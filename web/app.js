// OfferLens UI. All model output is rendered with createElement/textContent — never innerHTML (CSP, SECURITY §4).

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("data-") || k.startsWith("aria-") || k === "role") n.setAttribute(k, v);
    else n[k] = v;
  }
  for (const kid of kids) n.append(kid);
  return n;
};

// Field → label + meaning color (DESIGN.md: who=blue, money=red, when=yellow, other=ink).
const FIELDS = [
  ["merchant", "Merchant", "blue"], ["issuer", "Issuer", "blue"], ["offer_type", "Offer type", "ink"],
  ["value", "Value", "red"], ["max_cap_inr", "Max cap", "red"], ["min_order_inr", "Min order", "red"],
  ["coupon_code", "Coupon code", "ink"], ["valid_from", "Valid from", "yellow"], ["valid_till", "Valid till", "yellow"],
  ["payment_modes", "Payment modes", "blue"], ["exclusions", "Exclusions", "ink"], ["per_user_limit", "Per-user limit", "ink"],
];
const MODE_TEXT = { credit_card: "Credit card", debit_card: "Debit card", upi: "UPI", wallet: "Wallet",
  netbanking: "Netbanking", emi: "EMI", cod: "Cash on delivery", any: "Any" };
const MODE_FORMS = { credit_card: ["credit card", "cc", "credit"], debit_card: ["debit card", "debit"], upi: ["upi"],
  wallet: ["wallet"], netbanking: ["netbanking", "net banking"], emi: ["emi"], cod: ["cod", "cash on delivery"], any: [] };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

function display(field, offer) {
  const v = offer[field];
  if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) return null;
  if (field === "value") return offer.value_unit === "percent" ? `${v}%` : offer.value_unit === "flat_inr" ? `₹${inr.format(v)}` : String(v);
  if (field === "max_cap_inr" || field === "min_order_inr") return `₹${inr.format(v)}`;
  if (field === "payment_modes") return v.map((m) => MODE_TEXT[m] || m).join(", ");
  if (field === "exclusions") return v.join("; ");
  if (field === "offer_type") return v.replace(/_/g, " ");
  if (field === "valid_from" || field === "valid_till") {
    const [y, m, d] = v.split("-").map(Number);
    return `${d} ${MONTHS[m - 1]} ${y}`;
  }
  return String(v);
}

// ---------- Source highlighting ----------
function numberForms(n) {
  const s = String(n), c = inr.format(n);
  const forms = [s, c, `₹${s}`, `₹${c}`, `₹ ${s}`, `Rs${s}`, `Rs ${s}`, `Rs.${s}`, `Rs. ${s}`, `Rs.${c}`, `Rs. ${c}`, `Rs ${c}`, `INR ${s}`, `INR ${c}`];
  if (n >= 1000) forms.push(`${n / 1000}k`);
  return forms;
}
function dateForms(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const mon = MONTHS[m - 1];
  const sfx = d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th";
  return [`${d}${sfx} ${mon}`, `${d} ${mon}`, `${d}-${mon}`, `${d}/${m}`, `${d}-${m}`, `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`, `${mon} ${d}`, `${d}${sfx} ${mon} ${y}`, `${d} ${mon} ${y}`];
}
function candidates(offer, k) {
  const out = [];
  const add = (field, forms) => forms.filter((f) => f && f.length >= 2).forEach((f) => out.push({ field, key: `${k}.${field}`, form: f }));
  if (offer.merchant) add("merchant", [offer.merchant]);
  if (offer.issuer) add("issuer", [offer.issuer, offer.issuer.split(" ")[0]]);
  if (offer.value !== null) add("value", offer.value_unit === "percent" ? [`${offer.value}%`, `${offer.value} %`] : numberForms(offer.value));
  if (offer.max_cap_inr !== null) add("max_cap_inr", numberForms(offer.max_cap_inr));
  if (offer.min_order_inr !== null) add("min_order_inr", numberForms(offer.min_order_inr));
  if (offer.coupon_code) add("coupon_code", [offer.coupon_code]);
  if (offer.valid_from) add("valid_from", dateForms(offer.valid_from));
  if (offer.valid_till) add("valid_till", dateForms(offer.valid_till));
  for (const m of offer.payment_modes) add("payment_modes", MODE_FORMS[m] || []);
  for (const e of offer.exclusions) add("exclusions", [e, e.split(" ")[0]].filter((w) => w.length > 3));
  return out;
}
function findSpans(text, extraction) {
  const low = text.toLowerCase();
  const hits = [];
  extraction.offers.forEach((offer, k) => {
    for (const c of candidates(offer, k)) {
      const f = c.form.toLowerCase();
      for (let i = low.indexOf(f); i !== -1; i = low.indexOf(f, i + 1)) {
        const before = low[i - 1], after = low[i + f.length];
        const edge = (ch) => ch === undefined || !/[a-z0-9]/.test(ch);
        if (edge(before) && edge(after)) hits.push({ start: i, end: i + f.length, ...c });
      }
    }
  });
  hits.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start); // longest wins
  const kept = [];
  for (const h of hits) if (!kept.some((o) => h.start < o.end && o.start < h.end)) kept.push(h);
  return kept.sort((a, b) => a.start - b.start);
}
function colorOf(field) { return (FIELDS.find((f) => f[0] === field) || [, , "ink"])[2]; }

