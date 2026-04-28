// ─────────────────────────────────────────────────────────────────────────
//  Smart numeric rounding for display and export.
//
//  One source of truth — every panel display, Excel cell, plot legend,
//  and chart title routes through `smartRound` / `smartFormat` here so
//  the user sees the same precision everywhere.
//
//  Rules (selected via unit/label inspection, with explicit overrides for
//  units that need engineering-context interpretation):
//
//    Temperature units (K, °F, °C, °R)        → integer
//    Pressure units (bar, psia, psi, Pa, …)   → integer
//    ppm / ppmvd / ppmv / ppb                 → 1 decimal (emissions
//                                               precision matters)
//    Velocity (m/s, ft/s, cm/s)               → 1 decimal
//    Time (ms, s, μs) when |v| ≥ 0.1          → 1 decimal
//    Time when |v| <  0.1                     → 4 sig figs (small τ_ign etc.)
//    Percent (%)                              → 1 decimal
//    Equivalence ratio (φ, phi, equivalence)  → 3 decimals
//    Fuel/air ratio (FAR)                     → 4 decimals
//    Mass flow (kg/s, lb/s, kg/hr, lb/hr)     → 1 decimal
//    LHV (mass / vol) in SI (MJ/kg, MJ/m³)    → 1 decimal
//    LHV (mass / vol) in English (BTU/lb,
//      BTU/scf)                               → integer
//    MWI / Wobbe (both SI and English)        → 1 decimal
//    Default (everything else)                → 4 significant figures
//                                                (relative error ≤ 0.05%
//                                                 — well under the
//                                                 0.1% accuracy bound)
// ─────────────────────────────────────────────────────────────────────────

const TEMP_UNITS     = new Set(["k", "°f", "f", "°c", "c", "°r", "r"]);
const PRESS_UNITS    = new Set(["bar", "psia", "psi", "psig", "pa", "kpa", "mpa", "atm", "torr", "mmhg", "inhg"]);
const PPM_UNITS      = new Set(["ppm", "ppmv", "ppmvd", "ppb", "ppbv"]);
const VEL_UNITS      = new Set(["m/s", "ft/s", "cm/s", "mm/s"]);
const TIME_UNITS     = new Set(["ms", "s", "μs", "us", "min", "hr", "h"]);
const MASSFLOW_UNITS = new Set(["kg/s", "lb/s", "kg/hr", "lb/hr", "kg/h", "lb/h", "kg/min", "lb/min"]);

function _normUnit(u){ return String(u || "").trim().toLowerCase(); }
function _normLabel(l){ return String(l || "").toLowerCase(); }

function _isPercent(unit){
  return _normUnit(unit) === "%";
}
function _isPhiLabel(label){
  const l = _normLabel(label);
  return l === "phi" || l === "φ" || l.includes("equivalence ratio") ||
         /\bphi\b/.test(l) || l.includes("φ");
}
function _isFarLabel(label){
  const l = _normLabel(label);
  return /\bfar\b/.test(l) || l.includes("fuel/air") || l.includes("fuel-air") ||
         l.includes("fuel air ratio");
}
function _isLHVLabel(label, unit){
  // Match the LHV / Lower Heating Value labels — but ONLY when the unit
  // is a heating-value unit. This rejects "η LHV" (efficiency relative
  // to LHV, unit "%") which would otherwise hit this branch and break
  // the percent → 1 decimal rule.
  const l = _normLabel(label);
  if (!(/\blhv\b/.test(l) || l.includes("lower heating"))) return false;
  const u = _normUnit(unit);
  return u.startsWith("mj/") || u.startsWith("btu/");
}
function _isWobbeOrMWI(label){
  const l = _normLabel(label);
  return l.includes("wobbe") || /\bmwi\b/.test(l);
}

// Round to N significant figures (positive integer N).
function _roundToSigFigs(value, n){
  if (value === 0) return 0;
  const exp = Math.floor(Math.log10(Math.abs(value)));
  const factor = Math.pow(10, n - 1 - exp);
  return Math.round(value * factor) / factor;
}

// Round to N decimal places.
function _roundToDecimals(value, n){
  const factor = Math.pow(10, n);
  return Math.round(value * factor) / factor;
}

/**
 * Round a numeric value according to its unit + label context.
 * Returns the rounded NUMBER (not a string). Pass-through for non-finite
 * values, booleans, null, undefined.
 */
