import { Fragment, useState, useMemo, useCallback, useEffect, useRef, createContext, useContext } from "react";
import * as XLSX from "xlsx";
import { useAuth, AuthModal } from "./auth.jsx";
import { AccountPanel } from "./AccountPanel.jsx";
import * as api from "./api.js";

/* ══════════════════════════════════════════════════════════════
   UNIT SYSTEM
   ══════════════════════════════════════════════════════════════ */
const UnitCtx = createContext("SI");
// Accurate Mode: when on AND user has online access, panels route calcs to the backend (Cantera).
// Otherwise they use the free in-browser models. Exposed via context to avoid prop-drilling.
const AccurateCtx = createContext({ accurate:false, setAccurate:()=>{}, available:false });
// Busy tracker — any Cantera call registers a task here while in-flight so the global overlay
// can show a large "calculations in progress" banner that disappears when all tasks complete.
const BusyCtx = createContext({ begin:()=>()=>{}, tasks:[] });
const BUSY_LABELS = {
  aft: "Computing adiabatic flame temperature (Cantera HP equilibrium + complete-combustion companion)…",
  flame: "Solving 1D premixed flame — laminar flame speed S_L (Cantera FreeFlame, mixture-averaged transport)…",
  combustor: "Running PSR → PFR combustor network (Cantera reactor net, NOx + CO kinetics)…",
  exhaust: "Inverting exhaust O₂ / CO₂ to equivalence ratio (Cantera equilibrium + complete-combustion)…",
  props: "Computing mixture fluid properties (Cantera thermodynamics + transport)…",
  autoignition: "Integrating 0D ignition-delay (Cantera constant-HP reactor)…",
  cycle: "Solving gas-turbine cycle (compressor / combustor / turbine + bleed + water injection)…",
  combustor_mapping: "Running 4-circuit combustor mapping (PSR + PFR per circuit → mix → bulk PFR)…",
  flame_sweep: "Sweeping laminar flame speed across φ (Cantera FreeFlame × N points)…",
  load_sweep: "Running load sweep — cycle + AFT at each load point (20 → 100 %)…",
};
const UC = {
  SI: { T:{u:"K",from:v=>v,to:v=>v}, P:{u:"atm",from:v=>v,to:v=>v}, vel:{u:"m/s",from:v=>v,to:v=>v}, len:{u:"m",from:v=>v,to:v=>v}, lenSmall:{u:"cm",from:v=>v,to:v=>v}, SL:{u:"cm/s",from:v=>v,to:v=>v}, mass:{u:"kg",from:v=>v,to:v=>v}, energy_mass:{u:"MJ/kg",from:v=>v,to:v=>v}, energy_vol:{u:"MJ/m³",from:v=>v,to:v=>v}, cp:{u:"J/(mol·K)",from:v=>v,to:v=>v}, h_mol:{u:"kJ/mol",from:v=>v,to:v=>v}, s_mol:{u:"J/(mol·K)",from:v=>v,to:v=>v}, time:{u:"ms",from:v=>v,to:v=>v}, afr_mass:{u:"kg/kg",from:v=>v,to:v=>v} },
  ENG: { T:{u:"°F",from:K=>(K-273.15)*9/5+32,to:F=>(F-32)*5/9+273.15}, P:{u:"psia",from:a=>a*14.696,to:p=>p/14.696}, vel:{u:"ft/s",from:m=>m*3.28084,to:f=>f/3.28084}, len:{u:"ft",from:m=>m*3.28084,to:f=>f/3.28084}, lenSmall:{u:"in",from:c=>c/2.54,to:i=>i*2.54}, SL:{u:"ft/s",from:c=>c/30.48,to:f=>f*30.48}, mass:{u:"lb",from:k=>k*2.20462,to:l=>l/2.20462}, energy_mass:{u:"BTU/lb",from:v=>v*429.923,to:v=>v/429.923}, energy_vol:{u:"BTU/scf",from:v=>v*26.839,to:v=>v/26.839}, cp:{u:"BTU/(lbmol·°F)",from:v=>v*0.000238846*453.592*5/9,to:v=>v/(0.000238846*453.592*5/9)}, h_mol:{u:"BTU/lbmol",from:v=>v*429.923,to:v=>v/429.923}, s_mol:{u:"BTU/(lbmol·°F)",from:v=>v*0.000238846*453.592*5/9,to:v=>v/(0.000238846*453.592*5/9)}, time:{u:"ms",from:v=>v,to:v=>v}, afr_mass:{u:"lb/lb",from:v=>v,to:v=>v} }
};
function uv(units,key,val){return UC[units][key].from(val);}
function uvI(units,key,disp){return UC[units][key].to(disp);}  // display units -> SI
function uu(units,key){return UC[units][key].u;}

