import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.8.5/+esm";
import { EnergyRiskChart } from "./EnergyRiskChart.js";
import { CONFIG } from "./config.js";

document.addEventListener("DOMContentLoaded", async () => {
  // ── Load data ────────────────────────────────────────────────────────────
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

  // Normalise Uranium capitalisation inconsistency in source data
  rawData.forEach((d) => {
    if (d.fuel === "Uranium (Average)") d.fuel = "Uranium (AVERAGE)";
  });

  // ── Global scale: the highest scenario total drives the circle size ──────
  // value_scenario is pre-computed as the total (all steps summed) per scenario.
  const globalMaxCumulative = d3.max(rawData, (d) => d.value_scenario);

  // ── Initialise one chart per scenario ────────────────────────────────────
  const SCENARIOS = [1, 2, 3, 4, 5];
  const charts = {};

  SCENARIOS.forEach((s) => {
    const el = document.getElementById(`visualization-scenario-${s}`);
    if (!el) return;
    charts[s] = new EnergyRiskChart(el, s, rawData, globalMaxCumulative);
  });

  // ── IntersectionObserver per scenario ────────────────────────────────────
  SCENARIOS.forEach((s) => {
    const cards = document.querySelectorAll(`.card[data-viz="scenario-${s}"]`);
    if (!cards.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const step = +entry.target.dataset.step;
          cards.forEach((c) => c.classList.remove("active"));
          entry.target.classList.add("active");
          console.log(`Scenario ${s} — step ${step}`);
          charts[s]?.updateStep(step);
        });
      },
      { threshold: 0.5 },
    );

    cards.forEach((card) => observer.observe(card));
  });

  // ── Resize ───────────────────────────────────────────────────────────────
  window.addEventListener("resize", () => {
    Object.values(charts).forEach((c) => c.resize());
  });
});
