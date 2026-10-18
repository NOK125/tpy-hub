"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const view = $("#view");
const dlg = $("#dlg");

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (v) => (v == null || v === "" ? "-" : Number(v).toLocaleString("th-TH", { maximumFractionDigits: 2 }));
const money = (v) => Number(v || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const fileSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const TH_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// วันที่แบบไทย: 26/09/2569 21:19
function when(ts, withTime = true) {
  if (!ts) return "-";
  const [d, t = ""] = ts.split("T");
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${Number(y) + 543}${withTime && t ? " " + t.slice(0, 5) : ""}`;
}
const fmtNid = (n) => (n && n.length === 13 ? `${n[0]}-${n.slice(1, 5)}-${n.slice(5, 10)}-${n.slice(10, 12)}-${n[12]}` : n || "");

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
const bar = (value, max, cls = "") => `<div class="bar ${cls}"><i style="width:${Math.min(100, pct(value, max))}%"></i></div>`;
const isAdmin = () => me?.role === "admin";

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
    f.inputmode ? `inputmode="${f.inputmode}"` : "",
    f.pattern ? `pattern="${f.pattern}"` : "",
    f.maxlength ? `maxlength="${f.maxlength}"` : "",
  ].join(" ");
  if (f.type === "checkbox") {
    return `<label class="field checkbox"><input type="checkbox" ${attrs} ${v === true || v === 1 || v === "1" ? "checked" : ""}><span>${esc(f.label)}</span></label>`;
  }
  let input;
  if (f.type === "select") input = `<select ${attrs}>${f.options.map(([val, text]) => option(val, text, v)).join("")}</select>`;
  else if (f.type === "textarea") input = `<textarea ${attrs}>${esc(v)}</textarea>`;
  else if (f.type === "file") input = `<input type="file" ${attrs}>`;
  else input = `<input type="${f.type || "text"}" value="${esc(v)}" ${attrs}>`;
  return `<label class="field ${f.wide ? "wide" : ""}"><span>${esc(f.label)}${f.required ? " *" : ""}</span>${input}${
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
      $$("input[type=file]", form).forEach((f) => delete data[f.name]);
      const keepOpen = await onSubmit(data, form);
      if (keepOpen !== true) dlg.close();
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
  $("input:not([type=hidden]):not([type=file]), select, textarea", form)?.focus();
  return form;
}

function showMessage(title, html) {
  dlg.className = "wide";
  dlg.innerHTML = dialogShell(esc(title), html, null, "ปิด");
  wireDialog(() => {});
}

const cell = (label, value) => `<div><small>${label}</small><div>${value}</div></div>`;

// อ่านไฟล์จาก <input type=file> เป็น base64 ส่งไปกับ JSON
function readFile(input, exts, label) {
  const file = input?.files?.[0];
  if (!file) return Promise.resolve(null);
  if (!exts.some((x) => file.name.toLowerCase().endsWith(x))) return Promise.reject(new Error(`${label}ต้องเป็นไฟล์ ${exts.join(", ")}`));
  if (file.size > 15 * 1024 * 1024) return Promise.reject(new Error(`${label}ต้องไม่เกิน 15 MB`));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ file_name: file.name, file_data: reader.result.split(",")[1] });
    reader.onerror = () => reject(new Error("อ่านไฟล์ไม่สำเร็จ"));
    reader.readAsDataURL(file);
  });
}

