#!/usr/bin/env python3
"""TPY Hub — ระบบงานบุคคล งานวิจัย และนวัตกรรม โรงพยาบาลตาพระยา

ใช้แค่ Python standard library (http.server + sqlite3) ไม่ต้องติดตั้งไลบรารีเพิ่ม
รัน:  python server.py --open   แล้วเปิด http://127.0.0.1:8100
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import traceback
import webbrowser
from datetime import date, datetime, timedelta
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DB_PATH = Path(os.environ.get("HUB_DB", BASE_DIR / "data" / "hub.db"))
FILES_DIR = Path(os.environ.get("HUB_FILES", DB_PATH.parent / "files"))
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8100"))
SESSION_HOURS = 12
COOKIE_NAME = "tpyhub_session"
MAX_BODY = 1024 * 1024
MAX_UPLOAD_BODY = 20 * 1024 * 1024   # ไฟล์ PDF ไม่เกิน ~15 MB (base64 ใหญ่ขึ้น 1/3)
LICENSE_WARN_DAYS = 90

SCHEMA = """
CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    full_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'head', 'staff')),
    department_id INTEGER REFERENCES departments(id),
    position TEXT,
    profession TEXT,
    employment_type TEXT,
    phone TEXT,
    start_date TEXT,
    license_no TEXT,
    license_expiry TEXT,
    vacation_quota REAL NOT NULL DEFAULT 10,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS leaves (
    id INTEGER PRIMARY KEY,
    doc_no TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    department_id INTEGER REFERENCES departments(id),
    leave_type TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    days REAL NOT NULL,
    fiscal_year INTEGER NOT NULL,
    reason TEXT,
    contact TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    approver_name TEXT,
    approved_at TEXT,
    reject_reason TEXT
);
CREATE TABLE IF NOT EXISTS works (
    id INTEGER PRIMARY KEY,
    doc_no TEXT UNIQUE NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    authors TEXT NOT NULL,
    abstract TEXT,
    keywords TEXT,
    year INTEGER NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    department_id INTEGER REFERENCES departments(id),
    file_name TEXT,
    file_key TEXT,
    status TEXT NOT NULL DEFAULT 'submitted',
    review_note TEXT,
    reviewer_name TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leaves_user ON leaves(user_id, fiscal_year);
CREATE INDEX IF NOT EXISTS idx_leaves_status ON leaves(status);
CREATE INDEX IF NOT EXISTS idx_works_status ON works(status);
"""

ROLES = {"admin": "ผู้ดูแลระบบ", "head": "หัวหน้างาน", "staff": "เจ้าหน้าที่"}

# วันลาต่อปีงบประมาณ ตามระเบียบการลาของข้าราชการโดยประมาณ ลาพักผ่อนกำหนดรายคนได้ที่ users.vacation_quota
LEAVE_TYPES = {
    "sick": ("ลาป่วย", 60),
    "personal": ("ลากิจส่วนตัว", 45),
    "vacation": ("ลาพักผ่อน", None),
    "maternity": ("ลาคลอดบุตร", 90),
    "ordination": ("ลาอุปสมบท/ฮัจย์", 120),
    "other": ("ลาอื่น ๆ", None),
}
LEAVE_STATUS = {"pending": "รออนุมัติ", "approved": "อนุมัติ", "rejected": "ไม่อนุมัติ", "cancelled": "ยกเลิก"}

WORK_KINDS = {"research": "งานวิจัย", "innovation": "นวัตกรรม", "cqi": "CQI / R2R"}
# submitted = ส่งแล้วรอพิจารณา, revise = ส่งกลับแก้ไข, approved = อนุมัติ เผยแพร่ในคลังผลงาน, rejected = ไม่อนุมัติ
WORK_STATUS = {"submitted": "รอพิจารณา", "revise": "ส่งกลับแก้ไข", "approved": "เผยแพร่แล้ว", "rejected": "ไม่อนุมัติ"}


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
    def __init__(self, path, name, content_type="application/pdf"):
        self.path = path
        self.name = name
        self.content_type = content_type


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


def to_num(value, label, required=False, minimum=None):
    if value is None or value == "":
        if required:
            raise ApiError(400, f"กรุณาระบุ{label}")
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ApiError(400, f"{label}ต้องเป็นตัวเลข")
    if number != number or number in (float("inf"), float("-inf")):
        raise ApiError(400, f"{label}ต้องเป็นตัวเลข")
    if minimum is not None and number < minimum:
        raise ApiError(400, f"{label}ต้องไม่น้อยกว่า {minimum:g}")
    return number


def to_id(value, label, required=True):
    number = to_num(value, label, required)
    if number is None:
        return None
    if not number.is_integer():
        raise ApiError(400, f"{label}ไม่ถูกต้อง")
    return int(number)


def to_date(value, label, required=False):
    text = to_str(value, label, required, 10)
    if text is None:
        return None
    try:
        return date.fromisoformat(text)
    except ValueError:
        raise ApiError(400, f"{label}ไม่ถูกต้อง")


def iso(d):
    return str(d) if d else None


def to_choice(value, label, choices):
    if value not in choices:
        raise ApiError(400, f"{label}ไม่ถูกต้อง")
    return value


def to_bool(value):
    return value in (True, 1, "1", "true", "on")


def next_doc_no(conn, table, prefix):
    year = datetime.now().year + 543
    head = f"{prefix}{year}-"
    last = conn.execute(f"SELECT doc_no FROM {table} WHERE doc_no LIKE ? ORDER BY doc_no DESC LIMIT 1",
                        (head + "%",)).fetchone()
    seq = int(last[0].split("-")[1]) + 1 if last else 1
    return f"{head}{seq:04d}"


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


def valid_password(password):
    password = "" if password is None else str(password)
    if len(password) < 6:
        raise ApiError(400, "รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร")
    return password


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def public_user(row):
    if row is None:
        return None
    user = dict(row)
    user.pop("password_hash", None)
    return user


USER_SELECT = """
    SELECT u.*, d.name AS department_name
    FROM users u LEFT JOIN departments d ON d.id = u.department_id
"""


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
        USER_SELECT + " JOIN sessions s ON s.user_id = u.id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1",
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
    row = conn.execute(USER_SELECT + " WHERE u.id = ?", (user_id,)).fetchone()
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
    username = to_str(b.get("username"), "ชื่อผู้ใช้", True, 50)
    full_name = to_str(b.get("full_name"), "ชื่อ-นามสกุล", True)
    password = valid_password(b.get("password"))
    user_id = req.conn.execute(
        "INSERT INTO users (username, full_name, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
        (username, full_name, hash_password(password), now())).lastrowid
    start_session(req, user_id)
    return get_user(req.conn, user_id)


def login(req):
    username = to_str(req.body.get("username"), "ชื่อผู้ใช้", True, 50)
    password = str(req.body.get("password") or "")
    row = req.conn.execute(USER_SELECT + " WHERE u.username = ?", (username,)).fetchone()
    if row is None or not check_password(password, row["password_hash"]):
        raise ApiError(401, "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง")
    if not row["active"]:
        raise ApiError(403, "บัญชีนี้ถูกปิดใช้งาน ติดต่อผู้ดูแลระบบ")
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
    password = valid_password(req.body.get("new_password"))
    req.conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(password), req.user["id"]))
    return {"ok": True}


def update_me(req):
    """เจ้าหน้าที่แก้ข้อมูลติดต่อของตัวเองได้ ส่วนข้อมูลตำแหน่งและใบอนุญาตให้ผู้ดูแลแก้"""
    phone = to_str(req.body.get("phone"), "เบอร์โทร", max_len=30)
    req.conn.execute("UPDATE users SET phone = ? WHERE id = ?", (phone, req.user["id"]))
    return get_user(req.conn, req.user["id"])


def meta(req):
    return {
        "roles": ROLES,
        "leave_types": {k: v[0] for k, v in LEAVE_TYPES.items()},
        "leave_status": LEAVE_STATUS,
        "work_kinds": WORK_KINDS,
        "work_status": WORK_STATUS,
        "fiscal_year": fiscal_year(today()),
    }


# ---------- หน่วยงาน ----------

def list_departments(req):
    where = "" if req.user["role"] == "admin" else "WHERE active = 1"
    return rows(req.conn.execute(f"SELECT * FROM departments {where} ORDER BY name"))


def save_department(req, dept_id=None):
    name = to_str(req.body.get("name"), "ชื่อหน่วยงาน", True, 100)
    active = 1 if to_bool(req.body.get("active", True)) else 0
    try:
        if dept_id is None:
            dept_id = req.conn.execute("INSERT INTO departments (name, active) VALUES (?, ?)", (name, active)).lastrowid
        else:
            if req.conn.execute("UPDATE departments SET name = ?, active = ? WHERE id = ?",
                                (name, active, dept_id)).rowcount == 0:
                raise ApiError(404, "ไม่พบหน่วยงานนี้")
    except sqlite3.IntegrityError:
        raise ApiError(409, "มีหน่วยงานชื่อนี้แล้ว")
    return dict(req.conn.execute("SELECT * FROM departments WHERE id = ?", (dept_id,)).fetchone())


def create_department(req):
    return save_department(req)


def update_department(req, dept_id):
    return save_department(req, dept_id)


# ---------- บุคลากร ----------

PROFILE_FIELDS = [
    ("position", "ตำแหน่ง", 100),
    ("profession", "วิชาชีพ", 100),
    ("employment_type", "ประเภทการจ้าง", 50),
    ("phone", "เบอร์โทร", 30),
    ("license_no", "เลขที่ใบประกอบวิชาชีพ", 50),
]


def staff_scope(req):
    """หัวหน้างานเห็นเฉพาะคนในหน่วยงานตัวเอง ผู้ดูแลเห็นทั้งหมด"""
    if req.user["role"] == "admin":
        return "", []
    return " AND u.department_id = ?", [req.user["department_id"]]


def list_users(req):
    where, params = staff_scope(req)
    search = req.q("q").strip()
    if search:
        where += " AND (u.full_name LIKE ? OR u.username LIKE ? OR u.position LIKE ?)"
        params += [f"%{search}%"] * 3
    if req.q("active") != "all":
        where += " AND u.active = 1"
    return [public_user(r) for r in req.conn.execute(
        USER_SELECT + f" WHERE 1 = 1 {where} ORDER BY d.name, u.full_name", params)]


def user_values(req, creating):
    b = req.body
    values = {
        "full_name": to_str(b.get("full_name"), "ชื่อ-นามสกุล", True),
        "role": to_choice(b.get("role"), "สิทธิ์", ROLES),
        "department_id": to_id(b.get("department_id"), "หน่วยงาน", False),
        "start_date": iso(to_date(b.get("start_date"), "วันที่เริ่มงาน")),
        "license_expiry": iso(to_date(b.get("license_expiry"), "วันหมดอายุใบประกอบวิชาชีพ")),
        "vacation_quota": to_num(b.get("vacation_quota", 10), "วันลาพักผ่อนต่อปี", True, 0),
        "active": 1 if to_bool(b.get("active", True)) else 0,
    }
    for key, label, max_len in PROFILE_FIELDS:
        values[key] = to_str(b.get(key), label, max_len=max_len)
    if values["role"] != "admin" and not values["department_id"]:
        raise ApiError(400, "กรุณาเลือกหน่วยงาน")
    if values["department_id"] and not req.conn.execute(
            "SELECT 1 FROM departments WHERE id = ?", (values["department_id"],)).fetchone():
        raise ApiError(400, "ไม่พบหน่วยงานนี้")
    if creating or b.get("password"):
        values["password_hash"] = hash_password(valid_password(b.get("password")))
    return values


def create_user(req):
    values = user_values(req, True)
    values["username"] = to_str(req.body.get("username"), "ชื่อผู้ใช้", True, 50)
    values["created_at"] = now()
    cols = ", ".join(values)
    try:
        user_id = req.conn.execute(f"INSERT INTO users ({cols}) VALUES ({', '.join('?' * len(values))})",
                                   list(values.values())).lastrowid
    except sqlite3.IntegrityError:
        raise ApiError(409, "มีชื่อผู้ใช้นี้แล้ว")
    return get_user(req.conn, user_id)


def update_user(req, user_id):
    get_user(req.conn, user_id)
    values = user_values(req, False)
    if user_id == req.user["id"] and (values["role"] != "admin" or not values["active"]):
        raise ApiError(400, "ไม่สามารถลดสิทธิ์หรือปิดบัญชีของตัวเองได้")
    sets = ", ".join(f"{k} = ?" for k in values)
    req.conn.execute(f"UPDATE users SET {sets} WHERE id = ?", [*values.values(), user_id])
    if not values["active"] or "password_hash" in values:
        req.conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    return get_user(req.conn, user_id)


def license_alerts(req):
    where, params = staff_scope(req)
    limit = str(today() + timedelta(days=LICENSE_WARN_DAYS))
    return [public_user(r) for r in req.conn.execute(
        USER_SELECT + f" WHERE u.active = 1 AND u.license_expiry IS NOT NULL AND u.license_expiry <= ? {where}"
        " ORDER BY u.license_expiry", [limit, *params])]


# ---------- การลา ----------

def count_workdays(start, end):
    """นับวันจันทร์-ศุกร์ (ยังไม่หักวันหยุดนักขัตฤกษ์)"""
    days, d = 0, start
    while d <= end:
        if d.weekday() < 5:
            days += 1
        d += timedelta(days=1)
    return days


def leave_quota(user, leave_type):
    if leave_type == "vacation":
        return user["vacation_quota"]
    return LEAVE_TYPES[leave_type][1]


def leave_balance_for(conn, user, year):
    used = {r["leave_type"]: r for r in conn.execute(
        """SELECT leave_type,
                  SUM(CASE WHEN status = 'approved' THEN days ELSE 0 END) AS used,
                  SUM(CASE WHEN status = 'pending' THEN days ELSE 0 END) AS pending
           FROM leaves WHERE user_id = ? AND fiscal_year = ? GROUP BY leave_type""",
        (user["id"], year))}
    result = []
    for key, (label, _) in LEAVE_TYPES.items():
        quota = leave_quota(user, key)
        row = used.get(key)
        result.append({
            "leave_type": key, "label": label, "quota": quota,
            "used": row["used"] if row else 0, "pending": row["pending"] if row else 0,
        })
    return result


def leave_balance(req):
    year = to_id(req.q("year") or fiscal_year(today()), "ปีงบประมาณ")
    user = req.user
    if req.q("user_id"):
        user = get_user(req.conn, to_id(req.q("user_id"), "ผู้ใช้"))
        check_staff_access(req, user)
    return {"fiscal_year": year, "user": user, "balance": leave_balance_for(req.conn, user, year)}


def check_staff_access(req, user):
    if req.user["role"] == "admin" or user["id"] == req.user["id"]:
        return
    if req.user["role"] == "head" and user["department_id"] == req.user["department_id"]:
        return
    raise ApiError(403, "ไม่มีสิทธิ์ดูข้อมูลนี้")


LEAVE_SELECT = """
    SELECT l.*, u.full_name, u.position, d.name AS department_name
    FROM leaves l JOIN users u ON u.id = l.user_id LEFT JOIN departments d ON d.id = l.department_id
"""


def get_leave(req, leave_id):
    row = req.conn.execute(LEAVE_SELECT + " WHERE l.id = ?", (leave_id,)).fetchone()
    if row is None:
        raise ApiError(404, "ไม่พบใบลานี้")
    leave = dict(row)
    if req.user["role"] == "staff" and leave["user_id"] != req.user["id"]:
        raise ApiError(404, "ไม่พบใบลานี้")
    if req.user["role"] == "head" and leave["user_id"] != req.user["id"] \
            and leave["department_id"] != req.user["department_id"]:
        raise ApiError(404, "ไม่พบใบลานี้")
    return leave


def list_leaves(req):
    where, params = ["1 = 1"], []
    scope = req.q("scope", "mine")
    if scope == "mine" or req.user["role"] == "staff":
        where.append("l.user_id = ?")
        params.append(req.user["id"])
    elif req.user["role"] == "head":
        where.append("l.department_id = ?")
        params.append(req.user["department_id"])
    if req.q("status"):
        where.append("l.status = ?")
        params.append(req.q("status"))
    if req.q("year"):
        where.append("l.fiscal_year = ?")
        params.append(to_id(req.q("year"), "ปีงบประมาณ"))
    return rows(req.conn.execute(
        LEAVE_SELECT + f" WHERE {' AND '.join(where)} ORDER BY l.created_at DESC LIMIT 500", params))


def create_leave(req):
    b = req.body
    user = req.user
    leave_type = to_choice(b.get("leave_type"), "ประเภทการลา", LEAVE_TYPES)
    start = to_date(b.get("start_date"), "วันที่เริ่มลา", True)
    end = to_date(b.get("end_date"), "วันที่สิ้นสุด", True)
    if end < start:
        raise ApiError(400, "วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มลา")
    if (end - start).days > 365:
        raise ApiError(400, "ช่วงวันลายาวเกินไป")
    if fiscal_year(start) != fiscal_year(end):
        raise ApiError(400, "ช่วงวันลาข้ามปีงบประมาณ กรุณาแยกเป็น 2 ใบ")
    half = to_bool(b.get("half_day"))
    if half and start != end:
        raise ApiError(400, "ลาครึ่งวันได้เฉพาะเมื่อลาวันเดียว")
    days = count_workdays(start, end)
    if days == 0:
        raise ApiError(400, "ช่วงวันที่เลือกเป็นวันเสาร์-อาทิตย์ทั้งหมด")
    if half:
        days = 0.5
    overlap = req.conn.execute(
        "SELECT doc_no FROM leaves WHERE user_id = ? AND status IN ('pending', 'approved')"
        " AND start_date <= ? AND end_date >= ?", (user["id"], str(end), str(start))).fetchone()
    if overlap:
        raise ApiError(409, f"ช่วงวันลาซ้ำกับใบลา {overlap[0]}")
    year = fiscal_year(start)
    quota = leave_quota(user, leave_type)
    if quota is not None:
        bal = next(x for x in leave_balance_for(req.conn, user, year) if x["leave_type"] == leave_type)
        remaining = quota - bal["used"] - bal["pending"]
        if days > remaining:
            raise ApiError(400, f"{LEAVE_TYPES[leave_type][0]}คงเหลือ {remaining:g} วัน ไม่พอสำหรับ {days:g} วัน")
    leave_id = req.conn.execute(
        """INSERT INTO leaves (doc_no, user_id, department_id, leave_type, start_date, end_date, days,
               fiscal_year, reason, contact, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)""",
        (next_doc_no(req.conn, "leaves", "LV"), user["id"], user["department_id"], leave_type, str(start), str(end),
         days, year, to_str(b.get("reason"), "เหตุผลการลา", max_len=500),
         to_str(b.get("contact"), "ที่ติดต่อระหว่างลา", max_len=200), now())).lastrowid
    return get_leave(req, leave_id)


def cancel_leave(req, leave_id):
    leave = get_leave(req, leave_id)
    if leave["user_id"] != req.user["id"] and req.user["role"] != "admin":
        raise ApiError(403, "ยกเลิกได้เฉพาะใบลาของตัวเอง")
    if leave["status"] != "pending":
        raise ApiError(409, "ยกเลิกได้เฉพาะใบลาที่ยังรออนุมัติ")
    req.conn.execute("UPDATE leaves SET status = 'cancelled' WHERE id = ?", (leave_id,))
    return get_leave(req, leave_id)


def check_can_approve(req, leave):
    if leave["status"] != "pending":
        raise ApiError(409, "ใบลานี้ไม่ได้อยู่ในสถานะรออนุมัติ")
    if leave["user_id"] == req.user["id"] and req.user["role"] != "admin":
        raise ApiError(403, "อนุมัติใบลาของตัวเองไม่ได้")
    if req.user["role"] == "head" and leave["department_id"] != req.user["department_id"]:
        raise ApiError(403, "อนุมัติได้เฉพาะใบลาในหน่วยงานของตัวเอง")


def approve_leave(req, leave_id):
    leave = get_leave(req, leave_id)
    check_can_approve(req, leave)
    req.conn.execute("UPDATE leaves SET status = 'approved', approver_name = ?, approved_at = ? WHERE id = ?",
                     (req.user["full_name"], now(), leave_id))
    return get_leave(req, leave_id)


def reject_leave(req, leave_id):
    leave = get_leave(req, leave_id)
    check_can_approve(req, leave)
    reason = to_str(req.body.get("reject_reason"), "เหตุผลที่ไม่อนุมัติ", True, 500)
    req.conn.execute(
        "UPDATE leaves SET status = 'rejected', approver_name = ?, approved_at = ?, reject_reason = ? WHERE id = ?",
        (req.user["full_name"], now(), reason, leave_id))
    return get_leave(req, leave_id)


# ---------- งานวิจัยและนวัตกรรม ----------

WORK_SELECT = """
    SELECT w.*, u.full_name AS owner_name, d.name AS department_name
    FROM works w JOIN users u ON u.id = w.user_id LEFT JOIN departments d ON d.id = w.department_id
"""


def get_work(req, work_id):
    row = req.conn.execute(WORK_SELECT + " WHERE w.id = ?", (work_id,)).fetchone()
    if row is None:
        raise ApiError(404, "ไม่พบผลงานนี้")
    work = dict(row)
    # ผลงานที่เผยแพร่แล้วทุกคนดูได้ ที่ยังไม่เผยแพร่ดูได้เฉพาะเจ้าของและผู้ดูแลระบบ
    if work["status"] != "approved" and req.user["role"] != "admin" and work["user_id"] != req.user["id"]:
        raise ApiError(404, "ไม่พบผลงานนี้")
    work.pop("file_key", None)
    work["has_file"] = bool(row["file_key"])
    return work


def list_works(req):
    where, params = [], []
    scope = req.q("scope", "library")
    if scope == "mine":
        where.append("w.user_id = ?")
        params.append(req.user["id"])
    elif scope == "review":
        if req.user["role"] != "admin":
            raise ApiError(403, "เฉพาะผู้ดูแลระบบเท่านั้น")
    else:
        where.append("w.status = 'approved'")
    if req.q("status"):
        where.append("w.status = ?")
        params.append(req.q("status"))
    if req.q("kind"):
        where.append("w.kind = ?")
        params.append(req.q("kind"))
    if req.q("year"):
        where.append("w.year = ?")
        params.append(to_id(req.q("year"), "ปี"))
    search = req.q("q").strip()
    if search:
        where.append("(w.title LIKE ? OR w.authors LIKE ? OR w.keywords LIKE ? OR w.abstract LIKE ?)")
        params += [f"%{search}%"] * 4
    sql = WORK_SELECT + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY w.updated_at DESC LIMIT 500"
    result = []
    for row in req.conn.execute(sql, params):
        work = dict(row)
        work["has_file"] = bool(work.pop("file_key"))
        result.append(work)
    return result


def save_pdf(data_b64, name):
    name = to_str(name, "ชื่อไฟล์", True, 200)
    if not name.lower().endswith(".pdf"):
        raise ApiError(400, "แนบได้เฉพาะไฟล์ PDF")
    try:
        data = base64.b64decode(data_b64, validate=True)
    except (ValueError, TypeError):
        raise ApiError(400, "ไฟล์แนบไม่ถูกต้อง")
    if not data.startswith(b"%PDF"):
        raise ApiError(400, "ไฟล์แนบไม่ใช่ PDF")
    key = secrets.token_hex(16) + ".pdf"
    (FILES_DIR / key).write_bytes(data)
    return name, key


def work_values(req):
    b = req.body
    year = to_id(b.get("year"), "ปี พ.ศ.")
    if not 2500 <= year <= 2700:
        raise ApiError(400, "ปี พ.ศ. ไม่ถูกต้อง")
    return {
        "kind": to_choice(b.get("kind"), "ประเภทผลงาน", WORK_KINDS),
        "title": to_str(b.get("title"), "ชื่อผลงาน", True, 300),
        "authors": to_str(b.get("authors"), "ผู้จัดทำ", True, 500),
        "abstract": to_str(b.get("abstract"), "บทคัดย่อ", max_len=5000),
        "keywords": to_str(b.get("keywords"), "คำสำคัญ", max_len=300),
        "year": year,
    }


def create_work(req):
    values = work_values(req)
    file_name = file_key = None
    if req.body.get("file_data"):
        file_name, file_key = save_pdf(req.body["file_data"], req.body.get("file_name"))
    ts = now()
    work_id = req.conn.execute(
        """INSERT INTO works (doc_no, kind, title, authors, abstract, keywords, year, user_id, department_id,
               file_name, file_key, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?)""",
        (next_doc_no(req.conn, "works", "RI"), *values.values(), req.user["id"], req.user["department_id"],
         file_name, file_key, ts, ts)).lastrowid
    return get_work(req, work_id)


def update_work(req, work_id):
    work = get_work(req, work_id)
    if work["user_id"] != req.user["id"] and req.user["role"] != "admin":
        raise ApiError(403, "แก้ไขได้เฉพาะผลงานของตัวเอง")
    if work["status"] not in ("submitted", "revise") and req.user["role"] != "admin":
        raise ApiError(409, "ผลงานนี้พิจารณาแล้ว แก้ไขไม่ได้")
    values = work_values(req)
    if req.body.get("file_data"):
        old = req.conn.execute("SELECT file_key FROM works WHERE id = ?", (work_id,)).fetchone()[0]
        values["file_name"], values["file_key"] = save_pdf(req.body["file_data"], req.body.get("file_name"))
        if old:
            (FILES_DIR / old).unlink(missing_ok=True)
    if work["status"] == "revise" and work["user_id"] == req.user["id"]:
        values["status"] = "submitted"   # ส่งกลับมาพิจารณาใหม่หลังแก้ไข
    values["updated_at"] = now()
    sets = ", ".join(f"{k} = ?" for k in values)
    req.conn.execute(f"UPDATE works SET {sets} WHERE id = ?", [*values.values(), work_id])
    return get_work(req, work_id)


def review_work(req, work_id):
    get_work(req, work_id)
    status = to_choice(req.body.get("status"), "ผลการพิจารณา", ("approved", "revise", "rejected"))
    note = to_str(req.body.get("review_note"), "ความเห็น", status != "approved", 2000)
    req.conn.execute(
        "UPDATE works SET status = ?, review_note = ?, reviewer_name = ?, reviewed_at = ?, updated_at = ? WHERE id = ?",
        (status, note, req.user["full_name"], now(), now(), work_id))
    return get_work(req, work_id)


def work_file(req, work_id):
    work = get_work(req, work_id)
    key = req.conn.execute("SELECT file_key FROM works WHERE id = ?", (work_id,)).fetchone()[0]
    if not key or not (FILES_DIR / key).is_file():
        raise ApiError(404, "ผลงานนี้ไม่มีไฟล์แนบ")
    return FileResponse(FILES_DIR / key, work["file_name"])


# ---------- หน้าแรก ----------

def dashboard(req):
    year = fiscal_year(today())
    user = req.user
    result = {
        "fiscal_year": year,
        "balance": leave_balance_for(req.conn, user, year),
        "my_pending_leaves": req.conn.execute(
            "SELECT COUNT(*) FROM leaves WHERE user_id = ? AND status = 'pending'", (user["id"],)).fetchone()[0],
        "my_works": rows(req.conn.execute(
            "SELECT status, COUNT(*) AS n FROM works WHERE user_id = ? GROUP BY status", (user["id"],))),
        "library_count": req.conn.execute("SELECT COUNT(*) FROM works WHERE status = 'approved'").fetchone()[0],
        "on_leave_today": [],
    }
    if user["role"] in ("head", "admin"):
        dept_where = "" if user["role"] == "admin" else " AND l.department_id = ?"
        params = [] if user["role"] == "admin" else [user["department_id"]]
        result["leaves_to_approve"] = req.conn.execute(
            f"SELECT COUNT(*) FROM leaves l WHERE l.status = 'pending' AND l.user_id != ? {dept_where}",
            [user["id"], *params]).fetchone()[0]
        result["on_leave_today"] = rows(req.conn.execute(
            LEAVE_SELECT + f" WHERE l.status = 'approved' AND l.start_date <= ? AND l.end_date >= ? {dept_where}"
            " ORDER BY u.full_name", [str(today()), str(today()), *params]))
        result["license_alerts"] = license_alerts(req)
    if user["role"] == "admin":
        result["works_to_review"] = req.conn.execute(
            "SELECT COUNT(*) FROM works WHERE status = 'submitted'").fetchone()[0]
        result["staff_count"] = req.conn.execute("SELECT COUNT(*) FROM users WHERE active = 1").fetchone()[0]
    return result


# ---------- เส้นทาง API ----------

ROUTES = []
ID = r"(\d+)"


def route(method, pattern, handler, access="user"):
    """access: public = ไม่ต้องล็อกอิน, user = ทุกคนที่ล็อกอิน, manager = หัวหน้างานหรือผู้ดูแล, admin = ผู้ดูแลระบบ"""
    ROUTES.append((method, re.compile(f"^/api{pattern}$"), handler, access))


route("GET", "/setup", setup_status, "public")
route("POST", "/setup", setup, "public")
route("POST", "/login", login, "public")
route("POST", "/logout", logout)
route("GET", "/me", me)
route("PUT", "/me", update_me)
route("POST", "/me/password", change_password)
route("GET", "/meta", meta)
route("GET", "/dashboard", dashboard)
route("GET", "/departments", list_departments)
route("POST", "/departments", create_department, "admin")
route("PUT", f"/departments/{ID}", update_department, "admin")
route("GET", "/users", list_users, "manager")
route("POST", "/users", create_user, "admin")
route("PUT", f"/users/{ID}", update_user, "admin")
route("GET", "/license-alerts", license_alerts, "manager")
route("GET", "/leaves", list_leaves)
route("POST", "/leaves", create_leave)
route("GET", "/leaves/balance", leave_balance)
route("GET", f"/leaves/{ID}", get_leave)
route("POST", f"/leaves/{ID}/cancel", cancel_leave)
route("POST", f"/leaves/{ID}/approve", approve_leave, "manager")
route("POST", f"/leaves/{ID}/reject", reject_leave, "manager")
route("GET", "/works", list_works)
route("POST", "/works", create_work)
route("GET", f"/works/{ID}", get_work)
route("PUT", f"/works/{ID}", update_work)
route("POST", f"/works/{ID}/review", review_work, "admin")
route("GET", f"/works/{ID}/file", work_file)

UPLOAD_PATHS = re.compile(r"^/api/works(/\d+)?$")

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".png": "image/png",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "TPYHub/1.0"

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
                        if access != "public" and req.user is None:
                            raise ApiError(401, "กรุณาเข้าสู่ระบบ")
                        if access == "admin" and req.user["role"] != "admin":
                            raise ApiError(403, "เฉพาะผู้ดูแลระบบเท่านั้น")
                        if access == "manager" and req.user["role"] not in ("admin", "head"):
                            raise ApiError(403, "เฉพาะหัวหน้างานหรือผู้ดูแลระบบเท่านั้น")
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
            raise ApiError(413, "ข้อมูลใหญ่เกินไป (ไฟล์ PDF ต้องไม่เกิน 15 MB)")
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
        data = file.path.read_bytes()
        ascii_name = re.sub(r"[^A-Za-z0-9._-]", "_", file.name)
        self.send_response(200)
        self.send_header("Content-Type", file.content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition",
                         f"inline; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(file.name)}")
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
    print(f"TPY Hub กำลังทำงานที่ {url}  (กด Ctrl+C เพื่อหยุด)")
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
