// Pure math, no DOM: shared by the page and by tests/model.test.mjs.
// Margins are Democratic minus Republican, in percentage points of the two-party-plus-other
// total, the same sign convention as VotePredictor's pred_margin.

export const margin = (dem, rep, total) => (total > 0 ? ((dem - rep) / total) * 100 : null);

// ---------------------------------------------------------------- layer 1

/** Statewide baseline margin from a baseline file's state totals. */
export function stateBaseMargin(baseline, st) {
  const s = baseline.states[st];
  return s ? margin(s.dem, s.rep, s.total) : null;
}

/**
 * Uniform swing: every unit in the state moves by the gap between the
 * statewide forecast and the statewide baseline. Returns {fips: {...}}.
 * This is a projection of the statewide number, not a county model.
 */
export function impliedUnits(baseline, st, predMargin) {
  const base = stateBaseMargin(baseline, st);
  if (base == null || predMargin == null) return null;
  const swing = predMargin - base;
  const out = {};
  for (const [fips, [name, ust, dem, rep, total]] of Object.entries(baseline.units)) {
    if (ust !== st) continue;
    const m0 = margin(dem, rep, total);
    out[fips] = { fips, name, st, base: m0, expected: clamp(m0 + swing, -100, 100), baseTotal: total };
  }
  return { swing, base, units: out };
}

