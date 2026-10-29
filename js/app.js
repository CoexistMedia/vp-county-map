import { margin, stateBaseMargin, impliedUnits, estimate, priorSd } from "./model.js";
import { makeReplay, snapshotAt, ncExpected, makeNcReplay, ncSnapshotAt } from "./replay.js";
import { buildUnits, render, marginColor, legend, closeSheet } from "./map.js";

const API = "https://votepredictor.com/api/v1";
const $ = (id) => document.getElementById(id);
const fmtM = (m) => (m == null ? "–" : Math.abs(m) < 0.05 ? "Even" : `${m > 0 ? "D" : "R"}+${Math.abs(m).toFixed(1)}`);
const cls = (m) => (m == null ? "" : m > 0 ? "d" : "r");
const pct = (x) => (x == null ? "–" : `${(x * 100).toFixed(0)}%`);
const num = (x) => Math.round(x).toLocaleString("en-US");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmtDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const TYPE_LABEL = { early: "Early in person", mail: "Mail", eday: "Election Day", prov: "Provisional", all: "All votes" };
const ICON = { play: '<svg viewBox="0 0 12 12"><path d="M2 1l9 5-9 5z"/></svg>', pause: '<svg viewBox="0 0 12 12"><path d="M2 1h3v10H2zM7 1h3v10H7z"/></svg>' };
const setPlay = (btn, playing) => { btn.innerHTML = playing ? `${ICON.pause}Pause` : `${ICON.play}Play`; };
const share = (x, n) => (n > 0 ? `${((x / n) * 100).toFixed(1)}%` : "–");
const lastName = (s) => String(s || "").trim().split(/\s+/).pop();

/** Candidate rows with vote counts and share bars, the network-results layout. */
function candRows(c, dem, rep, total) {
  const row = (party, name, v) => `<div class="cand">
      <span class="chip ${party}"></span>
      <span class="name">${esc(name)}<small>${party === "d" ? "DEM" : "REP"}</small></span>
      <span class="pct ${party}">${share(v, total)}</span>
      <span class="votes"><span>${num(v)} votes</span></span>
      <span class="bar"><i style="width:${total ? (v / total) * 100 : 0}%;background:var(--${party === "d" ? "dem" : "rep"})"></i></span>
    </div>`;
  const rows = [["d", c.democrat || "Democrat", dem], ["r", c.republican || "Republican", rep]].sort((a, b) => b[2] - a[2]);
  return `<div class="cands">${rows.map((r) => row(...r)).join("")}</div>`;
}
const pbar = (p) => `<div class="pbar" role="img" aria-label="${pct(p)} Democratic win probability"><i style="width:${(p ?? 0.5) * 100}%"></i></div>`;

const S = { view: "forecast", races: [], history: {}, dates: [], live: false };
const PRES24 = { democrat: "Kamala Harris", republican: "Donald Trump" };

async function getJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// ---------------------------------------------------------------- boot

async function boot() {
  const [topo, b24, b20, snap, hist, nc20, nc24] = await Promise.all([
    getJSON("data/counties-10m.json"), getJSON("data/baseline-2024.json"),
    getJSON("data/baseline-2020.json"), getJSON("data/races.json"), getJSON("data/history.json"),
    getJSON("data/nc/2020.json"), getJSON("data/nc/2024.json"),
  ]);
  Object.assign(S, { topo, b24, b20, nc20, nc24, races: snap.races, history: hist.races });
  S.geo = buildUnits(topo, new Set(b24.statewide_states.map((st) => b24.states[st].fips)));
  setDates();

  wireTabs(); wireForecast(); wireNight();
  setPlay($("f-play"), false); setPlay($("n-play"), false);
  $("sheet-close").addEventListener("click", closeSheet);
  // Colours are read from the CSS tokens, so redraw when the theme flips.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => (S.view === "forecast" ? drawForecast() : drawNight()));
  drawForecast();
  refreshRaces(); // in the background: snapshot first, live numbers when they arrive
}

