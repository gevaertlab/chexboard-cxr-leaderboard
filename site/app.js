/* ──────────────────────────────────────────────────────────────────────────
   Chest X-ray Model Leaderboard — app logic
   Loads the static JSON, holds filter state, aggregates client-side (matching the
   manuscript's equal-weight-per-task method), and renders the table + drives the
   Plotly charts in charts.js. No build step, no server.
   ────────────────────────────────────────────────────────────────────────── */
"use strict";

/* ── site config ───────────────────────────────────────────────────────────
   The only place that knows about the outside world. Update `paper` (and drop
   `paperNote`) when the article is published; update the two GitHub URLs if the
   repositories move to another owner. Everything else on the page is derived
   from data/meta.json. */
const SITE = {
  repo:      "https://github.com/gevaertlab/chexboard-cxr-leaderboard",
  // The evaluation-code repository is not public yet, so the Code link stays off
  // until it is; the nav/footer builders drop it and show codeNote instead.
  code:      null,
  codeNote:  "Evaluation code released with the article",
  paper:     "https://arxiv.org/abs/2505.16027",     // unversioned: follows the latest arXiv version
  paperNote: "Preprint in preparation",
  lab:       "https://med.stanford.edu/gevaertlab.html",
};

const App = {
  meta: null,
  rows: [],            // array of row objects (decoded from columnar JSON)
  modelOrder: [],      // canonical model order (from meta) for stable colours
  state: {
    metric: "auroc",
    stratum: "overall",
    agg: "task",
    tab: "table",
    sort: { key: "value", dir: -1 },
    sel: {},           // facet -> Set of *excluded* keys (empty = all selected)
    scheme: "anatomy",
    cmpA: null, cmpB: null,
    hmAxis: "dataset", bdScheme: "anatomy",
  },
};

// ── small helpers ──────────────────────────────────────────────────────────
const $  = (s) => document.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const fmt = (v, d = 3) => (v == null || Number.isNaN(v)) ? "—" : v.toFixed(d);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const std  = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const uniq = (a) => [...new Set(a)];
// declared up here (not with the other chrome helpers) so the boot failure path,
// which can fire before the rest of the file has evaluated, can always reach it
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ── load ───────────────────────────────────────────────────────────────────
const getJson = (path) => fetch(path).then((r) => {
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
});

// the two JSON files are the whole app; if either fails there is nothing to show,
// so say what broke instead of leaving a blank page
let booted = false;
function bootFailed(err) {
  const box = $("#boot");
  if (!box || box.classList.contains("failed")) return;
  box.classList.remove("hidden");
  box.classList.add("failed");
  const local = location.protocol === "file:";
  $("#boot-msg").innerHTML = local
    ? `This page was opened directly from disk, so the browser blocked loading its data files. ` +
      `Serve the folder over HTTP instead — e.g. <code>python -m http.server 8731</code> in the ` +
      `site directory, then open <code>http://localhost:8731</code>.`
    : `Something went wrong loading the leaderboard (${esc(err.message || err)}). ` +
      `Reload the page; if it keeps failing, please <a href="${SITE.repo}/issues">open an issue</a>.`;
  console.error(err);
}

async function boot() {
  let meta, lb;
  try {
    [meta, lb] = await Promise.all([getJson("data/meta.json"), getJson("data/leaderboard.json")]);
  } catch (err) { bootFailed(err); return; }
  App.meta = meta;
  // tolerate both strata shapes: legacy ["overall",...] and ["{key,label}",...]
  App.meta.strata = meta.strata.map((s) => typeof s === "string"
    ? { key: s, label: s[0].toUpperCase() + s.slice(1) } : s);
  if (!App.meta.strata.some((s) => s.key === App.state.stratum)) App.state.stratum = App.meta.strata[0].key;
  App.modelOrder = meta.models.map((m) => m.key);
  // decode columnar -> row objects
  const c = lb.data, n = lb.n_rows, cols = lb.columns;
  App.rows = new Array(n);
  for (let i = 0; i < n; i++) { const o = {}; for (const k of cols) o[k] = c[k][i]; App.rows[i] = o; }

  initSelections();
  readHash();
  buildControls();
  buildCompareSelects();
  bindTabs();
  buildNav();
  buildAbout();
  buildFooter();
  // reveal before the first render: Plotly sizes charts from the live container,
  // and a chart laid out inside a display:none parent comes back at default width
  $("#boot").classList.add("hidden");
  $("#layout").classList.remove("hidden");
  render();
  booted = true;
}

