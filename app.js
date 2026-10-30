"use strict";

// Data contract: data/v2/meta.json describes the row layout; see
// pipeline/publish/export.py. Rows are positional arrays, "dict" fields index
// into lookups[table], "dict_list" fields hold lists of such indexes.
const DATA = "data/v2/";
const PAGE = 50;
const TECH = "tech";
const ALL = "all";

const S = {
  meta: null, lk: null, ins: null, cfg: {},
  details: new Map(), // bucket -> Promise<{id: summary}>
  F: {},             // field name -> column index
  rows: [], text: [], // loaded rows and their lowercase search text
  loaded: new Set(),
  partial: false,     // true while only latest.json is loaded
  loadChain: Promise.resolve(),
  filtered: [], shown: 0,
};

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString("en-US");
// Lowercase without accents, so "video" finds "Vídeo" and "sao paulo" finds "São Paulo".
const fold = (text) => String(text).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function pretty(key) {
  if (!key) return "";
  const s = String(key).replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const label = {
  region: (k) => S.lk.region_labels[k] || pretty(k),
  country: (k) => S.lk.country_names[k] || k,
  role: (k) => S.lk.category_labels[k] || pretty(k),
};

async function getJSON(path) {
  const res = await fetch(DATA + path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
function addRows(rows) {
  const F = S.F, company = S.lk.company, location = S.lk.location;
  for (const row of rows) {
    S.rows.push(row);
    S.text.push(fold(`${row[F.title]} ${company[row[F.company]]} ${location[row[F.location]]}`));
  }
}

// Loads are chained so overlapping filter changes never load a shard twice.
function ensureShards(keys) {
  S.loadChain = S.loadChain.then(async () => {
    const missing = keys.filter((k) => !S.loaded.has(k));
    if (!missing.length) return;
    if (!S.partial) $("count").textContent = "Loading jobs…";
    const shards = await Promise.all(
      missing.map((k) => getJSON(S.meta.shards.find((s) => s.key === k).file)),
    );
    if (S.partial) { // swap the preview rows for the real shards
      S.rows = []; S.text = []; S.partial = false;
    }
    shards.forEach((shard, i) => { addRows(shard.rows); S.loaded.add(missing[i]); });
  });
  return S.loadChain;
}

function shardsFor(role) {
  const keys = S.meta.shards.map((s) => s.key);
  if (role === ALL) return keys;
  if (role === TECH) return S.meta.shards.filter((s) => s.tech).map((s) => s.key);
  return [role];
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------
const CONTROLS = {
  q: "q", role: "f-role", region: "f-region", country: "f-country", wp: "f-workplace",
  sen: "f-seniority", posted: "f-posted", skill: "f-skill", sort: "f-sort",
};
const CHECKS = { sal: "f-salary", visa: "f-visa" };

function readState() {
  const st = {};
  for (const [k, id] of Object.entries(CONTROLS)) st[k] = $(id).value.trim();
  for (const [k, id] of Object.entries(CHECKS)) st[k] = $(id).checked;
  return st;
}

function writeState(st) {
  for (const [k, id] of Object.entries(CONTROLS)) if (k in st) $(id).value = st[k];
  for (const [k, id] of Object.entries(CHECKS)) if (k in st) $(id).checked = Boolean(st[k]);
}

function stateToHash(st) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(st)) {
    if (v === true) p.set(k, "1");
    else if (v && !(k === "role" && v === ALL) && !(k === "sort" && v === "new")) p.set(k, v);
  }
  const s = p.toString();
  history.replaceState(null, "", s ? `#${s}` : location.pathname + location.search);
}

function hashToState() {
  const p = new URLSearchParams(location.hash.slice(1));
  // Every control gets a value, so a link without a filter clears that filter.
  const st = {};
  for (const k of Object.keys(CONTROLS)) st[k] = p.get(k) || "";
  st.role = st.role || ALL;
  st.sort = st.sort || "new";
  for (const k of Object.keys(CHECKS)) st[k] = p.get(k) === "1";
  return st;
}

function option(value, text) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = text;
  return o;
}

function fillSelect(id, anyText, entries) {
  const el = $(id);
  el.replaceChildren(option("", anyText), ...entries.map(([v, t]) => option(v, t)));
}

function buildControls() {
  const lk = S.lk, meta = S.meta;
  const techCount = meta.shards.filter((s) => s.tech).reduce((a, s) => a + s.count, 0);
  const byName = [...meta.shards].sort((a, b) => (a.key === "other") - (b.key === "other") || a.label.localeCompare(b.label));
  $("f-role").replaceChildren(
    option(ALL, `All jobs (${fmt(meta.total_jobs)})`),
    option(TECH, `All tech jobs (${fmt(techCount)})`),
    ...byName.map((s) => option(s.key, `${s.label} (${fmt(s.count)})`)),
  );

  const regionCounts = Object.fromEntries(S.ins.by_region.map((r) => [r.region, r.jobs]));
  fillSelect("f-region", "Anywhere", lk.region.slice(1).map((r) => [r, `${label.region(r)} (${fmt(regionCounts[r] || 0)})`]));
  fillSelect("f-country", "Any country", lk.country.slice(1)
    .map((c) => [c, label.country(c)])
    .sort((a, b) => a[1].localeCompare(b[1])));
  fillSelect("f-workplace", "Any", lk.workplace.slice(1).map((w) => [w, pretty(w)]));
  fillSelect("f-seniority", "Any", lk.seniority.slice(1).map((s) => [s, pretty(s)]));
  $("skill-list").replaceChildren(...lk.skills.slice(1).map((s) => option(s, "")));
}

function compile(st) {
  const lk = S.lk, F = S.F;
  const idx = (table, value) => (value ? lk[table].indexOf(value) : -1);
  const techIdx = new Set(lk.tech_categories.map((c) => lk.category.indexOf(c)));
  const roleIdx = st.role === TECH || st.role === ALL ? -1 : idx("category", st.role);
  const region = idx("region", st.region);
  const country = idx("country", st.country);
  const wp = idx("workplace", st.wp);
  const sen = idx("seniority", st.sen);
  const skill = st.skill ? lk.skills.indexOf(st.skill.toLowerCase()) : -1;
  const terms = fold(st.q).split(/\s+/).filter(Boolean);

  let since = "";
  if (st.posted) {
    const d = new Date(S.meta.generated_at);
    d.setUTCDate(d.getUTCDate() - Number(st.posted));
    since = d.toISOString().slice(0, 10);
  }
  const unknownSkill = Boolean(st.skill) && skill < 0;

  return (row, i) => {
    if (unknownSkill) return false;
    if (st.role === TECH && !techIdx.has(row[F.category])) return false;
    if (roleIdx >= 0 && row[F.category] !== roleIdx) return false;
    if (region >= 0 && row[F.region] !== region) return false;
    if (country >= 0 && row[F.country] !== country) return false;
    if (wp >= 0 && row[F.workplace] !== wp) return false;
    if (sen >= 0 && row[F.seniority] !== sen) return false;
    if (since && (row[F.posted] || row[F.first_seen]) < since) return false;
    if (skill >= 0 && !row[F.skills].includes(skill) && !row[F.preferred_skills].includes(skill)) return false;
    if (st.sal && !row[F.salary_max] && !row[F.salary_min]) return false;
    if (st.visa && !row[F.visa]) return false;
    if (terms.length) {
      const text = S.text[i];
      for (const t of terms) if (!text.includes(t)) return false;
    }
    return true;
  };
}

let applySeq = 0;
async function apply() {
  const seq = ++applySeq;
  const st = readState();
  stateToHash(st);
  const wasPartial = S.partial;
  if (wasPartial) render(st); // instant results from the newest jobs
  await ensureShards(shardsFor(st.role));
  if (seq !== applySeq) return;
  // After the preview, keep as many jobs on screen as the visitor already opened.
  render(st, wasPartial ? S.shown : 0);
}

function render(st, keepShown = 0) {
  const test = compile(st);
  const F = S.F;
  const out = [];
  for (let i = 0; i < S.rows.length; i++) if (test(S.rows[i], i)) out.push(S.rows[i]);

  if (st.sort === "salary") {
    out.sort((a, b) => (b[F.salary_max] || b[F.salary_min] || 0) - (a[F.salary_max] || a[F.salary_min] || 0));
  } else {
    const day = (r) => r[F.posted] || r[F.first_seen];
    out.sort((a, b) => (day(a) < day(b) ? 1 : day(a) > day(b) ? -1 : 0));
  }

  S.filtered = out;
  S.shown = 0;
  $("results").replaceChildren();
  $("count").textContent = S.partial
    ? `${fmt(out.length)} of the newest ${fmt(S.rows.length)} jobs · loading all ${fmt(S.meta.total_jobs)}…`
    : `${fmt(out.length)} job${out.length === 1 ? "" : "s"}`;
  renderMore();
  while (S.shown < Math.min(keepShown, out.length)) renderMore();
  if (!out.length) {
    sideId = "";
    $("side-job").innerHTML = `<p class="muted">No job selected.</p>`;
  } else if (!out.some((r) => r[F.id] === sideId)) {
    sideId = "";
    showSide(out[0][F.id]);
  } else {
    document.querySelector(`.job[data-id="${CSS.escape(sideId)}"]`)?.classList.add("active");
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
function ago(day) {
  if (!day) return "";
  const ref = new Date(S.meta.generated_at.slice(0, 10) + "T00:00:00Z");
  const days = Math.round((ref - new Date(day + "T00:00:00Z")) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 31) return `${days} days ago`;
  return day;
}

function money(min, max, currency) {
  const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  if (!min && !max) return "";
  const range = min && max && min !== max ? `${k(min)}–${k(max)}` : k(max || min);
  return `${currency || ""} ${range}/yr`.trim();
}

function safeLink(url) {
  return /^https?:\/\//i.test(url) ? url : "#";
}

function jobHTML(row) {
  const F = S.F, lk = S.lk;
  const skills = row[F.skills].slice(0, 8).map((s) => lk.skills[s]);
  const wp = lk.workplace[row[F.workplace]];
  const sen = lk.seniority[row[F.seniority]];
  const emp = lk.employment_type[row[F.employment_type]];
  const years = row[F.min_years];
  const pay = money(row[F.salary_min], row[F.salary_max], lk.currency[row[F.currency]]);
  const place = lk.location[row[F.location]] || label.country(lk.country[row[F.country]]) || "Location not stated";
  const day = row[F.posted] || row[F.first_seen];

  const tags = [
    wp && `<span class="chip tag">${esc(pretty(wp))}</span>`,
    sen && `<span class="chip tag">${esc(pretty(sen))}</span>`,
    emp && emp !== "full_time" && `<span class="chip tag">${esc(pretty(emp))}</span>`,
    row[F.visa] ? `<span class="chip tag">Visa mentioned</span>` : "",
  ].filter(Boolean).join("");

  const id = row[F.id];
  const summary = row[F.has_summary]
    ? `<button type="button" class="link sum-btn" data-sum="${esc(id)}" aria-expanded="false">Summary ▾</button><div class="sum" id="sum-${esc(id)}" hidden></div>`
    : "";

  return `<li class="job" data-id="${esc(id)}">
    <h2><a href="${esc(safeLink(row[F.link]))}" target="_blank" rel="noopener nofollow">${esc(row[F.title])}</a></h2>
    <div class="line"><b>${esc(lk.company[row[F.company]] || "Unknown company")}</b><span>${esc(place)}</span>
      ${day ? `<span>${esc(row[F.posted] ? "Posted " : "Seen ")}${esc(ago(day))}</span>` : ""}
      ${years ? `<span>${esc(years)}+ yrs</span>` : ""}${pay ? `<span>${esc(pay)}</span>` : ""}</div>
    <div class="chips">${tags}${skills.map((s) => `<button type="button" class="chip" data-skill="${esc(s)}">${esc(s)}</button>`).join("")}</div>
    ${summary}
  </li>`;
}

function renderMore() {
  const next = S.filtered.slice(S.shown, S.shown + PAGE);
  S.shown += next.length;
  if (!S.filtered.length) {
    $("results").innerHTML = `<li class="empty">No jobs match these filters. Try removing one.</li>`;
  } else {
    const html = next.map(jobHTML);
    // Narrow screens have no side panel: show the contact card once in the list.
    if (S.shown === next.length && hasContact() && html.length > 5) {
      html.splice(5, 0, `<li class="cta narrow-only">${contactHTML()}</li>`);
    }
    $("results").insertAdjacentHTML("beforeend", html.join(""));
  }
  const left = S.filtered.length - S.shown;
  $("more").hidden = left <= 0;
  $("more").textContent = `Show more (${fmt(left)} left)`;
}

// ---------------------------------------------------------------------------
// CV review (WhatsApp) and job summaries
// ---------------------------------------------------------------------------
function waLink(text) {
  const phone = S.cfg.whatsapp_number;
  if (!phone) return "";
  const message = text || S.cfg.whatsapp_message || "";
  return `https://wa.me/${encodeURIComponent(phone)}${message ? `?text=${encodeURIComponent(message)}` : ""}`;
}

function hasContact() {
  return Boolean(S.cfg.whatsapp_number || S.cfg.linkedin_url);
}

function contactHTML() {
  const wa = waLink();
  const linkedin = S.cfg.linkedin_url;
  return `<strong>${esc(S.cfg.cv_review_title || "Need help with your CV?")}</strong>
    <p>${esc(S.cfg.cv_review_text || "")}</p>
    <div class="contact-links">
      ${wa ? `<a class="pill wa" href="${esc(wa)}" target="_blank" rel="noopener">Message me on WhatsApp</a>` : ""}
      ${linkedin ? `<a class="pill" href="${esc(linkedin)}" target="_blank" rel="noopener">${LINKEDIN_ICON} LinkedIn</a>` : ""}
    </div>`;
}

const LINKEDIN_ICON = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z"/></svg>`;

function loadDetails(id) {
  const bucket = id.slice(0, 2);
  if (!S.details.has(bucket)) {
    S.details.set(bucket, getJSON(`details/${bucket}.json`).catch((err) => {
      S.details.delete(bucket);
      throw err;
    }));
  }
  return S.details.get(bucket).then((b) => b[id]);
}

function summaryHTML(sum, row) {
  if (!sum) {
    return `<p class="muted">No summary available for this job.</p>
      <p class="sum-actions"><a href="${esc(safeLink(row[S.F.link]))}" target="_blank" rel="noopener nofollow">Read the full posting ↗</a></p>`;
  }
  const list = (title, items) => (items && items.length
    ? `<h3>${title}</h3><ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "");
  return `${sum.o ? `<p>${esc(sum.o)}</p>` : ""}
    ${list("What you'll do", sum.d)}${list("What they ask for", sum.r)}
    <p class="sum-actions"><a href="${esc(safeLink(row[S.F.link]))}" target="_blank" rel="noopener nofollow">Read the full posting ↗</a></p>`;
}

async function toggleSummary(btn) {
  const id = btn.dataset.sum;
  const box = document.getElementById(`sum-${id}`);
  const open = btn.getAttribute("aria-expanded") === "true";
  btn.setAttribute("aria-expanded", String(!open));
  btn.textContent = open ? "Summary ▾" : "Hide summary ▴";
  box.hidden = open;
  if (open || box.dataset.ready) return;
  box.innerHTML = `<p class="muted">Loading…</p>`;
  const row = rowById(id);
  try {
    box.innerHTML = summaryHTML(await loadDetails(id), row);
    box.dataset.ready = "1";
  } catch (err) {
    console.error(err);
    box.innerHTML = `<p class="muted">Could not load the summary. Try again.</p>`;
  }
}

// Wide screens with a mouse get the side panel; others keep inline summaries.
const WIDE = window.matchMedia("(min-width: 960px) and (hover: hover)");
let sideId = "";

function rowById(id) {
  return S.filtered.find((r) => r[S.F.id] === id) || S.rows.find((r) => r[S.F.id] === id);
}

async function showSide(id) {
  if (!WIDE.matches || !id || id === sideId) return;
  sideId = id;
  const row = rowById(id);
  if (!row) return;
  const F = S.F, lk = S.lk;
  document.querySelectorAll(".job.active").forEach((el) => el.classList.remove("active"));
  document.querySelector(`.job[data-id="${CSS.escape(id)}"]`)?.classList.add("active");

  const head = `<h2>${esc(row[F.title])}</h2>
    <p class="side-meta">${esc(lk.company[row[F.company]] || "")}${lk.location[row[F.location]] ? ` · ${esc(lk.location[row[F.location]])}` : ""}</p>`;
  const box = $("side-job");
  box.innerHTML = `${head}<div class="sum">${row[F.has_summary] ? `<p class="muted">Loading…</p>` : summaryHTML(null, row)}</div>`;
  if (!row[F.has_summary]) return;
  try {
    const sum = await loadDetails(id);
    if (sideId === id) box.innerHTML = `${head}<div class="sum">${summaryHTML(sum, row)}</div>`;
  } catch (err) {
    console.error(err);
    if (sideId === id) box.querySelector(".sum").innerHTML = `<p class="muted">Could not load the summary.</p>`;
  }
}

function syncLayout() {
  document.body.classList.toggle("wide", WIDE.matches);
  sideId = "";
  if (WIDE.matches && S.filtered.length) showSide(S.filtered[0][S.F.id]);
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------
const tip = {
  show(e, text) { const t = $("tip"); t.textContent = text; t.hidden = false; this.move(e); },
  move(e) { const t = $("tip"); t.style.left = `${e.clientX + 12}px`; t.style.top = `${e.clientY + 12}px`; },
  hide() { $("tip").hidden = true; },
};

function bindTips(root) {
  root.querySelectorAll("[data-tip]").forEach((el) => {
    el.addEventListener("mouseenter", (e) => tip.show(e, el.dataset.tip));
    el.addEventListener("mousemove", (e) => tip.move(e));
    el.addEventListener("mouseleave", () => tip.hide());
  });
}

function bars(el, items, { value = fmt, onPick } = {}) {
  const max = Math.max(...items.map((i) => i.value), 1);
  el.innerHTML = `<div class="bars">${items.map((it, n) => `
    <div class="bar${onPick ? " clickable" : ""}" data-n="${n}" data-tip="${esc(`${it.label}: ${value(it.value)}`)}">
      <span class="name">${esc(it.label)}</span>
      <span class="track"><span class="fill" style="width:${(it.value / max) * 82}%"></span><span class="num">${esc(value(it.value))}</span></span>
    </div>`).join("")}</div>`;
  if (onPick) el.querySelectorAll(".bar").forEach((b) => b.addEventListener("click", () => onPick(items[b.dataset.n])));
  bindTips(el);
}

function mixChart(el) {
  const keys = ["remote", "hybrid", "onsite"];
  const rows = S.ins.by_region.map((r) => {
    const mix = S.ins.workplace_by_region[r.region] || {};
    const total = keys.reduce((a, k) => a + (mix[k] || 0), 0) || 1;
    return { region: r.region, mix, total };
  });
  el.innerHTML = `<div class="legend">${keys.map((k, i) => `<span><i class="s${i + 1}"></i>${pretty(k)}</span>`).join("")}</div>
    <div class="bars">${rows.map((r) => `<div class="bar"><span class="name">${esc(label.region(r.region))}</span>
      <span class="track"><span class="stack">${keys.map((k, i) => {
        const v = r.mix[k] || 0;
        const pct = Math.round((v / r.total) * 100);
        return v ? `<span class="s${i + 1}" style="width:${(v / r.total) * 100}%" data-tip="${esc(`${label.region(r.region)} · ${pretty(k)}: ${fmt(v)} (${pct}%)`)}"></span>` : "";
      }).join("")}</span></span></div>`).join("")}</div>`;
  bindTips(el);
}

function daysChart(el) {
  const days = S.ins.posted_per_day;
  if (!days.length) { el.textContent = "No dated postings."; return; }
  const W = 1000, H = 180, padL = 40, padB = 22, max = Math.max(...days.map((d) => d.jobs));
  const step = (W - padL) / days.length, bw = Math.max(step - 2, 1);
  const y = (v) => (H - padB) - (v / max) * (H - padB - 8);
  const ticks = [0, Math.round(max / 2), max];
  const svg = [`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Jobs posted per day">`];
  for (const t of ticks) svg.push(`<line class="gridline" x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="0" y="${y(t) + 4}">${fmt(t)}</text>`);
  days.forEach((d, i) => {
    const x = padL + i * step, top = y(d.jobs);
    svg.push(`<rect class="col" x="${x}" y="${top}" width="${bw}" height="${H - padB - top}" rx="2" data-tip="${esc(`${d.date}: ${fmt(d.jobs)} jobs`)}"/>`);
    if (i % 10 === 0) svg.push(`<text class="axis" x="${x}" y="${H - 6}">${d.date.slice(5)}</text>`);
  });
  svg.push("</svg>");
  el.innerHTML = `<div class="days">${svg.join("")}</div>`;
  bindTips(el);
}

function goJobs(state) {
  writeState({ ...hashToState(), q: "", region: "", country: "", wp: "", sen: "", skill: "", ...state });
  selectTab("jobs");
  apply();
}

function renderInsights() {
  const ins = S.ins, s = ins.summary;
  const tiles = [
    [s.total_jobs, "open jobs"], [s.companies, "companies"], [s.countries, "countries"],
    [s.remote_jobs, "remote jobs"], [s.posted_last_7_days, "posted in the last 7 days"],
  ];
  $("tiles").innerHTML = tiles.map(([v, k]) => `<div class="tile"><div class="v">${fmt(v)}</div><div class="k">${k}</div></div>`).join("");

  bars($("c-role"), ins.by_category.map((r) => ({ label: label.role(r.category), value: r.jobs, key: r.category })),
    { onPick: (it) => goJobs({ role: it.key }) });
  mixChart($("c-mix"));
  bars($("c-skills"), ins.top_skills.slice(0, 20).map((r) => ({ label: r.skill, value: r.jobs })),
    { onPick: (it) => goJobs({ skill: it.label, role: ALL }) });
  bars($("c-country"), ins.by_country.slice(0, 15).map((r) => ({ label: label.country(r.country), value: r.jobs, key: r.country })),
    { onPick: (it) => goJobs({ country: it.key, role: ALL }) });
  bars($("c-remote"), ins.remote_by_country.slice(0, 12).map((r) => ({ label: label.country(r.country), value: r.jobs, key: r.country })),
    { onPick: (it) => goJobs({ country: it.key, wp: "remote", role: ALL }) });
  bars($("c-company"), ins.top_companies.slice(0, 15).map((r) => ({ label: r.company, value: r.jobs })),
    { onPick: (it) => goJobs({ q: it.label.toLowerCase(), role: ALL }) });
  daysChart($("c-days"));
  const sal = Object.entries(ins.median_usd_salary_by_category)
    .filter(([k]) => k !== "other")
    .sort((a, b) => b[1].median - a[1].median)
    .map(([k, v]) => ({ label: label.role(k), value: v.median, jobs: v.jobs }));
  bars($("c-salary"), sal, { value: (v) => `$${Math.round(v / 1000)}k` });
  bars($("c-seniority"), ins.by_seniority.map((r) => ({ label: pretty(r.seniority), value: r.jobs, key: r.seniority })),
    { onPick: (it) => goJobs({ sen: it.key }) });
  renderLifecycle();
}

// ---------------------------------------------------------------------------
// Job lifecycle (data/v2/lifecycle.json, from the Databricks gold tables)
// ---------------------------------------------------------------------------
const ROLE_FAMILY = {
  software_engineering: "Software engineering", data_engineering: "Data engineering", data_science: "Data science",
  devops_platform: "DevOps & platform", cybersecurity: "Cybersecurity", sales_development: "Sales development",
  other: "Other roles",
};
const pct = (share) => `${Math.round(share * 100)}%`;

// The file is optional: the section stays hidden when the build has none.
async function renderLifecycle() {
  let lc;
  try { lc = await getJSON("lifecycle.json"); } catch { return; }
  if (!lc.daily?.length) return;
  const all = lc.time_to_close?.all || {};
  const since = lc.daily[0].date, asOf = lc.as_of || lc.daily[lc.daily.length - 1].date;
  $("lc-note").textContent = `Each job is tracked from the day it first appears until it closes. Tracking since ${since}; `
    + `figures as of ${asOf}, computed on Databricks.`;
  const tiles = [
    [fmt(lc.daily.reduce((a, d) => a + (d.opened || 0), 0)), "new postings seen"],
    [fmt(all.closed || 0), "closed so far"],
    [all.median_days == null ? "—" : `${all.median_days} days`, "median time open"],
    [all.open_after_7d == null ? "—" : pct(all.open_after_7d), "still open after 7 days"],
  ];
  $("lc-tiles").innerHTML = tiles.map(([v, k]) => `<div class="tile"><div class="v">${esc(v)}</div><div class="k">${k}</div></div>`).join("");
  lifecycleDays($("c-lc-days"), lc.daily);
  timeToClose($("c-lc-ttc"), lc.time_to_close?.by_role || []);
  qualityCard($("c-lc-quality"), lc.quality);
  $("lifecycle").hidden = false;
}

function lifecycleDays(el, days) {
  const W = 1000, H = 180, padL = 52, padB = 22;
  const max = Math.max(...days.map((d) => Math.max(d.opened || 0, d.closed || 0)), 1);
  const step = (W - padL) / Math.max(days.length, 7), bw = Math.max(step / 2 - 2, 1);
  const y = (v) => (H - padB) - (v / max) * (H - padB - 8);
  const svg = [`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="New postings and closures per day">`];
  for (const t of [0, Math.round(max / 2), max]) svg.push(`<line class="gridline" x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="0" y="${y(t) + 4}">${fmt(t)}</text>`);
  days.forEach((d, i) => {
    const x = padL + i * step;
    for (const [n, key, cls] of [[0, "opened", "col"], [1, "closed", "col closed"]]) {
      const top = y(d[key] || 0);
      svg.push(`<rect class="${cls}" x="${x + n * (bw + 2)}" y="${top}" width="${bw}" height="${H - padB - top}" rx="2" data-tip="${esc(`${d.date}: ${fmt(d[key] || 0)} ${key === "opened" ? "new postings" : "closed"}`)}"/>`);
    }
    if (days.length <= 14 || i % 7 === 0) svg.push(`<text class="axis" x="${x}" y="${H - 6}">${d.date.slice(5)}</text>`);
  });
  svg.push("</svg>");
  el.innerHTML = `<div class="legend"><span><i class="s1"></i>New postings</span><span><i class="s2"></i>Closed</span></div><div class="days">${svg.join("")}</div>`;
  bindTips(el);
}

function timeToClose(el, roles) {
  const known = roles.filter((r) => r.median_days != null);
  if (known.length) {
    bars(el, known.map((r) => ({ label: ROLE_FAMILY[r.value] || pretty(r.value), value: r.median_days })),
      { value: (v) => `${v} days` });
    return;
  }
  // Until enough jobs have closed, the median is unknown: show what is being tracked.
  el.innerHTML = `<p class="lc-empty">Not enough jobs have closed yet to measure this. Medians appear once half of a role's tracked jobs have closed. Jobs with a known role tracked so far:</p><div></div>`;
  bars(el.lastElementChild, roles.map((r) => ({ label: ROLE_FAMILY[r.value] || pretty(r.value), value: r.still_open || 0 })));
}

function qualityCard(el, q) {
  if (!q) { el.innerHTML = `<p class="lc-empty">No run recorded yet.</p>`; return; }
  const when = new Date(q.run_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
  const stats = [[`${fmt(q.sources_ok)} / ${fmt(q.sources)}`, "sources returned jobs"], [fmt(q.errors), "errors"], [fmt(q.warnings), "warnings"]];
  el.innerHTML = `<div class="lc-stats">${stats.map(([v, k]) => `<div><div class="v">${esc(v)}</div><div class="k">${k}</div></div>`).join("")}</div>
    <p class="lc-empty">Run of ${esc(when)} UTC. A source that fails or suddenly returns no jobs is flagged before the site is published.</p>`;
}

// ---------------------------------------------------------------------------
// Tabs and startup
// ---------------------------------------------------------------------------
function selectTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  $("tab-jobs").hidden = name !== "jobs";
  $("tab-insights").hidden = name !== "insights";
  $("tab-blog").hidden = name !== "blog";
  $("tab-about").hidden = name !== "about";
  // The footer (last update, browse link, disclaimer) is about the job list.
  $("jobs-foot").hidden = name !== "jobs";
  if (name === "insights" && !$("tiles").childElementCount) renderInsights();
  if (name === "about" && !$("about-tiles").childElementCount) renderAbout();
}

// The other tabs have their own links (#insights, #blog, #about) so they can
// be shared on their own; the Jobs tab's hash holds the filters.
const TAB_HASHES = { "#insights": "insights", "#blog": "blog", "#about": "about" };
const tabFromHash = () => TAB_HASHES[location.hash] || "";

function renderAbout() {
  const s = S.ins.summary;
  const updated = new Date(S.meta.generated_at).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" });
  const tiles = [
    [fmt(s.total_jobs), "open jobs"], [fmt(s.companies), "companies"], [fmt(s.countries), "countries"],
    [fmt((S.lk.source || []).length), "sources"], [updated, "last update"],
  ];
  $("about-tiles").innerHTML = tiles.map(([v, k]) => `<div class="tile"><div class="v">${esc(v)}</div><div class="k">${k}</div></div>`).join("");
  const linkedin = S.cfg.linkedin_url;
  const links = [
    linkedin ? `<a class="pill" href="${esc(linkedin)}" target="_blank" rel="noopener">${LINKEDIN_ICON} LinkedIn</a>` : "",
    S.cfg.whatsapp_number ? `<a class="pill wa" href="${esc(waLink("Hi Pedro! I saw how your jobs index is built and would like to talk."))}" target="_blank" rel="noopener">WhatsApp</a>` : "",
  ].join("");
  $("about-links").innerHTML = links;
  $("about-contact").hidden = !links;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function main() {
  const startTab = tabFromHash();
  const cfg = fetch("config.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const latest = getJSON("latest.json").catch(() => ({ rows: [] }));
  [S.meta, S.lk, S.ins, S.cfg] = await Promise.all([getJSON("meta.json"), getJSON("lookups.json"), getJSON("insights.json"), cfg]);
  if (hasContact()) Object.assign($("contact"), { innerHTML: contactHTML(), hidden: false });
  S.meta.fields.forEach((f, i) => { S.F[f.name] = i; });
  const preview = (await latest).rows;
  if (preview.length) { addRows(preview); S.partial = true; }
  const s = S.ins.summary;
  const updated = new Date(S.meta.generated_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
  $("tagline").textContent = `${fmt(s.total_jobs)} open jobs · ${fmt(s.companies)} companies · ${fmt(s.countries)} countries`;
  $("updated").textContent = `Updated ${updated} UTC.`;

  buildControls();
  writeState(hashToState());

  const run = debounce(apply, 200);
  $("q").addEventListener("input", run);
  $("f-skill").addEventListener("change", apply);
  for (const id of ["f-role", "f-region", "f-country", "f-workplace", "f-seniority", "f-posted", "f-sort", "f-salary", "f-visa"]) {
    $(id).addEventListener("change", apply);
  }
  $("reset").addEventListener("click", () => { writeState({ q: "", role: ALL, region: "", country: "", wp: "", sen: "", posted: "", skill: "", sort: "new", sal: false, visa: false }); apply(); });
  $("more").addEventListener("click", renderMore);
  $("results").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-skill]");
    if (chip) { $("f-skill").value = chip.dataset.skill; apply(); return; }
    const sum = e.target.closest("[data-sum]");
    if (sum) toggleSummary(sum);
  });
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    selectTab(b.dataset.tab);
    if (b.dataset.tab !== "jobs") history.replaceState(null, "", `#${b.dataset.tab}`);
    else if (tabFromHash()) stateToHash(readState());
  }));
  // Hovering or focusing a job shows it in the side panel (short delay so
  // moving the mouse across the list does not flicker).
  // Only real pointer movement counts: when the page scrolls under a still
  // mouse, browsers fire hover events too, which made the panel jump.
  let hoverTimer;
  let lastX = -1, lastY = -1;
  const pick = (job) => {
    if (!job) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => showSide(job.dataset.id), 120);
  };
  $("results").addEventListener("mousemove", (e) => {
    if (e.clientX === lastX && e.clientY === lastY) return;
    lastX = e.clientX; lastY = e.clientY;
    pick(e.target.closest(".job"));
  });
  $("results").addEventListener("focusin", (e) => pick(e.target.closest(".job")));
  WIDE.addEventListener("change", syncLayout);
  document.body.classList.toggle("wide", WIDE.matches);

  // Pasted or edited links (#country=BR&skill=python) apply without a reload.
  window.addEventListener("hashchange", () => {
    if (tabFromHash()) { selectTab(tabFromHash()); return; }
    writeState(hashToState()); selectTab("jobs"); apply();
  });

  if (startTab) selectTab(startTab);
  await apply();
  // apply() rewrites the hash from the filters; keep the shared tab link.
  if (startTab) history.replaceState(null, "", `#${startTab}`);
}

main().catch((err) => {
  console.error(err);
  $("tagline").textContent = "Could not load the jobs data. Please try again later.";
  $("count").textContent = "";
});