/** Re-read every race and its published history from the live API; keep the snapshot on failure. */
async function refreshRaces() {
  $("f-asof").textContent = "Snapshot loaded · checking the live API…";
  const out = [...S.races], hist = { ...S.history };
  let ok = 0, i = 0;
  const worker = async () => {
    while (i < out.length) {
      const k = i++, id = out[k].race_id;
      try {
        const [d, h] = await Promise.all([getJSON(`${API}/race/${id}`), getJSON(`${API}/race/${id}/history`).catch(() => null)]);
        const f = d.forecast || {};
        out[k] = { ...out[k], as_of: d.as_of, pred_margin: f.pred_margin ?? null, p_dem_win: f.p_dem_win ?? null,
                   rating: f.rating, source: f.source, candidates: d.candidates || out[k].candidates,
                   no_forecast_reason: d.no_forecast?.reason ?? null };
        const pts = h?.as_published?.points;
        if (pts) hist[id] = pts.map((p) => [p.date, p.pred_margin, p.p_dem_win]);
        ok++;
      } catch { /* keep the snapshot row */ }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const atEnd = +$("f-date").value === +$("f-date").max;
  Object.assign(S, { races: out, history: hist, live: ok > 0 });
  setDates(atEnd);
  const asOf = out.map((r) => r.as_of).filter(Boolean).sort().pop();
  $("f-asof").textContent = S.live ? `Live from the API · model run ${asOf}` : `API unreachable · snapshot of ${asOf}`;
  fillRaceSelects();
  if (S.view === "forecast") drawForecast();
}

function setDates(jumpToEnd = true) {
  S.dates = [...new Set(Object.values(S.history).flatMap((h) => h.map((p) => p[0])))].sort();
  const r = $("f-date");
  r.max = Math.max(S.dates.length - 1, 0);
  if (jumpToEnd) r.value = r.max;
}

function wireTabs() {
  document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => {
    S.view = b.dataset.view;
    document.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-selected", x === b));
    $("controls-forecast").hidden = S.view !== "forecast";
    $("controls-night").hidden = S.view !== "night";
    stopAll(); closeSheet();
    S.view === "forecast" ? drawForecast() : setupNight();
  }));
}

// ---------------------------------------------------------------- layer 1: forecast

let fTimer = null;

function wireForecast() {
  $("f-office").addEventListener("change", () => { fillRaceSelects(); drawForecast(); });
  $("f-race").addEventListener("change", drawForecast);
  $("f-date").addEventListener("input", () => { stopAll(); drawForecast(); });
  $("f-play").addEventListener("click", () => {
    if (fTimer) return stopAll();
    const r = $("f-date");
    if (+r.value >= +r.max) r.value = 0;
    setPlay($("f-play"), true);
    fTimer = setInterval(() => {
      r.value = Math.min(+r.max, +r.value + 1);
      drawForecast();
      if (+r.value >= +r.max) stopAll();
    }, 160);
  });
  fillRaceSelects();
}

function fillRaceSelects() {
  const office = $("f-office").value, keep = $("f-race").value;
  const rows = S.races.filter((r) => r.office === office);
  $("f-race").innerHTML = `<option value="">All states</option>` + rows.map((r) =>
    `<option value="${r.race_id}" ${r.pred_margin == null ? "disabled" : ""}>${esc(r.state_name)}${r.pred_margin == null ? " (no forecast)" : ""}</option>`).join("");
  if (rows.some((r) => r.race_id === keep)) $("f-race").value = keep;

  const nr = $("n-race"), keepN = nr.value;
  nr.innerHTML = S.races.filter((r) => r.pred_margin != null).map((r) =>
    `<option value="${r.race_id}">${esc(r.state_name)} · ${r.office === "SEN" ? "Senate" : "Governor"}</option>`).join("");
  if (keepN) nr.value = keepN;
  else if (S.races.some((r) => r.race_id === "2026_SEN_NC")) nr.value = "2026_SEN_NC";
}

/** The race as it stood on a date: today's live numbers, or the last published point on or before it. */
function raceAt(r, date) {
  if (!date) return r;
  const pts = S.history[r.race_id] || [];
  let hit = null;
  for (const p of pts) if (p[0] <= date) hit = p; else break;
  return hit ? { ...r, pred_margin: hit[1], p_dem_win: hit[2], dated: hit[0] } : { ...r, pred_margin: null, notYet: true };
}

