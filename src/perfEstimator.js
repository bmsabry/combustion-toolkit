// ─────────────────────────────────────────────────────────────────────────
//  Adaptive runtime estimator for the Automate matrix runner.
//
//  Static "typical-cost" constants in automation.js's catalog go stale
//  every time we speed something up (Cantera Solution pool, brentq, batch
//  endpoint, etc. — real per-row cost dropped ~20× over the last week
//  while the catalog defaults still reported pre-pool times).
//
//  This module replaces them with a learning estimator:
//
//    estimateRunSeconds(panels, mode, needsBisection, matrixSize)
//      → If we have measured data for THIS exact (panels, mode,
//        bisection) combination, return matrixSize × measured EMA.
//      → Otherwise fall back to a calibrated default that reflects the
//        CURRENT codebase's typical per-panel cost.
//
//    recordRunPerf(panels, mode, needsBisection, matrixSize, elapsedSec)
//      → Update the stored exponentially-weighted moving average of
//        per-row cost for that combination, persisted to localStorage.
//      → Called when a matrix run completes (or partially during long
//        runs so the next session benefits from in-flight data).
//
//  Storage: localStorage["ctk_perf_v2"]. Versioned so a future schema
//  change can invalidate stale entries.
// ─────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = "ctk_perf_v2";
const EMA_ALPHA = 0.40;        // recent runs weighted moderately heavier
const SAMPLE_HISTORY = 5;      // last-N raw samples kept for diagnostics

// Default per-row, per-panel cost in seconds on Render Standard (1 vCPU)
// AFTER the Cantera Solution pool + brentq + batch fixes shipped on
// 2026-04-27. These are the a-priori numbers used until the user
// completes their first matrix run for a given panel-set; after that the
// EMA from real timing takes over.
const DEFAULT_PER_PANEL_S = {
  cycle:     0.50,   // /calc/cycle — separate HTTP, can't batch
  mapping:   0.05,   // correlation, near-zero compute, batched
  aft:       0.10,   // Cantera HP eq, batched
  exhaust:   0.20,   // 2 batched solves
  combustor: 0.40,   // PSR + PFR integration — slowest panel
  flame:     0.50,   // Cantera FreeFlame — also slow
};

// Per-row cost added when T_flame is varied (triggers
// /calc/solve-phi-for-tflame once per row, ~0.1-0.3 s post-brentq).
const BISECTION_PER_ROW_S = 0.15;

// Free-mode is JS-only (no HTTP, no Cantera), roughly 5% of accurate cost.
const FREE_MODE_FACTOR = 0.05;

// Per-row HTTP overhead baseline (TCP + JSON serialize/parse).
const HTTP_OVERHEAD_PER_ROW_S = 0.05;

function _signature(panels, mode, needsBisection){
  const ps = [...new Set(panels)].sort().join(",");
  return `${ps}|${mode}|${needsBisection ? "bis" : "nobis"}`;
}

function _load(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function _save(obj){
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(obj)); }
  catch { /* quota / SSR / disabled — silently drop */ }
}

// Pure-default per-row estimate for a (panels, mode, needsBisection)
// triple, ignoring any persisted measurements.
function _defaultPerRowSeconds(panels, mode, needsBisection){
  let perRow = HTTP_OVERHEAD_PER_ROW_S;
  for (const pid of panels) perRow += (DEFAULT_PER_PANEL_S[pid] ?? 0.10);
  if (needsBisection) perRow += BISECTION_PER_ROW_S;
  if (mode !== "accurate") perRow *= FREE_MODE_FACTOR;
  return perRow;
}

/**
 * Estimate total run time in seconds for the given matrix configuration.
 * Uses persisted EMA from prior runs if available; otherwise falls back
 * to current calibrated defaults.
 *
 * Returns { seconds, source, sampleCount } so the UI can show whether
 * the estimate is calibrated or a default.
 */
export function estimateRunSeconds(panels, mode, needsBisection, matrixSize){
  if (matrixSize <= 0) return { seconds: 0, source: "default", sampleCount: 0 };
  const sig = _signature(panels, mode, needsBisection);
  const store = _load();
  const entry = store[sig];
  if (entry && entry.ema_per_row_s > 0 && entry.sample_count > 0){
    return {
      seconds: matrixSize * entry.ema_per_row_s,
      source: "calibrated",
      sampleCount: entry.sample_count,
    };
  }
  return {
    seconds: matrixSize * _defaultPerRowSeconds(panels, mode, needsBisection),
    source: "default",
    sampleCount: 0,
  };
}

/**
 * Record a completed (or partial) run's measured per-row time. Updates
 * the EMA for this (panels, mode, needsBisection) signature so the next
 * run's estimate uses real measurements.
 *
 * If `partial` is true, this is a mid-run sample (e.g. user cancelled
 * but we want to learn from what completed). The EMA is still updated
 * but with a lower weight (α/2) since partial samples are less reliable
 * than full-run averages.
 */
export function recordRunPerf(panels, mode, needsBisection, matrixSize, elapsedSec, { partial = false } = {}){
  if (matrixSize <= 0 || elapsedSec <= 0) return;
  const sig = _signature(panels, mode, needsBisection);
  const store = _load();
  const per_row_s = elapsedSec / matrixSize;
  const prior = store[sig];
  const alpha = partial ? EMA_ALPHA * 0.5 : EMA_ALPHA;
  let ema = prior?.ema_per_row_s;
  if (!ema || ema <= 0) ema = per_row_s;             // first sample bootstrap
  else                  ema = alpha * per_row_s + (1 - alpha) * ema;
  const samples = (prior?.last_samples || []).concat([{
    per_row_s, matrix_size: matrixSize, elapsed_s: elapsedSec,
    when: Date.now(), partial,
  }]).slice(-SAMPLE_HISTORY);
  store[sig] = {
    ema_per_row_s: ema,
    sample_count: (prior?.sample_count || 0) + 1,
    last_updated: Date.now(),
    last_samples: samples,
  };
  _save(store);
}

/** Wipe all stored timings — useful when defaults are recalibrated. */
export function clearPerfHistory(){
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}
