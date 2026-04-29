import * as d3     from "https://cdn.jsdelivr.net/npm/d3@7.8.5/+esm";
import { EnergyRiskChart } from "./EnergyRiskChart.js";
import { CONFIG }          from "./config.js";

document.addEventListener("DOMContentLoaded", async () => {

  // ── Load data ────────────────────────────────────────────────────────────
  let rawData;
  try {
    rawData = await d3.csv(`${CONFIG.BASE_URL}/data_web.csv`, d => ({
      fuel:            d.fuel.trim(),
      name:            d.name.trim(),
      value:           +d.value,
      scenario:        +d.scenario,
      step:            +d.step,
      value_scenario:  +d.value_scenario,
    }));
  } catch (err) {
    console.error("Failed to load energy risk data:", err);
    return;
  }

  // Normalise Uranium capitalisation inconsistency in source data
  rawData.forEach(d => {
    if (d.fuel === "Uranium (Average)" || d.fuel === "Uranium (AVERAGE)") d.fuel = "Uranium";
  });

  // ── Global scale: the highest scenario total drives the circle size ──────
  const globalMaxCumulative = d3.max(rawData, d => d.value_scenario);

  // ── Initialise one chart per scenario ────────────────────────────────────
  const SCENARIOS = [1, 2, 3, 4, 5];
  const charts    = {};

  SCENARIOS.forEach(s => {
    const el = document.getElementById(`visualization-scenario-${s}`);
    if (!el) return;
    charts[s] = new EnergyRiskChart(el, s, rawData, globalMaxCumulative);
  });

  // ── Scroll-based step tracking (works on both downscroll and upscroll) ───
  const cardSets = SCENARIOS.map(s => ({
    s,
    cards:    Array.from(document.querySelectorAll(`.card[data-viz="scenario-${s}"]`)),
    lastStep: null,
  })).filter(entry => entry.cards.length > 0);

  function onScroll() {
    const triggerY = window.innerHeight * 0.5;

    cardSets.forEach((entry, idx) => {
      const { s, cards } = entry;
      let bestCard = null;
      let bestDist = Infinity;

      cards.forEach(card => {
        const rect = card.getBoundingClientRect();
        if (rect.bottom < -window.innerHeight || rect.top > window.innerHeight * 2) return;
        const cardMid = rect.top + rect.height / 2;
        const dist    = Math.abs(cardMid - triggerY);
        if (dist < bestDist) { bestDist = dist; bestCard = card; }
      });

      if (!bestCard) return;

      const step = +bestCard.dataset.step;
      if (step !== cardSets[idx].lastStep) {
        cardSets[idx].lastStep = step;
        cards.forEach(c => c.classList.remove("active"));
        bestCard.classList.add("active");
        charts[s]?.updateStep(step);
      }
    });
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll(); // paint initial state if cards already visible

  // ── Resize ───────────────────────────────────────────────────────────────
  window.addEventListener("resize", () => {
    Object.values(charts).forEach(c => c.resize());
  });
});
