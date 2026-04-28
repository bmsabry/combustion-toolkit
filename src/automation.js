/* ══════════════════════════════════════════════════════════════════════════
   AUTOMATION MODULE — DoE-driven multi-panel test matrix runner.

   This file is INTENTIONALLY pure JS — no React, no DOM, no calc
   dependencies. It owns three things:

     1. AUTO_VARS — the catalog of every input variable a user can vary.
                    Each entry is tagged with the panel it affects so the
                    UI can filter to whatever panels the user picked.

     2. AUTO_OUTPUTS — the catalog of every output a user can capture.
                       Each has a `pick(rowState)` that pulls the value from
                       the per-row results bundle the runner produces.

     3. generateMatrix() — full-factorial cross-product DoE generator.
                           Takes [{var, mode, ...}] and returns
                           [{var: value, ...}, ...] rows.

   The runner orchestrator + Excel writer live in App.jsx (where they have
   access to calcAFT_EQ, calcSL, calcCombustorNetwork, mixT, bkCachedFetch,
   etc.). This module just hands it the catalog and the matrix.
   ══════════════════════════════════════════════════════════════════════════ */

import { smartFormat } from "./format";

// ─────────────────────────────────────────────────────────────────────────
//  Panel ids — must match the tab ids in App.jsx (TABS_BASE).
// ─────────────────────────────────────────────────────────────────────────
export const AUTOMATABLE_PANELS = [
  { id: "cycle",     label: "Cycle (Gas Turbine)",     icon: "🛠️",
    desc: "Engine deck. Drives MW, η, T3, P3, T4, fuel/air/bleed flows. Required by Combustor Mapping.",
    typicalCost: 2.5 },
  { id: "mapping",   label: "Combustor Mapping (LMS100 4-circuit)", icon: "🎯",
    desc: "DLE correlation: NOx15, CO15, PX36_SEL/HI, per-circuit T_AFT. Auto-runs Cycle for T3/P3/W3.",
    typicalCost: 3.0, requires: ["cycle"] },
  { id: "aft",       label: "Flame Temp & Properties", icon: "🔥",
    desc: "Adiabatic flame T, equilibrium products, heating values, MWI.",
    typicalCost: 1.5 },
  { id: "exhaust",   label: "Exhaust Analysis",        icon: "🔬",
    desc: "Inverts measured O₂/CO₂ to φ + T_ad. Two solves per row (one from O₂, one from CO₂).",
    typicalCost: 1.5 },
  { id: "combustor", label: "Combustor PSR → PFR",     icon: "🏭",
    desc: "PSR primary zone + PFR burnout. NOx (Zeldovich) + CO kinetics. Slowest panel.",
    typicalCost: 5.0 },
  { id: "flame",     label: "Flame Speed & Blowoff",   icon: "⚡",
    desc: "S_L (Gülder/Metghalchi-Keck), Da, premixer stability. ~12 s per row in Accurate mode.",
    typicalCost: 12.0 },
];

// ─────────────────────────────────────────────────────────────────────────
//  AUTO_VARS — every input the user can vary.
//
//  fields:
//    id        unique key (matches a row column header)
//    label     display text
//    panels    which panels this variable feeds. UI shows a var only if
//              at least one selected panel needs it.
//    kind      'number' | 'enum' | 'bool' | 'fuel_species' | 'ox_species'
//    default   sensible default (used when the user adds the var)
//    range     [min, max] for number kind
//    step      default step for number kind
//    unit_si / unit_en  display units (label-only)
//    siToEn / enToSi    optional convertors so the user enters in current
//                       units; runner converts to SI internally
//    choices   for enum kind: array of {value, label}
//    needs     optional: array of var ids that must be set (e.g., bleed
//              valve only matters when bleedMode = manual)
//    linkage   if this var is varied AND the cycle panel is selected, the
//              runner will auto-break this Cycle linkage so the variation
//              actually takes effect (otherwise Cycle would override it).
// ─────────────────────────────────────────────────────────────────────────

// helpers for unit conversion
const K_to_F = K => (K - 273.15) * 9/5 + 32;
const F_to_K = F => (F - 32) * 5/9 + 273.15;
const atm_to_psia = a => a * 14.6959;
const psia_to_atm = p => p / 14.6959;
const m_to_ft  = m => m * 3.28084;
const ft_to_m  = f => f / 3.28084;
const mps_to_fps = v => v * 3.28084;
const fps_to_mps = v => v / 3.28084;

