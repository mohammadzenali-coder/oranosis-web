/* Oranosis v1 browser edition front-end (vanilla JS, no external dependencies).
 * Same UI as static/app.js; the /api/... calls are replaced by local calls to the JavaScript engine (oranosis.js).
 * Nothing is ever sent over the network: the page only reads its own model and knowledge files. */
import { Oranosis, sanitizeRecord, selfTest } from "./oranosis.js";

(() => {
"use strict";
const FIELDS = ["age","sex","patient habits","patient history","extraoral findings","texture","color","base","count","location","size(mm)","consistency","additional data"];
const CORE = ["texture","color","base","location","size(mm)","consistency"];
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const TIER_COL = {low:"var(--low)", borderline:"var(--border)", intermediate:"var(--mid)", high:"var(--high)"};
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let INFO = null, LAST = null, ENGINE = null, K = null;
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

/* Theme */
function applyTheme(t){
  document.documentElement.dataset.theme = t;
  $("theme").setAttribute("aria-pressed", t === "dark");
  $("theme").title = "Dark mode: " + (t === "dark" ? "on" : "off");
}
applyTheme(store.get("oranosis-theme") || "light");
$("theme").onclick = () => {
  const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(t); store.set("oranosis-theme", t);
};

/* Tabs: ARIA tab pattern with roving tabindex and arrow keys. */
const TABS = [...document.querySelectorAll('.tabs [role="tab"]')];
function go(tab, focus){
  TABS.forEach(b => { const on = b.dataset.tab === tab; b.setAttribute("aria-selected", on); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); });
  document.querySelectorAll("main > section").forEach(s => s.classList.toggle("hidden", s.id !== "tab-" + tab));
  try { history.replaceState(null, "", "#" + tab); } catch { /* file:// in some browsers */ }
}
TABS.forEach((b, i) => {
  b.onclick = () => go(b.dataset.tab);
  b.onkeydown = e => {
    const n = {ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1}[e.key];
    if (n === undefined) return;
    e.preventDefault(); go(TABS[(n + TABS.length) % TABS.length].dataset.tab, true);
  };
});
document.querySelectorAll("[data-go]").forEach(a => a.onclick = e => { e.preventDefault(); go(a.dataset.go); });
if (location.hash && $("tab-" + location.hash.slice(1))) go(location.hash.slice(1));

/* Chips: toggle buttons that write into their text field. */
document.querySelectorAll(".chips").forEach(group => {
  const input = $(group.dataset.target), multi = group.dataset.mode === "multi";
  group.querySelectorAll(".chip").forEach(chip => {
    chip.setAttribute("aria-pressed", "false");
    chip.onclick = () => {
      const val = chip.textContent.trim();
      let parts = input.value.split(",").map(s => s.trim()).filter(Boolean);
      if (parts.includes(val)) parts = parts.filter(p => p !== val);
      else { if (!multi) parts = []; parts.push(val); }
      input.value = parts.join(", "); syncChips(); updateCompleteness();
    };
  });
});
function syncChips(){
  document.querySelectorAll(".chips").forEach(group => {
    const vals = $(group.dataset.target).value.split(",").map(s => s.trim());
    group.querySelectorAll(".chip").forEach(c => c.setAttribute("aria-pressed", vals.includes(c.textContent.trim())));
  });
}

/* Form helpers */
function record(){
  const rec = {};
  FIELDS.forEach(k => rec[k] = $(k).value.trim());
  const checks = [...document.querySelectorAll("#findings input:checked")].map(c => c.value);
  if (checks.length) rec["additional data"] = [rec["additional data"], ...checks].filter(Boolean).join("; ");
  return rec;
}
function updateCompleteness(){
  const n = CORE.filter(k => $(k).value.trim()).length;
  $("comp-bar").style.width = (100 * n / CORE.length) + "%";
  $("comp-txt").textContent = `${n}/${CORE.length} core descriptors filled`;
}
FIELDS.forEach(k => $(k).addEventListener("input", () => { updateCompleteness(); syncChips(); }));
updateCompleteness();

const EXAMPLES = [
  {"age":"66","sex":"m","patient habits":"smoker, alcohol","patient history":"started as a small lump and grew over 2 months, painful while eating","extraoral findings":"left submandibular lymph node, hard and fixed","texture":"rough, ulcerated","color":"white, red","base":"sessile, fixed / non mobile","count":"1","location":"lateral border of tongue","size(mm)":"25*18","consistency":"firm, indurated","additional data":"ulcer present for 5 weeks; no relation to denture"},
  {"age":"27","sex":"f","patient habits":"pregnant","patient history":"rapidly growing over 3 weeks, bleeds on brushing","extraoral findings":"normal","texture":"lobulated, ulcerated","color":"red","base":"pedunculated","count":"1","location":"interdental papilla","size(mm)":"12*8","consistency":"soft","additional data":""},
  {"age":"19","sex":"f","patient habits":"cheek/lip biting","patient history":"swelling appears and disappears for 1 month","extraoral findings":"normal","texture":"smooth","color":"bluish","base":"dome shaped","count":"1","location":"lower lip","size(mm)":"6*6","consistency":"soft, fluctuant","additional data":""},
  {"age":"71","sex":"f","patient habits":"denture","patient history":"loose denture for years; folds of tissue along the flange for 1 year","extraoral findings":"normal","texture":"smooth, lobulated","color":"pink","base":"sessile","count":"1","location":"buccal vestibule (denture flange)","size(mm)":"30*10","consistency":"firm","additional data":""}
];
let exIdx = 0;
$("example").onclick = () => {
  clearForm(); const e = EXAMPLES[exIdx++ % EXAMPLES.length];
  FIELDS.forEach(k => $(k).value = e[k] || ""); syncChips(); updateCompleteness();
};
function clearForm(){
  FIELDS.forEach(k => $(k).value = k === "count" ? "1" : "");
  document.querySelectorAll("#findings input").forEach(c => c.checked = false);
  syncChips(); updateCompleteness();
}
$("clear").onclick = clearForm;

/* Analyse (local) */
const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
$("form").addEventListener("submit", async e => {
  e.preventDefault();
  if (!ENGINE) return;
  const btn = $("go"); btn.disabled = true; btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Analysing';
  try {
    await nextFrame();
    const rec = record();
    if (JSON.stringify(rec).length > K.LIMITS.MAX_JSON) throw new Error(`payload too large (limit ${K.LIMITS.MAX_JSON / 1024} KB)`);
    const t0 = performance.now();
    const d = ENGINE.diagnose(sanitizeRecord(rec, K));
    LAST = d; render(d, performance.now() - t0);
    if (window.innerWidth < 1000) $("result-col").scrollIntoView({behavior: reduceMotion() ? "auto" : "smooth"});
  } catch (err) {
    $("result").innerHTML = `<div class="warn" role="alert">Could not analyse the case: ${esc(err.message)}. Check the entries, then press Analyse again.</div>`;
  } finally { btn.disabled = false; btn.textContent = "Analyse"; }
});

function gaugeSVG(risk, tier){
  const pct = Math.max(0, Math.min(1, risk)), ang = Math.PI * (1 - pct);
  const cx = 100, cy = 100, r = 80, x = cx + r * Math.cos(ang), y = cy - r * Math.sin(ang);
  return `<svg class="gauge" viewBox="0 0 200 120" width="200" height="120" role="img" aria-label="Malignancy risk ${(100*risk).toFixed(1)} percent">
    <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="var(--surface-2)" stroke-width="16" stroke-linecap="round"/>
    <path d="M20 100 A80 80 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)}" fill="none" stroke="${TIER_COL[tier]}" stroke-width="16" stroke-linecap="round"/>
    <text x="100" y="92" text-anchor="middle" font-size="28" font-weight="800" fill="var(--ink)">${(100*risk).toFixed(1)}%</text>
    <text x="100" y="112" text-anchor="middle" font-size="12" fill="var(--mute)">malignancy risk</text></svg>`;
}

function scaleHTML(m){
  // Display scale runs to twice the high threshold so the three cut-offs stay readable.
  const th = m.thresholds, maxv = Math.max(th.high * 2, 0.4);
  const pos = v => Math.min(100, 100 * v / maxv);
  const seg = (a, b, c) => `<div style="width:${pos(b) - pos(a)}%;background:${c}"></div>`;
  return `<div class="scale" aria-hidden="true">${seg(0, th.borderline, "var(--low)")}${seg(th.borderline, th.intermediate, "var(--border)")}
    ${seg(th.intermediate, th.high, "var(--mid)")}${seg(th.high, maxv, "var(--high)")}
    <span class="marker" style="left:calc(${pos(m.risk)}% - 2px)"></span></div>
    <div class="scale-labels" aria-hidden="true"><span style="left:0">0%</span>${[th.borderline, th.intermediate, th.high].map(v =>
      `<span style="left:${pos(v)}%">${(100*v).toFixed(0)}%</span>`).join("")}</div>`;
}

function render(d, ms){
  const m = d.malignancy;
  let h = `<div class="riskwrap"><div>${gaugeSVG(m.risk, m.tier)}</div><div>
      <span class="badge t-${m.tier}">${m.tier.toUpperCase()} RISK</span>
      ${m.tier_override ? `<span class="mute"> raised by ${esc(m.tier_override)}</span>` : ""}
      <p style="margin:8px 0 0">${esc(m.advice)}</p></div></div>
    ${scaleHTML(m)}
    <div class="flags">${m.red_flags.length ? m.red_flags.map(f => `<span class="flag"><span aria-hidden="true">⚑ </span>${esc(f.flag)} (+${f.points})</span>`).join("") : '<span class="mute">No red flags.</span>'}</div>
    <details><summary>Details</summary><p class="mute">Model ${(100*m.model_probability).toFixed(1)}% · differential ${(100*m.differential_malignant_mass).toFixed(1)}% · red-flag score ${m.red_flag_score}</p>
      ${m.drivers.length ? "<p>" + m.drivers.map(x => `<span class="tag ${x.log_odds > 0 ? "neg" : "pos"}">${esc(x.feature)} ${x.log_odds > 0 ? "↑ raises" : "↓ lowers"}</span>`).join("") + "</p>" : ""}</details>
    ${d.warnings.map(w => `<div class="warn">${esc(w)}</div>`).join("")}
    <h2 style="margin-top:18px">Differential</h2>`;
  d.differential.forEach(x => {
    h += `<div class="dx ${x.malignant ? "mal" : ""}">
      <div class="dx-head"><h3>${x.rank}. ${esc(x.name)}${x.safety_inserted ? '<span class="pill" title="Most likely malignant lesion added because the risk tier is intermediate or high">safety</span>' : ""}</h3><span class="p">${(100*x.probability).toFixed(1)}%</span></div>
      <div class="bar" aria-hidden="true"><div style="width:${Math.max(2, 100*x.probability)}%"></div></div>
      <div class="mute">${esc(x.category)}</div>
      <div>${x.supporting.map(s => `<span class="tag pos">+ ${esc(s)}</span>`).join("")}${x.against.map(s => `<span class="tag neg">− ${esc(s)}</span>`).join("")}</div>
      <details><summary>Summary and references</summary><p>${esc(x.summary)}</p><p><b>Key differences:</b> ${esc(x.discriminators)}</p>
      <ol class="refs">${x.references.map(r => `<li>${esc(r)}</li>`).join("")}</ol></details></div>`;
  });
  h += `<details><summary>Recognised features (${d.recognized_features.length})</summary><p>${d.recognized_features.map(s => `<span class="tag pos">${esc(s)}</span>`).join("")}</p></details>
    <div class="actions no-print"><button type="button" class="btn ghost" id="print">Print report</button><button type="button" class="btn ghost" id="copy">Copy summary</button><button type="button" class="btn ghost" id="json">Download JSON</button></div>
    <div class="disc">${esc(d.disclaimer)} <span class="mute">Computed on this device${ms !== undefined ? " in " + (ms < 10 ? ms.toFixed(1) : Math.round(ms)) + " ms" : ""}.</span></div>`;
  $("result").innerHTML = h;
  $("print").onclick = () => { $("print-date").textContent = new Date().toLocaleString() + " · " + d.version; window.print(); };
  $("copy").onclick = async () => {
    const ok = await copyText(summaryText(d));
    const msg = ok ? "Copied" : "Copy failed: select the text and copy it by hand";
    $("copy").textContent = msg; $("copy-status").textContent = msg;
    setTimeout(() => { const b = $("copy"); if (b) b.textContent = "Copy summary"; $("copy-status").textContent = ""; }, 2500);
  };
  $("json").onclick = () => download("oranosis_result.json", JSON.stringify(d, null, 2), "application/json");
}

async function copyText(t){
  try { await navigator.clipboard.writeText(t); return true; }
  catch {                                     // file://, plain HTTP and some phones: no async clipboard
    const ta = document.createElement("textarea");
    ta.value = t; ta.style.cssText = "position:fixed;opacity:0"; document.body.appendChild(ta); ta.select();
    try { return document.execCommand("copy"); } catch { return false; } finally { ta.remove(); }
  }
}
function summaryText(d){
  const m = d.malignancy;
  return `Oranosis v1 - malignancy risk ${(100*m.risk).toFixed(1)}% (${m.tier.toUpperCase()})\n` +
    (m.red_flags.length ? "Red flags: " + m.red_flags.map(f => f.flag).join("; ") + "\n" : "") +
    "Differential: " + d.differential.slice(0, 3).map(x => `${x.rank}. ${x.name} (${(100*x.probability).toFixed(0)}%)`).join("; ") +
    `\n${m.advice}\n${d.disclaimer}`;
}
function download(name, text, type){
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], {type})); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* Library, evidence, about */
function renderLib(){
  if (!INFO) return;
  const q = $("lib-q").value.trim().toLowerCase(), cat = $("lib-cat").value;
  const items = INFO.lesions.filter(l => (!cat || l.category === cat) && (!q || (l.name + l.summary + l.discriminators).toLowerCase().includes(q)));
  if (!items.length) {
    $("lib-status").textContent = `No lesion matches "${$("lib-q").value.trim()}"${cat ? " in " + cat : ""}. Clear the search or choose All categories.`;
    $("lib").innerHTML = "";
    return;
  }
  $("lib-status").textContent = `${items.length} of ${INFO.lesions.length} lesions`;
  $("lib").innerHTML = `<table class="rtable"><thead><tr><th>Lesion</th><th>Category</th><th>Summary</th><th>Key differences</th></tr></thead><tbody>${items.map(l =>
    `<tr><td data-label="Lesion"><b>${esc(l.name)}</b>${l.malignant ? ' <span class="badge t-high" style="font-size:11px">malignant</span>' : ""}</td><td data-label="Category"><span class="cat">${esc(l.category)}</span></td>
     <td data-label="Summary">${esc(l.summary)}</td><td data-label="Key differences">${esc(l.discriminators)}<details><summary>${l.references.length} references</summary><ol class="refs">${l.references.map(r => `<li>${esc(r)}</li>`).join("")}</ol></details></td></tr>`).join("")}</tbody></table>`;
}
$("lib-q").oninput = renderLib; $("lib-cat").onchange = renderLib;