// anything that throws before the first successful render would otherwise leave
// the spinner turning with no explanation
window.addEventListener("error", (e) => { if (!booted) bootFailed(e.error || e); });

// selection state: a Set per facet listing EXCLUDED keys (so default = all on)
function initSelections() {
  for (const f of ["models", "regions", "datasets", "tasks", "categories"]) App.state.sel[f] = new Set();
}

// the distinct keys available for each facet (in display order)
function facetKeys(facet) {
  const m = App.meta;
  if (facet === "models")   return m.models.map((x) => x.key);
  if (facet === "regions")  return m.regions;
  if (facet === "datasets") return m.datasets.map((x) => x.name);
  if (facet === "categories") return m.category_schemes[App.state.scheme].order;
  if (facet === "tasks")    return uniq(App.rows.map((r) => r.task)).sort();
  return [];
}
const isOn = (facet, key) => !App.state.sel[facet].has(key);
function toggle(facet, key) {
  const s = App.state.sel[facet];
  s.has(key) ? s.delete(key) : s.add(key);
}

// ── filtering ───────────────────────────────────────────────────────────────
// rows that pass every facet for the current metric + stratum
function filtered() {
  const st = App.state;
  const catField = st.scheme;                 // anatomy | extent | prevalence
  const selModels = st.sel.models, selReg = st.sel.regions, selDs = st.sel.datasets,
        selTask = st.sel.tasks, selCat = st.sel.categories;
  const out = [];
  for (const r of App.rows) {
    if (r.metric !== st.metric || r.stratum !== st.stratum) continue;
    if (selModels.has(r.model)) continue;
    if (selReg.has(r.region)) continue;
    if (selDs.has(r.dataset)) continue;
    if (selTask.has(r.task)) continue;
    if (selCat.has(r[catField])) continue;
    out.push(r);
  }
  return out;
}

// ── aggregation (equal-weight-per-unit, matching the manuscript) ────────────
// mode 'task'  -> unit = finding (pathology, matches manuscript);  'dataset' -> cohort;  'simple' -> raw cells
// CI: across-unit spread (mean ± 1.96·SE) when ≥2 units (the manuscript method).
// With a single unit that spread is 0, which would collapse the CI onto the point
// estimate; we then fall back to the contributing cells' own bootstrap CIs so a
// filtered-down view still shows real uncertainty.
function aggregateModels(rows, mode = App.state.agg) {
  const unitField = mode === "task" ? "pathology" : mode === "dataset" ? "dataset" : null;
  const byModel = new Map();
  for (const r of rows) {
    if (!byModel.has(r.model)) byModel.set(r.model, { units: new Map(), cells: [] });
    const e = byModel.get(r.model);
    const u = unitField ? r[unitField] : e.cells.length; // simple: every row its own unit
    if (!e.units.has(u)) e.units.set(u, []);
    e.units.get(u).push(r.value);
    e.cells.push(r);
  }
  const res = [];
  for (const [model, e] of byModel) {
    const unitMeans = [...e.units.values()].map(mean);
    const m = mean(unitMeans), s = std(unitMeans), se = s / Math.sqrt(unitMeans.length);
    let ci_low, ci_high, ciSource;
    if (unitMeans.length >= 2) {
      ci_low = clamp(m - 1.96 * se, 0, 1); ci_high = clamp(m + 1.96 * se, 0, 1); ciSource = "across-unit";
    } else {                                   // single unit -> use per-cell bootstrap CIs
      const los = e.cells.map((c) => c.ci_low).filter((v) => v != null);
      const his = e.cells.map((c) => c.ci_high).filter((v) => v != null);
      ci_low = los.length ? clamp(mean(los), 0, 1) : m;
      ci_high = his.length ? clamp(mean(his), 0, 1) : m;
      ciSource = los.length ? "bootstrap" : "none";
    }
    res.push({ model, mean: m, ci_low, ci_high, ciSource, n_units: unitMeans.length, n_cells: e.cells.length });
  }
  res.sort((a, b) => b.mean - a.mean);
  return res;
}

