import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.8.5/+esm";

// ─── Fuel → color mapping (fossil → renewable) ───────────────────────────────
export const FUEL_COLORS = {
  Coal: "#33163A",
  "Gas (pipeline)": "#343151",
  "Gas (pipeline excluding NO and UK)": "#354C69",
  "Gas (LNG)": "#376882",
  "Oil and petroleum products": "#468699",
  "Uranium (AVERAGE)": "#55A4B0",
  Hydro: "#64C2C7",
  "Onshore Wind": "#97CBAB",
  "Offshore Wind": "#CBD490",
  Solar: "#FFDE75",
};

const NORM_N = 64; // polygon vertex count for animation interpolation
const WCVT_ITERS = 50; // Lloyd's relaxation iterations
const MIN_LABEL_AREA = 1800; // px² threshold to render a risk-type label

// ─── Geometry helpers ─────────────────────────────────────────────────────────

/** Approximate circle as a clockwise convex polygon (SVG coords). */
function circleClipPoly(cx, cy, r, n = 72) {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI; // clockwise in SVG (y-down)
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}

/**
 * Is point P to the interior side of directed edge A→B?
 * For a clockwise polygon in SVG coords, interior = cross ≥ 0.
 */
function isInside([px, py], [ax, ay], [bx, by]) {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax) >= 0;
}

function edgeIntersect([ax, ay], [bx, by], [cx, cy], [dx, dy]) {
  const a1 = by - ay,
    b1 = ax - bx;
  const a2 = dy - cy,
    b2 = cx - dx;
  const det = a1 * b2 - a2 * b1;
  if (Math.abs(det) < 1e-12) return [(ax + bx) / 2, (ay + by) / 2];
  const c1 = a1 * ax + b1 * ay,
    c2 = a2 * cx + b2 * cy;
  return [(c1 * b2 - c2 * b1) / det, (a1 * c2 - a2 * c1) / det];
}

/** Sutherland-Hodgman clip of subject polygon against a convex clip polygon. */
function clipToConvex(subj, clip) {
  let out = subj.slice();
  for (let i = 0, n = clip.length; i < n; i++) {
    if (!out.length) return [];
    const inp = out.slice();
    out = [];
    const A = clip[i],
      B = clip[(i + 1) % n];
    for (let j = 0, m = inp.length; j < m; j++) {
      const cur = inp[j],
        prev = inp[(j + m - 1) % m];
      const curIn = isInside(cur, A, B),
        prevIn = isInside(prev, A, B);
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
  let s = 0,
    n = pts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    s += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  }
  return Math.abs(s) / 2;
}

function polyCentroid(pts) {
  let ax = 0,
    ay = 0,
    area = 0,
    n = pts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const cross = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    area += cross;
    ax += (pts[j][0] + pts[i][0]) * cross;
    ay += (pts[j][1] + pts[i][1]) * cross;
  }
  area /= 2;
  if (Math.abs(area) < 1e-10)
    return [
      pts.reduce((s, p) => s + p[0], 0) / n,
      pts.reduce((s, p) => s + p[1], 0) / n,
    ];
  return [ax / (6 * area), ay / (6 * area)];
}

/**
 * Resample polygon to exactly n equidistant points along its perimeter.
 * Both source and target polygons are normalized to the same n before
 * animation — enabling linear vertex interpolation without topology issues.
 */
function normalizePoly(poly, n = NORM_N) {
  if (!poly || poly.length < 3) return null;
  const M = poly.length;
  const cum = new Float64Array(M + 1);
  for (let i = 0; i < M; i++) {
    const dx = poly[(i + 1) % M][0] - poly[i][0];
    const dy = poly[(i + 1) % M][1] - poly[i][1];
    cum[i + 1] = cum[i] + Math.sqrt(dx * dx + dy * dy);
  }
  const total = cum[M];
  if (total < 1e-10) return Array.from({ length: n }, () => [...poly[0]]);
  const res = [];
  for (let k = 0; k < n; k++) {
    const t = (k / n) * total;
    let lo = 0,
      hi = M - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    const dt = cum[lo + 1] - cum[lo];
    const f = dt < 1e-10 ? 0 : (t - cum[lo]) / dt;
    const a = poly[lo],
      b = poly[(lo + 1) % M];
    res.push([a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])]);
  }
  return res;
}

