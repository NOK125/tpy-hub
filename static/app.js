"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const view = $("#view");
const dlg = $("#dlg");

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (v) => (v == null || v === "" ? "-" : Number(v).toLocaleString("th-TH", { maximumFractionDigits: 2 }));

// วันที่แบบไทย: 26/09/2569 21:19
function when(ts, withTime = true) {
  if (!ts) return "-";
  const [d, t = ""] = ts.split("T");
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${Number(y) + 543}${withTime && t ? " " + t.slice(0, 5) : ""}`;
}
const daysUntil = (d) => Math.round((new Date(d + "T00:00:00") - new Date(new Date().toDateString())) / 86400000);

let me = null;
let META = null;
let unauthorized = () => {};

async function api(method, path, body) {
  const res = await fetch("/api" + path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/login") unauthorized();
  if (!res.ok) throw new Error(data.error || `เกิดข้อผิดพลาด (${res.status})`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = isError ? "error" : "";
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 2500);
}

// ---------- ส่วนประกอบหน้าจอ ----------

function table(headers, rowsHtml, emptyText) {
  if (!rowsHtml.length) return `<p class="empty">${esc(emptyText)}</p>`;
  const th = headers.map((h) => (Array.isArray(h) ? `<th class="${h[1]}">${esc(h[0])}</th>` : `<th>${esc(h)}</th>`));
  const td = (c) => (Array.isArray(c) ? `<td class="${c[1]}">${c[0]}</td>` : `<td>${c}</td>`);
  return `<div class="table-wrap"><table><thead><tr>${th.join("")}</tr></thead><tbody>${rowsHtml
    .map((cells) => `<tr>${cells.map(td).join("")}</tr>`).join("")}</tbody></table></div>`;
}

const btn = (act, text, id = "", cls = "") =>
  `<button type="button" class="btn small ${cls}" data-act="${act}" data-id="${esc(id)}">${esc(text)}</button>`;
const actions = (...buttons) => [buttons.join(""), "actions"];
const badge = (text, cls) => `<span class="badge ${cls}">${esc(text)}</span>`;
const option = (value, text, selected) =>
  `<option value="${esc(value)}" ${String(value) === String(selected ?? "") ? "selected" : ""}>${esc(text)}</option>`;

function bind(handlers) {
  view.onclick = (e) => {
    const b = e.target.closest("[data-act]");
    if (b && handlers[b.dataset.act]) handlers[b.dataset.act](b.dataset.id, b);
  };
}

function fieldHtml(f, values = {}) {
  const v = values[f.name] ?? f.value ?? "";
  const attrs = [
    `name="${f.name}"`,
    f.required ? "required" : "",
    f.min != null ? `min="${f.min}"` : "",
    f.max != null ? `max="${f.max}"` : "",
    f.type === "number" ? `step="${f.step || "any"}"` : "",
    f.placeholder ? `placeholder="${esc(f.placeholder)}"` : "",
    f.autocomplete ? `autocomplete="${f.autocomplete}"` : "",
    f.accept ? `accept="${f.accept}"` : "",
  ].join(" ");
  if (f.type === "checkbox") {
    return `<label class="field checkbox"><input type="checkbox" ${attrs} ${v === true || v === 1 || v === "1" ? "checked" : ""}><span>${esc(f.label)}</span></label>`;
  }
  let input;
  if (f.type === "select") input = `<select ${attrs}>${f.options.map(([val, text]) => option(val, text, v)).join("")}</select>`;
  else if (f.type === "textarea") input = `<textarea ${attrs}>${esc(v)}</textarea>`;
  else if (f.type === "file") input = `<input type="file" ${attrs}>`;
  else input = `<input type="${f.type || "text"}" value="${esc(v)}" ${attrs}>`;
  return `<label class="field"><span>${esc(f.label)}${f.required ? " *" : ""}</span>${input}${
    f.hint ? `<small>${esc(f.hint)}</small>` : ""}</label>`;
}

function dialogShell(title, inner, submitLabel = "บันทึก", cancelLabel = "ยกเลิก") {
  return `<form class="form">
    <h2>${title}</h2>
    ${inner}
    <p class="form-error" hidden></p>
    <div class="actions">
      <button type="button" class="btn" data-cancel>${esc(cancelLabel)}</button>
      ${submitLabel ? `<button type="submit" class="btn primary">${esc(submitLabel)}</button>` : ""}
    </div>
  </form>`;
}

function wireDialog(onSubmit) {
  const form = $("form", dlg);
  const error = $(".form-error", form);
  $("[data-cancel]", form).onclick = () => dlg.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const submit = $("button[type=submit]", form);
    if (submit) submit.disabled = true;
    error.hidden = true;
    try {
      const data = Object.fromEntries(new FormData(form));
      $$("input[type=checkbox]", form).forEach((c) => (data[c.name] = c.checked));
      await onSubmit(data, form);
      dlg.close();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      if (submit) submit.disabled = false;
    }
  };
  if (!dlg.open) dlg.showModal();
  return form;
}

function openForm({ title, fields, values = {}, submitLabel, intro = "", extra = "", onSubmit, wide = false, two = false }) {
  dlg.className = wide ? "wide" : "";
  dlg.innerHTML = dialogShell(esc(title),
    `${intro}<div class="fields ${two ? "two" : ""}">${fields.map((f) => fieldHtml(f, values)).join("")}</div>${extra}`, submitLabel);
  const form = wireDialog(onSubmit);
  $("input:not([type=hidden]), select, textarea", form)?.focus();
  return form;
}

const cell = (label, value) => `<div><small>${label}</small><div>${value}</div></div>`;

// ---------- การลา ----------

const LEAVE_BADGE = { pending: "warn", approved: "ok", rejected: "bad", cancelled: "muted" };
const leaveBadge = (s) => badge(META.leave_status[s], LEAVE_BADGE[s]);
const leaveType = (t) => META.leave_types[t] || t;
const leaveRange = (l) => (l.start_date === l.end_date ? when(l.start_date, false) : `${when(l.start_date, false)} – ${when(l.end_date, false)}`);

function balanceHtml(balance) {
  return `<div class="balance">${balance.filter((b) => b.quota != null || b.used || b.pending).map((b) => {
    const left = b.quota == null ? null : b.quota - b.used - b.pending;
    const pct = b.quota ? Math.min(100, ((b.used + b.pending) / b.quota) * 100) : 0;
    return `<div><small>${esc(b.label)}</small>
      <b>${left == null ? num(b.used) : num(left)}</b>
      <small>${left == null ? "วันที่ใช้ไป" : `คงเหลือจาก ${num(b.quota)} วัน`}${b.pending ? ` · รออนุมัติ ${num(b.pending)}` : ""}</small>
      ${b.quota ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ""}</div>`;
  }).join("")}</div>`;
}

function newLeave() {
  const form = openForm({
    title: "ยื่นใบลา",
    two: true,
    fields: [
      { name: "leave_type", label: "ประเภทการลา", type: "select", required: true,
        options: Object.entries(META.leave_types) },
      { name: "half_day", label: "ลาครึ่งวัน (เฉพาะลาวันเดียว)", type: "checkbox" },
      { name: "start_date", label: "ตั้งแต่วันที่", type: "date", required: true },
      { name: "end_date", label: "ถึงวันที่", type: "date", required: true },
      { name: "reason", label: "เหตุผล", type: "textarea" },
      { name: "contact", label: "ติดต่อได้ที่", placeholder: "เบอร์โทรหรือที่อยู่ระหว่างลา", value: me.phone || "" },
    ],
    intro: `<p class="hint">นับเฉพาะวันจันทร์–ศุกร์ ระบบยังไม่หักวันหยุดนักขัตฤกษ์ ถ้าช่วงลามีวันหยุดราชการให้แยกเป็นหลายใบ</p>`,
    submitLabel: "ส่งใบลา",
    onSubmit: async (d) => {
      const leave = await api("POST", "/leaves", d);
      toast(`ส่งใบลา ${leave.doc_no} แล้ว (${num(leave.days)} วัน)`);
      refresh();
    },
  });
  const start = $("[name=start_date]", form);
  const end = $("[name=end_date]", form);
  start.onchange = () => { if (!end.value || end.value < start.value) end.value = start.value; end.min = start.value; };
}

async function openLeave(id) {
  let l;
  try { l = await api("GET", `/leaves/${id}`); } catch (e) { return toast(e.message, true); }
  const manager = me.role !== "staff";
  const canApprove = l.status === "pending" && manager && (l.user_id !== me.id || me.role === "admin");
  const buttons = [];
  if (canApprove) buttons.push(btn("approve", "อนุมัติ", "", "primary"), btn("reject", "ไม่อนุมัติ", "", "danger"));
  if (l.status === "pending" && (l.user_id === me.id || me.role === "admin")) buttons.push(btn("cancel", "ยกเลิกใบลา", "", "danger"));
  buttons.push(btn("print", "พิมพ์ใบลา"));
  dlg.className = "wide";
  dlg.innerHTML = dialogShell(`ใบลา ${esc(l.doc_no)} ${leaveBadge(l.status)}`, `
    <div class="info-grid">
      ${cell("ผู้ลา", `${esc(l.full_name)}<br><small>${esc(l.position || "")}</small>`)}
      ${cell("หน่วยงาน", esc(l.department_name || "-"))}
      ${cell("ประเภท", esc(leaveType(l.leave_type)))}
      ${cell("ช่วงวันลา", `${leaveRange(l)} <b>(${num(l.days)} วัน)</b>`)}
      ${cell("ยื่นเมื่อ", when(l.created_at))}
      ${cell("ผู้พิจารณา", l.approver_name ? `${esc(l.approver_name)} <small>${when(l.approved_at)}</small>` : "-")}
    </div>
    ${l.reason ? `<p class="hint"><b>เหตุผล:</b> ${esc(l.reason)}</p>` : ""}
    ${l.contact ? `<p><small>ติดต่อระหว่างลา:</small> ${esc(l.contact)}</p>` : ""}
    ${l.reject_reason ? `<p class="form-error"><b>เหตุผลที่ไม่อนุมัติ:</b> ${esc(l.reject_reason)}</p>` : ""}
    <div class="doc-actions">${buttons.join("")}</div>`, null, "ปิด");
  const form = wireDialog(() => {});
  form.onclick = async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "print") return printLeave(l);
    if (act === "approve" || act === "cancel") {
      if (!confirm(act === "approve" ? `อนุมัติใบลา ${l.doc_no} ของ ${l.full_name}?` : `ยกเลิกใบลา ${l.doc_no}?`)) return;
      try {
        await api("POST", `/leaves/${id}/${act}`, {});
        toast(act === "approve" ? "อนุมัติแล้ว" : "ยกเลิกใบลาแล้ว");
        dlg.close();
        refresh();
      } catch (err) { toast(err.message, true); }
    }
    if (act === "reject") {
      openForm({
        title: `ไม่อนุมัติใบลา ${l.doc_no}`,
        fields: [{ name: "reject_reason", label: "เหตุผล", type: "textarea", required: true }],
        submitLabel: "ยืนยันไม่อนุมัติ",
        onSubmit: async (d) => { await api("POST", `/leaves/${id}/reject`, d); toast("บันทึกไม่อนุมัติแล้ว"); refresh(); },
      });
    }
  };
}

function printLeave(l) {
  $("#print").innerHTML = `
    <h1>แบบใบ${esc(leaveType(l.leave_type))}</h1>
    <p class="center">โรงพยาบาลตาพระยา · เลขที่ ${esc(l.doc_no)}</p>
    <p style="text-align:right">เขียนวันที่ ${when(l.created_at, false)}</p>
    <p>เรียน ผู้อำนวยการโรงพยาบาลตาพระยา</p>
    <p style="text-indent:3em;line-height:2">ข้าพเจ้า ${esc(l.full_name)} ตำแหน่ง ${esc(l.position || "............................")}
      สังกัด ${esc(l.department_name || "............................")} ขอ${esc(leaveType(l.leave_type))}
      ${l.reason ? `เนื่องจาก ${esc(l.reason)}` : ""} ตั้งแต่วันที่ ${when(l.start_date, false)} ถึงวันที่ ${when(l.end_date, false)}
      มีกำหนด ${num(l.days)} วัน ${l.contact ? `ในระหว่างลาจะติดต่อข้าพเจ้าได้ที่ ${esc(l.contact)}` : ""}</p>
    <div class="signs">
      <div></div>
      <div class="sign"><div>ลงชื่อ .......................................</div><div>( ${esc(l.full_name)} )</div></div>
      <div class="sign"><b>ความเห็นผู้บังคับบัญชา</b><div>${l.status === "approved" ? "☑ อนุมัติ ☐ ไม่อนุมัติ" : l.status === "rejected" ? "☐ อนุมัติ ☑ ไม่อนุมัติ" : "☐ อนุมัติ ☐ ไม่อนุมัติ"}</div>
        <div>ลงชื่อ .......................................</div><div>( ${esc(l.approver_name || "......................................")} )</div>
        <div>วันที่ ${l.approved_at ? when(l.approved_at, false) : "......../......../........"}</div></div>
    </div>`;
  window.print();
}

function leavesTable(list, showPerson) {
  const headers = ["เลขที่", ...(showPerson ? ["ผู้ลา", "หน่วยงาน"] : []), "ประเภท", "ช่วงวันลา", ["วัน", "num"], "สถานะ", ""];
  return table(headers, list.map((l) => [
    esc(l.doc_no),
    ...(showPerson ? [esc(l.full_name), esc(l.department_name || "-")] : []),
    esc(leaveType(l.leave_type)), leaveRange(l), [num(l.days), "num"], leaveBadge(l.status),
    actions(btn("open", "ดู", l.id)),
  ]), "ไม่มีใบลา");
}

async function leavesView() {
  const [list, bal] = await Promise.all([api("GET", "/leaves?scope=mine"), api("GET", "/leaves/balance")]);
  view.innerHTML = `
    <section class="card">
      <div class="toolbar"><h2>วันลาคงเหลือ ปีงบประมาณ ${bal.fiscal_year}</h2>
        <button class="btn primary" data-act="new">+ ยื่นใบลา</button></div>
      ${balanceHtml(bal.balance)}
    </section>
    <section class="list"><div class="toolbar"><h2>ใบลาของฉัน</h2></div>${leavesTable(list, false)}</section>`;
  bind({ new: newLeave, open: openLeave });
}

async function approveView() {
  const status = sessionStorage.getItem("leave-status") ?? "pending";
  const list = await api("GET", `/leaves?scope=all${status ? "&status=" + status : ""}`);
  view.innerHTML = `<section class="list">
    <div class="toolbar"><h2>ใบลา${me.role === "admin" ? "ทั้งโรงพยาบาล" : "ในหน่วยงาน"}</h2>
      <select id="status">${option("", "ทุกสถานะ", status)}${Object.entries(META.leave_status).map(([k, v]) => option(k, v, status)).join("")}</select>
    </div>${leavesTable(list, true)}</section>`;
  $("#status").onchange = (e) => { try { sessionStorage.setItem("leave-status", e.target.value); } catch {} refresh(); };
  bind({ open: openLeave });
}

// ---------- งานวิจัยและนวัตกรรม ----------

const WORK_BADGE = { submitted: "warn", revise: "info", approved: "ok", rejected: "bad" };
const workBadge = (s) => badge(META.work_status[s], WORK_BADGE[s]);

function readPdf(input) {
  const file = input?.files?.[0];
  if (!file) return Promise.resolve(null);
  if (file.size > 15 * 1024 * 1024) return Promise.reject(new Error("ไฟล์ PDF ต้องไม่เกิน 15 MB"));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ file_name: file.name, file_data: reader.result.split(",")[1] });
    reader.onerror = () => reject(new Error("อ่านไฟล์ไม่สำเร็จ"));
    reader.readAsDataURL(file);
  });
}

function workForm(work) {
  const thisYear = new Date().getFullYear() + 543;
  const form = openForm({
    title: work ? `แก้ไขผลงาน ${work.doc_no}` : "ส่งผลงานวิจัย / นวัตกรรม",
    wide: true,
    two: true,
    values: work || { year: thisYear, authors: me.full_name },
    fields: [
      { name: "kind", label: "ประเภทผลงาน", type: "select", required: true, options: Object.entries(META.work_kinds) },
      { name: "year", label: "ปี พ.ศ.", type: "number", required: true, min: 2500, max: 2700, step: 1 },
      { name: "title", label: "ชื่อผลงาน", required: true },
      { name: "authors", label: "ผู้จัดทำ", required: true, hint: "คั่นแต่ละคนด้วยเครื่องหมายจุลภาค (,)" },
      { name: "keywords", label: "คำสำคัญ", placeholder: "เช่น ผู้สูงอายุ, การพยาบาล, ลดเวลารอคอย" },
      { name: "file", label: work?.file_name ? `ไฟล์ PDF (มีแล้ว: ${work.file_name})` : "ไฟล์ PDF", type: "file", accept: "application/pdf,.pdf",
        hint: work?.file_name ? "เลือกไฟล์ใหม่ถ้าต้องการแทนที่" : "ไม่เกิน 15 MB" },
      { name: "abstract", label: "บทคัดย่อ", type: "textarea" },
    ],
    submitLabel: work ? "บันทึก" : "ส่งผลงาน",
    onSubmit: async (d, f) => {
      const file = await readPdf($("[name=file]", f));
      delete d.file;
      const body = { ...d, ...(file || {}) };
      const saved = await api(work ? "PUT" : "POST", work ? `/works/${work.id}` : "/works", body);
      toast(work ? "บันทึกแล้ว" : `ส่งผลงาน ${saved.doc_no} แล้ว รอผู้ดูแลพิจารณา`);
      refresh();
    },
  });
  $("[name=abstract]", form).closest(".field").style.gridColumn = "1 / -1";
}

async function openWork(id) {
  let w;
  try { w = await api("GET", `/works/${id}`); } catch (e) { return toast(e.message, true); }
  const buttons = [];
  if (w.has_file) buttons.push(`<a class="btn small primary" href="/api/works/${w.id}/file" target="_blank" rel="noopener">เปิดไฟล์ PDF</a>`);
  if ((w.user_id === me.id && ["submitted", "revise"].includes(w.status)) || me.role === "admin") buttons.push(btn("edit", "แก้ไข"));
  if (me.role === "admin") buttons.push(btn("review", "พิจารณา", "", w.status === "submitted" ? "primary" : ""));
  dlg.className = "wide";
  dlg.innerHTML = dialogShell(`${esc(w.title)}`, `
    <p>${badge(META.work_kinds[w.kind], "info")} ${workBadge(w.status)} <small>${esc(w.doc_no)}</small></p>
    <div class="info-grid">
      ${cell("ผู้จัดทำ", esc(w.authors))}
      ${cell("หน่วยงาน", esc(w.department_name || "-"))}
      ${cell("ปี พ.ศ.", esc(w.year))}
      ${cell("ส่งโดย", `${esc(w.owner_name)} <small>${when(w.created_at, false)}</small>`)}
    </div>
    ${w.keywords ? `<p><small>คำสำคัญ:</small> ${esc(w.keywords)}</p>` : ""}
    ${w.abstract ? `<h3>บทคัดย่อ</h3><p class="abstract">${esc(w.abstract)}</p>` : ""}
    ${w.review_note ? `<p class="${w.status === "approved" ? "hint" : "form-error"}"><b>ความเห็นผู้พิจารณา (${esc(w.reviewer_name)}):</b> ${esc(w.review_note)}</p>` : ""}
    <div class="doc-actions">${buttons.join("")}</div>`, null, "ปิด");
  const form = wireDialog(() => {});
  form.onclick = (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "edit") workForm(w);
    if (b.dataset.act === "review") {
      openForm({
        title: `พิจารณาผลงาน ${w.doc_no}`,
        fields: [
          { name: "status", label: "ผลการพิจารณา", type: "select", required: true, value: "approved",
            options: [["approved", "อนุมัติ เผยแพร่ในคลังผลงาน"], ["revise", "ส่งกลับให้แก้ไข"], ["rejected", "ไม่อนุมัติ"]] },
          { name: "review_note", label: "ความเห็น", type: "textarea", hint: "จำเป็นเมื่อส่งกลับแก้ไขหรือไม่อนุมัติ" },
        ],
        submitLabel: "บันทึกผลพิจารณา",
        onSubmit: async (d) => { await api("POST", `/works/${id}/review`, d); toast("บันทึกผลพิจารณาแล้ว"); refresh(); },
      });
    }
  };
}

const workCard = (w, showStatus) => `<button type="button" class="work" data-act="open" data-id="${w.id}">
    ${badge(META.work_kinds[w.kind], "info")} ${showStatus ? workBadge(w.status) : ""} <small>${esc(w.year)}${w.has_file ? " · PDF" : ""}</small>
    <h3>${esc(w.title)}</h3>
    <p>${esc(w.authors)}${w.department_name ? ` · ${esc(w.department_name)}` : ""}</p>
  </button>`;

async function libraryView() {
  view.innerHTML = `<div class="toolbar"><h2>คลังผลงานวิจัยและนวัตกรรม</h2>
      <input type="search" id="q" placeholder="ค้นหาชื่อเรื่อง ผู้จัดทำ คำสำคัญ">
      <select id="kind">${option("", "ทุกประเภท")}${Object.entries(META.work_kinds).map(([k, v]) => option(k, v)).join("")}</select>
    </div><div class="works" id="list"></div>`;
  let timer;
  const load = async () => {
    const params = new URLSearchParams({ scope: "library", q: $("#q").value, kind: $("#kind").value });
    const list = await api("GET", "/works?" + params);
    $("#list").innerHTML = list.length ? list.map((w) => workCard(w, false)).join("") : `<p class="empty">ยังไม่มีผลงานที่ตรงกับการค้นหา</p>`;
  };
  $("#q").oninput = () => { clearTimeout(timer); timer = setTimeout(() => load().catch((e) => toast(e.message, true)), 300); };
  $("#kind").onchange = () => load().catch((e) => toast(e.message, true));
  bind({ open: openWork });
  await load();
}

async function myWorksView() {
  const list = await api("GET", "/works?scope=mine");
  view.innerHTML = `<div class="toolbar"><h2>ผลงานของฉัน</h2><button class="btn primary" data-act="new">+ ส่งผลงาน</button></div>
    <div class="works">${list.length ? list.map((w) => workCard(w, true)).join("") : `<p class="empty">ยังไม่ได้ส่งผลงาน</p>`}</div>`;
  bind({ new: () => workForm(null), open: openWork });
}

async function reviewView() {
  const status = sessionStorage.getItem("work-status") ?? "submitted";
  const list = await api("GET", `/works?scope=review${status ? "&status=" + status : ""}`);
  view.innerHTML = `<section class="list">
    <div class="toolbar"><h2>พิจารณาผลงาน</h2>
      <select id="status">${option("", "ทุกสถานะ", status)}${Object.entries(META.work_status).map(([k, v]) => option(k, v, status)).join("")}</select>
    </div>
    ${table(["เลขที่", "ชื่อผลงาน", "ประเภท", "ผู้ส่ง", "ส่งเมื่อ", "สถานะ", ""], list.map((w) => [
      esc(w.doc_no), esc(w.title), esc(META.work_kinds[w.kind]), esc(w.owner_name), when(w.created_at, false), workBadge(w.status),
      actions(btn("open", "ดู", w.id)),
    ]), "ไม่มีผลงานในสถานะนี้")}</section>`;
  $("#status").onchange = (e) => { try { sessionStorage.setItem("work-status", e.target.value); } catch {} refresh(); };
  bind({ open: openWork });
}

// ---------- บุคลากรและหน่วยงาน ----------

function licenseCell(u) {
  if (!u.license_expiry) return "-";
  const d = daysUntil(u.license_expiry);
  const cls = d < 0 ? "bad" : d <= 90 ? "warn" : "";
  const text = d < 0 ? `หมดอายุแล้ว ${-d} วัน` : d <= 90 ? `อีก ${d} วัน` : "";
  return `${when(u.license_expiry, false)}${cls ? ` ${badge(text, cls)}` : ""}`;
}

async function userForm(user, departments) {
  openForm({
    title: user ? `แก้ไข ${user.full_name}` : "เพิ่มบุคลากร",
    wide: true,
    two: true,
    values: user || { role: "staff", vacation_quota: 10, active: true },
    fields: [
      { name: "full_name", label: "ชื่อ-นามสกุล", required: true },
      ...(user ? [] : [{ name: "username", label: "ชื่อผู้ใช้ (ล็อกอิน)", required: true, autocomplete: "off" }]),
      { name: "password", label: user ? "ตั้งรหัสผ่านใหม่" : "รหัสผ่าน", type: "password", required: !user, autocomplete: "new-password",
        hint: user ? "เว้นว่างถ้าไม่เปลี่ยน" : "อย่างน้อย 6 ตัวอักษร" },
      { name: "role", label: "สิทธิ์", type: "select", required: true, options: Object.entries(META.roles) },
      { name: "department_id", label: "หน่วยงาน", type: "select",
        options: [["", "— เลือกหน่วยงาน —"], ...departments.filter((d) => d.active || d.id === user?.department_id).map((d) => [d.id, d.name])] },
      { name: "position", label: "ตำแหน่ง", placeholder: "เช่น พยาบาลวิชาชีพชำนาญการ" },
      { name: "profession", label: "วิชาชีพ", placeholder: "เช่น พยาบาล, เภสัชกร" },
      { name: "employment_type", label: "ประเภทการจ้าง", placeholder: "เช่น ข้าราชการ, พนักงานราชการ, ลูกจ้าง" },
      { name: "start_date", label: "วันที่เริ่มงาน", type: "date" },
      { name: "phone", label: "เบอร์โทร" },
      { name: "license_no", label: "เลขที่ใบประกอบวิชาชีพ" },
      { name: "license_expiry", label: "วันหมดอายุใบประกอบวิชาชีพ", type: "date" },
      { name: "vacation_quota", label: "วันลาพักผ่อนต่อปี", type: "number", required: true, min: 0, hint: "รวมวันสะสมแล้ว" },
      { name: "active", label: "เปิดใช้งาน", type: "checkbox" },
    ],
    onSubmit: async (d) => {
      await api(user ? "PUT" : "POST", user ? `/users/${user.id}` : "/users", d);
      toast("บันทึกแล้ว");
      refresh();
    },
  });
}

async function staffView() {
  const admin = me.role === "admin";
  const showAll = sessionStorage.getItem("staff-all") === "1";
  const [users, departments] = await Promise.all([
    api("GET", `/users${showAll ? "?active=all" : ""}`), api("GET", "/departments")]);
  view.innerHTML = `<section class="list">
    <div class="toolbar"><h2>บุคลากร${admin ? "" : ` · ${esc(me.department_name || "")}`} <small>(${users.length} คน)</small></h2>
      <input type="search" id="q" placeholder="ค้นหาชื่อหรือตำแหน่ง">
      ${admin ? `<label class="checkbox"><input type="checkbox" id="all" ${showAll ? "checked" : ""}> รวมที่ปิดใช้งาน</label>
        <button class="btn primary" data-act="new">+ เพิ่มบุคลากร</button>` : ""}
    </div><div id="list"></div></section>`;
  const draw = () => {
    const q = $("#q").value.trim().toLowerCase();
    const shown = users.filter((u) => !q || `${u.full_name} ${u.position || ""} ${u.username}`.toLowerCase().includes(q));
    $("#list").innerHTML = table(["ชื่อ-นามสกุล", "ตำแหน่ง", "หน่วยงาน", "สิทธิ์", "ใบประกอบวิชาชีพหมดอายุ", ""], shown.map((u) => [
      `${esc(u.full_name)}${u.active ? "" : ` ${badge("ปิดใช้งาน", "muted")}`}<br><small>${esc(u.username)}</small>`,
      esc(u.position || "-"), esc(u.department_name || "-"), esc(META.roles[u.role]), licenseCell(u),
      actions(btn("leaves", "วันลา", u.id), admin ? btn("edit", "แก้ไข", u.id) : ""),
    ]), "ไม่พบบุคลากร");
  };
  $("#q").oninput = draw;
  if ($("#all")) $("#all").onchange = (e) => { try { sessionStorage.setItem("staff-all", e.target.checked ? "1" : "0"); } catch {} refresh(); };
  draw();
  const byId = (id) => users.find((u) => String(u.id) === id);
  bind({
    new: () => userForm(null, departments),
    edit: (id) => userForm(byId(id), departments),
    leaves: async (id) => {
      try {
        const bal = await api("GET", `/leaves/balance?user_id=${id}`);
        dlg.className = "wide";
        dlg.innerHTML = dialogShell(`วันลาของ ${esc(bal.user.full_name)} ปีงบประมาณ ${bal.fiscal_year}`, balanceHtml(bal.balance), null, "ปิด");
        wireDialog(() => {});
      } catch (e) { toast(e.message, true); }
    },
  });
}

async function departmentsView() {
  const list = await api("GET", "/departments");
  view.innerHTML = `<section class="list"><div class="toolbar"><h2>หน่วยงาน</h2><button class="btn primary" data-act="new">+ เพิ่มหน่วยงาน</button></div>
    ${table(["ชื่อหน่วยงาน", "สถานะ", ""], list.map((d) => [esc(d.name), d.active ? badge("ใช้งาน", "ok") : badge("ปิด", "muted"),
      actions(btn("edit", "แก้ไข", d.id))]), "ยังไม่มีหน่วยงาน")}</section>`;
  const form = (d) => openForm({
    title: d ? "แก้ไขหน่วยงาน" : "เพิ่มหน่วยงาน",
    values: d || { active: true },
    fields: [{ name: "name", label: "ชื่อหน่วยงาน", required: true }, { name: "active", label: "เปิดใช้งาน", type: "checkbox" }],
    onSubmit: async (v) => { await api(d ? "PUT" : "POST", d ? `/departments/${d.id}` : "/departments", v); toast("บันทึกแล้ว"); refresh(); },
  });
  bind({ new: () => form(null), edit: (id) => form(list.find((d) => String(d.id) === id)) });
}

// ---------- หน้าแรกและข้อมูลของฉัน ----------

async function homeView() {
  const d = await api("GET", "/dashboard");
  const works = Object.fromEntries(d.my_works.map((w) => [w.status, w.n]));
  const stat = (tab, value, label, attn = false) =>
    `<button class="stat ${attn ? "attn" : ""}" data-act="go" data-id="${tab}"><b>${num(value)}</b><span>${label}</span></button>`;
  const stats = [stat("leaves", d.my_pending_leaves, "ใบลาของฉันที่รออนุมัติ")];
  if (d.leaves_to_approve != null) stats.push(stat("approve", d.leaves_to_approve, "ใบลารอฉันอนุมัติ", d.leaves_to_approve > 0));
  if (d.works_to_review != null) stats.push(stat("review", d.works_to_review, "ผลงานรอพิจารณา", d.works_to_review > 0));
  stats.push(stat("works", works.revise || 0, "ผลงานของฉันที่ต้องแก้ไข", (works.revise || 0) > 0));
  stats.push(stat("library", d.library_count, "ผลงานในคลัง"));
  if (d.staff_count != null) stats.push(stat("staff", d.staff_count, "บุคลากรที่ใช้งาน"));

  view.innerHTML = `
    <h2>สวัสดี ${esc(me.full_name)}</h2>
    <div class="stats">${stats.join("")}</div>
    <div class="grid2">
      <section class="card"><div class="toolbar"><h2>วันลาคงเหลือ ปีงบ ${d.fiscal_year}</h2>
        <button class="btn small primary" data-act="newleave">+ ยื่นใบลา</button></div>${balanceHtml(d.balance)}</section>
      ${d.license_alerts ? `<section class="card"><h2>ใบประกอบวิชาชีพใกล้หมดอายุ <small>(ภายใน 90 วัน)</small></h2>
        ${table(["ชื่อ", "หน่วยงาน", "วันหมดอายุ"], d.license_alerts.map((u) => [esc(u.full_name), esc(u.department_name || "-"), licenseCell(u)]),
          "ไม่มีใบประกอบวิชาชีพที่ใกล้หมดอายุ")}</section>` : ""}
      ${me.role !== "staff" ? `<section class="card"><h2>ลาวันนี้ <small>(${d.on_leave_today.length} คน)</small></h2>
        ${table(["ชื่อ", "ประเภท", "ช่วงวันลา"], d.on_leave_today.map((l) => [esc(l.full_name), esc(leaveType(l.leave_type)), leaveRange(l)]),
          "วันนี้ไม่มีคนลา")}</section>` : ""}
    </div>`;
  bind({ go: (tab) => show(tab), newleave: newLeave });
}

async function profileView() {
  me = await api("GET", "/me");
  view.innerHTML = `<section class="card">
    <div class="toolbar"><h2>ข้อมูลของฉัน</h2>
      <button class="btn small" data-act="phone">แก้ไขเบอร์โทร</button>
      <button class="btn small" data-act="pw">เปลี่ยนรหัสผ่าน</button></div>
    <div class="info-grid">
      ${cell("ชื่อ-นามสกุล", esc(me.full_name))}
      ${cell("ชื่อผู้ใช้", esc(me.username))}
      ${cell("สิทธิ์", esc(META.roles[me.role]))}
      ${cell("หน่วยงาน", esc(me.department_name || "-"))}
      ${cell("ตำแหน่ง", esc(me.position || "-"))}
      ${cell("วิชาชีพ", esc(me.profession || "-"))}
      ${cell("ประเภทการจ้าง", esc(me.employment_type || "-"))}
      ${cell("วันที่เริ่มงาน", when(me.start_date, false))}
      ${cell("เบอร์โทร", esc(me.phone || "-"))}
      ${cell("เลขที่ใบประกอบวิชาชีพ", esc(me.license_no || "-"))}
      ${cell("ใบประกอบวิชาชีพหมดอายุ", licenseCell(me))}
    </div>
    <p class="hint">ถ้าข้อมูลตำแหน่งหรือใบประกอบวิชาชีพไม่ถูกต้อง แจ้งผู้ดูแลระบบให้แก้ไข</p></section>`;
  bind({
    pw: changePassword,
    phone: () => openForm({
      title: "แก้ไขเบอร์โทร",
      values: me,
      fields: [{ name: "phone", label: "เบอร์โทร" }],
      onSubmit: async (d) => { me = await api("PUT", "/me", d); toast("บันทึกแล้ว"); refresh(); },
    }),
  });
}

// ---------- เข้าสู่ระบบ ----------

function authScreen(setupMode) {
  document.body.classList.add("auth");
  $("#tabs").innerHTML = "";
  $("#userbox").innerHTML = "";
  view.onclick = null;
  view.innerHTML = `<form class="card auth-card" id="auth-form">
      <h2>${setupMode ? "ตั้งค่าระบบครั้งแรก" : "เข้าสู่ระบบ"}</h2>
      ${setupMode ? `<p class="hint">สร้างบัญชีผู้ดูแลระบบคนแรก จากนั้นเพิ่มหน่วยงานและบุคลากรได้ในเมนู "หน่วยงาน" และ "บุคลากร"</p>` : ""}
      <div class="fields">
        ${setupMode ? fieldHtml({ name: "full_name", label: "ชื่อ-นามสกุล", required: true }) : ""}
        ${fieldHtml({ name: "username", label: "ชื่อผู้ใช้", required: true, autocomplete: "username" })}
        ${fieldHtml({ name: "password", label: "รหัสผ่าน", type: "password", required: true,
          autocomplete: setupMode ? "new-password" : "current-password", hint: setupMode ? "อย่างน้อย 6 ตัวอักษร" : "" })}
      </div>
      <p class="form-error" hidden></p>
      <button type="submit" class="btn primary block">${setupMode ? "สร้างบัญชีและเข้าสู่ระบบ" : "เข้าสู่ระบบ"}</button>
    </form>`;
  const form = $("#auth-form");
  $("input", form).focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const error = $(".form-error", form);
    error.hidden = true;
    try {
      me = await api("POST", setupMode ? "/setup" : "/login", Object.fromEntries(new FormData(form)));
      startApp();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  };
}

function changePassword() {
  openForm({
    title: "เปลี่ยนรหัสผ่าน",
    fields: [
      { name: "old_password", label: "รหัสผ่านเดิม", type: "password", required: true, autocomplete: "current-password" },
      { name: "new_password", label: "รหัสผ่านใหม่", type: "password", required: true, autocomplete: "new-password", hint: "อย่างน้อย 6 ตัวอักษร" },
    ],
    onSubmit: async (d) => { await api("POST", "/me/password", d); toast("เปลี่ยนรหัสผ่านแล้ว"); },
  });
}

// ---------- เมนูและการสลับหน้า ----------

// ค่าที่ 3 คือสิทธิ์ที่เห็นเมนู: manager = หัวหน้างานและผู้ดูแล, admin = ผู้ดูแลเท่านั้น
const VIEWS = {
  home: ["หน้าแรก", homeView],
  leaves: ["การลา", leavesView],
  approve: ["อนุมัติการลา", approveView, "manager"],
  library: ["คลังผลงาน", libraryView],
  works: ["ผลงานของฉัน", myWorksView],
  review: ["พิจารณาผลงาน", reviewView, "admin"],
  staff: ["บุคลากร", staffView, "manager"],
  departments: ["หน่วยงาน", departmentsView, "admin"],
  profile: ["ข้อมูลของฉัน", profileView],
};
function allowed(key) {
  const need = VIEWS[key][2];
  if (!need) return true;
  if (need === "manager") return me?.role === "admin" || me?.role === "head";
  return me?.role === need;
}
let current = null;

async function show(tab) {
  if (!me) return;
  if (!VIEWS[tab] || !allowed(tab)) tab = "home";
  current = tab;
  if (dlg.open) dlg.close();
  view.onkeydown = view.onchange = null;
  if (location.hash !== "#" + tab) history.replaceState(null, "", "#" + tab);
  $("#tabs").innerHTML = Object.entries(VIEWS).filter(([k]) => allowed(k))
    .map(([key, [text]]) => `<button data-tab="${key}" ${key === tab ? 'aria-current="page"' : ""}>${text}</button>`).join("");
  try {
    await VIEWS[tab][1]();
  } catch (e) {
    if (me) view.innerHTML = `<p class="form-error">โหลดข้อมูลไม่สำเร็จ: ${esc(e.message)}</p>`;
  }
}

// โหลดหน้าปัจจุบันใหม่โดยไม่ปิดกล่องข้อความที่เปิดอยู่
function refresh() {
  if (current && me) VIEWS[current][1]().catch((e) => toast(e.message, true));
}

async function startApp() {
  document.body.classList.remove("auth");
  try { META = await api("GET", "/meta"); } catch (e) { return toast(e.message, true); }
  $("#userbox").innerHTML = `<span><b>${esc(me.full_name)}</b><small>${esc(META.roles[me.role])}${me.department_name ? " · " + esc(me.department_name) : ""}</small></span>
    <button class="btn small" id="logout">ออกจากระบบ</button>`;
  $("#logout").onclick = async () => {
    try { await api("POST", "/logout", {}); } catch {}
    me = null;
    authScreen(false);
  };
  show(location.hash.slice(1));
}

unauthorized = () => {
  if (!me) return;
  me = null;
  if (dlg.open) dlg.close();
  toast("หมดเวลาการใช้งาน กรุณาเข้าสู่ระบบใหม่", true);
  authScreen(false);
};

$("#tabs").onclick = (e) => { const b = e.target.closest("[data-tab]"); if (b) show(b.dataset.tab); };
window.addEventListener("hashchange", () => { if (location.hash.slice(1) !== current) show(location.hash.slice(1)); });

(async function boot() {
  try {
    const { needs_setup } = await api("GET", "/setup");
    if (needs_setup) return authScreen(true);
    me = await api("GET", "/me");
    startApp();
  } catch {
    authScreen(false);
  }
})();