function renderSource(text, extraction) {
  const box = $("source");
  box.replaceChildren();
  let pos = 0;
  for (const s of findSpans(text, extraction)) {
    if (s.start > pos) box.append(document.createTextNode(text.slice(pos, s.start)));
    const label = (FIELDS.find((f) => f[0] === s.field) || [, s.field])[1];
    box.append(el("mark", { class: `c-${colorOf(s.field)}`, "data-key": s.key, tabIndex: 0, title: label, text: text.slice(s.start, s.end) }));
    pos = s.end;
  }
  if (pos < text.length) box.append(document.createTextNode(text.slice(pos)));
  $("source-block").hidden = false;
}

function link(key, on) {
  document.querySelectorAll(`[data-key="${CSS.escape(key)}"]`).forEach((n) => n.classList.toggle("is-linked", on));
}
document.addEventListener("pointerover", (e) => { const k = e.target.closest?.("[data-key]"); if (k) link(k.dataset.key, true); });
document.addEventListener("pointerout", (e) => { const k = e.target.closest?.("[data-key]"); if (k) link(k.dataset.key, false); });
document.addEventListener("focusin", (e) => { const k = e.target.closest?.("[data-key]"); if (k) link(k.dataset.key, true); });
document.addEventListener("focusout", (e) => { const k = e.target.closest?.("[data-key]"); if (k) link(k.dataset.key, false); });

// ---------- Receipt ----------
function receipt(extraction, { diffAgainst = null, keyPrefix = "" } = {}) {
  const wrap = el("div");
  if (!extraction) {
    wrap.append(el("p", { class: "no-offer", text: "Output failed schema validation — nothing shown." }));
    return wrap;
  }
  if (extraction.offers.length === 0) {
    wrap.append(el("p", { class: "no-offer", text: "No offer in this text." }));
    return wrap;
  }
  extraction.offers.forEach((offer, k) => {
    const r = el("section", { class: "receipt", "aria-label": `Offer ${k + 1}` });
    r.append(el("div", { class: "receipt-head" }, el("span", { text: `Offer ${k + 1}` }), el("span", { text: offer.offer_type.replace(/_/g, " ") })));
    for (const [field, label, color] of FIELDS) {
      const shown = display(field, offer);
      const other = diffAgainst?.offers?.[k];
      const differs = diffAgainst !== null && JSON.stringify(offer[field]) !== JSON.stringify(other ? other[field] : undefined);
      r.append(el("div", { class: "line", "data-key": `${keyPrefix}${k}.${field}`, tabIndex: 0 },
        el("span", { class: `dot c-${color}`, "aria-hidden": "true" }),
        el("span", { class: "line-label", text: label }),
        el("span", { class: `line-value${shown === null ? " null" : ""}${differs ? " diff" : ""}`, text: shown ?? "—",
          "aria-label": `${label}: ${shown ?? "not stated"}${differs ? " (differs)" : ""}` })));
    }
    wrap.append(r);
  });
  return wrap;
}

