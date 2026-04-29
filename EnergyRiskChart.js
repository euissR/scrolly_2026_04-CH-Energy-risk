import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.8.5/+esm";

// ─── Fuel → color mapping (fossil → renewable) ───────────────────────────────
export const FUEL_COLORS = {
  "Coal":                                                    "#33163a",
  "Gas (pipeline)":                                          "#1d3956",
  "Gas (pipeline, excluding Norway and United Kingdom)":     "#376882",
  "Gas (LNG)":                                              "#309ebe",
  "Oil and petroleum products":                             "#df3144",
  "Uranium":                                                "#595959",
  "Hydro":                                                  "#64C2C7",
  "Onshore Wind":                                           "#99cb92",
  "Offshore Wind":                                          "#4cb748",
  "Solar":                                                  "#ffde75",
};

const DOTS_PER_UNIT  = 40;   // particles per unit of risk value
const MIN_DOTS       = 3;    // minimum new particles per step addition
const PARTICLE_R     = 3.75; // px
const FLIGHT_DUR     = 900;  // ms — particle flight time
const CELL_DELAY     = 650;  // ms — wait before circle/counter animate

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function circleClipPoly(cx, cy, r, n = 72) {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}

function isInside([px, py], [ax, ay], [bx, by]) {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax) >= 0;
}

function edgeIntersect([ax, ay], [bx, by], [cx, cy], [dx, dy]) {
  const a1 = by - ay, b1 = ax - bx;
  const a2 = dy - cy, b2 = cx - dx;
  const det = a1 * b2 - a2 * b1;
  if (Math.abs(det) < 1e-12) return [(ax + bx) / 2, (ay + by) / 2];
  const c1 = a1 * ax + b1 * ay, c2 = a2 * cx + b2 * cy;
  return [(c1 * b2 - c2 * b1) / det, (a1 * c2 - a2 * c1) / det];
}

function clipToConvex(subj, clip) {
  let out = subj.slice();
  for (let i = 0, n = clip.length; i < n; i++) {
    if (!out.length) return [];
    const inp = out.slice(); out = [];
    const A = clip[i], B = clip[(i + 1) % n];
    for (let j = 0, m = inp.length; j < m; j++) {
      const cur = inp[j], prev = inp[(j + m - 1) % m];
      const curIn  = isInside(cur,  A, B);
      const prevIn = isInside(prev, A, B);
      if (curIn) {
        if (!prevIn) out.push(edgeIntersect(prev, cur, A, B));
        out.push(cur);
      } else if (prevIn) {
        out.push(edgeIntersect(prev, cur, A, B));
      }
    }
  }
  return out;
}

function polyArea(pts) {
  let s = 0, n = pts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    s += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  }
  return Math.abs(s) / 2;
}

function polyCentroid(pts) {
  let ax = 0, ay = 0, area = 0, n = pts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const cross = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    area += cross;
    ax += (pts[j][0] + pts[i][0]) * cross;
    ay += (pts[j][1] + pts[i][1]) * cross;
  }
  area /= 2;
  if (Math.abs(area) < 1e-10)
    return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
  return [ax / (6 * area), ay / (6 * area)];
}

