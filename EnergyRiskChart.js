import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.8.5/+esm";

export const FUEL_COLORS = {
  Coal: "#33163a",
  "Gas (pipeline)": "#1d3956",
  "Gas (pipeline, excluding Norway and United Kingdom)": "#376882",
  "Gas (LNG)": "#309ebe",
  "Oil and petroleum products": "#df3144",
  Uranium: "#595959",
  Hydro: "#64C2C7",
  "Onshore Wind": "#99cb92",
  "Offshore Wind": "#4cb748",
  Solar: "#ffde75",
};

const ALL_FUELS = Object.keys(FUEL_COLORS);
const PAD_TOP = 64; // space for counter
const PAD_BOT = 16;
const BAR_PAD = 4; // gap between bars
const PAD_RIGHT = 24; // right margin inside SVG
const LABEL_PAD = 8; // gap between bar left edge and label
const MIN_BAR_W_LABEL = 60; // px — minimum bar width to show value counter
const MIN_BAR_W_FUEL = 120; // px — minimum bar width to show fuel label inside
const ANIM_DUR = 900;

// Luminance-based text color for readability on colored bars
function textColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.45 ? "#333" : "#fff";
}

export class EnergyRiskChart {
  constructor(container, scenarioNum, allData, globalMaxFuelValue) {
    this.container = container;
    this.scenarioNum = scenarioNum;
    this.currentStep = 0;
    this.globalMaxFuelValue = globalMaxFuelValue;

    this.scenarioData = allData.filter((d) => d.scenario === scenarioNum);
    this.maxStep = d3.max(this.scenarioData, (d) => d.step) || 1;

    this._measure();
    this._init();
  }

  // ── Layout ────────────────────────────────────────────────────────────────

  _measure() {
    const rect = this.container.getBoundingClientRect();
    this.width = rect.width || 500;
    this.height = Math.round(window.innerHeight * 0.8);
    const usable = this.height - PAD_TOP - PAD_BOT;
    this.rowH = usable / ALL_FUELS.length;
    this.barH = this.rowH - BAR_PAD * 2;
    // Usable bar width: full width minus right padding
    this.maxBarW = this.width - PAD_RIGHT * 10;

    // xScale: value → bar width (grows left from right edge)
    this.xScale = d3
      .scaleLinear()
      .domain([0, this.globalMaxFuelValue || 1])
      .range([0, this.maxBarW]);
  }

  _rowY(i) {
    return PAD_TOP + i * this.rowH + BAR_PAD;
  }
  _barCX(i) {
    return this._rowY(i) + this.barH / 2;
  } // vertical center