// Default mapping tables — φ for IP/OP/IM as a function of T3 (°F) and BRNDMD.
// Used by the Combustor Mapping panel: once T3 and BRNDMD are known, look up
// the three φ values and auto-fill the IP/OP/IM circuit inputs. User can edit
// any cell; software re-reads continuously. Linear interpolation between rows.
function _tblRow(T3, OP, IP, IM){ return {T3, OP, IP, IM}; }
const DEFAULT_MAPPING_TABLES = {
  7: [
    ...Array.from({length:17}, (_,i) => _tblRow(500+i*10, 0.85, 0.25, 0.58)),  // 500–660
    _tblRow(670, 0.75, 0.25, 0.58),
    _tblRow(680, 0.65, 0.25, 0.58),
    _tblRow(690, 0.55, 0.25, 0.575),
    _tblRow(700, 0.45, 0.25, 0.57),
    _tblRow(750, 0.45, 0.25, 0.57),
    _tblRow(800, 0.45, 0.25, 0.57),
    _tblRow(850, 0.45, 0.25, 0.57),
  ],
  6: [
    ...Array.from({length:21}, (_,i) => _tblRow(500+i*10, 0.7, 1.2, 0.47)),    // 500–700
    _tblRow(750, 0.7, 1.2, 0.47),
    _tblRow(800, 0.7, 1.2, 0.47),
    _tblRow(850, 0.7, 1.2, 0.47),
  ],
  4: [
    ...Array.from({length:21}, (_,i) => _tblRow(500+i*10, 0.7, 2.0, 0.43)),    // 500–700
    _tblRow(750, 0.7, 2.0, 0.43),
    _tblRow(800, 0.7, 2.0, 0.43),
    _tblRow(850, 0.7, 2.0, 0.43),
  ],
  2: [
    ...Array.from({length:21}, (_,i) => _tblRow(500+i*10, 0.85, 5.3, 0.0)),    // 500–700
    _tblRow(750, 0.85, 5.3, 0.0),
    _tblRow(800, 0.85, 5.3, 0.0),
    _tblRow(850, 0.85, 5.3, 0.0),
  ],
};

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
function calcBRNDMD(MW_net, emissionsMode=true){
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
const FUEL_PRESETS={"Pipeline NG (US)":{CH4:93.1,C2H6:3.2,C3H8:0.7,C4H10:0.4,CO2:1.0,N2:1.6},"Pipeline NG (EU)":{CH4:87.0,C2H6:5.5,C3H8:2.1,C4H10:0.5,N2:3.0,CO2:1.9},"LNG (typical)":{CH4:95.0,C2H6:3.0,C3H8:1.0,N2:1.0},"Biogas":{CH4:60,CO2:35,N2:4,H2:1},"Landfill Gas":{CH4:50,CO2:45,N2:5},"Syngas (Coal)":{H2:30,CO:40,CO2:10,CH4:5,N2:15},"Syngas (Biomass)":{H2:20,CO:20,CO2:15,CH4:10,N2:35},"Coke Oven Gas":{H2:55,CH4:25,CO:8,N2:6,C2H4:3,CO2:3},"Pure Methane":{CH4:100},"Pure Hydrogen":{H2:100},"Pure Propane":{C3H8:100},"13% N₂ (bal CH₄)":{CH4:87.0,N2:13.0},"26% N₂ (bal CH₄)":{CH4:74.0,N2:26.0},"7.5% C₂ + 1.8% C₃ (bal CH₄)":{CH4:89.7,C2H6:7.5,C3H8:1.8,N2:1.0},"15% C₂ + 3.6% C₃ (bal CH₄)":{CH4:80.4,C2H6:15.0,C3H8:3.6,N2:1.0},"70% H₂ / 30% NG":{H2:70,CH4:27.9,C2H6:1.0,C3H8:0.2,N2:0.5,CO2:0.4},"50% H₂ / 50% NG":{H2:50,CH4:46.6,C2H6:1.6,C3H8:0.4,N2:0.8,CO2:0.6},"20% H₂ / 80% NG":{H2:20,CH4:74.5,C2H6:2.6,C3H8:0.6,N2:1.3,CO2:1.0}};
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
function calcFuelProps(fuel,ox){const hv=calcHeatingValues(fuel);const MW_air=mixMW(ox);const SG=hv.MW/28.97;const WI=hv.HHV_vol/Math.sqrt(SG||0.01);const sO2=stoichO2(fuel);const oxO2f=(ox.O2||20.95)/100;const stoichOxMol=sO2/(oxO2f||0.2095);const AFR_mass=stoichOxMol*MW_air/hv.MW;return{...hv,SG,WI,AFR_mass,AFR_vol:stoichOxMol,MW_fuel:hv.MW,MW_air,stoichO2:sO2};}
function calcAFT(fuel,ox,phi,T0){const ft=Object.values(fuel).reduce((a,b)=>a+b,0);const ot=Object.values(ox).reduce((a,b)=>a+b,0);if(ft===0||ot===0)return{T_ad:T0,products:{}};const fN={},oN={};for(const k in fuel)fN[k]=fuel[k]/ft;for(const k in ox)oN[k]=ox[k]/ot;const sO2=stoichO2(fuel);const oxO2f=oN.O2||0.2095;const oxMols=sO2/(oxO2f*phi);const reactants={};for(const[sp,xi]of Object.entries(fN))reactants[sp]=(reactants[sp]||0)+xi;for(const[sp,xi]of Object.entries(oN))reactants[sp]=(reactants[sp]||0)+xi*oxMols;const products={};for(const sp of["N2","Ar"])products[sp]=reactants[sp]||0;products.H2O=reactants.H2O||0;products.CO2=reactants.CO2||0;let O2_used=0;for(const[sp,xi]of Object.entries(fN)){const d=SP[sp];if(!d||(d.C===0&&d.H===0&&sp!=="CO"))continue;products.CO2=(products.CO2||0)+xi*d.C;products.H2O=(products.H2O||0)+xi*d.H/2;O2_used+=xi*o2_per_mol(sp);}const O2_avail=oxMols*oxO2f;if(phi<=1){products.O2=O2_avail-O2_used;}else{const deficit=O2_used-O2_avail;const shift=Math.min(deficit,products.CO2||0);products.CO=shift;products.CO2=Math.max(0,(products.CO2||0)-shift);if(deficit>shift){const hS=(deficit-shift)*2;products.H2=hS;products.H2O=Math.max(0,(products.H2O||0)-hS);}products.O2=0;}let H_react=0;for(const[sp,n]of Object.entries(reactants)){if(!SP[sp])continue;H_react+=n*h_mol(sp,T0);}let T_ad=T0+1800;for(let i=0;i<200;i++){let H_prod=0;for(const[sp,n]of Object.entries(products)){if(!SP[sp]||n<=0)continue;H_prod+=n*h_mol(sp,T_ad);}let Cp=0;const Tm=(T0+T_ad)/2;for(const[sp,n]of Object.entries(products)){if(!SP[sp]||n<=0)continue;Cp+=n*cp_mol(sp,Tm);}if(Cp<1)break;const err=H_react-H_prod;const T_n=T_ad+err/Cp*0.6;if(Math.abs(T_n-T_ad)<0.2){T_ad=T_n;break;}T_ad=T_n;}T_ad=Math.max(T0,Math.min(T_ad,5500));const pT=Object.values(products).reduce((a,b)=>a+Math.max(0,b),0);const pPct={};for(const[sp,n]of Object.entries(products)){if(n>0.001)pPct[sp]=n/pT*100;}return{T_ad,products:pPct};}
function sweepAFT(fuel,ox,T0,P,mode){const r=[];for(let phi=0.3;phi<=1.01;phi+=0.02){const a=calcAFTx(fuel,ox,phi,T0,P,mode);r.push({phi:+phi.toFixed(2),T_ad:a.T_ad});}return r;}

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
function exportToExcel(fuel,ox,phi,T0,P,units,ps){const wb=XLSX.utils.book_new();const u=units;const fp=calcFuelProps(fuel,ox);const{velocity,Lchar,Dfh=0.02,Lpremix=0.10,Vpremix=60,tau_psr,L_pfr,V_pfr,T_fuel,T_air,measO2,measCO2,combMode,psrSeed="cold_ignited",eqConstraint="HP",integration="chunked",heatLossFrac=0,mechanism="gri30",WFR=0,waterMode="liquid",T_water=288.15,accurate=false,cycleEngine,cyclePamb,cycleTamb,cycleRH,cycleLoad,cycleTcool,cycleAirFrac,bleedMode="auto",bleedOpenPct=0,bleedValveSizePct=0,bleedAirFrac=0,cycleResult,mappingTables}=ps||{};
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
  ["═══ AFT vs φ SWEEP ═══"],["Equivalence Ratio (φ)","Fuel/Air Ratio (mass)","T_mixed_inlet ("+uu(u,"T")+")","Adiabatic Flame Temperature ("+uu(u,"T")+")"],...Array.from({length:18},(_,i)=>{const p=0.3+i*0.04;const Tm=mixT(fuel,ox,p,T_fuel??T0,T_air??T0);const a=calcAFTx(fuel,ox,p,Tm,P,combMode);return[+p.toFixed(2),+(p/fp.AFR_mass).toFixed(6),+uv(u,"T",Tm).toFixed(1),+uv(u,"T",a.T_ad).toFixed(1)];})];const ws1=XLSX.utils.aoa_to_sheet(s1);ws1["!cols"]=[{wch:42},{wch:20},{wch:18}];XLSX.utils.book_append_sheet(wb,ws1,"Flame Temp & Props");
const SL=calcSL(fuel,phi,T_mix_phi,P)*100;const bo=calcBlowoff(fuel,phi,T_mix_phi,P,velocity,Lchar);
// Premixer stability derived quantities (SL_ms = m/s, SL export is in user units; internal calcs use m/s).
const _SLms=SL/100;
const _alphaTh=alphaThU(T_mix_phi,P);
const _tauBO=Dfh/Math.max(1.5*_SLms,1e-20);
const _gc=(_SLms*_SLms)/Math.max(_alphaTh,1e-20);
const _tauIgn=calcTauIgnFree(T_mix_phi,P);
const _tauRes=Lpremix/Math.max(Vpremix,1e-20);
const _ignSafe=_tauRes<_tauIgn;
const s2=[["═══ FLAME SPEED & BLOWOFF — INPUTS ═══"],[],["Parameter","Value","Unit"],["Equivalence Ratio (φ)",+phi.toFixed(4),"—"],["Fuel/Air Ratio (mass)",+(phi/fp.AFR_mass).toFixed(6),uu(u,"afr_mass")],["Air Inlet Temperature (T_air)",+uv(u,"T",T_air??T0).toFixed(2),uu(u,"T")],["Fuel Inlet Temperature (T_fuel)",+uv(u,"T",T_fuel??T0).toFixed(2),uu(u,"T")],["Unburned Temperature (T_mixed @ φ)",+uv(u,"T",T_mix_phi).toFixed(2),uu(u,"T")],["Pressure",+uv(u,"P",P).toFixed(3),uu(u,"P")],["Reference Velocity",+uv(u,"vel",velocity).toFixed(2),uu(u,"vel")],["Characteristic Length (L_char)",+uv(u,"len",Lchar).toFixed(4),uu(u,"len")],["Flameholder Diameter (D_fh)",+uv(u,"len",Dfh).toFixed(4),uu(u,"len")],["Premixer Length (L_premix)",+uv(u,"len",Lpremix).toFixed(4),uu(u,"len")],["Premixer Velocity (V_premix)",+uv(u,"vel",Vpremix).toFixed(2),uu(u,"vel")],[],["═══ OUTPUTS ═══"],[],["Parameter","Value","Unit"],["Laminar Flame Speed (S_L)",+uv(u,"SL",SL).toFixed(4),uu(u,"SL")],["Chemical Timescale (τ_chem)",+bo.tau_chem.toFixed(6),"ms"],["Flow Timescale (τ_flow)",+bo.tau_flow.toFixed(6),"ms"],["Damköhler Number (Da)",+bo.Da.toFixed(4),"—"],["Blowoff Velocity",+uv(u,"vel",bo.blowoff_velocity).toFixed(2),uu(u,"vel")],["Flame Stability",bo.stable?"STABLE":"BLOWOFF RISK","—"],[],["═══ PREMIXER STABILITY — FLASHBACK & AUTOIGNITION ═══"],["Parameter","Value","Unit"],["Zukoski Blow-off Time (τ_BO)",+(_tauBO*1000).toFixed(4),"ms"],["Thermal Diffusivity (α_th, unburnt)",+(_alphaTh*1e6).toFixed(4),"mm²/s"],["Lewis-von Elbe Gradient (g_c)",+_gc.toFixed(1),"1/s"],["Autoignition Delay (τ_ign, Spadaccini-Colket)",+(_tauIgn*1000).toFixed(4),"ms"],["Premixer Residence Time (τ_res)",+(_tauRes*1000).toFixed(4),"ms"],["Safety Margin (τ_ign / τ_res)",+(_tauIgn/_tauRes).toFixed(3),"—"],["Premixer Status",_ignSafe?"SAFE":"AUTOIGNITION RISK","—"],["Note","τ_ign uses Spadaccini-Colket NG correlation (order-of-magnitude). Use Accurate mode for Cantera 0D values.",""],[],["═══ S_L vs Equivalence Ratio ═══"],["Equivalence Ratio (φ)","Fuel/Air Ratio (mass)","T_mixed ("+uu(u,"T")+")","Flame Speed ("+uu(u,"SL")+")"],...Array.from({length:13},(_,i)=>{const p=0.4+i*0.05;const Tm=mixT(fuel,ox,p,T_fuel??T0,T_air??T0);return[+p.toFixed(2),+(p/fp.AFR_mass).toFixed(6),+uv(u,"T",Tm).toFixed(1),+uv(u,"SL",calcSL(fuel,p,Tm,P)*100).toFixed(4)]}),[],["═══ S_L vs Pressure (@T_mixed) ═══"],["Pressure ("+uu(u,"P")+")","Flame Speed ("+uu(u,"SL")+")"],...[0.5,1,2,5,10,20,40].map(p=>[+uv(u,"P",p).toFixed(2),+uv(u,"SL",calcSL(fuel,phi,T_mix_phi,p)*100).toFixed(4)]),[],["═══ S_L vs Unburned Temperature (user sweep) ═══"],["Temperature ("+uu(u,"T")+")","Flame Speed ("+uu(u,"SL")+")"],...Array.from({length:23},(_,i)=>{const t=250+i*25;return[+uv(u,"T",t).toFixed(1),+uv(u,"SL",calcSL(fuel,phi,t,P)*100).toFixed(4)]}),[],["═══ Damköhler vs Velocity ═══"],["Velocity ("+uu(u,"vel")+")","Damköhler (Da)","Status"],...Array.from({length:40},(_,i)=>{const v=1+i*5;const b=calcBlowoff(fuel,phi,T_mix_phi,P,v,Lchar);return[+uv(u,"vel",v).toFixed(1),+b.Da.toFixed(4),b.stable?"Stable":"Blowoff"]})];const ws2=XLSX.utils.aoa_to_sheet(s2);ws2["!cols"]=[{wch:32},{wch:18},{wch:14}];XLSX.utils.book_append_sheet(wb,ws2,"Flame Speed & Blowoff");
const net=calcCombustorNetwork(fuel,ox,phi,T0,P,tau_psr,L_pfr,V_pfr,T_fuel,T_air);
// Canonical equilibrium AFT (same calc as Flame Temp sheet). Distinct from net.T_ad, which in this reduced-order model is the PFR exit T.
const combAFT=calcAFT_EQ(fuel,ox,phi,mixT(fuel,ox,phi,T_fuel??T0,T_air??T0),P);
const s3=[["═══ COMBUSTOR NETWORK — INPUTS ═══"],[],["Parameter","Value","Unit"],["Equivalence Ratio (φ)",+phi.toFixed(4),"—"],["Fuel/Air Ratio (mass)",+(phi/fp.AFR_mass).toFixed(6),uu(u,"afr_mass")],["Inlet Temperature (sidebar)",+uv(u,"T",T0).toFixed(2),uu(u,"T")],["Fuel Inlet Temperature (T_fuel)",+uv(u,"T",T_fuel??T0).toFixed(2),uu(u,"T")],["Air Inlet Temperature (T_air)",+uv(u,"T",T_air??T0).toFixed(2),uu(u,"T")],["Adiabatic Mixed Inlet T (T_mixed)",+uv(u,"T",net.T_mixed_inlet_K??T0).toFixed(2),uu(u,"T")],["Pressure",+uv(u,"P",P).toFixed(3),uu(u,"P")],["Water/Fuel Mass Ratio (WFR)",+(+WFR).toFixed(3),"kg_water/kg_fuel"],["Water Injection Mode",WFR>0?(waterMode==="steam"?"Steam (gas phase @ T_air)":"Liquid (absorbs h_fg)"):"off","—"],["PSR Residence Time (τ_PSR)",+tau_psr,"ms"],["PFR Length (L_PFR)",+uv(u,"len",L_pfr).toFixed(3),uu(u,"len")],["PFR Velocity (V_PFR)",+uv(u,"vel",V_pfr).toFixed(2),uu(u,"vel")],[],["═══ PSR SOLVER OPTIONS ═══"],["Parameter","Value","Unit"],["PSR Seed (warm-start)",_PSR_SEED_LBL[psrSeed]||psrSeed,"—"],["Equilibrium Constraint",(psrSeed==="unreacted"?"n/a (unreacted seed)":_EQ_LBL[eqConstraint]||eqConstraint),"—"],["Integration Strategy",_INT_LBL[integration]||integration,"—"],["Heat-Loss Fraction",+(+heatLossFrac).toFixed(3),"—"],["Heat-Loss Description",heatLossFrac>0?`T_psr held at T_ad − ${(heatLossFrac*100).toFixed(0)}%·(T_ad − T_inlet)`:"adiabatic (T_psr = T_ad)","—"],["Kinetic Mechanism",_MECH_LBL[mechanism]||mechanism,"—"],[],["═══ COMPUTATION MODE ═══"],["Mode",accurate?"ACCURATE (server-side Cantera backend)":"SIMPLE (in-browser reduced-order JS model)","—"],["Note",accurate?"PSR solver options above are honored by the Cantera backend when the app is running in Accurate mode. Tabular values and sweeps BELOW in this sheet are from the reduced-order JS model (GRI-Mech 3.0-calibrated correlations) for export consistency. To see accurate numbers for the current operating point, view the app UI in Accurate mode.":"PSR solver options and kinetic mechanism above are only used by the Accurate (Cantera) backend. In Simple mode, the tabular values below are from the reduced-order JS model (GRI-Mech 3.0-calibrated correlations) and do not vary with those options.","—"],[],["═══ OUTPUTS ═══"],[],["Parameter","Value","Unit"],["Adiabatic Flame Temperature",+uv(u,"T",combAFT.T_ad).toFixed(1),uu(u,"T")],["Combustor Exit Temperature",+uv(u,"T",net.T_ad).toFixed(1),uu(u,"T")],["PSR Exit Temperature",+uv(u,"T",net.T_psr).toFixed(1),uu(u,"T")],["PSR Conversion",+net.conv_psr.toFixed(2),"%"],["NOx at PSR Exit",+(net.NO_ppm_psr??0).toFixed(3),"ppmvd"],["NOx at Combustor Exit",+net.NO_ppm_exit.toFixed(3),"ppm"],["NOx @ 15% O₂",+net.NO_ppm_15O2.toFixed(3),"ppmvd"],["CO at Exit",+net.CO_ppm_exit.toFixed(2),"ppm"],["Exhaust O₂ (dry)",+net.O2_pct.toFixed(2),"%"],["τ_PFR",+net.tau_pfr_ms.toFixed(3),"ms"],["τ_total (PSR+PFR)",+net.tau_total_ms.toFixed(3),"ms"],[],["═══ PFR PROFILE ═══"],["Position ("+uu(u,"lenSmall")+")","Temperature ("+uu(u,"T")+")","NOx (ppm)","CO (ppm)","Conversion (%)"],...net.pfr.map(pt=>[+uv(u,"lenSmall",pt.x).toFixed(2),+uv(u,"T",pt.T).toFixed(1),+pt.NO_ppm,+pt.CO_ppm,+pt.conv]),[],["═══ EMISSIONS vs Equivalence Ratio ═══"],["Equivalence Ratio (φ)","Fuel/Air Ratio (mass)","NOx @ 15% O₂ (ppm)","CO (ppm)"],...Array.from({length:13},(_,i)=>{const p=0.4+i*0.05;const n=calcCombustorNetwork(fuel,ox,p,T0,P,tau_psr,L_pfr,V_pfr,T_fuel,T_air);return[+p.toFixed(2),+(p/fp.AFR_mass).toFixed(6),+n.NO_ppm_15O2.toFixed(3),+n.CO_ppm_exit.toFixed(2)]})];const ws3=XLSX.utils.aoa_to_sheet(s3);ws3["!cols"]=[{wch:32},{wch:20},{wch:16},{wch:14},{wch:14}];XLSX.utils.book_append_sheet(wb,ws3,"Combustor Network");
// Exhaust inversion: two-pass (mix T using initial phi=0.6 guess, then refine with solved phi)
const _exO2_p0=calcExhaustFromO2(fuel,ox,measO2,mixT(fuel,ox,0.6,T_fuel??T0,T_air??T0),P,combMode);
const rO2=calcExhaustFromO2(fuel,ox,measO2,mixT(fuel,ox,_exO2_p0.phi,T_fuel??T0,T_air??T0),P,combMode);
const _exCO2_p0=calcExhaustFromCO2(fuel,ox,measCO2,mixT(fuel,ox,0.6,T_fuel??T0,T_air??T0),P,combMode);
const rCO2=calcExhaustFromCO2(fuel,ox,measCO2,mixT(fuel,ox,_exCO2_p0.phi,T_fuel??T0,T_air??T0),P,combMode);
const T_mix_O2=mixT(fuel,ox,rO2.phi,T_fuel??T0,T_air??T0);
const T_mix_CO2=mixT(fuel,ox,rCO2.phi,T_fuel??T0,T_air??T0);
const s5=[["═══ EXHAUST ANALYSIS — INPUTS ═══"],[],["Parameter","Value","Unit"],["Measured O₂ (dry)",+measO2.toFixed(2),"%"],["Measured CO₂ (dry)",+measCO2.toFixed(2),"%"],["Air Inlet Temperature (T_air)",+uv(u,"T",T_air??T0).toFixed(2),uu(u,"T")],["Fuel Inlet Temperature (T_fuel)",+uv(u,"T",T_fuel??T0).toFixed(2),uu(u,"T")],["T_mixed @ φ(O₂ case)",+uv(u,"T",T_mix_O2).toFixed(2),uu(u,"T")],["T_mixed @ φ(CO₂ case)",+uv(u,"T",T_mix_CO2).toFixed(2),uu(u,"T")],["Water/Fuel Mass Ratio (WFR)",+(+WFR).toFixed(3),"kg_water/kg_fuel"],["Water Injection Mode",WFR>0?(waterMode==="steam"?"Steam (gas phase @ T_air)":"Liquid (absorbs h_fg)"):"off","—"],[],["═══ FROM MEASURED O₂ ═══"],[],["Parameter","Value","Unit"],["Equivalence Ratio (φ)",+rO2.phi.toFixed(5),"—"],["Adiabatic Flame Temperature",+uv(u,"T",rO2.T_ad).toFixed(1),uu(u,"T")],["Fuel/Air Ratio (mass)",+rO2.FAR_mass.toFixed(6),uu(u,"afr_mass")],["Air/Fuel Ratio (mass)",+(1/(rO2.FAR_mass+1e-20)).toFixed(3),uu(u,"afr_mass")],[],["Species (wet basis)","Mole %"],...Object.entries(rO2.products||{}).filter(([_,v])=>v>0.01).sort((a,b)=>b[1]-a[1]).map(([sp,v])=>[fmt(sp),+v.toFixed(4)]),[],["Species (dry basis)","Mole %"],...Object.entries(dryBasis(rO2.products||{})).filter(([_,v])=>v>0.01).sort((a,b)=>b[1]-a[1]).map(([sp,v])=>[fmt(sp),+v.toFixed(4)]),[],["═══ FROM MEASURED CO₂ ═══"],[],["Parameter","Value","Unit"],["Equivalence Ratio (φ)",+rCO2.phi.toFixed(5),"—"],["Adiabatic Flame Temperature",+uv(u,"T",rCO2.T_ad).toFixed(1),uu(u,"T")],["Fuel/Air Ratio (mass)",+rCO2.FAR_mass.toFixed(6),uu(u,"afr_mass")],["Air/Fuel Ratio (mass)",+(1/(rCO2.FAR_mass+1e-20)).toFixed(3),uu(u,"afr_mass")],[],["Species (wet basis)","Mole %"],...Object.entries(rCO2.products||{}).filter(([_,v])=>v>0.01).sort((a,b)=>b[1]-a[1]).map(([sp,v])=>[fmt(sp),+v.toFixed(4)]),[],["Species (dry basis)","Mole %"],...Object.entries(dryBasis(rCO2.products||{})).filter(([_,v])=>v>0.01).sort((a,b)=>b[1]-a[1]).map(([sp,v])=>[fmt(sp),+v.toFixed(4)]),[],["═══ Adiabatic Temperature vs Exhaust O₂ ═══"],["Exhaust O₂ (%)","Flame Temperature ("+uu(u,"T")+")","Equivalence Ratio (φ)","Fuel/Air Ratio (mass)"],...Array.from({length:30},(_,i)=>{const o2=0.5+i*0.5;const r0=calcExhaustFromO2(fuel,ox,o2,mixT(fuel,ox,0.6,T_fuel??T0,T_air??T0),P,combMode);const r=calcExhaustFromO2(fuel,ox,o2,mixT(fuel,ox,r0.phi,T_fuel??T0,T_air??T0),P,combMode);return[+o2.toFixed(1),+uv(u,"T",r.T_ad).toFixed(1),+r.phi.toFixed(4),+r.FAR_mass.toFixed(6)]})];const ws5=XLSX.utils.aoa_to_sheet(s5);ws5["!cols"]=[{wch:38},{wch:20},{wch:16},{wch:16}];XLSX.utils.book_append_sheet(wb,ws5,"Exhaust Analysis");
const s4=[["═══ THERMO DATABASE ═══"],["NASA 7-coefficient polynomials"],[]];for(const sp of["CH4","C2H6","C3H8","H2","CO","O2","N2","H2O","CO2","OH","NO","Ar"]){if(!SP[sp])continue;s4.push([SP[sp].nm+" ("+fmt(sp)+")","Molecular Weight: "+SP[sp].MW,"ΔHf: "+(SP[sp].Hf/1000).toFixed(2)+" kJ/mol"]);s4.push(["Temperature (K)","Heat Capacity Cp (J/mol·K)","Enthalpy H (kJ/mol)","Entropy S (J/mol·K)","Gibbs Energy G (kJ/mol)"]);for(let T=200;T<=3000;T+=100){const H=h_mol(sp,T)/1000;const Sv=sR(sp,T)*R_u;s4.push([T,+cp_mol(sp,T).toFixed(4),+H.toFixed(4),+Sv.toFixed(4),+((H*1000-T*Sv)/1000).toFixed(4)]);}s4.push([]);}const ws4=XLSX.utils.aoa_to_sheet(s4);ws4["!cols"]=[{wch:28},{wch:18},{wch:18},{wch:18},{wch:18}];XLSX.utils.book_append_sheet(wb,ws4,"Thermo Database");
// ══════════════════ CYCLE (Gas Turbine) — Option A + B ══════════════════
// Only written if we have a cycle result in hand. The cycle backend is
// Cantera-only, so offline / Simple mode has no numbers to export.
if(cycleResult){
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
    ["Fuel Temperature",fmtN(uv(u,"T",cr.T_fuel_K??cycleTamb),2),uu(u,"T")],
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

// ══════════════════ ASSUMPTIONS ══════════════════
// Mirrors the 12 groups from the in-app Assumptions panel. Keep these two
// in sync — if a number changes in cycle.py it must be updated both places.
const sA=[
  ["═══ MODELING ASSUMPTIONS ═══"],
  ["Every number below is baked into the cycle and combustion solvers."],
  ["Matches the in-app Assumptions tab. Not a design tool."],[],
  ["Group","Parameter","Value","Basis / Rationale"],

  ["1. Ambient & Inlet","Reference pressure","1.01325 bar","Sea-level ISA. P_amb input overrides for off-design."],
  ["","Reference temperature","288.706 K (60 °F)","LM6000 ISO anchor. LMS100 anchored at 44 °F / 80% RH."],
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
  ["","Combustor bypass fraction","LM6000: 0.683 / LMS100: 0.747","Per-engine calibration. Core-to-casing split."],
  ["","Combustor air fraction (flame/total)","0.88 (both)","Flame vs dilution zone split."],
  ["","T4 target","LM6000: 1755 K / LMS100: 1825 K","Firing temperature — commanded by deck."],
  ["","φ4 solve","Cantera equilibrate(\"HP\")","Back-solved so product T = T4. Equilibrium only."],
  ["","T_Bulk","equilibrate(\"HP\") at (T3,P3,φ_Bulk)","Drives downstream panels when linked."],
  ["","Heat loss","0%","Adiabatic combustor (AFT panel has separate HL input)."],

  ["6. Turbine","η_isen_turb","LM6000: 0.7416 / LMS100: 0.7640","Calibrated so MW_gross lands at cap at anchor."],
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

  ["10. Engine Deck Anchors","LM6000PF","45.0 MW @ 60 °F / 60% RH","T3 811 K · P3 30.3 bar · T4 1755 K · η 42.4% · HR 8493 BTU/kWh."],
  ["","LMS100PB+","107.5 MW @ 44 °F / 80% RH","T3 644 K · P3 44.0 bar · T4 1825 K · η 44.0% · HR 8178 BTU/kWh · intercooled."],
  ["","Anchor method","combustor_bypass_frac + η_isen_turb","Two per-engine knobs fit MW and η at anchor."],

  ["11. Off-design Scaling","Density lapse","mdot_air ∝ ρ_amb · VGV(T_amb)","Engine-specific lapse curve."],
  ["","LMS100 intercooler benefit","Architectural","HPC inlet pinned to T_cool_in."],
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
];
const wsA=XLSX.utils.aoa_to_sheet(sA);
wsA["!cols"]=[{wch:34},{wch:36},{wch:40},{wch:52}];
XLSX.utils.book_append_sheet(wb,wsA,"Assumptions");

// ══════════════════ MAPPING TABLES ══════════════════
if(mappingTables){
  const sM=[["═══ COMBUSTOR MAPPING TABLES — φ lookup by T3 × BRNDMD ═══"],[],
    ["BRNDMD","T3 (°F)","φ_OuterPilot","φ_InnerPilot","φ_InnerMain"]];
  for(const k of [7,6,4,2]){
    const rows=mappingTables[k]||[];
    for(const r of rows){sM.push([k,+r.T3,+r.OP,+r.IP,+r.IM]);}
    sM.push([]);
  }
  const wsM=XLSX.utils.aoa_to_sheet(sM);
  wsM["!cols"]=[{wch:10},{wch:10},{wch:16},{wch:16},{wch:16}];
  XLSX.utils.book_append_sheet(wb,wsM,"Mapping Tables");
}

XLSX.writeFile(wb,"ProReadyEngineer_CombustionReport.xlsx");}

/* ══════════════════ SVG CHART ══════════════════ */
function Chart({data,xK,yK,xL,yL,color="#2DD4BF",w=540,h=250,marker=null,markerColor=null,y2K=null,c2="#FBBF24",y2L="",vline=null,xMin=null,xMax=null,yMin=null,yMax=null,y2Min=null,y2Max=null,step=false,hLines=null}){if(!data||!data.length)return<div style={{color:C.txtMuted,padding:20,fontSize:13,fontFamily:"monospace"}}>No data</div>;const p={t:22,r:y2K?58:28,b:44,l:60};const W=w-p.l-p.r,H=h-p.t-p.b;const xs=data.map(d=>d[xK]),ys=data.map(d=>d[yK]);const xn=xMin!=null?xMin:Math.min(...xs),xx=xMax!=null?xMax:Math.max(...xs);let yn,yx;if(yMin!=null&&yMax!=null){yn=yMin;yx=yMax;}else{let yn_=Math.min(...ys),yx_=Math.max(...ys);if(yn_===yx_){yn_-=1;yx_+=1;}yn=yMin!=null?yMin:yn_-(yx_-yn_)*0.05;yx=yMax!=null?yMax:yx_+(yx_-yn_)*0.05;if(yn_>=0&&yn<0)yn=0;}const sx=v=>p.l+(v-xn)/(xx-xn||1)*W,sy=v=>p.t+H-(v-yn)/(yx-yn||1)*H;
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
  : data.map((d,i)=>`${i?'L':'M'}${sx(d[xK]).toFixed(1)},${sy(d[yK]).toFixed(1)}`).join(' ');let y2n,y2x,sy2,pts2;if(y2K){const y2s=data.map(d=>d[y2K]);if(y2Min!=null&&y2Max!=null){y2n=y2Min;y2x=y2Max;}else{let y2n_=Math.min(...y2s),y2x_=Math.max(...y2s);if(y2n_===y2x_){y2n_-=1;y2x_+=1;}y2n=y2Min!=null?y2Min:y2n_-(y2x_-y2n_)*0.05;y2x=y2Max!=null?y2Max:y2x_+(y2x_-y2n_)*0.05;if(y2n_>=0&&y2n<0)y2n=0;}sy2=v=>p.t+H-(v-y2n)/(y2x-y2n||1)*H;pts2=data.map((d,i)=>`${i?'L':'M'}${sx(d[xK]).toFixed(1)},${sy2(d[y2K]).toFixed(1)}`).join(' ');}const nY=5,nX=6;const yTk=Array.from({length:nY+1},(_,i)=>yn+(yx-yn)*i/nY);const xTk=Array.from({length:nX+1},(_,i)=>xn+(xx-xn)*i/nX);const fmt=v=>Math.abs(v)>=1e4?(v/1e3).toFixed(0)+'k':Math.abs(v)>=100?v.toFixed(0):Math.abs(v)>=1?v.toFixed(1):v.toFixed(3);const gid=`g${yK}${color.replace('#','')}${Math.random().toString(36).slice(2,6)}`;return(<svg viewBox={`0 0 ${w} ${h}`} style={{width:"100%",maxWidth:w}}><defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity=".2"/><stop offset="100%" stopColor={color} stopOpacity=".01"/></linearGradient></defs>{yTk.map((v,i)=><g key={i}><line x1={p.l} y1={sy(v)} x2={w-p.r} y2={sy(v)} stroke={C.grid} strokeWidth=".5"/><text x={p.l-5} y={sy(v)+3.5} fill={C.axis} fontSize="9" textAnchor="end" fontFamily="monospace">{fmt(v)}</text></g>)}{xTk.map((v,i)=><g key={i}><line x1={sx(v)} y1={p.t} x2={sx(v)} y2={p.t+H} stroke={C.grid} strokeWidth=".5"/><text x={sx(v)} y={h-p.b+15} fill={C.axis} fontSize="9" textAnchor="middle" fontFamily="monospace">{fmt(v)}</text></g>)}<path d={`${pts} L${sx(xs[xs.length-1]).toFixed(1)},${(p.t+H)} L${sx(xs[0]).toFixed(1)},${(p.t+H)} Z`} fill={`url(#${gid})`}/><path d={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round"/>{y2K&&pts2&&<path d={pts2} fill="none" stroke={c2} strokeWidth="2" strokeLinejoin="round" strokeDasharray="5 3"/>}{y2K&&<>{Array.from({length:nY+1},(_,i)=>y2n+(y2x-y2n)*i/nY).map((v,i)=><text key={`y2${i}`} x={w-p.r+5} y={sy2(v)+3.5} fill={c2} fontSize="8.5" textAnchor="start" fontFamily="monospace">{fmt(v)}</text>)}</>}{hLines&&hLines.map((hl,i)=>hl.y>=yn&&hl.y<=yx?<g key={`hl${i}`}><line x1={p.l} y1={sy(hl.y)} x2={w-p.r} y2={sy(hl.y)} stroke={hl.color} strokeWidth="1.5" strokeDasharray="6 4" opacity="0.9"/><text x={w-p.r-6} y={sy(hl.y)-4} fill={hl.color} fontSize="9.5" fontFamily="'Barlow Condensed',sans-serif" fontWeight="700" textAnchor="end" letterSpacing=".5px">{hl.label} · {hl.y.toFixed(1)}</text></g>:null)}{vline!=null&&vline>xn&&vline<xx&&<g><line x1={sx(vline)} y1={p.t} x2={sx(vline)} y2={p.t+H} stroke={C.txtMuted} strokeWidth="1" strokeDasharray="3 3" opacity=".7"/><text x={sx(vline)-4} y={p.t+11} fill={C.txtMuted} fontSize="8.5" textAnchor="end" fontFamily="monospace">PSR</text><text x={sx(vline)+4} y={p.t+11} fill={C.txtMuted} fontSize="8.5" textAnchor="start" fontFamily="monospace">PFR</text></g>}{marker&&<g><line x1={sx(marker.x)} y1={p.t} x2={sx(marker.x)} y2={p.t+H} stroke={markerColor||C.warm} strokeWidth="1" strokeDasharray="4 3"/><circle cx={sx(marker.x)} cy={sy(marker.y)} r="4" fill={markerColor||C.warm} stroke={C.bg} strokeWidth="2"/><text x={sx(marker.x)+(sx(marker.x)>w/2?-8:8)} y={sy(marker.y)-8} fill={markerColor||C.warm} fontSize="10" fontFamily="monospace" fontWeight="700" textAnchor={sx(marker.x)>w/2?"end":"start"}>{marker.label}</text></g>}<text x={p.l+W/2} y={h-3} fill={C.txtMuted} fontSize="10" textAnchor="middle" fontFamily="'Barlow',sans-serif">{xL}</text><text x={12} y={p.t+H/2} fill={color} fontSize="9.5" textAnchor="middle" fontFamily="'Barlow',sans-serif" transform={`rotate(-90,12,${p.t+H/2})`}>{yL}</text>{y2K&&<text x={w-14} y={p.t+H/2} fill={c2} fontSize="9.5" textAnchor="middle" fontFamily="'Barlow',sans-serif" transform={`rotate(90,${w-14},${p.t+H/2})`}>{y2L}</text>}</svg>);}
function HBar({data,w=540,h=180}){if(!data)return null;const entries=Object.entries(data).filter(([_,v])=>v>0.05).sort((a,b)=>b[1]-a[1]);if(!entries.length)return null;const pa={t:6,r:78,b:6,l:48};const bH=Math.min(22,(h-pa.t-pa.b)/entries.length-3);const mx=Math.max(...entries.map(e=>e[1]));const W=w-pa.l-pa.r;const clr={CO2:C.warm,H2O:C.accent,N2:C.accent3,O2:"#38BDF8",Ar:"#64748B",CH4:C.accent2,C2H6:C.orange,C3H8:"#F59E0B",H2:C.good,CO:"#FB923C",NO:C.strong,OH:C.violet,H:"#FDE68A",O:"#FCA5A5"};return(<svg viewBox={`0 0 ${w} ${h}`} style={{width:"100%",maxWidth:w}}>{entries.map(([sp,val],i)=>{const y=pa.t+i*(bH+3);const bw=val/mx*W;return(<g key={sp}><text x={pa.l-4} y={y+bH/2+4} fill={C.txtDim} fontSize="11" textAnchor="end" fontFamily="monospace">{fmt(sp)}</text><rect x={pa.l} y={y} width={Math.max(1,bw)} height={bH} rx="2" fill={clr[sp]||"#64748B"} opacity=".85"/><text x={pa.l+bw+4} y={y+bH/2+4} fill={C.txt} fontSize="10" fontFamily="monospace">{val.toFixed(2)}%</text></g>);})}</svg>);}

/* ══════════════════ UI COMPONENTS ══════════════════ */
const C={bg:"#0D1117",bg2:"#161B22",bg3:"#1C2128",border:"#30363D",accent:"#2DD4BF",accent2:"#FBBF24",accent3:"#60A5FA",warm:"#F87171",good:"#4ADE80",violet:"#A78BFA",orange:"#FB923C",strong:"#EF4444",txt:"#F0F6FC",txtDim:"#C9D1D9",txtMuted:"#8B949E",grid:"#21262D",axis:"#8B949E"};
const hs={box:{fontSize:10.5,lineHeight:1.55,color:C.txtDim,padding:"10px 12px",background:`${C.accent}08`,border:`1px solid ${C.accent}18`,borderRadius:6,marginBottom:10,fontFamily:"'Barlow',sans-serif"},em:{color:C.accent,fontWeight:600},warn:{color:C.accent2,fontWeight:600}};

// ── Help Components ──
function LinkChip({onBreak,label}){return(<div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:4,padding:"3px 7px",background:`${C.accent}15`,border:`1px solid ${C.accent}50`,borderRadius:4,fontSize:9.5,fontFamily:"monospace"}}>
  <span style={{color:C.accent}}>🔗 {label}</span>
  <button onClick={onBreak} title="Stop pulling this value from the Cycle panel" style={{padding:"1px 6px",fontSize:8.5,fontWeight:700,color:C.accent2,background:"transparent",border:`1px solid ${C.accent2}70`,borderRadius:3,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".4px"}}>BREAK</button>
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
          <input type="number" step="0.1" min="0" max="100" value={comp[sp]||""} placeholder="0" onChange={e=>{setComp(prev=>({...prev,[sp]:Math.max(0,parseFloat(e.target.value)||0)}));setPreset("");}} style={{...S.inp,padding:"4px 4px",fontSize:11,width:"100%",minWidth:0,textAlign:"right"}}/></div>))}
      </div>
      <div style={{marginTop:5,fontSize:10,fontFamily:"monospace",color:Math.abs(total-100)<0.1?C.good:C.accent2,textAlign:"right"}}>Σ={total.toFixed(1)}%{Math.abs(total-100)>0.1?" ⚠ Must sum to 100%":""}</div>
    </div>}</div>);}