/** Ray-casting point-in-polygon. */
function pointInPolygon([px, py], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

/** Sample n random points inside a polygon (rejection sampling). */
function sampleInPolygon(polygon, n) {
  if (!polygon || polygon.length < 3) return [];
  const xs = polygon.map(p => p[0]), ys = polygon.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const pts = [];
  let attempts = 0;
  while (pts.length < n && attempts < n * 30) {
    const x = minX + Math.random() * (maxX - minX);
    const y = minY + Math.random() * (maxY - minY);
    if (pointInPolygon([x, y], polygon)) pts.push([x, y]);
    attempts++;
  }
  // Fallback: centroid jitter for any remaining
  if (pts.length < n) {
    const [cx, cy] = polyCentroid(polygon);
    const jitter   = Math.min(maxX - minX, maxY - minY) * 0.15;
    while (pts.length < n)
      pts.push([cx + (Math.random() - 0.5) * jitter, cy + (Math.random() - 0.5) * jitter]);
  }
  return pts;
}

// ─── Weighted CVT ─────────────────────────────────────────────────────────────

// ─── Exact-area recursive polygon partitioning ───────────────────────────────

/** Clip convex polygon to the half-plane coord ≤ threshold (horiz) or coord ≥ (upper). */
function clipToHalf(polygon, threshold, horizontal, keepLower) {
  const out = [];
  const n   = polygon.length;
  for (let i = 0; i < n; i++) {
    const cur  = polygon[i];
    const next = polygon[(i + 1) % n];
    const cv   = horizontal ? cur[1]  : cur[0];
    const nv   = horizontal ? next[1] : next[0];
    const cIn  = keepLower  ? cv <= threshold : cv >= threshold;
    const nIn  = keepLower  ? nv <= threshold : nv >= threshold;
    if (cIn) out.push(cur);
    if (cIn !== nIn) {
      const t = (threshold - cv) / (nv - cv);
      out.push([cur[0] + t * (next[0] - cur[0]), cur[1] + t * (next[1] - cur[1])]);
    }
  }
  return out;
}

/** Binary-search for the cut position that gives the left/upper polygon
 *  exactly targetFraction of the input polygon's area. */
function splitByFraction(polygon, targetFraction, horizontal) {
  const totalArea  = polyArea(polygon);
  const targetArea = totalArea * targetFraction;
  const coords     = polygon.map(p => horizontal ? p[1] : p[0]);
  let lo = Math.min(...coords), hi = Math.max(...coords);

  let bestLeft = polygon, bestRight = polygon;
  for (let it = 0; it < 64; it++) {
    const mid   = (lo + hi) / 2;
    const left  = clipToHalf(polygon, mid, horizontal, true);
    const right = clipToHalf(polygon, mid, horizontal, false);
    const lArea = left.length  >= 3 ? polyArea(left)  : 0;
    if (lArea < targetArea) lo = mid; else hi = mid;
    if (left.length  >= 3) bestLeft  = left;
    if (right.length >= 3) bestRight = right;
  }
  return [bestLeft, bestRight];
}

/** Recursively partition a convex polygon into cells whose areas are
 *  exactly proportional to data[i].value. Alternates H/V splits. */
function partitionPolygon(polygon, data, depth = 0) {
  if (!data.length) return [];
  if (data.length === 1) return [{ ...data[0], polygon }];

  const total = data.reduce((s, d) => s + d.value, 0);

  // Find the split index closest to 50/50 by cumulative weight
  let cum = 0, splitIdx = 1;
  for (let i = 0; i < data.length - 1; i++) {
    const next = cum + data[i].value / total;
    // Take whichever split point is closer to 0.5
    if (Math.abs(next - 0.5) < Math.abs(cum - 0.5)) splitIdx = i + 1;
    cum = next;
    if (cum >= 0.5) break;
  }

  const leftData  = data.slice(0, splitIdx);
  const rightData = data.slice(splitIdx);
  const leftFrac  = leftData.reduce((s, d) => s + d.value, 0) / total;
  const horiz     = depth % 2 === 0; // alternate H / V

  const [leftPoly, rightPoly] = splitByFraction(polygon, leftFrac, horiz);

  return [
    ...partitionPolygon(leftPoly,  leftData,  depth + 1),
    ...partitionPolygon(rightPoly, rightData, depth + 1),
  ];
}

/** Build per-fuel cells with exactly proportional areas from a circle. */
function computePartition(data, cx, cy, radius) {
  if (!data.length) return [];
  if (data.length === 1) {
    return [{ ...data[0], polygon: circleClipPoly(cx, cy, radius, 72) }];
  }
  const circlePoly = circleClipPoly(cx, cy, radius, 72);
  return partitionPolygon(circlePoly, data, 0);
}

// ─── EnergyRiskChart ──────────────────────────────────────────────────────────

export class EnergyRiskChart {
  constructor(container, scenarioNum, allData, globalMaxCumulative) {
    this.container           = container;
    this.scenarioNum         = scenarioNum;
    this.globalMaxCumulative = globalMaxCumulative;
    this.currentStep         = 0;
    this.layouts             = {};

    this.scenarioData = allData.filter(d => d.scenario === scenarioNum);
    this.maxStep      = d3.max(this.scenarioData, d => d.step) || 1;

    const rect     = container.getBoundingClientRect();
    this.width     = rect.width  || 600;
    this.height    = Math.min(this.width * 0.88, window.innerHeight * 0.88);
    this.cx        = this.width  / 2;
    this.cy        = this.height / 2;
    this.maxRadius = Math.min(this.width, this.height) * 0.40;
    this.minRadius = this.maxRadius * 0.10;

    this._init();
  }

  // ── Data helpers ──────────────────────────────────────────────────────────

  /** Aggregate scenario data by fuel for all steps up to `step`.
   *  Returns one entry per fuel with { fuel, value (total), prevValue (steps < step) }. */
  _fuelDataForStep(step) {
    const map = new Map();
    this.scenarioData.forEach(d => {
      if (d.step > step) return;
      if (!map.has(d.fuel)) map.set(d.fuel, { fuel: d.fuel, value: 0, prevValue: 0 });
      const entry = map.get(d.fuel);
      entry.value += d.value;
      if (d.step < step) entry.prevValue += d.value;
    });
    return Array.from(map.values());
  }

  _cumVal(step) {
    return this.scenarioData.filter(d => d.step <= step).reduce((s, d) => s + d.value, 0);
  }

  _radius(cumVal) {
    if (!this.globalMaxCumulative) return this.maxRadius;
    return Math.max(this.minRadius, this.maxRadius * Math.sqrt(cumVal / this.globalMaxCumulative));
  }

  // ── Precomputation ────────────────────────────────────────────────────────

  _precompute() {
    for (let step = 1; step <= this.maxStep; step++) {
      const fuelData = this._fuelDataForStep(step);
      const cumVal   = this._cumVal(step);
      const radius   = this._radius(cumVal);

      // Exact-area partition (recursive binary split of the circle)
      const cells = computePartition(fuelData, this.cx, this.cy, radius);

      // ── Dot count from ACTUAL cell area, not target value ─────────────────
      // This guarantees uniform dot density across all cells regardless of
      // how well the WCVT converged. The areas do the proportionality work;
      // dots just fill each area evenly.
      const totalActualArea = cells.reduce((s, c) =>
        s + (c.polygon ? polyArea(c.polygon) : 0), 0);
      const totalDots = Math.max(MIN_DOTS * cells.length,
                                 Math.round(cumVal * DOTS_PER_UNIT));

      cells.forEach(cell => {
        const actualArea = cell.polygon ? polyArea(cell.polygon) : 0;
        const totalCount = Math.max(MIN_DOTS,
          Math.round((actualArea / totalActualArea) * totalDots));

        // prevCount: how many dots this fuel had in the previous step layout
        // (look up actual count, not recompute from value)
        const prevLayout = this.layouts[step - 1];
        const prevCell   = prevLayout?.cells.find(c => c.fuel === cell.fuel);
        const prevCount  = prevCell?.totalCount || 0;

        cell.particles  = cell.polygon ? sampleInPolygon(cell.polygon, totalCount) : [];
        cell.totalCount = totalCount;
        cell.prevCount  = prevCount;
        cell.newCount   = Math.max(0, totalCount - prevCount);
      });

      this.layouts[step] = { cells, radius, cumVal };
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  _init() {
    this.svg = d3.select(this.container)
      .append("svg")
      .attr("width",  this.width)
      .attr("height", this.height)
      .attr("class",  "energy-risk-svg");

    // Dashed reference circle
    this.circleBorder = this.svg.append("circle")
      .attr("cx", this.cx).attr("cy", this.cy).attr("r", 0)
      .attr("fill", "none").attr("stroke", "#bbb")
      .attr("stroke-width", 1).attr("stroke-dasharray", "4 3");

    // Counter
    this.valueLabel = this.svg.append("text")
      .attr("x", this.cx).attr("y", this.height - 36)
      .attr("text-anchor", "middle")
      .style("font-size", "12px").style("fill", "#666")
      .style("font-weight", "400").style("opacity", 0)
      .text("Cumulative risk index");

    this.valueNumber = this.svg.append("text")
      .attr("x", this.cx).attr("y", this.height - 8)
      .attr("text-anchor", "middle")
      .style("font-size", "36px").style("fill", "#333")
      .style("font-weight", "700").style("opacity", 0);

    // Voronoi cell borders (rendered below particle clouds)
    this.bordersGroup = this.svg.append("g").attr("class", "fuel-borders");

    // One <g> per fuel for particle clouds (z-order: all clouds below legend)
    this.fuelGroups = new Map();
    const fuels = [...new Set(this.scenarioData.map(d => d.fuel))];
    fuels.forEach(fuel => {
      this.fuelGroups.set(fuel,
        this.svg.append("g").attr("class", "fuel-cloud").attr("data-fuel", fuel)
      );
    });

    this._precompute();
    this._setupLegend();
    this._setupTooltip();
  }

  // ── Legend ────────────────────────────────────────────────────────────────

  _setupLegend() {
    const fuels  = [...new Set(this.scenarioData.map(d => d.fuel))];
    const ROW_H  = 18, DOT_W = 10, MARGIN = 14;
    const totalH = fuels.length * ROW_H;
    const startY = (this.height - totalH) / 2;
    const dotX   = this.width - MARGIN - DOT_W;

    this.legendGroup = this.svg.append("g").attr("class", "risk-legend");
    fuels.forEach((fuel, i) => {
      const row = this.legendGroup.append("g").attr("transform", `translate(0,${startY + i * ROW_H})`);
      row.append("rect").attr("x", dotX).attr("y", 0)
        .attr("width", DOT_W).attr("height", DOT_W).attr("rx", 2)
        .attr("fill", FUEL_COLORS[fuel] || "#aaa");
      row.append("text").attr("x", dotX - 5).attr("y", 9)
        .attr("text-anchor", "end").style("font-size", "10px").style("fill", "#444")
        .text(fuel);
    });
  }

  _updateLegendPosition() {
    if (!this.legendGroup) return;
    const fuels  = [...new Set(this.scenarioData.map(d => d.fuel))];
    const ROW_H  = 18, DOT_W = 10, MARGIN = 14;
    const startY = (this.height - fuels.length * ROW_H) / 2;
    const dotX   = this.width - MARGIN - DOT_W;
    this.legendGroup.selectAll("g").each(function(_, i) {
      d3.select(this).attr("transform", `translate(0,${startY + i * ROW_H})`);
      d3.select(this).select("rect").attr("x", dotX);
      d3.select(this).select("text").attr("x", dotX - 5);
    });
  }

  // ── Tooltip ───────────────────────────────────────────────────────────────

  _setupTooltip() {
    this.tooltip = d3.select("body").select(".risk-tooltip");
    if (this.tooltip.empty()) {
      this.tooltip = d3.select("body").append("div")
        .attr("class", "risk-tooltip tooltip").style("opacity", 0);
    }
  }

  // ── Spawn point (random edge) ─────────────────────────────────────────────

  _spawnPoint() {
    const MARGIN = 80, W = this.width;
    // All particles rain in from the top edge
    return [Math.random() * W, -MARGIN];
  }

  // ── Step update ───────────────────────────────────────────────────────────

  updateStep(step) {
    const layout = this.layouts[step];
    if (!layout) return;
    this.currentStep = step;
    const { cells, radius, cumVal } = layout;

    // ── 1. Circle border (delayed) ──────────────────────────────────────────
    this.circleBorder
      .transition().delay(CELL_DELAY).duration(800).ease(d3.easeCubicOut)
      .attr("r", radius);

    // ── 2. Counter (delayed) ────────────────────────────────────────────────
    const prevVal = step > 1 ? (this.layouts[step - 1]?.cumVal || 0) : 0;
    const interp  = d3.interpolateNumber(prevVal, cumVal);
    const vn      = this.valueNumber;
    this.valueLabel.transition().delay(CELL_DELAY).duration(400).style("opacity", 1);
    this.valueNumber.transition().delay(CELL_DELAY).duration(800)
      .style("opacity", 1)
      .tween("text", () => t => vn.text(interp(t).toFixed(3)));

    // ── 3. Voronoi cell borders ────────────────────────────────────────────
    const borderSel = this.bordersGroup.selectAll("path.fuel-border")
      .data(cells.filter(c => c.polygon && c.polygon.length >= 3), c => c.fuel);

    borderSel.exit().transition().duration(400).style("opacity", 0).remove();

    borderSel
      .attr("d", c => "M" + c.polygon.map(p => p[0].toFixed(1) + "," + p[1].toFixed(1)).join("L") + "Z")
      .attr("fill", c => FUEL_COLORS[c.fuel] || "#aaa")
      .transition().delay(CELL_DELAY).duration(600)
      .style("opacity", 1);

    borderSel.enter().append("path")
      .attr("class", "fuel-border")
      .attr("fill", c => FUEL_COLORS[c.fuel] || "#aaa")
      .attr("fill-opacity", 0)
      .attr("stroke", "#ccc")
      .attr("stroke-width", 1)
      .style("cursor", "default")
      .style("opacity", 0)
      .attr("d", c => "M" + c.polygon.map(p => p[0].toFixed(1) + "," + p[1].toFixed(1)).join("L") + "Z")
      .on("mouseover", (event, c) => {
        d3.select(event.currentTarget).attr("fill-opacity", 0.12);
        this.tooltip.style("opacity", 1)
          .html(`<strong>${c.fuel}</strong><br/>Risk index: ${c.value.toFixed(4)}`);
      })
      .on("mousemove", event => {
        this.tooltip
          .style("left", (event.pageX + 12) + "px")
          .style("top",  (event.pageY - 10) + "px");
      })
      .on("mouseout", (event) => {
        d3.select(event.currentTarget).attr("fill-opacity", 0);
        this.tooltip.style("opacity", 0);
      })
      .transition().delay(CELL_DELAY).duration(800)
      .style("opacity", 1);

    // ── 4. Particles per fuel ───────────────────────────────────────────────
    cells.forEach(cell => {
      const { fuel, particles, totalCount, prevCount } = cell;
      const g = this.fuelGroups.get(fuel);
      if (!g) return;

      const color = FUEL_COLORS[fuel] || "#aaa";

      // Build particle data with spawn points pre-assigned for new particles
      const particleData = particles.slice(0, totalCount).map((pos, idx) => {
        const isNew      = idx >= prevCount;
        const [sx, sy]   = isNew ? this._spawnPoint() : [pos[0], pos[1]];
        return { idx, x: pos[0], y: pos[1], sx, sy, isNew, fuel, fuelValue: cell.value };
      });

      const sel = g.selectAll("circle.risk-particle")
        .data(particleData, d => `${d.fuel}|${d.idx}`);

      // EXIT — backscroll removes excess particles
      sel.exit()
        .transition().duration(400).style("opacity", 0).remove();

      // UPDATE — existing particles migrate to new voronoi positions
      sel.transition()
        .duration(FLIGHT_DUR).ease(d3.easeCubicInOut)
        .attr("cx", d => d.x)
        .attr("cy", d => d.y)
        .style("opacity", d => d.isNew ? 1.0 : 0.33);

      // ENTER — new particles fly in from the edge
      sel.enter()
        .append("circle")
        .attr("class", "risk-particle")
        .attr("r", PARTICLE_R)
        .attr("fill", color)
        .style("opacity", 0.9)
        .style("pointer-events", "none")
        .attr("cx", d => d.sx)
        .attr("cy", d => d.sy)
        .transition()
        .duration(FLIGHT_DUR)
        .ease(t => t * t)   // ease-in: accelerate into the circle
        .attr("cx", d => d.x)
        .attr("cy", d => d.y)
        .style("opacity", 1.0);
    });
  }

  // ── Resize ────────────────────────────────────────────────────────────────

  resize() {
    const rect     = this.container.getBoundingClientRect();
    this.width     = rect.width || 600;
    this.height    = Math.min(this.width * 0.88, window.innerHeight * 0.88);
    this.cx        = this.width  / 2;
    this.cy        = this.height / 2;
    this.maxRadius = Math.min(this.width, this.height) * 0.40;
    this.minRadius = this.maxRadius * 0.10;

    this.svg.attr("width", this.width).attr("height", this.height);
    this.circleBorder.attr("cx", this.cx).attr("cy", this.cy);
    this.valueLabel.attr("x", this.cx).attr("y", this.height - 36);
    this.valueNumber.attr("x", this.cx).attr("y", this.height - 8);
    this._updateLegendPosition();

    // Re-precompute with new dimensions then re-render
    this.layouts = {};
    this._precompute();
    if (this.currentStep > 0) {
      // Clear all fuel groups, borders and labels
      this.bordersGroup.selectAll("*").remove();
      this.fuelGroups.forEach(g => g.selectAll("*").remove());
      this.updateStep(this.currentStep);
    }
  }
}

export default EnergyRiskChart;