  _fuelCumVal(fuel, step) {
    return this.scenarioData
      .filter((d) => d.fuel === fuel && d.step <= step)
      .reduce((s, d) => s + d.value, 0);
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  _init() {
    this.svg = d3
      .select(this.container)
      .append("svg")
      .attr("width", this.width)
      .attr("height", this.height)
      .attr("class", "energy-risk-svg");

    // Counter at top
    this.valueLabel = this.svg
      .append("text")
      .attr("x", this.width / 2)
      .attr("y", 18)
      .attr("text-anchor", "middle")
      .style("font-size", "12px")
      .style("fill", "#666")
      .style("font-weight", "400")
      .style("opacity", 0)
      .text("Cumulative risk index");

    this.valueNumber = this.svg
      .append("text")
      .attr("x", this.width / 2)
      .attr("y", 52)
      .attr("text-anchor", "middle")
      .style("font-size", "36px")
      .style("fill", "#333")
      .style("font-weight", "700")
      .style("opacity", 0);

    // Fuel rows
    this.fuelRows = new Map();

    ALL_FUELS.forEach((fuel, i) => {
      const color = FUEL_COLORS[fuel] || "#aaa";
      const y = this._rowY(i);
      const midY = y + this.barH / 2;
      const rightX = this.width - PAD_RIGHT;
      const g = this.svg.append("g").attr("class", "fuel-row");

      // Bar rect — anchored to right, grows left
      const bar = g
        .append("rect")
        .attr("class", "fuel-bar")
        .attr("x", rightX) // starts at right edge, width=0
        .attr("y", y)
        .attr("width", 0)
        .attr("height", this.barH)
        .attr("rx", 2)
        .attr("fill", color)
        .style("cursor", "default");

      // Fuel label — left of bar, moves with it
      const fuelLabel = g
        .append("text")
        .attr("class", "fuel-bar-label")
        .attr("x", rightX - LABEL_PAD)
        .attr("y", midY)
        .attr("text-anchor", "end")
        .attr("dominant-baseline", "middle")
        .style("font-size", "11px")
        .style("font-weight", "500")
        .style("fill", "#bbb") // starts dim (no value yet)
        .style("paint-order", "stroke")
        .style("stroke", "#fff")
        .style("stroke-width", "3px")
        .style("pointer-events", "none")
        .text(fuel);

      // Value counter inside bar — only shown when bar is wide enough
      const valueInside = g
        .append("text")
        .attr("class", "fuel-bar-value")
        .attr("x", rightX - LABEL_PAD) // updated each step
        .attr("y", midY)
        .attr("text-anchor", "end")
        .attr("dominant-baseline", "middle")
        .style("font-size", "11px")
        .style("font-weight", "600")
        .style("fill", "#fff")
        .style("pointer-events", "none")
        .style("opacity", 0)
        .text("0.00");

      this.fuelRows.set(fuel, {
        g,
        bar,
        fuelLabel,
        valueInside,
        y,
        midY,
        rightX,
      });
    });

    this._setupTooltip();
  }

  // ── Tooltip ───────────────────────────────────────────────────────────────

  _setupTooltip() {
    this.tooltip = d3.select("body").select(".risk-tooltip");
    if (this.tooltip.empty()) {
      this.tooltip = d3
        .select("body")
        .append("div")
        .attr("class", "risk-tooltip tooltip")
        .style("opacity", 0);
    }
    this.fuelRows.forEach(({ bar }, fuel) => {
      bar
        .on("mouseover", () => {
          const v = this._fuelCumVal(fuel, this.currentStep);
          if (!v) return;
          this.tooltip
            .style("opacity", 1)
            .html(`<strong>${fuel}</strong><br/>Risk index: ${v.toFixed(4)}`);
        })
        .on("mousemove", (event) => {
          this.tooltip
            .style(
              "left",
              event.pageX > window.innerWidth / 2
                ? event.pageX - 120 + "px"
                : event.pageX + 12 + "px",
            )
            .style("top", event.pageY - 10 + "px");
        })
        .on("mouseout", () => this.tooltip.style("opacity", 0));
    });
  }

  // ── Step update ───────────────────────────────────────────────────────────

  updateStep(step) {
    this.currentStep = step;

    ALL_FUELS.forEach((fuel) => {
      const row = this.fuelRows.get(fuel);
      if (!row) return;
      const { bar, fuelLabel, valueInside, rightX, midY } = row;
      const cumVal = this._fuelCumVal(fuel, step);
      const barW = this.xScale(cumVal);
      const barLeft = rightX - barW;
      const hasValue = cumVal > 0;

      // Animate bar (grows left from rightX)
      bar
        .transition()
        .duration(ANIM_DUR)
        .ease(d3.easeCubicOut)
        .attr("x", barLeft)
        .attr("width", barW);

      // Fuel label: track left edge of bar
      fuelLabel
        .transition()
        .duration(ANIM_DUR)
        .ease(d3.easeCubicOut)
        .attr("x", barLeft - LABEL_PAD)
        .style("fill", hasValue ? "#333" : "#bbb");

      // Value inside bar: show only if bar is wide enough
      const showValue = barW >= MIN_BAR_W_LABEL;
      const prevVal = step > 1 ? this._fuelCumVal(fuel, step - 1) : 0;
      const interpV = d3.interpolateNumber(prevVal, cumVal);
      const vi = valueInside;

      valueInside
        .transition()
        .duration(ANIM_DUR)
        .ease(d3.easeCubicOut)
        .attr("x", barLeft + LABEL_PAD) // inside bar, near left edge
        .attr("text-anchor", "start")
        .style("opacity", showValue ? 1 : 0)
        .tween("text", () => (t) => {
          if (showValue) vi.text(interpV(t).toFixed(2));
        });
    });

    // Counter
    const cumTotal = this.scenarioData
      .filter((d) => d.step <= step)
      .reduce((s, d) => s + d.value, 0);
    const prevTotal =
      step > 1
        ? this.scenarioData
            .filter((d) => d.step <= step - 1)
            .reduce((s, d) => s + d.value, 0)
        : 0;
    const interpT = d3.interpolateNumber(prevTotal, cumTotal);
    const vn = this.valueNumber;

    this.valueLabel.transition().duration(400).style("opacity", 1);
    this.valueNumber
      .transition()
      .duration(ANIM_DUR)
      .style("opacity", 1)
      .tween("text", () => (t) => vn.text(interpT(t).toFixed(3)));
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
      const midY = y + this.barH / 2;
      const rightX = this.width - PAD_RIGHT;
      row.y = y;
      row.midY = midY;
      row.rightX = rightX;
      row.bar.attr("y", y).attr("height", this.barH);
      row.fuelLabel.attr("y", midY);
      row.valueInside.attr("y", midY);
    });

    if (this.currentStep > 0) this.updateStep(this.currentStep);
  }
}

export default EnergyRiskChart;