// ---------------------------------------------------------------- layer 2

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, error < 1.5e-7). */
export function phi(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Inverse normal CDF (Acklam), used to read the forecast's spread off p_dem_win. */
export function phiInv(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const q = Math.min(Math.max(p, 1e-9), 1 - 1e-9);
  if (q < 0.02425) {
    const r = Math.sqrt(-2 * Math.log(q));
    return (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1);
  }
  if (q > 1 - 0.02425) return -phiInv(1 - q);
  const r = q - 0.5, s = r * r;
  return (((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1);
}

/**
 * The forecast's own spread, in margin points: pred_margin / z(p_dem_win).
 * Falls back when the probability is clamped (0.01/0.99), when the margin and
 * probability disagree in sign, or when the implied spread is implausible.
 */
export function priorSd(predMargin, pDemWin, fallback = 6) {
  if (predMargin == null || pDemWin == null || pDemWin <= 0.01 || pDemWin >= 0.99) return fallback;
  const z = phiInv(pDemWin);
  if (Math.abs(z) < 0.05 || Math.sign(z) !== Math.sign(predMargin)) return fallback;
  const sd = predMargin / z;
  return sd >= 2 && sd <= 20 ? sd : fallback;
}

/**
 * Election-night estimate for one statewide race.
 *
 * expected: {fips: {expected (margin), expectedVote}}   from layer 1 + a turnout assumption
 * live:     {fips: {dem, rep, total, pct_in?}}          from a results feed
 * opts:     {priorSd, modeSd, minIn}
 *
 * Method: the residual (actual − expected margin) in reporting units, weighted by
 * votes counted, estimates a common swing. That swing is shrunk toward zero by the
 * forecast's own spread (so with nothing counted the estimate IS the forecast), then
 * applied to each unit's uncounted vote. Uncertainty only applies to uncounted vote.
 */
export function estimate(expected, live, opts = {}) {
  if (Object.entries(expected).some(([f, e]) => e.types && live[f]?.by_type)) return estimateTyped(expected, live, opts);
  const { priorSd: sd0 = 6, modeSd = 2, provisionalSd = 6, completeAt = 0.95, minIn = 0.2 } = opts;
  const units = {};

  for (const [fips, e] of Object.entries(expected)) {
    const l = live[fips];
    const counted = l?.total || 0;
    let exp = e.expectedVote;
    if (l?.pct_in > 0.05) exp = counted / l.pct_in; // the feed's own expectation wins
    exp = Math.max(exp, counted);
    const frac = l?.pct_in != null ? Math.min(1, l.pct_in) : exp > 0 ? counted / exp : 0;
    const actual = counted > 0 ? margin(l.dem, l.rep, counted) : null;
    const resid = actual == null ? null : actual - e.expected;
    units[fips] = { fips, expected: e.expected, expVote: exp, counted, frac, actual, resid,
                    dem: l?.dem || 0, rep: l?.rep || 0 };
  }

  // Swing comes from COMPLETE units only. A partly counted unit's margin depends on
  // which ballots were counted first (mail often leans one way, Election Day the
  // other), and nothing in a county-total feed says which. Until some unit is
  // complete, partial units are used but the estimate is flagged provisional and
  // its spread widened.
  const all = Object.values(units).filter((u) => u.resid != null);
  let pool = all.filter((u) => u.frac >= completeAt);
  const provisional = pool.length === 0 && all.some((u) => u.frac >= minIn);
  if (provisional) pool = all.filter((u) => u.frac >= minIn);
  let W = 0, W2 = 0, Wr = 0, Wrr = 0;
  for (const u of pool) {
    W += u.counted; W2 += u.counted ** 2; Wr += u.counted * u.resid; Wrr += u.counted * u.resid ** 2;
  }
  const nRep = pool.length;

  // Common swing, shrunk toward 0 by the prior.
  let swing = 0, swingSd = sd0, residSd = null, nEff = 0;
  if (W > 0) {
    const mean = Wr / W;
    residSd = Math.sqrt(Math.max(Wrr / W - mean * mean, 0));
    nEff = (W * W) / W2;
    const s = Math.max(residSd, 1.5); // floor: a handful of near-identical counties isn't certainty
    const precData = nEff / (s * s), prec0 = 1 / (sd0 * sd0);
    swing = (mean * precData) / (precData + prec0);
    swingSd = Math.sqrt(1 / (precData + prec0));
  }

  let net = 0, total = 0, counted = 0, remaining = 0, projected = 0, idio = 0;
  const unitSd = residSd ?? 3; // county-to-county scatter around the common swing
  for (const u of Object.values(units)) {
    const done = u.frac >= completeAt;
    const left = done ? 0 : Math.max(u.expVote - u.counted, 0);
    u.projected = clamp(u.expected + (done ? u.resid : swing), -100, 100);
    u.remaining = left;
    // A partly counted unit is anchored on its projected FINAL margin, so the
    // uncounted part absorbs whatever lean the counted part had. If early mail
    // ran 8 points bluer than the county will finish, the rest is assumed redder.
    net += done ? u.dem - u.rep : (u.projected / 100) * (u.counted + left);
    total += u.counted + left;
    if (!done) { projected += u.counted + left; idio += ((u.counted + left) * unitSd) ** 2; }
    counted += u.counted;
    remaining += left;
  }

  const share = total > 0 ? remaining / total : 1;
  const proj = total > 0 ? (net / total) * 100 : null;
  // Error lives in the vote of units that aren't complete (their final margin is a
  // projection): the shared swing error, an order-of-count term, and each unit's
  // own scatter, which averages down across many units.
  const pShare = total > 0 ? projected / total : 1;
  const order = W > 0 ? (provisional ? provisionalSd : modeSd) : 0;
  const sd = Math.max(Math.sqrt((pShare * swingSd) ** 2 + (pShare * order) ** 2 + (total > 0 ? idio / total ** 2 : 0)), 0.05);
  let cnet = 0;
  for (const u of Object.values(units)) cnet += u.dem - u.rep;
  return {
    units, typed: false, swing, swingSd, residSd, nEff, nReporting: nRep, provisional,
    counted, remaining, share, projectedShare: pShare, proj, sd,
    countedMargin: counted > 0 ? (cnet / counted) * 100 : null,
    lo: proj - 1.645 * sd, hi: proj + 1.645 * sd,
    pDem: proj == null ? null : phi(proj / sd),
  };
}

const TYPES = ["early", "mail", "eday", "prov"];

/**
 * The same estimate when the feed splits each county by vote type (early, mail,
 * Election Day, provisional), as North Carolina's does.
 *
 * Early and mail ballots arrive first and lean differently from Election Day, and how
 * much they differ changes from one election to the next as voters switch methods.
 * So early and mail returns are NOT read as a swing on their own (the evidence says
 * they don't forecast results). A county tells us its swing once its Election Day
 * vote starts coming in:
 *
 *   county final ≈ each vote type's count so far, extended to that type's expected vote
 *                  at the margin it is running (early and mail are usually all in;
 *                  Election Day precincts are extrapolated within Election Day)
 *
 * The county's swing is that final minus its expected margin, trusted in proportion to
 * how much of its Election Day vote is in. The vote-weighted swing across those
 * counties, shrunk toward zero as before, sets every other county's final margin; each
 * county is anchored on that final, so its uncounted Election Day vote absorbs whatever
 * lean its early and mail ballots had.
 */
export function estimateTyped(expected, live, opts = {}) {
  const { priorSd: sd0 = 6, typedModeSd = 1.5, completeAt = 0.95, minEday = 0.1 } = opts;
  const units = {};
  const typeTot = Object.fromEntries(TYPES.map((t) => [t, { type: t, counted: 0, net: 0, expVote: 0 }]));

  for (const [fips, e] of Object.entries(expected)) {
    const bt = live[fips]?.by_type || {};
    const cells = {};
    let V = 0, counted = 0, net = 0;
    for (const t of TYPES) {
      const l = bt[t] || {}, n = l.total || 0;
      let E = e.types?.[t]?.expectedVote ?? 0;
      if (l.pct_in > 0.05) E = n / l.pct_in;
      else if (l.expected_vote) E = l.expected_vote;
      E = Math.max(E, n);
      cells[t] = { counted: n, net: (l.dem || 0) - (l.rep || 0), E };
      V += E; counted += n; net += cells[t].net;
      const tt = typeTot[t]; tt.counted += n; tt.net += cells[t].net; tt.expVote += E;
    }
    const ed = cells.eday, fE = ed.E > 0 ? Math.min(1, ed.counted / ed.E) : counted > 0 ? 1 : 0;
    // County final from its own counts, each type extended at the margin it is running.
    let est = null;
    if (fE >= minEday && V > 0) {
      let n = 0;
      for (const c of Object.values(cells)) n += c.counted > 0 ? c.net * (c.E / c.counted) : (e.expected / 100) * c.E;
      est = (n / V) * 100;
    }
    units[fips] = { fips, expected: e.expected, expVote: V, counted, frac: V > 0 ? Math.min(1, counted / V) : 0,
                    fE, est, resid: est == null ? null : est - e.expected,
                    actual: counted > 0 ? (net / counted) * 100 : null, dem: 0, rep: 0, net, cells };
  }

  // Swing from counties with Election Day vote in, weighted by how much of it is in.
  let W = 0, W2 = 0, Wr = 0, Wrr = 0, nRep = 0;
  for (const u of Object.values(units)) {
    if (u.resid == null) continue;
    const w = u.expVote * u.fE;
    W += w; W2 += w * w; Wr += w * u.resid; Wrr += w * u.resid ** 2; nRep++;
  }
  let swing = 0, swingSd = sd0, residSd = null, nEff = 0;
  if (W > 0) {
    const mean = Wr / W;
    residSd = Math.sqrt(Math.max(Wrr / W - mean * mean, 0));
    nEff = (W * W) / W2;
    const prec = nEff / Math.max(residSd, 1.5) ** 2, prec0 = 1 / sd0 ** 2;
    swing = (mean * prec) / (prec + prec0);
    swingSd = Math.sqrt(1 / (prec + prec0));
  }

  let net = 0, total = 0, counted = 0, open = 0, idio = 0;
  const unitSd = residSd ?? 3;
  for (const u of Object.values(units)) {
    const anchor = clamp(u.expected + swing, -100, 100);
    const done = u.fE >= completeAt && u.est != null;
    u.projected = done ? u.est : u.est != null ? u.fE * u.est + (1 - u.fE) * anchor : anchor;
    const vote = Math.max(u.expVote, u.counted);
    net += (u.projected / 100) * vote;
    total += vote; counted += u.counted;
    u.remaining = Math.max(vote - u.counted, 0);
    const openShare = done ? 0 : 1 - (u.est != null ? u.fE : 0); // how much of this county is projection
    open += vote * openShare;
    idio += (vote * openShare * unitSd) ** 2;
  }

  const proj = total > 0 ? (net / total) * 100 : null;
  const pShare = total > 0 ? open / total : 1;
  const order = W > 0 ? typedModeSd : 0; // precincts within a county don't report at random
  const sd = Math.max(Math.sqrt((pShare * swingSd) ** 2 + (pShare * order) ** 2 + (total > 0 ? idio / total ** 2 : 0)), 0.05);
  const cnet = Object.values(units).reduce((a, u) => a + u.net, 0);
  return {
    units, typed: true, swing, swingSd, residSd, nEff, nReporting: nRep, provisional: false,
    byType: TYPES.map((t) => ({ ...typeTot[t], countedMargin: typeTot[t].counted > 0 ? (typeTot[t].net / typeTot[t].counted) * 100 : null }))
                 .filter((r) => r.expVote > 0 || r.counted > 0),
    counted, remaining: Math.max(total - counted, 0), share: total > 0 ? Math.max(total - counted, 0) / total : 1,
    projectedShare: pShare, proj, sd, countedMargin: counted > 0 ? (cnet / counted) * 100 : null,
    lo: proj - 1.645 * sd, hi: proj + 1.645 * sd,
    pDem: proj == null ? null : phi(proj / sd),
  };
}

export function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