// equal-weight (by finding = pathology) mean of a row-set -> single value, for matrix cells
function cellValue(rows) {
  if (!rows.length) return null;
  const byTask = new Map();
  for (const r of rows) { if (!byTask.has(r.pathology)) byTask.set(r.pathology, []); byTask.get(r.pathology).push(r.value); }
  return mean([...byTask.values()].map(mean));
}

// ── render orchestration ─────────────────────────────────────────────────────
function render() {
  writeHash();
  const rows = filtered();
  updateViewCaption(rows);
  refreshChips();
  const tab = App.state.tab;
  if (tab === "table")     renderTable(rows);
  if (tab === "ranking")   Charts.ranking($("#chart-ranking"), aggregateModels(rows), App);
  if (tab === "heatmap")   Charts.heatmap($("#chart-heatmap"), rows, App.state.hmAxis, App);
  if (tab === "compare")   Charts.compare($("#chart-compare"), rows, App.state.cmpA, App.state.cmpB, App);
  if (tab === "breakdown") Charts.breakdown($("#chart-breakdown"), rows, App.state.bdScheme, App);
  renderFootnote(rows);
}

function metricMeta(key) { return App.meta.metrics.find((m) => m.key === key); }
function modelMeta(key)  { return App.meta.models.find((m) => m.key === key); }

function updateViewCaption(rows) {
  const mm = metricMeta(App.state.metric);
  const nMod = uniq(rows.map((r) => r.model)).length;
  const nDs  = uniq(rows.map((r) => r.dataset)).length;
  const nTask = uniq(rows.map((r) => r.task)).length;
  const aggLbl = { task: "equal-weight per finding", dataset: "equal-weight per dataset", simple: "mean of all cells" }[App.state.agg];
  const stratLbl = (App.meta.strata.find((s) => s.key === App.state.stratum) || {}).label || App.state.stratum;
  $("#viewcap").innerHTML =
    `<b>${esc(mm.label)}</b> · ${esc(stratLbl)} · ${esc(aggLbl)} · ` +
    `${nMod} models × ${nDs} datasets × ${nTask} findings · ${rows.length.toLocaleString()} cells`;
}

// ── leaderboard table ────────────────────────────────────────────────────────
function renderTable(rows) {
  const agg = aggregateModels(rows);
  const t = $("#lb-table");
  t.innerHTML = "";
  if (!agg.length) { t.innerHTML = `<tbody><tr><td><div class="empty">No data for this selection.</div></td></tr></tbody>`; return; }

  // sort
  const { key, dir } = App.state.sort;
  agg.sort((a, b) => {
    let va, vb;
    if (key === "model") { va = a.model; vb = b.model; return dir * String(va).localeCompare(String(vb)); }
    va = a[key]; vb = b[key]; return dir * ((va ?? -1) - (vb ?? -1));
  });
  const maxv = Math.max(...agg.map((a) => a.ci_high || a.mean));
  const mm = metricMeta(App.state.metric);

  const cols = [
    { k: "rank",   t: "#",      num: false },
    { k: "model",  t: "Model",  num: false },
    { k: "value",  t: mm.short, num: true },
    { k: "ci",     t: "95% CI", num: true, nosort: true },
    { k: "bar",    t: "",       num: false, nosort: true },
    { k: "n_units",t: App.state.agg === "task" ? "findings" : App.state.agg === "dataset" ? "datasets" : "cells", num: true },
  ];
  const thead = el("thead");
  const htr = el("tr");
  for (const c of cols) {
    const th = el("th", c.num ? "num" : "");
    th.textContent = c.t;
    if (!c.nosort && c.k !== "rank" && c.k !== "bar") {
      // the button carries the click and keyboard focus; aria-sort tells screen readers the state
      const active = App.state.sort.key === c.k;
      th.setAttribute("aria-sort", active ? (dir < 0 ? "descending" : "ascending") : "none");
      const sb = el("button", "th-sort");
      sb.type = "button";
      sb.textContent = c.t;
      if (active) sb.innerHTML += ` <span class="arr">${dir < 0 ? "▼" : "▲"}</span>`;
      th.textContent = ""; th.appendChild(sb);
      sb.onclick = () => { const s = App.state.sort; if (s.key === c.k) s.dir *= -1; else { s.key = c.k; s.dir = c.k === "model" ? 1 : -1; } render(); };
    }
    htr.appendChild(th);
  }
  thead.appendChild(htr); t.appendChild(thead);

  const tb = el("tbody");
  agg.forEach((a, i) => {
    const mt = modelMeta(a.model);
    const tr = el("tr");
    tr.appendChild(el("td", "rank", String(i + 1)));
    const mc = el("td");
    mc.innerHTML = `<div class="model-cell"><span class="dot" style="background:${mt.color}"></span>` +
      `<span class="nm">${esc(mt.official)}</span><span class="ty">${esc(mt.type)}</span></div>`;
    tr.appendChild(mc);
    tr.appendChild(el("td", "num", `<b>${fmt(a.mean)}</b>`));
    tr.appendChild(el("td", "num ci", `${fmt(a.ci_low)}–${fmt(a.ci_high)}`));
    const bar = el("td", "bar-cell");
    const pct = (a.mean / maxv) * 100, lo = (a.ci_low / maxv) * 100, hi = (a.ci_high / maxv) * 100;
    bar.innerHTML = `<div class="bar-track">` +
      `<div class="bar-fill" style="left:${lo}%;width:${hi - lo}%;background:${mt.color};opacity:.25"></div>` +
      `<div class="bar-fill" style="left:0;width:${pct}%;background:${mt.color};opacity:.85;height:7px"></div>` +
      `</div>`;
    tr.appendChild(bar);
    tr.appendChild(el("td", "num", String(a.n_units)));
    tb.appendChild(tr);
  });
  t.appendChild(tb);
}