function pathFromNormed(pts) {
  return (
    "M" +
    pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("L") +
    "Z"
  );
}

// ─── Weighted CVT (approximate voronoi treemap) ───────────────────────────────

/**
 * Place initial Voronoi sites using a weighted sunflower packing.
 * Cells with larger target areas are seeded closer to the interior.
 */
function initSites(data, cx, cy, radius) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const φ = Math.PI * (3 - Math.sqrt(5)); // golden angle
  let cum = 0;
  return data.map((d, i) => {
    cum += d.value / total;
    const r = radius * 0.75 * Math.sqrt(Math.max(0, cum - d.value / total / 2));
    return [cx + r * Math.cos(i * φ), cy + r * Math.sin(i * φ)];
  });
}

/**
 * Compute an approximate weighted centroidal Voronoi tessellation.
 * Uses Lloyd's relaxation with an area-error correction term so that
 * each cell's area converges toward its target (value / total) fraction.
 */
function computeWCVT(data, cx, cy, radius) {
  if (!data.length) return [];

  if (data.length === 1) {
    const poly = circleClipPoly(cx, cy, radius, NORM_N);
    return [{ ...data[0], polygon: poly, normedPoly: normalizePoly(poly) }];
  }

  const total = data.reduce((s, d) => s + d.value, 0);
  const clip = circleClipPoly(cx, cy, radius, 72);
  const bounds = [
    cx - radius - 1,
    cy - radius - 1,
    cx + radius + 1,
    cy + radius + 1,
  ];
  const circArea = Math.PI * radius * radius;

  let sites = initSites(data, cx, cy, radius);

  for (let it = 0; it < WCVT_ITERS; it++) {
    const del = d3.Delaunay.from(sites);
    const vor = del.voronoi(bounds);

    sites = sites.map((s, i) => {
      const raw = vor.cellPolygon(i);
      if (!raw) return s;
      const cell = clipToConvex(Array.from(raw), clip);
      if (cell.length < 3) return s;

      const area = polyArea(cell);
      const target = (data[i].value / total) * circArea;
      const [gx, gy] = polyCentroid(cell);

      // Lloyd step toward centroid
      const alpha = 0.35;
      let nx = s[0] + alpha * (gx - s[0]);
      let ny = s[1] + alpha * (gy - s[1]);

      // Area-error correction: shrink/expand by nudging site radially
      if (area > 1e-6) {
        const ratio = target / area; // >1 means cell too small, <1 too large
        const correction = (ratio - 1) * 0.18;
        const dx = s[0] - cx,
          dy = s[1] - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 1e-6) {
          // Move toward/away from center to claim/yield area
          nx -= (dx / dist) * radius * correction;
          ny -= (dy / dist) * radius * correction;
        }
      }

      // Clamp within circle
      const ddx = nx - cx,
        ddy = ny - cy;
      const d2 = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d2 > radius * 0.96) {
        const sc = (radius * 0.96) / d2;
        return [cx + ddx * sc, cy + ddy * sc];
      }
      return [nx, ny];
    });
  }

  // Compute final clipped polygons
  const del = d3.Delaunay.from(sites);
  const vor = del.voronoi(bounds);

  return data.map((d, i) => {
    const raw = vor.cellPolygon(i);
    const poly = raw ? clipToConvex(Array.from(raw), clip) : null;
    return {
      ...d,
      polygon: poly,
      normedPoly: poly ? normalizePoly(poly) : null,
      site: sites[i],
    };
  });
}

// ─── EnergyRiskChart ──────────────────────────────────────────────────────────

