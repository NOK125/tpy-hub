#!/usr/bin/env python3
"""TPY HR — ระบบงานบุคคล โรงพยาบาลตาพระยา

ใช้แค่ Python standard library (http.server + sqlite3) ไม่ต้องติดตั้งไลบรารีเพิ่ม
รัน:  python server.py --open   แล้วเปิด http://127.0.0.1:8100
"""
import base64
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import sqlite3
import sys
import traceback
import webbrowser
import zipfile
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse
from xml.sax.saxutils import escape as xml_escape

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DB_PATH = Path(os.environ.get("HUB_DB", BASE_DIR / "data" / "hub.db"))
FILES_DIR = Path(os.environ.get("HUB_FILES", DB_PATH.parent / "files"))
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8100"))
SESSION_HOURS = 12
COOKIE_NAME = "tpyhr_session"
MAX_BODY = 1024 * 1024
MAX_UPLOAD_BODY = 21 * 1024 * 1024   # ไฟล์ไม่เกิน 15 MB (base64 ใหญ่ขึ้น 1/3)
MAX_FILE = 15 * 1024 * 1024
LOGIN_MAX_FAILS = 5
LOGIN_LOCK_MINUTES = 15
MIN_PASSWORD = 8

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    national_id TEXT UNIQUE NOT NULL,
    seq INTEGER,
    prefix TEXT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    position TEXT,
    level TEXT,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    password_hash TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 1,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY,
    fiscal_year INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    department TEXT NOT NULL,
    budget REAL NOT NULL DEFAULT 0,
    spent_initial REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE (fiscal_year, seq)
);
CREATE TABLE IF NOT EXISTS plan_expenses (
    id INTEGER PRIMARY KEY,
    plan_id INTEGER NOT NULL REFERENCES plans(id),
    spent_on TEXT NOT NULL,
    amount REAL NOT NULL,
    description TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    doc_no TEXT,
    doc_date TEXT,
    note TEXT,
    file_name TEXT NOT NULL,
    file_key TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    uploaded_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clinic_questions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    subject TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clinic_messages (
    id INTEGER PRIMARY KEY,
    question_id INTEGER NOT NULL REFERENCES clinic_questions(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    from_admin INTEGER NOT NULL DEFAULT 0,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hr_expenses_plan ON plan_expenses(plan_id);
CREATE INDEX IF NOT EXISTS idx_hr_docs_cat ON documents(category, doc_date);
CREATE INDEX IF NOT EXISTS idx_hr_clinic_user ON clinic_questions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_hr_clinic_msg ON clinic_messages(question_id);
"""

ROLES = {"admin": "ผู้ดูแลระบบ", "user": "ผู้ใช้งาน"}
DOC_CATEGORIES = {
    "order": "คำสั่ง",
    "health": "ตรวจสุขภาพประจำปี",
    "meeting": "รายงานการประชุม",
    "other": "เอกสารอื่น ๆ",
}
CLINIC_STATUS = {"open": "รอตอบ", "answered": "ตอบแล้ว", "closed": "ปิดเรื่อง"}


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class Request:
    def __init__(self, conn, body, query, user):
        self.conn = conn
        self.body = body
        self.query = query
        self.user = user
        self.cookies = []

    def q(self, name, default=""):
        return (self.query.get(name) or [default])[0]


class FileResponse:
    def __init__(self, name, content_type, data=None, path=None, inline=True):
        self.name = name
        self.content_type = content_type
        self.data = data
        self.path = path
        self.inline = inline


def now():
    return datetime.now().isoformat(timespec="seconds")


def today():
    return date.today()


def fiscal_year(d):
    """ปีงบประมาณ พ.ศ. (เริ่ม 1 ต.ค.)"""
    return d.year + 543 + (1 if d.month >= 10 else 0)


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    FILES_DIR.mkdir(parents=True, exist_ok=True)
    conn = connect()
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        # ฐานข้อมูลรุ่นแรก (ระบบลา/คลังผลงาน) ไม่มีข้อมูลจริง เปลี่ยนชื่อตารางเก็บไว้แล้วเริ่มใหม่
        cols = [r[1] for r in conn.execute("PRAGMA table_info(users)")]
        if "username" in cols:
            conn.execute("PRAGMA foreign_keys = OFF")
            existing = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            for table in ("sessions", "leaves", "works", "users", "departments"):
                if table in existing:
                    conn.execute(f"ALTER TABLE {table} RENAME TO legacy_v1_{table}")
            conn.commit()
            conn.execute("PRAGMA foreign_keys = ON")
        conn.executescript(SCHEMA)
    finally:
        conn.close()


def rows(cursor):
    return [dict(r) for r in cursor.fetchall()]


# ---------- แปลงและตรวจค่าที่ส่งเข้ามา ----------

def to_str(value, label, required=False, max_len=200):
    text = "" if value is None else str(value).strip()
    if not text:
        if required:
            raise ApiError(400, f"กรุณาระบุ{label}")
        return None
    if len(text) > max_len:
        raise ApiError(400, f"{label}ยาวเกิน {max_len} ตัวอักษร")
    return text


def parse_number(value):
    """แปลงตัวเลขจากฟอร์มหรือ Excel (รองรับ 1,234.50) คืน None ถ้าไม่ใช่ตัวเลข"""
    if value is None:
        return None
    text = str(value).replace(",", "").replace("฿", "").strip()
    if not text:
        return None
    try:
        number = Decimal(text)
    except InvalidOperation:
        return None
    if not number.is_finite():
        return None
    return float(number)


def to_num(value, label, required=False, minimum=None):
    if value is None or str(value).strip() == "":
        if required:
            raise ApiError(400, f"กรุณาระบุ{label}")
        return None
    number = parse_number(value)
    if number is None:
        raise ApiError(400, f"{label}ต้องเป็นตัวเลข")
    if minimum is not None and number < minimum:
        raise ApiError(400, f"{label}ต้องไม่น้อยกว่า {minimum:g}")
    return number


def to_id(value, label, required=True):
    number = to_num(value, label, required)
    if number is None:
        return None
    if not float(number).is_integer():
        raise ApiError(400, f"{label}ไม่ถูกต้อง")
    return int(number)


def to_date(value, label, required=False):
    text = to_str(value, label, required, 10)
    if text is None:
        return None
    try:
        return str(date.fromisoformat(text))
    except ValueError:
        raise ApiError(400, f"{label}ไม่ถูกต้อง")


def to_choice(value, label, choices):
    if value not in choices:
        raise ApiError(400, f"{label}ไม่ถูกต้อง")
    return value


def to_bool(value):
    return value in (True, 1, "1", "true", "on")


def clean_national_id(value):
    """คืนเลขบัตร 13 หลัก รองรับค่าจาก Excel ที่เป็นตัวเลข (1.23E+12) หรือมีขีดคั่น"""
    text = "" if value is None else str(value).strip()
    if re.fullmatch(r"[\d\s-]+", text):
        digits = re.sub(r"\D", "", text)
    else:
        number = parse_number(text)
        digits = str(int(number)) if number is not None and float(number).is_integer() else ""
    return digits if len(digits) == 13 else None


def national_id_checksum_ok(nid):
    total = sum(int(nid[i]) * (13 - i) for i in range(12))
    return (11 - total % 11) % 10 == int(nid[12])


def to_national_id(value):
    nid = clean_national_id(value)
    if nid is None:
        raise ApiError(400, "เลขบัตรประชาชนต้องเป็นตัวเลข 13 หลัก")
    return nid


# ---------- ไฟล์ Excel (.xlsx) อ่านและเขียนด้วย zipfile + XML ----------

XL_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def decode_upload(value, label="ไฟล์"):
    try:
        data = base64.b64decode(value or "", validate=True)
    except (ValueError, TypeError):
        raise ApiError(400, f"{label}ไม่ถูกต้อง")
    if not data:
        raise ApiError(400, f"กรุณาเลือก{label}")
    if len(data) > MAX_FILE:
        raise ApiError(400, f"{label}ต้องไม่เกิน 15 MB")
    return data


def col_index(ref):
    letters = re.match(r"[A-Z]+", ref or "")
    if not letters:
        return None
    n = 0
    for ch in letters.group():
        n = n * 26 + ord(ch) - 64
    return n - 1


def col_letter(i):
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def read_xlsx(data):
    """อ่านชีตแรกของไฟล์ .xlsx คืนเป็นรายการแถว (list ของข้อความ)"""
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
        if sum(i.file_size for i in zf.infolist()) > 100 * 1024 * 1024:
            raise ApiError(400, "ไฟล์ Excel ใหญ่เกินไป")

        def xml(name):
            return ET.fromstring(zf.read(name))

        shared = []
        if "xl/sharedStrings.xml" in zf.namelist():
            for si in xml("xl/sharedStrings.xml").findall(f"{XL_NS}si"):
                shared.append("".join(t.text or "" for t in si.iter(f"{XL_NS}t")))
        sheet = xml("xl/workbook.xml").find(f"{XL_NS}sheets/{XL_NS}sheet")
        rid = sheet.get(f"{REL_NS}id")
        target = next(r.get("Target") for r in xml("xl/_rels/workbook.xml.rels") if r.get("Id") == rid)
        path = target.lstrip("/") if target.startswith("/") else "xl/" + target
        result = []
        for row in xml(path).iter(f"{XL_NS}row"):
            values, pos = {}, 0
            for c in row.findall(f"{XL_NS}c"):
                idx = col_index(c.get("r"))
                pos = pos if idx is None else idx
                kind = c.get("t")
                v = c.find(f"{XL_NS}v")
                if kind == "s" and v is not None:
                    text = shared[int(v.text)]
                elif kind == "inlineStr":
                    text = "".join(t.text or "" for t in c.iter(f"{XL_NS}t"))
                else:
                    text = v.text if v is not None and v.text else ""
                values[pos] = text.strip()
                pos += 1
            if values:
                result.append([values.get(i, "") for i in range(max(values) + 1)])
            else:
                result.append([])
        return result
    except ApiError:
        raise
    except (zipfile.BadZipFile, KeyError, StopIteration, ET.ParseError, IndexError, ValueError):
        raise ApiError(400, "อ่านไฟล์ไม่ได้ กรุณาใช้ไฟล์ Excel นามสกุล .xlsx")


def map_columns(rows_, rules, must_have):
    """หาแถวหัวตาราง แล้วจับคู่คอลัมน์ตามคำในหัวตาราง rules = [(key, [คำที่ต้องมี], [คำที่ต้องไม่มี])]"""
    for r_index, row in enumerate(rows_[:15]):
        mapping = {}
        for c_index, header in enumerate(row):
            h = re.sub(r"\s+", "", header)
            for key, words, avoid in rules:
                if key not in mapping and any(w in h for w in words) and not any(a in h for a in avoid):
                    mapping[key] = c_index
                    break
        if all(k in mapping for k in must_have):
            return r_index, mapping
    raise ApiError(400, "ไม่พบหัวตารางในไฟล์ กรุณาใช้แบบฟอร์มจากปุ่ม \"ดาวน์โหลดแบบฟอร์ม\"")


INVALID_XML = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def sheet_name(name):
    return re.sub(r"[\[\]:*?/\\]", " ", name)[:31]


def xlsx_bytes(sheets):
    """สร้างไฟล์ .xlsx จาก [(ชื่อชีต, [แถว])] แถวแรกเป็นหัวตาราง"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        overrides = "".join(
            f'<Override PartName="/xl/worksheets/sheet{i + 1}.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            for i in range(len(sheets)))
        zf.writestr("[Content_Types].xml",
                    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                    '<Default Extension="xml" ContentType="application/xml"/>'
                    '<Override PartName="/xl/workbook.xml" '
                    'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                    '<Override PartName="/xl/styles.xml" '
                    'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
                    f"{overrides}</Types>")
        zf.writestr("_rels/.rels",
                    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
                    'Target="xl/workbook.xml"/></Relationships>')
        sheet_tags = "".join(
            f'<sheet name="{xml_escape(sheet_name(name))}" sheetId="{i + 1}" r:id="rId{i + 1}"/>'
            for i, (name, _) in enumerate(sheets))
        zf.writestr("xl/workbook.xml",
                    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                    f"<sheets>{sheet_tags}</sheets></workbook>")
        rels = "".join(
            f'<Relationship Id="rId{i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
            f'Target="worksheets/sheet{i + 1}.xml"/>' for i in range(len(sheets)))
        rels += (f'<Relationship Id="rId{len(sheets) + 1}" '
                 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>')
        zf.writestr("xl/_rels/workbook.xml.rels",
                    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                    f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{rels}</Relationships>')
        # style 1 = ตัวหนาสำหรับหัวตาราง, style 2 = ตัวเลขมีจุลภาค
        zf.writestr("xl/styles.xml",
                    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                    '<fonts count="2"><font><sz val="11"/><name val="Tahoma"/></font>'
                    '<font><b/><sz val="11"/><name val="Tahoma"/></font></fonts>'
                    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
                    '<borders count="1"><border/></borders>'
                    '<cellStyleXfs count="1"><xf/></cellStyleXfs>'
                    '<cellXfs count="3"><xf/><xf fontId="1" applyFont="1"/><xf numFmtId="4" applyNumberFormat="1"/></cellXfs>'
                    '</styleSheet>')
        for i, (_, data_rows) in enumerate(sheets):
            widths = {}
            out = []
            for r, row in enumerate(data_rows):
                cells = []
                for c, value in enumerate(row):
                    ref = f"{col_letter(c)}{r + 1}"
                    widths[c] = max(widths.get(c, 8), min(60, len(str(value if value is not None else "")) + 2))
                    if value is None or value == "":
                        continue
                    if isinstance(value, (int, float)) and not isinstance(value, bool) and r > 0:
                        cells.append(f'<c r="{ref}" s="2"><v>{value}</v></c>')
                    else:
                        text = xml_escape(INVALID_XML.sub("", str(value)))
                        style = ' s="1"' if r == 0 else ""
                        cells.append(f'<c r="{ref}" t="inlineStr"{style}><is><t xml:space="preserve">{text}</t></is></c>')
                out.append(f'<row r="{r + 1}">{"".join(cells)}</row>')
            cols = "".join(f'<col min="{c + 1}" max="{c + 1}" width="{w * 1.2:.0f}" customWidth="1"/>'
                           for c, w in sorted(widths.items()))
            zf.writestr(f"xl/worksheets/sheet{i + 1}.xml",
                        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                        f'{"<cols>" + cols + "</cols>" if cols else ""}<sheetData>{"".join(out)}</sheetData></worksheet>')
    return buf.getvalue()


XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def xlsx_response(name, sheets):
    return FileResponse(name, XLSX_TYPE, data=xlsx_bytes(sheets), inline=False)


# ---------- บัญชีผู้ใช้และการล็อกอิน ----------

def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 200_000)
    return f"pbkdf2_sha256$200000${salt.hex()}${digest.hex()}"


def check_password(password, stored):
    try:
        _, iterations, salt, digest = stored.split("$")
        test = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations))
        return hmac.compare_digest(test.hex(), digest)
    except (ValueError, AttributeError):
        return False


DUMMY_HASH = hash_password(secrets.token_hex(8))


def initial_password(nid):
    """รหัสผ่านครั้งแรก = เลขบัตร 5 ตัวท้าย"""
    return nid[-5:]


def valid_new_password(password, nid):
    password = "" if password is None else str(password)
    if len(password) < MIN_PASSWORD:
        raise ApiError(400, f"รหัสผ่านใหม่ต้องยาวอย่างน้อย {MIN_PASSWORD} ตัวอักษร")
    if nid and password in (nid, nid[-5:]):
        raise ApiError(400, "รหัสผ่านใหม่ต้องไม่ใช่เลขบัตรประชาชน")
    return password


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def full_name(row):
    return f"{row['prefix'] or ''}{row['first_name']} {row['last_name']}".strip()


def public_user(row):
    if row is None:
        return None
    user = dict(row)
    for key in ("password_hash", "failed_logins"):
        user.pop(key, None)
    user["full_name"] = full_name(row)
    user["locked"] = bool(row["locked_until"] and row["locked_until"] > now())
    return user


def user_from_cookie(conn, header):
    if not header:
        return None
    cookie = SimpleCookie()
    try:
        cookie.load(header)
    except Exception:
        return None
    if COOKIE_NAME not in cookie:
        return None
    row = conn.execute(
        "SELECT u.* FROM users u JOIN sessions s ON s.user_id = u.id"
        " WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1",
        (token_hash(cookie[COOKIE_NAME].value), now())).fetchone()
    return public_user(row)


def start_session(req, user_id):
    token = secrets.token_urlsafe(32)
    expires = datetime.now() + timedelta(hours=SESSION_HOURS)
    req.conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now(),))
    req.conn.execute("INSERT INTO sessions VALUES (?, ?, ?)",
                     (token_hash(token), user_id, expires.isoformat(timespec="seconds")))
    req.cookies.append(f"{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_HOURS * 3600}")