function renderPerf(p){
  const dx = p.differential, mal = p.malignancy;
  ["top3","auc","sens","spec"].forEach(k => { if (p.kpis && p.kpis[k]) $("k-" + k).textContent = p.kpis[k]; });
  const row = name => (mal.rows || []).find(r => r.name === name);
  const b = row("≥ Borderline (safety-first)"), hi = row("High (urgent)");
  if (b) $("k-sens-note").textContent = `Share of cancers rated borderline or higher. Specificity at this cut-off: ${b.spec}.`;
  if (hi) $("k-spec-note").textContent = `Share of benign lesions not rated high. Sensitivity at this cut-off: ${hi.sens}.`;
  $("perf-dx").innerHTML = `<table><thead><tr><th>Diagnostician</th><th>Top-1</th><th>Top-3</th></tr></thead><tbody>${dx.map(r =>
    `<tr><td>${r.bold ? "<b>" + esc(r.name) + "</b>" : esc(r.name)}</td><td class="num">${esc(r.top1)}</td><td class="num">${esc(r.top3)}</td></tr>`).join("")}</tbody></table>
    <p class="mute">${esc(p.note || "")}</p>`;
  $("perf-mal").innerHTML = `<p>AUC <b>${esc(mal.auc)}</b></p><table><thead><tr><th>Cut-off</th><th>Sensitivity</th><th>Specificity</th></tr></thead><tbody>${mal.rows.map(r =>
    `<tr><td>${esc(r.name)}</td><td class="num">${esc(r.sens)}</td><td class="num">${esc(r.spec)}</td></tr>`).join("")}</tbody></table>`;
}