// ── controls ─────────────────────────────────────────────────────────────────
function buildControls() {
  // brand counts
  const bm = $("#brand-meta");
  bm.innerHTML =
    `<div class="stat"><b>${App.meta.models.length}</b><span>models</span></div>` +
    `<div class="stat"><b>${App.meta.datasets.length}</b><span>cohorts</span></div>` +
    `<div class="stat"><b>${uniq(App.rows.map((r)=>r.task)).length}</b><span>findings</span></div>` +
    `<div class="stat"><b>${App.meta.regions.length}</b><span>regions</span></div>`;

  // metric segmented
  segmented("#metric-seg", App.meta.metrics.map((m) => ({ k: m.key, t: m.short })), App.state.metric, (k) => { App.state.metric = k; syncMetricDesc(); guardCompareModels(); render(); });
  syncMetricDesc();
  // stratum (Overall + coarse age bands)
  segmented("#stratum-seg", App.meta.strata.map((s) => ({ k: s.key, t: s.label })), App.state.stratum, (k) => { App.state.stratum = k; render(); });
  // aggregation
  segmented("#agg-seg", [{ k: "task", t: "Per finding" }, { k: "dataset", t: "Per dataset" }, { k: "simple", t: "All cells" }], App.state.agg, (k) => { App.state.agg = k; render(); });
  // scheme
  segmented("#scheme-seg", Object.entries(App.meta.category_schemes).map(([k, v]) => ({ k, t: v.label.split(" ")[0] })), App.state.scheme, (k) => { App.state.scheme = k; App.state.sel.categories = new Set(); render(); });

  // chips
  ["models", "regions", "datasets"].forEach(renderChips);
  renderTaskChips();

  // mini all/none
  document.querySelectorAll(".mini").forEach((b) => {
    const grp = b.dataset.all || b.dataset.none;
    b.setAttribute("aria-label", `${b.hasAttribute("data-all") ? "Select all" : "Deselect all"} ${grp === "tasks" ? "findings" : grp}`);
    b.onclick = () => {
      const f = b.dataset.all || b.dataset.none;
      const all = b.hasAttribute("data-all") ? false : true; // data-all => select all => empty exclude set
      App.state.sel[f] = all ? new Set(facetKeys(f)) : new Set();
      render();
    };
  });
  // scope quick-toggles: turn every dataset of a scope on (or off if all already on)
  document.querySelectorAll(".scope-btn").forEach((b) => {
    b.onclick = () => {
      const scope = b.dataset.scope;
      const names = App.meta.datasets.filter((d) => d.scope === scope).map((d) => d.name);
      const allOn = names.every((n) => isOn("datasets", n));
      names.forEach((n) => { if (allOn) App.state.sel.datasets.add(n); else App.state.sel.datasets.delete(n); });
      render();
    };
  });

  $("#reset-btn").onclick = () => { initSelections(); App.state.scheme = "anatomy"; render(); };
  $("#task-search").oninput = (e) => renderTaskChips(e.target.value.toLowerCase());

  // panel sub-controls
  $("#heatmap-axis").value = App.state.hmAxis;
  $("#heatmap-axis").onchange = (e) => { App.state.hmAxis = e.target.value; render(); };
  $("#bd-scheme").value = App.state.bdScheme;
  $("#bd-scheme").onchange = (e) => { App.state.bdScheme = e.target.value; render(); };
  $("#export-csv").onclick = exportCsv;
}

