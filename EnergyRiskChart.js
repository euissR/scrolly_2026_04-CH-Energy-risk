import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.8.5/+esm";

export const FUEL_COLORS = {
  "Coal":                                                "#33163a",
  "Gas (pipeline)":                                      "#1d3956",
  "Gas (pipeline, excluding Norway and United Kingdom)": "#376882",
  "Gas (LNG)":                                           "#309ebe",
  "Oil and petroleum products":                          "#df3144",
  "Uranium":                                             "#595959",
  "Hydro":                                               "#64C2C7",
  "Onshore Wind":                                        "#99cb92",
  "Offshore Wind":                                       "#4cb748",
  "Solar":                                               "#ffde75",
};

const ALL_FUELS   = Object.keys(FUEL_COLORS);
const MAX_DOT_R   = 240;  // px — 3× the previous 80px
const LABEL_FROM_CX = 20; // px left of cx (right edge)
const PAD_TOP     = 48;   // space for counter at top
const PAD_BOT     = 16;
const ANIM_DUR    = 900;

// ── Semicircle path (left half, center at x=cx, y=cy) ────────────────────────
function semicirclePath(cx, cy, r) {
  if (r < 0.5) return `M ${cx} ${cy}`;
  return `M ${cx} ${cy - r} A ${r} ${r} 0 0 0 ${cx} ${cy + r}`;
}

export class EnergyRiskChart {
  constructor(container, scenarioNum, allData, globalMaxFuelValue) {
    this.container          = container;
    this.scenarioNum        = scenarioNum;
    this.currentStep        = 0;
    this.globalMaxFuelValue = globalMaxFuelValue;

    this.scenarioData = allData.filter(d => d.scenario === scenarioNum);
    this.maxStep      = d3.max(this.scenarioData, d => d.step) || 1;

    this._measure();
    this._init();
  }

  // ── Layout helpers ────────────────────────────────────────────────────────

  _measure() {
    const rect    = this.container.getBoundingClientRect();
    this.width    = rect.width || 500;
    // 80% of viewport height, vertically centered via sticky container
    this.height   = Math.round(window.innerHeight * 0.80);
    const usable  = this.height - PAD_TOP - PAD_BOT;
    this.rowH     = usable / ALL_FUELS.length;
    this.cx       = this.width; // semicircle center x = right edge
  }

  _rowY(i) {
    return PAD_TOP + (i + 0.5) * this.rowH;
  }

  _fuelCumVal(fuel, step) {
    return this.scenarioData
      .filter(d => d.fuel === fuel && d.step <= step)
      .reduce((s, d) => s + d.value, 0);
  }