// ---------- JSON view ----------
function jsonTokens(obj) {
  const pre = $("json-pre");
  pre.replaceChildren();
  const text = JSON.stringify(obj, null, 2);
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?)|(null)|(true|false)/g;
  let pos = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > pos) pre.append(document.createTextNode(text.slice(pos, m.index)));
    const cls = m[1] ? (m[2] ? "j-key" : "j-str") : m[3] ? "j-num" : m[4] ? "j-null" : "j-bool";
    pre.append(el("span", { class: cls, text: m[1] || m[0] }));
    if (m[2]) pre.append(document.createTextNode(m[2]));
    pos = re.lastIndex;
  }
  pre.append(document.createTextNode(text.slice(pos)));
  return text;
}

// ---------- API ----------
async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Request failed (${res.status}).`);
  return data;
}
function showError(id, msg) { const e = $(id); e.textContent = msg; e.hidden = !msg; }

// ---------- Extract view ----------
let lastJson = "";
async function runExtract() {
  const text = $("offer-text").value;
  showError("extract-error", "");
  if (!text.trim()) return showError("extract-error", "Paste some offer text first.");
  if (text.length > 2000) return showError("extract-error", "That's longer than 2,000 characters — trim it.");
  $("extract-btn").disabled = true;
  $("extract-empty").hidden = true;
  $("result").hidden = true;
  $("loader").hidden = false;
  $("result-col").setAttribute("aria-busy", "true");
  try {
    const r = await api("/api/extract", { text, reference_date: $("ref-date").value || null, model: "student" });
    $("status").replaceChildren(
      el("span", { class: `badge ${r.valid ? "ok" : "bad"}`, text: r.valid ? "VALID" : "INVALID" }),
      el("span", { class: "meta", text: `${r.latency_ms} ms` }),
      el("span", { class: "meta", text: r.label }),
      el("span", { class: "tag yellow", text: "constrained" }),
      ...(r.fallback ? [el("span", { class: "tag line", text: r.provider === "openrouter" ? "fallback · hosted API" : "fallback" })] : []),
    );
    $("receipt").replaceChildren(receipt(r.extraction));
    if (r.provider === "openrouter") $("receipt").prepend(el("p", { class: "meta", text: "Our GPU server is unavailable, so this text was processed by a third-party API (OpenRouter)." }));
    lastJson = jsonTokens(r.extraction ?? { error: "schema validation failed" });
    if (r.extraction) renderSource(text, r.extraction); else $("source-block").hidden = true;
    $("result").hidden = false;
  } catch (err) {
    $("extract-empty").hidden = false;
    showError("extract-error", err.message);
  } finally {
    $("loader").hidden = true;
    $("extract-btn").disabled = false;
    $("result-col").setAttribute("aria-busy", "false");
  }
}

function setView(view) {
  document.querySelectorAll(".toggle-opt").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.view === view)));
  $("receipt").hidden = view !== "receipt";
  $("json-view").hidden = view !== "json";
}

// ---------- Compare view ----------
async function runCompare() {
  const text = $("compare-text").value;
  showError("compare-error", "");
  if (!text.trim()) return showError("compare-error", "Paste some offer text first.");
  $("compare-btn").disabled = true;
  $("verdict").textContent = "Running both models…";
  try {
    const r = await api("/api/compare", { text, reference_date: $("ref-date").value || null });
    const b = r.base.extraction, s = r.student.extraction;
    const who = (x) => el("p", { class: "meta", text: `Answered by ${x.label}${x.fallback ? " (fallback)" : ""}` });
    $("compare-base").replaceChildren(who(r.base), receipt(b, { diffAgainst: s, keyPrefix: "b" }));
    $("compare-student").replaceChildren(who(r.student), receipt(s, { keyPrefix: "s" }));
    let diffs = 0;
    const n = Math.max(b?.offers.length ?? 0, s?.offers.length ?? 0);
    for (let k = 0; k < n; k++) for (const [f] of FIELDS) if (JSON.stringify(b?.offers[k]?.[f]) !== JSON.stringify(s?.offers[k]?.[f])) diffs++;
    $("verdict").textContent = diffs === 0 ? "Both models agree on every field." : `Base differs from OfferLens on ${diffs} field${diffs === 1 ? "" : "s"}.`;
    $("compare-cols").hidden = false;
  } catch (err) {
    $("verdict").textContent = "";
    showError("compare-error", err.message);
  } finally {
    $("compare-btn").disabled = false;
  }
}

// ---------- Results view ----------
const COND = { A: "A · Base, unconstrained", B: "B · Base + grammar", C: "C · OfferLens + grammar", D: "D · Teacher 7B + grammar" };
const METRICS = [["schema_valid", "Schema-valid"], ["field_acc", "Field accuracy"], ["hallucination_rate", "Hallucinated fields (lower is better)"]];
const pct = (v) => `${(100 * v).toFixed(1)}%`;

async function loadResults() {
  const body = $("results-body");
  body.replaceChildren(el("p", { class: "lede", text: "Loading…" }));
  let res;
  try { res = await api("/api/results"); } catch (err) {
    body.replaceChildren(el("p", { class: "lede", text: `${err.message} Nothing is shown until real numbers exist.` }));
    return;
  }
  body.replaceChildren();
  const sets = ["synthetic", "handlabeled", "real", "injection"].filter((s) => Object.keys(COND).some((c) => res[c]?.[s]));
  for (const set of sets) {
    body.append(el("h2", { class: "set-title", text: `${set} test · n=${res.meta?.n?.[set] ?? "?"}` }));
    for (const [key, label] of METRICS) {
      const m = el("div", { class: "metric" }, el("h2", { text: label }));
      for (const c of Object.keys(COND)) {
        const v = res[c]?.[set]?.[key];
        if (typeof v !== "number") continue;
        const bar = el("div", { class: `bar b-${c}` });
        bar.style.width = `${Math.max(0.5, v * 100)}%`; // CSSOM, not inline style attribute
        m.append(el("div", { class: "bar-row" }, el("span", { class: "bar-name", text: COND[c] }), el("div", { class: "bar-track" }, bar), el("span", { class: "bar-val", text: pct(v) })));
      }
      body.append(m);
    }
  }
  const local = res.C?.perf?.cost_per_1k_inr, api_ = res.meta?.closed_api;
  if (typeof local === "number") {
    body.append(el("p", { class: "cost", text: `₹${local.toFixed(2)}${api_?.cost_per_1k_inr ? ` vs ₹${api_.cost_per_1k_inr.toFixed(2)}` : ""}` }),
      el("p", { class: "cite", text: `Cost per 1,000 extractions. Local: GPU ₹/hour ÷ measured throughput. ${api_?.source_url ? `Closed API price: ${api_.source_url} (fetched ${api_.fetched}).` : ""}` }));
  }
}

// ---------- Router + boot ----------
function route() {
  const name = (location.hash.match(/^#\/(\w+)/) || [, "extract"])[1];
  const views = ["extract", "compare", "results"];
  const v = views.includes(name) ? name : "extract";
  for (const n of views) $(`view-${n}`).hidden = n !== v;
  document.querySelectorAll("nav [data-route]").forEach((a) => (a.dataset.route === v ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  if (v === "results") loadResults();
}

async function boot() {
  $("ref-date").value = new Date().toISOString().slice(0, 10);
  const ta = $("offer-text");
  ta.addEventListener("input", () => { $("char-count").textContent = `${inr.format(ta.value.length)} / 2,000`; });
  for (const t of [ta, $("compare-text")]) {
    t.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") (t === ta ? runExtract : runCompare)(); });
  }
  $("extract-btn").addEventListener("click", runExtract);
  $("compare-btn").addEventListener("click", runCompare);
  document.querySelectorAll(".toggle-opt").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  $("copy-btn").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(lastJson); $("copy-msg").textContent = "Copied."; } catch { $("copy-msg").textContent = "Copy failed — select the text instead."; }
  });
  window.addEventListener("hashchange", route);
  route();
  try {
    const examples = await api("/api/examples");
    $("examples").replaceChildren(...examples.map((ex) => el("button", { type: "button", role: "listitem", text: ex.label, onclick: () => {
      ta.value = ex.text; $("compare-text").value = ex.text; $("ref-date").value = ex.reference_date; ta.dispatchEvent(new Event("input")); ta.focus();
    } })));
  } catch { /* examples are optional */ }
}
boot();