const HOW = `<ol>
  <li><b>Knowledge:</b> 36 lesions and 19 red flags from WHO 2022, Neville, Burket and the Mortazavi decision tree.</li>
  <li><b>Literature:</b> 1,623 cases (692 malignant) extracted automatically from 6,226 PubMed case reports.</li>
  <li><b>Local data:</b> 255 biopsy-confirmed lesions (21 malignant), Shahid Beheshti oral medicine.</li>
  <li><b>Model:</b> Bayesian classifier fine-tuned on the cases; malignancy risk from a red-flag-based logistic model. Adding a red flag never lowers the risk.</li>
  <li><b>Validation:</b> nested cross-validation (10-fold × 3), compared with Grok 4.5 and clinicians on the same cases.</li>
  <li><b>This page:</b> the aggregate (public) model only, run locally by a JavaScript port of the engine; it contains no patient-level data. The validation figures shown on this site (top-3 83.8%, AUC 0.953 and the rest) were measured for the full research model; the public model omits the nearest-neighbour step and is about 1.6 points lower in top-1 accuracy (sensitivity analysis).</li></ol>`;
$("howtrained").innerHTML = HOW;

/* Start-up: load model and knowledge, either inlined (offline file) or next to the page. */
async function loadData(){
  const inline = $("oranosis-data");
  if (inline) return { ...JSON.parse(inline.textContent), offline: true };
  const get = u => fetch(u).then(r => { if (!r.ok) throw new Error(u + ": " + r.status); return r.json(); });
  const [model, knowledge] = await Promise.all([get("model.json"), get("knowledge.json")]);
  const [performance, selftest] = await Promise.all([get("performance.json").catch(() => null), get("selftest.json").catch(() => null)]);
  return { model, knowledge, performance, selftest, offline: false };
}