const S={sel:{width:"100%",padding:"6px 7px",background:C.bg,border:`1px solid ${C.border}`,borderRadius:4,color:C.txt,fontSize:11.5,fontFamily:"monospace",outline:"none"},inp:{width:"100%",padding:"6px 7px",background:C.bg,border:`1px solid ${C.border}`,borderRadius:4,color:C.txt,fontSize:11.5,fontFamily:"monospace",outline:"none",boxSizing:"border-box"},card:{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:8,padding:"14px 16px",marginBottom:12},cardT:{fontSize:9.5,fontWeight:700,color:C.txtDim,textTransform:"uppercase",letterSpacing:"1.5px",marginBottom:10},row:{display:"flex",gap:8,flexWrap:"wrap"}};

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
function HelpModal({show,onClose}){if(!show)return null;return(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.7)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={onClose}>
  <div style={{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:12,padding:"24px 28px",maxWidth:620,maxHeight:"80vh",overflowY:"auto",color:C.txt,fontFamily:"'Barlow',sans-serif",fontSize:13,lineHeight:1.7}} onClick={e=>e.stopPropagation()}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
      <h2 style={{margin:0,fontSize:18,color:C.accent}}>Combustion Toolkit — User Guide</h2>
      <button onClick={onClose} style={{background:"none",border:"none",color:C.txtDim,fontSize:18,cursor:"pointer"}}>✕</button></div>
    <div style={{fontSize:12,color:C.txtDim,lineHeight:1.8}}>
      <p><strong style={{color:C.accent}}>Getting Started:</strong> Define your fuel and oxidizer compositions in the <strong>left sidebar</strong>. These are shared across ALL calculation tabs. Select a preset or enter custom mol% values. The total must equal 100%.</p>
      <p><strong style={{color:C.accent}}>Operating Conditions:</strong> Set the equivalence ratio (φ), inlet temperature, and pressure in the sidebar. φ=1.0 is stoichiometric, φ&lt;1 is lean, φ&gt;1 is rich.</p>
      <p><strong style={{color:C.accent}}>Unit System:</strong> Toggle between SI (K, atm, m/s, MJ/kg) and English (°F, psia, ft/s, BTU/lb) using the button in the header. All inputs, outputs, and charts update automatically.</p>
      <hr style={{border:"none",borderTop:`1px solid ${C.border}`,margin:"12px 0"}}/>
      <p><strong style={{color:C.accent2}}>🔥 Flame Temp & Properties:</strong> Computes adiabatic flame temperature via energy balance with NASA polynomials. Shows LHV, HHV, Wobbe Index, specific gravity, stoichiometric air-fuel ratios, and equilibrium product composition.</p>
      <p><strong style={{color:C.accent2}}>⚡ Flame Speed & Blowoff:</strong> Laminar flame speed from Gülder/Metghalchi-Keck correlations with mixture-weighted parameters. Blowoff analysis compares chemical and flow timescales via the Damköhler number (Da&gt;1 = stable).</p>
      <p><strong style={{color:C.accent2}}>🏭 Combustor PSR→PFR:</strong> Models a gas turbine combustor as a Perfectly Stirred Reactor (primary zone) feeding a Plug Flow Reactor (burnout zone). Computes thermal NOx via Zeldovich mechanism and CO burnout kinetics.</p>
      <p><strong style={{color:C.accent2}}>🔬 Exhaust Analysis:</strong> Back-calculates equivalence ratio and flame temperature from measured exhaust O₂ or CO₂ concentrations using iterative inversion of the equilibrium solver.</p>
      <p><strong style={{color:C.accent2}}>📊 Thermo Database:</strong> NASA 7-coefficient polynomial properties (Cp, H, S, G) for 14 species from 200–6000K.</p>
      <hr style={{border:"none",borderTop:`1px solid ${C.border}`,margin:"12px 0"}}/>
      <p><strong style={{color:C.accent}}>Export to Excel:</strong> Click "Export Excel" to download a comprehensive .xlsx report with all inputs, outputs, sweep data, and spatial profiles from every panel — organized into separate sheets.</p>
      <p><strong style={{color:C.accent}}>ℹ️ Inline Help:</strong> Click the "ℹ️ How It Works" buttons in each panel for methodology details. Hover over metric boxes with ⓘ icons for quick definitions.</p>
      <p style={{fontSize:10.5,color:C.txtMuted,marginTop:12}}>Calculations use NASA Glenn thermodynamic polynomials, Gülder flame speed correlations, global Arrhenius kinetics, and extended Zeldovich NOx mechanism. Results are for engineering estimation — detailed CFD and full chemical mechanisms (e.g., GRI-Mech) should be used for final design.</p>
    </div></div></div>);}