export class EnergyRiskChart {
  /**
   * @param {Element}  container          - DOM element to render into
   * @param {number}   scenarioNum        - 1–5
   * @param {Array}    allData            - full parsed CSV array
   * @param {number}   globalMaxCumulative - max value_scenario across all scenarios (for scale)
   */
  constructor(container, scenarioNum, allData, globalMaxCumulative) {
    this.container = container;
    this.scenarioNum = scenarioNum;
    this.globalMaxCumulative = globalMaxCumulative;
    this.currentStep = 0;
    this.layouts = {}; // { step → { cells, radius, cumVal } }
    this.prevCells = null; // for polygon morph start

    this.scenarioData = allData.filter((d) => d.scenario === scenarioNum);
    this.maxStep = d3.max(this.scenarioData, (d) => d.step) || 1;

    const rect = container.getBoundingClientRect();
    this.width = rect.width || 600;
    this.height = Math.min(this.width * 0.88, window.innerHeight * 0.88);
    this.cx = this.width / 2;
    this.cy = this.height / 2;
    this.maxRadius = Math.min(this.width, this.height) * 0.4;
    this.minRadius = this.maxRadius * 0.1; // keeps tiny scenarios visible

    this._init();
  }

  // ── Data helpers ──────────────────────────────────────────────────────────

  _stepData(step) {
    return this.scenarioData.filter((d) => d.step <= step);
  }
  _cumVal(step) {
    return this._stepData(step).reduce((s, d) => s + d.value, 0);
  }
  _radius(cumVal) {
    if (!this.globalMaxCumulative) return this.maxRadius;
    return Math.max(
      this.minRadius,
      this.maxRadius * Math.sqrt(cumVal / this.globalMaxCumulative),
    );
  }

  // ── Pre-computation ───────────────────────────────────────────────────────

  _precompute() {
    for (let step = 1; step <= this.maxStep; step++) {
      const data = this._stepData(step);
      const cumVal = this._cumVal(step);
      const radius = this._radius(cumVal);
      const cells = computeWCVT(data, this.cx, this.cy, radius);
      this.layouts[step] = { cells, radius, cumVal };
    }
  }

  // ── Setup ─────────────────────────────────────────────────────────────────

  _init() {
    this.svg = d3
      .select(this.container)
      .append("svg")
      .attr("width", this.width)
      .attr("height", this.height)
      .attr("class", "energy-risk-svg");

    // Dashed reference circle (shows current scale)
    this.circleBorder = this.svg
      .append("circle")
      .attr("cx", this.cx)
      .attr("cy", this.cy)
      .attr("r", 0)
      .attr("fill", "none")
      .attr("stroke", "#bbb")
      .attr("stroke-width", 1)
      .attr("stroke-dasharray", "4 3");

    // Cumulative risk readout — static label + large animated number
    this.valueLabel = this.svg
      .append("text")
      .attr("x", this.cx)
      .attr("y", this.height - 36)
      .attr("text-anchor", "middle")
      .style("font-size", "12px")
      .style("fill", "#666")
      .style("font-weight", "400")
      .style("opacity", 0)
      .text("Cumulative risk index");

    this.valueNumber = this.svg
      .append("text")
      .attr("x", this.cx)
      .attr("y", this.height - 8)
      .attr("text-anchor", "middle")
      .style("font-size", "36px")
      .style("fill", "#333")
      .style("font-weight", "700")
      .style("opacity", 0);

    this.particlesGroup = this.svg.append("g").attr("class", "wcvt-particles");
    this.cellsGroup = this.svg.append("g").attr("class", "wcvt-cells");
    this.labelsGroup = this.svg.append("g").attr("class", "wcvt-labels");

    this._precompute();
    this._setupLegend();
    this._setupTooltip();
  }

  _setupLegend() {
    const fuels = [...new Set(this.scenarioData.map((d) => d.fuel))];
    const ROW_H = 18;
    const DOT_W = 10;
    const MARGIN = 14; // px from right edge to dot right edge
    const totalH = fuels.length * ROW_H;
    const startY = (this.height - totalH) / 2;
    const dotX = this.width - MARGIN - DOT_W; // left edge of dot rect

    this.legendGroup = this.svg.append("g").attr("class", "risk-legend");

    fuels.forEach((fuel, i) => {
      const y = startY + i * ROW_H;
      const row = this.legendGroup
        .append("g")
        .attr("transform", `translate(0,${y})`);

      // Dot at right margin
      row
        .append("rect")
        .attr("x", dotX)
        .attr("y", 0)
        .attr("width", DOT_W)
        .attr("height", DOT_W)
        .attr("rx", 2)
        .attr("fill", FUEL_COLORS[fuel] || "#aaa");

      // Label right-aligned to the left of the dot
      row
        .append("text")
        .attr("x", dotX - 5)
        .attr("y", 9)
        .attr("text-anchor", "end")
        .style("font-size", "10px")
        .style("fill", "#444")
        .text(fuel);
    });
  }