function drawForecast() {
  const office = $("f-office").value;
  const idx = +$("f-date").value, latest = idx >= +$("f-date").max;
  const date = latest ? null : S.dates[idx];
  $("f-date-label").textContent = latest ? "Today (latest)" : `As published ${fmtDate(date)}`;

  const races = S.races.filter((x) => x.office === office).map((r) => raceAt(r, date));
  const race = races.find((r) => r.race_id === $("f-race").value);
  const color = marginColor();
  const implied = {}, byState = {};
  for (const r of races.filter((x) => x.pred_margin != null)) {
    const imp = impliedUnits(S.b24, r.state, r.pred_margin);
    if (!imp) continue;
    byState[r.state] = { race: r, ...imp };
    Object.assign(implied, imp.units);
  }

  render($("map"), S.geo, {
    focus: race ? S.b24.states[race.state].fips : null,
    fill: (id) => color(implied[id]?.expected),
    tip: (id) => {
      const u = S.b24.units[id]; if (!u) return null;
      const i = implied[id], m24 = margin(u[2], u[3], u[4]);
      const r = byState[u[1]]?.race;
      const dShare = i ? Math.min(100, Math.max(0, 50 + i.expected / 2)) : 50;
      return `<div class="tt-head"><span>${esc(u[0])}</span><small>${u[1]}</small></div>`
        + (i ? `<div class="tt-row"><span>Implied 2026${r?.candidates ? ` · ${esc(lastName(i.expected >= 0 ? r.candidates.democrat : r.candidates.republican))}` : ""}</span><span class="${cls(i.expected)}">${fmtM(i.expected)}</span></div>
              <div class="tt-split"><i style="width:${dShare}%"></i><i style="width:${100 - dShare}%"></i></div>`
             : `<div class="tt-row"><span>No ${office === "SEN" ? "Senate" : "Governor"} forecast${date ? " on this date" : ""}</span><span></span></div>`)
        + `<div class="tt-row"><span>2024 president</span><span class="${cls(m24)}">${fmtM(m24)}</span></div>`
        + `<div class="tt-row"><span>2024 votes</span><span>${num(u[4])}</span></div>`;
    },
    action: (id) => (!race && byState[S.b24.units[id]?.[1]] ? { label: `Open ${esc(S.b24.units[id][1])} race` } : null),
    onClick: (id) => {
      const r = byState[S.b24.units[id]?.[1]]?.race;
      if (r && $("f-race").value !== r.race_id) { $("f-race").value = r.race_id; drawForecast(); }
    },
  });
  legend($("legend"), color, { extra: "grey: no race or no forecast yet" });
  $("panel").innerHTML = race
    ? (byState[race.state] ? racePanel(race, byState[race.state], date) : `<h2>${esc(race.state_name)}</h2><p class="who">No forecast published by ${fmtDate(date)}.</p><div>${spark(race.race_id, date)}</div>`)
    : nationalPanel(office, byState, races, date);
  $("panel").querySelectorAll("[data-race]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault(); $("f-race").value = a.dataset.race; drawForecast();
  }));
}

function racePanel(r, imp, date) {
  const units = Object.values(imp.units);
  const dNow = units.filter((u) => u.expected > 0).length;
  const flips = units.filter((u) => Math.sign(u.expected) !== Math.sign(u.base)).length;
  const c = r.candidates || {};
  const p = r.p_dem_win, dFav = (p ?? 0.5) >= 0.5, side = dFav ? "d" : "r";
  const fav = p != null && Math.abs(p - 0.5) < 0.05 ? "Toss-up" : `${esc((dFav ? c.democrat : c.republican) || (dFav ? "Democrat" : "Republican"))} favored`;
  return `<div>
      <h2>${esc(r.state_name)} ${r.office === "SEN" ? "Senate" : "Governor"}</h2>
      <p class="who">${esc(c.democrat || "Democrat")} vs. ${esc(c.republican || "Republican")}</p>
    </div>
    <div class="box">
      <p class="eyebrow">VotePredictor forecast${date ? ` · ${fmtDate(r.dated)}` : ""}</p>
      <div class="headline">
        <div><div class="favored ${side}">${fav}</div>${r.rating && r.rating !== fav ? `<div class="who">${esc(r.rating)}</div>` : ""}</div>
        <div class="stats">
          <div class="stat"><b class="${side}">${pct(dFav ? p : 1 - p)}</b><span>chance to win</span></div>
          <div class="stat"><b class="${cls(r.pred_margin)}">${fmtM(r.pred_margin)}</b><span>margin</span></div>
        </div>
      </div>
      <div style="margin-top:12px">${pbar(p)}</div>
    </div>
    <div>
      <p class="eyebrow">Published forecast over time</p>
      ${spark(r.race_id, date)}
    </div>
    <div>
      <p class="eyebrow">By county</p>
      <dl class="kv">
        <dt>2024 president, statewide</dt><dd class="${cls(imp.base)}">${fmtM(imp.base)}</dd>
        <dt>Swing applied to every county</dt><dd>${imp.swing > 0 ? "+" : ""}${imp.swing.toFixed(1)} pts</dd>
        <dt>Counties leaning D / R</dt><dd>${dNow} / ${units.length - dNow}</dd>
        <dt>Counties that flip vs 2024</dt><dd>${flips}</dd>
      </dl>
    </div>
    <p class="note">Each county is its 2024 presidential margin moved by the same swing: the gap between this
      forecast and the state's 2024 result. It projects the statewide number and ignores candidate effects
      such as a local incumbent. History is what the site published each day, not the backcast.
      <a href="${esc(r.url || "https://votepredictor.com")}">Race page</a></p>`;
}

