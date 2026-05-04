import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.8.5/+esm";
import { EnergyRiskChart } from "./EnergyRiskChart.js";
import { CONFIG } from "./config.js";

document.addEventListener("DOMContentLoaded", async () => {
  // ── Load data ──────────────────────────────────────────────────────────────
  let rawData;
  try {
    rawData = await d3.csv(`${CONFIG.BASE_URL}/data_web.csv`, (d) => ({
      fuel: d.fuel.trim(),
      name: d.name.trim(),
      value: +d.value,
      scenario: +d.scenario,
      step: +d.step,
      value_scenario: +d.value_scenario,
    }));
  } catch (err) {
    console.error("Failed to load energy risk data:", err);
    return;
  }

  // ── Normalise fuel names ───────────────────────────────────────────────────
  rawData.forEach((d) => {
    if (d.fuel === "Uranium (Average)" || d.fuel === "Uranium (AVERAGE)")
      d.fuel = "Uranium";
    if (d.fuel === "Gas (pipeline excluding NO and UK)")
      d.fuel = "Gas (pipeline, excluding Norway and United Kingdom)";
  });

  // ── Global max single-fuel cumulative value ───────────────────────────────
  const scenarios = [...new Set(rawData.map((d) => d.scenario))];
  const fuels = [...new Set(rawData.map((d) => d.fuel))];
  let globalMaxFuelValue = 0;

  scenarios.forEach((s) => {
    const sData = rawData.filter((d) => d.scenario === s);
    const maxStep = d3.max(sData, (d) => d.step);
    fuels.forEach((fuel) => {
      const cumVal = sData
        .filter((d) => d.fuel === fuel && d.step <= maxStep)
        .reduce((sum, d) => sum + d.value, 0);
      if (cumVal > globalMaxFuelValue) globalMaxFuelValue = cumVal;
    });
  });

  // ── Initialise one chart per scenario ─────────────────────────────────────
  const SCENARIOS = [1, 2, 3, 4, 5];
  const charts = {};

  SCENARIOS.forEach((s) => {
    const el = document.getElementById(`visualization-scenario-${s}`);
    if (!el) return;
    charts[s] = new EnergyRiskChart(el, s, rawData, globalMaxFuelValue);
  });

  // ── Scroll-based step tracking ────────────────────────────────────────────
  const cardSets = SCENARIOS.map((s) => ({
    s,
    cards: Array.from(
      document.querySelectorAll(`.card[data-viz="scenario-${s}"]`),
    ),
    lastStep: null,
  })).filter((entry) => entry.cards.length > 0);

  function onScroll() {
    const triggerY = window.innerHeight * 0.5;

    cardSets.forEach((entry, idx) => {
      const { s, cards } = entry;
      let bestCard = null,
        bestDist = Infinity;

      cards.forEach((card) => {
        const rect = card.getBoundingClientRect();
        if (
          rect.bottom < -window.innerHeight ||
          rect.top > window.innerHeight * 2
        )
          return;
        const dist = Math.abs(rect.top + rect.height / 2 - triggerY);
        if (dist < bestDist) {
          bestDist = dist;
          bestCard = card;
        }
      });

      if (!bestCard) return;

      const step = +bestCard.dataset.step;
      if (step !== cardSets[idx].lastStep) {
        cardSets[idx].lastStep = step;
        cards.forEach((c) => c.classList.remove("active"));
        bestCard.classList.add("active");

        // Parse optional highlight list from data-highlight attribute
        const highlights = (bestCard.dataset.highlight || "")
          .split("|")
          .map((h) => h.trim())
          .filter(Boolean);

        charts[s]?.updateStep(step, highlights);
      }
    });
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // ── Resize ────────────────────────────────────────────────────────────────
  window.addEventListener("resize", () => {
    Object.values(charts).forEach((c) => c.resize());
  });
});