  _updateLegendPosition() {
    if (!this.legendGroup) return;
    const fuels = [...new Set(this.scenarioData.map((d) => d.fuel))];
    const ROW_H = 18;
    const DOT_W = 10;
    const MARGIN = 14;
    const totalH = fuels.length * ROW_H;
    const startY = (this.height - totalH) / 2;
    const dotX = this.width - MARGIN - DOT_W;

    this.legendGroup.selectAll("g").each(function (_, i) {
      d3.select(this).attr("transform", `translate(0,${startY + i * ROW_H})`);
      d3.select(this).select("rect").attr("x", dotX);
      d3.select(this)
        .select("text")
        .attr("x", dotX - 5);
    });
  }

  _setupTooltip() {
    // Reuse a shared tooltip if present, otherwise create one
    this.tooltip = d3.select("body").select(".risk-tooltip");
    if (this.tooltip.empty()) {
      this.tooltip = d3
        .select("body")
        .append("div")
        .attr("class", "risk-tooltip tooltip")
        .style("opacity", 0);
    }
  }

  // ── Step update ───────────────────────────────────────────────────────────

  updateStep(step) {
    const layout = this.layouts[step];
    if (!layout) return;
    this.currentStep = step;
    const { cells, radius, cumVal } = layout;

    // 1. Animate reference circle
    this.circleBorder
      .transition()
      .delay(500)
      .duration(800)
      .ease(d3.easeCubicOut)
      .attr("r", radius);

    // 2. Animate risk readout
    const prevVal = step > 1 ? this.layouts[step - 1]?.cumVal || 0 : 0;
    const interp = d3.interpolateNumber(prevVal, cumVal);
    const vn = this.valueNumber;
    this.valueLabel.transition().duration(400).style("opacity", 1);
    this.valueNumber
      .transition()
      .duration(800)
      .style("opacity", 1)
      .tween("text", () => (t) => vn.text(interp(t).toFixed(2)));

    // 3. Build lookup of previous normalized polygons (for UPDATE morph)
    const prevMap = new Map();
    if (this.prevCells) {
      this.prevCells.forEach((c) => {
        prevMap.set(`${c.fuel}|${c.name}|${c.step}`, c.normedPoly);
      });
    }

    const validCells = cells.filter((c) => c.polygon && c.polygon.length >= 3);
    const centerPoly = Array.from({ length: NORM_N }, () => [this.cx, this.cy]);

    const sel = this.cellsGroup
      .selectAll(".risk-cell")
      .data(validCells, (d) => `${d.fuel}|${d.name}|${d.step}`);

    // ENTER — new cells fly in from center
    sel
      .enter()
      .append("path")
      .attr("class", "risk-cell")
      .attr("fill", (d) => FUEL_COLORS[d.fuel] || "#aaa")
      .attr("stroke", "#fff")
      .attr("stroke-width", 0.8)
      .style("opacity", 0)
      .attr("d", pathFromNormed(centerPoly))
      .on("mouseover", (event, d) => {
        this.tooltip
          .style("opacity", 1)
          .html(
            `<strong>${d.fuel}</strong><br/>${d.name}: ${d.value.toFixed(4)}`,
          );
      })
      .on("mousemove", (event) => {
        this.tooltip
          .style("left", event.pageX + 12 + "px")
          .style("top", event.pageY - 10 + "px");
      })
      .on("mouseout", () => this.tooltip.style("opacity", 0))
      .transition()
      .duration(900)
      .ease(d3.easeCubicOut)
      .style("opacity", (d) => (d.step === step ? 1 : 0.33))
      .attrTween("d", (d) => {
        const target = d.normedPoly || normalizePoly(d.polygon, NORM_N);
        return (t) =>
          pathFromNormed(
            centerPoly.map((s, i) => [
              s[0] + t * (target[i][0] - s[0]),
              s[1] + t * (target[i][1] - s[1]),
            ]),
          );
      });

    // EXIT — cells that no longer belong in this step (e.g. on backscroll)
    sel
      .exit()
      .transition()
      .duration(500)
      .ease(d3.easeCubicIn)
      .style("opacity", 0)
      .remove();

    // UPDATE — existing cells morph to their new voronoi positions
    sel
      .transition()
      .duration(900)
      .ease(d3.easeCubicInOut)
      .style("opacity", (d) => (d.step === step ? 1 : 0.33))
      .attrTween("d", (d) => {
        const key = `${d.fuel}|${d.name}|${d.step}`;
        const start = prevMap.get(key) || normalizePoly(d.polygon, NORM_N);
        const end = d.normedPoly || normalizePoly(d.polygon, NORM_N);
        if (!start || !end) return () => "";
        return (t) =>
          pathFromNormed(
            start.map((s, i) => [
              s[0] + t * (end[i][0] - s[0]),
              s[1] + t * (end[i][1] - s[1]),
            ]),
          );
      });

    // Particle burst for newly entering cells
    const newCells = validCells.filter((c) => c.step === step);
    if (newCells.length) this._burstParticles(newCells, radius);

    this.prevCells = cells;
  }