function syncMetricDesc() {
  const mm = metricMeta(App.state.metric);
  let d = mm.desc;
  if (mm.range && (mm.key === "auroc")) d += " Color scale 0.5–1.0.";
  $("#metric-desc").textContent = d;
}

function segmented(sel, items, current, cb) {
  const box = $(sel); box.innerHTML = "";
  items.forEach((it) => {
    const b = el("button", it.k === current ? "on" : "", it.t);
    b.type = "button";
    b.setAttribute("aria-pressed", it.k === current ? "true" : "false");
    b.onclick = () => { box.querySelectorAll("button").forEach((x) => { x.classList.remove("on"); x.setAttribute("aria-pressed", "false"); }); b.classList.add("on"); b.setAttribute("aria-pressed", "true"); cb(it.k); };
    box.appendChild(b);
  });
}

// chips are toggle buttons so they take keyboard focus; data-facet/data-key let render() restore focus
function mkChip(facet, key, on, html) {
  const chip = el("button", "chip" + (on ? " on" : " off"), html);
  chip.type = "button";
  chip.setAttribute("aria-pressed", on ? "true" : "false");
  chip.dataset.facet = facet; chip.dataset.key = key;
  chip.onclick = () => { toggle(facet, key); render(); };
  return chip;
}

function renderChips(facet) {
  const box = $(`#${facet}-chips`); box.innerHTML = "";
  const keys = facetKeys(facet);
  keys.forEach((key) => {
    const on = isOn(facet, key);
    const chip = mkChip(facet, key, on);
    if (facet === "models") {
      const mt = modelMeta(key);
      chip.innerHTML = `<span class="dot" style="background:${on ? mt.color : ""}"></span>${esc(mt.official)}<span class="tag">${esc(mt.type)}</span>`;
    } else if (facet === "datasets") {
      const dt = App.meta.datasets.find((d) => d.name === key);
      const cls = dt.scope === "Public" ? "pub" : "priv";
      chip.innerHTML = `${esc(key)}<span class="tag ${cls}">${dt.scope === "Public" ? "Pub" : "Priv"}</span>`;
    } else {
      chip.textContent = key;
    }
    box.appendChild(chip);
  });
}

function renderTaskChips(query = "") {
  // these boxes are rebuilt on every render, which would drop keyboard focus, so remember the focused chip
  const ae = document.activeElement;
  const focused = ae && ae.classList && ae.classList.contains("chip") && ae.closest("#categories-chips, #tasks-chips")
    ? { facet: ae.dataset.facet, key: ae.dataset.key } : null;
  // categories chips (scheme) live in their own box
  const cbox = $("#categories-chips"); cbox.innerHTML = "";
  facetKeys("categories").forEach((key) => {
    const on = isOn("categories", key);
    cbox.appendChild(mkChip("categories", key, on, esc(key)));
  });
  // findings chips
  const box = $("#tasks-chips"); box.innerHTML = "";
  facetKeys("tasks").filter((k) => k.toLowerCase().includes(query)).forEach((key) => {
    const on = isOn("tasks", key);
    box.appendChild(mkChip("tasks", key, on, esc(key)));
  });
  if (focused) {
    const nc = [...document.querySelectorAll("#categories-chips .chip, #tasks-chips .chip")]
      .find((c) => c.dataset.facet === focused.facet && c.dataset.key === focused.key);
    if (nc) nc.focus();
  }
}