export function smartRound(value, unit, label){
  if (value == null) return value;
  if (typeof value === "boolean") return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return value;

  const u = _normUnit(unit);

  // Highest-priority: domain-specific labels that override the
  // generic unit-bucket rule (LHV, MWI, Wobbe).
  if (_isLHVLabel(label, unit)){
    // SI heating-value units → 1 decimal; English → integer.
    if (u.startsWith("mj/")) return _roundToDecimals(value, 1);
    if (u.startsWith("btu/")) return Math.round(value);
    // Other LHV unit shapes — fall through to default.
  }
  if (_isWobbeOrMWI(label)){
    return _roundToDecimals(value, 1);
  }

  // Unit-bucket rules
  if (TEMP_UNITS.has(u))     return Math.round(value);
  if (PRESS_UNITS.has(u))    return Math.round(value);
  // ppm / ppmvd / ppmv / ppb — emissions need 1 decimal of precision
  // (e.g. NOx = 2.3 ppm vs 3 ppm matters for regulatory reporting and
  // for distinguishing the H₂ effect across the matrix).
  if (PPM_UNITS.has(u))      return _roundToDecimals(value, 1);
  if (VEL_UNITS.has(u))      return _roundToDecimals(value, 1);
  if (MASSFLOW_UNITS.has(u)) return _roundToDecimals(value, 1);
  if (_isPercent(u))         return _roundToDecimals(value, 1);
  if (TIME_UNITS.has(u)){
    // 1 decimal when |v| ≥ 0.1; else 4 sig figs so small τ_ign etc.
    // doesn't collapse to 0.0.
    return Math.abs(value) >= 0.1 ? _roundToDecimals(value, 1) : _roundToSigFigs(value, 4);
  }

  // Label-driven for unitless quantities
  if (_isPhiLabel(label)) return _roundToDecimals(value, 3);
  if (_isFarLabel(label)) return _roundToDecimals(value, 4);

  // Default: 4 significant figures (≤ 0.05% relative error)
  return _roundToSigFigs(value, 4);
}

/**
 * Round + format as a string. Preserves trailing zeros where they
 * carry precision information (φ = 0.555 stays "0.555", not "0.55") and
 * adds thousand-separators for large integer-rounded values
 * (50,011 → "50,011").
 */
export function smartFormat(value, unit, label){
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);

  const rounded = smartRound(value, unit, label);
  const u = _normUnit(unit);
  const isLHV = _isLHVLabel(label, unit);
  const isWobbe = _isWobbeOrMWI(label);

  let dec;
  if (isLHV){
    if (u.startsWith("mj/"))       dec = 1;
    else if (u.startsWith("btu/")) dec = 0;
    else dec = null;  // fall through
  } else if (isWobbe){
    dec = 1;
  } else if (TEMP_UNITS.has(u) || PRESS_UNITS.has(u)){
    dec = 0;
  } else if (PPM_UNITS.has(u) || VEL_UNITS.has(u) || MASSFLOW_UNITS.has(u) || _isPercent(u)){
    dec = 1;
  } else if (TIME_UNITS.has(u)){
    dec = Math.abs(value) >= 0.1 ? 1 : null;
  } else if (_isPhiLabel(label)){
    dec = 3;
  } else if (_isFarLabel(label)){
    dec = 4;
  }

  if (dec == null){
    // Default: 4 sig figs — derive decimal count from magnitude.
    if (rounded === 0) dec = 0;
    else dec = Math.max(0, 3 - Math.floor(Math.log10(Math.abs(rounded))));
  }

  // Thousand separators for values ≥ 1000 — keeps screen display
  // visually consistent with Excel's "#,##0.0" format code so big NOx /
  // CO numbers (2,656.3 ppmvd) read the same in both places.
  if (Math.abs(rounded) >= 1000){
    return rounded.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
  return rounded.toFixed(dec);
}

/**
 * Excel number-format string compatible with SheetJS / xlsx-js-style
 * cell `z` properties. Applied per-cell so Excel renders the value at
 * the right precision while keeping the underlying number intact for
 * sorting, filtering, formulas, etc.
 *
 * Returns an Excel format code string OR null when no specific format
 * applies (caller should let Excel use the default General format).
 */
export function excelNumberFormat(unit, label, sampleValue){
  const u = _normUnit(unit);
  const isLHV = _isLHVLabel(label, unit);
  const isWobbe = _isWobbeOrMWI(label);

  if (isLHV){
    if (u.startsWith("mj/"))       return "#,##0.0";
    if (u.startsWith("btu/"))      return "#,##0";
  }
  if (isWobbe) return "#,##0.0";

  if (TEMP_UNITS.has(u) || PRESS_UNITS.has(u)) return "#,##0";
  if (PPM_UNITS.has(u) || VEL_UNITS.has(u) || MASSFLOW_UNITS.has(u)) return "#,##0.0";
  if (_isPercent(u))                                                return "0.0";
  if (TIME_UNITS.has(u)){
    if (typeof sampleValue === "number" && Math.abs(sampleValue) >= 0.1) return "#,##0.0";
    // small times — let General format handle scientific if needed
    return "0.000E+00";
  }
  if (_isPhiLabel(label)) return "0.000";
  if (_isFarLabel(label)) return "0.0000";

  // Default 4 sig figs is hard to express as a single Excel format code
  // (it depends on magnitude). Use a magnitude-aware code.
  if (typeof sampleValue === "number" && Number.isFinite(sampleValue) && sampleValue !== 0){
    const exp = Math.floor(Math.log10(Math.abs(sampleValue)));
    const dec = Math.max(0, 3 - exp);
    if (dec === 0) return "#,##0";
    return "#,##0." + "0".repeat(Math.min(dec, 6));
  }
  return null;
}