  // ── Particle burst ────────────────────────────────────────────────────────

  _burstParticles(newCells, targetRadius) {
    const N_PER_CELL = 200; // particles per new cell — keep low for perf
    const DURATION = 700; // ms flight time
    const MARGIN = 60; // px beyond SVG edge for spawn point

    // Build a weighted color palette from the incoming cells
    const palette = newCells.map((c) => FUEL_COLORS[c.fuel] || "#aaa");

    const W = this.width,
      H = this.height;
    const cx = this.cx,
      cy = this.cy;

    // Generate spawn points randomly along all four outer edges
    function spawnPoint() {
      const edge = Math.floor(Math.random() * 4);
      switch (edge) {
        case 0:
          return [-MARGIN, Math.random() * H]; // left
        case 1:
          return [W + MARGIN, Math.random() * H]; // right
        case 2:
          return [Math.random() * W, -MARGIN]; // top
        default:
          return [Math.random() * W, H + MARGIN]; // bottom
      }
    }

    const total = newCells.length * N_PER_CELL;
    const data = Array.from({ length: total }, (_, i) => {
      const [sx, sy] = spawnPoint();
      // Land inside a small jitter radius around the circle centre
      const jitter = targetRadius * 0.35;
      const angle = Math.random() * 2 * Math.PI;
      const tx = cx + Math.cos(angle) * Math.random() * jitter;
      const ty = cy + Math.sin(angle) * Math.random() * jitter;
      return { sx, sy, tx, ty, color: palette[i % palette.length] };
    });

    const g = this.particlesGroup;

    data.forEach((d) => {
      const dot = g
        .append("circle")
        .attr("r", 2)
        .attr("cx", d.sx)
        .attr("cy", d.sy)
        .attr("fill", d.color)
        .style("opacity", 0.9)
        .style("pointer-events", "none");

      dot
        .transition()
        .duration(DURATION + Math.random() * 200) // slight stagger
        .ease((t) => t * t) // ease-in (accelerate in)
        .attr("cx", d.tx)
        .attr("cy", d.ty)
        .style("opacity", 0)
        .remove();
    });
  }

  // ── Resize ────────────────────────────────────────────────────────────────

  resize() {
    const rect = this.container.getBoundingClientRect();
    this.width = rect.width || 600;
    this.height = Math.min(this.width * 0.88, window.innerHeight * 0.88);
    this.cx = this.width / 2;
    this.cy = this.height / 2;
    this.maxRadius = Math.min(this.width, this.height) * 0.4;
    this.minRadius = this.maxRadius * 0.1;

    this.svg.attr("width", this.width).attr("height", this.height);
    this.circleBorder.attr("cx", this.cx).attr("cy", this.cy);
    this.valueLabel.attr("x", this.cx).attr("y", this.height - 36);
    this.valueNumber.attr("x", this.cx).attr("y", this.height - 8);
    this._updateLegendPosition();

    this.layouts = {};
    this._precompute();

    if (this.currentStep > 0) {
      this.prevCells = null;
      this.cellsGroup.selectAll("*").remove();
      this.labelsGroup.selectAll("*").remove();
      this.updateStep(this.currentStep);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _textColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.52 ? "#333" : "#fff";
}

export default EnergyRiskChart;