// keep chip on/off classes in sync after non-chip actions
function refreshChips() {
  ["models", "regions", "datasets"].forEach((f) => {
    $(`#${f}-chips`).querySelectorAll(".chip").forEach((chip, i) => {
      const key = facetKeys(f)[i];
      chip.classList.toggle("on", isOn(f, key));
      chip.classList.toggle("off", !isOn(f, key));
      chip.setAttribute("aria-pressed", isOn(f, key) ? "true" : "false");
      if (f === "models") { const mt = modelMeta(key); chip.querySelector(".dot").style.background = isOn(f, key) ? mt.color : ""; }
    });
  });
  renderTaskChips($("#task-search").value.toLowerCase());
  // reflect scope-toggle active state (all datasets of that scope currently on)
  document.querySelectorAll(".scope-btn").forEach((b) => {
    const names = App.meta.datasets.filter((d) => d.scope === b.dataset.scope).map((d) => d.name);
    b.classList.toggle("on", names.length > 0 && names.every((n) => isOn("datasets", n)));
  });
}

function buildCompareSelects() {
  const opts = App.meta.models.map((m) => `<option value="${esc(m.key)}">${esc(m.official)}</option>`).join("");
  $("#cmp-a").innerHTML = opts; $("#cmp-b").innerHTML = opts;
  App.state.cmpA = App.state.cmpA || App.meta.models[0].key;
  App.state.cmpB = App.state.cmpB || App.meta.models[1].key;
  $("#cmp-a").value = App.state.cmpA; $("#cmp-b").value = App.state.cmpB;
  $("#cmp-a").onchange = (e) => { App.state.cmpA = e.target.value; render(); };
  $("#cmp-b").onchange = (e) => { App.state.cmpB = e.target.value; render(); };
}
// binary model has no auroc/auprc — nudge compare selects off it for those metrics
function guardCompareModels() {}

// keep aria-selected and the roving tabindex in step with the .active class
function syncTabs() {
  document.querySelectorAll(".tab").forEach((x) => {
    const on = x.classList.contains("active");
    x.setAttribute("aria-selected", on ? "true" : "false");
    x.tabIndex = on ? 0 : -1;
  });
}

function bindTabs() {
  const tabs = [...document.querySelectorAll(".tab")];
  $("#tabs").addEventListener("keydown", (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const j = { ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 }[e.key];
    if (j == null) return;
    e.preventDefault();
    tabs[j].click(); tabs[j].focus();
  });
  tabs.forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      syncTabs();
      App.state.tab = b.dataset.tab;
      document.querySelectorAll(".panel").forEach((p) => p.classList.add("hidden"));
      $(`#panel-${App.state.tab}`).classList.remove("hidden");
      render();
    };
  });
}

function renderFootnote(rows) {
  const mm = metricMeta(App.state.metric);
  const binaries = App.meta.models.filter((m) => m.is_binary).map((m) => m.official);
  const unit = { task: "findings", dataset: "datasets", simple: "cells" }[App.state.agg];
  let note = `Each cohort × finding value carries a bootstrap 95% CI (test-set sampling variability, single inference pass). ` +
    `An aggregate's 95% CI is mean ± 1.96·SE across the averaged ${unit}; when only one remains, the cells' own bootstrap CIs are shown instead. `;
  if (["auroc", "auprc", "sens_at_95spec", "spec_at_95sens", "ppv_at_95sens", "npv_at_95sens"].includes(mm.key) && binaries.length)
    note += binaries.length === 1
      ? `${binaries[0]} produces binary output only and is excluded from probability-based metrics. `
      : `${binaries.join(", ")} produce binary output only and are excluded from probability-based metrics. `;
  if (App.state.stratum !== "overall")
    note += `Age-band views include only cohorts with per-image ages, so fewer datasets and findings contribute than in the Overall view. `;
  // models cover different findings, so a rank compares averages over different sets
  const counts = aggregateModels(rows).map((a) => a.n_units);
  if (counts.length > 1 && Math.min(...counts) !== Math.max(...counts))
    note += `Models here are averaged over different numbers of ${unit} (${Math.min(...counts)}–${Math.max(...counts)}), ` +
      `so a higher rank does not mean better performance on the same ${unit}; use the Findings filter or the Compare tab for a matched comparison. `;
  note += App.state.agg === "task"
    ? `Aggregation reproduces the manuscript's equal-weight-per-finding method. `
    : `This aggregation is an alternative view; the manuscript reports equal weight per finding. `;
  note += `Private cohorts: ${App.meta.datasets.filter((d)=>d.scope==="Private").map((d)=>d.name).join(", ")}.`;
  $("#footnote").textContent = note;
}