export const AUTO_VARS = [
  // ── Operating point (sidebar; used by every combustion panel) ──
  // φ, FAR, and T_flame are MUTUALLY DEPENDENT (group: "operating_point").
  // Pick any ONE to vary in automation; the picker hides the other two
  // because varying multiple would specify the same physical quantity twice
  // and produce inconsistent rows.
  { id: "phi", label: "phi",
    panels: ["aft", "combustor", "flame"], kind: "number",
    default: 0.555, range: [0.30, 1.50], step: 0.05, unit_si: "—", unit_en: "—",
    linkage: "linkFAR", group: "operating_point",
    desc: "Equivalence ratio (φ). Sidebar φ. Drives AFT, PSR-PFR, Flame Speed. If Cycle is selected and you vary φ, the φ_Bulk linkage is auto-broken. Mutually exclusive with FAR and TFlame_CC." },

  { id: "FAR", label: "FAR",
    panels: ["aft", "combustor", "flame"], kind: "number",
    default: 0.0339, range: [0.005, 0.10], step: 0.002, unit_si: "—", unit_en: "—",
    linkage: "linkFAR", group: "operating_point",
    desc: "Fuel/Air ratio (mass basis). Runner converts to φ per row via φ = FAR / FAR_stoich (FAR_stoich depends on the fuel + ox composition). Mutually exclusive with phi and TFlame_CC." },

  { id: "T_flame", label: "TFlame_CC",
    panels: ["aft", "combustor", "flame"], kind: "number",
    default: 1900, range: [1500, 2400], step: 50,
    unit_si: "K", unit_en: "°F",
    siToEn: K_to_F, enToSi: F_to_K,
    linkage: "linkFAR", group: "operating_point",
    desc: "Target adiabatic flame temperature, complete combustion (no dissociation), at the 3-stream mixed inlet. Runner back-solves the lean φ that produces this TFlame_CC given the current fuel, oxidizer, Fuel Temp, Air Temp. Mutually exclusive with phi and FAR." },

  { id: "T_air", label: "Air Temp",
    panels: ["aft", "combustor", "flame"], kind: "number",
    default: 810.93, range: [250, 900], step: 10,
    unit_si: "K", unit_en: "°F",
    siToEn: K_to_F, enToSi: F_to_K,
    linkage: "linkT3",
    desc: "Combustor air inlet temperature. If Cycle is selected, the T3 linkage is auto-broken." },

  { id: "T_fuel", label: "Fuel Temp",
    panels: ["aft", "combustor", "flame"], kind: "number",
    default: 294.26, range: [250, 700], step: 5,
    unit_si: "K", unit_en: "°F",
    siToEn: K_to_F, enToSi: F_to_K,
    desc: "Fuel inlet temperature (before adiabatic mixing with air). Sets fuel-side enthalpy in the 3-stream mix balance." },

  { id: "P", label: "Pressure",
    panels: ["aft", "combustor", "flame"], kind: "number",
    default: 27.22, range: [0.5, 50], step: 0.5,
    unit_si: "atm", unit_en: "psia",
    siToEn: atm_to_psia, enToSi: psia_to_atm,
    linkage: "linkP3",
    desc: "Combustor pressure. If Cycle is selected, the P3 linkage is auto-broken." },

  { id: "WFR", label: "Water/Fuel Ratio",
    panels: ["aft", "combustor", "cycle"], kind: "number",
    default: 0, range: [0, 2.0], step: 0.1,
    unit_si: "kg/kg", unit_en: "kg/kg",
    desc: "Water injection per unit fuel mass. 0 = no injection." },

  { id: "water_mode", label: "Water Injection Mode",
    panels: ["aft", "combustor", "cycle"], kind: "enum",
    default: "liquid",
    choices: [{ value: "liquid", label: "Liquid (absorbs h_fg)" },
              { value: "steam",  label: "Steam (gas at T_air)" }],
    desc: "Liquid debits h_fg from the flame; steam joins as superheated H₂O." },

  // ── Cycle (Engine & Ambient) ──
  { id: "engine", label: "Engine Deck",
    panels: ["cycle"], kind: "enum",
    default: "LMS100PB+",
    choices: [{ value: "LM6000PF",  label: "LM6000PF DLE" },
              { value: "LMS100PB+", label: "LMS100PB+ DLE IC" }],
    desc: "Switches MW cap, T4 firing target, η_isen calibration." },

  { id: "P_amb", label: "Ambient Pressure",
    panels: ["cycle"], kind: "number",
    default: 1.01325, range: [0.6, 1.2], step: 0.01,
    unit_si: "bar", unit_en: "bar",
    desc: "Compressor inlet pressure. Sea-level ISA = 1.01325 bar." },

  { id: "T_amb", label: "Ambient Temperature",
    panels: ["cycle"], kind: "number",
    default: 280, range: [253, 320], step: 1,
    unit_si: "K", unit_en: "°F",
    siToEn: K_to_F, enToSi: F_to_K,
    desc: "Site ambient. Drives compressor inlet density and humid-air R." },

  { id: "RH", label: "Relative Humidity",
    panels: ["cycle"], kind: "number",
    default: 60, range: [0, 100], step: 5, unit_si: "%", unit_en: "%",
    desc: "Inlet humidity. Higher RH → more volumetric mdot." },

  { id: "load_pct", label: "Load",
    panels: ["cycle"], kind: "number",
    default: 100, range: [20, 100], step: 5, unit_si: "%", unit_en: "%",
    desc: "GT load as % of rated. Drives MW_cap and T4 droop at part-load." },

  { id: "T_cool", label: "Intercooler Coolant T (LMS100 only)",
    panels: ["cycle"], kind: "number",
    default: 288.15, range: [273, 320], step: 1,
    unit_si: "K", unit_en: "°F",
    siToEn: K_to_F, enToSi: F_to_K,
    desc: "Sets HPC inlet T on LMS100. Ignored on LM6000." },

  { id: "com_air_frac", label: "Combustor Air Fraction (flame)",
    panels: ["cycle"], kind: "number",
    default: 0.88, range: [0.30, 1.00], step: 0.01, unit_si: "—", unit_en: "—",
    desc: "Flame-zone share of W36. Sets T_Bulk / φ_Bulk split. Default 0.88." },

  { id: "bleed_open_pct", label: "Bleed Valve Open",
    panels: ["cycle"], kind: "number",
    default: 0, range: [0, 100], step: 5, unit_si: "%", unit_en: "%",
    desc: "Bleed valve open %. Effective bleed_air_frac = (open % × valve size %) ÷ 10000. Always treated as MANUAL during automation — auto-schedule logic is bypassed." },

  { id: "bleed_valve_size_pct", label: "Bleed Valve Size (max bleed)",
    panels: ["cycle"], kind: "number",
    default: 3.3, range: [0, 100], step: 0.5, unit_si: "%", unit_en: "%",
    desc: "Maximum bleed % at fully-open valve. Combines with bleed_open_pct to set the actual fraction the cycle deck dumps to ambient." },

  { id: "emissionsMode", label: "Emissions Mode (BD7 ladder)",
    panels: ["cycle", "mapping"], kind: "bool",
    default: true,
    desc: "Enables full BD7 ladder. Disabled = engine holds at BD4." },

  // ── Combustor Mapping (DLE 4-circuit) ──
  { id: "mapW36w3", label: "W36 / W3",
    panels: ["mapping"], kind: "number",
    default: 0.75, range: [0.30, 0.95], step: 0.01, unit_si: "—", unit_en: "—",
    desc: "Fraction of compressor air going to combustor dome." },

  { id: "mapPhiIP", label: "φ Inner Pilot",
    panels: ["mapping"], kind: "number",
    default: 0.25, range: [0.05, 0.80], step: 0.02, unit_si: "—", unit_en: "—",
    desc: "Inner pilot circuit equivalence ratio." },

  { id: "mapPhiOP", label: "φ Outer Pilot",
    panels: ["mapping"], kind: "number",
    default: 0.65, range: [0.40, 0.90], step: 0.02, unit_si: "—", unit_en: "—",
    desc: "Outer pilot circuit equivalence ratio. Drives PX36 dynamics." },

  { id: "mapPhiIM", label: "φ Inner Main",
    panels: ["mapping"], kind: "number",
    default: 0.50, range: [0.20, 0.80], step: 0.02, unit_si: "—", unit_en: "—",
    desc: "Inner main circuit equivalence ratio." },

  { id: "mapFracIP", label: "Air % Inner Pilot",
    panels: ["mapping"], kind: "number",
    default: 2.3, range: [0.5, 30], step: 0.5, unit_si: "%", unit_en: "%",
    desc: "Inner pilot air fraction (% of flame air)." },

  { id: "mapFracOP", label: "Air % Outer Pilot",
    panels: ["mapping"], kind: "number",
    default: 2.2, range: [0.5, 30], step: 0.5, unit_si: "%", unit_en: "%",
    desc: "Outer pilot air fraction (% of flame air)." },

  { id: "mapFracIM", label: "Air % Inner Main",
    panels: ["mapping"], kind: "number",
    default: 39.9, range: [10, 80], step: 1.0, unit_si: "%", unit_en: "%",
    desc: "Inner main air fraction (% of flame air). IP+OP+IM+OM should sum to 100." },

  { id: "mapFracOM", label: "Air % Outer Main",
    panels: ["mapping"], kind: "number",
    default: 55.6, range: [10, 80], step: 1.0, unit_si: "%", unit_en: "%",
    desc: "Outer main air fraction (% of flame air). IP+OP+IM+OM should sum to 100." },

  // ── PSR-PFR Combustor ──
  { id: "tau_psr", label: "τ_PSR",
    panels: ["combustor"], kind: "number",
    default: 4.0, range: [0.5, 20], step: 0.5, unit_si: "ms", unit_en: "ms",
    desc: "Primary-zone residence time. Lower → blowout risk." },

  { id: "L_pfr", label: "L_PFR",
    panels: ["combustor"], kind: "number",
    default: 0.30, range: [0.05, 2.0], step: 0.05,
    unit_si: "m", unit_en: "ft",
    siToEn: m_to_ft, enToSi: ft_to_m,
    desc: "Burnout-zone length. Longer → more CO burnout, more NOx." },

  { id: "V_pfr", label: "V_PFR",
    panels: ["combustor"], kind: "number",
    default: 30, range: [5, 100], step: 5,
    unit_si: "m/s", unit_en: "ft/s",
    siToEn: mps_to_fps, enToSi: fps_to_mps,
    desc: "PFR axial velocity. Sets actual residence time." },

  { id: "heatLossFrac", label: "Combustor Heat Loss Fraction",
    panels: ["combustor"], kind: "number",
    default: 0, range: [0, 0.5], step: 0.05, unit_si: "—", unit_en: "—",
    desc: "T_psr held at T_ad − HL·(T_ad − T_inlet). 0 = adiabatic." },

  // ── Flame Speed & Blowoff ──
  { id: "velocity", label: "V_ref (approach velocity)",
    panels: ["flame"], kind: "number",
    default: 30, range: [1, 200], step: 5,
    unit_si: "m/s", unit_en: "ft/s",
    siToEn: mps_to_fps, enToSi: fps_to_mps,
    desc: "Reference approach velocity at the flameholder." },

  { id: "Lchar", label: "L_char (recirculation length)",
    panels: ["flame"], kind: "number",
    default: 0.05, range: [0.005, 0.5], step: 0.005,
    unit_si: "m", unit_en: "ft",
    siToEn: m_to_ft, enToSi: ft_to_m,
    desc: "Characteristic recirculation length (flameholder width / step)." },

  { id: "Dfh", label: "D_flameholder",
    panels: ["flame"], kind: "number",
    default: 0.02, range: [0.005, 0.2], step: 0.002,
    unit_si: "m", unit_en: "ft",
    siToEn: m_to_ft, enToSi: ft_to_m,
    desc: "Flameholder diameter (used for Zukoski τ_BO)." },

  { id: "Lpremix", label: "L_premix",
    panels: ["flame"], kind: "number",
    default: 0.10, range: [0.02, 1.0], step: 0.02,
    unit_si: "m", unit_en: "ft",
    siToEn: m_to_ft, enToSi: ft_to_m,
    desc: "Premixer length (for autoignition residence time)." },

  { id: "Vpremix", label: "V_premix",
    panels: ["flame"], kind: "number",
    default: 60, range: [5, 200], step: 5,
    unit_si: "m/s", unit_en: "ft/s",
    siToEn: mps_to_fps, enToSi: fps_to_mps,
    desc: "Premixer bulk velocity." },

  // ── Exhaust ──
  { id: "measO2", label: "Measured O₂ (% dry)",
    panels: ["exhaust"], kind: "number",
    default: 14.0, range: [0, 20], step: 0.5, unit_si: "%", unit_en: "%",
    desc: "Stack O₂ reading on a dry basis. Inverted to φ." },

  { id: "measCO2", label: "Measured CO₂ (% dry)",
    panels: ["exhaust"], kind: "number",
    default: 3.0, range: [0, 15], step: 0.5, unit_si: "%", unit_en: "%",
    desc: "Stack CO₂ reading on a dry basis. Inverted to φ (parallel solve to measO2)." },

  // ── Fuel composition (special — needs balance species) ──
  // Listed for the FUEL_SP species the app knows about.
  { id: "fuel.CH4",   label: "Fuel CH₄",   panels: ["aft","cycle","mapping","combustor","flame"],
    kind: "fuel_species", species: "CH4",   default: 100, range: [0, 100], step: 5,
    unit_si: "mol %", unit_en: "mol %", desc: "Methane mole %." },
  { id: "fuel.C2H6",  label: "Fuel C₂H₆",  panels: ["aft","cycle","mapping","combustor","flame"],
    kind: "fuel_species", species: "C2H6",  default: 0, range: [0, 100], step: 1,
    unit_si: "mol %", unit_en: "mol %", desc: "Ethane mole %." },
  { id: "fuel.C3H8",  label: "Fuel C₃H₈",  panels: ["aft","cycle","mapping","combustor","flame"],
    kind: "fuel_species", species: "C3H8",  default: 0, range: [0, 100], step: 1,
    unit_si: "mol %", unit_en: "mol %", desc: "Propane mole %." },
  { id: "fuel.C4H10", label: "Fuel C₄H₁₀", panels: ["aft","cycle","mapping","combustor","flame"],
    kind: "fuel_species", species: "C4H10", default: 0, range: [0, 100], step: 1,
    unit_si: "mol %", unit_en: "mol %", desc: "n-Butane mole %." },
  { id: "fuel.H2",    label: "Fuel H₂",    panels: ["aft","cycle","mapping","combustor","flame"],
    kind: "fuel_species", species: "H2",    default: 0, range: [0, 100], step: 5,
    unit_si: "mol %", unit_en: "mol %", desc: "Hydrogen mole %. Drives flashback risk above 30%." },
  { id: "fuel.CO",    label: "Fuel CO",    panels: ["aft","cycle","mapping","combustor","flame"],
    kind: "fuel_species", species: "CO",    default: 0, range: [0, 100], step: 5,
    unit_si: "mol %", unit_en: "mol %", desc: "Carbon monoxide mole %." },
  { id: "fuel.CO2",   label: "Fuel CO₂",   panels: ["aft","cycle","mapping","combustor","flame"],
    kind: "fuel_species", species: "CO2",   default: 0, range: [0, 100], step: 5,
    unit_si: "mol %", unit_en: "mol %", desc: "Diluent CO₂ mole %." },
  { id: "fuel.N2",    label: "Fuel N₂",    panels: ["aft","cycle","mapping","combustor","flame"],
    kind: "fuel_species", species: "N2",    default: 0, range: [0, 100], step: 5,
    unit_si: "mol %", unit_en: "mol %", desc: "Diluent N₂ mole %." },
];