  _dotR(cumVal) {
    if (!cumVal || !this.globalMaxFuelValue) return 0;
    return MAX_DOT_R * Math.sqrt(cumVal / this.globalMaxFuelValue);
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  _init() {
    this.svg = d3.select(this.container)
      .append("svg")
      .attr("width",  this.width)
      .attr("height", this.height)
      .attr("class",  "energy-risk-svg")
      .style("overflow", "visible");

    // ── Counter (top, same style as before) ──────────────────────────────
    this.valueLabel = this.svg.append("text")
      .attr("x", this.width / 2)
      .attr("y", 18)
      .attr("text-anchor", "middle")
      .style("font-size", "12px").style("fill", "#666")
      .style("font-weight", "400").style("opacity", 0)
      .text("Cumulative risk index");

    this.valueNumber = this.svg.append("text")
      .attr("x", this.width / 2)
      .attr("y", 44)
      .attr("text-anchor", "middle")
      .style("font-size", "36px").style("fill", "#333")
      .style("font-weight", "700").style("opacity", 0);

    // ── Fuel rows ─────────────────────────────────────────────────────────
    this.fuelRows = new Map();

    ALL_FUELS.forEach((fuel, i) => {
      const y     = this._rowY(i);
      const color = FUEL_COLORS[fuel] || "#aaa";
      const g     = this.svg.append("g")
        .attr("class", "fuel-row")
        .attr("data-fuel", fuel);

      // Semicircle: starts at r=0
      const arc = g.append("path")
        .attr("class", "fuel-arc")
        .attr("d", semicirclePath(this.cx, y, 0))
        .attr("data-r", 0)
        .attr("fill", color)
        .attr("fill-opacity", 0.1)
        .attr("stroke", color)
        .attr("stroke-width", 1.5)
        .style("pointer-events", "all");

      // Label: 20px left of cx, right-aligned, white stroke for legibility
      const label = g.append("text")
        .attr("class", "fuel-row-label")
        .attr("x", this.cx - LABEL_FROM_CX)
        .attr("y", y)
        .attr("text-anchor", "end")
        .attr("dominant-baseline", "middle")
        .style("font-size", "11px")
        .style("font-weight", "500")
        .style("fill", "#333")
        .style("paint-order", "stroke")
        .style("stroke", "#fff")
        .style("stroke-width", "3px")
        .text(fuel);

      this.fuelRows.set(fuel, { g, arc, label, y });
    });

    this._setupTooltip();
  }

  // ── Tooltip ───────────────────────────────────────────────────────────────

  _setupTooltip() {
    this.tooltip = d3.select("body").select(".risk-tooltip");
    if (this.tooltip.empty()) {
      this.tooltip = d3.select("body").append("div")
        .attr("class", "risk-tooltip tooltip").style("opacity", 0);
    }
    this.fuelRows.forEach(({ arc }, fuel) => {
      arc
        .on("mouseover", (event) => {
          const v = this._fuelCumVal(fuel, this.currentStep);
          if (!v) return;
          this.tooltip.style("opacity", 1)
            .html(`<strong>${fuel}</strong><br/>Risk index: ${v.toFixed(4)}`);
        })
        .on("mousemove", event => {
          this.tooltip
            .style("left", (event.pageX + 12) + "px")
            .style("top",  (event.pageY - 10) + "px");
        })
        .on("mouseout", () => this.tooltip.style("opacity", 0));
    });
  }

  // ── Step update ───────────────────────────────────────────────────────────

  updateStep(step) {
    this.currentStep = step;

    ALL_FUELS.forEach((fuel, i) => {
      const row    = this.fuelRows.get(fuel);
      if (!row) return;
      const cumVal = this._fuelCumVal(fuel, step);
      const r      = this._dotR(cumVal);
      const y      = row.y;
      const cx     = this.cx;

      row.arc
        .transition()
        .duration(ANIM_DUR)
        .ease(d3.easeCubicOut)
        .attrTween("d", function() {
          const prev = +(d3.select(this).attr("data-r") || 0);
          const interp = d3.interpolateNumber(prev, r);
          return t => semicirclePath(cx, y, interp(t));
        })
        .on("end", function() { d3.select(this).attr("data-r", r); });

      // Dim fuels absent from this scenario
      row.label
        .transition().duration(400)
        .style("fill", cumVal > 0 ? "#333" : "#bbb");
    });

    // Counter
    const cumTotal  = this.scenarioData.filter(d => d.step <= step).reduce((s, d) => s + d.value, 0);
    const prevTotal = step > 1
      ? this.scenarioData.filter(d => d.step <= step - 1).reduce((s, d) => s + d.value, 0)
      : 0;
    const interp = d3.interpolateNumber(prevTotal, cumTotal);
    const vn = this.valueNumber;

    this.valueLabel.transition().duration(400).style("opacity", 1);
    this.valueNumber
      .transition().duration(ANIM_DUR)
      .style("opacity", 1)
      .tween("text", () => t => vn.text(interp(t).toFixed(3)));
  }

  // ── Resize ────────────────────────────────────────────────────────────────

  resize() {
    this._measure();
    this.svg.attr("width", this.width).attr("height", this.height);

    this.valueLabel.attr("x", this.width / 2);
    this.valueNumber.attr("x", this.width / 2);

    ALL_FUELS.forEach((fuel, i) => {
      const row = this.fuelRows.get(fuel);
      if (!row) return;
      const y = this._rowY(i);
      row.y = y;
      row.arc.attr("d", semicirclePath(this.cx, y, +(row.arc.attr("data-r") || 0)));
      row.label.attr("x", this.cx - LABEL_FROM_CX).attr("y", y);
    });

    if (this.currentStep > 0) this.updateStep(this.currentStep);
  }
}

export default EnergyRiskChart;