function importResult(r) {
  const list = (items, cls) => (items.length ? `<ul class="msg-list ${cls}">${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
  showMessage("ผลการนำเข้า", `
    <div class="stats">
      <div class="stat"><b>${num(r.created)}</b><span>เพิ่มใหม่</span></div>
      <div class="stat"><b>${num(r.updated)}</b><span>ปรับปรุงข้อมูลเดิม</span></div>
      <div class="stat ${r.errors.length ? "attn" : ""}"><b>${num(r.errors.length)}</b><span>แถวที่ข้าม</span></div>
    </div>
    ${r.errors.length ? `<h3>แถวที่นำเข้าไม่ได้</h3>${list(r.errors, "bad")}` : ""}
    ${r.warnings.length ? `<h3>ควรตรวจสอบ</h3>${list(r.warnings, "warn")}` : ""}`);
}

function importForm({ title, path, intro, template, extraFields = [], values = {} }) {
  openForm({
    title,
    values,
    intro: `<p class="hint">${intro}</p>`,
    fields: [...extraFields, { name: "file", label: "ไฟล์ Excel (.xlsx)", type: "file", required: true, accept: ".xlsx" }],
    extra: `<p><a class="btn small" href="/api/templates/${template}">ดาวน์โหลดแบบฟอร์ม</a></p>`,
    submitLabel: "นำเข้า",
    onSubmit: async (d, f) => {
      const file = await readFile($("[name=file]", f), [".xlsx"], "ไฟล์");
      if (!file) throw new Error("กรุณาเลือกไฟล์");
      const result = await api("POST", path, { ...d, ...file });
      refresh();
      importResult(result);
      return true;
    },
  });
}

const yearSelect = (years, selected) =>
  `<select id="year" aria-label="ปีงบประมาณ">${years.map((y) => option(y, `ปีงบประมาณ ${y}`, selected)).join("")}</select>`;
let currentYear = null;

// ---------- Dashboard ----------

async function dashboardView() {
  const d = await api("GET", `/dashboard${currentYear ? "?year=" + currentYear : ""}`);
  currentYear = d.fiscal_year;
  const docsTotal = Object.values(d.documents).reduce((a, b) => a + b, 0);
  const stat = (value, label, tab, attn = false) =>
    `<button class="stat ${attn ? "attn" : ""}" ${tab ? `data-act="go" data-id="${tab}"` : ""}><b>${value}</b><span>${label}</span></button>`;
  const maxLevel = Math.max(1, ...d.by_level.map((r) => r.n));
  view.innerHTML = `
    <div class="print-only print-head"><h1>Dashboard งานบริหารทรัพยากรบุคคล โรงพยาบาลตาพระยา</h1>
      <p>ปีงบประมาณ ${d.fiscal_year} · ข้อมูล ณ วันที่ ${when(d.generated_at)}</p></div>
    <div class="toolbar no-print"><h2>Dashboard</h2>
      ${yearSelect(d.years, d.fiscal_year)}
      <a class="btn" href="/api/export/dashboard.xlsx?year=${d.fiscal_year}">ดาวน์โหลด Excel</a>
      <button class="btn" data-act="pdf">ดาวน์โหลด PDF</button>
    </div>
    <div class="stats">
      ${stat(num(d.staff_total), `บุคลากร (คน)${isAdmin() && d.staff_not_activated ? ` · ยังไม่เปลี่ยนรหัส ${num(d.staff_not_activated)}` : ""}`, "staff")}
      ${stat(money(d.total_budget), "งบแผนพัฒนาบุคลากร (บาท)", "plans")}
      ${stat(`${money(d.total_spent)} <small>(${pct(d.total_spent, d.total_budget)}%)</small>`, "ใช้ไปแล้ว (บาท)", "plans")}
      ${stat(money(d.total_remaining), "คงเหลือ (บาท)", "plans", d.total_budget > 0 && d.total_remaining < 0)}
      ${stat(num(d.clinic.open), isAdmin() ? "HR Clinic รอตอบ" : "คำถามของฉันที่รอตอบ", "clinic", isAdmin() && d.clinic.open > 0)}
      ${stat(num(docsTotal), "เอกสารทั้งหมด", "")}
    </div>
    <div class="grid2">
      <section class="card"><h2>งบแผนพัฒนาบุคลากรตามหน่วยงาน</h2>
        ${d.plans.length ? `<div class="meter-list">${d.plans.map((p) => `<div class="meter">
            <div class="meter-label"><span>${esc(p.department)}</span><small>${money(p.spent)} / ${money(p.budget)} (${pct(p.spent, p.budget)}%)</small></div>
            ${bar(p.spent, p.budget, p.spent > p.budget ? "over" : "")}</div>`).join("")}</div>`
          : `<p class="empty">ยังไม่มีแผนในปีงบประมาณนี้</p>`}
      </section>
      <section class="card"><h2>บุคลากรตามระดับ</h2>
        ${d.by_level.length ? `<div class="meter-list">${d.by_level.map((r) => `<div class="meter">
            <div class="meter-label"><span>${esc(r.label)}</span><small>${num(r.n)} คน</small></div>${bar(r.n, maxLevel, "alt")}</div>`).join("")}</div>`
          : `<p class="empty">ยังไม่มีข้อมูลบุคลากร</p>`}
      </section>
      <section class="card"><h2>การตัดงบล่าสุด</h2>
        ${table(["วันที่", "หน่วยงาน", "รายการ", ["จำนวนเงิน", "num"]], d.recent_expenses.map((e) =>
          [when(e.date, false), esc(e.department), esc(e.description), [money(e.amount), "num"]]), "ยังไม่มีการตัดงบ")}
      </section>
      <section class="card"><h2>เอกสาร</h2>
        <div class="doc-counts">${Object.entries(d.documents).map(([k, n]) =>
          `<button class="stat" data-act="go" data-id="doc-${k}"><b>${num(n)}</b><span>${esc(META.doc_categories[k])}</span></button>`).join("")}</div>
        <h3>เพิ่มล่าสุด</h3>
        ${table(["วันที่", "หมวด", "ชื่อเรื่อง"], d.latest_documents.map((x) =>
          [when(x.doc_date || x.created_at, false), esc(META.doc_categories[x.category]),
           `<a href="/api/documents/${x.id}/file" target="_blank" rel="noopener">${esc(x.title)}</a>`]), "ยังไม่มีเอกสาร")}
      </section>
    </div>`;
  $("#year").onchange = (e) => { currentYear = e.target.value; refresh(); };
  bind({ go: (tab) => tab && show(tab), pdf: () => window.print() });
}

// ---------- แผนพัฒนาบุคลากร ----------

function planForm(plan, year) {
  openForm({
    title: plan ? `แก้ไขแผน ลำดับ ${plan.seq}` : "เพิ่มแผนพัฒนาบุคลากร",
    two: true,
    values: plan || { fiscal_year: year, spent_initial: 0 },
    fields: [
      { name: "fiscal_year", label: "ปีงบประมาณ", type: "number", required: true, min: 2500, max: 2700, step: 1 },
      { name: "seq", label: "ลำดับ", type: "number", required: true, min: 1, step: 1 },
      { name: "department", label: "หน่วยงาน", required: true, wide: true },
      { name: "budget", label: "งบประมาณ (บาท)", type: "number", required: true, min: 0 },
      { name: "spent_initial", label: "งบที่ใช้ไปก่อนเริ่มใช้ระบบ (บาท)", type: "number", min: 0, hint: "การตัดงบในระบบบันทึกแยกด้วยปุ่ม \"ตัดงบ\"" },
    ],
    onSubmit: async (d) => {
      await api(plan ? "PUT" : "POST", plan ? `/plans/${plan.id}` : "/plans", d);
      toast("บันทึกแล้ว");
      refresh();
    },
  });
}

function expenseForm(plan) {
  openForm({
    title: `ตัดงบ: ${plan.department}`,
    intro: `<p class="hint">คงเหลือ <b>${money(plan.remaining)}</b> บาท จากงบประมาณ ${money(plan.budget)} บาท</p>`,
    values: { spent_on: todayIso() },
    fields: [
      { name: "spent_on", label: "วันที่", type: "date", required: true },
      { name: "amount", label: "จำนวนเงิน (บาท)", type: "number", required: true, min: 0.01, max: plan.remaining },
      { name: "description", label: "รายการ", type: "textarea", required: true, placeholder: "เช่น ค่าลงทะเบียนอบรมหลักสูตร ... (ชื่อผู้เข้าอบรม)" },
    ],
    submitLabel: "บันทึกการตัดงบ",
    onSubmit: async (d) => {
      await api("POST", `/plans/${plan.id}/expenses`, d);
      toast("ตัดงบแล้ว");
      refresh();
    },
  });
}

function timelineHtml(events, admin) {
  if (!events.length) return `<p class="empty">ยังไม่มีการตัดงบในปีงบประมาณนี้</p>`;
  const groups = [];
  for (const e of events) {
    const key = e.date.slice(0, 7);
    if (!groups.length || groups[groups.length - 1].key !== key) groups.push({ key, items: [] });
    groups[groups.length - 1].items.push(e);
  }
  return `<div class="timeline">${groups.map((g) => {
    const [y, m] = g.key.split("-");
    const total = g.items.reduce((a, e) => a + e.amount, 0);
    return `<div class="tl-month"><h3>${TH_MONTHS[Number(m) - 1]} ${Number(y) + 543} <small>รวม ${money(total)} บาท</small></h3>
      <ol>${g.items.map((e) => `<li class="${e.kind}">
        <div class="tl-date">${when(e.date, false)}</div>
        <div class="tl-body"><b>${esc(e.department)}</b> <small>(ลำดับ ${esc(e.seq)})</small><br>${esc(e.description)}
          <small class="tl-meta">ยอดใช้สะสม ${money(e.cumulative)} บาท${e.by ? ` · บันทึกโดย ${esc(e.by)}` : ""}</small></div>
        <div class="tl-amount">${money(e.amount)}${admin && e.kind === "expense" ? `<br>${btn("delexp", "ลบ", e.id, "danger")}` : ""}</div>
      </li>`).join("")}</ol></div>`;
  }).join("")}</div>`;
}

async function plansView() {
  const year = currentYear || META.fiscal_year;
  const [data, tl] = await Promise.all([api("GET", `/plans?year=${year}`), api("GET", `/plans/timeline?year=${year}`)]);
  currentYear = data.fiscal_year;
  const admin = isAdmin();
  view.innerHTML = `
    <div class="toolbar"><h2>แผนพัฒนาบุคลากร</h2>
      ${yearSelect(data.years, data.fiscal_year)}
      ${admin ? `<button class="btn" data-act="import">นำเข้า Excel</button><button class="btn primary" data-act="new">+ เพิ่มแผน</button>` : ""}
    </div>
    <div class="stats">
      <div class="stat"><b>${money(data.total_budget)}</b><span>งบประมาณรวม (บาท)</span></div>
      <div class="stat"><b>${money(data.total_spent)}</b><span>ใช้ไปแล้ว ${pct(data.total_spent, data.total_budget)}%</span></div>
      <div class="stat"><b>${money(data.total_remaining)}</b><span>คงเหลือ (บาท)</span></div>
    </div>
    <section class="list">
      ${table(["ลำดับ", "หน่วยงาน", ["งบประมาณ", "num"], ["ใช้ไป", "num"], ["คงเหลือ", "num"], "การใช้งบ", ""], data.plans.map((p) => [
        esc(p.seq), esc(p.department), [money(p.budget), "num"], [money(p.spent), "num"],
        [`<span class="${p.remaining < 0 ? "minus" : ""}">${money(p.remaining)}</span>`, "num"],
        `<div class="mini-meter">${bar(p.spent, p.budget, p.spent > p.budget ? "over" : "")}<small>${pct(p.spent, p.budget)}%</small></div>`,
        actions(admin ? btn("expense", "ตัดงบ", p.id, "primary") : "", btn("history", "ประวัติ", p.id),
          admin ? btn("edit", "แก้ไข", p.id) : "", admin && !p.expense_count ? btn("delete", "ลบ", p.id, "danger") : ""),
      ]), admin ? "ยังไม่มีแผนในปีงบประมาณนี้ กด \"นำเข้า Excel\" เพื่อเริ่มต้น" : "ยังไม่มีแผนในปีงบประมาณนี้")}
    </section>
    <section class="card"><h2>Timeline การดำเนินการตามแผน</h2>${timelineHtml(tl.events, admin)}</section>`;
  $("#year").onchange = (e) => { currentYear = e.target.value; refresh(); };
  const byId = (id) => data.plans.find((p) => String(p.id) === id);
  bind({
    import: () => importForm({
      title: "นำเข้าแผนพัฒนาบุคลากรจาก Excel",
      path: "/plans/import",
      template: "plans.xlsx",
      intro: "ไฟล์ต้องมีหัวตาราง: ลำดับ, หน่วยงาน, งบประมาณ, งบประมาณที่ใช้ไป · ถ้าลำดับซ้ำกับแผนเดิมในปีงบเดียวกัน ระบบจะอัปเดตข้อมูลแทน โดยไม่ลบประวัติการตัดงบ",
      values: { fiscal_year: data.fiscal_year },
      extraFields: [{ name: "fiscal_year", label: "ปีงบประมาณ", type: "number", required: true, min: 2500, max: 2700, step: 1 }],
    }),
    new: () => planForm(null, data.fiscal_year),
    edit: (id) => planForm(byId(id)),
    expense: (id) => expenseForm(byId(id)),
    history: async (id) => {
      const p = byId(id);
      const r = await api("GET", `/plans/timeline?year=${data.fiscal_year}&plan_id=${id}`).catch((e) => toast(e.message, true));
      if (r) showMessage(`ประวัติการใช้งบ: ${p.department}`,
        `<p class="hint">งบประมาณ ${money(p.budget)} · ใช้ไป ${money(p.spent)} · คงเหลือ ${money(p.remaining)} บาท</p>${timelineHtml(r.events, false)}`);
    },
    delete: async (id) => {
      if (!confirm(`ลบแผน "${byId(id).department}"?`)) return;
      try { await api("POST", `/plans/${id}/delete`, {}); toast("ลบแล้ว"); refresh(); } catch (e) { toast(e.message, true); }
    },
    delexp: async (id) => {
      if (!confirm("ลบรายการตัดงบนี้? ยอดเงินจะคืนกลับเข้างบคงเหลือ")) return;
      try { await api("POST", `/expenses/${id}/delete`, {}); toast("ลบรายการแล้ว"); refresh(); } catch (e) { toast(e.message, true); }
    },
  });
}

// ---------- เอกสาร (คำสั่ง ตรวจสุขภาพ รายงานการประชุม เอกสารอื่น ๆ) ----------

function documentForm(category, doc) {
  const isOrder = category === "order";
  openForm({
    title: doc ? "แก้ไขเอกสาร" : `อัปโหลด${META.doc_categories[category]}`,
    two: true,
    wide: true,
    values: doc || { doc_date: todayIso() },
    fields: [
      { name: "title", label: isOrder ? "เรื่อง" : "ชื่อเอกสาร", required: true, wide: true },
      { name: "doc_no", label: isOrder ? "เลขที่คำสั่ง" : "เลขที่ (ถ้ามี)", placeholder: isOrder ? "เช่น 123/2569" : "" },
      { name: "doc_date", label: "วันที่เอกสาร", type: "date" },
      { name: "note", label: "รายละเอียดเพิ่มเติม", type: "textarea", wide: true },
      { name: "file", label: doc ? `ไฟล์ PDF (มีแล้ว: ${doc.file_name})` : "ไฟล์ PDF", type: "file", required: !doc,
        accept: "application/pdf,.pdf", hint: doc ? "เลือกไฟล์ใหม่ถ้าต้องการแทนที่" : "ไม่เกิน 15 MB", wide: true },
    ],
    submitLabel: doc ? "บันทึก" : "อัปโหลด",
    onSubmit: async (d, f) => {
      const file = await readFile($("[name=file]", f), [".pdf"], "ไฟล์");
      if (!doc && !file) throw new Error("กรุณาเลือกไฟล์ PDF");
      await api(doc ? "PUT" : "POST", doc ? `/documents/${doc.id}` : "/documents", { ...d, category, ...(file || {}) });
      toast(doc ? "บันทึกแล้ว" : "อัปโหลดแล้ว");
      refresh();
    },
  });
}

function documentsView(category) {
  return async () => {
    const list = await api("GET", `/documents?category=${category}`);
    const admin = isAdmin();
    const years = [...new Set(list.map((d) => Number((d.doc_date || d.created_at).slice(0, 4)) + 543))].sort((a, b) => b - a);
    view.innerHTML = `<div class="toolbar"><h2>${esc(META.doc_categories[category])} <small>(${list.length})</small></h2>
        <input type="search" id="q" placeholder="ค้นหาชื่อเรื่องหรือเลขที่">
        ${years.length > 1 ? `<select id="y">${option("", "ทุกปี")}${years.map((y) => option(y, `ปี ${y}`)).join("")}</select>` : ""}
        ${admin ? `<button class="btn primary" data-act="new">+ อัปโหลด PDF</button>` : ""}
      </div><section class="list" id="list"></section>`;
    const draw = () => {
      const q = $("#q").value.trim().toLowerCase();
      const y = $("#y")?.value || "";
      const shown = list.filter((d) => (!q || `${d.title} ${d.doc_no || ""} ${d.note || ""}`.toLowerCase().includes(q))
        && (!y || String(Number((d.doc_date || d.created_at).slice(0, 4)) + 543) === y));
      $("#list").innerHTML = table(["วันที่", category === "order" ? "เลขที่คำสั่ง" : "เลขที่", "ชื่อเรื่อง", "ไฟล์", ""], shown.map((d) => [
        when(d.doc_date || d.created_at, false), esc(d.doc_no || "-"),
        `${esc(d.title)}${d.note ? `<br><small>${esc(d.note)}</small>` : ""}`,
        `<small>${fileSize(d.file_size)}</small>`,
        actions(`<a class="btn small primary" href="/api/documents/${d.id}/file" target="_blank" rel="noopener">เปิด</a>`,
          `<a class="btn small" href="/api/documents/${d.id}/file?download=1">ดาวน์โหลด</a>`,
          admin ? btn("edit", "แก้ไข", d.id) : "", admin ? btn("delete", "ลบ", d.id, "danger") : ""),
      ]), list.length ? "ไม่พบเอกสารที่ค้นหา" : "ยังไม่มีเอกสาร");
    };
    $("#q").oninput = draw;
    if ($("#y")) $("#y").onchange = draw;
    draw();
    const byId = (id) => list.find((d) => String(d.id) === id);
    bind({
      new: () => documentForm(category, null),
      edit: (id) => documentForm(category, byId(id)),
      delete: async (id) => {
        if (!confirm(`ลบเอกสาร "${byId(id).title}"? ไฟล์จะถูกลบถาวร`)) return;
        try { await api("POST", `/documents/${id}/delete`, {}); toast("ลบแล้ว"); refresh(); } catch (e) { toast(e.message, true); }
      },
    });
  };
}

// ---------- HR Clinic ----------

const CLINIC_BADGE = { open: "warn", answered: "ok", closed: "muted" };
const clinicBadge = (s) => badge(META.clinic_status[s], CLINIC_BADGE[s]);

async function openQuestion(id) {
  let q;
  try { q = await api("GET", `/clinic/${id}`); } catch (e) { return toast(e.message, true); }
  const admin = isAdmin();
  const canReply = q.status !== "closed" || admin;
  dlg.className = "wide";
  dlg.innerHTML = dialogShell(`${esc(q.subject)} ${clinicBadge(q.status)}`, `
    <p><small>ถามโดย ${esc(q.asker)}${q.position ? ` (${esc(q.position)})` : ""} · ${when(q.created_at)}</small></p>
    <div class="chat">${q.messages.map((m) => `<div class="msg ${m.from_admin ? "hr" : "me"}">
        <small>${esc(m.author)} · ${when(m.created_at)}</small><div>${esc(m.body)}</div></div>`).join("")}</div>
    ${canReply ? `<div class="fields step">${fieldHtml({ name: "body", label: admin ? "ตอบกลับ" : "ส่งข้อความเพิ่มเติม", type: "textarea", required: true })}</div>`
      : `<p class="hint">เรื่องนี้ปิดแล้ว ถ้ามีคำถามใหม่ กรุณาส่งคำถามใหม่</p>`}
    ${q.status !== "closed" ? `<div class="doc-actions">${btn("close", "ปิดเรื่อง")}</div>` : ""}`,
    canReply ? "ส่ง" : null, "ปิดหน้าต่าง");
  const form = wireDialog(async (d) => {
    await api("POST", `/clinic/${id}/reply`, d);
    toast("ส่งข้อความแล้ว");
    refresh();
    openQuestion(id);
    return true;
  });
  const chat = $(".chat", form);
  chat.scrollTop = chat.scrollHeight;
  form.onclick = async (e) => {
    if (!e.target.closest("[data-act=close]")) return;
    if (!confirm("ปิดเรื่องนี้?")) return;
    try { await api("POST", `/clinic/${id}/close`, {}); toast("ปิดเรื่องแล้ว"); dlg.close(); refresh(); } catch (err) { toast(err.message, true); }
  };
}

async function clinicView() {
  const admin = isAdmin();
  let status;
  try { status = sessionStorage.getItem("clinic-status"); } catch {}
  status = status ?? (admin ? "open" : "");
  const list = await api("GET", `/clinic${status ? "?status=" + status : ""}`);
  view.innerHTML = `<div class="toolbar"><h2>HR Clinic</h2>
      <select id="status">${option("", "ทุกสถานะ", status)}${Object.entries(META.clinic_status).map(([k, v]) => option(k, v, status)).join("")}</select>
      ${admin ? "" : `<button class="btn primary" data-act="new">+ ส่งคำถามถึง HR</button>`}
    </div>
    ${admin ? "" : `<p class="hint">สอบถามเรื่องสิทธิ สวัสดิการ การลา เงินเดือน หรือเรื่องงานบริหารทรัพยากรบุคคลอื่น ๆ เจ้าหน้าที่ HR จะตอบกลับในหน้านี้ คำถามของคุณเห็นเฉพาะคุณและเจ้าหน้าที่ HR</p>`}
    <section class="list">${table(["หัวข้อ", ...(admin ? ["ผู้ถาม"] : []), "ส่งเมื่อ", "อัปเดตล่าสุด", "สถานะ", ""], list.map((q) => [
      esc(q.subject), ...(admin ? [esc(q.asker)] : []), when(q.created_at), when(q.updated_at), clinicBadge(q.status),
      actions(btn("open", admin && q.status === "open" ? "ตอบ" : "ดู", q.id, admin && q.status === "open" ? "primary" : "")),
    ]), admin ? "ไม่มีคำถามในสถานะนี้" : "ยังไม่ได้ส่งคำถาม")}</section>`;
  $("#status").onchange = (e) => { try { sessionStorage.setItem("clinic-status", e.target.value); } catch {} refresh(); };
  bind({
    open: openQuestion,
    new: () => openForm({
      title: "ส่งคำถามถึง HR",
      fields: [
        { name: "subject", label: "หัวข้อ", required: true, placeholder: "เช่น สอบถามสิทธิการลาศึกษาต่อ" },
        { name: "body", label: "รายละเอียดคำถาม", type: "textarea", required: true },
      ],
      submitLabel: "ส่งคำถาม",
      onSubmit: async (d) => { await api("POST", "/clinic", d); toast("ส่งคำถามแล้ว"); refresh(); },
    }),
  });
}

// ---------- ข้อมูลบุคลากร (ทุกคนดูได้) ----------

const USERS_IMPORT_INTRO = "ไฟล์ต้องมีหัวตาราง: ลำดับ, คำนำหน้า, ชื่อ, นามสกุล, หมายเลขบัตร, ตำแหน่ง, ระดับ และใส่ กลุ่มงาน, กลุ่มวิชาชีพ เพิ่มได้ (ถ้าไม่มีกลุ่มวิชาชีพ ระบบเดาจากตำแหน่ง) · คนใหม่ได้รหัสผ่านครั้งแรกเป็นเลขบัตร 5 ตัวท้าย · ถ้าเลขบัตรมีในระบบแล้ว ระบบจะอัปเดตข้อมูลโดยไม่เปลี่ยนรหัสผ่าน";
const MOVE_BADGE = { hire: "ok", transfer_in: "info", resign: "bad", transfer_out: "warn" };
const STAFF_TABS = [["list", "รายชื่อ"], ["retention", "อัตราการคงอยู่"], ["moves", "ประวัติเข้า-ออก", "admin"]];
let staffTab = "list";
let staffGroupBy = "profession_group";
try { staffTab = sessionStorage.getItem("staff-tab") || "list"; } catch {}

function countBy(list, key) {
  const m = new Map();
  for (const s of list) { const k = s[key] || "ไม่ระบุ"; m.set(k, (m.get(k) || 0) + 1); }
  return [...m].sort((a, b) => b[1] - a[1]);
}

async function staffView() {
  const admin = isAdmin();
  const tabs = STAFF_TABS.filter((t) => !t[2] || admin);
  if (!tabs.some((t) => t[0] === staffTab)) staffTab = "list";
  view.innerHTML = `
    <div class="toolbar"><h2>ข้อมูลบุคลากร</h2>
      ${admin ? `<button class="btn" data-act="import-staff">นำเข้ารายชื่อ Excel</button>
        <a class="btn" href="/api/export/staff.xlsx${currentYear ? "?year=" + currentYear : ""}">ดาวน์โหลด Excel</a>` : ""}
    </div>
    <div class="subtabs" role="tablist">${tabs.map(([k, label]) =>
      `<button type="button" role="tab" data-act="subtab" data-id="${k}" aria-selected="${k === staffTab}">${label}</button>`).join("")}</div>
    <div id="staff-body"></div>`;
  bind({
    subtab: (k) => { staffTab = k; try { sessionStorage.setItem("staff-tab", k); } catch {} refresh(); },
    "import-staff": () => importForm({ title: "นำเข้ารายชื่อบุคลากรจาก Excel", path: "/users/import", template: "users.xlsx", intro: USERS_IMPORT_INTRO }),
    ...(await ({ list: staffListTab, retention: retentionTab, moves: movesTab }[staffTab])($("#staff-body"))),
  });
}

async function staffListTab(body) {
  const staff = await api("GET", "/staff");
  const levels = countBy(staff, "level");
  const positions = countBy(staff, "position");
  const depts = countBy(staff, "department");
  const profs = countBy(staff, "profession_group");
  const filter = { q: "", level: "", position: "", department: "", profession_group: "" };
  const select = (id, all, items) => `<select id="${id}">${option("", all)}${items.map(([k, n]) => option(k, `${k} (${n})`)).join("")}</select>`;
  body.innerHTML = `
    <div class="stats">
      <div class="stat"><b>${num(staff.length)}</b><span>บุคลากรทั้งหมด (คน)</span></div>
      <div class="stat"><b>${num(profs.length)}</b><span>กลุ่มวิชาชีพ</span></div>
      <div class="stat"><b>${num(depts.filter(([k]) => k !== "ไม่ระบุ").length)}</b><span>กลุ่มงาน</span></div>
      <div class="stat"><b>${num(positions.length)}</b><span>ตำแหน่ง</span></div>
    </div>
    <section class="card"><h2>จำนวนตามกลุ่มวิชาชีพ <small>กดเพื่อกรอง</small></h2>
      <div class="chips" id="prof-chips">${profs.map(([k, n]) =>
        `<button type="button" class="chip" data-act="prof" data-id="${esc(k)}">${esc(k)} <b>${num(n)}</b></button>`).join("")}</div>
    </section>
    <div class="toolbar">
      <input type="search" id="q" placeholder="ค้นหาชื่อ ตำแหน่ง ระดับ">
      ${select("f-dept", "ทุกกลุ่มงาน", depts)}${select("f-pos", "ทุกตำแหน่ง", positions)}${select("f-lv", "ทุกระดับ", levels)}
    </div>
    <section class="list" id="list"></section>`;
  const draw = () => {
    const q = filter.q.toLowerCase();
    const is = (s, key) => !filter[key] || (s[key] || "ไม่ระบุ") === filter[key];
    const shown = staff.filter((s) => (!q || `${s.full_name} ${s.position || ""} ${s.level || ""}`.toLowerCase().includes(q))
      && is(s, "level") && is(s, "position") && is(s, "department") && is(s, "profession_group"));
    $$("#prof-chips .chip").forEach((c) => c.classList.toggle("on", c.dataset.id === filter.profession_group));
    $("#list").innerHTML = `<p class="muted">แสดง ${num(shown.length)} จาก ${num(staff.length)} คน</p>` +
      table(["ลำดับ", "ชื่อ-นามสกุล", "ตำแหน่ง", "ระดับ", "กลุ่มงาน", "กลุ่มวิชาชีพ"], shown.map((s) =>
        [esc(s.seq ?? "-"), esc(s.full_name), esc(s.position || "-"), esc(s.level || "-"), esc(s.department || "-"), esc(s.profession_group || "-")]),
      staff.length ? "ไม่พบบุคลากรที่ค้นหา" : "ยังไม่มีข้อมูลบุคลากร");
  };
  $("#q").oninput = (e) => { filter.q = e.target.value.trim(); draw(); };
  $("#f-dept").onchange = (e) => { filter.department = e.target.value; draw(); };
  $("#f-pos").onchange = (e) => { filter.position = e.target.value; draw(); };
  $("#f-lv").onchange = (e) => { filter.level = e.target.value; draw(); };
  draw();
  return { prof: (k) => { filter.profession_group = filter.profession_group === k ? "" : k; draw(); } };
}

const rateText = (r) => (r == null ? "-" : `${num(r)}%`);
const rateClass = (r) => (r == null ? "" : r >= 90 ? "plus" : r < 80 ? "minus" : "");

async function retentionTab(body) {
  const t = await api("GET", `/staff/retention?by=${staffGroupBy}${currentYear ? "&year=" + currentYear : ""}`);
  currentYear = t.fiscal_year;
  const label = META.group_by[t.by];
  const row = (r, isTotal = false) => [
    isTotal ? `<b>${esc(r.group)}</b>` : `${esc(r.group)}${r.inconsistent ? ` ${badge("ตรวจข้อมูล", "warn")}` : ""}`,
    [num(r.start), "num"], [num(r.hire), "num"], [num(r.transfer_in), "num"], [num(r.resign), "num"],
    [num(r.transfer_out), "num"], [num(r.end), "num"],
    [`<div class="mini-meter">${bar(r.rate ?? 0, 100, r.rate != null && r.rate < 80 ? "over" : "")}<b class="${rateClass(r.rate)}">${rateText(r.rate)}</b></div>`, "num"],
  ];
  const maxTrend = 100;
  body.innerHTML = `
    <div class="toolbar">
      ${yearSelect(t.years, t.fiscal_year)}
      <div class="chips">${Object.entries(META.group_by).map(([k, v]) =>
        `<button type="button" class="chip ${k === t.by ? "on" : ""}" data-act="groupby" data-id="${k}">แยกตาม${v}</button>`).join("")}</div>
    </div>
    <div class="stats">
      <div class="stat"><b class="${rateClass(t.total.rate)}">${rateText(t.total.rate)}</b><span>อัตราการคงอยู่ทั้งโรงพยาบาล ปีงบ ${t.fiscal_year}</span></div>
      <div class="stat"><b>${num(t.total.start)}</b><span>บุคลากรต้นปีงบ (1 ต.ค.)</span></div>
      <div class="stat"><b>${num(t.total.left)}</b><span>ลาออก + ย้ายออก</span></div>
      <div class="stat"><b>${num(t.total.hire + t.total.transfer_in)}</b><span>รับใหม่ + รับย้ายเข้า</span></div>
    </div>
    <p class="hint"><b>สูตร:</b> อัตราการคงอยู่ = (บุคลากรต้นปีงบ − ลาออก − ย้ายออก) ÷ บุคลากรต้นปีงบ × 100 ·
      ช่วงเวลา ${when(t.start_date, false)} – ${when(t.end_date, false)} ·
      ต้นปีงบคำนวณจากรายชื่อปัจจุบันย้อนกลับด้วยประวัติเข้า-ออก ${t.total.inconsistent ? `<br><b>มีกลุ่มที่ตัวเลขไม่สอดคล้อง</b> (เช่น คนออกมากกว่าคนต้นปี) มักเกิดจากรายชื่อปัจจุบันยังไม่ครบ หรือประวัติเข้า-ออกยังไม่ครบ` : ""}</p>
    <section class="list"><h2>อัตราการคงอยู่ แยกตาม${label}</h2>
      ${table([label, ["ต้นปีงบ", "num"], ["รับใหม่", "num"], ["รับย้ายเข้า", "num"], ["ลาออก", "num"], ["ย้ายออก", "num"], ["ปลายปีงบ", "num"], ["อัตราการคงอยู่", "num"]],
        t.groups.length ? [...t.groups.map((r) => row(r)), row(t.total, true)] : [], "ยังไม่มีข้อมูลบุคลากร")}
    </section>
    <section class="card"><h2>แนวโน้มอัตราการคงอยู่ทั้งโรงพยาบาล</h2>
      <div class="meter-list">${t.trend.map((y) => `<div class="meter">
        <div class="meter-label"><span>ปีงบประมาณ ${y.fiscal_year}</span><small class="${rateClass(y.rate)}">${rateText(y.rate)}</small></div>
        ${bar(y.rate ?? 0, maxTrend, y.rate != null && y.rate < 80 ? "over" : "")}</div>`).join("")}</div>
    </section>`;
  $("#year").onchange = (e) => { currentYear = e.target.value; refresh(); };
  return { groupby: (k) => { staffGroupBy = k; refresh(); } };
}

function movementForm(staff) {
  const kinds = Object.entries(META.move_kinds);
  const form = openForm({
    title: "บันทึกบุคลากรเข้า-ออก",
    wide: true,
    two: true,
    values: { kind: "resign", moved_on: todayIso(), deactivate: true },
    intro: `<p class="hint">ลาออก/ย้ายออก: เลือกชื่อจากรายชื่อ ระบบจะปิดบัญชีของคนนั้นให้ · รับใหม่/รับย้ายเข้า: กรอกชื่อ ถ้าใส่เลขบัตรประชาชน ระบบจะเพิ่มเป็นผู้ใช้ให้ด้วย</p>`,
    fields: [
      { name: "kind", label: "ประเภท", type: "select", required: true, options: kinds },
      { name: "moved_on", label: "วันที่มีผล", type: "date", required: true },
      { name: "user_id", label: "เลือกจากรายชื่อบุคลากร", type: "select", wide: true,
        options: [["", "— ไม่เลือก (กรอกชื่อเอง) —"], ...staff.map((s) => [s.id, `${s.full_name}${s.position ? " · " + s.position : ""}`])] },
      { name: "prefix", label: "คำนำหน้า" },
      { name: "first_name", label: "ชื่อ" },
      { name: "last_name", label: "นามสกุล" },
      { name: "national_id", label: "เลขบัตรประชาชน (ถ้าจะเพิ่มเป็นผู้ใช้)", inputmode: "numeric", maxlength: 17 },
      { name: "position", label: "ตำแหน่ง" },
      { name: "employment_type", label: "ประเภทการจ้าง", placeholder: "เช่น ข้าราชการ, พกส., ลูกจ้างชั่วคราว" },
      { name: "department", label: "กลุ่มงาน" },
      { name: "profession_group", label: "กลุ่มวิชาชีพ", hint: "เว้นว่างได้ ระบบเดาจากตำแหน่ง" },
      { name: "note", label: "หมายเหตุ", wide: true, placeholder: "เช่น ย้ายไป รพ.อรัญประเทศ" },
      { name: "deactivate", label: "ปิดบัญชีผู้ใช้ของคนที่ลาออก/ย้ายออก", type: "checkbox" },
    ],
    onSubmit: async (d) => {
      if (!d.user_id && (!d.first_name || !d.last_name)) throw new Error("กรุณาเลือกจากรายชื่อ หรือกรอกชื่อและนามสกุล");
      const r = await api("POST", "/movements", d);
      toast(r.note ? `บันทึกแล้ว · ${r.note}` : "บันทึกแล้ว");
      refresh();
    },
  });
  // เลือกจากรายชื่อแล้วไม่ต้องกรอกชื่อ/เลขบัตร
  const pick = $("[name=user_id]", form);
  const toggle = () => ["prefix", "first_name", "last_name", "national_id"].forEach((n) => {
    const f = $(`[name=${n}]`, form).closest(".field");
    f.hidden = Boolean(pick.value);
  });
  pick.onchange = toggle;
  toggle();
}

async function movesTab(body) {
  const year = currentYear || META.fiscal_year;
  let kind = "";
  try { kind = sessionStorage.getItem("move-kind") || ""; } catch {}
  const [moves, staff, ret] = await Promise.all([
    api("GET", `/movements?year=${year}${kind ? "&kind=" + kind : ""}`), api("GET", "/staff"),
    api("GET", `/staff/retention?year=${year}`)]);
  currentYear = ret.fiscal_year;
  body.innerHTML = `
    <div class="toolbar">
      ${yearSelect(ret.years, ret.fiscal_year)}
      <select id="kind">${option("", "ทุกประเภท", kind)}${Object.entries(META.move_kinds).map(([k, v]) => option(k, v, kind)).join("")}</select>
      <button class="btn" data-act="import-moves">นำเข้า Excel</button>
      <button class="btn primary" data-act="new-move">+ บันทึกเข้า-ออก</button>
    </div>
    <section class="list">
      ${table(["วันที่", "ประเภท", "ชื่อ-นามสกุล", "ตำแหน่ง", "กลุ่มงาน", "กลุ่มวิชาชีพ", "หมายเหตุ", ""], moves.map((m) => [
        when(m.moved_on, false), badge(META.move_kinds[m.kind], MOVE_BADGE[m.kind]),
        esc(`${m.prefix || ""}${m.first_name} ${m.last_name}`), esc(m.position || "-"), esc(m.department || "-"),
        esc(m.profession_group || "-"), esc(m.note || ""), actions(btn("del-move", "ลบ", m.id, "danger")),
      ]), `ไม่มีรายการในปีงบประมาณ ${ret.fiscal_year}`)}
    </section>`;
  $("#year").onchange = (e) => { currentYear = e.target.value; refresh(); };
  $("#kind").onchange = (e) => { try { sessionStorage.setItem("move-kind", e.target.value); } catch {} refresh(); };
  return {
    "new-move": () => movementForm(staff),
    "import-moves": () => importForm({
      title: "นำเข้าบุคลากรเข้า-ออกจาก Excel",
      path: "/movements/import",
      template: "movements.xlsx",
      intro: "หัวตาราง: วันที่, ประเภท (รับใหม่/รับย้ายเข้า/ลาออก/ย้ายออก), ชื่อ-สกุล (หรือ ชื่อ กับ นามสกุล), ตำแหน่ง และใส่ ประเภทการจ้าง, กลุ่มงาน, กลุ่มวิชาชีพ, หมายเหตุ เพิ่มได้ · วันที่ใช้ได้ทั้ง 1/10/2569 และ 1 ต.ค. 69 · แถวที่ซ้ำกับของเดิมจะถูกข้าม · ไฟล์ .xls แบบเก่า ให้เปิดใน Excel แล้วบันทึกเป็น .xlsx ก่อน",
    }),
    "del-move": async (id) => {
      const m = moves.find((x) => String(x.id) === id);
      if (!confirm(`ลบรายการ${META.move_kinds[m.kind]}ของ ${m.first_name} ${m.last_name}?\n(บัญชีผู้ใช้ที่ถูกปิดไปแล้วจะไม่ถูกเปิดคืนอัตโนมัติ)`)) return;
      try { await api("POST", `/movements/${id}/delete`, {}); toast("ลบแล้ว"); refresh(); } catch (e) { toast(e.message, true); }
    },
  };
}

// ---------- ผู้ใช้งาน (ผู้ดูแลระบบ) ----------

function userForm(user) {
  openForm({
    title: user ? `แก้ไข ${user.full_name}` : "เพิ่มผู้ใช้งาน",
    wide: true,
    two: true,
    values: user || { role: "user", active: true },
    intro: user ? "" : `<p class="hint">รหัสผ่านครั้งแรกคือเลขบัตรประชาชน 5 ตัวท้าย ผู้ใช้ต้องเปลี่ยนรหัสผ่านเมื่อเข้าสู่ระบบครั้งแรก</p>`,
    fields: [
      { name: "national_id", label: "หมายเลขบัตรประชาชน", required: true, inputmode: "numeric", maxlength: 17, placeholder: "13 หลัก" },
      { name: "seq", label: "ลำดับ", type: "number", min: 1, step: 1 },
      { name: "prefix", label: "คำนำหน้า", placeholder: "เช่น นาย, นางสาว" },
      { name: "first_name", label: "ชื่อ", required: true },
      { name: "last_name", label: "นามสกุล", required: true },
      { name: "position", label: "ตำแหน่ง" },
      { name: "level", label: "ระดับ" },
      { name: "department", label: "กลุ่มงาน" },
      { name: "profession_group", label: "กลุ่มวิชาชีพ", hint: "เว้นว่างได้ ระบบเดาจากตำแหน่ง" },
      { name: "role", label: "สิทธิ์", type: "select", required: true, options: Object.entries(META.roles) },
      { name: "active", label: "เปิดใช้งาน", type: "checkbox" },
    ],
    onSubmit: async (d) => {
      await api(user ? "PUT" : "POST", user ? `/users/${user.id}` : "/users", d);
      toast("บันทึกแล้ว");
      refresh();
    },
  });
}

async function usersView() {
  let showAll = false;
  try { showAll = sessionStorage.getItem("users-all") === "1"; } catch {}
  const users = await api("GET", `/users${showAll ? "?active=all" : ""}`);
  view.innerHTML = `<div class="toolbar"><h2>ผู้ใช้งาน <small>(${users.length} คน)</small></h2>
      <input type="search" id="q" placeholder="ค้นหาชื่อ เลขบัตร ตำแหน่ง ระดับ">
      <label class="checkbox"><input type="checkbox" id="all" ${showAll ? "checked" : ""}> รวมที่ปิดใช้งาน</label>
      <button class="btn" data-act="import">นำเข้า Excel</button>
      <button class="btn primary" data-act="new">+ เพิ่มผู้ใช้</button>
    </div><section class="list" id="list"></section>`;
  const status = (u) => {
    if (!u.active) return badge("ปิดใช้งาน", "muted");
    if (u.locked) return badge("ล็อกชั่วคราว", "bad");
    if (u.must_change_password) return badge("ยังไม่เปลี่ยนรหัส", "warn");
    return badge("ใช้งานแล้ว", "ok");
  };
  const draw = () => {
    const q = $("#q").value.trim().toLowerCase();
    const shown = users.filter((u) => !q || `${u.full_name} ${u.national_id} ${u.position || ""} ${u.level || ""}`.toLowerCase().includes(q));
    $("#list").innerHTML = table(["ลำดับ", "ชื่อ-นามสกุล", "เลขบัตรประชาชน", "ตำแหน่ง", "ระดับ", "สิทธิ์", "สถานะ", ""], shown.map((u) => [
      esc(u.seq ?? "-"), esc(u.full_name), `<span class="mono">${esc(fmtNid(u.national_id))}</span>`, esc(u.position || "-"),
      esc(u.level || "-"), esc(META.roles[u.role]), status(u),
      actions(btn("edit", "แก้ไข", u.id), btn("reset", "รีเซ็ตรหัส", u.id)),
    ]), users.length ? "ไม่พบผู้ใช้ที่ค้นหา" : "ยังไม่มีผู้ใช้ กด \"นำเข้า Excel\" เพื่อเพิ่มทีละหลายคน");
  };
  $("#q").oninput = draw;
  $("#all").onchange = (e) => { try { sessionStorage.setItem("users-all", e.target.checked ? "1" : "0"); } catch {} refresh(); };
  draw();
  const byId = (id) => users.find((u) => String(u.id) === id);
  bind({
    new: () => userForm(null),
    edit: (id) => userForm(byId(id)),
    import: () => importForm({
      title: "นำเข้าผู้ใช้งานจาก Excel",
      path: "/users/import",
      template: "users.xlsx",
      intro: USERS_IMPORT_INTRO,
    }),
    reset: async (id) => {
      const u = byId(id);
      if (!confirm(`รีเซ็ตรหัสผ่านของ ${u.full_name} กลับเป็นเลขบัตร 5 ตัวท้าย?\nผู้ใช้ต้องตั้งรหัสใหม่เมื่อเข้าสู่ระบบครั้งถัดไป`)) return;
      try { await api("POST", `/users/${id}/reset-password`, {}); toast("รีเซ็ตรหัสผ่านแล้ว"); refresh(); } catch (e) { toast(e.message, true); }
    },
  });
}

// ---------- บัญชีของฉัน ----------

function passwordFields(knownOld) {
  return [
    ...(knownOld ? [] : [{ name: "old_password", label: "รหัสผ่านปัจจุบัน", type: "password", required: true, autocomplete: "current-password" }]),
    { name: "new_password", label: "รหัสผ่านใหม่", type: "password", required: true, autocomplete: "new-password",
      hint: `อย่างน้อย ${META.min_password} ตัวอักษร และต้องไม่ใช่เลขบัตรประชาชน` },
    { name: "confirm", label: "ยืนยันรหัสผ่านใหม่", type: "password", required: true, autocomplete: "new-password" },
  ];
}

async function submitPassword(d, oldPassword) {
  if (d.new_password !== d.confirm) throw new Error("รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน");
  me = await api("POST", "/me/password", { old_password: oldPassword ?? d.old_password, new_password: d.new_password });
}

async function accountView() {
  me = await api("GET", "/me");
  view.innerHTML = `<section class="card">
    <div class="toolbar"><h2>บัญชีของฉัน</h2><button class="btn small" data-act="pw">เปลี่ยนรหัสผ่าน</button></div>
    <div class="info-grid">
      ${cell("ชื่อ-นามสกุล", esc(me.full_name))}
      ${cell("เลขบัตรประชาชน", `<span class="mono">${esc(fmtNid(me.national_id))}</span>`)}
      ${cell("ตำแหน่ง", esc(me.position || "-"))}
      ${cell("ระดับ", esc(me.level || "-"))}
      ${cell("สิทธิ์", esc(META.roles[me.role]))}
    </div>
    <p class="hint">ถ้าข้อมูลไม่ถูกต้อง แจ้งเจ้าหน้าที่ HR ผ่านเมนู HR Clinic</p></section>`;
  bind({
    pw: () => openForm({
      title: "เปลี่ยนรหัสผ่าน",
      fields: passwordFields(false),
      onSubmit: async (d) => { await submitPassword(d); toast("เปลี่ยนรหัสผ่านแล้ว"); },
    }),
  });
}

// ---------- เข้าสู่ระบบ ----------

function authCard(title, intro, fields, submitLabel, onSubmit, tip = "") {
  document.body.classList.add("auth");
  $("#tabs").innerHTML = "";
  $("#userbox").innerHTML = "";
  view.onclick = null;
  const feature = (icon, text) => `<li><span>${ICONS[icon]}</span>${text}</li>`;
  view.innerHTML = `<div class="auth-wrap">
    <aside class="auth-brand">
      <div class="hosp-logo big"><img src="logo.png" alt="โรงพยาบาลตาพระยา"></div>
      <h1>ระบบงานบริหารทรัพยากรบุคคล</h1>
      <p>โรงพยาบาลตาพระยา</p>
      <ul>
        ${feature("plans", "แผนพัฒนาบุคลากรและการใช้งบ")}
        ${feature("doc", "คำสั่ง รายงานการประชุม และเอกสาร")}
        ${feature("health", "กิจกรรมตรวจสุขภาพประจำปี")}
        ${feature("clinic", "HR Clinic ถามตอบกับงานบริหารทรัพยากรบุคคล")}
      </ul>
    </aside>
    <form class="auth-form" id="auth-form">
      <h2>${title}</h2><p class="sub">${intro}</p>
      <div class="fields">${fields.map((f) => fieldHtml(f)).join("")}</div>
      <p class="form-error" hidden></p>
      <button type="submit" class="btn primary block">${submitLabel}</button>
      ${tip ? `<p class="tip">${tip}</p>` : ""}
    </form>
  </div>`;
  const form = $("#auth-form");
  $("input", form).focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const error = $(".form-error", form);
    const submit = $("button[type=submit]", form);
    error.hidden = true;
    submit.disabled = true;
    try {
      await onSubmit(Object.fromEntries(new FormData(form)));
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  };
}

const NID_FIELD = { name: "national_id", label: "เลขบัตรประชาชน 13 หลัก", required: true, inputmode: "numeric",
  autocomplete: "username", maxlength: 17, placeholder: "x-xxxx-xxxxx-xx-x" };

function loginScreen() {
  authCard("เข้าสู่ระบบ", "ยินดีต้อนรับ กรุณาเข้าสู่ระบบด้วยเลขบัตรประชาชน",
    [NID_FIELD, { name: "password", label: "รหัสผ่าน", type: "password", required: true, autocomplete: "current-password" }],
    "เข้าสู่ระบบ",
    async (d) => {
      me = await api("POST", "/login", d);
      startApp(d.password);
    }, "เข้าใช้งานครั้งแรก ใช้รหัสผ่านเป็นเลขบัตรประชาชน 5 ตัวท้าย ลืมรหัสผ่านติดต่องานบริหารทรัพยากรบุคคล");
}

function setupScreen() {
  authCard("ตั้งค่าระบบครั้งแรก", "สร้างบัญชีผู้ดูแลระบบ (HR) คนแรก จากนั้นนำเข้ารายชื่อบุคลากรได้ในเมนู \"ผู้ใช้งาน\"",
    [NID_FIELD, { name: "prefix", label: "คำนำหน้า" }, { name: "first_name", label: "ชื่อ", required: true },
      { name: "last_name", label: "นามสกุล", required: true }, { name: "position", label: "ตำแหน่ง" },
      { name: "password", label: "รหัสผ่าน", type: "password", required: true, autocomplete: "new-password",
        hint: "อย่างน้อย 8 ตัวอักษร และต้องไม่ใช่เลขบัตรประชาชน" }],
    "สร้างบัญชีและเข้าสู่ระบบ",
    async (d) => {
      me = await api("POST", "/setup", d);
      startApp();
    });
}

function forceChangeScreen(oldPassword) {
  authCard("ตั้งรหัสผ่านใหม่", `สวัสดี ${esc(me.full_name)} กรุณาตั้งรหัสผ่านใหม่ก่อนเริ่มใช้งาน`,
    passwordFields(Boolean(oldPassword)), "บันทึกรหัสผ่านและเข้าใช้งาน",
    async (d) => {
      await submitPassword(d, oldPassword);
      toast("ตั้งรหัสผ่านใหม่แล้ว");
      startApp();
    });
}

// ไอคอนเมนู (เส้น ใช้สีตามตัวอักษร)
const icon = (d) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  dashboard: icon('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'),
  staff: icon('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="11" r="2.5"/><path d="M5.5 17c.5-1.8 1.9-2.8 3.5-2.8s3 1 3.5 2.8M15 10h3M15 14h3"/>'),
  plans: icon('<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>'),
  doc: icon('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>'),
  order: icon('<path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1z"/><path d="M16 5h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2"/><path d="M9 12l2 2 4-4"/>'),
  health: icon('<path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 0 0-7.1 7.1L12 21.5l8.8-8.8a5 5 0 0 0 0-7.1z"/><path d="M7 12h2l1.5-2.5L13 15l1.5-3H17"/>'),
  meeting: icon('<circle cx="8" cy="8" r="3"/><circle cx="16" cy="8" r="3"/><path d="M2.5 19c.6-2.8 2.8-4.5 5.5-4.5s4.9 1.7 5.5 4.5M12.5 15c.9-.3 2.2-.5 3.5-.5 2.7 0 4.9 1.7 5.5 4.5"/>'),
  clinic: icon('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5M12 16.5h.01"/>'),
  other: icon('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  users: icon('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.7-3.4 3.3-5.5 6.5-5.5s5.8 2.1 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.6.8 2.7 2.6 3 5.2"/>'),
  account: icon('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="10" r="3"/><path d="M6.5 18.5c1.2-2 3.1-3 5.5-3s4.3 1 5.5 3"/>'),
};

// ---------- เมนูและการสลับหน้า ----------

const VIEWS = {
  dashboard: ["Dashboard", dashboardView, null, "dashboard"],
  staff: ["ข้อมูลบุคลากร", staffView, null, "staff"],
  plans: ["แผนพัฒนาบุคลากร", plansView, null, "plans"],
  "doc-order": ["คำสั่ง", documentsView("order"), null, "order"],
  "doc-health": ["ตรวจสุขภาพประจำปี", documentsView("health"), null, "health"],
  "doc-meeting": ["รายงานการประชุม", documentsView("meeting"), null, "meeting"],
  clinic: ["HR Clinic", clinicView, null, "clinic"],
  "doc-other": ["เอกสารอื่น ๆ", documentsView("other"), null, "other"],
  users: ["ผู้ใช้งาน", usersView, "admin", "users"],
  account: ["บัญชีของฉัน", accountView, null, "account"],
};
const allowed = (key) => !VIEWS[key][2] || me?.role === VIEWS[key][2];
let current = null;

async function show(tab) {
  if (!me) return;
  if (!VIEWS[tab] || !allowed(tab)) tab = "dashboard";
  current = tab;
  if (dlg.open) dlg.close();
  if (location.hash !== "#" + tab) history.replaceState(null, "", "#" + tab);
  $("#tabs").innerHTML = Object.entries(VIEWS).filter(([k]) => allowed(k))
    .map(([key, [text, , , ic]]) => `<button data-tab="${key}" ${key === tab ? 'aria-current="page"' : ""}>${ICONS[ic]}<span>${text}</span></button>`).join("");
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

async function startApp(loginPassword) {
  try { META = META || await api("GET", "/meta"); } catch (e) { return toast(e.message, true); }
  if (me.must_change_password) return forceChangeScreen(loginPassword);
  document.body.classList.remove("auth");
  $("#userbox").innerHTML = `<span><b>${esc(me.full_name)}</b><small>${esc(me.position || META.roles[me.role])}</small></span>
    <button class="btn small" id="logout">ออกจากระบบ</button>`;
  $("#logout").onclick = async () => {
    try { await api("POST", "/logout", {}); } catch {}
    me = null;
    loginScreen();
  };
  show(location.hash.slice(1));
}

unauthorized = () => {
  if (!me) return;
  me = null;
  if (dlg.open) dlg.close();
  toast("หมดเวลาการใช้งาน กรุณาเข้าสู่ระบบใหม่", true);
  loginScreen();
};

$("#tabs").onclick = (e) => { const b = e.target.closest("[data-tab]"); if (b) show(b.dataset.tab); };
window.addEventListener("hashchange", () => { if (location.hash.slice(1) !== current) show(location.hash.slice(1)); });

(async function boot() {
  try {
    const { needs_setup } = await api("GET", "/setup");
    if (needs_setup) return setupScreen();
    me = await api("GET", "/me");
    startApp();
  } catch {
    loginScreen();
  }
})();