// Helper: filter AUTO_VARS by which panels the user has selected.
export function varsForPanels(selectedPanels){
  const set = new Set(selectedPanels);
  return AUTO_VARS.filter(v => v.panels.some(p => set.has(p)));
}

// ─────────────────────────────────────────────────────────────────────────
//  UNIT HANDLING
//  All internal storage (varSpecs.min/max/step/list, generated matrix rows,
//  runner inputs) is in SI. The UI converts at the boundary using these
//  helpers so the user always sees the units they've selected in the
//  global toggle.
//
//  For ABSOLUTE values (min, max, list entries): use toDisplay/toSi.
//  For DELTAS (step): use toDisplayDelta/toSiDelta. Temperature is the
//  only common case where these differ (offset matters for absolute,
//  drops out for delta).
// ─────────────────────────────────────────────────────────────────────────
export function unitFor(varDef, units){
  if (!varDef) return "";
  return (units === "ENG" && varDef.unit_en) ? varDef.unit_en : (varDef.unit_si || "");
}
export function toDisplay(varDef, siValue, units){
  if (siValue == null || !Number.isFinite(siValue)) return siValue;
  if (units !== "ENG" || !varDef?.siToEn) return siValue;
  return varDef.siToEn(siValue);
}
export function toSi(varDef, displayValue, units){
  if (displayValue == null || !Number.isFinite(displayValue)) return displayValue;
  if (units !== "ENG" || !varDef?.enToSi) return displayValue;
  return varDef.enToSi(displayValue);
}
// For step / delta values (e.g. ΔT in K vs ΔT in °F differ only by the
// scale factor 1.8, not the 273.15 offset). Subtracting the conversion of
// zero handles both linear and affine conversions correctly.
export function toDisplayDelta(varDef, siDelta, units){
  if (siDelta == null || !Number.isFinite(siDelta)) return siDelta;
  if (units !== "ENG" || !varDef?.siToEn) return siDelta;
  return varDef.siToEn(siDelta) - varDef.siToEn(0);
}
export function toSiDelta(varDef, displayDelta, units){
  if (displayDelta == null || !Number.isFinite(displayDelta)) return displayDelta;
  if (units !== "ENG" || !varDef?.enToSi) return displayDelta;
  return varDef.enToSi(displayDelta) - varDef.enToSi(0);
}
// Output catalog also has unit_si/unit_en/siToEn fields for outputs whose
// units change between SI and English (T*_K → °F, P*_bar → psia, mdot kg/s
// → lb/s, etc.). Outputs without those fields just use a single `unit`.
export function outputUnitFor(out, units){
  if (!out) return "";
  if (out.unit_si || out.unit_en){
    return (units === "ENG" && out.unit_en) ? out.unit_en : (out.unit_si || "");
  }
  return out.unit || "";
}
export function outputDisplayValue(out, siValue, units){
  if (siValue == null) return siValue;
  if (typeof siValue !== "number" || !Number.isFinite(siValue)) return siValue;
  if (units !== "ENG" || !out?.siToEn) return siValue;
  return out.siToEn(siValue);
}