function PricingModal({show,onClose,onRequestSignin}){if(!show)return null;
  const {isAuthenticated,subscription}=useAuth();
  const [busy,setBusy]=useState(false);
  const [err,setErr]=useState(null);
  const currentTier=subscription?.tier||"free";
  const tiers=[
    {id:"free",name:"Free",price:"$0",period:"",features:["Online use at combustion-toolkit.proreadyengineer.com","Simplified model — accurate for φ ≤ 1.0 only","All 5 calculation panels + Excel export","NOT suitable for RQL or SAC combustion"],accent:C.txtDim},
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
// Prominent in-panel banner shown while one or more Cantera calls are in flight
// on the current panel. Sits INSIDE the panel's scrollable content so the user
// can't miss it (unlike the global fixed-position BusyOverlay, which may be
// scrolled off-screen or visually ignored). Pass any boolean(s) that represent
// an active calc — common pattern: <InlineBusyBanner loading={bk.loading}/>.
function InlineBusyBanner({loading, label="Calculations updating — please wait before trusting any number on this panel or exporting."}){
  if(!loading) return null;
  return(<div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 14px",
    background:`${C.warm}14`,border:`1px solid ${C.warm}60`,borderRadius:6,
    fontFamily:"'Barlow',sans-serif",fontSize:11.5,color:C.warm,marginBottom:6}}>
    <span style={{display:"inline-block",width:12,height:12,border:`2px solid ${C.warm}`,borderTopColor:"transparent",borderRadius:"50%",animation:"ctkspin 0.85s linear infinite",flexShrink:0}}/>
    <strong style={{fontWeight:700,letterSpacing:".3px"}}>CANTERA UPDATING</strong>
    <span style={{color:C.txtDim,fontWeight:400}}>— {label}</span>
  </div>);
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
const __BK_BUILD = (typeof __BUILD_SHA__ !== "undefined") ? __BUILD_SHA__ : "dev";
const __BK_LS_KEY = `ctk_bk_cache_${__BK_BUILD}`;
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
async function bkCachedFetch(kind, args){
  const fn = {aft:api.calcAFT, flame:api.calcFlameSpeed, combustor:api.calcCombustor,
    exhaust:api.calcExhaust, props:api.calcProps, autoignition:api.calcAutoignition,
    cycle:api.calcCycle, combustor_mapping:api.calcCombustorMapping}[kind];
  if(!fn) throw new Error(`bkCachedFetch: unknown kind ${kind}`);
  const cacheKey = `${kind}:${JSON.stringify(args||{})}`;
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
  const key=JSON.stringify(args||{});
  useEffect(()=>{
    if(!enabled){setData(null);setErr(null);setLoading(false);return;}
    const fn={aft:api.calcAFT,flame:api.calcFlameSpeed,combustor:api.calcCombustor,exhaust:api.calcExhaust,props:api.calcProps,autoignition:api.calcAutoignition,cycle:api.calcCycle,combustor_mapping:api.calcCombustorMapping}[kind];
    if(!fn){return;}
    const cacheKey = `${kind}:${key}`;
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
      <span style={{fontSize:15,fontWeight:700,letterSpacing:".5px",color:C.accent,fontFamily:"'Barlow Condensed',sans-serif"}}>CALCULATIONS IN PROGRESS — PLEASE WAIT</span>
      <span style={{fontSize:11,color:C.txtMuted,fontFamily:"monospace",marginLeft:"auto"}}>{secs}s</span>
    </div>
    <div style={{fontSize:11.5,color:C.txtDim,lineHeight:1.5,marginBottom:6}}>
      Cantera is updating the numbers on this page. Values on the screen may not yet reflect your latest inputs.
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
    <HelpBox title="ℹ️ Flame Temperature & Properties — How It Works"><p style={{margin:"0 0 6px"}}>This panel computes the <span style={hs.em}>adiabatic flame temperature</span> by solving an energy balance: total reactant enthalpy = total product enthalpy. Uses NASA 7-coefficient polynomials for temperature-dependent Cp and enthalpy.</p><p style={{margin:"0 0 6px"}}><span style={hs.em}>Complete Combustion:</span> Assumes all C→CO₂, all H→H₂O. No dissociation — gives the theoretical maximum T. <span style={hs.em}>Chemical Equilibrium:</span> Solves 4 dissociation reactions (CO₂⇌CO+½O₂, H₂O⇌H₂+½O₂, ½N₂+½O₂⇌NO, ½H₂+½O₂⇌OH) via Gibbs free energy Kp iteration. Gives realistic T with dissociation species (CO, OH, NO, H₂) in products.</p><p style={{margin:0}}>All values use the <span style={hs.warn}>fuel and oxidizer compositions</span> defined in the sidebar.</p></HelpBox>
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
      <div style={S.card}><div style={S.cardT}>T_ad vs Equivalence Ratio</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>Yellow marker shows current φ. Peak T_ad typically occurs near φ≈1.05 due to dissociation effects.</div><Chart data={sweep} xK="phi" yK="T_ad" xL="Equivalence Ratio (φ)" yL={`Temperature (${uu(units,"T")})`} color={C.accent} marker={mk}/></div>
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

function FlameSpeedPanel({fuel,ox,phi,T0,P,Tfuel,WFR=0,waterMode="liquid",velocity,setVelocity,Lchar,setLchar,Dfh,setDfh,Lpremix,setLpremix,Vpremix,setVpremix}){
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
  const [flameActive,setFlameActive]=useState(false);
  const [canteraSweeps,setCanteraSweeps]=useState(null);  // {hash, phi:[...], T:[...], P:[...]}
  const [sweepErr,setSweepErr]=useState(null);
  const [sweepRunning,setSweepRunning]=useState(false);
  // useMemo / useBackendCalc — short-circuit when !flameActive
  const Tmix=useMemo(()=>flameActive?mixT(fuel,ox,phi,Tfuel,Tair):0,[flameActive,fuel,ox,phi,Tfuel,Tair]);
  const bk=useBackendCalc("flame",{fuel:nonzero(fuel),oxidizer:nonzero(ox),phi,T0,P:atmToBar(P),domain_length_m:0.03,T_fuel_K:Tfuel,T_air_K:Tair,WFR,water_mode:waterMode},accurate&&flameActive);
  const bkIgn=useBackendCalc("autoignition",{fuel:nonzero(fuel),oxidizer:nonzero(ox),phi,T0,P:atmToBar(P),max_time_s:10.0,T_fuel_K:Tfuel,T_air_K:Tair,mechanism:"gri30",WFR,water_mode:waterMode},accurate&&flameActive);
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
  // Zukoski blow-off time (s): τ_BO = D_flameholder / (1.5 · S_L). Longer = more flashback-resistant.
  const tau_BO=Dfh/Math.max(1.5*SL_ms,1e-20);
  // Thermal diffusivity of unburnt mixture (m²/s). Prefer Cantera α_th from the flame response.
  const alphaTh=(accurate&&bk.data&&bk.data.alpha_th_u)?bk.data.alpha_th_u:alphaThU(Tmix,P);
  // Lewis–von Elbe critical boundary-velocity gradient (1/s): g_c = S_L² / α_th. Higher g_c = higher flashback resistance.
  const g_c=(SL_ms*SL_ms)/Math.max(alphaTh,1e-20);
  // Autoignition delay (s).
  //   Accurate mode → Cantera 0D const-P reactor; if the run reaches its cutoff without ignition,
  //                   we report τ_ign > cutoff and use the cutoff as a conservative lower bound
  //                   for the margin (never fall through to the NG-only correlation).
  //   Free mode     → Spadaccini–Colket NG correlation. Suppressed for fuels with H2>5% or
  //                   non-hydrocarbon species, where the correlation is outside its calibration.
  const H2_frac=(fuel.H2||0)/Math.max(Object.values(fuel).reduce((a,b)=>a+b,0),1e-9);
  const nonNGFuel=H2_frac>0.05||(fuel.CO||0)>0.01||(fuel.NH3||0)>0;
  const freeCorrValid=!nonNGFuel;
  const accurateIgn=accurate&&bkIgn.data;
  const tau_ign_source=accurateIgn?"cantera":(freeCorrValid?"spad_colk":"none");
  let tau_ign, tau_ign_is_lower_bound;
  if(accurateIgn){tau_ign=bkIgn.data.tau_ign_s;tau_ign_is_lower_bound=!bkIgn.data.ignited;}
  else if(freeCorrValid){tau_ign=calcTauIgnFree(Tmix,P);tau_ign_is_lower_bound=false;}
  else{tau_ign=NaN;tau_ign_is_lower_bound=false;}
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
    <HelpBox title="ℹ️ Flame Speed & Blowoff — How It Works"><p style={{margin:"0 0 6px"}}><span style={hs.em}>Laminar Flame Speed (S_L)</span> is computed using Gülder/Metghalchi-Keck empirical correlations: S_L = S_L0 · f(φ) · (T_u/T_0)^α · (P/P_0)^β. For mixtures, species contributions are mole-fraction-weighted.</p><p style={{margin:"0 0 6px"}}><span style={hs.em}>Blowoff Analysis:</span> τ_chem = α_th / S_L² (chemical timescale), τ_flow = L_char / V (flow timescale). The <span style={hs.em}>Damköhler number Da = τ_flow / τ_chem</span>. When Da &lt; 1, the flame cannot sustain itself and blows off.</p><p style={{margin:0}}><span style={hs.warn}>V_ref</span> is your reference approach velocity. <span style={hs.warn}>L_char</span> is the characteristic recirculation length (typically flameholder diameter or step height).</p></HelpBox>
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
    <div style={S.card}><div style={S.cardT}>Premixer Stability — Flashback & Autoignition {accurate&&(bkIgn.loading?<span style={{fontSize:10,color:C.accent2,marginLeft:8,fontFamily:"monospace"}}>⟳ CANTERA 0D…</span>:bkIgn.err?<span style={{fontSize:10,color:C.warm,marginLeft:8,fontFamily:"monospace"}}>⚠ {bkIgn.err}</span>:bkIgn.data?<span style={{fontSize:10,color:C.accent,marginLeft:8,fontFamily:"monospace",fontWeight:700}}>✓ CANTERA (0D const-P reactor)</span>:null)}</div>
      <div style={{...S.row,gap:8,marginBottom:10}}>
        <M l="Zukoski BOT (τ_BO)" v={(tau_BO*1000).toFixed(3)} u="ms" c={C.accent3} tip="Zukoski blow-off / flashback time: τ_BO = D_flameholder / (1.5·S_L). Longer τ_BO indicates the flameholder is less prone to flashback."/>
        <M l="Thermal Diffusivity (α_th)" v={(alphaTh*1e6).toFixed(2)} u="mm²/s" c={C.violet} tip={`Thermal diffusivity of unburnt mixture at T_mixed. α_th = k/(ρ·c_p). ${accurate&&bk.data&&bk.data.alpha_th_u?"Value from Cantera transport model.":"Free-mode approximation: α_th = 2.0e-5·(T/300)^1.7/P[atm]."}`}/>
        <M l="Lewis-von Elbe g_c" v={g_c.toFixed(0)} u="1/s" c={C.accent} tip="Lewis–von Elbe critical boundary velocity gradient: g_c = S_L² / α_th. Flame flashes back if actual near-wall velocity gradient falls below g_c. Higher g_c = more flashback-resistant."/>
        <M l="Autoignition Delay (τ_ign)" v={tau_ign_source==="none"?"N/A":(tau_ign_is_lower_bound?">":"")+(tau_ign*1000).toFixed(tau_ign<1?3:tau_ign<10?2:1)} u={tau_ign_source==="none"?"—":"ms"} c={tau_ign_source==="none"?C.txtMuted:C.accent2} tip={tau_ign_source==="cantera"?(bkIgn.data.ignited?"Ignition delay time from Cantera 0D const-P reactor (max dT/dt criterion) — first-principles kinetics from GRI-Mech 3.0.":`Mixture did not ignite within the ${(bkIgn.data.tau_ign_s).toFixed(1)} s integration window — τ_ign is at least this value, and the displayed margin is a lower bound.`):tau_ign_source==="spad_colk"?"Free-mode Spadaccini–Colket NG correlation: τ_ign = 3.09e-5·P^-1.12·exp(20130/T). Valid for natural-gas-like fuels only.":`Free-mode τ_ign correlation is disabled — this fuel contains ${(H2_frac*100).toFixed(0)}% H₂ or CO/NH₃ components. The Spadaccini-Colket correlation is calibrated for pure NG and is unreliable here. Switch to Accurate mode for Cantera 0D.`}/>
        <M l="Premixer Residence (τ_res)" v={(tau_res*1000).toFixed(3)} u="ms" c={C.accent3} tip="Premixer residence time: τ_res = L_premix / V_premix. Must be shorter than τ_ign to avoid autoignition inside the premixer."/>
        <M l="Safety Margin (τ_ign/τ_res)" v={!isFinite(ignition_margin)?"N/A":(tau_ign_is_lower_bound?">":"")+(ignition_margin>=1e4?ignition_margin.toExponential(1):ignition_margin.toFixed(1))} u="—" c={tau_ign_source==="none"?C.txtMuted:(ignition_safe?C.good:C.warm)} tip={tau_ign_is_lower_bound?"Lower bound on the safety margin — Cantera did not observe ignition within the integration window, so τ_ign (and therefore the margin) is at least this value.":"Ratio τ_ign / τ_res. Values > 3 indicate a robust margin against premixer autoignition. Values < 1 indicate the mixture can autoignite before leaving the premixer."}/>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",flex:"0 0 auto",padding:"0 10px"}}>
          <Tip text={`PREMIXER SAFE requires BOTH criteria:\n  1) Autoignition margin τ_ign/τ_res ≥ 3 (robust; 1–3 marginal; <1 fails).\n  2) Core-flashback margin V_premix / S_T > 1/0.7 ≈ 1.43, where S_T ≈ S_L·${turb_factor.toFixed(1)} (${H2_frac>0.30?"H₂>30% — includes turbulent wrinkling + Le<1 thermodiffusive":"Le≈1 — turbulent wrinkling only"}).\nFor detailed design replace S_T with measured / CFD values.`}>
            <span style={{padding:"3px 10px",borderRadius:16,fontSize:10,fontWeight:600,fontFamily:"monospace",cursor:"help",background:tau_ign_source==="none"?`${C.txtMuted}1F`:(premixer_safe?`${C.good}1F`:`${C.warm}1F`),color:tau_ign_source==="none"?C.txtMuted:(premixer_safe?C.good:C.warm),border:`1px solid ${tau_ign_source==="none"?C.txtMuted+"44":(premixer_safe?C.good+"44":C.warm+"44")}`}}>{tau_ign_source==="none"?"● NEEDS ACCURATE MODE":"● "+risk_label} ⓘ</span></Tip></div>
      </div>
      <div style={{...S.row,gap:8,marginBottom:10}}>
        <M l="Turbulent S_T Estimate" v={uv(units,"vel",S_T_est).toFixed(2)} u={uu(units,"vel")} c={C.violet} tip={`Screening estimate of turbulent flame speed: S_T ≈ S_L · ${turb_factor.toFixed(1)}. Factor ${turb_factor.toFixed(1)} accounts for ${H2_frac>0.30?"turbulent wrinkling AND Le<1 thermodiffusive acceleration (H₂ > 30%)":"turbulent wrinkling only (Le ≈ 1 hydrocarbons)"}. Replace with measured / CFD S_T for detailed design.`}/>
        <M l="V_premix (for flashback)" v={uv(units,"vel",Vpremix).toFixed(2)} u={uu(units,"vel")} c={C.accent3} tip="Bulk velocity of the premixed mixture through the premixer channel. For the flame to not travel upstream, V_premix must exceed the turbulent flame speed S_T with margin."/>
        <M l="Flashback Margin (V/S_T)" v={!isFinite(flashback_margin)?"N/A":flashback_margin.toFixed(2)} u="—" c={core_flashback_safe?C.good:C.warm} tip="Core flashback margin: V_premix / S_T. Must exceed 1/0.7 ≈ 1.43 for a 30% speed margin over the turbulent flame. Values < 1 mean the flame will propagate upstream into the premixer."/>
        <M l="S_T Model" v={H2_frac>0.30?"H₂ Le<1":"Le≈1"} u="—" c={h2_thermodiffusive_warn?C.warm:C.txtDim} tip={h2_thermodiffusive_warn?"Fuel is H₂-rich (>30%). Lewis number Le < 1 → thermodiffusive instability accelerates the turbulent flame (wrinkled cellular structure). The 2.5× factor is a conservative screening value; actual S_T/S_L can exceed 3 for very lean H₂.":"Fuel Lewis number ≈ 1 (hydrocarbon-like). S_T ≈ 1.8·S_L reflects standard turbulent-wrinkling enhancement."}/>
      </div>
      <div style={{marginTop:-4,background:`${C.accent}0A`,border:`1px solid ${C.border}`,borderRadius:5,padding:"7px 11px",fontSize:10.5,color:C.txtDim,fontFamily:"monospace",lineHeight:1.5}}>
        <strong style={{color:C.accent}}>ℹ PREMIXER SAFE — what it checks &amp; assumes:</strong><br/>
        &nbsp;&nbsp;• <strong>Autoignition (0D kinetics):</strong> Cantera const-P reactor on the perfectly mixed fuel+air stream at P, φ, T_mixed from the sidebar. Gate: τ_ign/τ_res ≥ 3.<br/>
        &nbsp;&nbsp;• <strong>Core flashback (1D laminar + turbulence factor):</strong> Cantera 1D FreeFlame gives S_L; S_T = S_L · {turb_factor.toFixed(1)} ({H2_frac>0.30?"H₂-rich: turb-wrinkling + Le<1 thermodiffusive":"hydrocarbon: turb-wrinkling only"}). Gate: V_premix / S_T &gt; 1/0.7 ≈ 1.43.<br/>
        &nbsp;&nbsp;• <strong>Not checked here:</strong> boundary-layer flashback (see g_c above), combustion-induced-vortex-breakdown (CIVB), acoustic-driven flashback, or wall-temperature/quenching effects. Use CFD + rig data for detailed design.
      </div>
      <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
        <div style={{display:"flex",alignItems:"center",gap:5}}><Tip text="Flameholder diameter (bluff body, burner rod, or swirler hub diameter). Used for Zukoski τ_BO."><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>D_flameholder ({uu(units,"len")}) ⓘ:</label></Tip>
          <NumField value={uv(units,"len",Dfh)} decimals={4} onCommit={v=>setDfh(uvI(units,"len",v))} style={{...S.inp,width:75}}/></div>
        <div style={{display:"flex",alignItems:"center",gap:5}}><Tip text="Premixer channel length from fuel injection point to flame front. Determines residence time of unburnt mixture."><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>L_premix ({uu(units,"len")}) ⓘ:</label></Tip>
          <NumField value={uv(units,"len",Lpremix)} decimals={4} onCommit={v=>setLpremix(uvI(units,"len",v))} style={{...S.inp,width:75}}/></div>
        <div style={{display:"flex",alignItems:"center",gap:5}}><Tip text="Bulk velocity of the premixed mixture through the premixer channel."><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>V_premix ({uu(units,"vel")}) ⓘ:</label></Tip>
          <NumField value={uv(units,"vel",Vpremix)} decimals={2} onCommit={v=>setVpremix(uvI(units,"vel",v))} style={{...S.inp,width:65}}/></div>
      </div>
      {!accurate&&freeCorrValid&&<div style={{marginTop:8,background:`${C.txtMuted}10`,border:`1px solid ${C.border}`,borderRadius:5,padding:"6px 10px",fontSize:10,color:C.txtMuted,fontFamily:"monospace",lineHeight:1.45}}>ℹ τ_ign uses the Spadaccini–Colket NG correlation — order-of-magnitude only, valid for NG-like fuels. Switch to <strong>Accurate</strong> mode for Cantera 0D constant-pressure reactor integration.</div>}
      {!accurate&&!freeCorrValid&&<div style={{marginTop:8,background:`${C.warm}12`,border:`1px solid ${C.warm}44`,borderRadius:5,padding:"7px 11px",fontSize:10.5,color:C.warm,fontFamily:"monospace",lineHeight:1.45}}>⚠ This fuel contains {(H2_frac*100).toFixed(0)}% H₂ (or CO / NH₃). The free-mode Spadaccini–Colket τ_ign correlation is calibrated for pure natural gas and gives unreliable values for H₂ blends — it has been suppressed. Switch to <strong>Accurate</strong> mode for first-principles Cantera 0D kinetics.</div>}
      {accurate&&bkIgn.data&&!bkIgn.data.ignited&&<div style={{marginTop:8,background:`${C.accent}10`,border:`1px solid ${C.accent}44`,borderRadius:5,padding:"7px 11px",fontSize:10.5,color:C.txtDim,fontFamily:"monospace",lineHeight:1.45}}>ℹ Cantera 0D integrated for {bkIgn.data.tau_ign_s.toFixed(1)} s without the mixture igniting (T_peak rose from {bkIgn.data.T_mixed_inlet_K.toFixed(0)} to {bkIgn.data.T_peak.toFixed(0)} K). τ_ign is therefore at least {bkIgn.data.tau_ign_s.toFixed(1)} s — the premixer margin shown is a <em>lower bound</em>. Very long τ_ign indicates the mixture is thermo-kinetically stable at T_mixed and cannot autoignite within the premixer.</div>}
      {h2_thermodiffusive_warn&&<div style={{marginTop:8,background:`${C.warm}12`,border:`1px solid ${C.warm}55`,borderRadius:5,padding:"7px 11px",fontSize:10.5,color:C.warm,fontFamily:"monospace",lineHeight:1.45}}>⚠ <strong>H₂-rich fuel ({(H2_frac*100).toFixed(0)}%) — Lewis-number advisory:</strong> Le &lt; 1 drives thermodiffusive instability and cellular flame structure, which can increase real S_T/S_L well beyond the 2.5× screening factor used here (measured values up to 3–4× for very lean H₂). The flashback margin shown is a <em>best-case</em> estimate; verify with rig data or CFD before committing to a premixer geometry.</div>}
    </div>
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
          <>Accurate mode is off — curves below are computed with the in-browser Gülder/Metghalchi-Keck correlation. Switch to <strong>Accurate</strong> mode and click <strong>Run Cantera Sweep Curves</strong> to replace these trends with first-principles Cantera solves.</>
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
      <div style={S.card}><div style={S.cardT}>Laminar Flame Speed vs Equivalence Ratio</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>Peak S_L occurs near stoichiometric (slightly rich for hydrocarbons, φ≈1.8 for H₂).</div><Chart data={sweep} xK="phi" yK="SL" xL="Equivalence Ratio (φ)" yL={`Flame Speed (${uu(units,"SL")})`} color={C.violet} marker={mk}/></div>
      <div style={S.card}><div style={S.cardT}>Damköhler Number vs Flow Velocity</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>Da decreases linearly with velocity. Below Da=1 (horizontal line), blowoff occurs.</div><Chart data={daSw} xK="V" yK="Da" xL={`Velocity (${uu(units,"vel")})`} yL="Damköhler Number" color={C.accent2}/></div>
      <div style={S.card}><div style={S.cardT}>Flame Speed vs Pressure</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>S_L decreases with pressure (exponent β ≈ -0.3 to -0.4 for hydrocarbons).</div><Chart data={pSw} xK="P" yK="SL" xL={`Pressure (${uu(units,"P")})`} yL={`Flame Speed (${uu(units,"SL")})`} color={C.accent3}/></div>
      <div style={S.card}><div style={S.cardT}>Flame Speed vs Unburned Temperature</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>S_L increases strongly with preheat temperature (exponent α ≈ 1.5–2.0).</div><Chart data={tSw} xK="T" yK="SL" xL={`Unburned Temperature (${uu(units,"T")})`} yL={`Flame Speed (${uu(units,"SL")})`} color={C.accent}/></div>
    </div></div>);}

function CombustorPanel({fuel,ox,phi,T0,P,tau,setTau,Lpfr,setL,Vpfr,setV,Tfuel,setTfuel,WFR=0,waterMode="liquid",psrSeed,setPsrSeed,eqConstraint,setEqConstraint,integration,setIntegration,heatLossFrac,setHeatLossFrac,mechanism,setMechanism}){
  const units=useContext(UnitCtx);
  const {accurate}=useContext(AccurateCtx);
  // Cantera PSR+PFR is the slowest backend call (~3-5 s). Off by default —
  // user clicks the green ACTIVATE button to fire it. While inactive, the
  // panel stays dimmed so the user knows nothing is being computed.
  const[psrActive,setPsrActive]=useState(false);
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
    <HelpBox title="ℹ️ Combustor Network — Methodology"><p style={{margin:"0 0 6px"}}>Models the combustor as a <span style={hs.em}>PSR (primary zone)</span> feeding a <span style={hs.em}>PFR (burnout zone)</span>. The <strong>thermochemistry</strong> (T_ad, equilibrium composition) is computed by Newton-Raphson on 6 dissociation reactions with NASA 7-coefficient polynomials — rigorous to &lt;0.2% vs Cantera.</p><p style={{margin:"0 0 6px"}}><span style={hs.em}>PSR T:</span> hot-branch (T_eq) gated by a sigmoid in log(τ/τ_ig) — captures blowoff but not partial-conversion states. <span style={hs.em}>PSR NO:</span> empirical prompt/N₂O floor + thermal Zeldovich with partial-equilibrium [O]. <span style={hs.em}>PSR CO:</span> empirical A·exp(14000/T)/τ·(27/P). <span style={hs.em}>PFR:</span> first-order CO burnout (k = 1.44e6·exp(−125000/RT) /s) + Zeldovich NO growth at local T.</p><p style={{margin:0}}><span style={hs.warn}>τ_PSR</span> = primary-zone residence time (ms). <span style={hs.warn}>L_PFR</span> = burnout-zone length. <span style={hs.warn}>V_PFR</span> = mean axial velocity. NOx is corrected to 15% O₂ dry per regulatory standard (ISO 11042, 40 CFR §60).</p></HelpBox>
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
              : "Free-version constant-cp approximation (cp_fuel≈2.2, cp_air≈1.005 kJ/kg·K). Switch to ACCURATE for the exact Cantera enthalpy balance."}
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
        <M l="NOx @ 15% O₂" v={net.NO_ppm_15O2.toFixed(1)} u="ppmvd" c={C.strong} tip="NOx corrected to 15% O₂ dry — the standard regulatory reporting basis for gas turbines and boilers."/>
        <M l="CO at Exit" v={net.CO_ppm_exit.toFixed(1)} u="ppm" c={C.accent2} tip="Carbon monoxide at exit (wet, actual O₂). High CO indicates incomplete combustion — reduce φ, increase τ, or lengthen PFR."/>
        <M l="CO @ 15% O₂" v={net.CO_ppm_15O2.toFixed(1)} u="ppmvd" c={C.orange} tip="CO corrected to 15% O₂ dry — the same regulatory reporting basis used for NOx. Formula: CO × (20.95−15)/(20.95−O₂_dry)."/>
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
      <div style={S.card}><div style={S.cardT}>NOx & CO @ 15% O₂ (PSR → PFR)</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>All ppm values corrected to 15% O₂ dry (regulatory reporting basis). Solid: NOx (flat across PSR, grows linearly in PFR via Zeldovich). Dashed: CO (PSR floor, first-order burnout in PFR). Vertical dashed line marks the PSR/PFR boundary.</div><Chart data={pfrDisp} xK="x" yK="NO_ppm_15O2" xL={`Position along combustor (${uu(units,"lenSmall")})`} yL="NOx @ 15% O₂ (ppmvd)" color={C.warm} y2K="CO_ppm_15O2" c2={C.accent2} y2L="CO @ 15% O₂ (ppmvd)" vline={uv(units,"lenSmall",net.L_psr_cm)}/></div>
    </div>
    <div style={S.card}><div style={S.cardT}>Emissions vs Equivalence Ratio</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>Classic NOx-CO tradeoff: lean mixtures reduce NOx but increase CO. Lean premixed combustors operate at φ ≈ 0.5–0.6 for low emissions.</div><Chart data={emSw} xK="phi" yK="NO" xL="Equivalence Ratio (φ)" yL="NOx @ 15% O₂ (ppm)" color={C.warm} y2K="CO" c2={C.accent2} y2L="CO (ppm)" w={700} h={270}/></div>
    </>}
  </div>);}