/** Published margin over time, with the selected date marked. */
function spark(id, date) {
  const pts = (S.history[id] || []).filter((p) => p[1] != null);
  if (pts.length < 2) return `<p class="note">${pts.length ? "One published day so far." : "No published history."}</p>`;
  const W = 280, H = 64, x0 = S.dates.indexOf(pts[0][0]);
  const xs = (d) => ((S.dates.indexOf(d) - x0) / Math.max(S.dates.length - 1 - x0, 1)) * (W - 8) + 4;
  const lim = Math.max(5, ...pts.map((p) => Math.abs(p[1])));
  const ys = (m) => H / 2 - (m / lim) * (H / 2 - 6);
  const at = date ? [...pts].reverse().find((p) => p[0] <= date) : pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Published margin over time">
    <line class="zero" x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}"/>
    <polyline class="line" points="${pts.map((p) => `${xs(p[0]).toFixed(1)},${ys(p[1]).toFixed(1)}`).join(" ")}"/>
    ${at ? `<circle class="mark" r="3.5" cx="${xs(at[0])}" cy="${ys(at[1])}"/>` : ""}
  </svg><div class="range">${fmtDate(pts[0][0])} → ${fmtDate(pts[pts.length - 1][0])} · above the dashed line leans D</div>`;
}

function nationalPanel(office, byState, races, date) {
  const rows = Object.values(byState).map((s) => s.race).sort((a, b) => Math.abs(a.pred_margin) - Math.abs(b.pred_margin));
  const none = races.filter((r) => r.pred_margin == null && !r.notYet);
  const notYet = races.filter((r) => r.notYet && S.history[r.race_id]?.length);
  return `<div>
      <h2>${office === "SEN" ? "Senate" : "Governor"} 2026</h2>
      <p class="who">${date ? `As published ${fmtDate(date)}` : "Latest forecast"} · ${rows.length} races</p>
    </div>
    <div>
      <p class="eyebrow">Closest races</p>
      <ul class="races">${rows.slice(0, 12).map((r) => `<li><a href="#" data-race="${r.race_id}">
        <span class="st">${esc(r.state_name)}</span>${pbar(r.p_dem_win)}<span class="m ${cls(r.pred_margin)}">${fmtM(r.pred_margin)}</span></a></li>`).join("")}</ul>
    </div>
    ${notYet.length ? `<p class="note">Not forecast yet on this date: ${notYet.map((r) => esc(r.state_name)).join(", ")}.</p>` : ""}
    ${none.length ? `<p class="note">No forecast published: ${none.map((r) => `${esc(r.state_name)} (${esc(String(r.no_forecast_reason || "").replace(/_/g, " "))})`).join(", ")}. Left grey, as on the site.</p>` : ""}
    <p class="note">Drag the timeline or press Play to watch the forecasts move. Select a county to open its state.</p>`;
}

// ---------------------------------------------------------------- layer 2: election night

let timer = null, pollTimer = null;
function stopAll() {
  clearInterval(timer); timer = null; setPlay($("n-play"), false);
  clearInterval(fTimer); fTimer = null; setPlay($("f-play"), false);
  clearInterval(pollTimer); pollTimer = null;
}

function wireNight() {
  const states = Object.keys(S.b24.states)
    .filter((st) => S.b20.states[st] && !S.b24.statewide_states.includes(st) && !S.b20.statewide_states.includes(st))
    .sort();
  $("n-replay-state").innerHTML = states.map((st) => `<option ${st === "PA" ? "selected" : ""}>${st}</option>`).join("");
  ["n-source", "n-replay-state", "n-order", "n-skew", "n-race", "n-turnout", "n-feed"].forEach((id) => $(id).addEventListener("change", setupNight));
  $("n-typed").addEventListener("change", drawNight);
  $("n-color").addEventListener("change", drawNight);
  $("n-step").addEventListener("input", () => { stopAll(); drawNight(); });
  $("n-play").addEventListener("click", () => {
    if (timer) return stopAll();
    const step = $("n-step");
    if (+step.value >= +step.max) step.value = 0;
    setPlay($("n-play"), true);
    const inc = Math.max(1, Math.round(+step.max / 150));
    timer = setInterval(() => {
      step.value = Math.min(+step.max, +step.value + inc);
      drawNight();
      if (+step.value >= +step.max) stopAll();
    }, 120);
  });
}

function show(cls, on) { document.querySelectorAll(cls).forEach((e) => (e.hidden = !on)); }

function setupNight() {
  stopAll();
  const src = $("n-source").value;
  show(".replay-only", src === "replay");
  show(".live-only", src === "live");
  show(".nc-only", src === "nc");

  if (src === "nc") {
    const rp = makeNcReplay(S.nc24);
    const final = estimate(ncExpected(S.nc20, S.nc24), ncSnapshotAt(rp, Infinity)).proj;
    S.night = { mode: "nc", st: "NC", rp, final, prior: 6, forecast: stateBaseMargin(S.b20, "NC"), cands: PRES24,
                title: "North Carolina president", sub: "2024 replayed in NC's real counting order",
                forecastLabel: "Expected (2020 result, no swing)" };
    $("n-step").max = rp.batches.length; $("n-step").value = rp.nEarly;
    drawNight();
    return;
  }

  if (src === "replay") {
    const st = $("n-replay-state").value;
    const base = stateBaseMargin(S.b20, st);
    const imp = impliedUnits(S.b20, st, base);
    const expected = {};
    for (const [f, u] of Object.entries(imp.units)) if (S.b24.units[f]) expected[f] = { expected: u.expected, expectedVote: u.baseTotal };
    const rp = makeReplay(S.b24, st, { order: $("n-order").value, skew: +$("n-skew").value });
    const final = estimate(expected, snapshotAt(rp, Infinity)).proj;
    S.night = { mode: "replay", st, expected, rp, forecast: base, prior: 6, final, cands: PRES24,
                title: `${st} president`, sub: "2024 counted against 2020, simulated batches",
                forecastLabel: "Expected (2020 result, no swing)" };
    $("n-step").max = rp.batches.length; $("n-step").value = 0;
    drawNight();
    return;
  }

  const r = S.races.find((x) => x.race_id === $("n-race").value) || S.races.find((x) => x.pred_margin != null);
  if (!r) return;
  $("n-race").value = r.race_id;
  const turnout = +$("n-turnout").value || 0.72;
  const imp = impliedUnits(S.b24, r.state, r.pred_margin);
  const expected = {};
  for (const [f, u] of Object.entries(imp.units)) {
    expected[f] = { expected: u.expected, expectedVote: u.baseTotal * turnout };
    // Vote-type split, for feeds that send by_type: county total split by 2024's mix as a
    // starting point; a feed's expected_vote / pct_in overrides it (the NC adapter sends
    // accepted early and mail ballots).
    const nc = r.state === "NC" && S.nc24.counties[f];
    if (nc) {
      const tot = Object.values(nc).reduce((a, v) => a + v[2], 0);
      expected[f].types = Object.fromEntries(Object.entries(nc).map(([t, v]) =>
        [t, { expected: u.expected, expectedVote: (u.baseTotal * turnout * v[2]) / tot }]));
    }
  }
  // Follow the race with the default path, unless a custom URL was typed in.
  if (!$("n-feed").value || $("n-feed").value === S.night?.defaultFeed) $("n-feed").value = `data/live/${r.race_id}.json`;
  S.night = { mode: "live", race: r, st: r.state, expected, live: {}, forecast: r.pred_margin,
              prior: priorSd(r.pred_margin, r.p_dem_win), defaultFeed: `data/live/${r.race_id}.json`,
              status: "Waiting for the feed…", cands: r.candidates || {},
              title: `${r.state_name} ${r.office === "SEN" ? "Senate" : "Governor"}`, sub: "Live results", forecastLabel: "VotePredictor forecast" };
  drawNight();
  pollFeed();
  pollTimer = setInterval(pollFeed, 30000);
}

async function pollFeed() {
  const n = S.night;
  try {
    const d = await getJSON($("n-feed").value);
    const live = {};
    const rows = Array.isArray(d.counties) ? d.counties : Object.entries(d.counties || {}).map(([fips, v]) => ({ fips, ...v }));
    for (const c of rows) { const f = String(c.fips); live[f.padStart(f.length <= 2 ? 2 : 5, "0")] = c; }
    n.live = live;
    n.status = `Feed updated ${d.updated_at || "(no timestamp)"} · polling every 30 s.`;
  } catch (e) {
    n.status = `Feed not available yet (${esc(e.message)}). The map shows the forecast until it is.`;
  }
  if (S.night === n) drawNight();
}

function nightData(n) {
  const step = +$("n-step").value;
  if (n.mode === "nc") {
    const typed = $("n-typed").checked;
    return { expected: ncExpected(S.nc20, S.nc24, { typed }), live: ncSnapshotAt(n.rp, step, { typed }) };
  }
  if (n.mode === "replay") return { expected: n.expected, live: snapshotAt(n.rp, step) };
  return { expected: n.expected, live: n.live };
}

function drawNight() {
  const n = S.night; if (!n) return;
  const { expected, live } = nightData(n);
  const est = estimate(expected, live, { priorSd: n.prior });
  const byShift = $("n-color").value === "shift";
  const color = byShift ? marginColor([2, 5, 10, 15]) : marginColor();
  const names = S.b24.units, c = n.cands || {};

  render($("map"), S.geo, {
    focus: S.b24.states[n.st].fips,
    fill: (id) => {
      const u = est.units[id]; if (!u) return null;
      if (byShift) return u.resid == null ? null : color(u.resid);
      return u.counted > 0 ? color(u.actual) : color(u.expected);
    },
    opacity: (id) => {
      const u = est.units[id]; if (!u) return 1;
      return u.counted > 0 ? 0.45 + 0.55 * Math.min(1, u.frac) : 0.3;
    },
    tip: (id) => {
      const u = est.units[id], b = names[id];
      if (!u || !b) return null;
      const dv = live[id]?.dem || 0, rv = live[id]?.rep || 0, tv = live[id]?.total || 0;
      const typeRows = u.cells && !Array.isArray(u.cells) ? Object.entries(u.cells).filter(([, x]) => x.counted > 0)
        .map(([t, x]) => `<div class="tt-row"><span>${TYPE_LABEL[t]} · ${pct(x.E ? x.counted / x.E : 1)} in</span><span class="${cls(x.net)}">${fmtM((x.net / x.counted) * 100)}</span></div>`).join("") : "";
      return `<div class="tt-head"><span>${esc(b[0])}</span><small>${pct(Math.min(1, u.frac))} in</small></div>`
        + (tv > 0 ? `<div class="tt-row"><span>${esc(lastName(c.democrat) || "Dem")}</span><span class="d">${share(dv, tv)} · ${num(dv)}</span></div>
            <div class="tt-row"><span>${esc(lastName(c.republican) || "Rep")}</span><span class="r">${share(rv, tv)} · ${num(rv)}</span></div>
            <div class="tt-split"><i style="width:${(dv / tv) * 100}%"></i><i style="width:${(rv / tv) * 100}%"></i></div>`
          : `<div class="tt-row"><span>No votes counted yet</span><span></span></div>`)
        + `<div class="tt-row"><span>Expected</span><span class="${cls(u.expected)}">${fmtM(u.expected)}</span></div>`
        + `<div class="tt-row"><span>Projected final</span><span class="${cls(u.projected)}">${fmtM(u.projected)}</span></div>`
        + (typeRows ? `<div class="tt-sub">${typeRows}</div>` : "");
    },
  });
  legend($("legend"), color, byShift ? { left: "Redder", right: "Bluer", extra: "vs expected · grey: not enough counted" } : { extra: "faded: still counting" });
  const replay = n.mode !== "live";
  $("replay-bar").hidden = !replay;
  const inShare = est.counted / (est.counted + est.remaining || 1);
  if (replay) $("n-step-label").textContent = `${pct(inShare)} of expected vote`;

  let dem = 0, rep = 0;
  for (const l of Object.values(live)) { dem += l.dem || 0; rep += l.rep || 0; }
  const badge = n.mode === "live" ? (est.counted > 0 ? `<span class="badge live">Live</span>` : `<span class="badge">Waiting</span>`)
    : `<span class="badge">Replay</span>`;
  const status = est.typed
    ? (est.nReporting ? `Split by vote type · ${est.nReporting} counties reporting Election Day votes` : "Split by vote type · no Election Day votes yet")
    : est.provisional ? `<span class="badge warn">Provisional</span> no county finished yet`
    : est.nReporting ? `${est.nReporting} counties finished` : "Nothing counted yet";
  const pD = est.pDem, dFav = (pD ?? 0.5) >= 0.5;
  const types = est.typed && est.byType?.length ? `<div><p class="eyebrow">By vote type</p><table class="tbl"><tr><th>Type</th><th>Counted</th><th>Margin so far</th></tr>
      ${est.byType.map((t) => `<tr><td>${TYPE_LABEL[t.type]}</td><td>${pct(t.expVote ? t.counted / t.expVote : 0)}</td>
        <td class="${cls(t.countedMargin)}">${fmtM(t.countedMargin)}</td></tr>`).join("")}</table></div>` : "";

  $("panel").innerHTML = `<div>
      <div class="headline"><h2>${esc(n.title)}</h2>${badge}</div>
      <p class="who">${esc(n.sub || "")}</p>
    </div>
    <div>
      <p class="eyebrow">Votes counted</p>
      ${candRows(c, dem, rep, est.counted)}
      <div class="range" style="display:flex;justify-content:space-between"><span>Est. ${pct(inShare)} of expected vote in</span><span>${num(est.counted)} votes</span></div>
      <div class="pbar track" style="margin-top:6px"><i style="width:${inShare * 100}%"></i></div>
    </div>
    <div class="box">
      <p class="eyebrow">Projected final</p>
      <div class="headline">
        <div class="big ${cls(est.proj)}">${fmtM(est.proj)}</div>
        <div class="stat" style="text-align:right"><b class="${dFav ? "d" : "r"}" style="font-size:22px">${pct(dFav ? pD : 1 - pD)}</b><span>${esc(lastName(dFav ? c.democrat : c.republican) || (dFav ? "Dem" : "Rep"))} win chance</span></div>
      </div>
      <div class="range">90% range ${fmtM(est.lo)} to ${fmtM(est.hi)}</div>
      <div style="margin-top:10px">${pbar(pD)}</div>
      <p class="note" style="margin-top:8px">${status}</p>
    </div>
    <dl class="kv">
      <dt>${esc(n.forecastLabel)}</dt><dd class="${cls(n.forecast)}">${fmtM(n.forecast)}</dd>
      <dt>Swing vs expected</dt><dd>${est.swing > 0 ? "+" : ""}${est.swing.toFixed(1)} ± ${(1.645 * est.swingSd).toFixed(1)}</dd>
      <dt>Counted margin so far</dt><dd class="${cls(est.countedMargin)}">${fmtM(est.countedMargin)}</dd>
      ${replay ? `<dt>Actual final (2024)</dt><dd class="${cls(n.final)}">${fmtM(n.final)}</dd>` : ""}
    </dl>
    ${types}
    <p class="note">${n.mode === "live" ? esc(n.status) + " " : ""}${est.typed
      ? "Early and mail ballots are counted but not read as a swing: they lean differently from Election Day by an amount that changes every cycle. Each county's swing is read once its Election Day votes start arriving. Untick the box to see the county-totals method misread the same count."
      : "The swing is measured in finished counties and applied to every county still counting, each anchored on its projected final margin, so a county whose early mail ran blue is expected to finish redder."}
      Not calibrated on real election nights; see the README.</p>`;
}

boot().catch((e) => {
  $("panel").innerHTML = `<h2>Couldn't load</h2><p class="note">${esc(e.message)}. Serve this folder over HTTP
    (for example <code>python3 -m http.server</code>); browsers block module scripts and data files on file://.</p>`;
});