def get_user(conn, user_id):
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None:
        raise ApiError(404, "ไม่พบผู้ใช้นี้")
    return public_user(row)


def setup_status(req):
    count = req.conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    return {"needs_setup": count == 0}


def setup(req):
    """สร้างบัญชีผู้ดูแลระบบคนแรก ทำได้ครั้งเดียวตอนยังไม่มีผู้ใช้"""
    if not setup_status(req)["needs_setup"]:
        raise ApiError(409, "ระบบตั้งค่าไปแล้ว")
    b = req.body
    nid = to_national_id(b.get("national_id"))
    user_id = req.conn.execute(
        """INSERT INTO users (national_id, prefix, first_name, last_name, position, role, password_hash,
               must_change_password, created_at) VALUES (?, ?, ?, ?, ?, 'admin', ?, 0, ?)""",
        (nid, to_str(b.get("prefix"), "คำนำหน้า", max_len=30), to_str(b.get("first_name"), "ชื่อ", True, 100),
         to_str(b.get("last_name"), "นามสกุล", True, 100), to_str(b.get("position"), "ตำแหน่ง", max_len=100),
         hash_password(valid_new_password(b.get("password"), nid)), now())).lastrowid
    start_session(req, user_id)
    return get_user(req.conn, user_id)


def login(req):
    nid = clean_national_id(req.body.get("national_id"))
    password = str(req.body.get("password") or "")
    row = req.conn.execute("SELECT * FROM users WHERE national_id = ?", (nid,)).fetchone() if nid else None
    if row is None:
        check_password(password, DUMMY_HASH)   # ให้ใช้เวลาเท่ากัน ไม่บอกว่ามีเลขบัตรนี้หรือไม่
        raise ApiError(401, "เลขบัตรประชาชนหรือรหัสผ่านไม่ถูกต้อง")
    if row["locked_until"] and row["locked_until"] > now():
        raise ApiError(429, f"ใส่รหัสผ่านผิดหลายครั้ง กรุณารอ {LOGIN_LOCK_MINUTES} นาทีแล้วลองใหม่")
    if not check_password(password, row["password_hash"]):
        fails = row["failed_logins"] + 1
        locked = None
        if fails >= LOGIN_MAX_FAILS:
            fails = 0
            locked = (datetime.now() + timedelta(minutes=LOGIN_LOCK_MINUTES)).isoformat(timespec="seconds")
        req.conn.execute("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?", (fails, locked, row["id"]))
        req.conn.commit()   # บันทึกจำนวนครั้งที่ผิดก่อนส่ง error (error จะ rollback)
        raise ApiError(401, "เลขบัตรประชาชนหรือรหัสผ่านไม่ถูกต้อง")
    if not row["active"]:
        raise ApiError(403, "บัญชีนี้ถูกปิดใช้งาน ติดต่อผู้ดูแลระบบ")
    req.conn.execute("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?", (row["id"],))
    start_session(req, row["id"])
    return public_user(row)


