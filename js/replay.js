// Replay a past election as if it were coming in live, to exercise the tracker.
// Expected = the earlier baseline with no swing; "live" = the later year's real
// county results, released in batches. The tracker has to find the swing itself.

import { margin } from "./model.js";

/** Small seeded RNG so a replay is repeatable. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/**
 * Build the batch schedule for one state.
 * order: "random" | "small-first" (rural counties first, cities last)
 * skew:  margin points the first batch in each county leans Democratic
 *        (early mail), paid back by the last batch. 0 = every batch alike.
 */
export function makeReplay(actualBaseline, st, { order = "random", skew = 0, seed = 7 } = {}) {
  const units = Object.entries(actualBaseline.units)
    .filter(([, u]) => u[1] === st)
    .map(([fips, [, , dem, rep, total]]) => ({ fips, dem, rep, total }));
  const r = rng(seed);
  if (order === "small-first") units.sort((a, b) => a.total - b.total);
  else units.sort(() => r() - 0.5);

  // Each unit reports 40% / 80% / 100%; batches interleave across units.
  const shares = [0.4, 0.4, 0.2], lean = [skew, 0, -2 * skew];
  const batches = [];
  units.forEach((u, i) => {
    const m = margin(u.dem, u.rep, u.total) / 100, other = u.total - u.dem - u.rep;
    shares.forEach((sh, k) => {
      const t = u.total * sh, mk = m + lean[k] / 100, o = other * sh;
      const two = t - o;
      batches.push({ at: i + k * units.length * 0.35 + r() * 3, fips: u.fips,
                     dem: (two + mk * t) / 2, rep: (two - mk * t) / 2, total: t });
    });
  });
  batches.sort((a, b) => a.at - b.at);
  return { units, batches };
}

/** Live-feed-shaped snapshot after the first n batches. */
export function snapshotAt(replay, n) {
  const live = {};
  for (const b of replay.batches.slice(0, n)) {
    const l = (live[b.fips] ||= { dem: 0, rep: 0, total: 0 });
    l.dem += b.dem; l.rep += b.rep; l.total += b.total;
  }
  for (const u of replay.units) if (live[u.fips]) live[u.fips].pct_in = Math.min(1, live[u.fips].total / u.total);
  return live;
}

// ---------------------------------------------------------------- NC, real vote types

const TYPES = ["early", "mail", "eday", "prov"];

/**
 * Expected values for the NC replay, built from a past NC file (data/nc/{year}.json).
 * Margins come from that year by county and vote type. Early and mail vote are taken
 * as KNOWN, from the target year's totals, because NC publishes accepted ballots
 * by county before polls close (the live adapter reads them from the absentee file).
 * Election Day is what's left of the county's expected total.
 */
export function ncExpected(prior, target, { typed = true } = {}) {
  const out = {};
  for (const [fips, ts] of Object.entries(prior.counties)) {
    const tot = TYPES.reduce((a, t) => a + (ts[t]?.[2] || 0), 0);
    const all = { expected: margin(sum(ts, 0), sum(ts, 1), tot), expectedVote: tot };
    if (!typed) { out[fips] = all; continue; }
    const tgt = target.counties[fips] || {};
    const known = (tgt.early?.[2] || 0) + (tgt.mail?.[2] || 0);
    const types = {};
    for (const t of TYPES) {
      const [d, r, n] = ts[t] || [0, 0, 0];
      types[t] = { expected: n > 0 ? margin(d, r, n) : all.expected, expectedVote: n };
    }
    types.early.expectedVote = tgt.early?.[2] || 0;
    types.mail.expectedVote = tgt.mail?.[2] || 0;
    types.eday.expectedVote = Math.max(tot - known - types.prov.expectedVote, 0.25 * (ts.eday?.[2] || 0));
    out[fips] = { ...all, types };
  }
  return out;
}
const sum = (ts, i) => TYPES.reduce((a, t) => a + (ts[t]?.[i] || 0), 0);

/**
 * NC's real counting order: at poll close each county releases its early and mail
 * ballots in one batch; Election Day precincts follow through the night; provisional
 * ballots come last (in reality days later, at the canvass).
 */
export function makeNcReplay(nc, { seed = 11 } = {}) {
  const r = rng(seed);
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const early = [], eday = [], prov = [];
  for (const [fips, ts] of Object.entries(nc.counties)) {
    for (const t of ["early", "mail"]) if (ts[t]) early.push({ fips, type: t, dem: ts[t][0], rep: ts[t][1], total: ts[t][2] });
    if (ts.prov) prov.push({ fips, type: "prov", dem: ts.prov[0], rep: ts.prov[1], total: ts.prov[2] });
    for (const [d, rep, n] of nc.eday_precincts[fips] || []) eday.push({ fips, type: "eday", dem: d, rep, total: n });
  }
  // Early and mail batches go out in the first stretch; precincts in roughly 400 steps.
  const precinctSteps = chunk(shuffle(eday), Math.ceil(eday.length / 400));
  const batches = [...shuffle(early).map((b) => [b]), ...precinctSteps, prov];
  return { batches, typed: true, nEarly: early.length };
}
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/** Feed-shaped snapshot after the first n steps of an NC replay. */
export function ncSnapshotAt(replay, n, { typed = true } = {}) {
  const live = {};
  for (const step of replay.batches.slice(0, n)) {
    for (const b of step) {
      const u = (live[b.fips] ||= { dem: 0, rep: 0, total: 0, by_type: {} });
      u.dem += b.dem; u.rep += b.rep; u.total += b.total;
      const c = (u.by_type[b.type] ||= { dem: 0, rep: 0, total: 0 });
      c.dem += b.dem; c.rep += b.rep; c.total += b.total;
    }
  }
  if (!typed) for (const u of Object.values(live)) delete u.by_type;
  return live;
}