// ─────────────────────────────────────────────────────────────────────────
//  AUTO_OUTPUTS — every output a panel can produce.
//  Each `pick(rs)` reads from the per-row results bundle:
//    rs.cycle  — /calc/cycle response (or local equivalent)
//    rs.map    — /calc/combustor_mapping response
//    rs.aft    — /calc/aft response (or local)
//    rs.exh_o2 — exhaust solve from O₂
//    rs.exh_co2— exhaust solve from CO₂
//    rs.psr    — PSR→PFR network result
//    rs.flame  — flame speed + autoignition result
//    rs.derived — extra computed values (MWI, fuel props, etc.)
// ─────────────────────────────────────────────────────────────────────────
// Output unit converters — each output that has a SI/EN distinction defines
// `unit_si`, `unit_en`, and `siToEn`. Outputs that don't change between unit
// systems (e.g. ppmvd, %, MW, mol fractions) use a single `unit` field.
const bar_to_psia = b => b * 14.5038;
const kgs_to_lbs  = k => k * 2.20462;
const ms_to_fts   = v => v * 3.28084;
const m2s_to_ft2s = a => a * 10.7639;
// Heating value: MJ/kg → BTU/lb. 1 MJ/kg = 1000 kJ/kg ÷ 2.326 kJ/kg per
// BTU/lb = 429.923 BTU/lb.
const MJkg_to_BTUlb  = e => e * 429.923;
// Volumetric heating value / Wobbe: MJ/m³ → BTU/scf at 60 °F / 1 atm.
// 1 BTU = 1055.06 J; 1 scf = 0.02832 m³  →  1 BTU/scf = 37 252 J/m³
// → 1 MJ/m³ = 26.839 BTU/scf.
const MJm3_to_BTUscf = e => e * 26.839;