function ExhaustPanel({fuel,ox,T0,P,Tfuel,WFR=0,waterMode="liquid",measO2,setMeasO2,measCO2,setMeasCO2,combMode,setCombMode}){
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
  const o2Sweep=useMemo(()=>{const r=[];for(let o2=0.5;o2<=15;o2+=0.5){const Tm0=mixT(fuel,ox,0.6,Tfuel,Tair);const res0=calcExhaustFromO2(fuel,ox,o2,Tm0,P,combMode);const Tm1=mixT(fuel,ox,res0.phi,Tfuel,Tair);const res=calcExhaustFromO2(fuel,ox,o2,Tm1,P,combMode);r.push({O2:o2,T_ad:uv(units,"T",res.T_ad),phi:res.phi});}return r;},[fuel,ox,Tfuel,Tair,P,combMode,units]);
  const modeToggle=<div style={{display:"flex",border:`1px solid ${C.border}`,borderRadius:5,overflow:"hidden",marginBottom:10}}>
    {["complete","equilibrium"].map(m=><button key={m} onClick={()=>setCombMode(m)} style={{padding:"6px 12px",fontSize:10.5,fontWeight:combMode===m?700:400,color:combMode===m?C.bg:C.txtDim,background:combMode===m?C.accent:"transparent",border:"none",cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".4px",transition:"all .15s"}}>{m==="complete"?"Complete Combustion":"Chemical Equilibrium"}</button>)}
  </div>;
  const status=(kbk)=>accurate?(kbk.loading?<span style={{fontSize:10,color:C.accent2,marginLeft:8,fontFamily:"monospace"}}>⟳ CANTERA…</span>:kbk.err?<span style={{fontSize:10,color:C.warm,marginLeft:8,fontFamily:"monospace"}}>⚠ {kbk.err}</span>:kbk.data?<span style={{fontSize:10,color:C.accent,marginLeft:8,fontFamily:"monospace",fontWeight:700}}>✓ CANTERA</span>:null):null;
  return(<div style={{display:"flex",flexDirection:"column",gap:12}}>
    <InlineBusyBanner loading={accurate&&(bkO2.loading||bkCO2.loading)}/>
    <HelpBox title="ℹ️ Exhaust Analysis — How It Works"><p style={{margin:"0 0 6px"}}>Enter a <span style={hs.em}>measured exhaust O₂ or CO₂ concentration</span> (dry basis, %) from a stack analyzer or CEMS. The tool iteratively solves for the equivalence ratio (φ) that produces that exhaust composition.</p><p style={{margin:"0 0 6px"}}>Two inversions are shown side-by-side: <span style={hs.em}>Complete Combustion</span> (no dissociation — all C → CO₂, all H → H₂O) and <span style={hs.em}>Chemical Equilibrium</span> (Cantera full-Gibbs, includes CO, OH, NO at high T).</p><p style={{margin:0}}><span style={hs.warn}>Which to use:</span> Pick <strong style={{color:C.orange}}>Complete Combustion</strong> for <strong>stack measurements</strong> (gas has cooled, dissociation products recombined). Also pick it for <strong>combustor-exit measurements</strong> unless <em>combustor_air_frac = 1</em> (no dilution). The lower combustor_air_frac drops below 1, the better complete combustion represents reality. Use <strong style={{color:C.accent}}>Equilibrium</strong> only for in-flame readings at the primary zone with no dilution.</p></HelpBox>
    {accurate?null:modeToggle}
    {/* ============== FROM MEASURED O2 ============== */}
    <div style={S.card}>
      <div style={{...S.cardT,display:"flex",alignItems:"center",gap:8}}>From Measured O₂ (% dry) {status(bkO2)}
        <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:6}}>
          <Tip text="Enter the measured O₂ concentration in the exhaust on a dry basis. Typical values: 2–6% for gas turbines, 3–8% for boilers."><label style={{fontSize:11,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>Meas. O₂ (% dry) ⓘ</label></Tip>
          <NumField value={measO2} decimals={2} onCommit={setMeasO2} style={{...S.inp,width:70}}/>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:accurate&&rO2.cc?"1fr 1fr":"1fr",gap:12}}>
        {accurate&&rO2.cc?<div style={{padding:12,background:`${C.orange}0A`,border:`1px solid ${C.orange}40`,borderRadius:6}}>
          <div style={{fontSize:11,fontWeight:700,color:C.orange,textTransform:"uppercase",letterSpacing:"1.2px",marginBottom:8}}>Complete Combustion <span style={{fontSize:9,fontWeight:500,color:C.txtMuted,textTransform:"none"}}>— stack / diluted-exit readings</span></div>
          <div style={{...S.row,gap:6}}>
            <M l="Equivalence Ratio (φ)" v={rO2.cc.phi.toFixed(3)} u="—" c={C.orange} tip="Inverted assuming no dissociation."/>
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
          <div style={{fontSize:11,fontWeight:700,color:C.accent,textTransform:"uppercase",letterSpacing:"1.2px",marginBottom:8}}>Chemical Equilibrium <span style={{fontSize:9,fontWeight:500,color:C.txtMuted,textTransform:"none"}}>— in-flame, air_frac = 1</span></div>
          <div style={{...S.row,gap:6}}>
            <M l="Equivalence Ratio (φ)" v={rO2.phi.toFixed(3)} u="—" c={C.accent} tip="Inverted using full Cantera HP equilibrium (includes CO, OH, NO dissociation)."/>
            <M l="Flame Temperature" v={uv(units,"T",rO2.T_ad).toFixed(0)} u={uu(units,"T")} c={C.accent} tip="T_ad under the full-equilibrium assumption."/>
            <M l="Fuel/Air (mass)" v={rO2.FAR_mass.toFixed(4)} u={uu(units,"afr_mass")} c={C.accent} tip="Fuel/air mass ratio from equilibrium inversion."/>
            <M l="Air/Fuel (mass)" v={(1/(rO2.FAR_mass+1e-20)).toFixed(2)} u={uu(units,"afr_mass")} c={C.accent} tip="Air/fuel mass ratio."/>
          </div>
          {rO2.products&&<div style={{marginTop:10}}>
            <div style={{fontSize:10,fontWeight:700,color:C.accent,textTransform:"uppercase",letterSpacing:"1px",marginBottom:4}}>Products — Wet Basis</div>
            <HBar data={rO2.products} h={Math.max(100,Object.keys(rO2.products).length*20+8)} w={380}/>
            <div style={{fontSize:10,fontWeight:700,color:C.accent,textTransform:"uppercase",letterSpacing:"1px",margin:"8px 0 4px"}}>Dry Basis (H₂O removed)</div>
            <HBar data={dryBasis(rO2.products)} h={Math.max(90,Math.max(0,Object.keys(rO2.products).length-1)*20+8)} w={380}/>
          </div>}
        </div>
      </div>
    </div>

    {/* ============== FROM MEASURED CO2 ============== */}
    <div style={S.card}>
      <div style={{...S.cardT,display:"flex",alignItems:"center",gap:8}}>From Measured CO₂ (% dry) {status(bkCO2)}
        <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:6}}>
          <Tip text="Enter the measured CO₂ concentration in the exhaust on a dry basis. Higher CO₂ indicates richer combustion."><label style={{fontSize:11,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>Meas. CO₂ (% dry) ⓘ</label></Tip>
          <NumField value={measCO2} decimals={2} onCommit={setMeasCO2} style={{...S.inp,width:70}}/>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:accurate&&rCO2.cc?"1fr 1fr":"1fr",gap:12}}>
        {accurate&&rCO2.cc?<div style={{padding:12,background:`${C.orange}0A`,border:`1px solid ${C.orange}40`,borderRadius:6}}>
          <div style={{fontSize:11,fontWeight:700,color:C.orange,textTransform:"uppercase",letterSpacing:"1.2px",marginBottom:8}}>Complete Combustion <span style={{fontSize:9,fontWeight:500,color:C.txtMuted,textTransform:"none"}}>— stack / diluted-exit readings</span></div>
          <div style={{...S.row,gap:6}}>
            <M l="Equivalence Ratio (φ)" v={rCO2.cc.phi.toFixed(3)} u="—" c={C.orange} tip="Inverted assuming no dissociation."/>
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
          <div style={{fontSize:11,fontWeight:700,color:C.accent,textTransform:"uppercase",letterSpacing:"1.2px",marginBottom:8}}>Chemical Equilibrium <span style={{fontSize:9,fontWeight:500,color:C.txtMuted,textTransform:"none"}}>— in-flame, air_frac = 1</span></div>
          <div style={{...S.row,gap:6}}>
            <M l="Equivalence Ratio (φ)" v={rCO2.phi.toFixed(3)} u="—" c={C.accent} tip="Inverted using full Cantera HP equilibrium."/>
            <M l="Flame Temperature" v={uv(units,"T",rCO2.T_ad).toFixed(0)} u={uu(units,"T")} c={C.accent} tip="T_ad under the full-equilibrium assumption."/>
            <M l="Fuel/Air (mass)" v={rCO2.FAR_mass.toFixed(4)} u={uu(units,"afr_mass")} c={C.accent} tip="Fuel/air mass ratio from equilibrium inversion."/>
            <M l="Air/Fuel (mass)" v={(1/(rCO2.FAR_mass+1e-20)).toFixed(2)} u={uu(units,"afr_mass")} c={C.accent} tip="Air/fuel mass ratio."/>
          </div>
          {rCO2.products&&<div style={{marginTop:10}}>
            <div style={{fontSize:10,fontWeight:700,color:C.accent,textTransform:"uppercase",letterSpacing:"1px",marginBottom:4}}>Products — Wet Basis</div>
            <HBar data={rCO2.products} h={Math.max(100,Object.keys(rCO2.products).length*20+8)} w={380}/>
            <div style={{fontSize:10,fontWeight:700,color:C.accent,textTransform:"uppercase",letterSpacing:"1px",margin:"8px 0 4px"}}>Dry Basis (H₂O removed)</div>
            <HBar data={dryBasis(rCO2.products)} h={Math.max(90,Math.max(0,Object.keys(rCO2.products).length-1)*20+8)} w={380}/>
          </div>}
        </div>
      </div>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <div style={S.card}><div style={S.cardT}>Flame Temperature vs Exhaust O₂</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>Higher exhaust O₂ → leaner combustion → lower flame temperature. Coral marker shows your measurement.</div><Chart data={o2Sweep} xK="O2" yK="T_ad" xL="Exhaust O₂ (%)" yL={`Flame Temperature (${uu(units,"T")})`} color={C.warm} marker={{x:measO2,y:uv(units,"T",rO2.T_ad),label:`${uv(units,"T",rO2.T_ad).toFixed(0)} ${uu(units,"T")}`}}/></div>
      <div style={S.card}><div style={S.cardT}>Equivalence Ratio vs Exhaust O₂</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>Direct mapping from exhaust O₂ to φ. At 0% O₂, φ ≈ 1.0 (stoichiometric).</div><Chart data={o2Sweep} xK="O2" yK="phi" xL="Exhaust O₂ (%)" yL="Equivalence Ratio (φ)" color={C.accent} marker={{x:measO2,y:rO2.phi,label:`φ=${rO2.phi.toFixed(3)}`}}/></div>
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
function AssumptionsPanel(){
  return(<div style={{display:"flex",flexDirection:"column",gap:12}}>
    <HelpBox title="ℹ️ How to read this page">
      <p style={{margin:"0 0 6px"}}>Every number below is baked into the cycle and combustion solvers. They are exposed here so you can audit them, map deviations, and know exactly what the app is and is not modeling.</p>
      <p style={{margin:"0 0 6px"}}><span style={hs.em}>In-spec for design-point anchors only.</span> LM6000PF and LMS100PB+ off-design behavior is driven by physical scaling (density lapse, humid-air R, load-line droop) anchored at a single published design point per engine.</p>
      <p style={{margin:0}}><span style={hs.warn}>Not a design tool.</span> The cycle is a reduced-order anchored correlation, not a station-by-station match of the OEM deck. Use high-fidelity tools for design, permitting, or emissions reporting.</p>
    </HelpBox>

    <AssumptionsGroup title="1. Ambient & Inlet" subtitle="Ambient state feeding the LP compressor inlet. No ram recovery, no inlet loss.">
      <Assumption label="Reference pressure" value="1.01325 bar" note="Sea-level ISA. Cycle input P_amb overrides for off-design."/>
      <Assumption label="Reference temperature" value="288.706 K (60 °F)" note="LM6000 ISO anchor. LMS100 anchored at 44 °F / 80% RH."/>
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
      <Assumption label="Combustor bypass fraction" value="LM6000: 0.683  /  LMS100: 0.747" note="Fraction of compressor discharge routed to the combustor core. Remainder is casing/HPT cooling. Private per-engine calibration so design-point MW and η land exactly."/>
      <Assumption label="Combustor air fraction (flame/total)" value="0.88 (both)" note="Flame zone gets 88% of combustor air; dilution zone gets 12%. FAR_Bulk = FAR4 / 0.88."/>
      <Assumption label="T4 target" value="LM6000: 1755 K  /  LMS100: 1825 K" note="Firing temperature. Commanded by the deck, not solved."/>
      <Assumption label="φ4 solve" value="Cantera equilibrate(&quot;HP&quot;)" note="Back-solved so equilibrium product T at (T3, P3) equals T4. No kinetics — equilibrium only."/>
      <Assumption label="T_Bulk (flame zone)" value="Cantera equilibrate(&quot;HP&quot;) at (T3, P3, φ_Bulk)" note="Adiabatic equilibrium. Drives downstream flame-speed / blowoff / autoignition panels when linked."/>
      <Assumption label="Heat loss" value="0%" note="Adiabatic combustor. The AFT panel has a separate heat-loss option for hand analysis."/>
    </AssumptionsGroup>

    <AssumptionsGroup title="6. Turbine" subtitle="Turbine work comes from an actual Cantera isentropic expansion — not a prescribed η_thermal. This is the core of Option A (energy-balance cycle).">
      <Assumption label="Isentropic efficiency η_isen,turb" value="LM6000: 0.7416  /  LMS100: 0.7640" note="Calibrated so MW_gross lands at MW_cap at the design anchor. Used for HPT + LPT combined (lumped)."/>
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
      <Assumption label="LM6000PF" value="45.0 MW @ 60 °F / 60% RH" note="T3 811 K · P3 30.3 bar · T4 1755 K · η_LHV 42.4% · HR 8493 BTU/kWh · no intercooler."/>
      <Assumption label="LMS100PB+" value="107.5 MW @ 44 °F / 80% RH" note="T3 644 K · P3 44.0 bar · T4 1825 K · η_LHV 44.0% · HR 8178 BTU/kWh · with intercooler."/>
      <Assumption label="Anchor method" value="Calibrate combustor_bypass_frac + eta_isen_turb" note="Two per-engine knobs fit both MW and η at anchor. Everything else is physical."/>
    </AssumptionsGroup>

    <AssumptionsGroup title="11. Off-design Scaling" subtitle="How the deck behaves away from its anchor. Not all of this is modeled — the list below states what IS.">
      <Assumption label="Density lapse" value="mdot_air ∝ ρ_amb · VGV(T_amb)" note="VGV is a simple function of ambient — folded into an engine-specific lapse curve."/>
      <Assumption label="LMS100 intercooler benefit" value="Architectural" note="LMS100 loses less on hot days than LM6000 because HPC inlet is fixed at T_cool_in. Verified in regression tests."/>
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
function CyclePanel({linkT3,setLinkT3,linkP3,setLinkP3,linkFAR,setLinkFAR,linkOx,setLinkOx,result,loading,err}){
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
      <p style={{margin:"0 0 6px"}}>Computes the thermodynamic cycle of a GE <span style={hs.em}>LM6000PF</span> or <span style={hs.em}>LMS100PB+</span> aero-derivative under the specified ambient and load. Uses published performance correlations <span style={hs.em}>anchored exactly at each engine's published design point</span>; ambient density and load scaling follow typical aero-derivative behavior.</p>
      <p style={{margin:"0 0 6px"}}>The combustor firing temperature <span style={hs.em}>T4</span> is commanded by the deck. <span style={hs.em}>φ₄</span> (and FAR₄) is back-solved via Cantera <code style={{background:`${C.accent}15`,padding:"1px 4px",borderRadius:3,fontFamily:"monospace"}}>equilibrate("HP")</code> at (T3, P3) so equilibrium product T = T4 — these are the <span style={hs.em}>combustor-exit</span> values after dilution mixing.</p>
      <p style={{margin:"0 0 6px"}}>The primary flame sees only a fraction of the combustor air — set by <span style={hs.em}>Combustor Air Fraction</span>. The flame-zone (bulk) values are <span style={hs.em}>FAR_Bulk = FAR₄ / frac</span>, <span style={hs.em}>φ_Bulk = φ₄ / frac</span>, and <span style={hs.em}>T_Bulk</span> = HP-adiabatic equilibrium T at (T3, P3, φ_Bulk). These drive the Flame Temp / Flame Speed / PSR-PFR / Blowoff / Exhaust panels when linked. The split does <span style={hs.em}>not</span> affect engine efficiency.</p>
      <p style={{margin:0}}><span style={hs.em}>Linkages:</span> the four toggles pipe T3, P3, φ_Bulk, and humid-air oxidizer into the sidebar so every other tab (AFT, flame speed, combustor, exhaust, autoignition) runs at the engine's actual flame-zone state. Each toggle has a <span style={hs.warn}>Break link</span> button to reclaim manual control.</p>
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
        {[
          {on:linkT3,set:setLinkT3,label:"Air Temperature → T3",tip:"Sidebar Air Temperature (K) ← cycle T3 (combustor inlet / HPC exit)"},
          {on:linkP3,set:setLinkP3,label:"Pressure → P3",tip:"Sidebar Pressure ← cycle P3 (combustor inlet pressure)"},
          {on:linkFAR,set:setLinkFAR,label:"φ → cycle φ_Bulk (flame zone)",tip:"Sidebar φ ← cycle's flame-zone φ_Bulk = φ₄ / combustor_air_frac. This is the equivalence ratio actually seen by the primary flame (richer than the diluted combustor exit φ₄). Drives T_ad on Flame Temp and the PSR-PFR / Flame Speed / Blowoff / Exhaust panels, which all model the flame — not the diluted exit."},
          {on:linkOx,set:setLinkOx,label:"Oxidizer comp → humid air @ ambient",tip:"Sidebar Oxidizer composition ← cycle's computed humid-air mol % at ambient T/RH. Required for T_ad on Flame Temp to match T4 on this panel (they use the same mechanism and same air)."},
        ].map(l=>(
          <div key={l.label} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 10px",border:`1px solid ${l.on?C.accent:C.border}`,borderRadius:6,marginBottom:6,background:l.on?`${C.accent}10`:"transparent"}}>
            <div style={{fontSize:11,color:C.txt,fontFamily:"monospace"}} title={l.tip}>
              <span style={{marginRight:6,opacity:l.on?1:.3}}>🔗</span>{l.label}
            </div>
            <button onClick={()=>l.set(!l.on)} style={{padding:"3px 10px",fontSize:10,fontWeight:700,color:l.on?C.bg:C.accent,background:l.on?C.accent:"transparent",border:`1px solid ${C.accent}`,borderRadius:4,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".5px"}}>
              {l.on?"LINKED":"BREAK · OFF"}
            </button>
          </div>
        ))}
        {!available&&<div style={{marginTop:10,padding:"8px 10px",background:`${C.warm}12`,border:`1px solid ${C.warm}35`,borderRadius:5,fontSize:10.5,color:C.txt,lineHeight:1.4}}>Linkages only push values when <strong style={{color:C.warm}}>Accurate Mode</strong> is active. Subscribe to the FULL tier to enable the Cantera-backed cycle solver.</div>}
        {available&&!accurate&&<div style={{marginTop:10,padding:"8px 10px",background:`${C.accent2}12`,border:`1px solid ${C.accent2}35`,borderRadius:5,fontSize:10.5,color:C.txt,lineHeight:1.4}}>Turn on <strong style={{color:C.accent2}}>Accurate Mode</strong> (header toggle) to run the cycle solver and activate linkages.</div>}
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
function CombustorMappingPanel({
  fuel, Tfuel, WFR=0, waterMode="liquid", T_water,
  cycleResult, bkCycle,
  // Lifted state — Operations Summary shares this so its NOx15/CO15 agree
  // with the mapping panel's correlation values.
  w36w3, setW36w3,
  fracIP, setFracIP, fracOP, setFracOP, fracIM, setFracIM, fracOM, setFracOM,
  phiIP, setPhiIP, phiOP, setPhiOP, phiIM, setPhiIM,
  bkMap,
  mappingTables, setMappingTables,
  emissionsMode,
}){
  const units=useContext(UnitCtx);
  const {accurate}=useContext(AccurateCtx);

  const sumFrac=fracIP+fracOP+fracIM+fracOM;

  // ── Mapping-table lookup — auto-fill IP/OP/IM φ from (T3, BRNDMD) ───────
  // T3 state comes from cycle; BRNDMD from MW_net + emissionsMode. Active
  // table defaults to BRNDMD=2 when BRNDMD=0 or 1 (no table for 1).
  const T3_K_cycle = cycleResult?.T3_K || 0;
  const T3_F_cycle = T3_K_cycle > 0 ? (T3_K_cycle - 273.15) * 9/5 + 32 : 0;
  const brndmdVal = calcBRNDMD(cycleResult?.MW_net || 0, emissionsMode);
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
  // Plays a 4-trace dashboard at 1 Hz showing what the operator would see on
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
  // Buffer is a 600-sample ring (10 minutes at 1 Hz). Stored in a useRef so
  // mutating it doesn't trigger React re-render — a separate tick counter
  // useState bumps once per second to redraw the charts.
  // ═══════════════════════════════════════════════════════════════════════
  const [mappingActive, setMappingActive] = useState(false);
  const [mappingStartedAt, setMappingStartedAt] = useState(null);  // wall-clock seconds since epoch
  const [tickCount, setTickCount] = useState(0);  // drives chart re-render
  const bufferRef = useRef([]);                   // up to 600 samples
  // User-editable y-axis ranges per plot. Stored in BASE units (psi for
  // PX36, ppm for NOx/CO, BTU/scf·√°R for MWI). The actual plot axis is
  // the MAX of (user-set range, data range) — auto-extends if live values
  // exceed the user bounds, never shrinks below them. Persisted across
  // sessions via localStorage.
  const [userRanges, setUserRanges] = useState(() => {
    const defaults = {
      PX36_SEL: { min: 2,  max: 6   },  // psi (display unit-converted)
      NOx15:    { min: 10, max: 50  },  // ppmvd
      CO15:     { min: 10, max: 450 },  // ppmvd
      MWI:      { min: 44, max: 56  },  // BTU/scf·√°R, shared by WIM and GC
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
  // Per-metric mean tracker — captures the lagging "what the instrument is
  // displaying right now" given the dead-time + smoothstep response model.
  const meansRef = useRef({
    PX36_SEL: { displayed: 0, target: 0, oldVal: 0, changeAt: 0, deadT: 0,   transT: 1 },
    NOx15:    { displayed: 0, target: 0, oldVal: 0, changeAt: 0, deadT: 83,  transT: 7 },
    CO15:     { displayed: 0, target: 0, oldVal: 0, changeAt: 0, deadT: 83,  transT: 7 },
    MWI_WIM:  { displayed: 0, target: 0, oldVal: 0, changeAt: 0, deadT: 2,   transT: 5 },
    MWI_GC:   { displayed: 0, target: 0, oldVal: 0, changeAt: 0, deadT: 415, transT: 5 },
  });
  // Per-metric noise generator state.
  const noiseRef = useRef({
    PX36_SEL: { devPct: 0, sign: 1, nextChange: 0 },
    NOx15:    { amp: 0.04, waveStart: 0 },
    CO15:     { amp: 0.06, waveStart: 0 },
  });
  // Refs that snapshot the latest correlation/cycle values so the interval
  // callback always reads fresh data without re-creating the interval.
  const corrRef = useRef(null);
  const cycleRef = useRef(null);
  useEffect(() => { corrRef.current = R?.correlations || null; cycleRef.current = cycleResult || null; });

  // smoothstep: 3u² − 2u³. Smooth tangent at 0 and 1, exact arrival at u=1.
  const _smoothstep = u => u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
  const _displayedMean = (now, m) => {
    if (m.target === m.oldVal) return m.target;
    const t = now - m.changeAt;
    if (t < m.deadT) return m.oldVal;
    if (t < m.deadT + m.transT) {
      const u = (t - m.deadT) / m.transT;
      return m.oldVal + (m.target - m.oldVal) * _smoothstep(u);
    }
    return m.target;
  };
  const _updateTarget = (now, m, newTarget) => {
    if (Math.abs(newTarget - m.target) < 1e-9) return;
    // Capture current displayed value as the new "old" so mid-transition
    // restarts blend smoothly from the current point, not from the original.
    m.oldVal = _displayedMean(now, m);
    m.target = newTarget;
    m.changeAt = now;
  };

  // ── 1 Hz tick loop ──
  useEffect(() => {
    if (!mappingActive) return;
    const id = setInterval(() => {
      const now = Date.now() / 1000;
      const corrLatest = corrRef.current;
      const cycLatest = cycleRef.current;
      const m = meansRef.current;

      // Update targets from latest correlation/cycle (might have changed).
      if (corrLatest) {
        _updateTarget(now, m.PX36_SEL, corrLatest.PX36_SEL);
        _updateTarget(now, m.NOx15,    corrLatest.NOx15);
        _updateTarget(now, m.CO15,     corrLatest.CO15);
      }
      const mwiCycle = cycLatest?.fuel_flexibility?.mwi || 0;
      if (mwiCycle > 0) {
        _updateTarget(now, m.MWI_WIM, mwiCycle * 0.99);  // Wobbe-meter reads 1% low
        _updateTarget(now, m.MWI_GC,  mwiCycle);          // GC matches cycle exactly
      }

      // Compute displayed (lagging) means.
      const dPX36 = _displayedMean(now, m.PX36_SEL);
      const dNOx  = _displayedMean(now, m.NOx15);
      const dCO   = _displayedMean(now, m.CO15);
      const dWIM  = _displayedMean(now, m.MWI_WIM);
      const dGC   = _displayedMean(now, m.MWI_GC);

      // Apply per-metric noise. PX36_SEL: random step jitter, mean-band
      // dependent amplitude. NOx15/CO15: sine with re-rolled amplitude per
      // 20 s wave. MWI: continuous sine, fixed amplitude.
      const n = noiseRef.current;
      // PX36_SEL — band ramps with dPX36 (psi units, raw correlation scale).
      // Below 4.7 psi the dynamics are quiet and well-damped (low band).
      // Above 4.85 the combustor is approaching its stability limit and the
      // pressure trace gets visibly chunky (high band). Linearly interpolate
      // both ends of the band through the 4.7–4.85 transition zone.
      if (now >= n.PX36_SEL.nextChange) {
        const x = dPX36;
        let lo, hi;
        if (x < 4.7)        { lo = 1.5; hi = 3.4; }
        else if (x > 4.85)  { lo = 7.0; hi = 9.0; }
        else {
          const u = (x - 4.7) / 0.15;
          lo = 1.5 + u * (7.0 - 1.5);
          hi = 3.4 + u * (9.0 - 3.4);
        }
        n.PX36_SEL.devPct = (lo + Math.random() * (hi - lo)) / 100;
        n.PX36_SEL.sign   = Math.random() < 0.5 ? -1 : 1;
        n.PX36_SEL.nextChange = now + 1 + Math.random();  // 1-2 s
      }
      const px36Val = dPX36 * (1 + n.PX36_SEL.sign * n.PX36_SEL.devPct);

      // NOx15 — 20 s sine, re-roll amp at wave end
      if (now - n.NOx15.waveStart >= 20) {
        n.NOx15.amp = (1 + Math.random() * 2) / 100;  // 1–3 %
        n.NOx15.waveStart = now;
      }
      const noxPhase = ((now - n.NOx15.waveStart) / 20) * 2 * Math.PI;
      const nox15Val = dNOx * (1 + n.NOx15.amp * Math.sin(noxPhase));

      // CO15 — 20 s sine, re-roll amp at wave end
      if (now - n.CO15.waveStart >= 20) {
        n.CO15.amp = (5 + Math.random() * 2.5) / 100;  // 5–7.5 %
        n.CO15.waveStart = now;
      }
      const coPhase = ((now - n.CO15.waveStart) / 20) * 2 * Math.PI;
      const co15Val = dCO * (1 + n.CO15.amp * Math.sin(coPhase));

      // MWI_WIM — Wobbe meter is a noisy, fast device. Use white noise:
      // fresh ±2.5 % uniform random per tick. Sine at 1 s period would alias
      // to flat at 1 Hz sampling (Nyquist) — every sample lands at the
      // same phase. Random per-tick gives the visibly-noisy look the
      // operator expects from a real WIM analog/digital trace.
      const wimVal = dWIM * (1 + (Math.random() * 2 - 1) * 0.025);
      // MWI_GC — continuous 120 s sine, ±0.25 %
      const gcVal  = dGC  * (1 + 0.0025 * Math.sin((now / 120) * 2 * Math.PI));

      bufferRef.current.push({
        t: now,
        PX36_SEL: px36Val, NOx15: nox15Val, CO15: co15Val,
        MWI_WIM: wimVal, MWI_GC: gcVal,
      });
      if (bufferRef.current.length > 600) bufferRef.current.shift();
      setTickCount(c => c + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [mappingActive]);

  const startMapping = () => {
    const now = Date.now() / 1000;
    bufferRef.current = [];
    // Seed targets with current means so the very first tick has something
    // sensible to centre on (rather than oscillating around 0).
    const m = meansRef.current;
    const c0 = R?.correlations;
    if (c0) {
      ["PX36_SEL","NOx15","CO15"].forEach(k => {
        m[k].displayed = m[k].target = m[k].oldVal = c0[k] || 0; m[k].changeAt = now;
      });
    }
    const mwi0 = cycleResult?.fuel_flexibility?.mwi || 0;
    m.MWI_WIM.displayed = m.MWI_WIM.target = m.MWI_WIM.oldVal = mwi0 * 0.99; m.MWI_WIM.changeAt = now;
    m.MWI_GC.displayed  = m.MWI_GC.target  = m.MWI_GC.oldVal  = mwi0;        m.MWI_GC.changeAt  = now;
    noiseRef.current.NOx15.waveStart = now;
    noiseRef.current.CO15.waveStart = now;
    noiseRef.current.PX36_SEL.nextChange = now;  // forces immediate roll
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
  const resetTables = () => {
    if(typeof window !== "undefined" && window.confirm("Reset ALL mapping tables to factory defaults? Your edits will be lost.")){
      setMappingTables(JSON.parse(JSON.stringify(DEFAULT_MAPPING_TABLES)));
    }
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

  // ── Inline φ editor (used in Cards 1 and 2) ─────────────────────────────
  // inline-flex so it shrinks to its content and centers properly when the
  // parent cell uses textAlign:center. Fixed width (104 px) so all three
  // editors line up vertically and match the OM disabled-value pill below.
  const PhiEditor = ({val,setVal,step,color})=>(
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
  // Disabled φ pill for Outer Main — same width as PhiEditor (104 px) and
  // same vertical footprint so OM's row reads as a peer of IP/OP/IM, not
  // a misaligned outlier.
  const PhiDisabled = ({val,color})=>(
    <div style={{display:"inline-block",width:104,padding:"4px 6px",fontFamily:"monospace",color,fontSize:12,fontWeight:700,background:`${color}18`,border:`1px dashed ${color}80`,borderRadius:4,textAlign:"center",boxSizing:"border-box"}}>{(val||0).toFixed(4)}</div>
  );

  return(<div style={{display:"flex",flexDirection:"column",gap:12}}>
    <InlineBusyBanner loading={accurate&&(bkCycle?.loading||bkMap.loading)}/>

    <HelpBox title="ℹ️ Combustor Mapping — How It Works">
      <p style={{margin:"0 0 6px"}}>The LMS100 DLE combustor has <span style={hs.em}>four fuel circuits</span>: Inner Pilot (IP), Outer Pilot (OP), Inner Main (IM), Outer Main (OM). Set a φ for each circuit and the tool computes per-circuit <strong>T_AFT</strong> (complete-combustion flame temperature), then <strong>DT_Main</strong> = T_AFT(OM) − T_AFT(IM).</p>
      <p style={{margin:"0 0 6px"}}>Emissions (NOx@15%O₂, CO@15%O₂) and dynamics (<strong>PX36_SEL</strong> low-frequency, <strong>PX36_SEL_HI</strong> high-frequency) come from an <strong>anchored linear correlation</strong> calibrated at the LMS100 design point. The correction chain is: (1) linear corrections for DT_Main, Phi_OP, C3, N2, Tflame, T3 deltas from the reference; (2) a Phi_OP multiplier that drops from 1.0 to 0.8 linearly between φ_OP = 0.55 and 0.45 — applied <strong>only</strong> to PX36_SEL_HI; (3) a P3 power-law scaling <code style={{background:`${C.accent}15`,padding:"1px 4px",borderRadius:3,fontFamily:"monospace"}}>(P3/638)^exp</code> with exponents 0.467 / −1.0 / 0.44 / 0.44 for part-load bridging.</p>
      <p style={{margin:0}}>Air flow: <code style={{background:`${C.accent}15`,padding:"1px 4px",borderRadius:3,fontFamily:"monospace"}}>W36 = W3 × (W36/W3)</code> enters the dome. Flame air = <code style={{background:`${C.accent}15`,padding:"1px 4px",borderRadius:3,fontFamily:"monospace"}}>W36 × com.Air Frac</code> (split across the 4 circuits). Effusion / cooling air = <code style={{background:`${C.accent}15`,padding:"1px 4px",borderRadius:3,fontFamily:"monospace"}}>W36 × (1 − com.Air Frac)</code>. Outer Main is the <span style={hs.em}>float</span> circuit: fuel = total − IP − OP − IM, φ back-solved.</p>
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
          title = "Accurate Mode is off";
          body = "Click ACCURATE: OFF in the header to switch it on. The cycle backend needs to run before the mapping can populate (needs T3, P3, humid-air composition, total fuel flow).";
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
          <div style={{padding:"5px 9px",background:C.bg2,borderRadius:5,border:`1px solid ${C.border}`}}><span style={{color:C.txtDim}}>T₃:</span> <strong style={{color:C.accent}}>{fmtT(T3)} {uu(units,"T")}</strong></div>
          <div style={{padding:"5px 9px",background:C.bg2,borderRadius:5,border:`1px solid ${C.border}`}}><span style={{color:C.txtDim}}>P₃:</span> <strong style={{color:C.accent}}>{units==="SI"?(P3_bar/1.01325).toFixed(3)+" atm":(P3_bar*14.5038).toFixed(1)+" psia"}</strong></div>
          <div style={{padding:"5px 9px",background:C.bg2,borderRadius:5,border:`1px solid ${C.border}`}}><span style={{color:C.txtDim}}>T_fuel:</span> <strong style={{color:C.accent2}}>{fmtT(Tfuel)} {uu(units,"T")}</strong></div>
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
                  <th style={{padding:"7px 10px",textAlign:"center",borderBottom:`1px solid ${C.border}`,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",fontSize:10,borderLeft:`2px solid ${C.warm}45`,color:C.warm}}>Acoustics — PX36_SEL ({pxUnit})</th>
                  <th style={{padding:"7px 10px",textAlign:"center",borderBottom:`1px solid ${C.border}`,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",fontSize:10,color:C.violet}}>Acoustics — PX36_SEL_HI ({pxUnit})</th>
                  <th style={{padding:"7px 10px",textAlign:"center",borderBottom:`1px solid ${C.border}`,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",fontSize:10,borderLeft:`2px solid ${C.accent}45`,color:C.accent}}>Emissions — NOx@15</th>
                  <th style={{padding:"7px 10px",textAlign:"center",borderBottom:`1px solid ${C.border}`,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",fontSize:10,color:C.accent2,borderRight:`2px solid ${C.border}`}}>Emissions — CO@15</th>
                  <th style={{padding:"7px 10px",textAlign:"right",borderBottom:`1px solid ${C.border}`,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",fontSize:10}}>M_Fuel ({mdotU})</th>
                  <th style={{padding:"7px 10px",textAlign:"right",borderBottom:`1px solid ${C.border}`,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",fontSize:10}}>T_AFT ({uu(units,"T")})</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["Inner Pilot","IP",C.strong,"centerbody pilot",C_IP,phiIP,setPhiIP,0.05,true],
                  ["Outer Pilot","OP",C.orange,"annular pilot",C_OP,phiOP,setPhiOP,0.05,true],
                  ["Inner Main","IM",C.accent,"inner premix",C_IM,phiIM,setPhiIM,0.01,true],
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
                    {/* Acoustics + Emissions: SYSTEM-WIDE, rendered once spanning all 4 rows */}
                    {idx===0&&(<>
                      <td rowSpan={4} style={{padding:"8px 10px",textAlign:"center",borderBottom:`1px solid ${C.border}40`,verticalAlign:"middle",borderLeft:`2px solid ${C.warm}45`,background:`${C.warm}08`}}>
                        <div style={{fontSize:18,color:C.warm,fontFamily:"monospace",fontWeight:700,lineHeight:1,fontVariantNumeric:"tabular-nums"}}>{corr?fmtPx(corr.PX36_SEL):"—"}</div>
                        <div style={{fontSize:9.5,color:C.txtMuted,marginTop:3}}>low-freq · {pxUnit}</div>
                      </td>
                      <td rowSpan={4} style={{padding:"8px 10px",textAlign:"center",borderBottom:`1px solid ${C.border}40`,verticalAlign:"middle",background:`${C.violet}08`}}>
                        <div style={{fontSize:18,color:C.violet,fontFamily:"monospace",fontWeight:700,lineHeight:1,fontVariantNumeric:"tabular-nums"}}>{corr?fmtPx(corr.PX36_SEL_HI):"—"}</div>
                        <div style={{fontSize:9.5,color:C.txtMuted,marginTop:3}}>high-freq · {pxUnit}</div>
                      </td>
                      <td rowSpan={4} style={{padding:"8px 10px",textAlign:"center",borderBottom:`1px solid ${C.border}40`,verticalAlign:"middle",borderLeft:`2px solid ${C.accent}45`,background:`${C.accent}08`}}>
                        <div style={{fontSize:18,color:C.accent,fontFamily:"monospace",fontWeight:700,lineHeight:1}}>{corr?corr.NOx15.toFixed(2):"—"}</div>
                        <div style={{fontSize:9,color:C.txtMuted,marginTop:2}}>ppm</div>
                      </td>
                      <td rowSpan={4} style={{padding:"8px 10px",textAlign:"center",borderBottom:`1px solid ${C.border}40`,verticalAlign:"middle",background:`${C.accent2}08`,borderRight:`2px solid ${C.border}`}}>
                        <div style={{fontSize:18,color:C.accent2,fontFamily:"monospace",fontWeight:700,lineHeight:1}}>{corr?corr.CO15.toFixed(2):"—"}</div>
                        <div style={{fontSize:9,color:C.txtMuted,marginTop:2}}>ppm</div>
                      </td>
                    </>)}
                    <td style={{padding:"8px 10px",textAlign:"right",color:C.accent2,fontWeight:600,borderBottom:`1px solid ${C.border}40`}}>{row?fmtMdot(row.m_fuel_kg_s):"—"}</td>
                    <td style={{padding:"8px 10px",textAlign:"right",color:C.orange,fontWeight:700,borderBottom:`1px solid ${C.border}40`}}>{row?fmtT(row.T_AFT_complete_K):"—"}</td>
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
          1 Hz tick · 10-min sliding window · sensor-realistic noise + lag
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
          // Tiny editor for one bound — a NumField that calls onChange on commit.
          const RangeInput = ({ value, onChange, hint }) => (
            <NumField value={value} decimals={decimals}
              onCommit={v => Number.isFinite(v) && onChange(v)}
              title={hint}
              style={{width:62,padding:"2px 5px",fontSize:10,fontFamily:"monospace",color,
                background:C.bg,border:`1px solid ${color}50`,borderRadius:3,textAlign:"center",
                outline:"none",fontWeight:600}}/>
          );
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
            {/* Editable y-axis bounds */}
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4,fontSize:9.5,color:C.txtMuted,fontFamily:"monospace",letterSpacing:".3px"}}>
              <span>RANGE:</span>
              <RangeInput value={userMinDisp} onChange={onChangeMin} hint={`Set y-axis MIN. Axis still auto-extends if data drops below this.`}/>
              <span>—</span>
              <RangeInput value={userMaxDisp} onChange={onChangeMax} hint={`Set y-axis MAX. Axis still auto-extends if data rises above this.`}/>
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
            />
            <div style={{display:"flex",justifyContent:"space-between",fontSize:9.5,color:C.txtMuted,fontFamily:"monospace",marginTop:-2}}>
              <span>{hhmm(xMin)}</span>
              <span>{hhmm((xMin+xMax)/2)}</span>
              <span>{hhmm(xMax)}</span>
            </div>
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
                  Real-time instrument simulation at 1 Hz. Each trace centres on the cycle/correlation mean; noise model is sensor-realistic per metric. When you change a parameter, the displayed mean lags behind by the device dead time (PX36: 0 s · NOx<sub>15</sub>/CO<sub>15</sub>: 83 s · MWI_WIM: 2 s · MWI_GC: 415 s) then ramps to the new value via smoothstep over 1 s / 7 s / 5 s / 5 s respectively.
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
            {!mappingStartedAt ? (
              <div style={{padding:"40px 24px",textAlign:"center",background:C.bg2,border:`1px dashed ${C.border}`,borderRadius:8,color:C.txtMuted,fontSize:12,fontFamily:"'Barlow',sans-serif"}}>
                Click <strong style={{color:C.good}}>▶ START MAPPING</strong> to begin a real-time recording. The 10-minute window will fill in over time, one sample per second.
              </div>
            ) : (
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
                <TraceChart title="PX36_SEL" color={C.warm}    yKey="PX36_SEL" fmt={fmtPx}  unit={pxUnit}
                  userMinDisp={_px(userRanges.PX36_SEL.min)} userMaxDisp={_px(userRanges.PX36_SEL.max)}
                  decimals={units==="SI"?1:2}
                  // Convert display→base on commit. PX36 stored in psi.
                  onChangeMin={v => _setRange("PX36_SEL", "min", units==="SI"?v/68.9476:v)}
                  onChangeMax={v => _setRange("PX36_SEL", "max", units==="SI"?v/68.9476:v)}
                  hLines={px36HLines}/>
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
          <div style={{minWidth:160}}>
            <div style={{fontSize:10,fontWeight:700,color:C.accent,textTransform:"uppercase",letterSpacing:"1px"}}>W36 / W3</div>
            <div style={{fontSize:9.5,color:C.txtMuted,fontFamily:"monospace",fontStyle:"italic"}}>fraction of W3 → combustor dome</div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:3}}>
            <button onClick={()=>setW36w3(v=>Math.max(0,+(v-0.01).toFixed(4)))} style={{padding:"2px 7px",fontSize:12,fontWeight:700,fontFamily:"monospace",color:C.accent,background:"transparent",border:`1px solid ${C.accent}60`,borderRadius:3,cursor:"pointer",lineHeight:1}}>−</button>
            <NumField value={w36w3} decimals={3} onCommit={v=>setW36w3(Math.max(0,Math.min(1,+v)))}
              style={{width:66,padding:"3px 6px",fontFamily:"monospace",color:C.accent,fontSize:13,fontWeight:700,background:C.bg,border:`1px solid ${C.accent}50`,borderRadius:4,textAlign:"center",outline:"none"}}/>
            <button onClick={()=>setW36w3(v=>Math.min(1,+(v+0.01).toFixed(4)))} style={{padding:"2px 7px",fontSize:12,fontWeight:700,fontFamily:"monospace",color:C.accent,background:"transparent",border:`1px solid ${C.accent}60`,borderRadius:3,cursor:"pointer",lineHeight:1}}>+</button>
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
            ["Inner Main (IM)","inner premix",C.accent,fracIM,setFracIM,m_air_IM,phiIM,setPhiIM,0.01,m_fuel_IM_bk,true],
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
          <button onClick={resetTables} style={{padding:"4px 10px",fontSize:10,fontWeight:600,color:C.warm,background:"transparent",border:`1px solid ${C.warm}80`,borderRadius:4,cursor:"pointer",whiteSpace:"nowrap",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".4px"}}>
            ↺ RESET TO DEFAULTS
          </button>
        </div>
      </div>

      {/* ═════════════════════════════════════════════════════════════════
          REFERENCE & METHODOLOGY — explanatory text, reference conditions,
          live correlation deltas, ratio scaling. Moved here from the old
          Card 2 inline block so the dashboard above stays clean.
         ═════════════════════════════════════════════════════════════════ */}
      <div style={{padding:"14px 16px",background:`${C.bg2}80`,border:`1px solid ${C.border}`,borderRadius:8,marginTop:4}}>
        <div style={{fontSize:11,fontWeight:700,color:C.accent,textTransform:"uppercase",letterSpacing:"1.2px",marginBottom:8,paddingBottom:5,borderBottom:`1px solid ${C.accent}25`}}>
          Reference Conditions & Correlation Methodology
        </div>

        <p style={{fontSize:11,color:C.txtDim,lineHeight:1.55,fontFamily:"'Barlow',sans-serif",margin:"0 0 10px"}}>
          The emissions and dynamics shown in <strong style={{color:C.txt}}>Card 1</strong> come from an
          <strong style={{color:C.accent}}> anchored linear correlation</strong> calibrated at the
          LMS100 design point. The correction chain is: <strong>(1)</strong> linear corrections for
          DT_Main, Phi_OP, C3, N2, Tflame, T3 deltas from the reference; <strong>(2)</strong> a Phi_OP
          multiplier that drops from 1.0 to 0.8 linearly between φ_OP = 0.55 and 0.45 — applied
          <strong> only</strong> to PX36_SEL_HI; <strong>(3)</strong> a P3 power-law scaling
          <code style={{background:`${C.accent}15`,padding:"1px 4px",borderRadius:3,fontFamily:"monospace",margin:"0 2px"}}>(P3/638)^exp</code>
          with exponents <strong>0.467 / −1.0 / 0.44 / 0.44</strong> for NOx<sub>15</sub> / CO<sub>15</sub> /
          PX36_SEL / PX36_SEL_HI respectively. The Tflame contribution to NOx<sub>15</sub> is
          piecewise-integrated (slope 0.12 ppm/°F above 2850 °F, 0.04 between 2750–2850 °F, frozen below).
        </p>

        <p style={{fontSize:11,color:C.txtDim,lineHeight:1.55,fontFamily:"'Barlow',sans-serif",margin:"0 0 10px"}}>
          <strong>T_AFT</strong> = complete-combustion adiabatic flame temperature (no dissociation). Mass-flow-weighted across
          the four circuits gives the <strong>Tflame</strong> input to the correlation. <strong>DT_Main</strong> = T_AFT(OM) −
          T_AFT(IM) in °F drives the dome-mixing term.
        </p>

        {derived?<>
          <div style={{padding:"8px 10px",background:C.bg2,borderRadius:5,border:`1px solid ${C.border}`,marginBottom:8}}>
            <div style={{fontSize:9.5,color:C.txtDim,textTransform:"uppercase",letterSpacing:".5px",marginBottom:6}}>Live correlation inputs · reference → live · Δ</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4, 1fr)",gap:6,fontSize:10.5,fontFamily:"monospace"}}>
              <div><span style={{color:C.txtDim}}>DT_Main:</span> <strong style={{color:C.warm}}>{derived.DT_Main_F.toFixed(1)} °F</strong> <span style={{color:C.txtMuted}}>(ref 450)</span></div>
              <div><span style={{color:C.txtDim}}>Tflame (mass-wt avg):</span> <strong style={{color:C.warm}}>{derived.Tflame_F.toFixed(0)} °F</strong> <span style={{color:C.txtMuted}}>(ref 3035)</span></div>
              <div><span style={{color:C.txtDim}}>T3:</span> <strong style={{color:C.accent}}>{derived.T3_F.toFixed(0)} °F</strong> <span style={{color:C.txtMuted}}>(ref 700)</span></div>
              <div><span style={{color:C.txtDim}}>P3:</span> <strong style={{color:C.accent}}>{derived.P3_psia.toFixed(1)} psia</strong> <span style={{color:C.txtMuted}}>(ref 638)</span></div>
              <div><span style={{color:C.txtDim}}>C3_eff:</span> <strong style={{color:C.accent2}}>{derived.C3_effective_pct.toFixed(2)} %</strong> <span style={{color:C.txtMuted}}>(ref 7.5)</span></div>
              <div><span style={{color:C.txtDim}}>N2 (fuel):</span> <strong style={{color:C.accent2}}>{derived.N2_pct.toFixed(2)} %</strong> <span style={{color:C.txtMuted}}>(ref 0.5)</span></div>
              <div><span style={{color:C.txtDim}}>Phi_OP:</span> <strong style={{color:C.orange}}>{phiOP.toFixed(3)}</strong> <span style={{color:C.txtMuted}}>(ref 0.65)</span></div>
              <div><span style={{color:C.txtDim}}>Phi_OP mult (HI):</span> <strong style={{color:derived.phi_OP_mult<1?C.warm:C.accent}}>{derived.phi_OP_mult.toFixed(3)}</strong> <span style={{color:C.txtMuted}}>(1 if ≥0.55)</span></div>
            </div>
            <div style={{marginTop:6,padding:"4px 8px",background:C.bg,borderRadius:4,fontSize:10,color:C.txtDim,fontFamily:"monospace",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
              <span>Pressure ratio (P3/638): <strong style={{color:C.accent}}>{derived.pressure_ratio.toFixed(4)}</strong> — scales all 4 outputs as (ratio)^exp</span>
              {corr100?<span style={{color:C.txtMuted}}>@ 100% load: NOx<sub>15</sub>={corr100.NOx15.toFixed(1)} · CO<sub>15</sub>={corr100.CO15.toFixed(1)} · PX36_SEL={fmtPx(corr100.PX36_SEL)} {pxUnit} · PX36_SEL_HI={fmtPx(corr100.PX36_SEL_HI)} {pxUnit}</span>:null}
            </div>
          </div>
        </>:null}

        <p style={{fontSize:10.5,color:C.txtMuted,lineHeight:1.5,fontFamily:"'Barlow',sans-serif",margin:0,fontStyle:"italic"}}>
          Air flow: <code style={{background:`${C.accent}15`,padding:"1px 4px",borderRadius:3,fontFamily:"monospace"}}>W36 = W3 × (W36/W3)</code> enters the dome.
          Flame air = <code style={{background:`${C.accent}15`,padding:"1px 4px",borderRadius:3,fontFamily:"monospace"}}>W36 × com.Air Frac</code> (split across the 4 circuits).
          Effusion / cooling air = <code style={{background:`${C.accent}15`,padding:"1px 4px",borderRadius:3,fontFamily:"monospace"}}>W36 × (1 − com.Air Frac)</code>.
          Outer Main is the <strong style={{color:C.accent2}}>float</strong> circuit: fuel = total − IP − OP − IM, φ back-solved.
        </p>
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
    brndmd:cycleResult?calcBRNDMD(cycleResult.MW_net, emissionsMode):null,
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
      {/* xMin/xMax pin the x-axis to the full 20-100% span so every chart covers the whole load envelope even if a sweep stopped early. Red marker shows current operating point. */}
      <Chart data={plotData} xK="load" yK="y" xL="Load (%)" yL={unit} color={color} w={680} h={240} xMin={20} xMax={100} marker={marker} markerColor="#EF4444" step={step}/>
    </div>);
  };

  return(<div style={{display:"flex",flexDirection:"column",gap:12}}>
    <InlineBusyBanner loading={accurate&&(bkCycle?.loading||bkAFT_T4.loading||bkComb.loading)}/>

    <HelpBox title="ℹ️ Operations Summary — What Am I Looking At?">
      <p style={{margin:"0 0 6px"}}>Single-glance dashboard of the most important gas-turbine operating numbers at the current conditions: <span style={hs.em}>net power, firing temperature, efficiency, all mass flows, and combustor-exit emissions + composition</span>. Everything is computed for the state set in the left sidebar (engine, ambient, fuel, bleed, water).</p>
      <p style={{margin:"0 0 6px"}}><span style={hs.em}>T_4 uses the complete-combustion assumption</span> (no dissociation, C→CO₂, H→H₂O) — the physically correct reference for diluted combustor-exit temperature measurements. Pulled from the Flame Temp &amp; Properties backend at the cycle's φ₄ (post-dilution equivalence ratio). O₂% and CO₂% come from the same calculation on a dry basis — what a stack analyzer would read.</p>
      <p style={{margin:0}}><span style={hs.em}>NO<sub>x</sub> @ 15 %O₂</span> and <span style={hs.em}>CO @ 15 %O₂</span> are PFR-exit values from the PSR→PFR combustor network (uses your sidebar tau_PSR, L_PFR, V_PFR, and mechanism settings). The load sweep below reruns the whole cycle solver from 20 % → 100 % load at every other parameter fixed — useful for seeing how each metric responds as the engine spools up.</p>
    </HelpBox>

    {!cycleResult?
      <div style={{padding:"32px 24px",textAlign:"center",background:C.bg2,border:`1px dashed ${C.warm}50`,borderRadius:10,color:C.txtDim}}>
        <div style={{fontSize:13,fontWeight:600,color:C.warm,marginBottom:8}}>Cycle solution not available</div>
        <div style={{fontSize:11}}>Turn on Accurate Mode in the header. The cycle must run before the summary can populate.</div>
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
        <Hero flex={0} small label="BRNDMD" value={String(calcBRNDMD(cycleResult.MW_net, emissionsMode))} unit="" color={C.violet}
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
        const _br = cycleResult ? calcBRNDMD(cycleResult.MW_net, emissionsMode) : null;
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
          title={!accurate?"Requires Accurate Mode":sweeping?"Sweep in progress…":"Run a 17-point load sweep (20-100 %) at the current conditions"}
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

function EngineAmbientSidebar({
  engine,setEngine,Pamb,setPamb,Tamb,setTamb,RH,setRH,loadPct,setLoadPct,
  Tcool,setTcool,airFrac,setAirFrac,
  bleedMode,setBleedMode,bleedOpenPct,bleedOpenManualPct,setBleedOpenManualPct,
  bleedValveSizePct,setBleedValveSizePct,bleedAirFrac,
  bleedStepPct,setBleedStepPct,
  emissionsMode,setEmissionsMode,
  accurate,
}){
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
  return(<div style={wrap}>
    <div style={sec}>Engine & Ambient {dim&&<span style={{fontSize:9,color:C.warm,fontWeight:600,letterSpacing:".4px",textTransform:"none",marginLeft:6}}>(Accurate Mode required)</span>}</div>
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      <div>
        <label style={lbl}>Engine</label>
        <select style={S.sel} value={engine} onChange={e=>setEngine(e.target.value)}>
          <option value="LM6000PF">LM6000PF DLE</option>
          <option value="LMS100PB+">LMS100PB+ DLE IC</option>
        </select>
      </div>
      {/* ── EMISSIONS MODE — toggle button (affects BRNDMD ladder) ───── */}
      <div>
        <label style={lbl} title="When enabled, the full BRNDMD ladder is active (1 → 2 → 4 → 6 → 7). When disabled, BRNDMD holds at 4 for MW > 45 — combustor stays in a simpler low-load mode rather than progressing to high-load modes.">Emissions Mode</label>
        <button onClick={()=>setEmissionsMode(!emissionsMode)}
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
          <button onClick={()=>setLoadPct(Math.max(20,Math.min(100,Math.round(loadPct-10))))}
            title="Decrease load by 10%"
            style={{padding:"4px 10px",fontSize:13,fontWeight:700,fontFamily:"monospace",color:C.accent,background:"transparent",border:`1px solid ${C.accent}80`,borderRadius:4,cursor:"pointer",lineHeight:1}}>−10</button>
          <div style={{flex:1,position:"relative"}}>
            <NumField value={loadPct} decimals={0} onCommit={v=>setLoadPct(Math.max(20,Math.min(100,+v)))}
              style={{width:"100%",padding:"5px 6px",fontFamily:"'Barlow Condensed',sans-serif",color:C.accent,fontSize:18,fontWeight:700,background:C.bg,border:`1px solid ${C.accent}80`,borderRadius:4,textAlign:"center",outline:"none",letterSpacing:".5px"}}/>
            <span style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",fontSize:11,color:C.txtMuted,fontFamily:"monospace",pointerEvents:"none"}}>%</span>
          </div>
          <button onClick={()=>setLoadPct(Math.max(20,Math.min(100,Math.round(loadPct+10))))}
            title="Increase load by 10%"
            style={{padding:"4px 10px",fontSize:13,fontWeight:700,fontFamily:"monospace",color:C.accent,background:"transparent",border:`1px solid ${C.accent}80`,borderRadius:4,cursor:"pointer",lineHeight:1}}>+10</button>
        </div>
        <input type="range" min="20" max="100" step="1" value={loadPct} onChange={e=>setLoadPct(+e.target.value)}
          style={{width:"100%",accentColor:C.accent,display:"block"}}/>
        <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:C.txtMuted,fontFamily:"monospace",marginTop:-1}}>
          <span>20%</span><span>60%</span><span>100%</span>
        </div>
      </div>

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
          <label style={{fontSize:10.5,color:C.txtMuted,fontFamily:"monospace"}} title="Flame-zone share of combustor airflow. Sets T_Bulk / φ_Bulk only (not η). Default 0.88.">Comb. Air Frac (flame)</label>
          <NumField value={airFrac} decimals={3} onCommit={v=>setAirFrac(Math.max(0.30,Math.min(1.00,+v)))} style={{width:64,padding:"3px 6px",fontFamily:"monospace",color:C.accent,fontSize:11.5,fontWeight:700,background:C.bg,border:`1px solid ${C.accent}50`,borderRadius:4,textAlign:"center",outline:"none"}}/>
        </div>
        <input type="range" min="0.30" max="1.00" step="0.005" value={airFrac} onChange={e=>setAirFrac(+e.target.value)} style={{width:"100%",accentColor:C.accent}}/>
      </div>

      {/* ── BLEED ───────────────────────────────────────────── */}
      <div style={subSec}>Compressor Bleed</div>
      <div>
        <label style={lbl} title="Maximum bleed split %: the hard upper bound on how much compressor air the bleed valve can dump at 100% open. A function of valve/line size (bigger valve → more bleed possible). Free-type any value.">Max Bleed split % (valve/line size)</label>
        <NumField value={bleedValveSizePct} decimals={2} onCommit={v=>setBleedValveSizePct(Math.max(0,Math.min(100,+v)))} style={S.inp}/>
      </div>
      <div>
        <div style={{display:"flex",gap:6,marginBottom:6}}>
          {[
            {k:"auto",lbl:"AUTO (vs Load)",tip:"Bleed open % is a continuous function of load. 100% open ≤75% load, 0% ≥95%, linear between."},
            {k:"manual",lbl:"MANUAL",tip:"You set the bleed open % directly — type a value, click ± with the selected step, or drag the slider."},
          ].map(o=>(
            <button key={o.k} onClick={()=>{
              if(o.k==="manual"&&bleedMode!=="manual"){
                // Seed manual % with the current programmed value when switching modes
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
        {/* Step chips — only active in MANUAL mode. Value "0" means fine step (1%). */}
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
  </div>);
}

/* ══════════════════ LOGO ══════════════════ */
function Logo({size=28}){return(<svg width={size} height={size} viewBox="0 0 40 40" fill="none"><rect x="2" y="2" width="36" height="36" rx="6" stroke={C.accent} strokeWidth="2.5" fill="none"/><path d="M10 28 L14 12 L20 22 L26 12 L30 28" stroke={C.accent2} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/><circle cx="20" cy="18" r="3" fill={C.accent} opacity=".6"/></svg>);}

/* ══════════════════ MAIN APP ══════════════════ */
const TABS_BASE=[{id:"summary",label:"Operations Summary",icon:"📈"},{id:"cycle",label:"Cycle",icon:"🛠️"},{id:"mapping",label:"Combustor Mapping",icon:"🎯",engines:["LMS100PB+"]},{id:"aft",label:"Flame Temp & Properties",icon:"🔥"},{id:"exhaust",label:"Exhaust Analysis",icon:"🔬"},{id:"combustor",label:"Combustor PSR→PFR",icon:"🏭"},{id:"flame",label:"Flame Speed & Blowoff",icon:"⚡"},{id:"props",label:"Thermo Database",icon:"📊"},{id:"assumptions",label:"Assumptions",icon:"📘"}];
const ACCOUNT_TAB={id:"account",label:"Account & Billing",icon:"👤"};

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
  const[cyclePamb,setCyclePamb]=useState(1.01325);     // bar
  const[cycleTamb,setCycleTamb]=useState(288.706);     // K (60 F)
  const[cycleRH,setCycleRH]=useState(60.0);            // %
  const[cycleLoad,setCycleLoad]=useState(100.0);       // %
  // Emissions Mode — when enabled (default) the full BRNDMD ladder is
  // active (1→2→4→6→7). When disabled, BRNDMD holds at 4 for MW > 45
  // (combustor stays in a simpler mode rather than progressing to high-
  // load modes). Referenced by calcBRNDMD() and displayed in Ops Summary.
  const[emissionsMode,setEmissionsMode]=useState(true);
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
  const CYCLE_AIRFRAC_DEFAULT={"LM6000PF":0.85,"LMS100PB+":0.89};
  const CYCLE_LPFR_DEFAULT_M ={"LM6000PF":0.21336,"LMS100PB+":0.13716};   // 0.70 ft / 0.45 ft
  const[cycleAirFrac,setCycleAirFrac]=useState(CYCLE_AIRFRAC_DEFAULT["LM6000PF"]);
  const[linkT3,setLinkT3]=useState(true);
  const[linkP3,setLinkP3]=useState(true);
  const[linkFAR,setLinkFAR]=useState(true);
  const[linkOx,setLinkOx]=useState(true);
  const[velocity,setVelocity]=useState(30);const[Lchar,setLchar]=useState(0.01);
  // Premixer stability inputs. D_fh = flameholder diameter (Zukoski τ_BO).
  // L_premix / V_premix = premixer geometry (autoignition safety: τ_res < τ_ign).
  const[Dfh,setDfh]=useState(0.02);       // 20 mm — typical bluff-body / burner rod
  const[Lpremix,setLpremix]=useState(0.10); // 100 mm
  const[Vpremix,setVpremix]=useState(60);   // 60 m/s
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
  const[combMode,setCombMode]=useState("complete"); // "complete" or "equilibrium"
  const[showHelp,setShowHelp]=useState(false);
  const[showPricing,setShowPricing]=useState(false);
  const[authModal,setAuthModal]=useState(null); // null | "login" | "signup"
  const[accurate,setAccurate]=useState(false);
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
  useEffect(()=>{if(accurate&&!hasOnline)setAccurate(false);},[hasOnline,accurate]);
  // Kick user out of Account tab if they sign out
  useEffect(()=>{if(!auth.isAuthenticated&&tab==="account")setTab("cycle");},[auth.isAuthenticated,tab]);

  // Filter tabs by engine — some panels (e.g. Combustor Mapping) are only
  // meaningful for specific engines because they reflect that engine's
  // physical combustor hardware (circuit counts, pilot/main split).
  const _baseTabs=TABS_BASE.filter(t=>!t.engines||t.engines.includes(cycleEngine));
  const TABS=auth.isAuthenticated?[..._baseTabs,ACCOUNT_TAB]:_baseTabs;
  // If user is on a tab that's no longer available (engine changed), bounce
  // them to the Operations Summary so they never land on a blank page.
  useEffect(()=>{if(!TABS.some(t=>t.id===tab))setTab("summary");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[cycleEngine]);
  const initF={};FUEL_SP.forEach(s=>initF[s]=0);Object.assign(initF,FUEL_PRESETS["Pipeline NG (US)"]);
  const initO={};OX_SP.forEach(s=>initO[s]=0);Object.assign(initO,OX_PRESETS["Humid Air (60%RH 25°C)"]);
  const[fuel,setFuel]=useState(initF);const[ox,setOx]=useState(initO);
  const FAR_stoich=useMemo(()=>1/(calcFuelProps(fuel,ox).AFR_mass||1e-12),[fuel,ox]);
  const FAR=phi*FAR_stoich;
  const setPhiClamped=v=>{if(Number.isFinite(v))setPhi(Math.max(0.3,Math.min(1.0,v)));};
  const setFAR=v=>{if(Number.isFinite(v))setPhiClamped(v/FAR_stoich);};

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
  },accurate&&hasOnline);
  const cycleResult=bkCycle.data;

  // ── App-level mapping-table lookup + auto-fill. Runs whenever cycleResult,
  // emissionsMode, or the tables change — regardless of active tab. Pushes
  // the three circuit φ values into state so bkMap and Ops Summary always
  // see fresh values without having to visit the Mapping panel first.
  const _T3_F_app = cycleResult?.T3_K ? (cycleResult.T3_K - 273.15) * 9/5 + 32 : 0;
  const _brndmd_app = calcBRNDMD(cycleResult?.MW_net || 0, emissionsMode);
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
    !!(accurate && _oxHumid && _m_air_post_bleed > 0 && _m_fuel_total > 0)
  );

  // panelState is built AFTER cycleResult to avoid temporal-dead-zone reference.
  // Consumed by exportToExcel button further below; safe to declare here.
  const panelState={velocity,Lchar,Dfh,Lpremix,Vpremix,tau_psr,L_pfr,V_pfr,T_fuel,T_air:T0,measO2,measCO2,combMode,psrSeed,eqConstraint,integration,heatLossFrac,mechanism,WFR,waterMode,T_water,accurate:accurate&&!!auth.hasOnlineAccess,
    cycleEngine,cyclePamb,cycleTamb,cycleRH,cycleLoad,cycleTcool,cycleAirFrac,cycleResult,
    bleedMode,bleedOpenPct,bleedValveSizePct,bleedAirFrac,mappingTables};

  // Propagate cycle outputs into main sidebar state when linkages are ON.
  // Re-runs whenever the cycle result changes or a toggle flips.
  useEffect(()=>{
    if(!cycleResult)return;
    if(linkT3)setT0(cycleResult.T3_K);
    if(linkP3)setP(cycleResult.P3_bar/1.01325);   // bar → atm (sidebar P is atm in SI)
    // Sidebar φ ← cycle φ_Bulk (flame-zone φ, = φ₄/combustor_air_frac). Fall
    // back to phi4 or legacy phi for older backends that haven't deployed yet.
    if(linkFAR)setPhiClamped(cycleResult.phi_Bulk??cycleResult.phi4??cycleResult.phi);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[cycleResult,linkT3,linkP3,linkFAR]);

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
      <div style={{fontFamily:"'Barlow','Segoe UI',sans-serif",background:C.bg,color:C.txt,minHeight:"100vh",display:"flex",flexDirection:"column"}}>
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
            {hasOnline&&(
              <button onClick={()=>setAccurate(a=>!a)} title={accurate?"Using backend Cantera solver":"Using in-browser model"} style={{padding:"6px 12px",fontSize:11,fontWeight:700,color:accurate?C.bg:C.accent,background:accurate?C.accent:`${C.accent}15`,border:`1px solid ${C.accent}`,borderRadius:6,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".5px",display:"flex",alignItems:"center",gap:6}}>
                <span style={{width:7,height:7,borderRadius:"50%",background:accurate?C.bg:C.accent,display:"inline-block"}}/>
                {accurate?"ACCURATE: ON":"ACCURATE: OFF"}
              </button>
            )}
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
            <div style={{display:"flex",border:`1px solid ${C.border}`,borderRadius:6,overflow:"hidden"}}>
              {["SI","ENG"].map(u=>(<button key={u} onClick={()=>setUnits(u)} style={{padding:"6px 14px",fontSize:11,fontWeight:units===u?700:400,fontFamily:"'Barlow Condensed',sans-serif",color:units===u?C.bg:C.txtDim,background:units===u?C.accent:"transparent",border:"none",cursor:"pointer",letterSpacing:".5px",transition:"all .15s"}}>{u==="SI"?"SI (Metric)":"English (Imperial)"}</button>))}</div>
            <BusyGuardedExportButton onExport={()=>exportToExcel(fuel,ox,phi,T0,P,units,panelState)}/>
          </div></div>

        {/* TABS */}
        <div style={{display:"flex",gap:1,padding:"0 20px",background:C.bg,borderBottom:`1px solid ${C.border}`,overflowX:"auto"}}>
          {TABS.map(t=><button key={t.id} onClick={()=>setTab(t.id)} style={{padding:"9px 14px",fontSize:11,fontWeight:tab===t.id?600:400,color:tab===t.id?C.accent:C.txtMuted,background:tab===t.id?`${C.accent}0A`:"transparent",border:"none",borderBottom:tab===t.id?`2px solid ${C.accent}`:"2px solid transparent",cursor:"pointer",whiteSpace:"nowrap",fontFamily:"'Barlow',sans-serif",letterSpacing:".4px",transition:"all .15s"}}><span style={{marginRight:4}}>{t.icon}</span>{t.label}</button>)}</div>

        {/* FREE-VERSION DISCLAIMER BANNER (hidden when Accurate Mode is active) */}
        {!(accurate&&hasOnline)&&tab!=="account"&&(
        <div style={{padding:"10px 20px",background:`${C.warm}12`,borderBottom:`1px solid ${C.warm}35`,display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,flexWrap:"wrap"}}>
          <div style={{fontSize:11.5,color:C.txt,fontFamily:"'Barlow',sans-serif",lineHeight:1.55,flex:"1 1 320px"}}>
            <strong style={{color:C.warm,letterSpacing:".5px",fontFamily:"'Barlow Condensed',sans-serif"}}>⚠ FREE VERSION</strong> — Simplified model, accurate for <strong>φ ≤ 1.0</strong> only. <span style={{color:C.txtDim}}>Not suitable for RQL, SAC, or other rich/staged combustion systems. Upgrade for exact Cantera-backed results across all regimes.</span>
          </div>
          <button onClick={()=>setShowPricing(true)} style={{padding:"7px 16px",fontSize:11,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",color:C.bg,background:C.accent,border:"none",borderRadius:6,cursor:"pointer",letterSpacing:".7px",whiteSpace:"nowrap"}}>VIEW PRICING →</button>
        </div>)}
        {accurate&&hasOnline&&tab!=="account"&&(
        <div style={{padding:"8px 20px",background:`${C.accent}12`,borderBottom:`1px solid ${C.accent}35`,fontSize:11.5,color:C.txt,fontFamily:"'Barlow',sans-serif"}}>
          <strong style={{color:C.accent,letterSpacing:".5px",fontFamily:"'Barlow Condensed',sans-serif"}}>✓ ACCURATE MODE ACTIVE</strong> — Calculations route to the backend Cantera solver (GRI-Mech 3.0 or Glarborg 2018 selectable per calculation, mixture-averaged transport, detailed PSR/PFR network).
        </div>)}

        <div style={{display:"flex",flex:"1 1 auto",minHeight:0}}>
          {/* SIDEBAR (hidden on Account tab) */}
          {tab!=="account"&&<div style={{width:255,flexShrink:0,borderRight:`1px solid ${C.border}`,padding:"12px 10px",overflowY:"auto",background:`${C.bg}CC`}}>
            {/* Engine & Ambient (lifted from CyclePanel) — drives the entire toolkit when Accurate Mode is on */}
            <EngineAmbientSidebar
              engine={cycleEngine} setEngine={setCycleEngine}
              Pamb={cyclePamb} setPamb={setCyclePamb}
              Tamb={cycleTamb} setTamb={setCycleTamb}
              RH={cycleRH} setRH={setCycleRH}
              loadPct={cycleLoad} setLoadPct={setCycleLoad}
              Tcool={cycleTcool} setTcool={setCycleTcool}
              airFrac={cycleAirFrac} setAirFrac={setCycleAirFrac}
              bleedMode={bleedMode} setBleedMode={setBleedMode}
              bleedOpenPct={bleedOpenPct}
              bleedOpenManualPct={bleedOpenManualPct} setBleedOpenManualPct={setBleedOpenManualPct}
              bleedValveSizePct={bleedValveSizePct} setBleedValveSizePct={setBleedValveSizePct}
              bleedStepPct={bleedStepPct} setBleedStepPct={setBleedStepPct}
              bleedAirFrac={bleedAirFrac}
              emissionsMode={emissionsMode} setEmissionsMode={setEmissionsMode}
              accurate={accurate&&hasOnline}
            />
            {/* Water / steam injection — kept right under Engine & Ambient per spec.
                Applies to AFT, Flame Speed, Combustor, Exhaust, Autoignition AND Cycle. */}
            <div style={{background:C.bg2,border:`1px solid ${C.accent3}25`,borderRadius:8,padding:12,marginBottom:10}}>
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
            <div style={{...hs.box,marginBottom:10,background:`${C.accent2}08`,borderColor:`${C.accent2}18`}}>
              <strong style={{color:C.accent2,fontSize:11}}>📌 Quick Start:</strong> <span style={{fontSize:10}}>Select a fuel preset below (e.g., "Pipeline NG"), set your equivalence ratio and conditions, then explore each tab. All panels share these settings.</span></div>
            <CompEditor title="Fuel (mol%)" comp={fuel} setComp={setFuel} presets={FUEL_PRESETS} speciesList={FUEL_SP} accent={C.accent2} initialPreset="Pipeline NG (US)"
              helpText="Enter fuel composition in mole percent. Select a preset for common fuels or enter custom values. Total must sum to 100%. CO₂ and N₂ in fuel are treated as diluents."/>
            <div>
              <CompEditor title="Oxidizer (mol%)" comp={ox} setComp={setOx} presets={OX_PRESETS} speciesList={OX_SP} accent={C.accent3} initialPreset="Humid Air (60%RH 25°C)"
                helpText="Enter oxidizer composition in mole percent. 'Dry Air' is the standard. Use humid air, O₂-enriched, or vitiated air for specialized analyses."/>
              {accurate&&hasOnline&&linkOx&&<div style={{marginTop:-2,marginBottom:8}}><LinkChip onBreak={()=>setLinkOx(false)} label="Linked to Cycle humid air"/></div>}
            </div>
            <div style={{background:C.bg2,border:`1px solid ${C.accent}25`,borderRadius:8,padding:12}}>
              <div style={{fontSize:10,fontWeight:700,color:C.accent,textTransform:"uppercase",letterSpacing:"1.5px",marginBottom:6}}>Operating Conditions</div>
              <div style={{fontSize:9.5,color:C.txtMuted,lineHeight:1.5,marginBottom:8,fontStyle:"italic"}}>These conditions apply to all tabs. φ=1 is stoichiometric; φ&lt;1 lean; φ&gt;1 rich.</div>
              <div style={{marginBottom:12}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                  <label style={{fontSize:10.5,color:C.txtMuted,fontFamily:"monospace"}}>Equivalence Ratio (φ)</label>
                  <NumField value={phi} decimals={4} onCommit={setPhiClamped} title="Type any φ between 0.3 and 1.0 (or drag the slider)"
                    style={{width:72,padding:"3px 6px",fontFamily:"monospace",color:C.accent,fontSize:13,fontWeight:700,background:C.bg,border:`1px solid ${C.accent}50`,borderRadius:4,textAlign:"center",outline:"none"}}/>
                </div>
                <input type="range" min="0.3" max="1.0" step="0.01" value={phi} onChange={e=>setPhi(+e.target.value)} style={{width:"100%",accentColor:C.accent}}/>
                <div style={{textAlign:"center",fontSize:9.5,color:C.txtMuted,marginTop:-2}}>{phi<0.95?"lean":phi>1.05?"rich":"~stoichiometric"}</div>
                {accurate&&hasOnline&&linkFAR&&<LinkChip onBreak={()=>setLinkFAR(false)} label="Linked to Cycle φ_Bulk"/>}
              </div>
              <div style={{marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                  <label style={{fontSize:10.5,color:C.txtMuted,fontFamily:"monospace"}} title="Fuel-Air Ratio by mass. Linked to φ via FAR = φ × FAR_stoich.">Fuel/Air Ratio (mass)</label>
                  <NumField value={FAR} decimals={5} onCommit={setFAR} title="Type any FAR within the allowed range; φ updates automatically."
                    style={{width:82,padding:"3px 6px",fontFamily:"monospace",color:C.accent2,fontSize:13,fontWeight:700,background:C.bg,border:`1px solid ${C.accent2}50`,borderRadius:4,textAlign:"center",outline:"none"}}/>
                </div>
                <input type="range" min={0.3*FAR_stoich} max={FAR_stoich} step={FAR_stoich/1000} value={FAR} onChange={e=>setFAR(+e.target.value)} style={{width:"100%",accentColor:C.accent2}}/>
                <div style={{textAlign:"center",fontSize:9.5,color:C.txtMuted,marginTop:-2}}>Stoichiometric FAR = {FAR_stoich.toFixed(5)} (kg fuel / kg air)</div>
              </div>
              <div style={{marginBottom:10}}>
                <label style={{fontSize:10.5,color:C.txtMuted,fontFamily:"monospace",display:"block",marginBottom:3}} title="Air / oxidizer inlet temperature. On the Combustor tab, Cantera mixes this with T_fuel adiabatically (mass-weighted enthalpy balance with T-dependent NASA polynomials) to get the actual PSR inlet T.">Air Temperature ({uu(units,"T")})</label>
                <NumField value={uv(units,"T",T0)} decimals={2} onCommit={v=>setT0(uvI(units,"T",v))} style={{...S.inp,borderColor:`${C.accent3}55`}}/>
                <input type="range" min={units==="SI"?250:0} max={units==="SI"?900:1160} step={5} value={+uv(units,"T",T0).toFixed(2)} onChange={e=>setT0(uvI(units,"T",+e.target.value))} style={{width:"100%",accentColor:C.accent3,marginTop:4}}/>
                {accurate&&hasOnline&&linkT3&&<LinkChip onBreak={()=>setLinkT3(false)} label="Linked to Cycle T3"/>}
              </div>
              <div style={{marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                  <label style={{fontSize:10.5,color:C.txtMuted,fontFamily:"monospace"}} title="Fuel inlet temperature (before adiabatic mixing with air). Independent from Air T. Typical values: 290 K (cold fuel line) to 550 K (preheated).">Fuel Temperature ({uu(units,"T")})</label>
                  <button onClick={()=>setTfuel(T0)} title="Copy current Air T into Fuel T (sets the two streams equal, so adiabatic mixing degenerates to the single-inlet case)." style={{padding:"1px 8px",fontSize:9,fontWeight:700,color:C.orange,background:"transparent",border:`1px solid ${C.orange}50`,borderRadius:3,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".4px"}}>copy Air T</button>
                </div>
                <NumField value={uv(units,"T",T_fuel)} decimals={2} onCommit={v=>setTfuel(uvI(units,"T",v))} style={{...S.inp,borderColor:`${C.orange}55`}}/>
                <input type="range" min={units==="SI"?250:0} max={units==="SI"?900:1160} step={5} value={+uv(units,"T",T_fuel).toFixed(2)} onChange={e=>setTfuel(uvI(units,"T",+e.target.value))} style={{width:"100%",accentColor:C.orange,marginTop:4}}/>
              </div>
              <div><label style={{fontSize:10.5,color:C.txtMuted,fontFamily:"monospace",display:"block",marginBottom:3}}>Pressure ({uu(units,"P")})</label>
                <NumField value={uv(units,"P",P)} decimals={3} onCommit={v=>setP(uvI(units,"P",v))} style={S.inp}/>
                {accurate&&hasOnline&&linkP3&&<LinkChip onBreak={()=>setLinkP3(false)} label="Linked to Cycle P3"/>}
              </div>
              {/* Water/steam injection (WFR) is now lifted to the dedicated card directly under Engine & Ambient at the top of the sidebar — it drives every Accurate Mode panel from a single source. */}
            </div>

            {/* ── EMISSIONS TRANSFER FUNCTION — bottom of the sidebar ──── */}
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
          </div>}

          {/* CONTENT */}
          <div style={{flex:1,padding:"12px 16px",overflowY:"auto",minWidth:0}}>
            {tab==="mapping"&&<CombustorMappingPanel
              fuel={fuel} Tfuel={T_fuel}
              WFR={WFR} waterMode={waterMode} T_water={T_water}
              cycleResult={cycleResult} bkCycle={bkCycle}
              bkMap={bkMap}
              w36w3={mapW36w3} setW36w3={setMapW36w3}
              fracIP={mapFracIP} setFracIP={setMapFracIP}
              fracOP={mapFracOP} setFracOP={setMapFracOP}
              fracIM={mapFracIM} setFracIM={setMapFracIM}
              fracOM={mapFracOM} setFracOM={setMapFracOM}
              phiIP={mapPhiIP} setPhiIP={setMapPhiIP}
              phiOP={mapPhiOP} setPhiOP={setMapPhiOP}
              phiIM={mapPhiIM} setPhiIM={setMapPhiIM}
              mappingTables={mappingTables} setMappingTables={setMappingTables}
              emissionsMode={emissionsMode}
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
              // Mapping panel state — enables per-load NOx15/CO15/BRNDMD in the load sweep
              mapW36w3={mapW36w3} mapFracIP={mapFracIP} mapFracOP={mapFracOP}
              mapFracIM={mapFracIM} mapFracOM={mapFracOM}
              mappingTables={mappingTables} emTfMults={emTfMults}
            />}
            {tab==="cycle"&&<CyclePanel
              linkT3={linkT3} setLinkT3={setLinkT3}
              linkP3={linkP3} setLinkP3={setLinkP3}
              linkFAR={linkFAR} setLinkFAR={setLinkFAR}
              linkOx={linkOx} setLinkOx={setLinkOx}
              result={cycleResult} loading={bkCycle.loading} err={bkCycle.err}
            />}
            {tab==="aft"&&<AFTPanel fuel={fuel} ox={ox} phi={phi} T0={T0} P={P} Tfuel={T_fuel} WFR={WFR} waterMode={waterMode} combMode={combMode} setCombMode={setCombMode} T4_K={cycleResult?.T4_K}/>}
            {tab==="flame"&&<FlameSpeedPanel fuel={fuel} ox={ox} phi={phi} T0={T0} P={P} Tfuel={T_fuel} WFR={WFR} waterMode={waterMode} velocity={velocity} setVelocity={setVelocity} Lchar={Lchar} setLchar={setLchar} Dfh={Dfh} setDfh={setDfh} Lpremix={Lpremix} setLpremix={setLpremix} Vpremix={Vpremix} setVpremix={setVpremix}/>}
            {tab==="combustor"&&<CombustorPanel fuel={fuel} ox={ox} phi={phi} T0={T0} P={P} tau={tau_psr} setTau={setTauPsr} Lpfr={L_pfr} setL={setLpfr} Vpfr={V_pfr} setV={setVpfr} Tfuel={T_fuel} setTfuel={setTfuel} WFR={WFR} waterMode={waterMode} psrSeed={psrSeed} setPsrSeed={setPsrSeed} eqConstraint={eqConstraint} setEqConstraint={setEqConstraint} integration={integration} setIntegration={setIntegration} heatLossFrac={heatLossFrac} setHeatLossFrac={setHeatLossFrac} mechanism={mechanism} setMechanism={setMechanism}/>}
            {tab==="exhaust"&&<ExhaustPanel fuel={fuel} ox={ox} T0={T0} P={P} Tfuel={T_fuel} WFR={WFR} waterMode={waterMode} measO2={measO2} setMeasO2={setMeasO2} measCO2={measCO2} setMeasCO2={setMeasCO2} combMode={combMode} setCombMode={setCombMode}/>}
            {tab==="props"&&<PropsPanel/>}
            {tab==="assumptions"&&<AssumptionsPanel/>}
            {tab==="account"&&auth.isAuthenticated&&<AccountPanel C={C}/>}
          </div>
        </div>

        {/* FOOTER */}
        <div style={{borderTop:`1px solid ${C.border}`,background:C.bg,flexShrink:0}}>
          <div style={{padding:"10px 20px",borderBottom:`1px solid ${C.border}`}}>
            <div style={{fontSize:9,color:C.txtMuted,fontFamily:"monospace",lineHeight:1.55,textAlign:"justify",maxWidth:1400,margin:"0 auto"}}>
              <span style={{color:C.accent,fontWeight:700,letterSpacing:".5px"}}>DISCLAIMER &amp; LIMITATION OF LIABILITY —</span> This software and all results herein (&quot;the Software&quot;) are provided <span style={{fontWeight:700}}>&quot;AS IS&quot;</span> without warranties of any kind, express or implied, for <span style={{fontWeight:700}}>educational and preliminary-estimation purposes only</span>. Outputs are best-effort approximations from reduced-order models and may deviate materially from real-world behavior or high-fidelity CFD / chemistry solvers. ProReadyEngineer LLC, its owners, employees, and contributors disclaim all liability for any direct, indirect, incidental, consequential, or punitive damages, losses, or claims arising from use of or reliance on the Software. Not certified for design, permitting, regulatory, emissions-reporting, or safety-critical decisions. Users assume all risk and must independently verify every result with qualified licensed engineers, validated software, and applicable codes and standards before any engineering or operational decision. By using the Software you accept these terms.
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