// ── nav / about / footer (chrome around the app) ──────────────────────────────
const extLink = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${esc(text)}</a>`;

// arXiv preprint citation; no venue is named until the article is published.
// String.raw keeps the LaTeX accent escapes ({\"u}, {\'c}) intact.
const BIBTEX = String.raw`@misc{xu2025benchmarking,
  title         = {Benchmarking Classification Tasks of Chest X-ray {AI} Across Multinational
                   Public and Private Datasets: a retrospective diagnostic accuracy study},
  author        = {Xu, Qinmei and Li, Yiheng and Zhao, Wenya and Zhao, Zihao
                   and Xu, Chuanjun and Er, Ahmet Gorkem and Zhan, Xianghao
                   and Dashevsky, Brittany and Alawad, Mohammed and von der St{\"u}ck, Marc
                   and Gazibari{\'c}, Marvin and Truhn, Daniel and Shibata, Shunsuke
                   and Horino, Ryosuke and Ito, Mio and Hiwatashi, Akio and Li, Suyu
                   and Yang, Mengya and Liu, Ya and Sun, Zhiyuan and Zhou, Changsheng
                   and Itakura, Haruka and Li, Xiao and Gevaert, Olivier},
  year          = {2025},
  eprint        = {2505.16027},
  archivePrefix = {arXiv},
  primaryClass  = {eess.IV},
  doi           = {10.48550/arXiv.2505.16027},
  url           = {https://arxiv.org/abs/2505.16027}
}`;

function openAbout() {
  const d = $("#about");
  d.open = true;
  d.scrollIntoView({ behavior: "smooth", block: "start" });
  // move focus too, or keyboard users stay on the nav button; preventScroll keeps the smooth scroll
  d.querySelector("summary").focus({ preventScroll: true });
}

function buildNav() {
  const nav = $("#topnav");
  nav.innerHTML = `<button type="button" id="nav-about">About &amp; methods</button>` +
    (SITE.paper ? extLink(SITE.paper, "Paper") : "") +
    (SITE.code ? extLink(SITE.code, "Code") : "") +
    extLink(SITE.repo, "GitHub");
  $("#nav-about").onclick = openAbout;
}

function buildAbout() {
  const m = App.meta;

  $("#about-models").innerHTML = m.models.map((x) =>
    `<div class="about-item model"><span class="dot" style="background:${x.color}"></span>` +
    `<span class="nm">${esc(x.official)}</span><span class="ty">${esc(x.type)}</span>` +
    `<span class="cit">${esc(x.citation)}</span></div>`).join("");

  const dsSorted = [...m.datasets].sort((a, b) =>
    a.scope === b.scope ? a.name.localeCompare(b.name) : (a.scope === "Public" ? -1 : 1));
  $("#about-datasets").innerHTML = dsSorted.map((d) =>
    `<div class="about-item"><span class="nm">${esc(d.name)}</span>` +
    `<span class="sub">${esc(d.scope)} · ${esc(d.country)} · n=${d.n.toLocaleString()}</span></div>`).join("");

  $("#about-metrics").innerHTML = m.metrics.map((x) =>
    `<dt>${esc(x.short)}</dt><dd>${esc(x.desc)}</dd>`).join("");

  const binaries = m.models.filter((x) => x.is_binary).map((x) => x.official);
  if (binaries.length) $("#about-binary").textContent = binaries.join(", ");

  const pv = m.provenance || {};
  const src = pv.source || {};
  const rows = [
    ["Source table", esc(src.path || "—")],
    ["Source sha1", `<code>${esc(src.sha1 || "—")}</code>`],
    ["Pipeline rev", `<code>${esc(pv.git_rev || "—")}</code>`],
    ["Rows", (pv.n_rows || App.rows.length).toLocaleString()],
    ["Built", esc((pv.built_at || "—").replace("T", " ").replace("+00:00", " UTC"))],
  ];
  $("#about-prov").innerHTML = rows.map(([k, v]) => `<li><span>${k}</span>${v}</li>`).join("");

  $("#cite-bibtex").textContent = BIBTEX;
  const btn = $("#copy-bibtex");
  btn.onclick = async () => {
    try { await navigator.clipboard.writeText(BIBTEX); btn.textContent = "Copied"; }
    catch { btn.textContent = "Press ⌘/Ctrl+C"; window.getSelection().selectAllChildren($("#cite-bibtex")); }
    setTimeout(() => { btn.textContent = "Copy BibTeX"; }, 2000);
  };
}

function buildFooter() {
  const links = [
    SITE.paper ? extLink(SITE.paper, "Paper") : `<span class="tiny">${esc(SITE.paperNote)}</span>`,
    SITE.code ? extLink(SITE.code, "Evaluation code") : `<span class="tiny">${esc(SITE.codeNote)}</span>`,
    extLink(SITE.repo, "This site's repository"),
    extLink(SITE.repo + "/issues", "Report an error"),
    `<a href="#" id="foot-about">About &amp; methods</a>`,
  ];
  $("#foot-links").innerHTML = links.map((l) => `<li>${l}</li>`).join("");
  $("#foot-about").onclick = (e) => { e.preventDefault(); openAbout(); };

  const pv = App.meta.provenance || {};
  const built = (pv.built_at || "").slice(0, 10);
  $("#foot-version").innerHTML =
    `${built ? `built ${esc(built)}` : "build date unknown"}<br>` +
    `pipeline ${esc(pv.git_rev || "—")}<br>` +
    `${(pv.n_rows || App.rows.length).toLocaleString()} result cells`;
}

// ── export + url state ────────────────────────────────────────────────────────
function exportCsv() {
  const agg = aggregateModels(filtered());
  const mm = metricMeta(App.state.metric);
  const head = ["rank", "model", "type", mm.short, "ci_low", "ci_high", "n_units"];
  // RFC 4180 quoting; a leading = + - @ is prefixed with ' so a spreadsheet reads
  // the field as text instead of a formula
  const q = (v) => {
    let s = String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [head.map(q).join(",")];
  agg.forEach((a, i) => {
    const mt = modelMeta(a.model);
    lines.push([i + 1, mt.official, mt.type, fmt(a.mean, 4), fmt(a.ci_low, 4), fmt(a.ci_high, 4), a.n_units].map(q).join(","));
  });
  const blob = new Blob([lines.join("\r\n") + "\r\n"], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = el("a"); a.href = url; a.download = `leaderboard_${App.state.metric}_${App.state.stratum}.csv`;
  // attached and revoked a beat later: some Safari builds drop a download whose
  // anchor is detached or whose blob URL is revoked in the same tick
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function writeHash() {
  const s = App.state;
  const p = new URLSearchParams();
  p.set("m", s.metric); p.set("p", s.stratum); p.set("a", s.agg); p.set("t", s.tab);
  for (const f of ["models", "regions", "datasets", "tasks", "categories"])
    if (s.sel[f].size) p.set("x_" + f, [...s.sel[f]].join("~"));
  if (s.scheme !== "anatomy") p.set("sc", s.scheme);
  history.replaceState(null, "", "#" + p.toString());
}
function readHash() {
  if (!location.hash) return;
  const p = new URLSearchParams(location.hash.slice(1));
  const s = App.state, m = App.meta;
  // a shared link is untrusted input: take a value only if it names something that
  // exists, otherwise keep the default (an unknown key would throw or reach the DOM)
  const pick = (name, allowed, cur) => { const v = p.get(name); return v != null && allowed.includes(v) ? v : cur; };
  s.metric = pick("m", m.metrics.map((x) => x.key), s.metric);
  s.stratum = pick("p", m.strata.map((x) => x.key), s.stratum);
  s.agg = pick("a", ["task", "dataset", "simple"], s.agg);
  s.tab = pick("t", [...document.querySelectorAll(".tab")].map((b) => b.dataset.tab), s.tab);
  s.scheme = pick("sc", Object.keys(m.category_schemes), s.scheme);
  for (const f of ["models", "regions", "datasets", "tasks", "categories"])
    if (p.get("x_" + f)) s.sel[f] = new Set(p.get("x_" + f).split("~"));
  // reflect tab
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === s.tab));
  syncTabs();
  document.querySelectorAll(".panel").forEach((pn) => pn.classList.toggle("hidden", pn.id !== `panel-${s.tab}`));
}

// writeHash uses replaceState, which never fires hashchange, so this only runs when
// the visitor edits the URL or pastes a shared link into an open tab. Reloading
// rebuilds every control from the new hash; the JSON comes back from cache.
window.addEventListener("hashchange", () => location.reload());

// .catch covers anything thrown after the fetch (a data shape the UI cannot build
// from); the window listener above covers synchronous errors outside boot()
boot().catch(bootFailed);