(async () => {
  try {
    const data = await loadData();
    K = data.knowledge;
    ENGINE = new Oranosis(data.model, K);
    INFO = ENGINE.info();
    const m = INFO.meta || {};
    [...new Set(INFO.lesions.map(l => l.category))].sort().forEach(c => $("lib-cat").insertAdjacentHTML("beforeend", `<option>${esc(c)}</option>`));
    renderLib();
    $("model-date").textContent = "model " + (m.trained || "").slice(0, 10);
    $("about").textContent = m.config ? `Risk tiers: borderline ≥ ${(100*m.config.thr_watch).toFixed(0)}%, intermediate ≥ ${(100*m.config.thr_intermediate).toFixed(0)}%, high ≥ ${(100*m.config.thr_high).toFixed(0)}%.` : "";
    $("offline-badge").textContent = data.offline ? "offline file · self-test OK" : "runs offline once loaded · self-test OK";
    if (data.performance) renderPerf(data.performance);
    else {
      const msg = '<p class="warn">The validation figures (performance.json) could not be loaded. The headline figures above come from the published validation report.</p>';
      $("perf-dx").innerHTML = msg; $("perf-mal").innerHTML = msg;
    }
    $("go").disabled = false; $("go").textContent = "Analyse";
    // 24 probe cases answered by the Python reference at build time must give the same answer in this browser.
    const failed = data.selftest ? selfTest(ENGINE, data.selftest) : ["self-test data missing"];
    if (failed.length) {
      $("offline-badge").textContent = "self-test: " + failed.length + " difference(s)";
      document.querySelector(".notice").insertAdjacentHTML("afterend", `<div class="warn" role="alert"><b>This browser does not reproduce the reference results on ${failed.length} of 24 built-in check cases</b> (${esc(failed.slice(0, 3).join("; "))}${failed.length > 3 ? "…" : ""}). Results for unusual (non-Latin) characters may differ from the Python version; ordinary English input is not expected to be affected. Please update your browser or use the Python version.</div>`);
    }
    if (!data.offline && "serviceWorker" in navigator && location.protocol.startsWith("http")) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
    // ?demo=N loads example N and analyses it (for demonstrations and screenshots).
    const demo = new URLSearchParams(location.search).get("demo");
    if (demo !== null) {
      exIdx = Math.max(0, parseInt(demo || "0", 10) || 0);
      $("example").click();
      $("form").requestSubmit();
    }
  } catch (err) {
    $("go").textContent = "Model unavailable";
    $("result").innerHTML = `<div class="warn" role="alert">Could not load the model (${esc(err.message)}). Open the site through its web address, or use the offline file <b>oranosis_offline.html</b>.</div>`;
    $("lib-status").textContent = "The lesion library could not be loaded because the model files are missing.";
    $("model-date").textContent = "model information unavailable";
  }
})();
})();