export const AUTO_OUTPUTS = [
  // ── Cycle ──
  { id: "MW_net",       label: "MW Net",            panel: "cycle", unit: "MW",       pick: r => r.cycle?.MW_net },
  { id: "MW_gross",     label: "MW Gross",          panel: "cycle", unit: "MW",       pick: r => r.cycle?.MW_gross },
  { id: "MW_cap",       label: "MW Cap",            panel: "cycle", unit: "MW",       pick: r => r.cycle?.MW_cap },
  // η_LHV — backend field is `efficiency_LHV` (a fraction 0–1). Multiply by
  // 100 for %. The legacy fallback to `eta_LHV` was dead code (no such field).
  { id: "eta_LHV_pct",  label: "η LHV",             panel: "cycle", unit: "%",        pick: r => 100*(r.cycle?.efficiency_LHV ?? 0) },
  // Heat rate — backend returns kJ/kWh; we expose kJ/kWh in SI mode and
  // convert to BTU/kWh in ENG mode (1 kJ = 0.9478 BTU).
  { id: "HR",           label: "Heat Rate",         panel: "cycle",
    unit_si: "kJ/kWh", unit_en: "BTU/kWh",
    siToEn: x => x * 0.9478,
    pick: r => r.cycle?.heat_rate_kJ_per_kWh },
  { id: "T1",           label: "T1 (ambient)",      panel: "cycle", unit_si: "K", unit_en: "°F", siToEn: K_to_F, pick: r => r.cycle?.T1_K },
  { id: "T2",           label: "T2 (LPC exit)",     panel: "cycle", unit_si: "K", unit_en: "°F", siToEn: K_to_F, pick: r => r.cycle?.T2_K },
  // Backend uses snake_case `T2_5_K` for intercooler exit (LMS100 only);
  // the label keeps the conventional "T2c" name.
  { id: "T2c",          label: "T2c (IC exit)",     panel: "cycle", unit_si: "K", unit_en: "°F", siToEn: K_to_F, pick: r => r.cycle?.T2_5_K },
  { id: "T3",           label: "T3 (combustor in)", panel: "cycle", unit_si: "K", unit_en: "°F", siToEn: K_to_F, pick: r => r.cycle?.T3_K },
  { id: "T4",           label: "T4 (firing)",       panel: "cycle", unit_si: "K", unit_en: "°F", siToEn: K_to_F, pick: r => r.cycle?.T4_K },
  { id: "T5",           label: "T5 (turbine exit)", panel: "cycle", unit_si: "K", unit_en: "°F", siToEn: K_to_F, pick: r => r.cycle?.T5_K },
  { id: "T_Bulk",       label: "T_Bulk (flame)",    panel: "cycle", unit_si: "K", unit_en: "°F", siToEn: K_to_F, pick: r => r.cycle?.T_Bulk_K },
  { id: "P3",           label: "P3",                panel: "cycle", unit_si: "bar", unit_en: "psia", siToEn: bar_to_psia, pick: r => r.cycle?.P3_bar },
  // The backend doesn't return P4 directly (combustor exit P after the 4 %
  // ΔP isn't reported); P_exhaust_bar (turbine exit, 1.05 bar fixed) is the
  // closest available station. Renamed accordingly.
  { id: "P_exhaust",    label: "P_exhaust (turbine exit)", panel: "cycle", unit_si: "bar", unit_en: "psia", siToEn: bar_to_psia, pick: r => r.cycle?.P_exhaust_bar },
  { id: "mdot_air",     label: "mdot air (post-bleed)", panel: "cycle", unit_si: "kg/s", unit_en: "lb/s", siToEn: kgs_to_lbs, pick: r => r.cycle?.mdot_air_post_bleed_kg_s ?? r.cycle?.mdot_air_kg_s },
  { id: "mdot_fuel",    label: "mdot fuel",         panel: "cycle", unit_si: "kg/s", unit_en: "lb/s", siToEn: kgs_to_lbs, pick: r => r.cycle?.mdot_fuel_kg_s },
  { id: "mdot_bleed",   label: "mdot bleed",        panel: "cycle", unit_si: "kg/s", unit_en: "lb/s", siToEn: kgs_to_lbs, pick: r => r.cycle?.mdot_bleed_kg_s },
  { id: "mdot_water",   label: "mdot water",        panel: "cycle", unit_si: "kg/s", unit_en: "lb/s", siToEn: kgs_to_lbs, pick: r => r.cycle?.mdot_water_kg_s },
  { id: "phi4",         label: "φ4 (combustor exit)", panel: "cycle", unit: "—",     pick: r => r.cycle?.phi4 },
  { id: "FAR4",         label: "FAR4",              panel: "cycle", unit: "—",        pick: r => r.cycle?.FAR4 },
  { id: "phi_Bulk",     label: "φ_Bulk",            panel: "cycle", unit: "—",        pick: r => r.cycle?.phi_Bulk },
  // FAR_Bulk = FAR4 / combustor_air_frac — flame-zone fuel-air ratio
  { id: "FAR_Bulk",     label: "FAR_Bulk",          panel: "cycle", unit: "—",        pick: r => r.cycle?.FAR_Bulk },
  // Combustor dilution — fraction of W3 entering the flame zone
  { id: "combustor_air_frac", label: "Combustor air frac", panel: "cycle", unit: "—",  pick: r => r.cycle?.combustor_air_frac },
  // Fuel LHV that the cycle calculation actually used (after composition
  // normalization). Same units as AFT LHV but read from cycle response.
  { id: "LHV_fuel_cycle", label: "LHV (fuel, cycle)", panel: "cycle",
    unit_si: "MJ/kg", unit_en: "BTU/lb", siToEn: MJkg_to_BTUlb,
    pick: r => r.cycle?.LHV_fuel_MJ_per_kg },
  // Ambient density (drives mass flow capacity)
  { id: "rho_amb",      label: "ρ ambient",          panel: "cycle",
    unit_si: "kg/m³", unit_en: "lb/ft³",
    siToEn: x => x * 0.062428,
    pick: r => r.cycle?.rho_amb_kg_m3 },
  // Intercooler heat duty (LMS100 only, 0 for LM6000)
  { id: "intercooler_duty", label: "Intercooler duty", panel: "cycle", unit: "MW",     pick: r => r.cycle?.intercooler_duty_MW },
  { id: "W_turb_MW",    label: "W_turbine",         panel: "cycle", unit: "MW",       pick: r => r.cycle?.W_turbine_MW },
  { id: "W_comp_MW",    label: "W_compressor",      panel: "cycle", unit: "MW",       pick: r => r.cycle?.W_compressor_MW },
  { id: "bleed_air_frac", label: "Bleed air fraction", panel: "cycle", unit: "—",     pick: r => r.cycle?.bleed_air_frac },
  { id: "MWI_BTUscf_R", label: "MWI",               panel: "cycle", unit: "BTU/scf·√°R", pick: r => r.cycle?.fuel_flexibility?.mwi },
  { id: "MWI_status",   label: "MWI status",        panel: "cycle", unit: "—",        pick: r => r.cycle?.fuel_flexibility?.mwi_status },
  { id: "MWI_derate_pct", label: "MWI derate",      panel: "cycle", unit: "%",        pick: r => r.cycle?.fuel_flexibility?.mwi_derate_pct },

  // ── Combustor Mapping ──
  { id: "NOx15_mapping",      label: "NOx15", panel: "mapping", unit: "ppmvd", pick: r => r.map?.correlations?.NOx15 },
  { id: "CO15_mapping",       label: "CO15",  panel: "mapping", unit: "ppmvd", pick: r => r.map?.correlations?.CO15 },
  { id: "PX36_SEL",           label: "PX36_SEL",     panel: "mapping", unit: "psi",   pick: r => r.map?.correlations?.PX36_SEL },
  { id: "PX36_SEL_HI",        label: "PX36_SEL_HI",  panel: "mapping", unit: "psi",   pick: r => r.map?.correlations?.PX36_SEL_HI },
  { id: "T_AFT_IP",           label: "T_AFT IP",     panel: "mapping", unit_si: "K", unit_en: "°F", siToEn: K_to_F, pick: r => r.map?.circuits?.IP?.T_AFT_complete_K },
  { id: "T_AFT_OP",           label: "T_AFT OP",     panel: "mapping", unit_si: "K", unit_en: "°F", siToEn: K_to_F, pick: r => r.map?.circuits?.OP?.T_AFT_complete_K },
  { id: "T_AFT_IM",           label: "T_AFT IM",     panel: "mapping", unit_si: "K", unit_en: "°F", siToEn: K_to_F, pick: r => r.map?.circuits?.IM?.T_AFT_complete_K },
  { id: "T_AFT_OM",           label: "T_AFT OM",     panel: "mapping", unit_si: "K", unit_en: "°F", siToEn: K_to_F, pick: r => r.map?.circuits?.OM?.T_AFT_complete_K },
  { id: "phi_OM",             label: "φ OM (residual)", panel: "mapping", unit: "—",  pick: r => r.map?.phi_OM },
  { id: "DT_Main",            label: "DT_Main",      panel: "mapping", unit: "°F",    pick: r => r.map?.derived?.DT_Main_F },
  { id: "Tflame",             label: "Tflame (avg)", panel: "mapping", unit_si: "K", unit_en: "°F", siToEn: K_to_F, pick: r => r.map?.derived?.Tflame_K },
  { id: "C3_eff_pct",         label: "C3-effective", panel: "mapping", unit: "%",     pick: r => r.map?.derived?.C3_effective_pct },
  { id: "phi_OP_mult",        label: "φ_OP multiplier", panel: "mapping", unit: "—",  pick: r => r.map?.derived?.phi_OP_mult },
  { id: "P3_pressure_ratio",  label: "P3 ratio (P3/638)", panel: "mapping", unit: "—",pick: r => r.map?.derived?.pressure_ratio },
  { id: "FAR_stoich",         label: "FAR stoich",   panel: "mapping", unit: "—",     pick: r => r.map?.FAR_stoich },

  // ── AFT (Flame Temp & Properties) ──
  { id: "T_ad",               label: "Tad_eq", panel: "aft", unit_si: "K", unit_en: "°F", siToEn: K_to_F, pick: r => r.aft?.T_ad },
  { id: "T_mixed",            label: "T_mixed (3-stream)", panel: "aft", unit_si: "K", unit_en: "°F", siToEn: K_to_F, pick: r => r.aft?.T_mixed_inlet_K },
  { id: "LHV_mass",           label: "LHV (mass)",   panel: "aft",
    unit_si: "MJ/kg", unit_en: "BTU/lb", siToEn: MJkg_to_BTUlb,
    pick: r => r.derived?.LHV_mass },
  { id: "LHV_vol",            label: "LHV (vol)",    panel: "aft",
    unit_si: "MJ/m³", unit_en: "BTU/scf", siToEn: MJm3_to_BTUscf,
    pick: r => r.derived?.LHV_vol },
  { id: "MW_fuel",            label: "Fuel MW",      panel: "aft", unit: "g/mol",     pick: r => r.derived?.MW_fuel },
  { id: "SG",                 label: "Specific Gravity", panel: "aft", unit: "—",     pick: r => r.derived?.SG },
  { id: "WI",                 label: "Wobbe Index",  panel: "aft",
    unit_si: "MJ/m³", unit_en: "BTU/scf", siToEn: MJm3_to_BTUscf,
    pick: r => r.derived?.WI },
  // Modified Wobbe Index (BTU/scf·√°R, GE convention) — same units in
  // both SI and English mode; the formula already mixes BTU/scf with
  // absolute T in °R per the GE spec, so no conversion needed.
  { id: "MWI",                label: "MWI (Modified Wobbe)", panel: "aft", unit: "BTU/scf·√°R",
    pick: r => r.derived?.MWI },
  // Higher Heating Values — same unit shape as LHV.
  { id: "HHV_mass",           label: "HHV (mass)",   panel: "aft",
    unit_si: "MJ/kg", unit_en: "BTU/lb", siToEn: MJkg_to_BTUlb,
    pick: r => r.derived?.HHV_mass },
  { id: "HHV_vol",            label: "HHV (vol)",    panel: "aft",
    unit_si: "MJ/m³", unit_en: "BTU/scf", siToEn: MJm3_to_BTUscf,
    pick: r => r.derived?.HHV_vol },
  { id: "AFR_mass",           label: "Stoich AFR (mass)", panel: "aft", unit: "—",    pick: r => r.derived?.AFR_mass },
  // Cantera complete-combustion T_ad (no dissociation reference). In
  // free mode this comes from the JS calcTflameComplete closed-form
  // helper; in accurate mode from the backend's complete_combustion.run.
  { id: "T_ad_complete",      label: "Tad_CC", panel: "aft",
    unit_si: "K", unit_en: "°F", siToEn: K_to_F, pick: r => r.aft?.T_ad_complete },
  // Stoichiometric AFR on a volumetric (molar) basis.
  { id: "AFR_vol",            label: "Stoich AFR (vol)",   panel: "aft", unit: "—",   pick: r => r.derived?.AFR_vol },
  // Stoichiometric O₂ demand per mole of fuel (atom-balance derived).
  { id: "stoichO2",           label: "Stoich O₂ demand",   panel: "aft", unit: "mol/mol fuel", pick: r => r.derived?.stoichO2 },
  { id: "X_CO2",              label: "X_CO₂ (wet)",  panel: "aft", unit: "%",         pick: r => r.aft?.products?.CO2 },
  { id: "X_H2O",              label: "X_H₂O (wet)",  panel: "aft", unit: "%",         pick: r => r.aft?.products?.H2O },
  { id: "X_O2",               label: "X_O₂ (wet)",   panel: "aft", unit: "%",         pick: r => r.aft?.products?.O2 },
  { id: "X_CO",               label: "X_CO (wet)",   panel: "aft", unit: "%",         pick: r => r.aft?.products?.CO },
  { id: "X_NO",               label: "X_NO (wet)",   panel: "aft", unit: "%",         pick: r => r.aft?.products?.NO },
  { id: "X_OH",               label: "X_OH (wet)",   panel: "aft", unit: "%",         pick: r => r.aft?.products?.OH },

  // ── Exhaust Analysis ──
  { id: "exh_phi_from_O2",    label: "φ from O₂",         panel: "exhaust", unit: "—", pick: r => r.exh_o2?.phi },
  { id: "exh_T_ad_from_O2",   label: "T_ad from O₂",      panel: "exhaust", unit_si: "K", unit_en: "°F", siToEn: K_to_F, pick: r => r.exh_o2?.T_ad },
  { id: "exh_FAR_from_O2",    label: "FAR (mass) from O₂",panel: "exhaust", unit: "—", pick: r => r.exh_o2?.FAR_mass },
  { id: "exh_phi_from_CO2",   label: "φ from CO₂",        panel: "exhaust", unit: "—", pick: r => r.exh_co2?.phi },
  { id: "exh_T_ad_from_CO2",  label: "T_ad from CO₂",     panel: "exhaust", unit_si: "K", unit_en: "°F", siToEn: K_to_F, pick: r => r.exh_co2?.T_ad },
  { id: "exh_FAR_from_CO2",   label: "FAR (mass) from CO₂", panel: "exhaust", unit: "—", pick: r => r.exh_co2?.FAR_mass },
  // Air/Fuel inverses — analyst convenience (= 1 / FAR_mass).
  { id: "exh_AFR_from_O2",    label: "AFR (mass) from O₂",  panel: "exhaust", unit: "—",
    pick: r => { const f = r.exh_o2?.FAR_mass; return (f && f > 0) ? 1 / f : null; } },
  { id: "exh_AFR_from_CO2",   label: "AFR (mass) from CO₂", panel: "exhaust", unit: "—",
    pick: r => { const f = r.exh_co2?.FAR_mass; return (f && f > 0) ? 1 / f : null; } },

  // ── PSR-PFR Combustor ──
  // The runner normalizes both Free (calcCombustorNetwork) and Accurate
  // (Cantera /calc/combustor) responses to the SAME field-name shape, so
  // pickers can be simple. Backend uses verbose `_vd_` infix and `_dry_`
  // suffix; we strip those for the picker. T_exit aliases to T_psr in Free
  // mode (no separate PFR exit T in the JS reduced-order solver).
  { id: "T_psr",              label: "T_PSR",        panel: "combustor", unit_si: "K", unit_en: "°F", siToEn: K_to_F, pick: r => r.psr?.T_psr },
  { id: "T_exit",             label: "T_exit (PFR)", panel: "combustor", unit_si: "K", unit_en: "°F", siToEn: K_to_F, pick: r => r.psr?.T_exit },
  { id: "psr_NO_ppm",         label: "NOx PSR",      panel: "combustor", unit: "ppmvd", pick: r => r.psr?.NO_ppm_psr },
  { id: "psr_CO_ppm",         label: "CO PSR",       panel: "combustor", unit: "ppmvd", pick: r => r.psr?.CO_ppm_psr },
  { id: "exit_NO_ppm",        label: "NOx exit",     panel: "combustor", unit: "ppmvd", pick: r => r.psr?.NO_ppm_exit },
  { id: "exit_CO_ppm",        label: "CO exit",      panel: "combustor", unit: "ppmvd", pick: r => r.psr?.CO_ppm_exit },
  { id: "NOx_15_psr",         label: "NOx15", panel: "combustor", unit: "ppmvd", pick: r => r.psr?.NO_ppm_15O2 },
  { id: "CO_15_psr",          label: "CO15",  panel: "combustor", unit: "ppmvd", pick: r => r.psr?.CO_ppm_15O2 },
  { id: "O2_dry_pct",         label: "Exhaust O₂ (dry)", panel: "combustor", unit: "%", pick: r => r.psr?.O2_pct },
  { id: "conv_psr_pct",       label: "PSR conversion", panel: "combustor", unit: "%", pick: r => r.psr?.conv_psr },
  { id: "tau_pfr_ms",         label: "τ_PFR",        panel: "combustor", unit: "ms",  pick: r => r.psr?.tau_pfr_ms },
  { id: "tau_total_ms",       label: "τ_total",      panel: "combustor", unit: "ms",  pick: r => r.psr?.tau_total_ms },
  // Adiabatic flame temperatures — full Cantera HP equilibrium AND no-
  // dissociation complete-combustion. Reference values shown alongside
  // the kinetic T_psr / T_exit on the panel.
  { id: "T_ad_equilibrium",   label: "Tad_eq (ref)", panel: "combustor",
    unit_si: "K", unit_en: "°F", siToEn: K_to_F, pick: r => r.psr?.T_ad_equilibrium },
  { id: "T_ad_complete_comb", label: "Tad_CC (ref)", panel: "combustor",
    unit_si: "K", unit_en: "°F", siToEn: K_to_F, pick: r => r.psr?.T_ad_complete },

  // ── Flame Speed & Blowoff ──
  // S_L conventionally reported in cm/s globally — keep single unit.
  { id: "S_L_cms",            label: "S_L",          panel: "flame", unit: "cm/s",    pick: r => r.flame?.SL_cms },
  { id: "tau_chem_ms",        label: "τ_chem",       panel: "flame", unit: "ms",      pick: r => r.flame?.tau_chem_ms },
  { id: "tau_flow_ms",        label: "τ_flow",       panel: "flame", unit: "ms",      pick: r => r.flame?.tau_flow_ms },
  { id: "Damkohler",          label: "Damköhler",    panel: "flame", unit: "—",       pick: r => r.flame?.Da },
  { id: "blowoff_velocity",   label: "Blowoff velocity", panel: "flame", unit_si: "m/s", unit_en: "ft/s", siToEn: ms_to_fts, pick: r => r.flame?.blowoff_velocity },
  { id: "stable",             label: "Flame stable", panel: "flame", unit: "bool",    pick: r => r.flame?.stable },
  { id: "tau_BO_ms",          label: "τ_BO (Zukoski)", panel: "flame", unit: "ms",    pick: r => r.flame?.tau_BO_ms },
  { id: "alpha_th",           label: "α_th",         panel: "flame", unit_si: "m²/s", unit_en: "ft²/s", siToEn: m2s_to_ft2s, pick: r => r.flame?.alpha_th },
  { id: "g_c",                label: "g_c (Lewis-vE)", panel: "flame", unit: "1/s",   pick: r => r.flame?.g_c },
  { id: "tau_ign_ms",         label: "τ_ign",        panel: "flame", unit: "ms",      pick: r => r.flame?.tau_ign_ms },
  { id: "tau_res_ms",         label: "τ_res",        panel: "flame", unit: "ms",      pick: r => r.flame?.tau_res_ms },
  { id: "ignition_safe",      label: "Ignition safe (τ_ign/τ_res>3)", panel: "flame", unit: "bool", pick: r => r.flame?.ignition_safe },
  { id: "flashback_margin",   label: "Flashback margin V/S_T", panel: "flame", unit: "—", pick: r => r.flame?.flashback_margin },
  { id: "premixer_safe",      label: "Premixer SAFE", panel: "flame", unit: "bool",   pick: r => r.flame?.premixer_safe },
];

