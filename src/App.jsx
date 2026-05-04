import { Fragment, memo, useState, useMemo, useCallback, useEffect, useRef, createContext, useContext } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as XLSX from "xlsx-js-style";   // drop-in replacement that supports cell styles
import { smartRound, excelNumberFormat, smartFormat } from "./format";
import JSZip from "jszip";
import {
  AUTOMATABLE_PANELS, AUTO_VARS, AUTO_OUTPUTS,
  varsForPanels, outputsForPanels,
  generateMatrix, countMatrixSize, MAX_MATRIX_SIZE,
  expandPanelDeps, rebalanceFuel, formatRowValue,
  reorderForCacheLocality,
  unitFor, toDisplay, toSi, toDisplayDelta, toSiDelta,
  outputUnitFor, outputDisplayValue,
} from "./automation";
import { useAuth, AuthModal } from "./auth.jsx";
import { AccountPanel } from "./AccountPanel.jsx";
import * as api from "./api.js";
import { estimateRunSeconds, recordRunPerf } from "./perfEstimator";

/* ══════════════════════════════════════════════════════════════
   UNIT SYSTEM
   ══════════════════════════════════════════════════════════════ */
const UnitCtx = createContext("SI");
// `accurate` is now DERIVED from Application Mode (accurate = mode !== "free")
// in App. When true AND user has online access, panels route calcs to the
// Cantera backend; otherwise they use the in-browser JS reduced-order models.
// Exposed via context to avoid prop-drilling. The `setAccurate` field is a
// no-op stub kept for context-shape compatibility — the canonical control is
// the mode picker in the header.
const AccurateCtx = createContext({ accurate:false, setAccurate:()=>{}, available:false });
// Busy tracker — any Cantera call registers a task here while in-flight so the global overlay
// can show a large "calculations in progress" banner that disappears when all tasks complete.
const BusyCtx = createContext({ begin:()=>()=>{}, tasks:[] });
// Generic-but-honest labels for the global busy banner. Kept short — the
// banner already carries the timer and the "please wait" framing, so each
// label just says which Cantera workload is running. Accuracy beats
// verbosity: e.g. combustor_mapping is correlation-based now (the per-
// circuit T_AFT calls go through Cantera HP-equilibrium, but there is
// no PSR/PFR network here).
const BUSY_LABELS = {
  aft:               "Computing adiabatic flame temperature…",
  flame:             "Solving laminar flame speed (Cantera FreeFlame)…",
  combustor:         "Running PSR → PFR combustor network…",
  exhaust:           "Inverting exhaust O₂ / CO₂ to equivalence ratio…",
  props:             "Computing mixture properties…",
  autoignition:      "Integrating 0D ignition-delay…",
  cycle:             "Solving gas-turbine cycle…",
  combustor_mapping: "Computing combustor mapping correlations…",
  flame_sweep:       "Sweeping laminar flame speed across φ…",
  load_sweep:        "Running load sweep…",
};
const UC = {
  SI: { T:{u:"K",from:v=>v,to:v=>v}, P:{u:"atm",from:v=>v,to:v=>v}, vel:{u:"m/s",from:v=>v,to:v=>v}, len:{u:"m",from:v=>v,to:v=>v}, lenSmall:{u:"cm",from:v=>v,to:v=>v}, SL:{u:"cm/s",from:v=>v,to:v=>v}, mass:{u:"kg",from:v=>v,to:v=>v}, vol:{u:"m³",from:v=>v,to:v=>v}, mass_flow:{u:"kg/s",from:v=>v,to:v=>v}, energy_mass:{u:"MJ/kg",from:v=>v,to:v=>v}, energy_vol:{u:"MJ/m³",from:v=>v,to:v=>v}, cp:{u:"J/(mol·K)",from:v=>v,to:v=>v}, h_mol:{u:"kJ/mol",from:v=>v,to:v=>v}, s_mol:{u:"J/(mol·K)",from:v=>v,to:v=>v}, time:{u:"ms",from:v=>v,to:v=>v}, afr_mass:{u:"kg/kg",from:v=>v,to:v=>v} },
  ENG: { T:{u:"°F",from:K=>(K-273.15)*9/5+32,to:F=>(F-32)*5/9+273.15}, P:{u:"psia",from:a=>a*14.696,to:p=>p/14.696}, vel:{u:"ft/s",from:m=>m*3.28084,to:f=>f/3.28084}, len:{u:"ft",from:m=>m*3.28084,to:f=>f/3.28084}, lenSmall:{u:"in",from:c=>c/2.54,to:i=>i*2.54}, SL:{u:"ft/s",from:c=>c/30.48,to:f=>f*30.48}, mass:{u:"lb",from:k=>k*2.20462,to:l=>l/2.20462}, vol:{u:"ft³",from:m3=>m3*35.3147,to:f3=>f3/35.3147}, mass_flow:{u:"lb/s",from:k=>k*2.20462,to:l=>l/2.20462}, energy_mass:{u:"BTU/lb",from:v=>v*429.923,to:v=>v/429.923}, energy_vol:{u:"BTU/scf",from:v=>v*26.839,to:v=>v/26.839}, cp:{u:"BTU/(lbmol·°F)",from:v=>v*0.000238846*453.592*5/9,to:v=>v/(0.000238846*453.592*5/9)}, h_mol:{u:"BTU/lbmol",from:v=>v*429.923,to:v=>v/429.923}, s_mol:{u:"BTU/(lbmol·°F)",from:v=>v*0.000238846*453.592*5/9,to:v=>v/(0.000238846*453.592*5/9)}, time:{u:"ms",from:v=>v,to:v=>v}, afr_mass:{u:"lb/lb",from:v=>v,to:v=>v} }
};
function uv(units,key,val){return UC[units][key].from(val);}
function uvI(units,key,disp){return UC[units][key].to(disp);}  // display units -> SI
function uu(units,key){return UC[units][key].u;}

// Default mapping tables — φ for IP/OP/IM as a function of T3 (°F) and BRNDMD.
// Used by the Combustor Mapping panel: once T3 and BRNDMD are known, look up
// the three φ values and auto-fill the IP/OP/IM circuit inputs. User can edit
// any cell; software re-reads continuously. Linear interpolation between rows.
function _tblRow(T3, OP, IP, IM){ return {T3, OP, IP, IM}; }
// ── Two named mapping-table presets ────────────────────────────────────
// UNMAPPED  — raw factory φ-vs-T3 lookups (BRNDMD 7 holds φ_OP flat, IP=0,
//             IM=0.51; BRNDMD 6 has IP=1.0 throughout). This is the
//             starting state every fresh session loads into the panel.
// MAPPED    — calibrated lookups derived from rig data (BRNDMD 7 walks
//             φ_OP down 0.85→0.45 across T3, IP=0.25, IM steps 0.58→0.57;
//             BRNDMD 6 has IP=1.2 for T3≤670 K then IP=1.0).
// The two are toggled by the bimodal "Reset to Unmapped / Reset to Mapped"
// button on the Combustor Mapping panel. T3 stored in °F as elsewhere.
//
// Common rows shared by every BRNDMD: 500..700 in 10 °F steps (21 rows),
// then 750 / 800 / 850 (sparse coverage above the deck T3 ceiling).
const _T3_DENSE  = (i) => 500 + i*10;          // 500, 510, ..., 700
const _T3_SPARSE = [750, 800, 850];
const _denseRows  = (OP, IP, IM) =>
  Array.from({length: 21}, (_, i) => _tblRow(_T3_DENSE(i), OP, IP, IM));
const _sparseRows = (OP, IP, IM) =>
  _T3_SPARSE.map(T3 => _tblRow(T3, OP, IP, IM));

const UNMAPPED_MAPPING_TABLES = {
  7: [
    // BRNDMD 7 unmapped: φ_OP held flat at 0.80 across the entire T3
    // window; IP=0, IM=0.51 every row.
    ..._denseRows (0.80, 0.0, 0.51),
    ..._sparseRows(0.80, 0.0, 0.51),
  ],
  6: [
    // BRNDMD 6 unmapped: φ_IM lowered 0.51 → 0.49 on 2026-05-02
    // per site recalibration. φ_OP=0.70 and φ_IP=1.0 unchanged.
    ..._denseRows (0.70, 1.0, 0.49),
    ..._sparseRows(0.70, 1.0, 0.49),
  ],
  4: [
    // BRNDMD 4 unmapped: φ_OP=0.70, φ_IP=2.0, φ_IM=0.43.
    // (Briefly bumped IM to 0.47 on 2026-05-02 then reverted same day.)
    ..._denseRows (0.70, 2.0, 0.43),
    ..._sparseRows(0.70, 2.0, 0.43),
  ],
  2: [
    ..._denseRows (0.85, 5.3, 0.0),
    ..._sparseRows(0.85, 5.3, 0.0),
  ],
};

const MAPPED_MAPPING_TABLES = {
  7: [
    // BRNDMD 7 mapped: φ_OP=0.85 for T3 ≤ 660, then 0.75/0.65/0.55/0.45
    // at 670/680/690/700+. IP=0.25 throughout. IM=0.58 for T3 ≤ 680,
    // 0.575 at 690, 0.57 for T3 ≥ 700.
    ...Array.from({length: 17}, (_, i) => _tblRow(500 + i*10, 0.85, 0.25, 0.58)),  // 500–660
    _tblRow(670, 0.75, 0.25, 0.58),
    _tblRow(680, 0.65, 0.25, 0.58),
    _tblRow(690, 0.55, 0.25, 0.575),
    _tblRow(700, 0.45, 0.25, 0.57),
    _tblRow(750, 0.45, 0.25, 0.57),
    _tblRow(800, 0.45, 0.25, 0.57),
    _tblRow(850, 0.45, 0.25, 0.57),
  ],
  6: [
    // BRNDMD 6 mapped: IP=1.2 for T3 ≤ 670, IP=1.0 for T3 ≥ 680.
    // φ_IM lowered 0.51 → 0.49 on 2026-05-02 per site recalibration
    // (same change applied to UNMAPPED to keep them in lockstep until
    // separate rig data lands for BD6).
    ...Array.from({length: 18}, (_, i) => _tblRow(500 + i*10, 0.70, 1.2, 0.49)),   // 500–670
    _tblRow(680, 0.70, 1.0, 0.49),
    _tblRow(690, 0.70, 1.0, 0.49),
    _tblRow(700, 0.70, 1.0, 0.49),
    _tblRow(750, 0.70, 1.0, 0.49),
    _tblRow(800, 0.70, 1.0, 0.49),
    _tblRow(850, 0.70, 1.0, 0.49),
  ],
  4: [
    // BRNDMD 4 mapped: same as UNMAPPED (no rig data yet for BD4).
    // φ_OP=0.70, φ_IP=2.0, φ_IM=0.43.
    ..._denseRows (0.70, 2.0, 0.43),
    ..._sparseRows(0.70, 2.0, 0.43),
  ],
  2: [
    ..._denseRows (0.85, 5.3, 0.0),
    ..._sparseRows(0.85, 5.3, 0.0),
  ],
};

// First-load seed for fresh sessions = UNMAPPED. Existing call sites
// importing DEFAULT_MAPPING_TABLES keep working unchanged. Users with
// localStorage edits are unaffected (the seed only fires on first load).
const DEFAULT_MAPPING_TABLES = UNMAPPED_MAPPING_TABLES;

// Linear interpolation of {OP, IP, IM} at T3 through a sorted mapping table.
// Clamps to first/last row if T3 is outside the table range.
function interpMappingTable(table, T3_F){
  if(!table || !table.length) return null;
  const s = [...table].sort((a,b) => a.T3 - b.T3);
  if(T3_F <= s[0].T3)              return {OP: s[0].OP, IP: s[0].IP, IM: s[0].IM};
  const last = s[s.length-1];
  if(T3_F >= last.T3)              return {OP: last.OP, IP: last.IP, IM: last.IM};
  for(let i=0; i<s.length-1; i++){
    const a=s[i], b=s[i+1];
    if(T3_F >= a.T3 && T3_F <= b.T3){
      const t = (T3_F - a.T3) / Math.max(1e-9, b.T3 - a.T3);
      return {
        OP: a.OP + t*(b.OP - a.OP),
        IP: a.IP + t*(b.IP - a.IP),
        IM: a.IM + t*(b.IM - a.IM),
      };
    }
  }
  return null;
}

// Burner mode lookup — piecewise-constant function of net shaft power (MW).
// When emissionsMode is true (default): the full ladder
//   MW ≤ 10 → 1,  ≤ 45 → 2,  ≤ 65 → 4,  ≤ 75 → 6,  > 75 → 7.
// When emissionsMode is false: the ladder caps at 4 — BRNDMD holds at 4
// once it steps up from 2 to 4 and never progresses to 6 or 7.
function calcBRNDMD(MW_net, emissionsMode=true, override=null){
  // override: when a number, the Engine Protection Logic has forced the
  // burner mode to a specific value (typically 4, 6, or 7). The override
  // wins over the natural ladder so the protection state machine in the
  // Live Mapping section can stage the engine through 4 → 6 → 7 transitions
  // regardless of MW or emissionsMode.
  if (override != null && Number.isFinite(override)) return Math.round(override);
  const mw=Number(MW_net);
  if(!Number.isFinite(mw)||mw<=0)return 0;
  if(mw<=10)return 1;
  if(mw<=45)return 2;
  if(!emissionsMode)return 4;  // disabled: hold at 4 for all MW > 45
  if(mw<=65)return 4;
  if(mw<=75)return 6;
  return 7;
}

/* ══════════════════════════════════════════════════════════════
   NASA POLYNOMIAL DATABASE
   ══════════════════════════════════════════════════════════════ */
const SP={CH4:{nm:"Methane",MW:16.043,lo:[1000,5.149,-1.367e-2,4.918e-5,-4.847e-8,1.667e-11,-1.025e4,-4.641],hi:[6000,7.4851e-2,1.339e-2,-5.733e-6,1.223e-9,-1.018e-13,-9.468e3,18.437],Hf:-74870,C:1,H:4,O:0},C2H6:{nm:"Ethane",MW:30.069,lo:[1000,4.291,-5.502e-3,5.994e-5,-7.085e-8,2.687e-11,-1.152e4,2.667],hi:[6000,1.072,2.169e-2,-1.003e-5,2.214e-9,-1.900e-13,-1.143e4,15.116],Hf:-83820,C:2,H:6,O:0},C3H8:{nm:"Propane",MW:44.096,lo:[1000,4.211,1.739e-3,7.092e-5,-9.217e-8,3.644e-11,-1.440e4,5.612],hi:[6000,7.534e-1,3.141e-2,-1.465e-5,3.252e-9,-2.796e-13,-1.644e4,11.844],Hf:-104680,C:3,H:8,O:0},C4H10:{nm:"n-Butane",MW:58.122,lo:[1000,5.550,-3.318e-3,1.215e-4,-1.540e-7,6.058e-11,-1.791e4,1.535],hi:[6000,1.534e1,-9.240e-3,2.076e-5,-1.265e-8,2.649e-12,-2.139e4,-5.649e1],Hf:-125600,C:4,H:10,O:0},C2H4:{nm:"Ethylene",MW:28.054,lo:[1000,3.959,-7.571e-3,5.710e-5,-6.764e-8,2.693e-11,5.090e3,4.097],hi:[6000,2.036,1.464e-2,-6.711e-6,1.472e-9,-1.257e-13,4.939e3,10.309],Hf:52500,C:2,H:4,O:0},H2:{nm:"Hydrogen",MW:2.016,lo:[1000,2.344,7.981e-3,-1.948e-5,2.016e-8,-7.376e-12,-917.9,0.683],hi:[6000,3.337,-4.940e-5,4.995e-7,-1.796e-10,2.003e-14,-950.2,-3.205],Hf:0,C:0,H:2,O:0},CO:{nm:"Carbon Monoxide",MW:28.010,lo:[1000,3.580,-6.104e-4,1.017e-6,9.070e-10,-9.044e-13,-1.434e4,3.508],hi:[6000,2.715,2.063e-3,-9.988e-7,2.301e-10,-2.036e-14,-1.415e4,7.819],Hf:-110530,C:1,H:0,O:1},O2:{nm:"Oxygen",MW:31.998,lo:[1000,3.782,-2.997e-3,9.847e-6,-9.681e-9,3.244e-12,-1064,3.658],hi:[6000,3.283,1.483e-3,-7.580e-7,2.095e-10,-2.167e-14,-1089,5.453],Hf:0,C:0,H:0,O:2},N2:{nm:"Nitrogen",MW:28.014,lo:[1000,3.531,-1.237e-4,-5.030e-7,2.435e-9,-1.409e-12,-1047,2.967],hi:[6000,2.953,1.397e-3,-4.926e-7,7.860e-11,-4.608e-15,-924,5.872],Hf:0,C:0,H:0,O:0},H2O:{nm:"Water",MW:18.015,lo:[1000,4.199,-2.036e-3,6.520e-6,-5.488e-9,1.772e-12,-3.029e4,-0.849],hi:[6000,3.034,2.177e-3,-1.641e-7,-9.704e-11,1.682e-14,-3.000e4,4.967],Hf:-241826,C:0,H:2,O:1},CO2:{nm:"Carbon Dioxide",MW:44.009,lo:[1000,2.357,8.985e-3,-7.124e-6,2.459e-9,-1.437e-13,-4.837e4,9.901],hi:[6000,3.857,4.414e-3,-2.215e-6,5.235e-10,-4.721e-14,-4.876e4,2.272],Hf:-393510,C:1,H:0,O:2},OH:{nm:"Hydroxyl",MW:17.007,lo:[1000,3.992,-2.401e-3,4.618e-6,-3.881e-9,1.364e-12,3615,-0.104],hi:[6000,3.093,5.484e-4,1.265e-7,-8.795e-11,1.174e-14,3859,4.477],Hf:38987,C:0,H:1,O:1},NO:{nm:"Nitric Oxide",MW:30.006,lo:[1000,4.219,-4.639e-3,1.104e-5,-9.336e-9,2.804e-12,9845,2.281],hi:[6000,3.261,1.191e-3,-4.291e-7,6.945e-11,-4.033e-15,9921,6.369],Hf:90291,C:0,H:0,O:1},O:{nm:"O atom",MW:15.999,lo:[1000,3.169,-3.280e-3,6.644e-6,-6.128e-9,2.113e-12,2.912e4,2.052],hi:[6000,2.569,-8.597e-5,4.195e-8,-1.001e-11,8.436e-16,2.921e4,4.784],Hf:249175,C:0,H:0,O:1},H:{nm:"H atom",MW:1.008,lo:[1000,2.5,7.054e-13,-1.995e-15,2.301e-18,-9.277e-22,2.547e4,-0.446],hi:[6000,2.5,-2.309e-11,1.616e-14,-4.735e-18,4.982e-22,2.547e4,-0.447],Hf:217998,C:0,H:1,O:0},Ar:{nm:"Argon",MW:39.948,lo:[1000,2.5,0,0,0,0,-745.4,4.366],hi:[6000,2.5,0,0,0,0,-745.4,4.366],Hf:0,C:0,H:0,O:0}};
const R_u=8.31446;
function cpR(sp,T){const d=SP[sp];if(!d)return 3.5;const c=T<1000?d.lo:d.hi;return c[1]+c[2]*T+c[3]*T*T+c[4]*T*T*T+c[5]*T*T*T*T;}
function hRT(sp,T){const d=SP[sp];if(!d)return 0;const c=T<1000?d.lo:d.hi;return c[1]+c[2]*T/2+c[3]*T*T/3+c[4]*T*T*T/4+c[5]*T*T*T*T/5+c[6]/T;}
function sR(sp,T){const d=SP[sp];if(!d)return 0;const c=T<1000?d.lo:d.hi;return c[1]*Math.log(T)+c[2]*T+c[3]*T*T/2+c[4]*T*T*T/3+c[5]*T*T*T*T/4+c[7];}
function h_mol(sp,T){return hRT(sp,T)*R_u*T;}
function cp_mol(sp,T){return cpR(sp,T)*R_u;}

/* ══════════════════ PRESETS ══════════════════ */
// Fuel presets — order here drives the dropdown order in CompEditor.
// LNG_Advanced is intentionally first because it's the user's primary
// reference fuel for LMS100-class DLN tuning. The "7.5% C₂ + 1.8% C₃"
// blend follows because it's the next most common test case (heavy-end
// LNG simulation). Everything below preserves the historical order.
const FUEL_PRESETS={
  "LNG_Advanced":                  {CH4:98.0,N2:2.0},
  "7.5% C₂ + 1.8% C₃ (bal CH₄)":   {CH4:89.7,C2H6:7.5,C3H8:1.8,N2:1.0},
  "Pipeline NG (US)":              {CH4:93.1,C2H6:3.2,C3H8:0.7,C4H10:0.4,CO2:1.0,N2:1.6},
  "Pipeline NG (EU)":              {CH4:87.0,C2H6:5.5,C3H8:2.1,C4H10:0.5,N2:3.0,CO2:1.9},
  "LNG (typical)":                 {CH4:95.0,C2H6:3.0,C3H8:1.0,N2:1.0},
  "Biogas":                        {CH4:60,CO2:35,N2:4,H2:1},
  "Landfill Gas":                  {CH4:50,CO2:45,N2:5},
  "Syngas (Coal)":                 {H2:30,CO:40,CO2:10,CH4:5,N2:15},
  "Syngas (Biomass)":              {H2:20,CO:20,CO2:15,CH4:10,N2:35},
  "Coke Oven Gas":                 {H2:55,CH4:25,CO:8,N2:6,C2H4:3,CO2:3},
  "Pure Methane":                  {CH4:100},
  "Pure Hydrogen":                 {H2:100},
  "Pure Propane":                  {C3H8:100},
  "13% N₂ (bal CH₄)":              {CH4:87.0,N2:13.0},
  "26% N₂ (bal CH₄)":              {CH4:74.0,N2:26.0},
  "15% C₂ + 3.6% C₃ (bal CH₄)":    {CH4:80.4,C2H6:15.0,C3H8:3.6,N2:1.0},
  "70% H₂ / 30% NG":               {H2:70,CH4:27.9,C2H6:1.0,C3H8:0.2,N2:0.5,CO2:0.4},
  "50% H₂ / 50% NG":               {H2:50,CH4:46.6,C2H6:1.6,C3H8:0.4,N2:0.8,CO2:0.6},
  "20% H₂ / 80% NG":               {H2:20,CH4:74.5,C2H6:2.6,C3H8:0.6,N2:1.3,CO2:1.0},
};
const OX_PRESETS={"Dry Air (standard)":{O2:20.95,N2:78.09,Ar:0.93,CO2:0.03},"Humid Air (60%RH 25°C)":{O2:20.29,N2:75.67,Ar:0.90,H2O:3.11,CO2:0.03},"O₂-Enriched 30%":{O2:30,N2:69.07,Ar:0.90,CO2:0.03},"Vitiated Air (GT)":{O2:14.5,N2:73.0,CO2:4.5,H2O:8.0},"Pure Oxygen":{O2:100},"Oxy-fuel (O₂/CO₂)":{O2:30,CO2:70}};
const FUEL_SP=["CH4","C2H6","C3H8","C4H10","C2H4","H2","CO","CO2","N2"];
const OX_SP=["O2","N2","Ar","CO2","H2O"];
const SUB_DIGIT=["₀","₁","₂","₃","₄","₅","₆","₇","₈","₉"];
const fmt=s=>(s==null?"":String(s)).replace(/\d/g,d=>SUB_DIGIT[+d]);

/* ══════════════════ CALCULATION ENGINE ══════════════════ */
function o2_per_mol(sp){const d=SP[sp];if(!d)return 0;return d.C+d.H/4-d.O/2;}
function stoichO2(fuel){const t=Object.values(fuel).reduce((a,b)=>a+b,0);if(t===0)return 0;let o2=0;for(const[sp,pct]of Object.entries(fuel)){if(SP[sp]&&(SP[sp].C>0||SP[sp].H>0||sp==="CO"))o2+=(pct/t)*o2_per_mol(sp);}return o2;}
function mixMW(comp){const t=Object.values(comp).reduce((a,b)=>a+b,0);if(t===0)return 28.97;let mw=0;for(const[sp,pct]of Object.entries(comp)){if(SP[sp])mw+=pct/t*SP[sp].MW;}return mw;}
function calcHeatingValues(fuel){const t=Object.values(fuel).reduce((a,b)=>a+b,0);if(t===0)return{LHV_mass:0,HHV_mass:0,LHV_vol:0,HHV_vol:0,MW:28.97};const lhv_d={CH4:802.3,C2H6:1428.6,C3H8:2044.0,C4H10:2657.4,C2H4:1323.1,H2:241.8,CO:283.0};const hhv_d={CH4:890.4,C2H6:1560.7,C3H8:2220.0,C4H10:2877.4,C2H4:1411.2,H2:285.8,CO:283.0};let lhv=0,hhv=0,mw=0;for(const[sp,pct]of Object.entries(fuel)){const xi=pct/t;if(lhv_d[sp])lhv+=xi*lhv_d[sp];if(hhv_d[sp])hhv+=xi*hhv_d[sp];if(SP[sp])mw+=xi*SP[sp].MW;}const mol_m3=101325/(R_u*288.15);return{LHV_mass:lhv/mw,HHV_mass:hhv/mw,LHV_vol:lhv*mol_m3/1000,HHV_vol:hhv*mol_m3/1000,MW:mw};}
function calcFuelProps(fuel,ox,T_fuel_K=288.15){
  const hv=calcHeatingValues(fuel);
  const MW_air=mixMW(ox);
  const SG=hv.MW/28.97;
  const WI=hv.HHV_vol/Math.sqrt(SG||0.01);
  const sO2=stoichO2(fuel);
  const oxO2f=(ox.O2||20.95)/100;
  const stoichOxMol=sO2/(oxO2f||0.2095);
  const AFR_mass=stoichOxMol*MW_air/hv.MW;
  // Modified Wobbe Index per GE convention (BTU/scf·√°R):
  //   MWI = LHV_vol[BTU/scf] / √(SG × T_fuel[°R])
  // LHV_vol from calcHeatingValues is MJ/m³ at 15 °C / 1 atm — convert to
  // BTU/scf via × 26.839. T_fuel default = 288.15 K (15 °C / 519.67 °R)
  // so legacy callers that don't pass T_fuel still get a sensible MWI.
  const T_fuel_R=(T_fuel_K||288.15)*1.8;
  const LHV_vol_BTUscf=(hv.LHV_vol||0)*26.839;
  const _denom=Math.sqrt(Math.max(SG*T_fuel_R,1e-9));
  const MWI=_denom>0 ? LHV_vol_BTUscf/_denom : 0;
  return{...hv,SG,WI,MWI,AFR_mass,AFR_vol:stoichOxMol,MW_fuel:hv.MW,MW_air,stoichO2:sO2};
}
function calcAFT(fuel,ox,phi,T0){const ft=Object.values(fuel).reduce((a,b)=>a+b,0);const ot=Object.values(ox).reduce((a,b)=>a+b,0);if(ft===0||ot===0)return{T_ad:T0,products:{}};const fN={},oN={};for(const k in fuel)fN[k]=fuel[k]/ft;for(const k in ox)oN[k]=ox[k]/ot;const sO2=stoichO2(fuel);const oxO2f=oN.O2||0.2095;const oxMols=sO2/(oxO2f*phi);const reactants={};for(const[sp,xi]of Object.entries(fN))reactants[sp]=(reactants[sp]||0)+xi;for(const[sp,xi]of Object.entries(oN))reactants[sp]=(reactants[sp]||0)+xi*oxMols;const products={};for(const sp of["N2","Ar"])products[sp]=reactants[sp]||0;products.H2O=reactants.H2O||0;products.CO2=reactants.CO2||0;let O2_used=0;for(const[sp,xi]of Object.entries(fN)){const d=SP[sp];if(!d||(d.C===0&&d.H===0&&sp!=="CO"))continue;products.CO2=(products.CO2||0)+xi*d.C;products.H2O=(products.H2O||0)+xi*d.H/2;O2_used+=xi*o2_per_mol(sp);}const O2_avail=oxMols*oxO2f;if(phi<=1){products.O2=O2_avail-O2_used;}else{const deficit=O2_used-O2_avail;const shift=Math.min(deficit,products.CO2||0);products.CO=shift;products.CO2=Math.max(0,(products.CO2||0)-shift);if(deficit>shift){const hS=(deficit-shift)*2;products.H2=hS;products.H2O=Math.max(0,(products.H2O||0)-hS);}products.O2=0;}let H_react=0;for(const[sp,n]of Object.entries(reactants)){if(!SP[sp])continue;H_react+=n*h_mol(sp,T0);}let T_ad=T0+1800;for(let i=0;i<200;i++){let H_prod=0;for(const[sp,n]of Object.entries(products)){if(!SP[sp]||n<=0)continue;H_prod+=n*h_mol(sp,T_ad);}let Cp=0;const Tm=(T0+T_ad)/2;for(const[sp,n]of Object.entries(products)){if(!SP[sp]||n<=0)continue;Cp+=n*cp_mol(sp,Tm);}if(Cp<1)break;const err=H_react-H_prod;const T_n=T_ad+err/Cp*0.6;if(Math.abs(T_n-T_ad)<0.2){T_ad=T_n;break;}T_ad=T_n;}T_ad=Math.max(T0,Math.min(T_ad,5500));const pT=Object.values(products).reduce((a,b)=>a+Math.max(0,b),0);const pPct={};for(const[sp,n]of Object.entries(products)){if(n>0.001)pPct[sp]=n/pT*100;}return{T_ad,products:pPct};}
function sweepAFT(fuel,ox,T0,P,mode){const r=[];for(let phi=0.3;phi<=1.01;phi+=0.02){const a=calcAFTx(fuel,ox,phi,T0,P,mode);r.push({phi:+phi.toFixed(2),T_ad:a.T_ad});}return r;}

// ─────────────────────────────────────────────────────────────────────────
//  Complete-combustion adiabatic flame T using the 3-stream mixed inlet.
//  This is the canonical T_flame definition in the OPERATING CONDITIONS
//  card: complete combustion (no dissociation), at the inlet T that the
//  fuel + air streams adiabatically mix to under the current phi.
// ─────────────────────────────────────────────────────────────────────────
function calcTflameComplete(fuel, ox, phi, T_fuel, T_air){
  if (!Number.isFinite(phi) || phi <= 0) return NaN;
  const Tmix = mixT(fuel, ox, phi, T_fuel, T_air);
  const r = calcAFT(fuel, ox, phi, Tmix);
  return r?.T_ad;
}

// ─────────────────────────────────────────────────────────────────────────
//  Inverse: given a target T_flame, bisect on phi over the LEAN range
//  [0.05, 1.0] to find the phi that produces T_target under complete
//  combustion. Returns the unique lean solution.
//
//  Why lean only: T_flame_complete(phi) is non-monotonic — it rises with
//  phi up to a peak near phi ≈ 1, then falls on the rich side. A target
//  within the achievable range typically has TWO solutions (one lean, one
//  rich). For GT applications the operationally-meaningful one is the
//  lean side. If T_target is above the peak (achievable maximum), this
//  saturates at phi ≈ 1.
// ─────────────────────────────────────────────────────────────────────────
function solvePhiForTflame(fuel, ox, T_target, T_fuel, T_air){
  if (!Number.isFinite(T_target) || T_target <= 0) return 1.0;
  // Compute T_flame at phi=1 to know the peak; if target exceeds it,
  // there is no lean solution — clamp.
  const TmixPeak = mixT(fuel, ox, 1.0, T_fuel, T_air);
  const peak = calcAFT(fuel, ox, 1.0, TmixPeak)?.T_ad ?? 0;
  if (T_target >= peak) return 1.0;
  // Compute T_flame at phi=0.05 — sets the lower bound. If the target is
  // below this, clamp to the lean limit.
  const TmixLow = mixT(fuel, ox, 0.05, T_fuel, T_air);
  const low = calcAFT(fuel, ox, 0.05, TmixLow)?.T_ad ?? T_target;
  if (T_target <= low) return 0.05;
  // Bisection on lean side. T_flame(phi) is monotonic-increasing here.
  let lo = 0.05, hi = 1.0;
  for (let i = 0; i < 60; i++){
    const mid = (lo + hi) / 2;
    const Tmix = mixT(fuel, ox, mid, T_fuel, T_air);
    const T = calcAFT(fuel, ox, mid, Tmix)?.T_ad ?? 0;
    if (T < T_target) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-5) break;
  }
  return (lo + hi) / 2;
}

/* ══════════ EQUILIBRIUM SOLVER — Newton-Raphson on 6 reaction extents ══════════
   Most accurate solution: solves 6 independent dissociation reactions simultaneously
   via Newton-Raphson with finite-difference Jacobian, backtracking line search, and
   analytical Water-Gas Shift pre-conditioning for rich mixtures.
   Reactions: CO2⇌CO+½O2, H2O⇌H2+½O2, ½N2+½O2⇌NO, ½H2+½O2⇌OH, O2⇌2O, H2⇌2H
   12 product species: CO2,H2O,O2,N2,CO,H2,OH,NO,O,H,Ar
   Validated: <0.2% vs Cantera for lean/stoichiometric, <0.1% for H2 at all φ.    */
function gRT(sp,T){return hRT(sp,T)-sR(sp,T);}
function lnKp(rxn,T){const g=sp=>gRT(sp,T);
  if(rxn===0)return -(g('CO')+0.5*g('O2')-g('CO2'));if(rxn===1)return -(g('H2')+0.5*g('O2')-g('H2O'));
  if(rxn===2)return -(g('NO')-0.5*g('N2')-0.5*g('O2'));if(rxn===3)return -(g('OH')-0.5*g('H2')-0.5*g('O2'));
  if(rxn===4)return -(2*g('O')-g('O2'));if(rxn===5)return -(2*g('H')-g('H2'));return 0;}

// Analytical Water-Gas Shift: CO+H2O ⇌ CO2+H2 via quadratic for extent ξ
function wgsAnalytical(nCO2,nH2O,nCO,nH2,Kwgs){
  const a=nCO2,b=nH2,c=nCO,d=nH2O,K=Kwgs;
  const A=1-K,B=a+b+K*(c+d),C=a*b-K*c*d;
  let xi;
  if(Math.abs(A)<1e-20){xi=-C/(B+1e-30);}
  else{const disc=B*B-4*A*C;if(disc<0)return[nCO2,nH2O,nCO,nH2];const s=Math.sqrt(disc);
    const x1=(-B+s)/(2*A),x2=(-B-s)/(2*A);xi=null;
    for(const x of[x1,x2]){if(a+x>-1e-10&&b+x>-1e-10&&c-x>-1e-10&&d-x>-1e-10){xi=x;break;}}
    if(xi===null)return[nCO2,nH2O,nCO,nH2];}
  return[Math.max(a+xi,1e-15),Math.max(d-xi,1e-15),Math.max(c-xi,1e-15),Math.max(b+xi,1e-15)];}

function equilibrateAtT(prod0,T,P_atm,isRich){
  const nAr=prod0.Ar||0;const pw={...prod0};
  // Analytical WGS for rich mixtures
  if(isRich&&(pw.CO||0)>1e-6){const Kwgs=Math.exp(lnKp(1,T)-lnKp(0,T));
    const r=wgsAnalytical(pw.CO2||0,pw.H2O||0,pw.CO||0,pw.H2||0,Kwgs);
    pw.CO2=r[0];pw.H2O=r[1];pw.CO=r[2];pw.H2=r[3];}
  const P=P_atm;
  // Species from 6 reaction extents e[0..5]
  const getN=e=>{const n={};
    n.CO2=Math.max((pw.CO2||0)-e[0],1e-20);n.CO=Math.max((pw.CO||0)+e[0],1e-20);
    n.H2O=Math.max((pw.H2O||0)-e[1],1e-20);n.H2=Math.max((pw.H2||0)+e[1]-0.5*e[3]-0.5*e[5],1e-20);
    n.O2=Math.max((pw.O2||1e-8)+0.5*e[0]+0.5*e[1]-0.5*e[2]-0.5*e[3]-0.5*e[4],1e-20);
    n.N2=Math.max((pw.N2||0)-0.5*e[2],1e-20);
    n.NO=Math.max(e[2],1e-20);n.OH=Math.max(e[3],1e-20);n.O=Math.max(e[4],1e-20);n.H=Math.max(e[5],1e-20);
    return n;};
  const lnKps=[lnKp(0,T),lnKp(1,T),lnKp(2,T),lnKp(3,T),lnKp(4,T),lnKp(5,T)];
  const residuals=e=>{const n=getN(e);let N=nAr;for(const k in n)N+=n[k];const x=sp=>n[sp]/N;const lP=Math.log(P);
    return[Math.log(x('CO'))+0.5*Math.log(x('O2'))-Math.log(x('CO2'))+0.5*lP-lnKps[0],
           Math.log(x('H2'))+0.5*Math.log(x('O2'))-Math.log(x('H2O'))+0.5*lP-lnKps[1],
           Math.log(x('NO'))-0.5*Math.log(x('N2'))-0.5*Math.log(x('O2'))-lnKps[2],
           Math.log(x('OH'))-0.5*Math.log(x('H2'))-0.5*Math.log(x('O2'))-lnKps[3],
           2*Math.log(x('O'))-Math.log(x('O2'))+lP-lnKps[4],
           2*Math.log(x('H'))-Math.log(x('H2'))+lP-lnKps[5]];};
  // Initial extents
  const e=[Math.min((pw.CO2||0)*0.01,0.1),Math.min((pw.H2O||0)*0.005,0.05),0.001,0.001,0.0001,0.0001];
  // Newton-Raphson
  for(let it=0;it<100;it++){
    const F=residuals(e);let maxF=0;for(let i=0;i<6;i++)maxF=Math.max(maxF,Math.abs(F[i]));
    if(maxF<1e-10)break;
    // Finite-difference Jacobian
    const J=Array.from({length:6},()=>new Array(6));const h=1e-7;
    for(let j=0;j<6;j++){const ep=[...e];ep[j]+=h;const em=[...e];em[j]-=h;
      const Fp=residuals(ep),Fm=residuals(em);for(let i=0;i<6;i++)J[i][j]=(Fp[i]-Fm[i])/(2*h);}
    // Solve J*delta=-F (Gaussian elimination)
    const M=6;const aug=J.map((row,i)=>[...row,-F[i]]);
    for(let col=0;col<M;col++){let mx=Math.abs(aug[col][col]),mr=col;
      for(let r=col+1;r<M;r++){if(Math.abs(aug[r][col])>mx){mx=Math.abs(aug[r][col]);mr=r;}}
      [aug[col],aug[mr]]=[aug[mr],aug[col]];if(Math.abs(aug[col][col])<1e-40)continue;
      for(let r=col+1;r<M;r++){const f=aug[r][col]/aug[col][col];for(let k=col;k<=M;k++)aug[r][k]-=f*aug[col][k];}}
    const delta=new Array(M);for(let i=M-1;i>=0;i--){delta[i]=aug[i][M];for(let k=i+1;k<M;k++)delta[i]-=aug[i][k]*delta[k];delta[i]/=(aug[i][i]||1e-40);}
    // Line search with backtracking
    let alpha=1;for(let ls=0;ls<20;ls++){
      const et=e.map((v,i)=>v+alpha*delta[i]);const nt=getN(et);let ok=true;
      for(const k in nt)if(nt[k]<=0){ok=false;break;}
      if(ok){const Ft=residuals(et);let maxFt=0;for(let i=0;i<6;i++)maxFt=Math.max(maxFt,Math.abs(Ft[i]));
        if(maxFt<maxF*1.1)break;}alpha*=0.5;}
    for(let i=0;i<6;i++)e[i]+=alpha*delta[i];
    e[0]=Math.max(e[0],-(pw.CO||0)*0.99);e[0]=Math.min(e[0],(pw.CO2||0)*0.99);
    e[1]=Math.min(e[1],(pw.H2O||0)*0.99);for(let i=2;i<6;i++)e[i]=Math.max(e[i],1e-15);
  }
  const result=getN(e);result.Ar=nAr;return result;
}

function calcAFT_EQ(fuel,ox,phi,T0,P_atm){
  const ft=Object.values(fuel).reduce((a,b)=>a+b,0);const ot=Object.values(ox).reduce((a,b)=>a+b,0);
  if(ft===0||ot===0)return{T_ad:T0,products:{}};
  const fN={},oN={};for(const k in fuel)fN[k]=fuel[k]/ft;for(const k in ox)oN[k]=ox[k]/ot;
  const sO2=stoichO2(fuel);const oxO2f=oN.O2||0.2095;const oxMols=sO2/(oxO2f*phi);
  const reactants={};for(const[sp,xi]of Object.entries(fN))reactants[sp]=(reactants[sp]||0)+xi;
  for(const[sp,xi]of Object.entries(oN))reactants[sp]=(reactants[sp]||0)+xi*oxMols;
  const prod0={};for(const sp of["N2","Ar"])prod0[sp]=reactants[sp]||0;
  prod0.H2O=reactants.H2O||0;prod0.CO2=reactants.CO2||0;prod0.CO=1e-8;prod0.H2=1e-8;
  let O2_used=0;
  for(const[sp,xi]of Object.entries(fN)){const d=SP[sp];if(!d||(d.C===0&&d.H===0&&sp!=="CO"))continue;prod0.CO2+=xi*d.C;prod0.H2O+=xi*d.H/2;O2_used+=xi*o2_per_mol(sp);}
  const O2_avail=oxMols*oxO2f;const isRich=phi>1;
  if(!isRich){prod0.O2=O2_avail-O2_used;}
  else{const deficit=O2_used-O2_avail;const shift=Math.min(deficit,prod0.CO2);prod0.CO=Math.max(shift,1e-8);prod0.CO2=Math.max(prod0.CO2-shift,1e-8);if(deficit>shift){prod0.H2=Math.max((deficit-shift)*2,1e-8);prod0.H2O=Math.max(prod0.H2O-(deficit-shift)*2,1e-8);}prod0.O2=1e-8;}
  let H_react=0;for(const[sp,n]of Object.entries(reactants)){if(!SP[sp])continue;H_react+=n*h_mol(sp,T0);}
  let T_ad=T0+1800;
  for(let i=0;i<150;i++){
    const eq=equilibrateAtT(prod0,T_ad,P_atm,isRich);
    let H_prod=0;for(const[sp,n]of Object.entries(eq)){if(!SP[sp]||n<=0)continue;H_prod+=n*h_mol(sp,T_ad);}
    let Cp_prod=0;for(const[sp,n]of Object.entries(eq)){if(!SP[sp]||n<=0)continue;Cp_prod+=n*cp_mol(sp,(T0+T_ad)/2);}
    if(Cp_prod<1)break;const err=H_react-H_prod;const dT=err/Cp_prod*0.4;
    if(Math.abs(dT)<0.3){T_ad+=dT;break;}T_ad+=dT;T_ad=Math.max(T0,Math.min(T_ad,5500));}
  const eqF=equilibrateAtT(prod0,T_ad,P_atm,isRich);
  const pT=Object.values(eqF).reduce((a,b)=>a+Math.max(0,b),0);
  const pPct={};for(const[sp,n]of Object.entries(eqF)){if(n/pT>0.0001)pPct[sp]=n/pT*100;}
  return{T_ad:Math.max(T0,Math.min(T_ad,5500)),products:pPct};
}

// Unified wrapper: mode = "complete" or "equilibrium"
function calcAFTx(fuel,ox,phi,T0,P,mode){
  return mode==="equilibrium"?calcAFT_EQ(fuel,ox,phi,T0,P):calcAFT(fuel,ox,phi,T0);
}

// Convert wet-basis product mol% to dry-basis (remove H2O, renormalize)
function dryBasis(wet){
  if(!wet)return {};
  const xH2O=wet.H2O||0;
  const remain=100-xH2O;
  if(remain<=0.001)return {};
  const dry={};
  for(const[sp,v] of Object.entries(wet)){
    if(sp==="H2O")continue;
    if(v>0)dry[sp]=v/remain*100;
  }
  return dry;
}

// Exhaust analysis with mode support
function calcExhaustFromO2(fuel,ox,measuredO2,T0,P,mode){let lo=0.3,hi=1.0;for(let i=0;i<60;i++){const mid=(lo+hi)/2;const r=calcAFTx(fuel,ox,mid,T0,P,mode);const o2Pct=r.products?.O2||0;if(o2Pct>measuredO2)lo=mid;else hi=mid;}const phi=(lo+hi)/2;const r=calcAFTx(fuel,ox,phi,T0,P,mode);const fp=calcFuelProps(fuel,ox);const FAR=phi/(fp.AFR_mass+1e-20);return{phi,T_ad:r.T_ad,products:r.products,FAR_mass:FAR,AFR_mass:fp.AFR_mass/phi};}
function calcExhaustFromCO2(fuel,ox,measuredCO2,T0,P,mode){let lo=0.3,hi=1.0;for(let i=0;i<60;i++){const mid=(lo+hi)/2;const r=calcAFTx(fuel,ox,mid,T0,P,mode);const co2Pct=r.products?.CO2||0;if(co2Pct<measuredCO2)lo=mid;else hi=mid;}const phi=(lo+hi)/2;const r=calcAFTx(fuel,ox,phi,T0,P,mode);const fp=calcFuelProps(fuel,ox);const FAR=phi/(fp.AFR_mass+1e-20);return{phi,T_ad:r.T_ad,products:r.products,FAR_mass:FAR,AFR_mass:fp.AFR_mass/phi};}
function calcSL(fuel,phi,Tu,P_atm){
  // Gülder-style asymmetric correlation, refit against Cantera GRI-Mech 3.0 FreeFlame
  // (mixture-averaged transport). Lean-side power-law factor φ^aL captures H₂'s sharp
  // lean tail; aL=0 reduces to the symmetric form used by hydrocarbons/CO.
  // Within app's lean slider range (φ≤1.0): H₂<1%, C₂H₄ 2%, C₃H₈ 4%, C₂H₆ 4%, CO 12%, CH₄ 14% vs Cantera.
  const ft=Object.values(fuel).reduce((a,b)=>a+b,0);if(ft===0)return 0;
  const params={
    H2:  {S0:3.0693,pm:1.3310,aL:0.9528,KL:2.7129,eL:4.6397,KR:0.1118,eR:1.8772,al:1.5997,be:-0.1265},
    CH4: {S0:0.3575,pm:1.0266,aL:0,KL:11.6967,eL:2.6375,KR:11.6967,eR:2.6375,al:1.9098,be:-0.3976},
    C2H6:{S0:0.4078,pm:1.0666,aL:0,KL:8.0540, eL:2.6898,KR:8.0540, eR:2.6898,al:1.8278,be:-0.2534},
    C3H8:{S0:0.4804,pm:1.0665,aL:0,KL:7.3777, eL:2.6074,KR:7.3777, eR:2.6074,al:1.7754,be:-0.2823},
    C4H10:{S0:0.4804,pm:1.0665,aL:0,KL:7.3777,eL:2.6074,KR:7.3777, eR:2.6074,al:1.7754,be:-0.2823}, // use C3H8 params (similar SL, not in GRI-30)
    C2H4:{S0:0.8653,pm:1.1907,aL:0,KL:4.9110, eL:3.0419,KR:4.9110, eR:3.0419,al:1.7184,be:-0.1973},
    CO:  {S0:0.2407,pm:1.2564,aL:0,KL:1.8946, eL:1.8298,KR:1.8946, eR:1.8298,al:1.9317,be:-0.0814}
  };
  let sl=0;
  for(const[sp,pct]of Object.entries(fuel)){
    const p=params[sp];if(!p)continue;
    const xi=pct/ft;
    const dphi=phi-p.pm;
    let fphi;
    if(dphi<0){
      const base=Math.exp(-p.KL*Math.pow(-dphi,p.eL));
      fphi=p.aL>0?Math.pow(phi/p.pm,p.aL)*base:base;
    }else{
      fphi=Math.exp(-p.KR*Math.pow(dphi,p.eR));
    }
    sl+=xi*p.S0*fphi*Math.pow(Tu/298,p.al)*Math.pow(P_atm/1,p.be);
  }
  return Math.max(0,sl);
}
function calcBlowoff(fuel,phi,Tu,P_atm,velocity,Lchar){const SL=calcSL(fuel,phi,Tu,P_atm);const alpha_th=2.0e-5*Math.pow(Tu/300,1.7)/P_atm;const tau_chem=alpha_th/(SL*SL+1e-20);const tau_flow=Lchar/(velocity+1e-20);const Da=tau_flow/tau_chem;return{SL,tau_chem:tau_chem*1000,tau_flow:tau_flow*1000,Da,blowoff_velocity:Lchar/tau_chem,stable:Da>1};}

// ─────────────────────────────────────────────────────────────────────────
//  Flame Speed & Regime Diagnostics — Phase 0.3 helpers (redesign Step C).
//
//  bradleyST   — Bradley/Lau/Lawes 1992 turbulent flame speed correlation,
//                handles all premixer / combustor turbulence regimes via
//                Karlovitz scaling. Returns S_T plus the Karlovitz Ka and
//                turbulent Reynolds Re_T diagnostics that drive the
//                Borghi-Peters regime classification.
//  damkohlerST — Damköhler 1940 corrugated-flamelet form. Cleaner closed
//                form, valid for u'/SL < 1, used as a cross-check on
//                Bradley. When the two disagree by >2× the user is
//                outside both correlations' calibration range.
//  lewisNumberFreeMode — JS fallback for the effective Lewis number when
//                Cantera isn't running (free-mode users won't see this
//                because the panel is paid-only as of Phase 0, but the
//                helper is still useful for sweep cards that want a quick
//                estimate without a backend round-trip). Coverage:
//                NG / hydrocarbons (Le≈0.97), NG+H₂ blends (interpolated),
//                pure H₂ (Le≈0.4), syngas CO/H₂/N₂, naphtha as C7H16
//                surrogate. Per-fuel surrogates are documented inline.
// ─────────────────────────────────────────────────────────────────────────
function bradleyST(SL, uPrime, lT, nu, Le=1.0){
  const SLs = Math.max(SL, 1e-9);
  const ReT = uPrime * lT / Math.max(nu, 1e-12);                 // turbulent Reynolds
  const Ka  = 0.157 * Math.pow(uPrime/SLs, 2) * Math.pow(Math.max(ReT, 1e-12), -0.5);
  const ST  = 0.88 * uPrime * Math.pow(Math.max(Ka, 1e-12), -0.3) / Math.max(Le, 0.1);
  return { ST, Ka, ReT };
}
function damkohlerST(SL, uPrime){
  const SLs = Math.max(SL, 1e-9);
  return SLs * Math.sqrt(1 + Math.pow(uPrime/SLs, 2));
}
// Lefebvre & Ballal, Gas Turbine Combustion (3rd ed., 2010), Eq. 5.27 (p. 185).
// Original ref: Lefebvre 1985, J. Eng. Gas Turbines Power 107, 24-37.
//
//   q_LBO = (A / V_pz) · [m_A / (P_3^1.3 · exp(T_3/300))] · [D_r² / (λ_r · H_r)]
//
// where q_LBO is the LEAN BLOWOUT fuel/air MASS RATIO (kg/kg). For gaseous
// fuel (no spray): D_r → 1, λ_r → 1, so the spray-evaporation term reduces
// to 1/H_r where H_r = LCV / LCV_JP4 with LCV_JP4 = 43.5 MJ/kg.
//
// Equivalence-ratio form: φ_LBO = q_LBO / FAR_stoich.
//
// Earlier transcription errors corrected against the book on 2026-04-30:
//   • NO square root (was using ^0.5 — wrong)
//   • exp(T_3/300) in DENOMINATOR (was in numerator — wrong)
//   • output is q_LBO not φ_LBO (must be divided by FAR_stoich)
//   • LCV enters as H_r normalized to JP4 (was using LCV_MJ_kg directly)
//
// SI units throughout (per Lefebvre's data, fitted to real engines):
//   A           dimensionless calibration constant (Table 5.1, p. 186)
//   m_air_kg_s  combustor air flow into primary zone (kg/s)
//   T3_K        combustor inlet temperature (K)
//   V_pz_m3     primary-zone volume (m³)
//   P3_kPa      combustor inlet pressure (kPa, NOT bar / MPa)
//   LCV_MJ_kg   fuel lower heating value, mass basis (MJ/kg)
//   FAR_stoich  fuel/air stoichiometric ratio (mass basis)
//
// Lefebvre Table 5.1 — A values from 8 production aero-engines (KEROSENE SPRAY):
//   J 79-17A  0.042   J 79-17C  0.031   F 101  0.032   TF 41  0.013
//   TF 39     0.037   J 85      0.064   TF 33  0.025   F 100  0.023
// Those values were calibrated for HETEROGENEOUS spray combustion (kerosene
// droplets evaporating in the primary zone). They are NOT appropriate for
// premixed-GAS DLN combustors. With D_r²/λ_r set to 1 for gas (no spray
// evaporation), the kerosene A values under-predict φ_LBO by ~250× because
// they implicitly bake in the slow droplet-evaporation timescale.
//
// PREMIXED-GAS CALIBRATION (this codebase):
//   A_LBO ≈ 6.3 — back-fit so that at the LMS100 NG-DLN industrial baseline
//   (ṁ_a = 30 kg/s, V_pz = 0.025 m³, P_3 = 2000 kPa, T_3 = 800 K, NG LCV
//   50 MJ/kg) the formula returns φ_LBO ≈ 0.40 — the canonical industrial
//   NG-DLN lean-blowout value. Default in this codebase: 6.3. Verified
//   2026-04-30 by hand at the LMS100 anchor.
//
// Provisional — refit A from measured plant φ_LBO when site data lands.
// Users with kerosene-spray combustors should revert to Lefebvre's Table
// 5.1 values (0.013–0.064).
// ── LBO loading-parameter band (typical industrial GT premixer design) ──
// LP = ṁ_air / (V_pz · P_3_atm^1.3) — Lefebvre's canonical "loading parameter".
// We sweep LP over a typical-design band to produce a φ_LBO RANGE rather than
// a single (calibration-fragile) point estimate. This is more robust than
// asking the user to dial V_pz and ṁ_air to match their specific combustor.
//   LP_LOW  = 10 kg/(s·m³·atm^1.3)  — well-loaded, sound design
//   LP_HIGH = 30 kg/(s·m³·atm^1.3)  — high-loaded, marginal design
// Industrial DLN combustors typically sit in this band; smaller LP = lower
// φ_LBO (more LBO margin); larger LP = higher φ_LBO (closer to LBO).
const _LBO_LP_LOW  = 10;
const _LBO_LP_HIGH = 30;

// Derive (φ_LBO_low, φ_LBO_high) from the LP band. Uses the simplification
//   q_LBO = K · LP_atm / (304.1 · exp(T_3/300) · H_r)
// (101.325^1.3 ≈ 304.1; H_r = LCV/43.5; FAR_stoich from fuel.)
// This drops out ṁ_air, V_pz, AND P_3 from the calculation — only T_3 and
// fuel properties matter. Returns {phi_low, phi_high, status} where status ∈
// {"SAFE", "ALARM", "HIGH_RISK"} per the rule:
//   φ_actual > phi_high           → SAFE        (above the band)
//   phi_low ≤ φ_actual ≤ phi_high → ALARM       (inside the band)
//   φ_actual < phi_low            → HIGH_RISK   (below the lowest LBO)
const _LBO_P_KPA_FACTOR = Math.pow(101.325, 1.3);  // ≈ 304.1, atm→kPa^1.3 conversion

// Fuel-composition multiplier on the φ_LBO band, applied to BOTH edges.
// Linear in mole fraction: pure H₂ → ×(1/3), pure C₃H₈ → ×0.9, pure CH₄
// (or any other species) → ×1.0. Composition mix scales linearly.
//   m = 1 − (1 − 1/3)·x_H2 − (1 − 0.9)·x_C3H8
//     = 1 − (2/3)·x_H2 − 0.1·x_C3H8
// Captures the empirically observed shift: H₂-rich fuels are MUCH more
// flammable (lower LBO) than NG; C3-heavy fuels are slightly more
// flammable (modest LBO drop) due to higher reactivity per mole.
function _lboFuelMultiplier(fuel_pct){
  const total = Object.values(fuel_pct||{}).reduce((a,b)=>a+(+b||0),0);
  if (total <= 0) return 1.0;
  const x_H2 = ((fuel_pct.H2   || 0) / total);
  const x_C3 = ((fuel_pct.C3H8 || 0) / total);
  return Math.max(0.0, 1.0 - (2.0/3.0) * x_H2 - 0.1 * x_C3);
}

// CH₄ REFERENCE properties — used unconditionally in the band calculation
// so that m_fuel is the ONE AND ONLY composition effect on the band.
// Without this lock-in, switching from CH₄ to C₃H₈ shifts both LCV (50→46.4)
// and FAR_stoich (0.0581→0.0641), and those shifts eat ~12% of the m_fuel
// multiplier — meaning 100% C₃H₈ would show ~0.88× CH₄ instead of exactly
// 0.9×. Locking to CH₄ refs ensures: pure C₃H₈ → exactly 0.9×, pure H₂ →
// exactly 1/3×, any blend → linearly between, regardless of fuel-specific
// LCV/FAR_stoich shifts.
const _LBO_LCV_REF_MJ_KG = 50.0;     // pure CH₄ LCV
const _LBO_FAR_REF       = 0.0581;   // pure CH₄ FAR_stoich (mass basis)

// Note: LCV_MJ_kg and FAR_stoich parameters retained in the signature for
// backward compatibility with existing call sites, but they are IGNORED.
// The band is always computed with CH₄ reference props; m_fuel is the
// sole composition modifier.
function lefebvreLBO_band(K, T3_K, _LCV_unused, _FAR_unused, phi_actual, fuel_pct){
  const H_r = _LBO_LCV_REF_MJ_KG / 43.5;                                // CH₄-locked
  const denom = _LBO_P_KPA_FACTOR * Math.exp(Math.max(T3_K, 1) / 300) * H_r;
  const q_low  = Math.max(K, 0) * _LBO_LP_LOW  / Math.max(denom, 1e-12);
  const q_high = Math.max(K, 0) * _LBO_LP_HIGH / Math.max(denom, 1e-12);
  // CRITICAL ORDER OF OPERATIONS:
  //   1. Compute CH₄ baseline band, with the 1.0 clamp on the upper bound.
  //   2. THEN apply the fuel multiplier to the clamped baseline.
  // This guarantees the band of ANY other fuel is exactly m_fuel × the
  // CH₄ band at every T_3 — even at low T_3 where the raw CH₄ upper would
  // exceed 1.0 (and gets clamped). If we applied m_fuel before the clamp
  // (older buggy version), the propane upper at low T_3 would also exceed
  // 1.0 and clamp, masking the multiplier and giving a 1.0/1.0 = 1.0 ratio
  // instead of the requested 0.9.
  const phi_low_CH4_base  = q_low  / _LBO_FAR_REF;
  const phi_high_CH4_base = Math.min(q_high / _LBO_FAR_REF, 1.0);       // clamp on CH₄ baseline
  const fuel_mult = _lboFuelMultiplier(fuel_pct);
  const phi_low  = phi_low_CH4_base  * fuel_mult;                       // exactly × m_fuel
  const phi_high = phi_high_CH4_base * fuel_mult;                       // exactly × m_fuel
  // Three-state status
  let status;
  if (!Number.isFinite(phi_actual))         status = "—";
  else if (phi_actual >  phi_high)          status = "SAFE";
  else if (phi_actual >= phi_low)           status = "ALARM";
  else                                      status = "HIGH_RISK";
  return { phi_low, phi_high, status, fuel_mult };
}

// Legacy single-point Lefebvre LBO (kept for backward compatibility — not
// used by the panel anymore; if some downstream code still calls it, it
// continues to work). New code should use lefebvreLBO_band.
function lefebvreLBO(A, m_air_kg_s, T3_K, V_pz_m3, P3_kPa, LCV_MJ_kg, FAR_stoich){
  const H_r = Math.max(LCV_MJ_kg, 1e-6) / 43.5;        // LCV / JP4 LCV
  const denom = Math.max(V_pz_m3, 1e-12)
              * Math.pow(Math.max(P3_kPa, 1e-3), 1.3)
              * Math.exp(Math.max(T3_K, 1) / 300)
              * Math.max(H_r, 1e-6);
  // D_r²/λ_r = 1 for gaseous fuels (no spray). Spray combustors should
  // multiply numerator by D_r² / λ_r per Lefebvre's heterogeneous-mix
  // extension — out of scope for the current panel.
  const q_LBO = Math.max(A, 0) * Math.max(m_air_kg_s, 0) / denom;
  return q_LBO / Math.max(FAR_stoich, 1e-12);
}

// ─────────────────────────────────────────────────────────────────────────
//  Premixer type catalog. Each entry:
//    label    — UI label
//    daCrit   — function(params) → Da_crit (dimensionless)
//    inputs   — [{ id, label, min, max, step, default, decimals, tooltip,
//                  ref }] — secondary slider(s) shown when type is picked
//    ref      — citation
//    note     — short prose for the inputs row
//  Generic enough to cover most gas-turbine premixer designs. Per-type
//  defaults are LMS100 / GE LSI flavor; user can override on the slider.
// ─────────────────────────────────────────────────────────────────────────
const PREMIXER_TYPES = {
  swirl: {
    label: "Swirl burner",
    ref:   "screening proxy (uncalibrated)",
    note:  "Geometric swirl S_n shifts the Da_crit screen — calibrate against rig data before design use.",
    inputs: [
      { id:"swirlNumber", label:"Swirl number S_n", min:0.4, max:1.2,
        step:0.05, default:0.6, decimals:2,
        tooltip:"Swirl number convention: this slider treats S_n as the momentum-based S_m = (axial flux of angular momentum)/(a · axial flux of axial momentum) per Lieuwen Eq. 4.6 (p. 144). The velocity-based S_v ≈ S_m for typical jet profiles but values quoted in different papers may use either convention — verify before benchmarking. Typical ranges: 0.4-0.6 weak swirl, 0.6-1.0 typical DLN, >1.0 high-swirl. Vortex breakdown (Lieuwen §4.4.2) is bistable: below S_A no breakdown ever; above S_B always breakdown; hysteresis between. For typical combustor jets at a_core/a ≈ 0.56, χ ≈ 1/3, Lieuwen Fig. 4.39 puts S_B,v ≈ 0.6-0.85 — reasonable proxy for the swirl scale at which CIVB becomes a flashback risk. The Da_crit screen below is engineering-grade and uncalibrated; per Lieuwen §10.2.3 (p. 396-400), Da/Da_crit captures only the first pre-blowoff stage. The fundamentally correct quantity is the extinction stretch rate κ_ext (Lieuwen Fig. 10.20). Calibrate against rig data for design-margin decisions." },
    ],
    // CAUTION: this piecewise interpolation (0.30 / 0.50 / 1.00 at S_n =
    // 0.4 / 0.6 / 1.0) is an approximate engineering screen, NOT a fitted
    // correlation. Lieuwen, "Unsteady Combustor Physics" (2nd ed., 2021)
    // §10.2.3 (p. 396-400) explicitly cautions that Da_crit-style numbers
    // for swirl burners are screening proxies for the first pre-blowoff
    // stage only — the fundamentally correct framework is the extinction
    // stretch rate κ_ext (Lieuwen Eq. and Fig. 10.20). Refit these
    // numbers against measured plant blowoff data when available.
    daCrit: (p) => {
      const sn = +p.swirlNumber || 0.6;
      if (sn <= 0.4) return 0.30;
      if (sn <= 0.6) return 0.30 + (0.50 - 0.30) * (sn - 0.4) / 0.2;
      if (sn <= 1.0) return 0.50 + (1.00 - 0.50) * (sn - 0.6) / 0.4;
      return 1.00;
    },
  },
  bluff_cylinder: {
    label: "Cylindrical bluff body",
    ref:   "Williams 1985",
    note:  "Single bluff cylinder transverse to flow. D_flameholder = bluff diameter.",
    inputs: [],
    daCrit: () => 0.045,
  },
  vgutter: {
    label: "V-gutter",
    ref:   "Sturgess 1985",
    note:  "Wedge-shaped flame holder. Da_crit grows with included angle.",
    inputs: [
      { id:"gutterAngleDeg", label:"Gutter angle (°)", min:30, max:120,
        step:5, default:90, decimals:0,
        tooltip:"Included angle of the V-gutter. Sturgess data: 60° → Da_crit 0.07, 90° → 0.10. Linear interp outside, capped at 30° / 120°." },
    ],
    daCrit: (p) => {
      const a = +p.gutterAngleDeg || 90;
      return 0.07 + (0.10 - 0.07) * Math.max(0, Math.min(1, (a - 60) / 30));
    },
  },
  dump: {
    label: "Sudden expansion (dump)",
    ref:   "Lefebvre Ch.5",
    note:  "Annular or can dump combustor. Mild Da_crit dependence on expansion ratio.",
    inputs: [
      { id:"expansionRatio", label:"Expansion ratio E_R", min:1.5, max:5.0,
        step:0.1, default:2.5, decimals:1,
        tooltip:"Area ratio A_dump / A_inlet. Typical DLN: 2-4. Da_crit ≈ 0.05 with weak (E_R/2.5)^0.1 scaling." },
    ],
    daCrit: (p) => 0.05 * Math.pow(Math.max(+p.expansionRatio || 2.5, 0.5) / 2.5, 0.1),
  },
  backstep: {
    label: "Backward-facing step",
    ref:   "Plee-Mellor 1979",
    note:  "2D step flame holder. L_char = step height.",
    inputs: [],
    daCrit: () => 0.08,
  },
  perforated: {
    label: "Perforated plate / micromixer",
    ref:   "various",
    note:  "Many small jets — H₂-tolerant micromixer architectures.",
    inputs: [
      { id:"holeDiamMm", label:"Hole diameter (mm)", min:0.5, max:5.0,
        step:0.1, default:1.5, decimals:1,
        tooltip:"Per-jet hole diameter. Typical micromixer: 0.5-2 mm.\n\nDa_crit (engineering screening interpolation):\n  0.5 mm  → 0.100  (small jets, high local strain → harder to anchor)\n  1.5 mm  → 0.045  (typical micromixer, bluff-body-like)\n  5.0 mm  → 0.030  (large jets, easier to anchor)\n\nLinear interp between the three anchors. Engineering-grade screen only — calibrate against rig data for design margin decisions." },
    ],
    // Engineering-grade Da_crit screen vs. hole diameter. Three-point
    // linear interp through the anchors above:
    //   d ≤ 0.5 mm → 0.100   (very small jets, high strain, hard to anchor)
    //   d  = 1.5 mm → 0.045  (typical micromixer, bluff-body-like)
    //   d ≥ 5.0 mm → 0.030   (large jets, behave like stable bluff bodies)
    // Smaller holes raise Da_crit because the per-jet strain rate climbs
    // and the local mixing/residence time shrinks — both make it harder
    // to maintain the anchor against blowoff. NOT a fitted correlation;
    // calibrate against rig data before design use.
    daCrit: (p) => {
      const d = +p.holeDiamMm || 1.5;
      if (d <= 0.5) return 0.100;
      if (d <= 1.5) return 0.100 + (0.045 - 0.100) * (d - 0.5) / 1.0;
      if (d <= 5.0) return 0.045 + (0.030 - 0.045) * (d - 1.5) / 3.5;
      return 0.030;
    },
  },
};

// Autoignition mechanism catalog — exposed in the Card 3 dropdown.
// `bundled` flag gates whether the choice is selectable on the UI;
// non-bundled entries appear disabled with a "coming" badge until
// their YAML lands in api/app/science/mechanisms/.
const IG_MECHANISMS = [
  { id:"gri30",    label:"GRI-Mech 3.0",  ref:"Cantera built-in",
    bundled:true,
    note:"53 species, 325 reactions. Default for natural gas. Validated T = 800–2500 K, P = 1–30 atm." },
  { id:"glarborg", label:"Glarborg 2018", ref:"Glarborg et al. 2018",
    bundled:true,
    note:"151 species, 1395 reactions. More detailed H₂ / NOx / NH₃ chemistry — recommended for H₂-rich fuels." },
  { id:"ffcm2",    label:"FFCM-2",        ref:"Wang et al. 2020",
    bundled:false,
    note:"Foundational Fuel Chemistry Model, 96 species. Best for NG with H₂ ≤ 50%. Mechanism file not bundled yet — pending YAML add to api/app/science/mechanisms/." },
  { id:"aramco",   label:"Aramco 3.0",    ref:"Zhou et al. 2018",
    bundled:false,
    note:"Comprehensive C0–C5 + H₂ / NOx mechanism. Mechanism file not bundled yet." },
];

function lewisNumberFreeMode(fuelComp){
  // Composition is in mol % (matches the sidebar editor).
  const xH2  = (fuelComp.H2  || 0) / 100;
  const xCO  = (fuelComp.CO  || 0) / 100;
  const xCH4 = (fuelComp.CH4 || 0) / 100;
  const xC2  = ((fuelComp.C2H6||0) + (fuelComp.C2H4||0) + (fuelComp.C2H2||0))/100;
  const xCge3= ((fuelComp.C3H8||0) + (fuelComp.C4H10||0) + (fuelComp.C5H12||0)
              + (fuelComp.C6H14||0) + (fuelComp.C7H16||0) + (fuelComp.C8H18||0))/100;
  const xC = xCH4 + xC2 + xCge3;
  const xN2 = (fuelComp.N2||0)/100, xCO2=(fuelComp.CO2||0)/100;
  const xCombust = xH2 + xCO + xC;
  if (xCombust < 1e-6) return 1.0;                                   // inert — fall through
  // Pure-fuel Lewis surrogates (deficient-reactant basis, lean side).
  const Le_H2     = 0.40;  // pure H₂/air, lean: thermo-diffusively unstable
  const Le_CO     = 1.10;  // CO/air, slightly above unity
  const Le_CH4    = 0.97;  // CH₄/air, near unity (the canonical hydrocarbon)
  const Le_C2     = 1.00;  // C2-class (C2H6/C2H4/C2H2): close to neutral
  const Le_Cge3   = 1.10;  // C3+ (treated as C3H8 surrogate up through C8H18)
  // Composition-weighted blend across the COMBUSTIBLE fraction (inerts don't
  // change Le; they shift α_th and D_def in lockstep).
  const Le = (xH2 * Le_H2  + xCO * Le_CO  + xCH4 * Le_CH4
            + xC2 * Le_C2  + xCge3 * Le_Cge3) / xCombust;
  return Le;
}
// Thermal diffusivity of unburnt mixture (m²/s). Free-mode approximation used when Cantera isn't available.
// α_th = 2.0e-5 · (T/300)^1.7 / P[atm]. Matches the form in calcBlowoff.
function alphaThU(Tu,P_atm){return 2.0e-5*Math.pow(Tu/300,1.7)/Math.max(P_atm,1e-6);}
// Spadaccini–Colket natural-gas autoignition delay (s). τ_ign = 3.09e-5·P^-1.12·exp(20130/T).
// Rough order-of-magnitude estimate only — accurate solver uses Cantera 0D const-P reactor.
function calcTauIgnFree(Tu,P_atm){
  const P_Pa=P_atm*101325;
  const A=3.09e-5,nP=-1.12,Ea_over_R=20130;
  return A*Math.pow(P_Pa/101325,nP)*Math.exp(Ea_over_R/Math.max(Tu,200));
}
/* Adiabatic fuel/air mixing (constant-cp approximation). Used by every science panel
   so the user's T_fuel and T_air controls actually flow through to AFT, SL, Exhaust, etc.
   Returns the pre-combustion mixture temperature. If both streams share the same T,
   returns that T (degenerate case = old single-inlet behavior). */
function mixT(fuel,ox,phi,Tf,Ta){
  if(Tf==null||Ta==null)return Tf??Ta;
  if(Math.abs(Tf-Ta)<1e-6)return Tf;
  const fp=calcFuelProps(fuel,ox);
  const FAR_m=phi/Math.max(fp.AFR_mass,1e-9);
  const Z=FAR_m/(1+FAR_m);                      // fuel-stream mass fraction
  const cp_f=2200,cp_a=1005;                    // J/kg·K (NG family / air)
  return (Z*cp_f*Tf+(1-Z)*cp_a*Ta)/(Z*cp_f+(1-Z)*cp_a);
}

/* PSR→PFR combustor network: hot-branch equilibrium + Cantera-calibrated kinetics.
   Calibrated against Cantera (GRI-Mech 3.0) over NG+humid-air phi=0.4–0.8, T_in=700–900K,
   P=1–30atm, tau=0.3–10ms. For the user's reference case (phi=0.45, T=811K, P=27atm,
   tau=0.5ms): predicts T_psr=1772K, PSR CO=3744 ppmvd, PSR NO=11 ppmvd, PFR exit CO≈1
   ppmvd, PFR exit NO≈16 ppmvd, NO@15%O2≈11 ppmvd — within ~15% of Cantera for lean GT
   operating envelope. Accuracy degrades above phi=0.8 (Zeldovich saturation not modeled). */
function calcCombustorNetwork(fuel,ox,phi,T_in,P_atm,tau_psr_ms,L_pfr,v_pfr,T_fuel,T_air){
  const tau_psr=tau_psr_ms/1000;
  // 0. Adiabatic mix of fuel & air streams when they differ. Constant-cp approximation
  //    (cp_fuel ~2.2 kJ/kg·K for NG-family, cp_air ~1.005 kJ/kg·K) — this is the free
  //    version; within ~3% of Cantera's enthalpy-balance for CH4-dominant mixtures.
  //    If either T_fuel/T_air is unspecified the mix degenerates to T_in.
  const Tf=(T_fuel!=null&&Number.isFinite(T_fuel))?T_fuel:T_in;
  const Ta=(T_air!=null&&Number.isFinite(T_air))?T_air:T_in;
  const fp0=calcFuelProps(fuel,ox);
  const FAR_m=phi/Math.max(fp0.AFR_mass,1e-9);
  const Z=FAR_m/(1+FAR_m);          // fuel-stream mass fraction of the combined feed
  const cp_f=2200,cp_a=1005;        // J/kg·K
  const T_mixed=Math.abs(Tf-Ta)<1e-6?Tf:(Z*cp_f*Tf+(1-Z)*cp_a*Ta)/(Z*cp_f+(1-Z)*cp_a);
  const T_inlet=T_mixed;            // what the PSR actually sees
  // 1. Equilibrium hot-branch solution (temperature + composition)
  const eq=calcAFT_EQ(fuel,ox,phi,T_inlet,P_atm);
  const T_eq=eq.T_ad;const prods=eq.products||{};
  const x=sp=>(prods[sp]||0)/100;
  const xO2_eq=x("O2"),xN2_eq=x("N2"),xH2O_eq=x("H2O"),xCO_eq=x("CO");
  // 2. Hot-branch factor: sustained combustion when tau is long enough relative
  //    to a piloted-ignition timescale. Real GT combustors always operate here.
  const SL=calcSL(fuel,phi,T_inlet,P_atm);
  const alpha_th=2.0e-5*Math.pow(T_inlet/300,1.7)/Math.max(P_atm,0.1);
  const tau_ig=Math.min(0.002,alpha_th/(SL*SL+1e-20)/200); // piloted: ~50x faster than autoignition
  const bo=Math.max(tau_psr/tau_ig,1e-6);
  const hot=1/(1+Math.exp(-3*(Math.log(bo)-Math.log(2))));
  const T_psr=T_inlet+(T_eq-T_inlet)*hot;
  const conv_psr=hot;
  // 3. PSR CO residual: empirical A/tau_ms, A = 0.7 exp(14000/T) * (27/P)
  //    Matches Cantera to within ±35% over phi=0.4–0.8, P=1–30atm, tau=0.3–10ms.
  const CO_kin=hot*0.7*Math.exp(14000/Math.max(T_psr,600))*27/Math.max(P_atm,0.5)/Math.max(tau_psr_ms,0.02);
  const CO_eq_ppmvd_raw=xCO_eq>0?xCO_eq/(1-xH2O_eq+1e-12)*1e6:0;
  const CO_psr_ppmvd=Math.max(CO_eq_ppmvd_raw,CO_kin);
  const xCO_psr=CO_psr_ppmvd*1e-6*(1-xH2O_eq);
  // 4. PSR NO: partial-equilibrium [O] + 2-term model (lumped prompt/N2O + thermal Zeldovich)
  //    [O] from O2 ⇌ 2O partial equilibrium: x_O = sqrt(Kp*x_O2/P_atm)  (reaction #4)
  //    NO_prompt (ppm-wet) = 337 * xN2 * xO * exp(16016/T) — lumps Fenimore prompt + N2O path
  //    NO_thermal (ppm-wet) = 2·k1·[N2][O]·C·tau with k1 = 1.8e8·exp(-38370/T) m³/mol/s
  const nPsr=(T)=>{
    const xO_pe=Math.sqrt(Math.exp(lnKp(4,T))*Math.max(xO2_eq,1e-12)/P_atm);
    const C_t=P_atm*101325/(R_u*T);
    const k_th=1.8e8*Math.exp(-38370/T);
    const NO_prompt=337*xN2_eq*xO_pe*Math.exp(16016/T); // ppm-wet
    const NO_thermal_rate=2*k_th*xN2_eq*xO_pe*C_t;      // xNO per second
    return{xO_pe,C_t,k_th,NO_prompt,NO_thermal_rate};
  };
  const psrK=nPsr(T_psr);
  const NO_wet_psr=hot*Math.min(psrK.NO_prompt+psrK.NO_thermal_rate*tau_psr*1e6,5000); // cap 5000 ppm
  const xNO_psr=NO_wet_psr*1e-6;
  const NO_psr_ppmvd=xNO_psr/(1-xH2O_eq+1e-12)*1e6;
  // 5. PFR march: first-order CO burnout + Zeldovich NO growth (partial-eq [O])
  //    k_CO_eff ≈ 1.44e6 exp(-125000/RT) /s — calibrated so CO drops 3200→5 ppmvd
  //    over 25 ms at 1745K (Cantera user-case benchmark).
  const nPts=80;const v_use=Math.max(v_pfr,0.1);
  const dx=L_pfr/nPts;const dt=dx/v_use;
  const L_psr_m=tau_psr*v_use;  // equivalent PSR length at the same flow velocity
  let T=T_psr;let xCO=xCO_psr;let xNO=xNO_psr;
  const psrPt=(x_m)=>({x:+(x_m*100).toFixed(2),T:+T_psr.toFixed(0),NO_ppm:+NO_psr_ppmvd.toFixed(2),CO_ppm:+CO_psr_ppmvd.toFixed(3),conv:+(conv_psr*100).toFixed(1)});
  const pfr=[psrPt(0),psrPt(L_psr_m)];
  for(let i=1;i<=nPts;i++){
    const k_CO=1.44e6*Math.exp(-125000/(R_u*T));
    xCO=Math.max(xCO*Math.exp(-k_CO*dt),xCO_eq);
    const pk=nPsr(T);
    xNO=Math.min(xNO+pk.NO_thermal_rate*dt,0.005);
    pfr.push({x:+((L_psr_m+i*dx)*100).toFixed(2),T:+T.toFixed(0),
      NO_ppm:+(xNO/(1-xH2O_eq+1e-12)*1e6).toFixed(2),
      CO_ppm:+(xCO/(1-xH2O_eq+1e-12)*1e6).toFixed(3),
      conv:+(conv_psr*100).toFixed(1)});
  }
  const O2_dry=xO2_eq/(1-xH2O_eq+1e-12)*100;
  const corrF=(20.95-15)/Math.max(20.95-O2_dry,0.1);
  const fin=pfr[pfr.length-1];
  return{T_psr,conv_psr:conv_psr*100,T_ad:T_eq,T_mixed_inlet_K:T_mixed,
    NO_ppm_exit:fin.NO_ppm,NO_ppm_psr:NO_psr_ppmvd,NO_ppm_15O2:fin.NO_ppm*corrF,
    CO_ppm_exit:fin.CO_ppm,CO_ppm_psr:CO_psr_ppmvd,CO_ppm_15O2:fin.CO_ppm*corrF,O2_pct:O2_dry,pfr,tau_psr_ms,tau_pfr_ms:L_pfr/Math.max(v_pfr,1e-6)*1000,tau_total_ms:tau_psr_ms+L_pfr/Math.max(v_pfr,1e-6)*1000,L_psr_cm:L_psr_m*100,L_total_cm:(L_psr_m+L_pfr)*100};
}

/* ══════════════════ EXCEL EXPORT ══════════════════ */
// Label maps for PSR option codes → human-readable strings in the export.
const _PSR_SEED_LBL={unreacted:"Unreacted (cold)",hot_eq:"Hot equilibrium",cold_ignited:"Cold-ignited (default)",autoignition:"Autoignition"};
const _EQ_LBL={HP:"HP (constant enthalpy+pressure)",UV:"UV (constant internal energy+volume)",TP:"TP (constant temperature+pressure)"};
const _INT_LBL={steady_state:"Steady-state solver",chunked:"Chunked time advance (default)",step:"Step-by-step"};
const _MECH_LBL={gri30:"GRI-Mech 3.0 (53 species, 325 rxns)",glarborg:"Glarborg 2018 (151 species, 1395 rxns)",usc2:"USC-Mech II (coming soon)",aramco30:"AramcoMech 3.0 (coming soon)"};
// Top-level entrypoint: build TWO workbooks (one in SI, one in English) and
// download both. The actual workbook construction lives in
// _buildExportWorkbook below.
//
// Browsers (Chrome ≥ 60, Safari, Firefox) routinely suppress back-to-back
// programmatic downloads triggered from a single click handler — only the
// first file lands. We schedule the second write inside a setTimeout so the
// click event has time to settle and the browser treats it as a fresh,
// user-initiated download. Both files share the active app-mode suffix so
// the user can see at a glance which mode the workbook was generated in.
function exportToExcel(fuel,ox,phi,T0,P,_unitsIgnored,ps){
  const _modeSuffix = ps?.appMode ? `_${ps.appMode}` : "";
  const wbSI = _buildExportWorkbook(fuel,ox,phi,T0,P,"SI",ps);
  XLSX.writeFile(wbSI, `ProReadyEngineer_CombustionReport${_modeSuffix}_SI.xlsx`);
  setTimeout(() => {
    const wbENG = _buildExportWorkbook(fuel,ox,phi,T0,P,"ENG",ps);
    XLSX.writeFile(wbENG, `ProReadyEngineer_CombustionReport${_modeSuffix}_English.xlsx`);
  }, 400);
}

function _buildExportWorkbook(fuel,ox,phi,T0,P,units,ps){const wb=XLSX.utils.book_new();const u=units;const fp=calcFuelProps(fuel,ox);const{velocity,Lchar,Dfh=0.02,Lpremix=0.10,Vpremix=60,tau_psr,L_pfr,V_pfr,T_fuel,T_air,measO2,measCO2,measCO=0,measUHC=0,measH2=0,fuelFlowKgs=0,fuelCostUsdPerMmbtuLhv=4.00,costPeriod="month",combMode,psrSeed="cold_ignited",eqConstraint="HP",integration="chunked",heatLossFrac=0,mechanism="gri30",WFR=0,waterMode="liquid",T_water=288.15,accurate=false,cycleEngine,cyclePamb,cycleTamb,cycleRH,cycleLoad,cycleTcool,cycleAirFrac,bleedMode="auto",bleedOpenPct=0,bleedValveSizePct=0,bleedAirFrac=0,cycleResult,mappingTables,
  emissionsMode=true,mapW36w3=0.75,mapFracIP=2.3,mapFracOP=2.2,mapFracIM=39.9,mapFracOM=55.6,
  mapPhiIP=0.25,mapPhiOP=0.65,mapPhiIM=0.50,mapResult=null,emTfMults=null,
  linkT3=true,linkP3=true,linkFAR=true,linkFuelFlow=true,linkExhaustCO=false,linkExhaustUHC=false,loadStepPct=5,bleedStepPct=15,
  appMode="advanced",
  // Lifted Cantera flame results (null in free mode or before activation).
  flameBk=null,flameBkIgn=null,flameCanteraSweeps=null
}=ps||{};
  // ── MODE-BASED SHEET VISIBILITY ─────────────────────────────────────
  // Mirrors the panel-visibility filter on TABS_BASE so the workbook only
  // contains tabs that correspond to panels visible in the active mode.
  //   free / ctk → combustion analysis sheets only
  //   gts        → cycle + mapping sheets only (no combustion analysis)
  //   advanced   → everything
  // Assumptions and UI Settings are always emitted (reference / repro).
  // Default is "advanced" so older callers (or stale localStorage) get the
  // legacy "everything" behavior rather than an empty workbook.
  const _showCombustion = ["free","ctk","advanced"].includes(appMode);
  const _showCycle      = ["gts","advanced"].includes(appMode);
  const _showMapping    = ["gts","advanced"].includes(appMode);
  // Adiabatic fuel/air mix T that's used everywhere downstream
  const T_mix_phi=mixT(fuel,ox,phi,T_fuel??T0,T_air??T0);
  const aft=calcAFTx(fuel,ox,phi,T_mix_phi,P,combMode);
  // T4 (turbine inlet) re-equilibration for the products section. Only computed if Cycle has been run.
  const T4_K=cycleResult?.T4_K||null;
  const T_fuel_eff=T_fuel??T0;
  // MWI uses the same formula as the UI card: LHV_vol/√(SG·T_fuel). SI: MJ/m³·√K. ENG: BTU/scf·√°R.
  const MWI=(u==="SI")?(fp.LHV_vol/Math.sqrt(Math.max(fp.SG,1e-9)*T_fuel_eff)):((fp.LHV_vol*26.839)/Math.sqrt(Math.max(fp.SG,1e-9)*T_fuel_eff*1.8));
  const MWI_unit=(u==="SI")?"MJ/m³·√K":"BTU/scf·√°R";
  // Re-equilibrate at T4 if available (free-mode 6-reaction Newton solver). Returns mol%, sums to 100.
  let productsAtT4=null;
  if(T4_K&&aft.products&&Object.keys(aft.products).length){
    try{const _prod0={};for(const[sp,pct]of Object.entries(aft.products))_prod0[sp]=pct/100;
      const _eq=equilibrateAtT(_prod0,T4_K,P,phi>1);
      const _tot=Object.values(_eq).reduce((a,b)=>a+Math.max(0,b),0);
      if(_tot>0){const _o={};for(const[sp,n]of Object.entries(_eq)){if(n>0&&n/_tot>1e-5)_o[sp]=n/_tot*100;}productsAtT4=Object.keys(_o).length?_o:null;}
    }catch(e){productsAtT4=null;}
  }
const s1=[["COMBUSTION ENGINEERING TOOLKIT — ProReadyEngineer LLC"],["Generated: "+new Date().toISOString().slice(0,16)],["Unit System: "+(u==="SI"?"SI (Metric)":"English (Imperial)")],["Combustion Mode: "+(combMode==="equilibrium"?"Chemical Equilibrium (with dissociation)":"Complete Combustion (no dissociation)")],[],["═══ FUEL COMPOSITION (mol%) ═══"],["Species","Mole %"],...Object.entries(fuel).filter(([_,v])=>v>0).map(([sp,v])=>[fmt(sp),+v.toFixed(2)]),[],["═══ OXIDIZER COMPOSITION (mol%) ═══"],["Species","Mole %"],...Object.entries(ox).filter(([_,v])=>v>0).map(([sp,v])=>[fmt(sp),+v.toFixed(2)]),[],["═══ OPERATING CONDITIONS (INPUTS) ═══"],["Parameter","Value","Unit"],["Equivalence Ratio (φ)",+phi.toFixed(4),"—"],["Fuel/Air Ratio (mass)",+(phi/fp.AFR_mass).toFixed(6),uu(u,"afr_mass")],["Air/Fuel Ratio (mass)",+(fp.AFR_mass/phi).toFixed(4),uu(u,"afr_mass")],["Air Inlet Temperature (T_air)",+uv(u,"T",T_air??T0).toFixed(2),uu(u,"T")],["Fuel Inlet Temperature (T_fuel)",+uv(u,"T",T_fuel_eff).toFixed(2),uu(u,"T")],["Adiabatic Mixed Inlet T (T_mixed @ φ)",+uv(u,"T",T_mix_phi).toFixed(2),uu(u,"T")],["Pressure",+uv(u,"P",P).toFixed(3),uu(u,"P")],["Water/Fuel Mass Ratio (WFR)",+(+WFR).toFixed(3),"kg_water/kg_fuel"],["Water Injection Mode",WFR>0?(waterMode==="steam"?"Steam (gas phase @ T_air)":"Liquid (absorbs h_fg)"):"off","—"],[],
  ["═══ FUEL PROPERTIES (composition + T_fuel only — no φ dependence) ═══"],["Parameter","Value","Unit"],
  ["Lower Heating Value (mass)",+uv(u,"energy_mass",fp.LHV_mass).toFixed(4),uu(u,"energy_mass")],
  ["Lower Heating Value (volumetric)",+uv(u,"energy_vol",fp.LHV_vol).toFixed(4),uu(u,"energy_vol")],
  ["Higher Heating Value (mass)",+uv(u,"energy_mass",fp.HHV_mass).toFixed(4),uu(u,"energy_mass")],
  ["Higher Heating Value (volumetric)",+uv(u,"energy_vol",fp.HHV_vol).toFixed(4),uu(u,"energy_vol")],
  ["Fuel Molecular Weight",+fp.MW_fuel.toFixed(4),"g/mol"],
  ["Specific Gravity",+fp.SG.toFixed(5),"—"],
  ["Wobbe Index (WI = HHV_vol/√SG)",+uv(u,"energy_vol",fp.WI).toFixed(2),uu(u,"energy_vol")],
  ["Modified Wobbe Index (MWI = LHV_vol/√(SG·T_fuel))",+MWI.toFixed(u==="SI"?4:3),MWI_unit],
  ["Stoichiometric Air/Fuel (mass)",+fp.AFR_mass.toFixed(4),uu(u,"afr_mass")],
  ["Stoichiometric Air/Fuel (vol)",+fp.AFR_vol.toFixed(4),"mol/mol"],
  ["Stoichiometric O₂ Demand",+fp.stoichO2.toFixed(5),"mol O₂ / mol fuel"],[],
  ["═══ FLAME PROPERTIES (depend on φ, oxidizer, conditions) ═══"],["Parameter","Value","Unit"],
  ["Adiabatic Flame Temperature (T_Bulk)",+uv(u,"T",aft.T_ad).toFixed(1),uu(u,"T")],
  ["T₄ (Turbine Inlet, from Cycle)",T4_K?+uv(u,"T",T4_K).toFixed(1):"n/a",T4_K?uu(u,"T"):"—"],[],
  ...(productsAtT4?[
    ["═══ EQUILIBRIUM PRODUCTS — WET BASIS at T₄ (mol%) ═══"],
    ["Note","Re-equilibrated at T₄ = "+(+uv(u,"T",T4_K).toFixed(1))+" "+uu(u,"T")+" (turbine inlet, dilution-cooled). NO and OH equilibrium are sensitive to product T.",""],
    ["Species","Mole Fraction (%)"],
    ...Object.entries(productsAtT4).filter(([_,v])=>v>0.01).sort((a,b)=>b[1]-a[1]).map(([sp,v])=>[fmt(sp),+v.toFixed(4)]),[],
    ["═══ EQUILIBRIUM PRODUCTS — DRY BASIS at T₄ (mol%, H₂O removed) ═══"],
    ["Species","Mole Fraction (%)"],
    ...Object.entries(dryBasis(productsAtT4)).filter(([_,v])=>v>0.01).sort((a,b)=>b[1]-a[1]).map(([sp,v])=>[fmt(sp),+v.toFixed(4)]),[],
    ["═══ EQUILIBRIUM PRODUCTS — WET BASIS at T_ad (reference, hot flame zone) ═══"],
    ["Species","Mole Fraction (%)"],
    ...Object.entries(aft.products||{}).filter(([_,v])=>v>0.01).sort((a,b)=>b[1]-a[1]).map(([sp,v])=>[fmt(sp),+v.toFixed(4)]),[],
  ]:[
    ["═══ EQUILIBRIUM PRODUCTS — WET BASIS at T_ad (mol%) ═══"],
    ["Note","Run the Cycle panel and re-export to also see products re-equilibrated at T₄ (turbine inlet).",""],
    ["Species","Mole Fraction (%)"],
    ...Object.entries(aft.products||{}).filter(([_,v])=>v>0.01).sort((a,b)=>b[1]-a[1]).map(([sp,v])=>[fmt(sp),+v.toFixed(4)]),[],
    ["═══ EQUILIBRIUM PRODUCTS — DRY BASIS at T_ad (mol%, H₂O removed) ═══"],
    ["Species","Mole Fraction (%)"],
    ...Object.entries(dryBasis(aft.products||{})).filter(([_,v])=>v>0.01).sort((a,b)=>b[1]-a[1]).map(([sp,v])=>[fmt(sp),+v.toFixed(4)]),[],
  ]),
  ["═══ AFT vs φ SWEEP ═══"],["Equivalence Ratio (φ)","Fuel/Air Ratio (mass)","T_mixed_inlet ("+uu(u,"T")+")","Adiabatic Flame Temperature ("+uu(u,"T")+")"],...Array.from({length:18},(_,i)=>{const p=0.3+i*0.04;const Tm=mixT(fuel,ox,p,T_fuel??T0,T_air??T0);const a=calcAFTx(fuel,ox,p,Tm,P,combMode);return[+p.toFixed(2),+(p/fp.AFR_mass).toFixed(6),+uv(u,"T",Tm).toFixed(1),+uv(u,"T",a.T_ad).toFixed(1)];})];const ws1=XLSX.utils.aoa_to_sheet(s1);ws1["!cols"]=[{wch:42},{wch:20},{wch:18}];if(_showCombustion)XLSX.utils.book_append_sheet(wb,ws1,"Flame Temp & Props");
// ── Source-of-truth selection for the Flame Speed sheet ────────────────
// When the user is in Combustion Toolkit / Advanced mode AND the live
// FlameSpeedPanel has a finished Cantera 1D-FreeFlame result in `flameBk`,
// we publish the REAL Cantera S_L, T_mixed, α_th, ν_u, Le_eff, Le_E, Le_D,
// Ma, Ze, δ_F. Otherwise we fall back to the JS Gülder correlation. This
// fixes the long-standing bug where Combustion Toolkit users got
// free-mode S_L in their Excel reports — sometimes off by 50–150 % vs
// the true Cantera value at industrial DLN conditions (high-T, high-P,
// lean φ, H₂-rich blends). The `_useCanteraFlame` flag also controls the
// downstream Bradley S_T, Karlovitz, Borghi regime, and the φ/T/P sweeps
// at the bottom of the sheet — they all need to use the same SL value
// the user saw on screen, otherwise Card 2/3 outputs would be poisoned.
const _useCanteraFlame = !!(accurate && flameBk && Number.isFinite(flameBk.SL) && flameBk.SL > 0);
const _T_mix_used = _useCanteraFlame ? flameBk.T_mixed_inlet_K : T_mix_phi;
const _SLms = _useCanteraFlame ? flameBk.SL : calcSL(fuel,phi,_T_mix_used,P);
const SL    = _SLms * 100;                          // cm/s for the Excel cell
const bo    = _useCanteraFlame
  ? (()=>{const tau_chem=(flameBk.alpha_th_u||alphaThU(_T_mix_used,P))/Math.max(_SLms*_SLms,1e-20);const tau_flow=Lchar/Math.max(velocity,1e-20);return{SL:_SLms,tau_chem:tau_chem*1000,tau_flow:tau_flow*1000,Da:tau_flow/Math.max(tau_chem,1e-20),blowoff_velocity:Lchar/Math.max(tau_chem,1e-20),stable:(tau_flow/Math.max(tau_chem,1e-20))>1};})()
  : calcBlowoff(fuel,phi,_T_mix_used,P,velocity,Lchar);
const _alphaTh = _useCanteraFlame && Number.isFinite(flameBk.alpha_th_u) ? flameBk.alpha_th_u : alphaThU(_T_mix_used,P);
const _tauBO=Dfh/Math.max(1.5*_SLms,1e-20);
const _gc=(_SLms*_SLms)/Math.max(_alphaTh,1e-20);
// τ_ign: prefer Cantera 0D autoignition reactor when available (flameBkIgn);
// otherwise fall back to Spadaccini-Colket NG correlation (free-mode).
const _tauIgn = (accurate && flameBkIgn && Number.isFinite(flameBkIgn.tau_ign_s) && flameBkIgn.tau_ign_s > 0)
  ? flameBkIgn.tau_ign_s
  : calcTauIgnFree(_T_mix_used,P);
const _tauRes=Lpremix/Math.max(Vpremix,1e-20);
const _ignSafe=_tauRes<_tauIgn;
// ── Card 1 (Flame Speed & Regime Diagnostics) — derived quantities ────
// All transport / Lewis / Markstein quantities prefer the live Cantera
// result when present. Free-mode fallback only when not in accurate mode
// or before the panel has been activated.
const _Le_free   = _useCanteraFlame && Number.isFinite(flameBk.Le_eff) ? flameBk.Le_eff : lewisNumberFreeMode(fuel);
const _Le_E_used = _useCanteraFlame && Number.isFinite(flameBk.Le_E)   ? flameBk.Le_E   : _Le_free;
const _Le_D_used = _useCanteraFlame && Number.isFinite(flameBk.Le_D)   ? flameBk.Le_D   : _Le_free;
const _Ma_used   = _useCanteraFlame && Number.isFinite(flameBk.Ma)     ? flameBk.Ma     : null;
const _Ze_used   = _useCanteraFlame && Number.isFinite(flameBk.Ze)     ? flameBk.Ze     : null;
const _Tmax_used = _useCanteraFlame && Number.isFinite(flameBk.T_max)  ? flameBk.T_max  : null;
const _nu_free   = _useCanteraFlame && Number.isFinite(flameBk.nu_u)   ? flameBk.nu_u   : (_alphaTh / 0.71);
const _delta_F   = _useCanteraFlame && Number.isFinite(flameBk.delta_F) ? flameBk.delta_F : (_alphaTh / Math.max(_SLms, 1e-9));
const _uPrimeRatio_x = 0.20;                                      // panel default (u'/U)
const _uPrime_x  = _uPrimeRatio_x * Math.max(velocity, 0);
const _lT_x      = 0.10 * Math.max(Lchar, 1e-6);
const _bradley   = bradleyST(_SLms, Math.max(_uPrime_x, 1e-9), _lT_x, _nu_free, _Le_free);
const _ST_brad   = _bradley.ST;
const _ST_dam    = damkohlerST(_SLms, Math.max(_uPrime_x, 1e-9));
const _Ka_diag   = _bradley.Ka;
const _ReT_diag  = _bradley.ReT;
const _Da_diag   = (_lT_x / Math.max(_delta_F, 1e-12)) * (_SLms / Math.max(_uPrime_x, 1e-9));
const _Borghi_regime = _Ka_diag<1?(_Da_diag>1?"Flamelet":"Corrugated"):_Ka_diag<100?"Thin reaction zone":"Broken reaction zone";
// ── Card 2 (Stabilization & Blowoff) — Lefebvre BAND + Plee-Mellor ────
// LP-band approach: no V_pz / ṁ_air dependency. Sweep loading parameter
// over typical industrial GT design range and produce φ_LBO range.
const _K_LBO_x   = 6.29;      // Lefebvre A — premixed-gas calibration (anchored to LMS100, φ_LBO=0.40 at LP_high)
const _T3_lbo_K  = (cycleResult && cycleResult.T3_K) ? cycleResult.T3_K : T0;
const _FAR_st    = 1 / Math.max(fp.AFR_mass, 1e-12);
const _lbo_band_x = lefebvreLBO_band(_K_LBO_x, _T3_lbo_K, fp.LHV_mass, _FAR_st, phi, fuel);
const _phi_LBO_low_x  = _lbo_band_x.phi_low;
const _phi_LBO_high_x = _lbo_band_x.phi_high;
const _lbo_status_x   = _lbo_band_x.status;
// Plee-Mellor uses T_3 as inlet T (still needed):
// Plee-Mellor 1979 cross-check (same formula as panel, T_φ uses 1800 K placeholder when no Cantera data)
const _PM_T_phi_x  = 1800;                          // export-time placeholder (no Cantera here)
const _PM_T_in_x   = Math.max(_T3_lbo_K, 1);
const _PM_EaR_K    = 21000.0 / 1.987;
const _PM_tau_hc_ms = 1e-4 * (_PM_T_phi_x / _PM_T_in_x) * Math.exp(_PM_EaR_K / Math.max(_PM_T_phi_x, 1));
const _PM_tau_sl_ms = (Math.max(Lchar, 1e-9) / Math.max(velocity, 1e-9)) * 1000;
const _PM_ratio    = _PM_tau_sl_ms / Math.max(_PM_tau_hc_ms, 1e-12);
const _PM_safe     = _PM_ratio > 2.11;
// Da_crit for default premixer = swirl @ S_n=0.6 → 0.50 per the panel's interpolation
const _Da_crit_x = 0.50;
const _Da_actual_x = bo.Da;
const _V_BO_x    = velocity * Math.max(_Da_actual_x / Math.max(_Da_crit_x, 1e-9), 1e-6);
// ── Card 3 (Premixer Flashback & Autoignition) — gates A/B/C/D ────────
const _H2_pct_x  = ((fuel.H2  || 0) / Math.max(Object.values(fuel).reduce((a,b)=>a+b,0), 1e-9)) * 100;
const _CO_pct_x  = ((fuel.CO  || 0) / Math.max(Object.values(fuel).reduce((a,b)=>a+b,0), 1e-9)) * 100;
const _CH4_pct_x = ((fuel.CH4 || 0) / Math.max(Object.values(fuel).reduce((a,b)=>a+b,0), 1e-9)) * 100;
const _D_h_x     = 0.040;     // panel default 40 mm
const _eps_turb_x= 0.7;       // panel default
const _RTD_x     = 1.5;       // panel default
const _Sn_x      = 0.6;       // swirl number default
const _g_u_pipe_x  = 8 * Vpremix / Math.max(_D_h_x, 1e-6);
const _g_u_actual_x= _g_u_pipe_x * (1 + _eps_turb_x);
const _sigma_rho_x = (_PM_T_phi_x) / Math.max(T_mix_phi, 1);
const _confine_corr = (_H2_pct_x/100 > 0.30) ? Math.sqrt(Math.max(_sigma_rho_x, 1)) : 1.0;
const _g_c_eff_x = _gc * _confine_corr;
const _gateA_pass= _g_u_actual_x > _g_c_eff_x;
const _gateA_marg= _g_u_actual_x / Math.max(_g_c_eff_x, 1e-9);
const _Ka_fb_x   = (_g_u_actual_x > 0 && _SLms > 0) ? (_g_u_actual_x * _delta_F) / _SLms : NaN;
const _shaffer_T_tip = -1.58*_H2_pct_x - 3.63*_CO_pct_x - 4.28*_CH4_pct_x + 0.38*_PM_T_phi_x;
const _piCIVB_x  = _SLms / Math.max(_Sn_x * Math.max(Vpremix, 1e-9) * Math.PI, 1e-12);
const _civb_thr_x= (_H2_pct_x/100 > 0.30) ? 0.03 : 0.05;
const _gateB_pass= _piCIVB_x < _civb_thr_x;
// Gate C uses Bradley S_T (not the simple SL × 1.8 turb-factor estimator).
// The legacy SL × 1.8 estimator is kept further down for the legacy
// flashback_margin rollup, but the panel's actual Gate C output uses
// Bradley S_T with V_premix-based u' — Excel must match the panel.
const _uPrime_premix_x = 0.10 * Math.max(Vpremix, 0);          // u' = 10% × V_premix (Card 3 convention)
const _lT_premix_x     = 0.10 * Math.max(_D_h_x, 1e-6);        // l_T = 0.1 × D_h
const _bradley_premix_x= bradleyST(_SLms, Math.max(_uPrime_premix_x, 1e-9), _lT_premix_x, _nu_free, _Le_free);
const _ST_premix_x     = _bradley_premix_x.ST;
// Legacy turb-factor S_T (kept for documentation; not used for Gate C anymore).
const _ST_est_x_legacy = _SLms * ((_H2_pct_x/100 > 0.30) ? 2.5 : 1.8);
const _v_st_marg = Vpremix / Math.max(_ST_premix_x, 1e-9);
const _gateC_pass= _v_st_marg > 1.43;
const _tau_res_99= _RTD_x * (Lpremix / Math.max(Vpremix, 1e-20));
const _ign_marg_3= isFinite(_tauIgn) ? _tauIgn / Math.max(_tau_res_99, 1e-20) : NaN;
const _gateD_pass= isFinite(_tauIgn) && _ign_marg_3 >= 3;
const _all_pass  = _gateA_pass && _gateB_pass && _gateC_pass && _gateD_pass;
const _card3_status = _all_pass ? "PASS" : "FAIL";
const s2=[
  ["═══ FLAME SPEED & BLOWOFF — INPUTS ═══"],[],
  ["Parameter","Value","Unit"],
  ["Equivalence Ratio (φ)",+phi.toFixed(4),"—"],
  ["Fuel/Air Ratio (mass)",+(phi/fp.AFR_mass).toFixed(6),uu(u,"afr_mass")],
  ["Air Inlet Temperature (T_air)",+uv(u,"T",T_air??T0).toFixed(2),uu(u,"T")],
  ["Fuel Inlet Temperature (T_fuel)",+uv(u,"T",T_fuel??T0).toFixed(2),uu(u,"T")],
  ["Unburned Temperature (T_mixed @ φ)",+uv(u,"T",_T_mix_used).toFixed(2),uu(u,"T")],
  ["Pressure",+uv(u,"P",P).toFixed(3),uu(u,"P")],
  ["Reference Velocity",+uv(u,"vel",velocity).toFixed(2),uu(u,"vel")],
  ["Characteristic Length (L_char)",+uv(u,"len",Lchar).toFixed(4),uu(u,"len")],
  ["Flameholder Diameter (D_fh)",+uv(u,"len",Dfh).toFixed(4),uu(u,"len")],
  ["Premixer Length (L_premix)",+uv(u,"len",Lpremix).toFixed(4),uu(u,"len")],
  ["Premixer Velocity (V_premix)",+uv(u,"vel",Vpremix).toFixed(2),uu(u,"vel")],
  [],
  ["═══ LEGACY OUTPUTS — Damköhler Blowoff ═══"],
  ["Parameter","Value","Unit"],
  ["Laminar Flame Speed (S_L)",+uv(u,"SL",SL).toFixed(4),uu(u,"SL")],
  ["Chemical Timescale (τ_chem)",+bo.tau_chem.toFixed(6),"ms"],
  ["Flow Timescale (τ_flow)",+bo.tau_flow.toFixed(6),"ms"],
  ["Damköhler Number (Da)",+bo.Da.toFixed(4),"—"],
  ["Blowoff Velocity",+uv(u,"vel",bo.blowoff_velocity).toFixed(2),uu(u,"vel")],
  ["Flame Stability",bo.stable?"STABLE":"BLOWOFF RISK","—"],
  [],
  ["═══ CARD 1 — Flame Speed & Regime Diagnostics ═══"],
  ["Parameter","Value","Unit"],
  ["Source",_useCanteraFlame?"Cantera 1D FreeFlame (mixture-averaged transport, GRI-Mech 3.0)":"Free-mode JS Gülder correlation (S_L) + Bechtold-Matalon Eq. 6 fallback (Le_eff)","—"],
  ["Effective Lewis Number (Le_eff)",+_Le_free.toFixed(3),"—"],
  ["Le_E (excess reactant)",+_Le_E_used.toFixed(3),"—"],
  ["Le_D (deficient reactant)",+_Le_D_used.toFixed(3),"—"],
  ["Markstein Number (Ma)",_Ma_used==null?"N/A":+_Ma_used.toFixed(3),"—"],
  ["Zeldovich Number (Ze)",_Ze_used==null?"N/A":+_Ze_used.toFixed(2),"—"],
  ["Flame Temperature T_max (Cantera burnt-side)",_Tmax_used==null?"N/A":+uv(u,"T",_Tmax_used).toFixed(1),uu(u,"T")],
  ...(_useCanteraFlame?[]:[["Note","Le_E/Le_D/Ma/Ze/T_max require Cantera. Activate the Flame Speed panel in Combustion Toolkit / Advanced mode and re-export.",""]]),
  ["Thermal Diffusivity (α_th, unburnt)",+(_alphaTh*1e6).toFixed(4),"mm²/s"],
  ["Kinematic Viscosity (ν, unburnt)",+(_nu_free*1e6).toFixed(4),"mm²/s"],
  ["Zeldovich Flame Thickness (δ_F)",+(_delta_F*1e6).toFixed(2),"μm"],
  ["u'/U (turbulence intensity)",+_uPrimeRatio_x.toFixed(3),"—"],
  ["u' (RMS turb velocity)",+uv(u,"vel",_uPrime_x).toFixed(3),uu(u,"vel")],
  ["l_T (integral length scale, auto = 0.1·L_char)",+uv(u,"len",_lT_x).toFixed(5),uu(u,"len")],
  ["Reynolds Re_T",+_ReT_diag.toFixed(0),"—"],
  ["Karlovitz Number (Ka)",+_Ka_diag.toFixed(3),"—"],
  ["Da_regime (Borghi, l_T/δ_F · S_L/u')",+_Da_diag.toFixed(2),"—"],
  ["Borghi-Peters Regime",_Borghi_regime,"—"],
  ["Turbulent Flame Speed S_T (Bradley/Lau/Lawes 1992)",+uv(u,"vel",_ST_brad).toFixed(3),uu(u,"vel")],
  ["Turbulent Flame Speed S_T (Damköhler 1940)",+uv(u,"vel",_ST_dam).toFixed(3),uu(u,"vel")],
  [],
  ["═══ CARD 2 — Stabilization & Blowoff (Lefebvre + Plee-Mellor) ═══"],
  ["Parameter","Value","Unit"],
  ["Premixer Type (default for export)","swirl burner @ S_n=0.6","—"],
  ["Da_BO,crit (premixer-type, anchor blowoff)",+_Da_crit_x.toFixed(3),"—"],
  ["Da_BO (actual, τ_flow/τ_chem with τ_flow=L_char/V_ref)",+_Da_actual_x.toFixed(3),"—"],
  ["Da_BO / Da_BO,crit (margin to flame anchor blowoff)",+(_Da_actual_x/_Da_crit_x).toFixed(2),"—"],
  ["Note","Da_BO (Card 2 / blowoff) and Da_regime (Card 1 / Borghi) are different Damköhler quantities sharing the same name — combustion convention. Da_regime places the point on the Borghi diagram; Da_BO measures flame-anchor stability.",""],
  ["V_BO (this geometry)",+uv(u,"vel",_V_BO_x).toFixed(2),uu(u,"vel")],
  ["─── Lefebvre LBO (Lefebvre & Ballal 2010 Eq. 5.27) ───","",""],
  ["Lefebvre A constant (premixed-gas calibration)",+_K_LBO_x.toFixed(4),"—"],
  ["Loading-parameter band swept (LP, kg/(s·m³·atm^1.3))",`${_LBO_LP_LOW}–${_LBO_LP_HIGH}`,"—"],
  ["T_3 (combustor inlet T)",+uv(u,"T",_T3_lbo_K).toFixed(1),uu(u,"T")],
  ["Fuel composition multiplier m_fuel (× both band edges)",+(_lbo_band_x.fuel_mult).toFixed(3),"—"],
  ["φ_LBO_low (LP="+_LBO_LP_LOW+", well-loaded sound design)",+_phi_LBO_low_x.toFixed(3),"—"],
  ["φ_LBO_high (LP="+_LBO_LP_HIGH+", high-loaded marginal design)",+_phi_LBO_high_x.toFixed(3),"—"],
  ["Operating φ vs band",+phi.toFixed(4),"—"],
  ["Lefebvre LBO Status",_lbo_status_x === "SAFE" ? "SAFE (above band)" : _lbo_status_x === "ALARM" ? "ALARM (in band)" : _lbo_status_x === "HIGH_RISK" ? "HIGH RISK (below band)" : "—","—"],
  ["Note","φ_LBO band: sweeps loading parameter LP = ṁ_air/(V_pz·P_3_atm^1.3) over typical industry-GT design range. q_LBO = K · LP / (304.1 · exp(T_3/300) · H_r); φ_LBO = (q_LBO/FAR_stoich) × m_fuel. Drops dependency on ṁ_air, V_pz, AND P_3 — only T_3 and fuel matter. K hidden; default 6.29. m_fuel = 1 − (2/3)·x_H₂ − 0.1·x_C₃H₈ (linear in mole fraction; pure H₂ → ×1/3; pure C₃H₈ → ×0.9; pure CH₄ → ×1.0). Status: φ above band = SAFE; in band = ALARM; below = HIGH RISK.",""],
  ["─── Plee-Mellor 1979 LBO Cross-check (Combust Flame 35:61) ───","",""],
  ["τ_sl shear-layer residence",+_PM_tau_sl_ms.toFixed(3),"ms"],
  ["τ_hc' chemical ignition delay (Eq. 17, T_φ=1800 K placeholder)",+_PM_tau_hc_ms.toFixed(4),"ms"],
  ["τ_sl / τ_hc' (LBO line at 2.11)",+_PM_ratio.toFixed(2),"—"],
  ["Plee-Mellor LBO Status",_PM_safe?"STABLE":"BLOWOFF","—"],
  ["─── Legacy Premixer Stability ───","",""],
  ["Zukoski Blow-off Time (τ_BO)",+(_tauBO*1000).toFixed(4),"ms"],
  ["Lewis-von Elbe Gradient (g_c)",+_gc.toFixed(1),"1/s"],
  ["Autoignition Delay (τ_ign, Spadaccini-Colket)",
    (_tauIgn > 1000) ? "> 1000 s (correlation OOR — mixture thermo-kinetically stable)" : +(_tauIgn*1000).toFixed(4),
    "ms"],
  ["Premixer Residence Time (τ_res)",+(_tauRes*1000).toFixed(4),"ms"],
  ["Safety Margin (τ_ign / τ_res)",+(_tauIgn/_tauRes).toFixed(3),"—"],
  ["Premixer Status",_ignSafe?"SAFE":"AUTOIGNITION RISK","—"],
  [],
  ["═══ CARD 3 — Premixer Flashback & Autoignition (4 gates) ═══"],
  ["Parameter","Value","Unit"],
  ["H₂ in fuel",+_H2_pct_x.toFixed(1),"%"],
  ["D_h premixer (default)",+_D_h_x.toFixed(3),"m"],
  ["ε_turb wall-shear amplification (default)",+_eps_turb_x.toFixed(2),"—"],
  ["RTD multiplier τ_res,99/τ_res (default)",+_RTD_x.toFixed(2),"—"],
  ["─── Gate A: Boundary-Layer Flashback (Lewis-von Elbe / Lieuwen 2021) ───","",""],
  ["g_c critical wall gradient",+_gc.toFixed(1),"1/s"],
  ["Confined-flame correction √σ_ρ (H₂>30%)",+_confine_corr.toFixed(2),"—"],
  ["g_c_eff = g_c · √σ_ρ",+_g_c_eff_x.toFixed(1),"1/s"],
  ["g_actual (Poiseuille × turb)",+_g_u_actual_x.toFixed(1),"1/s"],
  ["Flashback Karlovitz Ka_fb",isFinite(_Ka_fb_x)?+_Ka_fb_x.toFixed(2):"N/A","—"],
  ["margin = g_actual / g_c_eff",+_gateA_marg.toFixed(2),"×"],
  // Shaffer Eq. 4 OOR guard: flag when T_tip < T_air (extrapolated outside H₂-blend cal window)
  ["Shaffer 2013 burner-tip T (Eq. 4)",
    (_shaffer_T_tip < (T_air ?? T0) || (_CH4_pct_x > 50 && _H2_pct_x < 10))
      ? "OOR (low-H₂ fuel — Eq. 4 calibration window violated)"
      : +uv(u,"T",_shaffer_T_tip).toFixed(0),
    uu(u,"T")],
  ["Gate A Status",_gateA_pass?"PASS":"FAIL","—"],
  ["─── Gate B: CIVB (Sattelmayer 2004) ───","",""],
  ["Π_CIVB = S_L / (S_n·V_premix·π)",+_piCIVB_x.toFixed(4),"—"],
  ["CIVB threshold",+_civb_thr_x.toFixed(3),"—"],
  ["Swirl number S_n (default)",+_Sn_x.toFixed(2),"—"],
  ["Gate B Status",_gateB_pass?"PASS":"FAIL","—"],
  ["─── Gate C: Core Flashback (S_T vs V_premix) ───","",""],
  ["Turbulent flame speed S_T (Bradley, V_premix-based u')",+uv(u,"vel",_ST_premix_x).toFixed(2),uu(u,"vel")],
  ["  ↳ Legacy turb-factor estimator (SL × 1.8, for context)",+uv(u,"vel",_ST_est_x_legacy).toFixed(2),uu(u,"vel")],
  ["margin V_premix / S_T",+_v_st_marg.toFixed(2),"—"],
  ["Gate C Status",_gateC_pass?"PASS":"FAIL","—"],
  ["─── Gate D: Autoignition (RTD-corrected) ───","",""],
  ["τ_ign autoignition delay",+(_tauIgn*1000).toFixed(4),"ms"],
  ["τ_res,99 RTD-corrected residence",+(_tau_res_99*1000).toFixed(4),"ms"],
  ["Ignition margin τ_ign / τ_res,99 (need ≥ 3)",isFinite(_ign_marg_3)?+_ign_marg_3.toFixed(2):"N/A","—"],
  ["Gate D Status",_gateD_pass?"PASS":"FAIL","—"],
  ["─── Card 3 Combined ───","",""],
  ["Card 3 Overall Status",_card3_status,"—"],
  ["Note","Card 1/2/3 outputs above use panel default geometry (D_h=40 mm, V_pz=0.025 m³, S_n=0.6, swirl-type, ε_turb=0.7, RTD=1.5, K_LBO=6.29 — premixed-gas calibration). Customise these in the live panel and re-export for site-specific values.",""],
  [],
  ["═══ S_L vs Equivalence Ratio ═══"],
  [`Source: ${(_useCanteraFlame && flameCanteraSweeps && flameCanteraSweeps.phi && flameCanteraSweeps.phi.length)?"Cantera 1D FreeFlame sweep (run from the Flame Speed panel)":"Free-mode JS Gülder correlation"}`],
  ["Equivalence Ratio (φ)","Fuel/Air Ratio (mass)","T_mixed ("+uu(u,"T")+")","Flame Speed ("+uu(u,"SL")+")"],
  ...((_useCanteraFlame && flameCanteraSweeps && Array.isArray(flameCanteraSweeps.phi) && flameCanteraSweeps.phi.length>0)
    ? flameCanteraSweeps.phi.filter(pt=>pt && pt.converged!==false).map(pt=>{const p=+pt.x;const Tm=Number.isFinite(pt.T_mixed_inlet_K)&&pt.T_mixed_inlet_K>0?pt.T_mixed_inlet_K:mixT(fuel,ox,p,T_fuel??T0,T_air??T0);const SLcmps=(+pt.SL)*100;return[+p.toFixed(3),+(p/fp.AFR_mass).toFixed(6),+uv(u,"T",Tm).toFixed(1),+uv(u,"SL",SLcmps).toFixed(4)];})
    : Array.from({length:13},(_,i)=>{const p=0.4+i*0.05;const Tm=mixT(fuel,ox,p,T_fuel??T0,T_air??T0);return[+p.toFixed(2),+(p/fp.AFR_mass).toFixed(6),+uv(u,"T",Tm).toFixed(1),+uv(u,"SL",calcSL(fuel,p,Tm,P)*100).toFixed(4)]})),
  [],
  ["═══ S_L vs Pressure (@T_mixed) ═══"],
  [`Source: ${(_useCanteraFlame && flameCanteraSweeps && flameCanteraSweeps.P && flameCanteraSweeps.P.length)?"Cantera 1D FreeFlame sweep":"Free-mode JS Gülder correlation"}`],
  ["Pressure ("+uu(u,"P")+")","Flame Speed ("+uu(u,"SL")+")"],
  ...((_useCanteraFlame && flameCanteraSweeps && Array.isArray(flameCanteraSweeps.P) && flameCanteraSweeps.P.length>0)
    ? flameCanteraSweeps.P.filter(pt=>pt && pt.converged!==false).map(pt=>{const Pa_atm=(+pt.x)/1.01325;return[+uv(u,"P",Pa_atm).toFixed(2),+uv(u,"SL",(+pt.SL)*100).toFixed(4)];})
    : [0.5,1,2,5,10,20,40].map(p=>[+uv(u,"P",p).toFixed(2),+uv(u,"SL",calcSL(fuel,phi,T_mix_phi,p)*100).toFixed(4)])),
  [],
  ["═══ S_L vs Unburned Temperature (user sweep) ═══"],
  [`Source: ${(_useCanteraFlame && flameCanteraSweeps && flameCanteraSweeps.T && flameCanteraSweeps.T.length)?"Cantera 1D FreeFlame sweep":"Free-mode JS Gülder correlation"}`],
  ["Temperature ("+uu(u,"T")+")","Flame Speed ("+uu(u,"SL")+")"],
  ...((_useCanteraFlame && flameCanteraSweeps && Array.isArray(flameCanteraSweeps.T) && flameCanteraSweeps.T.length>0)
    ? flameCanteraSweeps.T.filter(pt=>pt && pt.converged!==false).map(pt=>[+uv(u,"T",+pt.x).toFixed(1),+uv(u,"SL",(+pt.SL)*100).toFixed(4)])
    : Array.from({length:23},(_,i)=>{const t=250+i*25;return[+uv(u,"T",t).toFixed(1),+uv(u,"SL",calcSL(fuel,phi,t,P)*100).toFixed(4)]})),
  [],
  ["═══ Damköhler vs Velocity ═══"],
  ["Velocity ("+uu(u,"vel")+")","Damköhler (Da)","Status"],
  ...Array.from({length:40},(_,i)=>{const v=1+i*5;const b=calcBlowoff(fuel,phi,T_mix_phi,P,v,Lchar);return[+uv(u,"vel",v).toFixed(1),+b.Da.toFixed(4),b.stable?"Stable":"Blowoff"]}),
];
const ws2=XLSX.utils.aoa_to_sheet(s2);ws2["!cols"]=[{wch:48},{wch:22},{wch:14}];if(_showCombustion)XLSX.utils.book_append_sheet(wb,ws2,"Flame Speed & Blowoff");
const net=calcCombustorNetwork(fuel,ox,phi,T0,P,tau_psr,L_pfr,V_pfr,T_fuel,T_air);
// Canonical equilibrium AFT (same calc as Flame Temp sheet). Distinct from net.T_ad, which in this reduced-order model is the PFR exit T.
const combAFT=calcAFT_EQ(fuel,ox,phi,mixT(fuel,ox,phi,T_fuel??T0,T_air??T0),P);
const s3=[["═══ COMBUSTOR NETWORK — INPUTS ═══"],[],["Parameter","Value","Unit"],["Equivalence Ratio (φ)",+phi.toFixed(4),"—"],["Fuel/Air Ratio (mass)",+(phi/fp.AFR_mass).toFixed(6),uu(u,"afr_mass")],["Inlet Temperature (sidebar)",+uv(u,"T",T0).toFixed(2),uu(u,"T")],["Fuel Inlet Temperature (T_fuel)",+uv(u,"T",T_fuel??T0).toFixed(2),uu(u,"T")],["Air Inlet Temperature (T_air)",+uv(u,"T",T_air??T0).toFixed(2),uu(u,"T")],["Adiabatic Mixed Inlet T (T_mixed)",+uv(u,"T",net.T_mixed_inlet_K??T0).toFixed(2),uu(u,"T")],["Pressure",+uv(u,"P",P).toFixed(3),uu(u,"P")],["Water/Fuel Mass Ratio (WFR)",+(+WFR).toFixed(3),"kg_water/kg_fuel"],["Water Injection Mode",WFR>0?(waterMode==="steam"?"Steam (gas phase @ T_air)":"Liquid (absorbs h_fg)"):"off","—"],["PSR Residence Time (τ_PSR)",+tau_psr,"ms"],["PFR Length (L_PFR)",+uv(u,"len",L_pfr).toFixed(3),uu(u,"len")],["PFR Velocity (V_PFR)",+uv(u,"vel",V_pfr).toFixed(2),uu(u,"vel")],[],["═══ PSR SOLVER OPTIONS ═══"],["Parameter","Value","Unit"],["PSR Seed (warm-start)",_PSR_SEED_LBL[psrSeed]||psrSeed,"—"],["Equilibrium Constraint",(psrSeed==="unreacted"?"n/a (unreacted seed)":_EQ_LBL[eqConstraint]||eqConstraint),"—"],["Integration Strategy",_INT_LBL[integration]||integration,"—"],["Heat-Loss Fraction",+(+heatLossFrac).toFixed(3),"—"],["Heat-Loss Description",heatLossFrac>0?`T_psr held at T_ad − ${(heatLossFrac*100).toFixed(0)}%·(T_ad − T_inlet)`:"adiabatic (T_psr = T_ad)","—"],["Kinetic Mechanism",_MECH_LBL[mechanism]||mechanism,"—"],[],["═══ COMPUTATION MODE ═══"],["Mode",accurate?"ACCURATE (server-side Cantera backend)":"SIMPLE (in-browser reduced-order JS model)","—"],["Note",accurate?"PSR solver options above are honored by the Cantera backend when the app is running in Accurate mode. Tabular values and sweeps BELOW in this sheet are from the reduced-order JS model (GRI-Mech 3.0-calibrated correlations) for export consistency. To see accurate numbers for the current operating point, view the app UI in Accurate mode.":"PSR solver options and kinetic mechanism above are only used by the Accurate (Cantera) backend. In Simple mode, the tabular values below are from the reduced-order JS model (GRI-Mech 3.0-calibrated correlations) and do not vary with those options.","—"],[],["═══ OUTPUTS ═══"],[],["Parameter","Value","Unit"],["Adiabatic Flame Temperature",+uv(u,"T",combAFT.T_ad).toFixed(1),uu(u,"T")],["Combustor Exit Temperature",+uv(u,"T",net.T_ad).toFixed(1),uu(u,"T")],["PSR Exit Temperature",+uv(u,"T",net.T_psr).toFixed(1),uu(u,"T")],["PSR Conversion",+net.conv_psr.toFixed(2),"%"],["NOx at PSR Exit",+(net.NO_ppm_psr??0).toFixed(3),"ppmvd"],["NOx at Combustor Exit",+net.NO_ppm_exit.toFixed(3),"ppm"],["NOx @ 15% O₂",+net.NO_ppm_15O2.toFixed(3),"ppmvd"],["CO at Exit",+net.CO_ppm_exit.toFixed(2),"ppm"],["Exhaust O₂ (dry)",+net.O2_pct.toFixed(2),"%"],["τ_PFR",+net.tau_pfr_ms.toFixed(3),"ms"],["τ_total (PSR+PFR)",+net.tau_total_ms.toFixed(3),"ms"],[],["═══ PFR PROFILE ═══"],["Position ("+uu(u,"lenSmall")+")","Temperature ("+uu(u,"T")+")","NOx (ppm)","CO (ppm)","Conversion (%)"],...net.pfr.map(pt=>[+uv(u,"lenSmall",pt.x).toFixed(2),+uv(u,"T",pt.T).toFixed(1),+pt.NO_ppm,+pt.CO_ppm,+pt.conv]),[],["═══ EMISSIONS vs Equivalence Ratio ═══"],["Equivalence Ratio (φ)","Fuel/Air Ratio (mass)","NOx @ 15% O₂ (ppm)","CO (ppm)"],...Array.from({length:13},(_,i)=>{const p=0.4+i*0.05;const n=calcCombustorNetwork(fuel,ox,p,T0,P,tau_psr,L_pfr,V_pfr,T_fuel,T_air);return[+p.toFixed(2),+(p/fp.AFR_mass).toFixed(6),+n.NO_ppm_15O2.toFixed(3),+n.CO_ppm_exit.toFixed(2)]})];const ws3=XLSX.utils.aoa_to_sheet(s3);ws3["!cols"]=[{wch:32},{wch:20},{wch:16},{wch:14},{wch:14}];if(_showCombustion)XLSX.utils.book_append_sheet(wb,ws3,"Combustor Network");
// Exhaust inversion: two-pass (mix T using initial phi=0.6 guess, then refine with solved phi)
const _exO2_p0=calcExhaustFromO2(fuel,ox,measO2,mixT(fuel,ox,0.6,T_fuel??T0,T_air??T0),P,combMode);
const rO2=calcExhaustFromO2(fuel,ox,measO2,mixT(fuel,ox,_exO2_p0.phi,T_fuel??T0,T_air??T0),P,combMode);
const _exCO2_p0=calcExhaustFromCO2(fuel,ox,measCO2,mixT(fuel,ox,0.6,T_fuel??T0,T_air??T0),P,combMode);
const rCO2=calcExhaustFromCO2(fuel,ox,measCO2,mixT(fuel,ox,_exCO2_p0.phi,T_fuel??T0,T_air??T0),P,combMode);
const T_mix_O2=mixT(fuel,ox,rO2.phi,T_fuel??T0,T_air??T0);
const T_mix_CO2=mixT(fuel,ox,rCO2.phi,T_fuel??T0,T_air??T0);
// ── Slip correction (mirrors ExhaustPanel.computeSlipCorrection) ────────
// Same energy-loss formula:
//   η_c = 1 − (N_dry/fuel) · (X_CO·LHV_CO + X_UHC·LHV_CH₄ + X_H₂·LHV_H₂) / LHV_fuel,molar
// LHV constants (NIST, kJ/mol, water-vapor product). Slip-corrected:
//   φ_fed = φ_burn / η_c    (metered air-fuel ratio rises)
//   T_eff = equilibrium at φ_eff = φ_burn · η_c (drops with slip)
const _LHV_CO_kJmol=282.99,_LHV_CH4_kJmol=802.31,_LHV_H2_kJmol=241.83;
const _nC_fuel=(()=>{let n=0;const t=Object.values(fuel).reduce((a,b)=>a+b,0)||1;for(const[sp,x]of Object.entries(fuel))n+=(x/t)*((SP[sp]?.C)||0);return n;})();
const _LHV_fuel_kJmol=(fp.LHV_mass||0)*(fp.MW_fuel||0);
const _slipFor=(r)=>{
  if(!r)return{eta_c:1,phi_fed:NaN,FAR_fed:NaN,AFR_fed:NaN,slipActive:false};
  const co=Math.max(0,+measCO||0),uhc=Math.max(0,+measUHC||0),h2=Math.max(0,+measH2||0);
  if((co===0&&uhc===0&&h2===0)||!_nC_fuel||!_LHV_fuel_kJmol)return{eta_c:1,phi_fed:r.phi,FAR_fed:r.FAR_mass,AFR_fed:r.AFR_mass,slipActive:false};
  const products=r.products||{};let X_C=0;
  for(const[sp,pct]of Object.entries(products)){const C=(SP[sp]?.C)||0;if(C>0)X_C+=(pct/100)*C;}
  if(X_C<=0)return{eta_c:1,phi_fed:r.phi,FAR_fed:r.FAR_mass,AFR_fed:r.AFR_mass,slipActive:false};
  const N_total=_nC_fuel/X_C,X_H2O=(products.H2O||0)/100,N_dry=N_total*(1-X_H2O);
  const E_loss=N_dry*1e-6*(co*_LHV_CO_kJmol+uhc*_LHV_CH4_kJmol+h2*_LHV_H2_kJmol);
  const eta_c=Math.max(0.01,Math.min(1,1-E_loss/_LHV_fuel_kJmol));
  return{eta_c,phi_fed:r.phi/eta_c,FAR_fed:r.FAR_mass/eta_c,AFR_fed:r.AFR_mass*eta_c,slipActive:true};
};
const _slipO2=_slipFor(rO2),_slipCO2=_slipFor(rCO2);
const _phi_eff_O2=(rO2&&Number.isFinite(rO2.phi))?rO2.phi*(_slipO2.eta_c||1):NaN;
const _phi_eff_CO2=(rCO2&&Number.isFinite(rCO2.phi))?rCO2.phi*(_slipCO2.eta_c||1):NaN;
const _T_mix_eff_O2=Number.isFinite(_phi_eff_O2)?mixT(fuel,ox,_phi_eff_O2,T_fuel??T0,T_air??T0):NaN;
const _T_mix_eff_CO2=Number.isFinite(_phi_eff_CO2)?mixT(fuel,ox,_phi_eff_CO2,T_fuel??T0,T_air??T0):NaN;
const _T_ad_eff_O2=(_slipO2.slipActive&&Number.isFinite(_phi_eff_O2))?(calcAFT_EQ(fuel,ox,_phi_eff_O2,_T_mix_eff_O2,P)?.T_ad??rO2?.T_ad):rO2?.T_ad;
const _T_ad_eff_CO2=(_slipCO2.slipActive&&Number.isFinite(_phi_eff_CO2))?(calcAFT_EQ(fuel,ox,_phi_eff_CO2,_T_mix_eff_CO2,P)?.T_ad??rCO2?.T_ad):rCO2?.T_ad;
// ── Fuel & Money (anchored on O₂ path, matching the panel) ──
// Air flow uses FAR_burn ALWAYS (compressor air flow is set by aero;
// slip is downstream chemistry — does not move ṁ_air).
const _FAR_for_air=rO2?.FAR_mass||NaN;
const _eta_money=_slipO2.slipActive?_slipO2.eta_c:1;
const _airFlowKgs=(Number.isFinite(fuelFlowKgs)&&Number.isFinite(_FAR_for_air)&&_FAR_for_air>0)?fuelFlowKgs/_FAR_for_air:NaN;
const _heatInputMW=(Number.isFinite(fuelFlowKgs)&&fp.LHV_mass>0)?fuelFlowKgs*fp.LHV_mass:NaN;
const _heatInputMMBtuHr=Number.isFinite(_heatInputMW)?_heatInputMW*3.41214:NaN;
const _hoursPerPeriod=costPeriod==="year"?8760:costPeriod==="month"?730:168;
const _totalCostPerHr=(Number.isFinite(_heatInputMMBtuHr)&&fuelCostUsdPerMmbtuLhv>0)?_heatInputMMBtuHr*fuelCostUsdPerMmbtuLhv:NaN;
const _totalCostPerPeriod=Number.isFinite(_totalCostPerHr)?_totalCostPerHr*_hoursPerPeriod:NaN;
const _penaltyCostPerPeriod=Number.isFinite(_totalCostPerPeriod)?_totalCostPerPeriod*(1-_eta_money):NaN;
const _flowFmt=(kgs)=>Number.isFinite(kgs)?(u==="SI"?+kgs.toFixed(4):+(kgs*7936.64).toFixed(2)):"n/a";
const _flowUnit=(u==="SI")?"kg/s":"lb/hr";
const _heatFmt=(mw)=>Number.isFinite(mw)?(u==="SI"?+mw.toFixed(3):+(mw*3.41214).toFixed(3)):"n/a";
const _heatUnit=(u==="SI")?"MW":"MMBTU/hr";
const _slipFuelRows=[
  [],["═══ SLIP MEASUREMENTS (entered) ═══"],
  ["Parameter","Value","Unit"],
  ["Measured CO (dry)",+(+measCO).toFixed(2),linkExhaustCO?"ppmvd · LINKED to Mapping CO15":"ppmvd · MANUAL"],
  ["Measured UHC as CH₄ (dry)",+(+measUHC).toFixed(2),linkExhaustUHC?"ppmvd · LINKED to Mapping CO15 (÷3)":"ppmvd · MANUAL"],
  ["Measured H₂ (dry)",+(+measH2).toFixed(2),"ppmvd"],[],
  ["═══ SLIP-CORRECTED CHEMICAL EQUILIBRIUM (FROM O₂) ═══"],
  ["Parameter","Value","Unit"],
  ["η_c (combustion efficiency, energy-loss formula)",+((_slipO2.eta_c||0)*100).toFixed(3),"%"],
  ["φ_fed (= φ_burn / η_c, metered)",Number.isFinite(_slipO2.phi_fed)?+_slipO2.phi_fed.toFixed(5):"n/a","—"],
  ["FAR_fed (mass)",Number.isFinite(_slipO2.FAR_fed)?+_slipO2.FAR_fed.toFixed(6):"n/a",uu(u,"afr_mass")],
  ["AFR_fed (mass)",Number.isFinite(_slipO2.AFR_fed)?+_slipO2.AFR_fed.toFixed(3):"n/a",uu(u,"afr_mass")],
  ["T_ad,eff (= equilibrium at φ_burn · η_c)",Number.isFinite(_T_ad_eff_O2)?+uv(u,"T",_T_ad_eff_O2).toFixed(1):"n/a",uu(u,"T")],[],
  ["═══ SLIP-CORRECTED CHEMICAL EQUILIBRIUM (FROM CO₂) ═══"],
  ["Parameter","Value","Unit"],
  ["η_c (combustion efficiency, energy-loss formula)",+((_slipCO2.eta_c||0)*100).toFixed(3),"%"],
  ["φ_fed (= φ_burn / η_c, metered)",Number.isFinite(_slipCO2.phi_fed)?+_slipCO2.phi_fed.toFixed(5):"n/a","—"],
  ["FAR_fed (mass)",Number.isFinite(_slipCO2.FAR_fed)?+_slipCO2.FAR_fed.toFixed(6):"n/a",uu(u,"afr_mass")],
  ["AFR_fed (mass)",Number.isFinite(_slipCO2.AFR_fed)?+_slipCO2.AFR_fed.toFixed(3):"n/a",uu(u,"afr_mass")],
  ["T_ad,eff (= equilibrium at φ_burn · η_c)",Number.isFinite(_T_ad_eff_CO2)?+uv(u,"T",_T_ad_eff_CO2).toFixed(1):"n/a",uu(u,"T")],[],
  ["═══ FUEL & MONEY (anchored on O₂ path) ═══"],
  ["Parameter","Value","Unit"],
  ["Fuel Flow (m_fuel)",_flowFmt(fuelFlowKgs),_flowUnit],
  ["Fuel Cost",+(+fuelCostUsdPerMmbtuLhv).toFixed(3),"USD/MMBTU (LHV)"],
  ["Period",costPeriod,"—"],
  ["Air Mass Flow (m_air = m_fuel / FAR_burn — slip-independent)",_flowFmt(_airFlowKgs),_flowUnit],
  ["Heat Input (LHV)",_heatFmt(_heatInputMW),_heatUnit],
  ["Total Fuel Cost (per "+costPeriod+")",Number.isFinite(_totalCostPerPeriod)?+(_totalCostPerPeriod).toFixed(0):"n/a","USD"],
  ["Penalty (= Total · (1 − η_c), money lost to slip per "+costPeriod+")",Number.isFinite(_penaltyCostPerPeriod)?+(_penaltyCostPerPeriod).toFixed(0):"n/a","USD"],
  ["Linkage to Cycle ṁ_fuel",linkFuelFlow?"ON (Cycle drives Fuel Flow)":"OFF","—"],
  ["Linkage CO ← Mapping CO15",linkExhaustCO?"ON (Mapping CO15 → CO at actual O₂ via Phi_Exhaust)":"OFF","—"],
  ["Linkage UHC ← Mapping CO15",linkExhaustUHC?"ON (UHC = CO_linked / 3)":"OFF","—"],
];
// Phi_Exhaust + linked-CO traceability rows. Only meaningful when the
// Mapping correlation has run (gts/advanced) AND the cycle reports
// air & fuel flow. Computed identically to ExhaustPanel's runtime
// linkage so the Excel record matches what the user sees on screen.
const _mappingCO15_xl=mapResult?.correlations?.CO15;
const _mdotFuelCyc_xl=cycleResult?.mdot_fuel_kg_s;
const _mdotAirCyc_xl =cycleResult?.mdot_air_post_bleed_kg_s;
const _FAR_stoich_xl =1/((fp.AFR_mass)||1e-12);
const _phiExhaust_xl =(Number.isFinite(_mdotFuelCyc_xl)&&Number.isFinite(_mdotAirCyc_xl)&&_mdotAirCyc_xl>0)
  ? (_mdotFuelCyc_xl/_mdotAirCyc_xl)/_FAR_stoich_xl : NaN;
let _o2DryAtPhiExh_xl=NaN, _coLinked_xl=NaN, _uhcLinked_xl=NaN;
if(Number.isFinite(_phiExhaust_xl)&&_phiExhaust_xl>0&&_phiExhaust_xl<1){
  const _Tmix_xl=mixT(fuel,ox,_phiExhaust_xl,T_fuel??T0,T_air??T0);
  const _r_xl=calcAFT(fuel,ox,_phiExhaust_xl,_Tmix_xl);
  const _o2w=_r_xl.products?.O2||0, _h2ow=_r_xl.products?.H2O||0;
  const _denom=1-_h2ow/100;
  if(_denom>0)_o2DryAtPhiExh_xl=_o2w/_denom;
  if(Number.isFinite(_mappingCO15_xl)&&_mappingCO15_xl>0&&Number.isFinite(_o2DryAtPhiExh_xl)&&_o2DryAtPhiExh_xl<20.9){
    _coLinked_xl=_mappingCO15_xl*(20.9-_o2DryAtPhiExh_xl)/5.9;
    _uhcLinked_xl=_coLinked_xl/3;
  }
}
_slipFuelRows.push(
  [],
  ["═══ EXHAUST LINKAGE TRACEABILITY (Phi_Exhaust → linked CO/UHC) ═══"],
  ["Parameter","Value","Unit"],
  ["Mapping CO15 (correlation output)",Number.isFinite(_mappingCO15_xl)?+_mappingCO15_xl.toFixed(2):"n/a","ppmvd @ 15% O₂"],
  ["ṁ_fuel (Cycle)",_flowFmt(_mdotFuelCyc_xl),_flowUnit],
  ["ṁ_air post-bleed (Cycle)",_flowFmt(_mdotAirCyc_xl),_flowUnit],
  ["FAR_stoich (panel fuel/oxidizer)",Number.isFinite(_FAR_stoich_xl)?+_FAR_stoich_xl.toFixed(5):"n/a","—"],
  ["Phi_Exhaust = (ṁ_fuel/ṁ_air) / FAR_stoich",Number.isFinite(_phiExhaust_xl)?+_phiExhaust_xl.toFixed(4):"n/a","—"],
  ["O₂_dry @ Phi_Exhaust (complete combustion)",Number.isFinite(_o2DryAtPhiExh_xl)?+_o2DryAtPhiExh_xl.toFixed(3):"n/a","% dry"],
  ["CO_linked = CO15 × (20.9 − O₂_dry%) / 5.9",Number.isFinite(_coLinked_xl)?+_coLinked_xl.toFixed(2):"n/a","ppmvd @ actual O₂"],
  ["UHC_linked = CO_linked / 3",Number.isFinite(_uhcLinked_xl)?+_uhcLinked_xl.toFixed(2):"n/a","ppmvd @ actual O₂"],
);
const s5=[["═══ EXHAUST ANALYSIS — INPUTS ═══"],[],["Parameter","Value","Unit"],["Measured O₂ (dry)",+measO2.toFixed(2),"%"],["Measured CO₂ (dry)",+measCO2.toFixed(2),"%"],["Air Inlet Temperature (T_air)",+uv(u,"T",T_air??T0).toFixed(2),uu(u,"T")],["Fuel Inlet Temperature (T_fuel)",+uv(u,"T",T_fuel??T0).toFixed(2),uu(u,"T")],["T_mixed @ φ(O₂ case)",+uv(u,"T",T_mix_O2).toFixed(2),uu(u,"T")],["T_mixed @ φ(CO₂ case)",+uv(u,"T",T_mix_CO2).toFixed(2),uu(u,"T")],["Water/Fuel Mass Ratio (WFR)",+(+WFR).toFixed(3),"kg_water/kg_fuel"],["Water Injection Mode",WFR>0?(waterMode==="steam"?"Steam (gas phase @ T_air)":"Liquid (absorbs h_fg)"):"off","—"],[],["═══ FROM MEASURED O₂ ═══"],[],["Parameter","Value","Unit"],["Equivalence Ratio (φ)",+rO2.phi.toFixed(5),"—"],["Adiabatic Flame Temperature",+uv(u,"T",rO2.T_ad).toFixed(1),uu(u,"T")],["Fuel/Air Ratio (mass)",+rO2.FAR_mass.toFixed(6),uu(u,"afr_mass")],["Air/Fuel Ratio (mass)",+(1/(rO2.FAR_mass+1e-20)).toFixed(3),uu(u,"afr_mass")],[],["Species (wet basis)","Mole %"],...Object.entries(rO2.products||{}).filter(([_,v])=>v>0.01).sort((a,b)=>b[1]-a[1]).map(([sp,v])=>[fmt(sp),+v.toFixed(4)]),[],["Species (dry basis)","Mole %"],...Object.entries(dryBasis(rO2.products||{})).filter(([_,v])=>v>0.01).sort((a,b)=>b[1]-a[1]).map(([sp,v])=>[fmt(sp),+v.toFixed(4)]),[],["═══ FROM MEASURED CO₂ ═══"],[],["Parameter","Value","Unit"],["Equivalence Ratio (φ)",+rCO2.phi.toFixed(5),"—"],["Adiabatic Flame Temperature",+uv(u,"T",rCO2.T_ad).toFixed(1),uu(u,"T")],["Fuel/Air Ratio (mass)",+rCO2.FAR_mass.toFixed(6),uu(u,"afr_mass")],["Air/Fuel Ratio (mass)",+(1/(rCO2.FAR_mass+1e-20)).toFixed(3),uu(u,"afr_mass")],[],["Species (wet basis)","Mole %"],...Object.entries(rCO2.products||{}).filter(([_,v])=>v>0.01).sort((a,b)=>b[1]-a[1]).map(([sp,v])=>[fmt(sp),+v.toFixed(4)]),[],["Species (dry basis)","Mole %"],...Object.entries(dryBasis(rCO2.products||{})).filter(([_,v])=>v>0.01).sort((a,b)=>b[1]-a[1]).map(([sp,v])=>[fmt(sp),+v.toFixed(4)]),[],["═══ Adiabatic Temperature vs Exhaust O₂ ═══"],["Exhaust O₂ (%)","Flame Temperature ("+uu(u,"T")+")","Equivalence Ratio (φ)","Fuel/Air Ratio (mass)"],...Array.from({length:30},(_,i)=>{const o2=0.5+i*0.5;const r0=calcExhaustFromO2(fuel,ox,o2,mixT(fuel,ox,0.6,T_fuel??T0,T_air??T0),P,combMode);const r=calcExhaustFromO2(fuel,ox,o2,mixT(fuel,ox,r0.phi,T_fuel??T0,T_air??T0),P,combMode);return[+o2.toFixed(1),+uv(u,"T",r.T_ad).toFixed(1),+r.phi.toFixed(4),+r.FAR_mass.toFixed(6)]})];s5.push(..._slipFuelRows);const ws5=XLSX.utils.aoa_to_sheet(s5);ws5["!cols"]=[{wch:38},{wch:20},{wch:16},{wch:16}];if(_showCombustion)XLSX.utils.book_append_sheet(wb,ws5,"Exhaust Analysis");
const s4=[["═══ THERMO DATABASE ═══"],["NASA 7-coefficient polynomials"],[]];for(const sp of["CH4","C2H6","C3H8","H2","CO","O2","N2","H2O","CO2","OH","NO","Ar"]){if(!SP[sp])continue;s4.push([SP[sp].nm+" ("+fmt(sp)+")","Molecular Weight: "+SP[sp].MW,"ΔHf: "+(SP[sp].Hf/1000).toFixed(2)+" kJ/mol"]);s4.push(["Temperature (K)","Heat Capacity Cp (J/mol·K)","Enthalpy H (kJ/mol)","Entropy S (J/mol·K)","Gibbs Energy G (kJ/mol)"]);for(let T=200;T<=3000;T+=100){const H=h_mol(sp,T)/1000;const Sv=sR(sp,T)*R_u;s4.push([T,+cp_mol(sp,T).toFixed(4),+H.toFixed(4),+Sv.toFixed(4),+((H*1000-T*Sv)/1000).toFixed(4)]);}s4.push([]);}const ws4=XLSX.utils.aoa_to_sheet(s4);ws4["!cols"]=[{wch:28},{wch:18},{wch:18},{wch:18},{wch:18}];if(_showCombustion)XLSX.utils.book_append_sheet(wb,ws4,"Thermo Database");
// ══════════════════ CYCLE (Gas Turbine) — Option A + B ══════════════════
// Only written if we have a cycle result in hand AND the active mode
// includes the Cycle panel (gts / advanced). The cycle backend is
// Cantera-only, so offline / Simple mode has no numbers to export.
if(cycleResult && _showCycle){
  const cr=cycleResult;
  const ff=cr.fuel_flexibility||{};
  const fmtN=(v,d=3)=>(Number.isFinite(v)?(+v).toFixed(d):"n/a");
  const sC=[
    ["═══ GAS TURBINE CYCLE — INPUTS ═══"],[],
    ["Parameter","Value","Unit"],
    ["Engine",cycleEngine||"—","—"],
    ["Ambient Pressure",fmtN(cyclePamb,3),"bar"],
    ["Ambient Temperature",fmtN(uv(u,"T",cycleTamb),2),uu(u,"T")],
    ["Relative Humidity",fmtN(cycleRH,1),"%"],
    ["Load",fmtN(cycleLoad,1),"%"],
    ["Intercooler Coolant T (LMS100 only)",cycleEngine==="LMS100PB+"?fmtN(uv(u,"T",cycleTcool),2):"n/a",uu(u,"T")],
    ["Combustor Air Fraction (flame/total)",fmtN(cycleAirFrac,3),"—"],
    ["Fuel Temp",fmtN(uv(u,"T",cr.T_fuel_K??cycleTamb),2),uu(u,"T")],
    ["Water/Fuel Mass Ratio (WFR)",fmtN(cr.WFR??WFR,3),"kg_water/kg_fuel"],
    ["Water Injection Mode",(cr.WFR??WFR)>0?((cr.water_mode||waterMode)==="steam"?"Steam":"Liquid (absorbs h_fg)"):"off","—"],
    ["Water Inlet Temperature",(cr.WFR??WFR)>0?fmtN(uv(u,"T",cr.T_water_K??T_water),1):"n/a",uu(u,"T")],
    ["Compressor Bleed Mode",bleedMode==="auto"?"AUTO (vs Load schedule)":"MANUAL","—"],
    ["Compressor Bleed Valve Size",fmtN(bleedValveSizePct,2),"% of compressor air"],
    ["Compressor Bleed Open",fmtN(bleedOpenPct,1),"% (0=closed, 100=full)"],
    ["Compressor Bleed Effective Fraction",fmtN(100*(cr.bleed_air_frac??bleedAirFrac),3),"% of compressor air dumped"],
    [],
    ["═══ STATION STATES ═══"],[],
    ["Station","Temperature ("+uu(u,"T")+")","Pressure (bar)","Mass Flow (kg/s)"],
    ["1 — Ambient / LPC inlet",fmtN(uv(u,"T",cr.T1_K),1),fmtN(cr.P1_bar,3),fmtN(cr.mdot_air_kg_s,2)],
    ["2 — LPC exit / IC inlet",fmtN(uv(u,"T",cr.T2_K),1),fmtN(cr.P2_bar,3),fmtN(cr.mdot_air_kg_s,2)],
    ["2c — IC exit / HPC inlet",fmtN(uv(u,"T",cr.T2c_K),1),fmtN(cr.P2c_bar,3),fmtN(cr.mdot_air_kg_s,2)],
    ["3 — Compressor exit / combustor inlet",fmtN(uv(u,"T",cr.T3_K),1),fmtN(cr.P3_bar,3),fmtN(cr.mdot_air_kg_s,2)],
    ["4 — Combustor exit (after dilution)",fmtN(uv(u,"T",cr.T4_K),1),fmtN(cr.P4_bar,3),fmtN((cr.mdot_air_kg_s||0)+(cr.mdot_fuel_kg_s||0),2)],
    ["Bulk (flame-zone)",fmtN(uv(u,"T",cr.T_Bulk_K),1),fmtN(cr.P3_bar,3),"—"],
    ["5 — Turbine exit (actual)",fmtN(uv(u,"T",cr.T5_K),1),fmtN(cr.P_exhaust_bar,3),"—"],
    ["5s — Turbine exit (isentropic)",fmtN(uv(u,"T",cr.T5_isen_K),1),fmtN(cr.P_exhaust_bar,3),"—"],
    [],
    ["═══ FUEL / FAR ═══"],[],
    ["Parameter","Value","Unit"],
    ["φ₄ (combustor-exit equivalence ratio)",fmtN(cr.phi4,4),"—"],
    ["FAR₄ (combustor-exit fuel/air)",fmtN(cr.FAR4,6),"—"],
    ["φ_Bulk (flame-zone equivalence ratio)",fmtN(cr.phi_Bulk,4),"—"],
    ["FAR_Bulk (flame-zone fuel/air)",fmtN(cr.FAR_Bulk,6),"—"],
    ["T_Bulk (flame-zone adiabatic T)",fmtN(uv(u,"T",cr.T_Bulk_K),1),uu(u,"T")],
    ["mdot_fuel",fmtN(cr.mdot_fuel_kg_s,4),"kg/s"],
    ["mdot_air (compressor inlet, total)",fmtN(cr.mdot_air_kg_s,3),"kg/s"],
    ["mdot_bleed (lost to ambient)",fmtN(cr.mdot_bleed_kg_s||0,4),"kg/s"],
    ["mdot_air_post_bleed (combustor + turbine path)",fmtN(cr.mdot_air_post_bleed_kg_s||cr.mdot_air_kg_s,3),"kg/s"],
    ["Bleed iterations (T4 power-hold)",fmtN(cr.bleed_iters||0,0),"—"],
    ["Bleed converged",cr.bleed_converged===false?"NO":(cr.bleed_air_frac>0?"YES":"n/a (no bleed)"),"—"],
    [],
    ["═══ OPTION A — ENERGY BALANCE ═══"],[],
    ["Parameter","Value","Unit"],
    ["W_turbine (Cantera isentropic expansion)",fmtN(cr.W_turbine_MW,3),"MW"],
    ["W_compressor (HPC + LPC)",fmtN(cr.W_compressor_MW,3),"MW"],
    ["W_parasitic (aux loads)",fmtN(cr.W_parasitic_MW,3),"MW"],
    ["MW_gross (turb − comp − parasitic)",fmtN(cr.MW_gross,3),"MW"],
    ["MW_cap (load × ambient × rated)",fmtN(cr.MW_cap,3),"MW"],
    ["MW_uncapped_before_derate",fmtN(cr.MW_uncapped_before_derate,3),"MW"],
    ["Fuel-flexibility derate factor",fmtN(cr.derate_factor,4),"—"],
    ["MW_net (final electrical output)",fmtN(cr.MW_net,3),"MW"],
    ["Heat rate (HHV)",fmtN(cr.HR_BTU_per_kWh,1),"BTU/kWh"],
    ["Thermal efficiency (LHV)",fmtN(100*(cr.eta_LHV||0),2),"%"],
    [],
    ["═══ COMPONENT EFFICIENCIES & DECK CONSTANTS ═══"],[],
    ["Parameter","Value","Unit"],
    ["η_isen_turb (calibrated per deck)",fmtN(cr.eta_isen_turb,4),"—"],
    ["η_isen_comp",fmtN(cr.eta_isen_comp,4),"—"],
    ["Combustor bypass fraction",fmtN(cr.combustor_bypass_frac,4),"—"],
    ["Combustor air fraction (flame/total)",fmtN(cycleAirFrac,3),"—"],
    ["P_exhaust",fmtN(cr.P_exhaust_bar,3),"bar"],
    [],
    ["═══ OPTION B — FUEL FLEXIBILITY (MWI) ═══"],[],
    ["Parameter","Value","Unit"],
    ["LHV_vol (at 60 °F)",fmtN(ff.lhv_vol_BTU_per_scf,1),"BTU/scf"],
    ["SG (fuel / air)",fmtN(ff.sg_air,4),"—"],
    ["Modified Wobbe Index (MWI)",fmtN(ff.mwi,2),"BTU/scf·√°R"],
    ["MWI Status",ff.mwi_status||"—","—"],
    ["MWI Derate",fmtN(ff.mwi_derate_pct,2),"%"],
    ["H₂ Fraction in Fuel",fmtN(ff.h2_frac_pct,2),"%"],
    [],
    ["═══ WARNINGS ═══"],
    ...(ff.warnings&&ff.warnings.length?ff.warnings.map(w=>[w]):[["(none)"]]),
  ];
  const wsC=XLSX.utils.aoa_to_sheet(sC);
  wsC["!cols"]=[{wch:44},{wch:20},{wch:22},{wch:18}];
  XLSX.utils.book_append_sheet(wb,wsC,"Cycle Results");
}

// ══════════════════ COMBUSTOR MAPPING (4-circuit DLE) ══════════════════
// Captures every mapping-panel input and the bkMap correlation result so
// the export reproduces what the user sees on the panel + Operations Summary.
// Gated on the active mode — only gts / advanced expose the Mapping panel.
if(_showMapping){
  const fmtN=(v,d=3)=>(Number.isFinite(v)?(+v).toFixed(d):"n/a");
  const mr=mapResult;
  const mc=mr?.circuits||{};
  const ma=mr?.air_accounting||{};
  const md=mr?.derived||{};
  const mFinal=mr?.correlations||{};
  const m100  =mr?.correlations_100pct_load||{};
  const mLin  =mr?.correlations_linear||{};
  const sMP=[
    ["═══ COMBUSTOR MAPPING — 4-CIRCUIT DLE (LMS100) ═══"],
    ["Correlation-based emissions and dynamics. No reactor-network kinetics."],[],
    ["═══ OPERATING MODE ═══"],
    ["Parameter","Value","Unit"],
    ["Emissions Mode","ON (DLE staging)" ,"—"],
    ["Emissions Mode toggle",emissionsMode?"ENABLED":"DISABLED","—"],
    [],
    ["═══ AIR-FLOW ALLOCATION INPUTS ═══"],
    ["Parameter","Value","Unit"],
    ["W36 / W3 (compressor → combustor)",fmtN(mapW36w3,4),"—"],
    ["Combustor air fraction (flame / W36)",fmtN(cycleAirFrac,4),"—"],
    ["Inner Pilot air %",fmtN(mapFracIP,2),"% of flame air"],
    ["Outer Pilot air %",fmtN(mapFracOP,2),"% of flame air"],
    ["Inner Main air %", fmtN(mapFracIM,2),"% of flame air"],
    ["Outer Main air %", fmtN(mapFracOM,2),"% of flame air"],
    [],
    ["═══ CIRCUIT EQUIVALENCE-RATIO INPUTS ═══"],
    ["Parameter","Value","Unit"],
    ["φ_IP (Inner Pilot)",fmtN(mapPhiIP,4),"—"],
    ["φ_OP (Outer Pilot)",fmtN(mapPhiOP,4),"—"],
    ["φ_IM (Inner Main)", fmtN(mapPhiIM,4),"—"],
    ["φ_OM (Outer Main, residual)",fmtN(mr?.phi_OM,4),"— (computed)"],
    [],
    ["═══ EMISSIONS TRANSFER FUNCTION (post-multipliers per BRNDMD) ═══"],
    ["BRNDMD","NOx mult","CO mult","PX36 mult"],
    ...[7,6,4,2].map(k=>{
      const e=emTfMults?.[k]||{};
      return [k,fmtN(e.NOx,3),fmtN(e.CO,3),fmtN(e.PX36,3)];
    }),
    [],
    ["═══ CIRCUIT RESULTS (mass flows, TFlame, fuel split) ═══"],
    ["Circuit","φ","TFlame ("+uu(u,"T")+")","m_air (kg/s)","m_fuel (kg/s)","Fuel_Split (%)"],
    ...["IP","OP","IM","OM"].map(k=>{
      const c=mc[k]||{};
      const _mFuelTot=["IP","OP","IM","OM"].reduce((s,kk)=>s+(mc[kk]?.m_fuel_kg_s||0),0);
      const _split=(_mFuelTot>0&&Number.isFinite(c.m_fuel_kg_s))?(c.m_fuel_kg_s/_mFuelTot*100):NaN;
      return [k,fmtN(c.phi,4),
        Number.isFinite(c.T_AFT_complete_K)?fmtN(uv(u,"T",c.T_AFT_complete_K),1):"n/a",
        fmtN(c.m_air_kg_s,4),fmtN(c.m_fuel_kg_s,5),fmtN(_split,2)];
    }),
    [],
    ["═══ AIR ACCOUNTING ═══"],
    ["Parameter","Value","Unit"],
    ["W3 (compressor air post-bleed)",fmtN(ma.W3_kg_s,3),"kg/s"],
    ["W36 (combustor inflow)",fmtN(ma.W36_kg_s,3),"kg/s"],
    ["Flame air (W36 × com_air_frac)",fmtN(ma.flame_air_kg_s,3),"kg/s"],
    ["Cooling air (W36 × (1 − com_air_frac))",fmtN(ma.cooling_air_kg_s,3),"kg/s"],
    ["Fuel residual (mass-balance check)",fmtN(mr?.fuel_residual_kg_s,6),"kg/s — should ≈ 0"],
    ["FAR_stoich",fmtN(mr?.FAR_stoich,5),"—"],
    [],
    ["═══ DERIVED CORRELATION INPUTS ═══"],
    ["Parameter","Value","Unit"],
    ["DT_Main = (T_AFT_OM − T_AFT_IM) × 1.8",fmtN(md.DT_Main_F,1),"°F (always F internally)"],
    ["Tflame (mass-flow weighted, all 4 circuits)",
      Number.isFinite(md.Tflame_K)?fmtN(uv(u,"T",md.Tflame_K),1):"n/a",uu(u,"T")],
    ["T3 (compressor exit)",
      Number.isFinite(cycleResult?.T3_K)?fmtN(uv(u,"T",cycleResult.T3_K),1):"n/a",uu(u,"T")],
    ["P3",fmtN(cycleResult?.P3_bar,3),"bar"],
    ["C3-effective fuel mole %",fmtN(md.C3_effective_pct,3),"%"],
    ["N₂ in fuel",fmtN(md.N2_pct,3),"%"],
    ["φ_OP multiplier (Step 2)",fmtN(md.phi_OP_mult,4),"—"],
    ["P3 ratio (P3 / 638 psia)",fmtN(md.pressure_ratio,4),"—"],
    [],
    ["═══ CORRELATION OUTPUTS — STAGE BY STAGE ═══"],
    ["Stage","NOx15 (ppmvd)","CO15 (ppmvd)","PX36_SEL (psi)","PX36_SEL_HI (psi)"],
    ["Linear (after Step 1)",     fmtN(mLin.NOx15,3),fmtN(mLin.CO15,2),fmtN(mLin.PX36_SEL,4),fmtN(mLin.PX36_SEL_HI,4)],
    ["After φ_OP mult (Step 2)",  fmtN(m100.NOx15,3),fmtN(m100.CO15,2),fmtN(m100.PX36_SEL,4),fmtN(m100.PX36_SEL_HI,4)],
    ["Final (after P3 scaling)",  fmtN(mFinal.NOx15,3),fmtN(mFinal.CO15,2),fmtN(mFinal.PX36_SEL,4),fmtN(mFinal.PX36_SEL_HI,4)],
    [],
    ["═══ REFERENCE DESIGN POINT (LMS100 DLE, 100% load, 44 °F) ═══"],
    ["Parameter","Value","Unit"],
    ["NOx15 ref",fmtN(mr?.reference?.values?.NOx15,2),"ppmvd"],
    ["CO15 ref", fmtN(mr?.reference?.values?.CO15,2),"ppmvd"],
    ["PX36_SEL ref",   fmtN(mr?.reference?.values?.PX36_SEL,3),"psi"],
    ["PX36_SEL_HI ref",fmtN(mr?.reference?.values?.PX36_SEL_HI,3),"psi"],
    ["DT_Main ref","450","°F"],["Phi_OP ref","0.65","—"],["C3 ref","7.5","%"],
    ["N₂ ref","0.5","%"],["Tflame ref","3035","°F"],["T3 ref","700","°F"],["P3 ref","638","psia"],
    [],
    // System Metrics summary mirrors the 5-row Category | Value table on
    // the Operating Snapshot card. PX36 / NOx15 / CO15 come from this
    // sheet's correlation outputs above; Penalty is computed from the
    // O₂-anchored slip path in the Exhaust block of the workbook (same
    // _penaltyCostPerPeriod calc — recomputed here so the value lands
    // on the same sheet as the metrics it joins).
    ["═══ SYSTEM METRICS (snapshot summary) ═══"],
    ["Category","Value","Unit"],
    ["Acoustics — PX36_SEL",    fmtN(mFinal.PX36_SEL,1),    "psi"],
    ["Acoustics — PX36_SEL_HI", fmtN(mFinal.PX36_SEL_HI,1), "psi"],
    ["Emissions — NOx@15",      fmtN(mFinal.NOx15,1),       "ppmvd"],
    ["Emissions — CO@15",       fmtN(mFinal.CO15,1),        "ppmvd"],
    [`Inefficiencies — Penalty / ${costPeriod}`,
      Number.isFinite(_penaltyCostPerPeriod)?+(_penaltyCostPerPeriod).toFixed(0):"n/a",
      "USD"],
  ];
  const wsMP=XLSX.utils.aoa_to_sheet(sMP);
  wsMP["!cols"]=[{wch:42},{wch:18},{wch:18},{wch:22},{wch:22}];
  XLSX.utils.book_append_sheet(wb,wsMP,"Combustor Mapping");
}

// ══════════════════ ASSUMPTIONS ══════════════════
// Mirrors the 12 groups from the in-app Assumptions panel. Keep these two
// in sync — if a number changes in cycle.py it must be updated both places.
const sA=[
  ["═══ MODELING ASSUMPTIONS ═══"],
  ["Every number below is baked into the cycle and combustion solvers."],
  ["Matches the in-app Assumptions tab. Not a design tool."],[],
  ["Group","Parameter","Value","Basis / Rationale"],

  ["1. Ambient & Inlet","Reference pressure","1.01325 bar","Sea-level ISA. P_amb input overrides for off-design."],
  ["","Reference temperature","LMS100 anchored at 44 °F / 80% RH","288.706 K (60 °F) is also used internally as the ISO reference. Additional engines are in development."],
  ["","Relative humidity","User input 0–100%","Default 60%. Enters via humid-air R and cp."],
  ["","Inlet pressure drop","0 bar","No filter / silencer loss."],
  ["","Inlet ram recovery","1.0","Stationary ground operation."],

  ["2. Humid Air","Dry-air mole fractions","N2 0.78084 / O2 0.20946 / Ar 0.00934","Standard atmospheric composition."],
  ["","H2O saturation","Antoine / Magnus","Humid-air x_H2O from RH and T_amb."],
  ["","Mixture thermodynamics","Cantera GRI-Mech 3.0","Same mechanism as combustion."],

  ["3. Compressor","Isentropic efficiency","0.88","Applied to LPC and HPC separately."],
  ["","Working fluid","Humid air","Real Cantera enthalpy — no ideal-gas shortcut."],
  ["","Bleed air","0%","No customer bleed / cooling-air extraction."],
  ["","Mechanical efficiency","1.00","Shaft/gearbox losses folded into deck cap."],

  ["4. Intercooler (LMS100 only)","Outlet T","T_coolant_in + 0 K","Infinite-surface limit."],
  ["","Pressure drop","0 bar","Not modeled."],
  ["","Heat rejected","Q_IC = mdot · Δh","Diagnostic only; not used in MW calc."],

  ["5. Combustor","Combustor ΔP","4%","P4 = 0.96 · P3."],
  ["","Combustor bypass fraction","LMS100: 0.747","Per-engine calibration. Core-to-casing split."],
  ["","Combustor air fraction (flame/total)","0.88 (both)","Flame vs dilution zone split."],
  ["","T4 target","LMS100: 1800 K (2780 °F) at 100% load","Firing temperature — commanded by deck. Now driven by the user-supplied 100%-load deck table."],
  ["","φ4 solve","Cantera equilibrate(\"HP\")","Back-solved so product T = T4. Equilibrium only."],
  ["","T_Bulk","equilibrate(\"HP\") at (T3,P3,φ_Bulk)","Drives downstream panels when linked."],
  ["","Heat loss","0%","Adiabatic combustor (AFT panel has separate HL input)."],

  ["6. Turbine","η_isen_turb","LMS100: 0.7805","Calibrated so MW_gross lands at MW_cap at the 44 °F design anchor (109.2 MW under the user-supplied deck table)."],
  ["","Expansion path","gas.SP = s_in, P_exh; η correction","Equilibrium products, Cantera enthalpy."],
  ["","P_exhaust","1.05 bar","Stack + HRSG backpressure."],
  ["","Cooling air","In bypass fraction","No re-injection mixing."],

  ["7. Power & Load","Parasitic load","1.5% of rated","Lube pumps, controls, cooling fans."],
  ["","MW_gross","W_turb − W_comp − W_parasitic","Cantera energy balance."],
  ["","MW_cap","rated · ambient · load_pct/100","Density-lapse & IC-benefit scaling."],
  ["","MW_net","MW_cap · (1 − derate%)","OEM-anchored cap × fuel-flex derate (MW_gross is diagnostic only)."],

  ["8. Fuel Properties (Option B)","Reference condition","60 °F / 1 atm","US gas-industry reference."],
  ["","Mixing rule","Linear in mole fractions","LHV_vol_mix = Σ xᵢ · LHV_vol,i."],
  ["","Components","CH4…C8H18, C2H4, C2H2, H2, CO, N2, CO2, H2O, Ar","16 species tabulated."],
  ["","Reference LHV","CH4 909.4 / C2H6 1618.7 / C3H8 2314.9 / H2 273.8 BTU/scf","GPA SP 2172."],

  ["9. Fuel Flexibility — MWI Derate (Option B)","Definition","MWI = LHV_vol / √(SG · T_fuel_°R)","T in absolute Rankine."],
  ["","In-spec band","40 ≤ MWI ≤ 54","No derate. Pure CH4 at 60 °F ≈ 53.6."],
  ["","Marginal","35–40 or 54–60","Derate 5%."],
  ["","Out-of-spec","MWI < 35 or > 60","Derate 20%."],
  ["","H2 warning","x_H2 > 30%","Flashback risk."],
  ["","Low-LHV warning","LHV_vol < 800 BTU/scf","Dilute fuel — doubles fuel flow."],
  ["","Derate application","MW_net = MW_uncapped · (1 − derate%)","Stacks with part-load, not with ambient droop."],

  ["10. Engine Deck Anchors","LMS100PB+","109.2 MW @ 44 °F / 80% RH","T3 644 K · P3 44.4 bar · T4 1800 K (2780°F) · η_LHV 44.9% · HR 8016 kJ/kWh · intercooled. Now driven by user-supplied 100%-load deck table (P3, T3, T4, MW vs T_amb). Additional engines are in development."],
  ["","Anchor method","combustor_bypass_frac + η_isen_turb","Two per-engine knobs fit MW and η at anchor."],

  ["11. Off-design Scaling","Density lapse","mdot_air ∝ ρ_amb · VGV(T_amb)","Engine-specific lapse curve."],
  ["","LMS100 intercooler benefit","Architectural","HPC inlet pinned to T_cool_in. LMS100 loses less on hot days than non-intercooled engines."],
  ["","Load line","Linear in cap","Cap = load_pct · rated_ambient. Gross super-linear at low load."],
  ["","Humidity","Via humid-air R only","Higher RH → more volumetric mdot."],
  ["","Altitude","Not modeled","Use P_amb input if needed."],
  ["","Inlet cooling","Not modeled","Simulate via T_amb input."],

  ["12. Solver & Numerics","Mechanism","GRI-Mech 3.0 (default)","53 species, 325 reactions."],
  ["","Combustion equilibrium","Cantera equilibrate(\"HP\")","Element-potential solver, constant H and P."],
  ["","Turbine expansion","Cantera gas.SP = s, P","Isentropic, then η correction."],
  ["","Compressor work","Cantera enthalpy difference","Humid-air real-gas."],
  ["","Thread model","Single-thread Cantera pool","Serialized server-side. 180 s / 540 s timeouts."],
  ["","Units","SI internal","UI converts to ENG on display."],

  ["13. Compressor Bleed","Modes","AUTO  /  MANUAL","AUTO: open % vs Load. MANUAL: user sets directly."],
  ["","Valve size","User input, 0–100% of W3","Sets max bleed_air_frac."],
  ["","Destination","Dumped to ambient","No re-injection. mdot_air_post_bleed = W3·(1 − bleed_air_frac)."],
  ["","T4 hold","Iterative on bleed_air_frac","Converges so T4 = deck commanded value. Reports bleed_iters / bleed_converged."],

  ["14. Water Injection","Inputs","WFR (kg_water/kg_fuel) + mode","WFR = 0 disables. Mode: liquid (h_fg) or steam (gas at T_air)."],
  ["","Mixed inlet T","3-stream enthalpy balance","h_air + WFR·h_water + (1/AFR)·h_fuel = mixed h."],
  ["","Liquid","Absorbs latent + sensible","h_fg = 2.257 MJ/kg at 100 °C."],
  ["","Steam","Gas phase, no h_fg","Joins inlet stream as superheated H2O at T_air."],
  ["","Cycle effect","Water passes through turbine","Adds turbine mdot. Power ↑, η ↓."],

  ["15. Combustor Mapping (LMS100 4-circuit DLE)","Reference design point","100% load, 44 °F","NOx15=45, CO15=130, PX36=4.3, PX36_HI=2.2 / DT_Main=450°F · Phi_OP=0.65 · C3=7.5% · N2=0.5% · Tflame=3035°F · T3=700°F · P3=638 psia."],
  ["","Per-circuit T_AFT","complete_combustion(T3, P3, φ)","Cantera complete-combustion (no dissociation)."],
  ["","OM circuit","Residual fuel mass","m_fuel_OM = total − (IP+OP+IM). φ_OM solved & clamped to [0,3]."],
  ["","Linear correction (Step 1)","Y = Y_ref + Σ ∂Y/∂xₖ · (xₖ − xₖ_ref)","Vars: DT_Main, N2, C3-eff, Phi_OP, Phi_IP (≥0.25 floor), Tflame, T3."],
  ["","Phi_OP multiplier (Step 2)","HI only: 1.0 ≥ φ ≥ 0.55, 0.8 ≤ 0.45","Linear interp on the 0.10 band. PX36_SEL_HI only."],
  ["","P3 scaling (Step 3)","(P3/638)^exp","NOx15=0.467, CO15=−1.0, SEL=1.35, SEL_HI=0.44."],
  ["","C3-effective","0.8·(C2H6+C2H4+C2H2) + (C3+...+C8)","C2-class at 0.8; C3 and heavier at 1.0."],
  ["","Tflame derivative (NOx)","Piecewise: 0.12 ≥2850, 0.04 between, 0 below 2750","Integrated continuously from T_ref = 3035 °F."],
  ["","Emissions Transfer Function","Per-BRNDMD post-multipliers on NOx, CO, PX36","User-trim knob; default 1.0. PX36_SEL_HI not multiplied."],
  ["","Air flow split","W36 = W3 · (W36/W3); flame = W36 · com.Air Frac; effusion = W36 · (1 − com.Air Frac)","W36 enters the dome and is split across the 4 circuits. OM is the float circuit (fuel and φ back-solved)."],

  ["16. Live Mapping (HMI sim)","Tick rate","2 Hz","Two samples per second across every metric. 10-minute rolling buffer (1200 samples). 2 Hz gives PX36_SEL / PX36_SEL_HI the transient resolution to read acoustic spikes; slow metrics (NOx, CO, MWI_GC, MW) are dead-time / lag-dominated so the higher rate just adds interpolation points to their existing curves."],
  ["","Instrument response","Transport delay + smoothstep","display(t) = lookup(t − deadT) blended over transT. Per-metric deadT/transT: PX36 0/1, NOx/CO 83/7, MWI_WIM 2/5, MWI_GC 415/5, MW 0/7."],
  ["","Noise","Per-metric, mean-band dependent","PX36: random step 1–9% every 1–2 s. NOx/CO: 20-s sine. MWI: 2.5% white + 2-min sine."],
  ["","PX36 protection trigger","px36 (display) > 5.5 psi","BD4 50 s → BD6 30 s → BD7. Up to 3 cycles before LOCK at BD4."],
  ["","Stochastic trips","phi_IP / phi_OP exceeding load-interp band","Random threshold rolled per band entry. Trip → all targets ramp to 0; 4-hour lockout banner."],
  ["","Emissions Mode staging","BD4 → 50 s → BD6 → 30 s → BD7","Triggered when Emissions Mode toggles ON. Endpoint adapts to current MW (skip / stop at BD6 / full)."],

  ["17. Exhaust Slip & η_c","Inputs","Measured CO, UHC (as CH₄), H₂ in dry exhaust (ppmvd)","User-entered. Zero values bypass the slip block (η_c = 1)."],
  ["","η_c formula","1 − (N_dry/fuel) · Σ(X_i · LHV_i,molar) / LHV_fuel,molar","Energy-loss form. Mirrors ASME PTC 4 / Lefebvre & Ballal Ch. 9."],
  ["","LHV constants (kJ/mol, NIST)","CO = 282.99 / CH₄ = 802.31 / H₂ = 241.83","Water as vapor product. Same constants as ExhaustPanel."],
  ["","N_dry/fuel","n_C_fuel / Σ(X_C · n_C,sp) · (1 − X_H₂O,wet)","Atom-balance from inversion product composition."],
  ["","φ_fed (metered)","φ_burn / η_c","Fuel-air ratio actually fed; rises with slip."],
  ["","FAR_fed / AFR_fed","FAR_burn / η_c  /  AFR_burn · η_c","Same η_c rescaling, mass basis."],
  ["","T_ad,eff (displayed)","Cantera HP-equilibrium at φ_eff = φ_burn · η_c","Drops with slip — captures the inefficiency penalty on flame T."],
  ["","Inputs that bypass slip","Pure-H₂ fuel, X_C ≤ 0, LHV_fuel ≤ 0","Slip block returns η_c = 1; reports burn-side values unchanged."],

  ["18. Fuel & Money","Anchor","O₂-derived path","O₂ is the standard stack measurement; CO₂ inversion can differ slightly."],
  ["","Fuel Flow input","Default 40,000 lb/hr (≈ 5.04 kg/s)","User-editable. In GTS mode auto-linked to Cycle ṁ_fuel (LOCKED). Advanced mode: linked but user-breakable."],
  ["","Air mass flow","ṁ_air = ṁ_fuel / FAR_burn","FAR_burn = O₂-inversion FAR (slip-independent). Convention: at a fixed operating point the compressor delivers a fixed ṁ_air — slip is downstream chemistry and must not feed back into the air estimate. Slip values affect η_c and the dollar penalty only."],
  ["","Heat input (LHV)","ṁ_fuel · LHV_mass","MW (SI) / MMBTU/hr (ENG). LHV is mass-basis from fuel composition."],
  ["","Fuel cost","User input USD/MMBTU (LHV). Default $4.00","No regional adjustment. LHV basis matches Heat Input units."],
  ["","Period","week (168 h) / month (730 h) / year (8,760 h)","Selectable. Total $ / period = MMBTU/hr · $/MMBTU · h/period."],
  ["","Penalty","Total · (1 − η_c)","Money lost to slip per period. η_c = 1 (no slip) → penalty = 0."],
];
const wsA=XLSX.utils.aoa_to_sheet(sA);
wsA["!cols"]=[{wch:34},{wch:36},{wch:40},{wch:52}];
XLSX.utils.book_append_sheet(wb,wsA,"Assumptions");

// ══════════════════ MAPPING TABLES ══════════════════
// Tables are stored in °F internally. SI export converts to K, English keeps °F.
// Mode-gated: only gts / advanced expose the Mapping panel.
if(mappingTables && _showMapping){
  const _t3Header=u==="SI"?"T3 (K)":"T3 (°F)";
  const _t3Conv=u==="SI"?(F=>+(((+F-32)*5/9+273.15).toFixed(2))):(F=>+(+F).toFixed(1));
  const sM=[["═══ COMBUSTOR MAPPING TABLES — φ lookup by T3 × BRNDMD ═══"],
    ["BRNDMD = burner mode (7=full DLE, 6=trans, 4=part-load, 2=startup)"],[],
    ["BRNDMD",_t3Header,"φ_OuterPilot","φ_InnerPilot","φ_InnerMain"]];
  for(const k of [7,6,4,2]){
    const rows=mappingTables[k]||[];
    for(const r of rows){sM.push([k,_t3Conv(r.T3),+r.OP,+r.IP,+r.IM]);}
    sM.push([]);
  }
  const wsM=XLSX.utils.aoa_to_sheet(sM);
  wsM["!cols"]=[{wch:10},{wch:12},{wch:16},{wch:16},{wch:16}];
  XLSX.utils.book_append_sheet(wb,wsM,"Mapping Tables");
}

// ══════════════════ UI / SIDEBAR SETTINGS ══════════════════
// Captures sidebar toggles & step values that aren't physical inputs but
// affect what the user sees / how they navigate. Helpful for reproducing
// a session.
{
  const sUI=[
    ["═══ UI & SIDEBAR SETTINGS ═══"],[],
    ["Setting","Value","Notes"],
    ["Unit System",u==="SI"?"SI (K, bar, m, m/s)":"English (°F, psia, ft, ft/s)","UI display only — internal calcs are SI"],
    ["Computation Mode",accurate?"ACCURATE (Cantera backend)":"SIMPLE (in-browser JS)","Accurate requires subscription"],
    ["Combustion Mode",combMode==="equilibrium"?"Chemical Equilibrium":"Complete Combustion","Drives AFT, Exhaust, Ops Summary"],
    ["Emissions Mode (Live Mapping staging)",emissionsMode?"ENABLED (BD7 ladder)":"DISABLED (BD4 only)","Drives BRNDMD ladder & live-mapping staging"],
    ["Linkage T3 ← Cycle T3",linkT3?"ON":"OFF","Sidebar T_air follows cycle T3"],
    ["Linkage P3 ← Cycle P3",linkP3?"ON":"OFF","Sidebar P follows cycle P3"],
    ["Linkage φ ← Cycle φ_Bulk",linkFAR?"ON":"OFF","Sidebar φ follows cycle φ_Bulk"],
    ["Load step (%)",loadStepPct,"± buttons + slider step. Editable, persists."],
    ["Bleed step (%)",bleedStepPct,"Manual-mode ± step for bleed valve."],
  ];
  const wsUI=XLSX.utils.aoa_to_sheet(sUI);
  wsUI["!cols"]=[{wch:38},{wch:24},{wch:48}];
  XLSX.utils.book_append_sheet(wb,wsUI,"UI Settings");
}

return wb;}

/* ══════════════════ SVG CHART ══════════════════ */
function Chart({data,xK,yK,xL,yL,color="#2DD4BF",w=540,h=250,marker=null,markerColor=null,y2K=null,c2="#FBBF24",y2L="",vline=null,xMin=null,xMax=null,yMin=null,yMax=null,y2Min=null,y2Max=null,step=false,hLines=null,xFmt=null,nXTicks=null,
  // bands: [{x0, x1, color}] in x-axis units. Drawn as background rectangles
  // BEHIND gridlines and the data line. Used to shade BR-mode regions on the
  // cycle load-sweep plots; safe to omit elsewhere.
  bands=null}){if(!data||!data.length)return<div style={{color:C.txtMuted,padding:20,fontSize:13,fontFamily:"monospace"}}>No data</div>;
// ── Chart layout & typography (figure-quality polish) ─────────────────
//   Axis padding bumped to make room for the larger tick + title fonts.
//   Tick labels: 12 px, semibold, full-contrast txt color (was 9 px / dim).
//   Axis titles:  14 px, bold (was 10 px, dim).
//   Major gridlines:  C.grid at 0.75 px.
//   Minor gridlines:  C.grid at 0.3 px, 4× density (between major ticks).
//   Data line stroke 2.5 (was 2). Marker label 12 px bold.
const p={t:28,r:y2K?80:40,b:60,l:78};const W=w-p.l-p.r,H=h-p.t-p.b;const xs=data.map(d=>d[xK]),ys=data.map(d=>d[yK]);const xn=xMin!=null?xMin:Math.min(...xs),xx=xMax!=null?xMax:Math.max(...xs);let yn,yx;if(yMin!=null&&yMax!=null){yn=yMin;yx=yMax;}else{let yn_=Math.min(...ys),yx_=Math.max(...ys);if(yn_===yx_){yn_-=1;yx_+=1;}yn=yMin!=null?yMin:yn_-(yx_-yn_)*0.05;yx=yMax!=null?yMax:yx_+(yx_-yn_)*0.05;if(yn_>=0&&yn<0)yn=0;}const sx=v=>p.l+(v-xn)/(xx-xn||1)*W,sy=v=>p.t+H-(v-yn)/(yx-yn||1)*H;
// Staircase path: hold each y constant from x_i to x_{i+1}, then jump to y_{i+1}.
// Used for piecewise-constant series like BRNDMD vs load.
const buildStep=(arr,xKey,yKey,syFn)=>{
  if(arr.length===0) return '';
  let d=`M${sx(arr[0][xKey]).toFixed(1)},${syFn(arr[0][yKey]).toFixed(1)}`;
  for(let i=1;i<arr.length;i++){
    d+=` L${sx(arr[i][xKey]).toFixed(1)},${syFn(arr[i-1][yKey]).toFixed(1)}`;
    d+=` L${sx(arr[i][xKey]).toFixed(1)},${syFn(arr[i][yKey]).toFixed(1)}`;
  }
  return d;
};
const pts = step
  ? buildStep(data,xK,yK,sy)
  : data.map((d,i)=>`${i?'L':'M'}${sx(d[xK]).toFixed(1)},${sy(d[yK]).toFixed(1)}`).join(' ');let y2n,y2x,sy2,pts2;if(y2K){const y2s=data.map(d=>d[y2K]);if(y2Min!=null&&y2Max!=null){y2n=y2Min;y2x=y2Max;}else{let y2n_=Math.min(...y2s),y2x_=Math.max(...y2s);if(y2n_===y2x_){y2n_-=1;y2x_+=1;}y2n=y2Min!=null?y2Min:y2n_-(y2x_-y2n_)*0.05;y2x=y2Max!=null?y2Max:y2x_+(y2x_-y2n_)*0.05;if(y2n_>=0&&y2n<0)y2n=0;}sy2=v=>p.t+H-(v-y2n)/(y2x-y2n||1)*H;pts2=data.map((d,i)=>`${i?'L':'M'}${sx(d[xK]).toFixed(1)},${sy2(d[y2K]).toFixed(1)}`).join(' ');}const nY=5,nX=nXTicks!=null?nXTicks:6;const yTk=Array.from({length:nY+1},(_,i)=>yn+(yx-yn)*i/nY);const xTk=Array.from({length:nX+1},(_,i)=>xn+(xx-xn)*i/nX);const fmt=v=>Math.abs(v)>=1e4?(v/1e3).toFixed(0)+'k':Math.abs(v)>=100?v.toFixed(0):Math.abs(v)>=1?v.toFixed(1):v.toFixed(3);const fmtX=v=>xFmt?xFmt(v):fmt(v);const gid=`g${yK}${color.replace('#','')}${Math.random().toString(36).slice(2,6)}`;return(<svg viewBox={`0 0 ${w} ${h}`} style={{width:"100%",maxWidth:w}}><defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity=".2"/><stop offset="100%" stopColor={color} stopOpacity=".01"/></linearGradient></defs>{bands && bands.map((b,i)=>{
    // Clip band to the visible x-range; drop bands that don't overlap.
    const x0c = Math.max(b.x0, xn), x1c = Math.min(b.x1, xx);
    if (!(x1c > x0c)) return null;
    const xa = sx(x0c), xb = sx(x1c);
    return (<rect key={`band${i}`} x={xa} y={p.t} width={Math.max(0, xb - xa)} height={H} fill={b.color} stroke="none"/>);
  })}{/* Minor gridlines: 4 sub-divisions between each major y/x tick. */}
{yTk.slice(0,-1).map((v,i)=>{const dy=(yTk[1]-yTk[0])/4;return [1,2,3].map(k=><line key={`yMin${i}_${k}`} x1={p.l} y1={sy(v+k*dy)} x2={w-p.r} y2={sy(v+k*dy)} stroke={C.grid} strokeWidth=".3" opacity=".55"/>);})}
{xTk.slice(0,-1).map((v,i)=>{const dx=(xTk[1]-xTk[0])/4;return [1,2,3].map(k=><line key={`xMin${i}_${k}`} x1={sx(v+k*dx)} y1={p.t} x2={sx(v+k*dx)} y2={p.t+H} stroke={C.grid} strokeWidth=".3" opacity=".55"/>);})}
{/* Major gridlines + tick labels. */}
{yTk.map((v,i)=><g key={i}><line x1={p.l} y1={sy(v)} x2={w-p.r} y2={sy(v)} stroke={C.grid} strokeWidth=".75"/><line x1={p.l-5} y1={sy(v)} x2={p.l} y2={sy(v)} stroke={C.axis} strokeWidth="1"/><text x={p.l-8} y={sy(v)+4} fill={C.txt} fontSize="12" textAnchor="end" fontFamily="monospace" fontWeight="500">{fmt(v)}</text></g>)}{xTk.map((v,i)=><g key={i}><line x1={sx(v)} y1={p.t} x2={sx(v)} y2={p.t+H} stroke={C.grid} strokeWidth=".75"/><line x1={sx(v)} y1={p.t+H} x2={sx(v)} y2={p.t+H+5} stroke={C.axis} strokeWidth="1"/><text x={sx(v)} y={h-p.b+19} fill={C.txt} fontSize="12" textAnchor="middle" fontFamily="monospace" fontWeight="500">{fmtX(v)}</text></g>)}{(!bands || bands.length===0) && <path d={`${pts} L${sx(xs[xs.length-1]).toFixed(1)},${(p.t+H)} L${sx(xs[0]).toFixed(1)},${(p.t+H)} Z`} fill={`url(#${gid})`}/>}<path d={pts} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"/>{y2K&&pts2&&<path d={pts2} fill="none" stroke={c2} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" strokeDasharray="6 4"/>}{y2K&&<>{Array.from({length:nY+1},(_,i)=>y2n+(y2x-y2n)*i/nY).map((v,i)=><text key={`y2${i}`} x={w-p.r+8} y={sy2(v)+4} fill={c2} fontSize="11" textAnchor="start" fontFamily="monospace" fontWeight="600">{fmt(v)}</text>)}</>}{hLines&&hLines.map((hl,i)=>hl.y>=yn&&hl.y<=yx?<g key={`hl${i}`}><line x1={p.l} y1={sy(hl.y)} x2={w-p.r} y2={sy(hl.y)} stroke={hl.color} strokeWidth="1.5" strokeDasharray="6 4" opacity="0.9"/><text x={w-p.r-6} y={sy(hl.y)-5} fill={hl.color} fontSize="12" fontFamily="'Barlow Condensed',sans-serif" fontWeight="700" textAnchor="end" letterSpacing=".5px">{hl.label} · {hl.y.toFixed(1)}</text></g>:null)}{vline!=null&&vline>xn&&vline<xx&&<g><line x1={sx(vline)} y1={p.t} x2={sx(vline)} y2={p.t+H} stroke={C.txtMuted} strokeWidth="1" strokeDasharray="3 3" opacity=".7"/><text x={sx(vline)-5} y={p.t+13} fill={C.txtMuted} fontSize="11" textAnchor="end" fontFamily="monospace" fontWeight="600">PSR</text><text x={sx(vline)+5} y={p.t+13} fill={C.txtMuted} fontSize="11" textAnchor="start" fontFamily="monospace" fontWeight="600">PFR</text></g>}{marker&&<g><line x1={sx(marker.x)} y1={p.t} x2={sx(marker.x)} y2={p.t+H} stroke={markerColor||C.warm} strokeWidth="1.25" strokeDasharray="4 3"/><circle cx={sx(marker.x)} cy={sy(marker.y)} r="5" fill={markerColor||C.warm} stroke={C.bg} strokeWidth="2"/><text x={sx(marker.x)+(sx(marker.x)>w/2?-10:10)} y={sy(marker.y)-9} fill={markerColor||C.warm} fontSize="12" fontFamily="monospace" fontWeight="700" textAnchor={sx(marker.x)>w/2?"end":"start"}>{marker.label}</text></g>}<text x={p.l+W/2} y={h-8} fill={C.txt} fontSize="14" fontWeight="700" textAnchor="middle" fontFamily="'Barlow',sans-serif">{xL}</text><text x={16} y={p.t+H/2} fill={color} fontSize="14" fontWeight="700" textAnchor="middle" fontFamily="'Barlow',sans-serif" transform={`rotate(-90,16,${p.t+H/2})`}>{yL}</text>{y2K&&<text x={w-16} y={p.t+H/2} fill={c2} fontSize="14" fontWeight="700" textAnchor="middle" fontFamily="'Barlow',sans-serif" transform={`rotate(90,${w-16},${p.t+H/2})`}>{y2L}</text>}</svg>);}
function HBar({data,w=540,h=180}){if(!data)return null;const entries=Object.entries(data).filter(([_,v])=>v>0.05).sort((a,b)=>b[1]-a[1]);if(!entries.length)return null;const pa={t:6,r:78,b:6,l:48};const bH=Math.min(22,(h-pa.t-pa.b)/entries.length-3);const mx=Math.max(...entries.map(e=>e[1]));const W=w-pa.l-pa.r;const clr={CO2:C.warm,H2O:C.accent,N2:C.accent3,O2:"#38BDF8",Ar:"#64748B",CH4:C.accent2,C2H6:C.orange,C3H8:"#F59E0B",H2:C.good,CO:"#FB923C",NO:C.strong,OH:C.violet,H:"#FDE68A",O:"#FCA5A5"};return(<svg viewBox={`0 0 ${w} ${h}`} style={{width:"100%",maxWidth:w}}>{entries.map(([sp,val],i)=>{const y=pa.t+i*(bH+3);const bw=val/mx*W;return(<g key={sp}><text x={pa.l-4} y={y+bH/2+4} fill={C.txtDim} fontSize="11" textAnchor="end" fontFamily="monospace">{fmt(sp)}</text><rect x={pa.l} y={y} width={Math.max(1,bw)} height={bH} rx="2" fill={clr[sp]||"#64748B"} opacity=".85"/><text x={pa.l+bw+4} y={y+bH/2+4} fill={C.txt} fontSize="10" fontFamily="monospace">{val.toFixed(2)}%</text></g>);})}</svg>);}

// ── Multi-series scatter/line chart for the Automate "Plot Data" panel.
//   Independent of the existing single-series `Chart` so we can keep `Chart`
//   simple and not retrofit it. Each series is {name, color, points:[{x,y}]}
//   pre-sorted by x ascending. Renders gridlines, axis ticks, points, lines
//   between points (only when ≥2 points exist), legend, and axis titles.
//   Auto-derives min/max with 5% padding (clamping min→0 for non-negative
//   data); honours explicit xMin/xMax/yMin/yMax overrides. xCategorical
//   (true) uses integer indices on x and shows the matching xLabel string
//   under each tick — used when the X column is enum/bool. yLog activates a
//   base-10 log scale on Y for outputs spanning many orders of magnitude.
function MultiSeriesChart({
  series, xLabel, yLabel, w=560, h=300,
  xMin=null, xMax=null, yMin=null, yMax=null,
  xCategorical=false, xLabels=null, yLog=false,
  legendCols=2,
  // When false, render markers only — no connecting lines. Used for
  // scatter-cloud plots (e.g. when X is an output that depends on
  // multiple inputs that all vary, so points are not naturally ordered
  // by X within a series and a connecting line would zigzag).
  connectLines=true,
}){
  const allPts = series.flatMap(s => s.points || []).filter(p =>
    p && Number.isFinite(p.x) && Number.isFinite(p.y) && (!yLog || p.y > 0)
  );
  if (allPts.length === 0){
    return <div style={{color:C.txtMuted, padding:20, fontSize:13, fontFamily:"monospace"}}>No data</div>;
  }
  // Reserve ~26 px per legend row at the bottom (legendCols entries per row).
  // Bumped from 18 → 24 to fit the larger 13 px legend font with breathing.
  const nLegendRows = Math.ceil(series.length / Math.max(1, legendCols));
  const legendH = nLegendRows * 24 + 10;
  // Padding tuned for figure-quality typography:
  //   bottom = 64 (axis title baseline) + legendH
  //   left   = 86 (room for 14 px y-title rotated + 12 px tick labels)
  //   top    = 28, right = 24
  const p = { t: 28, r: 24, b: 64 + legendH, l: 86 };
  const W = w - p.l - p.r, H = h - p.t - p.b;

  const xs = allPts.map(d => d.x);
  let xn = xMin != null ? xMin : Math.min(...xs);
  let xx = xMax != null ? xMax : Math.max(...xs);
  if (xn === xx){ xn -= 1; xx += 1; }
  if (xMin == null && xMax == null){
    const pad = (xx - xn) * 0.05;
    xn -= pad; xx += pad;
    if (Math.min(...xs) >= 0 && xn < 0) xn = 0;
  }

  // Y scale — linear or log10
  let yToPx, pxToY, yTk;
  const ys = allPts.map(d => d.y);
  if (yLog){
    const positiveYs = ys.filter(v => v > 0);
    let lyn = Math.log10(Math.min(...positiveYs));
    let lyx = Math.log10(Math.max(...positiveYs));
    if (lyn === lyx){ lyn -= 0.5; lyx += 0.5; }
    const lpad = (lyx - lyn) * 0.05;
    lyn -= lpad; lyx += lpad;
    yToPx = v => p.t + H - (Math.log10(v) - lyn) / (lyx - lyn || 1) * H;
    const nY = 5;
    yTk = Array.from({length: nY+1}, (_,i) => Math.pow(10, lyn + (lyx - lyn) * i / nY));
  } else {
    let yn = yMin != null ? yMin : Math.min(...ys);
    let yx = yMax != null ? yMax : Math.max(...ys);
    if (yn === yx){ yn -= 1; yx += 1; }
    if (yMin == null && yMax == null){
      const pad = (yx - yn) * 0.05;
      yn -= pad; yx += pad;
      if (Math.min(...ys) >= 0 && yn < 0) yn = 0;
    }
    yToPx = v => p.t + H - (v - yn) / (yx - yn || 1) * H;
    const nY = 5;
    yTk = Array.from({length: nY+1}, (_,i) => yn + (yx - yn) * i / nY);
  }

  const xToPx = v => p.l + (v - xn) / (xx - xn || 1) * W;
  const fmt = v => {
    if (!Number.isFinite(v)) return "—";
    const a = Math.abs(v);
    if (a !== 0 && (a < 0.01 || a >= 1e5)) return v.toExponential(1);
    if (a >= 1e4) return (v/1e3).toFixed(0) + "k";
    if (a >= 100) return v.toFixed(0);
    if (a >= 1)   return v.toFixed(2);
    if (a >= 0.01) return v.toFixed(3);
    return v.toFixed(4);
  };

  // X ticks — for categorical, use one tick per integer index in [xn, xx];
  // for numeric, 6 evenly spaced ticks.
  let xTk;
  if (xCategorical && xLabels){
    xTk = xLabels.map((label, i) => ({ v: i, label }));
  } else {
    const nX = 6;
    xTk = Array.from({length: nX+1}, (_,i) => {
      const v = xn + (xx - xn) * i / nX;
      return { v, label: fmt(v) };
    });
  }

  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${w} ${h}`}
      width={w} height={h}
      style={{width:"100%", maxWidth:w, height:"auto"}}>
      {/* Solid background — required for PNG export so charts read on the
          current theme background and don't render with transparent canvas. */}
      <rect x="0" y="0" width={w} height={h} fill={C.bg}/>
      {/* Minor gridlines — 4 sub-divisions per major tick, very faint.
          Skipped on log Y because log spacing makes minor placement awkward. */}
      {!yLog && yTk.slice(0,-1).map((v,i) => {
        const dy = (yTk[1] - yTk[0]) / 4;
        return [1,2,3].map(k => (
          <line key={`yMin${i}_${k}`}
            x1={p.l} y1={yToPx(v + k*dy)} x2={w - p.r} y2={yToPx(v + k*dy)}
            stroke={C.grid} strokeWidth=".3" opacity=".5"/>
        ));
      })}
      {!xCategorical && xTk.slice(0,-1).map((tk,i) => {
        if (i+1 >= xTk.length) return null;
        const dx = (xTk[1].v - xTk[0].v) / 4;
        return [1,2,3].map(k => (
          <line key={`xMin${i}_${k}`}
            x1={xToPx(tk.v + k*dx)} y1={p.t}
            x2={xToPx(tk.v + k*dx)} y2={p.t + H}
            stroke={C.grid} strokeWidth=".3" opacity=".5"/>
        ));
      })}
      {/* Major gridlines + Y tick labels */}
      {yTk.map((v,i) => (
        <g key={`y${i}`}>
          <line x1={p.l} y1={yToPx(v)} x2={w - p.r} y2={yToPx(v)}
            stroke={C.grid} strokeWidth=".75"/>
          <line x1={p.l - 6} y1={yToPx(v)} x2={p.l} y2={yToPx(v)}
            stroke={C.axis} strokeWidth="1"/>
          <text x={p.l - 9} y={yToPx(v) + 4} fill={C.txt} fontSize="12"
            textAnchor="end" fontFamily="monospace" fontWeight="500">{fmt(v)}</text>
        </g>
      ))}
      {/* X major gridlines + tick labels */}
      {xTk.map((tk,i) => (
        <g key={`x${i}`}>
          <line x1={xToPx(tk.v)} y1={p.t} x2={xToPx(tk.v)} y2={p.t + H}
            stroke={C.grid} strokeWidth=".75"/>
          <line x1={xToPx(tk.v)} y1={p.t + H} x2={xToPx(tk.v)} y2={p.t + H + 6}
            stroke={C.axis} strokeWidth="1"/>
          <text x={xToPx(tk.v)} y={h - p.b + 19} fill={C.txt} fontSize="12"
            textAnchor="middle" fontFamily="monospace" fontWeight="500"
            transform={xCategorical ? `rotate(-25, ${xToPx(tk.v)}, ${h - p.b + 19})` : ""}>
            {tk.label}
          </text>
        </g>
      ))}
      {/* Axis frame */}
      <rect x={p.l} y={p.t} width={W} height={H} fill="none" stroke={C.axis} strokeWidth="1.25"/>
      {/* Series — one path per series; bigger markers for readability */}
      {series.map((s, sIdx) => {
        const pts = (s.points || []).filter(d =>
          Number.isFinite(d.x) && Number.isFinite(d.y) && (!yLog || d.y > 0)
        );
        if (pts.length === 0) return null;
        const path = pts.map((d,i) =>
          `${i ? 'L' : 'M'}${xToPx(d.x).toFixed(1)},${yToPx(d.y).toFixed(1)}`
        ).join(' ');
        const marker = s.marker || "circle";
        return (
          <g key={`s${sIdx}`}>
            {connectLines && pts.length >= 2 && (
              <path d={path} fill="none" stroke={s.color} strokeWidth="2.25"
                strokeLinejoin="round" strokeLinecap="round" opacity="0.92"/>
            )}
            {pts.map((d,i) => _renderMarker(marker,
              xToPx(d.x), yToPx(d.y), 4.5, s.color, C.bg, `pt${sIdx}_${i}`))}
          </g>
        );
      })}
      {/* Axis titles — 14 px bold, full-contrast text */}
      <text x={p.l + W/2} y={h - p.b + 46} fill={C.txt} fontSize="14"
        textAnchor="middle" fontFamily="'Barlow',sans-serif" fontWeight="700">
        {xLabel}
      </text>
      <text x={20} y={p.t + H/2} fill={C.txt} fontSize="14"
        textAnchor="middle" fontFamily="'Barlow',sans-serif" fontWeight="700"
        transform={`rotate(-90, 20, ${p.t + H/2})`}>
        {yLabel}{yLog ? " (log₁₀)" : ""}
      </text>
      {/* Legend — wrap into legendCols columns × nLegendRows rows.
          Bumped to 13 px font + 24 px row pitch for readability. */}
      {series.map((s, i) => {
        const colW = W / Math.max(1, legendCols);
        const r = Math.floor(i / legendCols), c = i % legendCols;
        const lx = p.l + c * colW + 2;
        const ly = h - legendH + 12 + r * 24;
        const marker = s.marker || "circle";
        return (
          <g key={`lg${i}`}>
            <line x1={lx} y1={ly} x2={lx + 22} y2={ly} stroke={s.color} strokeWidth="3"/>
            {_renderMarker(marker, lx + 11, ly, 4.5, s.color, C.bg, `lgm${i}`)}
            <text x={lx + 30} y={ly + 4.5} fill={C.txt} fontSize="13"
              fontFamily="'Barlow',sans-serif" fontWeight="500">{s.name}</text>
          </g>
        );
      })}
    </svg>
  );
}

// Render a marker shape at (cx, cy) with radius r. Returns a JSX element.
// Uses simple geometric shapes that read clearly at 3-4 px size and stay
// distinguishable in PNG export at 2x pixel ratio. Filled shapes get a
// thin contrasting stroke so they pop on busy gridlines; stroke-only
// shapes (plus, cross) use the series color directly.
function _renderMarker(shape, cx, cy, r, color, bgColor, key){
  const cxs = (typeof cx === "number") ? cx.toFixed(1) : cx;
  const cys = (typeof cy === "number") ? cy.toFixed(1) : cy;
  switch (shape){
    case "square":
      return (<rect key={key} x={cx - r} y={cy - r} width={2*r} height={2*r}
        fill={color} stroke={bgColor} strokeWidth="0.8"/>);
    case "triangle":
      return (<polygon key={key}
        points={`${cxs},${(cy - r).toFixed(1)} ${(cx - r).toFixed(1)},${(cy + r * 0.85).toFixed(1)} ${(cx + r).toFixed(1)},${(cy + r * 0.85).toFixed(1)}`}
        fill={color} stroke={bgColor} strokeWidth="0.8"/>);
    case "diamond":
      return (<polygon key={key}
        points={`${cxs},${(cy - r).toFixed(1)} ${(cx + r).toFixed(1)},${cys} ${cxs},${(cy + r).toFixed(1)} ${(cx - r).toFixed(1)},${cys}`}
        fill={color} stroke={bgColor} strokeWidth="0.8"/>);
    case "plus":
      return (<g key={key}>
        <line x1={cx - r} y1={cy} x2={cx + r} y2={cy} stroke={color} strokeWidth="2"/>
        <line x1={cx} y1={cy - r} x2={cx} y2={cy + r} stroke={color} strokeWidth="2"/>
      </g>);
    case "cross":
      return (<g key={key}>
        <line x1={cx - r * 0.85} y1={cy - r * 0.85} x2={cx + r * 0.85} y2={cy + r * 0.85} stroke={color} strokeWidth="2"/>
        <line x1={cx - r * 0.85} y1={cy + r * 0.85} x2={cx + r * 0.85} y2={cy - r * 0.85} stroke={color} strokeWidth="2"/>
      </g>);
    case "star": {
      // 5-point star inscribed in circle of radius r.
      const pts = [];
      for (let i = 0; i < 10; i++){
        const ang = (Math.PI / 2) + (i * Math.PI / 5);
        const rr = (i % 2 === 0) ? r : r * 0.45;
        pts.push(`${(cx + rr * Math.cos(ang)).toFixed(1)},${(cy - rr * Math.sin(ang)).toFixed(1)}`);
      }
      return (<polygon key={key} points={pts.join(" ")}
        fill={color} stroke={bgColor} strokeWidth="0.6"/>);
    }
    case "circle":
    default:
      return (<circle key={key} cx={cxs} cy={cys} r={r}
        fill={color} stroke={bgColor} strokeWidth="0.8"/>);
  }
}

/* ══════════════════ UI COMPONENTS ══════════════════ */
// ── Theme palettes ─────────────────────────────────────────────────────
// Two palettes share identical KEYS so every `C.x` read works in both.
// Hue-matched accents are kept consistent — saturation/lightness are tuned
// per theme so they pop against their respective backgrounds (pastel-on-
// black for dark, saturated-on-near-white for light).
const DARK_C = {
  bg:"#0D1117", bg2:"#161B22", bg3:"#1C2128",
  border:"#30363D",
  accent:"#2DD4BF", accent2:"#FBBF24", accent3:"#60A5FA",
  warm:"#F87171", good:"#4ADE80", violet:"#A78BFA",
  orange:"#FB923C", strong:"#EF4444",
  txt:"#F0F6FC", txtDim:"#C9D1D9", txtMuted:"#8B949E",
  grid:"#21262D", axis:"#8B949E",
};
const LIGHT_C = {
  bg:"#FAFBFC", bg2:"#FFFFFF", bg3:"#F0F2F5",
  border:"#D0D7DE",
  // Saturated accents that read well on white (vs. the pastel set used
  // on near-black). Same hue as DARK so brand recognition is preserved.
  accent:"#0E8C7C", accent2:"#B97D00", accent3:"#0969DA",
  warm:"#CF222E", good:"#1A7F37", violet:"#6639BA",
  orange:"#BF5A0E", strong:"#A40E26",
  txt:"#1F2328", txtDim:"#3A3F45", txtMuted:"#656D76",
  grid:"#E4E8EC", axis:"#656D76",
};
// `_activeC` is the live palette every C.x read resolves to. Toggling the
// theme (a) reassigns this binding and (b) bumps a counter on App that's
// passed as React `key` to the panel container, forcing a clean re-mount
// so every inline-style site picks up the new palette without us having
// to refactor thousands of `style={{background: C.bg}}` sites into hooks.
let _activeC = DARK_C;
function _readActiveTheme(){
  try { return localStorage.getItem("ctk_theme") === "light" ? "light" : "dark"; }
  catch { return "dark"; }
}
// Initialize at module load from localStorage so the very first render of
// any panel function (which runs BEFORE App's useEffect commits) already
// sees the user's persisted theme — no flash of the default theme.
_activeC = _readActiveTheme() === "light" ? LIGHT_C : DARK_C;
function setActiveTheme(name){
  _activeC = name === "light" ? LIGHT_C : DARK_C;
  try { localStorage.setItem("ctk_theme", name); } catch {}
}
// `C` proxies onto whatever `_activeC` currently is, so every existing
// `C.bg` / `C.accent` / `${C.warm}50` reference Just Works without edits.
const C = new Proxy({}, {
  get(_, key){ return _activeC[key]; },
  // ownKeys + getOwnPropertyDescriptor are needed if any code does
  // Object.keys(C) or {...C} — which a few places do (e.g. AccountPanel
  // takes C as a prop). Forward them onto the active palette.
  ownKeys(){ return Reflect.ownKeys(_activeC); },
  getOwnPropertyDescriptor(_, key){
    return Reflect.getOwnPropertyDescriptor(_activeC, key);
  },
  has(_, key){ return key in _activeC; },
});

// BR-mode (BRNDMD) tint palette — used to shade chart backgrounds in the
// cycle load-sweep dashboard. Cool→warm progression maps to operational
// comfort: BD7 = full DLE (calm); BD2 = startup/diffusion (hottest).
//   solid: full-opacity color used for legend swatches and the BRNDMD
//          step-plot line itself.
//   tint:  same color at low alpha (12 in hex = ~7 %) — used as the
//          chart-background fill rectangles. Subtle enough to never
//          out-shout the data line.
const BR_PALETTE = {
  7: { solid: "#2DD4BF", tint: "#2DD4BF14", label: "BD7", desc: "Full DLE (high load)" },
  6: { solid: "#A78BFA", tint: "#A78BFA14", label: "BD6", desc: "Transition" },
  4: { solid: "#FBBF24", tint: "#FBBF2414", label: "BD4", desc: "Part-load" },
  2: { solid: "#F87171", tint: "#F8717114", label: "BD2", desc: "Startup / off-design" },
};
// Compute BR-mode background-band specs from a load-sweep result.
// Walks the sorted-by-load points and emits one band per contiguous BR-mode
// run. Returns [{x0, x1, color}, ...] in load-% units, ready for Chart.
function brBandsFromSweep(sweepData){
  if(!sweepData || sweepData.length === 0) return [];
  const pts = [...sweepData].sort((a,b)=>a.load - b.load);
  const out = [];
  let curBR = pts[0].brndmd;
  let segStart = pts[0].load;
  for(let i = 1; i < pts.length; i++){
    if(pts[i].brndmd !== curBR){
      // Boundary midway between this point and the previous one.
      const x1 = (pts[i].load + pts[i-1].load) / 2;
      const tint = BR_PALETTE[curBR]?.tint;
      if(tint) out.push({ x0: segStart, x1, color: tint, br: curBR });
      segStart = x1;
      curBR = pts[i].brndmd;
    }
  }
  const tint = BR_PALETTE[curBR]?.tint;
  if(tint) out.push({ x0: segStart, x1: pts[pts.length-1].load, color: tint, br: curBR });
  return out;
}
// ── Theme-reactive style objects ────────────────────────────────────────
// hs.box / hs.em / hs.warn embed alpha tints of C.accent etc. via template
// literals. If we built them at module load with `const hs = {...}`, the
// substitutions would resolve to FROZEN strings ("#2DD4BF08", etc.) and
// the styles would keep the boot-time theme forever — that's why dark
// mode looked broken (cards still carried light-theme backgrounds after
// toggling). Wrap in a Proxy backed by a builder that re-runs whenever
// _activeC changes; cache by reference so we don't allocate on every read.
let _hsCache=null,_hsCacheFor=null;
function _buildHs(){return{
  box:{fontSize:10.5,lineHeight:1.55,color:C.txtDim,padding:"10px 12px",background:`${C.accent}08`,border:`1px solid ${C.accent}18`,borderRadius:6,marginBottom:10,fontFamily:"'Barlow',sans-serif"},
  em:{color:C.accent,fontWeight:600},
  warn:{color:C.accent2,fontWeight:600},
};}
const hs=new Proxy({},{get(_,key){if(_hsCacheFor!==_activeC){_hsCache=_buildHs();_hsCacheFor=_activeC;}return _hsCache[key];}});

// ── Help Components ──
// LinkChip — sidebar status indicator for "this value is following the Cycle".
// When `onBreak` is a function, a BREAK button is shown so the user can
// disconnect (Advanced Mode). When `onBreak` is null/undefined the chip is a
// read-only indicator — used in Gas Turbine Simulator mode where the cycle is
// always the source of truth and the link is not user-breakable.
function LinkChip({onBreak,label}){return(<div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:4,padding:"3px 7px",background:`${C.accent}15`,border:`1px solid ${C.accent}50`,borderRadius:4,fontSize:9.5,fontFamily:"monospace"}}>
  <span style={{color:C.accent}}>🔗 {label}</span>
  {onBreak ? (
    <button onClick={onBreak} title="Stop pulling this value from the Cycle panel" style={{padding:"1px 6px",fontSize:8.5,fontWeight:700,color:C.accent2,background:"transparent",border:`1px solid ${C.accent2}70`,borderRadius:3,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".4px"}}>BREAK</button>
  ) : (
    <span title="Linked by Application Mode — engine mode always follows the cycle" style={{padding:"1px 6px",fontSize:8.5,fontWeight:700,color:C.txtMuted,background:"transparent",border:`1px solid ${C.border}`,borderRadius:3,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".4px"}}>LOCKED</span>
  )}
</div>);}

function HelpBox({children,title="ℹ️ How It Works"}){const[open,setOpen]=useState(false);return(<div style={{marginBottom:10}}>
  <button onClick={()=>setOpen(!open)} style={{background:"none",border:`1px solid ${C.accent}20`,borderRadius:5,padding:"5px 10px",cursor:"pointer",color:C.accent,fontSize:10,fontWeight:600,fontFamily:"monospace",letterSpacing:".5px",display:"flex",alignItems:"center",gap:5}}>
    <span style={{fontSize:12}}>{open?"▾":"▸"}</span>{title}</button>
  {open&&<div style={{...hs.box,marginTop:6}}>{children}</div>}</div>);}

function Tip({text,children}){const[show,setShow]=useState(false);return(<div style={{position:"relative",display:"inline-flex"}} onMouseEnter={()=>setShow(true)} onMouseLeave={()=>setShow(false)}>
  {children}{show&&<div style={{position:"absolute",bottom:"calc(100% + 6px)",left:"50%",transform:"translateX(-50%)",background:C.bg3,border:`1px solid ${C.accent}55`,borderRadius:5,padding:"6px 10px",fontSize:10.5,color:C.txt,fontFamily:"'Barlow',sans-serif",lineHeight:1.4,width:220,zIndex:99,boxShadow:"0 4px 16px rgba(0,0,0,.5)",pointerEvents:"none"}}>{text}</div>}</div>);}

function M({l,v,u,c,tip}){const box=(<div style={{padding:"8px 10px",background:`${c}0A`,border:`1px solid ${c}20`,borderRadius:5,flex:"1 1 110px",minWidth:100}}>
  <div style={{fontSize:9,color:C.txtDim,textTransform:"uppercase",letterSpacing:"1px",marginBottom:2,lineHeight:1.2,display:"flex",alignItems:"center",gap:3}}>{l}{tip&&<span style={{fontSize:8,color:C.accent,cursor:"help"}}>ⓘ</span>}</div>
  <div style={{fontSize:18,fontWeight:700,fontFamily:"monospace",color:c,lineHeight:1.1}}>{v}<span style={{fontSize:10,color:C.txtMuted,fontWeight:400,marginLeft:3}}>{u}</span></div></div>);
  return tip?<Tip text={tip}>{box}</Tip>:box;}

function CompEditor({title,comp,setComp,presets,speciesList,accent,helpText,initialPreset=""}){const[preset,setPreset]=useState(initialPreset);const[open,setOpen]=useState(true);const total=Object.values(comp).reduce((a,b)=>a+b,0);const loadPreset=name=>{if(presets[name]){const nc={};speciesList.forEach(sp=>nc[sp]=presets[name][sp]||0);setComp(nc);setPreset(name);}};return(
  <div style={{background:C.bg2,border:`1px solid ${accent}25`,borderRadius:8,marginBottom:10,overflow:"hidden"}}>
    <button onClick={()=>setOpen(!open)} style={{width:"100%",padding:"9px 12px",background:"none",border:"none",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",color:accent}}>
      <span style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:"1.5px"}}>{title}</span>
      <span style={{fontSize:13,transform:open?"rotate(0)":"rotate(-90deg)",transition:"transform .2s"}}>▾</span></button>
    {open&&<div style={{padding:"0 12px 10px"}}>
      {helpText&&<div style={{fontSize:9.5,color:C.txtMuted,lineHeight:1.5,marginBottom:6,fontStyle:"italic"}}>{helpText}</div>}
      <select style={S.sel} value={preset} onChange={e=>loadPreset(e.target.value)}>
        <option value="">— Select a Preset or Enter Custom —</option>{Object.keys(presets).map(k=><option key={k} value={k}>{k}</option>)}</select>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"5px 6px",marginTop:7}}>
        {speciesList.map(sp=>(<div key={sp} style={{display:"flex",alignItems:"center",gap:3,minWidth:0}}>
          <label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",width:30,textAlign:"right",flexShrink:0}}>{fmt(sp)}</label>
          {/* NumField formats to 3 decimals on blur but keeps the user's
              raw text while focused, so psychrometric humid-air values
              like 20.7286 display as a clean 20.729 without truncating
              anything the user types directly. */}
          <NumField value={comp[sp]||0} decimals={3}
            onCommit={v=>{setComp(prev=>({...prev,[sp]:Math.max(0,+v||0)}));setPreset("");}}
            style={{...S.inp,padding:"4px 4px",fontSize:11,width:"100%",minWidth:0,textAlign:"right"}}/></div>))}
      </div>
      <div style={{marginTop:5,fontSize:10,fontFamily:"monospace",color:Math.abs(total-100)<0.1?C.good:C.accent2,textAlign:"right"}}>Σ={total.toFixed(1)}%{Math.abs(total-100)>0.1?" ⚠ Must sum to 100%":""}</div>
    </div>}</div>);}

// Same theme-reactivity story as `hs` above — these styles bake in C.bg /
// C.border / C.txt / C.txtDim / C.bg2 which would otherwise freeze at
// module load. Wrapping in a Proxy makes S.card / S.sel / S.inp / S.cardT
// re-resolve on every theme toggle so cards repaint correctly when the
// user switches between dark and light.
let _sCache=null,_sCacheFor=null;
function _buildS(){return{
  sel:{width:"100%",padding:"6px 7px",background:C.bg,border:`1px solid ${C.border}`,borderRadius:4,color:C.txt,fontSize:11.5,fontFamily:"monospace",outline:"none"},
  inp:{width:"100%",padding:"6px 7px",background:C.bg,border:`1px solid ${C.border}`,borderRadius:4,color:C.txt,fontSize:11.5,fontFamily:"monospace",outline:"none",boxSizing:"border-box"},
  card:{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:8,padding:"14px 16px",marginBottom:12},
  cardT:{fontSize:9.5,fontWeight:700,color:C.txtDim,textTransform:"uppercase",letterSpacing:"1.5px",marginBottom:10},
  row:{display:"flex",gap:8,flexWrap:"wrap"},
};}
const S=new Proxy({},{get(_,key){if(_sCacheFor!==_activeC){_sCache=_buildS();_sCacheFor=_activeC;}return _sCache[key];}});

/* NumField — controlled numeric input that lets the user type freely.
   Internal text state while focused (no mid-typing truncation from parent
   .toFixed rounding); commits to parent on blur or Enter. When the parent
   value changes externally (e.g. slider), the displayed text re-syncs
   only if the field is not currently focused. */
function NumField({value,onCommit,decimals=4,style,title,disabled,...rest}){
  const fmt=v=>Number.isFinite(v)?String(+(+v).toFixed(decimals)):"";
  const[txt,setTxt]=useState(()=>fmt(value));
  const[focused,setFocused]=useState(false);
  useEffect(()=>{if(!focused)setTxt(fmt(value));},[value,focused,decimals]); // eslint-disable-line
  const commit=()=>{const n=parseFloat(txt);if(Number.isFinite(n))onCommit(n);else setTxt(fmt(value));};
  return(<input type="text" inputMode="decimal" value={txt} disabled={disabled} title={title} style={style}
    onChange={e=>setTxt(e.target.value)}
    onFocus={()=>setFocused(true)}
    onBlur={()=>{setFocused(false);commit();}}
    onKeyDown={e=>{if(e.key==="Enter"){e.target.blur();}}}
    {...rest}/>);
}

/* ══════════════════ HELP MODAL ══════════════════ */
function HelpModal({show,onClose}){if(!show)return null;
  const _h=(t)=>(<div style={{margin:"14px 0 6px",padding:"4px 0",borderBottom:`1px solid ${C.border}`,color:C.accent,fontSize:13,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".7px",textTransform:"uppercase"}}>{t}</div>);
  const _sub=(t)=>(<div style={{margin:"6px 0 2px",color:C.accent2,fontSize:11.5,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".5px"}}>{t}</div>);
  return(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.7)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={onClose}>
  <div style={{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:12,padding:"22px 26px",maxWidth:760,maxHeight:"85vh",overflowY:"auto",color:C.txt,fontFamily:"'Barlow',sans-serif",fontSize:12.5,lineHeight:1.65}} onClick={e=>e.stopPropagation()}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8,position:"sticky",top:0,background:C.bg3,paddingTop:2,paddingBottom:6,zIndex:1}}>
      <h2 style={{margin:0,fontSize:18,color:C.accent}}>Combustion Toolkit — User Guide</h2>
      <button onClick={onClose} style={{background:"none",border:"none",color:C.txtDim,fontSize:18,cursor:"pointer"}}>✕</button></div>
    <div style={{fontSize:12,color:C.txtDim,lineHeight:1.7}}>

      {_h("Quick Start")}
      <p>Pick an engine and set the operating point in the <strong>left sidebar</strong>, then open the panel you want. Most panels recompute live from the sidebar; the <strong>Combustor Mapping</strong> and <strong>Cycle</strong> panels also feed each other.</p>
      <p>Every interactive control on every panel has a <strong style={{color:C.accent}}>tooltip</strong> — hover or long-press any label, button, or input to see what it does. Look for the <strong>ⓘ</strong> icon next to labels for definitions.</p>

      {_h("Header Bar")}
      <p><strong>Unit toggle</strong> — flips the entire UI between SI (K, bar, m/s, MJ/kg) and English (°F, psia, ft/s, BTU/lb). Calculations stay in SI internally; this only changes display.</p>
      <p><strong>Application Mode picker</strong> — the button labeled <code>MODE: …</code>. Four choices: <em>Free</em> (combustion-only panels, in-browser reduced-order JS, accurate for φ ≤ 1.0), <em>Combustion Toolkit</em> (full Cantera combustion + DOE Automation, all φ regimes), <em>Gas Turbine Simulator</em> (Operations Summary + Cycle + LMS100 Mapping, Cantera-backed), and <em>Advanced Mode</em> (everything). The three non-Free modes require an active subscription. The mode banner directly under the tab bar describes the active choice.</p>
      <p><strong>Theme toggle</strong> — flips the entire UI between dark and light palettes. Affects on-screen panels and exported PNG figures. Persists across sessions.</p>
      <p><strong>Help (?)</strong> — this dialog. <strong>Export Excel</strong> — downloads two workbooks (one in SI, one in English) containing every input, output, sweep, and setting from every panel. <strong>Account</strong> — sign in / out, manage subscription.</p>

      {_h("Left Sidebar")}
      {_sub("Engine & Ambient")}
      <p><strong>Engine</strong> — currently calibrated for the LMS100PB+ DLE IC (intercooled, 107.5 MW @ 44 °F / 80% RH). Drives MW cap, T4 firing temperature, and the Combustor Mapping panel. Additional engines are in development.</p>
      <p><strong>Ambient P / T / RH</strong> — site conditions. The cycle uses these for compressor inlet density and humid-air properties.</p>
      <p><strong>Load %</strong> — gas turbine load. The big number in the green box. <strong>± buttons</strong> bump by the editable <strong>Step (%)</strong> just below — default 5, persists across reloads, accepts any integer 1–50. The slider also uses this step.</p>
      <p><strong>Intercooler coolant T</strong> — only shown for LMS100PB+. Sets the HPC inlet temperature (architectural intercooler benefit).</p>
      <p><strong>Combustor air fraction</strong> — flame-zone air ÷ total combustor inflow. Higher = leaner flame zone. Drives T_Bulk vs T4 split.</p>
      <p><strong>Bleed (Auto / Manual)</strong> — compressor bleed valve. <em>Auto</em> follows a load schedule. <em>Manual</em> exposes the open % slider with a chip-selectable step (1, 15, 30, 45, 60, 75, 90 %). Valve size sets the maximum bleed fraction at 100 % open.</p>
      <p><strong>Emissions Mode</strong> — when ON, the Combustor Mapping panel and Live Mapping use the BD7 staging ladder (DLE behavior). When OFF, the engine runs in BD4. In Live Mapping, toggling ON triggers a BD4→BD6→BD7 ramp; toggling OFF cancels any ramp in progress.</p>

      {_sub("Fuel & Oxidizer Composition")}
      <p>Pick a preset (Pipeline NG, Pure CH₄, etc.) or type custom mol % values. The total <strong>must sum to 100 %</strong> — the Σ indicator turns red if it doesn't. Compositions are shared across every panel.</p>

      {_sub("Operating Conditions (φ, T, P)")}
      <p><strong>φ</strong> — equivalence ratio. φ=1 stoichiometric, &lt;1 lean, &gt;1 rich. Sliders are clamped to physical ranges.</p>
      <p><strong>T_air, T_fuel</strong> — separate inlet temperatures. T_mixed at φ is computed from a 3-stream enthalpy balance (air + fuel + optional water).</p>
      <p><strong>Water/Fuel ratio (WFR)</strong> + radio (steam vs liquid) — water injection. Liquid mode absorbs h_fg from the flame; steam mode enters as gas at T_air. WFR = 0 disables water entirely.</p>

      {_sub("Linkages")}
      <p>Three checkboxes near the sidebar bottom: <strong>T3 ← Cycle T3</strong>, <strong>P3 ← Cycle P3</strong>, <strong>φ ← Cycle φ_Bulk</strong>. When ON, the sidebar values follow the most recent Cycle result automatically. Turn OFF to override manually.</p>

      {_h("Tabs")}

      {_sub("📈 Operations Summary")}
      <p>Single-glance dashboard: cycle MW, T3, P3, T4, T_Bulk, NOx15/CO15/PX36 at the current operating point. Pulls live from Cycle and Combustor Mapping. No inputs of its own — change conditions in the sidebar.</p>

      {_sub("🛠️ Cycle (Gas Turbine)")}
      <p>Anchored cycle deck for the LMS100PB+ DLE IC. <strong>Inputs</strong>: ambient, load, RH, intercooler coolant T, combustor air fraction, T_fuel, WFR, water mode, bleed. <strong>Outputs</strong>: every station state (1, 2, 2c, 3, 4, 5), MW_gross / MW_cap / MW_net, heat rate, η_LHV, fuel-flexibility derate (MWI), warnings. Additional engines are in development.</p>
      <p>Run <strong>Cycle</strong> → its results propagate through the linkages into every other panel.</p>

      {_sub("🎯 Combustor Mapping (LMS100 only)")}
      <p>4-circuit DLE correlation: per-circuit T_AFT (complete-combustion solve) plus a linear-anchored emissions / dynamics model centered on the LMS100 design point. <strong>Inputs</strong>: W36/W3 ratio, per-circuit air fractions (IP/OP/IM/OM), per-circuit φ (IP/OP/IM — OM is the residual). <strong>Outputs</strong>: NOx15, CO15, PX36_SEL, PX36_SEL_HI, plus stage-by-stage diagnostics (linear → φ_OP mult → P3 scaling).</p>
      <p><strong>Mapping Tables</strong> — editable φ-vs-T3 lookups for BRNDMD ∈ {"{2, 4, 6, 7}"}. Edits persist via localStorage. The <strong>Reset</strong> button is a bimodal switch between two named presets — <strong>UNMAPPED</strong> (raw factory lookups, the default seed for fresh sessions) and <strong>MAPPED</strong> (rig-calibrated lookups). The button label flips after each click to show which preset will load on the next click. <strong>Export to Excel</strong> writes the four BRNDMD lookups in their current state to a standalone .xlsx. Used to seed circuit φ inputs as ambient changes.</p>
      <p><strong>Emissions Transfer Function</strong> — per-BRNDMD post-multipliers on NOx, CO, and PX36_SEL. Trim knob; defaults to 1.0. Persists.</p>
      <p><strong>Live Mapping</strong> — real-time HMI-style trace dashboard. <strong>▶ Start</strong> begins a 2 Hz recording for up to 10 minutes. Six charts (PX36_SEL, PX36_SEL_HI, NOx15, CO15, MWI, MW Net) with sensor-realistic noise + first-order lag (each metric has its own deadtime and time constant). Per-chart <strong>y-axis Min/Max</strong> inputs persist; auto-extend if data exceeds your bounds.</p>
      <p style={{paddingLeft:14,borderLeft:`2px solid ${C.txtMuted}50`,fontSize:11,color:C.txtMuted}}>The Live Mapping plays out a stochastic plant model under the hood: PX36 spikes &gt; 5.5 trigger a 3-cycle protection sequence (BD4→BD6→BD7); rare φ_IP/φ_OP excursions trigger a full engine trip with a 4-hour lockout banner and a Reset button. Toggling Emissions Mode ON during mapping triggers the same staging ladder, ending at BD6 or BD7 depending on load. These behaviors are intentional and not under the operator's direct control — they exist to make the panel feel like a real control room.</p>

      {_sub("🔥 Flame Temp & Properties")}
      <p>Adiabatic flame temperature via energy balance with NASA polynomials. Two modes: <em>Complete combustion</em> (no dissociation) and <em>Equilibrium</em> (full dissociation). Outputs LHV / HHV (mass + volumetric), Wobbe Index, Modified Wobbe Index (MWI = LHV_vol / √(SG·T_fuel)), specific gravity, stoichiometric AFR, equilibrium products at T_ad. If Cycle has been run, also re-equilibrates products at T₄.</p>

      {_sub("🔬 Exhaust Analysis")}
      <p>Back-solves φ and T_ad from measured exhaust O₂ (dry) or CO₂ (dry) by inverting the equilibrium solver. Useful for tuning combustion mode against actual stack measurements. Two-pass solver: initial mix-T guess at φ=0.6, then refines. Two parallel inversions are reported — Chemical Equilibrium (with dissociation) and Complete Combustion (no dissociation). Equilibrium fits the flame zone with no dilution; complete combustion is the more physical assumption at the stack or after dilution where CO/OH/NO have cooled out of the dissociation regime.</p>
      <p><strong>Slip measurements (η_c).</strong> Optional inputs for measured CO, UHC (as CH₄), and H₂ in dry exhaust (ppmvd). When any are non-zero, the panel computes combustion efficiency via the energy-loss formula: η_c = 1 − (N_dry/fuel) · Σ(X_i · LHV_i,molar) / LHV_fuel,molar — same form as ASME PTC 4 / Lefebvre &amp; Ballal Ch. 9, NIST molar LHVs (CO 282.99, CH₄ 802.31, H₂ 241.83 kJ/mol). The slip-corrected display rescales the inversion: <strong>φ_fed = φ_burn / η_c</strong> (metered air-fuel ratio rises), <strong>FAR_fed = FAR_burn / η_c</strong>, <strong>AFR_fed = AFR_burn · η_c</strong>. The displayed Flame Temperature is <strong>T_ad,eff = equilibrium T at φ_eff = φ_burn · η_c</strong> — drops as slip rises, capturing the inefficiency penalty on flame temperature. At zero slip, η_c = 1 and the panel reduces to the burn-side inversion exactly.</p>
      <p><strong>Fuel &amp; Money.</strong> Enter fuel mass flow (default 40,000 lb/hr ≈ 5.04 kg/s) and fuel cost (USD/MMBTU on LHV basis, default $4.00). Pick the rollup period — week / month / year. The card reports air mass flow (= ṁ_fuel / FAR_fed), heat input (= ṁ_fuel · LHV_mass), total fuel cost / period, and <strong>Penalty / period (= Total · (1 − η_c))</strong> — money lost to slip. Anchored on the O₂-derived path since O₂ is the standard stack measurement. In Gas Turbine Simulator mode the Fuel Flow input is auto-locked to the Cycle ṁ_fuel; in Advanced mode it's linked but breakable via a 🔗 button next to the input.</p>

      {_sub("🏭 Combustor PSR → PFR")}
      <p>Reduced-order combustor: a Perfectly Stirred Reactor (primary zone, residence time τ_PSR) feeding a Plug Flow Reactor (burnout zone, length L_PFR at velocity V_PFR). Computes thermal NOx (extended Zeldovich) and CO burnout. The non-Free modes (Combustion Toolkit / Advanced) expose Cantera solver options: PSR seed (cold-ignited / hot-eq / unreacted / autoignition), equilibrium constraint (HP / UV / TP), integration strategy, heat-loss fraction, and kinetic mechanism (GRI-Mech 3.0 / Glarborg 2018).</p>
      <p><strong>Run sweep</strong> — 17-point load sweep across the full envelope, results plotted vs load. Cached per build SHA.</p>

      {_sub("⚡ Flame Speed & Blowoff")}
      <p>Laminar flame speed from Gülder / Metghalchi-Keck correlations (mixture-weighted). Blowoff via Damköhler comparison (τ_chem vs τ_flow). Premixer stability adds Zukoski blowoff time (τ_BO), Lewis-von Elbe critical gradient (g_c), and Spadaccini-Colket autoignition delay (τ_ign vs τ_res). The PREMIXER SAFE / RISK badge combines all four criteria.</p>

      {_sub("📚 Nomenclature")}
      <p>Single searchable index of every variable, output, and convention used anywhere in the app. Search by short symbol (NOx15, phi, Tad_CC), classical name (Equivalence Ratio, Wobbe), unit, or panel.</p>

      {_sub("📘 Assumptions")}
      <p>Single-page reference of every modeling assumption baked into the cycle and combustion solvers — ambient, humid air, compressor, intercooler, combustor, turbine, power & load, fuel properties, MWI derate, engine deck anchors, off-design scaling, and solver numerics. Mirrors the Assumptions sheet in the Excel export.</p>

      {_h("Export")}
      <p><strong>Export Excel</strong> downloads <strong>two</strong> .xlsx files in one click: <code>ProReadyEngineer_CombustionReport_SI.xlsx</code> and <code>..._English.xlsx</code>. Each file contains parallel sheets for Flame Temp, Flame Speed, Combustor Network, Exhaust, Cycle Results, Combustor Mapping, Mapping Tables, Thermo Database, Assumptions, and UI Settings — covering every input, output, sweep, and setting visible in the app.</p>

      {_h("Disclaimer")}
      <p style={{fontSize:11,color:C.warm}}><strong>This simulator may not be representative of the LMS100 engine behavior.</strong> All results are reduced-order approximations for educational and preliminary-estimation purposes. Not certified for design, permitting, or safety-critical decisions. See the footer for the full liability disclaimer.</p>

      <p style={{fontSize:10.5,color:C.txtMuted,marginTop:14}}>Calculations use NASA Glenn thermodynamic polynomials, Gülder / Metghalchi-Keck flame speed correlations, global Arrhenius kinetics, extended Zeldovich NOx, Cantera GRI-Mech 3.0 / Glarborg 2018 (Combustion Toolkit / Advanced modes), and an LMS100 4-circuit DLE correlation anchored to the design point.</p>
    </div></div></div>);}

function PricingModal({show,onClose,onRequestSignin}){if(!show)return null;
  const {isAuthenticated,subscription}=useAuth();
  const [busy,setBusy]=useState(false);
  const [err,setErr]=useState(null);
  const currentTier=subscription?.tier||"free";
  const tiers=[
    {id:"free",name:"Free",price:"$0",period:"",features:["Online use at combustion-toolkit.proreadyengineer.com","Simplified model — accurate for φ ≤ 1.0 only","Flame temperature accuracy within 20 °F vs Cantera","All 5 calculation panels + Excel export","NOT suitable for RQL or SAC combustion"],accent:C.txtDim},
    {id:"download",name:"Accurate — Download",price:"$100",period:"/year",features:["Downloadable desktop app","macOS, Windows, and Linux","Bundles Cantera — runs fully offline","Exact results across all φ","Excel export","1-year license, renewable"],accent:C.accent,cta:"Get Download"},
    {id:"full",name:"Download + Online",price:"$150",period:"/year",features:["Everything in Download tier","PLUS access to the Cantera-powered online version","Runs at combustion-toolkit.proreadyengineer.com","Same exact accuracy as local","Use anywhere, no install required"],accent:C.accent2,cta:"Get Both",best:true}
  ];
  const handleBuy=async(tier)=>{
    if(!isAuthenticated){onClose();onRequestSignin("signup");return;}
    setBusy(true);setErr(null);
    try{const {checkout_url}=await api.createCheckout(tier);window.location.href=checkout_url;}
    catch(e){setErr(e.message||"Failed to start checkout. Please try again.");setBusy(false);}
  };
  return(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.8)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20,overflowY:"auto"}} onClick={onClose}>
    <div onClick={e=>e.stopPropagation()} style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:12,padding:"28px 28px 22px",maxWidth:1040,width:"100%",color:C.txt,fontFamily:"'Barlow',sans-serif"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
        <div>
          <div style={{fontSize:22,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".5px",color:C.txt}}>Pricing</div>
          <div style={{fontSize:12,color:C.txtDim,marginTop:4,lineHeight:1.5}}>Upgrade for exact Cantera-backed results — no φ cap, full rich/staged combustion accuracy.</div>
        </div>
        <button onClick={onClose} style={{background:"transparent",border:"none",color:C.txtDim,fontSize:24,cursor:"pointer",padding:"0 8px",lineHeight:1}}>×</button>
      </div>
      {err&&<div style={{padding:"10px 14px",fontSize:11.5,color:"#ff6b6b",background:"#ff6b6b15",border:"1px solid #ff6b6b40",borderRadius:6,marginBottom:14,fontFamily:"monospace"}}>{err}</div>}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(260px,1fr))",gap:14}}>
        {tiers.map(t=>{const isCurrent=currentTier===t.id;const isUpgrade=currentTier==="download"&&t.id==="full";return(<div key={t.id} style={{background:C.bg3,border:`1px solid ${t.best?t.accent:C.border}`,borderRadius:10,padding:"22px 20px",position:"relative"}}>
          {t.best&&<div style={{position:"absolute",top:-11,right:16,background:t.accent,color:C.bg,padding:"3px 11px",fontSize:9,fontWeight:700,letterSpacing:"1.5px",textTransform:"uppercase",borderRadius:4,fontFamily:"'Barlow Condensed',sans-serif"}}>Best Value</div>}
          <div style={{fontSize:11,fontWeight:700,color:t.accent,textTransform:"uppercase",letterSpacing:"1.5px",marginBottom:10,fontFamily:"'Barlow Condensed',sans-serif"}}>{t.name}</div>
          <div style={{marginBottom:16}}>
            <span style={{fontSize:32,fontWeight:700,color:C.txt,fontFamily:"'Barlow Condensed',sans-serif"}}>{t.price}</span>
            <span style={{fontSize:13,color:C.txtDim,marginLeft:4}}>{t.period}</span>
          </div>
          <ul style={{listStyle:"none",padding:0,margin:"0 0 18px",fontSize:11.5,lineHeight:1.7,color:C.txt}}>
            {t.features.map(f=>(<li key={f} style={{paddingLeft:18,position:"relative",marginBottom:5}}><span style={{position:"absolute",left:0,color:t.accent,fontWeight:700}}>✓</span>{f}</li>))}
          </ul>
          {isCurrent
            ?<div style={{padding:"10px 14px",fontSize:11,fontWeight:600,textAlign:"center",color:C.txtDim,background:"transparent",border:`1px solid ${C.border}`,borderRadius:6,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".5px"}}>CURRENT PLAN</div>
            :t.id==="free"
              ?<div style={{padding:"10px 14px",fontSize:11,fontWeight:600,textAlign:"center",color:C.txtDim,background:"transparent",border:`1px solid ${C.border}`,borderRadius:6,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".5px"}}>INCLUDED — NO SIGNUP NEEDED</div>
              :<button disabled={busy} onClick={()=>handleBuy(t.id)} style={{width:"100%",padding:"11px 14px",fontSize:12,fontWeight:700,color:C.bg,background:t.accent,border:"none",borderRadius:6,cursor:busy?"wait":"pointer",opacity:busy?0.6:1,letterSpacing:".5px",fontFamily:"'Barlow Condensed',sans-serif"}}>{busy?"...":(isUpgrade?"Upgrade to Full":t.cta)} →</button>}
        </div>);})}
      </div>
      <div style={{marginTop:16,padding:"11px 14px",background:C.bg,borderRadius:6,fontSize:10.5,color:C.txtDim,fontFamily:"monospace",textAlign:"center"}}>All paid tiers: 1-year license, renew annually. Questions? Email <a href="mailto:sales@proreadyengineer.com" style={{color:C.accent}}>sales@proreadyengineer.com</a></div>
    </div>
  </div>);}

/* ══════════════════ ACCURATE-MODE HOOK ══════════════════ */
// Fires a backend Cantera call when `enabled`. Returns { data, loading, error }.
// `args` is serialized as a key so changes trigger a new call.
// A 300 s hard timeout guards against a hung solver locking the busy overlay
// forever (Render's HTTP ceiling is 600 s; the backend solver pool uses 540 s;
// 300 s client-side is the shortest reasonable ceiling that still lets long
// sweeps finish).
const BACKEND_CALC_TIMEOUT_MS = 300_000;
// Per-panel in-line "calculations updating" banner — INTENTIONALLY DISABLED.
// The global BusyOverlay (rendered once by BusyProvider, fixed top-of-screen)
// already communicates "calculating, please wait" any time a Cantera call is
// in flight, anywhere in the app. Showing the same message twice (overlay +
// inline panel banner) was noisy, so this component is now a no-op stub.
// Call sites still pass `loading` for future flexibility, but nothing renders.
function InlineBusyBanner(){ return null; }

// Reusable per-panel control: "Stay activated when navigating away" checkbox.
// The activation flag itself lives in App so it can survive tab nav; this
// toggle stores the user preference (in localStorage, owned by App) so the
// auto-deactivate-on-nav effect knows whether to skip itself for this panel.
// Browser restart never persists the activation flag, only the preference.
function KeepActivatedToggle({on,onChange,panelLabel="this panel"}){
  return(<label
    title={on
      ? `STAY-ACTIVATED is ON. ${panelLabel} will keep its activation state when you switch tabs. Browser restart still resets it to deactivated.`
      : `STAY-ACTIVATED is OFF (default). ${panelLabel} auto-deactivates when you switch tabs and you must click ACTIVATE again on return. Toggle on to keep it running across navigation.`}
    style={{display:"flex",alignItems:"center",gap:8,padding:"6px 12px",
      background:on?`${C.accent}10`:"transparent",
      border:`1px solid ${on?C.accent+"60":C.border}`,
      borderRadius:5,cursor:"pointer",userSelect:"none",
      fontFamily:"'Barlow',sans-serif",fontSize:11,color:on?C.accent:C.txtDim}}>
    <input type="checkbox" checked={on} onChange={e=>onChange&&onChange(e.target.checked)}
      style={{accentColor:C.accent,cursor:"pointer",margin:0}}/>
    <span style={{fontWeight:700,letterSpacing:".4px",fontFamily:"'Barlow Condensed',sans-serif",
      textTransform:"uppercase",fontSize:10.5}}>
      Stay activated when navigating away
    </span>
    <span style={{color:C.txtMuted,fontSize:10,fontStyle:"italic"}}>
      {on ? "(survives tab switch · resets on browser restart)" : "(default — deactivates on tab switch)"}
    </span>
  </label>);
}

// Export button that auto-disables while any Cantera calculation is in flight
// (reading BusyCtx.tasks). Prevents the user from exporting a stale snapshot
// while inputs are still being re-calculated.
function BusyGuardedExportButton({onExport}){
  const {tasks}=useContext(BusyCtx);
  const busy=tasks.length>0;
  return(<button
    onClick={()=>{if(!busy)onExport();}}
    disabled={busy}
    title={busy?"Calculations in progress — export is disabled until all Cantera calls settle.":"Export all panels to a comprehensive .xlsx report"}
    style={{padding:"6px 14px",fontSize:11,fontWeight:600,fontFamily:"'Barlow Condensed',sans-serif",
      color:busy?C.txtMuted:C.bg,
      background:busy?"transparent":C.accent2,
      border:busy?`1px solid ${C.border}`:"none",
      borderRadius:6,cursor:busy?"not-allowed":"pointer",letterSpacing:".5px",
      display:"flex",alignItems:"center",gap:5,opacity:busy?0.55:1}}>
    {busy?
      <span style={{display:"inline-block",width:11,height:11,border:`2px solid ${C.txtMuted}`,borderTopColor:"transparent",borderRadius:"50%",animation:"ctkspin 0.85s linear infinite"}}/>:
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 12h12M8 2v8M5 7l3 3 3-3" stroke={C.bg} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>}
    {busy?"Waiting for Cantera…":"Export Excel"}
  </button>);
}

// Module-level LRU cache for useBackendCalc, persisted to localStorage and
// keyed by build SHA. Identical {kind,args} requests served instantly from
// cache; persistence survives tab close, browser restart, and machine reboot.
//
// Build-hash keying: every entry is namespaced by the current build's git
// SHA (injected at build time via vite.config.js → __BUILD_SHA__). When a
// new build ships, the localStorage key changes — old caches become
// unreachable and are pruned on next load. Users never see stale science
// from before a backend or frontend deploy.
//
// Defensive against:
//   - localStorage quota exceeded (try/catch around writes)
//   - localStorage disabled (private browsing) — falls back to in-memory
//   - git failure at build (vite.config.js falls back to timestamp)
//   - two-tab concurrent writes (last-write-wins; minor entry loss)
//   - errors are NEVER cached (only the .then path stores)
//
// Cache-version sentinel — bump this when a backend response shape OR the
// numeric correctness of any cached endpoint changes, even when the
// frontend build SHA wouldn't otherwise change. This forces every client
// to drop stale entries on next load. Last bump: exhaust T_ad fix v2.
const __BK_CACHE_VERSION = "v6-bm-hawkes-le";
const __BK_BUILD = (typeof __BUILD_SHA__ !== "undefined") ? __BUILD_SHA__ : "dev";
const __BK_LS_KEY = `ctk_bk_cache_${__BK_BUILD}_${__BK_CACHE_VERSION}`;
const __BK_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days
const __BK_MAX = 100;
const __BK_INFLIGHT = new Map();        // key -> Promise<data>

// Load persisted cache on module init. Also prune any other ctk_bk_cache_*
// keys from previous builds (atomic invalidation on deploy).
function __bkLoad(){
  const m = new Map();
  try {
    // Prune stale-build entries
    const stale = [];
    for(let i = 0; i < localStorage.length; i++){
      const k = localStorage.key(i);
      if(k && k.startsWith("ctk_bk_cache_") && k !== __BK_LS_KEY) stale.push(k);
    }
    stale.forEach(k => { try { localStorage.removeItem(k); } catch {} });
    // Load current-build cache
    const raw = localStorage.getItem(__BK_LS_KEY);
    if(raw){
      const parsed = JSON.parse(raw);
      const now = Date.now();
      for(const [k, e] of parsed){
        if(e && (now - e.ts) <= __BK_TTL_MS) m.set(k, e);
      }
    }
  } catch {}
  return m;
}
const __BK_CACHE = __bkLoad();

// Debounced flush to localStorage. Each set() schedules one timer; the
// timer serializes the WHOLE map (so multiple rapid writes coalesce into
// one localStorage write). On quota error, silently fall back to memory-only.
let __bkSaveTimer = null;
function __bkSave(){
  if(__bkSaveTimer) clearTimeout(__bkSaveTimer);
  __bkSaveTimer = setTimeout(() => {
    __bkSaveTimer = null;
    try {
      localStorage.setItem(__BK_LS_KEY, JSON.stringify([...__BK_CACHE]));
    } catch {
      // Quota exceeded or localStorage disabled — drop persistence silently.
      // The in-memory cache still works for the rest of this session.
    }
  }, 1000);
}

function __bkCacheGet(key){
  const e = __BK_CACHE.get(key);
  if(!e) return null;
  if(Date.now() - e.ts > __BK_TTL_MS){ __BK_CACHE.delete(key); __bkSave(); return null; }
  // touch for LRU
  __BK_CACHE.delete(key); __BK_CACHE.set(key, e);
  return e.data;
}
function __bkCacheSet(key, data){
  __BK_CACHE.set(key, {data, ts: Date.now()});
  if(__BK_CACHE.size > __BK_MAX){
    const oldest = __BK_CACHE.keys().next().value;
    __BK_CACHE.delete(oldest);
  }
  __bkSave();
}

// Wipe the in-memory cache + the persisted localStorage entry for this
// build. Use when the user wants to force every backend call to re-fire
// from scratch (e.g. after a backend deploy that changed correlation
// internals but kept the same /calc/* signature).
function bkClearCache(){
  __BK_CACHE.clear();
  __BK_INFLIGHT.clear();
  try {
    // Sweep all build-versioned keys, not just the current one.
    const stale = [];
    for(let i = 0; i < localStorage.length; i++){
      const k = localStorage.key(i);
      if(k && k.startsWith("ctk_bk_cache_")) stale.push(k);
    }
    stale.forEach(k => { try { localStorage.removeItem(k); } catch {} });
  } catch {}
}

// Direct cached fetch — same cache + in-flight dedup as useBackendCalc, but
// usable from imperative code (e.g. the OperationsSummaryPanel load sweep
// loop that calls api.calcCycle / api.calcAFT / api.calcCombustorMapping
// in sequence). Identical {kind,args} returns instantly from the persisted
// cache; concurrent identical requests share a single network call.
// Build a cache key that's INSENSITIVE to harmless float jitter. Two args
// that are physically identical (e.g. WFR=0 vs WFR=0.0 vs WFR=1e-12) used
// to produce different cache keys and miss the cache. Round all numbers to
// 8 significant figures (well below any meaningful physics resolution),
// recurse into objects, sort object keys for stable output. Strings, bools,
// nulls pass through unchanged.
const _normalizeForCacheKey = (v) => {
  if (v === null || v === undefined) return v;
  if (typeof v === "number"){
    if (!Number.isFinite(v)) return v;
    if (v === 0) return 0;
    // 8 sig figs via toPrecision then back to number to drop trailing zeros.
    return +v.toPrecision(8);
  }
  if (Array.isArray(v)) return v.map(_normalizeForCacheKey);
  if (typeof v === "object"){
    const sorted = {};
    for (const k of Object.keys(v).sort()) sorted[k] = _normalizeForCacheKey(v[k]);
    return sorted;
  }
  return v;
};
const _bkCacheKey = (kind, args) =>
  `${kind}:${JSON.stringify(_normalizeForCacheKey(args || {}))}`;

async function bkCachedFetch(kind, args){
  const fn = {aft:api.calcAFT, flame:api.calcFlameSpeed, combustor:api.calcCombustor,
    exhaust:api.calcExhaust, props:api.calcProps, autoignition:api.calcAutoignition,
    cycle:api.calcCycle, combustor_mapping:api.calcCombustorMapping,
    solve_phi_tflame:api.calcSolvePhiForTflame}[kind];
  if(!fn) throw new Error(`bkCachedFetch: unknown kind ${kind}`);
  const cacheKey = _bkCacheKey(kind, args);
  const cached = __bkCacheGet(cacheKey);
  if(cached) return cached;
  let promise = __BK_INFLIGHT.get(cacheKey);
  if(!promise){
    promise = fn(args);
    __BK_INFLIGHT.set(cacheKey, promise);
    promise.finally(()=>{ __BK_INFLIGHT.delete(cacheKey); });
  }
  const data = await promise;
  __bkCacheSet(cacheKey, data);
  return data;
}

function useBackendCalc(kind, args, enabled){
  const [data,setData]=useState(null);const[loading,setLoading]=useState(false);const[err,setErr]=useState(null);
  const {begin}=useContext(BusyCtx);
  // Normalized key: shared with bkCachedFetch so React-driven and async-
  // imperative calls hit the same cache entry. Prevents float-jitter misses.
  const cacheKey = _bkCacheKey(kind, args);
  const key = cacheKey;  // legacy alias: useEffect deps array uses `key`
  useEffect(()=>{
    if(!enabled){setData(null);setErr(null);setLoading(false);return;}
    const fn={aft:api.calcAFT,flame:api.calcFlameSpeed,combustor:api.calcCombustor,exhaust:api.calcExhaust,props:api.calcProps,autoignition:api.calcAutoignition,cycle:api.calcCycle,combustor_mapping:api.calcCombustorMapping,solve_phi_tflame:api.calcSolvePhiForTflame}[kind];
    if(!fn){return;}
    // ── Cache hit: serve immediately, no network call, no busy spinner ──
    const cached = __bkCacheGet(cacheKey);
    if(cached){ setData(cached); setLoading(false); setErr(null); return; }
    let cancelled=false;setLoading(true);setErr(null);
    const endBusy=begin(BUSY_LABELS[kind]||kind);
    let ended=false;const safeEnd=()=>{if(!ended){ended=true;endBusy();}};
    const timeoutId=setTimeout(()=>{
      if(!cancelled){
        cancelled=true;
        setErr(`Request timed out after ${BACKEND_CALC_TIMEOUT_MS/1000}s. The solver may be under load; try again or simplify inputs.`);
        setLoading(false);setData(null);
      }
      safeEnd();
    },BACKEND_CALC_TIMEOUT_MS);
    // In-flight dedup: if an identical request is already pending, wait on it.
    let promise = __BK_INFLIGHT.get(cacheKey);
    if(!promise){
      promise = fn(args);
      __BK_INFLIGHT.set(cacheKey, promise);
      promise.finally(()=>{ __BK_INFLIGHT.delete(cacheKey); });
    }
    promise.then(d=>{clearTimeout(timeoutId);__bkCacheSet(cacheKey,d);if(!cancelled){setData(d);setLoading(false);}safeEnd();})
           .catch(e=>{clearTimeout(timeoutId);if(!cancelled){setErr(e.message||String(e));setLoading(false);setData(null);}safeEnd();});
    return()=>{cancelled=true;clearTimeout(timeoutId);safeEnd();};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[enabled,key,kind]);
  return{data,loading,err};
}

// Global busy tracker: any Cantera call (auto-fired via useBackendCalc, or manually-fired
// like the flame-speed sweep button) registers a task here. The overlay reads `tasks`
// and renders a large fixed-position banner while the list is non-empty — the banner
// disappears automatically once every task's promise settles. Fresh ids per begin() call
// allow multiple concurrent tasks of the same kind to coexist safely.
export function BusyProvider({children}){
  const[tasks,setTasks]=useState([]);
  const begin=useCallback((label)=>{
    const id=Math.random().toString(36).slice(2)+Date.now().toString(36);
    setTasks(ts=>[...ts,{id,label,t0:Date.now()}]);
    return()=>setTasks(ts=>ts.filter(x=>x.id!==id));
  },[]);
  const value=useMemo(()=>({begin,tasks}),[begin,tasks]);
  return <BusyCtx.Provider value={value}>{children}<BusyOverlay tasks={tasks}/></BusyCtx.Provider>;
}
function BusyOverlay({tasks}){
  const[tick,setTick]=useState(0);
  useEffect(()=>{if(tasks.length===0)return;const id=setInterval(()=>setTick(t=>t+1),500);return()=>clearInterval(id);},[tasks.length]);
  if(tasks.length===0)return null;
  const labels=[...new Set(tasks.map(t=>t.label))];
  const oldest=Math.max(...tasks.map(t=>Date.now()-t.t0));
  const secs=(oldest/1000).toFixed(1);
  return(<div style={{position:"fixed",top:16,left:"50%",transform:"translateX(-50%)",zIndex:99999,minWidth:440,maxWidth:680,padding:"14px 22px",background:C.bg2,border:`2px solid ${C.accent}`,borderRadius:10,boxShadow:`0 8px 32px rgba(0,0,0,.6), 0 0 0 4px ${C.accent}22`,fontFamily:"'Barlow',sans-serif",color:C.txt,pointerEvents:"none"}}
    data-tick={tick}>
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
      <span style={{display:"inline-block",width:14,height:14,border:`2.5px solid ${C.accent}`,borderTopColor:"transparent",borderRadius:"50%",animation:"ctkspin 0.85s linear infinite"}}/>
      <span style={{fontSize:15,fontWeight:700,letterSpacing:".5px",color:C.accent,fontFamily:"'Barlow Condensed',sans-serif"}}>CALCULATING — PLEASE WAIT</span>
      <span style={{fontSize:11,color:C.txtMuted,fontFamily:"monospace",marginLeft:"auto"}}>{secs}s</span>
    </div>
    <div style={{fontSize:11.5,color:C.txtDim,lineHeight:1.5,marginBottom:6}}>
      The calculation is still running. This banner will disappear automatically when it completes — please wait until then before reading any numbers on the page or exporting.
    </div>
    <ul style={{margin:"4px 0 6px 18px",padding:0,fontSize:11,color:C.txt,fontFamily:"monospace",lineHeight:1.55}}>
      {labels.map(l=><li key={l}>{l}</li>)}
    </ul>
    <div style={{fontSize:10.5,color:C.txtMuted,fontStyle:"italic"}}>This box will disappear automatically once the calculations are complete.</div>
    <style>{`@keyframes ctkspin{to{transform:rotate(360deg)}}`}</style>
  </div>);
}

// Only non-zero species so we don't ship a 30-key object for a 2-key input.
function nonzero(obj){const o={};for(const k in obj){if(obj[k]>0)o[k]=obj[k];}return o;}

// Atm -> bar
const atmToBar=(P)=>P*1.01325;

// Convert backend AFTResponse {mole_fractions:{CH4:0.0053,...}} to local format {products:{CH4:0.53,...}}
function adaptBackendAFT(r){
  if(!r)return null;
  const products={};for(const[k,v]of Object.entries(r.mole_fractions||{})){if(v>1e-5)products[k]=v*100;}
  // Optional secondary equilibrium at T4 (turbine-inlet T). Only present when the request
  // included T_products_K and the backend successfully re-equilibrated at that T.
  const _at_T={};for(const[k,v]of Object.entries(r.mole_fractions_at_T_products||{})){if(v>1e-5)_at_T[k]=v*100;}
  const productsAtT4=Object.keys(_at_T).length?_at_T:null;
  // Complete-combustion companion (no-dissociation reference — matches diluted
  // combustor-exit / stack measurements better than full equilibrium).
  const productsComplete={};for(const[k,v]of Object.entries(r.mole_fractions_complete||{})){if(v>1e-5)productsComplete[k]=v*100;}
  return{T_ad:r.T_actual||r.T_ad,products,productsAtT4,T_products_K:r.T_products_K||null,
    T_ad_complete:r.T_ad_complete||null,productsComplete:Object.keys(productsComplete).length?productsComplete:null,
    fromBackend:true};
}

/* ══════════════════ PANELS ══════════════════ */
function AFTPanel({fuel,ox,phi,T0,P,Tfuel,WFR=0,waterMode="liquid",combMode,setCombMode,T4_K}){
  const units=useContext(UnitCtx);
  const {accurate}=useContext(AccurateCtx);
  const Tair=T0;
  // Adiabatic fuel/air mix temperature at the user's current phi. If T_fuel==T_air
  // this collapses to T0 (old single-inlet behavior).
  const Tmix=useMemo(()=>mixT(fuel,ox,phi,Tfuel,Tair),[fuel,ox,phi,Tfuel,Tair]);
  const localResult=useMemo(()=>calcAFTx(fuel,ox,phi,Tmix,P,combMode),[fuel,ox,phi,Tmix,P,combMode]);
  // T4 (turbine-inlet) is plumbed in from the cycle. When present we pass it to the
  // backend so it returns a second equilibrium at T4 (cooled-products composition the
  // turbine actually sees), and we re-equilibrate locally for the free-mode path below.
  const T4_for_backend=(T4_K&&T4_K>0)?T4_K:null;
  const bk=useBackendCalc("aft",{fuel:nonzero(fuel),oxidizer:nonzero(ox),phi,T0,P:atmToBar(P),mode:"adiabatic",heat_loss_fraction:0,T_fuel_K:Tfuel,T_air_K:Tair,WFR,water_mode:waterMode,T_products_K:T4_for_backend},accurate);
  const adapted=adaptBackendAFT(bk.data);
  const result=accurate&&adapted?adapted:localResult;
  // Free-mode equilibrium at T4: same elemental composition as the local AFT solution,
  // but re-equilibrated at the (cooler) turbine-inlet temperature. Uses the existing
  // 6-reaction Newton solver; pass mole fractions (sum≈1) as the consistent basis.
  const productsAtT4Free=useMemo(()=>{
    if(accurate||!T4_for_backend||!localResult||!localResult.products)return null;
    const prod0={};for(const[sp,pct]of Object.entries(localResult.products))prod0[sp]=pct/100;
    const isRich=phi>1;
    try{
      const eq=equilibrateAtT(prod0,T4_for_backend,P,isRich);
      const tot=Object.values(eq).reduce((a,b)=>a+Math.max(0,b),0);
      if(!(tot>0))return null;
      const out={};for(const[sp,n]of Object.entries(eq)){if(n>0&&n/tot>1e-5)out[sp]=n/tot*100;}
      return Object.keys(out).length?out:null;
    }catch(e){return null;}
  },[accurate,T4_for_backend,localResult,phi,P]);
  // Decide which product mix to display in the Equilibrium Products card. Prefer Cantera-
  // at-T4 when available, fall back to free-mode-at-T4, then to T_ad equilibrium.
  const productsAtT4=accurate?(adapted&&adapted.productsAtT4):productsAtT4Free;
  const productsForDisplay=productsAtT4||result?.products;
  const usingT4=!!productsAtT4&&!!T4_for_backend;
  // Sweep recomputes T_mixed at each phi since Z (fuel-stream mass fraction) depends on phi.
  const sweep=useMemo(()=>{const out=[];for(let p=0.3;p<=1.01;p+=0.02){const Tm=mixT(fuel,ox,p,Tfuel,Tair);const a=calcAFTx(fuel,ox,p,Tm,P,combMode);out.push({phi:+p.toFixed(2),T_ad:uv(units,"T",a.T_ad)});}return out;},[fuel,ox,Tfuel,Tair,P,combMode,units]);
  const props=useMemo(()=>calcFuelProps(fuel,ox),[fuel,ox]);
  const mk=result?{x:phi,y:uv(units,"T",result.T_ad),label:`${uv(units,"T",result.T_ad).toFixed(0)} ${uu(units,"T")}`}:null;
  const modeToggle=<div style={{display:"flex",border:`1px solid ${C.border}`,borderRadius:5,overflow:"hidden",marginBottom:10,opacity:accurate?0.4:1}}>
    {["complete","equilibrium"].map(m=><button key={m} disabled={accurate} onClick={()=>setCombMode(m)} title={accurate?"Disabled in Accurate mode — Cantera performs full-species Gibbs equilibrium (all 53 GRI-Mech species), which supersedes the Complete / 4-reaction-Equilibrium toggle used in Free mode.":undefined} style={{padding:"6px 12px",fontSize:10.5,fontWeight:combMode===m?700:400,color:combMode===m?C.bg:C.txtDim,background:combMode===m?C.accent:"transparent",border:"none",cursor:accurate?"not-allowed":"pointer",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".4px",transition:"all .15s"}}>{m==="complete"?"Complete Combustion":"Chemical Equilibrium"}</button>)}
  </div>;
  const statusBadge=accurate?(
    bk.loading?<span style={{fontSize:10,color:C.accent2,marginLeft:8,fontFamily:"monospace"}}>⟳ CANTERA…</span>:
    bk.err?<span style={{fontSize:10,color:C.warm,marginLeft:8,fontFamily:"monospace"}}>⚠ BACKEND ERROR — {bk.err}</span>:
    adapted?<span style={{fontSize:10,color:C.accent,marginLeft:8,fontFamily:"monospace",fontWeight:700}}>✓ CANTERA</span>:null
  ):null;
  return(<div style={{display:"flex",flexDirection:"column",gap:12}}>
    <InlineBusyBanner loading={accurate&&bk.loading}/>
    <HelpBox title="ℹ️ Flame Temperature & Properties — How It Works"><p style={{margin:"0 0 6px"}}>This panel computes the <span style={hs.em}>adiabatic flame temperature</span> for the fuel and oxidizer in your sidebar at the equivalence ratio (φ) you set.</p><p style={{margin:"0 0 6px"}}><span style={hs.em}>You change:</span> φ, T_air, T_fuel, P, and water injection in the sidebar — plus the calculation mode toggle (Complete Combustion vs Chemical Equilibrium).</p><p style={{margin:"0 0 6px"}}><span style={hs.em}>You get:</span> flame temperature T_ad, full equilibrium product composition (wet and dry), fuel heating values (LHV / HHV, mass and volumetric), Wobbe and Modified Wobbe Index, specific gravity, and stoichiometric AFR.</p><p style={{margin:0,fontSize:11,color:C.txtMuted}}>Methodology, polynomial sources, and modeling assumptions live in the <strong>Assumptions</strong> tab.</p></HelpBox>
    {modeToggle}
    {Math.abs(Tfuel-Tair)>0.5&&<div style={{background:`${C.accent}0F`,border:`1px solid ${C.accent}44`,borderRadius:5,padding:"6px 10px",fontSize:10.5,color:C.txtDim,fontFamily:"monospace"}}>T_fuel={uv(units,"T",Tfuel).toFixed(0)} {uu(units,"T")} + T_air={uv(units,"T",Tair).toFixed(0)} {uu(units,"T")} → adiabatic mix at φ={phi.toFixed(2)} → <span style={{color:C.accent,fontWeight:700}}>T_mixed={uv(units,"T",Tmix).toFixed(0)} {uu(units,"T")}</span> (fed to equilibrium)</div>}
    {/* ────── Card 1: Fuel Properties — composition + T_fuel only ────── */}
    <div style={S.card}><div style={S.cardT}>Fuel Properties</div>
      <div style={{fontSize:9.5,color:C.txtMuted,marginBottom:8}}>Functions of fuel composition (and T_fuel for MWI) only — independent of φ, oxidizer, or flame temperature.</div>
      <div style={{...S.row,gap:8}}>
        <M l="LHV (mass basis)" v={uv(units,"energy_mass",props.LHV_mass).toFixed(units==="SI"?1:0)} u={uu(units,"energy_mass")} c={C.accent2} tip="Lower Heating Value per unit mass. Water in products remains as vapor. Used for gas turbine calculations."/>
        <M l="LHV (volumetric)" v={uv(units,"energy_vol",props.LHV_vol).toFixed(units==="SI"?1:0)} u={uu(units,"energy_vol")} c={C.accent2} tip="Lower Heating Value per unit volume at STP (15°C, 1 atm). Key parameter for gas metering and burner sizing."/>
        <M l="HHV (mass basis)" v={uv(units,"energy_mass",props.HHV_mass).toFixed(units==="SI"?1:0)} u={uu(units,"energy_mass")} c={C.orange} tip="Higher Heating Value per unit mass. Includes latent heat of water condensation. Used for boiler efficiency calculations."/>
        <M l="HHV (volumetric)" v={uv(units,"energy_vol",props.HHV_vol).toFixed(units==="SI"?1:0)} u={uu(units,"energy_vol")} c={C.orange} tip="Higher Heating Value per unit volume at STP. Used in gas utility billing and furnace sizing."/>
        <M l="Fuel Molecular Weight" v={props.MW_fuel.toFixed(2)} u="g/mol" c={C.accent3} tip="Mole-fraction-weighted average molecular weight of the fuel mixture."/>
        <M l="Specific Gravity" v={props.SG.toFixed(3)} u="—" c={C.accent3} tip="Ratio of fuel MW to standard air MW (28.97). SG > 1 means heavier than air."/>
        <M l="Wobbe Index" v={uv(units,"energy_vol",props.WI).toFixed(0)} u={uu(units,"energy_vol")} c={C.violet} tip="WI = HHV_vol / √SG. Measures fuel interchangeability — fuels with similar WI can be swapped without re-tuning burners. Pure fuel-composition property."/>
        <M l="Modified Wobbe Index (MWI)" v={(units==="SI"?props.LHV_vol/Math.sqrt(Math.max(props.SG,1e-9)*Tfuel):(props.LHV_vol*26.839)/Math.sqrt(Math.max(props.SG,1e-9)*Tfuel*1.8)).toFixed(units==="SI"?3:2)} u={units==="SI"?"MJ/m³·√K":"BTU/scf·√°R"} c={C.violet} tip={`MWI = LHV_vol / √(SG × T_fuel).  Uses your fuel temperature directly (no reference-T ratio), so units carry √T. SI: LHV in MJ/m³, T in K → MJ/m³·√K.  ENG: LHV in BTU/scf, T in °R → BTU/scf·√°R.  Evaluated at T_fuel = ${uv(units,"T",Tfuel).toFixed(0)} ${uu(units,"T")} (absolute: ${(units==="SI"?Tfuel:Tfuel*1.8).toFixed(1)} ${units==="SI"?"K":"°R"}).`}/>
        <M l="Stoichiometric Air/Fuel (mass)" v={props.AFR_mass.toFixed(1)} u={uu(units,"afr_mass")} c={C.good} tip="Mass of oxidizer per mass of fuel at stoichiometric conditions (φ=1). Used for combustor sizing."/>
        <M l="Stoichiometric Air/Fuel (vol)" v={props.AFR_vol.toFixed(1)} u="mol/mol" c={C.accent3} tip="Moles of oxidizer per mole of fuel at stoichiometric conditions."/>
        <M l="Stoichiometric O₂ Demand" v={props.stoichO2.toFixed(3)} u="mol" c={C.accent3} tip="Moles of O₂ required per mole of fuel for complete combustion: C→CO₂, H→H₂O."/>
      </div>
    </div>
    {/* ────── Card 2: Flame Properties — depend on φ, oxidizer, operating point ────── */}
    <div style={S.card}><div style={S.cardT}>Flame Properties{combMode==="equilibrium"&&!accurate&&<span style={{color:C.accent,fontWeight:400}}> — Equilibrium Mode</span>}{statusBadge}</div>
      <div style={{fontSize:9.5,color:C.txtMuted,marginBottom:8}}>Depend on φ, oxidizer composition, and inlet conditions. T₄ comes from the Cycle panel.</div>
      <div style={{...S.row,gap:8}}>
        <M l="T_ad — Chemical Equilibrium" v={uv(units,"T",result?.T_ad).toFixed(0)} u={uu(units,"T")} c={C.accent} tip="Full-species Cantera HP equilibrium (all 53 GRI-Mech species: CO₂, H₂O, CO, OH, NO, H, O, H₂, …). Accounts for dissociation — CO₂ and H₂O partially break up at high T, absorbing chemical energy and lowering T_ad. Most appropriate for the flame zone itself (combustor_air_frac = 1) where gas is still at peak T."/>
        {accurate&&adapted&&adapted.T_ad_complete?
          <M l="T_ad — Complete Combustion" v={uv(units,"T",adapted.T_ad_complete).toFixed(0)} u={uu(units,"T")} c={C.orange} tip="No dissociation: all C → CO₂, all H → H₂O (+ excess O₂ for lean, + CO/H₂ for rich). Always higher than equilibrium because no endothermic dissociation occurs. Most appropriate for combustor-exit or gas-turbine stack measurements where the gas has cooled below the dissociation regime; gets better as combustor_air_frac drops below 1 (more dilution cooling)."/>
          :null}
        <M l="T₄ (Turbine Inlet)" v={T4_for_backend?uv(units,"T",T4_for_backend).toFixed(0):"—"} u={T4_for_backend?uu(units,"T"):""} c={C.warm} tip={T4_for_backend?"Combustor exit / turbine-inlet temperature from the Cycle solution. T₄ = T_Bulk diluted by combustor secondary air, so T₄ < T_Bulk.":"Run the Cycle panel to compute T₄ — it is the dilution-cooled product temperature the turbine actually sees."}/>
      </div>
      {accurate&&adapted&&adapted.T_ad_complete?
        <div style={{marginTop:8,padding:"6px 10px",background:`${C.orange}0C`,border:`1px solid ${C.orange}35`,borderRadius:5,fontSize:10,color:C.txtMuted,lineHeight:1.45,fontFamily:"'Barlow',sans-serif"}}>
          <strong style={{color:C.orange}}>Which T_ad to use:</strong> Equilibrium is the theoretical in-flame value. Complete combustion is what a combustor-exit or stack thermocouple/calc tracks after dissociation products have recombined. For DLE primary zones use equilibrium; for overall combustor exit T or turbine inlet conditions use complete combustion. At this operating point the gap is {uv(units,"T",adapted.T_ad_complete-result.T_ad).toFixed(0)} {uu(units,"T")} (complete is higher).
        </div>:null}
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <div style={S.card}><div style={S.cardT}>T_ad vs phi</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>Yellow marker shows current φ. Peak T_ad typically occurs near φ≈1.05 due to dissociation effects.</div><Chart data={sweep} xK="phi" yK="T_ad" xL="phi (φ)" yL={`Temperature (${uu(units,"T")})`} color={C.accent} marker={mk}/></div>
      <div style={S.card}><div style={S.cardT}>Equilibrium Products (mol%){usingT4&&<span style={{color:C.warm,fontWeight:400}}> — at T₄ conditions</span>}</div>
        <div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>Major species at equilibrium. Lean mixtures (φ&lt;1) show excess O₂; rich mixtures (φ&gt;1) show CO and H₂.</div>
        {usingT4?<div style={{background:`${C.warm}0F`,border:`1px solid ${C.warm}44`,borderRadius:5,padding:"6px 10px",fontSize:10.5,color:C.txtDim,fontFamily:"monospace",marginBottom:8}}>📍 Re-equilibrated at <span style={{color:C.warm,fontWeight:700}}>T₄ = {uv(units,"T",T4_for_backend).toFixed(0)} {uu(units,"T")}</span> (turbine inlet) instead of T_ad = {uv(units,"T",result?.T_ad).toFixed(0)} {uu(units,"T")}. NO and OH equilibrium are sensitive to product temperature — the diluted, cooler products carry less of these minor species than the hot flame zone.</div>
          :T4_for_backend?<div style={{fontSize:10,color:C.txtMuted,fontStyle:"italic",marginBottom:6}}>Showing equilibrium at T_ad (T_Bulk). T₄ = {uv(units,"T",T4_for_backend).toFixed(0)} {uu(units,"T")} is available but the secondary equilibrium did not return — check Accurate-mode response.</div>
          :<div style={{fontSize:10,color:C.txtMuted,fontStyle:"italic",marginBottom:6}}>Showing equilibrium at T_ad (T_Bulk). Run the Cycle panel to also compute products at T₄ (turbine inlet).</div>}
        {productsForDisplay&&<>
          <div style={{fontSize:10,fontWeight:700,color:C.accent,textTransform:"uppercase",letterSpacing:"1px",margin:"4px 0 4px"}}>Wet Basis{usingT4?" (at T₄)":""}</div>
          <HBar data={productsForDisplay} h={Math.max(120,Object.keys(productsForDisplay).length*24+10)}/>
          <div style={{fontSize:10,fontWeight:700,color:C.accent2,textTransform:"uppercase",letterSpacing:"1px",margin:"10px 0 4px"}}>Dry Basis{usingT4?" (at T₄)":""} (H₂O removed, renormalized)</div>
          <HBar data={dryBasis(productsForDisplay)} h={Math.max(110,Math.max(0,Object.keys(productsForDisplay).length-1)*24+10)}/>
        </>}
      </div>
    </div></div>);}

// ─────────────────────────────────────────────────────────────────────────
//  Borghi-Peters regime diagram. Static log-log canvas with four standard
//  reference diagonals (Ka=1, Ka=100, Da=1, Re_T=1) and four labeled
//  regime quadrants (laminar / corrugated flamelet / thin reaction zone /
//  broken reaction zone). The current operating point is rendered as a
//  large violet dot; the trail (last 20 points) renders as smaller dots
//  with alpha fading from 0.85 (newest) to 0.10 (oldest). Hovering any
//  dot pops a readout showing (φ, T₀, P, Ka, Da, Re_T).
//
//  Reference-line math (Peters 2000, Borghi 1985 conventions):
//    Re_T = const ⇒ log(u'/SL) = -log(l_T/δ_F) + log(Re_T)   slope -1
//    Da   = const ⇒ log(u'/SL) =  log(l_T/δ_F) - log(Da)     slope +1
//    Ka   = const ⇒ log(u'/SL) = (1/3)·log(l_T/δ_F) + (2/3)·log(Ka)
//                                                            slope +1/3
//  All on log-log axes X = log10(l_T/δ_F), Y = log10(u'/SL).
// ─────────────────────────────────────────────────────────────────────────
function BorghiPetersDiagram({ currentX, currentY, currentLabel, trail, hover, setHover, units }){
  // Plot bounds (log10).
  const xMinLog = 0;       // 10^0  = 1
  const xMaxLog = 4;       // 10^4  = 10000
  const yMinLog = -1;      // 10^-1 = 0.1
  const yMaxLog = 3;       // 10^3  = 1000

  // Pixel canvas. Width responsive via SVG viewBox; render aspect 720×440.
  const W = 720, H = 440;
  const M = { left: 50, right: 18, top: 14, bottom: 38 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top  - M.bottom;

  const xToPx = (xLog) => M.left + (xLog - xMinLog) / (xMaxLog - xMinLog) * plotW;
  const yToPx = (yLog) => M.top  + (yMaxLog - yLog) / (yMaxLog - yMinLog) * plotH;
  const valToX = (v) => xToPx(Math.log10(Math.max(v, 10**xMinLog)));
  const valToY = (v) => yToPx(Math.log10(Math.max(v, 10**yMinLog)));

  // Build a reference line of given slope through given point, clipped to bounds.
  const refLine = (slope, intercept, xLo=xMinLog, xHi=xMaxLog) => {
    // y = slope·x + intercept
    const y0 = slope * xLo + intercept;
    const y1 = slope * xHi + intercept;
    return { x1: xToPx(xLo), y1: yToPx(y0), x2: xToPx(xHi), y2: yToPx(y1) };
  };
  const ka1   = refLine(1/3, 0);                                    // Ka=1
  const ka100 = refLine(1/3, (2/3)*Math.log10(100));                // Ka=100
  const da1   = refLine(1, 0);                                       // Da=1
  const reT1  = refLine(-1, 0);                                      // Re_T=1

  // Tick generator: integer log decades
  const xTicks = [];
  for (let k = xMinLog; k <= xMaxLog; k++) xTicks.push(k);
  const yTicks = [];
  for (let k = yMinLog; k <= yMaxLog; k++) yTicks.push(k);

  // Hover readout building.
  const fmtT = (TK) => units==="SI" ? `${TK.toFixed(0)} K` : `${((TK-273.15)*9/5+32).toFixed(0)} °F`;
  const fmtP = (Patm) => units==="SI" ? `${(Patm).toFixed(2)} atm` : `${(Patm*14.696).toFixed(0)} psia`;

  // What's hovered: current point if hover.idx === -1, else trail[hover.idx]
  const hoveredPt = (hover && Number.isFinite(hover.idx))
    ? (hover.idx === -1
        ? { ...currentLabel, x: currentX, y: currentY, isCurrent: true }
        : { ...(trail[hover.idx] || {}), isCurrent: false })
    : null;

  // ─── Flame-icon mini-glyphs, one per regime. Positioned at the region's
  // visual center in log-log space. Sized to read at the export resolution
  // and the on-screen viewBox (720×440). All paths use stroke from the
  // region's accent color so they stay legible on the tinted background.
  const FlameIcon = ({type, cx, cy, color, scale=1}) => {
    const t = `translate(${cx} ${cy})${scale!==1?` scale(${scale})`:""}`;
    if (type === "laminar") {
      // Smooth, stable single-peak flame — a teardrop with base line.
      return (
        <g transform={t} pointerEvents="none">
          <path d="M0,-15 C-7,-7 -10,2 -10,6 C-10,10 -5,12 0,12 C5,12 10,10 10,6 C10,2 7,-7 0,-15 Z"
                fill={`${color}33`} stroke={color} strokeWidth="1.6" strokeLinejoin="round"/>
          <line x1={-13} y1={13} x2={13} y2={13} stroke={color} strokeWidth="1.4" strokeDasharray="2,2"/>
        </g>
      );
    }
    if (type === "flamelet") {
      // Wrinkled but intact reaction sheet — a long sinusoid + small swirl arrows.
      return (
        <g transform={t} pointerEvents="none">
          <path d="M-30,2 Q-22,-8 -14,2 T2,2 T18,2 T34,2"
                fill="none" stroke={color} strokeWidth="2" strokeLinecap="round"/>
          <path d="M-22,-12 a3,3 0 1,1 3,-3" fill="none" stroke={color} strokeWidth="1.2"/>
          <path d="M-2,-12 a3,3 0 1,1 3,-3"  fill="none" stroke={color} strokeWidth="1.2"/>
          <path d="M18,-12 a3,3 0 1,1 3,-3"  fill="none" stroke={color} strokeWidth="1.2"/>
        </g>
      );
    }
    if (type === "thin") {
      // Disturbed, thicker flame — three-line band (dashed outer, solid core).
      return (
        <g transform={t} pointerEvents="none">
          <path d="M-30,-5 Q-22,-13 -14,-5 T2,-5 T18,-5 T34,-5"
                fill="none" stroke={color} strokeWidth="1" strokeDasharray="3,2" opacity="0.85"/>
          <path d="M-30,0 Q-22,-8 -14,0 T2,0 T18,0 T34,0"
                fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round"/>
          <path d="M-30,5 Q-22,-3 -14,5 T2,5 T18,5 T34,5"
                fill="none" stroke={color} strokeWidth="1" strokeDasharray="3,2" opacity="0.85"/>
          <path d="M-22,-15 a3,3 0 1,1 3,-3" fill="none" stroke={color} strokeWidth="1.2"/>
          <path d="M18,-15 a3,3 0 1,1 3,-3"  fill="none" stroke={color} strokeWidth="1.2"/>
        </g>
      );
    }
    if (type === "broken") {
      // Reaction zone breaks up — scattered fragmented cells.
      return (
        <g transform={t} pointerEvents="none" opacity="0.85">
          <circle cx={-18} cy={-2} r={5}  fill={`${color}55`} stroke={color} strokeWidth="1"/>
          <circle cx={-7}  cy={5}  r={3}  fill={`${color}55`} stroke={color} strokeWidth="1"/>
          <circle cx={6}   cy={-3} r={6}  fill={`${color}55`} stroke={color} strokeWidth="1"/>
          <circle cx={17}  cy={4}  r={3}  fill={`${color}55`} stroke={color} strokeWidth="1"/>
          <circle cx={-13} cy={9}  r={2}  fill={`${color}77`} />
          <circle cx={2}   cy={11} r={1.6} fill={`${color}77`} />
          <circle cx={15}  cy={-9} r={1.5} fill={`${color}77`} />
        </g>
      );
    }
    return null;
  };

  return (
    <div style={{marginTop:8,background:`${C.bg2}88`,border:`1px solid ${C.border}`,borderRadius:6,padding:"10px 8px 6px"}}>
      <div style={{fontSize:10.5,fontWeight:700,color:C.txtDim,letterSpacing:".5px",fontFamily:"'Barlow Condensed',sans-serif",textTransform:"uppercase",margin:"0 4px 4px 6px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span style={{fontSize:13,color:C.accent,letterSpacing:".8px"}}>BORGHI–PETERS REGIME DIAGRAM</span>
        <span style={{fontSize:9.5,color:C.txtMuted,fontFamily:"monospace",textTransform:"none",letterSpacing:0}}>● current point &nbsp;·&nbsp; ○ last {trail.length} ops &nbsp;·&nbsp; hover for readout</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"auto",display:"block"}} preserveAspectRatio="xMidYMid meet">
        {/* ── Background regime tints — stronger fills for better region readability ── */}
        {/* Flamelet (Ka<1) — full bottom band below Ka=1 line — pale green */}
        <polygon points={`${ka1.x1},${ka1.y1} ${ka1.x2},${ka1.y2} ${xToPx(xMaxLog)},${yToPx(yMinLog)} ${xToPx(xMinLog)},${yToPx(yMinLog)}`} fill={`${C.good}1A`} />
        {/* Thin reaction zone (1<Ka<100) — amber band */}
        <polygon points={`${ka1.x1},${ka1.y1} ${ka1.x2},${ka1.y2} ${ka100.x2},${ka100.y2} ${ka100.x1},${ka100.y1}`} fill={`${C.warm}28`} />
        {/* Broken reaction zone (Ka>100) — top region — pale red */}
        <polygon points={`${ka100.x1},${ka100.y1} ${ka100.x2},${ka100.y2} ${xToPx(xMaxLog)},${yToPx(yMaxLog)} ${xToPx(xMinLog)},${yToPx(yMaxLog)}`} fill={`${C.strong}1F`} />
        {/* Laminar (Re_T < 1) — bottom-left wedge — overlaid on the green. */}
        <polygon points={`${xToPx(xMinLog)},${yToPx(yMinLog)} ${reT1.x1},${reT1.y1} ${xToPx(xMinLog)},${reT1.y1}`} fill={`${C.accent3}33`} />

        {/* Major tick grid */}
        {xTicks.map(t => (
          <line key={`xg${t}`} x1={xToPx(t)} y1={M.top} x2={xToPx(t)} y2={H-M.bottom} stroke={C.border} strokeWidth="0.5" strokeDasharray="2,3" opacity="0.45"/>
        ))}
        {yTicks.map(t => (
          <line key={`yg${t}`} x1={M.left} y1={yToPx(t)} x2={W-M.right} y2={yToPx(t)} stroke={C.border} strokeWidth="0.5" strokeDasharray="2,3" opacity="0.45"/>
        ))}

        {/* Reference diagonals */}
        <line x1={ka1.x1} y1={ka1.y1} x2={ka1.x2} y2={ka1.y2} stroke={C.strong} strokeWidth="1.7"/>
        <line x1={ka100.x1} y1={ka100.y1} x2={ka100.x2} y2={ka100.y2} stroke={C.strong} strokeWidth="1.7"/>
        <line x1={da1.x1} y1={da1.y1} x2={da1.x2} y2={da1.y2} stroke={C.warm} strokeWidth="1.5" strokeDasharray="6,3"/>
        <line x1={reT1.x1} y1={reT1.y1} x2={reT1.x2} y2={reT1.y2} stroke={C.accent3} strokeWidth="1.5" strokeDasharray="3,3"/>

        {/* Diagonal labels — moved away from line origin/end so they don't crash */}
        <text x={xToPx(3.2)} y={yToPx(1.55)} fill={C.strong} fontSize="11" fontFamily="monospace" fontWeight="700">Ka = 1</text>
        <text x={xToPx(2.7)} y={yToPx(2.75)} fill={C.strong} fontSize="11" fontFamily="monospace" fontWeight="700">Ka = 100</text>
        <text x={xToPx(0.3)} y={yToPx(1.0)} fill={C.warm} fontSize="11" fontFamily="monospace" fontWeight="700">Da = 1</text>
        {/* Re_T=1 label — pushed against the LEFT edge so it doesn't crash
            the LAMINAR flame glyph that lives in the wedge corner. */}
        <text x={xToPx(0.03)} y={yToPx(-0.40)} fill={C.accent3} fontSize="11" fontFamily="monospace" fontWeight="700">Re_T = 1</text>

        {/* ── Regime labels with flame visualizations ── */}
        {/* LAMINAR — pushed deep into the wedge corner (well BELOW the
            Re_T=1 diagonal which at log_x≈0.45 sits at log_y≈-0.45) and
            scaled down so the icon + label + descriptor fit inside the
            ~1-decade-by-1-decade wedge without clipping the chart bottom
            or being crossed by the Re_T=1 line. */}
        <FlameIcon type="laminar" cx={xToPx(0.45)} cy={yToPx(-0.78)} color={C.accent3} scale={0.65}/>
        <text x={xToPx(0.45)} y={yToPx(-0.78)+18} fill={C.accent3} fontSize="10.5" fontFamily="'Barlow Condensed',sans-serif" fontWeight="800" letterSpacing=".5px" textAnchor="middle">LAMINAR</text>
        <text x={xToPx(0.45)} y={yToPx(-0.78)+29} fill={C.txtMuted} fontSize="9" fontStyle="italic" textAnchor="middle">smooth, stable flame</text>

        {/* FLAMELET — bottom-right area */}
        <FlameIcon type="flamelet" cx={xToPx(3.0)} cy={yToPx(-0.25)} color={C.good}/>
        <text x={xToPx(3.0)} y={yToPx(-0.25)+30} fill={C.good} fontSize="11.5" fontFamily="'Barlow Condensed',sans-serif" fontWeight="800" letterSpacing=".6px" textAnchor="middle">FLAMELET</text>
        <text x={xToPx(3.0)} y={yToPx(-0.25)+42} fill={C.txtMuted} fontSize="9.5" fontStyle="italic" textAnchor="middle">wrinkled but intact</text>

        {/* THIN REACTION ZONE — middle band, on the right side so it stays
            inside the band at most reasonable l_T/δ_F values and avoids
            collision with the typical operating point cluster */}
        <FlameIcon type="thin" cx={xToPx(2.6)} cy={yToPx(1.45)} color={C.warm}/>
        <text x={xToPx(2.6)} y={yToPx(1.45)+30} fill={C.warm} fontSize="11.5" fontFamily="'Barlow Condensed',sans-serif" fontWeight="800" letterSpacing=".6px" textAnchor="middle">THIN REACTION ZONE</text>
        <text x={xToPx(2.6)} y={yToPx(1.45)+42} fill={C.txtMuted} fontSize="9.5" fontStyle="italic" textAnchor="middle">disturbed, thicker flame</text>

        {/* BROKEN RXN — top region */}
        <FlameIcon type="broken" cx={xToPx(0.7)} cy={yToPx(2.55)} color={C.strong}/>
        <text x={xToPx(0.7)} y={yToPx(2.55)+30} fill={C.strong} fontSize="11.5" fontFamily="'Barlow Condensed',sans-serif" fontWeight="800" letterSpacing=".6px" textAnchor="middle">BROKEN RXN</text>
        <text x={xToPx(0.7)} y={yToPx(2.55)+42} fill={C.txtMuted} fontSize="9.5" fontStyle="italic" textAnchor="middle">reaction zone breaks up</text>

        {/* Frame */}
        <rect x={M.left} y={M.top} width={plotW} height={plotH} fill="none" stroke={C.txtDim} strokeWidth="1"/>

        {/* X axis ticks + labels */}
        {xTicks.map(t => (
          <g key={`xt${t}`}>
            <line x1={xToPx(t)} y1={H-M.bottom} x2={xToPx(t)} y2={H-M.bottom+5} stroke={C.txtDim} strokeWidth="1"/>
            <text x={xToPx(t)} y={H-M.bottom+18} fill={C.txtDim} fontSize="10" fontFamily="monospace" textAnchor="middle">10{t===0?"⁰":t===1?"¹":t===2?"²":t===3?"³":"⁴"}</text>
          </g>
        ))}
        <text x={M.left+plotW/2} y={H-4} fill={C.txt} fontSize="11" fontFamily="monospace" textAnchor="middle">l_T / δ_F</text>

        {/* Y axis ticks + labels */}
        {yTicks.map(t => (
          <g key={`yt${t}`}>
            <line x1={M.left-5} y1={yToPx(t)} x2={M.left} y2={yToPx(t)} stroke={C.txtDim} strokeWidth="1"/>
            <text x={M.left-8} y={yToPx(t)+3} fill={C.txtDim} fontSize="10" fontFamily="monospace" textAnchor="end">10{t===-1?"⁻¹":t===0?"⁰":t===1?"¹":t===2?"²":"³"}</text>
          </g>
        ))}
        <text x={14} y={M.top+plotH/2} fill={C.txt} fontSize="11" fontFamily="monospace" textAnchor="middle" transform={`rotate(-90 14 ${M.top+plotH/2})`}>u' / S_L</text>

        {/* Trail dots — fade alpha by age (older = fainter) */}
        {trail.map((p, i) => {
          if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
          const alpha = 0.10 + (0.75 * (i + 1) / Math.max(trail.length, 1));
          const cx = valToX(p.x), cy = valToY(p.y);
          if (cx < M.left || cx > W-M.right || cy < M.top || cy > H-M.bottom) return null;
          return (
            <g key={`tr${i}`}>
              <circle cx={cx} cy={cy} r={3.5} fill={C.violet} opacity={alpha}/>
              <circle cx={cx} cy={cy} r={9} fill="transparent"
                onMouseEnter={()=>setHover({idx:i})} onMouseLeave={()=>setHover(null)}
                style={{cursor:"crosshair"}}/>
            </g>
          );
        })}

        {/* Current operating point */}
        {(() => {
          const cx = valToX(currentX), cy = valToY(currentY);
          if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
          return (
            <g>
              <circle cx={cx} cy={cy} r={9} fill={C.violet} opacity="0.25"/>
              <circle cx={cx} cy={cy} r={5.5} fill={C.violet} stroke={C.bg} strokeWidth="1.5"/>
              <circle cx={cx} cy={cy} r={14} fill="transparent"
                onMouseEnter={()=>setHover({idx:-1})} onMouseLeave={()=>setHover(null)}
                style={{cursor:"crosshair"}}/>
            </g>
          );
        })()}

        {/* Hover readout */}
        {hoveredPt && Number.isFinite(hoveredPt.x) && Number.isFinite(hoveredPt.y) && (() => {
          const cx = valToX(hoveredPt.x), cy = valToY(hoveredPt.y);
          // Anchor box near point but clamp inside chart
          let bx = cx + 14, by = cy - 10;
          const bw = 178, bh = 86;
          if (bx + bw > W - M.right) bx = cx - bw - 14;
          if (by < M.top) by = M.top + 4;
          if (by + bh > H - M.bottom) by = H - M.bottom - bh - 4;
          return (
            <g pointerEvents="none">
              <rect x={bx} y={by} width={bw} height={bh} rx={5} fill={C.bg} stroke={C.violet} strokeWidth="1" opacity="0.97"/>
              <text x={bx+8} y={by+15} fill={C.violet} fontSize="10.5" fontFamily="monospace" fontWeight="700">{hoveredPt.isCurrent?"● CURRENT":"○ TRAIL"}</text>
              <text x={bx+8} y={by+30} fill={C.txt} fontSize="10" fontFamily="monospace">φ = {Number(hoveredPt.phi).toFixed(3)}</text>
              <text x={bx+8} y={by+43} fill={C.txt} fontSize="10" fontFamily="monospace">T = {fmtT(Number(hoveredPt.T0))}</text>
              <text x={bx+8} y={by+56} fill={C.txt} fontSize="10" fontFamily="monospace">P = {fmtP(Number(hoveredPt.P))}</text>
              <text x={bx+8} y={by+69} fill={C.warm} fontSize="10" fontFamily="monospace">Ka = {Number(hoveredPt.Ka).toFixed(2)} · Da = {Number(hoveredPt.Da).toFixed(2)}</text>
              <text x={bx+8} y={by+81} fill={C.accent3} fontSize="10" fontFamily="monospace">Re_T = {Number(hoveredPt.ReT)>=1e4?Number(hoveredPt.ReT).toExponential(1):Number(hoveredPt.ReT).toFixed(0)}</text>
            </g>
          );
        })()}
      </svg>
    </div>
  );
}

function FlameSpeedPanel({fuel,ox,phi,T0,P,Tfuel,WFR=0,waterMode="liquid",velocity,setVelocity,Lchar,setLchar,Dfh,setDfh,Lpremix,setLpremix,Vpremix,setVpremix,cycleResult=null,
  // Activation state is lifted to App so it survives tab nav when the user
  // enables `keepActivated`. Both default to App-level useState(false), so
  // a browser restart always opens the panel deactivated.
  flameActive,setFlameActive,keepActivated,setKeepActivated,
  // Lift Cantera results to App so the Excel export can publish them
  // instead of falling back to the free-mode JS Gülder correlation.
  onBkUpdate,onBkIgnUpdate,onSweepsUpdate}){
  // ─── HOOKS ─────────────────────────────────────────────────────────────
  // ALL hooks live above the activate-guard early return. Each does a
  // FULL no-op (returns a safe default, fires no backend call) when
  // !flameActive, so the panel is truly inert until the user opts in.
  // Same lesson learned the hard way on the PSR-PFR gate: it's not enough
  // to gate the backend — local useMemo sweeps and useState calls must
  // also short-circuit, and the JSX must not render result cards either.
  const units=useContext(UnitCtx);
  const {accurate}=useContext(AccurateCtx);
  const {begin:beginBusy}=useContext(BusyCtx);
  const Tair=T0;
  // Cantera 1D FreeFlame is ~10–15 s per call; the autoignition reactor is
  // another 2–5 s. Off by default — the user clicks ACTIVATE to opt in.
  // (flameActive/setFlameActive now arrive as props from App so the state
  //  survives tab nav when the user enables the keep-activated preference.)
  const [canteraSweeps,setCanteraSweeps]=useState(null);  // {hash, phi:[...], T:[...], P:[...]}
  // Lift Cantera sweeps to App so the Excel export can use the real
  // 1D-FreeFlame phi/T/P sweeps instead of the calcSL JS approximation.
  useEffect(()=>{onSweepsUpdate&&onSweepsUpdate(canteraSweeps);},[canteraSweeps,onSweepsUpdate]);
  const [sweepErr,setSweepErr]=useState(null);
  const [sweepRunning,setSweepRunning]=useState(false);
  // ── Card 1 (Flame Speed & Regime Diagnostics) panel-local state ──────
  // u'/U turbulence intensity. Default 0.10 = smooth duct. Range 0.05–0.30.
  // 0.20 ≈ swirl premixer; 0.30 ≈ highly turbulated dump combustor.
  const [uPrimeRatio, setUPrimeRatio] = useState(0.20);
  // Reference velocity for u' computation (Option B):
  //   "vref"    = V_ref at the flame anchor — used by Card 1 (regime
  //               diagnostics, Borghi/Bradley) and Card 2 (blowoff /
  //               flame-anchor stability). Physically the approach
  //               velocity into the recirculation zone.
  //   "vpremix" = V_premix bulk channel velocity — used by Card 3
  //               (premixer flashback) where the relevant turbulence is
  //               the channel turbulence upstream of the flame. Choose
  //               this when the regime question is "can the flame propagate
  //               upstream into the premixer?" rather than "can the
  //               anchor hold against blow-off?".
  // Single source of truth — every place in the panel that builds u'
  // reads this toggle so Card 1 / Card 2 / Card 3 always agree.
  const [uReference, setUReference] = useState("vref");
  // Integral length scale l_T (m). null = auto (0.1·L_char per
  // Tennekes-Lumley). User can override with any positive value.
  const [lTOverride, setLTOverride] = useState(null);
  // Borghi-Peters trail — last 20 operating points (FIFO). Each entry:
  //   {phi, T0, P, x: lT/δF, y: u'/SL, Ka, Da, ReT, ts}
  // Cleared whenever fuel or oxidizer composition changes (apples vs
  // oranges: δ_F shifts dramatically across fuels). Pure UI state, no
  // localStorage persistence — the diagnostic loses meaning across reloads.
  const [borghiTrail, setBorghiTrail] = useState([]);
  // Current hover-target on the Borghi SVG. {idx} where idx=-1 means the
  // current operating point, else the trail index. null = no hover.
  const [borghiHover, setBorghiHover] = useState(null);

  // ── Card 2 (Stabilization & Blowoff) panel-local state ──────────────
  // premixerType drives the Da_crit table + secondary inputs shown.
  const [premixerType, setPremixerType] = useState("swirl");
  // Type-specific secondary inputs. We carry one slot per parameter so
  // the value persists if the user switches types and switches back.
  const [swirlNumber, setSwirlNumber] = useState(0.6);
  const [gutterAngleDeg, setGutterAngleDeg] = useState(90);
  const [expansionRatio, setExpansionRatio] = useState(2.5);
  const [holeDiamMm, setHoleDiamMm] = useState(1.5);
  // Lefebvre LBO inputs.
  // V_pz: primary-zone volume (m³). Default 0.025 m³ — middle of the
  // frame-GT (~0.05 m³) / aero-derivative (~0.005 m³) range.
  const [V_pz_m3, setVpzM3] = useState(0.025);
  // K: Lefebvre A constant. Default 6.29 — premixed-gas calibration
  // (back-fit to φ_LBO≈0.40 at LMS100 NG-DLN baseline). Lefebvre Table 5.1
  // 0.013–0.064 values are for kerosene-spray aero engines and are not
  // appropriate for premixed gas. Editable for site-specific recalibration.
  const [K_LBO, setKLBO] = useState(6.29);

  // ── Card 3 (Premixer Flashback & Autoignition) panel-local state ────
  // D_h: premixer hydraulic diameter. Default 0.040 m (40 mm) — typical
  // DLN swirl premixer. Used by both boundary-layer (g_actual) and CIVB
  // (Π_CIVB) gates. Range loosely bounded to 5 mm (micromixer) – 200 mm
  // (large can combustor).
  const [D_h_premix, setDhPremix] = useState(0.040);
  // RTD multiplier: ratio τ_res,99 / τ_res,mean. Default 1.5 (1D plug
  // flow with realistic axial dispersion). Slider 1.0–3.0 — higher
  // values represent strong recirculation / poorly-distributed mixing.
  const [RTD_multiplier, setRTDMultiplier] = useState(1.5);
  // Autoignition mechanism. Decoupled from the App-level Combustor PSR
  // mechanism so the user can run FFCM-2 / Glarborg here without
  // perturbing the Combustor panel. Choices wired to the bundled YAMLs:
  //   gri30        — GRI-Mech 3.0 (Cantera built-in; default)
  //   glarborg     — Glarborg 2018 (bundled, more H₂/NOx detail)
  //   ffcm2        — FFCM-2 (planned; YAML not bundled yet)
  //   aramco       — Aramco 3.0 (planned)
  const [igMechanism, setIgMechanism] = useState("gri30");
  // Wall-shear amplification factor ε_turb for boundary-layer flashback
  // (Lewis-von Elbe). g_actual = (8·V_premix/D_h)·(1+ε_turb). Default
  // 0.7 (≈ 1.7× turbulent BL multiplier on the laminar gradient
  // estimate). Range 0–2.
  const [eps_turb, setEpsTurb] = useState(0.7);
  // useMemo / useBackendCalc — short-circuit when !flameActive
  const Tmix=useMemo(()=>flameActive?mixT(fuel,ox,phi,Tfuel,Tair):0,[flameActive,fuel,ox,phi,Tfuel,Tair]);
  const bk=useBackendCalc("flame",{fuel:nonzero(fuel),oxidizer:nonzero(ox),phi,T0,P:atmToBar(P),domain_length_m:0.03,T_fuel_K:Tfuel,T_air_K:Tair,WFR,water_mode:waterMode},accurate&&flameActive);
  const bkIgn=useBackendCalc("autoignition",{fuel:nonzero(fuel),oxidizer:nonzero(ox),phi,T0,P:atmToBar(P),max_time_s:10.0,T_fuel_K:Tfuel,T_air_K:Tair,mechanism:igMechanism,WFR,water_mode:waterMode},accurate&&flameActive);
  // Push the Cantera result up to App so exportToExcel can use it instead
  // of the free-mode JS correlation. Setter is stable; effect re-fires when
  // the data object identity changes.
  useEffect(()=>{onBkUpdate&&onBkUpdate(bk.data||null);},[bk.data,onBkUpdate]);
  useEffect(()=>{onBkIgnUpdate&&onBkIgnUpdate(bkIgn.data||null);},[bkIgn.data,onBkIgnUpdate]);
  // sweepHash and sweepIsFresh are cheap; safe to compute always.
  const sweepHash=useMemo(()=>JSON.stringify({fuel:nonzero(fuel),oxidizer:nonzero(ox),phi,T0,P:atmToBar(P),Tfuel,Tair}),[fuel,ox,phi,T0,P,Tfuel,Tair]);
  const sweepIsFresh=flameActive&&accurate&&canteraSweeps&&canteraSweeps.hash===sweepHash;
  const runCanteraSweeps=useCallback(async()=>{
    if(sweepRunning||!flameActive)return;
    setSweepRunning(true);setSweepErr(null);
    const endBusy=beginBusy(BUSY_LABELS.flame_sweep);
    const base={fuel:nonzero(fuel),oxidizer:nonzero(ox),phi,T0,P:atmToBar(P),domain_length_m:0.03,T_fuel_K:Tfuel,T_air_K:Tair,WFR,water_mode:waterMode};
    const phiVals=Array.from({length:5},(_,i)=>+(0.4+(2.0-0.4)*i/4).toFixed(3));
    const TVals=Array.from({length:4},(_,i)=>+(300+(800-300)*i/3).toFixed(1));
    const PVals_bar=Array.from({length:5},(_,i)=>+(0.5+(40-0.5)*i/4).toFixed(3)).map(atmToBar);
    try{
      // Sequential — backend solver pool is single-threaded (Cantera is not
      // thread-safe). Promise.all would queue them anyway and burn the
      // 300 s HTTP timeout. Sequential gives each sweep its own window.
      const PRes=await api.calcFlameSpeedSweep({...base,sweep_var:"P",sweep_values:PVals_bar});
      const TRes=await api.calcFlameSpeedSweep({...base,sweep_var:"T",sweep_values:TVals});
      const phiRes=await api.calcFlameSpeedSweep({...base,sweep_var:"phi",sweep_values:phiVals});
      setCanteraSweeps({hash:sweepHash,phi:phiRes.points,T:TRes.points,P:PRes.points});
    }catch(e){setSweepErr(e.message||String(e));}
    finally{setSweepRunning(false);endBusy();}
  },[sweepRunning,flameActive,beginBusy,fuel,ox,phi,T0,P,Tfuel,Tair,sweepHash,WFR,waterMode]);
  // SL_scale needs to be computed before the heavy sweeps that use it.
  // Both depend on bk.data (which is null when !flameActive), so they're
  // already implicitly off in the deactivated state.
  const localSLForScale=flameActive?calcSL(fuel,phi,Tmix,P)*100:0;
  const SLForScale=accurate&&bk.data?bk.data.SL*100:localSLForScale;
  const SL_scale=(accurate&&bk.data&&localSLForScale>1e-6)?SLForScale/localSLForScale:1;
  const SL_scale2=SL_scale*SL_scale;
  // Heavy sweeps — every one short-circuits when !flameActive.
  const jsPhiSweep=useMemo(()=>{if(!flameActive)return[];const r=[];for(let p=0.4;p<=1.01;p+=0.02){const Tm=mixT(fuel,ox,p,Tfuel,Tair);r.push({phi:+p.toFixed(2),SL:uv(units,"SL",calcSL(fuel,p,Tm,P)*100*SL_scale)});}return r;},[flameActive,fuel,ox,Tfuel,Tair,P,units,SL_scale]);
  const jsPSw=useMemo(()=>flameActive?[0.5,1,2,5,10,20,40].map(p=>({P:uv(units,"P",p),SL:uv(units,"SL",calcSL(fuel,phi,Tmix,p)*100*SL_scale)})):[],[flameActive,fuel,phi,Tmix,units,SL_scale]);
  const jsTSw=useMemo(()=>{if(!flameActive)return[];const r=[];for(let t=250;t<=800;t+=25)r.push({T:uv(units,"T",t),SL:uv(units,"SL",calcSL(fuel,phi,t,P)*100*SL_scale)});return r;},[flameActive,fuel,phi,P,units,SL_scale]);
  const sweep=useMemo(()=>sweepIsFresh?canteraSweeps.phi.filter(p=>p.converged).map(p=>({phi:+p.x.toFixed(3),SL:uv(units,"SL",p.SL*100)})):jsPhiSweep,[sweepIsFresh,canteraSweeps,units,jsPhiSweep]);
  const pSw=useMemo(()=>sweepIsFresh?canteraSweeps.P.filter(p=>p.converged).map(p=>({P:uv(units,"P",p.x/1.01325),SL:uv(units,"SL",p.SL*100)})):jsPSw,[sweepIsFresh,canteraSweeps,units,jsPSw]);
  const tSw=useMemo(()=>sweepIsFresh?canteraSweeps.T.filter(p=>p.converged).map(p=>({T:uv(units,"T",p.x),SL:uv(units,"SL",p.SL*100)})):jsTSw,[sweepIsFresh,canteraSweeps,units,jsTSw]);
  const bo=useMemo(()=>{
    if(!flameActive)return{SL:0,tau_chem:0,tau_flow:0,Da:0,blowoff_velocity:0,stable:false};
    const b=calcBlowoff(fuel,phi,Tmix,P,velocity,Lchar);const Da=b.Da*SL_scale2;
    return{SL:b.SL*SL_scale,tau_chem:b.tau_chem/SL_scale2,tau_flow:b.tau_flow,Da,blowoff_velocity:b.blowoff_velocity*SL_scale2,stable:Da>1};
  },[flameActive,fuel,phi,Tmix,P,velocity,Lchar,SL_scale,SL_scale2]);
  const daSw=useMemo(()=>{
    if(!flameActive)return[];
    const r=[];for(let v=1;v<=200;v+=2){const b=calcBlowoff(fuel,phi,Tmix,P,v,Lchar);r.push({V:uv(units,"vel",v),Da:Math.min(b.Da*SL_scale2,100)});}return r;
  },[flameActive,fuel,phi,Tmix,P,Lchar,units,SL_scale2]);

  // ── Borghi-Peters trail: reset on fuel/oxidizer change ───────────────
  // Must live above the early return so the hook order is stable across
  // (flameActive=false) ↔ (flameActive=true) renders. Reset clears stale
  // trail entries that came from a different fuel — the regime diagnostic
  // is meaningless across composition changes (δ_F can shift 5×).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setBorghiTrail([]); setBorghiHover(null); },
    [JSON.stringify(fuel), JSON.stringify(ox)]);

  // ── Borghi-Peters trail: push a new ops point per (φ, T, P) change ──
  // Computes diagnostics inline (rather than reading the active-branch
  // consts) so this hook can live above the early return. Bails silently
  // when flameActive is off, when bk.data isn't ready, or when the
  // computed (x, y) lands outside finite real space.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!flameActive) return;
    const Tmix_local = mixT(fuel, ox, phi, Tfuel, T0);
    const SL_local_cmps = (accurate && bk.data && bk.data.SL > 0)
      ? bk.data.SL * 100
      : calcSL(fuel, phi, Tmix_local, P) * 100;
    const SL_ms_local = SL_local_cmps / 100;
    if (!Number.isFinite(SL_ms_local) || SL_ms_local <= 0) return;
    const alpha_local = (accurate && bk.data && bk.data.alpha_th_u)
      ? bk.data.alpha_th_u
      : alphaThU(Tmix_local, P);
    const delta_F_local = (accurate && bk.data && bk.data.delta_F)
      ? bk.data.delta_F
      : alpha_local / Math.max(SL_ms_local, 1e-9);
    const nu_local = (accurate && bk.data && bk.data.nu_u)
      ? bk.data.nu_u
      : alpha_local / 0.71;
    const Le_local = (accurate && bk.data && bk.data.Le_eff)
      ? bk.data.Le_eff
      : lewisNumberFreeMode(fuel);
    const uRef_local = (uReference === "vpremix") ? Vpremix : velocity;
    const uPrime_local = uPrimeRatio * Math.max(uRef_local, 0);
    const lT_local = (lTOverride && lTOverride > 0)
      ? lTOverride
      : 0.1 * Math.max(Lchar, 1e-6);
    const x = lT_local / Math.max(delta_F_local, 1e-12);
    const y = uPrime_local / Math.max(SL_ms_local, 1e-9);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) return;
    const br = bradleyST(SL_ms_local, Math.max(uPrime_local, 1e-9), lT_local, nu_local, Le_local);
    const pt = {
      phi: +phi.toFixed(3),
      T0:  +T0.toFixed(1),
      P:   +P.toFixed(3),
      x, y,
      Ka:  br.Ka,
      Da:  (lT_local / Math.max(delta_F_local, 1e-12)) * (SL_ms_local / Math.max(uPrime_local, 1e-9)),
      ReT: br.ReT,
      ts: Date.now(),
    };
    setBorghiTrail(prev => {
      const last = prev[prev.length - 1];
      if (last
          && Math.abs(last.phi - pt.phi) < 1e-4
          && Math.abs(last.T0  - pt.T0)  < 1e-2
          && Math.abs(last.P   - pt.P)   < 1e-4) return prev;
      const next = [...prev, pt];
      return next.length > 20 ? next.slice(next.length - 20) : next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flameActive, accurate, bk.data, phi, T0, P, Tfuel, velocity, Vpremix, Lchar, uPrimeRatio, uReference, lTOverride, JSON.stringify(fuel), JSON.stringify(ox)]);

  // ─── EARLY RETURN: deactivated panel ──────────────────────────────────
  // Hooks above all ran (and short-circuited). Below this line: nothing
  // computes, nothing renders, nothing fires until flameActive=true.
  if(!flameActive){
    return(<div style={{display:"flex",flexDirection:"column",gap:12}}>
      <InlineBusyBanner loading={false}/>
      <button onClick={()=>setFlameActive(true)}
        title="Click to activate — runs Cantera 1D FreeFlame (~10-15 s) and 0D autoignition (~2-5 s) on every parameter change. Off by default to keep the app fast."
        style={{padding:"10px 16px",fontSize:13,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".7px",
          color:C.strong,background:`${C.strong}18`,border:`2px solid ${C.strong}`,
          borderRadius:6,cursor:"pointer",
          display:"flex",alignItems:"center",justifyContent:"center",gap:10,
          transition:"all .12s"}}>
        <span style={{width:10,height:10,borderRadius:"50%",background:C.strong,boxShadow:`0 0 8px ${C.strong}`}}/>
        DEACTIVATED — click to fire Cantera Flame Speed + Autoignition (~12-20 s)
      </button>
      <KeepActivatedToggle on={!!keepActivated} onChange={setKeepActivated} panelLabel="Flame Speed"/>
      <div style={{padding:"40px 24px",background:C.bg2,border:`1.5px dashed ${C.strong}60`,borderRadius:8,textAlign:"center",fontFamily:"'Barlow',sans-serif"}}>
        <div style={{fontSize:14,fontWeight:700,color:C.strong,letterSpacing:".5px",marginBottom:8,fontFamily:"'Barlow Condensed',sans-serif"}}>FLAME SPEED PANEL DEACTIVATED</div>
        <div style={{fontSize:12,color:C.txtDim,lineHeight:1.55,maxWidth:600,margin:"0 auto"}}>
          Cantera 1D FreeFlame (~10–15 s) and 0D const-P autoignition (~2–5 s) are off by default to keep the rest of the app responsive.
          <br/><br/>
          Click <strong style={{color:C.good}}>ACTIVATE</strong> above to mount the panel. While deactivated, no calculations run — even the local correlation-based sweeps and blowoff scans are paused.
        </div>
      </div>
    </div>);
  }

  // ─── ACTIVE RENDER ────────────────────────────────────────────────────
  // Everything below assumes flameActive=true. Real Tmix, real bk/bkIgn,
  // real sweeps. Scalar derivations don't need to be hooks — they just
  // recompute every render in this branch, which is cheap and safe.
  const localSL=calcSL(fuel,phi,Tmix,P)*100;
  const SL=accurate&&bk.data?bk.data.SL*100:localSL;
  const mk={x:phi,y:uv(units,"SL",SL),label:`${uv(units,"SL",SL).toFixed(1)} ${uu(units,"SL")}`};
  // ───── Premixer stability metrics ─────
  // SL in m/s for these formulas (SL state variable is cm/s).
  const SL_ms=SL/100;
  // Zukoski blow-off time (s): τ_BO = D_flameholder / (1.5 · S_L).
  // Time for the flame to detach from the bluff body. Longer τ_BO means
  // the anchor is more resistant to BLOW-OFF (flame swept downstream).
  // It is NOT a flashback metric — flashback is the flame propagating
  // upstream against the flow, governed by separate criteria
  // (Lewis-von Elbe boundary-layer gradient g_c, CIVB, and turbulent
  // core flashback via S_T) which are computed elsewhere on the panel.
  const tau_BO=Dfh/Math.max(1.5*SL_ms,1e-20);
  // Thermal diffusivity of unburnt mixture (m²/s). Prefer Cantera α_th from the flame response.
  const alphaTh=(accurate&&bk.data&&bk.data.alpha_th_u)?bk.data.alpha_th_u:alphaThU(Tmix,P);
  // Lewis–von Elbe critical boundary-velocity gradient (1/s): g_c = S_L² / α_th. Higher g_c = higher flashback resistance.
  const g_c=(SL_ms*SL_ms)/Math.max(alphaTh,1e-20);

  // ── Card 1: Flame Speed & Regime Diagnostics — derived quantities ─────
  // All transport-derived numbers come from Cantera (bk.data) when accurate
  // mode is on; otherwise we fall back to JS approximations.
  //
  //   δ_F   : Zeldovich flame thickness (m) = α_th / S_L. (Williams 1985)
  //   ν     : kinematic viscosity (m²/s) of the unburned mixture.
  //   Le_eff: B-M Eq. 6 weighted average of Le_E (excess) and Le_D (deficient).
  //           Hawkes-Chen 2004 mole-weighted aggregate D_fuel for blends.
  //   Le_E  : Lewis number of excess reactant (lean → O₂; rich → fuel).
  //   Le_D  : Lewis number of deficient reactant (lean → fuel; rich → O₂).
  //   Ma    : Markstein per B-M Eq. 12, sheet ref, λ=T^(1/2):
  //           Ma = γ_1/σ + ½·β·(Le_eff−1)·γ_2 with σ=ρ_u/ρ_b.
  //   u'    : turbulence velocity = (u'/U) · V_ref, in m/s.
  //   l_T   : integral length scale (m). Auto = 0.1·L_char (Tennekes-Lumley).
  //   Re_T  : turbulent Reynolds = u'·l_T / ν.
  //   Ka    : Karlovitz number, from Bradley (0.157·(u'/SL)²·Re_T^-0.5).
  //   Da_regime : Borghi Damköhler = (l_T/δ_F)·(SL/u') = τ_T/τ_chem.
  //              (Distinct from Card 2's Da_BO = τ_flow/τ_chem with τ_flow=L_char/V_ref.)
  //   S_T   : Bradley turbulent flame speed = 0.88·u'·Ka^(-0.3)/Le_eff.
  const delta_F = (accurate && bk.data && bk.data.delta_F)
    ? bk.data.delta_F
    : alphaTh / Math.max(SL_ms, 1e-9);
  const nu_u = (accurate && bk.data && bk.data.nu_u)
    ? bk.data.nu_u
    : alphaTh / 0.71;     // Pr ≈ 0.71 fallback for hot air
  const Le_eff = (accurate && bk.data && bk.data.Le_eff)
    ? bk.data.Le_eff
    : lewisNumberFreeMode(fuel);
  // Le_E (excess reactant) and Le_D (deficient reactant) per Bechtold-Matalon
  // Eq. 6 weighting. Backend returns both as of v6 schema. In free mode we
  // don't have a per-reactant breakdown — fall back to Le_eff for both.
  const Le_E_eff = (accurate && bk.data && Number.isFinite(bk.data.Le_E)) ? bk.data.Le_E : Le_eff;
  const Le_D_eff = (accurate && bk.data && Number.isFinite(bk.data.Le_D)) ? bk.data.Le_D : Le_eff;
  const Ma_eff = (accurate && bk.data && Number.isFinite(bk.data.Ma))
    ? bk.data.Ma
    : 0;     // Free-mode placeholder — Phase 4 will fit this per fuel
  // Resolve u' reference per the Card 1 toggle (Option B). Same
  // resolution is repeated inside the trail-push useEffect above so
  // the dot on the Borghi diagram is computed identically.
  const uReferenceVal = (uReference === "vpremix") ? Vpremix : velocity;
  const uPrime = uPrimeRatio * Math.max(uReferenceVal, 0);
  const lT_auto = 0.1 * Math.max(Lchar, 1e-6);
  const lT = (lTOverride && lTOverride > 0) ? lTOverride : lT_auto;
  const bradley = bradleyST(SL_ms, Math.max(uPrime, 1e-9), lT, nu_u, Le_eff);
  const ReT_diag = bradley.ReT;
  const Ka_diag = bradley.Ka;
  const Da_diag = (lT / Math.max(delta_F, 1e-12)) * (SL_ms / Math.max(uPrime, 1e-9));
  const ST_bradley = bradley.ST;
  const ST_damk    = damkohlerST(SL_ms, Math.max(uPrime, 1e-9));
  // τ_chem (Williams) = α_th / S_L²; ms for display.
  const tau_chem_ms = (alphaTh / Math.max(SL_ms*SL_ms, 1e-18)) * 1000;

  // ── Card 2: Stabilization & Blowoff — derived quantities ─────────────
  // Da_crit from the premixer-type catalog given the user's secondary
  // input(s). Falls back to 0.05 if catalog lookup fails (defensive).
  const _typeEntry = PREMIXER_TYPES[premixerType] || PREMIXER_TYPES.swirl;
  const _typeParams = { swirlNumber, gutterAngleDeg, expansionRatio, holeDiamMm };
  const Da_crit = (() => {
    try { return Math.max(0.001, +_typeEntry.daCrit(_typeParams) || 0.05); }
    catch { return 0.05; }
  })();
  // Headline ratio Da_actual / Da_crit.
  //   > 3 : robust margin (green)
  //   1–3 : marginal     (yellow)
  //   ≤ 1 : blow-off     (red)
  // Note: bo.Da reuses the existing Damköhler from the lower card (it's
  // computed via useMemo above, so available here).
  const Da_actual = bo.Da;
  const Da_ratio = Da_actual / Math.max(Da_crit, 1e-9);
  const Da_status = Da_ratio > 3 ? "green" : Da_ratio > 1 ? "yellow" : "red";
  // V_BO_card2: the reference velocity at which Da would equal Da_crit
  // (linear in V_ref since τ_flow ∝ 1/V).
  const V_BO_card2 = velocity * Math.max(Da_ratio, 1e-9);

  // ── Lefebvre φ_LBO BAND (LP-sweep approach, no ṁ_air or V_pz needed) ──
  // We sweep the loading parameter LP = ṁ_air/(V_pz·P_3_atm^1.3) over the
  // typical industrial-GT design band (10–30 kg/(s·m³·atm^1.3)) and return
  // φ_LBO at each end. The user's actual LP is unknown (depends on a
  // V_pz/ṁ_air pair that's calibration-fragile); the BAND captures the
  // realistic LBO uncertainty. T_3 and fuel properties are the only inputs
  // that survive — P_3, V_pz, and ṁ_air all cancel out algebraically
  // (since the loading parameter folds them into one quantity).
  const _fp_card2 = calcFuelProps(fuel, ox);                          // {LHV_mass, AFR_mass, ...}
  const T3_lbo_K  = (cycleResult && cycleResult.T3_K) ? cycleResult.T3_K : T0;
  const _FAR_stoich_lbo = 1 / Math.max(_fp_card2.AFR_mass, 1e-12);    // mass basis
  const _lbo_band = lefebvreLBO_band(K_LBO, T3_lbo_K, _fp_card2.LHV_mass, _FAR_stoich_lbo, phi, fuel);
  const phi_LBO_low  = _lbo_band.phi_low;
  const phi_LBO_high = _lbo_band.phi_high;
  const lbo_status   = _lbo_band.status;     // "SAFE" | "ALARM" | "HIGH_RISK" | "—"
  // Status colour for the badge (SAFE green / ALARM warm / HIGH_RISK strong).
  const _lbo_col = lbo_status === "SAFE" ? C.good
                 : lbo_status === "ALARM" ? C.warm
                 : lbo_status === "HIGH_RISK" ? C.strong
                 : C.txtMuted;
  // Backward-compat aliases — some downstream JSX still reads phi_LBO_safe.
  const phi_LBO_safe = lbo_status === "SAFE";

  // ── Plee-Mellor 1979 LBO cross-check ─────────────────────────────────
  // Eq. 17 (Configuration A — 45° conical baffle, propane fit to Ballal-
  // Lefebvre data):  τ_hc' = 1e-4 · (T_φ/T_in) · exp(21000/(R·T_φ))  (msec)
  // Stable when τ_sl/τ_hc' > 2.11 (Plee-Mellor Fig. 5 LBO line).
  // T_φ = adiabatic flame T at approach φ; we use T_b from Cantera when
  // available, else fall back to a 1800 K placeholder consistent with the
  // Card 3 BLF gate. L = bluff-body recirc length ≈ Lchar; V = velocity.
  const _PM_T_phi   = (accurate && bk.data && bk.data.T_max) ? bk.data.T_max : 1800;
  const _PM_T_in    = Math.max(T3_lbo_K, 1);   // approach gas T (compressor discharge)
  const _PM_EaR_K   = 21000.0 / 1.987;         // 21000 cal/mol / R(cal·K⁻¹·mol⁻¹) ≈ 10568 K
  const pm_tau_hc_ms = 1e-4 * (_PM_T_phi / _PM_T_in) * Math.exp(_PM_EaR_K / Math.max(_PM_T_phi, 1));
  const pm_tau_sl_ms = (Math.max(Lchar, 1e-9) / Math.max(velocity, 1e-9)) * 1000;
  const pm_ratio     = pm_tau_sl_ms / Math.max(pm_tau_hc_ms, 1e-12);
  const pm_lbo_safe  = pm_ratio > 2.11;
  const pm_marginal  = pm_lbo_safe && pm_ratio < 2.11 * 1.3;

  // Sweep arrays for the two small charts under Card 2.
  // φ_LBO BAND vs T_3: T_3 from 500 to 900 K. Each row is the band at that
  // T_3 for the typical LP range. Both edges plotted so the chart shows the
  // band envelope (low and high lines).
  const lbo_T3_sweep = (() => {
    const r = [];
    for (let T3 = 500; T3 <= 900; T3 += 25) {
      const b = lefebvreLBO_band(K_LBO, T3, _fp_card2.LHV_mass, _FAR_stoich_lbo, phi, fuel);
      r.push({ T: uv(units, "T", T3), phiLBO_low: b.phi_low, phiLBO_high: b.phi_high });
    }
    return r;
  })();
  // V_BO vs L_char: L_char from 5 mm to 100 mm at fixed V_ref. V_BO
  // scales linearly with L_char (since Da ∝ L_char / V_ref).
  const vbo_Lchar_sweep = (() => {
    const r = [];
    for (let Lc_mm = 5; Lc_mm <= 100; Lc_mm += 5) {
      const Lc = Lc_mm / 1000;       // m
      // At V=V_ref, Da scales as Lc / Lchar. V_BO = V_ref * (Da_at_Lc / Da_crit).
      const Da_at_Lc = Da_actual * (Lc / Math.max(Lchar, 1e-9));
      const V_BO_at_Lc = velocity * Math.max(Da_at_Lc / Math.max(Da_crit, 1e-9), 1e-6);
      r.push({ L: uv(units, "len", Lc), VBO: uv(units, "vel", V_BO_at_Lc) });
    }
    return r;
  })();

  // ── Card 3: Premixer Flashback & Autoignition — three flashback gates
  //  + autoignition gate.
  //
  //  Card 3's u' uses V_premix EXCLUSIVELY (not the Card 1 toggle), since
  //  the question is intrinsically about the premixer-channel turbulence
  //  upstream of the flame. The Card 1 toggle exists for the regime
  //  diagnostic (where the answer depends on whether you're characterizing
  //  the anchor region or the upstream channel); Gate C of Card 3 has a
  //  definite physical answer.
  const uPrime_premix = uPrimeRatio * Math.max(Vpremix, 0);
  const lT_premix = 0.10 * Math.max(D_h_premix, 1e-6);    // l_T = 0.1·D_h

  // H₂ fraction in the fuel — needed by every Card 3 gate that has an
  // H₂-rich branch (confined-flame √σ_ρ correction in Gate A, tightened
  // CIVB threshold in Gate B, GRI-3.0 mechanism advisory in Gate D, the
  // turbulent-flame-speed multiplier in the core flashback gate, and
  // the thermodiffusive Le<1 advisory). Declared HERE — before any of
  // those references — to avoid a Temporal Dead Zone error that turned
  // the whole panel into a black screen on the live site.
  const H2_frac = (fuel.H2 || 0) / Math.max(Object.values(fuel).reduce((a,b)=>a+b,0), 1e-9);

  // Shaffer-Duan-McDonell 2013 (J Eng GT 135:011502) Eq. 4 — predicted
  // burner-tip temperature at flashback for the current fuel composition
  // and approach AFT. Used as an advisory beside the BLF gate: per
  // Shaffer §4.5 the tip T is what physically drives BLF runaway in
  // H₂-rich blends (heat transfer to the burner rim raises local Tu,
  // raises S_L, reduces δ_q, all of which lower g_c). Linear formula:
  //   T_tip = -1.58·H₂% - 3.63·CO% - 4.28·CH₄% + 0.38·AFT [K]
  // Composition fed in mole-percent (sum = 100). AFT is the bulk
  // adiabatic flame T at approach φ; we use Cantera's T_max when in
  // accurate mode, else the 1800 K Card 3 placeholder.
  const _tot_fuel_pct = Math.max(Object.values(fuel).reduce((a,b)=>a+b,0), 1e-9);
  const _H2_pct  = ((fuel.H2  || 0) / _tot_fuel_pct) * 100;
  const _CO_pct  = ((fuel.CO  || 0) / _tot_fuel_pct) * 100;
  const _CH4_pct = ((fuel.CH4 || 0) / _tot_fuel_pct) * 100;
  const _AFT_card3 = (accurate && bk.data && bk.data.T_max) ? bk.data.T_max : 1800;
  const shaffer_tip_T_K = -1.58 * _H2_pct - 3.63 * _CO_pct - 4.28 * _CH4_pct + 0.38 * _AFT_card3;
  // Shaffer Eq. 4 was fit on H₂/CO/CH₄ blends at AFT = 1700-1900 K with
  // significant H₂ content. For CH₄-rich (>50%) low-H₂ (<10%) fuels it
  // extrapolates and returns T_tip < T_air, which is non-physical (the
  // burner tip can't be colder than the inlet air). Suppress display
  // outside the calibration window and route callers through the OOR flag.
  const T_air_for_shaffer = Tair || 300;
  const shaffer_T_tip_OOR = (shaffer_tip_T_K < T_air_for_shaffer) || (_CH4_pct > 50 && _H2_pct < 10);

  // Spadaccini-Colket τ_ign extrapolation guard. Calibration range is roughly
  // T = 1000-1500 K; below T_premix ≈ 800 K the exponential blows up and
  // returns τ_ign on the order of years — meaningless. Mark as OOR when
  // τ_ign > 1000 s; the underlying physics ("mixture is thermo-kinetically
  // stable, cannot autoignite") is correct but the number is useless.
  const tau_ign_OOR_threshold_s = 1000.0;

  // ── Gate A: boundary-layer flashback (Lewis-von Elbe / Lieuwen 2021) ──
  // Per Lieuwen, "Unsteady Combustor Physics" 2nd ed., Ch. 10 §10.1.2.1
  // (pp. 382-385). Flashback condition (Eq. 10.4):
  //     g_u · δ_q / s_d^u = 1     →   flashback when g_u·δ_q < s_d^u
  // Equivalent flashback Karlovitz (Eq. 10.5, assuming δ_q ∝ δ_F):
  //     Ka_fb = g_u · δ_F / s_d^u
  // Pass criterion: Ka_fb ≥ 1 (wall shear fast enough to keep the flame
  // swept downstream).
  //
  // For laminar boundary layers the Poiseuille-flow estimate g_u_pipe ≈
  // 8·V/D_h is the wall gradient. For TURBULENT boundary layers,
  // Lieuwen p. 385 reports g_u,turbulent ≈ 3·g_u,laminar (Eichler-
  // Sattelmayer 2011). We model this as a multiplier (1 + ε_turb), with
  // ε_turb ≈ 0 for laminar (factor 1) up to ε_turb ≈ 2 for fully
  // turbulent (factor 3). Default 0.7 is mid-range, conservative.
  //
  // For H₂-rich flames in CONFINED channels, Lieuwen Fig. 10.9 (p. 387)
  // shows g_u,confined / g_u,unconfined ≈ √σ_ρ to σ_ρ, where σ_ρ = T_b/T_u
  // — i.e. confinement raises the EFFECTIVE critical g_c by gas-expansion
  // back-pressure. We apply √σ_ρ when H₂ > 30% as the conservative
  // mid-range; richer H₂ should be flagged for CFD.
  const g_u_pipe   = 8 * Vpremix / Math.max(D_h_premix, 1e-6);
  const g_u_actual = g_u_pipe * (1 + eps_turb);
  // T_b: prefer Cantera flame T_max when available; else estimate from φ.
  const T_b_card3  = (accurate && bk.data && bk.data.T_max) ? bk.data.T_max : 1800;
  const sigma_rho  = T_b_card3 / Math.max(Tmix, 1);
  const confine_correction = (H2_frac > 0.30) ? Math.sqrt(Math.max(sigma_rho, 1)) : 1.0;
  const g_c_eff    = g_c * confine_correction;
  const Ka_flashback = (g_u_actual > 0 && SL_ms > 0)
    ? (g_u_actual * delta_F) / SL_ms
    : NaN;
  const gateA_pass    = g_u_actual > g_c_eff;       // equivalently Ka_fb ≥ 1
  const gateA_margin  = g_u_actual / Math.max(g_c_eff, 1e-9);
  // Legacy alias for the Card 3 JSX (still reads g_actual)
  const g_actual = g_u_actual;

  // ── Gate B: CIVB (Combustion-Induced Vortex Breakdown) ────────────
  // Sattelmayer 2004 (J. Eng. Gas Turbines Power 126:276-283):
  //   Π_CIVB = S_L · D_h / Γ_swirl, with Γ_swirl = S_n · V_premix · D_h · π
  //          ⇒ Π_CIVB = S_L / (S_n · V_premix · π)
  // Empirical threshold: 0.05 (natural gas); tightened to 0.03 for H₂
  // blends > 30% (Sattelmayer 2014, J. Eng. Gas Turbines Power 138:011503).
  //
  // Physical context (Lieuwen, Unsteady Combustor Physics 2nd ed.,
  // §4.4.2 pp. 147-150 + §10.1.1 pp. 381-382):
  //   • Vortex breakdown is BISTABLE: S < S_A (no breakdown), S > S_B
  //     (always breakdown), S_A < S < S_B (hysteresis depending on
  //     initial conditions).
  //   • For typical combustor jets at a_core/a ≈ 0.56, χ = 1/3 the
  //     S_B breakdown threshold is S_v ≈ 0.6-0.85 (Lieuwen Fig. 4.39).
  //   • CIVB occurs when the FLAME's adverse pressure gradient + radial
  //     divergence acts as the finite-amplitude perturbation that flips
  //     the system from non-breakdown into breakdown — even when the
  //     non-reacting flow itself is sub-S_B. Π_CIVB captures when this
  //     flame-driven mechanism activates.
  //
  // Only meaningful when the premixer type is "swirl" — for non-swirl
  // architectures CIVB doesn't apply (gate is auto-pass with N/A label).
  const civb_applicable = (premixerType === "swirl");
  const civb_threshold = (H2_frac > 0.30) ? 0.03 : 0.05;
  const piCIVB = civb_applicable
    ? SL_ms / Math.max(swirlNumber * Math.max(Vpremix, 1e-9) * Math.PI, 1e-12)
    : 0;
  const gateB_pass = !civb_applicable || piCIVB < civb_threshold;

  // ── Gate C: turbulent core flashback (Bradley 1992) ─────────────────
  // S_T from Bradley using V_premix-based u' and 0.1·D_h length scale.
  // Margin = V_premix / S_T. Pass: > 1.43 (≈ 1/0.7, 30% margin).
  const bradley_premix = bradleyST(SL_ms,
                                    Math.max(uPrime_premix, 1e-9),
                                    lT_premix, nu_u, Le_eff);
  const ST_premix = bradley_premix.ST;
  const ST_premix_dk = damkohlerST(SL_ms, Math.max(uPrime_premix, 1e-9));
  const v_st_margin = Vpremix / Math.max(ST_premix, 1e-9);
  const gateC_pass = v_st_margin > 1.43;

  // Autoignition delay τ_ign (s) — needed by Gate D below AND by the
  // legacy "premixer safe" rollup further down. Declared HERE to avoid
  // a Temporal Dead Zone error: Gate D references tau_ign and the old
  // declaration was below Gate D.
  //   Accurate mode → Cantera 0D const-P reactor; if cutoff is reached
  //                   without ignition, report τ_ign > cutoff and use
  //                   the cutoff as a conservative lower bound.
  //   Free mode     → Spadaccini–Colket NG correlation. Suppressed for
  //                   fuels with H₂ > 5% or non-hydrocarbons (out of cal).
  const nonNGFuel       = H2_frac > 0.05 || (fuel.CO || 0) > 0.01 || (fuel.NH3 || 0) > 0;
  const freeCorrValid   = !nonNGFuel;
  const accurateIgn     = accurate && bkIgn.data;
  const tau_ign_source  = accurateIgn ? "cantera" : (freeCorrValid ? "spad_colk" : "none");
  let tau_ign, tau_ign_is_lower_bound;
  if (accurateIgn)            { tau_ign = bkIgn.data.tau_ign_s;    tau_ign_is_lower_bound = !bkIgn.data.ignited; }
  else if (freeCorrValid)     { tau_ign = calcTauIgnFree(Tmix, P); tau_ign_is_lower_bound = false; }
  else                        { tau_ign = NaN;                     tau_ign_is_lower_bound = false; }

  // ── Gate D: autoignition (RTD-corrected) ───────────────────────────
  // τ_res,99 = RTD_multiplier · (L_premix / V_premix). Pass: τ_ign /
  // τ_res,99 ≥ 3. Reuses the existing tau_ign (bk-fed in accurate mode)
  // and tau_ign_is_lower_bound flag.
  const tau_res_mean = Lpremix / Math.max(Vpremix, 1e-20);
  const tau_res_99 = RTD_multiplier * tau_res_mean;
  const ign_margin_card3 = isFinite(tau_ign) ? tau_ign / Math.max(tau_res_99, 1e-20) : NaN;
  const gateD_pass = isFinite(tau_ign) && ign_margin_card3 >= 3;

  // Combined PASS / FAIL for the whole Card 3 status chip.
  // FAIL if any one of the four gates fails. WARN if all pass but at
  // least one is "marginal" (within 20% of its threshold). PASS otherwise.
  const gateA_marginal = gateA_pass && gateA_margin < 1.2;
  const gateC_marginal = gateC_pass && v_st_margin < 1.43 * 1.2;
  const gateD_marginal = gateD_pass && ign_margin_card3 < 3.6;
  const gateB_marginal = gateB_pass && civb_applicable && piCIVB > civb_threshold * 0.8;
  const all_pass = gateA_pass && gateB_pass && gateC_pass && gateD_pass;
  const any_marginal = gateA_marginal || gateB_marginal || gateC_marginal || gateD_marginal;
  const card3_status = !all_pass ? "FAIL" : (any_marginal ? "WARN" : "PASS");

  // H₂-mechanism advisory: warn when fuel has > 30 % H₂ AND user is
  // still on GRI-Mech 3.0 (validated only for NG-like fuels).
  const ig_mech_warn = (H2_frac > 0.30) && (igMechanism === "gri30");

  // (Trail effects moved above the early return — see ABOVE the
  // `if(!flameActive)` block in this same component. Hooks rules require
  // identical hook call order on every render, so the trail-reset and
  // trail-push useEffects can't live in the active branch.)
  // (Autoignition block — nonNGFuel/freeCorrValid/accurateIgn/tau_ign —
  //  was moved above Gate D to fix a TDZ. See the comment block above
  //  Gate D in this same component.)
  // Premixer residence time (s): τ_res = L_premix / V_premix.
  const tau_res=Lpremix/Math.max(Vpremix,1e-20);
  // Autoignition safety — τ_ign / τ_res. ≥ 3 is robust (gating threshold).
  //   1–3 marginal; < 1 means the mixture will autoignite before exiting the premixer.
  const ignition_margin=isFinite(tau_ign)?tau_ign/Math.max(tau_res,1e-20):NaN;
  const ignition_safe=isFinite(tau_ign)&&ignition_margin>=3;
  // ───── Core flashback (flame propagation) criterion ─────
  // Estimated turbulent flame speed S_T ≈ S_L · turb_factor (conservative screening).
  //   H2 > 30 %: 2.5 — turbulent wrinkling + Le<1 thermodiffusive acceleration
  //   otherwise:  1.8 — turbulent wrinkling only (Le ≈ 1 hydrocarbons)
  // For detailed design, replace this with measured or CFD-derived S_T/S_L.
  const turb_factor=H2_frac>0.30?2.5:1.8;
  const S_T_est=SL_ms*turb_factor;                                          // m/s
  const flashback_margin=Vpremix/Math.max(S_T_est,1e-20);
  // Safe if V_premix exceeds S_T by ~30 % (flashback_margin > 1/0.7 ≈ 1.43).
  const core_flashback_safe=flashback_margin>1/0.7;
  // Lewis-number (thermodiffusive) advisory when fuel has > 30 % H₂.
  const h2_thermodiffusive_warn=H2_frac>0.30;
  // Overall PREMIXER SAFE = BOTH autoignition robust AND core-flashback margin hold.
  const premixer_safe=ignition_safe&&core_flashback_safe;
  const risk_label=(!ignition_safe&&!core_flashback_safe)?"AUTOIGN + FLASHBACK RISK"
                 :(!ignition_safe?"AUTOIGNITION RISK"
                 :(!core_flashback_safe?"FLASHBACK RISK":"PREMIXER SAFE"));
  return(<div style={{display:"flex",flexDirection:"column",gap:12}}>
    <InlineBusyBanner loading={accurate&&(bk.loading||(bkIgn&&bkIgn.loading))}/>
    {/* DEACTIVATE button — same pattern as the PSR-PFR panel. Clicking it
        flips flameActive=false, which short-circuits every useMemo above
        and bails out into the placeholder JSX. */}
    <button onClick={()=>setFlameActive(false)}
      title="Click to deactivate — stops firing the Cantera Flame Speed and Autoignition backends and pauses every local sweep."
      style={{padding:"10px 16px",fontSize:13,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".7px",
        color:C.good,background:`${C.good}18`,border:`2px solid ${C.good}`,
        borderRadius:6,cursor:"pointer",
        display:"flex",alignItems:"center",justifyContent:"center",gap:10,
        transition:"all .12s"}}>
      <span style={{width:10,height:10,borderRadius:"50%",background:C.good,boxShadow:`0 0 8px ${C.good}`}}/>
      ACTIVATED — Cantera Flame Speed + Autoignition running on every change
    </button>
    <KeepActivatedToggle on={!!keepActivated} onChange={setKeepActivated} panelLabel="Flame Speed"/>
    <HelpBox title="ℹ️ Flame Speed & Blowoff — How It Works">
      <p style={{margin:"0 0 6px"}}>Three vertically-stacked cards diagnose <span style={hs.em}>flame stability</span> at the current operating point. Each answers a distinct question with its own bold gate criterion:</p>
      <p style={{margin:"0 0 6px"}}>
        <strong style={{color:C.violet}}>Card 1 · Flame Speed &amp; Regime Diagnostics</strong> — what combustion regime is the flame in? The Borghi-Peters diagram places the operating point relative to the Ka=1 / Ka=100 / Da=1 / Re_T=1 reference lines. Lewis &amp; Markstein chips flag thermo-diffusive stability.
      </p>
      <p style={{margin:"0 0 6px"}}>
        <strong style={{color:C.accent2}}>Card 2 · Stabilization &amp; Blowoff</strong> — will the flame anchor, or be swept downstream? Pick the premixer type to load the right Da_crit; the headline gate is <strong>Da/Da_crit &gt; 1</strong> (with &gt; 3 design margin) and Lefebvre's <strong>φ &gt; φ_LBO + 0.05</strong> margin.
      </p>
      <p style={{margin:"0 0 6px"}}>
        <strong style={{color:C.accent}}>Card 3 · Premixer Flashback &amp; Autoignition</strong> — will the flame propagate upstream, or auto-ignite in the premixer? Three flashback gates (boundary-layer, CIVB, turbulent core via Bradley) plus the Cantera 0D τ_ign gate. Single <strong>PREMIXER STATUS: PASS / WARN / FAIL</strong> chip combines all four.
      </p>
      <p style={{margin:0,fontSize:11,color:C.txtMuted}}>Vocabulary: <strong>blow-off</strong> = flame swept downstream (Card 2); <strong>flashback</strong> = flame propagates upstream (Card 3); <strong>autoignition</strong> = mixture spontaneously ignites with no external flame (Card 3, separate gate). Underlying correlations: Bradley/Lau/Lawes 1992, Sattelmayer 2004 (CIVB), Lefebvre 1985 (LBO), Lewis-von Elbe 1943 (boundary-layer), Cantera 1D FreeFlame + 0D const-P. Full assumptions in the <strong>Assumptions</strong> tab.</p>
    </HelpBox>

    {/* ═══════════ CARD 1 — FLAME SPEED & REGIME DIAGNOSTICS ═══════════ */}
    {/* Phase 1 of the redesign. Houses the laminar core (S_L, δ_F, α_th,
        ν, τ_chem), the dimensionless trio (u'/S_L, l_T/δ_F, Ka, Da), the
        Lewis & Markstein chips, and the interactive Borghi-Peters regime
        diagram. Inputs row gives the user u'/U (turbulence intensity)
        and l_T (integral length scale, auto = 0.1·L_char). */}
    <div style={S.card}>
      <div style={S.cardT}>
        Flame Speed &amp; Regime Diagnostics {accurate&&(bk.loading?<span style={{fontSize:10,color:C.accent2,marginLeft:8,fontFamily:"monospace"}}>⟳ CANTERA…</span>:bk.err?<span style={{fontSize:10,color:C.warm,marginLeft:8,fontFamily:"monospace"}}>⚠ {bk.err}</span>:bk.data?<span style={{fontSize:10,color:C.accent,marginLeft:8,fontFamily:"monospace",fontWeight:700}}>✓ CANTERA (1D FreeFlame)</span>:null)}
      </div>

      {/* ── Inputs row (u' reference, u'/U slider, l_T) ───────────────── */}
      <div style={{display:"flex",gap:14,alignItems:"center",flexWrap:"wrap",marginBottom:12,padding:"8px 10px",background:`${C.accent}08`,border:`1px solid ${C.accent}30`,borderRadius:6}}>
        {/* u' reference selector — drives the U in u' = (u'/U)·U everywhere on the panel */}
        <div style={{display:"flex",alignItems:"center",gap:5}}>
          <Tip text="Which reference velocity feeds u'.\n• V_ref (flame anchor): approach velocity into the flame-anchoring zone. Use for blow-off, Borghi regimes, anchor-side turbulence.\n• V_premix (channel): bulk velocity through the premixer channel. Use for upstream flashback questions where the channel turbulence governs the flame's ability to propagate into the premixer."><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help",whiteSpace:"nowrap"}}>u' ref ⓘ</label></Tip>
          <div style={{display:"flex",border:`1px solid ${C.violet}55`,borderRadius:5,overflow:"hidden",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".4px"}}>
            <button onClick={()=>setUReference("vref")}
              title={`Use V_ref (flame anchor) = ${uv(units,"vel",velocity).toFixed(1)} ${uu(units,"vel")}`}
              style={{padding:"3px 8px",fontSize:10,fontWeight:700,
                color:uReference==="vref"?C.bg:C.violet,
                background:uReference==="vref"?C.violet:"transparent",
                border:"none",cursor:"pointer"}}>V_ref</button>
            <button onClick={()=>setUReference("vpremix")}
              title={`Use V_premix (channel) = ${uv(units,"vel",Vpremix).toFixed(1)} ${uu(units,"vel")}`}
              style={{padding:"3px 8px",fontSize:10,fontWeight:700,
                color:uReference==="vpremix"?C.bg:C.violet,
                background:uReference==="vpremix"?C.violet:"transparent",
                border:`1px solid ${C.violet}55`,borderLeft:"none",cursor:"pointer"}}>V_premix</button>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6,flex:"1 1 240px"}}>
          <Tip text="Turbulence intensity u'/U. 0.10 = smooth duct or flow-conditioned premixer; 0.20 = swirl-stabilized DLN; 0.30 = highly turbulated dump combustor. Drives Re_T, Ka, Da and the Bradley turbulent flame speed."><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help",whiteSpace:"nowrap"}}>u'/U ⓘ</label></Tip>
          <input type="range" min="0.05" max="0.30" step="0.01" value={uPrimeRatio} onChange={e=>setUPrimeRatio(+e.target.value)} style={{flex:1,accentColor:C.violet,minWidth:90}}/>
          <NumField value={uPrimeRatio} decimals={2} onCommit={v=>setUPrimeRatio(Math.max(0.01,Math.min(0.5,+v)))} style={{width:54,padding:"3px 5px",fontFamily:"monospace",color:C.violet,fontSize:11.5,fontWeight:700,background:C.bg,border:`1px solid ${C.violet}50`,borderRadius:4,textAlign:"center",outline:"none"}}/>
          <span style={{fontSize:10,color:C.txtDim,fontFamily:"monospace",whiteSpace:"nowrap"}}>u' = {uv(units,"vel",uPrime).toFixed(2)} {uu(units,"vel")} <span style={{color:C.txtMuted}}>({uReference==="vpremix"?"V_premix":"V_ref"})</span></span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <Tip text="Integral turbulent length scale l_T. Default auto = 0.1·L_char (Tennekes-Lumley). Override for specific geometries: ~grid spacing × 0.2 for turbulence grids, ~0.1·D_swirl for swirl premixers."><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help",whiteSpace:"nowrap"}}>l_T ({uu(units,"len")}) ⓘ</label></Tip>
          <NumField value={uv(units,"len",lT)} decimals={5} onCommit={v=>{const lt=uvI(units,"len",+v);setLTOverride(lt>0?lt:null);}}
            style={{...S.inp,width:90,fontSize:11.5}}/>
          <button onClick={()=>setLTOverride(null)}
            disabled={!lTOverride}
            title="Reset to auto = 0.1·L_char"
            style={{padding:"3px 8px",fontSize:10,fontWeight:600,fontFamily:"'Barlow Condensed',sans-serif",
              color:lTOverride?C.accent:C.txtMuted,
              background:"transparent",border:`1px solid ${lTOverride?C.accent:C.border}`,
              borderRadius:4,cursor:lTOverride?"pointer":"default",letterSpacing:".4px"}}>auto</button>
        </div>
      </div>

      {/* ── Row 1: laminar core ────────────────────────────────────────── */}
      <div style={{...S.row,gap:8,marginBottom:8}}>
        <M l="Laminar Flame Speed (S_L)" v={uv(units,"SL",SL).toFixed(2)} u={uu(units,"SL")} c={C.violet} tip="Laminar burning velocity from the Cantera 1D FreeFlame solve (mixture-averaged transport)."/>
        <M l="Flame Thickness (δ_F)" v={(delta_F*1000).toFixed(3)} u="mm" c={C.accent} tip={`Zeldovich flame thickness δ_F = α_th / S_L. ${(accurate&&bk.data&&bk.data.delta_F)?"From Cantera transport.":"JS approximation (Cantera disabled)."} Drops with pressure (~1/P^0.5) — typical CH₄/air at 1 atm: 0.3 mm; at 20 atm: 0.05 mm. Used to non-dimensionalize l_T in the Borghi diagram.`}/>
        <M l="Thermal Diffusivity (α_th)" v={(alphaTh*1e6).toFixed(2)} u="mm²/s" c={C.accent3} tip={`α_th = k/(ρ·c_p) at T_mixed, P, X_unburned. ${(accurate&&bk.data&&bk.data.alpha_th_u)?"From Cantera transport.":"Free-mode: 2.0e-5·(T/300)^1.7 / P[atm]."}`}/>
        <M l="Kinematic Viscosity (ν)" v={(nu_u*1e6).toFixed(2)} u="mm²/s" c={C.accent3} tip={`ν = μ/ρ at T_mixed, P, X_unburned. ${(accurate&&bk.data&&bk.data.nu_u)?"From Cantera transport.":"Free-mode: α_th / Pr ≈ α_th / 0.71."}`}/>
        <M l="Chemical Time (τ_chem)" v={tau_chem_ms.toFixed(4)} u="ms" c={C.violet} tip="τ_chem = α_th / S_L² = δ_F / S_L. Ratio τ_T/τ_chem is the Damköhler number."/>
        <M l="Re_T" v={ReT_diag>=1e4?ReT_diag.toExponential(1):ReT_diag.toFixed(0)} u="—" c={C.accent2} tip="Turbulent Reynolds number Re_T = u'·l_T / ν. > 100 → fully turbulent regime."/>
      </div>

      {/* ── Row 2: dimensionless trio + regime ─────────────────────────── */}
      <div style={{...S.row,gap:8,marginBottom:10}}>
        <M l="u'/S_L" v={(uPrime/Math.max(SL_ms,1e-9)).toFixed(2)} u="—" c={C.violet} tip="Turbulence intensity ratio. <1: laminar wrinkling; ≫1: thin reaction zone."/>
        <M l="l_T/δ_F" v={(lT/Math.max(delta_F,1e-12)).toFixed(0)} u="—" c={C.accent} tip="Length scale ratio. >>1: large eddies stretch a thin flame; ~1: small eddies penetrate."/>
        <M l="Karlovitz (Ka)" v={Ka_diag<1?Ka_diag.toFixed(3):Ka_diag.toFixed(2)} u="—" c={Ka_diag<1?C.good:Ka_diag<100?C.warm:C.strong} tip={`Karlovitz number from Bradley correlation: Ka = 0.157·(u'/S_L)²·Re_T^-0.5. ${Ka_diag<1?"Ka<1: flamelet regime — every gas turbine at idle.":Ka_diag<100?"Ka>1: thin reaction zone — every gas turbine at full power.":"Ka>100: broken reaction zone — edge case."}`}/>
        <M l="Da_regime (Borghi)" v={Da_diag<10?Da_diag.toFixed(2):Da_diag.toFixed(0)} u="—" c={Da_diag>1?C.good:C.warm} tip={`Borghi REGIME Damköhler: Da_regime = (l_T/δ_F)·(S_L/u') — places the operating point on the Borghi-Peters diagram below. ${Da_diag>1?"Da_regime>1: chemistry is fast relative to turbulent timescale.":"Da_regime<1: turbulence outpaces chemistry — flame extinction risk."}\n\nDistinct from the BLOWOFF Damköhler (Da_BO) on Card 2, which is τ_flow/τ_chem with τ_flow = L_char/V_ref. Same name "Damköhler", different definitions — the two values disagree by design and that's combustion convention. Card 1 = regime placement, Card 2 = flame-anchor stability.`}/>
        <M l="S_T (Bradley)" v={uv(units,"vel",ST_bradley).toFixed(2)} u={uu(units,"vel")} c={C.accent} tip={`Turbulent flame speed via Bradley/Lau/Lawes 1992: S_T = 0.88·u'·Ka^-0.3 / Le. Cross-check (Damköhler 1940): S_T_DK = ${uv(units,"vel",ST_damk).toFixed(2)} ${uu(units,"vel")}. Disagreement >2× means you're outside both calibration ranges — typically very high u'/S_L.`}/>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",flex:"0 0 auto",padding:"0 10px"}}>
          <Tip text={`Combustion regime classification (Borghi-Peters). Ka and Da together place the operating point on the diagram below.\n• Ka<1, Da>1: laminar / corrugated flamelet (idle GTs).\n• Ka<1, Da<1: corrugated flamelet.\n• 1<Ka<100, Da>1: thin reaction zone (full-power GTs).\n• Ka>100: broken reaction zone (extinction).`}>
            <span style={{padding:"3px 10px",borderRadius:16,fontSize:10,fontWeight:600,fontFamily:"monospace",background:`${C.accent}1F`,color:C.accent,border:`1px solid ${C.accent}44`,cursor:"help"}}>{Ka_diag<1?(Da_diag>1?"● FLAMELET":"● CORRUGATED"):Ka_diag<100?"● THIN RXN ZONE":"● BROKEN RXN"} ⓘ</span>
          </Tip>
        </div>
      </div>

      {/* ── Lewis & Markstein with stability indicator ────────────────── */}
      <div style={{...S.row,gap:8,marginBottom:4}}>
        <M l="Effective Lewis (Le)" v={Le_eff.toFixed(3)} u="—" c={Le_eff<0.9?C.warm:Le_eff>1.1?C.accent3:C.good} tip={`Le_eff = Bechtold-Matalon Eq. 6 weighted average of the excess (Le_E=${Le_E_eff.toFixed(3)}) and deficient (Le_D=${Le_D_eff.toFixed(3)}) reactants. Weighting parameter A = 1 + β·(Φ−1) (β = Zeldovich number, Φ = max(φ, 1/φ)). At stoichiometry Le_eff = (Le_E+Le_D)/2; far from it Le_eff → Le_D. ${(accurate&&bk.data&&bk.data.Le_eff)?"Per-species D from Cantera mixture transport; H₂-blend Le_fuel uses Hawkes-Chen 2004 mole-weighted aggregate.":"Free-mode: composition-weighted lookup table."} Le<1 → thermo-diffusively unstable (H₂-rich GTs operate here, S_T can exceed predictions by 30–50%). Le≈1 → stable (typical hydrocarbon). Le>1 → diffusively stable (CO-rich, naphtha).`}/>
        <M l="Markstein (Ma)" v={Ma_eff.toFixed(2)} u="—" c={Ma_eff>0.5?C.good:Ma_eff<-0.5?C.warm:C.accent2} tip={`Ma per Bechtold-Matalon 2001 Eq. 12 (sheet reference, λ=T^(1/2)): Ma = γ_1/σ + ½·β·(Le_eff−1)·γ_2 with σ = ρ_u/ρ_b. ${(accurate&&bk.data&&Number.isFinite(bk.data.Ma))?"From Cantera flame analysis (full B-M expression).":"Free-mode: 0 placeholder."} +Ma: stable to wrinkling. -Ma: cellular instability. |Ma|>0.5: notable thermo-diffusive deviation from Le=1 baseline.`}/>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",flex:"0 0 auto",padding:"0 10px"}}>
          <Tip text={Ma_eff>0.5?"Ma > 0.5 — flame is thermo-diffusively stable. Standard turbulent-flamelet correlations apply.":Ma_eff<-0.5?"Ma < -0.5 — flame is thermo-diffusively unstable (cellular structure). S_T can exceed Bradley by 30-50%; treat correlations as conservative.":"|Ma| ≤ 0.5 — flame is near-neutral. Bradley S_T is a good baseline."}>
            <span style={{padding:"3px 10px",borderRadius:16,fontSize:10,fontWeight:600,fontFamily:"monospace",cursor:"help",
              background:Ma_eff>0.5?`${C.good}1F`:Ma_eff<-0.5?`${C.warm}1F`:`${C.accent2}1F`,
              color:Ma_eff>0.5?C.good:Ma_eff<-0.5?C.warm:C.accent2,
              border:`1px solid ${Ma_eff>0.5?C.good+"44":Ma_eff<-0.5?C.warm+"44":C.accent2+"44"}`}}>{Ma_eff>0.5?"● STABLE":Ma_eff<-0.5?"● CELLULAR-UNSTABLE":"● NEAR-NEUTRAL"} ⓘ</span>
          </Tip>
        </div>
      </div>
      {/* Bechtold-Matalon Le_eff breakdown — surfaces the per-reactant Lewis
          numbers that feed Eq. 6 so engineers investigating H₂-rich behavior
          can see what's driving the weighted average. */}
      <div style={{fontSize:9.5,color:C.txtMuted,marginBottom:10,fontStyle:"italic",lineHeight:1.4,paddingLeft:2}}>
        Bechtold-Matalon decomposition: Le_E (excess) = <span style={{color:C.txtDim,fontFamily:"monospace",fontWeight:600}}>{Le_E_eff.toFixed(3)}</span> · Le_D (deficient) = <span style={{color:C.txtDim,fontFamily:"monospace",fontWeight:600}}>{Le_D_eff.toFixed(3)}</span> → Le_eff weighted by A = 1 + β·(Φ−1).
        {(!accurate||!bk.data||!Number.isFinite(bk.data.Le_E))?<span style={{color:C.accent2,marginLeft:6}}>(activate accurate mode for distinct Le_E/Le_D from Cantera transport)</span>:null}
      </div>

      {/* ── Borghi-Peters regime diagram ──────────────────────────────── */}
      {/* Wrapper caps width at 50% so the diagram doesn't dominate the
          panel. The SVG inside uses width:100% / height:auto so it
          rescales cleanly to the cap. Centred for visual balance. */}
      <div style={{maxWidth:"50%",margin:"0 auto"}}>
        <BorghiPetersDiagram
          currentX={lT/Math.max(delta_F,1e-12)}
          currentY={uPrime/Math.max(SL_ms,1e-9)}
          currentLabel={{phi:+phi.toFixed(3),T0:+T0.toFixed(1),P:+P.toFixed(3),Ka:Ka_diag,Da:Da_diag,ReT:ReT_diag}}
          trail={borghiTrail}
          hover={borghiHover}
          setHover={setBorghiHover}
          units={units}
        />
      </div>
    </div>
    {/* ═══════════ END CARD 1 ═══════════ */}

    {/* ═══════════ CARD 2 — STABILIZATION & BLOWOFF ═══════════ */}
    {/* Phase 2 of the redesign. Generic premixer-type selector loads
        type-aware secondary inputs; Da_crit comes from the per-type
        function in PREMIXER_TYPES. Headline metrics: Da, Da_crit,
        Da/Da_crit (3-state badge), V_BO, φ_LBO + margin, τ_BO (also
        shown on the legacy Premixer card below — duplicated until
        Step E retires the old card). Two sweep charts close out
        the card. */}
    <div style={S.card}>
      <div style={S.cardT}>Stabilization &amp; Blowoff <span style={{fontSize:10,color:C.txtMuted,marginLeft:8,fontFamily:"monospace"}}>·  flame anchor stability + lean blow-out</span></div>

      {/* ── Premixer-type selector ─────────────────────────────────── */}
      <div style={{marginBottom:10,padding:"8px 10px",background:`${C.accent2}08`,border:`1px solid ${C.accent2}30`,borderRadius:6}}>
        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:_typeEntry.inputs.length?6:0}}>
          <span style={{fontSize:10,fontWeight:700,color:C.accent2,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".8px",textTransform:"uppercase"}}>Premixer type:</span>
          <div style={{display:"flex",gap:3,flexWrap:"wrap"}}>
            {Object.entries(PREMIXER_TYPES).map(([id, t]) => (
              <button key={id} onClick={()=>setPremixerType(id)}
                title={`${t.label} — Da_crit reference: ${t.ref}. ${t.note}`}
                style={{padding:"3px 9px",fontSize:10,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".4px",
                  color:premixerType===id?C.bg:C.accent2,
                  background:premixerType===id?C.accent2:"transparent",
                  border:`1px solid ${C.accent2}`,borderRadius:4,cursor:"pointer"}}>{t.label}</button>
            ))}
          </div>
          <span style={{marginLeft:"auto",fontSize:10,color:C.txtMuted,fontFamily:"monospace"}}>{_typeEntry.note}</span>
        </div>

        {/* Type-specific secondary input(s) */}
        {_typeEntry.inputs.map(inp => {
          const val = _typeParams[inp.id];
          const setter = inp.id==="swirlNumber"   ? setSwirlNumber
                       : inp.id==="gutterAngleDeg" ? setGutterAngleDeg
                       : inp.id==="expansionRatio" ? setExpansionRatio
                       : inp.id==="holeDiamMm"     ? setHoleDiamMm
                       : null;
          if (!setter) return null;
          return (
            <div key={inp.id} style={{display:"flex",alignItems:"center",gap:8,marginTop:6}}>
              <Tip text={inp.tooltip}><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help",whiteSpace:"nowrap",minWidth:130}}>{inp.label} ⓘ</label></Tip>
              <input type="range" min={inp.min} max={inp.max} step={inp.step} value={val}
                onChange={e=>setter(+e.target.value)}
                style={{flex:1,accentColor:C.accent2,minWidth:120}}/>
              <NumField value={val} decimals={inp.decimals}
                onCommit={v=>setter(Math.max(inp.min, Math.min(inp.max, +v)))}
                style={{width:64,padding:"3px 6px",fontFamily:"monospace",color:C.accent2,fontSize:11.5,fontWeight:700,background:C.bg,border:`1px solid ${C.accent2}50`,borderRadius:4,textAlign:"center",outline:"none"}}/>
              <span style={{fontSize:10,color:C.txtMuted,fontFamily:"monospace",whiteSpace:"nowrap"}}>{inp.ref}</span>
            </div>
          );
        })}
      </div>

      {/* ── LBO calibration row (LP-band approach; K_LBO hidden) ─────── */}
      <div style={{display:"flex",alignItems:"center",gap:14,flexWrap:"wrap",marginBottom:10,padding:"8px 10px",background:`${C.accent3}08`,border:`1px solid ${C.accent3}30`,borderRadius:6,fontSize:10.5,fontFamily:"monospace"}}>
        <span style={{fontSize:10,fontWeight:700,color:C.accent3,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".8px",textTransform:"uppercase"}}>LBO band:</span>
        <Tip text={`Lefebvre LP-band approach (Lefebvre & Ballal 2010 Eq. 5.27 reformulated).\n\nUnder the hood: loading parameter LP = ṁ_air/(V_pz · P_3_atm^1.3) is swept over the typical industrial-GT design range LP ∈ [${_LBO_LP_LOW}, ${_LBO_LP_HIGH}] kg/(s·m³·atm^1.3). This brackets the typical industrial DLN design space (well-loaded sound design through high-loaded marginal design).\n\nq_LBO = K · LP / (304.1 · exp(T_3/300) · H_r);  φ_LBO = (q_LBO/FAR_stoich) × m_fuel\n\nA constant (K) hidden under the hood — fixed at the premixed-gas calibration value (anchored to LMS100 NG-DLN baseline). Sweeping LP drops dependency on V_pz and ṁ_air entirely (calibration-fragile pair), and the multiplicative fuel-composition correction m_fuel handles fuel reactivity shifts.`}>
          <span style={{color:C.txtDim,fontStyle:"italic",cursor:"help"}}>LP {_LBO_LP_LOW}–{_LBO_LP_HIGH} kg/(s·m³·atm^1.3) · m_fuel = {_lbo_band.fuel_mult.toFixed(3)} (H₂ {((fuel.H2||0)/Math.max(Object.values(fuel).reduce((a,b)=>a+b,0),1e-9)*100).toFixed(0)}%, C₃H₈ {((fuel.C3H8||0)/Math.max(Object.values(fuel).reduce((a,b)=>a+b,0),1e-9)*100).toFixed(0)}%) ⓘ</span>
        </Tip>
      </div>

      {/* ── Headline metrics ────────────────────────────────────────── */}
      {/* NOTE: this is the BLOWOFF Damköhler (Da_BO), not the regime
          Damköhler shown on Card 1. They are different quantities with the
          same dimensionless name — distinguishing them in the labels and
          tooltips here so an engineer who notices the discrepancy doesn't
          chase a phantom bug. */}
      <div style={{...S.row,gap:8,marginBottom:8}}>
        <M l={`Da_BO,crit (${_typeEntry.label})`} v={Da_crit.toFixed(3)} u="—" c={C.accent2} tip={`Critical BLOWOFF Damköhler for ${_typeEntry.label} (ref: ${_typeEntry.ref}). Below this value the recirculation zone can no longer compensate for chemistry timescale and the flame anchor blows off. Distinct from the Borghi regime Da on Card 1: that one is Da_regime = (l_T/δ_F)·(S_L/u') for placing the operating point on the Borghi diagram. This one is Da_BO = τ_flow/τ_chem with τ_flow = L_char/V_ref — the anchor-stability Damköhler. Same name, different quantities; that's combustion convention.`}/>
        <M l="Da_BO (anchor)" v={Da_actual.toFixed(2)} u="—" c={C.accent} tip="BLOWOFF Damköhler at the current operating point: Da_BO = τ_flow / τ_chem with τ_flow = L_char / V_ref and τ_chem = α_th / S_L². This is the flame-anchor stability ratio — distinct from the Borghi regime Da on Card 1 which uses (l_T/δ_F)·(S_L/u'). Two different Damköhlers, same name, by convention."/>
        <M l="Da_BO / Da_BO,crit" v={Da_ratio.toFixed(2)} u="—" c={Da_status==="green"?C.good:Da_status==="yellow"?C.warm:C.strong} tip={`Margin to flame anchor blow-off. > 3 robust, 1–3 marginal, ≤ 1 imminent blow-off. Currently ${Da_status==="green"?"ROBUST":Da_status==="yellow"?"MARGINAL":"BLOW-OFF IMMINENT"}.`}/>
        <M l="V_BO (this geometry)" v={uv(units,"vel",V_BO_card2).toFixed(1)} u={uu(units,"vel")} c={C.accent2} tip={`Reference velocity at which Da would equal Da_crit for the selected ${_typeEntry.label} geometry. V_ref = ${uv(units,"vel",velocity).toFixed(1)} ${uu(units,"vel")} → V_BO = V_ref · (Da/Da_crit).`}/>
        <M l="φ_LBO range (Lefebvre band)" v={`${phi_LBO_low.toFixed(2)}–${phi_LBO_high.toFixed(2)}`} u="—" c={_lbo_col} tip={`Lefebvre 1985 LEAN blowout band, computed by sweeping the loading parameter LP = ṁ_air/(V_pz·P_3_atm^1.3) over the typical industry-GT design range LP ∈ [${_LBO_LP_LOW}, ${_LBO_LP_HIGH}] kg/(s·m³·atm^1.3).\n\nq_LBO = K · LP / (304.1 · exp(T_3/300) · H_r);  φ_LBO = q_LBO/FAR_stoich.\nT_3 = ${T3_lbo_K.toFixed(0)} K (${cycleResult?.T3_K?"from Cycle":"sidebar"}); H_r = LCV/43.5 = ${(_fp_card2.LHV_mass/43.5).toFixed(2)}; FAR_stoich = ${_FAR_stoich_lbo.toFixed(4)}; K = ${K_LBO}.\n\nLP_low=${_LBO_LP_LOW} → φ_LBO_low = ${phi_LBO_low.toFixed(3)} (well-loaded sound design).\nLP_high=${_LBO_LP_HIGH} → φ_LBO_high = ${phi_LBO_high.toFixed(3)} (high-loaded marginal design; clamped to 1.0 if formula extrapolates above).\n\nThis approach drops the dependency on a specific V_pz / ṁ_air pair — the band captures the realistic LBO uncertainty across typical industrial combustor designs.`}/>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",flex:"0 0 auto",padding:"0 10px"}}>
          <Tip text={`LBO status — your operating φ = ${phi.toFixed(3)} relative to the Lefebvre band [${phi_LBO_low.toFixed(2)}, ${phi_LBO_high.toFixed(2)}]:\n\n• φ > ${phi_LBO_high.toFixed(2)} (above band) → SAFE: no realistic loading parameter brings the design near LBO.\n• ${phi_LBO_low.toFixed(2)} ≤ φ ≤ ${phi_LBO_high.toFixed(2)} (in band) → ALARM: actual LBO depends on the specific loading; treat as a near-LBO operating point and verify against rig/site data.\n• φ < ${phi_LBO_low.toFixed(2)} (below band) → HIGH RISK: even the lowest typical loading would predict LBO above this φ; the design will blow off at any reasonable loading.\n\nCurrently: ${lbo_status === "SAFE" ? "SAFE" : lbo_status === "ALARM" ? "ALARM (in band)" : lbo_status === "HIGH_RISK" ? "HIGH RISK (below band)" : "—"}`}>
            <span style={{padding:"3px 10px",borderRadius:16,fontSize:10,fontWeight:600,fontFamily:"monospace",cursor:"help",
              background:`${_lbo_col}1F`, color:_lbo_col, border:`1px solid ${_lbo_col}55`}}>
              {lbo_status==="SAFE"?"● LBO SAFE":lbo_status==="ALARM"?"● LBO ALARM":lbo_status==="HIGH_RISK"?"● LBO HIGH RISK":"—"} ⓘ
            </span>
          </Tip>
        </div>
        <M l="Zukoski Blow-off (τ_BO)" v={(tau_BO*1000).toFixed(3)} u="ms" c={C.accent3} tip="Time for the flame to detach from the bluff body: τ_BO = D_flameholder / (1.5·S_L). Same value as on the legacy Premixer card below — also lives here because it characterises blow-off, not flashback."/>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",flex:"0 0 auto",padding:"0 10px"}}>
          <Tip text={`Blow-off status combines Da_BO margin AND Lefebvre LBO band status.\nDa_BO/Da_BO,crit: ${Da_ratio.toFixed(2)} (${Da_status==="green"?"robust":Da_status==="yellow"?"marginal":"imminent"})\nφ_LBO band ${phi_LBO_low.toFixed(2)}–${phi_LBO_high.toFixed(2)}: φ=${phi.toFixed(2)} ${lbo_status==="SAFE"?"above band (SAFE)":lbo_status==="ALARM"?"in band (ALARM)":lbo_status==="HIGH_RISK"?"below band (HIGH RISK)":"—"}`}>
            <span style={{padding:"3px 10px",borderRadius:16,fontSize:10,fontWeight:600,fontFamily:"monospace",cursor:"help",
              background:(Da_status==="green"&&lbo_status==="SAFE")?`${C.good}1F`:(Da_status==="red"||lbo_status==="HIGH_RISK")?`${C.strong}1F`:`${C.warm}1F`,
              color:(Da_status==="green"&&lbo_status==="SAFE")?C.good:(Da_status==="red"||lbo_status==="HIGH_RISK")?C.strong:C.warm,
              border:`1px solid ${(Da_status==="green"&&lbo_status==="SAFE")?C.good+"44":(Da_status==="red"||lbo_status==="HIGH_RISK")?C.strong+"44":C.warm+"44"}`}}>{(Da_status==="green"&&lbo_status==="SAFE")?"● ROBUST":(Da_status==="red"||lbo_status==="HIGH_RISK")?"● BLOW-OFF RISK":"● MARGINAL/ALARM"} ⓘ</span>
          </Tip>
        </div>
      </div>

      {/* ── Plee-Mellor 1979 LBO cross-check (independent framework) ── */}
      <div style={{...S.row,gap:8,marginBottom:8,marginTop:2}}>
        <M l="τ_sl (shear-layer)" v={pm_tau_sl_ms.toFixed(2)} u="ms" c={C.violet} tip={`Shear-layer residence time τ_sl = L_recirc / V_a, with L_recirc ≈ L_char (${uv(units,"len",Lchar).toFixed(4)} ${uu(units,"len")}) and V_a = V_ref (${uv(units,"vel",velocity).toFixed(1)} ${uu(units,"vel")}). Per Plee-Mellor 1979 (Combust Flame 35:61-80) this is the fluid-mechanic timescale that competes with chemical ignition delay in the bluff-body shear layer.`}/>
        <M l="τ_hc' (chem ignition)" v={pm_tau_hc_ms.toFixed(3)} u="ms" c={C.accent3} tip={`Plee-Mellor 1979 Eq. 17 chemical ignition delay (Configuration A — 45° conical baffle, propane fit to Ballal-Lefebvre data):\nτ_hc' = 1e-4 · (T_φ / T_in) · exp(21000 / (R · T_φ))   [msec]\nT_φ = ${_PM_T_phi.toFixed(0)} K (${(accurate&&bk.data&&bk.data.T_max)?"Cantera flame T_max":"1800 K placeholder"}); T_in = ${_PM_T_in.toFixed(0)} K (compressor discharge); E_a/R ≈ 10568 K from the Plee-Mellor activation energy 21000 cal/mol.`}/>
        <M l="τ_sl / τ_hc'" v={pm_ratio.toFixed(2)} u="—" c={pm_lbo_safe?(pm_marginal?C.warm:C.good):C.strong} tip={`Plee-Mellor stability ratio. LBO line at ratio = 2.11 (Configuration A — Plee-Mellor Fig. 5 fit, r = 0.98, n = 72). Above the line → STABLE; below → BLOWOFF. Currently ${pm_lbo_safe?(pm_marginal?"MARGINAL (within 30% of LBO line)":"ROBUST"):"BLOWOFF — chemistry can't keep up with shear-layer residence time"}.`}/>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",flex:"0 0 auto",padding:"0 10px"}}>
          <Tip text={`Plee-Mellor 1979 characteristic-time framework — independent of Lefebvre. Both criteria should agree on robust vs. blowoff classification; if they disagree, the operating point is in a regime where one of the framework's assumptions is being stressed (e.g. very lean φ where T_φ approaches the lean flammability limit).`}>
            <span style={{padding:"3px 10px",borderRadius:16,fontSize:10,fontWeight:600,fontFamily:"monospace",cursor:"help",
              background:pm_lbo_safe?(pm_marginal?`${C.warm}1F`:`${C.good}1F`):`${C.strong}1F`,
              color:pm_lbo_safe?(pm_marginal?C.warm:C.good):C.strong,
              border:`1px solid ${pm_lbo_safe?(pm_marginal?C.warm:C.good):C.strong}44`}}>{pm_lbo_safe?(pm_marginal?"● PM MARGINAL":"● PM ROBUST"):"● PM BLOWOFF"} ⓘ</span>
          </Tip>
        </div>
      </div>
      <div style={{fontSize:9.5,color:C.txtMuted,marginBottom:10,fontStyle:"italic",lineHeight:1.4,paddingLeft:2}}>
        Plee-Mellor 1979 cross-check uses a Damköhler-style competition between shear-layer residence time (L_char/V_ref) and chemical ignition delay; agreement with Lefebvre above is expected for typical premixers. Configuration A constants (45° conical baffle, propane). Cited as Combust. Flame 35:61-80.
      </div>

      {/* ── Sweep charts ───────────────────────────────────────────── */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginTop:8}}>
        <div style={{background:`${C.bg2}88`,border:`1px solid ${C.border}`,borderRadius:6,padding:"8px 6px"}}>
          <div style={{fontSize:10.5,fontWeight:700,color:C.txtDim,letterSpacing:".5px",fontFamily:"'Barlow Condensed',sans-serif",textTransform:"uppercase",margin:"0 4px 4px 6px"}}>φ_LBO BAND vs T_3 (sweep 500–900 K, LP {_LBO_LP_LOW}–{_LBO_LP_HIGH})</div>
          <Chart data={lbo_T3_sweep} xK="T" yK="phiLBO_high" y2K="phiLBO_low" xL={`T_3 (${uu(units,"T")})`} yL="φ_LBO_high" y2L="φ_LBO_low" color={C.accent3} c2={C.accent2}/>
        </div>
        <div style={{background:`${C.bg2}88`,border:`1px solid ${C.border}`,borderRadius:6,padding:"8px 6px"}}>
          <div style={{fontSize:10.5,fontWeight:700,color:C.txtDim,letterSpacing:".5px",fontFamily:"'Barlow Condensed',sans-serif",textTransform:"uppercase",margin:"0 4px 4px 6px"}}>V_BO vs L_char (sweep 5–100 mm)</div>
          <Chart data={vbo_Lchar_sweep} xK="L" yK="VBO" xL={`L_char (${uu(units,"len")})`} yL={`V_BO (${uu(units,"vel")})`} color={C.accent2}/>
        </div>
      </div>
    </div>
    {/* ═══════════ END CARD 2 ═══════════ */}

    <div style={S.card}><div style={S.cardT}>Flame Speed & Stability Analysis {accurate&&(bk.loading?<span style={{fontSize:10,color:C.accent2,marginLeft:8,fontFamily:"monospace"}}>⟳ CANTERA…</span>:bk.err?<span style={{fontSize:10,color:C.warm,marginLeft:8,fontFamily:"monospace"}}>⚠ {bk.err}</span>:bk.data?<span style={{fontSize:10,color:C.accent,marginLeft:8,fontFamily:"monospace",fontWeight:700}}>✓ CANTERA (1D FreeFlame)</span>:null)}</div>
      <div style={{...S.row,gap:8,marginBottom:10}}>
        <M l="Laminar Flame Speed (S_L)" v={uv(units,"SL",SL).toFixed(2)} u={uu(units,"SL")} c={C.violet} tip="Laminar burning velocity — the speed at which a planar flame front propagates into the unburned mixture."/>
        <M l="Chemical Timescale (τ_chem)" v={bo.tau_chem.toFixed(4)} u="ms" c={C.accent3} tip="Chemical timescale: time for the flame to propagate one thermal diffusion length. τ_chem = α_th / S_L²."/>
        <M l="Flow Timescale (τ_flow)" v={bo.tau_flow.toFixed(4)} u="ms" c={C.accent} tip="Flow timescale: residence time of unburned gas near the flameholder. τ_flow = L_char / V_ref."/>
        <M l="Damköhler Number (Da)" v={bo.Da.toFixed(2)} u="—" c={bo.stable?C.good:C.warm} tip="Damköhler number = τ_flow / τ_chem. Da > 1 means chemistry is fast enough to sustain the flame. Da < 1 → blowoff risk."/>
        <M l="Blowoff Velocity" v={uv(units,"vel",bo.blowoff_velocity).toFixed(1)} u={uu(units,"vel")} c={C.accent2} tip="Velocity at which Da = 1 for the given L_char. Above this velocity the flame will blow off."/>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",flex:"0 0 auto",padding:"0 10px"}}>
          <span style={{padding:"3px 10px",borderRadius:16,fontSize:10,fontWeight:600,fontFamily:"monospace",background:bo.stable?`${C.good}1F`:`${C.warm}1F`,color:bo.stable?C.good:C.warm,border:`1px solid ${bo.stable?C.good+"44":C.warm+"44"}`}}>{bo.stable?"● STABLE":"● BLOWOFF RISK"}</span></div>
      </div>
      <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
        <div style={{display:"flex",alignItems:"center",gap:5}}><Tip text="The reference approach velocity of the unburned gas mixture at the flameholder location."><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>V_ref ({uu(units,"vel")}) ⓘ:</label></Tip>
          <NumField value={uv(units,"vel",velocity)} decimals={2} onCommit={v=>setVelocity(uvI(units,"vel",v))} style={{...S.inp,width:65}}/></div>
        <div style={{display:"flex",alignItems:"center",gap:5}}><Tip text="Characteristic recirculation length — typically the flameholder diameter, bluff body width, or step height."><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>L_char ({uu(units,"len")}) ⓘ:</label></Tip>
          <NumField value={uv(units,"len",Lchar)} decimals={4} onCommit={v=>setLchar(uvI(units,"len",v))} style={{...S.inp,width:75}}/></div>
      </div></div>
    {/* ═══════════ CARD 3 — PREMIXER FLASHBACK & AUTOIGNITION ═══════════ */}
    {/* Phase 3 of the redesign. Replaces the legacy "Premixer Stability"
        card. Three flashback gates + autoignition gate, each with its
        own pass/fail indicator and an aggregate PASS / WARN / FAIL chip.
        Gate C (turbulent core) uses V_premix EXCLUSIVELY for u' —
        the Card 1 toggle deliberately doesn't apply here because the
        flashback question is intrinsically about premixer-channel
        turbulence. */}
    <div style={S.card}>
      <div style={S.cardT}>Premixer Flashback &amp; Autoignition <span style={{fontSize:10,color:C.txtMuted,marginLeft:8,fontFamily:"monospace"}}>·  3 flashback gates + autoignition</span> {accurate&&(bkIgn.loading?<span style={{fontSize:10,color:C.accent2,marginLeft:8,fontFamily:"monospace"}}>⟳ CANTERA 0D…</span>:bkIgn.err?<span style={{fontSize:10,color:C.warm,marginLeft:8,fontFamily:"monospace"}}>⚠ {bkIgn.err}</span>:bkIgn.data?<span style={{fontSize:10,color:C.accent,marginLeft:8,fontFamily:"monospace",fontWeight:700}}>✓ CANTERA (0D const-P reactor)</span>:null)}</div>

      {/* ── Inputs row ────────────────────────────────────────────── */}
      <div style={{display:"flex",gap:14,alignItems:"center",flexWrap:"wrap",marginBottom:10,padding:"8px 10px",background:`${C.accent}08`,border:`1px solid ${C.accent}30`,borderRadius:6}}>
        <span style={{fontSize:10,fontWeight:700,color:C.accent,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".8px",textTransform:"uppercase",marginRight:4}}>Inputs:</span>
        <div style={{display:"flex",alignItems:"center",gap:5}}>
          <Tip text="Premixer hydraulic diameter D_h = 4·A/P (round duct: tube ID; non-round: 4·area/wetted-perimeter). Drives boundary-layer flashback (g_actual ∝ V_premix/D_h) and the integral-scale used by the turbulent core gate (l_T = 0.10·D_h). Range 5 mm (micromixer) – 200 mm (large can)."><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>D_h ({uu(units,"len")}) ⓘ:</label></Tip>
          <NumField value={uv(units,"len",D_h_premix)} decimals={4} onCommit={v=>setDhPremix(uvI(units,"len",v))} style={{...S.inp,width:80}}/>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:5}}>
          <Tip text="Premixer channel length from fuel injection point to flame anchor. Drives τ_res = L_premix / V_premix."><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>L_premix ({uu(units,"len")}) ⓘ:</label></Tip>
          <NumField value={uv(units,"len",Lpremix)} decimals={4} onCommit={v=>setLpremix(uvI(units,"len",v))} style={{...S.inp,width:80}}/>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:5}}>
          <Tip text="Bulk velocity of the premixed mixture through the premixer channel."><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>V_premix ({uu(units,"vel")}) ⓘ:</label></Tip>
          <NumField value={uv(units,"vel",Vpremix)} decimals={2} onCommit={v=>setVpremix(uvI(units,"vel",v))} style={{...S.inp,width:65}}/>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:5}}>
          <Tip text="Wall-shear amplification factor ε_turb. Default 0.7 (≈1.7× turbulent boundary-layer multiplier on the laminar wall-gradient estimate). Range 0 (laminar) – 2.0 (highly disturbed)."><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>ε_turb ⓘ:</label></Tip>
          <NumField value={eps_turb} decimals={2} onCommit={v=>setEpsTurb(Math.max(0,Math.min(2,+v)))} style={{...S.inp,width:55}}/>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:5,minWidth:170,flex:"1 1 200px"}}>
          <Tip text="Residence-time-distribution multiplier. τ_res,99 = RTD · (L_premix/V_premix). Default 1.5 (1D plug flow with axial dispersion). Range 1.0 (perfect plug flow) – 3.0 (strong recirculation)."><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help",whiteSpace:"nowrap"}}>RTD mult ⓘ</label></Tip>
          <input type="range" min="1.0" max="3.0" step="0.1" value={RTD_multiplier} onChange={e=>setRTDMultiplier(+e.target.value)} style={{flex:1,accentColor:C.accent3}}/>
          <NumField value={RTD_multiplier} decimals={1} onCommit={v=>setRTDMultiplier(Math.max(1,Math.min(3,+v)))} style={{width:48,padding:"3px 5px",fontFamily:"monospace",color:C.accent3,fontSize:11.5,fontWeight:700,background:C.bg,border:`1px solid ${C.accent3}50`,borderRadius:4,textAlign:"center",outline:"none"}}/>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:5}}>
          <Tip text={`Autoignition kinetics mechanism. ${IG_MECHANISMS.find(m=>m.id===igMechanism)?.note||""}\n\nWhen H₂ > 30%, GRI-Mech 3.0 is outside its calibration range — switch to Glarborg 2018 (or FFCM-2 / Aramco when those YAMLs land).`}><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>Mechanism ⓘ:</label></Tip>
          <select value={igMechanism} onChange={e=>setIgMechanism(e.target.value)}
            style={{padding:"4px 8px",fontSize:10.5,fontWeight:600,fontFamily:"monospace",
              color:ig_mech_warn?C.warm:C.accent,
              background:C.bg,
              border:`1px solid ${ig_mech_warn?C.warm:C.accent}50`,borderRadius:4,outline:"none"}}>
            {IG_MECHANISMS.map(m =>
              <option key={m.id} value={m.id} disabled={!m.bundled}>{m.label}{m.bundled?"":" (coming)"}</option>
            )}
          </select>
        </div>
      </div>

      {/* ── H₂ + GRI advisory banner ─────────────────────────────────── */}
      {ig_mech_warn && <div style={{marginBottom:10,background:`${C.warm}12`,border:`1px solid ${C.warm}55`,borderRadius:5,padding:"7px 11px",fontSize:10.5,color:C.warm,fontFamily:"monospace",lineHeight:1.45}}>
        ⚠ <strong>Mechanism advisory:</strong> Fuel contains {(H2_frac*100).toFixed(0)}% H₂. GRI-Mech 3.0 is calibrated for natural gas and is not validated above ~30% H₂ blends — switch to <strong>Glarborg 2018</strong> for accurate H₂ kinetics.
      </div>}

      {/* ── Four gates row ───────────────────────────────────────────── */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:8,marginBottom:10}}>
        {/* Gate A — Boundary-layer flashback (Lieuwen Eq. 10.4-10.6) */}
        <div style={{background:gateA_pass?`${C.good}10`:`${C.warm}10`,border:`1.5px solid ${gateA_pass?C.good:C.warm}55`,borderRadius:6,padding:"8px 10px"}}>
          <div style={{fontSize:10,fontWeight:700,color:gateA_pass?C.good:C.warm,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".5px",textTransform:"uppercase",marginBottom:5}}>{gateA_pass?"✓":"✗"} Gate A — Boundary-Layer Flashback</div>
          <div style={{fontSize:11,fontFamily:"monospace",color:C.txt,lineHeight:1.5}}>
            <span title={`Critical wall gradient g_c = S_L²/α_th (Lewis-von Elbe). ${H2_frac>0.30?`Confined H₂-flame correction √σ_ρ=${confine_correction.toFixed(2)} applied per Lieuwen Fig. 10.9 (g_c_eff shown).`:"Unconfined; no σ_ρ correction."}`}>g_c{H2_frac>0.30?"_eff":""} = <strong>{g_c_eff.toFixed(0)}</strong> 1/s</span><br/>
            <span title={`Actual wall gradient: 8·V_premix/D_h Poiseuille estimate × (1+ε_turb)=${(1+eps_turb).toFixed(2)}. Lieuwen p. 385 reports g_u,turbulent ≈ 3·g_u,laminar (Eichler-Sattelmayer).`}>g_actual = <strong style={{color:gateA_pass?C.good:C.warm}}>{g_actual.toFixed(0)}</strong> 1/s</span><br/>
            <span title={`Flashback Karlovitz Ka_fb = g_u·δ_F/s_d^u (Lieuwen Eq. 10.5). Pass: Ka_fb ≥ 1.`}>Ka_fb = <strong>{Number.isFinite(Ka_flashback)?Ka_flashback.toFixed(2):"—"}</strong> <span style={{color:C.txtMuted}}>(need ≥ 1)</span></span><br/>
            <span style={{fontSize:10,color:C.txtMuted}}>margin = {gateA_margin.toFixed(2)}×</span><br/>
            <span title={`Shaffer-Duan-McDonell 2013 (J Eng GT 135:011502) Eq. 4 — predicted burner-tip temperature at flashback as a linear function of fuel composition + AFT:\n  T_tip = -1.58·H₂% - 3.63·CO% - 4.28·CH₄% + 0.38·AFT [K, internally]\nPer Shaffer §4.5, this is what physically drives BLF runaway in H₂-rich blends — heat transfer to the burner rim raises local Tu, raises S_L, reduces δ_q, all of which lower g_c. Using AFT = ${uv(units,"T",_AFT_card3).toFixed(0)} ${uu(units,"T")} (${(accurate&&bk.data&&bk.data.T_max)?"Cantera flame T_max":"1800 K placeholder"}). Active cooling typically caps T_tip ≤ ${uv(units,"T",600).toFixed(0)} ${uu(units,"T")} (≈600 K).\n\nValidity: Shaffer's experiments used H₂/CO/CH₄ blends; pure-NG / low-H₂ fuels extrapolate to T_tip < T_air, which is non-physical. ${shaffer_T_tip_OOR?`OUT OF RANGE: T_tip predicted ${uv(units,"T",shaffer_tip_T_K).toFixed(0)} ${uu(units,"T")} < T_air ${uv(units,"T",T_air_for_shaffer).toFixed(0)} ${uu(units,"T")} OR fuel is CH₄-dominant with <10% H₂. Display suppressed.`:"In calibration window."}`} style={{fontSize:10,color:shaffer_T_tip_OOR?C.txtMuted:(shaffer_tip_T_K>500?C.warm:C.txtMuted)}}>{shaffer_T_tip_OOR?<>T_tip (Shaffer) = <strong style={{color:C.txtMuted}}>OOR</strong> <span style={{color:C.txtMuted,fontStyle:"italic"}}>(low-H₂ fuel — Eq. 4 extrapolated)</span></>:<>T_tip (Shaffer) = <strong>{uv(units,"T",shaffer_tip_T_K).toFixed(0)}</strong> {uu(units,"T")}{shaffer_tip_T_K>500?<span style={{marginLeft:6,color:C.warm,fontWeight:600}}>⚠ &gt;{uv(units,"T",500).toFixed(0)} {uu(units,"T")}</span>:""}</>}</span>
          </div>
          <div style={{fontSize:9,color:C.txtMuted,marginTop:4,fontStyle:"italic",lineHeight:1.3}}>Lieuwen Eq. 10.4-10.6 + Shaffer 2013 Eq. 4 tip-T predictor. Dominant for tube burners and micromixers; H₂ flames {H2_frac>0.30?"(>30% — √σ_ρ confinement applied)":"hit this gate hardest"}.</div>
        </div>

        {/* Gate B — CIVB */}
        <div style={{background:gateB_pass?`${C.good}10`:`${C.warm}10`,border:`1.5px solid ${civb_applicable?(gateB_pass?C.good:C.warm)+"55":C.txtMuted+"55"}`,borderRadius:6,padding:"8px 10px"}}>
          <div style={{fontSize:10,fontWeight:700,color:civb_applicable?(gateB_pass?C.good:C.warm):C.txtMuted,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".5px",textTransform:"uppercase",marginBottom:5}}>{civb_applicable?(gateB_pass?"✓":"✗"):"–"} Gate B — CIVB</div>
          {civb_applicable ? (
            <div style={{fontSize:11,fontFamily:"monospace",color:C.txt,lineHeight:1.5}}>
              <span title="Π_CIVB = S_L / (S_n · V_premix · π) — Sattelmayer 2004 simplified.">Π_CIVB = <strong style={{color:gateB_pass?C.good:C.warm}}>{piCIVB.toFixed(4)}</strong></span><br/>
              <span title={`Threshold ${civb_threshold} — ${H2_frac>0.30?"tightened to 0.03 for H₂ > 30% (Sattelmayer et al., J. Eng. Gas Turbines Power 138:011503, 2014)":"natural-gas value from Fritz/Kröner/Sattelmayer 2004 (J. Eng. Gas Turbines Power 126:276-283)"}.`}>threshold &lt; <strong>{civb_threshold.toFixed(2)}</strong></span><br/>
              <span style={{fontSize:10,color:C.txtMuted}}>S_n = {swirlNumber.toFixed(2)}</span>
            </div>
          ) : (
            <div style={{fontSize:11,fontFamily:"monospace",color:C.txtMuted,lineHeight:1.5}}>
              <em>N/A</em> — Card 2 premixer type is "{_typeEntry.label}". CIVB applies only to swirl burners.
            </div>
          )}
          <div style={{fontSize:9,color:C.txtMuted,marginTop:4,fontStyle:"italic",lineHeight:1.3}}>Dominant flashback mode for swirl DLN. Bistable: above the Π threshold the flame's pressure rise flips the vortex into breakdown (Lieuwen §4.4.2, Fig. 4.39).</div>
        </div>

        {/* Gate C — Turbulent core (Bradley) */}
        <div style={{background:gateC_pass?`${C.good}10`:`${C.warm}10`,border:`1.5px solid ${gateC_pass?C.good:C.warm}55`,borderRadius:6,padding:"8px 10px"}}>
          <div style={{fontSize:10,fontWeight:700,color:gateC_pass?C.good:C.warm,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".5px",textTransform:"uppercase",marginBottom:5}}>{gateC_pass?"✓":"✗"} Gate C — Turbulent Core (Bradley)</div>
          <div style={{fontSize:11,fontFamily:"monospace",color:C.txt,lineHeight:1.5}}>
            <span title={`Bradley S_T = ${uv(units,"vel",ST_premix).toFixed(2)} ${uu(units,"vel")}. Damköhler cross-check: ${uv(units,"vel",ST_premix_dk).toFixed(2)} ${uu(units,"vel")}.`}>S_T = <strong>{uv(units,"vel",ST_premix).toFixed(2)}</strong> {uu(units,"vel")}</span><br/>
            <span title="V_premix / S_T — must exceed 1.43 for a 30% margin.">V/S_T = <strong style={{color:gateC_pass?C.good:C.warm}}>{v_st_margin.toFixed(2)}</strong></span><br/>
            <span style={{fontSize:10,color:C.txtMuted}}>need &gt; 1.43 (30% margin)</span>
          </div>
          <div style={{fontSize:9,color:C.txtMuted,marginTop:4,fontStyle:"italic",lineHeight:1.3}}>Uses V_premix-based u'; Bradley/Lau/Lawes 1992.</div>
        </div>

        {/* Gate D — Autoignition */}
        <div style={{background:gateD_pass?`${C.good}10`:`${C.warm}10`,border:`1.5px solid ${gateD_pass?C.good:C.warm}55`,borderRadius:6,padding:"8px 10px"}}>
          <div style={{fontSize:10,fontWeight:700,color:gateD_pass?C.good:C.warm,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".5px",textTransform:"uppercase",marginBottom:5}}>{gateD_pass?"✓":isFinite(tau_ign)?"✗":"–"} Gate D — Autoignition</div>
          {isFinite(tau_ign) ? (
            <div style={{fontSize:11,fontFamily:"monospace",color:C.txt,lineHeight:1.5}}>
              {(() => {
                const tau_OOR = !accurateIgn && Number.isFinite(tau_ign) && tau_ign > tau_ign_OOR_threshold_s;
                if (tau_OOR) {
                  return <span title={`Spadaccini-Colket τ_ign = ${tau_ign.toExponential(2)} s ≈ ${(tau_ign/86400).toFixed(0)} days. Calibrated for T = 1000-1500 K; at T_premix = ${Tmix.toFixed(0)} K the exp(20130/T) term blows up and gives a value that means "the mixture is thermo-kinetically frozen at this T — autoignition is essentially impossible". Useful conclusion: SAFE on autoignition. Useless number to display, so suppressed.`} style={{color:C.good}}>τ_ign = <strong>&gt; 1000 s</strong> <span style={{fontSize:9,fontStyle:"italic",color:C.good}}>(corr. extrapolated — mixture thermo-kinetically stable, autoignition impossible)</span></span>;
                }
                return <span title={`τ_ign = ${(tau_ign*1000).toFixed(3)} ms. ${tau_ign_is_lower_bound?"Cantera did not observe ignition within window — lower bound.":accurateIgn?"Cantera 0D const-P, "+IG_MECHANISMS.find(m=>m.id===igMechanism)?.label:"Spadaccini-Colket NG correlation."}.`}>τ_ign = <strong>{tau_ign_is_lower_bound?">":""}{(tau_ign*1000).toFixed(tau_ign<1?3:tau_ign<10?2:1)}</strong> ms</span>;
              })()}<br/>
              <span title={`τ_res,99 = RTD·(L_premix/V_premix) = ${RTD_multiplier.toFixed(1)}·${(tau_res_mean*1000).toFixed(3)} ms.`}>τ_res,99 = <strong>{(tau_res_99*1000).toFixed(3)}</strong> ms</span><br/>
              <span style={{fontSize:10,color:gateD_pass?C.good:C.warm}}>margin = {tau_ign_is_lower_bound?">":""}{ign_margin_card3.toFixed(1)} (need ≥ 3)</span>
            </div>
          ) : (
            <div style={{fontSize:11,fontFamily:"monospace",color:C.txtMuted,lineHeight:1.5}}>
              <em>Cantera not running</em> — activate panel above to fire 0D const-P kinetics.
            </div>
          )}
          <div style={{fontSize:9,color:C.txtMuted,marginTop:4,fontStyle:"italic",lineHeight:1.3}}>{IG_MECHANISMS.find(m=>m.id===igMechanism)?.label} · RTD = {RTD_multiplier.toFixed(1)}.</div>
        </div>
      </div>

      {/* ── Combined PREMIXER STATUS ─────────────────────────────────── */}
      <div style={{padding:"10px 14px",background:card3_status==="PASS"?`${C.good}12`:card3_status==="WARN"?`${C.warm}12`:`${C.strong}12`,
                  border:`1.5px solid ${card3_status==="PASS"?C.good:card3_status==="WARN"?C.warm:C.strong}55`,
                  borderRadius:6,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".4px"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
          <span style={{fontSize:13,fontWeight:700,color:card3_status==="PASS"?C.good:card3_status==="WARN"?C.warm:C.strong,textTransform:"uppercase"}}>● PREMIXER STATUS: {card3_status}</span>
          <span style={{fontSize:10,color:C.txtMuted,fontFamily:"monospace",letterSpacing:0}}>
            {card3_status==="PASS"?"all four gates pass with margin":card3_status==="WARN"?"all gates pass but at least one is within 20% of its threshold":"at least one gate fails"}
          </span>
        </div>
        <div style={{fontSize:10.5,fontFamily:"monospace",color:C.txt,lineHeight:1.55,letterSpacing:0}}>
          {gateA_pass?"✓":"✗"} Boundary-layer flashback&nbsp;&nbsp;<span style={{color:C.txtMuted}}>g_actual={g_actual.toFixed(0)} {gateA_pass?">":"<"} g_c={g_c.toFixed(0)}</span><br/>
          {civb_applicable?(gateB_pass?"✓":"✗"):"–"} CIVB&nbsp;&nbsp;<span style={{color:C.txtMuted}}>{civb_applicable?`Π=${piCIVB.toFixed(4)} ${gateB_pass?"<":">"} ${civb_threshold}`:"N/A (non-swirl premixer)"}</span><br/>
          {gateC_pass?"✓":"✗"} Turbulent core flashback&nbsp;&nbsp;<span style={{color:C.txtMuted}}>V/S_T = {v_st_margin.toFixed(2)} {gateC_pass?">":"<"} 1.43</span><br/>
          {isFinite(tau_ign)?(gateD_pass?"✓":"✗"):"–"} Autoignition margin&nbsp;&nbsp;<span style={{color:C.txtMuted}}>{isFinite(tau_ign)?`τ_ign/τ_res,99 = ${ign_margin_card3.toFixed(1)} ${gateD_pass?"≥":"<"} 3`:"Cantera off"}</span>
        </div>
      </div>

      {/* ── Cantera no-ignition diagnostic banner ─────────────────────── */}
      {accurate&&bkIgn.data&&!bkIgn.data.ignited&&<div style={{marginTop:8,background:`${C.accent}10`,border:`1px solid ${C.accent}44`,borderRadius:5,padding:"7px 11px",fontSize:10.5,color:C.txtDim,fontFamily:"monospace",lineHeight:1.45}}>ℹ Cantera 0D integrated for {bkIgn.data.tau_ign_s.toFixed(1)} s without the mixture igniting (T_peak rose from {uv(units,"T",bkIgn.data.T_mixed_inlet_K).toFixed(0)} to {uv(units,"T",bkIgn.data.T_peak).toFixed(0)} {uu(units,"T")}). τ_ign is therefore at least {bkIgn.data.tau_ign_s.toFixed(1)} s — the autoignition margin shown is a <em>lower bound</em>. The mixture is thermo-kinetically stable at T_mixed and cannot autoignite within the premixer.</div>}
    </div>
    {/* ═══════════ END CARD 3 ═══════════ */}
    {/* Sweep curves — banner + button. In accurate mode the charts below show correlation-based
        TRENDS unless the user clicks "Run" to fetch first-principles Cantera sweeps (slow, ~2-3 min).
        Fresh Cantera results are used automatically and marked green. */}
    <div style={{padding:"11px 14px",background:sweepIsFresh?`${C.good}0C`:(accurate?`${C.accent2}10`:`${C.txtMuted}10`),border:`1.5px solid ${sweepIsFresh?C.good+"55":(accurate?C.accent2+"55":C.border)}`,borderRadius:7,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
      <div style={{flex:"1 1 360px",fontSize:11.5,color:C.txtDim,lineHeight:1.5,fontFamily:"'Barlow',sans-serif"}}>
        {sweepIsFresh?(
          <><strong style={{color:C.good,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".5px"}}>✓ CANTERA SWEEP CURVES</strong> — Curves below are first-principles Cantera 1D FreeFlame solves at every sampled point, not a correlation. Change any input (fuel, φ, T, P) to re-enable the Run button.</>
        ):accurate?(
          <><strong style={{color:C.accent2,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".5px"}}>⚠ CURVES ARE TRENDS ONLY</strong> — The curves below use the fast Gülder/Metghalchi-Keck correlation scaled to your current Cantera operating point (×{SL_scale.toFixed(2)}). For H₂ blends or rich operation the trend shape may differ from Cantera. Click <strong>Run Cantera Sweep Curves</strong> to replace the trends with ~30 real Cantera flame solves — this takes about 2–3 minutes; a "Calculations in Progress" box will be shown until complete.</>
        ):(
          <>Free Mode active — curves below are computed with the in-browser Gülder/Metghalchi-Keck correlation. Switch to <strong>Combustion Toolkit</strong> or <strong>Advanced Mode</strong> via the MODE picker, then click <strong>Run Cantera Sweep Curves</strong> to replace these trends with first-principles Cantera solves.</>
        )}
        {sweepErr&&<div style={{marginTop:6,color:C.warm,fontFamily:"monospace",fontSize:10.5}}>⚠ Sweep failed: {sweepErr}</div>}
      </div>
      {accurate&&(
        <button onClick={runCanteraSweeps} disabled={sweepRunning||sweepIsFresh} style={{padding:"9px 16px",fontSize:12,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".6px",color:(sweepRunning||sweepIsFresh)?C.txtMuted:C.bg,background:sweepIsFresh?C.good:(sweepRunning?C.bg3:C.accent2),border:`1.5px solid ${sweepIsFresh?C.good:C.accent2}`,borderRadius:6,cursor:(sweepRunning||sweepIsFresh)?"default":"pointer",whiteSpace:"nowrap"}}>
          {sweepRunning?"⟳ RUNNING CANTERA…":sweepIsFresh?"✓ CURVES UP TO DATE":"▶ RUN CANTERA SWEEP CURVES"}
        </button>
      )}
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <div style={S.card}><div style={S.cardT}>Laminar Flame Speed vs phi</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>Peak S_L occurs near stoichiometric (slightly rich for hydrocarbons, φ≈1.8 for H₂).</div><Chart data={sweep} xK="phi" yK="SL" xL="phi (φ)" yL={`Flame Speed (${uu(units,"SL")})`} color={C.violet} marker={mk}/></div>
      <div style={S.card}><div style={S.cardT}>Damköhler Number vs Flow Velocity</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>Da decreases linearly with velocity. Below Da=1 (horizontal line), blowoff occurs.</div><Chart data={daSw} xK="V" yK="Da" xL={`Velocity (${uu(units,"vel")})`} yL="Damköhler Number" color={C.accent2}/></div>
      <div style={S.card}><div style={S.cardT}>Flame Speed vs Pressure</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>S_L decreases with pressure (exponent β ≈ -0.3 to -0.4 for hydrocarbons).</div><Chart data={pSw} xK="P" yK="SL" xL={`Pressure (${uu(units,"P")})`} yL={`Flame Speed (${uu(units,"SL")})`} color={C.accent3}/></div>
      <div style={S.card}><div style={S.cardT}>Flame Speed vs Unburned Temperature</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>S_L increases strongly with preheat temperature (exponent α ≈ 1.5–2.0).</div><Chart data={tSw} xK="T" yK="SL" xL={`Unburned Temperature (${uu(units,"T")})`} yL={`Flame Speed (${uu(units,"SL")})`} color={C.accent}/></div>
    </div></div>);}

function CombustorPanel({fuel,ox,phi,T0,P,tau,setTau,Lpfr,setL,Vpfr,setV,Tfuel,setTfuel,WFR=0,waterMode="liquid",psrSeed,setPsrSeed,eqConstraint,setEqConstraint,integration,setIntegration,heatLossFrac,setHeatLossFrac,mechanism,setMechanism,
  // Activation state lifted to App so it survives tab nav when keepActivated.
  psrActive,setPsrActive,keepActivated,setKeepActivated}){
  const units=useContext(UnitCtx);
  const {accurate}=useContext(AccurateCtx);
  // Cantera PSR+PFR is the slowest backend call (~3-5 s). Off by default —
  // user clicks the green ACTIVATE button to fire it. While inactive, the
  // panel stays dimmed so the user knows nothing is being computed.
  // (psrActive/setPsrActive arrive as props from App so the state survives
  //  tab nav when the user enables the keep-activated preference.)
  // Air inlet T = T0 (sidebar "Air Temperature"); fuel inlet T = Tfuel (sidebar "Fuel Temperature").
  const Tair=T0;
  // PSR reactor options are lifted to App (so exportToExcel can see them).
  // Compatibility: unreacted seed has no equilibrium to constrain; autoignition is constant-HP by construction.
  const constraintDisabled=psrSeed==="unreacted"||psrSeed==="autoignition";
  const effectiveConstraint=psrSeed==="autoignition"?"HP":eqConstraint;
  const showIgnitionWarning=psrSeed==="unreacted"&&integration==="steady_state";
  // If user switches to autoignition while UV/TP was selected, snap the constraint back to HP.
  useEffect(()=>{if(psrSeed==="autoignition"&&eqConstraint!=="HP")setEqConstraint("HP");},[psrSeed]);
  // Every calc below is short-circuited on psrActive. When the panel is deactivated
  // we do ZERO work: no local JS PSR/PFR, no AFT equilibrium, no 31-point φ sweep,
  // no backend Cantera/AFT calls. The only thing that updates on parameter change
  // is the activate button and the static placeholder. This is the whole point of
  // the gate — keep the rest of the app fast.
  const localNet=useMemo(()=>psrActive?calcCombustorNetwork(fuel,ox,phi,T0,P,tau,Lpfr,Vpfr,Tfuel,Tair):null,[psrActive,fuel,ox,phi,T0,P,tau,Lpfr,Vpfr,Tfuel,Tair]);
  const bk=useBackendCalc("combustor",{fuel:nonzero(fuel),oxidizer:nonzero(ox),phi,T0,P:atmToBar(P),tau_psr_s:tau/1000,L_pfr_m:Lpfr,V_pfr_m_s:Vpfr,profile_points:60,T_fuel_K:Tfuel,T_air_K:Tair,psr_seed:psrSeed,eq_constraint:effectiveConstraint,integration,heat_loss_fraction:heatLossFrac,mechanism,WFR,water_mode:waterMode},accurate&&psrActive);
  // Canonical adiabatic flame temperature — same calc as the AFT panel, so the headline T_ad matches across panels.
  // Local: 4-reaction equilibrium (calcAFT_EQ). Accurate: Cantera full-species Gibbs equilibrium (GRI-Mech).
  const Tmix_aft=useMemo(()=>psrActive?mixT(fuel,ox,phi,Tfuel,Tair):0,[psrActive,fuel,ox,phi,Tfuel,Tair]);
  const localAFT=useMemo(()=>psrActive?calcAFT_EQ(fuel,ox,phi,Tmix_aft,P):null,[psrActive,fuel,ox,phi,Tmix_aft,P]);
  // bkAFT is also gated on psrActive — it's the AFT pre-fetch used only by this panel's headline T_ad.
  const bkAFT=useBackendCalc("aft",{fuel:nonzero(fuel),oxidizer:nonzero(ox),phi,T0,P:atmToBar(P),mode:"adiabatic",heat_loss_fraction:0,T_fuel_K:Tfuel,T_air_K:Tair,WFR,water_mode:waterMode},accurate&&psrActive);
  const T_ad_canonical=accurate&&bkAFT.data?(bkAFT.data.T_actual||bkAFT.data.T_ad):(localAFT?localAFT.T_ad:0);
  // Adapt backend response to local combustor format.
  const backendNet=bk.data?{
    T_ad:bk.data.T_exit,T_psr:bk.data.T_psr,conv_psr:bk.data.conv_psr,
    T_mixed_inlet_K:bk.data.T_mixed_inlet_K??T0,
    T_ad_equilibrium:bk.data.T_ad_equilibrium||null,
    T_ad_complete:bk.data.T_ad_complete||null,
    NO_ppm_exit:bk.data.NO_ppm_vd_exit,NO_ppm_psr:bk.data.NO_ppm_vd_psr,NO_ppm_15O2:bk.data.NO_ppm_15O2,
    CO_ppm_exit:bk.data.CO_ppm_vd_exit,CO_ppm_psr:bk.data.CO_ppm_vd_psr,CO_ppm_15O2:bk.data.CO_ppm_15O2,
    O2_pct:bk.data.O2_pct_dry_exit??0,  // dry-basis exhaust O2 from Cantera
    tau_pfr_ms:bk.data.tau_pfr_ms,tau_total_ms:bk.data.tau_total_ms,
    L_psr_cm:bk.data.L_psr_cm,L_total_cm:bk.data.L_total_cm,
    heat_loss_fraction:bk.data.heat_loss_fraction,T_target_K:bk.data.T_target_K,
    pfr:bk.data.profile||[],fromBackend:true
  }:null;
  const net=accurate&&backendNet?backendNet:localNet;
  // 15% O₂ correction factor (exit-basis, assumed constant across PSR→PFR in lean mode).
  // Lets the profile plot endpoints match the "NOx @ 15% O₂" / "CO @ 15% O₂" metrics.
  const pfrDisp=useMemo(()=>{
    if(!psrActive||!net)return[];
    const corrF=(20.95-15)/Math.max(20.95-(net.O2_pct||14),0.1);
    return net.pfr.map(pt=>({x:uv(units,"lenSmall",pt.x),T:uv(units,"T",pt.T),NO_ppm:pt.NO_ppm,CO_ppm:pt.CO_ppm,NO_ppm_15O2:pt.NO_ppm*corrF,CO_ppm_15O2:pt.CO_ppm*corrF,conv:pt.conv}));
  },[psrActive,net,units]);
  const emSw=useMemo(()=>{if(!psrActive)return[];const r=[];for(let p=0.4;p<=1.01;p+=0.02){const n=calcCombustorNetwork(fuel,ox,p,T0,P,tau,Lpfr,Vpfr,Tfuel,Tair);r.push({phi:+p.toFixed(2),NO:n.NO_ppm_15O2,CO:n.CO_ppm_exit});}return r;},[psrActive,fuel,ox,T0,P,tau,Lpfr,Vpfr,Tfuel,Tair]);
  return(<div style={{display:"flex",flexDirection:"column",gap:12}}>
    <InlineBusyBanner loading={accurate&&(bk.loading||bkAFT.loading)}/>
    {/* ── ACTIVATE button ─ Cantera PSR+PFR is the slowest call; off by default ── */}
    <button onClick={()=>setPsrActive(v=>!v)}
      title={psrActive?"Click to deactivate — stops firing the Cantera PSR+PFR backend on every parameter change.":"Click to activate — runs the Cantera PSR+PFR backend (~3-5 s per parameter change). Off by default to keep the app fast."}
      style={{padding:"10px 16px",fontSize:13,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".7px",
        color:psrActive?C.good:C.strong,
        background:psrActive?`${C.good}18`:`${C.strong}18`,
        border:`2px solid ${psrActive?C.good:C.strong}`,
        borderRadius:6,cursor:"pointer",
        display:"flex",alignItems:"center",justifyContent:"center",gap:10,
        transition:"all .12s"}}>
      <span style={{width:10,height:10,borderRadius:"50%",background:psrActive?C.good:C.strong,boxShadow:`0 0 8px ${psrActive?C.good:C.strong}`}}/>
      {psrActive?"ACTIVATED — PSR+PFR running on every change":"DEACTIVATED — click to fire Cantera PSR+PFR (~3-5 s)"}
    </button>
    <KeepActivatedToggle on={!!keepActivated} onChange={setKeepActivated} panelLabel="Combustor PSR→PFR"/>
    {/* When deactivated, render a static placeholder INSTEAD of the panel cards.
        Nothing below this line mounts until psrActive=true — no Cantera, no local
        PSR/PFR, no φ-sweep, no charts, no SVG, no DOM cost on parameter change. */}
    {!psrActive&&(
      <div style={{padding:"40px 24px",background:`${C.bg2}`,border:`1.5px dashed ${C.strong}60`,borderRadius:8,textAlign:"center",fontFamily:"'Barlow',sans-serif"}}>
        <div style={{fontSize:14,fontWeight:700,color:C.strong,letterSpacing:".5px",marginBottom:8,fontFamily:"'Barlow Condensed',sans-serif"}}>PSR + PFR PANEL DEACTIVATED</div>
        <div style={{fontSize:12,color:C.txtDim,lineHeight:1.55,maxWidth:560,margin:"0 auto"}}>
          The Cantera PSR + PFR network is the slowest backend call (~3–5 s per change). It is off by default to keep the rest of the app responsive.
          <br/><br/>
          Click <strong style={{color:C.good}}>ACTIVATE</strong> above to mount the panel and start running the network. While deactivated, no calculations are performed and no values are displayed — even the local-mode reduced-order model is paused.
        </div>
      </div>
    )}
    {psrActive&&<>
    {!accurate&&<div style={{padding:"12px 14px",background:`${C.strong}10`,border:`1.5px solid ${C.strong}60`,borderRadius:6,fontSize:11.5,lineHeight:1.55,color:C.txtDim,fontFamily:"'Barlow',sans-serif"}}>
      <div style={{fontSize:12.5,fontWeight:700,color:C.strong,marginBottom:6,letterSpacing:".3px"}}>⚠ APPROXIMATION — CASE-SPECIFIC REDUCED-ORDER MODEL</div>
      <p style={{margin:"0 0 6px"}}>This combustor network is <strong style={{color:C.strong}}>not a full chemical-kinetics solver</strong>. It is a calibrated reduced-order model whose CO and NOx kinetics were fit to Cantera (GRI-Mech 3.0) over a <strong style={{color:C.accent2}}>narrow operating envelope</strong>: natural-gas fuel + humid air, φ = 0.4–0.8, T_inlet = 700–900 K, P = 1–30 atm, τ_PSR = 0.3–10 ms. Inside that envelope, emissions are within ±15–35% of Cantera. The temperature and equilibrium composition are rigorous; the PSR/PFR kinetics are correlations.</p>
      <p style={{margin:"0 0 6px"}}><strong style={{color:C.strong}}>Do not use for:</strong> pure H₂ or H₂-rich syngas (prompt-NO correlation has no fuel dependence), rich operation (φ &gt; 0.85, Zeldovich back-reaction not modeled), oxy-fuel or high-EGR oxidizers, non-adiabatic combustors with significant heat loss, or design-level NOx predictions requiring detailed kinetics (LES/detailed-CRN). Outside the calibration envelope the results are <strong style={{color:C.accent2}}>order-of-magnitude estimates only</strong>.</p>
      <p style={{margin:0}}>A full-accuracy version with a server-side Cantera backend (detailed mechanisms, any fuel, heat-loss modeling, proper PSR bistability) is planned. <strong style={{color:C.accent}}>Contact ProReadyEngineer if you need design-grade combustor predictions.</strong></p>
    </div>}
    {accurate&&<div style={{padding:"10px 14px",background:`${C.accent}10`,border:`1px solid ${C.accent}50`,borderRadius:6,fontSize:11.5,color:C.txtDim,fontFamily:"'Barlow',sans-serif"}}>
      <strong style={{color:C.accent}}>✓ CANTERA PSR + PFR</strong> — GRI-Mech 3.0 kinetics, detailed Zeldovich + prompt NO, proper ReactorNet integration. Valid across full φ range, any fuel in the GRI set, any pressure.
    </div>}
    <HelpBox title="ℹ️ Combustor Network — How It Works"><p style={{margin:"0 0 6px"}}>This panel models the combustor as a <span style={hs.em}>primary zone</span> (PSR) feeding a <span style={hs.em}>burnout zone</span> (PFR), and reports emissions out of the burnout zone.</p><p style={{margin:"0 0 6px"}}><span style={hs.em}>You change:</span> φ, T_air, T_fuel, P in the sidebar, plus the network geometry — primary-zone residence time τ_PSR, burnout length L_PFR, and burnout mean velocity V_PFR.</p><p style={{margin:"0 0 6px"}}><span style={hs.em}>You get:</span> temperatures at the PSR exit and PFR exit, NOx and CO at both stations and corrected to 15% O₂ dry, residence times, and conversion. The plot shows how NOx@15%O₂ and CO@15%O₂ trade off vs τ_PSR.</p><p style={{margin:0,fontSize:11,color:C.txtMuted}}>Mechanism, kinetics, and the 15% O₂ correction are documented in the <strong>Assumptions</strong> tab.</p></HelpBox>
    <div style={S.card}><div style={S.cardT}>PSR → PFR Combustor Network {accurate&&(bk.loading?<span style={{fontSize:10,color:C.accent2,marginLeft:8,fontFamily:"monospace"}}>⟳ CANTERA…</span>:bk.err?<span style={{fontSize:10,color:C.warm,marginLeft:8,fontFamily:"monospace"}}>⚠ {bk.err}</span>:bk.data?<span style={{fontSize:10,color:C.accent,marginLeft:8,fontFamily:"monospace",fontWeight:700}}>✓ CANTERA</span>:null)}</div>
      <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap",marginBottom:12}}>
        <div style={{display:"flex",alignItems:"center",gap:5}}><Tip text="Primary zone residence time. Typical GT: 1–5 ms. Lower values increase blowout risk but reduce NOx."><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>τ_PSR (ms) ⓘ:</label></Tip><NumField value={tau} decimals={3} onCommit={v=>setTau(Math.max(v,0.01))} style={{...S.inp,width:65}}/></div>
        <div style={{display:"flex",alignItems:"center",gap:5}}><Tip text="Length of the burnout/dilution zone downstream of the primary zone. Longer = more complete CO burnout but more NOx."><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>L_PFR ({uu(units,"len")}) ⓘ:</label></Tip><NumField value={uv(units,"len",Lpfr)} decimals={4} onCommit={v=>setL(uvI(units,"len",v))} style={{...S.inp,width:65}}/></div>
        <div style={{display:"flex",alignItems:"center",gap:5}}><Tip text="Mean axial gas velocity in the PFR burnout section. Determines actual residence time in the PFR."><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>V_PFR ({uu(units,"vel")}) ⓘ:</label></Tip><NumField value={uv(units,"vel",Vpfr)} decimals={2} onCommit={v=>setV(uvI(units,"vel",v))} style={{...S.inp,width:65}}/></div>
        <div style={{fontSize:10,color:C.txtMuted,fontFamily:"monospace",marginLeft:8,paddingLeft:8,borderLeft:`1px dashed ${C.border}`}}>
          T_air = <span style={{color:C.accent3}}>{uv(units,"T",Tair).toFixed(1)} {uu(units,"T")}</span>
          &nbsp;·&nbsp; T_fuel = <span style={{color:C.orange}}>{uv(units,"T",Tfuel).toFixed(1)} {uu(units,"T")}</span>
          &nbsp;<span style={{color:C.txtMuted,fontSize:9}}>(set in sidebar)</span>
        </div>
      </div>
      {accurate&&(
        <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:12,padding:"8px 10px",background:C.bg2,border:`1px dashed ${C.border}`,borderRadius:4}}>
          <div style={{fontSize:9.5,color:C.txtMuted,fontFamily:"monospace",letterSpacing:".3px"}}>PSR REACTOR OPTIONS (advanced — defaults reproduce standard behavior)</div>
          {/* Seed row */}
          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
            <Tip text="How the PSR is initialized before the ReactorNet integrates to steady state. Unreacted = cold inlet, integrator must ignite it. Hot-Eq = plain equilibrium, NO locked at eq. Cold-Ignited (default) = equilibrium with NOx-family zeroed, so thermal NO builds kinetically. Autoignition = pre-solve a closed 0D constant-HP reactor past ignition, then use that as the seed.">
              <label style={{fontSize:10,color:C.txtDim,fontFamily:"monospace",cursor:"help",minWidth:98}}>PSR seed ⓘ:</label>
            </Tip>
            {[
              {v:"unreacted",l:"Unreacted"},
              {v:"hot_eq",l:"Hot Eq"},
              {v:"cold_ignited",l:"Cold-Ignited"},
              {v:"autoignition",l:"Autoignition"},
            ].map(o=>(
              <button key={o.v} onClick={()=>setPsrSeed(o.v)} style={{padding:"4px 9px",fontSize:10,fontWeight:psrSeed===o.v?700:400,color:psrSeed===o.v?C.bg:C.txtDim,background:psrSeed===o.v?C.accent:"transparent",border:`1px solid ${psrSeed===o.v?C.accent:C.border}`,borderRadius:3,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".3px",transition:"all .15s"}}>{o.l}</button>
            ))}
          </div>
          {/* Constraint row */}
          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",opacity:constraintDisabled?0.5:1}}>
            <Tip text="Thermodynamic constraint for the equilibrium seed. HP = constant enthalpy + pressure (correct for adiabatic PSR; default). UV = closed vessel. TP = isothermal at inlet T (rarely correct). Only active for Hot-Eq and Cold-Ignited seeds.">
              <label style={{fontSize:10,color:C.txtDim,fontFamily:"monospace",cursor:constraintDisabled?"not-allowed":"help",minWidth:98}}>Eq constraint ⓘ:</label>
            </Tip>
            {["HP","UV","TP"].map(c=>{
              const sel=effectiveConstraint===c;
              return(<button key={c} disabled={constraintDisabled} onClick={()=>!constraintDisabled&&setEqConstraint(c)} style={{padding:"4px 9px",fontSize:10,fontWeight:sel?700:400,color:sel?C.bg:C.txtDim,background:sel?C.accent3:"transparent",border:`1px solid ${sel?C.accent3:C.border}`,borderRadius:3,cursor:constraintDisabled?"not-allowed":"pointer",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".3px",transition:"all .15s"}}>{c}</button>);
            })}
            {psrSeed==="unreacted"&&<span style={{fontSize:9,color:C.txtMuted,fontStyle:"italic"}}>n/a — unreacted seed has no equilibrium to constrain</span>}
            {psrSeed==="autoignition"&&<span style={{fontSize:9,color:C.txtMuted,fontStyle:"italic"}}>forced to HP (autoignition is constant-HP)</span>}
          </div>
          {/* Integration row */}
          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
            <Tip text="PSR time-integration strategy. Steady-State = Cantera's built-in advance_to_steady_state (fast but can return prematurely for Zeldovich-dominated reactors). Chunked (default) = advance in 100τ chunks with ΔT/ΔNO convergence check. Step-by-Step = net.step() with per-step convergence (slowest, finest control).">
              <label style={{fontSize:10,color:C.txtDim,fontFamily:"monospace",cursor:"help",minWidth:98}}>Integration ⓘ:</label>
            </Tip>
            {[
              {v:"steady_state",l:"Steady-State"},
              {v:"chunked",l:"Chunked"},
              {v:"step",l:"Step-by-Step"},
            ].map(o=>(
              <button key={o.v} onClick={()=>setIntegration(o.v)} style={{padding:"4px 9px",fontSize:10,fontWeight:integration===o.v?700:400,color:integration===o.v?C.bg:C.txtDim,background:integration===o.v?C.accent2:"transparent",border:`1px solid ${integration===o.v?C.accent2:C.border}`,borderRadius:3,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".3px",transition:"all .15s"}}>{o.l}</button>
            ))}
            {showIgnitionWarning&&<span style={{fontSize:9,color:C.warm,fontStyle:"italic"}}>⚠ Steady-State + Unreacted may not ignite; Chunked is safer</span>}
          </div>
          {/* Heat-loss row */}
          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
            <Tip text="Fraction of sensible heat release removed from the PSR via film cooling, liner losses, and dilution. PSR is held at T_psr = T_ad − f·(T_ad − T_inlet) via a high-conductance heat-extraction wall. Typical real DLE combustors: 0.10–0.25 (10–25% quench from idealized adiabatic). A major lever on thermal NO: 20% quench at P = 27 bar drops NO@15%O₂ from ~1000 ppm (adiabatic, GRI-Mech) into the tens.">
              <label style={{fontSize:10,color:C.txtDim,fontFamily:"monospace",cursor:"help",minWidth:98}}>Heat loss ⓘ:</label>
            </Tip>
            <input type="range" min="0" max="0.5" step="0.01" value={heatLossFrac} onChange={e=>setHeatLossFrac(+e.target.value)} style={{width:140}}/>
            <span style={{fontSize:10,fontFamily:"monospace",color:C.accent,fontWeight:700,minWidth:40}}>{(heatLossFrac*100).toFixed(0)}%</span>
            <span style={{fontSize:9,color:C.txtMuted,fontStyle:"italic"}}>
              {heatLossFrac===0?"adiabatic (T_psr ≈ T_ad)":`T_psr ≈ T_ad − ${(heatLossFrac*100).toFixed(0)}%·(T_ad − T_inlet)`}
            </span>
          </div>
          {/* Mechanism row */}
          <div style={{display:"flex",alignItems:"flex-start",gap:6,flexWrap:"wrap"}}>
            <Tip text="Chemical-kinetics mechanism. The mechanism determines both fuel-oxidation pathways (ignition, flame speed, CO burnout) and NOx chemistry (thermal, prompt, N₂O). GRI-Mech 3.0 is the default because it ships with Cantera and includes both hydrocarbon + nitrogen chemistry in one file. Glarborg 2018 is a larger modern mechanism with comprehensive N-chemistry (NNH, N2O, prompt-NCN, NH3 oxidation) — use it when GRI's NOx numbers look suspect or when burning NH3/H2/CO blends. Other mechanisms (USC-Mech II, AramcoMech 3.0) are widely-cited alternatives validated at elevated pressures, but do not include built-in NOx chemistry and would require merging with a nitrogen sub-mechanism — not yet bundled.">
              <label style={{fontSize:10,color:C.txtDim,fontFamily:"monospace",cursor:"help",minWidth:98}}>Mechanism ⓘ:</label>
            </Tip>
            <div style={{display:"flex",flexDirection:"column",gap:4,flex:1,minWidth:280}}>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {[
                  {v:"gri30",l:"GRI-Mech 3.0",active:true},
                  {v:"glarborg",l:"Glarborg 2018",active:true},
                  {v:"usc2",l:"USC-Mech II",active:false},
                  {v:"aramco30",l:"AramcoMech 3.0",active:false},
                ].map(o=>{
                  const sel=mechanism===o.v;
                  return(<button key={o.v} disabled={!o.active} onClick={()=>o.active&&setMechanism(o.v)}
                    title={o.active?"":"Not yet bundled — see summary below"}
                    style={{padding:"4px 9px",fontSize:10,fontWeight:sel?700:400,color:sel?C.bg:(o.active?C.txtDim:C.txtMuted),background:sel?C.orange:"transparent",border:`1px solid ${sel?C.orange:C.border}`,borderRadius:3,cursor:o.active?"pointer":"not-allowed",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".3px",opacity:o.active?1:0.5,transition:"all .15s"}}>{o.l}{!o.active&&" (soon)"}</button>);
                })}
              </div>
              <div style={{fontSize:9.5,color:C.txtMuted,lineHeight:1.45,fontFamily:"'Barlow',sans-serif"}}>
                {mechanism==="gri30"&&<><strong style={{color:C.orange}}>GRI-Mech 3.0</strong> — 53 species, 325 reactions. Natural-gas oxidation (CH₄ → C₃H₈, H₂, NH₃) with thermal, prompt, and N₂O NOx chemistry.</>}
                {mechanism==="glarborg"&&<><strong style={{color:C.orange}}>Glarborg 2018</strong> — 151 species, 1395 reactions. Comprehensive nitrogen chemistry (thermal, prompt-NCN, N₂O, NNH, NH₃/HCN oxidation) merged with C1–C2 hydrocarbon kinetics. The state-of-the-art reference for NOx modeling in premixed flames (Glarborg, Miller, Ruscic, Klippenstein, <em>Prog. Energy Combust. Sci.</em> 2018). <span style={{color:C.warm}}>C1–C2 only</span> — C₃H₈ in the fuel is lumped to C₂H₆ on a hydrocarbon-mol basis (fine for natural gas with &lt;2% propane). Typically predicts 30–60% higher NO than GRI at DLE conditions — closer to experiments at elevated P.</>}
                {mechanism==="usc2"&&<><strong>USC-Mech II</strong> — 111 species, 784 reactions. C1–C4 + benzene kinetics, validated to P = 100 atm (Wang et al., USC 2007). Widely used for high-pressure gas-turbine CFD. <span style={{color:C.warm}}>Does not include nitrogen chemistry</span> — must be merged with a NOx sub-mechanism (Glarborg, Konnov-N) to compute NOx. Bundling pending.</>}
                {mechanism==="aramco30"&&<><strong>AramcoMech 3.0</strong> — 581 species, 3037 reactions. Modern C0–C4 oxidation (Zhou et al., NUIG 2017–2019) validated for natural gas, biogas, and hydrogen-enriched fuels across φ = 0.3–2 and P = 1–80 atm. <span style={{color:C.warm}}>Ships without NOx chemistry</span> — would need merging with Glarborg-N or AramcoN for NOx. Bundling pending.</>}
              </div>
            </div>
          </div>
        </div>
      )}
      {Math.abs(Tfuel-Tair)>0.5&&(
        <div style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",marginBottom:8,padding:"6px 10px",background:`${C.accent}08`,border:`1px dashed ${C.accent}40`,borderRadius:4}}>
          <div style={{marginBottom:2}}>
            <span style={{color:C.orange}}>T_fuel</span> = {uv(units,"T",Tfuel).toFixed(1)} {uu(units,"T")}
            <span style={{margin:"0 6px",color:C.txtMuted}}>+</span>
            <span style={{color:C.accent3}}>T_air</span> = {uv(units,"T",Tair).toFixed(1)} {uu(units,"T")}
            <span style={{margin:"0 6px",color:C.txtMuted}}>→ adiabatic mix →</span>
            <span style={{color:C.accent,fontWeight:700}}>T_inlet_PSR = {uv(units,"T",net.T_mixed_inlet_K??T0).toFixed(1)} {uu(units,"T")}</span>
          </div>
          <div style={{fontSize:9.5,color:C.txtMuted}}>
            {accurate
              ? "Cantera enthalpy balance: h_mix = Z·h_fuel(T_fuel) + (1−Z)·h_air(T_air), then solve gas.HPX for T."
              : "Free-version constant-cp approximation (cp_fuel≈2.2, cp_air≈1.005 kJ/kg·K). Switch to Combustion Toolkit or Advanced Mode for the exact Cantera enthalpy balance."}
          </div>
        </div>
      )}
      <svg viewBox="0 0 600 60" style={{width:"100%",maxWidth:750,marginBottom:10}}>
        <defs><linearGradient id="pg1b" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor={C.accent} stopOpacity=".6"/><stop offset="100%" stopColor={C.accent3} stopOpacity=".6"/></linearGradient><linearGradient id="pg2b" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor={C.accent3} stopOpacity=".6"/><stop offset="100%" stopColor={C.accent2} stopOpacity=".6"/></linearGradient></defs>
        <rect x="16" y="10" width="40" height="40" rx="4" fill="none" stroke={C.border} strokeWidth="1.5"/><text x="36" y="28" fill={C.txtDim} fontSize="7.5" textAnchor="middle" fontFamily="monospace">FUEL</text><text x="36" y="38" fill={C.txtDim} fontSize="7.5" textAnchor="middle" fontFamily="monospace">+OX</text><polygon points="58,26 70,30 58,34" fill={C.border}/>
        <rect x="72" y="5" width="150" height="50" rx="8" fill="url(#pg1b)" opacity=".12" stroke={C.accent} strokeWidth="1.5"/><text x="147" y="26" fill={C.accent} fontSize="11" textAnchor="middle" fontFamily="monospace" fontWeight="700">PSR</text><text x="147" y="40" fill={C.txtMuted} fontSize="8" textAnchor="middle" fontFamily="monospace">τ={tau}ms T={uv(units,"T",net.T_psr).toFixed(0)}{uu(units,"T")}</text>
        <polygon points="224,26 236,30 224,34" fill={C.border}/>
        <rect x="238" y="5" width="220" height="50" rx="8" fill="url(#pg2b)" opacity=".12" stroke={C.accent3} strokeWidth="1.5"/><text x="348" y="26" fill={C.accent3} fontSize="11" textAnchor="middle" fontFamily="monospace" fontWeight="700">PFR (Burnout)</text><text x="348" y="40" fill={C.txtMuted} fontSize="8" textAnchor="middle" fontFamily="monospace">L={uv(units,"len",Lpfr).toFixed(2)}{uu(units,"len")} V={uv(units,"vel",Vpfr).toFixed(1)}{uu(units,"vel")}</text>
        <polygon points="460,26 472,30 460,34" fill={C.border}/><text x="510" y="27" fill={C.accent2} fontSize="9" textAnchor="middle" fontFamily="monospace" fontWeight="700">EXIT</text><text x="510" y="40" fill={C.txtMuted} fontSize="7" textAnchor="middle" fontFamily="monospace">{uv(units,"T",net.pfr[net.pfr.length-1]?.T).toFixed(0)}{uu(units,"T")}</text>
      </svg>
      {/* ── Row 1: Flame Temperatures ───────────────────────────────── */}
      <div style={{fontSize:9.5,fontWeight:700,color:C.accent,textTransform:"uppercase",letterSpacing:"1.2px",margin:"4px 0 6px",paddingBottom:3,borderBottom:`1px solid ${C.accent}25`}}>Flame Temperatures</div>
      <div style={{...S.row,gap:8,marginBottom:12}}>
        <M l="T_ad — Chemical Equilibrium" v={uv(units,"T",(accurate&&backendNet&&backendNet.T_ad_equilibrium)?backendNet.T_ad_equilibrium:T_ad_canonical).toFixed(0)} u={uu(units,"T")} c={C.accent} tip="Full-species Cantera HP equilibrium (includes CO, OH, NO, H, O, H₂ dissociation products). Appropriate reference for the primary flame zone at combustor_air_frac = 1 (no dilution)."/>
        {accurate&&backendNet&&backendNet.T_ad_complete?
          <M l="T_ad — Complete Combustion" v={uv(units,"T",backendNet.T_ad_complete).toFixed(0)} u={uu(units,"T")} c={C.orange} tip="No dissociation (all C → CO₂, all H → H₂O). Higher than equilibrium by ≈10–100 K depending on T. Appropriate reference for the diluted combustor exit — the lower combustor_air_frac drops below 1, the better complete combustion represents the actual exit state."/>
          :null}
        <M l="Combustor Exit Temperature" v={uv(units,"T",net.T_ad).toFixed(0)} u={uu(units,"T")} c={C.accent2} tip="Kinetic PFR-exit T (Accurate mode). In Free mode this collapses to the PSR equilibrium T. This is the computed value; compare against the two T_ad references to see how far the kinetic solution sits from either idealization."/>
        <M l="PSR Exit Temperature" v={uv(units,"T",net.T_psr).toFixed(0)} u={uu(units,"T")} c={C.accent3} tip="Exit T of the well-stirred primary zone. At finite residence time, sits between complete combustion (radicals not yet recombined) and full equilibrium (NO formed). Should fall close to T_ad — Complete Combustion for realistic tau values."/>
      </div>

      {/* ── Row 2: Emissions ───────────────────────────────────────── */}
      <div style={{fontSize:9.5,fontWeight:700,color:C.warm,textTransform:"uppercase",letterSpacing:"1.2px",margin:"4px 0 6px",paddingBottom:3,borderBottom:`1px solid ${C.warm}25`}}>Emissions</div>
      <div style={{...S.row,gap:8,marginBottom:12}}>
        <M l="NOx at PSR Exit" v={((accurate&&backendNet?backendNet.NO_ppm_psr:net.NO_ppm_psr)??0).toFixed(1)} u="ppmvd" c={C.orange} tip="NO concentration leaving the PSR (entering the PFR). Growth between this value and 'NOx at Exit' is pure PFR-stage Zeldovich — small PSR/exit gap means most NOx is formed in the primary zone."/>
        <M l="CO at PSR Exit" v={((accurate&&backendNet?backendNet.CO_ppm_psr:net.CO_ppm_psr)??0).toFixed(1)} u="ppmvd" c={C.accent2} tip="CO concentration leaving the PSR (entering the PFR). In lean premixed combustors CO peaks at the PSR exit and is burned out in the PFR — so PSR CO minus exit CO is the burnout margin."/>
        <M l="NOx at Exit" v={net.NO_ppm_exit.toFixed(1)} u="ppm" c={C.warm} tip="Nitric oxide concentration at combustor exit (wet, actual O₂). Primarily thermal NOx from the Zeldovich mechanism."/>
        <M l="NOx15" v={net.NO_ppm_15O2.toFixed(1)} u="ppmvd" c={C.strong} tip="NOx corrected to 15% O₂ dry — the standard regulatory reporting basis for gas turbines and boilers."/>
        <M l="CO at Exit" v={net.CO_ppm_exit.toFixed(1)} u="ppm" c={C.accent2} tip="Carbon monoxide at exit (wet, actual O₂). High CO indicates incomplete combustion — reduce φ, increase τ, or lengthen PFR."/>
        <M l="CO15" v={net.CO_ppm_15O2.toFixed(1)} u="ppmvd" c={C.orange} tip="CO corrected to 15% O₂ dry — the same regulatory reporting basis used for NOx. Formula: CO × (20.95−15)/(20.95−O₂_dry)."/>
        <M l="Exhaust O₂ (dry)" v={net.O2_pct.toFixed(1)} u="%" c={C.accent3} tip="Residual oxygen in exhaust on a dry basis. Used for emissions correction and combustion efficiency."/>
      </div>

      {/* ── Row 3: Residence Time & Conversion ─────────────────────── */}
      <div style={{fontSize:9.5,fontWeight:700,color:C.accent2,textTransform:"uppercase",letterSpacing:"1.2px",margin:"4px 0 6px",paddingBottom:3,borderBottom:`1px solid ${C.accent2}25`}}>Residence Time & Conversion</div>
      <div style={{...S.row,gap:8}}>
        <M l="τ_PFR" v={net.tau_pfr_ms.toFixed(2)} u="ms" c={C.accent} tip="PFR residence time = L_PFR / V_PFR. Sets the time available for CO burnout and post-flame NOx growth."/>
        <M l="τ_total (PSR+PFR)" v={net.tau_total_ms.toFixed(2)} u="ms" c={C.accent2} tip="Total combustor residence time = τ_PSR + τ_PFR. Typical industrial gas turbine: 5–30 ms."/>
        <M l="PSR Conversion" v={net.conv_psr.toFixed(1)} u="%" c={C.good} tip="Fuel conversion in the PSR. 100% = complete combustion. Values below ~90% indicate approaching blowout."/>
      </div></div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <div style={S.card}><div style={S.cardT}>Temperature Profile (PSR → PFR)</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>Well-mixed plateau across the PSR, then constant through the adiabatic PFR (no heat loss in this model). Dashed line marks the PSR/PFR boundary.</div><Chart data={pfrDisp} xK="x" yK="T" xL={`Position along combustor (${uu(units,"lenSmall")})`} yL={`Temperature (${uu(units,"T")})`} color={C.accent2} vline={uv(units,"lenSmall",net.L_psr_cm)}/></div>
      <div style={S.card}><div style={S.cardT}>NOx15 & CO15 (PSR → PFR)</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>All ppm values corrected to 15% O₂ dry (regulatory reporting basis). Solid: NOx (flat across PSR, grows linearly in PFR via Zeldovich). Dashed: CO (PSR floor, first-order burnout in PFR). Vertical dashed line marks the PSR/PFR boundary.</div><Chart data={pfrDisp} xK="x" yK="NO_ppm_15O2" xL={`Position along combustor (${uu(units,"lenSmall")})`} yL="NOx15 (ppmvd)" color={C.warm} y2K="CO_ppm_15O2" c2={C.accent2} y2L="CO15 (ppmvd)" vline={uv(units,"lenSmall",net.L_psr_cm)}/></div>
    </div>
    <div style={S.card}><div style={S.cardT}>Emissions vs Equivalence Ratio</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>Classic NOx-CO tradeoff: lean mixtures reduce NOx but increase CO. Lean premixed combustors operate at φ ≈ 0.5–0.6 for low emissions.</div><Chart data={emSw} xK="phi" yK="NO" xL="phi (φ)" yL="NOx15 (ppm)" color={C.warm} y2K="CO" c2={C.accent2} y2L="CO (ppm)" w={700} h={270}/></div>
    </>}
  </div>);}

function ExhaustPanel({fuel,ox,T0,P,Tfuel,WFR=0,waterMode="liquid",measO2,setMeasO2,measCO2,setMeasCO2,measCO,setMeasCO,measUHC,setMeasUHC,measH2,setMeasH2,fuelFlowKgs,setFuelFlowKgs,fuelCostUsdPerMmbtuLhv,setFuelCostUsdPerMmbtuLhv,costPeriod,setCostPeriod,linkFuelFlow,setLinkFuelFlow,linkBreakable,combMode,setCombMode,cycleResult,bkMap,linkExhaustCO,setLinkExhaustCO,linkExhaustUHC,setLinkExhaustUHC,onPenaltyUpdate}){
  const units=useContext(UnitCtx);
  const {accurate}=useContext(AccurateCtx);
  const Tair=T0;
  // Two-pass inversion: bisect phi using T_mixed computed at the current mid-phi,
  // then refine T_mixed at the converged phi and re-solve AFT. For lean exhaust the
  // phi depends weakly on inlet T, so one refinement is enough.
  const solveExhaustLocal=(measured,method)=>{
    // First pass: use T_mixed at phi=0.6 (typical lean solution) as initial inlet T
    const Tmix0=mixT(fuel,ox,0.6,Tfuel,Tair);
    const fn=method==="O2"?calcExhaustFromO2:calcExhaustFromCO2;
    const first=fn(fuel,ox,measured,Tmix0,P,combMode);
    // Refine T_mixed at the solved phi, then re-solve
    const Tmix1=mixT(fuel,ox,first.phi,Tfuel,Tair);
    return fn(fuel,ox,measured,Tmix1,P,combMode);
  };
  // ── Phi_Exhaust + linked CO/UHC from Mapping CO15 ───────────────────────
  // Phi_Exhaust uses the cycle's air & fuel mass flows directly:
  //   FAR     = ṁ_fuel / ṁ_air_post_bleed
  //   Φ_Exh   = FAR / FAR_stoich
  // (NOT cycle.phi4 — the user explicitly asked for a flow-derived Φ on this
  // panel.) Linked CO scales mapping CO15 from the 15% O₂ basis to the actual
  // O₂ basis at Φ_Exh; linked UHC = CO/3 (LMS100 mapping convention).
  const _mappingCO15      = bkMap?.data?.correlations?.CO15 || 0;
  const _mdotFuelCycle    = cycleResult?.mdot_fuel_kg_s;
  const _mdotAirCycle     = cycleResult?.mdot_air_post_bleed_kg_s;
  const _FAR_stoich_panel = useMemo(()=>{
    const fp = calcFuelProps(fuel, ox);
    return 1 / (fp.AFR_mass || 1e-12);
  }, [fuel, ox]);
  const phiExhaust = useMemo(()=>{
    if (!Number.isFinite(_mdotFuelCycle) || !Number.isFinite(_mdotAirCycle)
        || _mdotAirCycle <= 0) return NaN;
    const FAR = _mdotFuelCycle / _mdotAirCycle;
    return FAR / _FAR_stoich_panel;
  }, [_mdotFuelCycle, _mdotAirCycle, _FAR_stoich_panel]);
  // O₂ at Φ_Exh on a dry basis (complete combustion — products are stoich).
  // calcAFT returns mole percents wet; convert to dry by 1/(1 − X_H2O).
  const o2DryAtPhiExhaust = useMemo(()=>{
    if (!Number.isFinite(phiExhaust) || phiExhaust <= 0 || phiExhaust >= 1) return NaN;
    const Tmix = mixT(fuel, ox, phiExhaust, Tfuel, Tair);
    const r = calcAFT(fuel, ox, phiExhaust, Tmix);
    const o2_wet  = r.products?.O2  || 0;
    const h2o_wet = r.products?.H2O || 0;
    const denom = 1 - h2o_wet/100;
    if (denom <= 0) return NaN;
    return o2_wet / denom;
  }, [phiExhaust, fuel, ox, Tfuel, Tair]);
  // Linked CO (ppmvd at actual O₂):
  //   CO_actual = CO15 × (20.9 − O2_dry%) / (20.9 − 15)
  // valid only when O2_dry < 20.9. UHC_linked = CO_linked / 3.
  const linkedCO = useMemo(()=>{
    if (!Number.isFinite(_mappingCO15) || _mappingCO15 <= 0) return NaN;
    if (!Number.isFinite(o2DryAtPhiExhaust) || o2DryAtPhiExhaust >= 20.9) return NaN;
    return _mappingCO15 * (20.9 - o2DryAtPhiExhaust) / 5.9;
  }, [_mappingCO15, o2DryAtPhiExhaust]);
  const linkedUHC = useMemo(()=>{
    if (!Number.isFinite(linkedCO)) return NaN;
    return linkedCO / 3;
  }, [linkedCO]);
  // Push the linked values into measCO / measUHC state when the link is
  // active and a finite linked value is available. The slip-correction
  // block downstream reads measCO / measUHC, so this keeps the entire
  // η_c calculation downstream of one source of truth.
  useEffect(()=>{
    if (linkExhaustCO && Number.isFinite(linkedCO)) {
      setMeasCO(linkedCO);
    }
  }, [linkExhaustCO, linkedCO, setMeasCO]);
  useEffect(()=>{
    if (linkExhaustUHC && Number.isFinite(linkedUHC)) {
      setMeasUHC(linkedUHC);
    }
  }, [linkExhaustUHC, linkedUHC, setMeasUHC]);

  const localRO2=useMemo(()=>solveExhaustLocal(measO2,"O2"),[fuel,ox,measO2,Tfuel,Tair,P,combMode]);
  const localRCO2=useMemo(()=>solveExhaustLocal(measCO2,"CO2"),[fuel,ox,measCO2,Tfuel,Tair,P,combMode]);
  const bkO2=useBackendCalc("exhaust",{fuel:nonzero(fuel),oxidizer:nonzero(ox),T0,P:atmToBar(P),measured_O2_pct_dry:measO2,combustion_mode:combMode,T_fuel_K:Tfuel,T_air_K:Tair,WFR,water_mode:waterMode},accurate);
  const bkCO2=useBackendCalc("exhaust",{fuel:nonzero(fuel),oxidizer:nonzero(ox),T0,P:atmToBar(P),measured_CO2_pct_dry:measCO2,combustion_mode:combMode,T_fuel_K:Tfuel,T_air_K:Tair,WFR,water_mode:waterMode},accurate);
  // Adapt backend exhaust response: equilibrium block + optional complete-combustion companion.
  const adaptEx=(r)=>{
    if(!r)return null;
    const eq={phi:r.phi,T_ad:r.T_ad,products:Object.fromEntries(Object.entries(r.exhaust_composition_wet||{}).filter(([k,v])=>v>1e-5).map(([k,v])=>[k,v*100])),FAR_mass:r.FAR,AFR_mass:r.AFR};
    const ccb=r.complete_combustion;
    const cc=(ccb&&ccb.phi)?{phi:ccb.phi,T_ad:ccb.T_ad,products:Object.fromEntries(Object.entries(ccb.exhaust_composition_wet||{}).filter(([k,v])=>v>1e-5).map(([k,v])=>[k,v*100])),FAR_mass:ccb.FAR,AFR_mass:ccb.AFR}:null;
    return{...eq,cc};
  };
  const rO2=accurate&&bkO2.data?adaptEx(bkO2.data):localRO2;
  const rCO2=accurate&&bkCO2.data?adaptEx(bkCO2.data):localRCO2;

  // ── Slip correction (CO + UHC + H₂ → combustion efficiency η_c) ────
  // Energy-loss formula (ASME PTC 4 / Lefebvre & Ballal Ch. 9):
  //   η_c = 1 − (N_dry/fuel) · (X_CO·LHV_CO + X_UHC·LHV_CH4 + X_H2·LHV_H2)
  //          / LHV_fuel,molar
  // where X_i are mole fractions in dry exhaust on the ACTUAL O₂ basis
  // (NOT 15% O₂ corrected) — caller supplies ppmvd directly.
  // Burn-side products are kept (they match the measured O₂/CO₂); only
  // φ / FAR / AFR / T_ad are remapped via η_c.
  // LHV constants (NIST, kJ/mol, water as vapor):
  //   CO + ½O₂ → CO₂              : 282.99
  //   CH₄ + 2O₂ → CO₂ + 2H₂O(g)   : 802.31
  //   H₂ + ½O₂ → H₂O(g)            : 241.83
  const LHV_CO_kJmol  = 282.99;
  const LHV_CH4_kJmol = 802.31;
  const LHV_H2_kJmol  = 241.83;
  const fp = useMemo(() => calcFuelProps(fuel, ox, Tfuel), [fuel, ox, Tfuel]);
  const LHV_fuel_kJmol = (fp.LHV_mass || 0) * (fp.MW_fuel || 0);   // MJ/kg · g/mol = kJ/mol
  // Per-fuel-mole carbon count in the inlet fuel — used to convert exhaust
  // mole fractions to "moles per mole fuel" via carbon atom balance.
  // Each fuel species: SP[sp].C carbons per molecule. Inert / non-carbon
  // fuel components (H₂, N₂, etc.) contribute 0.
  const nC_fuel = useMemo(() => {
    let n = 0; const tot = Object.values(fuel).reduce((a,b)=>a+b,0) || 1;
    for (const [sp, x] of Object.entries(fuel)){
      const C = SP[sp]?.C || 0;
      n += (x / tot) * C;
    }
    return n;
  }, [fuel]);
  // Compute η_c, φ_fed, FAR_fed, AFR_fed for one inversion result. Returns
  // {eta_c, phi_fed, FAR_fed, AFR_fed, slipActive}. Pass an `r` of the same
  // shape adaptEx returns: {phi, FAR_mass, AFR_mass, products: {sp: pct}}.
  const computeSlipCorrection = (r) => {
    if (!r) return {eta_c: 1, phi_fed: r?.phi, FAR_fed: r?.FAR_mass, AFR_fed: r?.AFR_mass, slipActive: false};
    const co_ppm  = Math.max(0, +measCO  || 0);
    const uhc_ppm = Math.max(0, +measUHC || 0);
    const h2_ppm  = Math.max(0, +measH2  || 0);
    if (co_ppm === 0 && uhc_ppm === 0 && h2_ppm === 0){
      return {eta_c: 1, phi_fed: r.phi, FAR_fed: r.FAR_mass, AFR_fed: r.AFR_mass, slipActive: false};
    }
    if (!nC_fuel || !LHV_fuel_kJmol){
      // Pure-H₂ or zero-LHV fuel — slip-correction undefined; bypass.
      return {eta_c: 1, phi_fed: r.phi, FAR_fed: r.FAR_mass, AFR_fed: r.AFR_mass, slipActive: false};
    }
    // products are stored as percent; convert back to mole fractions.
    const products = r.products || {};
    let X_C_total = 0;   // sum of carbon-bearing product mole fractions × n_C
    for (const [sp, pct] of Object.entries(products)){
      const C = SP[sp]?.C || 0;
      if (C > 0) X_C_total += (pct / 100) * C;
    }
    if (X_C_total <= 0){
      return {eta_c: 1, phi_fed: r.phi, FAR_fed: r.FAR_mass, AFR_fed: r.AFR_mass, slipActive: false};
    }
    // Atom balance: total moles of products / mole fuel = n_C_fuel / X_C_total
    const N_total_per_fuel = nC_fuel / X_C_total;
    const X_H2O_wet = (products.H2O || 0) / 100;
    const N_dry_per_fuel = N_total_per_fuel * (1 - X_H2O_wet);
    // Energy lost per mole of fuel fed (kJ/mol):
    //   N_dry/fuel  ·  ppmvd · 1e-6  ·  LHV_species_molar
    // Three terms — CO, UHC (as CH₄), H₂.
    const E_loss = N_dry_per_fuel * 1e-6 * (
      co_ppm  * LHV_CO_kJmol  +
      uhc_ppm * LHV_CH4_kJmol +
      h2_ppm  * LHV_H2_kJmol
    );
    const eta_c = Math.max(0.01, Math.min(1, 1 - E_loss / LHV_fuel_kJmol));
    return {
      eta_c,
      phi_fed: r.phi / eta_c,
      FAR_fed: r.FAR_mass / eta_c,
      AFR_fed: r.AFR_mass * eta_c,
      slipActive: true,
    };
  };
  const slipO2  = useMemo(() => computeSlipCorrection(rO2),
    [rO2, measCO, measUHC, measH2, nC_fuel, LHV_fuel_kJmol]);
  const slipCO2 = useMemo(() => computeSlipCorrection(rCO2),
    [rCO2, measCO, measUHC, nC_fuel, LHV_fuel_kJmol]);

  // Displayed Flame Temperature is the equilibrium T at the EFFECTIVE φ
  // (= φ_burn × η_c, where φ_burn is the FAR-at-100%-efficiency from the
  // original inversion). Net effect: as CO/UHC slip rises, η_c falls,
  // φ_eff falls, equilibrium T_ad falls — captures the inefficiency
  // penalty on flame temperature. Note the asymmetry vs displayed φ /
  // FAR / AFR (which are DIVIDED by η_c; the metered ratio rises).
  // At zero slip η_c = 1 so φ_eff = φ_burn and T reduces to the
  // existing burn-side T_ad (rO2.T_ad). Free mode → JS calcAFT_EQ.
  // Accurate mode → /calc/aft, gated on slipActive so no HTTP call
  // fires at zero slip.
  const phi_eff_O2  = (rO2  && Number.isFinite(rO2.phi))  ? rO2.phi  * (slipO2.eta_c  || 1) : 0.5;
  const phi_eff_CO2 = (rCO2 && Number.isFinite(rCO2.phi)) ? rCO2.phi * (slipCO2.eta_c || 1) : 0.5;
  const T_mix_eff_O2  = useMemo(() => mixT(fuel, ox, phi_eff_O2  || 0.6, Tfuel, Tair), [fuel, ox, phi_eff_O2,  Tfuel, Tair]);
  const T_mix_eff_CO2 = useMemo(() => mixT(fuel, ox, phi_eff_CO2 || 0.6, Tfuel, Tair), [fuel, ox, phi_eff_CO2, Tfuel, Tair]);
  const localFedO2  = useMemo(() => slipO2.slipActive  && Number.isFinite(phi_eff_O2)  ? calcAFT_EQ(fuel, ox, phi_eff_O2,  T_mix_eff_O2,  P) : null, [fuel, ox, phi_eff_O2,  T_mix_eff_O2,  P, slipO2.slipActive]);
  const localFedCO2 = useMemo(() => slipCO2.slipActive && Number.isFinite(phi_eff_CO2) ? calcAFT_EQ(fuel, ox, phi_eff_CO2, T_mix_eff_CO2, P) : null, [fuel, ox, phi_eff_CO2, T_mix_eff_CO2, P, slipCO2.slipActive]);
  const bkFedO2  = useBackendCalc("aft", {fuel: nonzero(fuel), oxidizer: nonzero(ox), phi: phi_eff_O2  || 0.5, T0: T_mix_eff_O2,  P: atmToBar(P), mode: "adiabatic", heat_loss_fraction: 0, T_fuel_K: Tfuel, T_air_K: Tair, WFR, water_mode: waterMode}, accurate && slipO2.slipActive  && Number.isFinite(phi_eff_O2));
  const bkFedCO2 = useBackendCalc("aft", {fuel: nonzero(fuel), oxidizer: nonzero(ox), phi: phi_eff_CO2 || 0.5, T0: T_mix_eff_CO2, P: atmToBar(P), mode: "adiabatic", heat_loss_fraction: 0, T_fuel_K: Tfuel, T_air_K: Tair, WFR, water_mode: waterMode}, accurate && slipCO2.slipActive && Number.isFinite(phi_eff_CO2));
  // T_ad to display: at zero slip → burn-side. With slip → Cantera/JS at φ_eff.
  const T_ad_disp_O2  = !slipO2.slipActive  ? rO2?.T_ad  : (accurate && bkFedO2.data?.T_ad)  ? bkFedO2.data.T_ad  : (localFedO2?.T_ad  ?? rO2?.T_ad);
  const T_ad_disp_CO2 = !slipCO2.slipActive ? rCO2?.T_ad : (accurate && bkFedCO2.data?.T_ad) ? bkFedCO2.data.T_ad : (localFedCO2?.T_ad ?? rCO2?.T_ad);

  // ── Fuel & Money — operating-point cost / penalty computation ────────
  // Uses the O₂-derived chemical-equilibrium FAR (η_c-corrected fed-side)
  // and η_c. O₂ is the more common stack measurement so we anchor on it;
  // the CO₂ path can differ slightly in φ inversion but is rarely the
  // primary operational signal.
  // Air-flow anchor: the burn-side FAR from the O₂ inversion ALONE.
  // At a fixed operating point the compressor delivers a fixed ṁ_air —
  // CO / UHC slip are downstream chemistry phenomena (kinetic quench,
  // mixing) and must NOT feed back into the air estimate. The slip
  // correction is reserved for the η_c, fed-side FAR / AFR display, and
  // the dollar penalty.
  const FAR_for_air = rO2?.FAR_mass || NaN;
  const eta_c_money = slipO2.slipActive ? slipO2.eta_c : 1;
  // Air mass flow (kg/s): m_air = m_fuel / FAR_burn (does not move with slip)
  const airFlowKgs = (Number.isFinite(fuelFlowKgs) && Number.isFinite(FAR_for_air) && FAR_for_air > 0)
    ? fuelFlowKgs / FAR_for_air : NaN;
  // Heat-input rate (MW) — m_fuel × LHV_mass. fp.LHV_mass is in MJ/kg, so
  // kg/s × MJ/kg = MJ/s = MW directly.
  const heatInputMW = (Number.isFinite(fuelFlowKgs) && fp.LHV_mass > 0)
    ? fuelFlowKgs * fp.LHV_mass : NaN;
  // Heat-input rate (MMBTU/hr) for ENG display — 1 MW = 3.41214 MMBTU/hr.
  const heatInputMMBtuHr = Number.isFinite(heatInputMW) ? heatInputMW * 3.41214 : NaN;
  // Total fuel cost per period (USD).
  //   $/hr = MMBTU/hr × $/MMBTU
  //   $/period = $/hr × hours/period
  const _hoursPerPeriod = costPeriod === "year"  ? 8760
                        : costPeriod === "month" ? 730
                        : 168;  // week (default)
  const totalCostPerHr = (Number.isFinite(heatInputMMBtuHr) && fuelCostUsdPerMmbtuLhv > 0)
    ? heatInputMMBtuHr * fuelCostUsdPerMmbtuLhv : NaN;
  const totalCostPerPeriod   = Number.isFinite(totalCostPerHr) ? totalCostPerHr * _hoursPerPeriod : NaN;
  // Penalty = fraction of fuel cost wasted on slip = total × (1 − η_c).
  const penaltyCostPerPeriod = Number.isFinite(totalCostPerPeriod) ? totalCostPerPeriod * (1 - eta_c_money) : NaN;
  // Lift penalty + period to App so the Mapping panel's Operating Snapshot
  // can show "Inefficiencies — Penalty / {period}" alongside acoustics
  // and emissions. NaN → null so consumers can render "—" cleanly.
  useEffect(()=>{
    if(typeof onPenaltyUpdate !== "function") return;
    if(Number.isFinite(penaltyCostPerPeriod)){
      onPenaltyUpdate({value: penaltyCostPerPeriod, period: costPeriod});
    } else {
      onPenaltyUpdate({value: null, period: costPeriod});
    }
  }, [penaltyCostPerPeriod, costPeriod, onPenaltyUpdate]);
  // Display formatters: thousand-separated USD with 0 decimals (penalty
  // always shown in the same precision as total so the two are visually
  // comparable; small penalty values still read cleanly).
  const _fmtUSD = (v) => Number.isFinite(v)
    ? "$" + v.toLocaleString("en-US", {minimumFractionDigits: 0, maximumFractionDigits: 0})
    : "—";
  const o2Sweep=useMemo(()=>{const r=[];for(let o2=0.5;o2<=15;o2+=0.5){const Tm0=mixT(fuel,ox,0.6,Tfuel,Tair);const res0=calcExhaustFromO2(fuel,ox,o2,Tm0,P,combMode);const Tm1=mixT(fuel,ox,res0.phi,Tfuel,Tair);const res=calcExhaustFromO2(fuel,ox,o2,Tm1,P,combMode);r.push({O2:o2,T_ad:uv(units,"T",res.T_ad),phi:res.phi});}return r;},[fuel,ox,Tfuel,Tair,P,combMode,units]);
  const modeToggle=<div style={{display:"flex",border:`1px solid ${C.border}`,borderRadius:5,overflow:"hidden",marginBottom:10}}>
    {["complete","equilibrium"].map(m=><button key={m} onClick={()=>setCombMode(m)} style={{padding:"6px 12px",fontSize:10.5,fontWeight:combMode===m?700:400,color:combMode===m?C.bg:C.txtDim,background:combMode===m?C.accent:"transparent",border:"none",cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".4px",transition:"all .15s"}}>{m==="complete"?"Complete Combustion":"Chemical Equilibrium"}</button>)}
  </div>;
  const status=(kbk)=>accurate?(kbk.loading?<span style={{fontSize:10,color:C.accent2,marginLeft:8,fontFamily:"monospace"}}>⟳ CANTERA…</span>:kbk.err?<span style={{fontSize:10,color:C.warm,marginLeft:8,fontFamily:"monospace"}}>⚠ {kbk.err}</span>:kbk.data?<span style={{fontSize:10,color:C.accent,marginLeft:8,fontFamily:"monospace",fontWeight:700}}>✓ CANTERA</span>:null):null;
  return(<div style={{display:"flex",flexDirection:"column",gap:12}}>
    <InlineBusyBanner loading={accurate&&(bkO2.loading||bkCO2.loading)}/>
    <HelpBox title="ℹ️ Exhaust Analysis — How It Works"><p style={{margin:"0 0 6px"}}>This panel back-solves the operating point from a <span style={hs.em}>stack measurement</span>. Enter what your analyzer reads in the dry exhaust and the tool finds the equivalence ratio φ that produces it.</p><p style={{margin:"0 0 6px"}}><span style={hs.em}>You change:</span> measured O₂ (% dry) or measured CO₂ (% dry). Optionally measured CO, UHC (as CH₄), and H₂ (ppmvd) if your analyzer reports them. Optionally fuel flow and fuel cost for the dollar view.</p><p style={{margin:"0 0 6px"}}><span style={hs.em}>You get:</span> φ, FAR, AFR, flame temperature, and the full exhaust composition. Two cards report the result two ways — Complete Combustion (right answer for stack and most combustor-exit readings) and Chemical Equilibrium (for in-flame readings at the primary zone only).</p><p style={{margin:"0 0 6px"}}><span style={hs.em}>Slip and Fuel &amp; Money.</span> If you've entered CO / UHC / H₂, those are fuel that walked through unburned — the panel turns them into a <strong>combustion efficiency</strong> and corrects the metered φ / FAR / AFR for the lost mass. With a fuel flow and price entered, the inefficiency becomes a <strong style={{color:C.warm}}>dollar penalty</strong> per week, month, or year — the cost share lost to slip. Useful for sizing the impact of a CO / UHC excursion before deciding whether to tune.</p><p style={{margin:0,fontSize:11,color:C.txtMuted}}>Formulas, citations, and modeling assumptions live in the <strong>Assumptions</strong> tab.</p></HelpBox>
    {accurate?null:modeToggle}
    {/* ── Optional slip measurements (CO + UHC) ────────────────────────
        When non-zero, the Chemical Equilibrium card below reports
        combustion efficiency η_c and the FED-side φ / FAR / AFR / flame T
        (corrected for the unburned mass that walked through). At zero
        the panel behaves exactly as before — η_c = 1, no correction. */}
    <div style={{padding:"10px 14px",background:`${C.violet}0A`,
      border:`1px solid ${C.violet}30`,borderRadius:6,
      display:"flex",alignItems:"center",gap:14,flexWrap:"wrap"}}>
      <div style={{fontSize:10,fontWeight:700,color:C.violet,
        textTransform:"uppercase",letterSpacing:"1.2px",
        fontFamily:"'Barlow Condensed',sans-serif"}}>
        Optional slip measurements
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:3}}>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <Tip text={`Measured CO concentration in exhaust (dry, on the actual O₂ basis — NOT 15% O₂ corrected). Set to zero if not measured. Used in the energy-loss formula to compute combustion efficiency η_c.${linkExhaustCO?" Currently linked to Mapping CO15 (corrected to actual-O₂ basis via Phi_Exhaust). Break the link below to type a manual value.":""}`}>
            <label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>
              Measured CO (ppmvd dry, actual) ⓘ:
            </label>
          </Tip>
          <NumField value={measCO} decimals={1}
            onCommit={v=>setMeasCO(Math.max(0,+v))}
            disabled={linkExhaustCO}
            title={linkExhaustCO?"Linked to Mapping CO15 (corrected to actual-O₂ basis via Phi_Exhaust) — break the link below to type a manual value":undefined}
            style={{width:80,padding:"4px 6px",fontFamily:"monospace",
              color:linkExhaustCO?C.txtMuted:C.violet,fontSize:12,fontWeight:700,
              background:linkExhaustCO?C.bg2:C.bg,
              border:`1px solid ${linkExhaustCO?C.border:`${C.violet}50`}`,
              borderRadius:4,textAlign:"center",
              cursor:linkExhaustCO?"not-allowed":"text"}}/>
        </div>
        {linkExhaustCO && <LinkChip onBreak={linkBreakable?()=>setLinkExhaustCO(false):null} label="Linked to Mapping CO15"/>}
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:3}}>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <Tip text={`Measured unburned hydrocarbons in exhaust, expressed as ppmvd CH₄ (dry, actual O₂ basis — NOT 15% O₂ corrected). Speciated FTIR readings should be totaled and reported on a CH₄ basis. Used in the energy-loss formula via LHV_CH₄ = 802.31 kJ/mol.${linkExhaustUHC?" Currently linked to Mapping CO15 (UHC = CO/3 per LMS100 mapping convention). Break the link below to type a manual value.":""}`}>
            <label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>
              Measured UHC as CH₄ (ppmvd dry, actual) ⓘ:
            </label>
          </Tip>
          <NumField value={measUHC} decimals={1}
            onCommit={v=>setMeasUHC(Math.max(0,+v))}
            disabled={linkExhaustUHC}
            title={linkExhaustUHC?"Linked to Mapping CO15 (UHC = CO_linked / 3) — break the link below to type a manual value":undefined}
            style={{width:80,padding:"4px 6px",fontFamily:"monospace",
              color:linkExhaustUHC?C.txtMuted:C.violet,fontSize:12,fontWeight:700,
              background:linkExhaustUHC?C.bg2:C.bg,
              border:`1px solid ${linkExhaustUHC?C.border:`${C.violet}50`}`,
              borderRadius:4,textAlign:"center",
              cursor:linkExhaustUHC?"not-allowed":"text"}}/>
        </div>
        {linkExhaustUHC && <LinkChip onBreak={linkBreakable?()=>setLinkExhaustUHC(false):null} label="Linked to Mapping CO15 (÷3)"/>}
      </div>
      <div style={{display:"flex",alignItems:"center",gap:6}}>
        <Tip text="Measured H₂ in exhaust (dry, actual O₂ basis — NOT 15% O₂ corrected). Relevant for syngas, H₂-blended fuels, or partial oxidation upsets. Used in the energy-loss formula via LHV_H₂ = 241.83 kJ/mol. Set to zero for natural-gas combustion (H₂ slip is typically negligible there).">
          <label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>
            Measured H₂ (ppmvd dry, actual) ⓘ:
          </label>
        </Tip>
        <NumField value={measH2} decimals={1}
          onCommit={v=>setMeasH2(Math.max(0,+v))}
          style={{width:80,padding:"4px 6px",fontFamily:"monospace",
            color:C.violet,fontSize:12,fontWeight:700,background:C.bg,
            border:`1px solid ${C.violet}50`,borderRadius:4,textAlign:"center"}}/>
      </div>
      <div style={{flex:"1 1 100%",fontSize:10,color:C.txtMuted,
        fontFamily:"'Barlow',sans-serif",lineHeight:1.45,fontStyle:"italic"}}>
        Enter values if you have stack measurements; leave at zero otherwise. Drives combustion efficiency on the Chemical Equilibrium card and the operating-cost penalty below. See the <strong>How It Works</strong> box above for details.
      </div>
    </div>

    {/* ── Fuel & Money — operating-point flows + cost / penalty ────────
        Inputs:  fuel mass flow (lb/hr ENG / kg/hr SI) — default 40,000 lb/hr;
                  fuel cost ($/MMBTU LHV) — default $4.00;
                  period toggle (week / month / year).
        Computed using the O₂-derived chemical-equilibrium fed-side FAR &
        η_c (so changing CO/UHC/H₂ above re-flows down to all four cards):
                  air mass flow (lb/s ENG / kg/s SI) = m_fuel / FAR_fed
                  heat-input rate (MMBTU/hr ENG / MW SI) = m_fuel · LHV_mass
                  total fuel cost / period
                  PENALTY / period = total × (1 − η_c)   [warm color] */}
    <div style={{padding:"10px 14px",background:`${C.accent2}0A`,
      border:`1px solid ${C.accent2}30`,borderRadius:6,
      display:"flex",flexDirection:"column",gap:10}}>
      <div style={{fontSize:10,fontWeight:700,color:C.accent2,
        textTransform:"uppercase",letterSpacing:"1.2px",
        fontFamily:"'Barlow Condensed',sans-serif"}}>
        Fuel &amp; Money — at this operating point
      </div>
      {/* Inputs row */}
      <div style={{display:"flex",alignItems:"center",gap:14,flexWrap:"wrap"}}>
        <div style={{display:"flex",flexDirection:"column",gap:3}}>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <Tip text="Total mass flow of fuel metered to the combustor. Default = 40,000 lb/hr (typical heavy-duty GT baseload, e.g. an LMS100 at full load). Stored internally in kg/s; the field shows lb/hr in English units, kg/hr in SI. In Gas Turbine Simulator and Advanced modes this field is linked to the Cycle's ṁ_fuel by default — break the link to override manually.">
              <label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>
                Fuel Flow ({units==="ENG"?"lb/hr":"kg/hr"}) ⓘ:
              </label>
            </Tip>
            <NumField value={units==="ENG"?(fuelFlowKgs*7936.64):(fuelFlowKgs*3600)}
              decimals={0}
              onCommit={v=>{
                const val = Math.max(0, +v || 0);
                setFuelFlowKgs(units==="ENG" ? val/7936.64 : val/3600);
              }}
              disabled={linkFuelFlow}
              title={linkFuelFlow?"Linked to Cycle ṁ_fuel — break the link below to type a manual value":undefined}
              style={{width:96,padding:"4px 6px",fontFamily:"monospace",
                color:linkFuelFlow?C.txtMuted:C.accent2,
                fontSize:12,fontWeight:700,
                background:linkFuelFlow?C.bg2:C.bg,
                border:`1px solid ${linkFuelFlow?C.border:`${C.accent2}50`}`,
                borderRadius:4,textAlign:"center",
                cursor:linkFuelFlow?"not-allowed":"text"}}/>
          </div>
          {/* Cycle ṁ_fuel linkage chip — shown when the effective link
              is active (forced ON in Gas Turbine Simulator; user-controlled
              ON in Advanced). Hidden in Free / Combustion Toolkit (no cycle
              running). BREAK button is suppressed (LOCKED) outside Advanced. */}
          {linkFuelFlow && <LinkChip onBreak={linkBreakable?()=>setLinkFuelFlow(false):null} label="Linked to Cycle ṁ_fuel"/>}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <Tip text="Fuel cost in US dollars per million BTU on a LHV basis — the standard contract / regulatory unit for natural gas. Default $4.00/MMBTU LHV (typical 2024-2026 industrial-tier U.S. NG benchmark). Adjust to your actual fuel contract.">
            <label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>
              Fuel Cost ($/MMBTU LHV) ⓘ:
            </label>
          </Tip>
          <NumField value={fuelCostUsdPerMmbtuLhv} decimals={2}
            onCommit={v=>setFuelCostUsdPerMmbtuLhv(Math.max(0, +v || 0))}
            style={{width:78,padding:"4px 6px",fontFamily:"monospace",
              color:C.accent2,fontSize:12,fontWeight:700,background:C.bg,
              border:`1px solid ${C.accent2}50`,borderRadius:4,textAlign:"center"}}/>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace"}}>Period:</label>
          <div style={{display:"flex",border:`1px solid ${C.border}`,borderRadius:4,overflow:"hidden"}}>
            {[{k:"week",l:"Wk"},{k:"month",l:"Mo"},{k:"year",l:"Yr"}].map(p=>(
              <button key={p.k} onClick={()=>setCostPeriod(p.k)}
                style={{padding:"4px 12px",fontSize:10.5,fontWeight:costPeriod===p.k?700:400,
                  fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".4px",
                  color:costPeriod===p.k?C.bg:C.txtDim,
                  background:costPeriod===p.k?C.accent2:"transparent",
                  border:"none",cursor:"pointer",transition:"all .15s"}}>
                {p.l}
              </button>
            ))}
          </div>
        </div>
      </div>
      {/* Computed row 1: air flow + heat input */}
      <div style={{...S.row,gap:8}}>
        <M l="Air Mass Flow" v={Number.isFinite(airFlowKgs)?(units==="ENG"?(airFlowKgs*2.20462).toFixed(2):airFlowKgs.toFixed(3)):"—"}
          u={units==="ENG"?"lb/s":"kg/s"} c={C.accent3}
          tip={`Mass flow of combustion air (post-bleed if cycle is linked). Computed from m_air = m_fuel / FAR_fed using the η_c-corrected fed-side FAR from the Chemical Equilibrium card on the O₂ side: FAR_fed = ${Number.isFinite(FAR_for_air)?FAR_for_air.toFixed(5):"—"}. Changes with both the fuel-flow input and the slip measurements above.`}/>
        <M l="Heat Input (LHV)" v={Number.isFinite(heatInputMMBtuHr)?(units==="ENG"?heatInputMMBtuHr.toFixed(0):heatInputMW.toFixed(2)):"—"}
          u={units==="ENG"?"MMBTU/hr":"MW"} c={C.accent}
          tip="Fuel-side heat input rate on a LHV basis: m_fuel · LHV_mass. Independent of efficiency — this is the chemical energy entering the combustor per unit time. Useful sanity-check against expected MW output."/>
      </div>
      {/* Computed row 2: cost + penalty (penalty in warm to draw the eye) */}
      <div style={{...S.row,gap:8}}>
        <M l={`Total Fuel Cost / ${costPeriod}`} v={_fmtUSD(totalCostPerPeriod)} u="USD" c={C.txtDim}
          tip={`Total fuel bill at this operating point: heat input × ${fuelCostUsdPerMmbtuLhv.toFixed(2)} $/MMBTU LHV × ${_hoursPerPeriod} hr. The full amount the operator pays for fuel — informational, regardless of efficiency.`}/>
        <M l={`PENALTY / ${costPeriod}`} v={_fmtUSD(penaltyCostPerPeriod)} u={`USD · η_c=${(eta_c_money*100).toFixed(2)}%`} c={C.warm}
          tip={`Money walking out the stack as unburned CO + UHC + H₂. Computed as Total Fuel Cost × (1 − η_c). At η_c = 1 (no slip), this is zero. The actionable number for justifying combustor tuning interventions.`}/>
      </div>
    </div>

    {/* ============== FROM MEASURED O2 ============== */}
    <div style={S.card}>
      <div style={{...S.cardT,display:"flex",alignItems:"center",gap:8}}>From Measured O₂ (% dry) {status(bkO2)}</div>
      {/* Dedicated input bar — LEFT-aligned so the field sits directly above
          the result-card labels (PHI / FLAME TEMPERATURE / FUEL-AIR / AIR-FUEL),
          giving a clean vertical alignment between the user's input and the
          values it drives. */}
      <div style={{display:"flex",justifyContent:"flex-start",alignItems:"center",gap:10,
        padding:"8px 12px",marginBottom:10,
        background:`${C.accent}10`,border:`1px solid ${C.accent}45`,borderRadius:6}}>
        <Tip text="Enter the measured O₂ concentration in the exhaust on a dry basis. Typical values: 2–6% for gas turbines, 3–8% for boilers. The analysis below back-solves φ and flame temperature from this single measurement.">
          <label style={{fontSize:11,fontWeight:700,color:C.accent,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".6px",cursor:"help",textTransform:"uppercase"}}>Enter measured O₂ (% dry) ⓘ</label>
        </Tip>
        <NumField value={measO2} decimals={2} onCommit={setMeasO2}
          style={{width:90,padding:"5px 8px",fontFamily:"'Barlow Condensed',sans-serif",color:C.accent,fontSize:16,fontWeight:700,background:C.bg,border:`1.5px solid ${C.accent}80`,borderRadius:5,textAlign:"center",outline:"none",letterSpacing:".5px"}}/>
        <span style={{fontSize:11,color:C.txtMuted,fontFamily:"monospace"}}>%</span>
      </div>
      <div style={{display:"grid",gridTemplateColumns:accurate&&rO2.cc?"1fr 1fr":"1fr",gap:12}}>
        {accurate&&rO2.cc?<div style={{padding:12,background:`${C.orange}0A`,border:`1px solid ${C.orange}40`,borderRadius:6}}>
          <div style={{fontSize:11,fontWeight:700,color:C.orange,textTransform:"uppercase",letterSpacing:"1.2px",marginBottom:8}}>Complete Combustion <span style={{fontSize:9,fontWeight:500,color:C.txtMuted,textTransform:"none"}}>— stack / diluted-exit readings · slip not modeled (see Chemical Equilibrium for fed-side η_c)</span></div>
          <div style={{...S.row,gap:6}}>
            <M l="phi" v={rO2.cc.phi.toFixed(3)} u="—" c={C.orange} tip="Inverted assuming no dissociation."/>
            <M l="Flame Temperature" v={uv(units,"T",rO2.cc.T_ad).toFixed(0)} u={uu(units,"T")} c={C.orange} tip="T_ad under the complete-combustion assumption."/>
            <M l="Fuel/Air (mass)" v={rO2.cc.FAR_mass.toFixed(4)} u={uu(units,"afr_mass")} c={C.orange} tip="Fuel/air mass ratio from complete-combustion inversion."/>
            <M l="Air/Fuel (mass)" v={(1/(rO2.cc.FAR_mass+1e-20)).toFixed(2)} u={uu(units,"afr_mass")} c={C.orange} tip="Air/fuel mass ratio."/>
          </div>
          {rO2.cc.products&&<div style={{marginTop:10}}>
            <div style={{fontSize:10,fontWeight:700,color:C.orange,textTransform:"uppercase",letterSpacing:"1px",marginBottom:4}}>Products — Wet Basis</div>
            <HBar data={rO2.cc.products} h={Math.max(100,Object.keys(rO2.cc.products).length*20+8)} w={380}/>
            <div style={{fontSize:10,fontWeight:700,color:C.orange,textTransform:"uppercase",letterSpacing:"1px",margin:"8px 0 4px"}}>Dry Basis (H₂O removed)</div>
            <HBar data={dryBasis(rO2.cc.products)} h={Math.max(90,Math.max(0,Object.keys(rO2.cc.products).length-1)*20+8)} w={380}/>
          </div>}
        </div>:null}
        <div style={{padding:12,background:`${C.accent}0A`,border:`1px solid ${C.accent}40`,borderRadius:6}}>
          <div style={{fontSize:11,fontWeight:700,color:C.accent,textTransform:"uppercase",letterSpacing:"1.2px",marginBottom:8}}>Chemical Equilibrium <span style={{fontSize:9,fontWeight:500,color:C.txtMuted,textTransform:"none"}}>— in-flame, air_frac = 1{slipO2.slipActive?` · slip-corrected (η_c = ${(slipO2.eta_c*100).toFixed(2)}%)`:""}</span></div>
          <div style={{...S.row,gap:6}}>
            <M l="phi" v={(slipO2.phi_fed||rO2.phi).toFixed(3)} u="—" c={C.accent} tip={slipO2.slipActive?"Fed-side equivalence ratio φ_fed = φ_burn / η_c. Reflects the actual fuel that was metered to the combustor (some of which slipped through unburned).":"Inverted using full Cantera HP equilibrium (includes CO, OH, NO dissociation)."}/>
            <M l="Flame Temperature" v={uv(units,"T",T_ad_disp_O2).toFixed(0)} u={uu(units,"T")} c={C.accent} tip={slipO2.slipActive?"Equilibrium flame T at the EFFECTIVE φ (= φ_burn × η_c, the FAR at 100% efficiency multiplied by the efficiency). As CO/UHC slip rises, η_c falls, φ_eff falls, and equilibrium flame T falls with it — captures the inefficiency penalty on flame temperature even while the metered φ / FAR rise.":"T_ad under the full-equilibrium assumption."}/>
            <M l="Fuel/Air (mass)" v={(slipO2.FAR_fed||rO2.FAR_mass).toFixed(4)} u={uu(units,"afr_mass")} c={C.accent} tip={slipO2.slipActive?"Fed-side fuel/air mass ratio (= burn-side / η_c).":"Fuel/air mass ratio from equilibrium inversion."}/>
            <M l="Air/Fuel (mass)" v={(slipO2.slipActive?slipO2.AFR_fed:1/(rO2.FAR_mass+1e-20)).toFixed(2)} u={uu(units,"afr_mass")} c={C.accent} tip={slipO2.slipActive?"Fed-side air/fuel mass ratio (= burn-side × η_c).":"Air/fuel mass ratio."}/>
            {slipO2.slipActive&&<M l="η_c" v={(slipO2.eta_c*100).toFixed(2)} u="%" c={C.violet} tip="Combustion efficiency from CO/UHC slip energy-loss formula. η_c = 1 − (N_dry/fuel) × (X_CO·LHV_CO + X_UHC·LHV_CH4) / LHV_fuel."/>}
          </div>
          {slipO2.slipActive&&<div style={{marginTop:6,padding:"5px 8px",background:`${C.violet}10`,border:`1px solid ${C.violet}30`,borderRadius:4,fontSize:9.5,color:C.txtMuted,fontFamily:"monospace",lineHeight:1.4}}>
            η_c = {(slipO2.eta_c*100).toFixed(2)}% — φ / FAR / AFR are <strong style={{color:C.violet}}>fed-side</strong> (= burn-side ÷ η_c, the metered ratio rises with slip). Flame T is Cantera HP-eq at the <strong style={{color:C.violet}}>effective</strong> φ (= φ_burn × η_c = {(rO2.phi*slipO2.eta_c).toFixed(3)}, falls with slip). Burn-side ref (no slip): φ = {rO2.phi.toFixed(3)}, T_ad = {uv(units,"T",rO2.T_ad).toFixed(0)} {uu(units,"T")}.
          </div>}
          {rO2.products&&<div style={{marginTop:10}}>
            <div style={{fontSize:10,fontWeight:700,color:C.accent,textTransform:"uppercase",letterSpacing:"1px",marginBottom:4}}>Products — Wet Basis <span style={{fontSize:8.5,fontWeight:500,color:C.txtMuted,textTransform:"none"}}>(burn-side; matches measured O₂)</span></div>
            <HBar data={rO2.products} h={Math.max(100,Object.keys(rO2.products).length*20+8)} w={380}/>
            <div style={{fontSize:10,fontWeight:700,color:C.accent,textTransform:"uppercase",letterSpacing:"1px",margin:"8px 0 4px"}}>Dry Basis (H₂O removed)</div>
            <HBar data={dryBasis(rO2.products)} h={Math.max(90,Math.max(0,Object.keys(rO2.products).length-1)*20+8)} w={380}/>
          </div>}
        </div>
      </div>
    </div>

    {/* ============== FROM MEASURED CO2 ============== */}
    <div style={S.card}>
      <div style={{...S.cardT,display:"flex",alignItems:"center",gap:8}}>From Measured CO₂ (% dry) {status(bkCO2)}</div>
      {/* Left-aligned input bar — matches the O₂ block above so both
          measurement fields sit at the same x-coordinate as the result-card
          labels (PHI / FLAME TEMPERATURE / FUEL-AIR / AIR-FUEL) directly
          below them. */}
      <div style={{display:"flex",justifyContent:"flex-start",alignItems:"center",gap:10,
        padding:"8px 12px",marginBottom:10,
        background:`${C.accent}10`,border:`1px solid ${C.accent}45`,borderRadius:6}}>
        <Tip text="Enter the measured CO₂ concentration in the exhaust on a dry basis. Higher CO₂ indicates richer combustion. The analysis below back-solves φ and flame temperature from this single measurement.">
          <label style={{fontSize:11,fontWeight:700,color:C.accent,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".6px",cursor:"help",textTransform:"uppercase"}}>Enter measured CO₂ (% dry) ⓘ</label>
        </Tip>
        <NumField value={measCO2} decimals={2} onCommit={setMeasCO2}
          style={{width:90,padding:"5px 8px",fontFamily:"'Barlow Condensed',sans-serif",color:C.accent,fontSize:16,fontWeight:700,background:C.bg,border:`1.5px solid ${C.accent}80`,borderRadius:5,textAlign:"center",outline:"none",letterSpacing:".5px"}}/>
        <span style={{fontSize:11,color:C.txtMuted,fontFamily:"monospace"}}>%</span>
      </div>
      <div style={{display:"grid",gridTemplateColumns:accurate&&rCO2.cc?"1fr 1fr":"1fr",gap:12}}>
        {accurate&&rCO2.cc?<div style={{padding:12,background:`${C.orange}0A`,border:`1px solid ${C.orange}40`,borderRadius:6}}>
          <div style={{fontSize:11,fontWeight:700,color:C.orange,textTransform:"uppercase",letterSpacing:"1.2px",marginBottom:8}}>Complete Combustion <span style={{fontSize:9,fontWeight:500,color:C.txtMuted,textTransform:"none"}}>— stack / diluted-exit readings · slip not modeled (see Chemical Equilibrium for fed-side η_c)</span></div>
          <div style={{...S.row,gap:6}}>
            <M l="phi" v={rCO2.cc.phi.toFixed(3)} u="—" c={C.orange} tip="Inverted assuming no dissociation."/>
            <M l="Flame Temperature" v={uv(units,"T",rCO2.cc.T_ad).toFixed(0)} u={uu(units,"T")} c={C.orange} tip="T_ad under the complete-combustion assumption."/>
            <M l="Fuel/Air (mass)" v={rCO2.cc.FAR_mass.toFixed(4)} u={uu(units,"afr_mass")} c={C.orange} tip="Fuel/air mass ratio from complete-combustion inversion."/>
            <M l="Air/Fuel (mass)" v={(1/(rCO2.cc.FAR_mass+1e-20)).toFixed(2)} u={uu(units,"afr_mass")} c={C.orange} tip="Air/fuel mass ratio."/>
          </div>
          {rCO2.cc.products&&<div style={{marginTop:10}}>
            <div style={{fontSize:10,fontWeight:700,color:C.orange,textTransform:"uppercase",letterSpacing:"1px",marginBottom:4}}>Products — Wet Basis</div>
            <HBar data={rCO2.cc.products} h={Math.max(100,Object.keys(rCO2.cc.products).length*20+8)} w={380}/>
            <div style={{fontSize:10,fontWeight:700,color:C.orange,textTransform:"uppercase",letterSpacing:"1px",margin:"8px 0 4px"}}>Dry Basis (H₂O removed)</div>
            <HBar data={dryBasis(rCO2.cc.products)} h={Math.max(90,Math.max(0,Object.keys(rCO2.cc.products).length-1)*20+8)} w={380}/>
          </div>}
        </div>:null}
        <div style={{padding:12,background:`${C.accent}0A`,border:`1px solid ${C.accent}40`,borderRadius:6}}>
          <div style={{fontSize:11,fontWeight:700,color:C.accent,textTransform:"uppercase",letterSpacing:"1.2px",marginBottom:8}}>Chemical Equilibrium <span style={{fontSize:9,fontWeight:500,color:C.txtMuted,textTransform:"none"}}>— in-flame, air_frac = 1{slipCO2.slipActive?` · slip-corrected (η_c = ${(slipCO2.eta_c*100).toFixed(2)}%)`:""}</span></div>
          <div style={{...S.row,gap:6}}>
            <M l="phi" v={(slipCO2.phi_fed||rCO2.phi).toFixed(3)} u="—" c={C.accent} tip={slipCO2.slipActive?"Fed-side equivalence ratio φ_fed = φ_burn / η_c. Reflects the actual fuel that was metered to the combustor.":"Inverted using full Cantera HP equilibrium."}/>
            <M l="Flame Temperature" v={uv(units,"T",T_ad_disp_CO2).toFixed(0)} u={uu(units,"T")} c={C.accent} tip={slipCO2.slipActive?"Equilibrium flame T at the EFFECTIVE φ (= φ_burn × η_c, the FAR at 100% efficiency multiplied by the efficiency). As CO/UHC slip rises, η_c falls, φ_eff falls, and equilibrium flame T falls with it.":"T_ad under the full-equilibrium assumption."}/>
            <M l="Fuel/Air (mass)" v={(slipCO2.FAR_fed||rCO2.FAR_mass).toFixed(4)} u={uu(units,"afr_mass")} c={C.accent} tip={slipCO2.slipActive?"Fed-side fuel/air mass ratio (= burn-side / η_c).":"Fuel/air mass ratio from equilibrium inversion."}/>
            <M l="Air/Fuel (mass)" v={(slipCO2.slipActive?slipCO2.AFR_fed:1/(rCO2.FAR_mass+1e-20)).toFixed(2)} u={uu(units,"afr_mass")} c={C.accent} tip={slipCO2.slipActive?"Fed-side air/fuel mass ratio (= burn-side × η_c).":"Air/fuel mass ratio."}/>
            {slipCO2.slipActive&&<M l="η_c" v={(slipCO2.eta_c*100).toFixed(2)} u="%" c={C.violet} tip="Combustion efficiency from CO/UHC slip energy-loss formula."/>}
          </div>
          {slipCO2.slipActive&&<div style={{marginTop:6,padding:"5px 8px",background:`${C.violet}10`,border:`1px solid ${C.violet}30`,borderRadius:4,fontSize:9.5,color:C.txtMuted,fontFamily:"monospace",lineHeight:1.4}}>
            η_c = {(slipCO2.eta_c*100).toFixed(2)}% — φ / FAR / AFR are <strong style={{color:C.violet}}>fed-side</strong> (= burn-side ÷ η_c, rises with slip). Flame T is Cantera HP-eq at the <strong style={{color:C.violet}}>effective</strong> φ (= φ_burn × η_c = {(rCO2.phi*slipCO2.eta_c).toFixed(3)}, falls with slip). Burn-side ref (no slip): φ = {rCO2.phi.toFixed(3)}, T_ad = {uv(units,"T",rCO2.T_ad).toFixed(0)} {uu(units,"T")}.
          </div>}
          {rCO2.products&&<div style={{marginTop:10}}>
            <div style={{fontSize:10,fontWeight:700,color:C.accent,textTransform:"uppercase",letterSpacing:"1px",marginBottom:4}}>Products — Wet Basis <span style={{fontSize:8.5,fontWeight:500,color:C.txtMuted,textTransform:"none"}}>(burn-side; matches measured CO₂)</span></div>
            <HBar data={rCO2.products} h={Math.max(100,Object.keys(rCO2.products).length*20+8)} w={380}/>
            <div style={{fontSize:10,fontWeight:700,color:C.accent,textTransform:"uppercase",letterSpacing:"1px",margin:"8px 0 4px"}}>Dry Basis (H₂O removed)</div>
            <HBar data={dryBasis(rCO2.products)} h={Math.max(90,Math.max(0,Object.keys(rCO2.products).length-1)*20+8)} w={380}/>
          </div>}
        </div>
      </div>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <div style={S.card}><div style={S.cardT}>Flame Temperature vs Exhaust O₂</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>Higher exhaust O₂ → leaner combustion → lower flame temperature. Coral marker shows your measurement.</div><Chart data={o2Sweep} xK="O2" yK="T_ad" xL="Exhaust O₂ (%)" yL={`Flame Temperature (${uu(units,"T")})`} color={C.warm} marker={{x:measO2,y:uv(units,"T",rO2.T_ad),label:`${uv(units,"T",rO2.T_ad).toFixed(0)} ${uu(units,"T")}`}}/></div>
      <div style={S.card}><div style={S.cardT}>phi vs Exhaust O₂</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>Direct mapping from exhaust O₂ to φ. At 0% O₂, φ ≈ 1.0 (stoichiometric).</div><Chart data={o2Sweep} xK="O2" yK="phi" xL="Exhaust O₂ (%)" yL="phi (φ)" color={C.accent} marker={{x:measO2,y:rO2.phi,label:`φ=${rO2.phi.toFixed(3)}`}}/></div>
    </div></div>);}

function PropsPanel(){
  const units=useContext(UnitCtx);const[sp,setSp]=useState("H2O");const[Tmin,setTmin]=useState(300);const[Tmax,setTmax]=useState(3000);const[step,setStep]=useState(100);
  const temps=useMemo(()=>{const r=[];for(let t=Tmin;t<=Tmax;t+=step)r.push(t);return r.slice(0,200);},[Tmin,Tmax,step]);
  const data=useMemo(()=>temps.map(T=>{const H_SI=h_mol(sp,T)/1000;const S_SI=sR(sp,T)*R_u;const G_SI=H_SI-T*S_SI/1000;return{T:uv(units,"T",T),Cp:uv(units,"cp",cp_mol(sp,T)),H:uv(units,"h_mol",H_SI),S:uv(units,"s_mol",S_SI),G:uv(units,"h_mol",G_SI)};}),[sp,temps,units]);
  return(<div style={{display:"flex",flexDirection:"column",gap:12}}>
    <HelpBox title="ℹ️ Thermo Database — How It Works"><p style={{margin:"0 0 6px"}}>Computes thermodynamic properties using <span style={hs.em}>NASA 7-coefficient polynomials</span> valid from 200–6000K. These are the same polynomials used by Cantera, CEA, and CHEMKIN. Two sets of coefficients cover low (200–1000K) and high (1000–6000K) ranges.</p><p style={{margin:0}}><span style={hs.em}>Cp</span> = heat capacity at constant pressure. <span style={hs.em}>H</span> = sensible enthalpy relative to elements at 0K. <span style={hs.em}>S</span> = absolute entropy at 1 atm. <span style={hs.em}>G</span> = Gibbs free energy = H − TS.</p></HelpBox>
    <div style={{...S.card,display:"flex",gap:12,alignItems:"flex-end",flexWrap:"wrap"}}>
      <div><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",display:"block",marginBottom:3}}>Species</label><select style={{...S.sel,width:170}} value={sp} onChange={e=>setSp(e.target.value)}>{Object.entries(SP).map(([k,v])=><option key={k} value={k}>{v.nm} ({k})</option>)}</select></div>
      <div><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",display:"block",marginBottom:3}}>T_min (K)</label><input type="number" style={{...S.inp,width:75}} value={Tmin} onChange={e=>setTmin(+e.target.value||200)}/></div>
      <div><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",display:"block",marginBottom:3}}>T_max (K)</label><input type="number" style={{...S.inp,width:75}} value={Tmax} onChange={e=>setTmax(+e.target.value||3000)}/></div>
      <div><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",display:"block",marginBottom:3}}>Step (K)</label><input type="number" style={{...S.inp,width:65}} value={step} onChange={e=>setStep(+e.target.value||50)}/></div>
      <div style={{padding:"6px 10px",background:`${C.accent}0A`,borderRadius:5,fontSize:10.5,fontFamily:"monospace",color:C.txtDim}}><strong style={{color:C.accent}}>MW:</strong> {SP[sp]?.MW} g/mol &nbsp;<strong style={{color:C.accent}}>ΔH°f:</strong> {((SP[sp]?.Hf||0)/1000).toFixed(2)} kJ/mol</div>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
      <div style={S.card}><div style={S.cardT}>Heat Capacity ({uu(units,"cp")})</div><Chart data={data} xK="T" yK="Cp" xL={`Temperature (${uu(units,"T")})`} yL={uu(units,"cp")} color={C.accent3} w={350}/></div>
      <div style={S.card}><div style={S.cardT}>Enthalpy ({uu(units,"h_mol")})</div><Chart data={data} xK="T" yK="H" xL={`Temperature (${uu(units,"T")})`} yL={uu(units,"h_mol")} color={C.accent} w={350}/></div>
      <div style={S.card}><div style={S.cardT}>Entropy ({uu(units,"s_mol")})</div><Chart data={data} xK="T" yK="S" xL={`Temperature (${uu(units,"T")})`} yL={uu(units,"s_mol")} color={C.good} w={350}/></div>
    </div>
    <div style={S.card}><div style={S.cardT}>Data Table</div><div style={{overflowX:"auto",maxHeight:300,overflowY:"auto"}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontFamily:"monospace",fontSize:11}}>
        <thead><tr>{[`Temperature (${uu(units,"T")})`,`Cp (${uu(units,"cp")})`,`Enthalpy (${uu(units,"h_mol")})`,`Entropy (${uu(units,"s_mol")})`,`Gibbs G (${uu(units,"h_mol")})`].map(h=><th key={h} style={{textAlign:"left",padding:"6px 8px",borderBottom:`1px solid ${C.border}`,color:C.txtDim,fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:"1px",position:"sticky",top:0,background:C.bg3}}>{h}</th>)}</tr></thead>
        <tbody>{data.map((r,i)=>(<tr key={i} style={{background:i%2?`${C.bg}55`:"transparent"}}><td style={{padding:"4px 8px",color:C.txt}}>{r.T.toFixed(1)}</td><td style={{padding:"4px 8px",color:C.txtDim}}>{r.Cp.toFixed(3)}</td><td style={{padding:"4px 8px",color:C.txtDim}}>{r.H.toFixed(3)}</td><td style={{padding:"4px 8px",color:C.txtDim}}>{r.S.toFixed(3)}</td><td style={{padding:"4px 8px",color:C.txtDim}}>{r.G.toFixed(3)}</td></tr>))}</tbody></table></div></div></div>);}

/* ══════════════════ ASSUMPTIONS PANEL ══════════════════
   Read-only reference page listing every modeling assumption the cycle
   and combustion solvers depend on. Grouped by topic so users can audit
   what the solver is doing and what it is NOT doing. No inputs — pure
   documentation. If a number changes in cycle.py (e.g. eta_isen_turb,
   combustor_bypass_frac, MWI band edges) it must be updated here too.
*/
function Assumption({label,value,note}){
  return(<div style={{display:"grid",gridTemplateColumns:"220px 170px 1fr",gap:10,padding:"6px 8px",borderBottom:`1px solid ${C.border}40`,alignItems:"baseline"}}>
    <div style={{fontSize:11,color:C.txtDim,fontFamily:"'Barlow',sans-serif",fontWeight:600}}>{label}</div>
    <div style={{fontSize:11,color:C.accent,fontFamily:"monospace",fontWeight:600}}>{value}</div>
    <div style={{fontSize:10.5,color:C.txtMuted,fontFamily:"'Barlow',sans-serif",lineHeight:1.5}}>{note}</div>
  </div>);
}
function AssumptionsGroup({title,subtitle,children}){
  return(<div style={{...S.card,padding:"12px 14px"}}>
    <div style={{fontSize:12,fontWeight:700,color:C.accent,letterSpacing:".6px",marginBottom:2,fontFamily:"'Barlow Condensed',sans-serif",textTransform:"uppercase"}}>{title}</div>
    {subtitle&&<div style={{fontSize:10.5,color:C.txtMuted,marginBottom:10,lineHeight:1.5,fontFamily:"'Barlow',sans-serif"}}>{subtitle}</div>}
    <div style={{marginTop:8}}>
      <div style={{display:"grid",gridTemplateColumns:"220px 170px 1fr",gap:10,padding:"4px 8px",borderBottom:`1px solid ${C.border}`,fontSize:9,color:C.txtMuted,textTransform:"uppercase",letterSpacing:"1.2px",fontFamily:"monospace",fontWeight:700}}>
        <div>Parameter</div><div>Value</div><div>Basis / Rationale</div>
      </div>
      {children}
    </div>
  </div>);
}
// ─────────────────────────────────────────────────────────────────────────
//  NOMENCLATURE PANEL
//
//  Single, searchable index of every variable, output, and convention used
//  anywhere in the app. Sources of truth:
//
//    1. AUTO_VARS    — every input the DOE/Automation tab can vary
//    2. AUTO_OUTPUTS — every result the DOE/Automation tab can capture
//    3. NOMENCLATURE_EXTRA — concepts not in the catalogs above
//                            (cycle station numbers, common subscripts,
//                            ppm vs ppmvd, dry vs wet, sign conventions)
//
//  When a label has been renamed for industry-standard brevity, the long
//  form is exposed via NOMENCLATURE_LONGNAMES so users can search for the
//  classical name (e.g. "Equivalence Ratio") and still find the entry that
//  now displays as "phi".
// ─────────────────────────────────────────────────────────────────────────
const NOMENCLATURE_LONGNAMES = {
  // Operating point (renamed for industry naming):
  phi:               "Equivalence ratio (mass-of-fuel / mass-of-fuel-stoich at the same air); the lean/rich knob.",
  FAR:               "Fuel/Air mass ratio.",
  T_flame:           "TFlame_CC — adiabatic flame T, complete combustion (no dissociation), at the 3-stream mixed inlet. The third equivalent way to express the operating point alongside phi and FAR.",
  T_air:             "Air Temp — combustor air-side inlet temperature (before adiabatic mixing with fuel).",
  T_fuel:            "Fuel Temp — fuel-side inlet temperature (before adiabatic mixing with air).",
  P:                 "Combustor static pressure.",
  WFR:               "Water-injection mass per unit fuel mass (kg water / kg fuel).",
  // Outputs:
  NOx_15_psr:        "PSR-PFR exit NOx mole fraction, corrected to 15% O₂ on a dry basis (regulatory standard for stationary gas turbines).",
  CO_15_psr:         "PSR-PFR exit CO mole fraction, corrected to 15% O₂ dry.",
  NOx15_mapping:     "Combustor-mapping correlation NOx, corrected to 15% O₂ dry.",
  CO15_mapping:      "Combustor-mapping correlation CO, corrected to 15% O₂ dry.",
  T_ad:              "Tad_eq — adiabatic flame T computed by Cantera HP equilibrium with full dissociation (NO, OH, etc. allowed).",
  T_ad_complete:     "Tad_CC — adiabatic flame T assuming complete combustion to CO₂ + H₂O + O₂ + N₂ only (no dissociation). Always higher than Tad_eq.",
  T_ad_equilibrium:  "Tad_eq reference value displayed alongside the kinetic PSR/PFR temperatures.",
  T_ad_complete_comb:"Tad_CC reference value displayed alongside the kinetic PSR/PFR temperatures.",
  T1:                "Compressor inlet T (≡ ambient).",
  T2:                "Low-pressure compressor exit T.",
  T2c:               "Intercooler exit T (LMS100 only).",
  T3:                "Combustor inlet T = high-pressure compressor exit T.",
  T4:                "Combustor exit / turbine inlet T (firing temperature).",
  T5:                "Turbine exit T.",
  T_Bulk:            "Flame-zone T at the (T3, P3, phi_Bulk) point — what the flame actually sees before dilution.",
  P3:                "Combustor inlet pressure = HPC exit pressure.",
  phi4:              "Equivalence ratio at the combustor exit station 4 (post-dilution).",
  phi_Bulk:          "Equivalence ratio in the flame zone before dilution.",
  FAR4:              "Mass-basis fuel/air ratio at station 4.",
  FAR_Bulk:          "Mass-basis fuel/air ratio in the flame zone (= FAR4 / combustor_air_frac).",
  // Exhaust slip measurements + combustion-efficiency outputs (Phase 3 AUTO_VARS / AUTO_OUTPUTS):
  measCO:            "Stack CO concentration measured on a dry basis at the actual exhaust O₂ (NOT 15% O₂ corrected). Drives the η_c energy-loss formula.",
  measUHC:           "Stack unburned-hydrocarbons measured as ppmvd CH₄-equivalent on a dry basis (actual O₂). Drives the η_c energy-loss formula.",
  measH2:            "Stack H₂ measured on a dry basis (actual O₂). Relevant for syngas, H₂ blends, partial-oxidation upsets. Drives the η_c energy-loss formula.",
  fuelFlowKgs:       "Fuel mass flow into the combustor. In Gas Turbine Simulator and Advanced modes this is auto-linked to the cycle's ṁ_fuel; user can break the link to type a manual value.",
  fuelCostUsdPerMmbtuLhv: "Fuel price in USD per million BTU on a LHV basis — the standard contract / regulatory unit for natural gas. Default $4.00/MMBTU, adjust to actual contract.",
  // Slip-corrected outputs (per O₂ and CO₂ inversion paths):
  exh_eta_c_o2:      "Combustion efficiency η_c, computed via energy-loss formula (ASME PTC 4 / Lefebvre Ch. 9), using the O₂-derived equilibrium products as the dry-flow reference. η_c = 1 − N_dry/fuel · (X_CO·LHV_CO + X_UHC·LHV_CH4 + X_H2·LHV_H2) / LHV_fuel.",
  exh_eta_c_co2:     "Same formula as exh_eta_c_o2 but anchored on the CO₂-derived equilibrium products.",
  exh_phi_fed_o2:    "Fed-side equivalence ratio (= φ_burn / η_c, the operator-metered φ) from the O₂ inversion path. Larger than φ_burn whenever there's slip.",
  exh_phi_fed_co2:   "Same as exh_phi_fed_o2 but from the CO₂ inversion path.",
  exh_FAR_fed_o2:    "Fed-side fuel/air mass ratio (= FAR_burn / η_c) from the O₂ inversion path.",
  exh_FAR_fed_co2:   "Same from the CO₂ inversion path.",
  exh_AFR_fed_o2:    "Fed-side air/fuel mass ratio (= AFR_burn × η_c) from the O₂ inversion path.",
  exh_AFR_fed_co2:   "Same from the CO₂ inversion path.",
  exh_T_ad_eff_o2:   "Equilibrium flame T at the EFFECTIVE φ (= φ_burn × η_c, the FAR-at-100%-efficiency multiplied by η_c). Lower than φ_burn HP equilibrium T because only the η_c fraction released its chemical energy. Falls as slip rises.",
  exh_T_ad_eff_co2:  "Same as exh_T_ad_eff_o2 but from the CO₂ inversion path.",
  air_flow_kg_s:     "Combustion air mass flow rate (post-bleed when cycle is linked) inferred from m_fuel / FAR_fed using the η_c-corrected fed-side FAR from the Chemical Equilibrium card.",
  heat_input_MW:     "Fuel-side heat input rate on a LHV basis: m_fuel · LHV_mass. Independent of combustion efficiency.",
  total_fuel_cost_per_hr: "Total fuel-cost rate at the operating point: heat_input_MMBTU/hr × $/MMBTU LHV. Multiply by 168 / 730 / 8760 for week / month / year totals.",
  penalty_per_hr_o2: "Money-rate equivalent of the chemical energy walking out of the stack as unburned CO + UHC + H₂. Penalty/hr = total_cost_per_hr × (1 − η_c). Anchored on the O₂-derived η_c.",
  penalty_per_hr_co2:"Same as penalty_per_hr_o2 but anchored on the CO₂-derived η_c.",
};

// Concepts that have no AUTO_VARS / AUTO_OUTPUTS entry — combustion
// vocabulary the user encounters in chart axes, tooltips, and the
// Excel export. Listed in the Nomenclature panel under "Conventions".
const NOMENCLATURE_EXTRA = [
  { symbol: "ppm",     fullName: "Parts per million (mole)",  unit: "—",   group: "Units & conventions",
    desc: "Mole fraction × 1e6. Wet basis unless stated. For emissions, always check whether the value is corrected to 15% O₂ dry (ppmvd) or just raw wet ppm." },
  { symbol: "ppmvd",   fullName: "Parts per million by volume, dry",  unit: "—", group: "Units & conventions",
    desc: "Mole fraction on a dry basis (H₂O removed) × 1e6. The standard regulatory reporting unit for NOx and CO. Higher than wet ppm by ~10–20% depending on combustion." },
  { symbol: "@ 15% O₂", fullName: "Corrected to 15% O₂ dry", unit: "—",  group: "Units & conventions",
    desc: "Standard correction for stationary gas-turbine emissions: ppm_15 = ppm_actual × (20.95 − 15) / (20.95 − O₂_dry%). Removes the dilution effect of excess air." },
  { symbol: "wet basis",  fullName: "Wet (includes H₂O) mole fractions", unit: "—", group: "Units & conventions",
    desc: "Mole fractions where H₂O is part of the total moles. Native Cantera output." },
  { symbol: "dry basis",  fullName: "Dry (H₂O removed) mole fractions", unit: "—", group: "Units & conventions",
    desc: "Mole fractions after H₂O is mathematically removed and the rest renormalised to sum to 1. The basis used for stack-O₂ readings and emissions correction." },
  { symbol: "Cantera mode", fullName: "Accurate vs Free computation mode", unit: "—", group: "Modes",
    desc: "Accurate Mode routes solves to the Cantera backend (full kinetics, validated NASA polynomials, GRI-Mech 3.0 by default). Free Mode runs reduced-order JS correlations in the browser — ~5% the cost and ~95% the accuracy." },
  { symbol: "linkT3",  fullName: "Cycle linkage: Air Temp ← T3", unit: "—", group: "Cycle linkages",
    desc: "When ON, the sidebar Air Temp tracks the latest cycle T3. Auto-broken if the user varies Air Temp in Automation." },
  { symbol: "linkP3",  fullName: "Cycle linkage: Pressure ← P3", unit: "—", group: "Cycle linkages",
    desc: "When ON, the sidebar Pressure tracks the latest cycle P3. Auto-broken if the user varies Pressure in Automation." },
  { symbol: "linkFAR", fullName: "Cycle linkage: phi ← phi_Bulk", unit: "—", group: "Cycle linkages",
    desc: "When ON, the sidebar phi tracks the latest cycle phi_Bulk. Auto-broken if the user varies phi, FAR, or TFlame_CC in Automation." },
  { symbol: "linkOx",  fullName: "Cycle linkage: Oxidizer ← humid air @ ambient", unit: "—", group: "Cycle linkages",
    desc: "When ON, the sidebar Oxidizer composition tracks the cycle's computed humid-air mol % at ambient T/RH." },
  { symbol: "linkFuelFlow", fullName: "Cycle linkage: Fuel Flow ← cycle ṁ_fuel", unit: "—", group: "Cycle linkages",
    desc: "When ON (default in GTS / Advanced modes), the Exhaust panel's Fuel Flow input on the Fuel & Money card tracks the cycle's mdot_fuel_kg_s. In GTS mode the link is non-breakable; in Advanced mode the BREAK button drops to manual entry. Hidden in Free / Combustion Toolkit (no cycle running)." },
  { symbol: "linkExhaustCO", fullName: "Mapping linkage: Exhaust CO ← Mapping CO15 (corrected to actual O₂ via Phi_Exhaust)", unit: "—", group: "Cycle linkages",
    desc: "When ON (default in GTS / Advanced modes), the Exhaust panel's measured-CO input is computed from the Mapping correlation's CO15 (15% O₂ basis) using CO_actual = CO15 × (20.9 − O₂_dry%) / 5.9 at Phi_Exhaust. In GTS mode the link is non-breakable; in Advanced mode the BREAK button drops to manual entry. Hidden in Free / Combustion Toolkit (no Mapping panel)." },
  { symbol: "linkExhaustUHC", fullName: "Mapping linkage: Exhaust UHC ← Mapping CO15 (UHC = CO_linked / 3)", unit: "—", group: "Cycle linkages",
    desc: "When ON (default in GTS / Advanced modes), the Exhaust panel's measured-UHC input is set to CO_linked / 3, per LMS100 mapping convention. In GTS mode the link is non-breakable; in Advanced mode the BREAK button drops to manual entry. Hidden in Free / Combustion Toolkit (no Mapping panel)." },
  { symbol: "Phi_Exhaust", fullName: "Equivalence ratio computed from cycle's air & fuel mass flows", unit: "—", group: "Combustion efficiency & slip",
    desc: "Phi_Exhaust = (cycle.mdot_fuel_kg_s / cycle.mdot_air_post_bleed_kg_s) / FAR_stoich. Used by the CO/UHC Mapping linkages on the Exhaust panel to convert mapping CO15 (15% O₂ basis) to the actual-O₂ basis. Distinct from cycle.phi4 — uses the panel-side flows directly." },
  { symbol: "Fuel_Split", fullName: "Per-circuit fuel-flow share of total fuel", unit: "% of total", group: "Combustor model",
    desc: "Fuel_Split_circuit = m_fuel_circuit / m_fuel_total × 100 for each of IP / OP / IM / OM. Shown in the Operating Snapshot table as a 4th column alongside φ, TFlame, M_Fuel. Helps the operator see which DLE circuit carries what fraction of the load — useful for diagnosing pilot-heavy operation or stoichiometric drift." },

  // ── Combustion efficiency & slip ────────────────────────────────────
  { symbol: "η_c", fullName: "Combustion efficiency", unit: "%", group: "Combustion efficiency & slip",
    desc: "Fraction of fuel chemical energy that combusted at this operating point. Computed from measured CO + UHC + H₂ slip via the energy-loss formula η_c = 1 − N_dry/fuel · (X_CO·LHV_CO + X_UHC·LHV_CH4 + X_H2·LHV_H2) / LHV_fuel,molar. Reference: ASME PTC 4 §5.14 / Lefebvre & Ballal Ch. 9.4-9.6." },
  { symbol: "energy-loss formula", fullName: "η_c from emission energy loss", unit: "—", group: "Combustion efficiency & slip",
    desc: "Per ASME PTC 4 / Lefebvre Ch. 9: each unburned species in the dry exhaust carries a known molar LHV and represents heat that didn't reach the gas. Dividing the sum of these losses by the fuel's LHV gives 1 − η_c. Constants used: LHV_CO = 282.99 kJ/mol, LHV_CH4 = 802.31 kJ/mol, LHV_H2 = 241.83 kJ/mol (NIST, water-vapor reference)." },
  { symbol: "φ_burn", fullName: "Burn-side equivalence ratio (matches measured O₂/CO₂)", unit: "—", group: "Combustion efficiency & slip",
    desc: "The φ from the original Cantera HP-equilibrium inversion — i.e. the φ that produces the exact measured exhaust O₂ (or CO₂) under the assumption that all fuel burned. This is the φ at 100% efficiency. Used as the anchor for both the fed-side and eff-side corrections." },
  { symbol: "φ_fed", fullName: "Fed-side equivalence ratio (operator-metered)", unit: "—", group: "Combustion efficiency & slip",
    desc: "What the operator actually metered into the combustor. φ_fed = φ_burn / η_c. Larger than φ_burn whenever slip is present, because some metered fuel walked through unburned. This is the φ shown on the displayed Chemical Equilibrium card." },
  { symbol: "φ_eff", fullName: "Effective equivalence ratio (drives flame T)", unit: "—", group: "Combustion efficiency & slip",
    desc: "φ_eff = φ_burn × η_c. The equivalent leaner ratio at which the burning fraction released its energy after accounting for both the slip mass loss and the inefficiency penalty. Cantera HP equilibrium at φ_eff gives the displayed Flame Temperature, which falls as slip rises." },
  { symbol: "FAR_burn / FAR_fed / FAR_eff", fullName: "Three FAR variants — burn, fed, effective", unit: "—", group: "Combustion efficiency & slip",
    desc: "Same φ trio expressed in mass-basis FAR. FAR_burn = the inversion result; FAR_fed = FAR_burn / η_c (rises with slip); FAR_eff = FAR_burn × η_c (falls with slip)." },
  { symbol: "T_ad,burn / T_ad,eff", fullName: "Two flame T conventions in slip-corrected display", unit: "K / °F", group: "Combustion efficiency & slip",
    desc: "T_ad,burn = HP-equilibrium T at φ_burn (the inversion result, matches measured O₂/CO₂ exactly). T_ad,eff = HP-equilibrium T at φ_eff (= φ_burn × η_c) — falls as slip rises, captures the inefficiency penalty on flame temperature. The displayed Flame Temperature on the Chemical Equilibrium card is T_ad,eff." },

  // ── Operating-point cost & money ────────────────────────────────────
  { symbol: "Fuel Flow", fullName: "Fuel mass flow rate at this operating point", unit: "lb/hr or kg/hr (input) · kg/s (storage)", group: "Cost & money",
    desc: "Default 40,000 lb/hr (LMS100-class baseload). Stored internally as kg/s. Linked to cycle ṁ_fuel in GTS / Advanced modes; manually editable after BREAK." },
  { symbol: "Fuel Cost", fullName: "Fuel price ($/MMBTU LHV)", unit: "$/MMBTU LHV", group: "Cost & money",
    desc: "Default $4.00/MMBTU LHV — typical 2024-2026 industrial U.S. natural-gas benchmark (sources: EIA Industrial NG monthly, Henry Hub spot + transport adder). Adjust to the operator's actual contract." },
  { symbol: "Period", fullName: "Cost-rollup time period", unit: "—", group: "Cost & money",
    desc: "Toggle between Wk (168 h), Mo (730 h), or Yr (8760 h). Drives the time-multiplier on the Total Fuel Cost and Penalty rows." },
  { symbol: "Air Mass Flow", fullName: "Combustion air mass flow rate", unit: "lb/s or kg/s", group: "Cost & money",
    desc: "ṁ_air = ṁ_fuel / FAR_fed using the η_c-corrected fed-side FAR from the O₂-derived Chemical Equilibrium card. Reflects the mass of air the metered fuel encountered in the combustor." },
  { symbol: "Heat Input (LHV)", fullName: "Fuel-side heat input rate", unit: "MMBTU/hr or MW", group: "Cost & money",
    desc: "Q̇_in = ṁ_fuel · LHV_mass. The chemical energy entering the combustor per unit time, independent of combustion efficiency." },
  { symbol: "Total Fuel Cost / period", fullName: "Total fuel bill at this operating point", unit: "USD", group: "Cost & money",
    desc: "Total fuel spend over the chosen period: Heat_input_MMBTU/hr × $/MMBTU × hours/period. Independent of combustion efficiency — this is the full amount the operator pays for fuel." },
  { symbol: "Penalty / period", fullName: "Money walking out the stack as unburned slip", unit: "USD", group: "Cost & money",
    desc: "Penalty = Total Fuel Cost × (1 − η_c). The dollars equivalent of the chemical energy lost to CO + UHC + H₂ slip. The actionable number for justifying combustor tuning interventions. Verified against published industry benchmarks: GE, Solar Turbines, EPRI, Energy Institute UK." },
  { symbol: "PSR",     fullName: "Perfectly Stirred Reactor", unit: "—", group: "Combustor model",
    desc: "Idealized well-mixed primary zone with finite residence time τ_PSR. All inputs instantly mix to the PSR's volume-averaged state." },
  { symbol: "PFR",     fullName: "Plug Flow Reactor", unit: "—", group: "Combustor model",
    desc: "Adiabatic constant-pressure burnout zone downstream of the PSR. State varies along the axial coordinate; no back-mixing." },
  { symbol: "τ",       fullName: "Residence time / characteristic time", unit: "ms", group: "Combustor model",
    desc: "τ_PSR = primary-zone residence; τ_PFR = burnout-zone residence; τ_total = τ_PSR + τ_PFR; τ_chem = chemical time = (S_L²)/α; τ_flow = L_char / V_ref." },
  { symbol: "S_L",     fullName: "Laminar flame speed", unit: "cm/s", group: "Flame physics",
    desc: "Speed at which a laminar flame front propagates into the unburned mixture. Computed via Gülder or Metghalchi-Keck correlations in Free Mode; via Cantera FreeFlame in Accurate Mode." },
  { symbol: "Da",      fullName: "Damköhler number", unit: "—", group: "Flame physics",
    desc: "Da = τ_flow / τ_chem. Da > 1 → mixing-limited (stable); Da < 1 → reaction-limited (blowout risk)." },
  { symbol: "WI",      fullName: "Wobbe Index = HHV_vol / √SG", unit: "BTU/scf", group: "Fuel properties",
    desc: "Energy delivered per unit pressure drop across a fixed orifice. Two fuels with the same WI deliver the same heat input on the same hardware without retuning." },
  { symbol: "MWI",     fullName: "Modified Wobbe Index = LHV_vol / √(SG · T_fuel/520°R)", unit: "BTU/scf·√°R", group: "Fuel properties",
    desc: "GE-convention fuel-flexibility metric. Includes the Fuel Temp dependency (cold fuel → denser → more energy per scf at the same WI)." },
  { symbol: "LHV",     fullName: "Lower Heating Value (water vapor in products)", unit: "MJ/kg or BTU/lb", group: "Fuel properties",
    desc: "Heat released per unit fuel when product H₂O is in the vapor phase. The standard for gas turbines (which exhaust at T >> 100 °C)." },
  { symbol: "HHV",     fullName: "Higher Heating Value (water condensed)", unit: "MJ/kg or BTU/lb", group: "Fuel properties",
    desc: "LHV plus the heat of vaporisation of all water formed. Used for boiler ratings; for GTs always quote LHV." },
  { symbol: "SG",      fullName: "Specific gravity (relative to air)", unit: "—", group: "Fuel properties",
    desc: "MW_fuel / MW_air. Drives orifice flow and Wobbe Index." },
];

// Categorise an AUTO_VARS entry into a Nomenclature group.
function _nomenGroupForVar(v){
  if (v.group === "operating_point") return "Operating point";
  if (["T_air","T_fuel","P","WFR","water_mode"].includes(v.id)) return "Operating point";
  if (["P_amb","T_amb","RH","load_pct","T_cool","engine","emissionsMode","com_air_frac","bleed_open_pct","bleed_valve_size_pct"].includes(v.id)) return "Cycle (engine & ambient)";
  if (v.id.startsWith("map")) return "Combustor mapping (DLE 4-circuit)";
  if (["tau_psr","L_pfr","V_pfr","heatLossFrac"].includes(v.id)) return "Combustor PSR-PFR";
  if (["velocity","Lchar","Dfh","Lpremix","Vpremix"].includes(v.id)) return "Flame speed & blowoff";
  if (["measO2","measCO2","measCO","measUHC","measH2"].includes(v.id)) return "Exhaust analysis — measurements";
  if (["fuelFlowKgs","fuelCostUsdPerMmbtuLhv"].includes(v.id)) return "Exhaust analysis — fuel & money";
  if (v.kind === "fuel_species") return "Fuel composition";
  if (v.kind === "ox_species")   return "Oxidizer composition";
  return "Other inputs";
}

// Categorise an AUTO_OUTPUTS entry by panel.
function _nomenGroupForOutput(o){
  return ({
    cycle: "Cycle outputs (gas turbine)",
    mapping: "Combustor mapping outputs",
    aft: "Flame Temp & Properties outputs",
    exhaust: "Exhaust analysis outputs",
    combustor: "Combustor PSR-PFR outputs",
    flame: "Flame speed & blowoff outputs",
  })[o.panel] || "Other outputs";
}

function NomenclaturePanel(){
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();

  // Build the full searchable list once. AUTO_VARS and AUTO_OUTPUTS are
  // module-level constants so a single useMemo with [] deps is correct.
  const entries = useMemo(() => {
    const out = [];
    for (const v of AUTO_VARS){
      out.push({
        kind: "input",
        symbol: v.label,
        fullName: NOMENCLATURE_LONGNAMES[v.id] || v.label,
        unitSI: v.unit_si || "",
        unitEN: v.unit_en || v.unit_si || "",
        group: _nomenGroupForVar(v),
        panels: v.panels,
        desc: v.desc || "",
        searchKeys: [v.id, v.label, v.unit_si, v.unit_en, NOMENCLATURE_LONGNAMES[v.id] || "", v.desc || "", _nomenGroupForVar(v)].filter(Boolean).join(" ").toLowerCase(),
      });
    }
    for (const o of AUTO_OUTPUTS){
      const uSI = o.unit_si || o.unit || "";
      const uEN = o.unit_en || o.unit || uSI;
      out.push({
        kind: "output",
        symbol: o.label,
        fullName: NOMENCLATURE_LONGNAMES[o.id] || o.label,
        unitSI: uSI,
        unitEN: uEN,
        group: _nomenGroupForOutput(o),
        panels: [o.panel],
        desc: NOMENCLATURE_LONGNAMES[o.id] || o.label,
        searchKeys: [o.id, o.label, uSI, uEN, NOMENCLATURE_LONGNAMES[o.id] || "", o.panel, _nomenGroupForOutput(o)].filter(Boolean).join(" ").toLowerCase(),
      });
    }
    for (const x of NOMENCLATURE_EXTRA){
      out.push({
        kind: "concept",
        symbol: x.symbol,
        fullName: x.fullName,
        unitSI: x.unit || "",
        unitEN: x.unit || "",
        group: x.group,
        panels: [],
        desc: x.desc,
        searchKeys: [x.symbol, x.fullName, x.unit, x.desc, x.group].filter(Boolean).join(" ").toLowerCase(),
      });
    }
    return out;
  }, []);

  const filtered = useMemo(() => {
    if (!q) return entries;
    return entries.filter(e => e.searchKeys.includes(q));
  }, [entries, q]);

  // Group preserves insertion order — so groups appear in the order their
  // first member was added (vars → outputs → concepts).
  const grouped = useMemo(() => {
    const m = new Map();
    for (const e of filtered){
      if (!m.has(e.group)) m.set(e.group, []);
      m.get(e.group).push(e);
    }
    return [...m.entries()];
  }, [filtered]);

  const totalCount = entries.length;
  const matchCount = filtered.length;

  return (
    <div style={{display:"flex", flexDirection:"column", gap:12}}>
      <HelpBox title="📚 Nomenclature — every symbol used anywhere in this app">
        <p style={{margin:"0 0 6px"}}>
          A single index of every input variable, output, and convention. Search by short symbol
          (e.g. <code>NOx15</code>, <code>phi</code>, <code>Tad_CC</code>), by classical name
          (<code>Equivalence Ratio</code>, <code>Wobbe</code>), by unit, or by panel.
        </p>
        <p style={{margin:0, color:C.txtMuted}}>
          Showing <strong>{matchCount}</strong> of <strong>{totalCount}</strong> entries.
        </p>
      </HelpBox>

      <div style={{display:"flex", alignItems:"center", gap:10}}>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search symbols, names, units, descriptions, panels…"
          style={{
            flex:1, padding:"8px 12px", fontSize:13,
            background: C.bg, color: C.txt,
            border: `1px solid ${C.border}`, borderRadius: 6,
            fontFamily: "'Barlow', sans-serif", outline: "none",
          }}
        />
        {search && (
          <button onClick={() => setSearch("")}
            style={{padding:"6px 12px", fontSize:11, fontWeight:700,
              color: C.txtDim, background: "transparent",
              border: `1px solid ${C.border}`, borderRadius: 4, cursor: "pointer",
              fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: ".5px"}}>
            CLEAR
          </button>
        )}
      </div>

      {grouped.length === 0 && (
        <div style={{padding:14, color:C.txtMuted, fontSize:12, fontStyle:"italic",
          fontFamily:"monospace", textAlign:"center"}}>
          No entries match "{search}". Try a shorter or different keyword.
        </div>
      )}

      {grouped.map(([group, items]) => (
        <div key={group} style={{background:C.bg2, border:`1px solid ${C.border}`,
          borderRadius:8, padding:14}}>
          <div style={{fontSize:12, fontWeight:700, color:C.accent,
            letterSpacing:".6px", marginBottom:8,
            fontFamily:"'Barlow Condensed', sans-serif",
            textTransform:"uppercase"}}>
            {group} <span style={{color:C.txtMuted, fontWeight:400}}>· {items.length}</span>
          </div>
          <div style={{display:"grid",
            gridTemplateColumns:"170px 90px 1fr",
            gap:8, padding:"4px 6px",
            borderBottom:`1px solid ${C.border}`,
            fontSize:9, color:C.txtMuted, textTransform:"uppercase",
            letterSpacing:"1.2px", fontFamily:"monospace", fontWeight:700}}>
            <div>Symbol</div><div>Unit (SI / EN)</div><div>Definition</div>
          </div>
          {items.map((e, i) => (
            <div key={`${e.symbol}_${i}`} style={{display:"grid",
              gridTemplateColumns:"170px 90px 1fr",
              gap:8, padding:"6px 6px",
              borderBottom: i === items.length-1 ? "none" : `1px solid ${C.border}25`,
              fontSize:11, fontFamily:"'Barlow', sans-serif"}}>
              <div style={{fontFamily:"monospace", fontWeight:700,
                color: e.kind === "input" ? C.accent3 : e.kind === "output" ? C.accent2 : C.txtDim,
                wordBreak:"break-word"}}>
                {e.symbol}
                <div style={{fontSize:8.5, color:C.txtMuted, fontWeight:400,
                  textTransform:"uppercase", letterSpacing:".4px", marginTop:1}}>
                  {e.kind}
                </div>
              </div>
              <div style={{fontFamily:"monospace", color:C.txtMuted, fontSize:10}}>
                {e.unitSI === e.unitEN || !e.unitEN
                  ? (e.unitSI || "—")
                  : `${e.unitSI || "—"} / ${e.unitEN}`}
              </div>
              <div style={{color:C.txt, lineHeight:1.5}}>
                <div style={{color:C.txt, fontWeight:600}}>{e.fullName}</div>
                {e.desc && e.desc !== e.fullName && (
                  <div style={{color:C.txtMuted, fontSize:10.5, marginTop:2}}>{e.desc}</div>
                )}
                {e.panels && e.panels.length > 0 && (
                  <div style={{fontSize:9.5, color:C.txtDim, marginTop:3,
                    fontFamily:"monospace", letterSpacing:".3px"}}>
                    panels: {e.panels.join(", ")}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function AssumptionsPanel(){
  return(<div style={{display:"flex",flexDirection:"column",gap:12}}>
    <HelpBox title="ℹ️ How to read this page">
      <p style={{margin:"0 0 6px"}}>Every number below is baked into the cycle and combustion solvers. They are exposed here so you can audit them, map deviations, and know exactly what the app is and is not modeling.</p>
      <p style={{margin:"0 0 6px"}}><span style={hs.em}>In-spec for design-point anchors only.</span> LMS100PB+ off-design behavior is driven by a measured 100%-load deck table (P3, T3, T4, MW vs T_amb) anchored at the published design point. Additional engines are in development.</p>
      <p style={{margin:0}}><span style={hs.warn}>Not a design tool.</span> The cycle is a reduced-order anchored correlation, not a station-by-station match of the OEM deck. Use high-fidelity tools for design, permitting, or emissions reporting.</p>
    </HelpBox>

    <AssumptionsGroup title="1. Ambient & Inlet" subtitle="Ambient state feeding the LP compressor inlet. No ram recovery, no inlet loss.">
      <Assumption label="Reference pressure" value="1.01325 bar" note="Sea-level ISA. Cycle input P_amb overrides for off-design."/>
      <Assumption label="Reference temperature" value="LMS100 anchored at 44 °F / 80% RH" note="288.706 K (60 °F) is also used internally as the ISO reference. Additional engines are in development."/>
      <Assumption label="Relative humidity" value="User input 0–100%" note="Default 60%. Enters via humid-air R and cp."/>
      <Assumption label="Inlet pressure drop" value="0 bar" note="No filter / silencer loss modeled. T1/P1 ≡ ambient."/>
      <Assumption label="Inlet ram recovery" value="1.0" note="Stationary (aero-derivative on ground). No Mach effect."/>
    </AssumptionsGroup>

    <AssumptionsGroup title="2. Humid Air Composition" subtitle="Humid-air composition uses psychrometric H2O mole fraction; dry-air N2/O2/Ar ratios are fixed at the balance.">
      <Assumption label="Dry-air mole fractions" value="N2 0.78084 / O2 0.20946 / Ar 0.00934" note="Standard atmospheric composition. CO2 + trace lumped into N2."/>
      <Assumption label="H2O saturation" value="Antoine / Magnus" note="Humid-air x_H2O from RH and T_amb via Antoine P_sat."/>
      <Assumption label="Mixture thermodynamics" value="Cantera GRI-Mech 3.0" note="Enthalpies, entropies, cp, R from the same mechanism as combustion."/>
    </AssumptionsGroup>

    <AssumptionsGroup title="3. Compressor" subtitle="Compressors are modeled with a single isentropic efficiency and mechanical efficiency = 1. HPC and LPC use the same efficiency for the LMS100 three-spool.">
      <Assumption label="Isentropic efficiency (both engines)" value="0.88" note="Applied to LPC and HPC separately. h_out = h_in + (h_out,s − h_in)/η_isen."/>
      <Assumption label="Working fluid" value="Humid air" note="Real Cantera enthalpy difference — no dry-air ideal-gas shortcut."/>
      <Assumption label="Bleed air" value="0%" note="No customer bleed / cooling-air extraction modeled."/>
      <Assumption label="Mechanical efficiency" value="1.00" note="Shaft friction and gearbox losses ignored (folded into the overall cap)."/>
    </AssumptionsGroup>

    <AssumptionsGroup title="4. Intercooler (LMS100 only)" subtitle="The LMS100's water-to-air intercooler sits between the LPC and HPC. Modeled as a fixed outlet temperature equal to the coolant supply.">
      <Assumption label="Outlet T" value="T_coolant_in + 0 K" note="Infinite-surface limit. T_IC_out = T_cool_in (user input, default 288.15 K)."/>
      <Assumption label="Pressure drop" value="0 bar" note="Not modeled. P_IC_out = P_LPC_out."/>
      <Assumption label="Heat rejected" value="Q_IC = mdot · (h_LPC_out − h_IC_out)" note="Reported as diagnostic, not used in MW calculation."/>
    </AssumptionsGroup>

    <AssumptionsGroup title="5. Combustor" subtitle="Two states — flame zone (bulk) and combustor exit (station 4). The flame zone sees only the primary air; dilution air is added after to meet T4.">
      <Assumption label="Combustor pressure drop" value="4%" note="P4 = 0.96 · P3. Fixed. Typical DLE range is 3–5%."/>
      <Assumption label="Combustor bypass fraction" value="LMS100: 0.747" note="Fraction of compressor discharge routed to the combustor core. Remainder is casing/HPT cooling. Private per-engine calibration so design-point MW and η land exactly."/>
      <Assumption label="Combustor air fraction (flame/total)" value="0.88 (both)" note="Flame zone gets 88% of combustor air; dilution zone gets 12%. FAR_Bulk = FAR4 / 0.88."/>
      <Assumption label="T4 target" value="LMS100: 1800 K (2780 °F) at 100% load" note="Firing temperature. Commanded by the deck, not solved. The LMS100 anchor was lowered from 1825 K to 1800 K (2826 °F → 2780 °F) for the PB+ uprate. Now driven by the user-supplied 100%-load deck table at every ambient point."/>
      <Assumption label="φ4 solve" value="Cantera equilibrate(&quot;HP&quot;)" note="Back-solved so equilibrium product T at (T3, P3) equals T4. No kinetics — equilibrium only."/>
      <Assumption label="T_Bulk (flame zone)" value="Cantera equilibrate(&quot;HP&quot;) at (T3, P3, φ_Bulk)" note="Adiabatic equilibrium. Drives downstream flame-speed / blowoff / autoignition panels when linked."/>
      <Assumption label="Heat loss" value="0%" note="Adiabatic combustor. The AFT panel has a separate heat-loss option for hand analysis."/>
    </AssumptionsGroup>

    <AssumptionsGroup title="6. Turbine" subtitle="Turbine work comes from an actual Cantera isentropic expansion — not a prescribed η_thermal. This is the core of Option A (energy-balance cycle).">
      <Assumption label="Isentropic efficiency η_isen,turb" value="LMS100: 0.7805" note="Calibrated so MW_gross lands at MW_cap at the 44 °F design anchor (109.2 MW under the user-supplied deck table)."/>
      <Assumption label="Expansion path" value="gas.SP = s_in, P_exhaust; h_out = h_in − η·(h_in−h_out,s)" note="Equilibrium products; full Cantera enthalpy at outlet."/>
      <Assumption label="Exhaust pressure" value="1.05 bar" note="Stack + HRSG backpressure. Fixed — not a function of ambient."/>
      <Assumption label="Cooling air" value="Accounted in bypass fraction" note="No re-injection mixing — modeled as energy not delivered to the turbine."/>
    </AssumptionsGroup>

    <AssumptionsGroup title="7. Power & Load" subtitle="Gross shaft power = turbine − compressor − parasitic. Net electrical = gross · fuel-flexibility derate, capped by the load-and-ambient line.">
      <Assumption label="Parasitic load" value="1.5% of rated MW" note="Lube pumps, controls, cooling fans. Subtracted from W_turbine − W_compressor."/>
      <Assumption label="MW_gross formula" value="W_turbine − W_compressor − W_parasitic" note="Pure energy balance from Cantera enthalpies, mdot_air set by T4 back-solve."/>
      <Assumption label="MW_cap" value="rated_MW · ambient_factor · load_factor" note="Density-lapse & intercooler-benefit ambient factor, times load_pct/100."/>
      <Assumption label="MW_net" value="MW_cap · (1 − derate_pct/100)" note="Uses the OEM-anchored deck cap (rated_MW · ambient_factor · load_factor) as the published power. MW_gross is reported separately for diagnostic comparison only — the simplified Brayton calc holds T4 constant and doesn't model variable IGVs / bleed scheduling, so it under-predicts off-design power by a few MW."/>
    </AssumptionsGroup>

    <AssumptionsGroup title="8. Fuel Properties (Option B)" subtitle="Per-component LHV on a volume basis (BTU/scf at 60 °F, 1 atm) and specific gravity relative to air. Used to compute LHV_mix and SG_mix linearly.">
      <Assumption label="Reference condition" value="60 °F / 1 atm" note="US gas-industry reference. T_fuel input re-maps via absolute T for MWI."/>
      <Assumption label="Mixing rule" value="Linear in mole fractions" note="LHV_vol_mix = Σ xᵢ · LHV_vol,i. SG_mix = Σ xᵢ · SG,i. Good for most NG-range mixes."/>
      <Assumption label="Components tabulated" value="CH4, C2H6, C3H8, C4H10, C5H12, C6H14, C7H16, C8H18, C2H4, C2H2, H2, CO, N2, CO2, H2O, Ar" note="Inert diluents dilute LHV_vol and lift SG — drops MWI."/>
      <Assumption label="Reference LHV values" value="CH4 909.4, C2H6 1618.7, C3H8 2314.9, H2 273.8 BTU/scf" note="Standard gas-industry tabulated values (Cantera/GPA SP 2172)."/>
    </AssumptionsGroup>

    <AssumptionsGroup title="9. Fuel Flexibility — MWI Derate (Option B)" subtitle="Modified Wobbe Index uses the absolute fuel temperature in the denominator. Derate reflects GE DLE combustor limits.">
      <Assumption label="Definition" value="MWI = LHV_vol / √(SG · T_fuel_°R)" note="LHV_vol in BTU/scf; T_fuel in absolute Rankine. Higher MWI → higher volumetric energy density."/>
      <Assumption label="In-spec band" value="40 ≤ MWI ≤ 54" note="Nominal GE DLE range. No derate applied. Default pure-CH4 at 60 °F gives MWI ≈ 53.6."/>
      <Assumption label="Marginal band" value="35–40 or 54–60" note="Derate 5%. Hardware will run but combustor may need tuning / liner life may be affected."/>
      <Assumption label="Out-of-spec" value="MWI &lt; 35 or &gt; 60" note="Derate 20%. Typical of very dilute or very heavy fuels."/>
      <Assumption label="H2 warning" value="x_H2 &gt; 30%" note="Flashback risk in DLE premixer — emitted as a warning regardless of MWI."/>
      <Assumption label="Low LHV warning" value="LHV_vol &lt; 800 BTU/scf" note="Dilute fuel; fuel flow roughly doubles. Emitted as a warning."/>
      <Assumption label="Derate application" value="MW_net = MW_cap · (1 − derate_pct/100)" note="Applied directly to the deck-anchored cap. Derate stacks with part-load and ambient droop (which both already live inside MW_cap)."/>
    </AssumptionsGroup>

    <AssumptionsGroup title="10. Engine Deck Anchors" subtitle="Design-point numbers each off-design scaling law is anchored at. These must match the published deck exactly.">
      <Assumption label="LMS100PB+" value="109.2 MW @ 44 °F / 80% RH" note="T3 644 K · P3 44.4 bar · T4 1800 K (2780 °F) · η_LHV 44.9% · HR 8016 kJ/kWh · with intercooler. Now driven by the user-supplied 100%-load deck table (P3, T3, T4, MW vs T_amb). Additional engines are in development."/>
      <Assumption label="Anchor method" value="Calibrate combustor_bypass_frac + eta_isen_turb" note="Two per-engine knobs fit both MW and η at anchor. Everything else is physical."/>
    </AssumptionsGroup>

    <AssumptionsGroup title="11. Off-design Scaling" subtitle="How the deck behaves away from its anchor. Not all of this is modeled — the list below states what IS.">
      <Assumption label="Density lapse" value="mdot_air ∝ ρ_amb · VGV(T_amb)" note="VGV is a simple function of ambient — folded into an engine-specific lapse curve."/>
      <Assumption label="LMS100 intercooler benefit" value="Architectural" note="LMS100 loses less on hot days than non-intercooled engines because HPC inlet is fixed at T_cool_in. Verified in regression tests."/>
      <Assumption label="Load line" value="Linear in rated" note="MW_net = load_pct · MW_rated_ambient · derate. Part-load T4 droops so MW_gross is super-linear at low load (diagnostic only — does not affect MW_net)."/>
      <Assumption label="Humidity" value="Via humid-air R only" note="Higher RH → lower molecular weight → more volumetric mdot at fixed corrected flow."/>
      <Assumption label="Altitude" value="Not modeled" note="Use P_amb input if needed; scales density directly."/>
      <Assumption label="Inlet cooling" value="Not modeled" note="No evap / chiller hook. Simulate manually by dropping T_amb."/>
    </AssumptionsGroup>

    <AssumptionsGroup title="12. Solver & Numerics" subtitle="What the backend solver is doing and where convergence is enforced.">
      <Assumption label="Mechanism" value="GRI-Mech 3.0 (default)" note="53 species, 325 reactions. Alternate mechanisms available on combustor panel only."/>
      <Assumption label="Combustion equilibrium" value="Cantera equilibrate(&quot;HP&quot;)" note="Element-potential solver. Constant enthalpy & pressure. Used for T_Bulk and T4 back-solve."/>
      <Assumption label="Turbine expansion" value="Cantera gas.SP = s, P" note="Isentropic outlet state, then non-isentropic correction via η_isen."/>
      <Assumption label="Compressor work" value="Cantera enthalpy difference" note="Humid-air composition with water vapor → real-gas properties."/>
      <Assumption label="Thread model" value="Single-thread Cantera pool" note="All Cantera calls serialized server-side. Per-request timeout 180 s (540 s for sweeps)."/>
      <Assumption label="Units" value="SI internally" note="K, Pa, m, kg/s, W. UI converts to ENG (°F, psia, BTU/kWh) on display."/>
    </AssumptionsGroup>

    <AssumptionsGroup title="13. Compressor Bleed" subtitle="Optional compressor air dump used to hold combustor T4 at part-load. Active only on the LMS100 deck.">
      <Assumption label="Modes" value="AUTO  /  MANUAL" note="AUTO: bleed_open % is a continuous function of load — 100% open below 75% load, 0% above 95%, linear between. MANUAL: user sets the open % directly."/>
      <Assumption label="Valve size (max bleed)" value="User input, 0–100% of W3" note="Sets the upper bound on bleed_air_frac at 100% open. bleed_air_frac = (open_pct/100) × (valve_size_pct/100)."/>
      <Assumption label="Bleed destination" value="Dumped to ambient" note="No re-injection or HRSG mix; the air leaves the cycle. mdot_air_post_bleed = W3 × (1 − bleed_air_frac)."/>
      <Assumption label="Convergence (T4 hold)" value="Iterative on bleed_air_frac" note="When bleed is active and T4 is the target, the cycle iterates bleed_air_frac to keep T4 at the deck commanded value. Reports bleed_iters and bleed_converged in the result."/>
    </AssumptionsGroup>

    <AssumptionsGroup title="14. Water Injection (NOx control)" subtitle="3-stream enthalpy balance: air + fuel + water → mixed inlet. Used by every combustor panel and the cycle.">
      <Assumption label="Inputs" value="WFR (kg_water / kg_fuel) + mode" note="WFR = 0 disables water entirely. Mode = liquid (absorbs h_fg) or steam (gas phase at T_air)."/>
      <Assumption label="Mixed inlet T" value="3-stream enthalpy balance" note="T_mixed solved so h_air(T_air) + WFR·h_water(T_water,mode) + (1/AFR)·h_fuel(T_fuel) = total mixed h at T_mixed."/>
      <Assumption label="Liquid water" value="Absorbs latent + sensible" note="h_fg at 100 °C = 2.257 MJ/kg. Plus cp_liq·(T_evap − T_water_in) and cp_vap·(T_mixed − T_evap)."/>
      <Assumption label="Steam water" value="Gas phase, no h_fg debit" note="Treated as superheated steam at T_air, joining the inlet stream as pure H2O."/>
      <Assumption label="Cycle effect" value="Water mass passes through turbine" note="Adds turbine mdot, increases W_turb. T4 floats — power ↑, η ↓ (extra energy spent vaporizing). Reported in cycle outputs."/>
    </AssumptionsGroup>

    <AssumptionsGroup title="15. Combustor Mapping (LMS100 4-circuit DLE — correlation)" subtitle="Per-circuit T_AFT from a complete-combustion solve, then linear-anchored emissions / dynamics. No reactor kinetics. Drives the Combustor Mapping panel and the Operations Summary.">
      <Assumption label="Reference design point" value="LMS100 DLE, 100% load, 44 °F" note="NOx15=45 ppmvd · CO15=130 ppmvd · PX36_SEL=4.3 psi · PX36_SEL_HI=2.2 psi. DT_Main=450 °F · Phi_OP=0.65 · C3=7.5% · N2=0.5% · Tflame=3035 °F · T3=700 °F · P3=638 psia."/>
      <Assumption label="Per-circuit T_AFT" value="complete_combustion at (T3, P3, φ_circuit)" note="Cantera complete-combustion (no dissociation) at the circuit-specific φ. Falls back to T_air when φ ≈ 0."/>
      <Assumption label="OM circuit" value="Residual fuel mass" note="m_fuel_OM = m_fuel_total − (m_fuel_IP + m_fuel_OP + m_fuel_IM). φ_OM is back-solved and clamped to [0, 3]."/>
      <Assumption label="Linear correction (Step 1)" value="Y_lin = Y_ref + Σₖ (∂Y/∂xₖ)·(xₖ − xₖ_ref)" note="Variables: DT_Main, N2, C3-eff, Phi_OP, Phi_IP (above 0.25 floor), Tflame, T3. Per-output derivatives baked into the module — see combustor_mapping.py."/>
      <Assumption label="Phi_OP multiplier (Step 2)" value="HI only: 1.0 ≥ φ ≥ 0.55, 0.8 ≤ 0.45" note="Linear interp on the 0.10 band between. PX36_SEL_HI is the only output that gets this multiplier."/>
      <Assumption label="P3 scaling (Step 3)" value="(P3/638)^exp" note="Exponents: NOx15=0.467, CO15=−1.0, PX36_SEL=1.35, PX36_SEL_HI=0.44. Anchored at the design P3 = 638 psia."/>
      <Assumption label="C3-effective" value="0.8·(C2H6+C2H4+C2H2) + (C3H8+C4H10+...+C8H18)" note="C2-class species at 0.8 coefficient; C3 and every heavier hydrocarbon at 1.0."/>
      <Assumption label="Tflame derivative (NOx only)" value="Piecewise: 0.12 ppm/°F ≥2850, 0.04 between 2750–2850, 0 below 2750" note="Integrated continuously from T_ref = 3035 °F so the contribution has no jumps at breakpoints."/>
      <Assumption label="Emissions Transfer Function" value="Per-BRNDMD post-multipliers on NOx, CO, PX36" note="User-trim knob, default 1.0 for all. PX36_SEL_HI does NOT take this multiplier (its tuning is in Step 2). Stored per BRNDMD ∈ {2,4,6,7}."/>
      <Assumption label="Air flow split" value="W36 = W3 · (W36/W3); flame air = W36 · com.Air Frac; effusion / cooling = W36 · (1 − com.Air Frac)" note="W36 enters the dome and is split across the four fuel circuits. The remainder is effusion / cooling air. Outer Main is the float circuit: m_fuel_OM = total − IP − OP − IM, and φ_OM is back-solved."/>
    </AssumptionsGroup>

    <AssumptionsGroup title="16. Live Mapping (HMI sim — visual only, no engineering data)" subtitle="Real-time trace dashboard. Numbers are derived from the mapping correlation above plus a stochastic instrument-response model. Behavior is intentional and not under operator control.">
      <Assumption label="Tick rate" value="2 Hz" note="Two samples per second across every metric. Buffer holds 10 minutes (1200 samples) and shifts oldest out. The acoustic metrics (PX36_SEL, PX36_SEL_HI) need this resolution for transient spikes; slow metrics (NOx, CO, MWI_GC, MW) are dead-time / lag-dominated and just carry extra interpolation points."/>
      <Assumption label="Instrument response" value="History-based transport delay + 1st-order smoothstep" note="displayed(t) = lookup(history, t − deadT) blended via smoothstep over transT. Per-metric deadT/transT: PX36 0/1, NOx/CO 83/7, MWI_WIM 2/5, MWI_GC 415/5, MW 0/7."/>
      <Assumption label="Noise model" value="Per-metric, mean-band dependent" note="PX36: random step every 1–2 s, amplitude scales with mean (1.5–3.4% low, 7–9% high). NOx/CO: 20-second sine, amplitude re-rolled at each cycle. MWI: 2.5% white + slow 2-min sine."/>
      <Assumption label="PX36 trip threshold" value="px36 (display) > 5.5 psi" note="Triggers the protection cycle: BD4 for 50 s → BD6 for 30 s → BD7. Up to 3 cycles before LOCK at BD4."/>
      <Assumption label="Stochastic engine trips" value="phi_IP / phi_OP excursions" note="At BR=7, phi_IP entry into a load-interpolated band rolls a random threshold; crossing it trips the engine. Same logic for phi_OP at BR=6 or 7. After trip, all targets ramp to 0 with metric-specific delays; banner shows a 4-hour lockout countdown."/>
      <Assumption label="Emissions Mode staging" value="BD4 → 50 s → BD6 → 30 s → BD7 (or stop at BD6)" note="Triggered when Emissions Mode toggles ON during mapping. Endpoint adapts to current MW: low load skips, mid load (BR_max=6) stops at BD6, high load runs the full sequence."/>
    </AssumptionsGroup>
  </div>);
}

/* ══════════════════ CYCLE PANEL (Gas Turbine) ══════════════════
   Takes ambient conditions + load + engine deck; runs the backend /calc/cycle
   solver (anchored aero-derivative correlation + Cantera equilibrate('HP') phi
   back-solve). Headline output is MW_net. Three linkage toggles push cycle
   outputs into the other panels' operating conditions:
      • linkT3  → sidebar Air Temperature = T3
      • linkP3  → sidebar Pressure        = P3
      • linkFAR → sidebar phi (and FAR)   = cycle-computed phi at target T4
*/
function CyclePanel({linkT3,setLinkT3,linkP3,setLinkP3,linkFAR,setLinkFAR,linkOx,setLinkOx,result,loading,err,mode}){
  const units=useContext(UnitCtx);
  const {accurate,available}=useContext(AccurateCtx);
  const fmtT=K=>uv(units,"T",K).toFixed(1)+" "+uu(units,"T");
  const fmtP=bar=>{
    // Internal unit is bar (cycle outputs bar). Display uses the main unit
    // system, which has atm in SI and psia in ENG — convert accordingly.
    if(units==="SI")return (bar/1.01325).toFixed(3)+" atm";
    return (bar*14.5038).toFixed(1)+" psia";
  };
  const fmtMdot=k=>{
    if(units==="SI")return k.toFixed(2)+" kg/s";
    return (k*2.20462).toFixed(1)+" lb/s";
  };
  const fmtMdotHr=k=>{
    if(units==="SI")return (k*3600).toFixed(0)+" kg/hr";
    return (k*2.20462*3600).toFixed(0)+" lb/hr";
  };

  return(<div style={{display:"flex",flexDirection:"column",gap:12}}>
    <InlineBusyBanner loading={accurate&&loading}/>
    <HelpBox title="ℹ️ Gas Turbine Cycle — How It Works">
      <p style={{margin:"0 0 6px"}}>This panel computes the full thermodynamic cycle of the <span style={hs.em}>LMS100PB+ DLE IC</span> aero-derivative gas turbine at the ambient and load you set. Additional engines are in development.</p>
      <p style={{margin:"0 0 6px"}}><span style={hs.em}>You change:</span> engine, ambient pressure, ambient temperature, relative humidity, load %, intercooler coolant T (LMS100), combustor air fraction, fuel composition, water injection, and compressor bleed.</p>
      <p style={{margin:"0 0 6px"}}><span style={hs.em}>You get:</span> station states (T1 / T2 / T3 / T4 / T5 and P1 / P2 / P3 / P_exhaust), all mass flows, gross and net power, heat rate, efficiency, fuel-flexibility derate, and the flame-zone bulk values (T_Bulk, φ_Bulk, FAR_Bulk).</p>
      <p style={{margin:"0 0 6px"}}><span style={hs.em}>Linkages.</span> Four toggles pipe T3, P3, φ_Bulk, and the humid-air oxidizer back into the sidebar so every other panel runs at the engine's actual flame-zone state. Each toggle has a <strong>Break link</strong> button if you need manual control.</p>
      <p style={{margin:0,fontSize:11,color:C.txtMuted}}>Engine-deck anchors, calibration, and off-design scaling are documented in the <strong>Assumptions</strong> tab.</p>
    </HelpBox>

    {/* Inputs — Engine & Ambient inputs are now in the global sidebar (top of page).
        This panel only owns the cycle-specific Linkages card. */}
    <div>
      {/* Linkages */}
      <div style={S.card}>
        <div style={S.cardT}>Linkages to Other Panels</div>
        <div style={{fontSize:10.5,color:C.txtMuted,marginBottom:10,lineHeight:1.45,fontFamily:"'Barlow',sans-serif"}}>
          When a linkage is ON, the cycle output drives that sidebar field so <strong style={{color:C.accent}}>every other panel (AFT, Flame Speed, Combustor, Exhaust, Autoignition)</strong> runs at the engine's actual state. Break link to regain manual control.
        </div>
        {(() => {
          // Toggles are user-controlled ONLY in Advanced Mode. In Gas
          // Turbine Simulator the linkages are forced ON (engine mode is
          // always linked by spec); the buttons render but are disabled
          // and labeled LOCKED so the user can see the wiring.
          const canToggle = (mode === "advanced");
          return [
            {on:linkT3,set:setLinkT3,label:"Air Temp → T3",tip:"Sidebar Air Temp (K) ← cycle T3 (combustor inlet / HPC exit)"},
            {on:linkP3,set:setLinkP3,label:"Pressure → P3",tip:"Sidebar Pressure ← cycle P3 (combustor inlet pressure)"},
            {on:linkFAR,set:setLinkFAR,label:"φ → cycle φ_Bulk (flame zone)",tip:"Sidebar φ ← cycle's flame-zone φ_Bulk = φ₄ / combustor_air_frac. This is the equivalence ratio actually seen by the primary flame (richer than the diluted combustor exit φ₄). Drives T_ad on Flame Temp and the PSR-PFR / Flame Speed / Blowoff / Exhaust panels, which all model the flame — not the diluted exit."},
            {on:linkOx,set:setLinkOx,label:"Oxidizer comp → humid air @ ambient",tip:"Sidebar Oxidizer composition ← cycle's computed humid-air mol % at ambient T/RH. Required for T_ad on Flame Temp to match T4 on this panel (they use the same mechanism and same air)."},
          ].map(l=>(
            <div key={l.label} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 10px",border:`1px solid ${l.on?C.accent:C.border}`,borderRadius:6,marginBottom:6,background:l.on?`${C.accent}10`:"transparent"}}>
              <div style={{fontSize:11,color:C.txt,fontFamily:"monospace"}} title={l.tip}>
                <span style={{marginRight:6,opacity:l.on?1:.3}}>🔗</span>{l.label}
              </div>
              <button onClick={canToggle?(()=>l.set(!l.on)):undefined}
                disabled={!canToggle}
                title={canToggle?undefined:"Engine mode (Gas Turbine Simulator) keeps cycle linkages always ON. Switch to Advanced Mode to break individual links."}
                style={{padding:"3px 10px",fontSize:10,fontWeight:700,
                  color:!canToggle?C.txtMuted:(l.on?C.bg:C.accent),
                  background:!canToggle?"transparent":(l.on?C.accent:"transparent"),
                  border:`1px solid ${!canToggle?C.border:C.accent}`,
                  borderRadius:4,
                  cursor:canToggle?"pointer":"not-allowed",
                  fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".5px"}}>
                {!canToggle ? "LOCKED" : (l.on ? "LINKED" : "BREAK · OFF")}
              </button>
            </div>
          ));
        })()}
        {!available&&<div style={{marginTop:10,padding:"8px 10px",background:`${C.warm}12`,border:`1px solid ${C.warm}35`,borderRadius:5,fontSize:10.5,color:C.txt,lineHeight:1.4}}>Cycle linkages need an active subscription to run the Cantera backend. The <strong style={{color:C.warm}}>Gas Turbine Simulator</strong> or <strong style={{color:C.warm}}>Advanced Mode</strong> tier enables the cycle solver.</div>}
        {available&&!accurate&&<div style={{marginTop:10,padding:"8px 10px",background:`${C.accent2}12`,border:`1px solid ${C.accent2}35`,borderRadius:5,fontSize:10.5,color:C.txt,lineHeight:1.4}}>Switch to <strong style={{color:C.accent2}}>Gas Turbine Simulator</strong> or <strong style={{color:C.accent2}}>Advanced Mode</strong> via the MODE picker in the header to run the cycle solver and activate linkages.</div>}
      </div>
    </div>

    {/* Headline — MW_net */}
    <div style={{...S.card,padding:"18px 22px",background:`linear-gradient(135deg,${C.accent}10,${C.bg2})`,borderColor:`${C.accent}40`}}>
      {err&&<div style={{padding:10,color:C.accent2,fontSize:11,fontFamily:"monospace"}}>Error: {err}</div>}
      {!err&&<div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:16}}>
        <div>
          <div style={{fontSize:10,fontWeight:700,color:C.txtDim,textTransform:"uppercase",letterSpacing:"2px",marginBottom:4}}>Net Shaft Power</div>
          <div style={{fontSize:48,fontWeight:800,color:C.accent,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"-1px",lineHeight:1}}>
            {loading?"—":result?result.MW_net.toFixed(1):"—"}
            <span style={{fontSize:22,fontWeight:500,color:C.txtDim,marginLeft:6}}>MW</span>
          </div>
          {result&&<div style={{fontSize:10.5,color:C.txtMuted,marginTop:3,fontFamily:"monospace"}}>
            {result.load_pct.toFixed(0)}% load · max-on-day {result.MW_max_ambient.toFixed(1)} MW
          </div>}
        </div>
        {result&&<div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
          <Kpi label="T4 (firing)" value={fmtT(result.T4_K)}/>
          <Kpi label="T_Bulk (flame)" value={fmtT(result.T_Bulk_K!=null?result.T_Bulk_K:result.T4_K)}/>
          <Kpi label="T3 (comb. in)" value={fmtT(result.T3_K)}/>
          <Kpi label="P3" value={fmtP(result.P3_bar)}/>
          <Kpi label="φ₄ / φ_Bulk" value={`${(result.phi4!=null?result.phi4:result.phi).toFixed(3)} / ${(result.phi_Bulk!=null?result.phi_Bulk:result.phi).toFixed(3)}`}/>
        </div>}
      </div>}
    </div>

    {/* Stations + flows */}
    {result&&<div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:12}}>
      <div style={S.card}>
        <div style={S.cardT}>Stations</div>
        <table style={{width:"100%",borderCollapse:"collapse",fontFamily:"monospace",fontSize:11.5}}>
          <thead>
            <tr>{["Station","Description","T","P"].map(h=><th key={h} style={{textAlign:"left",padding:"6px 8px",borderBottom:`1px solid ${C.border}`,color:C.txtDim,fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:"1px"}}>{h}</th>)}</tr>
          </thead>
          <tbody>
            <StationRow n="1"   desc="Inlet (ambient)"                   T={result.T1_K}   P={result.P1_bar}  fmtT={fmtT} fmtP={fmtP}/>
            {result.intercooled&&<StationRow n="2"   desc="LPC exit"                            T={result.T2_K}   P={result.P2_bar}  fmtT={fmtT} fmtP={fmtP}/>}
            {result.intercooled&&<StationRow n="2.5" desc="Intercooler exit / HPC inlet"        T={result.T2_5_K} P={result.P2_5_bar} fmtT={fmtT} fmtP={fmtP}/>}
            {!result.intercooled&&<StationRow n="2"  desc="Compressor exit (= combustor inlet)" T={result.T2_K}   P={result.P2_bar}  fmtT={fmtT} fmtP={fmtP}/>}
            <StationRow n="3"   desc="Combustor inlet (HPC exit)"        T={result.T3_K}   P={result.P3_bar}  fmtT={fmtT} fmtP={fmtP} hi/>
            <StationRow n="4"   desc="Turbine inlet (firing temp)"       T={result.T4_K}   P={result.P3_bar}  fmtT={fmtT} fmtP={fmtP} hi/>
          </tbody>
        </table>
      </div>

      <div style={S.card}>
        <div style={S.cardT}>Flows & Performance</div>
        <div style={{display:"flex",flexDirection:"column",gap:6,fontFamily:"monospace",fontSize:11.5}}>
          <KV k="Air flow (compressor)"   v={fmtMdot(result.mdot_air_kg_s)}/>
          {(result.bleed_air_frac||0)>0&&<KV k="└─ Bleed (lost to ambient)" v={`${fmtMdot(result.mdot_bleed_kg_s||0)}  (${((result.bleed_air_frac||0)*100).toFixed(2)} %)`}/>}
          {(result.bleed_air_frac||0)>0&&<KV k="└─ Combustor air (post-bleed)" v={fmtMdot(result.mdot_air_post_bleed_kg_s||result.mdot_air_kg_s)}/>}
          <KV k="Fuel flow"               v={fmtMdot(result.mdot_fuel_kg_s)}/>
          <KV k="Fuel flow (hourly)"      v={fmtMdotHr(result.mdot_fuel_kg_s)}/>
          <div style={{marginTop:4,fontSize:9.5,color:C.txtMuted,textTransform:"uppercase",letterSpacing:"1px",fontWeight:700}}>Combustor exit (after dilution)</div>
          <KV k="T₄ (firing)"             v={fmtT(result.T4_K)}/>
          <KV k="FAR₄"                    v={(result.FAR4!=null?result.FAR4:result.FAR_flame||result.FAR).toFixed(5)}/>
          <KV k="φ₄"                      v={(result.phi4!=null?result.phi4:result.phi).toFixed(4)}/>
          <div style={{marginTop:4,fontSize:9.5,color:C.txtMuted,textTransform:"uppercase",letterSpacing:"1px",fontWeight:700}}>Flame zone (bulk)</div>
          <KV k="T_Bulk (flame)"          v={fmtT(result.T_Bulk_K!=null?result.T_Bulk_K:result.T4_K)}/>
          <KV k="FAR_Bulk"                v={(result.FAR_Bulk!=null?result.FAR_Bulk:(result.FAR4||0)).toFixed(5)}/>
          <KV k="φ_Bulk"                  v={(result.phi_Bulk!=null?result.phi_Bulk:(result.phi4||result.phi||0)).toFixed(4)}/>
          <KV k="Air frac (flame/dil.)"   v={((result.combustor_air_frac||1)*100).toFixed(1)+" %"}/>
          <div style={{marginTop:4,fontSize:9.5,color:C.txtMuted,textTransform:"uppercase",letterSpacing:"1px",fontWeight:700}}>Performance</div>
          <KV k="Efficiency (LHV)"        v={(result.efficiency_LHV*100).toFixed(2)+" %"}/>
          <KV k="Heat rate"               v={result.heat_rate_kJ_per_kWh.toFixed(0)+" kJ/kWh"}/>
          <KV k="LHV (fuel)"              v={result.LHV_fuel_MJ_per_kg.toFixed(2)+" MJ/kg"}/>
          <KV k="ρ_ambient"               v={result.rho_amb_kg_m3.toFixed(3)+" kg/m³"}/>
          {result.intercooled&&<KV k="Intercooler duty" v={result.intercooler_duty_MW.toFixed(2)+" MW_th"}/>}
        </div>
      </div>
    </div>}

    {/* Humid-air composition */}
    {result&&<div style={S.card}>
      <div style={S.cardT}>Inlet Humid-Air Composition (mol %)</div>
      <div style={{display:"flex",gap:16,flexWrap:"wrap",fontFamily:"monospace",fontSize:11.5}}>
        {Object.entries(result.oxidizer_humid_mol_pct).map(([k,v])=>(
          <div key={k} style={{minWidth:80}}>
            <span style={{color:C.txtDim}}>{k}:</span> <strong style={{color:C.accent}}>{v.toFixed(3)}</strong>
          </div>
        ))}
      </div>
    </div>}
  </div>);
}
function Kpi({label,value}){return(<div style={{padding:"6px 12px",background:C.bg,border:`1px solid ${C.border}`,borderRadius:5,minWidth:110}}>
  <div style={{fontSize:9,color:C.txtDim,fontFamily:"monospace",letterSpacing:".6px",textTransform:"uppercase"}}>{label}</div>
  <div style={{fontSize:15,fontWeight:700,color:C.txt,fontFamily:"monospace"}}>{value}</div>
</div>);}
function StationRow({n,desc,T,P,fmtT,fmtP,hi}){return(<tr style={hi?{background:`${C.accent}10`}:{}}>
  <td style={{padding:"5px 8px",color:hi?C.accent:C.txt,fontWeight:hi?700:400,borderBottom:`1px solid ${C.border}50`}}>{n}</td>
  <td style={{padding:"5px 8px",color:C.txtDim,borderBottom:`1px solid ${C.border}50`}}>{desc}</td>
  <td style={{padding:"5px 8px",color:hi?C.accent:C.txt,fontWeight:hi?700:400,borderBottom:`1px solid ${C.border}50`}}>{fmtT(T)}</td>
  <td style={{padding:"5px 8px",color:hi?C.accent:C.txt,fontWeight:hi?700:400,borderBottom:`1px solid ${C.border}50`}}>{fmtP(P)}</td>
</tr>);}
function KV({k,v}){return(<div style={{display:"flex",justifyContent:"space-between",gap:8,padding:"4px 0",borderBottom:`1px solid ${C.border}50`}}>
  <span style={{color:C.txtDim}}>{k}</span><span style={{color:C.accent,fontWeight:600}}>{v}</span>
</div>);}

/* ══════════════════ ENGINE & AMBIENT (sidebar version) ══════════════════
   Used to live inside CyclePanel. Lifted to the global sidebar so the engine
   inputs (which the user sweeps the most) are always one click away on every
   tab. Includes the Bleed sub-section. Dimmed when Accurate Mode is off
   because the cycle endpoint is FULL-tier-only.

   Bleed model:
     • bleedMode  = "auto" — bleed_open_pct is a piecewise-linear function of
                              load (100 % ≤ 75 %, 0 % ≥ 95 %, linear between).
     •            = "manual" — user types open % directly (slider 0–100 step 1).
     • bleedValveSizePct — max % of compressor air bled when fully open
                              (default 3.3 %, free-typed; quick 15 %-step buttons).
     • bleed_air_frac = open% × valve_size% / 10000  → backend lops that
       fraction off mdot_air_combustor & mdot_air_turbine (compressor work
       unchanged) and iteratively raises T4 to hold gross power.
*/
/* ══════════════════════════════════════════════════════════════════════════
   COMBUSTOR MAPPING PANEL (LMS100PB+ 4-circuit DLE premixer)
   --------------------------------------------------------------------------
   Maps the combustor primary-zone air into the four LMS100 DLE circuits
   (Inner Pilot, Outer Pilot, Inner Main, Outer Main) and lets the user set
   each circuit's equivalence ratio to confirm the combustor generates
   acceptable emissions with acceptable acoustics.

   Physics:
     • Total flame-zone air = m_air_combustor × combustor_air_frac (from cycle).
     • Each circuit takes a fixed % of the flame-zone air (editable, defaults
       IP 2.3, OP 2.2, IM 41.0, OM 54.5 — sum must = 100 %).
     • User sets phi for IP / OP / IM. Each circuit's fuel flow follows:
         m_fuel_i = FAR_stoich × phi_i × m_air_i
     • Outer Main is the "float" circuit — its fuel is whatever's left from
       the cycle's total fuel, phi_OM back-solved from the balance.
     • Water injection (WFR > 0): distributed proportionally to fuel, so each
       circuit sees the same WFR = overall WFR.
     • T_flame for each circuit is HP equilibrium at (phi_i, T_fuel, T3, P3)
       via the AFT backend (with water-aware variant when WFR > 0).

   Inputs from cycle: T3, P3, oxidizer humid-air composition, total combustor
   air flow, total fuel flow, combustor_air_frac. From sidebar: T_fuel, WFR,
   water_mode, T_water.
═══════════════════════════════════════════════════════════════════════════ */

// ─── Module-scope φ controls (used by Operating Snapshot in mapping) ─────
// These live OUTSIDE CombustorMappingPanel so React keeps a stable
// component identity across the 2 Hz live-mapping ticker. Previously
// they were inline inside the panel body, which made them brand-new
// component types on every render — React would unmount each <button>
// and remount a fresh one every 500 ms. If a tick fired between
// mousedown and mouseup, the button you were pressing got destroyed
// and the click was lost — that's the "sticky and non-responsive"
// feel the user reported during recording. With them hoisted, the
// DOM nodes persist across ticks and clicks register instantly.
//
// Wrapped in React.memo (imported as `memo`) so even if the parent rerenders 2×/s, these
// only repaint when val/color/step actually change.
const PhiEditor = memo(function PhiEditor({val, setVal, step, color}) {
  return (
    <div style={{display:"inline-flex",alignItems:"center",gap:3,width:104,justifyContent:"center"}}>
      <button onClick={()=>setVal(Math.max(0,+(val-step).toFixed(4)))}
        title={`Decrease φ by ${step}`}
        style={{padding:"2px 6px",fontSize:11,fontWeight:700,fontFamily:"monospace",color,background:"transparent",border:`1px solid ${color}60`,borderRadius:3,cursor:"pointer",lineHeight:1,flex:"0 0 auto"}}>−</button>
      <NumField value={val} decimals={4} onCommit={v=>setVal(Math.max(0,+v))}
        style={{width:60,padding:"3px 4px",fontFamily:"monospace",color,fontSize:12,fontWeight:700,background:C.bg,border:`1px solid ${color}40`,borderRadius:4,textAlign:"center",outline:"none",flex:"0 0 auto"}}/>
      <button onClick={()=>setVal(+(val+step).toFixed(4))}
        title={`Increase φ by ${step}`}
        style={{padding:"2px 6px",fontSize:11,fontWeight:700,fontFamily:"monospace",color,background:"transparent",border:`1px solid ${color}60`,borderRadius:3,cursor:"pointer",lineHeight:1,flex:"0 0 auto"}}>+</button>
    </div>
  );
});

const PhiDisabled = memo(function PhiDisabled({val, color}) {
  return (
    <div style={{display:"inline-block",width:104,padding:"4px 6px",fontFamily:"monospace",color,fontSize:12,fontWeight:700,background:`${color}18`,border:`1px dashed ${color}80`,borderRadius:4,textAlign:"center",boxSizing:"border-box"}}>
      {(val||0).toFixed(4)}
    </div>
  );
});

function CombustorMappingPanel({
  fuel, Tfuel, WFR=0, waterMode="liquid", T_water,
  cycleResult: cycleResultProp, bkCycle,
  // Lifted state — Operations Summary shares this so its NOx15/CO15 agree
  // with the mapping panel's correlation values.
  w36w3, setW36w3,
  fracIP, setFracIP, fracOP, setFracOP, fracIM, setFracIM, fracOM, setFracOM,
  phiIP, setPhiIP, phiOP, setPhiOP, phiIM, setPhiIM,
  bkMap: bkMapProp,
  mappingTables, setMappingTables,
  emissionsMode, setEmissionsMode,
  brndmdOverride, setBrndmdOverride,
  // Penalty value lifted FROM ExhaustPanel via App-level state. Object of
  // {value: USD/period or null, period: "week"|"month"|"year"}. Surfaced
  // in the Operating Snapshot summary alongside acoustics/emissions.
  exhaustPenalty,
  // Emissions-staging banner state lifted to App level. Object of
  // {currentBR, nextBR, timerEndsAt} or null.
  emStagingBanner,
  // Callback to cancel any in-progress emissions staging — called by the
  // Live Mapping protection / trip handlers so the staging timer doesn't
  // overwrite the protection cycle's brndmdOverride mid-flight.
  cancelEmissionsStaging,
}){
  const units=useContext(UnitCtx);
  const {accurate}=useContext(AccurateCtx);

  // ─── Engine load ramp — 0.2 MW/sec ────────────────────────────────────
  // When the user changes LOAD, the cycle backend returns the new steady-
  // state engine outputs instantly. A real LMS100 takes time (~0.2 MW/sec
  // permitted gradient). We interpolate cycleResult linearly between the
  // previous displayed state and the new target at 0.2 MW/sec so the live
  // mapping traces show a representative engine response.
  //
  // CRITICAL: ONLY load (MW) changes are ramped. φ button clicks, fuel
  // composition edits, water settings, ambient changes, etc. all snap
  // instantly — they're operator inputs, not engine transients. The map
  // output (PX36/NOx/CO correlations) is interpolated alongside the
  // cycle ONLY while a load ramp is in flight; for any other input
  // change the map snaps to the latest backend value.
  const RAMP_RATE_MW_PER_S = 0.2;
  const [displayedCycle, setDisplayedCycle] = useState(cycleResultProp);
  const [displayedMap,   setDisplayedMap]   = useState(bkMapProp?.data || null);
  // ramp state — `active` flips true ONLY when a load (MW) change triggers
  // an interpolation. φ / fuel / ambient changes do NOT set active=true.
  const rampRef = useRef({
    active: false,
    startCycle: null, targetCycle: null,
    startMap:   null, targetMap:   null,
    startMW:    0,    targetMW:    0,
    started_at: 0,
  });
  const lerpResult = useCallback((a, b, t) => {
    if (!a) return b; if (!b) return a;
    if (t <= 0) return a; if (t >= 1) return b;
    const out = { ...b };
    for (const k of Object.keys(b)) {
      const av = a[k], bv = b[k];
      if (typeof av === "number" && typeof bv === "number" && Number.isFinite(av) && Number.isFinite(bv)) {
        out[k] = av + t * (bv - av);
      } else if (av && bv && typeof av === "object" && typeof bv === "object" && !Array.isArray(av) && !Array.isArray(bv)) {
        const sub = { ...bv };
        for (const k2 of Object.keys(bv)) {
          const av2 = av[k2], bv2 = bv[k2];
          if (typeof av2 === "number" && typeof bv2 === "number" && Number.isFinite(av2) && Number.isFinite(bv2)) {
            sub[k2] = av2 + t * (bv2 - av2);
          }
        }
        out[k] = sub;
      }
    }
    return out;
  }, []);
  // CYCLE EFFECT — the only place that activates a ramp. Compares MW; if
  // ΔMW ≥ 0.05 we set active=true and capture start/target. Otherwise we
  // snap (cycle changed for some non-power reason — fuel, ambient, etc.).
  useEffect(() => {
    if (!cycleResultProp) return;
    if (!displayedCycle) { setDisplayedCycle(cycleResultProp); return; }
    const startMW  = Number(displayedCycle.MW_net) || 0;
    const targetMW = Number(cycleResultProp.MW_net) || 0;
    if (Math.abs(targetMW - startMW) < 0.05) {
      setDisplayedCycle(cycleResultProp);  // snap — non-power cycle change
      return;
    }
    // True load change — start ramp
    rampRef.current = {
      active: true,
      startCycle: displayedCycle,
      targetCycle: cycleResultProp,
      startMW, targetMW,
      // Map endpoints are filled when the next bkMap.data arrives (from the
      // cycle-driven mapping refetch). Until then the displayed map stays
      // at its previous value, then ramps once both endpoints are known.
      startMap: displayedMap,
      targetMap: null,
      started_at: Date.now(),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycleResultProp]);
  // MAP EFFECT — only stores the new map as a ramp target IF a ramp is
  // currently active. For any other reason the map updated (φ click, fuel
  // change, etc.) we SNAP to the new value immediately — that's exactly
  // what the user demanded: φ adjustments must be instantly visible.
  useEffect(() => {
    const newMap = bkMapProp?.data || null;
    if (!newMap) return;
    const r = rampRef.current;
    if (r.active && !r.targetMap) {
      // First map update after load change — capture as ramp target
      rampRef.current = { ...r, targetMap: newMap };
    } else {
      // Either no ramp active (φ click etc.) or ramp already has its
      // target — either way, snap. φ changes mid-ramp also snap, by design.
      setDisplayedMap(newMap);
      // If we're snapping mid-ramp, also kill the map portion of the ramp
      // so we don't drift backwards on the next tick.
      if (r.active) rampRef.current = { ...r, startMap: newMap, targetMap: null };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bkMapProp?.data]);
  // 200 ms ticker — advances the ramp only while r.active is true.
  useEffect(() => {
    const id = setInterval(() => {
      const r = rampRef.current;
      if (!r.active) return;
      const elapsed = (Date.now() - r.started_at) / 1000;
      const totalDelta = Math.abs(r.targetMW - r.startMW);
      const required = totalDelta / RAMP_RATE_MW_PER_S;
      const progress = required > 0 ? Math.min(1, elapsed / required) : 1;
      if (r.startCycle && r.targetCycle) {
        setDisplayedCycle(lerpResult(r.startCycle, r.targetCycle, progress));
      }
      if (r.startMap && r.targetMap) {
        setDisplayedMap(lerpResult(r.startMap, r.targetMap, progress));
      }
      if (progress >= 1) {
        // Ramp complete — clear state so next non-power change snaps.
        rampRef.current = {
          active: false,
          startCycle: null, targetCycle: null,
          startMap: null, targetMap: null,
          startMW: 0, targetMW: 0,
          started_at: 0,
        };
      }
    }, 200);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Shadow the props so downstream code consumes the ramped versions.
  const cycleResult = displayedCycle;
  const bkMap = bkMapProp ? { ...bkMapProp, data: displayedMap || bkMapProp.data } : bkMapProp;

  const sumFrac=fracIP+fracOP+fracIM+fracOM;

  // ── Mapping-table lookup — auto-fill IP/OP/IM φ from (T3, BRNDMD) ───────
  // T3 state comes from cycle; BRNDMD from MW_net + emissionsMode. Active
  // table defaults to BRNDMD=2 when BRNDMD=0 or 1 (no table for 1).
  const T3_K_cycle = cycleResult?.T3_K || 0;
  const T3_F_cycle = T3_K_cycle > 0 ? (T3_K_cycle - 273.15) * 9/5 + 32 : 0;
  const brndmdVal = calcBRNDMD(cycleResult?.MW_net || 0, emissionsMode, brndmdOverride);
  const tableKey = brndmdVal >= 2 ? brndmdVal : 2;
  const activeTable = mappingTables?.[tableKey] || mappingTables?.[2];
  const tableLookup = activeTable ? interpMappingTable(activeTable, T3_F_cycle) : null;

  // The auto-fill useEffect was moved to App level so it fires on any
  // cycle/parameter change regardless of which tab is active. The local
  // lookup computation above is kept just for this panel's "Active lookup"
  // summary display and active-row highlighting.

  // Active BRNDMD tab for the Mapping Tables card (default to current lookup)
  const [tblTab, setTblTab] = useState(7);
  useEffect(() => {
    if(tableKey !== tblTab) setTblTab(tableKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableKey]);

  // ═══════════════════════════════════════════════════════════════════════
  // LIVE MAPPING — real-time gas-turbine instrument simulation
  //
  // Plays a 4-trace dashboard at 2 Hz showing what the operator would see on
  // a control room HMI. Each trace centres on the cycle/correlation mean and
  // adds realistic instrument noise. When the user changes a parameter, the
  // displayed mean lags behind with sensor-realistic dead-time + smoothstep:
  //
  //          Metric        Dead time   Transition   Noise model
  //   ─────────────────  ───────────  ──────────  ─────────────────────────
  //   PX36_SEL              0 s         1 s        random step every 1-2 s,
  //                                                amp depends on mean band
  //   NOx15                83 s         7 s        sine wave, period 20 s,
  //                                                amp re-rolled each wave
  //   CO15                 83 s         7 s        same as NOx15
  //   MWI_WIM               2 s         5 s        sine 1 s period, ±4 %
  //   MWI_GC              415 s         5 s        sine 120 s period, ±0.5 %
  //
  // Buffer is a 1200-sample ring (10 minutes at 2 Hz). Stored in a useRef so
  // mutating it doesn't trigger React re-render — a separate tick counter
  // useState bumps once per tick to redraw the charts.
  // ═══════════════════════════════════════════════════════════════════════
  const [mappingActive, setMappingActive] = useState(false);
  const [mappingStartedAt, setMappingStartedAt] = useState(null);  // wall-clock seconds since epoch
  const [tickCount, setTickCount] = useState(0);  // drives chart re-render
  const bufferRef = useRef([]);                   // up to 1200 samples
  // User-editable y-axis ranges per plot. Stored in BASE units (psi for
  // PX36, ppm for NOx/CO, BTU/scf·√°R for MWI). The actual plot axis is
  // the MAX of (user-set range, data range) — auto-extends if live values
  // exceed the user bounds, never shrinks below them. Persisted across
  // sessions via localStorage.
  const [userRanges, setUserRanges] = useState(() => {
    const defaults = {
      PX36_SEL:    { min: 2,  max: 6   },  // psi (display unit-converted)
      PX36_SEL_HI: { min: 1,  max: 4   },  // psi — auto-extends to capture 100 psi trip
      NOx15:       { min: 10, max: 50  },  // ppmvd
      CO15:        { min: 10, max: 450 },  // ppmvd
      MWI:         { min: 44, max: 56  },  // BTU/scf·√°R, shared by WIM and GC
      MW:          { min: 0,  max: 120 },  // MW
    };
    try {
      const saved = localStorage.getItem("ctk.userRanges.v1");
      if (saved) return { ...defaults, ...JSON.parse(saved) };
    } catch {}
    return defaults;
  });
  useEffect(() => {
    try { localStorage.setItem("ctk.userRanges.v1", JSON.stringify(userRanges)); } catch {}
  }, [userRanges]);
  const _setRange = (key, side, valBase) => {
    if (!Number.isFinite(valBase)) return;
    setUserRanges(prev => ({...prev, [key]: {...(prev[key] || {min:0,max:1}), [side]: valBase}}));
  };
  // Per-metric mean tracker — models a real instrument: transport delay
  // (deadT) + first-order-style response (transT) on every step change in
  // the input signal. `history` is a sorted list of step events
  // [{tc, value}, …]; the displayed value at time t is found by walking
  // back to whatever the input was at time (t − deadT), then applying a
  // smoothstep ramp if a change happened recently. This correctly handles
  // multiple rapid step changes (e.g. BD4 → BD6 → BD7 → BD4 …) — each
  // input step shows up as a delayed output step, separated by the same
  // intervals as the input. Old design only tracked ONE active transition
  // and collapsed intermediate values.
  const meansRef = useRef({
    PX36_SEL:    { deadT: 0,   transT: 1, history: [{tc:-Infinity, value:0}] },
    PX36_SEL_HI: { deadT: 0,   transT: 1, history: [{tc:-Infinity, value:0}] },
    NOx15:       { deadT: 83,  transT: 7, history: [{tc:-Infinity, value:0}] },
    CO15:        { deadT: 83,  transT: 7, history: [{tc:-Infinity, value:0}] },
    MWI_WIM:     { deadT: 2,   transT: 5, history: [{tc:-Infinity, value:0}] },
    MWI_GC:      { deadT: 415, transT: 5, history: [{tc:-Infinity, value:0}] },
    MW:          { deadT: 0,   transT: 7, history: [{tc:-Infinity, value:0}] },
  });
  // Per-metric noise generator state.
  const noiseRef = useRef({
    PX36_SEL:    { devPct: 0, sign: 1, nextChange: 0 },
    PX36_SEL_HI: { devPct: 0, sign: 1, nextChange: 0 },
    NOx15:       { amp: 0.04, waveStart: 0 },
    CO15:        { amp: 0.06, waveStart: 0 },
  });
  // Trip stochastic-threshold trackers — random trip points re-rolled each
  // time the relevant phi rises into the trip band.
  const tripStateRef = useRef({
    phiIp: { thresh: null, inBand: false },  // BR=7 only
    phiOp: { thresh: null, inBand: false },  // BR=6 or 7
    // Acoustic-instability spike on LOW φ_OP (BR=7 only). When φ_OP enters
    // the unstable band [0.25, 0.31], we roll a random fire threshold
    // inside the band and a random spike amplitude in [6, 8] psi. While
    // φ_OP sits at-or-below the threshold AND in the band, the PX36_SEL
    // target is held at the spike amplitude — the existing protection
    // cycle then trips at >5.5 psi, overrides BRNDMD to 4, the BR=4
    // mapping pulls φ_OP back to 0.7, the band condition clears, and
    // the spike target stops being re-asserted (PX36 lags back down).
    phiOpSpike: { thresh: null, target: null, active: false },
    tripped: false,                           // engine shut down
    tripAt: 0,                                // wall-clock seconds
    tripCause: null,                          // 'phi_ip' | 'phi_op'
  });
  // Trip banner state for UI rendering (mirrors tripStateRef.tripped)
  const [tripBanner, setTripBanner] = useState(null);  // null | {atSec, cause, phi}
  // Refs that snapshot the latest correlation/cycle/emissionsMode values so
  // the interval callback always reads fresh data without re-creating the
  // interval. emissionsModeRef lets the auto-stage-down trigger read the
  // CURRENT value (not the value when the interval was first created).
  const corrRef = useRef(null);
  const cycleRef = useRef(null);
  const emissionsModeRef = useRef(emissionsMode);
  // Phi refs — mirror the φ state into refs so the 2 Hz Live Mapping
  // interval can read fresh values without having phiIP/phiOP/phiIM in
  // its useEffect deps. Without this, every +/− click on the φ editor
  // forces React to tear down + recreate the setInterval synchronously
  // during the commit phase, and rapid clicks stack up to a perceptible
  // UI freeze (3–5 clicks → couple-second stall). With it, clicks just
  // update the ref; the running interval picks up the new value on its
  // next 500 ms tick.
  const phiIPRef = useRef(phiIP);
  const phiOPRef = useRef(phiOP);
  const phiIMRef = useRef(phiIM);
  // brndmdOverride MUST be mirrored too. When the φ_OP-spike protection
  // cycle calls setBrndmdOverride(4) the App-level auto-fill writes the
  // BR=4 mapping values into phi state immediately (phi_IP=2.0 etc).
  // If the interval's closure is still on stale brndmdOverride=null then
  // _br = calcBRNDMD(MW_net) = 7 — and the BR=7-gated phi_IP high-side
  // trip detection sees phi_IP=2.0 (well above the [0.29, 0.35] band)
  // and trips the engine on the very next tick. The override and the
  // φ values must move atomically from the interval's point of view.
  const brndmdOverrideRef = useRef(brndmdOverride);
  useEffect(() => {
    corrRef.current = R?.correlations || null;
    cycleRef.current = cycleResult || null;
    emissionsModeRef.current = emissionsMode;
    phiIPRef.current = phiIP;
    phiOPRef.current = phiOP;
    phiIMRef.current = phiIM;
    brndmdOverrideRef.current = brndmdOverride;
  });
  // ── ENGINE PROTECTION LOGIC ─────────────────────────────────────────
  // Realistic plant control behavior. When live PX36_SEL crosses 5.5 psi,
  // the engine is auto-staged through a defensive cycle:
  //
  //     (idle) → BD4 (50 s) → BD6 (30 s) → BD7 (monitoring)
  //
  // If PX36_SEL trips again from BD6 or BD7 (or from idle after the cycle
  // completes), we restart the cycle and increment cycleCount. After 3
  // such cycles, the engine LOCKS at BD4 with a "contact your provider"
  // notice — operator action required to reset.
  //
  // State machine lives in a ref so the live-mapping interval callback
  // reads the latest value without re-creating the interval. Banner state
  // mirrors it for React rendering.
  const protRef = useRef({
    state: 'idle',          // 'idle' | 'at4' | 'at6' | 'at7' | 'locked'
    cycleCount: 0,
    timer: null,            // setTimeout handle for current phase
  });
  const [protBanner, setProtBanner] = useState(null);
    // { phase: 'staged' | 'locked', cycleCount, atSeconds, px36Val,
    //   currentBR: 4|6|7, nextBR?: 6|7|null, timerEndsAt?: epochSec }
  const _clearProtTimer = () => {
    if (protRef.current.timer) {
      clearTimeout(protRef.current.timer);
      protRef.current.timer = null;
    }
  };
  // Push a banner snapshot capturing the current protection state.
  const _bannerStaged = (px36Val, currentBR, nextBR, timerSec) => {
    setProtBanner({
      phase: 'staged',
      cycleCount: protRef.current.cycleCount,
      atSeconds: Date.now() / 1000,
      px36Val, currentBR, nextBR,
      timerEndsAt: timerSec ? (Date.now() / 1000) + timerSec : null,
    });
  };
  const _bannerLocked = (px36Val) => {
    setProtBanner({
      phase: 'locked',
      cycleCount: protRef.current.cycleCount,
      atSeconds: Date.now() / 1000,
      px36Val, currentBR: 4, nextBR: null, timerEndsAt: null,
    });
  };
  // Trigger entry into the protection cycle (called when PX36 > 5.5 from
  // any non-protective state).
  const _triggerProtection = (px36Val) => {
    // PX36 protection wins — abort any in-flight emissions-mode staging.
    if (cancelEmissionsStaging) cancelEmissionsStaging();
    protRef.current.cycleCount++;
    if (protRef.current.cycleCount > 3) {
      // LOCK at BD4, no more auto-staging
      _clearProtTimer();
      protRef.current.state = 'locked';
      if (setBrndmdOverride) setBrndmdOverride(4);
      _bannerLocked(px36Val);
      return;
    }
    // Start a fresh cycle: BD4 (50 s) → BD6 (30 s) → BD7
    _clearProtTimer();
    protRef.current.state = 'at4';
    if (setBrndmdOverride) setBrndmdOverride(4);
    _bannerStaged(px36Val, 4, 6, 50);
    protRef.current.timer = setTimeout(() => {
      // BD4 → BD6
      protRef.current.state = 'at6';
      if (setBrndmdOverride) setBrndmdOverride(6);
      _bannerStaged(px36Val, 6, 7, 30);
      protRef.current.timer = setTimeout(() => {
        // BD6 → BD7 (clear override, ladder takes over and gives 7 at high MW)
        protRef.current.state = 'at7';
        if (setBrndmdOverride) setBrndmdOverride(7);
        _bannerStaged(px36Val, 7, null, null);
        protRef.current.timer = null;
      }, 30 * 1000);
    }, 50 * 1000);
  };
  // Operator dismiss / reset — clears the override and resets the counter.
  const _resetProtection = () => {
    _clearProtTimer();
    protRef.current.state = 'idle';
    protRef.current.cycleCount = 0;
    if (setBrndmdOverride) setBrndmdOverride(null);
    setProtBanner(null);
  };
  // Cleanup timer on unmount
  useEffect(() => () => _clearProtTimer(), []);

  // ── EMISSIONS-MODE STAGING (lifted to App level) ────────────────────
  // The trigger/cancel logic + timer state + banner state used to live here
  // gated behind `mappingActive`, which meant the staging only fired when
  // Live Mapping was actively recording. It's now in App so a click on the
  // sidebar Emissions Mode toggle fires the staging from any tab.
  // The banner UI below still reads from the lifted `emStagingBanner` prop.

  // smoothstep: 3u² − 2u³. Smooth tangent at 0 and 1, exact arrival at u=1.
  const _smoothstep = u => u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
  // Compute the displayed mean at time `now` from the input-change history.
  // Algorithm: find what the input was at time tEff = now − deadT (the
  // "delayed input"). If a step change happened recently relative to tEff,
  // smoothstep between the previous value and the new value over transT.
  // Multiple step changes in the input each produce their own delayed step,
  // separated by the same time intervals as the original changes.
  const _displayedMean = (now, m) => {
    const h = m.history;
    if (!h || h.length === 0) return 0;
    const tEff = now - m.deadT;
    // Find the most recent change at or before tEff (binary search would be
    // overkill — history is short, walk back linearly).
    let i = h.length - 1;
    while (i > 0 && h[i].tc > tEff) i--;
    const cur = h[i];
    if (i === 0) return cur.value;  // no prior change; initial value
    const prev = h[i - 1];
    const dt = tEff - cur.tc;
    if (dt >= m.transT) return cur.value;  // fully transitioned to cur.value
    return prev.value + (cur.value - prev.value) * _smoothstep(dt / m.transT);
  };
  const _updateTarget = (now, m, newTarget) => {
    if (!m.history || m.history.length === 0) {
      m.history = [{tc:-Infinity, value:newTarget}];
      return;
    }
    const last = m.history[m.history.length - 1];
    if (Math.abs(newTarget - last.value) < 1e-9) return;  // no real change
    m.history.push({tc: now, value: newTarget});
    // Trim entries older than the response window so memory doesn't grow.
    // Keep an extra 60 s of pre-window context for smoothstep continuity.
    const cutoff = now - m.deadT - m.transT - 60;
    while (m.history.length > 1 && m.history[1].tc < cutoff) m.history.shift();
  };

  // ── 2 Hz tick loop ──
  useEffect(() => {
    if (!mappingActive) return;
    const id = setInterval(() => {
      const now = Date.now() / 1000;
      const corrLatest = corrRef.current;
      const cycLatest = cycleRef.current;
      const m = meansRef.current;
      const tr = tripStateRef.current;

      // ─── BRNDMD 6 multiplier on PX36_SEL_HI based on phi_IP ───────────
      // Piecewise linear lookup. Outside [0.8, 1.4] continue with the
      // closest segment's slope (linear extrapolation per user spec).
      const _phi_ip_hi_mult = (phiIp) => {
        const tbl = [[0.8,1.08],[0.9,1.04],[1.0,1.00],[1.1,0.94],[1.2,0.85],[1.3,0.84],[1.4,0.83]];
        if (phiIp <= tbl[0][0]) {
          // extrapolate using 0.8→0.9 slope (-0.4/unit for the multiplier)
          const slope = (tbl[1][1] - tbl[0][1]) / (tbl[1][0] - tbl[0][0]);
          return tbl[0][1] + slope * (phiIp - tbl[0][0]);
        }
        if (phiIp >= tbl[tbl.length-1][0]) {
          const a = tbl[tbl.length-2], b = tbl[tbl.length-1];
          const slope = (b[1]-a[1])/(b[0]-a[0]);
          return b[1] + slope * (phiIp - b[0]);
        }
        for (let i=0; i<tbl.length-1; i++) {
          if (phiIp >= tbl[i][0] && phiIp <= tbl[i+1][0]) {
            const u = (phiIp - tbl[i][0]) / (tbl[i+1][0] - tbl[i][0]);
            return tbl[i][1] + u * (tbl[i+1][1] - tbl[i][1]);
          }
        }
        return 1.0;
      };
      // Helper: linearly interpolate trip band edges based on load %.
      // Clamp at the bound endpoints (no extrapolation outside).
      const _interpBand = (loadPct, bandLo, bandHi) => {
        // bandLo = [loadL, loL, hiL]; bandHi = [loadH, loH, hiH]
        const [lL, ldL, hdL] = bandLo;
        const [lH, ldH, hdH] = bandHi;
        if (loadPct <= Math.min(lL, lH)) {
          const which = lL < lH ? bandLo : bandHi;
          return [which[1], which[2]];
        }
        if (loadPct >= Math.max(lL, lH)) {
          const which = lL > lH ? bandLo : bandHi;
          return [which[1], which[2]];
        }
        const u = (loadPct - lL) / (lH - lL);
        return [ldL + u * (ldH - ldL), hdL + u * (hdH - hdL)];
      };

      // ── Acoustic spike on LOW φ_OP (BR=7) — runs FIRST so the target
      //    update on this same tick reads a fresh `active` flag, no
      //    1-tick lag. Lean-tip flameholding margin collapses around
      //    φ_OP ≈ 0.27 ± and the dome rings up. When φ_OP enters
      //    [0.25, 0.31] we pick a random fire point inside the band and
      //    a random spike amplitude in [6, 8] psi — different exact
      //    trigger each time. Latch persists while φ_OP stays in band
      //    AND below the rolled threshold; clears the moment φ_OP exits
      //    (which it will when the existing >5.5 psi protection cycle
      //    forces BRNDMD → 4 and the BR=4 mapping pulls φ_OP back to
      //    ~0.7).
      if (!tr.tripped && cycLatest) {
        const _br_spike = brndmdOverrideRef.current ?? calcBRNDMD(cycLatest?.MW_net || 0, emissionsModeRef.current);
        if (_br_spike === 7) {
          const pOp = Number(phiOPRef.current) || 0;
          if (pOp >= 0.25 && pOp <= 0.31) {
            if (tr.phiOpSpike.thresh == null) {
              tr.phiOpSpike.thresh = 0.25 + Math.random() * (0.31 - 0.25);
              tr.phiOpSpike.target = 6 + Math.random() * 2;
            }
            tr.phiOpSpike.active = pOp <= tr.phiOpSpike.thresh;
          } else {
            tr.phiOpSpike.thresh = null;
            tr.phiOpSpike.target = null;
            tr.phiOpSpike.active = false;
          }
        } else {
          tr.phiOpSpike.thresh = null;
          tr.phiOpSpike.target = null;
          tr.phiOpSpike.active = false;
        }
      } else {
        // Engine tripped or no cycle yet — clear the latch so a recovery
        // doesn't strand the spike state.
        tr.phiOpSpike.thresh = null;
        tr.phiOpSpike.target = null;
        tr.phiOpSpike.active = false;
      }

      // ─── Update target means ──────────────────────────────────────────
      // When tripped, ALL targets go to 0 with their device-delay times.
      // Otherwise read the latest correlation/cycle values.
      if (tr.tripped) {
        _updateTarget(now, m.PX36_SEL, 0);
        _updateTarget(now, m.PX36_SEL_HI, 0);
        _updateTarget(now, m.NOx15, 0);
        _updateTarget(now, m.CO15,  0);
        _updateTarget(now, m.MWI_WIM, 0);
        _updateTarget(now, m.MWI_GC,  0);
        _updateTarget(now, m.MW, 0);
      } else if (corrLatest) {
        // When the φ_OP spike is latched, override the PX36_SEL target
        // with the rolled spike amplitude (6–8 psi) instead of the live
        // correlation value. The lagging-mean smoothstep walks the
        // displayed value toward the spike target within ~1 s — fast
        // enough to read as a real acoustic event on the trace.
        _updateTarget(now, m.PX36_SEL,
          tr.phiOpSpike.active ? tr.phiOpSpike.target : corrLatest.PX36_SEL);
        _updateTarget(now, m.NOx15,    corrLatest.NOx15);
        _updateTarget(now, m.CO15,     corrLatest.CO15);
        // PX36_SEL_HI gets the BRNDMD-6 phi_IP multiplier (only at BR=6).
        const _br = brndmdOverrideRef.current ?? calcBRNDMD(cycLatest?.MW_net || 0, emissionsModeRef.current);
        const _hiMult = (_br === 6) ? _phi_ip_hi_mult(Number(phiIPRef.current) || 0) : 1.0;
        _updateTarget(now, m.PX36_SEL_HI, corrLatest.PX36_SEL_HI * _hiMult);
        const mwiCycle = cycLatest?.fuel_flexibility?.mwi || 0;
        if (mwiCycle > 0) {
          _updateTarget(now, m.MWI_WIM, mwiCycle * 0.99);
          _updateTarget(now, m.MWI_GC,  mwiCycle);
        }
        const mwLive = cycLatest?.MW_net || 0;
        _updateTarget(now, m.MW, mwLive);
      }

      // ─── Stochastic phi_IP / phi_OP trips ─────────────────────────────
      // Pick a random threshold ONCE when phi rises into the trip band;
      // persist until phi drops back below the lower edge (then re-roll).
      // Trip logic only runs when NOT already tripped.
      if (!tr.tripped && cycLatest) {
        const loadPct = cycLatest.load_pct || 100;
        const _br = brndmdOverrideRef.current ?? calcBRNDMD(cycLatest?.MW_net || 0, emissionsModeRef.current);
        // ── phi_IP trip — only at BRNDMD 7 ──
        if (_br === 7) {
          const [lo, hi] = _interpBand(loadPct, [75, 0.35, 0.40], [100, 0.29, 0.35]);
          const pIp = Number(phiIPRef.current) || 0;
          if (pIp >= lo) {
            if (!tr.phiIp.inBand) {
              // First entry into the band: roll a fresh random threshold
              tr.phiIp.inBand = true;
              tr.phiIp.thresh = lo + Math.random() * (hi - lo);
            }
            if (pIp >= tr.phiIp.thresh) {
              // TRIP fires — engine shutdown sequence begins
              tr.tripped = true; tr.tripAt = now; tr.tripCause = 'phi_ip';
              _updateTarget(now, m.PX36_SEL_HI, 100);  // instant spike to 100
              setTripBanner({
                atSec: now, px36HiVal: 100,
                brndmd: _br, loadPct,
                phiIp: pIp, phiOp: Number(phiOPRef.current)||0, phiIm: Number(phiIMRef.current)||0,
              });
              _resetProtection();  // cancel any in-progress protection cycle
              if (cancelEmissionsStaging) cancelEmissionsStaging();  // cancel any in-progress emissions ramp
            }
          } else {
            // phi dropped out of band — clear so next entry re-rolls
            tr.phiIp.inBand = false; tr.phiIp.thresh = null;
          }
        } else {
          tr.phiIp.inBand = false; tr.phiIp.thresh = null;
        }
        // ── phi_OP trip — at BRNDMD 6 or 7 ──
        if (!tr.tripped && (_br === 6 || _br === 7)) {
          const [lo, hi] = _interpBand(loadPct, [70, 1.00, 1.20], [100, 0.95, 1.10]);
          const pOp = Number(phiOPRef.current) || 0;
          if (pOp >= lo) {
            if (!tr.phiOp.inBand) {
              tr.phiOp.inBand = true;
              tr.phiOp.thresh = lo + Math.random() * (hi - lo);
            }
            if (pOp >= tr.phiOp.thresh) {
              tr.tripped = true; tr.tripAt = now; tr.tripCause = 'phi_op';
              _updateTarget(now, m.PX36_SEL_HI, 100);
              setTripBanner({
                atSec: now, px36HiVal: 100,
                brndmd: _br, loadPct,
                phiIp: Number(phiIPRef.current)||0, phiOp: pOp, phiIm: Number(phiIMRef.current)||0,
              });
              _resetProtection();
              if (cancelEmissionsStaging) cancelEmissionsStaging();
            }
          } else {
            tr.phiOp.inBand = false; tr.phiOp.thresh = null;
          }
        } else {
          tr.phiOp.inBand = false; tr.phiOp.thresh = null;
        }

      }

      // ─── Compute displayed (lagging) means ──────────────────────────
      // PX36_SEL fast-path: when the φ_OP spike latch is active, bypass
      // the deadtime + smoothstep ramp entirely and snap dPX36 to the
      // rolled spike target. Acoustic ring-up is a fraction-of-a-second
      // event in the real world; the lagging-mean's 1 s transT models
      // the SENSOR response, not the gas-dynamics. We still call
      // _updateTarget below with the spike target so the lagging mean
      // tracks for the FALL phase — when the latch clears, the metric's
      // internal mean is at-or-near the spike value and ramps back down
      // to the correlation value over ~1 s. Net: instant rise, gradual
      // decay, which matches dome-ring-up / ring-down physics.
      const dPX36 = tr.phiOpSpike.active
        ? tr.phiOpSpike.target
        : _displayedMean(now, m.PX36_SEL);
      const dPX36HI = _displayedMean(now, m.PX36_SEL_HI);
      const dNOx    = _displayedMean(now, m.NOx15);
      const dCO     = _displayedMean(now, m.CO15);
      const dWIM    = _displayedMean(now, m.MWI_WIM);
      const dGC     = _displayedMean(now, m.MWI_GC);
      const dMW     = _displayedMean(now, m.MW);

      // ─── Per-metric noise ───────────────────────────────────────────
      const n = noiseRef.current;
      // PX36_SEL — random step, mean-band dependent amplitude.
      // mean<4.7 → U(1.5,3.4) ; mean>4.85 → U(7,9) ; interp in between.
      if (now >= n.PX36_SEL.nextChange) {
        const x = dPX36;
        let lo, hi;
        if (x < 4.7)        { lo = 1.5; hi = 3.4; }
        else if (x > 4.85)  { lo = 7.0; hi = 9.0; }
        else { const u = (x - 4.7) / 0.15; lo = 1.5 + u * (7.0 - 1.5); hi = 3.4 + u * (9.0 - 3.4); }
        n.PX36_SEL.devPct = (lo + Math.random() * (hi - lo)) / 100;
        n.PX36_SEL.sign   = Math.random() < 0.5 ? -1 : 1;
        n.PX36_SEL.nextChange = now + 1 + Math.random();
      }
      const px36Val = dPX36 * (1 + n.PX36_SEL.sign * n.PX36_SEL.devPct);
      // PX36_SEL_HI — same noise style, breakpoints at 2.1 / 2.25 psi.
      // When tripped (target=100), suppress the % noise — the trip value
      // should read as a clean 100 psi visual spike, not noisy.
      if (now >= n.PX36_SEL_HI.nextChange) {
        const x = dPX36HI;
        let lo, hi;
        if (x < 2.1)        { lo = 1.5; hi = 3.4; }
        else if (x > 2.25)  { lo = 7.0; hi = 9.0; }
        else { const u = (x - 2.1) / 0.15; lo = 1.5 + u * (7.0 - 1.5); hi = 3.4 + u * (9.0 - 3.4); }
        n.PX36_SEL_HI.devPct = (lo + Math.random() * (hi - lo)) / 100;
        n.PX36_SEL_HI.sign   = Math.random() < 0.5 ? -1 : 1;
        n.PX36_SEL_HI.nextChange = now + 1 + Math.random();
      }
      const px36HiVal = (dPX36HI > 50)
        ? dPX36HI  // trip — no noise, clean 100 psi spike
        : dPX36HI * (1 + n.PX36_SEL_HI.sign * n.PX36_SEL_HI.devPct);

      // ── Engine Protection Logic (NOT during trip) ──
      if (!tr.tripped
          && px36Val > 5.5
          && protRef.current.state !== 'at4'
          && protRef.current.state !== 'locked') {
        _triggerProtection(px36Val);
      }

      // NOx15 — 20 s sine, re-roll amp at wave end
      if (now - n.NOx15.waveStart >= 20) {
        n.NOx15.amp = (1 + Math.random() * 2) / 100;
        n.NOx15.waveStart = now;
      }
      const noxPhase = ((now - n.NOx15.waveStart) / 20) * 2 * Math.PI;
      const nox15Val = dNOx * (1 + n.NOx15.amp * Math.sin(noxPhase));

      if (now - n.CO15.waveStart >= 20) {
        n.CO15.amp = (5 + Math.random() * 2.5) / 100;
        n.CO15.waveStart = now;
      }
      const coPhase = ((now - n.CO15.waveStart) / 20) * 2 * Math.PI;
      const co15Val = dCO * (1 + n.CO15.amp * Math.sin(coPhase));

      const wimVal = dWIM * (1 + (Math.random() * 2 - 1) * 0.025);
      const gcVal  = dGC  * (1 + 0.0025 * Math.sin((now / 120) * 2 * Math.PI));
      // MW — no noise, just the smoothstepped value (power output is steady)
      const mwVal  = dMW;

      bufferRef.current.push({
        t: now,
        PX36_SEL: px36Val, PX36_SEL_HI: px36HiVal,
        NOx15: nox15Val, CO15: co15Val,
        MWI_WIM: wimVal, MWI_GC: gcVal,
        MW: mwVal,
      });
      // 2 Hz × 10-minute window = 1200 samples in the ring buffer.
      // Every metric is sampled at 2 Hz; the acoustic ones (PX36_SEL,
      // PX36_SEL_HI) need it for transient resolution, the slow ones
      // (emissions, MWI_GC, MW) just carry extra interpolation points
      // along their unchanged lagging-mean curves — their deadtime /
      // time-constant smoothing is in seconds and is rate-invariant.
      if (bufferRef.current.length > 1200) bufferRef.current.shift();
      setTickCount(c => c + 1);
    }, 500);
    return () => clearInterval(id);
    // Only re-create the interval when mappingActive itself flips —
    // phiIP/phiOP/phiIM are now read live via their refs (above) so
    // continuous +/- clicks don't tear down the running interval.
  }, [mappingActive]);

  const startMapping = () => {
    const now = Date.now() / 1000;
    bufferRef.current = [];
    // Seed each metric's history with a single "initial" entry at -Infinity
    // so the displayed-mean lookup returns the seed value at any time. The
    // first real change comes in via _updateTarget on the next tick.
    const m = meansRef.current;
    const c0 = R?.correlations;
    if (c0) {
      ["PX36_SEL","PX36_SEL_HI","NOx15","CO15"].forEach(k => {
        m[k].history = [{tc:-Infinity, value: c0[k] || 0}];
      });
    }
    const mwi0 = cycleResult?.fuel_flexibility?.mwi || 0;
    m.MWI_WIM.history = [{tc:-Infinity, value: mwi0 * 0.99}];
    m.MWI_GC.history  = [{tc:-Infinity, value: mwi0}];
    m.MW.history      = [{tc:-Infinity, value: cycleResult?.MW_net || 0}];
    noiseRef.current.NOx15.waveStart = now;
    noiseRef.current.CO15.waveStart = now;
    noiseRef.current.PX36_SEL.nextChange = now;
    noiseRef.current.PX36_SEL_HI.nextChange = now;
    // Reset trip state — fresh start
    tripStateRef.current = {
      phiIp: { thresh: null, inBand: false },
      phiOp: { thresh: null, inBand: false },
      phiOpSpike: { thresh: null, target: null, active: false },
      tripped: false, tripAt: 0, tripCause: null,
    };
    setTripBanner(null);
    setMappingStartedAt(now);
    setTickCount(0);
    setMappingActive(true);
  };
  const pauseMapping = () => setMappingActive(false);
  const resumeMapping = () => setMappingActive(true);
  const resetMapping = () => {
    bufferRef.current = [];
    setMappingStartedAt(null);
    setTickCount(0);
    setMappingActive(false);
    // Clear trip state too — fresh start should clear any in-progress trip
    tripStateRef.current = {
      phiIp: { thresh: null, inBand: false },
      phiOp: { thresh: null, inBand: false },
      phiOpSpike: { thresh: null, target: null, active: false },
      tripped: false, tripAt: 0, tripCause: null,
    };
    setTripBanner(null);
  };
  // Reset only the trip (operator dismisses the trip banner) — clears the
  // tripped flag so targets resume reading from cycle/correlation. Leaves
  // the mapping running and history intact so the user sees the recovery.
  const _resetTrip = () => {
    tripStateRef.current.tripped = false;
    tripStateRef.current.tripAt = 0;
    tripStateRef.current.tripCause = null;
    tripStateRef.current.phiIp = { thresh: null, inBand: false };
    tripStateRef.current.phiOp = { thresh: null, inBand: false };
    tripStateRef.current.phiOpSpike = { thresh: null, target: null, active: false };
    setTripBanner(null);
  };

  // Edit one cell of one table and persist via setMappingTables.
  const updateCell = (BRNDMD, rowIdx, key, value) => {
    setMappingTables(prev => {
      const next = {...prev};
      const rows = [...(prev[BRNDMD]||[])];
      if(!rows[rowIdx]) return prev;
      rows[rowIdx] = {...rows[rowIdx], [key]: Number(value)};
      next[BRNDMD] = rows;
      return next;
    });
  };
  // ── Bimodal Reset switch ────────────────────────────────────────────
  // Two named lookup presets — UNMAPPED (raw factory) and MAPPED
  // (rig-calibrated). The button label always reflects the NEXT action:
  // initial label = "Reset to Mapped" (because UNMAPPED is the seed
  // loaded on first launch); each click loads the named preset and
  // flips the label to the other one. Persisted in localStorage so
  // the toggle state survives reloads.
  const [nextResetTarget, setNextResetTarget] = useState(() => {
    try {
      const v = localStorage.getItem("ctk_mapping_reset_target");
      return (v === "unmapped" || v === "mapped") ? v : "mapped";
    } catch { return "mapped"; }
  });
  const resetTables = () => {
    if (typeof window === "undefined") return;
    const target = nextResetTarget;
    const table = target === "unmapped" ? UNMAPPED_MAPPING_TABLES : MAPPED_MAPPING_TABLES;
    if (window.confirm(`Reset ALL mapping tables to ${target.toUpperCase()} values? Your edits will be lost.`)){
      setMappingTables(JSON.parse(JSON.stringify(table)));
      const next = target === "unmapped" ? "mapped" : "unmapped";
      setNextResetTarget(next);
      try { localStorage.setItem("ctk_mapping_reset_target", next); } catch {}
    }
  };

  // ── Standalone Mapping-Tables-only Excel export ─────────────────────────
  // Writes a single-sheet workbook with the four BRNDMD lookups in their
  // current edited state, rather than dragging in the full multi-sheet
  // CombustionReport. Uses the same column layout as the big workbook's
  // "Mapping Tables" sheet so a side-by-side comparison still lines up.
  // Honors the current units context — SI exports T3 in K, ENG keeps °F.
  const exportMappingTables = () => {
    if (!mappingTables) return;
    const u = units === "SI" ? "SI" : "ENG";
    const _t3Header = u === "SI" ? "T3 (K)" : "T3 (°F)";
    const _t3Conv   = u === "SI"
      ? (F => +(((+F - 32) * 5/9 + 273.15).toFixed(2)))
      : (F => +(+F).toFixed(1));
    const sM = [
      ["═══ COMBUSTOR MAPPING TABLES — φ lookup by T3 × BRNDMD ═══"],
      ["BRNDMD = burner mode (7=full DLE, 6=trans, 4=part-load, 2=startup)"],
      ["Generated: " + new Date().toISOString().slice(0, 16)],
      [],
      ["BRNDMD", _t3Header, "φ_OuterPilot", "φ_InnerPilot", "φ_InnerMain"],
    ];
    for (const k of [7, 6, 4, 2]){
      const rows = mappingTables[k] || [];
      for (const r of rows) sM.push([k, _t3Conv(r.T3), +r.OP, +r.IP, +r.IM]);
      sM.push([]);
    }
    const wb  = XLSX.utils.book_new();
    const wsM = XLSX.utils.aoa_to_sheet(sM);
    wsM["!cols"] = [{wch:10},{wch:12},{wch:16},{wch:16},{wch:16}];
    XLSX.utils.book_append_sheet(wb, wsM, "Mapping Tables");
    const suffix = u === "SI" ? "SI" : "English";
    XLSX.writeFile(wb, `ProReadyEngineer_MappingTables_${suffix}.xlsx`);
  };

  // ── Cycle-provided state ─────────────────────────────────────────────────
  const T3=cycleResult?.T3_K||300;
  const P3_bar=cycleResult?.P3_bar||1;
  const oxHumid=cycleResult?.oxidizer_humid_mol_pct||null;
  const m_air_post_bleed=cycleResult?.mdot_air_post_bleed_kg_s||cycleResult?.mdot_air_kg_s||0;
  const m_fuel_total=cycleResult?.mdot_fuel_kg_s||0;
  const comAirFrac=cycleResult?.combustor_air_frac||0.89;

  // ── Derived air allocation (for display; backend authoritative) ──────────
  const m_air_W36       = m_air_post_bleed * Math.max(0,Math.min(1,w36w3));
  const m_air_flame     = m_air_W36 * Math.max(0,Math.min(1,comAirFrac));
  const m_air_cooling   = m_air_W36 * (1 - Math.max(0,Math.min(1,comAirFrac)));
  const m_air_IP        = m_air_flame * fracIP/100;
  const m_air_OP        = m_air_flame * fracOP/100;
  const m_air_IM        = m_air_flame * fracIM/100;
  const m_air_OM        = m_air_flame * fracOM/100;

  // bkMap is computed once in App and passed down — shared with Ops Summary.
  const R = bkMap?.data;
  const C_IP = R?.circuits?.IP, C_OP = R?.circuits?.OP, C_IM = R?.circuits?.IM, C_OM = R?.circuits?.OM;
  const phi_OM = R?.phi_OM || 0;
  const m_fuel_OM = C_OM?.m_fuel_kg_s || 0;
  const m_fuel_IP_bk = C_IP?.m_fuel_kg_s || 0;
  const m_fuel_OP_bk = C_OP?.m_fuel_kg_s || 0;
  const m_fuel_IM_bk = C_IM?.m_fuel_kg_s || 0;
  const fuel_residual = R?.fuel_residual_kg_s || 0;
  const derived = R?.derived;
  const corr    = R?.correlations;
  const corr100 = R?.correlations_100pct_load;

  // ── Formatting helpers ───────────────────────────────────────────────────
  const fmtMdot = k => units==="SI" ? k.toFixed(4) : (k*2.20462).toFixed(3);
  const mdotU   = units==="SI" ? "kg/s" : "lb/s";
  const fmtT    = K => uv(units,"T",K).toFixed(0);
  // PX36 dynamics — backend returns psi. SI users want mbar (1 psi ≈ 68.9476 mbar).
  // Helper returns a {value, unit} object so headers and values stay consistent.
  const fmtPx   = v => units==="SI" ? (v*68.9476).toFixed(1) : v.toFixed(3);
  const pxUnit  = units==="SI" ? "mbar" : "psi";

  // ── Validation banners ───────────────────────────────────────────────────
  const sumOff       = Math.abs(sumFrac-100) > 0.05;
  const OMnegFuel    = fuel_residual < -1e-6 || (R && m_fuel_OM<=0 && (m_fuel_IP_bk+m_fuel_OP_bk+m_fuel_IM_bk)>m_fuel_total*1.001);
  const OMphiExtreme = phi_OM>0 && (phi_OM<0.05 || phi_OM>1.5);

  // PhiEditor and PhiDisabled are HOISTED to module scope (above this
  // function definition) so the -/+ buttons keep a stable React
  // component identity across the 2 Hz live-mapping ticker.
  // See the comment block at the module-level definitions for the full
  // root-cause explanation.

  return(<div style={{display:"flex",flexDirection:"column",gap:12}}>
    <InlineBusyBanner loading={accurate&&(bkCycle?.loading||bkMap.loading)}/>

    <HelpBox title="ℹ️ Combustor Mapping — How It Works">
      <p style={{margin:"0 0 6px"}}>This panel maps the <span style={hs.em}>LMS100 four-circuit DLE combustor</span> — Inner Pilot, Outer Pilot, Inner Main, Outer Main — at the cycle's operating point. Outer Main is the float circuit (fuel and φ back-solved from the total).</p>
      <p style={{margin:"0 0 6px"}}><span style={hs.em}>You change:</span> per-circuit fuel splits and equivalence ratios, dome air fraction (W36/W3), and an emissions transfer-function trim if you want to bias the result.</p>
      <p style={{margin:"0 0 6px"}}><span style={hs.em}>You get:</span> per-circuit flame temperature (T_AFT), total NOx@15%O₂ and CO@15%O₂, dynamics signals (PX36_SEL low-frequency and PX36_SEL_HI high-frequency), and the temperature spread DT_Main between Outer Main and Inner Main.</p>
      <p style={{margin:0,fontSize:11,color:C.txtMuted}}>Reference design point, anchor calibration, and the correction chain are documented in the <strong>Assumptions</strong> tab.</p>
    </HelpBox>

    {!cycleResult?
      // Diagnostic placeholder — distinguishes the four real reasons cycleResult
      // can be null instead of always saying "turn on Accurate Mode" (which is
      // wrong when Accurate is already on and the user is staring at a stuck
      // panel without knowing why).
      (() => {
        const _isLoading = !!(bkCycle && bkCycle.loading);
        const _err = bkCycle && bkCycle.err;
        let title, body, color;
        if(!accurate){
          color = C.warm;
          title = "Cycle backend not active";
          body = "Switch to Gas Turbine Simulator or Advanced Mode using the MODE picker in the header. The cycle backend needs to run before the mapping can populate (needs T3, P3, humid-air composition, total fuel flow).";
        } else if(_err){
          color = C.strong;
          title = "Cycle backend error";
          body = `The /calc/cycle call returned an error: ${_err}. Try toggling a sidebar parameter to re-fire, or click CLEAR CACHE in the header to drop any stale cached response.`;
        } else if(_isLoading){
          color = C.accent;
          title = "Computing cycle solution…";
          body = "First-call cycle solve takes 5–15 s. The mapping populates as soon as it returns. If this hangs for >30 s, click CLEAR CACHE in the header and try again.";
        } else {
          color = C.txtMuted;
          title = "Waiting for cycle inputs";
          body = "The cycle endpoint hasn't fired yet — try nudging any sidebar parameter (load %, fuel composition, ambient T) to trigger it. If this state persists after a parameter change, click CLEAR CACHE in the header.";
        }
        return (
          <div style={{padding:"32px 24px",textAlign:"center",background:C.bg2,border:`1px dashed ${color}50`,borderRadius:10,color:C.txtDim}}>
            <div style={{fontSize:13,fontWeight:700,color,marginBottom:8,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".5px"}}>{_isLoading?"⟳ ":""}{title}</div>
            <div style={{fontSize:11.5,lineHeight:1.55,maxWidth:640,margin:"0 auto",fontFamily:"'Barlow',sans-serif"}}>{body}</div>
          </div>
        );
      })()
      :<>

      {/* ═════════════════════════════════════════════════════════════════
          1 · OPERATING SNAPSHOT — per-circuit dashboard
            Columns (left → right): Air flow · φ (editable) · Acoustics
            (PX36_SEL + PX36_SEL_HI, system-wide, merged across rows) ·
            Emissions (NOx15 + CO15, system-wide, merged) · M_Fuel · T_AFT
         ═════════════════════════════════════════════════════════════════ */}
      <div style={S.card}>
        <div style={S.cardT}>1 · Operating Snapshot</div>

        {/* Inlet state chips (read-only from cycle) */}
        <div style={{display:"flex",gap:8,flexWrap:"wrap",fontFamily:"monospace",fontSize:11,marginBottom:10}}>
          {/* BRNDMD chip — leftmost so users see the burner-mode ladder
              position at a glance before reading the cycle stations. */}
          <div title="BRNDMD = burner mode (7=full DLE, 6=transitional, 4=part-load, 2=startup). Computed from MW_net via the emissions-mode ladder." style={{padding:"5px 9px",background:`${C.violet}15`,borderRadius:5,border:`1px solid ${C.violet}66`}}><span style={{color:C.txtDim}}>BRNDMD:</span> <strong style={{color:C.violet}}>{Number.isFinite(brndmdVal)?brndmdVal:"—"}</strong></div>
          {/* MW_net chip — drives BRNDMD selection and is the headline cycle output. */}
          <div title="MW_net = OEM-anchored cycle deck output (after part-load, ambient droop, fuel-flex derate). Drives the BRNDMD ladder selection." style={{padding:"5px 9px",background:`${C.good}15`,borderRadius:5,border:`1px solid ${C.good}66`}}><span style={{color:C.txtDim}}>Power:</span> <strong style={{color:C.good}}>{Number.isFinite(cycleResult?.MW_net)?cycleResult.MW_net.toFixed(1):"—"} MW</strong></div>
          <div style={{padding:"5px 9px",background:C.bg2,borderRadius:5,border:`1px solid ${C.border}`}}><span style={{color:C.txtDim}}>T₃:</span> <strong style={{color:C.accent}}>{fmtT(T3)} {uu(units,"T")}</strong></div>
          <div style={{padding:"5px 9px",background:C.bg2,borderRadius:5,border:`1px solid ${C.border}`}}><span style={{color:C.txtDim}}>P₃:</span> <strong style={{color:C.accent}}>{units==="SI"?(P3_bar/1.01325).toFixed(3)+" atm":(P3_bar*14.5038).toFixed(1)+" psia"}</strong></div>
          <div style={{padding:"5px 9px",background:C.bg2,borderRadius:5,border:`1px solid ${C.border}`}}><span style={{color:C.txtDim}}>T_fuel:</span> <strong style={{color:C.accent2}}>{fmtT(Tfuel)} {uu(units,"T")}</strong></div>
          {derived?.T_Bulk_K
            ? <div title="Single-zone HP-equilibrium adiabatic flame T at φ_Bulk = total_fuel / (total_flame_air × FAR_stoich). Cantera complete-combustion at (T3, P3) with T_fuel and WFR carried in. This is the Tflame the NOx/CO correlation is anchored on." style={{padding:"5px 9px",background:C.bg2,borderRadius:5,border:`1px solid ${C.accent}40`}}><span style={{color:C.txtDim}}>T_Bulk:</span> <strong style={{color:C.accent}}>{fmtT(derived.T_Bulk_K)} {uu(units,"T")}</strong></div>
            : null}
          <div style={{padding:"5px 9px",background:C.bg2,borderRadius:5,border:`1px solid ${C.border}`}}><span style={{color:C.txtDim}}>W3 (post-bleed):</span> <strong style={{color:C.txt}}>{fmtMdot(m_air_post_bleed)} {mdotU}</strong></div>
          <div style={{padding:"5px 9px",background:C.bg2,borderRadius:5,border:`1px solid ${C.border}`}}><span style={{color:C.txtDim}}>com.Air Frac:</span> <strong style={{color:C.txt}}>{(comAirFrac*100).toFixed(1)} %</strong></div>
          <div style={{padding:"5px 9px",background:C.bg2,borderRadius:5,border:`1px solid ${C.border}`}}><span style={{color:C.txtDim}}>Total fuel:</span> <strong style={{color:C.accent2}}>{fmtMdot(m_fuel_total)} {mdotU}</strong></div>
          {WFR>0?<div style={{padding:"5px 9px",background:C.bg2,borderRadius:5,border:`1px solid ${C.violet}40`}}><span style={{color:C.txtDim}}>WFR:</span> <strong style={{color:C.violet}}>{WFR.toFixed(3)}</strong> <span style={{color:C.txtMuted,fontSize:10}}>({waterMode})</span></div>:null}
        </div>

        {!R&&accurate
          ? <div style={{padding:"18px",textAlign:"center",color:C.txtDim,fontSize:11,fontStyle:"italic"}}>{bkMap.loading?"Calculating per-circuit values…":bkMap.err?`Error: ${bkMap.err}`:"Waiting for inputs…"}</div>
          : (
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11.5,fontFamily:"monospace"}}>
              <thead>
                <tr style={{background:C.bg2,color:C.txtDim}}>
                  <th style={{padding:"7px 10px",textAlign:"left",borderBottom:`1px solid ${C.border}`,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",fontSize:10}}>Circuit</th>
                  <th style={{padding:"7px 10px",textAlign:"right",borderBottom:`1px solid ${C.border}`,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",fontSize:10}}>Air flow ({mdotU})</th>
                  <th style={{padding:"7px 10px",textAlign:"center",borderBottom:`1px solid ${C.border}`,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",fontSize:10}}>φ</th>
                  <th style={{padding:"7px 10px",textAlign:"right",borderBottom:`1px solid ${C.border}`,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",fontSize:10}}>TFlame ({uu(units,"T")})</th>
                  <th style={{padding:"7px 10px",textAlign:"right",borderBottom:`1px solid ${C.border}`,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",fontSize:10}}>M_Fuel ({mdotU})</th>
                  <th style={{padding:"7px 10px",textAlign:"right",borderBottom:`1px solid ${C.border}`,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",fontSize:10}}>Fuel_Split (%)</th>
                  <th style={{padding:"7px 10px",textAlign:"center",borderBottom:`1px solid ${C.border}`,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",fontSize:10,borderLeft:`2px solid ${C.border}`,color:C.txtDim}}>System Metrics</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["Inner Pilot","IP",C.strong,"centerbody pilot",C_IP,phiIP,setPhiIP,0.05,true],
                  ["Outer Pilot","OP",C.orange,"annular pilot",C_OP,phiOP,setPhiOP,0.05,true],
                  ["Inner Main","IM",C.accent,"inner premix",C_IM,phiIM,setPhiIM,0.005,true],
                  ["Outer Main","OM",C.accent2,"float circuit",C_OM,phi_OM,null,0,false],
                ].map(([label,key,color,sub,row,phiV,setPhi,step,editable],idx)=>(
                  <tr key={key} style={{background:`${color}08`}}>
                    <td style={{padding:"8px 10px",borderBottom:`1px solid ${C.border}40`,minWidth:140}}>
                      <div style={{fontSize:11.5,fontWeight:700,color,letterSpacing:".3px"}}>{label} <span style={{color:C.txtMuted,fontWeight:400,fontSize:9.5}}>({key})</span></div>
                      <div style={{fontSize:9,color:C.txtMuted,fontFamily:"monospace",fontStyle:"italic"}}>{sub}</div>
                    </td>
                    <td style={{padding:"8px 10px",textAlign:"right",color:C.txt,fontWeight:600,borderBottom:`1px solid ${C.border}40`}}>{row?fmtMdot(row.m_air_kg_s):fmtMdot([m_air_IP,m_air_OP,m_air_IM,m_air_OM][idx])}</td>
                    <td style={{padding:"8px 10px",textAlign:"center",borderBottom:`1px solid ${C.border}40`}}>
                      {editable
                        ? <PhiEditor val={phiV} setVal={setPhi} step={step} color={color}/>
                        : <PhiDisabled val={phiV} color={color}/>}
                    </td>
                    <td style={{padding:"8px 10px",textAlign:"right",color:C.orange,fontWeight:700,borderBottom:`1px solid ${C.border}40`}}>{row?fmtT(row.T_AFT_complete_K):"—"}</td>
                    <td style={{padding:"8px 10px",textAlign:"right",color:C.accent2,fontWeight:600,borderBottom:`1px solid ${C.border}40`}}>{row?fmtMdot(row.m_fuel_kg_s):"—"}</td>
                    <td style={{padding:"8px 10px",textAlign:"right",color:C.txt,fontWeight:600,borderBottom:`1px solid ${C.border}40`}}>{
                      // Fuel split = m_fuel_circuit / m_fuel_total × 100, rounded
                      // to 2 decimals. Shows "—" if either flow is missing/zero.
                      (row && Number.isFinite(row.m_fuel_kg_s) && Number.isFinite(m_fuel_total) && m_fuel_total > 0)
                        ? (row.m_fuel_kg_s / m_fuel_total * 100).toFixed(2) + " %"
                        : "—"
                    }</td>
                    {/* System-wide metrics: rendered once spanning all 4 rows.
                        5-row × 2-col Category|Value table — Acoustics × 2 +
                        Emissions × 2 + Inefficiencies (Penalty $/period from
                        ExhaustPanel via the App-level exhaustPenalty lift). */}
                    {idx===0&&(
                      <td rowSpan={4} style={{padding:"6px 10px",borderBottom:`1px solid ${C.border}40`,verticalAlign:"middle",borderLeft:`2px solid ${C.border}`,background:C.bg2,minWidth:300}}>
                        {(()=>{
                          const _period = exhaustPenalty?.period || "week";
                          const _penaltyVal = exhaustPenalty?.value;
                          const _fmtUSD = (v) => Number.isFinite(v)
                            ? "$" + v.toLocaleString("en-US", {minimumFractionDigits: 0, maximumFractionDigits: 0})
                            : "—";
                          // 1-decimal pressure formatter (psi or mbar) — bypasses
                          // the panel-wide fmtPx which uses 3 decimals.
                          const _fmtPx1 = (v) => units==="SI" ? (v*68.9476).toFixed(1) : v.toFixed(1);
                          // Color rule per user: PX36 → red, NOx/CO → green,
                          // Inefficiencies → orange. C.strong is the canonical
                          // red, C.good the canonical green.
                          const ROWS = [
                            ["Acoustics — PX36_SEL",    corr ? `${_fmtPx1(corr.PX36_SEL)} ${pxUnit}`     : "—", C.strong],
                            ["Acoustics — PX36_SEL_HI", corr ? `${_fmtPx1(corr.PX36_SEL_HI)} ${pxUnit}`  : "—", C.strong],
                            ["Emissions — NOx@15",      corr ? `${corr.NOx15.toFixed(1)} ppm`            : "—", C.good],
                            ["Emissions — CO@15",       corr ? `${corr.CO15.toFixed(1)} ppm`             : "—", C.good],
                            [`Inefficiencies — Penalty / ${_period}`, _fmtUSD(_penaltyVal),               C.orange],
                          ];
                          return (
                            <table style={{width:"100%",borderCollapse:"collapse",fontFamily:"monospace",fontSize:14}}>
                              <tbody>
                                {ROWS.map(([cat, val, color], i) => (
                                  <tr key={cat} style={{background:`${color}08`}}>
                                    <td style={{padding:"7px 10px",color,fontWeight:700,letterSpacing:".3px",fontSize:13,borderBottom:i<ROWS.length-1?`1px solid ${C.border}40`:"none"}}>{cat}</td>
                                    <td style={{padding:"7px 10px",textAlign:"right",color,fontWeight:700,fontSize:14,fontVariantNumeric:"tabular-nums",borderBottom:i<ROWS.length-1?`1px solid ${C.border}40`:"none"}}>{val}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          );
                        })()}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        {derived?<div style={{marginTop:8,padding:"5px 10px",background:`${C.warm}10`,border:`1px solid ${C.warm}45`,borderRadius:5,fontSize:11,fontFamily:"monospace",color:C.txtDim,display:"inline-block"}}>
          <strong style={{color:C.warm}}>DT_Main</strong> (OM − IM) = <strong style={{color:C.warm,fontSize:13}}>{derived.DT_Main_F.toFixed(1)} °F</strong>
        </div>:null}
      </div>

      {/* ═════════════════════════════════════════════════════════════════
          LIVE MAPPING — real-time HMI-style trace dashboard
          2 Hz tick · 10-min sliding window · sensor-realistic noise + lag
         ═════════════════════════════════════════════════════════════════ */}
      {(() => {
        // X-axis range — first 10 min: [start, start+600s]; after that, slides.
        const buf = bufferRef.current;
        const now = Date.now() / 1000;
        const xMin = mappingStartedAt
          ? (now - mappingStartedAt < 600 ? mappingStartedAt : now - 600)
          : 0;
        const xMax = mappingStartedAt
          ? (now - mappingStartedAt < 600 ? mappingStartedAt + 600 : now)
          : 600;
        // Format wall-clock time HH:MM from epoch seconds
        const hhmm = (s) => {
          const d = new Date(s * 1000);
          const hh = String(d.getHours()).padStart(2, "0");
          const mm = String(d.getMinutes()).padStart(2, "0");
          const ss = String(d.getSeconds()).padStart(2, "0");
          return `${hh}:${mm}:${ss}`;
        };
        // Slice the buffer to the visible window (no need to plot off-screen).
        const visible = buf.filter(p => p.t >= xMin && p.t <= xMax);
        // Helper for one mini chart with our standard styling.
        // userMinDisp / userMaxDisp = user-set bounds in DISPLAY units.
        // The actual axis = max(user, data) so the trace can extend the axis
        // dynamically if values exceed the user bounds (never shrinks below).
        // onChangeMin / onChangeMax — callbacks invoked with a value in DISPLAY
        // units; parent converts to base units before storing in userRanges.
        // Each plot also shows a small editable Range pill in the header.
        const TraceChart = ({ title, color, yKey, fmt, unit, secondKey, secondColor, secondLabel, primaryLabel,
                              userMinDisp, userMaxDisp, onChangeMin, onChangeMax, decimals=2,
                              y2LockMin, y2LockMax, hLines }) => {
          // Extract every visible numeric value (primary + secondary if present)
          // in display units, find the data extremes, and let them push the axis
          // beyond the user bounds when needed.
          const allVals = [];
          visible.forEach(p => {
            const a = Number(fmt(p[yKey])); if (Number.isFinite(a)) allVals.push(a);
            if (secondKey) {
              const b = Number(fmt(p[secondKey])); if (Number.isFinite(b)) allVals.push(b);
            }
          });
          const dataMin = allVals.length ? Math.min(...allVals) : userMinDisp;
          const dataMax = allVals.length ? Math.max(...allVals) : userMaxDisp;
          const effMin  = Math.min(userMinDisp, dataMin);
          const effMax  = Math.max(userMaxDisp, dataMax);
          // For dual-axis plots (MWI), the secondary axis should match the
          // primary effective range so both series read against the same scale.
          const effY2Min = secondKey ? effMin : y2LockMin;
          const effY2Max = secondKey ? effMax : y2LockMax;
          // Inline shared style for the two range inputs. (Don't wrap in a
          // sub-component — TraceChart re-creates every tick, so a nested
          // component type would be re-defined on every render and React
          // would unmount/remount the NumField, killing focus and any
          // in-progress text. NumField itself is top-level and stable, so
          // calling it directly preserves identity across renders.)
          const _rangeInputStyle = {width:62,padding:"2px 5px",fontSize:10,fontFamily:"monospace",color,
            background:C.bg,border:`1px solid ${color}50`,borderRadius:3,textAlign:"center",
            outline:"none",fontWeight:600};
          // Visual cue: when the axis is auto-extended beyond the user range,
          // show a small "AUTO+" tag so the operator knows the band has stretched.
          const extended = effMin < userMinDisp || effMax > userMaxDisp;
          return (
          <div style={{background:C.bg2,border:`1px solid ${color}30`,borderRadius:6,padding:"10px 12px 4px"}}>
            <div style={{fontSize:11,fontWeight:700,color:C.txtDim,textTransform:"uppercase",letterSpacing:".8px",marginBottom:4,display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap"}}>
              <span style={{color,display:"flex",alignItems:"center",gap:8}}>
                {title}
                {extended && <span title="Axis auto-extended past your set range to fit live data" style={{fontSize:8.5,fontWeight:700,padding:"1px 5px",background:`${C.warm}25`,border:`1px solid ${C.warm}60`,borderRadius:3,color:C.warm,letterSpacing:".3px"}}>AUTO+</span>}
              </span>
              {visible.length > 0 ? (
                <span style={{fontSize:10,fontWeight:500,fontFamily:"monospace",letterSpacing:0,fontVariantNumeric:"tabular-nums",display:"flex",gap:10,alignItems:"baseline"}}>
                  <span style={{color}}>{primaryLabel ? `${primaryLabel} ` : ""}{fmt(visible[visible.length-1][yKey])} {unit}</span>
                  {secondKey ? <span style={{color:secondColor}}>{secondLabel} {fmt(visible[visible.length-1][secondKey])}</span> : null}
                </span>
              ) : null}
            </div>
            {/* Editable y-axis bounds — inline NumField (NOT wrapped in
                a nested sub-component, see _rangeInputStyle comment above) */}
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4,fontSize:9.5,color:C.txtMuted,fontFamily:"monospace",letterSpacing:".3px"}}>
              <span>RANGE:</span>
              <NumField value={userMinDisp} decimals={decimals}
                onCommit={v => Number.isFinite(v) && onChangeMin(v)}
                title="Set y-axis MIN. Axis still auto-extends if data drops below this."
                style={_rangeInputStyle}/>
              <span>—</span>
              <NumField value={userMaxDisp} decimals={decimals}
                onCommit={v => Number.isFinite(v) && onChangeMax(v)}
                title="Set y-axis MAX. Axis still auto-extends if data rises above this."
                style={_rangeInputStyle}/>
              <span>{unit}</span>
            </div>
            <Chart
              data={visible.map(p => ({
                t: p.t,
                v: Number(fmt(p[yKey])),
                ...(secondKey ? { v2: Number(fmt(p[secondKey])) } : {}),
              }))}
              xK="t" yK="v" xL=""
              yL={`${title} (${unit})`}
              color={color}
              w={600} h={210}
              xMin={xMin} xMax={xMax}
              yMin={effMin} yMax={effMax}
              y2K={secondKey ? "v2" : null}
              c2={secondColor || color}
              y2L={secondLabel || ""}
              y2Min={effY2Min} y2Max={effY2Max}
              hLines={hLines}
              // Format x-axis tick labels as wall-clock HH:MM:SS instead of
              // raw epoch seconds. 4 ticks across a ~600 px chart gives one
              // label every ~150 px — comfortable for "HH:MM:SS" strings
              // without overlap.
              xFmt={hhmm} nXTicks={4}
            />
          </div>
          );
        };
        // Unit converters — PX36 already has fmtPx/pxUnit defined above.
        const fmtNOx = v => v.toFixed(1);
        const fmtCO  = v => v.toFixed(1);
        const fmtMWI = v => v.toFixed(2);
        // PX36 user range and threshold lines are in psi (base units); convert
        // to mbar in SI display mode via _px (1 psi = 68.9476 mbar).
        const _px = (psi) => units==="SI" ? psi * 68.9476 : psi;
        const px36HLines = [
          { y: _px(5.0), color: C.accent2, label: "ALARM" },  // amber/yellow
          { y: _px(5.5), color: C.strong,  label: "TRIP"  },  // red
        ];
        // PX36_SEL_HI threshold lines — alarm 2.3 psi yellow, trip 2.5 psi red.
        const px36HiHLines = [
          { y: _px(2.3), color: C.accent2, label: "ALARM" },
          { y: _px(2.5), color: C.strong,  label: "TRIP"  },
        ];
        // Elapsed playback time
        const elapsed = mappingStartedAt ? Math.floor(now - mappingStartedAt) : 0;
        const mm = String(Math.floor(elapsed/60)).padStart(2,"0");
        const ss = String(elapsed%60).padStart(2,"0");
        return (
          <div style={{...S.card,border:`1.5px solid ${mappingActive?C.good:C.border}`,background:mappingActive?`linear-gradient(180deg, ${C.good}06 0%, ${C.bg} 80%)`:undefined}}>
            {/* Top bar — controls + status */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:10}}>
              <div>
                <div style={{...S.cardT,marginBottom:3}}>
                  Live Mapping {mappingActive ? <span style={{fontSize:10,color:C.good,marginLeft:8,fontWeight:500,fontFamily:"monospace",letterSpacing:0}}>● RECORDING · {mm}:{ss}</span> : null}
                </div>
                <div style={{fontSize:10.5,color:C.txtMuted,lineHeight:1.45,fontFamily:"'Barlow',sans-serif",maxWidth:820}}>
                  Real-time instrument simulation at 2 Hz with sensor-realistic noise. Response times reflect each instrument: acoustics (PX36) ≈ 1 s, power (MW) ≈ 7 s, Wobbe meter (WIM) ≈ 7 s, emissions (NOx / CO) ≈ 90 s, gas chromatograph (GC) ≈ 7 min. Exact dead-times and time constants are in the <strong>Assumptions</strong> tab.
                </div>
              </div>
              <div style={{display:"flex",gap:8,flexShrink:0}}>
                {!mappingActive && !mappingStartedAt && (
                  <button onClick={startMapping}
                    style={{padding:"10px 18px",fontSize:12,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".6px",
                      color:C.bg,background:C.good,border:`1.5px solid ${C.good}`,borderRadius:6,cursor:"pointer",
                      display:"flex",alignItems:"center",gap:7}}>
                    ▶ START MAPPING
                  </button>
                )}
                {!mappingActive && mappingStartedAt && (
                  <button onClick={resumeMapping}
                    style={{padding:"10px 18px",fontSize:12,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".6px",
                      color:C.bg,background:C.good,border:`1.5px solid ${C.good}`,borderRadius:6,cursor:"pointer",
                      display:"flex",alignItems:"center",gap:7}}>
                    ▶ RESUME
                  </button>
                )}
                {mappingActive && (
                  <button onClick={pauseMapping}
                    style={{padding:"10px 18px",fontSize:12,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".6px",
                      color:C.bg,background:C.accent2,border:`1.5px solid ${C.accent2}`,borderRadius:6,cursor:"pointer",
                      display:"flex",alignItems:"center",gap:7}}>
                    ⏸ PAUSE
                  </button>
                )}
                {mappingStartedAt && (
                  <button onClick={resetMapping}
                    style={{padding:"10px 14px",fontSize:12,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".6px",
                      color:C.warm,background:"transparent",border:`1.5px solid ${C.warm}`,borderRadius:6,cursor:"pointer",
                      display:"flex",alignItems:"center",gap:7}}>
                    ⟳ RESET
                  </button>
                )}
              </div>
            </div>
            {/* Engine TRIP banner — full shutdown sequence with 4-hour
                countdown. Replaces the protection banner when active.
                Countdown re-evaluates each tick (2 Hz) via tickCount.
                Auto-clears when timer hits zero; user can override with
                the RESET button to bypass the lockdown. */}
            {tripBanner && (() => {
              const LOCKOUT_SEC = 4 * 60 * 60;  // 4 hours
              const elapsed = Math.max(0, (Date.now()/1000) - tripBanner.atSec);
              const remain  = Math.max(0, LOCKOUT_SEC - elapsed);
              // Auto-clear once the lockout has elapsed.
              if (remain <= 0) {
                // Defer state mutation out of render
                setTimeout(_resetTrip, 0);
              }
              const hh = String(Math.floor(remain / 3600)).padStart(2, "0");
              const mm = String(Math.floor((remain % 3600) / 60)).padStart(2, "0");
              const ss = String(Math.floor(remain % 60)).padStart(2, "0");
              const tStr = (()=>{const d=new Date(tripBanner.atSec*1000);return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;})();
              const releaseAt = new Date((tripBanner.atSec + LOCKOUT_SEC) * 1000);
              const releaseStr = `${String(releaseAt.getHours()).padStart(2,"0")}:${String(releaseAt.getMinutes()).padStart(2,"0")}:${String(releaseAt.getSeconds()).padStart(2,"0")}`;
              // Operator-facing message — present the trip CONDITION (the
              // PX36_SEL_HI value and the live mapping settings) without
              // disclosing the underlying random-trigger logic. The user
              // is expected to recognise patterns in the data themselves
              // across multiple trips.
              return (
                <div style={{
                  marginBottom:14,padding:"22px 26px",
                  background:`linear-gradient(135deg, ${C.strong}48 0%, ${C.strong}20 100%)`,
                  border:`4px solid ${C.strong}`,borderRadius:8,
                  boxShadow:`0 0 0 2px ${C.strong}30, 0 6px 24px ${C.strong}50, inset 0 0 0 1px ${C.strong}30`,
                  display:"flex",alignItems:"center",justifyContent:"space-between",gap:20,
                }}>
                  <div style={{flex:"0 0 auto",fontSize:60,color:C.strong,lineHeight:1,
                    filter:`drop-shadow(0 0 14px ${C.strong}90)`}}>
                    🚨
                  </div>
                  <div style={{flex:1,minWidth:0,display:"flex",flexDirection:"column",gap:6}}>
                    <div style={{fontSize:30,fontWeight:800,color:C.strong,
                      fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"1.5px",
                      lineHeight:1.05,textShadow:`0 1px 0 ${C.bg}`}}>
                      ENGINE TRIPPED — LOCK DOWN
                    </div>
                    {/* Live 4-hour countdown */}
                    <div style={{display:"flex",alignItems:"baseline",gap:14,marginTop:2}}>
                      <div style={{fontSize:36,fontWeight:800,color:C.strong,
                        fontFamily:"monospace",letterSpacing:"2px",lineHeight:1,
                        fontVariantNumeric:"tabular-nums",
                        textShadow:`0 0 8px ${C.strong}50`}}>
                        {hh}:{mm}:{ss}
                      </div>
                      <div style={{fontSize:11,color:C.txtDim,fontFamily:"'Barlow',sans-serif",
                        letterSpacing:".5px"}}>
                        REMAINING · auto-release at <strong style={{color:C.txt,fontFamily:"monospace"}}>{releaseStr}</strong>
                      </div>
                    </div>
                    {/* Trip condition — pure data, no cause disclosure */}
                    <div style={{fontSize:13,color:C.txt,fontFamily:"monospace",
                      lineHeight:1.55,marginTop:6}}>
                      <strong style={{color:C.warm}}>PX36_SEL_HI = {fmtPx(tripBanner.px36HiVal)} {pxUnit}</strong>
                      &nbsp;·&nbsp; tripped at <strong>{tStr}</strong>
                    </div>
                    <div style={{fontSize:12,color:C.txtDim,fontFamily:"monospace",
                      lineHeight:1.5,marginTop:2,letterSpacing:".2px"}}>
                      Mapping at trip:&nbsp;
                      Load <strong style={{color:C.txt}}>{tripBanner.loadPct.toFixed(0)} %</strong>
                      &nbsp;·&nbsp; BR <strong style={{color:C.violet}}>{tripBanner.brndmd}</strong>
                      &nbsp;·&nbsp; φ<sub>IP</sub> <strong style={{color:C.txt}}>{tripBanner.phiIp.toFixed(3)}</strong>
                      &nbsp;·&nbsp; φ<sub>OP</sub> <strong style={{color:C.txt}}>{tripBanner.phiOp.toFixed(3)}</strong>
                      &nbsp;·&nbsp; φ<sub>IM</sub> <strong style={{color:C.txt}}>{tripBanner.phiIm.toFixed(3)}</strong>
                    </div>
                    <div style={{fontSize:12,color:C.txtMuted,fontStyle:"italic",
                      marginTop:4,fontFamily:"'Barlow',sans-serif"}}>
                      This message will not appear on the engine GUI.
                    </div>
                  </div>
                  <button onClick={_resetTrip}
                    title="Override the 4-hour lock and reset the engine immediately. In a real plant this would require provider authorisation."
                    style={{padding:"12px 22px",fontSize:15,fontWeight:800,
                      color:C.bg,background:C.strong,border:`2px solid ${C.strong}`,borderRadius:6,
                      cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".7px",
                      whiteSpace:"nowrap",flexShrink:0,boxShadow:`0 2px 10px ${C.strong}70`}}>
                    ⟲ OVERRIDE & RESET
                  </button>
                </div>
              );
            })()}
            {/* Engine Protection Logic banner — fires when PX36_SEL > 5.5 psi.
                Sized to be impossible to miss: oversized icon, large title,
                generous padding, intense colour. The operator should read
                this from across the room. Hidden during trip — trip wins. */}
            {!tripBanner && protBanner && (() => {
              const isLocked = protBanner.phase === 'locked';
              const accent = isLocked ? C.strong : C.warm;
              const tStr = (()=>{const d=new Date(protBanner.atSeconds*1000);return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;})();
              const remain = protBanner.timerEndsAt ? Math.max(0, protBanner.timerEndsAt - (Date.now()/1000)) : null;
              const titleText = isLocked
                ? "ENGINE LOCKED IN BD 4"
                : (protBanner.cycleCount === 1
                    ? "STAGED DOWN TO BD 4 — ELEVATED ACOUSTICS"
                    : `ENGINE PROTECTION CYCLE ${protBanner.cycleCount} OF 3`);
              const subText = isLocked
                ? "CONTACT YOUR PROVIDER"
                : (protBanner.cycleCount > 1 ? `STAGED DOWN TO BD ${protBanner.currentBR}` : null);
              return (
                <div style={{
                  marginBottom:14,padding:"18px 22px",
                  background:`linear-gradient(135deg, ${accent}38 0%, ${accent}18 100%)`,
                  border:`3px solid ${accent}`,borderRadius:8,
                  boxShadow:`0 0 0 1px ${accent}25, 0 4px 16px ${accent}30, inset 0 0 0 1px ${accent}25`,
                  display:"flex",alignItems:"center",justifyContent:"space-between",gap:18,
                  position:"relative",
                }}>
                  {/* Big icon */}
                  <div style={{flex:"0 0 auto",fontSize:48,color:accent,lineHeight:1,
                    filter:`drop-shadow(0 0 10px ${accent}80)`}}>
                    {isLocked ? "🔒" : "⚠"}
                  </div>
                  {/* Body */}
                  <div style={{flex:1,minWidth:0,display:"flex",flexDirection:"column",gap:6}}>
                    <div style={{fontSize:24,fontWeight:800,color:accent,
                      fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"1.2px",
                      lineHeight:1.1,textShadow:`0 1px 0 ${C.bg}`}}>
                      {titleText}
                    </div>
                    {subText && (
                      <div style={{fontSize:18,fontWeight:700,color:accent,
                        fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"1px",
                        lineHeight:1.1,opacity:0.95}}>
                        {subText}
                      </div>
                    )}
                    {/* Detail line */}
                    <div style={{fontSize:13,color:C.txt,fontFamily:"monospace",
                      lineHeight:1.55,marginTop:2}}>
                      PX36_SEL trip at <strong style={{color:accent,fontSize:14}}>{fmtPx(protBanner.px36Val)} {pxUnit}</strong>
                      &nbsp;·&nbsp; <strong>{tStr}</strong>
                      {!isLocked && (<>
                        &nbsp;·&nbsp; BR=<strong style={{color:C.violet}}>{protBanner.currentBR}</strong>
                        {protBanner.nextBR != null && (<>
                          &nbsp;→&nbsp; BR=<strong style={{color:C.violet}}>{protBanner.nextBR}</strong>
                          &nbsp;in&nbsp;<strong style={{color:accent,fontSize:14}}>{remain != null ? `${Math.ceil(remain)} s` : "—"}</strong>
                        </>)}
                        {protBanner.nextBR == null && <em style={{color:C.txtDim}}>&nbsp;· monitoring (will retrigger if PX36 spikes again)</em>}
                      </>)}
                    </div>
                    {/* Disclaimer */}
                    <div style={{fontSize:12,color:C.txtMuted,fontStyle:"italic",
                      marginTop:4,fontFamily:"'Barlow',sans-serif"}}>
                      {isLocked
                        ? "This message will not appear on the engine GUI."
                        : "This tip will not appear on the engine GUI."}
                    </div>
                  </div>
                  {/* Reset button */}
                  <button onClick={_resetProtection}
                    title={isLocked ? "Reset protection — clear lock and resume normal control" : "Dismiss and abort current protection cycle"}
                    style={{padding:"10px 18px",fontSize:14,fontWeight:800,
                      color:C.bg,background:accent,border:`2px solid ${accent}`,borderRadius:6,
                      cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".7px",
                      whiteSpace:"nowrap",flexShrink:0,boxShadow:`0 2px 8px ${accent}50`}}>
                    ⟲ RESET
                  </button>
                </div>
              );
            })()}
            {/* ── Emissions-mode staging banner (green) ──
                Shown while ramping BD4 → BD6 → BD7 after the operator turns
                Emissions Mode ON. Hidden during trip and during PX36
                protection — those higher-priority banners take the slot. */}
            {!tripBanner && !protBanner && emStagingBanner && (() => {
              const accent = C.good;
              const remain = emStagingBanner.timerEndsAt
                ? Math.max(0, emStagingBanner.timerEndsAt - (Date.now()/1000))
                : null;
              return (
                <div style={{
                  marginBottom:14,padding:"14px 18px",
                  background:`linear-gradient(135deg, ${accent}30 0%, ${accent}12 100%)`,
                  border:`2px solid ${accent}`,borderRadius:8,
                  boxShadow:`0 0 0 1px ${accent}25, 0 3px 12px ${accent}25`,
                  display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,
                }}>
                  <div style={{flex:"0 0 auto",fontSize:32,color:accent,lineHeight:1,
                    filter:`drop-shadow(0 0 8px ${accent}80)`}}>
                    ✓
                  </div>
                  <div style={{flex:1,minWidth:0,display:"flex",flexDirection:"column",gap:4}}>
                    <div style={{fontSize:18,fontWeight:800,color:accent,
                      fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"1px",
                      lineHeight:1.1}}>
                      EMISSIONS MODE STAGING IN PROGRESS
                    </div>
                    <div style={{fontSize:13,color:C.txt,fontFamily:"monospace",lineHeight:1.55}}>
                      Currently at BR=<strong style={{color:accent,fontSize:14}}>{emStagingBanner.currentBR}</strong>
                      {emStagingBanner.nextBR != null && (<>
                        &nbsp;→&nbsp; BR=<strong style={{color:accent,fontSize:14}}>{emStagingBanner.nextBR}</strong>
                        &nbsp;in&nbsp;<strong style={{color:accent,fontSize:14}}>{remain != null ? `${Math.ceil(remain)} s` : "—"}</strong>
                      </>)}
                      {emStagingBanner.nextBR == null && (
                        <em style={{color:C.txtDim}}>&nbsp;· settled at target burner mode</em>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}
            {!mappingStartedAt ? (
              <div style={{padding:"40px 24px",textAlign:"center",background:C.bg2,border:`1px dashed ${C.border}`,borderRadius:8,color:C.txtMuted,fontSize:12,fontFamily:"'Barlow',sans-serif"}}>
                Click <strong style={{color:C.good}}>▶ START MAPPING</strong> to begin a real-time recording. The 10-minute window will fill in over time, one sample per second.
              </div>
            ) : (
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
                <TraceChart title="PX36_SEL" color={C.warm}    yKey="PX36_SEL" fmt={fmtPx}  unit={pxUnit}
                  userMinDisp={_px(userRanges.PX36_SEL.min)} userMaxDisp={_px(userRanges.PX36_SEL.max)}
                  decimals={units==="SI"?1:2}
                  onChangeMin={v => _setRange("PX36_SEL", "min", units==="SI"?v/68.9476:v)}
                  onChangeMax={v => _setRange("PX36_SEL", "max", units==="SI"?v/68.9476:v)}
                  hLines={px36HLines}/>
                <TraceChart title="PX36_SEL_HI" color={C.violet} yKey="PX36_SEL_HI" fmt={fmtPx} unit={pxUnit}
                  userMinDisp={_px(userRanges.PX36_SEL_HI.min)} userMaxDisp={_px(userRanges.PX36_SEL_HI.max)}
                  decimals={units==="SI"?1:2}
                  onChangeMin={v => _setRange("PX36_SEL_HI", "min", units==="SI"?v/68.9476:v)}
                  onChangeMax={v => _setRange("PX36_SEL_HI", "max", units==="SI"?v/68.9476:v)}
                  hLines={px36HiHLines}/>
                <TraceChart title="NOx @ 15 % O₂" color={C.accent} yKey="NOx15"    fmt={fmtNOx} unit="ppmvd"
                  userMinDisp={userRanges.NOx15.min} userMaxDisp={userRanges.NOx15.max} decimals={1}
                  onChangeMin={v => _setRange("NOx15", "min", v)}
                  onChangeMax={v => _setRange("NOx15", "max", v)}/>
                <TraceChart title="CO @ 15 % O₂"  color={C.accent2} yKey="CO15"     fmt={fmtCO}  unit="ppmvd"
                  userMinDisp={userRanges.CO15.min} userMaxDisp={userRanges.CO15.max} decimals={0}
                  onChangeMin={v => _setRange("CO15", "min", v)}
                  onChangeMax={v => _setRange("CO15", "max", v)}/>
                <TraceChart title="MWI — Wobbe Index" color={C.accent3} yKey="MWI_WIM" fmt={fmtMWI} unit="BTU/scf·√°R"
                  primaryLabel="WIM"
                  secondKey="MWI_GC" secondColor={C.good} secondLabel="GC"
                  userMinDisp={userRanges.MWI.min} userMaxDisp={userRanges.MWI.max} decimals={1}
                  onChangeMin={v => _setRange("MWI", "min", v)}
                  onChangeMax={v => _setRange("MWI", "max", v)}/>
                <TraceChart title="Net Power (MW)" color={C.accent} yKey="MW" fmt={v=>v.toFixed(1)} unit="MW"
                  userMinDisp={userRanges.MW.min} userMaxDisp={userRanges.MW.max} decimals={0}
                  onChangeMin={v => _setRange("MW", "min", v)}
                  onChangeMax={v => _setRange("MW", "max", v)}/>
              </div>
            )}
          </div>
        );
      })()}

      {/* ═════════════════════════════════════════════════════════════════
          2 · USER INPUTS — Air Fraction (editable) + φ (editable) +
          M_Air (derived) + M_Fuel (derived). Compact 4-column per-circuit
          table. W36/W3 knob lives at the top since it's also a user input.
         ═════════════════════════════════════════════════════════════════ */}
      <div style={S.card}>
        <div style={S.cardT}>2 · User Inputs (Air Split & Equivalence Ratio)</div>

        {/* W36/W3 knob */}
        <div style={{padding:"9px 11px",background:`${C.accent}0A`,border:`1px solid ${C.accent}45`,borderRadius:6,marginBottom:10,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
          <div style={{minWidth:160}} title="W36 = mass flow into the combustor dome (i.e. into the four DLE circuits + cooling air). W3 = total compressor exit air (post-bleed). The remaining (1 − W36/W3) is wall cooling air that bypasses the dome. Default 0.75.">
            <div style={{fontSize:10,fontWeight:700,color:C.accent,textTransform:"uppercase",letterSpacing:"1px"}}>W36 / W3</div>
            <div style={{fontSize:9.5,color:C.txtMuted,fontFamily:"monospace",fontStyle:"italic"}}>fraction of W3 → combustor dome</div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:3}}>
            <button onClick={()=>setW36w3(v=>Math.max(0,+(v-0.01).toFixed(4)))} title="Decrease W36/W3 by 0.01" style={{padding:"2px 7px",fontSize:12,fontWeight:700,fontFamily:"monospace",color:C.accent,background:"transparent",border:`1px solid ${C.accent}60`,borderRadius:3,cursor:"pointer",lineHeight:1}}>−</button>
            <NumField value={w36w3} decimals={3} onCommit={v=>setW36w3(Math.max(0,Math.min(1,+v)))}
              style={{width:66,padding:"3px 6px",fontFamily:"monospace",color:C.accent,fontSize:13,fontWeight:700,background:C.bg,border:`1px solid ${C.accent}50`,borderRadius:4,textAlign:"center",outline:"none"}}/>
            <button onClick={()=>setW36w3(v=>Math.min(1,+(v+0.01).toFixed(4)))} title="Increase W36/W3 by 0.01" style={{padding:"2px 7px",fontSize:12,fontWeight:700,fontFamily:"monospace",color:C.accent,background:"transparent",border:`1px solid ${C.accent}60`,borderRadius:3,cursor:"pointer",lineHeight:1}}>+</button>
          </div>
          <div style={{fontSize:11,color:C.txtDim,fontFamily:"monospace"}}>W36 = {fmtMdot(m_air_W36)} {mdotU}</div>
        </div>

        {/* Per-circuit input grid — fixed-width control columns + flexible
            number columns so the inputs hug their headers and there's no
            empty stripe in the Air-Fraction column. */}
        {(() => {
          // Single source of truth for the column template; header + every
          // row use the SAME string so columns line up to the pixel.
          const cols = "minmax(180px, 1.4fr) 150px 130px 1fr 1fr";
          return (
        <div style={{border:`1px solid ${C.border}`,borderRadius:6,overflow:"hidden"}}>
          <div style={{display:"grid",gridTemplateColumns:cols,columnGap:14,background:C.bg2,padding:"7px 12px",fontSize:9.5,color:C.txtDim,fontFamily:"monospace",textTransform:"uppercase",letterSpacing:".6px",alignItems:"center"}}>
            <div>Circuit</div>
            <div style={{textAlign:"center"}}>Air Fraction&nbsp;<span style={{color:C.txtMuted,textTransform:"none",letterSpacing:0}}>(% flame air)</span></div>
            <div style={{textAlign:"center"}}>φ</div>
            <div style={{textAlign:"right"}}>M_Air ({mdotU})</div>
            <div style={{textAlign:"right"}}>M_Fuel ({mdotU})</div>
          </div>
          {[
            ["Inner Pilot (IP)","centerbody pilot",C.strong,fracIP,setFracIP,m_air_IP,phiIP,setPhiIP,0.05,m_fuel_IP_bk,true],
            ["Outer Pilot (OP)","annular pilot",C.orange,fracOP,setFracOP,m_air_OP,phiOP,setPhiOP,0.05,m_fuel_OP_bk,true],
            ["Inner Main (IM)","inner premix",C.accent,fracIM,setFracIM,m_air_IM,phiIM,setPhiIM,0.005,m_fuel_IM_bk,true],
            ["Outer Main (OM)","float circuit",C.accent2,fracOM,setFracOM,m_air_OM,phi_OM,null,0,m_fuel_OM,false],
          ].map(([name,sub,color,frac,setFrac,mAir,phiV,setPhi,step,mFuel,editable])=>(
            <div key={name} style={{display:"grid",gridTemplateColumns:cols,columnGap:14,alignItems:"center",padding:"9px 12px",borderTop:`1px solid ${C.border}`,background:`${color}08`}}>
              <div>
                <div style={{fontSize:12,fontWeight:700,color,letterSpacing:".3px"}}>{name}</div>
                <div style={{fontSize:9.5,color:C.txtMuted,fontFamily:"monospace",fontStyle:"italic"}}>{sub}</div>
              </div>
              <div style={{textAlign:"center"}}>
                <NumField value={frac} decimals={2} onCommit={v=>setFrac(Math.max(0,Math.min(100,+v)))}
                  style={{width:90,padding:"5px 8px",fontSize:13,color,fontFamily:"monospace",fontWeight:700,background:C.bg,border:`1px solid ${color}40`,borderRadius:4,textAlign:"center",outline:"none"}}/>
              </div>
              <div style={{textAlign:"center"}}>
                {editable
                  ? <PhiEditor val={phiV} setVal={setPhi} step={step} color={color}/>
                  : <PhiDisabled val={phiV} color={color}/>}
              </div>
              <div style={{fontSize:13,fontFamily:"monospace",color:C.txt,fontWeight:600,textAlign:"right",fontVariantNumeric:"tabular-nums"}}>{fmtMdot(mAir)}</div>
              <div style={{fontSize:13,fontFamily:"monospace",color:C.accent2,fontWeight:600,textAlign:"right",fontVariantNumeric:"tabular-nums"}}>{fmtMdot(mFuel)}</div>
            </div>
          ))}
          <div style={{padding:"7px 12px",background:C.bg2,borderTop:`1px solid ${C.border}`,fontSize:10.5,color:C.txtMuted,fontFamily:"monospace",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span>Outer Main φ + M_Fuel are back-solved from the total-fuel mass balance.</span>
            <span>Air frac sum: <strong style={{color:Math.abs(sumFrac-100)<0.05?C.accent:C.warm}}>{sumFrac.toFixed(2)} %</strong></span>
          </div>
        </div>
          );
        })()}

        {sumOff?<div style={{marginTop:8,padding:"6px 10px",background:`${C.warm}14`,border:`1px solid ${C.warm}80`,borderRadius:6,fontSize:11,color:C.warm}}>⚠ Air fractions sum to {sumFrac.toFixed(2)} % — should equal 100 %.</div>:null}
        {OMnegFuel?<div style={{marginTop:8,padding:"6px 10px",background:`${C.strong}14`,border:`1px solid ${C.strong}80`,borderRadius:6,fontSize:11,color:C.strong}}>⚠ IP + OP + IM fuel exceeds cycle total — Outer Main went to zero. Reduce pilot/main φ.</div>:null}
        {!OMnegFuel&&OMphiExtreme?<div style={{marginTop:8,padding:"6px 10px",background:`${C.warm}14`,border:`1px solid ${C.warm}80`,borderRadius:6,fontSize:11,color:C.warm}}>⚠ Outer Main φ = {phi_OM.toFixed(3)} is outside the [0.05, 1.5] premixer band.</div>:null}
      </div>

      {/* ═════════════════════════════════════════════════════════════════
          3 · AIR ACCOUNTING & FUEL BALANCE (sanity check)
         ═════════════════════════════════════════════════════════════════ */}
      <div style={S.card}>
        <div style={S.cardT}>3 · Air Accounting & Fuel Balance</div>
        {(() => {
          // Reusable definition row with a dotted leader filling the gap
          // between label and value. Classic typographic technique — turns
          // empty whitespace into intentional pacing.
          const Row = ({label, value, valueColor=C.txt, accentBg, isWarn=false}) => (
            <div style={{
              display:"grid",
              gridTemplateColumns:"auto 1fr auto",
              alignItems:"baseline",
              columnGap:8,
              padding:"5px 10px",
              background:accentBg||C.bg2,
              borderRadius:4,
              fontFamily:"monospace",
              fontSize:11.5,
            }}>
              <span style={{color:C.txtDim,whiteSpace:"nowrap"}}>{label}</span>
              <span style={{
                borderBottom:`1px dotted ${isWarn?C.warm+"60":C.border}`,
                height:0,
                alignSelf:"end",
                marginBottom:4,
              }}/>
              <strong style={{color:valueColor,whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums"}}>{value}</strong>
            </div>
          );
          const SectionHeader = ({label, color}) => (
            <div style={{
              fontSize:10,fontWeight:700,color,textTransform:"uppercase",letterSpacing:"1px",
              marginBottom:6,paddingBottom:4,borderBottom:`1px solid ${color}40`,
            }}>{label}</div>
          );
          return (
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:18}}>
              <div>
                <SectionHeader label={`Air (${mdotU})`} color={C.accent}/>
                <div style={{display:"flex",flexDirection:"column",gap:4}}>
                  <Row label="W3 (post-bleed)" value={fmtMdot(m_air_post_bleed)} valueColor={C.txt}/>
                  <Row label="W36 (dome)" value={fmtMdot(m_air_W36)} valueColor={C.accent} accentBg={`${C.accent}0C`}/>
                  <Row label={`Flame air (${(comAirFrac*100).toFixed(1)} %)`} value={fmtMdot(m_air_flame)} valueColor={C.warm} accentBg={`${C.warm}0C`}/>
                  <Row label="Effusion cooling" value={fmtMdot(m_air_cooling)} valueColor={C.violet} accentBg={`${C.violet}0C`}/>
                </div>
              </div>
              <div>
                <SectionHeader label={`Fuel (${mdotU})`} color={C.accent2}/>
                <div style={{display:"flex",flexDirection:"column",gap:4}}>
                  <Row label="IP + OP + IM" value={fmtMdot(m_fuel_IP_bk+m_fuel_OP_bk+m_fuel_IM_bk)} valueColor={C.txt}/>
                  <Row label="OM (float)" value={fmtMdot(m_fuel_OM)} valueColor={C.accent2} accentBg={`${C.accent2}0C`}/>
                  <Row label="Sum (all 4)" value={fmtMdot(m_fuel_IP_bk+m_fuel_OP_bk+m_fuel_IM_bk+m_fuel_OM)} valueColor={C.accent} accentBg={`${C.accent}0C`}/>
                  <Row label="Cycle total" value={fmtMdot(m_fuel_total)} valueColor={C.accent2} accentBg={`${C.accent2}0C`}/>
                  <Row label="Residual" value={fmtMdot(fuel_residual)}
                    valueColor={Math.abs(fuel_residual)<1e-6?C.accent:C.warm}
                    accentBg={Math.abs(fuel_residual)<1e-6?`${C.accent}0C`:`${C.warm}18`}
                    isWarn={Math.abs(fuel_residual)>=1e-6}/>
                </div>
              </div>
            </div>
          );
        })()}
      </div>

      {/* ═════════════════════════════════════════════════════════════════
          4 · MAPPING TABLES — editable φ(T3) by BRNDMD; auto-fill circuits
         ═════════════════════════════════════════════════════════════════ */}
      <div style={S.card}>
        <div style={S.cardT}>4 · Mapping Tables (φ lookup by T₃ × BRNDMD)</div>

        {/* Current-lookup summary */}
        <div style={{padding:"8px 10px",background:C.bg2,borderRadius:5,border:`1px solid ${C.border}`,marginBottom:10,fontSize:11,fontFamily:"monospace"}}>
          <div style={{color:C.txtDim,fontSize:9.5,textTransform:"uppercase",letterSpacing:".5px",marginBottom:3}}>Active lookup</div>
          <div>
            BRNDMD = <strong style={{color:C.violet}}>{brndmdVal}</strong>
            {brndmdVal<2?<span style={{color:C.warm}}> (no table for BRNDMD ≤ 1 — using BRNDMD=2 table)</span>:null}
            {", "}T₃ = <strong style={{color:C.accent}}>{T3_F_cycle.toFixed(1)} °F</strong>
            {tableLookup?(
              <>  →  φ_OP = <strong style={{color:C.orange}}>{tableLookup.OP.toFixed(3)}</strong>
                , φ_IP = <strong style={{color:C.strong}}>{tableLookup.IP.toFixed(3)}</strong>
                , φ_IM = <strong style={{color:C.accent}}>{tableLookup.IM.toFixed(3)}</strong></>
            ):<span style={{color:C.txtMuted}}> (waiting for cycle)</span>}
          </div>
        </div>

        {/* Tab buttons */}
        <div style={{display:"flex",gap:6,marginBottom:10}}>
          {[7,6,4,2].map(k=>(
            <button key={k} onClick={()=>setTblTab(k)} style={{
              flex:1,padding:"6px 12px",fontSize:11,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".4px",
              color:tblTab===k?C.bg:C.violet,
              background:tblTab===k?C.violet:"transparent",
              border:`1.5px solid ${C.violet}`,
              borderRadius:5,cursor:"pointer",
              display:"flex",alignItems:"center",justifyContent:"center",gap:5}}>
              BRNDMD {k}
              {brndmdVal===k?<span style={{fontSize:8.5,opacity:0.85,fontWeight:500}}>● active</span>:null}
            </button>
          ))}
        </div>

        {/* Editable table of active tab */}
        <div style={{border:`1px solid ${C.border}`,borderRadius:6,overflow:"hidden",maxHeight:360,overflowY:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:11,fontFamily:"monospace"}}>
            <thead style={{position:"sticky",top:0,background:C.bg2,zIndex:1}}>
              <tr>
                <th style={{padding:"6px 8px",textAlign:"center",borderBottom:`1px solid ${C.border}`,color:C.txtDim,fontSize:9.5,textTransform:"uppercase",letterSpacing:".5px"}}>T₃ (°F)</th>
                <th style={{padding:"6px 8px",textAlign:"center",borderBottom:`1px solid ${C.border}`,color:C.orange,fontSize:9.5,textTransform:"uppercase",letterSpacing:".5px"}}>φ_OP</th>
                <th style={{padding:"6px 8px",textAlign:"center",borderBottom:`1px solid ${C.border}`,color:C.strong,fontSize:9.5,textTransform:"uppercase",letterSpacing:".5px"}}>φ_IP</th>
                <th style={{padding:"6px 8px",textAlign:"center",borderBottom:`1px solid ${C.border}`,color:C.accent,fontSize:9.5,textTransform:"uppercase",letterSpacing:".5px"}}>φ_IM</th>
              </tr>
            </thead>
            <tbody>
              {(mappingTables?.[tblTab]||[]).map((row,idx)=>{
                const isActive = brndmdVal===tblTab && tableLookup &&
                  T3_F_cycle>=row.T3-5 && T3_F_cycle<=row.T3+5;
                return(
                  <tr key={idx} style={{background:isActive?`${C.accent}12`:"transparent"}}>
                    <td style={{padding:"3px 6px",textAlign:"center",borderBottom:`1px solid ${C.border}40`}}>
                      <NumField value={row.T3} decimals={0} onCommit={v=>updateCell(tblTab,idx,"T3",v)}
                        style={{width:72,padding:"3px 5px",fontSize:11,fontFamily:"monospace",color:C.accent,fontWeight:600,background:C.bg,border:`1px solid ${C.border}`,borderRadius:3,textAlign:"center",outline:"none"}}/>
                    </td>
                    <td style={{padding:"3px 6px",textAlign:"center",borderBottom:`1px solid ${C.border}40`}}>
                      <NumField value={row.OP} decimals={3} onCommit={v=>updateCell(tblTab,idx,"OP",v)}
                        style={{width:72,padding:"3px 5px",fontSize:11,fontFamily:"monospace",color:C.orange,fontWeight:600,background:C.bg,border:`1px solid ${C.border}`,borderRadius:3,textAlign:"center",outline:"none"}}/>
                    </td>
                    <td style={{padding:"3px 6px",textAlign:"center",borderBottom:`1px solid ${C.border}40`}}>
                      <NumField value={row.IP} decimals={3} onCommit={v=>updateCell(tblTab,idx,"IP",v)}
                        style={{width:72,padding:"3px 5px",fontSize:11,fontFamily:"monospace",color:C.strong,fontWeight:600,background:C.bg,border:`1px solid ${C.border}`,borderRadius:3,textAlign:"center",outline:"none"}}/>
                    </td>
                    <td style={{padding:"3px 6px",textAlign:"center",borderBottom:`1px solid ${C.border}40`}}>
                      <NumField value={row.IM} decimals={3} onCommit={v=>updateCell(tblTab,idx,"IM",v)}
                        style={{width:72,padding:"3px 5px",fontSize:11,fontFamily:"monospace",color:C.accent,fontWeight:600,background:C.bg,border:`1px solid ${C.border}`,borderRadius:3,textAlign:"center",outline:"none"}}/>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={{marginTop:8,display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:10,color:C.txtMuted,fontFamily:"monospace",gap:10}}>
          <span>Edits persist across page reloads (localStorage). Card 2 φ inputs auto-fill from the active lookup; linear interpolation between rows.</span>
          <div style={{display:"flex",gap:6,flexShrink:0}}>
            <button onClick={exportMappingTables}
              title="Export the four BRNDMD lookup tables to a standalone .xlsx — current edits included, T3 in the active unit system."
              style={{padding:"4px 10px",fontSize:10,fontWeight:600,color:C.bg,background:C.accent2,border:`1px solid ${C.accent2}`,borderRadius:4,cursor:"pointer",whiteSpace:"nowrap",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".4px"}}>
              📥 EXPORT TO EXCEL
            </button>
            <button onClick={resetTables}
              title={`Click to load the ${nextResetTarget.toUpperCase()} preset. The button label flips after each click — bimodal switch between the raw factory (UNMAPPED) and the rig-calibrated (MAPPED) lookups.`}
              style={{padding:"4px 10px",fontSize:10,fontWeight:600,color:C.warm,background:"transparent",border:`1px solid ${C.warm}80`,borderRadius:4,cursor:"pointer",whiteSpace:"nowrap",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".4px"}}>
              ↺ RESET TO {nextResetTarget.toUpperCase()}
            </button>
          </div>
        </div>
      </div>

      </>}
  </div>);
}

/* ══════════════════════════════════════════════════════════════════════════
   OPERATIONS SUMMARY PANEL
   --------------------------------------------------------------------------
   First tab. Aggregates the most important operating numbers from the Cycle
   + AFT + Combustor backends into a single glanceable dashboard, then lets
   the user run a load sweep (20 → 100 %) to visualize how every metric
   trends from minimum-stable load to full power at the current ambient +
   fuel + bleed + water settings.

   Headline metrics:
     • Power (MW_net)                          ← cycleResult
     • Load %                                  ← cycleLoad input
     • Bleed % (effective, lost to ambient)    ← bleedAirFrac × 100
     • Fuel / Air / Water mass flow            ← cycleResult
     • T4 (complete-combustion assumption)     ← AFT backend at phi4
     • Thermal efficiency η_LHV                ← cycleResult
     • NOx @ 15% O₂, CO @ 15% O₂ (PFR exit)    ← Combustor backend
     • O₂ dry %, CO₂ dry % (complete-comb. @ T4 conditions)  ← AFT backend dry
═══════════════════════════════════════════════════════════════════════════ */
function OperationsSummaryPanel({
  fuel, ox, Tfuel, WFR=0, waterMode="liquid", T_water,
  tau_psr, L_pfr, V_pfr, heatLossFrac,
  psrSeed, eqConstraint, integration, mechanism,
  cycleResult, bleedAirFrac, bkCycle,
  bkMap,  // shared /calc/combustor_mapping result — NOx15/CO15 from correlation
  // bleed state — needed so the sweep can vary the correct % open at every
  // load (auto schedule) and so the current-load marker shows the actual
  // % open the user has dialled in, not the multiplied "effective" fraction
  bleedMode, bleedOpenPct, bleedOpenManualPct, bleedValveSizePct,
  // cycle sweep args
  cycleEngine, cyclePamb, cycleTamb, cycleRH, cycleLoad, cycleTcool, cycleAirFrac,
  emissionsMode,
  brndmdOverride,
  // Mapping panel state — for per-load NOx15/CO15/BRNDMD in the sweep
  mapW36w3, mapFracIP, mapFracOP, mapFracIM, mapFracOM,
  mappingTables, emTfMults,
}){
  const units=useContext(UnitCtx);
  const {accurate}=useContext(AccurateCtx);
  // Register the load sweep with the global BusyCtx so the prominent top-
  // center "CALCULATIONS IN PROGRESS" overlay appears (exactly like it does
  // for auto-fired useBackendCalc panels). Without this the overlay would
  // stay silent because we call api.calcCycle/api.calcAFT directly.
  const {begin:beginBusy}=useContext(BusyCtx);

  // ── NOx15 / CO15 come from the shared mapping correlation (bkMap) ───────
  // This matches exactly what the Combustor Mapping panel displays because
  // both panels consume the same /calc/combustor_mapping result.
  const NOx_15=bkMap?.data?.correlations?.NOx15||0;
  const CO_15 =bkMap?.data?.correlations?.CO15 ||0;

  // ── T4 (complete-combustion) + equilibrium O2/CO2 at NEW phi ────────────
  // phi_new = total_fuel / ((compressor_air − bleed_air) × FAR_stoich).
  // The compressor-air-minus-bleed is cycle's mdot_air_post_bleed. The O2 /
  // CO2 come from HP-equilibrium at that phi (dry basis). This bypasses the
  // cycle's internal combustor_bypass_frac calibration knob and gives the
  // values that correspond to the physical air+fuel mass balance.
  const T3_K=cycleResult?.T3_K||Tfuel||300;
  const P3_bar=cycleResult?.P3_bar||1;
  const W3_post_bleed=cycleResult?.mdot_air_post_bleed_kg_s||cycleResult?.mdot_air_kg_s||0;
  const mdot_fuel=cycleResult?.mdot_fuel_kg_s||0;
  const FAR_stoich_map=bkMap?.data?.FAR_stoich||0.053;  // fallback if bkMap missing
  const FAR_new=W3_post_bleed>0?(mdot_fuel/W3_post_bleed):0;
  const phi_new=FAR_stoich_map>0?FAR_new/FAR_stoich_map:0;

  // Equilibrium at phi_new: HP equilibrium mole fractions → dry basis for O2/CO2.
  const bkAFT_T4=useBackendCalc("aft",{
    fuel:nonzero(fuel),oxidizer:nonzero(ox),
    phi:phi_new>0?phi_new:0.01, T0:T3_K, P:P3_bar,
    mode:"adiabatic", heat_loss_fraction:0,
    T_fuel_K:Tfuel, T_air_K:T3_K,
    WFR, water_mode:waterMode,
  }, !!(accurate&&cycleResult&&phi_new>0));

  // T4 displayed here is the SAME cycle T4 that the Cycle panel shows —
  // nothing to do with the AFT call at phi_new. Equilibrium firing T, back-
  // solved by cycle.py to hit the deck's T4 target.
  const T4_fromCycle=cycleResult?.T4_K||0;
  // Equilibrium (wet) mole fractions at phi_new, then convert to dry for
  // the O2/CO2 display ONLY (completely independent from T4).
  const eqWet=bkAFT_T4.data?.mole_fractions||{};
  const X_H2O=eqWet.H2O||0;
  const denomDry=Math.max(1e-9,1-X_H2O);
  const O2_pct_T4=(eqWet.O2||0)/denomDry*100;
  const CO2_pct_T4=((eqWet.CO2||0)+(eqWet.CO||0))/denomDry*100;
  // Legacy bkComb retained only for backward-compatibility with the loading
  // banner (the NOx/CO values themselves now come from bkMap, above).
  const bkComb={data:null,loading:false,err:null};

  // ── Sweep state (client-side load sweep) ─────────────────────────────────
  const[sweepData,setSweepData]=useState([]);
  const[sweeping,setSweeping]=useState(false);
  const[sweepProgress,setSweepProgress]=useState(0);
  const[sweepErr,setSweepErr]=useState(null);

  // Auto-bleed schedule — same formula used in App.jsx (keep in sync). In
  // AUTO mode the % open is a continuous function of load. In MANUAL mode
  // the user's bleedOpenManualPct is constant across loads.
  const autoBleedOpenPct=(L)=>{
    if(L<=75)return 100;
    if(L>=95)return 0;
    return 100*(95-L)/20;
  };
  const bleedOpenAtLoad=(L)=>bleedMode==="auto"?autoBleedOpenPct(L):(bleedOpenManualPct??0);

  // ── Mirror the live App-level bkMap call exactly ─────────────────────
  // Two args were drifting and producing curves that disagreed with the
  // header marker:
  //   1. oxidizer — live uses cycleResult.oxidizer_humid_mol_pct (HUMID,
  //      from the cycle's own RH-aware humidification). My old code stripped
  //      H2O from the sidebar oxidizer thinking the mapping wanted dry air —
  //      wrong. Use each per-load cycle's humid oxidizer.
  //   2. com_air_frac — live uses cycleResult.combustor_air_frac (typically
  //      0.89 for LMS100). My old code hardcoded 0.747. Use the prop.
  // Both are already on the per-load cycle result `c` and the sweep props.

  const runSweep=async()=>{
    if(sweeping)return;
    setSweeping(true);setSweepErr(null);setSweepData([]);setSweepProgress(0);
    // Sweep every 5 % for a smoother curve all the way to full load.
    // 17 points × ~1 s per cycle+AFT pair ≈ 17-25 s of wall-clock time.
    const points=[20,25,30,35,40,45,50,55,60,65,70,75,80,85,90,95,100];
    const results=[];
    const endSweepBusy=beginBusy(BUSY_LABELS.load_sweep);
    try{
      for(let i=0;i<points.length;i++){
        const L=points[i];
        const endPtBusy=beginBusy(`Load sweep point ${i+1}/${points.length} — ${L}% load…`);
        try{
          const openAtL=Math.max(0,Math.min(100,bleedOpenAtLoad(L)));
          const bleedAirFracAtL=Math.max(0,Math.min(0.50,(openAtL/100)*((bleedValveSizePct||0)/100)));
          // Cycle — cached. Identical args on a re-run hit the persisted cache instantly.
          const c=await bkCachedFetch("cycle",{
            engine:cycleEngine,
            P_amb_bar:cyclePamb, T_amb_K:cycleTamb, RH_pct:cycleRH,
            load_pct:L,
            T_cool_in_K:cycleEngine==="LMS100PB+"?cycleTcool:null,
            fuel_pct:nonzero(fuel),
            combustor_air_frac:cycleAirFrac,
            T_fuel_K:Tfuel,
            WFR, water_mode:waterMode, T_water_K:WFR>0?T_water:null,
            bleed_air_frac:bleedAirFracAtL,
          });
          const T4_cycle=c.T4_K||0;
          const W3_pb=c.mdot_air_post_bleed_kg_s||c.mdot_air_kg_s||0;
          const m_fuel=c.mdot_fuel_kg_s||0;
          const MW_pt=c.MW_net||0;
          // ── Combustor mapping at THIS load point ─────────────────────
          // BRNDMD per the App-level ladder, mapping-table phi lookup at
          // this load's T3, then the same /calc/combustor_mapping call
          // that the live page makes — driven by per-load T3, P3, MW, W3.
          //
          // Mirror the App-level fallback (App.jsx ~3478, ~3497) so the
          // sweep matches the page exactly:
          //   _tblKey = max(brndmd, 2)  — table only has rows for {2,4,6,7}
          //   tfMult  = emTfMults[_tblKey]  (NOT emTfMults[brndmd])
          const brndmd  = calcBRNDMD(MW_pt, emissionsMode);
          const tblKey  = brndmd >= 2 ? brndmd : 2;
          const tbl     = mappingTables?.[tblKey];
          // interpMappingTable expects T3 in °F (table rows are stored in °F).
          const T3_F    = (c.T3_K - 273.15) * 9/5 + 32;
          const phisAtLoad = tbl ? interpMappingTable(tbl, T3_F) : null;
          const tfMult  = (emTfMults && emTfMults[tblKey]) || {NOx:1.0, CO:1.0, PX36:1.0};
          // Use the same humid oxidizer + combustor_air_frac the live App
          // bkMap call uses. Per-load cycle result c carries both — they don't
          // change with load (RH and air_frac are inputs), but pulling from c
          // keeps everything self-consistent if cycle.py ever modifies them.
          const _oxHumidPt = c.oxidizer_humid_mol_pct;
          const _comAirFracPt = c.combustor_air_frac;
          let NOx15_pt=0, CO15_pt=0, FAR_stoich_pt=0.060;
          try{
            if(W3_pb>0 && m_fuel>0 && _oxHumidPt){
              const m=await bkCachedFetch("combustor_mapping",{
                fuel:nonzero(fuel),
                oxidizer:nonzero(_oxHumidPt),
                T3_K:c.T3_K, P3_bar:c.P3_bar,
                T_fuel_K:Tfuel,
                W3_kg_s:W3_pb,
                W36_over_W3:Math.max(0.01,Math.min(1.0,mapW36w3||0.89)),
                com_air_frac:Math.max(0.01,Math.min(1.0,_comAirFracPt||0.89)),
                frac_IP_pct:mapFracIP, frac_OP_pct:mapFracOP,
                frac_IM_pct:mapFracIM, frac_OM_pct:mapFracOM,
                phi_IP:Math.max(0,phisAtLoad?.IP||0),
                phi_OP:Math.max(0,phisAtLoad?.OP||0),
                phi_IM:Math.max(0,phisAtLoad?.IM||0),
                m_fuel_total_kg_s:m_fuel,
                WFR, water_mode:waterMode,
                nox_mult:tfMult.NOx, co_mult:tfMult.CO, px36_mult:tfMult.PX36??1.0,
              });
              NOx15_pt=m?.correlations?.NOx15||0;
              CO15_pt =m?.correlations?.CO15 ||0;
              FAR_stoich_pt=m?.FAR_stoich||0.060;
            }
          }catch(e){/* leave NOx/CO at 0 if mapping errors at this point */}
          // ── O2/CO2 dry — equilibrium at phi = m_fuel / (W3_pb · FAR_stoich)
          // Uses FAR_stoich from the mapping result above so values match the
          // page header section (which uses bkMap.data.FAR_stoich).
          let O2dry=0, CO2dry=0;
          const phi_eq=(W3_pb>0 && FAR_stoich_pt>0)?(m_fuel/(W3_pb*FAR_stoich_pt)):0;
          try{
            if(phi_eq>0){
              const aft=await bkCachedFetch("aft",{
                fuel:nonzero(fuel),oxidizer:nonzero(ox),
                phi:phi_eq, T0:c.T3_K, P:c.P3_bar,
                mode:"adiabatic", heat_loss_fraction:0,
                T_fuel_K:Tfuel, T_air_K:c.T3_K,
                WFR, water_mode:waterMode,
              });
              const X_H2O=aft.mole_fractions?.H2O||0;
              const den=Math.max(1e-9,1-X_H2O);
              O2dry=((aft.mole_fractions?.O2||0)/den)*100;
              CO2dry=(((aft.mole_fractions?.CO2||0)+(aft.mole_fractions?.CO||0))/den)*100;
            }
          }catch(e){/* leave O2/CO2 at 0 if AFT errors */}
          const m_bleed=c.mdot_bleed_kg_s||0;
          const m_water=c.mdot_water_kg_s||0;
          results.push({
            load:L,
            MW:MW_pt,
            fuel:m_fuel,
            air:W3_pb,
            water:m_water,
            bleed:m_bleed,
            bleed_open:openAtL,
            T4:T4_cycle,
            eta:(c.efficiency_LHV||0)*100,
            O2:O2dry, CO2:CO2dry,
            NOx15:NOx15_pt, CO15:CO15_pt,
            brndmd:brndmd,
          });
          setSweepData([...results]);
          setSweepProgress((i+1)/points.length);
        }finally{
          endPtBusy();
        }
      }
    }catch(e){setSweepErr(e?.message||String(e));}
    endSweepBusy();
    setSweeping(false);
  };

  // ── Visual helpers ───────────────────────────────────────────────────────
  const fmtMdot=k=>units==="SI"?k.toFixed(2)+" kg/s":(k*2.20462).toFixed(1)+" lb/s";
  const fmtT=K=>uv(units,"T",K).toFixed(0)+" "+uu(units,"T");

  // Big hero card with a large centered value. Colors categorise data type.
  const Hero=({label,value,unit,color,tip,small=false,flex=1})=>(
    <div title={tip} style={{flex:`${flex} 1 0`,padding:small?"10px 12px":"14px 16px",
      background:`linear-gradient(135deg,${color}14,${color}03)`,
      border:`1px solid ${color}40`,borderRadius:8,minWidth:small?120:150,
      boxShadow:`inset 0 0 0 1px ${color}08`,position:"relative",overflow:"hidden"}}>
      <div style={{fontSize:9.5,fontWeight:700,color:color,textTransform:"uppercase",
        letterSpacing:"1.3px",marginBottom:small?3:5,opacity:0.9}}>{label}</div>
      <div style={{fontSize:small?22:30,fontWeight:800,color:color,
        fontFamily:"'Barlow Condensed',sans-serif",lineHeight:1,letterSpacing:"-0.5px"}}>
        {value}<span style={{fontSize:small?10:12,fontWeight:500,color:C.txtDim,
          marginLeft:4,letterSpacing:0,fontFamily:"'Barlow',sans-serif"}}>{unit}</span>
      </div>
    </div>);

  // Compact mini chart grid cell — single series Load → metric
  // ── Current operating point — values at the user's current Load% ─────────
  // Displayed as a red marker on every mini-chart so the user sees exactly
  // where their current setting sits on each curve. Prefer live cycle/AFT
  // results (highest fidelity); fall back to linear interpolation of the
  // sweep if needed.
  const currentLoad=cycleResult?.load_pct||cycleLoad||0;
  const mOpenNow=bleedOpenPct??0;
  const mCurrent={
    MW:cycleResult?.MW_net||null,
    eta:cycleResult?(cycleResult.efficiency_LHV*100):null,
    T4:T4_fromCycle||null,
    fuel:cycleResult?.mdot_fuel_kg_s||null,
    air:cycleResult?(cycleResult.mdot_air_post_bleed_kg_s||cycleResult.mdot_air_kg_s||0):null,
    water:cycleResult?.mdot_water_kg_s||null,
    bleed_open:mOpenNow,
    O2:O2_pct_T4||null,
    CO2:CO2_pct_T4||null,
    NOx15:NOx_15||null,
    CO15:CO_15||null,
    brndmd:cycleResult?calcBRNDMD(cycleResult.MW_net, emissionsMode, brndmdOverride):null,
  };

  // Linear interpolation helper for sweep fallback (when live value missing).
  const interpAt=(xArr,yArr,x)=>{
    if(!xArr.length)return null;
    if(x<=xArr[0])return yArr[0];
    if(x>=xArr[xArr.length-1])return yArr[yArr.length-1];
    for(let i=0;i<xArr.length-1;i++){
      if(x>=xArr[i]&&x<=xArr[i+1]){
        const t=(x-xArr[i])/(xArr[i+1]-xArr[i]);
        return yArr[i]+t*(yArr[i+1]-yArr[i]);
      }
    }
    return null;
  };

  // BR-mode bands derived from sweepData[].brndmd transitions. Computed once
  // per sweep and shared across every MiniChart so the bands align exactly.
  const brBands = useMemo(() => brBandsFromSweep(sweepData), [sweepData]);
  // Which BR modes actually appear in the sweep — drives the legend strip
  // (don't show a swatch for a mode the engine never enters at this ambient).
  const activeBRModes = useMemo(() => {
    const s = new Set(sweepData.map(d => d.brndmd).filter(b => BR_PALETTE[b]));
    // Keep the legend in cool→warm order, so it always reads BD7 → BD2.
    return [7,6,4,2].filter(b => s.has(b));
  }, [sweepData]);

  const MiniChart=({title,yKey,color,unit,transformY,currentRaw,step=false})=>{
    if(!sweepData.length)return(<div style={{padding:"32px 10px",textAlign:"center",background:C.bg2,border:`1px dashed ${C.border}`,borderRadius:6,color:C.txtMuted,fontSize:11,fontFamily:"'Barlow',sans-serif"}}>{title}<br/><span style={{fontSize:9.5,fontStyle:"italic"}}>Run sweep to populate</span></div>);
    const plotData=sweepData.map(d=>({load:d.load,y:transformY?transformY(d[yKey]):d[yKey]}));
    const partial=sweepData.length>0&&sweepData[sweepData.length-1].load<100;
    // Current-load red marker. Use the live cycle value if we have it;
    // otherwise interpolate within the sweep. Apply the same unit transform.
    let markerY=(currentRaw!=null&&Number.isFinite(currentRaw))?currentRaw:interpAt(sweepData.map(d=>d.load),sweepData.map(d=>d[yKey]),currentLoad);
    if(markerY!=null&&transformY)markerY=transformY(markerY);
    const marker=(markerY!=null&&Number.isFinite(markerY)&&currentLoad>=20&&currentLoad<=100)?{
      x:currentLoad,
      y:markerY,
      label:`${currentLoad.toFixed(0)}% → ${Math.abs(markerY)>=100?markerY.toFixed(0):Math.abs(markerY)>=10?markerY.toFixed(1):markerY.toFixed(2)}`
    }:null;
    return(<div style={{background:C.bg2,border:`1px solid ${color}30`,borderRadius:6,padding:"10px 12px 4px"}}>
      <div style={{fontSize:11,fontWeight:700,color:color,textTransform:"uppercase",letterSpacing:"0.8px",marginBottom:4,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span>{title}</span>
        {partial?<span style={{fontSize:9,fontWeight:500,color:C.warm,textTransform:"none",letterSpacing:0,fontStyle:"italic"}}>partial — re-run to reach 100%</span>:null}
      </div>
      {/* xMin/xMax pin the x-axis to the full 20-100% span so every chart covers the whole load envelope even if a sweep stopped early. Red marker shows current operating point. BR-mode bands tint the chart background to flag which burner mode the engine is in at each load. */}
      <Chart data={plotData} xK="load" yK="y" xL="Load (%)" yL={unit} color={color} w={680} h={240} xMin={20} xMax={100} marker={marker} markerColor="#EF4444" step={step} bands={brBands}/>
    </div>);
  };

  return(<div style={{display:"flex",flexDirection:"column",gap:12}}>
    <InlineBusyBanner loading={accurate&&(bkCycle?.loading||bkAFT_T4.loading||bkComb.loading)}/>

    <HelpBox title="ℹ️ Operations Summary — What Am I Looking At?">
      <p style={{margin:"0 0 6px"}}>This panel is a <span style={hs.em}>single-glance dashboard</span> of the most important operating numbers at the current sidebar state — net power, firing temperature, efficiency, mass flows, and combustor-exit emissions and composition.</p>
      <p style={{margin:"0 0 6px"}}><span style={hs.em}>You change:</span> nothing on this panel directly. Every number reads from your sidebar inputs (engine, ambient, fuel, bleed, water). Run the Cycle and Combustor Network panels first, then this dashboard summarizes the result.</p>
      <p style={{margin:"0 0 6px"}}><span style={hs.em}>You get:</span> a compact summary card with all of the above, plus a <strong>load sweep</strong> below that reruns the cycle from 20% → 100% load with everything else held — useful for seeing how each metric responds as the engine spools up.</p>
      <p style={{margin:0,fontSize:11,color:C.txtMuted}}>Definitions and modeling assumptions live in the <strong>Assumptions</strong> tab.</p>
    </HelpBox>

    {!cycleResult?
      <div style={{padding:"32px 24px",textAlign:"center",background:C.bg2,border:`1px dashed ${C.warm}50`,borderRadius:10,color:C.txtDim}}>
        <div style={{fontSize:13,fontWeight:600,color:C.warm,marginBottom:8}}>Cycle solution not available</div>
        <div style={{fontSize:11}}>Switch to Gas Turbine Simulator or Advanced Mode via the MODE picker in the header. The cycle must run before the summary can populate.</div>
      </div>
      :<div style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) minmax(0,1fr)",gap:16,alignItems:"start"}}>
      <div style={{display:"flex",flexDirection:"column",gap:12,minWidth:0}}>

      {/* ═══ ROW 1 — TWO BIG HEROES (Power + Fuel Flow) ═══
          The two metrics the operator cares about most. Equal width, big
          fonts, captions underneath. Everything else below this row uses
          the uniform `Hero small` treatment to make clear they're
          consequences of the cycle, not primary control variables. */}
      <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
        {/* Net Shaft Power */}
        <div style={{flex:"1 1 0",minWidth:240,padding:"14px 18px",
          background:`linear-gradient(135deg,${C.accent}22,${C.accent}06)`,
          border:`1.5px solid ${C.accent}70`,borderRadius:10,
          boxShadow:`inset 0 0 0 1px ${C.accent}12`}}>
          <div style={{fontSize:10.5,fontWeight:700,color:C.accent,textTransform:"uppercase",letterSpacing:"2px",marginBottom:6}}>Net Shaft Power</div>
          <div style={{fontSize:44,fontWeight:800,color:C.accent,fontFamily:"'Barlow Condensed',sans-serif",lineHeight:1,letterSpacing:"-1.5px"}}>
            {cycleResult.MW_net.toFixed(1)}
            <span style={{fontSize:18,fontWeight:500,color:C.txtDim,marginLeft:6,letterSpacing:0,fontFamily:"'Barlow',sans-serif"}}>MW</span>
          </div>
          <div style={{fontSize:10,color:C.txtMuted,marginTop:4,fontFamily:"monospace"}}>
            GE {cycleResult.engine}. max on day {cycleResult.MW_max_ambient.toFixed(1)} MW
          </div>
        </div>
        {/* Fuel Flow Rate — primary mass flow that the operator dials */}
        <div style={{flex:"1 1 0",minWidth:240,padding:"14px 18px",
          background:`linear-gradient(135deg,${C.accent2}22,${C.accent2}06)`,
          border:`1.5px solid ${C.accent2}70`,borderRadius:10,
          boxShadow:`inset 0 0 0 1px ${C.accent2}12`}}>
          <div style={{fontSize:10.5,fontWeight:700,color:C.accent2,textTransform:"uppercase",letterSpacing:"2px",marginBottom:6}}>Fuel Flow Rate</div>
          <div style={{fontSize:44,fontWeight:800,color:C.accent2,fontFamily:"'Barlow Condensed',sans-serif",lineHeight:1,letterSpacing:"-1.5px"}}>
            {units==="SI"?cycleResult.mdot_fuel_kg_s.toFixed(3):(cycleResult.mdot_fuel_kg_s*2.20462).toFixed(2)}
            <span style={{fontSize:18,fontWeight:500,color:C.txtDim,marginLeft:6,letterSpacing:0,fontFamily:"'Barlow',sans-serif"}}>{units==="SI"?"kg/s":"lb/s"}</span>
          </div>
          <div style={{fontSize:10,color:C.txtMuted,marginTop:4,fontFamily:"monospace"}}>
            {units==="SI"?(cycleResult.mdot_fuel_kg_s*3600).toFixed(0):(cycleResult.mdot_fuel_kg_s*2.20462*3600).toFixed(0)} {units==="SI"?"kg/hr":"lb/hr"} · post-WFR fuel bump
          </div>
        </div>
      </div>

      {/* ═══ OPERATING POINT — uniform small Hero tier ═══
          Load, T3, P3, T4, η, HR, BRNDMD, Bleed Valve. All same size, same
          padding. Consequences of the cycle solution, not primary inputs. */}
      <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
        <Hero flex={0} small label="Load" value={cycleResult.load_pct.toFixed(0)} unit="%" color={C.accent2}
          tip="Percent of max-on-day power at current ambient conditions. Set in sidebar."/>
        <Hero flex={0} small label="T₃ (comb inlet)" value={uv(units,"T",cycleResult.T3_K).toFixed(0)} unit={uu(units,"T")} color={C.warm}
          tip="Compressor-exit / combustor-inlet temperature. Anchored to 700 °F at 100 % load and 660 °F at 75 % load for LMS100; linearly interpolated between / outside."/>
        <Hero flex={0} small label="P₃" value={units==="SI"?(cycleResult.P3_bar).toFixed(1):(cycleResult.P3_bar*14.5038).toFixed(0)} unit={units==="SI"?"bar":"psia"} color={C.accent3}
          tip="Compressor-exit / combustor-inlet pressure. Drives the pressure-ratio scaling of NOx, CO, and PX36 dynamics via the (P3/638)^exp terms in the correlation."/>
        <Hero flex={0} small label="T₄ (firing)" value={fmtT(T4_fromCycle).split(" ")[0]} unit={uu(units,"T")} color={C.warm}
          tip="Combustor-exit firing temperature from the cycle result — identical to T4 shown on the Cycle panel. Independent from the O2/CO2 calculation below, which uses a separate equilibrium at φ_new = fuel / ((W3 − bleed) × FAR_stoich)."/>
        <Hero flex={0} small label="Thermal Efficiency (LHV)" value={(cycleResult.efficiency_LHV*100).toFixed(2)} unit="%" color={C.good}
          tip="Net shaft power divided by fuel LHV thermal input. Equivalent to 1 / HR in consistent units."/>
        <Hero flex={0} small label="Heat Rate" value={cycleResult.heat_rate_kJ_per_kWh.toFixed(0)} unit="kJ/kWh" color={C.accent3}
          tip="Fuel heat input per unit electrical output. Lower is better."/>
        <Hero flex={0} small label="BRNDMD" value={String(calcBRNDMD(cycleResult.MW_net, emissionsMode, brndmdOverride))} unit="" color={C.violet}
          tip={`Burner mode — piecewise-constant function of net shaft power (MW). Emissions Mode is currently ${emissionsMode?"ENABLED — full ladder 1/2/4/6/7":"DISABLED — holds at 4 for MW > 45"}. Breakpoints (emissions ON): ≤10 → 1, ≤45 → 2, ≤65 → 4, ≤75 → 6, >75 → 7.`}/>
        <Hero flex={0} small label="Bleed Valve" value={(bleedOpenPct||0).toFixed(0)} unit="% open" color={C.orange}
          tip="Bleed valve position — 0 % = closed, 100 % = fully open. Auto schedule: 100 % below 75 % load, 0 % above 95 %, linear between. Effective air dumped = valve % × Max Bleed split %."/>
      </div>

      {/* ═══ MASS FLOWS — fuel removed (now hero); air, bleed, water ═══ */}
      <div>
        <div style={{fontSize:9.5,fontWeight:700,color:C.accent3,textTransform:"uppercase",letterSpacing:"1.2px",margin:"2px 0 6px",paddingBottom:3,borderBottom:`1px solid ${C.accent3}30`}}>Mass Flows</div>
        <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
          <Hero small label="Air (compressor inlet)" value={units==="SI"?cycleResult.mdot_air_kg_s.toFixed(1):(cycleResult.mdot_air_kg_s*2.20462).toFixed(0)} unit={units==="SI"?"kg/s":"lb/s"} color={C.accent}
            tip="Total humid-air mass flow into the compressor."/>
          {(cycleResult.bleed_air_frac||0)>0?
            <Hero small label="Bleed flow" value={units==="SI"?(cycleResult.mdot_bleed_kg_s||0).toFixed(3):((cycleResult.mdot_bleed_kg_s||0)*2.20462).toFixed(2)} unit={units==="SI"?"kg/s":"lb/s"} color={C.orange}
              tip="Air bled from compressor discharge to ambient — lost from the turbine expansion."/>:null}
          {WFR>0?
            <Hero small label="Water inject" value={units==="SI"?(cycleResult.mdot_water_kg_s||0).toFixed(3):((cycleResult.mdot_water_kg_s||0)*2.20462).toFixed(2)} unit={units==="SI"?"kg/s":"lb/s"} color={C.violet}
              tip={`${waterMode==="steam"?"Steam":"Liquid water"} injected into the combustor primary zone. Threads through the turbine as extra mass.`}/>:null}
        </div>
      </div>

      {/* ═══ EMISSIONS (PSR-PFR exit) ═══ */}
      <div>
        <div style={{fontSize:9.5,fontWeight:700,color:C.warm,textTransform:"uppercase",letterSpacing:"1.2px",margin:"2px 0 6px",paddingBottom:3,borderBottom:`1px solid ${C.warm}30`}}>Emissions — PSR/PFR Exit {bkComb.loading?<span style={{fontSize:9,color:C.accent2,marginLeft:6,fontWeight:500,textTransform:"none",letterSpacing:0}}>⟳ updating</span>:bkComb.err?<span style={{fontSize:9,color:C.strong,marginLeft:6,fontWeight:500,textTransform:"none",letterSpacing:0}}>⚠ {bkComb.err}</span>:null}</div>
        <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
          <Hero small label="NOₓ @ 15 % O₂" value={NOx_15.toFixed(1)} unit="ppmvd" color={C.strong}
            tip="Thermal NOx from the Zeldovich mechanism at the PFR exit, corrected to 15 % O₂ dry (regulatory basis). From the Combustor PSR-PFR backend at the current sidebar φ_Bulk, T3, P3, tau_PSR, L_PFR."/>
          <Hero small label="CO @ 15 % O₂" value={CO_15.toFixed(1)} unit="ppmvd" color={C.orange}
            tip="CO burnout value at the PFR exit, corrected to 15 % O₂ dry."/>
        </div>
      </div>

      {/* ═══ EXHAUST COMPOSITION (equilibrium, dry basis) ═══ */}
      <div>
        <div style={{fontSize:9.5,fontWeight:700,color:C.violet,textTransform:"uppercase",letterSpacing:"1.2px",margin:"2px 0 6px",paddingBottom:3,borderBottom:`1px solid ${C.violet}30`}}>Exhaust Composition — Equilibrium, Dry {bkAFT_T4.loading?<span style={{fontSize:9,color:C.accent2,marginLeft:6,fontWeight:500,textTransform:"none",letterSpacing:0}}>⟳ updating</span>:null}</div>
        <div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6,fontFamily:"monospace"}}>
          φ_new = m_fuel / ((W3 − bleed) × FAR_stoich) = {phi_new.toFixed(4)}   (HP equilibrium at T3, P3)
        </div>
        <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
          <Hero small label="O₂ dry" value={O2_pct_T4.toFixed(2)} unit="%" color="#38BDF8"
            tip="Oxygen in exhaust products on a dry basis, from HP equilibrium at the NEW phi based on post-bleed air flow and total fuel flow. Does not use cycle's internal combustor_bypass_frac calibration."/>
          <Hero small label="CO₂ dry" value={CO2_pct_T4.toFixed(2)} unit="%" color={C.warm}
            tip="CO₂ + CO on a dry basis (CO from equilibrium dissociation recombines to CO₂ as stack cools). From HP equilibrium at the new phi."/>
        </div>
      </div>

      </div>

      {/* ═════════════════════════════════════════════════════════════════
          RIGHT HALF — burner-mode visual driven by BRNDMD
            BRNDMD=1 → BD2 (low-load fallback, only IP/OP active)
            BRNDMD=2 → BD2
            BRNDMD=4 → BD4
            BRNDMD=6 → BD4 (same image — only the metric switches)
            BRNDMD=7 → BD7
          Images live in public/burner-modes/ → /burner-modes/BD{N}.png
          when served. If a file is missing the <img onError> swaps in a
          subtle placeholder so the panel never breaks.
         ═════════════════════════════════════════════════════════════════ */}
      {(() => {
        const _br = cycleResult ? calcBRNDMD(cycleResult.MW_net, emissionsMode, brndmdOverride) : null;
        const _imgMap = {1:"BD2", 2:"BD2", 4:"BD4", 6:"BD4", 7:"BD7"};
        const _imgName = _br!=null ? (_imgMap[_br] || "BD2") : null;
        const _imgSrc = _imgName ? `/burner-modes/${_imgName}.png` : null;
        const _modeLabel = {1:"BRNDMD 1 — Sub-idle", 2:"BRNDMD 2 — Pilot only (IP+OP)", 4:"BRNDMD 4 — Pilots + Outer Main", 6:"BRNDMD 6 — Pilots + Both Mains (transitional)", 7:"BRNDMD 7 — Full ladder, all four circuits"}[_br] || "";
        return (
          <div style={{display:"flex",flexDirection:"column",gap:8,minWidth:0}}>
            <div style={{fontSize:9.5,fontWeight:700,color:C.violet,textTransform:"uppercase",letterSpacing:"1.2px",marginBottom:4,paddingBottom:3,borderBottom:`1px solid ${C.violet}30`}}>
              Burner Mode (BRNDMD = {_br??"—"}) — Active Circuits
            </div>
            <div style={{background:C.bg2,border:`1px solid ${C.violet}30`,borderRadius:8,padding:14,display:"flex",flexDirection:"column",alignItems:"center",gap:8}}>
              {_imgSrc?(
                <img src={_imgSrc}
                  alt={`Burner mode ${_imgName} — circuits active at BRNDMD ${_br}`}
                  style={{maxWidth:"100%",maxHeight:480,width:"auto",height:"auto",borderRadius:6,objectFit:"contain"}}
                  onError={(e)=>{
                    e.currentTarget.style.display="none";
                    if(e.currentTarget.nextElementSibling)
                      e.currentTarget.nextElementSibling.style.display="flex";
                  }}/>
              ):null}
              {/* Fallback placeholder — only visible if the image fails to load */}
              <div style={{display:"none",padding:"40px 20px",border:`1.5px dashed ${C.warm}50`,borderRadius:6,color:C.txtDim,fontSize:11,textAlign:"center",fontFamily:"'Barlow',sans-serif",lineHeight:1.5,maxWidth:360}}>
                <div style={{color:C.warm,fontWeight:600,marginBottom:6,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".5px"}}>Burner-mode image not found</div>
                Expected at <code style={{color:C.accent,background:C.bg,padding:"1px 5px",borderRadius:3,fontFamily:"monospace",fontSize:10}}>{_imgSrc}</code>.
                <br/>Drop <code style={{color:C.accent}}>{_imgName}.png</code> into <code style={{color:C.accent}}>public/burner-modes/</code> and re-deploy.
              </div>
              <div style={{fontSize:10.5,color:C.txtDim,fontFamily:"'Barlow',sans-serif",textAlign:"center",lineHeight:1.4,fontStyle:"italic"}}>
                {_modeLabel}
              </div>
            </div>
          </div>
        );
      })()}

      </div>}

    {/* ═══ LOAD SWEEP — full-width below the dashboards ═══ */}
    {cycleResult&&<div style={{...S.card,padding:16,marginTop:14}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div>
          <div style={{...S.cardT,marginBottom:3}}>Load-% Sweep — Variation at Current Operating Conditions</div>
          <div style={{fontSize:10.5,color:C.txtMuted,lineHeight:1.45,fontFamily:"'Barlow',sans-serif",maxWidth:900}}>
            Runs cycle + combustor mapping + Flame-Temp backends at 17 points from 20 % to 100 % load (every 5 %), holding every other parameter fixed (engine, ambient, fuel, bleed, water, mapping table phis, emissions multipliers). NOx<sub>15</sub>/CO<sub>15</sub> are computed by the same correlation used on the Combustor Mapping panel — phi values per circuit are looked up from the mapping table at each load's MW. BRNDMD is the burner-mode ladder evaluated at each load. Re-runs hit the persisted cache and return instantly when no parameter has changed.
          </div>
        </div>
        <button onClick={runSweep} disabled={sweeping||!accurate}
          title={!accurate?"Requires Gas Turbine Simulator or Advanced Mode":sweeping?"Sweep in progress…":"Run a 17-point load sweep (20-100 %) at the current conditions"}
          style={{padding:"10px 18px",fontSize:12,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".5px",
            color:sweeping||!accurate?C.txtMuted:C.bg,
            background:sweeping||!accurate?"transparent":C.accent,
            border:`1.5px solid ${sweeping||!accurate?C.border:C.accent}`,
            borderRadius:6,cursor:sweeping||!accurate?"not-allowed":"pointer",
            display:"flex",alignItems:"center",gap:7,flexShrink:0}}>
          {sweeping?<>
            <span style={{display:"inline-block",width:11,height:11,border:`2px solid ${C.txtMuted}`,borderTopColor:"transparent",borderRadius:"50%",animation:"ctkspin 0.85s linear infinite"}}/>
            RUNNING… {Math.round(sweepProgress*100)}%
          </>:sweepData.length?"▶ RE-RUN SWEEP":"▶ RUN LOAD SWEEP"}
        </button>
      </div>
      {sweepErr?<div style={{padding:"6px 10px",background:`${C.strong}14`,border:`1px solid ${C.strong}60`,borderRadius:4,fontSize:10.5,color:C.strong,marginBottom:10}}>Sweep error: {sweepErr}</div>:null}

      {/* BR-mode legend strip — shared across every chart below. Only shows
          modes that actually appear in the current sweep. Cool→warm reads
          BD7 → BD2 (well-behaved DLE → off-design startup). Each swatch
          shows the load-% range over which that mode is active in this
          ambient/engine combo. */}
      {activeBRModes.length > 0 && (
        <div style={{display:"flex",alignItems:"center",gap:14,flexWrap:"wrap",
          padding:"8px 12px",marginBottom:10,
          background:C.bg2,border:`1px solid ${C.border}`,borderRadius:6,
          fontFamily:"'Barlow',sans-serif"}}
          title="Background tint on every chart below indicates which burner mode the engine is in at that load. Cool teal = BD7 (full DLE, calm). Warm red = BD2 (startup). BD-mode breakpoints depend on engine deck and ambient — re-run the sweep after changing ambient to update the bands.">
          <span style={{fontSize:10,fontWeight:700,color:C.txtDim,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".6px",textTransform:"uppercase"}}>
            Burner mode (BR) bands:
          </span>
          {activeBRModes.map(br => {
            // Find this mode's load-% extent from brBands.
            const segs = brBands.filter(b => b.br === br);
            const lo = Math.min(...segs.map(s => s.x0));
            const hi = Math.max(...segs.map(s => s.x1));
            const pal = BR_PALETTE[br];
            return (
              <div key={br} style={{display:"flex",alignItems:"center",gap:6,fontSize:11}}>
                <span style={{display:"inline-block",width:18,height:12,
                  background:pal.solid,opacity:0.45,
                  border:`1px solid ${pal.solid}`,borderRadius:2}}/>
                <span style={{fontWeight:700,color:pal.solid,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".4px"}}>{pal.label}</span>
                <span style={{color:C.txtMuted,fontFamily:"monospace",fontSize:10}}>
                  {lo.toFixed(0)}–{hi.toFixed(0)} %
                </span>
                <span style={{color:C.txtDim,fontSize:10,fontStyle:"italic"}}>· {pal.desc}</span>
              </div>
            );
          })}
        </div>
      )}

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
        <MiniChart title="Net Power" yKey="MW" color={C.accent} unit={`MW`} currentRaw={mCurrent.MW}/>
        <MiniChart title="Thermal Efficiency (LHV)" yKey="eta" color={C.good} unit="%" currentRaw={mCurrent.eta}/>
        <MiniChart title="T₄ (firing, cycle)" yKey="T4" color={C.warm} unit={uu(units,"T")} transformY={(K)=>uv(units,"T",K)} currentRaw={mCurrent.T4}/>
        <MiniChart title="Fuel flow" yKey="fuel" color={C.accent2} unit={units==="SI"?"kg/s":"lb/s"} transformY={(k)=>units==="SI"?k:k*2.20462} currentRaw={mCurrent.fuel}/>
        <MiniChart title="Air flow (post-bleed)" yKey="air" color={C.accent3} unit={units==="SI"?"kg/s":"lb/s"} transformY={(k)=>units==="SI"?k:k*2.20462} currentRaw={mCurrent.air}/>
        {WFR>0?<MiniChart title="Water inject flow" yKey="water" color={C.violet} unit={units==="SI"?"kg/s":"lb/s"} transformY={(k)=>units==="SI"?k:k*2.20462} currentRaw={mCurrent.water}/>:null}
        <MiniChart title="Bleed Valve — % Open" yKey="bleed_open" color={C.orange} unit="% open" currentRaw={mCurrent.bleed_open}/>
        <MiniChart title="NOₓ @ 15 % O₂ (mapping)" yKey="NOx15" color={C.strong} unit="ppmvd" currentRaw={mCurrent.NOx15}/>
        <MiniChart title="CO @ 15 % O₂ (mapping)" yKey="CO15" color={C.orange} unit="ppmvd" currentRaw={mCurrent.CO15}/>
        <MiniChart title="O₂ dry (equilibrium, post-bleed)" yKey="O2" color="#38BDF8" unit="%" currentRaw={mCurrent.O2}/>
        <MiniChart title="CO₂ dry (equilibrium, post-bleed)" yKey="CO2" color={C.warm} unit="%" currentRaw={mCurrent.CO2}/>
        <MiniChart title="BRNDMD (burner mode)" yKey="brndmd" color={C.violet} unit="" currentRaw={mCurrent.brndmd} step/>
      </div>
    </div>}
  </div>);
}

/* ══════════════════════════════════════════════════════════════════════════
   AUTOMATION RUNNER
   ──────────────────────────────────────────────────────────────────────────
   Per-row execution of the user-defined DoE matrix. Pure async function;
   the panel UI calls it with a config bundle and gets back per-row results.

   For each matrix row:
     1. Apply variable overrides on top of the baseline App state.
     2. Rebalance fuel composition if any fuel.* vars are varied.
     3. Run the selected panels in dependency order (Cycle first, then
        Mapping, then everything else). Cycle's outputs feed downstream
        panels' T3/P3/W3 (this is the "auto-break linkage" behavior — the
        runner replaces sidebar T_air/P with Cycle outputs unless the user
        is varying them, in which case the user's swept values win).
     4. Collect the requested outputs into a flat row dict.

   Errors are caught per-row, never abort the whole matrix. Failed rows go
   into the Excel sheet with an `__error__` column populated.
   ══════════════════════════════════════════════════════════════════════════ */

async function runAutomationMatrix({
  rows, selectedPanels, selectedOutputs, baseline, varSpecs,
  accurate, onProgress, abortRef,
}){
  // Build a quick id→spec map for the variable list (used to look up linkage,
  // unit conversions, etc.).
  const specMap = {};
  for (const s of varSpecs) specMap[s.id] = s;

  // Determine which sidebar variables are being USER-VARIED. When Cycle is
  // selected, the runner normally consumes Cycle's T3/P3/φ_Bulk for the
  // downstream sidebar values — but if the user is sweeping (say) T_air,
  // we honour the user's swept value instead and skip Cycle's T3 override.
  // This is the "auto-break linkage" behaviour.
  const userVarying = new Set(varSpecs.map(s => s.id));
  const breaksLinkT3  = userVarying.has("T_air");
  const breaksLinkP3  = userVarying.has("P");
  const breaksLinkFAR = userVarying.has("phi");

  const results = [];
  const t0 = Date.now();
  for (let i = 0; i < rows.length; i++){
    if (abortRef?.current?.aborted) break;

    const row = rows[i];

    // ── Compose the per-row inputs from baseline + overrides ──
    const inputs = {
      // sidebar
      phi:      override(row, "phi",      baseline.phi),
      T_air:    override(row, "T_air",    baseline.T_air),
      T_fuel:   override(row, "T_fuel",   baseline.T_fuel),
      P:        override(row, "P",        baseline.P),
      WFR:      override(row, "WFR",      baseline.WFR),
      water_mode: override(row, "water_mode", baseline.water_mode),
      // cycle
      engine:   override(row, "engine",   baseline.engine),
      P_amb:    override(row, "P_amb",    baseline.P_amb),
      T_amb:    override(row, "T_amb",    baseline.T_amb),
      RH:       override(row, "RH",       baseline.RH),
      load_pct: override(row, "load_pct", baseline.load_pct),
      T_cool:   override(row, "T_cool",   baseline.T_cool),
      com_air_frac: override(row, "com_air_frac", baseline.com_air_frac),
      bleed_open_pct:       override(row, "bleed_open_pct",       baseline.bleed_open_pct),
      bleed_valve_size_pct: override(row, "bleed_valve_size_pct", baseline.bleed_valve_size_pct),
      emissionsMode:        override(row, "emissionsMode",        baseline.emissionsMode),
      // mapping
      mapW36w3:  override(row, "mapW36w3",  baseline.mapW36w3),
      mapPhiIP:  override(row, "mapPhiIP",  baseline.mapPhiIP),
      mapPhiOP:  override(row, "mapPhiOP",  baseline.mapPhiOP),
      mapPhiIM:  override(row, "mapPhiIM",  baseline.mapPhiIM),
      mapFracIP: override(row, "mapFracIP", baseline.mapFracIP),
      mapFracOP: override(row, "mapFracOP", baseline.mapFracOP),
      mapFracIM: override(row, "mapFracIM", baseline.mapFracIM),
      mapFracOM: override(row, "mapFracOM", baseline.mapFracOM),
      // psr-pfr
      tau_psr: override(row, "tau_psr", baseline.tau_psr),
      L_pfr:   override(row, "L_pfr",   baseline.L_pfr),
      V_pfr:   override(row, "V_pfr",   baseline.V_pfr),
      heatLossFrac: override(row, "heatLossFrac", baseline.heatLossFrac),
      // flame speed
      velocity: override(row, "velocity", baseline.velocity),
      Lchar:    override(row, "Lchar",    baseline.Lchar),
      Dfh:      override(row, "Dfh",      baseline.Dfh),
      Lpremix:  override(row, "Lpremix",  baseline.Lpremix),
      Vpremix:  override(row, "Vpremix",  baseline.Vpremix),
      // exhaust
      measO2:  override(row, "measO2",  baseline.measO2),
      measCO2: override(row, "measCO2", baseline.measCO2),
      // exhaust — slip measurements + fuel/money (η_c block in ExhaustPanel)
      measCO:  override(row, "measCO",  baseline.measCO  ?? 0),
      measUHC: override(row, "measUHC", baseline.measUHC ?? 0),
      measH2:  override(row, "measH2",  baseline.measH2  ?? 0),
      fuelFlowKgs:             override(row, "fuelFlowKgs",             baseline.fuelFlowKgs             ?? 0),
      fuelCostUsdPerMmbtuLhv:  override(row, "fuelCostUsdPerMmbtuLhv",  baseline.fuelCostUsdPerMmbtuLhv  ?? 4.00),
      costPeriod:              baseline.costPeriod || "week",
      // composition
      fuel: rebalanceFuel(baseline.fuel, row, row.__fuelBalance),
      ox:   baseline.ox,
    };

    // ── Operating-point mutex resolution ──
    // φ, FAR, and T_flame are mutually dependent. The catalog's mutex
    // group prevents the user from varying more than one, but we still
    // need to back-solve the canonical phi for whichever the user did
    // pick. After this block, inputs.phi is the truth and downstream
    // panels read from it.
    //
    // ALSO preserve the user's swept input on `inputs` so the Excel
    // writer's picker can find it. The picker reads `inputs[varId]` —
    // for FAR and T_flame those keys are NOT among the standard input
    // fields above (only `phi` is), so without these explicit copies
    // the "INPUT (varied) T_flame" / "INPUT (varied) FAR" columns
    // would be blank in the workbook even though the back-solve fired
    // correctly. Same class of bug as fuel.H2 in an earlier round.
    if (Object.prototype.hasOwnProperty.call(row, "FAR")){
      inputs.FAR = +row.FAR;
      const fp = calcFuelProps(inputs.fuel, inputs.ox);
      const FAR_st = fp.AFR_mass > 0 ? (1 / fp.AFR_mass) : 0.06;
      inputs.phi = (+row.FAR) / Math.max(FAR_st, 1e-9);
    } else if (Object.prototype.hasOwnProperty.call(row, "T_flame")){
      inputs.T_flame = +row.T_flame;
      // Bisect for the lean phi that produces the target T_flame under
      // complete combustion at the current 3-stream mixed inlet. In
      // Accurate Mode use the backend Cantera bisection (one HTTP call
      // per row, ~350 ms — the backend wraps ~15 internal Cantera evals).
      // In Free Mode use JS bisection (instant).
      if (accurate){
        try {
          const r = await bkCachedFetch("solve_phi_tflame", {
            fuel: nonzero(inputs.fuel), oxidizer: nonzero(inputs.ox),
            T_flame_target_K: +row.T_flame,
            T_fuel_K: inputs.T_fuel, T_air_K: inputs.T_air,
            P_bar: atmToBar(inputs.P),
            WFR: inputs.WFR, water_mode: inputs.water_mode,
          });
          inputs.phi = (r && Number.isFinite(r.phi))
            ? r.phi
            : solvePhiForTflame(inputs.fuel, inputs.ox, +row.T_flame, inputs.T_fuel, inputs.T_air);
        } catch (_) {
          inputs.phi = solvePhiForTflame(inputs.fuel, inputs.ox, +row.T_flame, inputs.T_fuel, inputs.T_air);
        }
      } else {
        inputs.phi = solvePhiForTflame(
          inputs.fuel, inputs.ox, +row.T_flame,
          inputs.T_fuel, inputs.T_air,
        );
      }
    }

    // ── Symmetric: always populate the FAR and T_flame inputs even
    //   when they're not the varied variable, so the Excel writer's
    //   "INPUT (fixed) FAR" / "INPUT (fixed) T_flame" columns aren't
    //   blank when something else drives the operating point. Both are
    //   derivable from inputs.phi + composition; we use JS for these
    //   (no extra backend roundtrip) — they're diagnostic columns, not
    //   the canonical sidebar/panel display, so the ~14 °F JS↔Cantera
    //   bias on T_flame is acceptable for fixed-column reporting.
    if (!Object.prototype.hasOwnProperty.call(inputs, "FAR")){
      const _fp = calcFuelProps(inputs.fuel, inputs.ox);
      const _FAR_st = _fp.AFR_mass > 0 ? (1 / _fp.AFR_mass) : 0.06;
      inputs.FAR = inputs.phi * _FAR_st;
    }
    if (!Object.prototype.hasOwnProperty.call(inputs, "T_flame")){
      inputs.T_flame = calcTflameComplete(
        inputs.fuel, inputs.ox, inputs.phi,
        inputs.T_fuel, inputs.T_air,
      );
    }

    let rowState = {};
    let rowError = null;

    try {
      // ── Run Cycle (always, if it's in the panel set; auto-included
      //   when Mapping is selected). ──
      if (selectedPanels.includes("cycle")){
        rowState.cycle = await runCycleForAutomation(inputs, accurate);
        // Override sidebar T_air, P from Cycle outputs UNLESS the user is
        // varying those — that's the "auto-break linkage" behaviour.
        if (rowState.cycle){
          if (!breaksLinkT3 && Number.isFinite(rowState.cycle.T3_K)){
            inputs.T_air = rowState.cycle.T3_K;
          }
          if (!breaksLinkP3 && Number.isFinite(rowState.cycle.P3_bar)){
            inputs.P = rowState.cycle.P3_bar / 1.01325;  // bar → atm
          }
          if (!breaksLinkFAR && Number.isFinite(rowState.cycle.phi_Bulk)){
            inputs.phi = rowState.cycle.phi_Bulk;
          }
        }
      }

      // ── Post-Cycle panels: try ONE batch HTTP call for all selected
      //   panels at once. Falls back to per-panel calls if the batch
      //   endpoint errors (older backend). All adapter logic mirrors the
      //   per-call functions exactly — same args in, same shape out.
      const postCyclePanels = selectedPanels.filter(p =>
        p === "mapping" || p === "aft" || p === "exhaust" ||
        p === "combustor" || p === "flame"
      );
      const batchOutcome = await _runPostCycleBatch(
        postCyclePanels, inputs, rowState.cycle, accurate
      );
      Object.assign(rowState, batchOutcome);

      // Always compute fuel-property "derived" bundle for AFT outputs.
      rowState.derived = calcFuelProps(inputs.fuel, inputs.ox, inputs.T_fuel);
    } catch (e){
      rowError = e?.message || String(e);
      console.warn(`[automation] row ${i+1} failed:`, e);
    }

    // ── Capture the per-row data ──
    // We save the FULL inputs snapshot (after fuel/ox rebalance) and the
    // mapped output values. The Excel writer iterates over every input the
    // selected panels need — varied or fixed — and reads each value from
    // this snapshot. That way the workbook is fully self-describing and
    // reproducible: a reader doesn't need the App's baseline state to know
    // what value was used for any input on any row.
    const outputsForRow = {};
    for (const out of selectedOutputs){
      outputsForRow[out.id] = rowError ? null : out.pick(rowState);
    }
    const outRow = {
      __row__: i + 1,
      __inputs__: inputs,
      __outputs__: outputsForRow,
    };
    if (rowError) outRow.__error__ = rowError;
    results.push(outRow);

    // Progress callback
    const elapsed = (Date.now() - t0) / 1000;
    const eta = i+1 < rows.length ? elapsed * (rows.length / (i+1) - 1) : 0;
    onProgress && onProgress({
      done: i + 1, total: rows.length,
      elapsed, eta, lastRow: outRow,
    });
  }
  return results;
}

function override(row, key, fallback){
  return Object.prototype.hasOwnProperty.call(row, key) ? row[key] : fallback;
}

// ── Build the Cantera-side payload for each post-Cycle panel. Mirrors the
//   `bkCachedFetch(...)` args used by the per-panel runners exactly so the
//   batched call hits the SAME backend cache key as a per-panel call. Kept
//   in one place so any args-tweak only needs to land in two spots
//   (per-panel runner + here) instead of being scattered. ──
function _buildPanelArgs(kind, inp, cycleResult){
  if (kind === "combustor_mapping"){
    if (!cycleResult) return null;
    return {
      fuel: nonzero(inp.fuel),
      oxidizer: nonzero(cycleResult.oxidizer_humid_mol_pct || inp.ox),
      T3_K: cycleResult.T3_K,
      P3_bar: cycleResult.P3_bar,
      T_fuel_K: inp.T_fuel,
      W3_kg_s: cycleResult.mdot_air_post_bleed_kg_s || cycleResult.mdot_air_kg_s,
      W36_over_W3: inp.mapW36w3,
      com_air_frac: cycleResult.combustor_air_frac || inp.com_air_frac,
      frac_IP_pct: inp.mapFracIP,
      frac_OP_pct: inp.mapFracOP,
      frac_IM_pct: inp.mapFracIM,
      frac_OM_pct: inp.mapFracOM,
      phi_IP: inp.mapPhiIP,
      phi_OP: inp.mapPhiOP,
      phi_IM: inp.mapPhiIM,
      m_fuel_total_kg_s: cycleResult.mdot_fuel_kg_s,
      WFR: inp.WFR,
      water_mode: inp.water_mode,
      nox_mult: 1.0, co_mult: 1.0, px36_mult: 1.0,
    };
  }
  if (kind === "aft"){
    return {
      fuel: nonzero(inp.fuel), oxidizer: nonzero(inp.ox),
      phi: inp.phi, T0: inp.T_air, P: atmToBar(inp.P),
      mode: "adiabatic", heat_loss_fraction: 0,
      T_fuel_K: inp.T_fuel, T_air_K: inp.T_air,
      WFR: inp.WFR, water_mode: inp.water_mode,
    };
  }
  if (kind === "exhaust_o2"){
    return {
      fuel: nonzero(inp.fuel), oxidizer: nonzero(inp.ox),
      T0: inp.T_air, P: atmToBar(inp.P),
      measured_O2_pct_dry: inp.measO2,
      combustion_mode: "equilibrium",
      T_fuel_K: inp.T_fuel, T_air_K: inp.T_air,
      WFR: inp.WFR, water_mode: inp.water_mode,
    };
  }
  if (kind === "exhaust_co2"){
    return {
      fuel: nonzero(inp.fuel), oxidizer: nonzero(inp.ox),
      T0: inp.T_air, P: atmToBar(inp.P),
      measured_CO2_pct_dry: inp.measCO2,
      combustion_mode: "equilibrium",
      T_fuel_K: inp.T_fuel, T_air_K: inp.T_air,
      WFR: inp.WFR, water_mode: inp.water_mode,
    };
  }
  if (kind === "combustor"){
    return {
      fuel: nonzero(inp.fuel), oxidizer: nonzero(inp.ox),
      phi: inp.phi, T0: inp.T_air, P: atmToBar(inp.P),
      tau_psr_s: inp.tau_psr / 1000,
      L_pfr_m: inp.L_pfr, V_pfr_m_s: inp.V_pfr,
      profile_points: 30,
      T_fuel_K: inp.T_fuel, T_air_K: inp.T_air,
      psr_seed: "cold_ignited", eq_constraint: "HP",
      integration: "chunked",
      heat_loss_fraction: inp.heatLossFrac,
      mechanism: "gri30",
      WFR: inp.WFR, water_mode: inp.water_mode,
      lean: true,
    };
  }
  if (kind === "flame_speed"){
    return {
      fuel: nonzero(inp.fuel), oxidizer: nonzero(inp.ox),
      phi: inp.phi, T0: inp.T_air, P: atmToBar(inp.P),
      domain_length_m: 0.03,
      T_fuel_K: inp.T_fuel, T_air_K: inp.T_air,
      WFR: inp.WFR, water_mode: inp.water_mode,
      lean: true,
    };
  }
  return null;
}

// Adapt a raw backend response to the canonical shape the AUTO_OUTPUTS
// pickers expect. Matches the inline adapters in the per-panel runners.
function _adaptPanelResponse(slot, r, inp){
  if (slot === "aft"){
    const products = {};
    for (const [sp, x] of Object.entries(r.mole_fractions || {})){
      if (x > 1e-5) products[sp] = x * 100;
    }
    return {
      T_ad: r.T_ad,
      T_ad_complete: r.T_ad_complete,    // Cantera complete-combustion T_ad
      products,
      T_mixed_inlet_K: r.T_mixed_inlet_K,
    };
  }
  if (slot === "exh_o2" || slot === "exh_co2"){
    // Convert backend wet composition (mole fractions) to PERCENT to match
    // the free-mode shape consumed by computeExhaustSlipForRow's atom balance.
    const products = {};
    for (const [sp, x] of Object.entries(r.exhaust_composition_wet || {})){
      if (x > 1e-10) products[sp] = x * 100;
    }
    return {
      phi: r.phi, T_ad: r.T_ad, FAR_mass: r.FAR,
      AFR_mass: (r.FAR && r.FAR > 0) ? 1 / r.FAR : null,
      products,
    };
  }
  if (slot === "psr"){
    return {
      T_psr:           r.T_psr,
      T_exit:          r.T_exit,
      T_ad_equilibrium: r.T_ad_equilibrium,   // Cantera HP equilibrium reference
      T_ad_complete:    r.T_ad_complete,      // Cantera complete-combustion reference
      NO_ppm_psr:      r.NO_ppm_vd_psr,
      NO_ppm_exit:     r.NO_ppm_vd_exit,
      CO_ppm_psr:      r.CO_ppm_vd_psr,
      CO_ppm_exit:     r.CO_ppm_vd_exit,
      NO_ppm_15O2:     r.NO_ppm_15O2,
      CO_ppm_15O2:     r.CO_ppm_15O2,
      O2_pct:          r.O2_pct_dry_exit,
      conv_psr:        r.conv_psr,
      tau_pfr_ms:      r.tau_pfr_ms,
      tau_total_ms:    r.tau_total_ms,
    };
  }
  if (slot === "flame"){
    // Backend gives SL + alpha_th_u + Le_eff/Le_E/Le_D/Ma/Ze/delta_F/nu_u;
    // the rest is JS post-processing (Damköhler, blowoff, ignition margin,
    // flashback margin, Card 1 regime, Card 2 LBO, Card 3 gates) that
    // mirrors runFlameForAutomation exactly. Keep the two in lockstep.
    const Tmix = mixT(inp.fuel, inp.ox, inp.phi, inp.T_fuel, inp.T_air);
    const SL_cms = (r.SL || 0) * 100;
    const SL_ms = SL_cms / 100;
    const alpha_th_u = r.alpha_th_u;
    const tau_chem = (alpha_th_u || 2e-5*Math.pow(Tmix/300,1.7)/inp.P) / Math.max(SL_ms*SL_ms, 1e-20);
    const tau_flow = inp.Lchar / Math.max(inp.velocity, 1e-20);
    const Da = tau_flow / tau_chem;
    const blowoff_velocity = inp.Lchar / tau_chem;
    const stable = Da > 1;
    const tau_BO = inp.Dfh / Math.max(1.5 * SL_ms, 1e-20);
    const alphaTh = alpha_th_u || (2e-5*Math.pow(Tmix/300,1.7)/inp.P);
    const g_c = (SL_ms*SL_ms) / Math.max(alphaTh, 1e-20);
    const tau_ign = (typeof calcTauIgnFree === "function") ? calcTauIgnFree(Tmix, inp.P) : NaN;
    const tau_res = inp.Lpremix / Math.max(inp.Vpremix, 1e-20);
    const ignition_safe = Number.isFinite(tau_ign) && (tau_ign / Math.max(tau_res, 1e-20)) >= 3;
    const H2_frac = (inp.fuel.H2 || 0) / Math.max(Object.values(inp.fuel).reduce((a,b)=>a+(+b||0),0), 1e-9);
    const S_T_est = SL_ms * (H2_frac > 0.30 ? 2.5 : 1.8);
    const flashback_margin = inp.Vpremix / Math.max(S_T_est, 1e-20);
    const core_flashback_safe = flashback_margin > 1/0.7;
    const premixer_safe = ignition_safe && core_flashback_safe;
    // ── Card 1 (Flame Speed & Regime Diagnostics) — Cantera-backed when available ──
    const Le_eff = Number.isFinite(r.Le_eff) ? r.Le_eff : (typeof lewisNumberFreeMode==="function" ? lewisNumberFreeMode(inp.fuel) : 1.0);
    const Le_E = Number.isFinite(r.Le_E) ? r.Le_E : Le_eff;
    const Le_D = Number.isFinite(r.Le_D) ? r.Le_D : Le_eff;
    const Ma = Number.isFinite(r.Ma) ? r.Ma : null;
    const Ze = Number.isFinite(r.Ze) ? r.Ze : null;
    const delta_F = Number.isFinite(r.delta_F) ? r.delta_F : alphaTh / Math.max(SL_ms, 1e-9);
    const nu_u_val = Number.isFinite(r.nu_u) ? r.nu_u : alphaTh / 0.71;
    const _uPrime = 0.10 * Math.max(inp.velocity, 0);
    const _lT = 0.10 * Math.max(inp.Lchar, 1e-6);
    const _b = bradleyST(SL_ms, Math.max(_uPrime, 1e-9), _lT, nu_u_val, Le_eff);
    const ReT_diag = _b.ReT, Ka_diag = _b.Ka, ST_bradley = _b.ST;
    const ST_damkohler = damkohlerST(SL_ms, Math.max(_uPrime, 1e-9));
    const Da_diag = (_lT / Math.max(delta_F, 1e-12)) * (SL_ms / Math.max(_uPrime, 1e-9));
    const borghi_regime = Ka_diag<1 ? (Da_diag>1?"Flamelet":"Corrugated") : Ka_diag<100?"Thin reaction zone":"Broken reaction zone";
    // ── Card 2 (Stabilization & Blowoff) — Lefebvre BAND (LP-sweep) + Plee-Mellor ──
    const _fp_a = (typeof calcFuelProps==="function") ? calcFuelProps(inp.fuel, inp.ox) : null;
    const _K_LBO_x=6.29, _Da_crit_x=0.50, _Sn_x=0.6;
    const _T3_lbo_K = inp.cycle?.T3_K ?? inp.T_air ?? 700.0;
    const _FAR_st = _fp_a ? 1/Math.max(_fp_a.AFR_mass, 1e-12) : 0.0583;
    const _lbo_band = (typeof lefebvreLBO_band==="function" && _fp_a)
      ? lefebvreLBO_band(_K_LBO_x, _T3_lbo_K, _fp_a.LHV_mass, _FAR_st, inp.phi, inp.fuel)
      : { phi_low: NaN, phi_high: NaN, status: "—" };
    const phi_LBO_low = _lbo_band.phi_low;
    const phi_LBO_high = _lbo_band.phi_high;
    const lbo_status = _lbo_band.status;
    const lbo_safe_lefebvre = lbo_status === "SAFE";
    const V_BO_card2 = inp.velocity * Math.max(Da/Math.max(_Da_crit_x,1e-9), 1e-6);
    // Plee-Mellor 1979 cross-check
    const _PM_T_phi = Number.isFinite(r.T_max) ? r.T_max : 1800;
    const _PM_T_in = Math.max(_T3_lbo_K, 1);
    const _PM_EaR = 21000.0/1.987;
    const pm_tau_hc_ms = 1e-4 * (_PM_T_phi/_PM_T_in) * Math.exp(_PM_EaR/Math.max(_PM_T_phi,1));
    const pm_tau_sl_ms = (Math.max(inp.Lchar,1e-9)/Math.max(inp.velocity,1e-9))*1000;
    const pm_ratio = pm_tau_sl_ms / Math.max(pm_tau_hc_ms, 1e-12);
    const pm_lbo_safe = pm_ratio > 2.11;
    // ── Card 3 (Premixer Flashback & Autoignition) — 4 gates ──
    const _D_h_x=0.040, _eps_turb_x=0.7, _RTD_x=1.5;
    const _g_u_pipe = 8 * inp.Vpremix / Math.max(_D_h_x, 1e-6);
    const _g_u_actual = _g_u_pipe * (1 + _eps_turb_x);
    const _T_b_card3 = Number.isFinite(r.T_max) ? r.T_max : 1800;
    const sigma_rho = _T_b_card3 / Math.max(Tmix, 1);
    const confine_correction = (H2_frac > 0.30) ? Math.sqrt(Math.max(sigma_rho, 1)) : 1.0;
    const g_c_eff = g_c * confine_correction;
    const gateA_pass = _g_u_actual > g_c_eff;
    const gateA_margin = _g_u_actual / Math.max(g_c_eff, 1e-9);
    const Ka_flashback = (_g_u_actual>0 && SL_ms>0) ? (_g_u_actual*delta_F)/SL_ms : NaN;
    const _tot_pct = Math.max(Object.values(inp.fuel).reduce((a,b)=>a+(+b||0),0), 1e-9);
    const _H2_pct = ((inp.fuel.H2 || 0)/_tot_pct)*100;
    const _CO_pct = ((inp.fuel.CO || 0)/_tot_pct)*100;
    const _CH4_pct = ((inp.fuel.CH4 || 0)/_tot_pct)*100;
    const shaffer_T_tip = -1.58*_H2_pct - 3.63*_CO_pct - 4.28*_CH4_pct + 0.38*_T_b_card3;
    const piCIVB = SL_ms / Math.max(_Sn_x*Math.max(inp.Vpremix,1e-9)*Math.PI, 1e-12);
    const civb_threshold = (H2_frac>0.30) ? 0.03 : 0.05;
    const gateB_pass = piCIVB < civb_threshold;
    // Gate C: use Bradley S_T (V_premix-based u') to match the panel — NOT
    // the simple SL × 1.8 turb-factor estimator (which is the legacy
    // flashback_margin metric, computed above).
    const _uPrime_premix_a = 0.10 * Math.max(inp.Vpremix, 0);
    const _lT_premix_a     = 0.10 * Math.max(_D_h_x, 1e-6);
    const _bradley_premix_a= bradleyST(SL_ms, Math.max(_uPrime_premix_a, 1e-9), _lT_premix_a, nu_u_val, Le_eff);
    const ST_premix_gateC  = _bradley_premix_a.ST;
    const v_st_margin = inp.Vpremix / Math.max(ST_premix_gateC, 1e-9);
    const gateC_pass = v_st_margin > 1.43;
    const tau_res_99 = _RTD_x * (inp.Lpremix / Math.max(inp.Vpremix, 1e-20));
    const ign_margin_card3 = Number.isFinite(tau_ign) ? tau_ign / Math.max(tau_res_99, 1e-20) : NaN;
    const gateD_pass = Number.isFinite(tau_ign) && ign_margin_card3 >= 3;
    const card3_all_pass = gateA_pass && gateB_pass && gateC_pass && gateD_pass;
    const card3_status = card3_all_pass ? "PASS" : "FAIL";
    return {
      SL_cms, tau_chem_ms: tau_chem * 1000, tau_flow_ms: tau_flow * 1000,
      Da, blowoff_velocity, stable,
      tau_BO_ms: tau_BO * 1000, alpha_th: alphaTh, g_c,
      tau_ign_ms: Number.isFinite(tau_ign) ? tau_ign * 1000 : null,
      tau_res_ms: tau_res * 1000, ignition_safe,
      flashback_margin, core_flashback_safe, premixer_safe,
      // Card 1
      Le_eff, Le_E, Le_D, Ma, Ze, delta_F, nu_u: nu_u_val,
      ReT_diag, Ka_diag, Da_diag, ST_bradley, ST_damkohler, borghi_regime,
      // Card 2
      phi_LBO_low, phi_LBO_high, lbo_status, lbo_safe_lefebvre,
      lbo_fuel_mult: _lbo_band.fuel_mult,
      Da_crit_x: _Da_crit_x, V_BO_card2,
      pm_tau_sl_ms, pm_tau_hc_ms, pm_ratio, pm_lbo_safe,
      // Card 3
      gateA_pass, gateA_margin, Ka_flashback, g_c_eff, shaffer_T_tip,
      piCIVB, civb_threshold, gateB_pass,
      v_st_margin, gateC_pass,
      tau_res_99_ms: tau_res_99 * 1000, ign_margin_card3, gateD_pass,
      card3_status,
    };
  }
  if (slot === "map"){
    // mapping response goes through unchanged (picker reads raw fields).
    return r;
  }
  return r;
}

// ── ONE batch HTTP call wraps all post-Cycle panel jobs for a single row.
//   In Free mode there's nothing to batch (no network); just delegate to
//   the per-panel runners. In Accurate mode we:
//     1. Probe the client cache for each panel — skip jobs that hit.
//     2. Send the misses as a single /calc/batch request.
//     3. Adapt and write each response back into the client cache so
//        downstream rows / re-runs see the same fast path.
//     4. On batch failure (older backend / network error) fall back to
//        per-panel calls — quality is identical, only the per-row HTTP
//        overhead returns.
//   Returns an object with the same keys the previous sequential block
//   wrote into rowState: {map, aft, exh_o2, exh_co2, psr, flame}.
async function _runPostCycleBatch(panels, inp, cycleResult, accurate){
  // Free mode: per-panel JS calls, no network.
  if (!accurate){
    const out = {};
    if (panels.includes("mapping")){
      out.map = await runMappingForAutomation(inp, cycleResult, accurate);
    }
    if (panels.includes("aft")){
      out.aft = await runAFTForAutomation(inp, accurate);
    }
    if (panels.includes("exhaust")){
      const both = await runExhaustForAutomation(inp, accurate);
      out.exh_o2  = both.o2;
      out.exh_co2 = both.co2;
      out.exh_slip = computeExhaustSlipForRow(both, inp, out.cycle, out.map);
    }
    if (panels.includes("combustor")){
      out.psr = await runPSRForAutomation(inp, accurate);
    }
    if (panels.includes("flame")){
      out.flame = await runFlameForAutomation(inp, accurate);
    }
    return out;
  }

  // ── Accurate mode: assemble (slot, kind, args) tuples ──
  // `kind` is the backend route name; `slot` is the rowState key the
  // adapted response is assigned to. Skip mapping if cycle didn't run.
  const planned = [];
  if (panels.includes("mapping") && cycleResult){
    planned.push({ slot: "map", kind: "combustor_mapping", argKind: "combustor_mapping" });
  }
  if (panels.includes("aft")){
    planned.push({ slot: "aft", kind: "aft", argKind: "aft" });
  }
  if (panels.includes("exhaust")){
    planned.push({ slot: "exh_o2",  kind: "exhaust", argKind: "exhaust_o2"  });
    planned.push({ slot: "exh_co2", kind: "exhaust", argKind: "exhaust_co2" });
  }
  if (panels.includes("combustor")){
    planned.push({ slot: "psr", kind: "combustor", argKind: "combustor" });
  }
  if (panels.includes("flame")){
    planned.push({ slot: "flame", kind: "flame_speed", argKind: "flame_speed" });
  }

  if (planned.length === 0) return {};

  // Resolve args + check the client cache. Build the misses-only batch.
  // `bkKind` is the kind passed to bkCachedFetch (uses the legacy short
  // name "flame" for the flame-speed cache, matching per-panel calls).
  const _bkKindFor = (kind) => kind === "flame_speed" ? "flame" : kind;
  const out = {};
  const batchJobs = [];
  const batchMeta = [];   // index-aligned with batchJobs
  for (const p of planned){
    const args = _buildPanelArgs(p.argKind, inp, cycleResult);
    if (args === null){ continue; }
    const cacheKey = _bkCacheKey(_bkKindFor(p.kind), args);
    const cached = __bkCacheGet(cacheKey);
    if (cached){
      try { out[p.slot] = _adaptPanelResponse(p.slot, cached, inp); } catch (_) {}
      continue;
    }
    batchJobs.push({ kind: p.kind, args });
    batchMeta.push({ slot: p.slot, bkKind: _bkKindFor(p.kind), args });
  }

  if (batchJobs.length === 0) return out;

  // Fire ONE HTTP call. On any exception fall back to per-panel runners
  // for the misses — the sequential path is the previous baseline so
  // quality is preserved.
  let resp = null;
  try {
    resp = await api.calcBatch({ jobs: batchJobs });
  } catch (e){
    console.warn("[automation] batch endpoint failed, falling back to per-panel calls:", e);
    return await _runPostCycleSequential(panels, inp, cycleResult, accurate, out);
  }

  const results = (resp && Array.isArray(resp.results)) ? resp.results : [];
  if (results.length !== batchJobs.length){
    console.warn(`[automation] batch returned ${results.length} results for ${batchJobs.length} jobs — falling back`);
    return await _runPostCycleSequential(panels, inp, cycleResult, accurate, out);
  }

  // Assign each result. Per-job failures (e.g. one panel's args were
  // invalid) DON'T abort the row — the slot is left undefined and the
  // output picker returns null.
  for (let i = 0; i < results.length; i++){
    const r = results[i];
    const m = batchMeta[i];
    if (r && r.ok && r.data){
      // Cache the raw response under the same key the per-panel call
      // would use, so a later row with identical args hits the cache
      // even outside of automation.
      try { __bkCacheSet(_bkCacheKey(m.bkKind, m.args), r.data); } catch (_) {}
      try { out[m.slot] = _adaptPanelResponse(m.slot, r.data, inp); }
      catch (e){ console.warn(`[automation] adapter failed for ${m.slot}:`, e); }
    } else {
      console.warn(`[automation] batch job ${m.slot} failed:`, r && r.error);
    }
  }
  // After both exhaust slots are populated (from cache or batch), compute
  // the slip + Fuel & Money block. Same shape as the free-mode runner so
  // AUTO_OUTPUTS pickers don't branch.
  if (panels.includes("exhaust") && out.exh_o2 && out.exh_co2){
    out.exh_slip = computeExhaustSlipForRow({o2: out.exh_o2, co2: out.exh_co2}, inp, out.cycle, out.map);
  }
  return out;
}

// Fallback path: invoke the per-panel runners sequentially. Used when the
// /calc/batch endpoint is unavailable or returns a malformed payload.
// `partial` is the partial output already populated from cache hits — we
// only re-run panels that aren't already in it.
async function _runPostCycleSequential(panels, inp, cycleResult, accurate, partial){
  const out = { ...(partial || {}) };
  if (panels.includes("mapping") && !("map" in out)){
    out.map = await runMappingForAutomation(inp, cycleResult, accurate);
  }
  if (panels.includes("aft") && !("aft" in out)){
    out.aft = await runAFTForAutomation(inp, accurate);
  }
  if (panels.includes("exhaust") && !("exh_o2" in out) && !("exh_co2" in out)){
    const both = await runExhaustForAutomation(inp, accurate);
    out.exh_o2  = both.o2;
    out.exh_co2 = both.co2;
    out.exh_slip = computeExhaustSlipForRow(both, inp, out.cycle, out.map);
  }
  if (panels.includes("combustor") && !("psr" in out)){
    out.psr = await runPSRForAutomation(inp, accurate);
  }
  if (panels.includes("flame") && !("flame" in out)){
    out.flame = await runFlameForAutomation(inp, accurate);
  }
  return out;
}

// ── Per-panel calculation wrappers — pick Free-mode JS or Accurate Cantera
//   based on the `accurate` flag. Each returns a result object whose shape
//   matches what the AUTO_OUTPUTS pickers expect. ──

async function runCycleForAutomation(inp, accurate){
  if (!accurate) {
    // Free mode: cycle is Cantera-only. Return a stub so downstream picks
    // still work; the user is told in the UI that Cycle requires Accurate.
    return null;
  }
  // Compute the actual bleed_air_frac the backend needs, from the user's
  // open % and valve size %. Same formula the rest of the app uses
  // (App.jsx ~4251). Clamped to the backend's [0, 0.5] range.
  const bleed_open  = +inp.bleed_open_pct       || 0;
  const bleed_valve = +inp.bleed_valve_size_pct || 0;
  const bleed_air_frac = Math.max(0, Math.min(0.50,
    (bleed_open / 100) * (bleed_valve / 100)
  ));
  return await bkCachedFetch("cycle", {
    engine: inp.engine,
    P_amb_bar: inp.P_amb,
    T_amb_K:   inp.T_amb,
    RH_pct:    inp.RH,
    load_pct:  inp.load_pct,
    T_cool_in_K: inp.T_cool,
    fuel_pct:  nonzero(inp.fuel),
    T_fuel_K:  inp.T_fuel,
    combustor_air_frac: inp.com_air_frac,
    WFR:       inp.WFR,
    water_mode: inp.water_mode,
    T_water_K: 288.15,
    bleed_air_frac,
  });
}

async function runMappingForAutomation(inp, cycleResult, accurate){
  if (!accurate || !cycleResult) return null;
  return await bkCachedFetch("combustor_mapping", {
    fuel: nonzero(inp.fuel),
    oxidizer: nonzero(cycleResult.oxidizer_humid_mol_pct || inp.ox),
    T3_K:    cycleResult.T3_K,
    P3_bar:  cycleResult.P3_bar,
    T_fuel_K: inp.T_fuel,
    W3_kg_s: cycleResult.mdot_air_post_bleed_kg_s || cycleResult.mdot_air_kg_s,
    W36_over_W3: inp.mapW36w3,
    com_air_frac: cycleResult.combustor_air_frac || inp.com_air_frac,
    // All four circuit air fractions are now driven by the user's baseline /
    // matrix overrides (previously frac_IM_pct was hardcoded to 39.9 and
    // frac_OM_pct was a derived remainder, so user variations of IM/OM had
    // no effect). The backend validates that they sum to 100.
    frac_IP_pct: inp.mapFracIP,
    frac_OP_pct: inp.mapFracOP,
    frac_IM_pct: inp.mapFracIM,
    frac_OM_pct: inp.mapFracOM,
    phi_IP: inp.mapPhiIP,
    phi_OP: inp.mapPhiOP,
    phi_IM: inp.mapPhiIM,
    m_fuel_total_kg_s: cycleResult.mdot_fuel_kg_s,
    WFR: inp.WFR,
    water_mode: inp.water_mode,
    nox_mult: 1.0, co_mult: 1.0, px36_mult: 1.0,
  });
}

async function runAFTForAutomation(inp, accurate){
  if (accurate){
    const r = await bkCachedFetch("aft", {
      fuel: nonzero(inp.fuel), oxidizer: nonzero(inp.ox),
      phi: inp.phi, T0: inp.T_air, P: atmToBar(inp.P),
      mode: "adiabatic", heat_loss_fraction: 0,
      T_fuel_K: inp.T_fuel, T_air_K: inp.T_air,
      WFR: inp.WFR, water_mode: inp.water_mode,
    });
    // Adapt to the same shape calcAFT_EQ returns (products in mol %).
    const products = {};
    for (const [sp, x] of Object.entries(r.mole_fractions || {})){
      if (x > 1e-5) products[sp] = x * 100;
    }
    return {
      T_ad: r.T_ad,
      T_ad_complete: r.T_ad_complete,        // Cantera complete-combustion T_ad
      products,
      T_mixed_inlet_K: r.T_mixed_inlet_K,
    };
  }
  // Free mode: the JS HP equilibrium solver
  const Tmix = mixT(inp.fuel, inp.ox, inp.phi, inp.T_fuel, inp.T_air);
  const r = calcAFT_EQ(inp.fuel, inp.ox, inp.phi, Tmix, inp.P);
  // Free-mode T_ad_complete: use calcTflameComplete (closed-form) so the
  // automation user can plot it even without Accurate mode.
  const T_ad_complete = (typeof calcTflameComplete === "function")
    ? calcTflameComplete(inp.fuel, inp.ox, inp.phi, inp.T_fuel, inp.T_air)
    : null;
  return { T_ad: r.T_ad, T_ad_complete, products: r.products, T_mixed_inlet_K: Tmix };
}

// ── Slip + Fuel & Money block, computed for ONE per-row exhaust result.
// Mirrors ExhaustPanel.computeSlipCorrection (NIST molar LHVs, energy-loss
// formula). Returns the SAME shape we read from in AUTO_OUTPUTS pickers.
// `both` is { o2, co2 } from runExhaustForAutomation. Both halves carry
// {phi, T_ad, FAR_mass, AFR_mass, products} in PERCENT (free + accurate
// shapes are unified upstream).
function computeExhaustSlipForRow(both, inp, cycleResultLocal, mapResultLocal){
  const fuel = inp.fuel || {};
  const ox   = inp.ox   || {};
  const fp   = calcFuelProps(fuel, ox, inp.T_fuel);
  const LHV_CO_kJmol  = 282.99;
  const LHV_CH4_kJmol = 802.31;
  const LHV_H2_kJmol  = 241.83;
  const nC_fuel = (() => {
    let n = 0; const tot = Object.values(fuel).reduce((a,b)=>a+b,0) || 1;
    for (const [sp, x] of Object.entries(fuel)) n += (x/tot) * ((SP[sp]?.C) || 0);
    return n;
  })();
  const LHV_fuel_kJmol = (fp.LHV_mass || 0) * (fp.MW_fuel || 0);
  const co  = Math.max(0, +inp.measCO  || 0);
  const uhc = Math.max(0, +inp.measUHC || 0);
  const h2  = Math.max(0, +inp.measH2  || 0);
  const slipFor = (r) => {
    if (!r) return {eta_c:1, phi_fed:NaN, FAR_fed:NaN, AFR_fed:NaN, slipActive:false};
    if ((co===0 && uhc===0 && h2===0) || !nC_fuel || !LHV_fuel_kJmol)
      return {eta_c:1, phi_fed:r.phi, FAR_fed:r.FAR_mass,
              AFR_fed:(r.AFR_mass ?? ((r.FAR_mass>0)?1/r.FAR_mass:NaN)), slipActive:false};
    const products = r.products || {};
    let X_C = 0;
    for (const [sp, pct] of Object.entries(products)) {
      const C = (SP[sp]?.C) || 0;
      if (C > 0) X_C += (pct/100) * C;
    }
    if (X_C <= 0) return {eta_c:1, phi_fed:r.phi, FAR_fed:r.FAR_mass,
                          AFR_fed:(r.AFR_mass ?? ((r.FAR_mass>0)?1/r.FAR_mass:NaN)), slipActive:false};
    const N_total = nC_fuel / X_C;
    const X_H2O   = (products.H2O || 0) / 100;
    const N_dry   = N_total * (1 - X_H2O);
    const E_loss  = N_dry * 1e-6 * (co*LHV_CO_kJmol + uhc*LHV_CH4_kJmol + h2*LHV_H2_kJmol);
    const eta_c   = Math.max(0.01, Math.min(1, 1 - E_loss / LHV_fuel_kJmol));
    const AFR_b   = r.AFR_mass ?? ((r.FAR_mass>0) ? 1/r.FAR_mass : NaN);
    return {
      eta_c,
      phi_fed: r.phi / eta_c,
      FAR_fed: r.FAR_mass / eta_c,
      AFR_fed: AFR_b * eta_c,
      slipActive: true,
    };
  };
  const sO2  = slipFor(both?.o2);
  const sCO2 = slipFor(both?.co2);
  // T_ad,eff at φ_eff = φ_burn · η_c, evaluated with the local JS Cantera-
  // equivalent (calcAFT_EQ). At zero slip → φ_eff = φ_burn → T_eff = burn-side T.
  const Tflame_eff = (r, eta_c) => {
    if (!r || !Number.isFinite(r.phi)) return NaN;
    const phi_eff = r.phi * (eta_c || 1);
    if (eta_c >= 1) return r.T_ad;
    const Tmix = mixT(fuel, ox, phi_eff, inp.T_fuel, inp.T_air);
    try {
      const eq = calcAFT_EQ(fuel, ox, phi_eff, Tmix, inp.P);
      return eq?.T_ad ?? r.T_ad;
    } catch (_) { return r.T_ad; }
  };
  const T_ad_eff_o2  = Tflame_eff(both?.o2,  sO2.eta_c);
  const T_ad_eff_co2 = Tflame_eff(both?.co2, sCO2.eta_c);
  // Fuel & Money — anchored on O₂ path (matches ExhaustPanel display).
  // Air flow uses FAR_burn ALWAYS (compressor air flow is set by aero;
  // slip is downstream chemistry — does not move ṁ_air).
  const FAR_for_air = both?.o2?.FAR_mass || NaN;
  const fuelFlowKgs = +inp.fuelFlowKgs || 0;
  const fuelCost   = +inp.fuelCostUsdPerMmbtuLhv || 0;
  const air_flow_kg_s = (Number.isFinite(fuelFlowKgs) && Number.isFinite(FAR_for_air) && FAR_for_air > 0)
    ? fuelFlowKgs / FAR_for_air : NaN;
  const heat_input_MW = (fuelFlowKgs > 0 && fp.LHV_mass > 0) ? fuelFlowKgs * fp.LHV_mass : NaN;
  const heat_input_MMBTU_hr = Number.isFinite(heat_input_MW) ? heat_input_MW * 3.41214 : NaN;
  const total_cost_per_hr = (Number.isFinite(heat_input_MMBTU_hr) && fuelCost > 0)
    ? heat_input_MMBTU_hr * fuelCost : NaN;
  const penalty_per_hr_o2  = Number.isFinite(total_cost_per_hr) ? total_cost_per_hr * (1 - sO2.eta_c)  : NaN;
  const penalty_per_hr_co2 = Number.isFinite(total_cost_per_hr) ? total_cost_per_hr * (1 - sCO2.eta_c) : NaN;
  // ── Exhaust linkage block (Phi_Exhaust → O2_dry → CO_linked → UHC_linked) ──
  // Only computable when both Cycle AND Mapping ran in the same row. Mirrors
  // the runtime ExhaustPanel useMemo math exactly so Excel matches the UI.
  // Returns NaN for any row where either runner was absent.
  let phi_exhaust = NaN, o2_dry_at_phi_exhaust = NaN;
  let CO_linked = NaN, UHC_linked = NaN;
  const _mdotFuelCyc = cycleResultLocal?.mdot_fuel_kg_s;
  const _mdotAirCyc  = cycleResultLocal?.mdot_air_post_bleed_kg_s;
  const _mappingCO15 = mapResultLocal?.correlations?.CO15;
  const _FAR_stoich  = 1 / ((fp.AFR_mass) || 1e-12);
  if (Number.isFinite(_mdotFuelCyc) && Number.isFinite(_mdotAirCyc) && _mdotAirCyc > 0){
    phi_exhaust = (_mdotFuelCyc / _mdotAirCyc) / _FAR_stoich;
    if (Number.isFinite(phi_exhaust) && phi_exhaust > 0 && phi_exhaust < 1){
      const _Tmix = mixT(fuel, ox, phi_exhaust, inp.T_fuel, inp.T_air);
      try {
        const _r = calcAFT(fuel, ox, phi_exhaust, _Tmix);
        const _o2w = _r.products?.O2 || 0, _h2ow = _r.products?.H2O || 0;
        const _denom = 1 - _h2ow/100;
        if (_denom > 0) o2_dry_at_phi_exhaust = _o2w / _denom;
        if (Number.isFinite(_mappingCO15) && _mappingCO15 > 0
            && Number.isFinite(o2_dry_at_phi_exhaust) && o2_dry_at_phi_exhaust < 20.9){
          CO_linked  = _mappingCO15 * (20.9 - o2_dry_at_phi_exhaust) / 5.9;
          UHC_linked = CO_linked / 3;
        }
      } catch (_) { /* leave NaN */ }
    }
  }
  // Per-period penalty convenience outputs. The UI defaults to monthly so
  // these are commonly the most useful absolute numbers.
  const penalty_per_month_o2  = Number.isFinite(penalty_per_hr_o2)  ? penalty_per_hr_o2  * 730  : NaN;
  const penalty_per_year_o2   = Number.isFinite(penalty_per_hr_o2)  ? penalty_per_hr_o2  * 8760 : NaN;
  const penalty_per_month_co2 = Number.isFinite(penalty_per_hr_co2) ? penalty_per_hr_co2 * 730  : NaN;
  const penalty_per_year_co2  = Number.isFinite(penalty_per_hr_co2) ? penalty_per_hr_co2 * 8760 : NaN;
  return {
    eta_c_o2: sO2.eta_c, eta_c_co2: sCO2.eta_c,
    phi_fed_o2: sO2.phi_fed, phi_fed_co2: sCO2.phi_fed,
    FAR_fed_o2: sO2.FAR_fed, FAR_fed_co2: sCO2.FAR_fed,
    AFR_fed_o2: sO2.AFR_fed, AFR_fed_co2: sCO2.AFR_fed,
    T_ad_eff_o2, T_ad_eff_co2,
    air_flow_kg_s,
    heat_input_MW,
    total_cost_per_hr,
    penalty_per_hr_o2,
    penalty_per_hr_co2,
    penalty_per_month_o2,  penalty_per_year_o2,
    penalty_per_month_co2, penalty_per_year_co2,
    phi_exhaust, o2_dry_at_phi_exhaust,
    CO_linked, UHC_linked,
  };
}

async function runExhaustForAutomation(inp, accurate){
  if (accurate){
    const r1 = await bkCachedFetch("exhaust", {
      fuel: nonzero(inp.fuel), oxidizer: nonzero(inp.ox),
      T0: inp.T_air, P: atmToBar(inp.P),
      measured_O2_pct_dry: inp.measO2,
      combustion_mode: "equilibrium",
      T_fuel_K: inp.T_fuel, T_air_K: inp.T_air,
      WFR: inp.WFR, water_mode: inp.water_mode,
    });
    const r2 = await bkCachedFetch("exhaust", {
      fuel: nonzero(inp.fuel), oxidizer: nonzero(inp.ox),
      T0: inp.T_air, P: atmToBar(inp.P),
      measured_CO2_pct_dry: inp.measCO2,
      combustion_mode: "equilibrium",
      T_fuel_K: inp.T_fuel, T_air_K: inp.T_air,
      WFR: inp.WFR, water_mode: inp.water_mode,
    });
    // Convert backend wet-composition (mole fractions, 0..1) to % so
    // computeExhaustSlipForRow's atom balance — which mirrors the panel's
    // pct/100 division — works without further branching.
    const _toPct = (x) => {const o={};for(const[s,v]of Object.entries(x||{}))o[s]=(+v||0)*100;return o;};
    return {
      o2:  { phi: r1.phi, T_ad: r1.T_ad, FAR_mass: r1.FAR,
             AFR_mass: (r1.FAR && r1.FAR>0) ? 1/r1.FAR : null,
             products: _toPct(r1.exhaust_composition_wet) },
      co2: { phi: r2.phi, T_ad: r2.T_ad, FAR_mass: r2.FAR,
             AFR_mass: (r2.FAR && r2.FAR>0) ? 1/r2.FAR : null,
             products: _toPct(r2.exhaust_composition_wet) },
    };
  }
  // Free mode: 2-pass JS inversion
  const Tmix0 = mixT(inp.fuel, inp.ox, 0.6, inp.T_fuel, inp.T_air);
  const o2_p0 = calcExhaustFromO2(inp.fuel, inp.ox, inp.measO2, Tmix0, inp.P, "equilibrium");
  const Tmix1 = mixT(inp.fuel, inp.ox, o2_p0.phi, inp.T_fuel, inp.T_air);
  const o2 = calcExhaustFromO2(inp.fuel, inp.ox, inp.measO2, Tmix1, inp.P, "equilibrium");
  const c0 = calcExhaustFromCO2(inp.fuel, inp.ox, inp.measCO2, Tmix0, inp.P, "equilibrium");
  const Tmix2 = mixT(inp.fuel, inp.ox, c0.phi, inp.T_fuel, inp.T_air);
  const co2 = calcExhaustFromCO2(inp.fuel, inp.ox, inp.measCO2, Tmix2, inp.P, "equilibrium");
  return { o2, co2 };
}

async function runPSRForAutomation(inp, accurate){
  if (accurate){
    const r = await bkCachedFetch("combustor", {
      fuel: nonzero(inp.fuel), oxidizer: nonzero(inp.ox),
      phi: inp.phi, T0: inp.T_air, P: atmToBar(inp.P),
      tau_psr_s: inp.tau_psr / 1000,
      L_pfr_m: inp.L_pfr, V_pfr_m_s: inp.V_pfr,
      profile_points: 30,
      T_fuel_K: inp.T_fuel, T_air_K: inp.T_air,
      psr_seed: "cold_ignited", eq_constraint: "HP",
      integration: "chunked",
      heat_loss_fraction: inp.heatLossFrac,
      mechanism: "gri30",
      WFR: inp.WFR, water_mode: inp.water_mode,
      lean: true,  // automation never reads the profile — save ~30 KB / call
    });
    // ── Adapt the backend response to the canonical picker shape ──
    // Backend uses the verbose `_vd_` infix (volumetric dry) for ppm and
    // `_dry_` suffix for O2 percentages. We normalize to short names so the
    // AUTO_OUTPUTS pickers stay simple and free-mode aligned. Same pattern
    // the existing CombustorPanel uses (App.jsx ~1791 backendNet).
    return {
      T_psr:           r.T_psr,
      T_exit:          r.T_exit,
      T_ad_equilibrium: r.T_ad_equilibrium,   // Cantera HP equilibrium reference
      T_ad_complete:    r.T_ad_complete,      // Cantera complete-combustion reference
      NO_ppm_psr:      r.NO_ppm_vd_psr,
      NO_ppm_exit:     r.NO_ppm_vd_exit,
      CO_ppm_psr:      r.CO_ppm_vd_psr,
      CO_ppm_exit:     r.CO_ppm_vd_exit,
      NO_ppm_15O2:     r.NO_ppm_15O2,
      CO_ppm_15O2:     r.CO_ppm_15O2,
      O2_pct:       r.O2_pct_dry_exit,  // post-burnout dry O2
      conv_psr:     r.conv_psr,
      tau_pfr_ms:   r.tau_pfr_ms,
      tau_total_ms: r.tau_total_ms,
    };
  }
  // Free mode: calcCombustorNetwork returns the short names natively, BUT
  // it has no separate PFR-exit T (the JS solver assumes adiabatic PFR, so
  // T at the exit ≡ T_psr). Alias T_exit = T_psr so the picker works.
  const free = calcCombustorNetwork(
    inp.fuel, inp.ox, inp.phi, inp.T_air, inp.P,
    inp.tau_psr, inp.L_pfr, inp.V_pfr, inp.T_fuel, inp.T_air,
  );
  return { ...free, T_exit: free.T_psr };
}

async function runFlameForAutomation(inp, accurate){
  const Tmix = mixT(inp.fuel, inp.ox, inp.phi, inp.T_fuel, inp.T_air);
  let SL_cms, alpha_th_u, _bkResp = {};
  if (accurate){
    try {
      const r = await bkCachedFetch("flame", {
        fuel: nonzero(inp.fuel), oxidizer: nonzero(inp.ox),
        phi: inp.phi, T0: inp.T_air, P: atmToBar(inp.P),
        domain_length_m: 0.03,
        T_fuel_K: inp.T_fuel, T_air_K: inp.T_air,
        WFR: inp.WFR, water_mode: inp.water_mode,
        lean: true,  // skip T_profile + x_profile arrays in response
      });
      SL_cms = (r.SL || 0) * 100;
      alpha_th_u = r.alpha_th_u;
      _bkResp = r;  // keep Le_eff / Le_E / Le_D / Ma / Ze / delta_F / nu_u / T_max
    } catch (_) {
      SL_cms = calcSL(inp.fuel, inp.phi, Tmix, inp.P) * 100;
    }
  } else {
    SL_cms = calcSL(inp.fuel, inp.phi, Tmix, inp.P) * 100;
  }
  const SL_ms = SL_cms / 100;
  const tau_chem = (alpha_th_u || 2e-5*Math.pow(Tmix/300,1.7)/inp.P) / Math.max(SL_ms*SL_ms, 1e-20);
  const tau_flow = inp.Lchar / Math.max(inp.velocity, 1e-20);
  const Da = tau_flow / tau_chem;
  const blowoff_velocity = inp.Lchar / tau_chem;
  const stable = Da > 1;
  const tau_BO = inp.Dfh / Math.max(1.5 * SL_ms, 1e-20);
  const alphaTh = alpha_th_u || (2e-5*Math.pow(Tmix/300,1.7)/inp.P);
  const g_c = (SL_ms*SL_ms) / Math.max(alphaTh, 1e-20);
  const tau_ign = (typeof calcTauIgnFree === "function") ? calcTauIgnFree(Tmix, inp.P) : NaN;
  const tau_res = inp.Lpremix / Math.max(inp.Vpremix, 1e-20);
  const ignition_safe = Number.isFinite(tau_ign) && (tau_ign / Math.max(tau_res, 1e-20)) >= 3;
  const H2_frac = (inp.fuel.H2 || 0) / Math.max(Object.values(inp.fuel).reduce((a,b)=>a+(+b||0),0), 1e-9);
  const S_T_est = SL_ms * (H2_frac > 0.30 ? 2.5 : 1.8);
  const flashback_margin = inp.Vpremix / Math.max(S_T_est, 1e-20);
  const core_flashback_safe = flashback_margin > 1/0.7;
  const premixer_safe = ignition_safe && core_flashback_safe;
  // ── Card 1 (Flame Speed & Regime Diagnostics) ──
  const Le_eff = Number.isFinite(_bkResp.Le_eff) ? _bkResp.Le_eff : (typeof lewisNumberFreeMode==="function" ? lewisNumberFreeMode(inp.fuel) : 1.0);
  const Le_E = Number.isFinite(_bkResp.Le_E) ? _bkResp.Le_E : Le_eff;
  const Le_D = Number.isFinite(_bkResp.Le_D) ? _bkResp.Le_D : Le_eff;
  const Ma = Number.isFinite(_bkResp.Ma) ? _bkResp.Ma : null;
  const Ze = Number.isFinite(_bkResp.Ze) ? _bkResp.Ze : null;
  const delta_F = Number.isFinite(_bkResp.delta_F) ? _bkResp.delta_F : alphaTh / Math.max(SL_ms, 1e-9);
  const nu_u_val = Number.isFinite(_bkResp.nu_u) ? _bkResp.nu_u : alphaTh / 0.71;
  const _uPrime = 0.10 * Math.max(inp.velocity, 0);
  const _lT = 0.10 * Math.max(inp.Lchar, 1e-6);
  const _b = bradleyST(SL_ms, Math.max(_uPrime, 1e-9), _lT, nu_u_val, Le_eff);
  const ReT_diag = _b.ReT, Ka_diag = _b.Ka, ST_bradley = _b.ST;
  const ST_damkohler = damkohlerST(SL_ms, Math.max(_uPrime, 1e-9));
  const Da_diag = (_lT / Math.max(delta_F, 1e-12)) * (SL_ms / Math.max(_uPrime, 1e-9));
  const borghi_regime = Ka_diag<1 ? (Da_diag>1?"Flamelet":"Corrugated") : Ka_diag<100?"Thin reaction zone":"Broken reaction zone";
  // ── Card 2 (Stabilization & Blowoff) — Lefebvre + Plee-Mellor (defaults) ──
  const _fp_a = (typeof calcFuelProps==="function") ? calcFuelProps(inp.fuel, inp.ox) : null;
  const _K_LBO_x=6.29, _Da_crit_x=0.50, _Sn_x=0.6;
  const _T3_lbo_K = inp.cycle?.T3_K ?? inp.T_air ?? 700.0;
  const _FAR_st = _fp_a ? 1/Math.max(_fp_a.AFR_mass, 1e-12) : 0.0583;
  const _lbo_band = (typeof lefebvreLBO_band==="function" && _fp_a)
    ? lefebvreLBO_band(_K_LBO_x, _T3_lbo_K, _fp_a.LHV_mass, _FAR_st, inp.phi, inp.fuel)
    : { phi_low: NaN, phi_high: NaN, status: "—" };
  const phi_LBO_low = _lbo_band.phi_low;
  const phi_LBO_high = _lbo_band.phi_high;
  const lbo_status = _lbo_band.status;
  const lbo_safe_lefebvre = lbo_status === "SAFE";
  const V_BO_card2 = inp.velocity * Math.max(Da/Math.max(_Da_crit_x,1e-9), 1e-6);
  const _PM_T_phi = Number.isFinite(_bkResp.T_max) ? _bkResp.T_max : 1800;
  const _PM_T_in = Math.max(_T3_lbo_K, 1);
  const _PM_EaR = 21000.0/1.987;
  const pm_tau_hc_ms = 1e-4 * (_PM_T_phi/_PM_T_in) * Math.exp(_PM_EaR/Math.max(_PM_T_phi,1));
  const pm_tau_sl_ms = (Math.max(inp.Lchar,1e-9)/Math.max(inp.velocity,1e-9))*1000;
  const pm_ratio = pm_tau_sl_ms / Math.max(pm_tau_hc_ms, 1e-12);
  const pm_lbo_safe = pm_ratio > 2.11;
  // ── Card 3 (Premixer Flashback & Autoignition) — 4 gates ──
  const _D_h_x=0.040, _eps_turb_x=0.7, _RTD_x=1.5;
  const _g_u_pipe = 8 * inp.Vpremix / Math.max(_D_h_x, 1e-6);
  const _g_u_actual = _g_u_pipe * (1 + _eps_turb_x);
  const _T_b_card3 = Number.isFinite(_bkResp.T_max) ? _bkResp.T_max : 1800;
  const sigma_rho = _T_b_card3 / Math.max(Tmix, 1);
  const confine_correction = (H2_frac > 0.30) ? Math.sqrt(Math.max(sigma_rho, 1)) : 1.0;
  const g_c_eff = g_c * confine_correction;
  const gateA_pass = _g_u_actual > g_c_eff;
  const gateA_margin = _g_u_actual / Math.max(g_c_eff, 1e-9);
  const Ka_flashback = (_g_u_actual>0 && SL_ms>0) ? (_g_u_actual*delta_F)/SL_ms : NaN;
  const _tot_pct = Math.max(Object.values(inp.fuel).reduce((a,b)=>a+(+b||0),0), 1e-9);
  const _H2_pct = ((inp.fuel.H2 || 0)/_tot_pct)*100;
  const _CO_pct = ((inp.fuel.CO || 0)/_tot_pct)*100;
  const _CH4_pct = ((inp.fuel.CH4 || 0)/_tot_pct)*100;
  const shaffer_T_tip = -1.58*_H2_pct - 3.63*_CO_pct - 4.28*_CH4_pct + 0.38*_T_b_card3;
  const piCIVB = SL_ms / Math.max(_Sn_x*Math.max(inp.Vpremix,1e-9)*Math.PI, 1e-12);
  const civb_threshold = (H2_frac>0.30) ? 0.03 : 0.05;
  const gateB_pass = piCIVB < civb_threshold;
  // Gate C: use Bradley S_T to match the panel (the simple SL × 1.8
  // estimator is reserved for the legacy flashback_margin metric above).
  const _uPrime_premix_b = 0.10 * Math.max(inp.Vpremix, 0);
  const _lT_premix_b     = 0.10 * Math.max(_D_h_x, 1e-6);
  const _bradley_premix_b= bradleyST(SL_ms, Math.max(_uPrime_premix_b, 1e-9), _lT_premix_b, nu_u_val, Le_eff);
  const ST_premix_gateC  = _bradley_premix_b.ST;
  const v_st_margin = inp.Vpremix / Math.max(ST_premix_gateC, 1e-9);
  const gateC_pass = v_st_margin > 1.43;
  const tau_res_99 = _RTD_x * (inp.Lpremix / Math.max(inp.Vpremix, 1e-20));
  const ign_margin_card3 = Number.isFinite(tau_ign) ? tau_ign / Math.max(tau_res_99, 1e-20) : NaN;
  const gateD_pass = Number.isFinite(tau_ign) && ign_margin_card3 >= 3;
  const card3_status = (gateA_pass && gateB_pass && gateC_pass && gateD_pass) ? "PASS" : "FAIL";
  return {
    SL_cms, tau_chem_ms: tau_chem * 1000, tau_flow_ms: tau_flow * 1000,
    Da, blowoff_velocity, stable,
    tau_BO_ms: tau_BO * 1000, alpha_th: alphaTh, g_c,
    tau_ign_ms: Number.isFinite(tau_ign) ? tau_ign * 1000 : null,
    tau_res_ms: tau_res * 1000, ignition_safe,
    flashback_margin, core_flashback_safe, premixer_safe,
    // Card 1
    Le_eff, Le_E, Le_D, Ma, Ze, delta_F, nu_u: nu_u_val,
    ReT_diag, Ka_diag, Da_diag, ST_bradley, ST_damkohler, borghi_regime,
    // Card 2
    phi_LBO, q_LBO, phi_LBO_margin, lbo_safe_lefebvre,
    Da_crit_x: _Da_crit_x, V_BO_card2,
    pm_tau_sl_ms, pm_tau_hc_ms, pm_ratio, pm_lbo_safe,
    // Card 3
    gateA_pass, gateA_margin, Ka_flashback, g_c_eff, shaffer_T_tip,
    piCIVB, civb_threshold, gateB_pass,
    v_st_margin, gateC_pass,
    tau_res_99_ms: tau_res_99 * 1000, ign_margin_card3, gateD_pass,
    card3_status,
  };
}

// ─────────────────────────────────────────────────────────────────────────
//  Excel writer for automation results.
//  ONE sheet, columns = inputs first then outputs, one row per matrix point.
// ─────────────────────────────────────────────────────────────────────────
function writeAutomationExcel(results, varSpecs, selectedOutputs, runMeta){
  if (!results || results.length === 0) return;
  const wb = XLSX.utils.book_new();
  const units = runMeta.units || "SI";
  const baseline = runMeta.baseline || {};
  const effectivePanels = runMeta.selectedPanels || [];

  // ── Column construction ──
  //
  // Every variable RELEVANT to the selected panels gets its own column,
  // even if the user didn't pick it to vary. Non-varied vars carry the
  // baseline value (the App-level state at the moment Run was clicked) on
  // every row. This way the workbook fully documents what was held fixed
  // for the run — no reader has to back-derive defaults.
  //
  // Fuel and oxidizer compositions are always reported (one column per
  // species that's either non-zero in the baseline OR being varied).
  // Per-row values come from the rebalanced inputs.fuel / inputs.ox so the
  // sheet records the actual mol % used for that row's calculation.

  const variedIds = new Set(varSpecs.map(s => s.id));

  // 1. Scalar input variables relevant to the selected panels, ordered:
  //    varied first (in the user's selection order), then fixed (in catalog
  //    order). Fuel- and oxidizer-species variables are EXCLUDED from this
  //    section — composition is reported in dedicated FUEL / OXIDIZER
  //    sections below where the full per-row composition lives.
  const allRelevant = varsForPanels(effectivePanels);
  const orderedVars = [
    ...varSpecs.filter(s => s.kind !== "fuel_species" && s.kind !== "ox_species"),
    ...allRelevant.filter(v => !variedIds.has(v.id)
                              && v.kind !== "fuel_species"
                              && v.kind !== "ox_species"),
  ];

  const inCols = orderedVars.map(s => ({
    key: s.id,
    name: s.label,
    unit: unitFor(s, units),
    panel: variedIds.has(s.id) ? "INPUT (varied)" : "INPUT (fixed)",
    convert: v => {
      // Booleans and enums pass through formatRowValue directly; numerics
      // get unit conversion (SI → display).
      if (s.kind === "enum" || s.kind === "bool") return v;
      return toDisplay(s, v, units);
    },
    pick: r => {
      const inputs = r.__inputs__ || {};
      return inputs[s.id];
    },
  }));

  // 2. Fuel composition columns — one per species that's either varied or
  //    non-zero in the baseline. Per-row value = inputs.fuel[species].
  const baselineFuel = baseline.fuel || {};
  const fuelSpeciesSet = new Set();
  // Add species that are being varied
  for (const s of varSpecs){
    if (s.kind === "fuel_species" && s.species) fuelSpeciesSet.add(s.species);
  }
  // Add species that have a nonzero baseline mol %
  for (const sp of Object.keys(baselineFuel)){
    if ((+baselineFuel[sp] || 0) > 0) fuelSpeciesSet.add(sp);
  }
  // Stable order: by AUTO_VARS catalog (CH4, C2H6, ...), then any extras
  const fuelOrder = [
    ...AUTO_VARS.filter(v => v.kind === "fuel_species" && fuelSpeciesSet.has(v.species))
      .map(v => v.species),
    ...[...fuelSpeciesSet].filter(sp =>
      !AUTO_VARS.some(v => v.kind === "fuel_species" && v.species === sp)),
  ];
  const fuelCols = fuelOrder.map(sp => {
    const isVaried = varSpecs.some(v => v.kind === "fuel_species" && v.species === sp);
    return {
      key: `fuel.${sp}`,
      name: `Fuel ${sp}`,
      unit: "mol %",
      // The species the user varies is "FUEL (varied)". Other species are
      // labelled just "FUEL" — NOT "fixed" — because their values can move
      // per row when rebalanceFuel adjusts the balance species to keep the
      // composition summing to 100 %.
      panel: isVaried ? "FUEL (varied)" : "FUEL",
      convert: v => v,
      pick: r => {
        const fuel = r.__inputs__?.fuel || {};
        return +fuel[sp] || 0;
      },
    };
  });

  // 3. Oxidizer composition columns — same rule (non-zero baseline, no
  //    user variation supported in the catalog yet). Composition is fixed
  //    across all rows for now (oxidizer isn't a varyable variable).
  const baselineOx = baseline.ox || {};
  const oxSpecies = Object.keys(baselineOx).filter(sp => (+baselineOx[sp] || 0) > 0);
  const oxCols = oxSpecies.map(sp => ({
    key: `ox.${sp}`,
    name: `Oxidizer ${sp}`,
    unit: "mol %",
    // Oxidizer composition is not user-varyable yet; same neutral "OXIDIZER"
    // label as the FUEL section uses for non-varied species.
    panel: "OXIDIZER",
    convert: v => v,
    pick: r => {
      const ox = r.__inputs__?.ox || {};
      return +ox[sp] || 0;
    },
  }));

  // 4. Output columns
  const outCols = selectedOutputs.map(o => ({
    key: `out.${o.id}`,
    name: o.label,
    unit: outputUnitFor(o, units),
    panel: o.panel.toUpperCase(),
    convert: v => outputDisplayValue(o, v, units),
    pick: r => r.__outputs__?.[o.id],
  }));

  const allCols = [
    {key: "__row__", name: "Run #", unit: "", panel: "META",
      convert: v => v, pick: r => r.__row__},
    ...inCols,
    ...fuelCols,
    ...oxCols,
    ...outCols,
    {key: "__error__", name: "Error", unit: "", panel: "META",
      convert: v => v, pick: r => r.__error__ ?? ""},
  ];

  // Three-row header: panel, metric name, unit. Then data rows.
  const header1 = allCols.map(c => c.panel);
  const header2 = allCols.map(c => c.name);
  const header3 = allCols.map(c => c.unit ? `(${c.unit})` : "");
  // Data rows: keep numbers as NUMBERS so Excel applies the per-cell
  // number format and right-aligns naturally. Booleans → "TRUE"/"FALSE".
  // Errors / strings pass through.
  const dataRows = results.map(r => allCols.map(c => {
    const raw = c.convert(c.pick(r));
    if (raw == null) return "";
    if (typeof raw === "boolean") return raw ? "TRUE" : "FALSE";
    if (typeof raw === "number"){
      if (!Number.isFinite(raw)) return "";
      return smartRound(raw, c.unit, c.name);
    }
    return raw;
  }));

  const aoa = [header1, header2, header3, ...dataRows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // ── Auto-fit column widths ──
  // Width = max(panel-header, name-header, unit-header, every data cell)
  // + small padding. Cap at 36 chars so an occasional long error message
  // can't blow out a column to absurd width. Floor at 8 chars so very
  // narrow columns (Run #, blank units) still have a comfortable click
  // area in Excel.
  ws["!cols"] = allCols.map((c, ci) => {
    let maxLen = (c.panel || "").length;
    if (c.name && c.name.length > maxLen) maxLen = c.name.length;
    const unitStr = c.unit ? `(${c.unit})` : "";
    if (unitStr.length > maxLen) maxLen = unitStr.length;
    for (let r = 3; r < aoa.length; r++){
      const v = aoa[r][ci];
      if (v == null) continue;
      const s = String(v).length;
      if (s > maxLen) maxLen = s;
    }
    return { wch: Math.min(36, Math.max(8, maxLen + 2)) };
  });

  // ── Freeze panes ──
  // Top 3 rows (panel / name / unit) AND every column up to and
  // including the last varied column (matched by the "(varied)" tag in
  // the panel header — covers both "INPUT (varied)" and "FUEL (varied)"
  // so a varied fuel species pulls the freeze line out to its column).
  // Run # column is always inside the freeze so the row index travels
  // with the user during horizontal scroll.
  let lastVariedIdx = 0;   // Run # at column 0 stays in the freeze
  for (let i = 0; i < allCols.length; i++){
    if (allCols[i].panel && allCols[i].panel.includes("(varied)")){
      if (i > lastVariedIdx) lastVariedIdx = i;
    }
  }
  const _xSplit = lastVariedIdx + 1;
  const _ySplit = 3;
  // Both forms set: !freeze is the SheetJS legacy property, !views is
  // the canonical OOXML-mapped property that xlsx-js-style serializes
  // into the workbook so Excel actually shows the frozen panes.
  ws["!freeze"] = { xSplit: _xSplit, ySplit: _ySplit };
  ws["!views"] = [{
    state: "frozen",
    xSplit: _xSplit,
    ySplit: _ySplit,
    topLeftCell: XLSX.utils.encode_cell({ c: _xSplit, r: _ySplit }),
    activePane: "bottomRight",
  }];

  // ── Per-cell styling pass ──
  // - First 3 rows: bold + center alignment + light fill so headers stand out.
  // - All cells: thin black border (table-grid look).
  // - Data cells: number format from excelNumberFormat() so the displayed
  //   value matches the project-wide rounding contract while the underlying
  //   cell value remains a true number (sortable, filterable, formula-able).
  // - Numbers right-aligned (Excel default), text left-aligned (override
  //   so meta columns like Run #, Error read consistently).
  const THIN_BORDER = { style: "thin", color: { rgb: "606060" } };
  const ALL_BORDERS = { top: THIN_BORDER, bottom: THIN_BORDER, left: THIN_BORDER, right: THIN_BORDER };
  const HEADER_FILL = { fgColor: { rgb: "1C2128" } };
  const HEADER_FONT = { bold: true, color: { rgb: "F0F6FC" } };
  for (let r = 0; r < aoa.length; r++){
    for (let c = 0; c < allCols.length; c++){
      const addr = XLSX.utils.encode_cell({ c, r });
      const cell = ws[addr];
      if (!cell) continue;
      const isHeader = r < 3;
      const isNumber = typeof cell.v === "number";
      const style = {
        border: ALL_BORDERS,
        // Per user request: center-align EVERY cell horizontally + vertically
        // (headers and data alike). The number-format string still controls
        // displayed precision; alignment just centers the text within the
        // cell box. Numbers stay numeric (sortable / formula-able) — only
        // the visual placement is centered.
        alignment: { horizontal: "center", vertical: "center" },
      };
      if (isHeader){
        style.font = HEADER_FONT;
        style.fill = HEADER_FILL;
      }
      // Apply number format to data-row numeric cells.
      if (!isHeader && isNumber){
        const fmtCode = excelNumberFormat(allCols[c].unit, allCols[c].name, cell.v);
        if (fmtCode) cell.z = fmtCode;
      }
      cell.s = style;
    }
  }

  XLSX.utils.book_append_sheet(wb, ws, "Automation Results");

  // ── Run definition sheet — captures what was run ──
  const def = [
    ["AUTOMATION RUN — Definition"],
    [""],
    ["Generated", new Date().toISOString().slice(0,19)],
    ["Mode", runMeta.accurate ? "Accurate (Cantera)" : "Simple (in-browser JS)"],
    ["Panels selected", runMeta.selectedPanels.join(", ")],
    ["Matrix size", `${results.length} runs`],
    [""],
    ["Variables varied"],
    ["Variable", "Unit", "Mode", "Min", "Max", "Step", "List", "Balance species"],
    ...varSpecs.map(s => {
      const isEnum = s.kind === "enum" || s.kind === "bool";
      const u = unitFor(s, units);
      const dispMin  = s.mode === "list" ? "" : formatRowValue(toDisplay(s, s.min, units));
      const dispMax  = s.mode === "list" ? "" : formatRowValue(toDisplay(s, s.max, units));
      const dispStep = s.mode === "list" ? "" : formatRowValue(toDisplayDelta(s, s.step, units));
      const dispList = Array.isArray(s.list)
        ? s.list.map(v => isEnum ? v : formatRowValue(toDisplay(s, v, units))).join(", ")
        : "";
      return [
        s.id, u,
        s.mode || (isEnum ? "list" : "range"),
        dispMin, dispMax, dispStep, dispList,
        s.balanceSpecies || "",
      ];
    }),
    [""],
    ["Outputs captured"],
    ["Output", "Panel", "Unit"],
    ...selectedOutputs.map(o => [o.label, o.panel, outputUnitFor(o, units)]),
  ];
  const wsDef = XLSX.utils.aoa_to_sheet(def);
  wsDef["!cols"] = [{wch:36},{wch:14},{wch:12},{wch:12},{wch:12},{wch:36},{wch:18}];
  // Bold + bordered styling on the Run Definition section headers
  // (rows whose first cell starts with an uppercase keyword) so the
  // sheet reads as a proper structured report.
  for (let r = 0; r < def.length; r++){
    const firstCell = def[r] && def[r][0];
    const isSectionHeader = typeof firstCell === "string" &&
      /^[A-Z][A-Z\s]+$/.test(firstCell.trim().split(" ")[0] || "");
    for (let c = 0; c < (def[r] || []).length; c++){
      const addr = XLSX.utils.encode_cell({ c, r });
      const cell = wsDef[addr];
      if (!cell) continue;
      const style = {
        border: { top: {style:"thin",color:{rgb:"606060"}}, bottom: {style:"thin",color:{rgb:"606060"}},
                  left: {style:"thin",color:{rgb:"606060"}}, right: {style:"thin",color:{rgb:"606060"}} },
        alignment: { horizontal: "center", vertical: "center" },
      };
      if (r === 0 || isSectionHeader){
        style.font = { bold: true, color: { rgb: "F0F6FC" } };
        style.fill = { fgColor: { rgb: "1C2128" } };
      }
      cell.s = style;
    }
  }
  XLSX.utils.book_append_sheet(wb, wsDef, "Run Definition");

  const filename = `ProReadyEngineer_Automation_${new Date().toISOString().slice(0,16).replace(/[:T-]/g,"")}.xlsx`;
  XLSX.writeFile(wb, filename);
}

/* ══════════════════════════════════════════════════════════════════════════
   PLOT PANEL — visualize the matrix results
   ──────────────────────────────────────────────────────────────────────────
   Two sections:
     1. CUSTOM PLOT — user picks X, Y, and group-by columns from a searchable
        list of varied inputs + captured outputs. Renders a single chart.
     2. AUTO PLOTS  — for every captured output we render N charts (one per
        varied input as the X axis). Series within a chart are grouped by
        the OTHER varied inputs, so each line is a unique combination of
        the held-fixed-this-time values. With N=1 varied input there's one
        series per chart and the legend is hidden.
   Both sections feed the same MultiSeriesChart component. All values are
   converted to display units (SI or ENG) so labels and ticks match the
   user's selection. ══════════════════════════════════════════════════════ */

const PLOT_PALETTE = [
  "#2DD4BF", "#FBBF24", "#60A5FA", "#F87171", "#A78BFA",
  "#4ADE80", "#FB923C", "#EF4444", "#38BDF8", "#FDE68A",
  "#A3E635", "#F472B6",
];

// ─────────────────────────────────────────────────────────────────────────
//  Combustion-engineer priority ranking. Lower rank = higher priority.
//  Drives both the ORDER plots are rendered (most-important first) and
//  which plots are checked by default in the multi-selector. Reflects how
//  a gas-turbine combustion SME reads results: regulated emissions first,
//  then flame temperatures, then stability/blowoff, then ignition, then
//  cycle, then secondary properties, finally O₂/inerts.
//
//  The HUNDREDS digit groups outputs into report categories used as ZIP
//  folder names — see _CATEGORY_LABELS below.
// ─────────────────────────────────────────────────────────────────────────
const _OUTPUT_PRIORITY = {
  // ── Tier 1: Regulated emissions (NOx & CO @ 15% O₂ first) ──
  "NOx_15_psr": 100, "CO_15_psr": 101,
  "NOx15_mapping": 110, "CO15_mapping": 111,
  "exit_NO_ppm": 120, "exit_CO_ppm": 121,
  "psr_NO_ppm": 130, "psr_CO_ppm": 131,
  // ── Tier 2: Flame / combustion temperatures ──
  "T_ad": 200, "T_ad_complete": 201, "Tflame": 210,
  "T_psr": 220, "T_exit": 221,
  "T_ad_equilibrium": 222, "T_ad_complete_comb": 223,
  "T_AFT_IP": 230, "T_AFT_OP": 231, "T_AFT_IM": 232, "T_AFT_OM": 233,
  "T_Bulk": 240, "T4": 241,
  // ── Tier 3: Flame stability / blowoff (S_L, BOT, Da, etc.) ──
  "S_L_cms":           300,
  "blowoff_velocity":  310,
  "tau_BO_ms":         320,   // Zukoski blowoff time
  "Damkohler":         330,
  "g_c":               340,   // Lewis-vE stretch rate
  "stable":            350,
  "premixer_safe":     351,
  "flashback_margin":  352,
  // ── Tier 4: Autoignition / time scales ──
  "tau_ign_ms":     400,
  "tau_res_ms":     410,
  "tau_chem_ms":    420,
  "tau_flow_ms":    430,
  "ignition_safe":  440,
  // ── Tier 5: Cycle performance (MW, η) ──
  "MW_net": 500, "MW_gross": 501, "MW_cap": 502,
  "eta_LHV_pct": 510, "HR": 511,
  "T1": 520, "T2": 521, "T2c": 522, "T3": 523, "T5": 524,
  "W_turb_MW": 530, "W_comp_MW": 531,
  "intercooler_duty": 540,
  "combustor_air_frac": 550,
  "rho_amb": 560,
  // ── Tier 6: Mapping correlations (PX36, ΔT) ──
  "PX36_SEL": 600, "PX36_SEL_HI": 601,
  "DT_Main": 610, "C3_eff_pct": 611,
  "phi_OP_mult": 620, "P3_pressure_ratio": 621,
  // ── Tier 7: Mass flows ──
  "mdot_air": 700, "mdot_fuel": 701, "mdot_bleed": 702, "mdot_water": 703,
  // ── Tier 8: φ / FAR ──
  "phi4": 800, "FAR4": 801, "phi_Bulk": 802, "FAR_Bulk": 803, "phi_OM": 804,
  "exh_phi_from_O2": 810, "exh_phi_from_CO2": 811,
  "exh_AFR_from_O2": 815, "exh_AFR_from_CO2": 816,
  // ── Tier 9: Pressures ──
  "P3": 900, "P_exhaust": 901,
  // ── Tier 10: Fuel properties ──
  "LHV_mass": 1000, "LHV_vol": 1001, "HHV_mass": 1002, "HHV_vol": 1003,
  "MW_fuel": 1004, "SG": 1005,
  "AFR_mass": 1006, "AFR_vol": 1007, "stoichO2": 1008,
  "WI": 1009, "MWI": 1010,
  "LHV_fuel_cycle": 1015,
  "MWI_BTUscf_R": 1020, "MWI_status": 1021, "MWI_derate_pct": 1022,
  "FAR_stoich": 1030,
  // ── Tier 11: Mixed inlet temp & transport ──
  "T_mixed": 1100, "alpha_th": 1110,
  // ── Tier 12: Mole fractions (interesting species first) ──
  "X_NO": 1200, "X_OH": 1201,
  "X_CO": 1210, "X_CO2": 1211, "X_H2O": 1212,
  // ── Tier 13: Conversion / total residence ──
  "conv_psr_pct": 1300,
  "tau_pfr_ms":   1310, "tau_total_ms": 1311,
  // ── Tier 14: Exhaust-derived (rederivable from inputs) ──
  "exh_T_ad_from_O2": 1400, "exh_T_ad_from_CO2": 1401,
  "exh_FAR_from_O2":  1410, "exh_FAR_from_CO2":  1411,
  // ── Tier 15: O₂ / inerts (last — usually a result, not a driver) ──
  "O2_dry_pct": 1500, "X_O2": 1501, "bleed_air_frac": 1510,
};

// Folder name (also used as the report-section heading) for each
// hundreds-digit category in the priority map.
const _CATEGORY_LABELS = {
  1:  "01_emissions",
  2:  "02_flame_temperatures",
  3:  "03_stability_blowoff",
  4:  "04_autoignition",
  5:  "05_cycle_performance",
  6:  "06_mapping_correlations",
  7:  "07_mass_flows",
  8:  "08_phi_FAR",
  9:  "09_pressures",
  10: "10_fuel_properties",
  11: "11_inlet_temps_transport",
  12: "12_mole_fractions",
  13: "13_conversion_residence",
  14: "14_exhaust_inverted",
  15: "15_O2_inerts",
};

// X-axis ranking — when ONE Y output has multiple plots (one per varied
// X), order operating-condition Xs first (φ, T_air, P, …), cycle drivers
// next, then design knobs. This is the engineering "how a SME would walk
// through the results" sequence.
const _INPUT_PRIORITY = {
  "phi": 100, "FAR": 101, "T_flame": 102,
  "T_air": 110, "T_fuel": 111, "P": 112, "WFR": 113, "water_mode": 114,
  "load_pct": 200, "T_amb": 210, "RH": 211, "P_amb": 212,
  "T_cool": 220, "com_air_frac": 221, "engine": 230,
  "bleed_open_pct": 240, "bleed_valve_size_pct": 241,
  "emissionsMode": 250,
  "mapW36w3":  300,
  "mapPhiIP":  310, "mapPhiOP":  311, "mapPhiIM":  312,
  "mapFracIP": 320, "mapFracOP": 321, "mapFracIM": 322, "mapFracOM": 323,
  "tau_psr": 400, "L_pfr": 401, "V_pfr": 402, "heatLossFrac": 403,
  "Lpremix": 500, "Vpremix": 501, "Lchar": 502, "Dfh": 503, "velocity": 510,
  "measO2": 600, "measCO2": 601,
};
function _outputRank(o){
  return _OUTPUT_PRIORITY[o.id] != null ? _OUTPUT_PRIORITY[o.id] : 9999;
}
function _outputCategory(o){
  const r = _outputRank(o);
  if (r >= 9000) return "99_other";
  return _CATEGORY_LABELS[Math.floor(r / 100)] || "99_other";
}
function _inputRank(varSpec){
  if (varSpec.kind === "fuel_species") return 800;
  if (varSpec.kind === "ox_species")   return 810;
  return _INPUT_PRIORITY[varSpec.id] != null ? _INPUT_PRIORITY[varSpec.id] : 9999;
}

// Strip filesystem-unsafe characters and collapse whitespace. Used for both
// PNG download names and ZIP entry names (jszip doesn't sanitize).
function _sanitizeFilename(s){
  return String(s)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/[^\w\s.\-+%₂₃₄]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 100);
}

// Trigger a browser download for a Blob. Uses an off-DOM anchor so it
// works on every modern browser without a file-saver dependency.
function _triggerBlobDownload(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Convert a MultiSeriesChart props bundle to a self-contained SVG string.
// Uses ReactDOMServer's static markup renderer so we get the exact same
// chart the user is looking at — zero divergence between on-screen and
// exported plots. Adds the SVG namespace explicitly (some browsers reject
// canvas drawImage on SVG without xmlns even if React rendered without).
function _chartSpecToSvgString(spec){
  let s = renderToStaticMarkup(<MultiSeriesChart {...spec}/>);
  if (!s.includes('xmlns="http://www.w3.org/2000/svg"')){
    s = s.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return s;
}

// Wrap a chart SVG with a title + (optional) subtitle bar at the top so
// every PNG export carries the same context the on-screen panel shows
// above its chart — what's plotted, what's grouped, what's held constant.
// Returns a fresh SVG string with width = w and height = h + headerH;
// the caller passes that taller height to _svgStringToPngBlob so the
// canvas matches.
function _wrapChartWithHeader(chartSvg, w, h, title, subtitle){
  const HEADER_H = subtitle ? 52 : 32;
  const totalH = h + HEADER_H;
  // Strip the chart's outer <svg> wrapper so we can nest it inside the
  // composed parent SVG via a <g transform="translate(...)">.
  const inner = chartSvg
    .replace(/^<svg[^>]*>/, "")
    .replace(/<\/svg>$/, "");
  // XML-escape title / subtitle so ampersands, angle brackets, etc.
  // don't break the SVG when it hits the canvas rasterizer.
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const titleY = subtitle ? 22 : 22;
  const subtitleY = 41;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${totalH}" width="${w}" height="${totalH}">
<rect x="0" y="0" width="${w}" height="${totalH}" fill="${C.bg}"/>
<text x="${w/2}" y="${titleY}" fill="${C.accent}" font-size="14" font-family="'Barlow Condensed',sans-serif" font-weight="700" text-anchor="middle" letter-spacing=".5px">${esc(title)}</text>
${subtitle ? `<text x="${w/2}" y="${subtitleY}" fill="${C.txtDim}" font-size="11" font-family="'Barlow',sans-serif" text-anchor="middle">${esc(subtitle)}</text>` : ""}
<g transform="translate(0,${HEADER_H})">${inner}</g>
</svg>`;
}

// CRC32 over a byte slice — used to compute the PNG chunk CRC when we
// inject a pHYs (physical pixel dimensions) chunk for DPI metadata.
// Standard PNG/zlib polynomial. Cached lookup table for speed.
const _PNG_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++){
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function _crc32(bytes){
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = _PNG_CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Inject a pHYs chunk into the PNG byte stream so PowerPoint, Word, and
// other consumers know the print resolution. Without this they assume 96
// DPI and shrink the image accordingly when placed in a document.
//   pHYs chunk format (PNG spec 11.3.5.3):
//     4 bytes — pixels per unit X-axis (big-endian unsigned 32-bit)
//     4 bytes — pixels per unit Y-axis (big-endian unsigned 32-bit)
//     1 byte  — unit specifier (0 = unknown, 1 = meter)
//   For 300 DPI: ppm = 300 × 39.3701 = 11811
async function _addPngDpi(blob, dpi){
  const buf = new Uint8Array(await blob.arrayBuffer());
  const ppm = Math.round(dpi * 39.3701);
  // Find IHDR chunk end so we insert pHYs immediately after it (before IDAT).
  // PNG header = 8 bytes signature, then chunks: [4 length][4 type][N data][4 crc].
  // IHDR is always the first chunk → starts at byte 8, length is 13, total 8+4+4+13+4 = 33.
  const insertAt = 33;
  // Build pHYs chunk
  const dataBytes = new Uint8Array(9);
  const dv = new DataView(dataBytes.buffer);
  dv.setUint32(0, ppm, false);
  dv.setUint32(4, ppm, false);
  dv.setUint8(8, 1);  // unit = meters
  const typeBytes = new Uint8Array([0x70, 0x48, 0x59, 0x73]);  // "pHYs"
  const crcInput = new Uint8Array(typeBytes.length + dataBytes.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(dataBytes, typeBytes.length);
  const crc = _crc32(crcInput);
  const chunk = new Uint8Array(4 + 4 + 9 + 4);  // length + type + data + crc
  const cv = new DataView(chunk.buffer);
  cv.setUint32(0, 9, false);
  chunk.set(typeBytes, 4);
  chunk.set(dataBytes, 8);
  cv.setUint32(17, crc, false);
  // Splice into the original byte stream
  const out = new Uint8Array(buf.length + chunk.length);
  out.set(buf.subarray(0, insertAt), 0);
  out.set(chunk, insertAt);
  out.set(buf.subarray(insertAt), insertAt + chunk.length);
  return new Blob([out], { type: "image/png" });
}

// Convert an SVG markup string to a PNG Blob via canvas. Uses a Blob URL
// (not a data URL) to avoid hitting the ~2 MB limit on data URLs in
// older Safari builds.
//
// `scale` (default 4) sets the output pixel ratio — at the standard 96
// CSS-pixel base this gives ~384 DPI raster, which is well above the
// 300 DPI print bar. The pHYs chunk we inject afterwards declares the
// PNG as 300 DPI so consumers (PowerPoint / Word / Illustrator) place
// it at the right physical size in documents.
async function _svgStringToPngBlob(svgString, w, h, scale=4){
  const blob = new Blob([svgString], {type: "image/svg+xml;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  try {
    const rawPng = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width  = Math.round(w * scale);
          canvas.height = Math.round(h * scale);
          const ctx = canvas.getContext("2d");
          // High-quality interpolation for crisp text at high scale.
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          // Solid background so the PNG isn't transparent on white viewers.
          ctx.fillStyle = "#0D1117";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(b => b ? resolve(b) : reject(new Error("toBlob returned null")), "image/png");
        } catch (e){ reject(e); }
      };
      img.onerror = () => reject(new Error("SVG failed to load into Image"));
      img.src = url;
    });
    // Best-effort: tag the PNG as 300 DPI so it imports at print size.
    // If anything fails, fall back to the raw PNG (still at 4× pixel
    // density — just no DPI metadata).
    try { return await _addPngDpi(rawPng, 300); }
    catch { return rawPng; }
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Format a single column value for use as a group-key label. Uses
// formatRowValue for nice numeric rounding, falls back to String() for
// enums/bools that are already strings/booleans.
// Marker palette — used as the SHAPE dimension when the user picks a
// second grouping variable. Order matters: shapes farthest apart visually
// come first so a typical 2-3 level group is maximally distinguishable.
const PLOT_MARKERS = ["circle", "square", "triangle", "diamond", "plus", "cross", "star"];

function _plotFmtVal(col, raw){
  if (raw == null) return "—";
  if (col.isCategorical) return String(raw);
  const disp = col.toDisp(raw);
  // Use unit-aware smart formatting so legends read "Pressure = 250 psia"
  // and "Fuel H₂ = 50 mol %" — matching what the rest of the app shows.
  if (typeof disp === "number" && Number.isFinite(disp)){
    return formatRowValue(disp, col.unit, col.label);
  }
  return String(disp);
}

// Read the per-row raw value for a varSpec column. Fuel and oxidizer
// species live nested in row.__inputs__.fuel / .ox keyed by the SPECIES
// name (e.g. "H2", "CH4") — NOT by the catalog var-id which prefixes
// "fuel." / "ox." for namespacing (e.g. "fuel.H2"). The Excel writer
// uses v.species the same way; we mirror that here so plotting / slicing
// reads the right value. Plain inputs (phi, T_air, …) are top-level.
function _readRowVarValue(row, col){
  const inp = row.__inputs__;
  if (!inp) return undefined;
  if (col.kindRaw === "fuel_species") {
    const key = col.species || col.varId;
    return inp.fuel ? inp.fuel[key] : undefined;
  }
  if (col.kindRaw === "ox_species") {
    const key = col.species || col.varId;
    return inp.ox ? inp.ox[key] : undefined;
  }
  return inp[col.varId];
}

// Pull the baseline value for a varSpec from the App-level baseline
// snapshot. Same species-name vs var-id distinction as _readRowVarValue.
function _readBaselineVar(baseline, varSpec){
  if (!baseline) return undefined;
  if (varSpec.kind === "fuel_species") {
    const key = varSpec.species || varSpec.id;
    return baseline.fuel ? baseline.fuel[key] : undefined;
  }
  if (varSpec.kind === "ox_species") {
    const key = varSpec.species || varSpec.id;
    return baseline.ox ? baseline.ox[key] : undefined;
  }
  return baseline[varSpec.id];
}

// Numeric / categorical equality with a sane tolerance. Used to pin a row
// to a specific value of a held-constant variable.
function _valuesMatch(a, b){
  if (a == null || b == null) return false;
  if (typeof a === "number" && typeof b === "number"){
    if (a === b) return true;
    const tol = Math.max(Math.abs(a), Math.abs(b), 1) * 1e-6;
    return Math.abs(a - b) < tol;
  }
  return String(a) === String(b);
}

// Compile the full set of plottable columns once per (varSpecs, outputs,
// units) tuple. Each column knows how to pick a raw SI value out of a row
// and how to convert that value to display units.
function _buildPlotColumns(varSpecs, outputs, units){
  const cols = [];
  for (const v of varSpecs){
    const isFuelSp = v.kind === "fuel_species";
    const isOxSp   = v.kind === "ox_species";
    const isCat    = v.kind === "enum" || v.kind === "bool";
    // Species are keyed by v.species (e.g. "H2") inside row.__inputs__.fuel /
    // .ox; the catalog v.id is namespaced ("fuel.H2") and would miss the
    // dict. Plain inputs are top-level under the catalog id.
    const speciesKey = (isFuelSp || isOxSp) ? (v.species || v.id) : null;
    cols.push({
      id: `in:${v.id}`, kind: "input", varId: v.id,
      kindRaw: v.kind,
      species: speciesKey,
      label: v.label,
      unit: unitFor(v, units),
      isCategorical: isCat,
      raw: row => isFuelSp ? row.__inputs__?.fuel?.[speciesKey]
              : isOxSp     ? row.__inputs__?.ox?.[speciesKey]
              : row.__inputs__?.[v.id],
      toDisp: raw => toDisplay(v, raw, units),
    });
  }
  for (const o of outputs){
    const isCat = o.unit === "bool";
    cols.push({
      id: `out:${o.id}`, kind: "output",
      kindRaw: "output",
      label: o.label,
      unit: outputUnitFor(o, units),
      isCategorical: isCat,
      raw: row => row.__outputs__?.[o.id],
      toDisp: raw => isCat ? (raw ? 1 : 0) : outputDisplayValue(o, raw, units),
    });
  }
  return cols;
}

// Build the canonical {kindRaw, varId, species} bundle from a varSpec.
// Used everywhere the slicing/matching code needs to read a value out of
// row.__inputs__ — keeps the species-vs-id distinction in one place.
function _colFromVarSpec(varSpec){
  return {
    kindRaw: varSpec.kind,
    varId:   varSpec.id,
    species: varSpec.species,
  };
}

// Distinct values of a varSpec across the matrix, sorted (numeric → low to
// high; string → alphabetical). Used both for slicing fallbacks and for
// populating the per-held-var dropdowns in the UI.
function _distinctValuesForVar(results, varSpec){
  const seen = new Map();   // rounded-key → original raw value
  const col = _colFromVarSpec(varSpec);
  for (const r of results){
    if (r.__error__) continue;
    const raw = _readRowVarValue(r, col);
    if (raw == null) continue;
    const k = (typeof raw === "number") ? +raw.toPrecision(8) : String(raw);
    if (!seen.has(k)) seen.set(k, raw);
  }
  const arr = [...seen.values()];
  if (arr.every(v => typeof v === "number")) arr.sort((a, b) => a - b);
  else arr.sort((a, b) => String(a).localeCompare(String(b)));
  return arr;
}

// ─────────────────────────────────────────────────────────────────────────
//  Hold-constant slice resolution.
//
//  Standard DOE plotting practice: when plotting Y vs X grouped by G1/G2,
//  every other varied factor must be pinned to a single value or the
//  resulting curve is a smear of unrelated points.
//
//  Value-selection precedence per held variable:
//    1. User override (heldOverrides Map<varId, value>) — takes precedence.
//    2. App baseline value, IF that value actually appears in the matrix.
//    3. Mode (most-common) value across the matrix as fallback.
//
//  Returns each held entry with `distinct` (the matrix's distinct values
//  for that var, suitable for a dropdown) and `source` ∈ {"user", "baseline", "mode"}.
// ─────────────────────────────────────────────────────────────────────────
// Sentinel value the user can pick in a held-var dropdown to mean
// "leave this var free — don't filter on it". Stored in the
// heldOverrides Map under the var id.
const HELD_FREE = Symbol.for("ctk.held.free");

function _findHeldSlice(varSpecs, baseline, results, freeVarIds, heldOverrides, opts){
  // `xIsInput` controls the DEFAULT for vars without a user override:
  //   X=input  → default to baseline (or mode fallback) → variable IS held.
  //   X=output → default to free                         → variable is NOT held.
  // Either way the user gets a dropdown for every candidate (var that
  // isn't an axis or grouping) so they can switch any of them between
  // "Free (full spread)" and "Hold at <picked value>".
  const xIsInput = opts && opts.xIsInput !== false;
  const candidates = [];      // [{varSpec, value, source, distinct}] — value=null means free
  let anyFallback = false;

  for (const v of varSpecs){
    if (freeVarIds.has(v.id)) continue;
    const distinct = _distinctValuesForVar(results, v);

    // (1) User override wins — including explicit "free this var" sentinel.
    if (heldOverrides && heldOverrides.has(v.id)){
      const ov = heldOverrides.get(v.id);
      if (ov === HELD_FREE){
        candidates.push({ varSpec: v, value: null, source: "user-free", distinct });
        continue;
      }
      candidates.push({ varSpec: v, value: ov, source: "user", distinct });
      continue;
    }

    // (2) No user override — default depends on X kind.
    if (!xIsInput){
      // X is an output → default is FREE so the cloud spreads on X.
      candidates.push({ varSpec: v, value: null, source: "free-default", distinct });
      continue;
    }

    // X is an input → default is baseline (or mode fallback).
    const baseVal = _readBaselineVar(baseline, v);
    const baseInMatrix = baseVal != null && distinct.some(d => _valuesMatch(d, baseVal));
    if (baseInMatrix){
      candidates.push({ varSpec: v, value: baseVal, source: "baseline", distinct });
      continue;
    }
    // (3) Mode fallback — most-common value across all rows.
    const counts = new Map();
    const col = _colFromVarSpec(v);
    for (const r of results){
      if (r.__error__) continue;
      const raw = _readRowVarValue(r, col);
      if (raw == null) continue;
      const k = (typeof raw === "number") ? +raw.toPrecision(8) : String(raw);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let bestN = 0, bestRaw = null;
    for (const [k, n] of counts){
      if (n > bestN){
        bestN = n;
        const match = distinct.find(d => {
          const dk = (typeof d === "number") ? +d.toPrecision(8) : String(d);
          return dk === k;
        });
        bestRaw = match != null ? match : k;
      }
    }
    candidates.push({ varSpec: v, value: bestRaw, source: "mode", distinct });
    anyFallback = true;
  }

  // The actually-held subset (every candidate with a non-null value).
  // Backward-compatible field name `held` so the slice filter and the
  // existing caption renderers keep working.
  const held = candidates.filter(c => c.value != null);
  const count = _countMatchingRows(results, held);
  return { held, candidates, count, fallback: anyFallback };
}

function _countMatchingRows(results, held){
  if (held.length === 0) return results.filter(r => !r.__error__).length;
  let n = 0;
  for (const r of results){
    if (r.__error__) continue;
    let ok = true;
    for (const h of held){
      const col = _colFromVarSpec(h.varSpec);
      if (!_valuesMatch(_readRowVarValue(r, col), h.value)){ ok = false; break; }
    }
    if (ok) n++;
  }
  return n;
}

// Build chart series with proper DOE slicing.
//
//   xCol   — independent axis (input OR output)
//   yCol   — dependent axis
//   gColor — optional grouping column (color dimension); must be input
//   gShape — optional second grouping column (shape dimension); must be input
//   slice  — { held, fallback } from _findHeldSlice
//
// Rows that don't match every held value are FILTERED OUT (this is the
// fix for the "vertical stack" bug). Within the filtered set, points are
// bucketed by (gColor value, gShape value), each bucket becomes one
// series with a unique (color, marker) combination, points are sorted by
// X ascending so lines trace left-to-right.
function _buildSlicedSeries(rows, varSpecs, xCol, yCol, gColor, gShape, slice){
  const xIsCat = !!xCol.isCategorical;
  const catOrder = [];
  const catIdx = new Map();
  // Pre-index series buckets keyed by (colorKey, shapeKey).
  // We store colorKey separately so we can assign palette colors after
  // bucketing (so order-of-encounter doesn't drive color assignment).
  const buckets = new Map();   // bucketKey → {colorKey, shapeKey, points}

  // Track distinct color and shape keys for legend ordering.
  const colorKeys = [];
  const colorSeen = new Set();
  const shapeKeys = [];
  const shapeSeen = new Set();

  const heldValues = slice ? slice.held : [];

  rowLoop:
  for (const row of rows){
    if (row.__error__) continue;
    // Hold-constant filter
    for (const h of heldValues){
      const col = _colFromVarSpec(h.varSpec);
      if (!_valuesMatch(_readRowVarValue(row, col), h.value)) continue rowLoop;
    }
    // Read X
    const xRaw = xCol.raw(row);
    const yRaw = yCol.raw(row);
    if (xRaw == null || yRaw == null) continue;
    let x;
    if (xIsCat){
      const k = String(xRaw);
      if (!catIdx.has(k)){ catIdx.set(k, catOrder.length); catOrder.push(k); }
      x = catIdx.get(k);
    } else {
      x = xCol.toDisp(xRaw);
      if (typeof x !== "number" || !Number.isFinite(x)) continue;
    }
    let y = yCol.toDisp(yRaw);
    if (typeof y === "boolean") y = y ? 1 : 0;
    if (typeof y !== "number" || !Number.isFinite(y)) continue;
    // Determine series identity
    const colorRaw = gColor ? gColor.raw(row) : null;
    const shapeRaw = gShape ? gShape.raw(row) : null;
    const colorKey = gColor ? _plotFmtVal(gColor, colorRaw) : "__all__";
    const shapeKey = gShape ? _plotFmtVal(gShape, shapeRaw) : "__one__";
    if (gColor && !colorSeen.has(colorKey)){ colorSeen.add(colorKey); colorKeys.push({key: colorKey, raw: colorRaw}); }
    if (gShape && !shapeSeen.has(shapeKey)){ shapeSeen.add(shapeKey); shapeKeys.push({key: shapeKey, raw: shapeRaw}); }
    const bucketKey = `${colorKey}||${shapeKey}`;
    if (!buckets.has(bucketKey)){
      buckets.set(bucketKey, { colorKey, shapeKey, points: [] });
    }
    buckets.get(bucketKey).points.push({ x, y });
  }

  // Sort color and shape keys by their underlying numeric value when
  // possible (so a swept variable's series appear low-to-high in the
  // legend). Strings sort alphabetically.
  const sortKeys = (arr) => {
    arr.sort((a, b) => {
      const av = (typeof a.raw === "number") ? a.raw : null;
      const bv = (typeof b.raw === "number") ? b.raw : null;
      if (av != null && bv != null) return av - bv;
      return String(a.key).localeCompare(String(b.key));
    });
  };
  sortKeys(colorKeys);
  sortKeys(shapeKeys);

  // Assign palette colors and markers based on sorted key order, so the
  // colors match the natural order of the swept variable.
  const colorByKey = new Map();
  colorKeys.forEach((c, i) => colorByKey.set(c.key, PLOT_PALETTE[i % PLOT_PALETTE.length]));
  const markerByKey = new Map();
  shapeKeys.forEach((s, i) => markerByKey.set(s.key, PLOT_MARKERS[i % PLOT_MARKERS.length]));

  // Default color/marker for ungrouped axes.
  const defaultColor  = PLOT_PALETTE[0];
  const defaultMarker = "circle";

  // Build the final series list. Ordering: color-first, then shape, so
  // the legend reads "[color1·shape1, color1·shape2, color2·shape1, …]".
  const series = [];
  const cKeys = colorKeys.length > 0 ? colorKeys.map(c => c.key) : ["__all__"];
  const sKeys = shapeKeys.length > 0 ? shapeKeys.map(s => s.key) : ["__one__"];
  for (const cK of cKeys){
    for (const sK of sKeys){
      const b = buckets.get(`${cK}||${sK}`);
      if (!b || b.points.length === 0) continue;
      b.points.sort((a, p) => a.x - p.x);
      // Build human-readable legend label
      const parts = [];
      if (gColor) parts.push(`${gColor.label} = ${cK}${gColor.unit ? ` ${gColor.unit}` : ""}`);
      if (gShape) parts.push(`${gShape.label} = ${sK}${gShape.unit ? ` ${gShape.unit}` : ""}`);
      const name = parts.length > 0 ? parts.join(" · ") : "data";
      series.push({
        name,
        color:  gColor ? colorByKey.get(cK)  : defaultColor,
        marker: gShape ? markerByKey.get(sK) : defaultMarker,
        points: b.points,
      });
    }
  }
  return { series, xCategorical: xIsCat, xLabels: xIsCat ? catOrder : null };
}

// A small searchable selector for plottable columns. Filters the list of
// `cols` against the user-typed substring (case-insensitive). Renders a
// scrollable list; the currently-selected entry is highlighted.
function ColPicker({ label, cols, value, onChange, allowNone=false, noneLabel="(none)" }){
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    if (!q.trim()) return cols;
    const needle = q.trim().toLowerCase();
    return cols.filter(c =>
      c.label.toLowerCase().includes(needle) || c.id.toLowerCase().includes(needle)
    );
  }, [cols, q]);
  return (
    <div style={{display:"flex", flexDirection:"column", gap:4, minWidth:200, flex:"1 1 200px"}}>
      <div style={{fontSize:10, color:C.txtMuted, textTransform:"uppercase", letterSpacing:".5px",
        fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700}}>{label}</div>
      <input type="text" value={q} placeholder="search…" onChange={e=>setQ(e.target.value)}
        style={{padding:"5px 8px", fontSize:11, fontFamily:"monospace",
          background:C.bg, color:C.txt, border:`1px solid ${C.border}`, borderRadius:4}}/>
      <div style={{maxHeight:160, overflow:"auto", border:`1px solid ${C.border}`,
        borderRadius:4, background:C.bg}}>
        {allowNone && (
          <div onClick={() => onChange(null)}
            style={{padding:"4px 8px", fontSize:11, cursor:"pointer",
              fontFamily:"monospace",
              background: value == null ? `${C.accent}30` : "transparent",
              color: value == null ? C.accent : C.txtDim,
              borderBottom:`1px solid ${C.border}40`}}>
            {noneLabel}
          </div>
        )}
        {filtered.length === 0 && (
          <div style={{padding:"6px 8px", fontSize:11, color:C.txtMuted, fontStyle:"italic",
            fontFamily:"monospace"}}>no match</div>
        )}
        {filtered.map(c => (
          <div key={c.id} onClick={() => onChange(c.id)}
            style={{padding:"4px 8px", fontSize:11, cursor:"pointer",
              fontFamily:"monospace",
              background: value === c.id ? `${C.accent}30` : "transparent",
              color: value === c.id ? C.accent : C.txtDim,
              borderBottom:`1px solid ${C.border}40`}}>
            <span style={{color:c.kind === "input" ? C.accent3 : C.warm,
              fontSize:9, marginRight:6, fontWeight:700}}>
              {c.kind === "input" ? "IN" : "OUT"}
            </span>
            {c.label}
            {c.unit ? <span style={{color:C.txtMuted, marginLeft:6}}>({c.unit})</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

// Cheap test for "is this Y essentially constant across the run". If max
// and min are within 1e-9 of each other (or relative spread < 1e-6), we
// consider the Y constant and skip plotting it — flat lines waste real
// estate and obscure the plots that actually carry information.
function _isYConstant(series){
  const ys = series.flatMap(s => s.points.map(p => p.y)).filter(Number.isFinite);
  if (ys.length < 2) return true;
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const span = hi - lo;
  if (span <= 1e-12) return true;
  // Relative spread < 0.01% counts as effectively constant (covers stuff
  // like FAR_stoich which barely budges when you sweep a knob that doesn't
  // touch composition).
  const ref = Math.max(Math.abs(lo), Math.abs(hi), 1e-30);
  return (span / ref) < 1e-4;
}

// Build the chart props bundle (everything MultiSeriesChart wants) for one
// auto-plot entry. Same arguments produce identical SVG, so this is what
// gets passed both to the on-screen renderer AND the renderToStaticMarkup
// path used for ZIP export.
function _autoChartSpec(ch, useLog){
  return {
    series: ch.data.series,
    xLabel: `${ch.xCol.label}${ch.xCol.unit ? ` (${ch.xCol.unit})` : ""}`,
    yLabel: `${ch.yCol.label}${ch.yCol.unit ? ` (${ch.yCol.unit})` : ""}`,
    w: 720, h: 460,   // export-resolution; on-screen uses w=520/h=300
    xCategorical: ch.data.xCategorical,
    xLabels: ch.data.xLabels,
    yLog: useLog && _seriesAllPositive(ch.data.series),
    legendCols: ch.data.series.length > 4 ? 2 : 1,
  };
}

// Build a one-line "Held constant: var1 = v1, var2 = v2, …" caption from
// a slice's held-vars list. Truncated if the list is long; suffix shows
// the data source (baseline vs. mode fallback) and how many rows the
// slice actually pinned in the matrix.
function _heldSliceCaption(slice, units){
  if (!slice || slice.held.length === 0) {
    return `Held constant: nothing — every varied input is in use as an axis or grouping.`;
  }
  const parts = slice.held.map(h => {
    const v = h.varSpec;
    if (h.value == null) return `${v.label} = —`;
    let dispVal;
    if (v.kind === "fuel_species" || v.kind === "ox_species" || v.kind === "enum" || v.kind === "bool"){
      dispVal = String(h.value);
    } else if (typeof h.value === "number") {
      dispVal = formatRowValue(toDisplay(v, h.value, units));
    } else {
      dispVal = String(h.value);
    }
    const u = unitFor(v, units);
    return `${v.label} = ${dispVal}${u ? ` ${u}` : ""}`;
  });
  // Plain "(N matching rows)" suffix only — the per-variable source
  // (baseline / mode / picked) lives in the dropdown badges above the
  // chart, and the pre-run modal warns when baseline doesn't match the
  // matrix. No need to re-warn the user here.
  return `Held constant: ${parts.join(" · ")} (${slice.count} matching row${slice.count !== 1 ? "s" : ""})`;
}

// Per-held-variable dropdown UI. Renders one <select> per held var with
// the matrix's distinct values, plus a small "[baseline / mode / picked]"
// badge so the user always knows whether the slice is auto-selected or
// overridden. Picking a value writes into the heldOverrides Map (which
// takes precedence over baseline/mode in _findHeldSlice).
function HeldValuePicker({ slice, units, heldOverrides, setHeldOverrides }){
  const labelFor = (v, raw) => {
    if (raw == null) return "—";
    if (v.kind === "fuel_species" || v.kind === "ox_species" ||
        v.kind === "enum" || v.kind === "bool"){
      return String(raw);
    }
    if (typeof raw === "number"){
      return formatRowValue(toDisplay(v, raw, units));
    }
    return String(raw);
  };

  // Each <select> uses string values: "free" = HELD_FREE sentinel; "i:N"
  // = pick distinct[N] from this var's distinct values.
  const onSelectChange = (varId, distinct, raw) => {
    setHeldOverrides(prev => {
      const next = new Map(prev);
      if (raw === "free")          next.set(varId, HELD_FREE);
      else if (raw.startsWith("i:")) next.set(varId, distinct[+raw.slice(2)]);
      return next;
    });
  };
  const reset = (varId) => {
    setHeldOverrides(prev => {
      if (!prev.has(varId)) return prev;
      const next = new Map(prev);
      next.delete(varId);
      return next;
    });
  };

  // Use the candidates list (every varSpec that COULD be held — i.e.,
  // not the X axis or a grouping var). Each candidate gets a dropdown
  // with "(Free)" + every distinct matrix value, defaulted to
  // baseline/mode for input-X plots and to "Free" for output-X plots.
  const candidates = slice.candidates || slice.held || [];
  if (candidates.length === 0) return null;
  const heldCount = candidates.filter(c => c.value != null).length;

  return (
    <div style={{padding:"8px 10px", background:`${C.accent}10`, borderRadius:5,
      border:`1px solid ${C.accent}40`, marginBottom:10}}>
      <div style={{fontSize:10, fontWeight:700, color:C.accent,
        textTransform:"uppercase", letterSpacing:".7px", marginBottom:6,
        fontFamily:"'Barlow Condensed',sans-serif"}}>
        Filter by other inputs:  <span style={{color:C.txtMuted, fontWeight:400, textTransform:"none", letterSpacing:0}}>
          {heldCount === 0
            ? `nothing held — all ${slice.count} valid points shown`
            : `${heldCount} held → ${slice.count} matching row${slice.count !== 1 ? "s" : ""}`}
        </span>
      </div>
      <div style={{display:"flex", flexWrap:"wrap", gap:10}}>
        {candidates.map(h => {
          const v = h.varSpec;
          const u = unitFor(v, units);
          const distinct = h.distinct || [];
          const isHeld = h.value != null;
          const selIdx = isHeld ? distinct.findIndex(d => _valuesMatch(d, h.value)) : -1;
          const selectVal = isHeld ? `i:${selIdx >= 0 ? selIdx : 0}` : "free";
          const sourceColor =
            h.source === "user"        ? C.accent2 :
            h.source === "user-free"   ? C.txtDim  :
            h.source === "baseline"    ? C.txtDim  :
            h.source === "free-default"? C.txtMuted:
                                          C.warm;     // mode fallback
          const sourceLabel =
            h.source === "user"        ? "picked"          :
            h.source === "user-free"   ? "free (picked)"   :
            h.source === "baseline"    ? "baseline"        :
            h.source === "free-default"? "free (default)"  :
                                          "mode (baseline missed)";
          return (
            <div key={v.id} style={{display:"flex", flexDirection:"column", gap:2,
              minWidth:170}}>
              <div style={{display:"flex", alignItems:"baseline", gap:6}}>
                <span style={{fontSize:10.5, color:C.txtDim, fontFamily:"'Barlow',sans-serif",
                  fontWeight:600}}>{v.label}{u ? ` (${u})` : ""}</span>
                <span style={{fontSize:8.5, color:sourceColor, fontStyle:"italic"}}>
                  {sourceLabel}
                </span>
                {(h.source === "user" || h.source === "user-free") && (
                  <button onClick={() => reset(v.id)}
                    style={{marginLeft:"auto", padding:"0 4px", fontSize:9,
                      color:C.txtMuted, background:"transparent",
                      border:`1px solid ${C.border}`, borderRadius:2, cursor:"pointer",
                      fontFamily:"'Barlow Condensed',sans-serif"}}
                    title="Restore default (baseline for input X, free for output X)">↺</button>
                )}
              </div>
              <select value={selectVal}
                onChange={e => onSelectChange(v.id, distinct, e.target.value)}
                style={{padding:"3px 6px", fontSize:11,
                  background: isHeld ? C.bg : `${C.bg2}`, color: isHeld ? C.txt : C.txtDim,
                  border:`1px solid ${isHeld ? C.accent2 + "60" : C.border}`,
                  borderRadius:3, fontFamily:"monospace"}}>
                <option value="free">— Free (don't filter) —</option>
                {distinct.length === 0 && <option value="i:-1" disabled>(no values)</option>}
                {distinct.map((d, i) => (
                  <option key={i} value={`i:${i}`}>{labelFor(v, d)}</option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PlotPanel({ results, varSpecs, selectedOutputs, units, baseline, onClose }){
  // varSpecs is the user's varied list (already filtered to active panels);
  // selectedOutputs is the captured-output catalog for those panels.
  const allCols = useMemo(
    () => _buildPlotColumns(varSpecs, selectedOutputs, units),
    [varSpecs, selectedOutputs, units],
  );
  const inputCols  = useMemo(() => allCols.filter(c => c.kind === "input"),  [allCols]);
  const outputCols = useMemo(() => allCols.filter(c => c.kind === "output"), [allCols]);

  // Combustion-priority sorted lists — used as defaults and as the
  // canonical X/Y order in the auto plots.
  const sortedInputs = useMemo(() => {
    return [...inputCols].sort((a, b) => {
      const av = varSpecs.find(v => v.id === a.varId);
      const bv = varSpecs.find(v => v.id === b.varId);
      return (av ? _inputRank(av) : 9999) - (bv ? _inputRank(bv) : 9999);
    });
  }, [inputCols, varSpecs]);
  const sortedOutputs = useMemo(() => {
    return [...outputCols].sort((a, b) => {
      const ao = selectedOutputs.find(o => `out:${o.id}` === a.id);
      const bo = selectedOutputs.find(o => `out:${o.id}` === b.id);
      return (ao ? _outputRank(ao) : 9999) - (bo ? _outputRank(bo) : 9999);
    });
  }, [outputCols, selectedOutputs]);

  // ── Custom plot state ──
  // X, Y can be any column. Color and Shape grouping must be inputs (we
  // use them to discriminate held-vs-free). Both groupings are optional;
  // X being an input means it's also "free" (so it joins the freeVarIds).
  const [customXId, setCustomXId] = useState(() => sortedInputs[0]?.id || allCols[0]?.id || null);
  const [customYId, setCustomYId] = useState(() => sortedOutputs[0]?.id || outputCols[0]?.id || null);
  const [customGColorId, setCustomGColorId] = useState(null);
  const [customGFacetId, setCustomGFacetId] = useState(null);
  const [customLog, setCustomLog] = useState(false);
  // Per-held-var overrides — when set, takes precedence over baseline/mode.
  // Map<varId, value>. Reset whenever X/Y/grouping changes (the held set
  // changes too, so old overrides may apply to vars that are no longer
  // held). The reset is wired via useEffect below.
  const [heldOverrides, setHeldOverrides] = useState(() => new Map());

  const xCol      = useMemo(() => allCols.find(c => c.id === customXId)      || null, [allCols, customXId]);
  const yCol      = useMemo(() => allCols.find(c => c.id === customYId)      || null, [allCols, customYId]);
  const gColorCol = useMemo(() => allCols.find(c => c.id === customGColorId) || null, [allCols, customGColorId]);
  const gFacetCol = useMemo(() => allCols.find(c => c.id === customGFacetId) || null, [allCols, customGFacetId]);

  // When X/Y/grouping changes, drop any overrides for vars that ARE NOW
  // free (so stale entries don't leak), but keep overrides for vars that
  // are still held. The held set is recomputed lazily; here we just compute
  // the free set and prune.
  useEffect(() => {
    const free = new Set();
    if (xCol?.kind === "input") free.add(xCol.varId);
    if (gColorCol)              free.add(gColorCol.varId);
    if (gFacetCol)              free.add(gFacetCol.varId);
    setHeldOverrides(prev => {
      let changed = false;
      const next = new Map();
      for (const [k, v] of prev){
        if (!free.has(k)) next.set(k, v);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [xCol, gColorCol, gFacetCol]);

  const FACET_CAP = 12;
  const customSliceData = useMemo(() => {
    if (!xCol || !yCol) return null;

    // ── Common free set ──
    // Vars NOT in `commonFree` become candidates the user can hold via
    // the held-vars picker. X-axis and color-grouping are always free
    // (the chart varies along them). The FACET variable is intentionally
    // NOT marked free here — it's still a held candidate in the picker
    // because the MAIN plot pins it to a single value (otherwise multiple
    // facet values would smear into one line per color group). Picking
    // a different value in the picker overrides the auto-selected
    // baseline/mode pin. The facet panels below (small multiples) iterate
    // over ALL distinct values regardless of the picker selection — see
    // the heldExceptFacet block in the facets section.
    const commonFree = new Set();
    if (xCol.kind === "input") commonFree.add(xCol.varId);
    if (gColorCol) commonFree.add(gColorCol.varId);
    // (gFacetCol intentionally NOT added — see comment above.)
    const commonSlice = _findHeldSlice(
      varSpecs, baseline, results, commonFree, heldOverrides,
      { xIsInput: xCol.kind === "input" },
    );

    // ── Main plot ──
    // commonSlice.held already includes the facet variable pinned to a
    // single value via the standard baseline/mode/user-override logic
    // _findHeldSlice applies to every held candidate. Pull that entry
    // out for the "Main plot pinned to ..." badge below the title so
    // the user always sees which facet slice the main plot is showing.
    let mainFacetPin = null;
    if (gFacetCol){
      const fSpec = varSpecs.find(v => v.id === gFacetCol.varId);
      if (fSpec){
        const found = commonSlice.held.find(h => h.varSpec.id === fSpec.id);
        if (found){
          mainFacetPin = {
            ...found,
            distinct: _distinctValuesForVar(results, fSpec),
          };
        }
      }
    }
    const mainSlice = {
      held: commonSlice.held,
      candidates: commonSlice.candidates,
      count: _countMatchingRows(results, commonSlice.held),
      fallback: commonSlice.fallback,
    };
    const mainSd = _buildSlicedSeries(
      results, varSpecs, xCol, yCol, gColorCol, null, mainSlice,
    );

    // ── Facet panels ──
    // commonSlice.held now includes the facet variable (we stopped
    // hiding it from the picker so the user can pin which value the
    // MAIN plot shows). For the facet panels, we want to ignore that
    // pin and iterate over ALL distinct facet values — each panel will
    // pin the facet to its own value. So we strip the facet entry from
    // the inherited held list before enumerating distinct values and
    // before building each panel's panelHeld.
    let facets = null;
    let facetOverflow = false;
    if (gFacetCol){
      const fSpec = varSpecs.find(v => v.id === gFacetCol.varId);
      if (fSpec){
        const colFacet = _colFromVarSpec(fSpec);
        const heldExceptFacet = commonSlice.held.filter(h => h.varSpec.id !== fSpec.id);
        // Distinct facet values present in rows that satisfy the OTHER
        // held vars (Air Temp, etc.) — but NOT the facet's own pin.
        const facetSeen = new Map();
        for (const r of results){
          if (r.__error__) continue;
          let ok = true;
          for (const h of heldExceptFacet){
            const col = _colFromVarSpec(h.varSpec);
            if (!_valuesMatch(_readRowVarValue(r, col), h.value)){ ok = false; break; }
          }
          if (!ok) continue;
          const raw = _readRowVarValue(r, colFacet);
          if (raw == null) continue;
          const k = (typeof raw === "number") ? +raw.toPrecision(8) : String(raw);
          if (!facetSeen.has(k)) facetSeen.set(k, raw);
        }
        let facetVals = [...facetSeen.values()];
        if (facetVals.every(v => typeof v === "number")) facetVals.sort((a, b) => a - b);
        else facetVals.sort((a, b) => String(a).localeCompare(String(b)));
        if (facetVals.length > FACET_CAP){
          facetOverflow = true;
          facetVals = facetVals.slice(0, FACET_CAP);
        }

        facets = facetVals.map(fVal => {
          const panelHeld = [
            ...heldExceptFacet,
            { varSpec: fSpec, value: fVal, source: "facet-panel" },
          ];
          const panelSlice = { held: panelHeld, candidates: panelHeld, count: 0, fallback: false };
          const sd = _buildSlicedSeries(
            results, varSpecs, xCol, yCol, gColorCol, null, panelSlice,
          );
          return {
            facetValue: fVal,
            facetLabel: _plotFmtVal(gFacetCol, fVal),
            ...sd,
            pointCount: sd.series.reduce((acc, s) => acc + s.points.length, 0),
          };
        });
      }
    }

    // Compute SHARED axis bounds across the main plot AND every facet
    // panel so all charts read back-to-back at the same scale (Tufte-
    // style small multiples). Without this each panel auto-scales to
    // its own data and visual comparison is lost.
    const allSeries = [
      ...(mainSd.series || []),
      ...(facets ? facets.flatMap(f => f.series) : []),
    ];
    let sharedXMin = null, sharedXMax = null, sharedYMin = null, sharedYMax = null;
    if (!mainSd.xCategorical){
      const xs = allSeries.flatMap(s => s.points.map(p => p.x)).filter(Number.isFinite);
      if (xs.length){
        sharedXMin = Math.min(...xs);
        sharedXMax = Math.max(...xs);
        if (sharedXMin === sharedXMax){ sharedXMin -= 1; sharedXMax += 1; }
        else {
          const pad = (sharedXMax - sharedXMin) * 0.05;
          sharedXMin -= pad; sharedXMax += pad;
          if (Math.min(...xs) >= 0 && sharedXMin < 0) sharedXMin = 0;
        }
      }
    }
    {
      const ys = allSeries.flatMap(s => s.points.map(p => p.y)).filter(Number.isFinite);
      if (ys.length){
        sharedYMin = Math.min(...ys);
        sharedYMax = Math.max(...ys);
        if (sharedYMin === sharedYMax){ sharedYMin -= 1; sharedYMax += 1; }
        else {
          const pad = (sharedYMax - sharedYMin) * 0.05;
          sharedYMin -= pad; sharedYMax += pad;
          if (Math.min(...ys) >= 0 && sharedYMin < 0) sharedYMin = 0;
        }
      }
    }

    return {
      ...mainSd,
      slice: commonSlice,    // for the held-vars picker (excludes facet)
      mainSlice,             // what the main chart actually filtered on
      mainFacetPin,          // facet variable + pinned value used for main
      facets,
      facetOverflow,
      facetTotalCount: gFacetCol ? (facets ? facets.length : 0) : 0,
      sharedXMin, sharedXMax, sharedYMin, sharedYMax,
    };
  }, [results, varSpecs, baseline, xCol, yCol, gColorCol, gFacetCol, heldOverrides]);

  // ── Auto-plot grid ───────────────────────────────────────────────
  // For each captured output × each varied input X, generate:
  //   (a) a "main effect" plot — no grouping, every other varied input
  //       held at baseline (or mode fallback)
  //   (b) for each OTHER varied input as G_color, ONE color-grouped
  //       variant (other-other vars still held)
  // Charts where Y is essentially constant after slicing are dropped —
  // they'd just be flat lines.
  // Each chart is ranked by combustion priority (yRank, xRank) for
  // sort + multi-select default selection; the top-priority "main effect"
  // plots come first, then color-grouped variants, then less-important
  // outputs.
  const autoCharts = useMemo(() => {
    if (inputCols.length === 0 || outputCols.length === 0) return [];
    const out = [];
    for (const yc of outputCols){
      const yOutDef = selectedOutputs.find(o => `out:${o.id}` === yc.id);
      const yRank = yOutDef ? _outputRank(yOutDef) : 9999;
      const yCategory = yOutDef ? _outputCategory(yOutDef) : "99_other";
      for (const xc of inputCols){
        const xVarDef = varSpecs.find(v => v.id === xc.varId);
        const xRank = xVarDef ? _inputRank(xVarDef) : 9999;

        // (a) Main-effect plot — no grouping. Free = X only.
        {
          const free = new Set([xc.varId]);
          const slice = _findHeldSlice(varSpecs, baseline, results, free, null, { xIsInput: true });
          const sd = _buildSlicedSeries(results, varSpecs, xc, yc, null, null, slice);
          if (sd.series.length > 0 && !_isYConstant(sd.series)){
            const baseName = `${_sanitizeFilename(yc.label)}_vs_${_sanitizeFilename(xc.label)}`;
            out.push({
              key: `${yc.id}__vs__${xc.id}`,
              title: `${yc.label} vs ${xc.label}`,
              xCol: xc, yCol: yc, gColorCol: null, gFacetCol: null,
              data: sd, slice,
              logHint: _shouldLogAxis(sd.series),
              yRank, xRank, gRank: 0,
              category: yCategory,
              filename: `${baseName}.png`,
            });
          }
        }

        // (b) One color-grouped variant per OTHER varied input.
        for (const gColor of inputCols){
          if (gColor.varId === xc.varId) continue;
          const gVarDef = varSpecs.find(v => v.id === gColor.varId);
          const gRank = gVarDef ? _inputRank(gVarDef) : 9999;
          const free = new Set([xc.varId, gColor.varId]);
          const slice = _findHeldSlice(varSpecs, baseline, results, free, null, { xIsInput: true });
          const sd = _buildSlicedSeries(results, varSpecs, xc, yc, gColor, null, slice);
          if (sd.series.length === 0 || _isYConstant(sd.series)) continue;
          // Skip if every series collapses to a single point — usually
          // means slicing was so tight no variation in X is preserved
          // for any group key.
          const totalPts = sd.series.reduce((acc, s) => acc + s.points.length, 0);
          if (totalPts < sd.series.length * 2) continue;
          const baseName = `${_sanitizeFilename(yc.label)}_vs_${_sanitizeFilename(xc.label)}_by_${_sanitizeFilename(gColor.label)}`;
          out.push({
            key: `${yc.id}__vs__${xc.id}__by__${gColor.id}`,
            title: `${yc.label} vs ${xc.label} · colored by ${gColor.label}`,
            xCol: xc, yCol: yc, gColorCol: gColor, gFacetCol: null,
            data: sd, slice,
            logHint: _shouldLogAxis(sd.series),
            yRank, xRank, gRank,
            category: yCategory,
            filename: `${baseName}.png`,
          });
        }
      }
    }
    // Sort: yRank → xRank → gRank (no-grouping first since gRank=0) → title.
    out.sort((a, b) =>
      (a.yRank - b.yRank) ||
      (a.xRank - b.xRank) ||
      (a.gRank - b.gRank) ||
      a.title.localeCompare(b.title)
    );
    return out;
  }, [results, inputCols, outputCols, varSpecs, selectedOutputs, baseline]);

  const [logFlags, setLogFlags] = useState({});

  // ── Multi-select state ──────────────────────────────────────────
  // Default selection: top-N most-important plots (combustion priority).
  // The Set stores chart keys; a key being IN the set means "render &
  // export it". Recomputed whenever the chart list changes.
  const DEFAULT_SHOW_N = 8;
  const [selectedKeys, setSelectedKeys] = useState(() =>
    new Set(autoCharts.slice(0, DEFAULT_SHOW_N).map(ch => ch.key))
  );
  // Re-seed when autoCharts changes (e.g. user reruns matrix).
  useEffect(() => {
    setSelectedKeys(new Set(autoCharts.slice(0, DEFAULT_SHOW_N).map(ch => ch.key)));
  }, [autoCharts]);

  const renderedCharts = useMemo(
    () => autoCharts.filter(ch => selectedKeys.has(ch.key)),
    [autoCharts, selectedKeys],
  );

  const ok = results.filter(r => !r.__error__).length;
  const errored = results.length - ok;

  // ── Export handlers ─────────────────────────────────────────────
  const [exporting, setExporting] = useState(null);  // null | "custom" | "zip"

  const exportCustomPlot = useCallback(async () => {
    if (!xCol || !yCol || !customSliceData) return;
    setExporting("custom");
    try {
      const props = {
        series: customSliceData.series,
        xLabel: `${xCol.label}${xCol.unit ? ` (${xCol.unit})` : ""}`,
        yLabel: `${yCol.label}${yCol.unit ? ` (${yCol.unit})` : ""}`,
        w: 960, h: 600,
        xCategorical: customSliceData.xCategorical,
        xLabels: customSliceData.xLabels,
        xMin: customSliceData.sharedXMin, xMax: customSliceData.sharedXMax,
        yMin: customSliceData.sharedYMin, yMax: customSliceData.sharedYMax,
        yLog: customLog && _seriesAllPositive(customSliceData.series),
        legendCols: customSliceData.series.length > 6 ? 3 : 2,
        connectLines: xCol.kind === "input",
      };
      const svg = _chartSpecToSvgString(props);
      // Build the same title + held-vars subtitle the on-screen panel
      // shows above its chart so the exported PNG carries the same
      // context — what's plotted, what's grouped, what's held constant.
      let title = `${yCol.label}${yCol.unit ? ` (${yCol.unit})` : ""} vs ${xCol.label}${xCol.unit ? ` (${xCol.unit})` : ""}`;
      if (gColorCol) title += ` · color by ${gColorCol.label}`;
      if (gFacetCol) title += ` · faceted by ${gFacetCol.label}`;
      const subtitle = (customSliceData.mainSlice || customSliceData.slice)
        ? _heldSliceCaption(customSliceData.mainSlice || customSliceData.slice, units)
        : null;
      const HEADER_H = subtitle ? 52 : 32;
      const wrapped = _wrapChartWithHeader(svg, props.w, props.h, title, subtitle);
      const png = await _svgStringToPngBlob(wrapped, props.w, props.h + HEADER_H);
      const colSuf = gColorCol ? `_color_${_sanitizeFilename(gColorCol.label)}` : "";
      const logSuffix = props.yLog ? "_logy" : "";
      const fname = `${_sanitizeFilename(yCol.label)}_vs_${_sanitizeFilename(xCol.label)}${colSuf}${logSuffix}.png`;
      _triggerBlobDownload(png, fname);
    } catch (e){
      console.error("custom plot export failed:", e);
      alert(`Export failed: ${e.message || e}`);
    } finally {
      setExporting(null);
    }
  }, [xCol, yCol, gColorCol, gFacetCol, customSliceData, customLog, units]);

  // Export the entire facet grid as one composed SVG → PNG. Builds a
  // single big <svg> containing all panels in a 3-column grid plus a
  // shared title bar, then runs it through the standard PNG-converter
  // pipeline (4× pixel ratio + 300 DPI metadata).
  const exportFacetGrid = useCallback(async () => {
    if (!gFacetCol || !customSliceData?.facets?.length) return;
    setExporting("facets");
    try {
      const facets = customSliceData.facets;
      const N = facets.length;
      const cols = N <= 2 ? N : (N <= 6 ? 3 : 4);
      const rows = Math.ceil(N / cols);
      const PW = 520;            // per-panel width
      const PH = 380;            // per-panel height
      const TITLE_H = 50;        // top header strip
      const FOOTER_H = 60;       // shared legend strip
      const GAP = 12;
      const PADDING = 16;
      const TOTAL_W = PADDING * 2 + cols * PW + (cols - 1) * GAP;
      const TOTAL_H = PADDING * 2 + TITLE_H + rows * PH + (rows - 1) * GAP + FOOTER_H;
      const sharedYLog = customLog && _seriesAllPositive(facets.flatMap(f => f.series));
      const xLabel = `${xCol.label}${xCol.unit ? ` (${xCol.unit})` : ""}`;
      const yLabel = `${yCol.label}${yCol.unit ? ` (${yCol.unit})` : ""}`;
      const facetVarLabel = `${gFacetCol.label}${gFacetCol.unit ? ` (${gFacetCol.unit})` : ""}`;

      // Render each facet panel to its own SVG string, then nest each
      // inside a <g transform="translate(...)"> within an outer <svg>.
      const panels = facets.map((f, i) => {
        const r = Math.floor(i / cols), c = i % cols;
        const x = PADDING + c * (PW + GAP);
        const y = PADDING + TITLE_H + r * (PH + GAP);
        const panelSvg = _chartSpecToSvgString({
          series: f.series,
          xLabel, yLabel,
          w: PW, h: PH,
          xCategorical: f.xCategorical,
          xLabels: f.xLabels,
          xMin: customSliceData.sharedXMin, xMax: customSliceData.sharedXMax,
          yMin: customSliceData.sharedYMin, yMax: customSliceData.sharedYMax,
          yLog: sharedYLog,
          legendCols: 1,
          connectLines: xCol.kind === "input",
        });
        // Strip the outer <svg ...> wrapper from the panel — we keep its
        // inner content and wrap in a translate group.
        const inner = panelSvg
          .replace(/^<svg[^>]*>/, '')
          .replace(/<\/svg>$/, '');
        const titleY = y - 6;
        return `
<g transform="translate(${x},${y})">${inner}</g>
<text x="${x + PW/2}" y="${titleY}" fill="${C.txt}" font-size="13" font-family="'Barlow Condensed',sans-serif" font-weight="700" text-anchor="middle">
  ${facetVarLabel.split("(")[0].trim()} = ${f.facetLabel}${gFacetCol.unit ? ` ${gFacetCol.unit}` : ""}
</text>`;
      }).join("");

      const heading = `${yLabel} vs ${xLabel} — faceted by ${facetVarLabel}`;
      // Include the held-vars caption (everything held constant for the
      // ENTIRE grid, excluding the facet variable which varies per panel)
      // so a reader of the exported image sees the same context the
      // on-screen panel shows above the chart.
      const heldCap = (customSliceData.slice && customSliceData.slice.held && customSliceData.slice.held.length > 0)
        ? _heldSliceCaption({...customSliceData.slice, held: customSliceData.slice.held.filter(h => h.varSpec.id !== gFacetCol.varId)}, units)
        : "";
      const colorPart = gColorCol ? `Color: ${gColorCol.label}` : "Single series per panel";
      const subHeading = heldCap
        ? `${colorPart} · ${heldCap}`
        : `${colorPart} · ${N} panels · shared X/Y axes`;

      const composed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TOTAL_W} ${TOTAL_H}" width="${TOTAL_W}" height="${TOTAL_H}">
<rect x="0" y="0" width="${TOTAL_W}" height="${TOTAL_H}" fill="${C.bg}"/>
<text x="${TOTAL_W/2}" y="22" fill="${C.accent}" font-size="16" font-family="'Barlow Condensed',sans-serif" font-weight="700" text-anchor="middle" letter-spacing=".7px">${heading}</text>
<text x="${TOTAL_W/2}" y="40" fill="${C.txtDim}" font-size="11" font-family="'Barlow',sans-serif" text-anchor="middle">${subHeading}</text>
${panels}
</svg>`;

      const png = await _svgStringToPngBlob(composed, TOTAL_W, TOTAL_H);
      const colSuf = gColorCol ? `_color_${_sanitizeFilename(gColorCol.label)}` : "";
      const facSuf = `_facet_${_sanitizeFilename(gFacetCol.label)}`;
      const logSuf = sharedYLog ? "_logy" : "";
      const fname = `${_sanitizeFilename(yCol.label)}_vs_${_sanitizeFilename(xCol.label)}${colSuf}${facSuf}${logSuf}.png`;
      _triggerBlobDownload(png, fname);
    } catch (e){
      console.error("facet grid export failed:", e);
      alert(`Facet export failed: ${e.message || e}`);
    } finally {
      setExporting(null);
    }
  }, [gFacetCol, gColorCol, xCol, yCol, customSliceData, customLog, units]);

  const exportSingleAuto = useCallback(async (ch) => {
    setExporting(ch.key);
    try {
      const useLog = logFlags[ch.key] != null ? logFlags[ch.key] : false;
      const props = _autoChartSpec(ch, useLog);
      const svg = _chartSpecToSvgString(props);
      // Add the same conditions header the on-screen panel shows so the
      // exported PNG carries the context of what was held constant.
      const subtitle = ch.slice ? _heldSliceCaption(ch.slice, units) : null;
      const HEADER_H = subtitle ? 52 : 32;
      const wrapped = _wrapChartWithHeader(svg, props.w, props.h, ch.title, subtitle);
      const png = await _svgStringToPngBlob(wrapped, props.w, props.h + HEADER_H);
      const logSuffix = props.yLog ? "_logy" : "";
      const base = ch.filename.replace(/\.png$/, "");
      _triggerBlobDownload(png, `${base}${logSuffix}.png`);
    } catch (e){
      console.error("single chart export failed:", e);
      alert(`Export failed: ${e.message || e}`);
    } finally {
      setExporting(null);
    }
  }, [logFlags, units]);

  const exportZipAll = useCallback(async () => {
    if (renderedCharts.length === 0) return;
    setExporting("zip");
    try {
      const zip = new JSZip();
      // Pre-rank ordering inside each folder is preserved — just slap a
      // 2-digit ordinal on each filename so the directory listing reads
      // top-to-bottom in priority order even for users on filesystems
      // that don't sort naturally.
      const counters = {};
      for (const ch of renderedCharts){
        const useLog = logFlags[ch.key] != null ? logFlags[ch.key] : false;
        const props  = _autoChartSpec(ch, useLog);
        const svg    = _chartSpecToSvgString(props);
        // Same conditions header treatment as the single-export path.
        const subtitle = ch.slice ? _heldSliceCaption(ch.slice, units) : null;
        const HEADER_H = subtitle ? 52 : 32;
        const wrapped  = _wrapChartWithHeader(svg, props.w, props.h, ch.title, subtitle);
        const png      = await _svgStringToPngBlob(wrapped, props.w, props.h + HEADER_H);
        const folder = zip.folder(ch.category);
        counters[ch.category] = (counters[ch.category] || 0) + 1;
        const ord = String(counters[ch.category]).padStart(2, "0");
        const logSuffix = props.yLog ? "_logy" : "";
        const base = ch.filename.replace(/\.png$/, "");
        folder.file(`${ord}_${base}${logSuffix}.png`, png);
      }
      // README inside the ZIP — small note describing how plots are sorted
      // and what the categories mean. Pure plain text, never expensive.
      const readme = [
        "ProReadyEngineer · Combustion Toolkit — Automated Plots",
        "",
        `Run captured ${results.length} matrix rows (${ok} valid, ${errored} errored).`,
        `${renderedCharts.length} plots exported, organized by combustion-domain priority.`,
        "",
        "Folder ordering (most decision-relevant first):",
        "  01_emissions            NOx, CO @ 15% O₂ — regulatory drivers",
        "  02_flame_temperatures   T_ad, T_psr, T_AFT, T_Bulk, T4",
        "  03_stability_blowoff    S_L, blowoff velocity, τ_BO, Damköhler, g_c",
        "  04_autoignition         τ_ign, τ_res, τ_chem, ignition margin",
        "  05_cycle_performance    MW, η_LHV, heat rate, station temps",
        "  06_mapping_correlations PX36, ΔT_Main, C3-effective",
        "  07_mass_flows           mdot air / fuel / bleed / water",
        "  08_phi_FAR              φ4, FAR4, φ_Bulk, exhaust-derived φ",
        "  09_pressures            P3, P_exhaust",
        "  10_fuel_properties      LHV, MW, SG, AFR, Wobbe, MWI",
        "  11_inlet_temps_transport T_mixed, α_th",
        "  12_mole_fractions       X_NO, X_OH, X_CO, X_CO2, X_H2O",
        "  13_conversion_residence PSR conv, τ_PFR, τ_total",
        "  14_exhaust_inverted     T_ad / FAR derived from O₂ / CO₂ measurements",
        "  15_O2_inerts            Exhaust O₂, X_O2, bleed fraction",
        "",
        `Generated ${new Date().toISOString()}`,
        `Units: ${units}`,
      ].join("\n");
      zip.file("README.txt", readme);

      const blob = await zip.generateAsync({type: "blob", compression: "DEFLATE"});
      const ts = new Date().toISOString().slice(0, 16).replace(/[:T-]/g, "");
      _triggerBlobDownload(blob, `ProReadyEngineer_Plots_${ts}.zip`);
    } catch (e){
      console.error("ZIP export failed:", e);
      alert(`ZIP export failed: ${e.message || e}`);
    } finally {
      setExporting(null);
    }
  }, [renderedCharts, logFlags, results.length, ok, errored, units]);

  return (
    <div style={{
      marginTop: 14, padding: 14, background: C.bg2, borderRadius: 8,
      border: `1px solid ${C.accent}30`,
    }}>
      <div style={{display:"flex", alignItems:"center", marginBottom: 10}}>
        <span style={{fontSize: 14, fontWeight: 700, color: C.accent,
          fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:".7px"}}>
          📊 PLOT DATA · {ok} valid rows{errored > 0 ? ` · ${errored} errored (skipped)` : ""}
        </span>
        <button onClick={onClose}
          style={{marginLeft:"auto", padding:"4px 12px", fontSize:11, fontWeight:600,
            color: C.txtDim, background: "transparent", border: `1px solid ${C.border}`,
            borderRadius:4, cursor:"pointer", fontFamily:"'Barlow Condensed',sans-serif"}}>
          ✕ CLOSE
        </button>
      </div>

      {/* ── Custom plot builder ─────────────────────────────────────── */}
      <div style={{padding:10, background:C.bg, borderRadius:6, marginBottom:14,
        border:`1px solid ${C.border}`}}>
        <div style={{fontSize:11, fontWeight:700, color:C.txtDim,
          fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:".6px",
          textTransform:"uppercase", marginBottom:6}}>
          Custom plot — every other varied input is held at baseline
        </div>
        <div style={{fontSize:10, color:C.txtMuted, marginBottom:10,
          fontFamily:"'Barlow',sans-serif", lineHeight:1.5}}>
          Pick X, Y, and up to two grouping inputs. <strong>Color</strong> grouping splits
          series by the first grouping variable; <strong>Shape</strong> grouping changes
          marker shape per value of the second. Every other varied input is
          held at its baseline value (or the most-common matrix value if
          baseline isn't in the swept range).
        </div>
        <div style={{display:"grid",
          gridTemplateColumns:"repeat(auto-fit, minmax(200px, 1fr))",
          gap:12, marginBottom:10}}>
          <ColPicker label="X axis" cols={allCols} value={customXId} onChange={setCustomXId}/>
          <ColPicker label="Y axis" cols={allCols} value={customYId} onChange={setCustomYId}/>
          <ColPicker label="Group by COLOR (primary)" cols={inputCols} value={customGColorId}
            onChange={setCustomGColorId}
            allowNone={true} noneLabel="(no color grouping)"/>
          <ColPicker label="Secondary Grouping (Facet Below)" cols={inputCols} value={customGFacetId}
            onChange={setCustomGFacetId}
            allowNone={true} noneLabel="(no faceting — single chart only)"/>
        </div>
        {/* ── Held-constant value pickers ─────────────────────────────
            One dropdown per held variable, populated with the distinct
            values that appear in the matrix. Default selection = the
            baseline value if it's in the matrix, else the most-common
            value. Picking a value sets a user override that takes
            precedence over baseline/mode and triggers a slice recompute. */}
        {customSliceData && customSliceData.slice && (customSliceData.slice.candidates?.length > 0 || customSliceData.slice.held.length > 0) && (
          <HeldValuePicker
            slice={customSliceData.slice}
            units={units}
            heldOverrides={heldOverrides}
            setHeldOverrides={setHeldOverrides}
          />
        )}
        <div style={{display:"flex", alignItems:"center", gap:14, marginBottom:8, flexWrap:"wrap"}}>
          <label style={{display:"flex", alignItems:"center", gap:6, fontSize:11,
            color:C.txtDim, cursor:"pointer", fontFamily:"'Barlow',sans-serif"}}>
            <input type="checkbox" checked={customLog} onChange={e=>setCustomLog(e.target.checked)}/>
            Y log scale
          </label>
          <button onClick={exportCustomPlot}
            disabled={!xCol || !yCol || !customSliceData || customSliceData.series.length === 0 || exporting === "custom"}
            style={{marginLeft:"auto", padding:"5px 12px", fontSize:11, fontWeight:700,
              color: C.bg, background: C.accent2, border: "none", borderRadius:4,
              cursor: (!xCol || !yCol || !customSliceData || customSliceData.series.length === 0) ? "not-allowed" : "pointer",
              opacity: (!xCol || !yCol || !customSliceData || customSliceData.series.length === 0) ? 0.4 : 1,
              fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:".5px"}}>
            {exporting === "custom" ? "⏳ EXPORTING…" : "📥 EXPORT MAIN PNG"}
          </button>
          {gFacetCol && customSliceData?.facets?.length > 0 && (
            <button onClick={exportFacetGrid}
              disabled={exporting === "facets"}
              style={{padding:"5px 12px", fontSize:11, fontWeight:700,
                color: C.bg, background: C.good, border: "none", borderRadius:4,
                cursor: "pointer",
                fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:".5px"}}>
              {exporting === "facets"
                ? "⏳ COMPOSING…"
                : `📥 EXPORT FACETS PNG (${customSliceData.facets.length})`}
            </button>
          )}
        </div>
        {xCol && yCol && customSliceData && customSliceData.series.length > 0 ? (
          <div style={{background:C.bg2, borderRadius:6, padding:8}}>
            <div style={{fontSize:12, color:C.txt, marginBottom:4, fontWeight:600,
              fontFamily:"'Barlow',sans-serif"}}>
              {yCol.label}{yCol.unit ? ` (${yCol.unit})` : ""} vs {xCol.label}{xCol.unit ? ` (${xCol.unit})` : ""}
              {gColorCol ? ` · color by ${gColorCol.label}` : ""}
              {gFacetCol ? ` · faceted below by ${gFacetCol.label}` : ""}
            </div>
            <div style={{fontSize:10, color: C.txtMuted,
              marginBottom:6, fontFamily:"'Barlow',sans-serif", lineHeight:1.4}}>
              {_heldSliceCaption(customSliceData.mainSlice || customSliceData.slice, units)}
              {customSliceData.mainFacetPin && (
                <div style={{marginTop:2, color: C.warm, fontStyle:"italic"}}>
                  Main plot pinned to {gFacetCol.label}
                  {" = "}{_plotFmtVal(gFacetCol, customSliceData.mainFacetPin.value)}
                  {gFacetCol.unit ? ` ${gFacetCol.unit}` : ""}
                  {customSliceData.mainFacetPin.source === "mode"     ? " (mode — baseline missed matrix)"
                  : customSliceData.mainFacetPin.source === "user"     ? " (picked)"
                  :                                                     " (baseline)"}
                  . Change the value via the held-vars picker above; the faceted panels below show the full {gFacetCol.label} variation regardless.
                </div>
              )}
            </div>
            <MultiSeriesChart
              series={customSliceData.series}
              xLabel={`${xCol.label}${xCol.unit ? ` (${xCol.unit})` : ""}`}
              yLabel={`${yCol.label}${yCol.unit ? ` (${yCol.unit})` : ""}`}
              w={760} h={420}
              xCategorical={customSliceData.xCategorical}
              xLabels={customSliceData.xLabels}
              xMin={customSliceData.sharedXMin} xMax={customSliceData.sharedXMax}
              yMin={customSliceData.sharedYMin} yMax={customSliceData.sharedYMax}
              yLog={customLog && _seriesAllPositive(customSliceData.series)}
              legendCols={customSliceData.series.length > 6 ? 3 : 2}
              // Output X axis = scatter cloud (no natural ordering of points
              // along X within a series). Drop the connecting line so
              // markers stand alone instead of zigzagging.
              connectLines={xCol.kind === "input"}
            />
            {/* ── Faceted small-multiples grid ─────────────────────────
                Same X/Y axes as the main plot above, but split by the
                user's secondary grouping variable. Each panel shows only
                rows where the facet variable equals that value, with the
                primary color grouping preserved. Shared axis bounds make
                panels back-to-back comparable. */}
            {gFacetCol && customSliceData.facets && customSliceData.facets.length > 0 && (
              <div style={{marginTop:14, paddingTop:12, borderTop:`1px solid ${C.border}`}}>
                <div style={{fontSize:11, fontWeight:700, color:C.accent,
                  fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:".6px",
                  textTransform:"uppercase", marginBottom:4}}>
                  Faceted by {gFacetCol.label} — small-multiples comparison
                </div>
                <div style={{fontSize:10, color:C.txtMuted, marginBottom:8,
                  fontFamily:"'Barlow',sans-serif", lineHeight:1.4}}>
                  {customSliceData.facets.length} panel{customSliceData.facets.length !== 1 ? "s" : ""} ·
                  shared X / Y axes · same color set as the main plot above.
                  {customSliceData.facetOverflow && (
                    <span style={{color:C.warm, marginLeft:6}}>
                      ⚠ Capped at {FACET_CAP} panels — pick a coarser grouping for fewer facets.
                    </span>
                  )}
                </div>
                <div style={{display:"grid",
                  gridTemplateColumns: `repeat(${customSliceData.facets.length <= 2 ? customSliceData.facets.length : (customSliceData.facets.length <= 6 ? 3 : 4)}, minmax(0, 1fr))`,
                  gap:10}}>
                  {customSliceData.facets.map((f, i) => (
                    <div key={i} style={{background:C.bg, padding:6, borderRadius:5,
                      border:`1px solid ${C.border}`}}>
                      <div style={{fontSize:11, fontWeight:600, color:C.txt,
                        fontFamily:"'Barlow',sans-serif", marginBottom:2,
                        textAlign:"center"}}>
                        {gFacetCol.label} = {f.facetLabel}{gFacetCol.unit ? ` ${gFacetCol.unit}` : ""}
                      </div>
                      <div style={{fontSize:9, color:C.txtMuted,
                        fontFamily:"monospace", marginBottom:4, textAlign:"center"}}>
                        {f.pointCount} point{f.pointCount !== 1 ? "s" : ""}
                      </div>
                      <MultiSeriesChart
                        series={f.series}
                        xLabel={`${xCol.label}${xCol.unit ? ` (${xCol.unit})` : ""}`}
                        yLabel={`${yCol.label}${yCol.unit ? ` (${yCol.unit})` : ""}`}
                        w={460} h={300}
                        xCategorical={f.xCategorical}
                        xLabels={f.xLabels}
                        xMin={customSliceData.sharedXMin} xMax={customSliceData.sharedXMax}
                        yMin={customSliceData.sharedYMin} yMax={customSliceData.sharedYMax}
                        yLog={customLog && _seriesAllPositive(f.series)}
                        legendCols={f.series.length > 4 ? 2 : 1}
                        connectLines={xCol.kind === "input"}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div style={{padding:14, color:C.txtMuted, fontSize:12, fontStyle:"italic",
            fontFamily:"monospace", textAlign:"center"}}>
            {(!xCol || !yCol)
              ? "Pick an X and Y column above to build a custom plot."
              : "No rows match the held-constant slice. Try changing X / grouping or remove a grouping variable."}
          </div>
        )}
      </div>

      {/* ── Auto plots ──────────────────────────────────────────────── */}
      <div>
        <div style={{display:"flex", alignItems:"center", gap:10, marginBottom:8, flexWrap:"wrap"}}>
          <span style={{fontSize:11, fontWeight:700, color:C.txtDim,
            fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:".6px",
            textTransform:"uppercase"}}>
            Auto plots — sorted by combustion priority
            <span style={{fontWeight:400, color:C.txtMuted, marginLeft:6}}>
              ({renderedCharts.length} of {autoCharts.length} shown
              {autoCharts.length > 0 ? `; constant outputs filtered out` : ""})
            </span>
          </span>
          <PlotMultiSelect
            charts={autoCharts}
            selectedKeys={selectedKeys}
            setSelectedKeys={setSelectedKeys}
          />
          <button onClick={exportZipAll}
            disabled={renderedCharts.length === 0 || exporting === "zip"}
            style={{padding:"5px 12px", fontSize:11, fontWeight:700,
              color: C.bg, background: C.good, border: "none", borderRadius:4,
              cursor: renderedCharts.length === 0 ? "not-allowed" : "pointer",
              opacity: renderedCharts.length === 0 ? 0.4 : 1,
              fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:".5px"}}
            title={`Export the ${renderedCharts.length} selected plot${renderedCharts.length !== 1 ? "s" : ""} as a ZIP, organized into combustion-domain folders.`}>
            {exporting === "zip" ? `⏳ ZIPPING…` : `📦 EXPORT ${renderedCharts.length} AS ZIP`}
          </button>
        </div>
        {autoCharts.length === 0 && (
          <div style={{padding:14, color:C.txtMuted, fontSize:12, fontStyle:"italic",
            fontFamily:"monospace"}}>
            No informative auto plots — every output is constant across the matrix
            (or no inputs are varied). Vary at least one input that drives a
            non-constant output to populate this section.
          </div>
        )}
        {autoCharts.length > 0 && renderedCharts.length === 0 && (
          <div style={{padding:14, color:C.txtMuted, fontSize:12, fontStyle:"italic",
            fontFamily:"monospace"}}>
            No plots selected. Use the picker above to choose which charts to display.
          </div>
        )}
        <div style={{display:"grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
          gap: 10}}>
          {renderedCharts.map(ch => {
            const useLog = logFlags[ch.key] != null ? logFlags[ch.key] : false;
            const canLog = _seriesAllPositive(ch.data.series);
            return (
              <div key={ch.key} style={{background:C.bg, padding:8, borderRadius:6,
                border:`1px solid ${C.border}`}}>
                <div style={{display:"flex", alignItems:"flex-start", marginBottom:4, gap:8}}>
                  <div style={{flex:1, minWidth:0}}>
                    <div style={{fontSize:11.5, fontWeight:700, color:C.txt,
                      fontFamily:"'Barlow',sans-serif"}}>
                      {ch.yCol.label}{ch.yCol.unit ? ` (${ch.yCol.unit})` : ""} vs {ch.xCol.label}{ch.xCol.unit ? ` (${ch.xCol.unit})` : ""}
                      {ch.gColorCol ? <span style={{color:C.accent, marginLeft:6, fontWeight:600, fontSize:10}}>· color: {ch.gColorCol.label}</span> : null}
                    </div>
                    <div style={{fontSize:9.5, color: C.txtMuted,
                      marginTop:2, fontFamily:"'Barlow',sans-serif", lineHeight:1.35}}>
                      {_heldSliceCaption(ch.slice, units)}
                    </div>
                  </div>
                  {canLog && (
                    <label style={{display:"flex", alignItems:"center", gap:4,
                      fontSize:10, color: ch.logHint ? C.accent2 : C.txtMuted, cursor:"pointer",
                      fontFamily:"'Barlow',sans-serif", whiteSpace:"nowrap"}}
                      title={ch.logHint ? "Wide y-range — log scale recommended" : "Toggle log y axis"}>
                      <input type="checkbox" checked={useLog}
                        onChange={e => setLogFlags(f => ({...f, [ch.key]: e.target.checked}))}/>
                      log y{ch.logHint ? " ★" : ""}
                    </label>
                  )}
                  <button onClick={() => exportSingleAuto(ch)}
                    disabled={exporting === ch.key}
                    style={{padding:"2px 8px", fontSize:10, fontWeight:700,
                      color: C.txtDim, background: "transparent",
                      border: `1px solid ${C.border}`, borderRadius:3, cursor:"pointer",
                      fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:".4px",
                      whiteSpace:"nowrap"}}
                    title="Export this plot as a PNG file">
                    {exporting === ch.key ? "⏳" : "📥 PNG"}
                  </button>
                </div>
                <MultiSeriesChart
                  series={ch.data.series}
                  xLabel={`${ch.xCol.label}${ch.xCol.unit ? ` (${ch.xCol.unit})` : ""}`}
                  yLabel={`${ch.yCol.label}${ch.yCol.unit ? ` (${ch.yCol.unit})` : ""}`}
                  w={520} h={300}
                  xCategorical={ch.data.xCategorical}
                  xLabels={ch.data.xLabels}
                  yLog={useLog && canLog}
                  legendCols={ch.data.series.length > 4 ? 2 : 1}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Searchable multi-select dropdown for the auto-plot selector ──
//   Trigger button shows "{N selected of M}". Click → opens a panel with
//   a search box, select-all/clear shortcuts, and a category-grouped
//   checkbox list. Click outside closes. Keys click on the chart key
//   from autoCharts; the parent renders only checked charts.
function PlotMultiSelect({ charts, selectedKeys, setSelectedKeys }){
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const wrapRef = useRef(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const filtered = useMemo(() => {
    if (!q.trim()) return charts;
    const needle = q.trim().toLowerCase();
    return charts.filter(ch =>
      ch.title.toLowerCase().includes(needle) ||
      ch.category.toLowerCase().includes(needle)
    );
  }, [charts, q]);

  // Group by category for the list.
  const grouped = useMemo(() => {
    const m = new Map();
    for (const ch of filtered){
      if (!m.has(ch.category)) m.set(ch.category, []);
      m.get(ch.category).push(ch);
    }
    return [...m.entries()].sort((a,b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const toggle = (key) => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const selectAllFiltered = () => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      for (const ch of filtered) next.add(ch.key);
      return next;
    });
  };
  const clearAllFiltered = () => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      for (const ch of filtered) next.delete(ch.key);
      return next;
    });
  };

  const totalSel = selectedKeys.size;
  const totalAll = charts.length;

  return (
    <div ref={wrapRef} style={{position:"relative"}}>
      <button onClick={() => setOpen(o => !o)}
        style={{padding:"5px 12px", fontSize:11, fontWeight:600,
          color: C.txt, background: C.bg, border: `1px solid ${C.accent}80`,
          borderRadius:4, cursor:"pointer", fontFamily:"'Barlow Condensed',sans-serif",
          letterSpacing:".4px", minWidth: 240, textAlign:"left",
          display:"flex", alignItems:"center", gap:8}}>
        <span>SELECT PLOTS · {totalSel} / {totalAll}</span>
        <span style={{marginLeft:"auto", color: C.accent, fontSize:10}}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{position:"absolute", top:"calc(100% + 4px)", left:0, zIndex:50,
          width: 460, maxHeight: 420, overflow:"hidden", display:"flex", flexDirection:"column",
          background: C.bg2, border: `1px solid ${C.accent}80`, borderRadius: 6,
          boxShadow: "0 8px 24px rgba(0,0,0,0.5)"}}>
          <div style={{padding: 8, borderBottom: `1px solid ${C.border}`,
            display:"flex", flexDirection:"column", gap:6}}>
            <input type="text" value={q} placeholder="search title, category…"
              onChange={e => setQ(e.target.value)}
              style={{padding:"5px 8px", fontSize:11, background: C.bg, color: C.txt,
                border: `1px solid ${C.border}`, borderRadius:4, fontFamily:"monospace"}}/>
            <div style={{display:"flex", gap:6, fontSize:10}}>
              <button onClick={selectAllFiltered}
                style={{flex:1, padding:"4px 8px", fontSize:10, fontWeight:600,
                  color: C.accent, background:"transparent", border:`1px solid ${C.accent}60`,
                  borderRadius:3, cursor:"pointer", fontFamily:"'Barlow Condensed',sans-serif"}}>
                ✓ SELECT {filtered.length}{q ? " FILTERED" : " ALL"}
              </button>
              <button onClick={clearAllFiltered}
                style={{flex:1, padding:"4px 8px", fontSize:10, fontWeight:600,
                  color: C.warm, background:"transparent", border:`1px solid ${C.warm}60`,
                  borderRadius:3, cursor:"pointer", fontFamily:"'Barlow Condensed',sans-serif"}}>
                ✕ CLEAR{q ? " FILTERED" : " ALL"}
              </button>
            </div>
          </div>
          <div style={{flex:1, overflowY:"auto", padding: 6}}>
            {grouped.length === 0 && (
              <div style={{padding:8, color:C.txtMuted, fontSize:11, fontStyle:"italic",
                fontFamily:"monospace"}}>
                no charts match
              </div>
            )}
            {grouped.map(([cat, items]) => (
              <div key={cat} style={{marginBottom:8}}>
                <div style={{fontSize:9.5, fontWeight:700, color: C.accent,
                  textTransform:"uppercase", letterSpacing:".7px", padding:"4px 6px",
                  background:`${C.accent}10`, borderRadius:3,
                  fontFamily:"'Barlow Condensed',sans-serif"}}>
                  {cat.replace(/^\d+_/, "").replace(/_/g, " ")} ({items.length})
                </div>
                {items.map(ch => {
                  const checked = selectedKeys.has(ch.key);
                  return (
                    <label key={ch.key}
                      style={{display:"flex", alignItems:"center", gap:6, padding:"3px 6px",
                        cursor:"pointer", fontSize:11, fontFamily:"'Barlow',sans-serif",
                        color: checked ? C.txt : C.txtDim,
                        background: checked ? `${C.accent}14` : "transparent",
                        borderRadius:3}}>
                      <input type="checkbox" checked={checked} onChange={() => toggle(ch.key)}/>
                      <span style={{fontFamily:"monospace", fontSize:10.5}}>{ch.title}</span>
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Heuristic: prefer a log y axis when all-positive AND span ≥ 2 orders.
function _shouldLogAxis(series){
  const ys = series.flatMap(s => s.points.map(p => p.y)).filter(Number.isFinite);
  if (ys.length === 0) return false;
  const positives = ys.filter(v => v > 0);
  if (positives.length !== ys.length) return false;
  const lo = Math.min(...positives), hi = Math.max(...positives);
  return hi / Math.max(lo, 1e-30) >= 100;
}
function _seriesAllPositive(series){
  return series.every(s => s.points.every(p => p.y > 0));
}

// ── ListInput — local-state text field for the DOE "List" mode ──
//
// The naive `<input value={cfg.list...} onChange={parse-on-every-keystroke}>`
// pattern caused awful typing UX: every keystroke parsed the comma-separated
// string, normalized to SI, called updateVarSpec → triggered a full
// AutomatePanel re-render → recomputed matrix size estimate → shifted page
// layout. Result: typing felt sluggish and the page jumped while you typed.
//
// This component decouples typing from upstream re-renders:
//   - Local string state holds whatever the user is typing, including
//     incomplete values like "30," or "30, 4" with trailing commas/spaces.
//   - Upstream `onCommit` only fires on blur or Enter, when the user
//     signals they're done editing. Then we parse, drop blanks/NaN, convert
//     display→SI, and ship the SI list to varSpecs.
//   - Re-syncs from props if the upstream value changes externally (e.g.
//     user clears it from elsewhere).
function ListInput({ isEnum, def, units, list, placeholder, onCommit, style }){
  // Format the upstream SI list as a display string for the input.
  const formatFromList = useCallback((arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return "";
    if (isEnum) return arr.join(", ");
    return arr.map(v => toDisplay(def, v, units)).join(", ");
  }, [isEnum, def, units]);

  const [text, setText] = useState(() => formatFromList(list));
  // Re-sync from props when the upstream list changes from outside (mode
  // toggle, reset, programmatic clear). We compare the formatted upstream
  // string against the local text — if different, accept upstream.
  useEffect(() => {
    const upstream = formatFromList(list);
    setText(prev => (prev === upstream ? prev : upstream));
    // Only re-sync on upstream changes; ignore our own setText calls below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, formatFromList]);

  const commit = () => {
    const raw = text.split(",").map(s => s.trim()).filter(Boolean);
    const parsed = isEnum
      ? raw
      : raw.map(s => +s).filter(n => Number.isFinite(n)).map(v => toSi(def, v, units));
    // Re-format what we accepted, so the input snaps to the canonical
    // form (drops NaN tokens, removes trailing commas, etc.) AFTER the user
    // has finished typing.
    setText(formatFromList(parsed));
    onCommit(parsed);
  };

  return (
    <input type="text" placeholder={placeholder}
      value={text}
      onChange={e => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } }}
      style={style}/>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   AUTOMATION PANEL (tab UI)
   ──────────────────────────────────────────────────────────────────────────
   Five-step wizard:
     1. PANELS    — pick which calculation panels to run
     2. VARIABLES — pick which inputs to vary (filtered by selected panels)
     3. DOE       — set min/max/step (or list, balance species) per variable
     4. PREVIEW   — review the matrix size, estimated runtime, broken linkages
     5. RUN       — go button + progress + Excel download
   Each step is collapsible; the user can move back and edit any step.
   ══════════════════════════════════════════════════════════════════════════ */

function AutomatePanel(props){
  const units = useContext(UnitCtx);
  const { accurate } = useContext(AccurateCtx);
  const { begin: beginBusy } = useContext(BusyCtx);

  // Snapshot the App's baseline state for use as the "everything else fixed"
  // value in each row. Pass via props so we don't re-grab on every render.
  const baseline = props.baseline;
  const mode = props.mode;   // Application Mode — gates which panels are
                             // automatable (CTK can't run cycle/mapping; Advanced can).

  // ── Mode-filtered automatable panel list ─────────────────────────────
  // Single source of truth for "which panels does this mode allow?" is
  // TABS_BASE.modes (the same list the header tab bar consumes). We mirror
  // that filter here so Automate's picker stays in lockstep — adding a
  // new panel to TABS_BASE with `modes:[…]` automatically updates this
  // picker without a second edit.
  const visibleAutomatablePanels = useMemo(() => {
    return AUTOMATABLE_PANELS.filter(p => {
      const tab = TABS_BASE.find(t => t.id === p.id);
      if (!tab || !tab.modes) return true;       // unconstrained → always shown
      return tab.modes.includes(mode);
    });
  }, [mode]);
  const _allowedSet = useMemo(
    () => new Set(visibleAutomatablePanels.map(p => p.id)),
    [visibleAutomatablePanels],
  );

  // ── Wizard state ──
  const [selectedPanels, setSelectedPanels] = useState([]);
  const [selectedVarIds, setSelectedVarIds] = useState([]);
  const [varSpecs, setVarSpecs] = useState({});  // {varId: {mode, min, max, step, list, balanceSpecies}}
  const [selectedOutputIds, setSelectedOutputIds] = useState(null);  // null = all-of-panel
  const [running, setRunning]   = useState(false);
  const [progress, setProgress] = useState(null);
  const [results, setResults]   = useState(null);
  const [errMsg, setErrMsg]     = useState(null);
  const [showPlots, setShowPlots] = useState(false);
  const abortRef = useRef({aborted:false});

  // Prune any previously-selected panel that the new mode disallows.
  // Without this, switching from Advanced (with cycle+mapping selected)
  // to Combustion Toolkit would leave stale selections that the runner
  // would still try to execute — silently producing wrong rows or 401s.
  useEffect(() => {
    setSelectedPanels(prev => {
      const next = prev.filter(id => _allowedSet.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [_allowedSet]);

  // Auto-include dependency panels (mapping → cycle)
  const effectivePanels = useMemo(
    () => expandPanelDeps(selectedPanels),
    [selectedPanels],
  );
  const autoIncluded = effectivePanels.filter(p => !selectedPanels.includes(p));

  // Variables relevant to the selected panels
  const relevantVars = useMemo(
    () => varsForPanels(effectivePanels),
    [effectivePanels],
  );

  // Outputs that will be captured (default = all outputs from selected panels)
  const candidateOutputs = useMemo(
    () => outputsForPanels(effectivePanels),
    [effectivePanels],
  );
  const effectiveOutputs = useMemo(() => {
    if (!selectedOutputIds) return candidateOutputs;
    const set = new Set(selectedOutputIds);
    return candidateOutputs.filter(o => set.has(o.id));
  }, [candidateOutputs, selectedOutputIds]);

  // Build the active varSpecs (only those the user selected, with their config)
  const activeVarSpecs = useMemo(() => {
    return selectedVarIds.map(id => {
      const def = AUTO_VARS.find(v => v.id === id);
      const cfg = varSpecs[id] || {};
      const baseSpec = {
        ...def,
        mode: cfg.mode || (def.kind === "enum" || def.kind === "bool" ? "list" : "range"),
        min: cfg.min ?? def.range?.[0] ?? 0,
        max: cfg.max ?? def.range?.[1] ?? 1,
        step: cfg.step ?? def.step ?? 0.1,
        list: cfg.list ?? (def.kind === "enum" ? def.choices.map(c => c.value)
                          : def.kind === "bool" ? [true, false]
                          : null),
        // For fuel-species variables, fall back to the SAME default the
        // balance-species dropdown displays (CH4 for any non-CH4 species,
        // N2 if the user is varying CH4 itself). Without this fallback,
        // varSpecs[id].balanceSpecies stays `undefined` until the user
        // actively clicks the dropdown — and rebalanceFuel silently bails
        // (`if (!fuelBalance) return baselineFuel`), dropping every fuel
        // override and sending unchanged baseline fuel to the backend.
        balanceSpecies: cfg.balanceSpecies
          || (def.kind === "fuel_species"
              ? (def.species === "CH4" ? "N2" : "CH4")
              : undefined),
      };
      return baseSpec;
    });
  }, [selectedVarIds, varSpecs]);

  // Compute the matrix size FIRST (cheap — just multiplies per-var counts).
  // The actual matrix is only enumerated if the size is reasonable. Without
  // this guard, picking 4 variables with default ranges generates millions
  // of rows synchronously and freezes the tab.
  const matrixSize = useMemo(
    () => countMatrixSize(activeVarSpecs),
    [activeVarSpecs],
  );
  const matrixOversized = matrixSize > MAX_MATRIX_SIZE;
  // Reorder varSpecs for cache locality before generating the matrix.
  // The factorial cross-product puts FIRST-listed var as slowest-varying;
  // reordering Tier-1 (Cycle) vars to the front maximizes cache hits for
  // the heavy Cycle backend call when downstream vars sweep. Display order
  // (preview table, Excel headers) still uses activeVarSpecs (user order).
  const matrixSpecs = useMemo(
    () => reorderForCacheLocality(activeVarSpecs),
    [activeVarSpecs],
  );
  const matrix = useMemo(
    () => (matrixSpecs.length && !matrixOversized) ? generateMatrix(matrixSpecs) : [],
    [matrixSpecs, matrixOversized],
  );

  // T_flame as an operating-condition variable triggers the per-row
  // /calc/solve-phi-for-tflame bisection — it adds non-trivial time
  // even after the brentq+pool optimization, so the estimator tracks
  // it as part of the run signature.
  const needsBisection = useMemo(
    () => selectedVarIds.includes("T_flame"),
    [selectedVarIds],
  );

  // Adaptive runtime estimate. On the first run for a given (panels,
  // mode, bisection) signature we use calibrated defaults; from the
  // second run on, the EMA of measured per-row time takes over. The
  // {seconds, source, sampleCount} bundle lets the UI flag whether the
  // estimate is `default` (a guess) or `calibrated` (tuned to your
  // actual hardware + network + load history).
  const estimate = useMemo(() => {
    return estimateRunSeconds(
      effectivePanels,
      accurate ? "accurate" : "free",
      needsBisection,
      matrixSize,
    );
  }, [effectivePanels, accurate, needsBisection, matrixSize]);
  const estimatedSec = Math.round(estimate.seconds);

  // Any auto-broken linkages?
  const brokenLinkages = useMemo(() => {
    if (!effectivePanels.includes("cycle")) return [];
    const out = [];
    for (const id of selectedVarIds){
      const def = AUTO_VARS.find(v => v.id === id);
      if (def?.linkage) out.push({ var: id, linkage: def.linkage });
    }
    return out;
  }, [selectedVarIds, effectivePanels]);

  // ── Cycle requires Accurate Mode ──
  const cycleRequiresAccurate = effectivePanels.includes("cycle") && !accurate;

  const togglePanel = (pid) => {
    setSelectedPanels(prev => prev.includes(pid)
      ? prev.filter(p => p !== pid)
      : [...prev, pid]);
  };
  // Toast for transient user-facing notes (e.g. mutex group hits). Auto-clears
  // after 5 s. Only one toast at a time.
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);
  const showToast = (msg) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => setToast(null), 5000);
  };
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  const toggleVar = (vid) => {
    setSelectedVarIds(prev => {
      if (prev.includes(vid)) return prev.filter(v => v !== vid);
      // ── Mutex groups: variables tagged with the same `group` are
      // physically redundant. Adding one removes any others in the same
      // group and surfaces a 5-second note explaining why.
      const def = AUTO_VARS.find(v => v.id === vid);
      if (def?.group){
        const conflicting = prev.filter(otherId => {
          const otherDef = AUTO_VARS.find(v => v.id === otherId);
          return otherDef?.group === def.group;
        });
        if (conflicting.length > 0){
          const conflictLabels = conflicting
            .map(id => AUTO_VARS.find(v => v.id === id)?.label)
            .filter(Boolean).join(", ");
          showToast(`Removed ${conflictLabels} — only one of these variables can be varied at a time because they are mutually dependent (set one, the others are determined).`);
          return [...prev.filter(id => !conflicting.includes(id)), vid];
        }
      }
      return [...prev, vid];
    });
  };
  const updateVarSpec = (vid, patch) => {
    setVarSpecs(prev => ({...prev, [vid]: {...(prev[vid]||{}), ...patch}}));
  };

  // ── Pre-run check: which varied inputs have a baseline value that
  //    ISN'T in their swept set?
  //
  //    These are the variables that will trigger the "mode-fallback"
  //    slice when the user later picks a plot whose held-vars include
  //    them — meaning the chart slice will be on a value that isn't the
  //    user's intended baseline. Easier to surface this BEFORE the run
  //    so the user can fix sidebar values or sweep ranges, rather than
  //    after they've spent compute time only to see a fallback warning
  //    in the chart caption.
  const baselineMismatches = useMemo(() => {
    if (matrix.length === 0) return [];
    const out = [];
    for (const v of activeVarSpecs){
      // Read swept distinct values for this var directly from the matrix.
      const colKey = v.id;
      const isFuelSp = v.kind === "fuel_species";
      const isOxSp   = v.kind === "ox_species";
      const sweptSet = new Set();
      const sweptDisplay = [];
      for (const row of matrix){
        let val;
        if (isFuelSp) val = row.fuel ? row.fuel[v.species] : (row[colKey]);
        else if (isOxSp) val = row.ox ? row.ox[v.species] : (row[colKey]);
        else val = row[colKey];
        if (val == null) continue;
        const k = (typeof val === "number") ? +val.toPrecision(8) : String(val);
        if (!sweptSet.has(k)){ sweptSet.add(k); sweptDisplay.push(val); }
      }
      // Read baseline for this var.
      let baseRaw;
      if (isFuelSp) baseRaw = baseline?.fuel?.[v.species];
      else if (isOxSp) baseRaw = baseline?.ox?.[v.species];
      else baseRaw = baseline?.[v.id];
      if (baseRaw == null) continue;  // no baseline to mismatch against
      const baseInSwept = sweptDisplay.some(s => _valuesMatch(s, baseRaw));
      if (!baseInSwept){
        out.push({ varSpec: v, baselineVal: baseRaw, sweptVals: sweptDisplay });
      }
    }
    return out;
  }, [matrix, activeVarSpecs, baseline]);

  // Modal state for the pre-run baseline warning. `pendingRun` set to
  // true when the user clicked Run but the warning is showing → after
  // they acknowledge we proceed with the actual run.
  const [showBaselineWarn, setShowBaselineWarn] = useState(false);

  // Actual run logic — separated from `startRun` so the modal's "Run
  // anyway" can call it directly without re-checking the warning gate.
  const _runMatrixNow = async () => {
    if (matrix.length === 0) return;
    if (matrixOversized){
      setErrMsg(`Matrix size (${matrixSize.toLocaleString()}) exceeds the ${MAX_MATRIX_SIZE.toLocaleString()} cap. Narrow your ranges before running.`);
      return;
    }
    if (cycleRequiresAccurate){
      setErrMsg("Cycle (and Combustor Mapping) require Accurate Mode. Turn it on in the header.");
      return;
    }
    setErrMsg(null);
    setRunning(true);
    setResults(null);
    setProgress({ done: 0, total: matrix.length, elapsed: 0, eta: 0, lastRow: null, phase: "warmup" });
    abortRef.current = { aborted: false };
    const endBusy = beginBusy("Running automation matrix");
    try {
      // ── Warm-up ping ────────────────────────────────────────────────
      // The Render service auto-sleeps after ~15 min idle. The first
      // request after sleep pays a 10-30 s wake penalty (FastAPI cold
      // start + Cantera GRI-Mech load). Fire one cheap call BEFORE the
      // matrix wall-time clock starts so that penalty doesn't show up
      // as the first row taking 30 s. The call uses the baseline state
      // so it's likely to be a cache hit on subsequent matrix calls
      // anyway. Errors here are swallowed — if the warmup fails the
      // matrix run will surface the real error on the first row.
      if (accurate){
        try {
          await bkCachedFetch("aft", {
            fuel: nonzero(baseline.fuel),
            oxidizer: nonzero(baseline.ox),
            phi: baseline.phi,
            T0: baseline.T_air,
            P: atmToBar(baseline.P),
            mode: "adiabatic",
            heat_loss_fraction: 0,
            T_fuel_K: baseline.T_fuel,
            T_air_K: baseline.T_air,
            WFR: baseline.WFR,
            water_mode: baseline.water_mode,
          });
        } catch (_) { /* warmup is best-effort */ }
      }
      setProgress({ done: 0, total: matrix.length, elapsed: 0, eta: 0, lastRow: null, phase: "running" });
      // Capture the wall-clock at the moment the matrix run actually
      // starts (NOT including the warmup ping above) so the persisted
      // per-row time reflects steady-state cost, not cold-start.
      const matrixStart = Date.now();
      const out = await runAutomationMatrix({
        rows: matrix,
        selectedPanels: effectivePanels,
        selectedOutputs: effectiveOutputs,
        baseline,
        varSpecs: activeVarSpecs,
        accurate,
        onProgress: (p) => setProgress(p),
        abortRef,
      });
      // Record measured per-row time → updates the EMA used by the
      // pre-run estimator on the user's NEXT matrix run with the same
      // (panels, mode, bisection) signature. If the user cancelled, we
      // still log a partial sample so the next estimate benefits.
      const elapsed = (Date.now() - matrixStart) / 1000;
      const completed = out ? out.length : 0;
      const wasAborted = !!abortRef.current?.aborted;
      if (completed > 0){
        recordRunPerf(
          effectivePanels,
          accurate ? "accurate" : "free",
          needsBisection,
          completed,
          elapsed,
          { partial: wasAborted },
        );
      }
      setResults(out);
    } catch (e){
      setErrMsg(e?.message || String(e));
    } finally {
      setRunning(false);
      endBusy();
    }
  };
  // Public entry: gate on the baseline-mismatch modal first. If any
  // varied input has a baseline that's not in its swept set, show the
  // modal; otherwise run immediately.
  const startRun = () => {
    if (matrix.length === 0) return;
    if (matrixOversized){
      setErrMsg(`Matrix size (${matrixSize.toLocaleString()}) exceeds the ${MAX_MATRIX_SIZE.toLocaleString()} cap. Narrow your ranges before running.`);
      return;
    }
    if (cycleRequiresAccurate){
      setErrMsg("Cycle (and Combustor Mapping) require Accurate Mode. Turn it on in the header.");
      return;
    }
    if (baselineMismatches.length > 0){
      setShowBaselineWarn(true);
      return;
    }
    _runMatrixNow();
  };
  const proceedAfterWarning = () => {
    setShowBaselineWarn(false);
    _runMatrixNow();
  };
  const cancelRun = () => { abortRef.current.aborted = true; };
  const downloadExcel = () => {
    if (!results) return;
    writeAutomationExcel(results, activeVarSpecs, effectiveOutputs, {
      accurate, selectedPanels: effectivePanels, units, baseline,
    });
  };
  const resetRun = () => { setResults(null); setProgress(null); setErrMsg(null); setShowPlots(false); };

  // ─────────────────────────────────────────────────────────────────────
  //  UI helpers
  // ─────────────────────────────────────────────────────────────────────
  const Step = ({n, title, children, done, locked}) => (
    <div style={{
      background: locked ? `${C.bg2}88` : C.bg2,
      border: `1.5px solid ${done ? C.good+"50" : locked ? C.border : C.accent+"50"}`,
      borderRadius: 8, padding: "14px 16px", marginBottom: 12,
      opacity: locked ? 0.55 : 1,
    }}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
        <span style={{
          width:26, height:26, borderRadius:"50%",
          background: done ? C.good : (locked ? C.bg3 : C.accent),
          color: locked ? C.txtMuted : C.bg,
          display:"inline-flex", alignItems:"center", justifyContent:"center",
          fontWeight:700, fontSize:13, fontFamily:"'Barlow Condensed',sans-serif",
        }}>{done ? "✓" : n}</span>
        <span style={{fontSize:13, fontWeight:700, color:C.txt,
          fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:".5px",
          textTransform:"uppercase"}}>{title}</span>
      </div>
      {!locked && children}
    </div>
  );

  return(<div style={{display:"flex",flexDirection:"column",gap:12,maxWidth:1100}}>
    <HelpBox title="ℹ️ Automation — How It Works">
      <p style={{margin:"0 0 6px"}}>Build a <span style={hs.em}>test matrix</span> — pick the panels you want to run, the inputs to vary, and the value ranges. The runner computes every combination and gives you one Excel sheet, one row per run.</p>
      <p style={{margin:"0 0 6px"}}><span style={hs.em}>You change:</span> any sidebar input or panel-local input, in any range and step. Pick the panels you want results from and the outputs you want captured.</p>
      <p style={{margin:"0 0 6px"}}><span style={hs.em}>You get:</span> an Excel workbook with all inputs and all outputs from the selected panels for every row, plus an interactive plot you can build right inside the app.</p>
      <p style={{margin:"0 0 6px"}}><span style={hs.em}>Notes.</span> Pick Combustor Mapping and Cycle is auto-included. Vary T_air, P, or φ and the matching Cycle linkage is auto-broken for the run, then restored after. Cycle and Combustor Mapping require Gas Turbine Simulator or Advanced mode; the other panels run in any mode.</p>
      <p style={{margin:0,fontSize:11,color:C.txtMuted}}>Per-panel methodology and output definitions are documented in the <strong>Assumptions</strong> tab.</p>
    </HelpBox>
    {/* Transient toast — surfaces mutex / validation notes for ~5 s. */}
    {toast && (
      <div style={{padding:"8px 14px", background:`${C.accent2}18`, border:`1.5px solid ${C.accent2}`,
        borderRadius:6, fontSize:11.5, color:C.txt, fontFamily:"'Barlow',sans-serif",
        lineHeight:1.5, display:"flex", alignItems:"center", gap:10}}>
        <span style={{color:C.accent2, fontSize:14}}>ⓘ</span>
        <span>{toast}</span>
      </div>
    )}

    {/* ────────── STEP 1 — PANELS ────────── */}
    <Step n={1} title="Pick the panels to automate" done={selectedPanels.length > 0}>
      <div style={{fontSize:11, color:C.txtMuted, marginBottom:10, fontFamily:"'Barlow',sans-serif", lineHeight:1.5}}>
        Select one or more. Combustor Mapping depends on Cycle internally — if you pick Mapping, Cycle is auto-included. Picking more panels means more outputs per row but also more compute time.
      </div>
      <div style={{display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(280px,1fr))", gap:8}}>
        {visibleAutomatablePanels.map(p => {
          const isSel  = selectedPanels.includes(p.id);
          const isAuto = autoIncluded.includes(p.id);
          return(
            <div key={p.id}
              onClick={() => togglePanel(p.id)}
              style={{
                padding:"10px 12px",
                background: isSel ? `${C.accent}18` : isAuto ? `${C.accent2}10` : C.bg3,
                border: `1.5px solid ${isSel ? C.accent : isAuto ? C.accent2 : C.border}`,
                borderRadius:6, cursor:"pointer",
                fontFamily:"'Barlow',sans-serif", color:C.txt,
              }}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                <input type="checkbox" checked={isSel} readOnly
                  style={{accentColor:C.accent, cursor:"pointer", margin:0}}/>
                <span style={{fontSize:13, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:".4px"}}>
                  {p.icon} {p.label}
                </span>
                {isAuto && <span style={{marginLeft:"auto", fontSize:9, fontWeight:700, color:C.accent2, fontFamily:"monospace"}}>AUTO</span>}
              </div>
              <div style={{fontSize:10.5, color:C.txtDim, lineHeight:1.45}}>{p.desc}</div>
              <div style={{fontSize:9.5, color:C.txtMuted, marginTop:4, fontFamily:"monospace"}}>
                ~{p.typicalCost}s / row in Accurate mode
              </div>
            </div>
          );
        })}
      </div>
    </Step>

    {/* ────────── STEP 2 — VARIABLES ────────── */}
    <Step n={2} title="Pick variables to vary" done={selectedVarIds.length > 0}
      locked={selectedPanels.length === 0}>
      <div style={{fontSize:11, color:C.txtMuted, marginBottom:10, fontFamily:"'Barlow',sans-serif", lineHeight:1.5}}>
        Only variables that affect a selected panel are shown. The
        <span style={{color:C.accent2, fontWeight:600}}> amber number </span>
        is the <strong>baseline value</strong> the runner will use on every
        row if you don't pick that variable to vary — the value currently
        on your sidebar at the moment you opened this panel.
      </div>
      <div style={{maxHeight:320, overflowY:"auto", border:`1px solid ${C.border}`, borderRadius:6, padding:6}}>
        {(() => {
          const grouped = {};
          for (const v of relevantVars){
            const key = v.panels[0];  // group by primary panel
            (grouped[key] = grouped[key] || []).push(v);
          }
          return Object.entries(grouped).map(([panel, vars]) => (
            <div key={panel} style={{marginBottom:8}}>
              <div style={{fontSize:10, fontWeight:700, color:C.accent, textTransform:"uppercase",
                letterSpacing:".7px", padding:"4px 8px", background:`${C.accent}10`, borderRadius:3}}>
                {panel}
              </div>
              <div style={{display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(265px,1fr))", gap:4, padding:4}}>
                {vars.map(v => {
                  const isSel = selectedVarIds.includes(v.id);
                  // Baseline value the runner will use if THIS variable is
                  // NOT selected — pulled from the App's sidebar snapshot
                  // captured when the user opened the Automate panel. Fuel
                  // / oxidizer species are nested under .fuel / .ox by
                  // species name; everything else is top-level on baseline.
                  let baseRaw;
                  if (v.kind === "fuel_species") baseRaw = baseline?.fuel?.[v.species];
                  else if (v.kind === "ox_species") baseRaw = baseline?.ox?.[v.species];
                  else baseRaw = baseline?.[v.id];
                  // Convert to display units (K → °F etc.) then route
                  // through the project-wide smart formatter so the same
                  // rounding rules apply (T → integer, φ → 3 dec, …).
                  let baseTxt;
                  if (baseRaw == null || baseRaw === "") {
                    baseTxt = "—";
                  } else if (typeof baseRaw === "boolean") {
                    baseTxt = baseRaw ? "true" : "false";
                  } else if (typeof baseRaw === "number") {
                    baseTxt = formatRowValue(toDisplay(v, baseRaw, units), unitFor(v, units), v.label);
                  } else {
                    baseTxt = String(baseRaw);
                  }
                  // Each row is laid out as a 4-column mini-table (checkbox
                  // + label | baseline value | unit) with vertical dividers
                  // between cells and a faint background tint on the value
                  // cell so the three pieces of information read as
                  // distinct columns instead of a continuous string.
                  const u = unitFor(v, units) || v.kind;
                  const cellBorder = `1px solid ${C.border}80`;
                  const valueBg = isSel ? "transparent" : `${C.accent2}10`;
                  return(
                    <label key={v.id} title={v.desc ? `${v.desc}\n\nBaseline: ${baseTxt}${u ? ` ${u}` : ""}` : `Baseline: ${baseTxt}`}
                      style={{display:"grid",
                        // minmax(0, 1fr) on the label column lets it shrink
                        // below its content size — without it the label
                        // refuses to truncate and instead wraps, kicking
                        // every neighboring card on that grid row to a
                        // taller height. Slightly tighter value/unit columns
                        // (74/50 vs 78/56) give labels more headroom so most
                        // fit without needing the ellipsis at all.
                        gridTemplateColumns:"auto minmax(0,1fr) 74px 50px",
                        alignItems:"stretch", cursor:"pointer", borderRadius:3,
                        border:`1px solid ${isSel ? C.accent + "60" : C.border + "40"}`,
                        background: isSel ? `${C.accent}10` : "transparent",
                        fontSize:11, fontFamily:"'Barlow',sans-serif",
                        overflow:"hidden"}}>
                      {/* Cell 1: checkbox */}
                      <span style={{display:"flex", alignItems:"center",
                        padding:"4px 6px 4px 6px"}}>
                        <input type="checkbox" checked={isSel}
                          onChange={() => toggleVar(v.id)}
                          style={{accentColor:C.accent, cursor:"pointer", margin:0}}/>
                      </span>
                      {/* Cell 2: variable label — truncate with ellipsis
                          so long labels (Water Injection Mode, Combustor
                          Heat Loss Fraction) don't wrap and break row
                          heights. Tooltip on the parent <label> already
                          shows the full text on hover. */}
                      <span style={{color:C.txt, padding:"4px 6px",
                        borderLeft: cellBorder,
                        display:"flex", alignItems:"center",
                        whiteSpace:"nowrap", overflow:"hidden",
                        textOverflow:"ellipsis", minWidth:0}}>
                        {v.label}
                      </span>
                      {/* Cell 3: baseline value (right-aligned, faint
                          background, monospace, amber when active baseline,
                          dim when the variable is being overridden by a sweep) */}
                      <span style={{fontSize:10.5, fontFamily:"monospace",
                        color: isSel ? C.txtMuted : C.accent2,
                        opacity: isSel ? 0.45 : 1,
                        background: valueBg,
                        borderLeft: cellBorder,
                        padding:"4px 8px",
                        textAlign:"right",
                        display:"flex", alignItems:"center", justifyContent:"flex-end",
                        whiteSpace:"nowrap"}}
                        title={`Baseline: ${baseTxt}${u ? ` ${u}` : ""}`}>
                        {baseTxt}
                      </span>
                      {/* Cell 4: unit */}
                      <span style={{fontSize:9.5, color:C.txtMuted, fontFamily:"monospace",
                        borderLeft: cellBorder,
                        padding:"4px 6px",
                        display:"flex", alignItems:"center", justifyContent:"flex-start",
                        whiteSpace:"nowrap"}}>
                        {u}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ));
        })()}
      </div>
    </Step>

    {/* ────────── STEP 3 — DOE ────────── */}
    <Step n={3} title="Define the DoE (range or list)" done={matrix.length > 0}
      locked={selectedVarIds.length === 0}>
      <div style={{fontSize:11, color:C.txtMuted, marginBottom:10, fontFamily:"'Barlow',sans-serif", lineHeight:1.5}}>
        For each variable, set min / max / step (range mode) OR enter a comma-separated list of specific values. Fuel-species variables also need a balance species (the species that absorbs the difference to keep total = 100 %).
      </div>
      <div style={{display:"flex", flexDirection:"column", gap:6}}>
        {selectedVarIds.map(vid => {
          const def = AUTO_VARS.find(v => v.id === vid);
          if (!def) return null;
          const cfg = varSpecs[vid] || {};
          const isEnum = def.kind === "enum" || def.kind === "bool";
          const isFuel = def.kind === "fuel_species";
          const mode = cfg.mode || (isEnum ? "list" : "range");
          const dispUnit = unitFor(def, units);
          // Convert SI defaults to display units. cfg.{min,max,step,list} are
          // stored in SI; we convert here for the input fields and convert
          // back on commit.
          const siMin  = cfg.min  ?? def.range?.[0];
          const siMax  = cfg.max  ?? def.range?.[1];
          const siStep = cfg.step ?? def.step;
          const dispMin  = toDisplay(def, siMin, units);
          const dispMax  = toDisplay(def, siMax, units);
          const dispStep = toDisplayDelta(def, siStep, units);
          // Points-count: compute from display units (math is identical, just
          // shown for the user's UX).
          const pointCount = Math.max(1, Math.floor(((dispMax - dispMin) / Math.max(dispStep, 1e-12)) + 1.0001));
          // 7-column grid: name | mode | min | max | step | pts | balance.
          // Every row paints the same columns at the same x-positions so
          // values line up across rows even when only some have a Balance.
          // List mode collapses Min/Max/Step/pts into one spanning cell;
          // Balance stays in its own column (or an empty placeholder for
          // non-fuel rows) so the column geometry never shifts.
          return(
            <div key={vid} style={{padding:"8px 10px", background:C.bg3, borderRadius:5,
              border:`1px solid ${C.border}`, display:"grid",
              gridTemplateColumns:"180px 100px 110px 110px 100px 75px 130px",
              gap:10, alignItems:"end"}}>
              {/* Col 1 — Variable name */}
              <div style={{alignSelf:"center"}}>
                <div style={{fontSize:11.5, color:C.txt, fontWeight:600}}>{def.label}</div>
                <div style={{fontSize:9.5, color:C.txtMuted, fontFamily:"monospace"}}>{dispUnit || def.kind}</div>
              </div>
              {/* Col 2 — Range / List mode */}
              <select value={mode} onChange={e => updateVarSpec(vid, {mode:e.target.value})}
                disabled={isEnum}
                style={{...S.sel, fontSize:10, padding:"4px 6px", alignSelf:"center"}}>
                <option value="range">Range</option>
                <option value="list">List</option>
              </select>
              {/* Cols 3–6 — Min / Max / Step / pts (range mode) OR list input spanning all four */}
              {mode === "range" && !isEnum && (
                <>
                  {/* Numeric columns: right-align both label and value so
                      they pair vertically (label sits above the digits,
                      not dangling at the empty left edge of the column). */}
                  <NumLabel l={`Min (${dispUnit})`} align="right">
                    <NumField value={dispMin} decimals={4}
                      onCommit={v => updateVarSpec(vid, {min: toSi(def, +v, units)})}
                      style={{...S.inp, width:"100%", textAlign:"right",
                        fontVariantNumeric:"tabular-nums"}}/>
                  </NumLabel>
                  <NumLabel l={`Max (${dispUnit})`} align="right">
                    <NumField value={dispMax} decimals={4}
                      onCommit={v => updateVarSpec(vid, {max: toSi(def, +v, units)})}
                      style={{...S.inp, width:"100%", textAlign:"right",
                        fontVariantNumeric:"tabular-nums"}}/>
                  </NumLabel>
                  <NumLabel l={`Step (${dispUnit})`} align="right">
                    <NumField value={dispStep} decimals={4}
                      onCommit={v => updateVarSpec(vid, {step: toSiDelta(def, +v, units)})}
                      style={{...S.inp, width:"100%", textAlign:"right",
                        fontVariantNumeric:"tabular-nums"}}/>
                  </NumLabel>
                  <span style={{fontSize:10, color:C.txtMuted, fontFamily:"monospace",
                    textAlign:"right", paddingBottom:6}}>
                    → {pointCount} pts
                  </span>
                </>
              )}
              {mode === "list" && (
                <div style={{gridColumn:"3 / 7", display:"flex", gap:8, alignItems:"center"}}>
                  <ListInput
                    isEnum={isEnum}
                    def={def}
                    units={units}
                    list={cfg.list}
                    placeholder={isEnum ? def.choices?.map(c=>c.value).join(", ") : "e.g. 1.0, 2.0, 3.0"}
                    onCommit={(parsedSiList) => updateVarSpec(vid, {list: parsedSiList})}
                    style={{...S.inp, flex:1, minWidth:0}}
                  />
                  {!isEnum && <span style={{fontSize:9.5, color:C.txtMuted, fontFamily:"monospace"}}>{dispUnit}</span>}
                </div>
              )}
              {/* Col 7 — Balance species (fuel rows only; placeholder for others to keep grid aligned) */}
              {isFuel ? (
                <NumLabel l="Balance">
                  <select value={cfg.balanceSpecies || (def.species === "CH4" ? "N2" : "CH4")}
                    onChange={e => updateVarSpec(vid, {balanceSpecies:e.target.value})}
                    style={{...S.sel, fontSize:10, padding:"3px 5px", width:"100%"}}>
                    {FUEL_SP.filter(sp => sp !== def.species).map(sp =>
                      <option key={sp} value={sp}>{sp}</option>)}
                  </select>
                </NumLabel>
              ) : <div/>}
            </div>
          );
        })}
      </div>
    </Step>

    {/* ────────── STEP 4 — PREVIEW ────────── */}
    <Step n={4}
      title={`Review matrix (${matrixSize.toLocaleString()} runs · est. ${formatRuntime(estimatedSec)})`}
      done={results !== null}
      locked={matrixSize === 0}>
      {/* Hard-stop banner when the cross product would explode. Shown
          BEFORE matrix enumeration so the tab doesn't freeze. */}
      {matrixOversized && (
        <div style={{padding:"10px 14px", background:`${C.strong}18`,
          border:`2px solid ${C.strong}`, borderRadius:6, fontSize:12,
          color:C.txt, marginBottom:10, fontFamily:"'Barlow',sans-serif", lineHeight:1.55}}>
          <div style={{fontSize:13, fontWeight:700, color:C.strong,
            fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:".5px",
            marginBottom:4, textTransform:"uppercase"}}>
            ⚠ MATRIX TOO LARGE — {matrixSize.toLocaleString()} ROWS
          </div>
          The full factorial of your variables would produce <strong>{matrixSize.toLocaleString()}</strong> runs.
          The cap is <strong>{MAX_MATRIX_SIZE.toLocaleString()}</strong>. Even at a few seconds per row this would take days
          and consume gigabytes of memory. Narrow the ranges (increase the
          step size) or remove a variable, then come back to this step.
          <div style={{marginTop:6, fontSize:11, color:C.txtMuted, fontFamily:"monospace"}}>
            Tip: each variable contributes a multiplier. T_air at 250–900 K step 10
            = 66 points; H₂ at 0–100 % step 5 = 21; tau_PSR at 0.5–20 ms step 0.5
            = 40. The cross product is the product of these.
          </div>
        </div>
      )}
      {brokenLinkages.length > 0 && (
        <div style={{padding:"6px 10px", background:`${C.accent2}12`, border:`1px solid ${C.accent2}50`,
          borderRadius:4, fontSize:11, color:C.txtDim, marginBottom:8, fontFamily:"'Barlow',sans-serif"}}>
          <strong style={{color:C.accent2}}>⚙ Linkage(s) auto-broken for this run:</strong>{" "}
          {brokenLinkages.map(b => <code key={b.var} style={{color:C.accent2, marginRight:6}}>{b.linkage}</code>)}
          — your swept values for those variables will take effect instead of being overridden by Cycle.
        </div>
      )}
      {autoIncluded.length > 0 && (
        <div style={{padding:"6px 10px", background:`${C.accent}12`, border:`1px solid ${C.accent}50`,
          borderRadius:4, fontSize:11, color:C.txtDim, marginBottom:8, fontFamily:"'Barlow',sans-serif"}}>
          <strong style={{color:C.accent}}>+ Cycle auto-included</strong> — Combustor Mapping needs Cycle T3/P3/mdot_air. Cycle outputs will appear in the Excel sheet too.
        </div>
      )}
      {cycleRequiresAccurate && (
        <div style={{padding:"6px 10px", background:`${C.warm}14`, border:`1px solid ${C.warm}60`,
          borderRadius:4, fontSize:11, color:C.warm, marginBottom:8, fontFamily:"'Barlow',sans-serif", fontWeight:700}}>
          ⚠ Cycle requires Gas Turbine Simulator or Advanced Mode (Cantera backend). Switch via the MODE picker in the header before running.
        </div>
      )}
      <div style={{display:"flex", gap:14, marginBottom:8, flexWrap:"wrap", fontSize:11, fontFamily:"'Barlow',sans-serif"}}>
        <Stat label="Runs"            value={matrixSize.toLocaleString()}
          color={matrixOversized ? C.strong : C.txt}/>
        <Stat label="Inputs / row"    value={selectedVarIds.length}/>
        <Stat label="Outputs / row"   value={effectiveOutputs.length}/>
        <Stat label="Mode"            value={accurate ? "Accurate" : "Simple"}
          color={accurate ? C.accent : C.txtDim}/>
        <Stat label={estimate.source === "calibrated"
                 ? `Est. runtime (calibrated · n=${estimate.sampleCount})`
                 : "Est. runtime (default — first run)"}
          value={formatRuntime(estimatedSec)}
          color={matrixOversized ? C.strong : C.txt}/>
      </div>
      {/* Preview table — first 8 rows. Values shown in current units.
          Columns auto-size to their content (no forced 100% width) so the
          table hugs the data instead of stretching to fill the viewport.
          Wrapper is inline-block to shrink to the table's natural width;
          horizontal scroll appears only if user picks more columns than
          fit on screen. Suppressed entirely when the matrix is oversized
          (no rows enumerated → nothing to preview). */}
      {!matrixOversized && (
      <div style={{maxHeight:180, overflow:"auto", border:`1px solid ${C.border}`, borderRadius:4,
        fontFamily:"monospace", fontSize:10, background:C.bg, display:"inline-block",
        maxWidth:"100%"}}>
        <table style={{borderCollapse:"collapse", width:"auto"}}>
          <thead>
            <tr>
              <th style={previewHeaderStyle()}>#</th>
              {activeVarSpecs.map(s => <th key={s.id} style={previewHeaderStyle()}>
                {s.label}{unitFor(s, units) ? ` (${unitFor(s, units)})` : ""}
              </th>)}
            </tr>
          </thead>
          <tbody>
            {matrix.slice(0, 8).map((r, i) => (
              <tr key={i} style={{borderTop:`1px solid ${C.border}40`}}>
                <td style={previewCellStyle()}>{i+1}</td>
                {activeVarSpecs.map(s => <td key={s.id} style={previewCellStyle()}>
                  {formatRowValue(toDisplay(s, r[s.id], units), unitFor(s, units), s.label)}
                </td>)}
              </tr>
            ))}
            {matrix.length > 8 && (
              // Footer line is prose, not a number — left-align it so
              // it doesn't get visually-glued to the rightmost column.
              <tr><td colSpan={activeVarSpecs.length + 1}
                style={{...previewCellStyle(), textAlign:"left",
                  color:C.txtMuted, fontStyle:"italic", paddingLeft:14}}>
                … and {matrix.length - 8} more rows
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      )}
    </Step>

    {/* ────────── STEP 5 — RUN ────────── */}
    <Step n={5} title="Run the matrix" done={results !== null}
      locked={matrix.length === 0 || cycleRequiresAccurate || matrixOversized}>
      {!running && !results && (
        <button onClick={startRun}
          disabled={matrix.length === 0 || cycleRequiresAccurate || matrixOversized}
          style={{padding:"10px 24px", fontSize:13, fontWeight:700,
            color:C.bg, background:C.good, border:"none", borderRadius:6,
            cursor:"pointer", fontFamily:"'Barlow Condensed',sans-serif",
            letterSpacing:".7px"}}>
          ▶ START AUTOMATED RUN ({matrix.length} runs)
        </button>
      )}
      {running && progress && (
        <div>
          <div style={{display:"flex", alignItems:"center", gap:10, marginBottom:8}}>
            <span style={{display:"inline-block",width:14,height:14,
              border:`2.5px solid ${C.accent}`, borderTopColor:"transparent",
              borderRadius:"50%", animation:"ctkspin 0.85s linear infinite"}}/>
            <span style={{fontSize:13, fontWeight:700, color:C.accent,
              fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:".5px"}}>
              RUNNING — {progress.done} / {progress.total}
            </span>
            <span style={{marginLeft:"auto", fontSize:11, color:C.txtMuted, fontFamily:"monospace"}}>
              {formatRuntime(progress.elapsed)} elapsed · {formatRuntime(progress.eta)} ETA
            </span>
          </div>
          <div style={{height:8, background:C.bg3, borderRadius:4, overflow:"hidden", marginBottom:8}}>
            <div style={{
              height:"100%", width:`${(progress.done/progress.total)*100}%`,
              background:C.accent, transition:"width .3s",
            }}/>
          </div>
          <button onClick={cancelRun}
            style={{padding:"6px 14px", fontSize:11, fontWeight:700,
              color:C.warm, background:"transparent", border:`1px solid ${C.warm}`,
              borderRadius:4, cursor:"pointer", fontFamily:"'Barlow Condensed',sans-serif"}}>
            ✕ CANCEL
          </button>
        </div>
      )}
      {!running && results && (
        <div style={{display:"flex", gap:10, alignItems:"center", flexWrap:"wrap"}}>
          <span style={{fontSize:13, fontWeight:700, color:C.good, fontFamily:"'Barlow Condensed',sans-serif"}}>
            ✓ COMPLETE — {results.length} rows
            {results.filter(r => r.__error__).length > 0 && (
              <span style={{color:C.warm, marginLeft:8}}>
                ({results.filter(r => r.__error__).length} errored)
              </span>
            )}
          </span>
          <button onClick={downloadExcel}
            style={{padding:"8px 18px", fontSize:12, fontWeight:700,
              color:C.bg, background:C.accent2, border:"none", borderRadius:5,
              cursor:"pointer", fontFamily:"'Barlow Condensed',sans-serif",
              letterSpacing:".5px"}}>
            📥 DOWNLOAD EXCEL
          </button>
          <button onClick={()=>setShowPlots(s=>!s)}
            style={{padding:"8px 18px", fontSize:12, fontWeight:700,
              color: showPlots ? C.bg : C.accent,
              background: showPlots ? C.accent : "transparent",
              border:`1.5px solid ${C.accent}`, borderRadius:5,
              cursor:"pointer", fontFamily:"'Barlow Condensed',sans-serif",
              letterSpacing:".5px"}}>
            📊 {showPlots ? "HIDE PLOTS" : "PLOT DATA"}
          </button>
          <button onClick={resetRun}
            style={{padding:"8px 14px", fontSize:11, fontWeight:600,
              color:C.txtDim, background:"transparent", border:`1px solid ${C.border}`,
              borderRadius:5, cursor:"pointer", fontFamily:"'Barlow Condensed',sans-serif"}}>
            ↺ RESET
          </button>
        </div>
      )}
      {errMsg && (
        <div style={{marginTop:8, padding:"6px 10px", background:`${C.warm}14`,
          border:`1px solid ${C.warm}60`, borderRadius:4, fontSize:11, color:C.warm,
          fontFamily:"monospace"}}>{errMsg}</div>
      )}
      {!running && results && showPlots && (
        <PlotPanel
          results={results}
          varSpecs={activeVarSpecs}
          selectedOutputs={effectiveOutputs}
          units={units}
          baseline={baseline}
          onClose={() => setShowPlots(false)}
        />
      )}
      {/* Pre-run baseline-mismatch modal */}
      {showBaselineWarn && (
        <BaselineMismatchModal
          mismatches={baselineMismatches}
          units={units}
          onCancel={() => setShowBaselineWarn(false)}
          onProceed={proceedAfterWarning}
        />
      )}
    </Step>
  </div>);
}

// ── BaselineMismatchModal ──
//   One-time pre-run dialog. Lists each varied input whose sidebar
//   baseline value isn't one of the values the matrix sweep includes —
//   meaning that variable can't be slice-pinned on baseline in a future
//   plot (the plot panel would fall back to mode). Two actions:
//     • Cancel → close, no run. User can fix sidebar values OR DOE
//       ranges in Step 3 to make baseline match.
//     • Run anyway → acknowledge the mismatch, fire the matrix.
function BaselineMismatchModal({ mismatches, units, onCancel, onProceed }){
  const fmtVal = (v, raw) => {
    if (raw == null) return "—";
    if (typeof raw === "number") return formatRowValue(toDisplay(v, raw, units), unitFor(v, units), v.label);
    return String(raw);
  };
  return (
    <div onClick={onCancel}
      style={{position:"fixed", inset:0, zIndex:1000,
        background:"rgba(0,0,0,0.6)", display:"flex",
        alignItems:"center", justifyContent:"center", padding:20}}>
      <div onClick={e => e.stopPropagation()}
        style={{maxWidth:640, width:"100%", maxHeight:"85vh", overflowY:"auto",
          background:C.bg2, border:`1px solid ${C.accent2}`, borderRadius:8,
          boxShadow:"0 16px 48px rgba(0,0,0,0.7)",
          fontFamily:"'Barlow',sans-serif"}}>
        <div style={{padding:"14px 18px", borderBottom:`1px solid ${C.border}`}}>
          <div style={{fontSize:14, fontWeight:700, color:C.accent2,
            fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:".7px"}}>
            ⚠ HEADS UP — BASELINE NOT IN SWEPT RANGE
          </div>
          <div style={{fontSize:11, color:C.txtDim, marginTop:4, lineHeight:1.5}}>
            Some of your sidebar values won't be among the values the
            matrix actually runs. That means later, when you plot results
            and want to "hold this variable at baseline," the chart will
            substitute the most-common value from your matrix instead.
            Usually fine, but worth knowing before spending compute time.
          </div>
        </div>
        <div style={{padding:"12px 18px"}}>
          <div style={{display:"grid",
            gridTemplateColumns:"1fr auto 1fr", gap:"6px 14px",
            fontSize:11, alignItems:"baseline"}}>
            <div style={{fontSize:9.5, fontWeight:700, color:C.txtMuted,
              textTransform:"uppercase", letterSpacing:".6px"}}>Variable</div>
            <div style={{fontSize:9.5, fontWeight:700, color:C.txtMuted,
              textTransform:"uppercase", letterSpacing:".6px", textAlign:"center"}}>Sidebar baseline</div>
            <div style={{fontSize:9.5, fontWeight:700, color:C.txtMuted,
              textTransform:"uppercase", letterSpacing:".6px"}}>Matrix sweeps</div>
            {mismatches.map((m, i) => {
              const v = m.varSpec;
              const u = unitFor(v, units);
              return (
                <Fragment key={i}>
                  <div style={{color:C.txt, fontWeight:600}}>
                    {v.label}{u ? <span style={{color:C.txtMuted, fontWeight:400, marginLeft:4}}>({u})</span> : null}
                  </div>
                  <div style={{color:C.warm, fontFamily:"monospace", textAlign:"center",
                    fontSize:11, fontWeight:600}}>
                    {fmtVal(v, m.baselineVal)}
                  </div>
                  <div style={{color:C.txtDim, fontFamily:"monospace", fontSize:10.5,
                    wordBreak:"break-word"}}>
                    {m.sweptVals.map(sv => fmtVal(v, sv)).join(", ")}
                  </div>
                </Fragment>
              );
            })}
          </div>
        </div>
        <div style={{padding:"12px 18px", borderTop:`1px solid ${C.border}`,
          background:`${C.bg3}`, display:"flex", gap:10, alignItems:"center"}}>
          <span style={{flex:1, fontSize:10.5, color:C.txtMuted, fontStyle:"italic"}}>
            Tip: include your sidebar value in each variable's sweep range
            (Step 3) if you want chart slices to actually use baseline.
          </span>
          <button onClick={onCancel}
            style={{padding:"7px 16px", fontSize:11, fontWeight:600,
              color:C.txtDim, background:"transparent", border:`1px solid ${C.border}`,
              borderRadius:5, cursor:"pointer", fontFamily:"'Barlow Condensed',sans-serif",
              letterSpacing:".5px"}}>
            ← BACK TO EDIT
          </button>
          <button onClick={onProceed}
            style={{padding:"7px 16px", fontSize:11, fontWeight:700,
              color:C.bg, background:C.accent2, border:"none",
              borderRadius:5, cursor:"pointer", fontFamily:"'Barlow Condensed',sans-serif",
              letterSpacing:".5px"}}>
            ✓ ACKNOWLEDGE & RUN ANYWAY
          </button>
        </div>
      </div>
    </div>
  );
}

// Tiny visual helpers used by AutomatePanel.
// Functions instead of consts so each render reads the LIVE palette
// (the const-capture-at-module-load trap is the same one S and hs hit).
// Headers and cells both center inside their column so the small,
// uniform values ("2,800", "300", "0") sit visually balanced under
// their captions. tabular-nums keeps thousand-separated numbers like
// "2,800" column-aligning with bare zeros despite center-alignment.
function previewHeaderStyle(){return{
  textAlign:"center", padding:"6px 14px", fontSize:10, color:C.txtDim,
  background:C.bg3, position:"sticky", top:0, fontWeight:700,
  borderBottom:`1px solid ${C.border}`,
  fontVariantNumeric:"tabular-nums",
  whiteSpace:"nowrap",
};}
function previewCellStyle(){return{
  padding:"4px 14px", color:C.txt, whiteSpace:"nowrap",
  textAlign:"center",
  fontVariantNumeric:"tabular-nums",
};}
// align="right" flips the small caption to right-align — used on the
// DOE Min/Max/Step rows so the label sits directly above the numeric
// value rather than dangling at the column's left edge.
function NumLabel({l, children, align="left"}){
  return(<div style={{display:"flex",flexDirection:"column",gap:1}}>
    <div style={{fontSize:8.5, color:C.txtMuted, textTransform:"uppercase", letterSpacing:".5px", textAlign:align}}>{l}</div>
    {children}
  </div>);
}
function Stat({label, value, color}){
  return(<div style={{display:"flex", flexDirection:"column", gap:1, paddingRight:14, borderRight:`1px solid ${C.border}40`}}>
    <div style={{fontSize:9, color:C.txtMuted, textTransform:"uppercase", letterSpacing:".5px"}}>{label}</div>
    <div style={{fontSize:13, fontWeight:700, color: color || C.txt, fontFamily:"'Barlow Condensed',sans-serif"}}>{value}</div>
  </div>);
}
function formatRuntime(seconds){
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  const h = Math.floor(m / 60), rm = m % 60;
  return `${h}h ${rm}m`;
}

// Sidebar Engine & Ambient block.
// `section` selects which subset to render so the parent can place groups
// non-contiguously in the sidebar:
//   "top"   (default) — Engine selector, Emissions Mode toggle, Load card,
//                       Ambient Conditions + Comb. Air Frac
//   "bleed" — just the Compressor Bleed card (its own outer wrapper)
function EngineAmbientSidebar({
  engine,setEngine,Pamb,setPamb,Tamb,setTamb,RH,setRH,loadPct,setLoadPct,
  Tcool,setTcool,airFrac,setAirFrac,
  bleedMode,setBleedMode,bleedOpenPct,bleedOpenManualPct,setBleedOpenManualPct,
  bleedValveSizePct,setBleedValveSizePct,bleedAirFrac,
  bleedStepPct,setBleedStepPct,
  loadStepPct,setLoadStepPct,
  emissionsMode,setEmissionsMode,
  accurate,
  section="top",
}){
  // Clamp the editable step to a sane range. The buttons read this value;
  // the inline NumField below the load row writes it.
  const _loadStep=Math.max(1,Math.min(50,Math.round(+loadStepPct||5)));
  const units=useContext(UnitCtx);
  const isLMS=engine==="LMS100PB+";
  const dim=!accurate;
  // Wrap the whole card in a fieldset-style dim. Inputs still render so the
  // user can SEE the engine inputs even on the free tier (per spec) but
  // pointer-events disabled to avoid mutating values that don't drive
  // anything in free mode.
  const wrap={
    background:C.bg2,border:`1px solid ${C.accent}25`,borderRadius:8,
    padding:12,marginBottom:10,position:"relative",
    opacity:dim?0.55:1,
    pointerEvents:dim?"none":"auto",
    transition:"opacity .15s",
  };
  const lbl={fontSize:10.5,color:C.txtMuted,fontFamily:"monospace",display:"block",marginBottom:3};
  const sec={fontSize:10,fontWeight:700,color:C.accent,textTransform:"uppercase",letterSpacing:"1.5px",marginBottom:6};
  const subSec={fontSize:9.5,fontWeight:700,color:C.txtDim,textTransform:"uppercase",letterSpacing:"1.2px",marginTop:10,marginBottom:6,paddingTop:8,borderTop:`1px solid ${C.border}50`};
  // ── Compressor Bleed JSX block — defined here so it can be rendered both
  //   inline in the section="top" card (between Load and Ambient — its
  //   permanent home as of 2026-05-02) and as a no-op for section="bleed"
  //   (legacy — kept null so existing call sites don't double-render). ──
  const bleedBlock = (
    <div data-card="compressor-bleed">
      <div style={subSec}>Compressor Bleed</div>
      <div>
        <label style={lbl} title="Maximum bleed split %: the hard upper bound on how much compressor air the bleed valve can dump at 100% open. A function of valve/line size (bigger valve → more bleed possible). Free-type any value.">Max Bleed split % (valve/line size)</label>
        <NumField value={bleedValveSizePct} decimals={2} onCommit={v=>setBleedValveSizePct(Math.max(0,Math.min(100,+v)))} style={S.inp}/>
      </div>
      <div style={{marginTop:8}}>
        <div style={{display:"flex",gap:6,marginBottom:6}}>
          {[
            {k:"auto",lbl:"AUTO (vs Load)",tip:"Bleed open % is a continuous function of load. 100% open ≤75% load, 0% ≥95%, linear between."},
            {k:"manual",lbl:"MANUAL",tip:"You set the bleed open % directly — type a value, click ± with the selected step, or drag the slider."},
          ].map(o=>(
            <button key={o.k} onClick={()=>{
              if(o.k==="manual"&&bleedMode!=="manual"){
                setBleedOpenManualPct(bleedOpenPct);
              }
              setBleedMode(o.k);
            }} title={o.tip} style={{
              flex:1,padding:"4px 8px",fontSize:10,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",
              letterSpacing:".5px",
              color:bleedMode===o.k?C.bg:C.accent,
              background:bleedMode===o.k?C.accent:"transparent",
              border:`1px solid ${C.accent}`,borderRadius:4,cursor:"pointer"
            }}>{o.lbl}</button>
          ))}
        </div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3,gap:4}}>
          <label style={{fontSize:10.5,color:C.txtMuted,fontFamily:"monospace"}}>Bleed Open (%)</label>
          <div style={{display:"flex",alignItems:"center",gap:3}}>
            <button
              onClick={()=>{if(bleedMode==="manual"){const s=Math.max(1,bleedStepPct);setBleedOpenManualPct(Math.max(0,Math.min(100,Math.round(bleedOpenPct-s))));}}}
              disabled={bleedMode==="auto"}
              title={bleedMode==="auto"?"AUTO mode — switch to MANUAL":`Decrease by ${Math.max(1,bleedStepPct)}%`}
              style={{padding:"2px 6px",fontSize:12,fontWeight:700,fontFamily:"monospace",
                color:bleedMode==="auto"?C.txtMuted:C.accent2,
                background:"transparent",border:`1px solid ${bleedMode==="auto"?C.border:C.accent2}80`,
                borderRadius:3,cursor:bleedMode==="auto"?"not-allowed":"pointer",lineHeight:1}}>−</button>
            <NumField
              value={bleedOpenPct}
              decimals={0}
              onCommit={v=>{
                if(bleedMode==="manual")setBleedOpenManualPct(Math.max(0,Math.min(100,Math.round(+v))));
              }}
              disabled={bleedMode==="auto"}
              title={bleedMode==="auto"?"AUTO mode — switch to MANUAL to type a value":"Type any value 0–100, or use ± to bump by the selected step"}
              style={{width:56,padding:"3px 6px",fontFamily:"monospace",
                color:bleedMode==="auto"?C.txtMuted:C.accent2,
                fontSize:12,fontWeight:700,background:C.bg,
                border:`1px solid ${bleedMode==="auto"?C.border:C.accent2}50`,
                borderRadius:4,textAlign:"center",outline:"none"}}/>
            <button
              onClick={()=>{if(bleedMode==="manual"){const s=Math.max(1,bleedStepPct);setBleedOpenManualPct(Math.max(0,Math.min(100,Math.round(bleedOpenPct+s))));}}}
              disabled={bleedMode==="auto"}
              title={bleedMode==="auto"?"AUTO mode — switch to MANUAL":`Increase by ${Math.max(1,bleedStepPct)}%`}
              style={{padding:"2px 6px",fontSize:12,fontWeight:700,fontFamily:"monospace",
                color:bleedMode==="auto"?C.txtMuted:C.accent2,
                background:"transparent",border:`1px solid ${bleedMode==="auto"?C.border:C.accent2}80`,
                borderRadius:3,cursor:bleedMode==="auto"?"not-allowed":"pointer",lineHeight:1}}>+</button>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:4,marginTop:2,marginBottom:4}}>
          <span style={{fontSize:9.5,color:C.txtMuted,fontFamily:"monospace"}} title="Step size for ± buttons and the slider. Type any value directly regardless of step.">Step:</span>
          <div style={{display:"flex",gap:3,flexWrap:"wrap"}}>
            {[0,15,30,45,60,75,90].map(v=>{
              const active=bleedStepPct===v||(v===0&&bleedStepPct<=1);
              return(
                <button key={v} onClick={()=>{if(bleedMode==="manual")setBleedStepPct(v===0?1:v);}}
                  disabled={bleedMode==="auto"}
                  title={v===0?"Fine step — arrows bump by 1%":`Arrows bump by ${v}%`}
                  style={{padding:"1px 5px",fontSize:9,fontWeight:600,fontFamily:"monospace",
                    color:active?C.bg:(bleedMode==="auto"?C.txtMuted:C.txtDim),
                    background:active?C.accent2:"transparent",
                    border:`1px solid ${bleedMode==="auto"?C.border:C.accent2}50`,
                    borderRadius:3,cursor:bleedMode==="auto"?"not-allowed":"pointer",
                    opacity:bleedMode==="auto"?0.5:1}}>{v===0?"1":v}</button>
              );
            })}
          </div>
        </div>
        <input type="range" min="0" max="100" step={Math.max(1,bleedStepPct)}
          value={bleedOpenPct}
          disabled={bleedMode==="auto"}
          onChange={e=>{if(bleedMode==="manual")setBleedOpenManualPct(+e.target.value);}}
          style={{width:"100%",accentColor:C.accent2,opacity:bleedMode==="auto"?0.45:1}}/>
        <div style={{textAlign:"center",fontSize:9.5,color:C.txtMuted,marginTop:1,fontStyle:"italic",lineHeight:1.3}}>
          {bleedMode==="auto"?"programmed schedule (Load → Open %)":"manual override"}
          {" · "}lost air = <strong style={{color:C.accent2}}>{(bleedAirFrac*100).toFixed(2)}%</strong>
        </div>
      </div>
    </div>
  );

  // The bleed UI now lives INSIDE the section="top" card (between Load and
  // Ambient). Returning null here so any caller still passing
  // section="bleed" produces nothing instead of a duplicate card.
  if (section === "bleed") return null;

  // ── TOP-GROUP render: Engine / Emissions / Load / Bleed / Ambient ─────
  return(<div style={wrap}>
    <div style={sec}>Engine & Ambient {dim&&<span style={{fontSize:9,color:C.warm,fontWeight:600,letterSpacing:".4px",textTransform:"none",marginLeft:6}}>(Accurate Mode required)</span>}</div>
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      <div>
        <label style={lbl} title="Engine deck. Currently calibrated for the LMS100PB+ DLE IC (intercooled, 107.5 MW @ 44 °F / 80% RH). Drives engine-specific calibration constants (η_isen, MW cap, T4 firing temp, combustor bypass).">Engine</label>
        <select style={S.sel} value={engine} onChange={e=>setEngine(e.target.value)}
          title="Engine deck selector. LMS100PB+ DLE IC is the only deck currently shipping; additional engines are in development.">
          <option value="LMS100PB+">LMS100PB+ DLE IC</option>
        </select>
      </div>
      {/* ── EMISSIONS MODE — toggle button (affects BRNDMD ladder) ───── */}
      <div>
        <label style={lbl} title="When enabled, the full BRNDMD ladder is active (1 → 2 → 4 → 6 → 7). When disabled, BRNDMD holds at 4 for MW > 45 — combustor stays in a simpler low-load mode rather than progressing to high-load modes.">Emissions Mode</label>
        <button onClick={()=>setEmissionsMode(!emissionsMode)}
          title={emissionsMode
            ?"Click to DISABLE emissions mode — engine holds at BD4 (low-load mode) regardless of MW. In Live Mapping, this cancels any in-progress staging ramp."
            :"Click to ENABLE emissions mode — full DLE BD4→BD6→BD7 ladder is active. In Live Mapping, this triggers a staging ramp through the burner modes."}
          style={{width:"100%",padding:"7px 12px",fontSize:11.5,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".6px",
            color:emissionsMode?C.good:C.strong,
            background:emissionsMode?`${C.good}18`:`${C.strong}18`,
            border:`1.5px solid ${emissionsMode?C.good:C.strong}`,
            borderRadius:5,cursor:"pointer",
            display:"flex",alignItems:"center",justifyContent:"center",gap:8,
            transition:"all .12s"}}>
          <span style={{width:8,height:8,borderRadius:"50%",background:emissionsMode?C.good:C.strong,boxShadow:`0 0 6px ${emissionsMode?C.good:C.strong}`}}/>
          {emissionsMode?"ENABLED":"DISABLED"}
        </button>
      </div>

      {/* ── LOAD — hero control (most frequently varied parameter) ───── */}
      <div style={{background:`${C.accent}0F`,border:`1px solid ${C.accent}60`,borderRadius:6,padding:"8px 10px",marginTop:2}}>
        <div style={{fontSize:9.5,fontWeight:700,color:C.accent,textTransform:"uppercase",letterSpacing:".6px",marginBottom:4,lineHeight:1.25}}>Input or vary the gas turbine load</div>
        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
          <button onClick={()=>setLoadPct(Math.max(20,Math.min(100,Math.round(loadPct-_loadStep))))}
            title={`Decrease load by ${_loadStep}%`}
            style={{padding:"4px 10px",fontSize:13,fontWeight:700,fontFamily:"monospace",color:C.accent,background:"transparent",border:`1px solid ${C.accent}80`,borderRadius:4,cursor:"pointer",lineHeight:1}}>−{_loadStep}</button>
          <div style={{flex:1,position:"relative"}}>
            <NumField value={loadPct} decimals={0} onCommit={v=>setLoadPct(Math.max(20,Math.min(100,+v)))}
              style={{width:"100%",padding:"5px 6px",fontFamily:"'Barlow Condensed',sans-serif",color:C.accent,fontSize:18,fontWeight:700,background:C.bg,border:`1px solid ${C.accent}80`,borderRadius:4,textAlign:"center",outline:"none",letterSpacing:".5px"}}/>
            <span style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",fontSize:11,color:C.txtMuted,fontFamily:"monospace",pointerEvents:"none"}}>%</span>
          </div>
          <button onClick={()=>setLoadPct(Math.max(20,Math.min(100,Math.round(loadPct+_loadStep))))}
            title={`Increase load by ${_loadStep}%`}
            style={{padding:"4px 10px",fontSize:13,fontWeight:700,fontFamily:"monospace",color:C.accent,background:"transparent",border:`1px solid ${C.accent}80`,borderRadius:4,cursor:"pointer",lineHeight:1}}>+{_loadStep}</button>
        </div>
        <input type="range" min="20" max="100" step={_loadStep} value={loadPct} onChange={e=>setLoadPct(+e.target.value)}
          style={{width:"100%",accentColor:C.accent,display:"block"}}/>
        <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:C.txtMuted,fontFamily:"monospace",marginTop:-1}}>
          <span>20%</span><span>60%</span><span>100%</span>
        </div>
        {/* Editable step — drives both ± buttons and the slider step. */}
        <div style={{display:"flex",alignItems:"center",gap:5,marginTop:5}}
          title="Step size for the ± buttons and the slider above. Edit to any integer 1..50.">
          <span style={{fontSize:9.5,color:C.txtMuted,fontFamily:"monospace"}}>Step (%):</span>
          <NumField value={_loadStep} decimals={0}
            onCommit={v=>setLoadStepPct&&setLoadStepPct(Math.max(1,Math.min(50,Math.round(+v||5))))}
            style={{width:42,padding:"2px 4px",fontSize:10,fontFamily:"monospace",color:C.accent,background:C.bg,border:`1px solid ${C.accent}50`,borderRadius:3,textAlign:"center",outline:"none"}}/>
          <span style={{fontSize:9,color:C.txtMuted,fontFamily:"monospace",marginLeft:"auto"}}>persists</span>
        </div>
      </div>

      {/* ── COMPRESSOR BLEED — moved here on 2026-05-02 to sit directly
          under the Load card and ABOVE Ambient Conditions, where the
          operator naturally looks after adjusting load. ── */}
      {bleedBlock}

      {/* ── AMBIENT CONDITIONS ───────────────────────────────────────── */}
      <div style={{fontSize:9,fontWeight:700,color:C.txtDim,textTransform:"uppercase",letterSpacing:"1px",marginTop:4,marginBottom:2}}>Ambient Conditions</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
        <div>
          <label style={lbl} title="Ambient (inlet filter) pressure">P_amb ({uu(units,"P")})</label>
          <NumField value={uv(units,"P",Pamb/1.01325)} decimals={3} onCommit={v=>setPamb(uvI(units,"P",v)*1.01325)} style={S.inp}/>
        </div>
        <div>
          <label style={lbl} title="Ambient dry-bulb temperature">T_amb ({uu(units,"T")})</label>
          <NumField value={uv(units,"T",Tamb)} decimals={1} onCommit={v=>setTamb(uvI(units,"T",v))} style={S.inp}/>
        </div>
        <div>
          <label style={lbl}>RH (%)</label>
          <NumField value={RH} decimals={0} onCommit={v=>setRH(Math.max(0,Math.min(100,+v)))} style={S.inp}/>
        </div>
        {isLMS?
          <div>
            <label style={lbl} title="Intercooler cooling-water supply temperature.">T_cool ({uu(units,"T")})</label>
            <NumField value={uv(units,"T",Tcool)} decimals={1} onCommit={v=>setTcool(uvI(units,"T",v))} style={S.inp}/>
          </div>
          :<div/>}
      </div>
      <div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
          <label style={{fontSize:10.5,color:C.txtMuted,fontFamily:"monospace"}} title="Flame-zone share of combustor airflow. Sets T_Bulk / φ_Bulk only (not η). Default 0.867.">Comb. Air Frac (flame)</label>
          <NumField value={airFrac} decimals={3} onCommit={v=>setAirFrac(Math.max(0.30,Math.min(1.00,+v)))} style={{width:64,padding:"3px 6px",fontFamily:"monospace",color:C.accent,fontSize:11.5,fontWeight:700,background:C.bg,border:`1px solid ${C.accent}50`,borderRadius:4,textAlign:"center",outline:"none"}}/>
        </div>
        <input type="range" min="0.30" max="1.00" step="0.005" value={airFrac} onChange={e=>setAirFrac(+e.target.value)} style={{width:"100%",accentColor:C.accent}}/>
      </div>

    </div>
  </div>);
}

/* ══════════════════ LOGO ══════════════════ */
function Logo({size=28}){return(<svg width={size} height={size} viewBox="0 0 40 40" fill="none"><rect x="2" y="2" width="36" height="36" rx="6" stroke={C.accent} strokeWidth="2.5" fill="none"/><path d="M10 28 L14 12 L20 22 L26 12 L30 28" stroke={C.accent2} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/><circle cx="20" cy="18" r="3" fill={C.accent} opacity=".6"/></svg>);}

/* ══════════════════ MAIN APP ══════════════════ */
// ─────────────────────────────────────────────────────────────────────
//  TAB CATALOG
//
//  Each entry can carry two filters that compose:
//    `engines`: [...] — show only when cycleEngine matches one of these
//                       (used to hide LMS100-specific Mapping when LM6000 is active)
//    `modes`:   [...] — show only when the active Application Mode is in this set
//                       ("free", "ctk", "gts", "advanced")
//  Visible tabs = TABS_BASE.filter(both filters satisfied OR filter absent).
//  See APP_MODES below for what each mode includes.
// ─────────────────────────────────────────────────────────────────────
const TABS_BASE=[
  {id:"summary",     label:"Operations Summary",  icon:"📈", modes:["gts","advanced"]},
  {id:"cycle",       label:"Cycle",               icon:"🛠️", modes:["gts","advanced"]},
  {id:"mapping",     label:"Combustor Mapping",   icon:"🎯", engines:["LMS100PB+"], modes:["gts","advanced"]},
  {id:"aft",         label:"Flame Temp & Properties", icon:"🔥", modes:["free","ctk","advanced"]},
  {id:"exhaust",     label:"Exhaust Analysis",    icon:"🔬", modes:["free","ctk","gts","advanced"]},
  {id:"combustor",   label:"Combustor PSR→PFR",   icon:"🏭", modes:["free","ctk","advanced"]},
  {id:"flame",       label:"Flame Speed & Blowoff", icon:"⚡", modes:["ctk","advanced"]},
  {id:"automate",    label:"Automate",            icon:"🧪", modes:["ctk","advanced"]},
  {id:"nomenclature",label:"Nomenclature",        icon:"📚"},  // always visible (reference)
  {id:"assumptions", label:"Assumptions",         icon:"📘"},  // always visible (reference)
];
const ACCOUNT_TAB={id:"account",label:"Account & Billing",icon:"👤"};

// ─────────────────────────────────────────────────────────────────────
//  APPLICATION MODES — the four user-selectable workflow tiers.
//
//  Each entry:
//    id           internal key, persisted to localStorage["ctk_app_mode"]
//    label        button copy ("Free", "Combustion Toolkit", …)
//    icon         single glyph for the dropdown row
//    subtitle     one-line description used in the picker rows
//    requiresSub  true → user must be subscribed; clicking when not
//                 subscribed pops the pricing modal instead of switching
//    accent       which C.* token tints the banner strip
//    bannerStrong leading colored text in the mode banner
//    bannerBody   descriptive copy shown to the right of bannerStrong
//
//  `accurate` (the legacy boolean used everywhere via AccurateCtx) is now
//  derived: accurate = (mode !== "free"). Free routes calcs through the
//  in-browser JS reduced-order model; the other three modes route through
//  the Cantera backend.
// ─────────────────────────────────────────────────────────────────────
const APP_MODES = [
  {
    id: "free", label: "Free", icon: "○",
    subtitle: "Combustion analysis · simplified JS model · φ ≤ 1.0",
    requiresSub: false,
    accent: "warm",
    bannerStrong: "⚠ FREE VERSION",
    bannerBody: "Simplified model, accurate for φ ≤ 1.0 only. Flame temperature accuracy is within 20 °F vs Cantera. Not suitable for RQL, SAC, or other rich/staged combustion systems. Upgrade for exact Cantera-backed results across all regimes.",
  },
  {
    id: "ctk", label: "Combustion Toolkit", icon: "🔥",
    subtitle: "Full Cantera combustion · all φ regimes · DOE automation",
    requiresSub: true,
    accent: "accent",
    bannerStrong: "🔥 COMBUSTION TOOLKIT",
    bannerBody: "Full Cantera-backed combustion analysis: AFT, PSR-PFR network, flame speed, exhaust inversion, and automated DOE. All φ regimes — RQL, SAC, and staged combustion stable.",
  },
  {
    id: "gts", label: "Gas Turbine Simulator", icon: "🛠️",
    subtitle: "Engine deck · cycle + LMS100 four-circuit mapping",
    requiresSub: true,
    accent: "accent3",
    bannerStrong: "🛠️ GAS TURBINE SIMULATOR",
    bannerBody: "Engine-deck performance for the LMS100PB+ DLE IC (intercooled aero-derivative). Off-design power, heat rate, T3 / T4 / P3, bleed scheduling, BR-mode ladder. Powered by Cantera HP-equilibrium combustion and Cantera turbine expansion. Additional engine decks are in development.",
  },
  {
    id: "advanced", label: "Advanced Mode", icon: "🔬",
    subtitle: "Everything · combustion + cycle + mapping + automation",
    requiresSub: true,
    accent: "violet",
    bannerStrong: "🔬 ADVANCED MODE",
    bannerBody: "Full toolkit — combustion analysis + engine cycle + LMS100 four-circuit mapping + DOE automation. Cantera Accurate mode active across all panels.",
  },
];
function _modeById(id){ return APP_MODES.find(m => m.id === id) || APP_MODES[0]; }

// ─────────────────────────────────────────────────────────────────────
//  Application Mode picker — dropdown button shown in the header.
//
//  Compact button shows the current mode label; clicking opens an
//  absolutely-positioned menu listing all four modes with their subtitle.
//  Clicking a row calls onPick(modeId); the parent's setMode handles the
//  subscription gate (popping the pricing modal if unsubscribed).
//  Click-outside (mousedown anywhere outside) closes the menu.
// ─────────────────────────────────────────────────────────────────────
function AppModePicker({ mode, onPick, onUnlock, hasOnline }){
  const[open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const m = _modeById(mode);
  const accentTok = m.accent;
  return (
    <div ref={ref} style={{position:"relative"}}>
      <button onClick={() => setOpen(o => !o)}
        title="Application Mode — pick which set of panels to load"
        style={{padding:"6px 12px", fontSize:11, fontWeight:700,
          color: C[accentTok], background: `${C[accentTok]}18`,
          border: `1px solid ${C[accentTok]}`, borderRadius: 6, cursor: "pointer",
          fontFamily: "'Barlow Condensed',sans-serif", letterSpacing: ".5px",
          display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap"}}>
        <span style={{fontSize:13}}>{m.icon}</span>
        MODE: {m.label.toUpperCase()}
        <span style={{fontSize:9, marginLeft:2, opacity:.7}}>▾</span>
      </button>
      {open && (
        <div style={{position:"absolute", top:"calc(100% + 6px)", right:0,
          minWidth: 320, background: C.bg2, border: `1px solid ${C.border}`,
          borderRadius: 8, boxShadow: `0 8px 24px ${C.bg}99`,
          zIndex: 50, overflow:"hidden"}}>
          <div style={{padding:"8px 12px", fontSize:9, fontWeight:700,
            color: C.txtMuted, textTransform: "uppercase", letterSpacing:"1.2px",
            background: C.bg3, borderBottom: `1px solid ${C.border}`,
            fontFamily: "'Barlow Condensed', sans-serif"}}>
            Application Mode
          </div>
          {APP_MODES.map(opt => {
            const active  = opt.id === mode;
            const locked  = opt.requiresSub && !hasOnline;
            const tone    = C[opt.accent];
            return (
              <button key={opt.id}
                onClick={() => {
                  setOpen(false);
                  if (locked) onUnlock();
                  else onPick(opt.id);
                }}
                style={{width:"100%", textAlign:"left",
                  padding:"10px 14px",
                  display:"flex", alignItems:"flex-start", gap:10,
                  background: active ? `${tone}15` : "transparent",
                  border: "none",
                  borderBottom: `1px solid ${C.border}40`,
                  cursor: "pointer",
                  fontFamily: "'Barlow', sans-serif"}}>
                <span style={{fontSize:18, lineHeight:1, marginTop:1}}>{opt.icon}</span>
                <span style={{flex:1}}>
                  <span style={{display:"flex", alignItems:"center", gap:6}}>
                    <span style={{fontSize:12, fontWeight:700, color: active ? tone : C.txt,
                      letterSpacing:".3px"}}>{opt.label}</span>
                    {locked && (
                      <span title="Requires subscription"
                        style={{fontSize:9, fontWeight:700, color: C.txtMuted,
                          padding:"1px 6px", border: `1px solid ${C.border}`,
                          borderRadius:3, fontFamily:"'Barlow Condensed',sans-serif",
                          letterSpacing:".5px"}}>
                        🔒 PRO
                      </span>
                    )}
                    {active && (
                      <span style={{fontSize:9, fontWeight:700, color: tone,
                        padding:"1px 6px", border: `1px solid ${tone}80`,
                        borderRadius:3, fontFamily:"'Barlow Condensed',sans-serif",
                        letterSpacing:".5px"}}>
                        ACTIVE
                      </span>
                    )}
                  </span>
                  <span style={{display:"block", fontSize:10.5,
                    color: C.txtMuted, lineHeight:1.4, marginTop:2}}>
                    {opt.subtitle}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function App(){
  // All engineering state below is stored in SI internally (K, atm, m/s, m).
  // Sidebar inputs display and accept values in the currently selected unit system,
  // converting to/from SI via uv()/uvI(). This guarantees that toggling SI↔ENG
  // leaves calculations and chart axes self-consistent.
  const auth=useAuth();
  const[tab,setTab]=useState("summary");const[phi,setPhi]=useState(0.555);const[T0,setT0]=useState(810.93);const[P,setP]=useState(27.22);const[units,setUnits]=useState("ENG");
  // ── Gas-turbine cycle inputs & linkages ─────────────────────────────────
  // When a linkage toggle is ON, the corresponding sidebar input (Air T, Pressure, or phi/FAR)
  // is driven from the latest cycle result and displayed with a lock badge. "Break link"
  // turns the toggle off and returns manual control. Links default ON because the cycle
  // panel is the first tab and its outputs are the *intent* of most subsequent analyses.
  const[cycleEngine,setCycleEngine]=useState("LMS100PB+");
  // LM6000PF was hidden from the UI on 2026-05-02 (under development).
  // If any saved state (Automate scenario, persisted picker) has LM6000PF
  // as the engine, force it back to the only currently-shipping deck so
  // the dropdown stays consistent with the available <option>s.
  useEffect(()=>{ if(cycleEngine!=="LMS100PB+") setCycleEngine("LMS100PB+"); },[cycleEngine]);
  const[cyclePamb,setCyclePamb]=useState(1.01325);     // bar
  const[cycleTamb,setCycleTamb]=useState(288.706);     // K (60 F)
  const[cycleRH,setCycleRH]=useState(60.0);            // %
  const[cycleLoad,setCycleLoad]=useState(100.0);       // %
  // Emissions Mode — when enabled (default) the full BRNDMD ladder is
  // active (1→2→4→6→7). When disabled, BRNDMD holds at 4 for MW > 45
  // (combustor stays in a simpler mode rather than progressing to high-
  // load modes). Referenced by calcBRNDMD() and displayed in Ops Summary.
  const[emissionsMode,setEmissionsMode]=useState(true);
  // Engine Protection Logic override — set by the Live Mapping panel when
  // it auto-stages the engine due to elevated PX36_SEL acoustics. When
  // non-null, this value wins over the natural ladder in calcBRNDMD.
  const[brndmdOverride,setBrndmdOverride]=useState(null);  // null | 4 | 6 | 7
  // ── Emissions-mode staging (App level so it fires from any tab) ─────
  // Mirrors the Live Mapping protection staging timing (BD4 → 50s → BD6 →
  // 30s → BD7) but triggers on the Emissions Mode toggle. The endpoint
  // adapts to current MW_net: low load (BR_max=4) skips entirely; mid load
  // (BR_max=6) stops at BD6; high load (BR_max=7) runs the full sequence.
  // OFF → ON triggers staging; ON → OFF cancels timers + releases override
  // so the natural ladder snaps to BD4 with no wait.
  const _emStagingRef = useRef({ state: 'idle', targetMaxBR: 4, timer: null });
  const [emStagingBanner, setEmStagingBanner] = useState(null);
  // Stable refs for the values the staging closures need to read at fire-
  // time (cycleResult, setBrndmdOverride). useEffect dependency on
  // emissionsMode below is the only retrigger.
  const _cycleResultStagingRef = useRef(null);
  const _clearEmStagingTimer = () => {
    if (_emStagingRef.current.timer) {
      clearTimeout(_emStagingRef.current.timer);
      _emStagingRef.current.timer = null;
    }
  };
  const _cancelEmissionsStaging = () => {
    _clearEmStagingTimer();
    _emStagingRef.current.state = 'idle';
    setBrndmdOverride(null);
    setEmStagingBanner(null);
  };
  const _triggerEmissionsStaging = () => {
    const mw = _cycleResultStagingRef.current?.MW_net || 0;
    const targetMaxBR = calcBRNDMD(mw, true, null);
    // Skip staging entirely when natural ladder caps at ≤ 4 (low load,
    // engine would just run at BD4 anyway).
    if (targetMaxBR <= 4) return;
    _clearEmStagingTimer();
    _emStagingRef.current.state = 'at4';
    _emStagingRef.current.targetMaxBR = targetMaxBR;
    setBrndmdOverride(4);
    setEmStagingBanner({ currentBR: 4, nextBR: 6, timerEndsAt: (Date.now()/1000) + 50 });
    _emStagingRef.current.timer = setTimeout(() => {
      // Phase 2: BR=6
      _emStagingRef.current.state = 'at6';
      setBrndmdOverride(6);
      if (_emStagingRef.current.targetMaxBR === 6) {
        // Mid-load: stop at BD6, don't progress to BD7. Release override
        // (ladder gives BR=6 naturally at this MW range).
        _emStagingRef.current.timer = setTimeout(() => {
          _emStagingRef.current.state = 'done';
          _emStagingRef.current.timer = null;
          setBrndmdOverride(null);
          setEmStagingBanner(null);
        }, 100);
        setEmStagingBanner({ currentBR: 6, nextBR: null, timerEndsAt: null });
      } else {
        // High-load: continue to BR=7 after 30 s
        setEmStagingBanner({ currentBR: 6, nextBR: 7, timerEndsAt: (Date.now()/1000) + 30 });
        _emStagingRef.current.timer = setTimeout(() => {
          _emStagingRef.current.state = 'done';
          _emStagingRef.current.timer = null;
          setBrndmdOverride(null);
          setEmStagingBanner(null);
        }, 30 * 1000);
      }
    }, 50 * 1000);
  };
  const[cycleTcool,setCycleTcool]=useState(288.15);    // K (15 C) — LMS100 IC supply
  // Combustor-air fraction is the FLAME-ZONE share of combustor airflow
  // (m_flame / m_comb_air). It is a pure intra-combustor split and does NOT
  // affect efficiency (η is handled by a private per-engine calibration in
  // the backend). Its only job is to set the flame-zone state:
  //    FAR_Bulk = FAR4 / frac,  phi_Bulk = phi4 / frac,  T_Bulk = adiabatic
  //    equilibrium T at (T3, P3, phi_Bulk).
  // 0.88 is a nominal DLE primary-zone fraction.
  // Per-engine calibration defaults. Chosen from OEM / SME-informed values:
  // combustor_air_frac (flame/total) and L_pfr (burnout length, m) depend on
  // combustor geometry and primary-zone design.
  const CYCLE_AIRFRAC_DEFAULT={"LM6000PF":0.867,"LMS100PB+":0.867};
  const CYCLE_LPFR_DEFAULT_M ={"LM6000PF":0.21336,"LMS100PB+":0.13716};   // 0.70 ft / 0.45 ft
  const[cycleAirFrac,setCycleAirFrac]=useState(CYCLE_AIRFRAC_DEFAULT["LM6000PF"]);
  // ── Cycle linkage flags (raw user-controlled state) ───────────────
  // Raw flags hold the user's preference inside Advanced Mode. The
  // EFFECTIVE link state used everywhere else (sidebar chips, the
  // App-level cycle-result propagation effects, the CyclePanel toggles)
  // is DERIVED from `mode` further below:
  //   free / ctk    → all OFF (cycle never runs; no source to link to)
  //   gts           → all ON  (cycle drives every combustion variable;
  //                            engine-mode always linked by spec — no
  //                            break-link button exposed)
  //   advanced      → the raw flags ARE the effective state; user
  //                   controls them via the CyclePanel toggles + the
  //                   sidebar BREAK chips
  const[linkT3Raw,setLinkT3]=useState(true);
  const[linkP3Raw,setLinkP3]=useState(true);
  const[linkFARRaw,setLinkFAR]=useState(true);
  const[linkOxRaw,setLinkOx]=useState(true);
  // Fifth linkage: Fuel Flow ← cycle ṁ_fuel. Same mode-derivation as the
  // others (forced ON in GTS, user-controlled in Advanced, hidden in Free/CTK).
  const[linkFuelFlowRaw,setLinkFuelFlow]=useState(true);
  // Sixth + seventh linkages: Exhaust CO / UHC ← Mapping CO15 (corrected from
  // 15% O₂ basis to actual O₂ basis using a Phi_Exhaust derived from THIS
  // panel's fuel/air flows — NOT cycle.phi4). UHC = CO/3 per LMS100 mapping
  // convention. Same mode-derivation as the other linkages: forced ON in GTS,
  // user-controlled in Advanced, hidden in Free / Combustion-Toolkit.
  const[linkExhaustCORaw,setLinkExhaustCO]=useState(true);
  const[linkExhaustUHCRaw,setLinkExhaustUHC]=useState(true);
  // Flame Speed & Blowoff panel sidebar/panel-local defaults.
  // Set to industrial-gas-turbine premixer values (per Phase 0 of the
  // Flame Speed redesign plan): 50 m/s reference velocity, 25 mm L_char,
  // 20 mm flame-holder, 80 mm premixer length, 60 m/s premixer bulk
  // velocity. These are the conditions where S_L and Da read "industrial"
  // out of the box (rather than a 30 cm lab burner at 3 m/s).
  const[velocity,setVelocity]=useState(50);   // 50 m/s — typical premixer ref velocity
  const[Lchar,setLchar]=useState(0.025);      // 25 mm — bluff-body / liner-scale flame anchor
  // Premixer stability inputs. D_fh = flameholder diameter (Zukoski τ_BO).
  // L_premix / V_premix = premixer geometry (autoignition safety: τ_res < τ_ign).
  const[Dfh,setDfh]=useState(0.020);          // 20 mm — typical bluff-body / burner rod
  const[Lpremix,setLpremix]=useState(0.080);  // 80 mm — fuel-injection point to flame anchor
  const[Vpremix,setVpremix]=useState(60);     // 60 m/s — premixer bulk velocity
  const[tau_psr,setTauPsr]=useState(0.5);const[L_pfr,setLpfr]=useState(0.21336);const[V_pfr,setVpfr]=useState(30.48);
  // Fuel-stream inlet temperature (K). Air inlet T = T0 (sidebar). When T_fuel != T0
  // the combustor mixes them adiabatically before the PSR.
  const[T_fuel,setTfuel]=useState(294.261); // 70 °F
  // Water / steam injection (3rd stream). WFR = mass ratio of water to fuel.
  // water_mode = "liquid" absorbs the latent heat of vaporization; "steam" does not.
  // Both feed the Cantera adiabatic enthalpy balance in the backend.
  const[WFR,setWFR]=useState(0);
  const[waterMode,setWaterMode]=useState("liquid");
  // Water inlet temperature (K). Independent from fuel temperature. Default
  // 288.15 K for liquid (cold city water), 450 K for steam (mid-pressure saturated).
  // Changes when the user flips modes unless they've manually overridden.
  const[T_water,setTwater]=useState(288.15);
  // Compressor-discharge bleed. The bleed valve dumps a fraction of compressor
  // air to ambient (it never reaches the combustor or turbine). Two knobs:
  //   • bleedMode   = "auto" (programmed schedule vs load) | "manual" (user value)
  //   • bleedValveSizePct = max bleed % at fully-open (default 3.3 %)
  //   • bleedOpenManualPct = override % open (only used in manual mode)
  // Auto schedule: 100 % open at load ≤ 75 %, 0 % at load ≥ 95 %, linear between.
  // Effective bleed_air_frac = (open % / 100) × (valve_size % / 100).
  const[bleedMode,setBleedMode]=useState("auto");
  const[bleedOpenManualPct,setBleedOpenManualPct]=useState(100);
  const[bleedValveSizePct,setBleedValveSizePct]=useState(7.75);
  // UI step size for Bleed Open % (manual mode). Selectable via the chips
  // under the Bleed Open NumField. 1 = fine (per-% step); 15/30/45/60/75/90 are
  // coarse steps for quickly nudging the valve to common operating points.
  const[bleedStepPct,setBleedStepPct]=useState(15);
  // Load %-step for the Engine&Ambient sidebar ± buttons. Default is 5 %.
  // Persists across reloads; user can edit to any positive integer 1..50.
  const[loadStepPct,setLoadStepPct]=useState(()=>{
    try{const s=localStorage.getItem("ctk.loadStepPct.v1");
      if(s!==null){const n=Math.round(+s);if(n>=1&&n<=50)return n;}
    }catch(e){}
    return 5;
  });
  useEffect(()=>{try{localStorage.setItem("ctk.loadStepPct.v1",String(loadStepPct));}catch(e){}},[loadStepPct]);

  // ── Heavy-panel activation state, lifted to App so it survives tab nav.
  // Two pieces per panel:
  //   * <panel>Active        — boolean activation flag (session-only useState
  //                            in App; intentionally NOT persisted, so a
  //                            browser restart always starts deactivated).
  //   * keep<Panel>Activated — user preference (persisted via localStorage)
  //                            to skip the auto-deactivate-on-nav-away.
  // The auto-deactivate effect below watches `tab` and clears the active
  // flag when the user navigates AWAY from the owning panel UNLESS the
  // matching keep* preference is on.
  const[flameActive,setFlameActive]=useState(false);
  // Cantera flame results lifted from FlameSpeedPanel so the Excel exporter
  // can write the LIVE Cantera S_L / Le_eff / Le_E / Le_D / Ma / Ze / δ_F
  // / α_th / ν_u / T_max instead of falling back to the free-mode JS Gülder
  // correlation. Without this lift, the Excel sheet shipped low-fidelity
  // numbers even when the user was in Combustion Toolkit / Cantera mode.
  const[flameBk,setFlameBk]=useState(null);
  const[flameBkIgn,setFlameBkIgn]=useState(null);
  const[flameCanteraSweeps,setFlameCanteraSweeps]=useState(null);
  const[psrActive,setPsrActive]=useState(false);
  const[keepFlameActivated,setKeepFlameActivated]=useState(()=>{
    try{return localStorage.getItem("ctk.keepFlameActivated.v1")==="1";}catch(e){return false;}
  });
  const[keepPsrActivated,setKeepPsrActivated]=useState(()=>{
    try{return localStorage.getItem("ctk.keepPsrActivated.v1")==="1";}catch(e){return false;}
  });
  useEffect(()=>{try{localStorage.setItem("ctk.keepFlameActivated.v1",keepFlameActivated?"1":"0");}catch(e){}},[keepFlameActivated]);
  useEffect(()=>{try{localStorage.setItem("ctk.keepPsrActivated.v1",keepPsrActivated?"1":"0");}catch(e){}},[keepPsrActivated]);
  // (auto-deactivate-on-tab-change effect lives further down, AFTER `tab` is
  // declared, to avoid a temporal-dead-zone reference.)
  // ── Combustor-Mapping panel inputs (lifted to App so Operations Summary
  // can reuse the same correlation result — /calc/combustor_mapping is
  // fired once in App and the bkMap handle is passed to both panels).
  const[mapW36w3,setMapW36w3]=useState(0.75);
  const[mapFracIP,setMapFracIP]=useState(2.3);
  const[mapFracOP,setMapFracOP]=useState(2.2);
  const[mapFracIM,setMapFracIM]=useState(39.9);
  const[mapFracOM,setMapFracOM]=useState(55.6);
  const[mapPhiIP,setMapPhiIP]=useState(0.25);
  const[mapPhiOP,setMapPhiOP]=useState(0.65);
  const[mapPhiIM,setMapPhiIM]=useState(0.50);
  // ── Mapping tables (φ vs T3 for BRNDMD ∈ {2,4,6,7}) — persisted to
  // localStorage so user edits survive page refresh. Tables auto-fill the
  // IP/OP/IM φ inputs whenever T3 or BRNDMD changes.
  const[mappingTables,setMappingTables]=useState(()=>{
    try{
      const s=localStorage.getItem("ctk.mappingTables.v1");
      if(s){const p=JSON.parse(s);if(p&&p[2]&&p[4]&&p[6]&&p[7])return p;}
    }catch(e){}
    return JSON.parse(JSON.stringify(DEFAULT_MAPPING_TABLES));
  });
  useEffect(()=>{try{localStorage.setItem("ctk.mappingTables.v1",JSON.stringify(mappingTables));}catch(e){}},[mappingTables]);
  // ── Emissions Transfer Function — per-BRNDMD output multipliers for
  // NOx15 and CO15. Applied as a final post-multiplier on the correlation
  // result (after linear corrections, Phi_OP mult, and P3 scaling). User-
  // editable in the sidebar; persisted to localStorage.
  const DEFAULT_EM_TF={
    7:{NOx:1.00,CO:1.00,PX36:1.00},
    6:{NOx:1.25,CO:0.90,PX36:1.00},
    4:{NOx:1.50,CO:0.85,PX36:1.50},
    2:{NOx:0.50,CO:0.25,PX36:1.00},
  };
  const[emTfMults,setEmTfMults]=useState(()=>{
    try{
      const s=localStorage.getItem("ctk.emTfMults.v1");
      if(s){const p=JSON.parse(s);if(p&&p[7]&&p[6]&&p[4]&&p[2])return p;}
    }catch(e){}
    return JSON.parse(JSON.stringify(DEFAULT_EM_TF));
  });
  useEffect(()=>{try{localStorage.setItem("ctk.emTfMults.v1",JSON.stringify(emTfMults));}catch(e){}},[emTfMults]);

  // ── Mapping-table auto-fill (App-level so it fires on ANY cycle change,
  //    not just when the Mapping panel is mounted). The panel itself shows
  //    its own "Active lookup" summary from the same data. This keeps Card 1
  //    circuit φ inputs, bkMap, and Ops Summary NOx/CO all in sync as the
  //    user tweaks sidebar parameters from any tab. ───────────────────────
  const[measO2,setMeasO2]=useState(14.0);const[measCO2,setMeasCO2]=useState(3.0);
  // ── Exhaust slip measurements (CO + UHC) ─────────────────────────────
  // Optional. When non-zero, the Chemical Equilibrium card on the Exhaust
  // panel computes a combustion efficiency η_c via the energy-loss formula
  //   η_c = 1 − N_dry/fuel · (X_CO·LHV_CO + X_UHC·LHV_CH4) / LHV_fuel,molar
  // and reports fed-side φ / FAR / AFR (= burn-side / η_c) along with the
  // fed-side flame T re-computed at φ_fed via Cantera HP equilibrium.
  // Defaults are zero — the panel behaves identically to the no-slip case
  // until the user enters values. UHC is reported as ppmvd "as CH₄" on the
  // actual-O₂ basis (NOT 15% O₂ corrected); CO same.
  const[measCO,setMeasCO]=useState(0);
  const[measUHC,setMeasUHC]=useState(0);
  const[measH2,setMeasH2]=useState(0);
  // ── Fuel & Money operating-point inputs (for the Fuel & Money card on
  // the Exhaust panel). Stored in SI (kg/s) so the panel-side display
  // logic can convert to either kg/hr (SI) or lb/hr (ENG) and the panel
  // is unit-toggle-aware. Default = 40,000 lb/hr (typical heavy-duty GT
  // baseload fuel rate, e.g. an LMS100 at full load) = 5.0399 kg/s.
  const[fuelFlowKgs,setFuelFlowKgs]=useState(40000 * 0.453592 / 3600);
  // Fuel cost in USD per million BTU on a LHV basis — the standard
  // contract / regulatory unit for natural gas. Default $4.00/MMBTU LHV
  // (a typical 2024-2026 industrial-tier U.S. NG benchmark).
  const[fuelCostUsdPerMmbtuLhv,setFuelCostUsdPerMmbtuLhv]=useState(4.00);
  // Time period for the weekly / monthly / annual cost rollup.
  const[costPeriod,setCostPeriod]=useState("month"); // "week" | "month" | "year"
  // Penalty value lifted FROM ExhaustPanel via onPenaltyUpdate callback.
  // Surfaced on the Combustor Mapping panel's Operating Snapshot summary
  // so the inefficiency dollar cost is visible alongside acoustics/emissions.
  // null = no value yet (Exhaust panel hasn't run, no slip, no fuel flow).
  const[exhaustPenalty,setExhaustPenalty]=useState(null); // {value:Number, period:"week"|"month"|"year"} | null
  const[combMode,setCombMode]=useState("complete"); // "complete" or "equilibrium"
  const[showHelp,setShowHelp]=useState(false);
  const[showPricing,setShowPricing]=useState(false);
  const[authModal,setAuthModal]=useState(null); // null | "login" | "signup"
  // ── Application Mode (replaces the old "accurate" boolean) ─────────
  // Four modes: free / ctk / gts / advanced. See APP_MODES catalog at
  // the top of this file. The legacy `accurate` flag is DERIVED from
  // mode (accurate = mode !== "free") so every existing AccurateCtx
  // consumer keeps working without refactoring.
  //
  // Persistence: localStorage["ctk_app_mode"]. On load we downgrade to
  // "free" if the saved mode requires a subscription the user doesn't
  // have — that prevents stale state from a previous session leaking
  // into a logged-out tab.
  const[mode, setModeRaw] = useState(() => {
    try {
      const saved = localStorage.getItem("ctk_app_mode");
      if (saved && APP_MODES.some(m => m.id === saved)) return saved;
    } catch {}
    return "free";   // safe default; will be lifted to "advanced" by the
                     // auth-aware effect below for subscribed users
  });
  const accurate = (mode !== "free");
  // No-op stub for any future caller that imports setAccurate via
  // AccurateCtx. The mode picker is the canonical control now.
  const setAccurate = () => {};

  // ── Effective cycle linkages (derived from mode) ──────────────────
  // free/ctk → false (no cycle running)
  // gts      → true  (engine mode is always linked)
  // advanced → user-controlled via the *Raw flags above
  const linkT3  = (mode === "advanced") ? linkT3Raw  : (mode === "gts");
  const linkP3  = (mode === "advanced") ? linkP3Raw  : (mode === "gts");
  const linkFAR = (mode === "advanced") ? linkFARRaw : (mode === "gts");
  const linkOx  = (mode === "advanced") ? linkOxRaw  : (mode === "gts");
  const linkFuelFlow = (mode === "advanced") ? linkFuelFlowRaw : (mode === "gts");
  // Exhaust CO/UHC linkages (only meaningful when a cycle is running, so
  // free/ctk evaluate to false naturally — no Mapping panel + no cycleResult
  // means there's nothing to link FROM).
  const linkExhaustCO  = (mode === "advanced") ? linkExhaustCORaw  : (mode === "gts");
  const linkExhaustUHC = (mode === "advanced") ? linkExhaustUHCRaw : (mode === "gts");
  // The sidebar BREAK button is only meaningful in Advanced. We pass
  // null for onBreak in non-Advanced modes so LinkChip suppresses
  // the button (showing the chip as a read-only status indicator).
  const _linkBreakable = (mode === "advanced");
  // ── Theme state ─────────────────────────────────────────────────────
  // Theme is hot-swappable ("dark" ↔ "light"). The actual palette lives at
  // module level in `_activeC` (see DARK_C / LIGHT_C). Toggling here:
  //   1. updates `_activeC` (so any FUTURE C.x reads return new colors)
  //   2. bumps `themeRev`, which is passed as a React `key` to the panel
  //      tree below — that key change forces a clean re-mount and every
  //      inline-style site picks up the new palette without us refactoring
  //      thousands of `style={{background: C.bg}}` references into hooks.
  const[theme, setTheme] = useState(() => _readActiveTheme());
  const[themeRev, setThemeRev] = useState(0);
  useEffect(() => {
    setActiveTheme(theme);
    setThemeRev(r => r + 1);
  }, [theme]);
  // Clear-cache button feedback — briefly flips to "✓ CLEARED" after a click.
  const[cacheCleared,setCacheCleared]=useState(false);
  // PSR reactor options (lifted from CombustorPanel so they can be captured in Excel export).
  const[psrSeed,setPsrSeed]=useState("cold_ignited");
  const[eqConstraint,setEqConstraint]=useState("HP");
  const[integration,setIntegration]=useState("chunked");
  const[heatLossFrac,setHeatLossFrac]=useState(0);
  const[mechanism,setMechanism]=useState("gri30");
  const hasOnline=!!auth.hasOnlineAccess;

  // Checkout return — refresh subscription state after coming back from Stripe
  useEffect(()=>{
    const u=new URL(window.location.href);
    if(u.searchParams.get("checkout")==="success"||u.searchParams.get("checkout")==="canceled"){
      if(u.searchParams.get("checkout")==="success"){setTab("account");}
      auth.refresh&&auth.refresh();
      u.searchParams.delete("checkout");u.searchParams.delete("session_id");
      window.history.replaceState({},"",u.pathname+(u.search?u.search:""));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  // Accurate-Mode auto-disable if subscription ends / user signs out
  // ── Mode setter with auth gate + persistence ──────────────────────
  // Centralised mode mutator. If the requested mode requires a
  // subscription and the user doesn't have one, we pop the pricing
  // modal AND short-circuit (the mode stays put). This is the single
  // place that gates non-Free modes — the dropdown calls it directly,
  // the auth-downgrade effect below calls it on auth-state change.
  const setMode = useCallback((next) => {
    const m = _modeById(next);
    if (m.requiresSub && !hasOnline){
      setShowPricing(true);
      return;
    }
    setModeRaw(m.id);
    try { localStorage.setItem("ctk_app_mode", m.id); } catch {}
  }, [hasOnline]);
  // Auto-downgrade if the user loses online/subscribed state while
  // sitting in a non-Free mode. Without this they'd be stuck in a
  // mode whose Cantera calls all 401 / 403.
  //
  // CRITICAL: wait for auth.loading to resolve before deciding to
  // downgrade. Without this guard, a subscribed user with
  // localStorage.ctk_app_mode = "advanced" gets demoted on the
  // first render (auth still loading → hasOnline=false), and the
  // one-shot lift effect below short-circuits because saved="advanced"
  // already exists — leaving them stuck on Free for the whole session.
  useEffect(() => {
    if (auth.loading) return;
    if (mode !== "free" && !hasOnline) setModeRaw("free");
  }, [mode, hasOnline, auth.loading]);
  // First-load lift: subscribed users with no saved mode (or with
  // saved="free" defaulted in by the useState fallback) get bumped to
  // Advanced so they see the same panel set they had before this
  // change shipped. Runs ONCE per auth state transition into "online".
  const[_modeLifted, setModeLifted] = useState(false);
  useEffect(() => {
    if (_modeLifted) return;
    if (auth.loading) return;
    if (!hasOnline) return;
    const saved = (() => { try { return localStorage.getItem("ctk_app_mode"); } catch { return null; } })();
    if (!saved){
      setModeRaw("advanced");
      try { localStorage.setItem("ctk_app_mode", "advanced"); } catch {}
    }
    setModeLifted(true);
  }, [hasOnline, _modeLifted, auth.loading]);
  // Kick user out of Account tab if they sign out
  useEffect(()=>{if(!auth.isAuthenticated&&tab==="account")setTab("cycle");},[auth.isAuthenticated,tab]);

  // Filter tabs by engine — some panels (e.g. Combustor Mapping) are only
  // meaningful for specific engines because they reflect that engine's
  // physical combustor hardware (circuit counts, pilot/main split).
  // Compose engine + mode filters: a tab is visible only if BOTH filters
  // pass (or the filter is absent). Account tab is appended for signed-in
  // users and is always available regardless of mode.
  const _baseTabs = TABS_BASE
    .filter(t => !t.engines || t.engines.includes(cycleEngine))
    .filter(t => !t.modes   || t.modes.includes(mode));
  const TABS=auth.isAuthenticated?[..._baseTabs,ACCOUNT_TAB]:_baseTabs;
  // If user is on a tab that's no longer available (engine OR mode
  // changed it out of the visible set), bounce them to the first
  // remaining tab so they never land on a blank page.
  useEffect(()=>{
    if (TABS.length === 0) return;
    if (!TABS.some(t => t.id === tab)) setTab(TABS[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[cycleEngine, mode]);
  // Auto-deactivate the heavy panels when the user navigates AWAY from them,
  // unless they've opted into "stay activated" via the per-panel preference.
  // Default keeps the original UX (deactivate on nav away) — opt-in survives
  // navigation but never survives a browser restart (state lives in App
  // useState, not localStorage; see initializers).
  useEffect(()=>{
    if(tab!=="flame" && flameActive && !keepFlameActivated) setFlameActive(false);
    if(tab!=="combustor" && psrActive && !keepPsrActivated) setPsrActive(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[tab]);
  const initF={};FUEL_SP.forEach(s=>initF[s]=0);Object.assign(initF,FUEL_PRESETS["Pipeline NG (US)"]);
  const initO={};OX_SP.forEach(s=>initO[s]=0);Object.assign(initO,OX_PRESETS["Humid Air (60%RH 25°C)"]);
  const[fuel,setFuel]=useState(initF);const[ox,setOx]=useState(initO);
  const FAR_stoich=useMemo(()=>1/(calcFuelProps(fuel,ox).AFR_mass||1e-12),[fuel,ox]);
  const FAR=phi*FAR_stoich;
  // Phi clamp: only enforce non-negativity. Cantera HP-equilibrium and the
  // complete-combustion path both handle rich mixtures correctly (φ > 1
  // triggers water-gas-shift logic on the deficient-O₂ side), so there's
  // no UI reason to cap φ at 1.0 the way the legacy Free-mode JS model
  // required. Free-mode users still see the "accurate for φ ≤ 1.0 only"
  // banner — the warning, not the slider, is the right place for that
  // guidance.
  const setPhiClamped=v=>{if(Number.isFinite(v))setPhi(Math.max(0,+v));};
  const setFAR=v=>{if(Number.isFinite(v))setPhiClamped(v/FAR_stoich);};
  // ── T_flame (canonical) ───────────────────────────────────────────────
  // The OPERATING CONDITIONS sidebar shows T_flame = adiabatic flame T at
  // the current phi/fuel/ox/T_fuel/T_air, COMPLETE COMBUSTION (no
  // dissociation). The Combustor PSR-PFR panel also displays this value
  // (as "T_AD — Complete Combustion") using Cantera's complete-combustion
  // path. Two solvers (JS calcAFT vs Cantera) gave different results — a
  // ~14 °F drift that confused users.
  //
  // Single source of truth: in Accurate Mode we fetch Cantera's
  // T_ad_complete from a dedicated /calc/aft call using the sidebar
  // values. In Free Mode we fall back to JS calcAFT. The sidebar reads
  // this canonical T_flame value, and so does the runner during
  // automation. Same number everywhere.
  const bkSidebarTflame = useBackendCalc("aft", {
    fuel: nonzero(fuel), oxidizer: nonzero(ox),
    phi, T0, P: atmToBar(P),
    mode: "adiabatic", heat_loss_fraction: 0,
    T_fuel_K: T_fuel, T_air_K: T0,
    WFR, water_mode: waterMode,
  }, accurate);
  const T_flame_canonical = useMemo(() => {
    // Prefer Cantera's complete-combustion result when available — it's
    // what the Combustor PSR-PFR panel displays. Falls through to JS
    // calcAFT if the call hasn't returned yet, fails, or accurate=false.
    if (accurate && bkSidebarTflame.data?.T_ad_complete > 0) {
      return bkSidebarTflame.data.T_ad_complete;
    }
    return calcTflameComplete(fuel, ox, phi, T_fuel, T0);
  }, [accurate, bkSidebarTflame.data, fuel, ox, phi, T_fuel, T0]);


  // Gas-turbine cycle backend call. Fires only in Accurate Mode (requires FULL subscription).
  // Uses the same fuel composition as the rest of the toolkit so linked phi is self-consistent.
  // Result drives the CyclePanel *and* the sidebar linkage toggles (T_air←T3, P←P3, phi←cycle phi).
  // Reset the combustor-air fraction AND the PFR length to the per-engine
  // defaults whenever the user picks a different engine. They can still over-
  // ride either one manually — the Cycle-panel slider for air_frac, the
  // Combustor-panel L_PFR field for burnout length.
  useEffect(()=>{
    const d=CYCLE_AIRFRAC_DEFAULT[cycleEngine];
    if(d!==undefined)setCycleAirFrac(d);
    const L=CYCLE_LPFR_DEFAULT_M[cycleEngine];
    if(L!==undefined)setLpfr(L);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[cycleEngine]);

  // Auto bleed schedule — pure function of load. Continuous, displayed as
  // rounded integer in the UI. 100 % at low load (rotor cooling demand high),
  // ramps closed between 75 → 95 % load to recover combustor air at full
  // power. Numbers match the user-specified schedule.
  const autoBleedOpenPct=(L)=>{
    if(L<=75)return 100;
    if(L>=95)return 0;
    return 100*(95-L)/20;
  };
  const bleedOpenPct=bleedMode==="auto"?Math.round(autoBleedOpenPct(cycleLoad)):bleedOpenManualPct;
  // Effective compressor-discharge fraction lost to ambient. Backend clamps
  // to [0, 0.50] so the UI never has to.
  const bleedAirFrac=Math.max(0,Math.min(0.50,(bleedOpenPct/100)*(bleedValveSizePct/100)));

  const bkCycle=useBackendCalc("cycle",{
    engine:cycleEngine,
    P_amb_bar:cyclePamb,
    T_amb_K:cycleTamb,
    RH_pct:cycleRH,
    load_pct:cycleLoad,
    T_cool_in_K:cycleEngine==="LMS100PB+"?cycleTcool:null,
    fuel_pct:nonzero(fuel),
    combustor_air_frac:cycleAirFrac,
    // Pass sidebar T_fuel so cycle's T_Bulk uses the same enthalpy-balanced
    // fuel/air mix as the Flame Temp panel (otherwise T_Bulk overshoots when
    // T_fuel ≪ T3, because cycle would treat fuel as if preheated to T3).
    T_fuel_K:T_fuel,
    // Forward the sidebar water-injection state so Cycle's flame-zone T_Bulk
    // matches the Flame Temp panel exactly when WFR>0, AND the T4 back-solve
    // uses controller-style logic (raise phi to overcome water cooling so T4
    // stays at the firing-temp setpoint). Drops η_LHV a few % — matches the
    // real-engine penalty.
    WFR,
    water_mode:waterMode,
    T_water_K:WFR>0?T_water:null,
    // Compressor-discharge bleed dumped to ambient. Reduces air to combustor
    // + turbine; backend iteratively elevates T4 to hold gross power.
    bleed_air_frac:bleedAirFrac,
  // Cycle endpoint is only ever rendered in gts / advanced modes — gate the
  // call so Free / Combustion Toolkit don't fire (and don't surface a misleading
  // "Solving gas-turbine cycle…" line in the global busy banner when the user
  // doesn't have a Cycle panel at all).
  },accurate&&hasOnline&&(mode==="gts"||mode==="advanced"));
  const cycleResult=bkCycle.data;

  // Keep the emissions-staging closure's view of cycleResult fresh — the
  // closures below read MW_net via _cycleResultStagingRef.current to decide
  // whether to skip / stop-at-6 / run-full when the user clicks the toggle.
  useEffect(() => { _cycleResultStagingRef.current = cycleResult; }, [cycleResult]);
  // Watch the Emissions Mode toggle and fire staging on OFF→ON, cancel on
  // ON→OFF. Runs at App level so a click on the sidebar button stages the
  // engine from any tab — not just inside Live Mapping. Uses a ref to
  // remember the previous value across renders.
  const _prevEmissionsModeAppRef = useRef(emissionsMode);
  useEffect(() => {
    const prev = _prevEmissionsModeAppRef.current;
    _prevEmissionsModeAppRef.current = emissionsMode;
    if (prev === emissionsMode) return;
    if (!prev && emissionsMode) {
      _triggerEmissionsStaging();
    } else if (prev && !emissionsMode) {
      _cancelEmissionsStaging();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emissionsMode]);
  // Cleanup any in-flight timer on unmount.
  useEffect(() => () => _clearEmStagingTimer(), []);

  // ── App-level mapping-table lookup + auto-fill. Runs whenever cycleResult,
  // emissionsMode, or the tables change — regardless of active tab. Pushes
  // the three circuit φ values into state so bkMap and Ops Summary always
  // see fresh values without having to visit the Mapping panel first.
  const _T3_F_app = cycleResult?.T3_K ? (cycleResult.T3_K - 273.15) * 9/5 + 32 : 0;
  const _brndmd_app = calcBRNDMD(cycleResult?.MW_net || 0, emissionsMode, brndmdOverride);
  const _tblKey_app = _brndmd_app >= 2 ? _brndmd_app : 2;
  const _tbl_app = mappingTables?.[_tblKey_app] || mappingTables?.[2];
  const _tblLookup_app = _tbl_app ? interpMappingTable(_tbl_app, _T3_F_app) : null;
  useEffect(() => {
    if(!_tblLookup_app) return;
    setMapPhiIP(_tblLookup_app.IP);
    setMapPhiOP(_tblLookup_app.OP);
    setMapPhiIM(_tblLookup_app.IM);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_tblLookup_app?.IP, _tblLookup_app?.OP, _tblLookup_app?.IM]);

  // ── Shared /calc/combustor_mapping — drives the Mapping panel AND the
  // Operations Summary emissions + dynamics display. State lifted above.
  const _oxHumid=cycleResult?.oxidizer_humid_mol_pct||null;
  const _m_air_post_bleed=cycleResult?.mdot_air_post_bleed_kg_s||cycleResult?.mdot_air_kg_s||0;
  const _m_fuel_total=cycleResult?.mdot_fuel_kg_s||0;
  const _comAirFrac=cycleResult?.combustor_air_frac||0.89;
  // Pick the BRNDMD-specific NOx / CO post-multipliers from the Emissions
  // Transfer Function table. Falls back to BRNDMD=2 when BRNDMD ≤ 1.
  const _noxMult  = emTfMults?.[_brndmd_app>=2?_brndmd_app:2]?.NOx  ?? 1.0;
  const _coMult   = emTfMults?.[_brndmd_app>=2?_brndmd_app:2]?.CO   ?? 1.0;
  const _px36Mult = emTfMults?.[_brndmd_app>=2?_brndmd_app:2]?.PX36 ?? 1.0;
  const bkMap=useBackendCalc(
    "combustor_mapping",
    {
      fuel:nonzero(fuel),
      oxidizer:_oxHumid?nonzero(_oxHumid):null,
      T3_K:cycleResult?.T3_K||300, P3_bar:cycleResult?.P3_bar||1,
      T_fuel_K:T_fuel,
      W3_kg_s:_m_air_post_bleed,
      W36_over_W3:Math.max(0.01,Math.min(1.0,mapW36w3)),
      com_air_frac:Math.max(0.01,Math.min(1.0,_comAirFrac)),
      frac_IP_pct:mapFracIP, frac_OP_pct:mapFracOP,
      frac_IM_pct:mapFracIM, frac_OM_pct:mapFracOM,
      phi_IP:Math.max(0,mapPhiIP), phi_OP:Math.max(0,mapPhiOP), phi_IM:Math.max(0,mapPhiIM),
      m_fuel_total_kg_s:_m_fuel_total,
      WFR, water_mode:waterMode,
      nox_mult:_noxMult, co_mult:_coMult, px36_mult:_px36Mult,
    },
    // Mapping endpoint is only ever rendered in gts / advanced. Don't fire
    // it in Free / Combustion Toolkit — those modes have no Mapping panel,
    // so a "Computing combustor mapping correlations…" line in the global
    // busy banner there would be a lie.
    !!(accurate && _oxHumid && _m_air_post_bleed > 0 && _m_fuel_total > 0
       && (mode==="gts"||mode==="advanced"))
  );

  // panelState is built AFTER cycleResult to avoid temporal-dead-zone reference.
  // Consumed by exportToExcel button further below; safe to declare here.
  const panelState={velocity,Lchar,Dfh,Lpremix,Vpremix,tau_psr,L_pfr,V_pfr,T_fuel,T_air:T0,measO2,measCO2,combMode,psrSeed,eqConstraint,integration,heatLossFrac,mechanism,WFR,waterMode,T_water,accurate:accurate&&!!auth.hasOnlineAccess,
    // Cantera flame results lifted from FlameSpeedPanel — the export now
    // publishes real 1D-FreeFlame numbers when these are present.
    flameBk,flameBkIgn,flameCanteraSweeps,
    // ── Exhaust slip measurements + fuel/money (used by ExhaustPanel η_c block) ──
    measCO,measUHC,measH2,fuelFlowKgs,fuelCostUsdPerMmbtuLhv,costPeriod,
    cycleEngine,cyclePamb,cycleTamb,cycleRH,cycleLoad,cycleTcool,cycleAirFrac,cycleResult,
    bleedMode,bleedOpenPct,bleedValveSizePct,bleedAirFrac,mappingTables,
    // ── Combustor-Mapping inputs (4-circuit DLE — LMS100 only) ──
    emissionsMode,
    mapW36w3,mapFracIP,mapFracOP,mapFracIM,mapFracOM,mapPhiIP,mapPhiOP,mapPhiIM,
    mapResult:bkMap?.data||null,
    emTfMults,
    // ── Linkage toggles (Cycle → sidebar) ──
    linkT3,linkP3,linkFAR,linkFuelFlow,
    // ── Exhaust CO/UHC linkages (Mapping CO15 → measured CO/UHC) ──
    linkExhaustCO,linkExhaustUHC,
    // ── UI sidebar controls ──
    loadStepPct,bleedStepPct,
    // ── Active Application Mode (free / ctk / gts / advanced) ──
    // Used by exportToExcel to gate which sheets land in the workbook so
    // the export only contains tabs relevant to the user's current mode.
    appMode:mode};

  // Propagate cycle outputs into main sidebar state when linkages are ON.
  // Re-runs whenever the cycle result changes or a toggle flips.
  useEffect(()=>{
    if(!cycleResult)return;
    if(linkT3)setT0(cycleResult.T3_K);
    if(linkP3)setP(cycleResult.P3_bar/1.01325);   // bar → atm (sidebar P is atm in SI)
    // Sidebar φ ← cycle φ_Bulk (flame-zone φ, = φ₄/combustor_air_frac). Fall
    // back to phi4 or legacy phi for older backends that haven't deployed yet.
    if(linkFAR)setPhiClamped(cycleResult.phi_Bulk??cycleResult.phi4??cycleResult.phi);
    // Exhaust panel Fuel Flow ← cycle ṁ_fuel (kg/s). Guarded against NaN
    // and 0 so a degenerate cycle (e.g. unit-test seed) doesn't wipe the
    // user's existing fuelFlowKgs.
    if(linkFuelFlow && Number.isFinite(cycleResult.mdot_fuel_kg_s) && cycleResult.mdot_fuel_kg_s > 0){
      setFuelFlowKgs(cycleResult.mdot_fuel_kg_s);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[cycleResult,linkT3,linkP3,linkFAR,linkFuelFlow]);

  // Oxidizer linkage — propagate the cycle's humid-air composition (at ambient
  // T/RH) into the sidebar Oxidizer state. Required so T_ad on Flame Temp uses
  // the exact same oxidizer as the cycle's T4 back-solve. Backend returns keys
  // in GRI-Mech-style casing (O2, N2, AR, CO2, H2O) — normalize AR → Ar.
  useEffect(()=>{
    if(!cycleResult||!linkOx)return;
    const src=cycleResult.oxidizer_humid_mol_pct;
    if(!src||typeof src!=="object")return;
    const next={};OX_SP.forEach(s=>next[s]=0);
    Object.entries(src).forEach(([k,v])=>{
      const K=k==="AR"?"Ar":k;
      if(K in next)next[K]=Number(v)||0;
    });
    setOx(next);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[cycleResult,linkOx]);

  // NB: BusyProvider is hoisted to main.jsx so it wraps the entire App tree,
  // including the App-body bkCycle useBackendCalc call above. Wrapping
  // BusyProvider inside App would leave bkCycle with the default no-op
  // begin() and the top overlay would silently miss all cycle-only updates.
  return(
    <UnitCtx.Provider value={units}>
    <AccurateCtx.Provider value={{accurate:accurate&&hasOnline,setAccurate,available:hasOnline}}>
      <div key={themeRev} style={{fontFamily:"'Barlow','Segoe UI',sans-serif",background:C.bg,color:C.txt,minHeight:"100vh",display:"flex",flexDirection:"column"}}>
        <link href="https://fonts.googleapis.com/css2?family=Barlow:wght@300;400;500;600;700;800&family=Barlow+Condensed:wght@400;600;700&display=swap" rel="stylesheet"/>
        <HelpModal show={showHelp} onClose={()=>setShowHelp(false)}/>
        <PricingModal show={showPricing} onClose={()=>setShowPricing(false)} onRequestSignin={(m)=>setAuthModal(m||"login")}/>
        <AuthModal show={!!authModal} mode={authModal||"login"} onClose={()=>setAuthModal(null)} onModeChange={(m)=>setAuthModal(m)} C={C}/>

        {/* HEADER */}
        <div style={{padding:"12px 20px",borderBottom:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between",alignItems:"center",background:`linear-gradient(180deg,${C.bg3},${C.bg})`}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <Logo size={32}/>
            <div><div style={{fontSize:17,fontWeight:700,letterSpacing:"-.3px",color:C.txt,fontFamily:"'Barlow Condensed',sans-serif"}}><span style={{color:C.accent}}>Pro</span><span style={{color:C.accent2}}>Ready</span><span>Engineer</span></div>
              <div style={{fontSize:8.5,color:C.txtMuted,fontFamily:"monospace",letterSpacing:"2px",textTransform:"uppercase"}}>Combustion Engineering Toolkit — Thermal Fluid Sciences & AI</div></div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {/* Application Mode picker — replaces the legacy Accurate
                toggle. The four modes (Free / Combustion Toolkit / GTS /
                Advanced) gate which tabs render and route calcs through
                JS (Free) or Cantera (the rest). See APP_MODES + setMode. */}
            <AppModePicker
              mode={mode}
              hasOnline={hasOnline}
              onPick={setMode}
              onUnlock={() => setShowPricing(true)}
            />
            {/* Theme toggle — flips the active palette between dark and light.
                The palette swap is implemented as a Proxy + key-based remount
                (see DARK_C / LIGHT_C / setActiveTheme above). All inline-
                style sites that reference C.* automatically pick up the new
                palette on the next render. */}
            <button onClick={()=>{
              const next = theme === "light" ? "dark" : "light";
              // Mutate the active palette synchronously BEFORE the React
              // re-render so the very first render after the click already
              // sees the new colors (no flash of the previous theme).
              setActiveTheme(next);
              setTheme(next);
            }}
              title={theme==="light" ? "Switch to dark theme" : "Switch to light theme"}
              style={{padding:"6px 10px",fontSize:11,fontWeight:700,
                color:C.txtDim, background:"transparent",
                border:`1px solid ${C.border}`, borderRadius:6, cursor:"pointer",
                fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:".5px",
                display:"flex", alignItems:"center", gap:5}}>
              <span style={{fontSize:13}}>{theme==="light" ? "☀" : "☾"}</span>
              {theme==="light" ? "LIGHT" : "DARK"}
            </button>
            {/* Cache clear — wipes in-memory + persisted backend response cache.
                Use after a backend deploy that changed correlation internals
                without bumping the frontend build SHA, or anytime you want
                the next call to be a fresh fetch. */}
            <button onClick={()=>{
              bkClearCache();
              setCacheCleared(true);
              setTimeout(()=>setCacheCleared(false), 1800);
            }}
              title="Clear the backend response cache. Next /calc/* call will fetch fresh."
              style={{padding:"6px 10px",fontSize:11,fontWeight:700,
                color:cacheCleared?C.bg:C.txtDim,
                background:cacheCleared?C.good:"transparent",
                border:`1px solid ${cacheCleared?C.good:C.border}`,
                borderRadius:6,cursor:"pointer",
                fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".5px",
                display:"flex",alignItems:"center",gap:5,
                transition:"all .15s"}}>
              {cacheCleared?"✓ CLEARED":"⟲ CLEAR CACHE"}
            </button>
            {auth.isAuthenticated?(
              <button onClick={()=>setTab("account")} title="Account & Billing" style={{padding:"6px 10px",fontSize:11,fontWeight:700,color:C.accent,background:`${C.accent}15`,border:`1px solid ${C.accent}40`,borderRadius:6,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".4px",display:"flex",alignItems:"center",gap:6,maxWidth:220,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                <span style={{width:18,height:18,borderRadius:"50%",background:C.accent,color:C.bg,display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:800}}>{(auth.user?.email||"?").charAt(0).toUpperCase()}</span>
                <span style={{overflow:"hidden",textOverflow:"ellipsis"}}>{auth.user?.email}</span>
              </button>
            ):(
              <button onClick={()=>setAuthModal("login")} title="Sign In" style={{padding:"6px 12px",fontSize:11,fontWeight:700,color:C.accent,background:"transparent",border:`1px solid ${C.accent}`,borderRadius:6,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".5px"}}>SIGN IN</button>
            )}
            <button onClick={()=>setShowPricing(true)} title="Pricing — Accurate Cantera versions" style={{padding:"6px 12px",fontSize:11,fontWeight:700,color:C.bg,background:C.accent2,border:"none",borderRadius:6,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".5px"}}>PRICING</button>
            <button onClick={()=>setShowHelp(true)} title="User Guide & Help" style={{padding:"6px 10px",fontSize:13,fontWeight:700,color:C.accent,background:`${C.accent}15`,border:`1px solid ${C.accent}30`,borderRadius:6,cursor:"pointer",fontFamily:"monospace"}}>?</button>
            {/* Units selector — a single labeled dropdown ("UNITS · English ▾")
                replaces the old two-button segmented control. English is
                the default (set in the App-level useState above). */}
            <label title="Switch between English (Imperial) and SI (Metric) units across every panel" style={{display:"flex",alignItems:"stretch",border:`1px solid ${C.border}`,borderRadius:6,overflow:"hidden",background:C.bg2,cursor:"pointer"}}>
              <span style={{padding:"6px 10px",fontSize:11,fontWeight:700,color:C.txtDim,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".5px",display:"flex",alignItems:"center"}}>UNITS</span>
              <select value={units} onChange={e=>setUnits(e.target.value)}
                style={{padding:"6px 10px",fontSize:11,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",color:C.bg,background:C.accent,border:"none",borderLeft:`1px solid ${C.border}`,cursor:"pointer",letterSpacing:".5px",outline:"none"}}>
                <option value="ENG">English (Imperial)</option>
                <option value="SI">SI (Metric)</option>
              </select>
            </label>
            <BusyGuardedExportButton onExport={()=>exportToExcel(fuel,ox,phi,T0,P,units,panelState)}/>
          </div></div>

        {/* TABS */}
        <div style={{display:"flex",gap:1,padding:"0 20px",background:C.bg,borderBottom:`1px solid ${C.border}`,overflowX:"auto"}}>
          {TABS.map(t=><button key={t.id} onClick={()=>setTab(t.id)} style={{padding:"9px 14px",fontSize:11,fontWeight:tab===t.id?600:400,color:tab===t.id?C.accent:C.txtMuted,background:tab===t.id?`${C.accent}0A`:"transparent",border:"none",borderBottom:tab===t.id?`2px solid ${C.accent}`:"2px solid transparent",cursor:"pointer",whiteSpace:"nowrap",fontFamily:"'Barlow',sans-serif",letterSpacing:".4px",transition:"all .15s"}}><span style={{marginRight:4}}>{t.icon}</span>{t.label}</button>)}</div>

        {/* MODE BANNER — colour-coded strip describing the active
            Application Mode. Free shows a "view pricing" CTA; the three
            subscription modes show informational copy only.
            Hidden on the Account tab so the billing UI isn't crowded. */}
        {tab!=="account" && (() => {
          const m = _modeById(mode);
          const tone = C[m.accent];
          return (
            <div style={{padding:"10px 20px",
              background:`${tone}12`,
              borderBottom:`1px solid ${tone}35`,
              display:"flex",alignItems:"center",justifyContent:"space-between",
              gap:14,flexWrap:"wrap"}}>
              <div style={{fontSize:11.5,color:C.txt,
                fontFamily:"'Barlow',sans-serif",lineHeight:1.55,
                flex:"1 1 320px"}}>
                <strong style={{color:tone,letterSpacing:".5px",
                  fontFamily:"'Barlow Condensed',sans-serif"}}>
                  {m.bannerStrong}
                </strong>
                {" — "}
                <span style={{color:C.txtDim}}>{m.bannerBody}</span>
              </div>
              {mode === "free" && (
                <button onClick={()=>setShowPricing(true)}
                  style={{padding:"7px 16px",fontSize:11,fontWeight:700,
                    fontFamily:"'Barlow Condensed',sans-serif",
                    color:C.bg,background:C.accent,border:"none",
                    borderRadius:6,cursor:"pointer",letterSpacing:".7px",
                    whiteSpace:"nowrap"}}>
                  VIEW PRICING →
                </button>
              )}
            </div>
          );
        })()}

        <div style={{display:"flex",flex:"1 1 auto",minHeight:0}}>
          {/* SIDEBAR (hidden on Account tab) */}
          {tab!=="account"&&<div style={{width:255,flexShrink:0,borderRight:`1px solid ${C.border}`,padding:"12px 10px",overflowY:"auto",background:`${C.bg}CC`}}>
            {/* ── SIDEBAR INPUT ORDER ─────────────────────────────────
                  Free / Combustion Toolkit (no cycle, no mapping):
                    1. Operating Conditions
                    2. Oxidizer composition
                    3. Fuel composition
                    4. Water / Steam Injection
                  Gas Turbine Simulator / Advanced (cycle + mapping):
                    1. Engine & Ambient (Engine, Emissions Mode, Load,
                       Ambient Conditions, Comb. Air Frac)
                    2. Fuel composition
                    3. Water / Steam Injection
                    4. Operating Conditions
                    5. Oxidizer composition
                    6. Compressor Bleed
                    7. Emissions Transfer Function

                Each card is built once as a JSX const inside the IIFE
                below, then placed in the per-mode order. Avoids duplicating
                the ~150-line Operating Conditions / Water JSX. */}
            {(() => {
              const isGtsOrAdv = mode === "gts" || mode === "advanced";

              const engineAmbientTop = isGtsOrAdv ? (
                <EngineAmbientSidebar
                  section="top"
                  engine={cycleEngine} setEngine={setCycleEngine}
                  Pamb={cyclePamb} setPamb={setCyclePamb}
                  Tamb={cycleTamb} setTamb={setCycleTamb}
                  RH={cycleRH} setRH={setCycleRH}
                  loadPct={cycleLoad} setLoadPct={setCycleLoad}
                  Tcool={cycleTcool} setTcool={setCycleTcool}
                  airFrac={cycleAirFrac} setAirFrac={setCycleAirFrac}
                  loadStepPct={loadStepPct} setLoadStepPct={setLoadStepPct}
                  emissionsMode={emissionsMode} setEmissionsMode={setEmissionsMode}
                  // Bleed props — bleed UI now renders inline inside the top
                  // card, between Load and Ambient Conditions. The standalone
                  // bleedCard below is now a no-op (returns null).
                  bleedMode={bleedMode} setBleedMode={setBleedMode}
                  bleedOpenPct={bleedOpenPct}
                  bleedOpenManualPct={bleedOpenManualPct} setBleedOpenManualPct={setBleedOpenManualPct}
                  bleedValveSizePct={bleedValveSizePct} setBleedValveSizePct={setBleedValveSizePct}
                  bleedStepPct={bleedStepPct} setBleedStepPct={setBleedStepPct}
                  bleedAirFrac={bleedAirFrac}
                  accurate={accurate&&hasOnline}
                />
              ) : null;

              const bleedCard = isGtsOrAdv ? (
                <EngineAmbientSidebar
                  section="bleed"
                  bleedMode={bleedMode} setBleedMode={setBleedMode}
                  bleedOpenPct={bleedOpenPct}
                  bleedOpenManualPct={bleedOpenManualPct} setBleedOpenManualPct={setBleedOpenManualPct}
                  bleedValveSizePct={bleedValveSizePct} setBleedValveSizePct={setBleedValveSizePct}
                  bleedStepPct={bleedStepPct} setBleedStepPct={setBleedStepPct}
                  bleedAirFrac={bleedAirFrac}
                  accurate={accurate&&hasOnline}
                />
              ) : null;

              const opCondCard = (
            <div data-card="operating-conditions">
            {/* ── Operating Conditions ───────────────────────────── */}
            <div style={{background:C.bg2,border:`1px solid ${C.accent}25`,borderRadius:8,padding:12,marginBottom:10}}>
              <div style={{fontSize:10,fontWeight:700,color:C.accent,textTransform:"uppercase",letterSpacing:"1.5px",marginBottom:8}}>Operating Conditions</div>
              {/* Field order per Application Mode spec:
                    Air Temp → Pressure → TFlame_CC → phi → FAR → Fuel Temp */}
              {/* ── Air Temp ─────────────────────────────────────────── */}
              <div style={{marginBottom:10}}>
                <label style={{fontSize:10.5,color:C.txtMuted,fontFamily:"monospace",display:"block",marginBottom:3}} title="Air / oxidizer inlet temperature. On the Combustor tab, Cantera mixes this with Fuel Temp adiabatically (mass-weighted enthalpy balance with T-dependent NASA polynomials) to get the actual PSR inlet T.">Air Temp ({uu(units,"T")})</label>
                <NumField value={uv(units,"T",T0)} decimals={2} onCommit={v=>setT0(uvI(units,"T",v))} style={{...S.inp,borderColor:`${C.accent3}55`}}/>
                <input type="range" min={units==="SI"?250:0} max={units==="SI"?900:1160} step={5} value={+uv(units,"T",T0).toFixed(2)} onChange={e=>setT0(uvI(units,"T",+e.target.value))} style={{width:"100%",accentColor:C.accent3,marginTop:4}}/>
                {accurate&&hasOnline&&linkT3&&<LinkChip onBreak={_linkBreakable?()=>setLinkT3(false):null} label="Linked to Cycle T3"/>}
              </div>
              {/* ── Pressure ─────────────────────────────────────────── */}
              <div style={{marginBottom:10}}>
                <label style={{fontSize:10.5,color:C.txtMuted,fontFamily:"monospace",display:"block",marginBottom:3}}>Pressure ({uu(units,"P")})</label>
                <NumField value={uv(units,"P",P)} decimals={1} onCommit={v=>setP(uvI(units,"P",v))} style={S.inp}/>
                {accurate&&hasOnline&&linkP3&&<LinkChip onBreak={_linkBreakable?()=>setLinkP3(false):null} label="Linked to Cycle P3"/>}
              </div>
              {/* ── Tflame (adiabatic, complete combustion) — third equivalent
                   way to express the operating point. φ, FAR, and T_flame are
                   all interdependent: setting any one determines the other
                   two given the fuel + ox composition and inlet temps. ── */}
              {(() => {
                // Canonical T_flame source: Cantera in accurate mode (matches
                // the Combustor PSR-PFR panel exactly), JS calcAFT otherwise.
                const tflame_K = T_flame_canonical;
                const tflame_disp = Number.isFinite(tflame_K)
                  ? +uv(units, "T", tflame_K).toFixed(2) : NaN;
                const fromBackend = accurate && bkSidebarTflame.data?.T_ad_complete > 0;
                const onTflameCommit = async (v) => {
                  const T_target_K = uvI(units, "T", +v);
                  if (!Number.isFinite(T_target_K) || T_target_K <= 0) return;
                  if (accurate){
                    try {
                      const r = await bkCachedFetch("solve_phi_tflame", {
                        fuel: nonzero(fuel), oxidizer: nonzero(ox),
                        T_flame_target_K: T_target_K,
                        T_fuel_K: T_fuel, T_air_K: T0, P_bar: atmToBar(P),
                        WFR, water_mode: waterMode,
                      });
                      if (r && Number.isFinite(r.phi)) {
                        setPhiClamped(r.phi);
                        return;
                      }
                    } catch (_) { /* fall through to JS */ }
                  }
                  const phi_solved = solvePhiForTflame(fuel, ox, T_target_K, T_fuel, T0);
                  setPhiClamped(phi_solved);
                };
                return (
                  <div style={{marginBottom:10}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                      <label style={{fontSize:10.5,color:C.txtMuted,fontFamily:"monospace"}}
                        title={fromBackend
                          ? "Adiabatic flame temperature, complete combustion (no dissociation), at the 3-stream mixed inlet T. Source: Cantera /calc/aft → T_ad_complete (matches the value shown on the Combustor PSR-PFR panel). Editing this back-solves φ via JS bisection — typed value may differ ~10–20 °F from the redisplayed value due to the JS↔Cantera solver bias."
                          : "Adiabatic flame temperature, complete combustion (no dissociation), at the 3-stream mixed inlet T. Source: in-browser JS calcAFT. Setting this back-solves φ — pick the φ that produces this T_flame given the current fuel, oxidizer, T_fuel, and T_air. Lean solution only."}>
                        TFlame_CC ({uu(units,"T")}) {fromBackend?"":"(JS)"}
                      </label>
                      <NumField value={tflame_disp} decimals={0} onCommit={onTflameCommit}
                        title="Type a target T_flame; the lean φ that produces it is back-solved automatically."
                        style={{width:82,padding:"3px 6px",fontFamily:"monospace",color:C.warm,fontSize:13,fontWeight:700,background:C.bg,border:`1px solid ${C.warm}50`,borderRadius:4,textAlign:"center",outline:"none"}}/>
                    </div>
                    <input type="range"
                      min={units==="SI" ? 1500 : Math.round((1500-273.15)*9/5+32)}
                      max={units==="SI" ? 2400 : Math.round((2400-273.15)*9/5+32)}
                      step={units==="SI" ? 5 : 10}
                      value={Number.isFinite(tflame_disp) ? tflame_disp : 1900}
                      onChange={e => onTflameCommit(+e.target.value)}
                      style={{width:"100%",accentColor:C.warm}}/>
                    <div style={{textAlign:"center",fontSize:9.5,color:C.txtMuted,marginTop:-2}}>
                      Mutually dependent with φ and FAR — changing one updates the others.
                    </div>
                  </div>
                );
              })()}
              {/* ── phi ──────────────────────────────────────────────── */}
              <div style={{marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                  <label style={{fontSize:10.5,color:C.txtMuted,fontFamily:"monospace"}}>phi (φ)</label>
                  <NumField value={phi} decimals={3} onCommit={setPhiClamped} title="Type any φ ≥ 0 — rich mixtures (φ > 1) are supported by the Cantera path. Slider covers 0.0 – 3.0 for fast scrubbing; type a value to go higher."
                    style={{width:72,padding:"3px 6px",fontFamily:"monospace",color:C.accent,fontSize:13,fontWeight:700,background:C.bg,border:`1px solid ${C.accent}50`,borderRadius:4,textAlign:"center",outline:"none"}}/>
                </div>
                <input type="range" min="0" max="3.0" step="0.01" value={Math.min(3.0,phi)} onChange={e=>setPhiClamped(+e.target.value)} style={{width:"100%",accentColor:C.accent}}/>
                <div style={{textAlign:"center",fontSize:9.5,color:C.txtMuted,marginTop:-2}}>{phi<0.95?"lean":phi>1.05?"rich":"~stoichiometric"}</div>
                {accurate&&hasOnline&&linkFAR&&<LinkChip onBreak={_linkBreakable?()=>setLinkFAR(false):null} label="Linked to Cycle φ_Bulk"/>}
              </div>
              {/* ── FAR ──────────────────────────────────────────────── */}
              <div style={{marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                  <label style={{fontSize:10.5,color:C.txtMuted,fontFamily:"monospace"}} title="Fuel-Air Ratio by mass. Linked to φ via FAR = φ × FAR_stoich.">Fuel/Air Ratio (mass)</label>
                  <NumField value={FAR} decimals={4} onCommit={setFAR} title="Type any FAR within the allowed range; φ updates automatically."
                    style={{width:82,padding:"3px 6px",fontFamily:"monospace",color:C.accent2,fontSize:13,fontWeight:700,background:C.bg,border:`1px solid ${C.accent2}50`,borderRadius:4,textAlign:"center",outline:"none"}}/>
                </div>
                <input type="range" min={0} max={3*FAR_stoich} step={FAR_stoich/1000} value={Math.min(3*FAR_stoich,FAR)} onChange={e=>setFAR(+e.target.value)} style={{width:"100%",accentColor:C.accent2}}/>
                <div style={{textAlign:"center",fontSize:9.5,color:C.txtMuted,marginTop:-2}}>Stoichiometric FAR = {FAR_stoich.toFixed(4)} (kg fuel / kg air)</div>
              </div>
              {/* ── Fuel Temp (last in Operating Conditions) ─────────── */}
              <div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                  <label style={{fontSize:10.5,color:C.txtMuted,fontFamily:"monospace"}} title="Fuel inlet temperature (before adiabatic mixing with air). Independent from Air Temp. Typical values: 290 K (cold fuel line) to 550 K (preheated).">Fuel Temp ({uu(units,"T")})</label>
                  <button onClick={()=>setTfuel(T0)} title="Copy current Air Temp into Fuel Temp (sets the two streams equal, so adiabatic mixing degenerates to the single-inlet case)." style={{padding:"1px 8px",fontSize:9,fontWeight:700,color:C.orange,background:"transparent",border:`1px solid ${C.orange}50`,borderRadius:3,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".4px"}}>copy Air Temp</button>
                </div>
                <NumField value={uv(units,"T",T_fuel)} decimals={2} onCommit={v=>setTfuel(uvI(units,"T",v))} style={{...S.inp,borderColor:`${C.orange}55`}}/>
                <input type="range" min={units==="SI"?250:0} max={units==="SI"?900:1160} step={5} value={+uv(units,"T",T_fuel).toFixed(2)} onChange={e=>setTfuel(uvI(units,"T",+e.target.value))} style={{width:"100%",accentColor:C.orange,marginTop:4}}/>
              </div>
            </div>
            </div>
              );

              const oxCard = (
            <div>
              <CompEditor title="Oxidizer (mol%)" comp={ox} setComp={setOx} presets={OX_PRESETS} speciesList={OX_SP} accent={C.accent3} initialPreset="Humid Air (60%RH 25°C)"
                helpText="Enter oxidizer composition in mole percent. 'Dry Air' is the standard. Use humid air, O₂-enriched, or vitiated air for specialized analyses."/>
              {accurate&&hasOnline&&linkOx&&<div style={{marginTop:-2,marginBottom:8}}><LinkChip onBreak={_linkBreakable?()=>setLinkOx(false):null} label="Linked to Cycle humid air"/></div>}
            </div>
              );

              const fuelCard = (
            <CompEditor title="Fuel (mol%)" comp={fuel} setComp={setFuel} presets={FUEL_PRESETS} speciesList={FUEL_SP} accent={C.accent2} initialPreset="Pipeline NG (US)"
              helpText="Enter fuel composition in mole percent. Select a preset for common fuels or enter custom values. Total must sum to 100%. CO₂ and N₂ in fuel are treated as diluents."/>
              );

              const waterCard = (
            <div style={{background:C.bg2,border:`1px solid ${C.accent3}25`,borderRadius:8,padding:12,marginTop:10,marginBottom:10}}>
              <div style={{fontSize:10,fontWeight:700,color:C.accent3,textTransform:"uppercase",letterSpacing:"1.5px",marginBottom:6}}>Water / Steam Injection</div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                <label style={{fontSize:10.5,color:C.txtMuted,fontFamily:"monospace"}} title="Water-to-Fuel mass Ratio (WFR). Water / steam injection is the classic NOx-knockdown lever: liquid water absorbs the latent heat of vaporization on the way to flame temperature, dropping T_ad by 100–300 K and cutting thermal NOx exponentially via Zeldovich. Steam gives dilution-only cooling (smaller T drop). Typical gas-turbine DLE WFR: 0.5–1.0.">Water/Fuel Ratio (WFR) ⓘ</label>
                <NumField value={WFR} decimals={2} onCommit={v=>setWFR(Math.max(0,Math.min(2,+v)))} style={{width:60,padding:"3px 6px",fontFamily:"monospace",color:C.accent3,fontSize:12,fontWeight:700,background:C.bg,border:`1px solid ${C.accent3}50`,borderRadius:4,textAlign:"center",outline:"none"}}/>
              </div>
              <input type="range" min="0" max="2" step="0.05" value={WFR} onChange={e=>setWFR(+e.target.value)} style={{width:"100%",accentColor:C.accent3}}/>
              <div style={{textAlign:"center",fontSize:9.5,color:C.txtMuted,marginTop:-2}}>{WFR===0?"dry (no water)":WFR<0.3?"trace":WFR<0.8?"moderate":WFR<1.3?"typical DLE":"heavy"}</div>
              <div style={{display:"flex",gap:6,marginTop:6,fontSize:10,fontFamily:"monospace"}}>
                <label style={{display:"flex",alignItems:"center",gap:4,cursor:"pointer",flex:1,padding:"4px 6px",border:`1px solid ${waterMode==="liquid"?C.accent3:C.border}`,borderRadius:4,background:waterMode==="liquid"?`${C.accent3}18`:"transparent"}}>
                  <input type="radio" name="waterMode" value="liquid" checked={waterMode==="liquid"} onChange={()=>{setWaterMode("liquid");setTwater(288.15);}} style={{accentColor:C.accent3}}/>
                  <span title="Liquid water (user-specified inlet T below). Absorbs latent heat h_fg ≈ 2.45 MJ/kg on vaporization; biggest flame-T drop per unit WFR.">Liquid</span>
                </label>
                <label style={{display:"flex",alignItems:"center",gap:4,cursor:"pointer",flex:1,padding:"4px 6px",border:`1px solid ${waterMode==="steam"?C.accent3:C.border}`,borderRadius:4,background:waterMode==="steam"?`${C.accent3}18`:"transparent"}}>
                  <input type="radio" name="waterMode" value="steam" checked={waterMode==="steam"} onChange={()=>{setWaterMode("steam");setTwater(450);}} style={{accentColor:C.accent3}}/>
                  <span title="Steam at user-specified inlet T (default 450 K ≈ saturated mid-pressure). Dilution-only cooling (no latent heat).">Steam</span>
                </label>
              </div>
              <div style={{marginTop:8,paddingTop:6,borderTop:`1px solid ${C.border}`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                  <label style={{fontSize:10.5,color:C.txtMuted,fontFamily:"monospace"}} title="Water/steam inlet temperature — independent from fuel T. Liquid defaults to 288 K (15 °C city water). Steam defaults to 450 K (~saturated at 10 bar). Overridable for chilled water, superheated steam, or HRSG tie-ins.">Water Inlet T ({uu(units,"T")}) ⓘ</label>
                  <NumField value={uv(units,"T",T_water)} decimals={1} onCommit={v=>setTwater(Math.max(250,Math.min(900,uvI(units,"T",+v))))} disabled={WFR===0} style={{width:64,padding:"3px 6px",fontFamily:"monospace",color:WFR===0?C.txtMuted:C.accent3,fontSize:12,fontWeight:700,background:C.bg,border:`1px solid ${WFR===0?C.border:C.accent3}50`,borderRadius:4,textAlign:"center",outline:"none"}}/>
                </div>
                <div style={{display:"flex",gap:3,marginTop:2,flexWrap:"wrap"}}>
                  {(waterMode==="liquid"?[{k:278.15,l:"5°C"},{k:288.15,l:"15°C"},{k:303.15,l:"30°C"}]:[{k:373.15,l:"sat 1bar"},{k:450,l:"sat ~10bar"},{k:550,l:"superhtd"}]).map(o=>(
                    <button key={o.k} disabled={WFR===0} onClick={()=>setTwater(o.k)}
                      title={`${o.l} = ${o.k} K`}
                      style={{padding:"2px 6px",fontSize:9,fontWeight:600,fontFamily:"monospace",
                        color:Math.abs(T_water-o.k)<1?C.bg:C.txtDim,
                        background:Math.abs(T_water-o.k)<1?C.accent3:"transparent",
                        border:`1px solid ${C.border}`,borderRadius:3,cursor:WFR===0?"default":"pointer",opacity:WFR===0?0.4:1}}>{o.l}</button>
                  ))}
                </div>
              </div>
            </div>
              );

              const etfCard = isGtsOrAdv ? (
                <div style={{background:C.bg2,border:`1px solid ${C.violet}30`,borderRadius:8,padding:12,marginTop:10}}>
                  <div style={{fontSize:10,fontWeight:700,color:C.violet,textTransform:"uppercase",letterSpacing:"1.5px",marginBottom:8}}>Emissions Transfer Function</div>
                  <div style={{display:"grid",gridTemplateColumns:"50px 1fr 1fr 1fr",gap:4,alignItems:"center",fontSize:10,fontFamily:"monospace"}}>
                    <div></div>
                    <div style={{color:C.strong,textAlign:"center",fontWeight:700,fontSize:9.5,textTransform:"uppercase",letterSpacing:".3px"}}>NOx ×</div>
                    <div style={{color:C.orange,textAlign:"center",fontWeight:700,fontSize:9.5,textTransform:"uppercase",letterSpacing:".3px"}}>CO ×</div>
                    <div style={{color:C.warm,textAlign:"center",fontWeight:700,fontSize:9.5,textTransform:"uppercase",letterSpacing:".3px"}}>PX36 ×</div>
                    {[7,6,4,2].map(k=>(
                      <Fragment key={k}>
                        <div style={{color:C.violet,fontWeight:700,fontSize:10}}>BR={k}</div>
                        <NumField value={emTfMults?.[k]?.NOx??1.0} decimals={2}
                          onCommit={v=>setEmTfMults(prev=>({...prev,[k]:{...(prev?.[k]||{}),NOx:Math.max(0,+v)}}))}
                          style={{width:"100%",padding:"3px 4px",fontSize:11,fontFamily:"monospace",color:C.strong,fontWeight:600,background:C.bg,border:`1px solid ${C.strong}40`,borderRadius:3,textAlign:"center",outline:"none"}}/>
                        <NumField value={emTfMults?.[k]?.CO??1.0} decimals={2}
                          onCommit={v=>setEmTfMults(prev=>({...prev,[k]:{...(prev?.[k]||{}),CO:Math.max(0,+v)}}))}
                          style={{width:"100%",padding:"3px 4px",fontSize:11,fontFamily:"monospace",color:C.orange,fontWeight:600,background:C.bg,border:`1px solid ${C.orange}40`,borderRadius:3,textAlign:"center",outline:"none"}}/>
                        <NumField value={emTfMults?.[k]?.PX36??1.0} decimals={2}
                          onCommit={v=>setEmTfMults(prev=>({...prev,[k]:{...(prev?.[k]||{}),PX36:Math.max(0,+v)}}))}
                          style={{width:"100%",padding:"3px 4px",fontSize:11,fontFamily:"monospace",color:C.warm,fontWeight:600,background:C.bg,border:`1px solid ${C.warm}40`,borderRadius:3,textAlign:"center",outline:"none"}}/>
                      </Fragment>
                    ))}
                  </div>
                  <div style={{fontSize:9,color:C.txtMuted,fontFamily:"monospace",fontStyle:"italic",marginTop:6,lineHeight:1.3}}>
                    Multipliers applied to NOx15 / CO15 / PX36_SEL correlation output based on current BRNDMD. Persists across reloads.
                  </div>
                </div>
              ) : null;

              // Per-mode render order (see header comment for the spec).
              if (isGtsOrAdv) {
                return (<>
                  {engineAmbientTop}
                  {fuelCard}
                  {waterCard}
                  {opCondCard}
                  {oxCard}
                  {bleedCard}
                  {etfCard}
                </>);
              }
              return (<>
                {opCondCard}
                {oxCard}
                {fuelCard}
                {waterCard}
              </>);
            })()}
          </div>}

          {/* CONTENT */}
          <div style={{flex:1,padding:"12px 16px",overflowY:"auto",minWidth:0}}>
            {tab==="mapping"&&<CombustorMappingPanel
              fuel={fuel} Tfuel={T_fuel}
              WFR={WFR} waterMode={waterMode} T_water={T_water}
              cycleResult={cycleResult} bkCycle={bkCycle}
              bkMap={bkMap}
              exhaustPenalty={exhaustPenalty}
              emStagingBanner={emStagingBanner}
              cancelEmissionsStaging={_cancelEmissionsStaging}
              w36w3={mapW36w3} setW36w3={setMapW36w3}
              fracIP={mapFracIP} setFracIP={setMapFracIP}
              fracOP={mapFracOP} setFracOP={setMapFracOP}
              fracIM={mapFracIM} setFracIM={setMapFracIM}
              fracOM={mapFracOM} setFracOM={setMapFracOM}
              phiIP={mapPhiIP} setPhiIP={setMapPhiIP}
              phiOP={mapPhiOP} setPhiOP={setMapPhiOP}
              phiIM={mapPhiIM} setPhiIM={setMapPhiIM}
              mappingTables={mappingTables} setMappingTables={setMappingTables}
              emissionsMode={emissionsMode} setEmissionsMode={setEmissionsMode}
              brndmdOverride={brndmdOverride} setBrndmdOverride={setBrndmdOverride}
            />}
            {tab==="summary"&&<OperationsSummaryPanel
              fuel={fuel} ox={ox} Tfuel={T_fuel}
              WFR={WFR} waterMode={waterMode} T_water={T_water}
              tau_psr={tau_psr} L_pfr={L_pfr} V_pfr={V_pfr}
              heatLossFrac={heatLossFrac} psrSeed={psrSeed}
              eqConstraint={eqConstraint} integration={integration} mechanism={mechanism}
              cycleResult={cycleResult} bleedAirFrac={bleedAirFrac} bkCycle={bkCycle}
              bkMap={bkMap}
              bleedMode={bleedMode} bleedOpenPct={bleedOpenPct}
              bleedOpenManualPct={bleedOpenManualPct} bleedValveSizePct={bleedValveSizePct}
              cycleEngine={cycleEngine} cyclePamb={cyclePamb} cycleTamb={cycleTamb}
              cycleRH={cycleRH} cycleLoad={cycleLoad} cycleTcool={cycleTcool}
              cycleAirFrac={cycleAirFrac}
              emissionsMode={emissionsMode}
              brndmdOverride={brndmdOverride}
              // Mapping panel state — enables per-load NOx15/CO15/BRNDMD in the load sweep
              mapW36w3={mapW36w3} mapFracIP={mapFracIP} mapFracOP={mapFracOP}
              mapFracIM={mapFracIM} mapFracOM={mapFracOM}
              mappingTables={mappingTables} emTfMults={emTfMults}
            />}
            {tab==="cycle"&&<CyclePanel
              mode={mode}
              linkT3={linkT3} setLinkT3={setLinkT3}
              linkP3={linkP3} setLinkP3={setLinkP3}
              linkFAR={linkFAR} setLinkFAR={setLinkFAR}
              linkOx={linkOx} setLinkOx={setLinkOx}
              result={cycleResult} loading={bkCycle.loading} err={bkCycle.err}
            />}
            {tab==="aft"&&<AFTPanel fuel={fuel} ox={ox} phi={phi} T0={T0} P={P} Tfuel={T_fuel} WFR={WFR} waterMode={waterMode} combMode={combMode} setCombMode={setCombMode} T4_K={cycleResult?.T4_K}/>}
            {tab==="flame"&&<FlameSpeedPanel fuel={fuel} ox={ox} phi={phi} T0={T0} P={P} Tfuel={T_fuel} WFR={WFR} waterMode={waterMode} velocity={velocity} setVelocity={setVelocity} Lchar={Lchar} setLchar={setLchar} Dfh={Dfh} setDfh={setDfh} Lpremix={Lpremix} setLpremix={setLpremix} Vpremix={Vpremix} setVpremix={setVpremix}
              cycleResult={cycleResult}
              flameActive={flameActive} setFlameActive={setFlameActive}
              keepActivated={keepFlameActivated} setKeepActivated={setKeepFlameActivated}
              onBkUpdate={setFlameBk} onBkIgnUpdate={setFlameBkIgn} onSweepsUpdate={setFlameCanteraSweeps}/>}
            {tab==="combustor"&&<CombustorPanel fuel={fuel} ox={ox} phi={phi} T0={T0} P={P} tau={tau_psr} setTau={setTauPsr} Lpfr={L_pfr} setL={setLpfr} Vpfr={V_pfr} setV={setVpfr} Tfuel={T_fuel} setTfuel={setTfuel} WFR={WFR} waterMode={waterMode} psrSeed={psrSeed} setPsrSeed={setPsrSeed} eqConstraint={eqConstraint} setEqConstraint={setEqConstraint} integration={integration} setIntegration={setIntegration} heatLossFrac={heatLossFrac} setHeatLossFrac={setHeatLossFrac} mechanism={mechanism} setMechanism={setMechanism}
              psrActive={psrActive} setPsrActive={setPsrActive}
              keepActivated={keepPsrActivated} setKeepActivated={setKeepPsrActivated}/>}
            {/* ExhaustPanel is always mounted (just hidden when not the
                active tab) so its slip-correction + η_c + Penalty
                calculations keep refreshing as upstream inputs change
                (Operating Conditions, Cycle outputs, Mapping φ_IP/OP/IM
                via bkMap.data.correlations.CO15). The lifted
                exhaustPenalty state — shown in the Mapping panel's
                System Metrics mini-table — would otherwise go stale
                whenever the user is on a different tab. Same pattern as
                AutomatePanel below. */}
            <div style={{display: tab==="exhaust" ? "block" : "none"}}>
              <ExhaustPanel fuel={fuel} ox={ox} T0={T0} P={P} Tfuel={T_fuel} WFR={WFR} waterMode={waterMode} measO2={measO2} setMeasO2={setMeasO2} measCO2={measCO2} setMeasCO2={setMeasCO2} measCO={measCO} setMeasCO={setMeasCO} measUHC={measUHC} setMeasUHC={setMeasUHC} measH2={measH2} setMeasH2={setMeasH2} fuelFlowKgs={fuelFlowKgs} setFuelFlowKgs={setFuelFlowKgs} fuelCostUsdPerMmbtuLhv={fuelCostUsdPerMmbtuLhv} setFuelCostUsdPerMmbtuLhv={setFuelCostUsdPerMmbtuLhv} costPeriod={costPeriod} setCostPeriod={setCostPeriod} linkFuelFlow={linkFuelFlow} setLinkFuelFlow={setLinkFuelFlow} linkBreakable={_linkBreakable} combMode={combMode} setCombMode={setCombMode}
                cycleResult={cycleResult} bkMap={bkMap}
                linkExhaustCO={linkExhaustCO} setLinkExhaustCO={setLinkExhaustCO}
                linkExhaustUHC={linkExhaustUHC} setLinkExhaustUHC={setLinkExhaustUHC}
                onPenaltyUpdate={setExhaustPenalty}/>
            </div>
            {/* AutomatePanel is always mounted (just hidden when not the
                active tab) so an in-progress run, captured results, the
                wizard state, and the Plot Data panel survive tab switches.
                Conditionally mounting would destroy all panel-internal
                state on every navigation. */}
            <div style={{display: tab==="automate" ? "block" : "none"}}>
              <AutomatePanel mode={mode} baseline={{
                // Snapshot every input the runner needs as a per-row baseline.
                // Anything the user doesn't vary stays at this value across rows.
                // Field names here MUST match the override() keys used in the
                // runner (App.jsx runAutomationMatrix inputs object).
                phi, T_air:T0, T_fuel, P, WFR, water_mode:waterMode,
                engine:cycleEngine, P_amb:cyclePamb, T_amb:cycleTamb, RH:cycleRH,
                load_pct:cycleLoad, T_cool:cycleTcool, com_air_frac:cycleAirFrac,
                bleed_open_pct:bleedOpenPct,
                bleed_valve_size_pct:bleedValveSizePct,
                emissionsMode,
                mapW36w3, mapPhiIP, mapPhiOP, mapPhiIM,
                mapFracIP, mapFracOP, mapFracIM, mapFracOM,
                tau_psr, L_pfr, V_pfr, heatLossFrac,
                velocity, Lchar, Dfh, Lpremix, Vpremix,
                measO2, measCO2, measCO, measUHC, measH2,
                fuelFlowKgs, fuelCostUsdPerMmbtuLhv, costPeriod,
                fuel, ox,
              }}/>
            </div>
            {tab==="nomenclature"&&<NomenclaturePanel/>}
            {tab==="assumptions"&&<AssumptionsPanel/>}
            {tab==="account"&&auth.isAuthenticated&&<AccountPanel C={C}/>}
          </div>
        </div>

        {/* FOOTER */}
        <div style={{borderTop:`1px solid ${C.border}`,background:C.bg,flexShrink:0}}>
          <div style={{padding:"10px 20px",borderBottom:`1px solid ${C.border}`}}>
            <div style={{fontSize:9,color:C.txtMuted,fontFamily:"monospace",lineHeight:1.55,textAlign:"justify",maxWidth:1400,margin:"0 auto"}}>
              <span style={{color:C.accent,fontWeight:700,letterSpacing:".5px"}}>DISCLAIMER &amp; LIMITATION OF LIABILITY —</span> This software and all results herein (&quot;the Software&quot;) are provided <span style={{fontWeight:700}}>&quot;AS IS&quot;</span> without warranties of any kind, express or implied, for <span style={{fontWeight:700}}>educational and preliminary-estimation purposes only</span>. <span style={{color:C.warm,fontWeight:700}}>This simulator may not be representative of the LMS100 engine behavior.</span> Outputs are best-effort approximations from reduced-order models and may deviate materially from real-world behavior or high-fidelity CFD / chemistry solvers. ProReadyEngineer LLC, its owners, employees, and contributors disclaim all liability for any direct, indirect, incidental, consequential, or punitive damages, losses, or claims arising from use of or reliance on the Software. Not certified for design, permitting, regulatory, emissions-reporting, or safety-critical decisions. Users assume all risk and must independently verify every result with qualified licensed engineers, validated software, and applicable codes and standards before any engineering or operational decision. By using the Software you accept these terms.
            </div>
          </div>
          <div style={{padding:"12px 20px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}><Logo size={18}/><span style={{fontSize:10,color:C.txtMuted,fontFamily:"monospace"}}>© {new Date().getFullYear()} ProReadyEngineer LLC — All Rights Reserved</span></div>
            <div style={{display:"flex",alignItems:"center",gap:16}}><a href="https://www.ProReadyEngineer.com" target="_blank" rel="noopener noreferrer" style={{fontSize:10,color:C.accent,fontFamily:"monospace",textDecoration:"none"}}>www.ProReadyEngineer.com</a><span style={{fontSize:9,color:C.txtMuted,fontFamily:"monospace"}}>Thermal Fluid Sciences & AI</span></div>
          </div>
        </div>
      </div>
    </AccurateCtx.Provider>
    </UnitCtx.Provider>);}