def logout(req):
    req.conn.execute("DELETE FROM sessions WHERE user_id = ?", (req.user["id"],))
    req.cookies.append(f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")
    return {"ok": True}


def me(req):
    return req.user


def change_password(req):
    row = req.conn.execute("SELECT password_hash FROM users WHERE id = ?", (req.user["id"],)).fetchone()
    if not check_password(str(req.body.get("old_password") or ""), row["password_hash"]):
        raise ApiError(400, "รหัสผ่านเดิมไม่ถูกต้อง")
    password = valid_new_password(req.body.get("new_password"), req.user["national_id"])
    req.conn.execute("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?",
                     (hash_password(password), req.user["id"]))
    return get_user(req.conn, req.user["id"])


def meta(req):
    return {
        "roles": ROLES,
        "doc_categories": DOC_CATEGORIES,
        "clinic_status": CLINIC_STATUS,
        "fiscal_year": fiscal_year(today()),
        "min_password": MIN_PASSWORD,
    }


# ---------- จัดการผู้ใช้ (ผู้ดูแลระบบ) ----------

def list_users(req):
    where, params = ["1 = 1"], []
    search = req.q("q").strip()
    if search:
        where.append("(first_name LIKE ? OR last_name LIKE ? OR national_id LIKE ? OR position LIKE ? OR level LIKE ?)")
        params += [f"%{search}%"] * 5
    if req.q("active") != "all":
        where.append("active = 1")
    return [public_user(r) for r in req.conn.execute(
        f"SELECT * FROM users WHERE {' AND '.join(where)} ORDER BY seq IS NULL, seq, first_name", params)]


def user_values(b):
    return {
        "seq": to_id(b.get("seq"), "ลำดับ", False),
        "prefix": to_str(b.get("prefix"), "คำนำหน้า", max_len=30),
        "first_name": to_str(b.get("first_name"), "ชื่อ", True, 100),
        "last_name": to_str(b.get("last_name"), "นามสกุล", True, 100),
        "position": to_str(b.get("position"), "ตำแหน่ง", max_len=150),
        "level": to_str(b.get("level"), "ระดับ", max_len=100),
        "role": to_choice(b.get("role", "user"), "สิทธิ์", ROLES),
        "active": 1 if to_bool(b.get("active", True)) else 0,
    }


def create_user(req):
    values = user_values(req.body)
    nid = to_national_id(req.body.get("national_id"))
    values.update(national_id=nid, password_hash=hash_password(initial_password(nid)),
                  must_change_password=1, created_at=now())
    try:
        user_id = req.conn.execute(
            f"INSERT INTO users ({', '.join(values)}) VALUES ({', '.join('?' * len(values))})",
            list(values.values())).lastrowid
    except sqlite3.IntegrityError:
        raise ApiError(409, "มีเลขบัตรประชาชนนี้ในระบบแล้ว")
    return get_user(req.conn, user_id)


def update_user(req, user_id):
    get_user(req.conn, user_id)
    values = user_values(req.body)
    values["national_id"] = to_national_id(req.body.get("national_id"))
    if user_id == req.user["id"] and (values["role"] != "admin" or not values["active"]):
        raise ApiError(400, "ไม่สามารถลดสิทธิ์หรือปิดบัญชีของตัวเองได้")
    try:
        req.conn.execute(f"UPDATE users SET {', '.join(f'{k} = ?' for k in values)} WHERE id = ?",
                         [*values.values(), user_id])
    except sqlite3.IntegrityError:
        raise ApiError(409, "มีเลขบัตรประชาชนนี้ในระบบแล้ว")
    if not values["active"]:
        req.conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    return get_user(req.conn, user_id)


def reset_password(req, user_id):
    user = get_user(req.conn, user_id)
    req.conn.execute(
        "UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL WHERE id = ?",
        (hash_password(initial_password(user["national_id"])), user_id))
    req.conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    return get_user(req.conn, user_id)


USER_COLUMNS = [
    ("seq", ["ลำดับ", "ที่"], []),
    ("prefix", ["คำนำหน้า"], []),
    ("last_name", ["นามสกุล", "สกุล"], []),
    ("national_id", ["บัตร", "เลขประจำตัว"], []),
    ("first_name", ["ชื่อ"], ["นามสกุล", "คำนำหน้า"]),
    ("position", ["ตำแหน่ง"], []),
    ("level", ["ระดับ"], []),
]


def import_users(req):
    data = decode_upload(req.body.get("file_data"), "ไฟล์ Excel")
    sheet = read_xlsx(data)
    header_row, cols = map_columns(sheet, USER_COLUMNS, ["first_name", "last_name", "national_id"])
    created = updated = 0
    errors, warnings = [], []
    seen = set()
    for i, row in enumerate(sheet[header_row + 1:], start=header_row + 2):
        cell = lambda key: (row[cols[key]] if key in cols and cols[key] < len(row) else "").strip()
        if not any(x.strip() for x in row):
            continue
        nid = clean_national_id(cell("national_id"))
        first, last = cell("first_name"), cell("last_name")
        if not nid:
            errors.append(f"แถว {i}: เลขบัตรประชาชนไม่ครบ 13 หลัก ({cell('national_id') or 'ว่าง'})")
            continue
        if not first or not last:
            errors.append(f"แถว {i}: ไม่มีชื่อหรือนามสกุล")
            continue
        if nid in seen:
            errors.append(f"แถว {i}: เลขบัตร {nid} ซ้ำกับแถวก่อนหน้าในไฟล์")
            continue
        seen.add(nid)
        if not national_id_checksum_ok(nid):
            warnings.append(f"แถว {i}: เลขบัตร {nid} ({first} {last}) หลักตรวจสอบไม่ตรง อาจพิมพ์ผิด กรุณาตรวจสอบ")
        seq = parse_number(cell("seq"))
        values = {
            "seq": int(seq) if seq is not None and float(seq).is_integer() else None,
            "prefix": cell("prefix")[:30] or None,
            "first_name": first[:100],
            "last_name": last[:100],
            "position": cell("position")[:150] or None,
            "level": cell("level")[:100] or None,
        }
        existing = req.conn.execute("SELECT id FROM users WHERE national_id = ?", (nid,)).fetchone()
        if existing:
            req.conn.execute(f"UPDATE users SET {', '.join(f'{k} = ?' for k in values)} WHERE id = ?",
                             [*values.values(), existing["id"]])
            updated += 1
        else:
            values.update(national_id=nid, password_hash=hash_password(initial_password(nid)),
                          must_change_password=1, role="user", created_at=now())
            req.conn.execute(f"INSERT INTO users ({', '.join(values)}) VALUES ({', '.join('?' * len(values))})",
                             list(values.values()))
            created += 1
    return {"created": created, "updated": updated, "errors": errors, "warnings": warnings}


def users_template(req):
    return xlsx_response("แบบฟอร์มนำเข้าผู้ใช้.xlsx",
                         [("ผู้ใช้", [["ลำดับ", "คำนำหน้า", "ชื่อ", "นามสกุล", "หมายเลขบัตร", "ตำแหน่ง", "ระดับ"]])])


# ---------- แผนพัฒนาบุคลากร ----------

PLAN_SELECT = """
    SELECT p.*, p.spent_initial + COALESCE((SELECT SUM(amount) FROM plan_expenses e WHERE e.plan_id = p.id), 0) AS spent,
           (SELECT COUNT(*) FROM plan_expenses e WHERE e.plan_id = p.id) AS expense_count
    FROM plans p
"""


def plan_years(conn):
    years = {r[0] for r in conn.execute("SELECT DISTINCT fiscal_year FROM plans")}
    years.add(fiscal_year(today()))
    return sorted(years, reverse=True)


def year_param(req):
    return to_id(req.q("year") or fiscal_year(today()), "ปีงบประมาณ")


def list_plans(req):
    year = year_param(req)
    plans = rows(req.conn.execute(PLAN_SELECT + " WHERE p.fiscal_year = ? ORDER BY p.seq", (year,)))
    for p in plans:
        p["remaining"] = p["budget"] - p["spent"]
    total = sum(p["budget"] for p in plans)
    spent = sum(p["spent"] for p in plans)
    return {"fiscal_year": year, "years": plan_years(req.conn), "plans": plans,
            "total_budget": total, "total_spent": spent, "total_remaining": total - spent}


def get_plan(conn, plan_id):
    row = conn.execute(PLAN_SELECT + " WHERE p.id = ?", (plan_id,)).fetchone()
    if row is None:
        raise ApiError(404, "ไม่พบแผนนี้")
    plan = dict(row)
    plan["remaining"] = plan["budget"] - plan["spent"]
    return plan


def plan_values(b):
    return {
        "fiscal_year": to_id(b.get("fiscal_year"), "ปีงบประมาณ"),
        "seq": to_id(b.get("seq"), "ลำดับ"),
        "department": to_str(b.get("department"), "หน่วยงาน", True, 200),
        "budget": to_num(b.get("budget"), "งบประมาณ", True, 0),
        "spent_initial": to_num(b.get("spent_initial") or 0, "งบที่ใช้ไปก่อนเริ่มใช้ระบบ", True, 0),
    }


def create_plan(req):
    values = plan_values(req.body)
    values["created_at"] = now()
    try:
        plan_id = req.conn.execute(f"INSERT INTO plans ({', '.join(values)}) VALUES ({', '.join('?' * len(values))})",
                                   list(values.values())).lastrowid
    except sqlite3.IntegrityError:
        raise ApiError(409, "มีลำดับนี้ในปีงบประมาณนี้แล้ว")
    return get_plan(req.conn, plan_id)


def update_plan(req, plan_id):
    plan = get_plan(req.conn, plan_id)
    values = plan_values(req.body)
    if values["budget"] < values["spent_initial"] + (plan["spent"] - plan["spent_initial"]):
        raise ApiError(400, "งบประมาณน้อยกว่างบที่ใช้ไปแล้ว")
    try:
        req.conn.execute(f"UPDATE plans SET {', '.join(f'{k} = ?' for k in values)} WHERE id = ?",
                         [*values.values(), plan_id])
    except sqlite3.IntegrityError:
        raise ApiError(409, "มีลำดับนี้ในปีงบประมาณนี้แล้ว")
    return get_plan(req.conn, plan_id)


def delete_plan(req, plan_id):
    plan = get_plan(req.conn, plan_id)
    if plan["expense_count"]:
        raise ApiError(409, "แผนนี้มีประวัติการตัดงบแล้ว ลบไม่ได้ ให้ลบรายการตัดงบก่อน")
    req.conn.execute("DELETE FROM plans WHERE id = ?", (plan_id,))
    return {"ok": True}


PLAN_COLUMNS = [
    ("seq", ["ลำดับ", "ที่"], []),
    ("department", ["หน่วยงาน", "กลุ่มงาน", "ฝ่าย"], []),
    ("spent", ["ใช้ไป", "ใช้แล้ว", "เบิกจ่าย"], []),
    ("budget", ["งบประมาณ", "งบ"], ["ใช้", "เบิก", "คงเหลือ"]),
]


def import_plans(req):
    year = to_id(req.body.get("fiscal_year"), "ปีงบประมาณ")
    data = decode_upload(req.body.get("file_data"), "ไฟล์ Excel")
    sheet = read_xlsx(data)
    header_row, cols = map_columns(sheet, PLAN_COLUMNS, ["department", "budget"])
    created = updated = 0
    errors = []
    next_seq = (req.conn.execute("SELECT MAX(seq) FROM plans WHERE fiscal_year = ?", (year,)).fetchone()[0] or 0) + 1
    for i, row in enumerate(sheet[header_row + 1:], start=header_row + 2):
        cell = lambda key: (row[cols[key]] if key in cols and cols[key] < len(row) else "").strip()
        if not any(x.strip() for x in row):
            continue
        dept = cell("department")
        if not dept:
            continue   # แถวสรุปยอดรวมท้ายตาราง
        if re.fullmatch(r"(รวม|ยอดรวม|รวมทั้งสิ้น).*", dept):
            continue
        budget = parse_number(cell("budget"))
        spent = parse_number(cell("spent")) or 0
        if budget is None or budget < 0:
            errors.append(f"แถว {i}: งบประมาณของ \"{dept}\" ไม่ใช่ตัวเลข")
            continue
        if spent < 0:
            errors.append(f"แถว {i}: งบที่ใช้ไปของ \"{dept}\" ติดลบ")
            continue
        seq_num = parse_number(cell("seq"))
        if seq_num is not None and float(seq_num).is_integer():
            seq = int(seq_num)
        else:
            seq, next_seq = next_seq, next_seq + 1
        existing = req.conn.execute("SELECT id FROM plans WHERE fiscal_year = ? AND seq = ?", (year, seq)).fetchone()
        if existing:
            req.conn.execute("UPDATE plans SET department = ?, budget = ?, spent_initial = ? WHERE id = ?",
                             (dept[:200], budget, spent, existing["id"]))
            updated += 1
        else:
            req.conn.execute(
                "INSERT INTO plans (fiscal_year, seq, department, budget, spent_initial, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (year, seq, dept[:200], budget, spent, now()))
            created += 1
        next_seq = max(next_seq, seq + 1)
    return {"created": created, "updated": updated, "errors": errors, "warnings": []}


def plans_template(req):
    return xlsx_response("แบบฟอร์มแผนพัฒนาบุคลากร.xlsx",
                         [("แผนพัฒนาบุคลากร", [["ลำดับ", "หน่วยงาน", "งบประมาณ", "งบประมาณที่ใช้ไป"]])])


def add_expense(req, plan_id):
    plan = get_plan(req.conn, plan_id)
    amount = to_num(req.body.get("amount"), "จำนวนเงิน", True)
    if amount <= 0:
        raise ApiError(400, "จำนวนเงินต้องมากกว่า 0")
    if amount > plan["remaining"] + 1e-6:
        raise ApiError(400, f"งบคงเหลือ {plan['remaining']:,.2f} บาท ไม่พอสำหรับ {amount:,.2f} บาท")
    req.conn.execute(
        "INSERT INTO plan_expenses (plan_id, spent_on, amount, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (plan_id, to_date(req.body.get("spent_on"), "วันที่", True), amount,
         to_str(req.body.get("description"), "รายการ", True, 500), req.user["id"], now()))
    return get_plan(req.conn, plan_id)


def delete_expense(req, expense_id):
    if req.conn.execute("DELETE FROM plan_expenses WHERE id = ?", (expense_id,)).rowcount == 0:
        raise ApiError(404, "ไม่พบรายการนี้")
    return {"ok": True}


def timeline_events(conn, year, plan_id=None):
    where, params = "p.fiscal_year = ?", [year]
    if plan_id:
        where += " AND p.id = ?"
        params.append(plan_id)
    events = rows(conn.execute(
        f"""SELECT e.id, e.plan_id, e.spent_on AS date, e.amount, e.description, e.created_at,
                   p.seq, p.department, u.prefix, u.first_name, u.last_name
            FROM plan_expenses e JOIN plans p ON p.id = e.plan_id LEFT JOIN users u ON u.id = e.created_by
            WHERE {where}""", params))
    for e in events:
        e["by"] = f"{e.pop('prefix') or ''}{e.pop('first_name') or ''} {e.pop('last_name') or ''}".strip()
        e["kind"] = "expense"
    for p in conn.execute(f"SELECT * FROM plans p WHERE {where} AND p.spent_initial > 0", params):
        events.append({"id": None, "plan_id": p["id"], "date": p["created_at"][:10], "amount": p["spent_initial"],
                       "description": "งบที่ใช้ไปตามไฟล์นำเข้า", "seq": p["seq"], "department": p["department"],
                       "by": "", "kind": "initial", "created_at": p["created_at"]})
    events.sort(key=lambda e: (e["date"], e["created_at"]))
    running = 0
    for e in events:
        running += e["amount"]
        e["cumulative"] = running
    events.reverse()
    return events


def plan_timeline(req):
    plan_id = to_id(req.q("plan_id"), "แผน", False)
    return {"fiscal_year": year_param(req), "events": timeline_events(req.conn, year_param(req), plan_id)}


# ---------- เอกสาร (คำสั่ง ตรวจสุขภาพ รายงานการประชุม เอกสารอื่น ๆ) ----------

DOC_SELECT = """
    SELECT d.id, d.category, d.title, d.doc_no, d.doc_date, d.note, d.file_name, d.file_size, d.created_at,
           u.prefix, u.first_name, u.last_name
    FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
"""


def doc_row(row):
    d = dict(row)
    d["uploaded_by"] = f"{d.pop('prefix') or ''}{d.pop('first_name') or ''} {d.pop('last_name') or ''}".strip()
    return d


def list_documents(req):
    where, params = ["1 = 1"], []
    if req.q("category"):
        where.append("d.category = ?")
        params.append(to_choice(req.q("category"), "หมวดเอกสาร", DOC_CATEGORIES))
    search = req.q("q").strip()
    if search:
        where.append("(d.title LIKE ? OR d.doc_no LIKE ? OR d.note LIKE ?)")
        params += [f"%{search}%"] * 3
    if req.q("year"):
        # ปี พ.ศ. ของวันที่เอกสาร
        y = to_id(req.q("year"), "ปี") - 543
        where.append("substr(COALESCE(d.doc_date, d.created_at), 1, 4) = ?")
        params.append(str(y))
    return [doc_row(r) for r in req.conn.execute(
        DOC_SELECT + f" WHERE {' AND '.join(where)} ORDER BY COALESCE(d.doc_date, substr(d.created_at, 1, 10)) DESC, d.id DESC"
        " LIMIT 1000", params)]


def save_pdf(data_b64, name):
    name = to_str(name, "ชื่อไฟล์", True, 200)
    if not name.lower().endswith(".pdf"):
        raise ApiError(400, "แนบได้เฉพาะไฟล์ PDF")
    data = decode_upload(data_b64, "ไฟล์ PDF")
    if not data.startswith(b"%PDF"):
        raise ApiError(400, "ไฟล์แนบไม่ใช่ PDF")
    key = secrets.token_hex(16) + ".pdf"
    (FILES_DIR / key).write_bytes(data)
    return name, key, len(data)


def doc_values(b):
    return {
        "category": to_choice(b.get("category"), "หมวดเอกสาร", DOC_CATEGORIES),
        "title": to_str(b.get("title"), "ชื่อเรื่อง", True, 300),
        "doc_no": to_str(b.get("doc_no"), "เลขที่", max_len=100),
        "doc_date": to_date(b.get("doc_date"), "วันที่เอกสาร"),
        "note": to_str(b.get("note"), "รายละเอียด", max_len=2000),
    }


def get_document(req, doc_id):
    row = req.conn.execute(DOC_SELECT + " WHERE d.id = ?", (doc_id,)).fetchone()
    if row is None:
        raise ApiError(404, "ไม่พบเอกสารนี้")
    return doc_row(row)


def create_document(req):
    values = doc_values(req.body)
    values["file_name"], values["file_key"], values["file_size"] = save_pdf(req.body.get("file_data"), req.body.get("file_name"))
    values.update(uploaded_by=req.user["id"], created_at=now())
    doc_id = req.conn.execute(f"INSERT INTO documents ({', '.join(values)}) VALUES ({', '.join('?' * len(values))})",
                              list(values.values())).lastrowid
    return get_document(req, doc_id)


def update_document(req, doc_id):
    get_document(req, doc_id)
    values = doc_values(req.body)
    old_key = None
    if req.body.get("file_data"):
        old_key = req.conn.execute("SELECT file_key FROM documents WHERE id = ?", (doc_id,)).fetchone()[0]
        values["file_name"], values["file_key"], values["file_size"] = save_pdf(req.body["file_data"], req.body.get("file_name"))
    req.conn.execute(f"UPDATE documents SET {', '.join(f'{k} = ?' for k in values)} WHERE id = ?",
                     [*values.values(), doc_id])
    if old_key:
        (FILES_DIR / old_key).unlink(missing_ok=True)
    return get_document(req, doc_id)


def delete_document(req, doc_id):
    row = req.conn.execute("SELECT file_key FROM documents WHERE id = ?", (doc_id,)).fetchone()
    if row is None:
        raise ApiError(404, "ไม่พบเอกสารนี้")
    req.conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
    (FILES_DIR / row["file_key"]).unlink(missing_ok=True)
    return {"ok": True}


def document_file(req, doc_id):
    row = req.conn.execute("SELECT file_name, file_key FROM documents WHERE id = ?", (doc_id,)).fetchone()
    if row is None or not (FILES_DIR / row["file_key"]).is_file():
        raise ApiError(404, "ไม่พบไฟล์เอกสารนี้")
    return FileResponse(row["file_name"], "application/pdf", path=FILES_DIR / row["file_key"],
                        inline=req.q("download") != "1")


# ---------- HR Clinic ----------

CLINIC_SELECT = """
    SELECT q.*, u.prefix, u.first_name, u.last_name, u.position,
           (SELECT COUNT(*) FROM clinic_messages m WHERE m.question_id = q.id) AS message_count
    FROM clinic_questions q JOIN users u ON u.id = q.user_id
"""


def clinic_row(row):
    q = dict(row)
    q["asker"] = f"{q.pop('prefix') or ''}{q.pop('first_name')} {q.pop('last_name')}".strip()
    return q


def list_clinic(req):
    where, params = ["1 = 1"], []
    if req.user["role"] != "admin":
        where.append("q.user_id = ?")
        params.append(req.user["id"])
    if req.q("status"):
        where.append("q.status = ?")
        params.append(to_choice(req.q("status"), "สถานะ", CLINIC_STATUS))
    return [clinic_row(r) for r in req.conn.execute(
        CLINIC_SELECT + f" WHERE {' AND '.join(where)} ORDER BY q.updated_at DESC LIMIT 500", params)]


def get_clinic(req, qid):
    row = req.conn.execute(CLINIC_SELECT + " WHERE q.id = ?", (qid,)).fetchone()
    # คำถามของคนอื่นตอบว่าไม่พบ ไม่บอกว่ามีอยู่
    if row is None or (req.user["role"] != "admin" and row["user_id"] != req.user["id"]):
        raise ApiError(404, "ไม่พบคำถามนี้")
    q = clinic_row(row)
    q["messages"] = []
    for m in req.conn.execute(
            """SELECT m.*, u.prefix, u.first_name, u.last_name FROM clinic_messages m
               JOIN users u ON u.id = m.user_id WHERE m.question_id = ? ORDER BY m.id""", (qid,)):
        msg = dict(m)
        msg["author"] = "เจ้าหน้าที่ HR" if msg["from_admin"] else \
            f"{msg.pop('prefix') or ''}{msg.pop('first_name')} {msg.pop('last_name')}".strip()
        for k in ("prefix", "first_name", "last_name", "user_id"):
            msg.pop(k, None)
        q["messages"].append(msg)
    return q


def create_clinic(req):
    subject = to_str(req.body.get("subject"), "หัวข้อ", True, 200)
    body = to_str(req.body.get("body"), "คำถาม", True, 5000)
    ts = now()
    qid = req.conn.execute(
        "INSERT INTO clinic_questions (user_id, subject, status, created_at, updated_at) VALUES (?, ?, 'open', ?, ?)",
        (req.user["id"], subject, ts, ts)).lastrowid
    req.conn.execute("INSERT INTO clinic_messages (question_id, user_id, from_admin, body, created_at) VALUES (?, ?, 0, ?, ?)",
                     (qid, req.user["id"], body, ts))
    return get_clinic(req, qid)


def reply_clinic(req, qid):
    q = get_clinic(req, qid)
    body = to_str(req.body.get("body"), "ข้อความ", True, 5000)
    is_admin = req.user["role"] == "admin" and q["user_id"] != req.user["id"]
    if q["status"] == "closed" and not is_admin:
        raise ApiError(409, "เรื่องนี้ปิดแล้ว กรุณาส่งคำถามใหม่")
    ts = now()
    req.conn.execute("INSERT INTO clinic_messages (question_id, user_id, from_admin, body, created_at) VALUES (?, ?, ?, ?, ?)",
                     (qid, req.user["id"], 1 if is_admin else 0, body, ts))
    status = "answered" if is_admin else "open"
    req.conn.execute("UPDATE clinic_questions SET status = ?, updated_at = ? WHERE id = ?", (status, ts, qid))
    return get_clinic(req, qid)


def close_clinic(req, qid):
    get_clinic(req, qid)
    req.conn.execute("UPDATE clinic_questions SET status = 'closed', updated_at = ? WHERE id = ?", (now(), qid))
    return get_clinic(req, qid)


# ---------- Dashboard และการส่งออก ----------

def dashboard_data(conn, user, year):
    staff = conn.execute(
        "SELECT COUNT(*) AS total, SUM(must_change_password) AS not_activated FROM users WHERE active = 1").fetchone()
    by_level = rows(conn.execute(
        "SELECT COALESCE(NULLIF(level, ''), 'ไม่ระบุ') AS label, COUNT(*) AS n FROM users WHERE active = 1"
        " GROUP BY label ORDER BY n DESC"))
    by_position = rows(conn.execute(
        "SELECT COALESCE(NULLIF(position, ''), 'ไม่ระบุ') AS label, COUNT(*) AS n FROM users WHERE active = 1"
        " GROUP BY label ORDER BY n DESC LIMIT 10"))
    plans = rows(conn.execute(PLAN_SELECT + " WHERE p.fiscal_year = ? ORDER BY p.seq", (year,)))
    for p in plans:
        p["remaining"] = p["budget"] - p["spent"]
    total_budget = sum(p["budget"] for p in plans)
    total_spent = sum(p["spent"] for p in plans)
    docs = {r["category"]: r["n"] for r in conn.execute("SELECT category, COUNT(*) AS n FROM documents GROUP BY category")}
    clinic_where = "" if user["role"] == "admin" else f" WHERE user_id = {int(user['id'])}"
    clinic = {r["status"]: r["n"] for r in conn.execute(
        f"SELECT status, COUNT(*) AS n FROM clinic_questions{clinic_where} GROUP BY status")}
    latest_docs = [doc_row(r) for r in conn.execute(DOC_SELECT + " ORDER BY d.created_at DESC LIMIT 6")]
    return {
        "fiscal_year": year,
        "years": plan_years(conn),
        "generated_at": now(),
        "staff_total": staff["total"],
        "staff_not_activated": staff["not_activated"] or 0,
        "by_level": by_level,
        "by_position": by_position,
        "plans": plans,
        "total_budget": total_budget,
        "total_spent": total_spent,
        "total_remaining": total_budget - total_spent,
        "documents": {k: docs.get(k, 0) for k in DOC_CATEGORIES},
        "clinic": {k: clinic.get(k, 0) for k in CLINIC_STATUS},
        "latest_documents": latest_docs,
        "recent_expenses": timeline_events(conn, year)[:6],
    }


def dashboard(req):
    return dashboard_data(req.conn, req.user, year_param(req))


def th_date(iso):
    if not iso:
        return ""
    y, m, d = iso[:10].split("-")
    return f"{d}/{m}/{int(y) + 543}"


def export_dashboard(req):
    d = dashboard_data(req.conn, req.user, year_param(req))
    pct = lambda a, b: round(a / b * 100, 2) if b else 0
    summary = [
        ["หัวข้อ", "ค่า"],
        ["รายงาน ณ วันที่", th_date(d["generated_at"])],
        ["ปีงบประมาณ", d["fiscal_year"]],
        ["จำนวนบุคลากร (คน)", d["staff_total"]],
        ["งบประมาณแผนพัฒนาบุคลากรรวม (บาท)", d["total_budget"]],
        ["ใช้ไปแล้ว (บาท)", d["total_spent"]],
        ["คงเหลือ (บาท)", d["total_remaining"]],
        ["ใช้ไปแล้ว (%)", pct(d["total_spent"], d["total_budget"])],
        *[[f"เอกสาร: {DOC_CATEGORIES[k]} (ฉบับ)", v] for k, v in d["documents"].items()],
        *[[f"HR Clinic: {CLINIC_STATUS[k]} (เรื่อง)", v] for k, v in d["clinic"].items()],
    ]
    plans = [["ลำดับ", "หน่วยงาน", "งบประมาณ", "ใช้ไป", "คงเหลือ", "ใช้ไป (%)"]] + [
        [p["seq"], p["department"], p["budget"], p["spent"], p["remaining"], pct(p["spent"], p["budget"])]
        for p in d["plans"]]
    timeline = [["วันที่", "ลำดับแผน", "หน่วยงาน", "รายการ", "จำนวนเงิน", "ยอดใช้สะสม", "ผู้บันทึก"]] + [
        [th_date(e["date"]), e["seq"], e["department"], e["description"], e["amount"], e["cumulative"], e["by"]]
        for e in timeline_events(req.conn, d["fiscal_year"])]
    levels = [["ระดับ", "จำนวน (คน)"]] + [[r["label"], r["n"]] for r in d["by_level"]]
    positions = [["ตำแหน่ง", "จำนวน (คน)"]] + [[r["label"], r["n"]] for r in d["by_position"]]
    return xlsx_response(f"สรุปภาพรวม HR ปีงบ {d['fiscal_year']}.xlsx", [
        ("สรุป", summary), ("แผนพัฒนาบุคลากร", plans), ("ประวัติการตัดงบ", timeline),
        ("บุคลากรตามระดับ", levels), ("บุคลากรตามตำแหน่ง", positions)])


# ---------- เส้นทาง API ----------

ROUTES = []
ID = r"(\d+)"


def route(method, pattern, handler, access="user"):
    """access: public = ไม่ต้องล็อกอิน, self = ล็อกอินแล้ว (ใช้ได้แม้ยังไม่เปลี่ยนรหัสครั้งแรก),
    user = ทุกคนที่ล็อกอินและเปลี่ยนรหัสแล้ว, admin = ผู้ดูแลระบบ"""
    ROUTES.append((method, re.compile(f"^/api{pattern}$"), handler, access))


route("GET", "/setup", setup_status, "public")
route("POST", "/setup", setup, "public")
route("POST", "/login", login, "public")
route("POST", "/logout", logout, "self")
route("GET", "/me", me, "self")
route("POST", "/me/password", change_password, "self")
route("GET", "/meta", meta, "self")
route("GET", "/dashboard", dashboard)
route("GET", "/export/dashboard.xlsx", export_dashboard)
route("GET", "/users", list_users, "admin")
route("POST", "/users", create_user, "admin")
route("POST", "/users/import", import_users, "admin")
route("GET", "/templates/users.xlsx", users_template, "admin")
route("PUT", f"/users/{ID}", update_user, "admin")
route("POST", f"/users/{ID}/reset-password", reset_password, "admin")
route("GET", "/plans", list_plans)
route("POST", "/plans", create_plan, "admin")
route("POST", "/plans/import", import_plans, "admin")
route("GET", "/plans/timeline", plan_timeline)
route("GET", "/templates/plans.xlsx", plans_template, "admin")
route("PUT", f"/plans/{ID}", update_plan, "admin")
route("POST", f"/plans/{ID}/delete", delete_plan, "admin")
route("POST", f"/plans/{ID}/expenses", add_expense, "admin")
route("POST", f"/expenses/{ID}/delete", delete_expense, "admin")
route("GET", "/documents", list_documents)
route("POST", "/documents", create_document, "admin")
route("GET", f"/documents/{ID}/file", document_file)
route("PUT", f"/documents/{ID}", update_document, "admin")
route("POST", f"/documents/{ID}/delete", delete_document, "admin")
route("GET", "/clinic", list_clinic)
route("POST", "/clinic", create_clinic)
route("GET", f"/clinic/{ID}", get_clinic)
route("POST", f"/clinic/{ID}/reply", reply_clinic)
route("POST", f"/clinic/{ID}/close", close_clinic)

UPLOAD_PATHS = re.compile(r"^/api/(documents(/\d+)?|users/import|plans/import)$")

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".png": "image/png",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "TPYHR/2.0"

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def dispatch(self, method):
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            if method != "GET":
                return self.send_json(405, {"error": "Method not allowed"})
            return self.serve_static(url.path)
        cookies = []
        try:
            # คำขอที่ไม่ใช่ GET ต้องเป็น JSON เสมอ (กัน CSRF จากฟอร์มเว็บอื่น)
            if method != "GET" and not (self.headers.get("Content-Type") or "").startswith("application/json"):
                raise ApiError(415, "ต้องส่งข้อมูลเป็น JSON")
            limit = MAX_UPLOAD_BODY if UPLOAD_PATHS.match(url.path) else MAX_BODY
            body = self.read_json(limit) if method != "GET" else {}
            for route_method, pattern, handler, access in ROUTES:
                match = pattern.match(url.path)
                if route_method != method or not match:
                    continue
                conn = connect()
                try:
                    with conn:
                        req = Request(conn, body, parse_qs(url.query), user_from_cookie(conn, self.headers.get("Cookie")))
                        if access != "public":
                            if req.user is None:
                                raise ApiError(401, "กรุณาเข้าสู่ระบบ")
                            if access != "self" and req.user["must_change_password"]:
                                raise ApiError(403, "กรุณาเปลี่ยนรหัสผ่านก่อนใช้งาน")
                            if access == "admin" and req.user["role"] != "admin":
                                raise ApiError(403, "เฉพาะผู้ดูแลระบบเท่านั้น")
                        result = handler(req, *[int(g) for g in match.groups()])
                        cookies = req.cookies
                finally:
                    conn.close()
                if isinstance(result, FileResponse):
                    return self.send_file(result)
                return self.send_json(200, result, cookies)
            raise ApiError(404, "ไม่พบ API นี้")
        except ApiError as err:
            self.send_json(err.status, {"error": err.message})
        except Exception:
            traceback.print_exc()
            self.send_json(500, {"error": "เกิดข้อผิดพลาดในเซิร์ฟเวอร์"})

    def read_json(self, limit):
        length = int(self.headers.get("Content-Length") or 0)
        if length > limit:
            raise ApiError(413, "ไฟล์ใหญ่เกินไป (ต้องไม่เกิน 15 MB)")
        if not length:
            return {}
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(400, "ข้อมูลที่ส่งมาไม่ใช่ JSON")
        if not isinstance(data, dict):
            raise ApiError(400, "ข้อมูลที่ส่งมาต้องเป็น JSON object")
        return data

    def send_json(self, status, payload, cookies=()):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for cookie in cookies:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(data)

    def send_file(self, file):
        data = file.data if file.data is not None else file.path.read_bytes()
        ascii_name = re.sub(r"[^A-Za-z0-9._-]", "_", file.name)
        disposition = "inline" if file.inline else "attachment"
        self.send_response(200)
        self.send_header("Content-Type", file.content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition",
                         f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(file.name)}")
        self.send_header("Cache-Control", "private, no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def serve_static(self, path):
        target = (STATIC_DIR / (path.lstrip("/") or "index.html")).resolve()
        if not target.is_relative_to(STATIC_DIR) or not target.is_file():
            return self.send_json(404, {"error": "ไม่พบหน้านี้"})
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", STATIC_TYPES.get(target.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        if "--quiet" not in sys.argv:
            super().log_message(fmt, *args)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{'127.0.0.1' if HOST in ('0.0.0.0', '') else HOST}:{PORT}"
    print(f"TPY HR กำลังทำงานที่ {url}  (กด Ctrl+C เพื่อหยุด)")
    print(f"ฐานข้อมูล: {DB_PATH}")
    if "--open" in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nหยุดระบบแล้ว")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