// Filter outputs to those whose panel is in the running set.
export function outputsForPanels(panels){
  const set = new Set(panels);
  return AUTO_OUTPUTS.filter(o => set.has(o.panel));
}

// ─────────────────────────────────────────────────────────────────────────
//  Matrix size cap. The full factorial of 4 variables with default step
//  sizes can explode to 2 M+ rows (e.g. T_air × H2 × τ_PSR × L_PFR =
//  66 × 21 × 40 × 40 ≈ 2.2 M). Even Free-mode JS would freeze the tab for
//  minutes; Accurate mode would take days. Cap at 10 000 rows — beyond
//  that the user must narrow ranges or remove variables.
// ─────────────────────────────────────────────────────────────────────────
export const MAX_MATRIX_SIZE = 10000;

// Cheaply compute the cross-product row count WITHOUT enumerating any
// values. Used by the UI to display the count + gate matrix generation
// before it blocks the main thread.
export function countMatrixSize(varSpecs){
  if (!varSpecs || varSpecs.length === 0) return 0;
  let total = 1;
  for (const s of varSpecs){
    const n = countValues(s);
    if (n === 0) return 0;
    total *= n;
    // Bail early if we're already orders of magnitude past the cap — keeps
    // total from overflowing Number.MAX_SAFE_INTEGER on insane configs.
    if (total > MAX_MATRIX_SIZE * 1000) return total;
  }
  return total;
}

