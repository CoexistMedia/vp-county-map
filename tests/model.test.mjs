// node tests/model.test.mjs
// Replays 2024 against a 2020 baseline in every state and checks the tracker:
// (1) with nothing counted it returns the forecast, (2) when all is counted it
// returns the real result, (3) part-way, the 90% interval covers the final
// margin about as often as it claims to.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { impliedUnits, estimate, margin, priorSd, phi, phiInv } from "../js/model.js";
import { makeReplay, snapshotAt } from "../js/replay.js";

const load = (y) => JSON.parse(readFileSync(new URL(`../data/baseline-${y}.json`, import.meta.url)));
const b20 = load(2020), b24 = load(2024);

assert.ok(Math.abs(phi(1.645) - 0.95) < 1e-4);
assert.ok(Math.abs(phiInv(0.95) - 1.645) < 1e-3);
assert.equal(priorSd(5, 0.99), 6, "clamped probability falls back");
assert.ok(Math.abs(priorSd(6, phi(1)) - 6) < 1e-3);

// Uniform swing reproduces the statewide forecast when aggregated.
const ga = impliedUnits(b24, "GA", 3.0);
let net = 0, tot = 0;
for (const u of Object.values(ga.units)) { net += u.expected * u.baseTotal; tot += u.baseTotal; }
assert.ok(Math.abs(net / tot - 3.0) < 0.6, `GA implied ${net / tot}`); // ±clamping

const states = Object.keys(b24.states).filter((s) => b20.states[s] && !b24.statewide_states.includes(s) && !b20.statewide_states.includes(s));
let covered = 0, checks = 0, worst = 0;
for (const st of states) {
  for (const [order, skew] of [["random", 0], ["small-first", 0], ["random", 8]]) {
    const base = margin(b20.states[st].dem, b20.states[st].rep, b20.states[st].total);
    const imp = impliedUnits(b20, st, base); // forecast = repeat of 2020
    const expected = {};
    for (const [f, u] of Object.entries(imp.units)) if (b24.units[f]) expected[f] = { expected: u.expected, expectedVote: u.baseTotal };
    const truthLive = snapshotAt(makeReplay(b24, st, { order, skew }), Infinity);
    let tn = 0, tt = 0;
    for (const f of Object.keys(expected)) { const l = truthLive[f]; if (l) { tn += l.dem - l.rep; tt += l.total; } }
    const truth = (tn / tt) * 100;

    const rp = makeReplay(b24, st, { order, skew });
    const zero = estimate(expected, {}, { priorSd: 6 });
    assert.ok(Math.abs(zero.proj - base) < 0.8, `${st} empty ≈ forecast (${zero.proj} vs ${base})`);
    const done = estimate(expected, snapshotAt(rp, Infinity), { priorSd: 6 });
    assert.ok(Math.abs(done.proj - truth) < 1e-6, `${st} complete = truth`);
    worst = Math.max(worst, Math.abs(done.proj - truth));

    for (const frac of [0.25, 0.5, 0.75]) {
      const e = estimate(expected, snapshotAt(rp, Math.floor(rp.batches.length * frac)), { priorSd: 6 });
      checks++; if (truth >= e.lo && truth <= e.hi) covered++;
    }
  }
}
const cov = covered / checks;
console.log(`${states.length} states · ${checks} part-way checks · 90% interval covered ${(cov * 100).toFixed(1)}%`);
assert.ok(cov > 0.85, `coverage too low: ${cov}`);
console.log("ok");

// ---------------------------------------------------------------- NC with real vote types
// 2024 counted in NC's real order (early + mail at poll close, then Election Day
// precincts) against 2020 expectations. Without vote types the early/mail batch, which
// is most of the vote and leans bluer than the county will finish, should mislead the
// estimate; with them it shouldn't.
{
  const { ncExpected, makeNcReplay, ncSnapshotAt } = await import("../js/replay.js");
  const nc20 = JSON.parse(readFileSync(new URL("../data/nc/2020.json", import.meta.url)));
  const nc24 = JSON.parse(readFileSync(new URL("../data/nc/2024.json", import.meta.url)));
  const rp = makeNcReplay(nc24);
  const truth = estimate(ncExpected(nc20, nc24), ncSnapshotAt(rp, Infinity)).proj;
  const rows = [];
  let typedCovered = 0;
  const steps = [rp.nEarly, rp.nEarly + 40, rp.nEarly + 120, rp.nEarly + 240];
  for (const n of steps) {
    const t = estimate(ncExpected(nc20, nc24), ncSnapshotAt(rp, n), { priorSd: 6 });
    const u = estimate(ncExpected(nc20, nc24, { typed: false }), ncSnapshotAt(rp, n, { typed: false }), { priorSd: 6 });
    if (truth >= t.lo && truth <= t.hi) typedCovered++;
    rows.push({ step: n, counted: t.countedMargin.toFixed(1), typed: t.proj.toFixed(1), untyped: u.proj.toFixed(1),
                typedErr: Math.abs(t.proj - truth), untypedErr: Math.abs(u.proj - truth) });
  }
  console.log(`NC 2024 truth ${truth.toFixed(2)}`);
  console.table(rows.map((r) => ({ ...r, typedErr: r.typedErr.toFixed(2), untypedErr: r.untypedErr.toFixed(2) })));
  assert.ok(Math.abs(truth - (2715375 - 2898423) / 5699141 * 100) < 0.3, "NC truth ≈ official R+3.2");
  assert.ok(rows[0].typedErr < rows[0].untypedErr, "vote types beat county totals right after poll close");
  assert.equal(typedCovered, steps.length, "typed 90% range covers the result at every checkpoint");
  console.log("ok (NC vote types)");
}
