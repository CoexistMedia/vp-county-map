// Map drawing. Uses the d3 and topojson globals loaded in index.html.
/* global d3, topojson */

const W = 960, H = 600;

/**
 * Build the drawable units: every county, except in states whose results are
 * reported statewide (Alaska, Connecticut), which are drawn as one shape keyed
 * by the two-digit state FIPS so they join to the baseline's statewide unit.
 */
export function buildUnits(topo, statewideFips) {
  const counties = topojson.feature(topo, topo.objects.counties).features
    .filter((f) => !statewideFips.has(f.id.slice(0, 2)));
  const states = topojson.feature(topo, topo.objects.states).features;
  const statewide = states.filter((f) => statewideFips.has(f.id));
  return {
    units: [...counties, ...statewide],
    states,
    stateMesh: topojson.mesh(topo, topo.objects.states, (a, b) => a !== b),
    nation: topojson.mesh(topo, topo.objects.states, (a, b) => a === b),
  };
}

/** True on touch screens and narrow windows, where a tap opens the bottom sheet instead of a hover tooltip. */
export const sheetMode = () => matchMedia("(hover: none), (max-width: 767px)").matches;

/**
 * Render (or re-render) units into the svg.
 * opts.focus: two-digit state FIPS to zoom to, or null for the whole country.
 * opts.fill(id) -> colour or null (null = no data, drawn neutral)
 * opts.opacity(id) -> 0..1
 * opts.tip(id) -> HTML string for the tooltip / sheet
 * opts.onClick(id), opts.action(id) -> {label} for a button in the mobile sheet
 */
export function render(svg, geo, opts) {
  const sel = d3.select(svg).attr("viewBox", `0 0 ${W} ${H}`);
  const focusUnits = opts.focus ? geo.units.filter((f) => f.id.slice(0, 2) === opts.focus) : geo.units;
  const focusStates = opts.focus ? geo.states.filter((f) => f.id === opts.focus) : geo.states;
  const proj = d3.geoAlbersUsa().fitExtent([[8, 8], [W - 8, H - 8]],
    { type: "FeatureCollection", features: focusStates });
  const path = d3.geoPath(proj);
  const none = cssVar("--map-none");

  sel.selectAll("g.units").data([0]).join("g").attr("class", "units")
    .selectAll("path.unit")
    .data(focusUnits, (d) => d.id)
    .join("path")
    .attr("class", "unit")
    .attr("d", path)
    .attr("fill", (d) => opts.fill(d.id) || none)
    .attr("fill-opacity", (d) => (opts.opacity ? opts.opacity(d.id) : 1))
    .on("mousemove", (ev, d) => { if (!sheetMode()) showTip(ev, opts.tip(d.id)); })
    .on("mouseleave", hideTip)
    .on("click", function (_ev, d) {
      if (sheetMode()) {
        d3.select(svg).selectAll("path.unit.on").classed("on", false);
        d3.select(this).classed("on", true).raise();
        return openSheet(opts.tip(d.id), opts.action?.(d.id), () => opts.onClick?.(d.id));
      }
      opts.onClick?.(d.id);
    });

  const mesh = opts.focus ? { type: "FeatureCollection", features: focusStates } : geo.stateMesh;
  sel.selectAll("path.states").data([mesh]).join("path").attr("class", "states").attr("d", path);
  sel.selectAll("path.outline").data([opts.focus ? mesh : geo.nation]).join("path").attr("class", "outline").attr("d", path);
  sel.selectAll("g.units").lower();
}

export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const tipEl = () => document.getElementById("tooltip");
function showTip(ev, html) {
  const el = tipEl();
  if (!html) return hideTip();
  el.innerHTML = html;
  el.hidden = false;
  const pad = 16, r = el.getBoundingClientRect();
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - pad;
  el.style.left = `${Math.max(8, x)}px`;
  el.style.top = `${Math.max(8, y)}px`;
}
function hideTip() { tipEl().hidden = true; }

function openSheet(html, action, onAction) {
  if (!html) return;
  const sheet = document.getElementById("sheet");
  document.getElementById("sheet-body").innerHTML = html
    + (action ? `<button class="btn" id="sheet-action">${action.label}</button>` : "");
  sheet.classList.add("open");
  document.getElementById("sheet-action")?.addEventListener("click", () => { closeSheet(); onAction(); });
}
export function closeSheet() {
  document.getElementById("sheet").classList.remove("open");
  d3.selectAll("#map path.unit.on").classed("on", false);
}

/**
 * Stepped margin scale in the site's party colours, like the bucketed shading on
 * network results maps: each step mixes --dem or --rep further away from the surface.
 * steps: the upper edge of each bucket in margin points.
 */
export function marginColor(steps = [5, 10, 20, 30]) {
  const dem = cssVar("--dem"), rep = cssVar("--rep"), base = cssVar("--surface");
  const shades = (c) => steps.map((_, i) => {
    const t = 0.3 + (0.7 * i) / (steps.length - 1);
    return i === steps.length - 1 ? d3.interpolateLab(c, "#000")(0.18) : d3.interpolateLab(base, c)(t);
  });
  const D = shades(dem), R = shades(rep);
  const bucket = (m) => { const a = Math.abs(m); const i = steps.findIndex((s) => a < s); return i === -1 ? steps.length - 1 : i; };
  const fn = (m) => (m == null ? null : m >= 0 ? D[bucket(m)] : R[bucket(m)]);
  fn.ramp = { D, R, steps };
  return fn;
}

/** Discrete legend: R buckets strongest-first, then D buckets weakest-first. */
export function legend(el, scale, { left = "R", right = "D", unit = "", extra = "" } = {}) {
  const { D, R, steps } = scale.ramp;
  const sw = (c) => `<i style="background:${c}"></i>`;
  el.innerHTML = `<span>${left}+${steps[steps.length - 2]}${unit}</span>`
    + `<span class="ramp">${[...R].reverse().map(sw).join("")}${D.map(sw).join("")}</span>`
    + `<span>${right}+${steps[steps.length - 2]}${unit}</span>${extra ? `<span class="note">${extra}</span>` : ""}`;
}