function countValues(spec){
  if (spec.kind === "enum" || spec.kind === "bool"){
    return Array.isArray(spec.list) ? spec.list.length : 0;
  }
  if (spec.mode === "list" && Array.isArray(spec.list)){
    return spec.list.length;
  }
  const min = +spec.min, max = +spec.max, step = +spec.step;
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step) || step <= 0) return 0;
  if (max < min) return 1;
  // Same +1 endpoint inclusion logic as enumerateValues so counts agree.
  return Math.floor((max - min) / step + 1e-9) + 1;
}

// ─────────────────────────────────────────────────────────────────────────
//  generateMatrix(varSpecs)
//  Full-factorial cross-product over per-variable value lists.
//
//  varSpecs: [
//    {id, kind, mode, min, max, step, list, balanceSpecies?},
//  ]
//
//  mode = 'range' uses {min, max, step}; 'list' uses {list: [v1,v2,...]}.
//  Returns: [{varId: value, ...}, ...] one entry per variable per row.
//  For fuel_species vars, also captures balanceSpecies onto each row so the
//  runner knows how to renormalise.
//
//  HARD GUARD: returns [] if the cross product would exceed
//  MAX_MATRIX_SIZE. Caller must check countMatrixSize() first and surface
//  an error to the user before the matrix-too-large state propagates.
// ─────────────────────────────────────────────────────────────────────────
export function generateMatrix(varSpecs){
  // Refuse to enumerate anything past the cap. This is the single line
  // that prevents the 2.2-M-row tab freeze.
  if (countMatrixSize(varSpecs) > MAX_MATRIX_SIZE) return [];

  const valuesPerVar = varSpecs.map(s => ({
    spec: s,
    values: enumerateValues(s),
  })).filter(p => p.values.length > 0);

  if (valuesPerVar.length === 0) return [];

  // Cross product
  let rows = [{}];
  for (const {spec, values} of valuesPerVar){
    const next = [];
    for (const r of rows){
      for (const v of values){
        const merged = {...r, [spec.id]: v};
        if (spec.kind === "fuel_species" && spec.balanceSpecies){
          merged.__fuelBalance = merged.__fuelBalance || {};
          merged.__fuelBalance[spec.species] = spec.balanceSpecies;
        }
        next.push(merged);
      }
    }
    rows = next;
  }
  return rows;
}

function enumerateValues(spec){
  if (spec.kind === "enum" || spec.kind === "bool"){
    return Array.isArray(spec.list) && spec.list.length ? spec.list : [];
  }
  // fuel_species, ox_species, number — all use range or list
  if (spec.mode === "list" && Array.isArray(spec.list) && spec.list.length){
    return spec.list.slice();
  }
  // range mode
  const min = +spec.min, max = +spec.max, step = +spec.step;
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step) || step <= 0) return [];
  if (max < min) return [min];
  const out = [];
  // Use integer counter to avoid floating-point drift on long ranges.
  const n = Math.floor((max - min) / step + 1e-9);
  for (let i = 0; i <= n; i++){
    const v = min + i * step;
    out.push(+v.toFixed(8));
  }
  // Ensure exact endpoint inclusion when step doesn't divide range cleanly.
  if (Math.abs(out[out.length-1] - max) > step * 1e-3){
    out.push(+max.toFixed(8));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
//  Reorder varSpecs for cache locality. The factorial cross-product in
//  generateMatrix iterates so that the FIRST-listed variable changes
//  SLOWEST and the LAST-listed changes FASTEST. By putting variables
//  that drive the heaviest, cache-able backend calls FIRST, every
//  fast-varying inner loop hits the cache for those calls.
//
//  Example: user sweeps T_amb (cycle-affecting) and L_PFR (combustor-
//  only). Without reordering, if L_PFR is added first the outer loop
//  is L_PFR, the inner loop is T_amb — every (L_PFR, T_amb) cell fires
//  a fresh Cycle call (T_amb cycles through every L_PFR value, no
//  cache reuse). With reordering, T_amb becomes outer, L_PFR inner —
//  Cycle runs once per T_amb and gets cached for every L_PFR value
//  inside that group.
//
//  The Excel/preview column order is unchanged (those iterate by the
//  user's add-order activeVarSpecs); only the matrix row order changes.
// ─────────────────────────────────────────────────────────────────────────

// Tier 1 (slowest-varying ideal): vars that affect the Cycle backend
// call directly — Cycle is the heaviest single call (~3-5 s) and its
// cache key doesn't include phi or panel-specific vars.
const _TIER1_CYCLE_VARS = new Set([
  "engine", "P_amb", "T_amb", "RH", "load_pct", "T_cool",
  "com_air_frac", "T_fuel", "WFR", "water_mode",
  "bleed_open_pct", "bleed_valve_size_pct", "emissionsMode",
]);
// Tier 2: vars that affect Mapping (which depends on Cycle outputs but
// also has its own per-circuit args).
const _TIER2_MAPPING_VARS = new Set([
  "mapW36w3", "mapPhiIP", "mapPhiOP", "mapPhiIM",
  "mapFracIP", "mapFracOP", "mapFracIM", "mapFracOM",
]);
// Tier 3: sidebar operating-point vars used by AFT, PSR, Flame Speed,
// Exhaust. Includes the operating-point mutex group (phi/FAR/T_flame).
const _TIER3_SIDEBAR_VARS = new Set([
  "phi", "FAR", "T_flame", "T_air", "P",
]);
// Tier 4 (fastest-varying ideal): panel-specific vars — each only
// affects one downstream call.
const _TIER4_PANEL_VARS = new Set([
  "tau_psr", "L_pfr", "V_pfr", "heatLossFrac",
  "velocity", "Lchar", "Dfh", "Lpremix", "Vpremix",
  "measO2", "measCO2",
]);

function _cacheLocalityTier(spec){
  if (!spec) return 5;
  // Fuel composition vars affect Cycle / Mapping / AFT etc. — Tier 1.
  if (spec.kind === "fuel_species") return 1;
  if (_TIER1_CYCLE_VARS.has(spec.id)) return 1;
  if (_TIER2_MAPPING_VARS.has(spec.id)) return 2;
  if (_TIER3_SIDEBAR_VARS.has(spec.id)) return 3;
  if (_TIER4_PANEL_VARS.has(spec.id)) return 4;
  return 5;  // unknown — sort to the end
}

export function reorderForCacheLocality(varSpecs){
  if (!Array.isArray(varSpecs) || varSpecs.length < 2) return varSpecs;
  // Stable sort: tier ascending (Tier 1 first = slowest-varying outer
  // loop = best cache hits for the heavy Cycle/Mapping backend calls).
  // Map to (tier, originalIndex) so vars within the same tier preserve
  // the user's add order.
  const indexed = varSpecs.map((s, i) => ({s, i, t: _cacheLocalityTier(s)}));
  indexed.sort((a, b) => (a.t - b.t) || (a.i - b.i));
  return indexed.map(x => x.s);
}

// ─────────────────────────────────────────────────────────────────────────
//  Auto-include panel dependencies. Mapping needs Cycle internally.
// ─────────────────────────────────────────────────────────────────────────
export function expandPanelDeps(selectedPanels){
  const out = new Set(selectedPanels);
  for (const id of selectedPanels){
    const def = AUTOMATABLE_PANELS.find(p => p.id === id);
    (def?.requires || []).forEach(r => out.add(r));
  }
  return [...out];
}

// ─────────────────────────────────────────────────────────────────────────
//  Rebalance a fuel composition vector when one species is being varied.
//  Takes the baseline composition, the override (varId → value), and a map
//  of {speciesBeingVaried: balanceSpeciesName}.
//  Returns a new composition object that sums to 100 %.
// ─────────────────────────────────────────────────────────────────────────
export function rebalanceFuel(baselineFuel, overrides, fuelBalance){
  if (!fuelBalance) return baselineFuel;
  const next = {...baselineFuel};
  // Apply each species override in turn; balance the matching balance species
  for (const [varId, val] of Object.entries(overrides)){
    if (!varId.startsWith("fuel.")) continue;
    const species = varId.slice("fuel.".length);
    const balance = fuelBalance[species];
    if (!balance || balance === species) continue;
    const oldVal = +(next[species] || 0);
    const oldBalance = +(next[balance] || 0);
    const newVal = Math.max(0, Math.min(100, +val));
    const delta = newVal - oldVal;
    next[species] = newVal;
    next[balance] = Math.max(0, oldBalance - delta);
  }
  // Final renormalisation to land exactly on 100 % (handles rounding).
  const sum = Object.values(next).reduce((a,b) => a + (+b||0), 0);
  if (sum > 0 && Math.abs(sum - 100) > 0.01){
    const k = 100 / sum;
    for (const sp of Object.keys(next)) next[sp] = +(next[sp] * k).toFixed(4);
  }
  return next;
}

// ─────────────────────────────────────────────────────────────────────────
//  Format a row value for the Excel sheet. Numbers get reasonable decimal
//  precision, booleans become "TRUE"/"FALSE", strings pass through.
// ─────────────────────────────────────────────────────────────────────────
export function formatRowValue(v, unit, label){
  if (v == null || (typeof v === "number" && !Number.isFinite(v))) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number"){
    // If caller supplied unit/label context, delegate to the unit-aware
    // smartFormat helper so display matches the project-wide rounding
    // contract (temperatures → integer, φ → 3 dec, FAR → 4 dec, etc.).
    if (unit !== undefined || label !== undefined){
      return smartFormat(v, unit, label);
    }
    // No-context fallback for legacy callers (preview table, etc.).
    const a = Math.abs(v);
    if (a >= 1e6) return v.toExponential(3);
    if (a >= 100) return +v.toFixed(2);
    if (a >= 1)   return +v.toFixed(4);
    if (a >= 0.001) return +v.toFixed(5);
    return v === 0 ? 0 : +v.toExponential(3);
  }
  return String(v);
}
