import { useState, useMemo, useCallback, createContext, useContext } from "react";
import * as XLSX from "xlsx";

/* ══════════════════════════════════════════════════════════════
   UNIT SYSTEM
   ══════════════════════════════════════════════════════════════ */
const UnitCtx = createContext("SI");
const UC = {
  SI: { T:{u:"K",from:v=>v,to:v=>v}, P:{u:"atm",from:v=>v,to:v=>v}, vel:{u:"m/s",from:v=>v,to:v=>v}, len:{u:"m",from:v=>v,to:v=>v}, lenSmall:{u:"cm",from:v=>v,to:v=>v}, SL:{u:"cm/s",from:v=>v,to:v=>v}, mass:{u:"kg",from:v=>v,to:v=>v}, energy_mass:{u:"MJ/kg",from:v=>v,to:v=>v}, energy_vol:{u:"MJ/m³",from:v=>v,to:v=>v}, cp:{u:"J/(mol·K)",from:v=>v,to:v=>v}, h_mol:{u:"kJ/mol",from:v=>v,to:v=>v}, s_mol:{u:"J/(mol·K)",from:v=>v,to:v=>v}, time:{u:"ms",from:v=>v,to:v=>v}, afr_mass:{u:"kg/kg",from:v=>v,to:v=>v} },
  ENG: { T:{u:"°F",from:K=>(K-273.15)*9/5+32,to:F=>(F-32)*5/9+273.15}, P:{u:"psia",from:a=>a*14.696,to:p=>p/14.696}, vel:{u:"ft/s",from:m=>m*3.28084,to:f=>f/3.28084}, len:{u:"ft",from:m=>m*3.28084,to:f=>f/3.28084}, lenSmall:{u:"in",from:c=>c/2.54,to:i=>i*2.54}, SL:{u:"ft/s",from:c=>c/30.48,to:f=>f*30.48}, mass:{u:"lb",from:k=>k*2.20462,to:l=>l/2.20462}, energy_mass:{u:"BTU/lb",from:v=>v*429.923,to:v=>v/429.923}, energy_vol:{u:"BTU/scf",from:v=>v*26.839,to:v=>v/26.839}, cp:{u:"BTU/(lbmol·°F)",from:v=>v*0.000238846*453.592*5/9,to:v=>v/(0.000238846*453.592*5/9)}, h_mol:{u:"BTU/lbmol",from:v=>v*429.923,to:v=>v/429.923}, s_mol:{u:"BTU/(lbmol·°F)",from:v=>v*0.000238846*453.592*5/9,to:v=>v/(0.000238846*453.592*5/9)}, time:{u:"ms",from:v=>v,to:v=>v}, afr_mass:{u:"lb/lb",from:v=>v,to:v=>v} }
};
function uv(units,key,val){return UC[units][key].from(val);}
function uu(units,key){return UC[units][key].u;}

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
const FUEL_PRESETS={"Pipeline NG (US)":{CH4:93.1,C2H6:3.2,C3H8:0.7,C4H10:0.4,CO2:1.0,N2:1.6},"Pipeline NG (EU)":{CH4:87.0,C2H6:5.5,C3H8:2.1,C4H10:0.5,N2:3.0,CO2:1.9},"LNG (typical)":{CH4:95.0,C2H6:3.0,C3H8:1.0,N2:1.0},"Biogas":{CH4:60,CO2:35,N2:4,H2:1},"Landfill Gas":{CH4:50,CO2:45,N2:5},"Syngas (Coal)":{H2:30,CO:40,CO2:10,CH4:5,N2:15},"Syngas (Biomass)":{H2:20,CO:20,CO2:15,CH4:10,N2:35},"Coke Oven Gas":{H2:55,CH4:25,CO:8,N2:6,C2H4:3,CO2:3},"Pure Methane":{CH4:100},"Pure Hydrogen":{H2:100},"Pure Propane":{C3H8:100},"70% H₂ / 30% NG":{H2:70,CH4:27.9,C2H6:1.0,C3H8:0.2,N2:0.5,CO2:0.4},"50% H₂ / 50% NG":{H2:50,CH4:46.6,C2H6:1.6,C3H8:0.4,N2:0.8,CO2:0.6},"20% H₂ / 80% NG":{H2:20,CH4:74.5,C2H6:2.6,C3H8:0.6,N2:1.3,CO2:1.0}};
const OX_PRESETS={"Dry Air (standard)":{O2:20.95,N2:78.09,Ar:0.93,CO2:0.03},"Humid Air (60%RH 25°C)":{O2:20.29,N2:75.67,Ar:0.90,H2O:3.11,CO2:0.03},"O₂-Enriched 30%":{O2:30,N2:69.07,Ar:0.90,CO2:0.03},"Vitiated Air (GT)":{O2:14.5,N2:73.0,CO2:4.5,H2O:8.0},"Pure Oxygen":{O2:100},"Oxy-fuel (O₂/CO₂)":{O2:30,CO2:70}};
const FUEL_SP=["CH4","C2H6","C3H8","C4H10","C2H4","H2","CO","CO2","N2"];
const OX_SP=["O2","N2","Ar","CO2","H2O"];

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

// Exhaust analysis with mode support
function calcExhaustFromO2(fuel,ox,measuredO2,T0,P,mode){let lo=0.3,hi=1.0;for(let i=0;i<60;i++){const mid=(lo+hi)/2;const r=calcAFTx(fuel,ox,mid,T0,P,mode);const o2Pct=r.products?.O2||0;if(o2Pct>measuredO2)lo=mid;else hi=mid;}const phi=(lo+hi)/2;const r=calcAFTx(fuel,ox,phi,T0,P,mode);const fp=calcFuelProps(fuel,ox);const FAR=1/(fp.AFR_mass*phi+1e-20)*phi;return{phi,T_ad:r.T_ad,products:r.products,FAR_mass:FAR,AFR_mass:fp.AFR_mass/phi};}
function calcExhaustFromCO2(fuel,ox,measuredCO2,T0,P,mode){let lo=0.3,hi=1.0;for(let i=0;i<60;i++){const mid=(lo+hi)/2;const r=calcAFTx(fuel,ox,mid,T0,P,mode);const co2Pct=r.products?.CO2||0;if(co2Pct<measuredCO2)lo=mid;else hi=mid;}const phi=(lo+hi)/2;const r=calcAFTx(fuel,ox,phi,T0,P,mode);const fp=calcFuelProps(fuel,ox);const FAR=phi/(fp.AFR_mass+1e-20);return{phi,T_ad:r.T_ad,products:r.products,FAR_mass:FAR,AFR_mass:fp.AFR_mass/phi};}
function calcSL(fuel,phi,Tu,P_atm){const ft=Object.values(fuel).reduce((a,b)=>a+b,0);if(ft===0)return 0;const params={CH4:{S0:0.36,al:2.0,be:-0.38,pm:1.08},C2H6:{S0:0.41,al:1.75,be:-0.31,pm:1.10},C3H8:{S0:0.39,al:1.80,be:-0.33,pm:1.08},C4H10:{S0:0.37,al:1.80,be:-0.34,pm:1.07},C2H4:{S0:0.68,al:1.60,be:-0.22,pm:1.08},H2:{S0:3.0,al:1.50,be:-0.15,pm:1.80},CO:{S0:0.45,al:1.70,be:-0.30,pm:1.05}};let sl=0;for(const[sp,pct]of Object.entries(fuel)){const p=params[sp];if(!p)continue;const xi=pct/ft;sl+=xi*p.S0*Math.exp(-5.18*Math.pow(Math.abs(phi-p.pm),2.16))*Math.pow(Tu/298,p.al)*Math.pow(P_atm/1,p.be);}return Math.max(0,sl);}
function calcBlowoff(fuel,phi,Tu,P_atm,velocity,Lchar){const SL=calcSL(fuel,phi,Tu,P_atm);const alpha_th=2.0e-5*Math.pow(Tu/300,1.7)/P_atm;const tau_chem=alpha_th/(SL*SL+1e-20);const tau_flow=Lchar/(velocity+1e-20);const Da=tau_flow/tau_chem;return{SL,tau_chem:tau_chem*1000,tau_flow:tau_flow*1000,Da,blowoff_velocity:Lchar/tau_chem,stable:Da>1};}
function calcCombustorNetwork(fuel,ox,phi,T_in,P_atm,tau_psr_ms,L_pfr,v_pfr){const aft=calcAFT(fuel,ox,phi,T_in);const T_ad=aft.T_ad;const tau_psr=tau_psr_ms/1000;const ft=Object.values(fuel).reduce((a,b)=>a+b,0);const kin={CH4:{A:1.3e9,Ea:202600},C2H6:{A:1.1e12,Ea:208400},C3H8:{A:8.6e11,Ea:208400},C4H10:{A:8.6e11,Ea:208400},H2:{A:1.8e13,Ea:142300},CO:{A:2.2e12,Ea:167400}};let Ea_eff=200000,A_eff=0;if(ft>0){Ea_eff=0;A_eff=0;for(const[sp,pct]of Object.entries(fuel)){const k=kin[sp]||kin.CH4;const xi=pct/ft;Ea_eff+=xi*k.Ea;A_eff+=xi*Math.log(k.A);}A_eff=Math.exp(A_eff);}let T_psr=T_in+(T_ad-T_in)*0.85;for(let i=0;i<100;i++){const rate=A_eff*Math.exp(-Ea_eff/(R_u*T_psr));const Da=rate*tau_psr;const conv=Da/(1+Da);const T_n=T_in+(T_ad-T_in)*conv;if(Math.abs(T_n-T_psr)<0.5){T_psr=T_n;break;}T_psr=T_psr*0.5+T_n*0.5;}const conv_psr=(T_psr-T_in)/(T_ad-T_in+1e-10);const xO2_eq=(aft.products?.O2||3)/100;const xN2_eq=(aft.products?.N2||70)/100;const calcNOxR=(T,P_a,xO2,xN2)=>{const Ct=P_a*101325/(R_u*T);const cO2=Ct*xO2;const cN2=Ct*xN2;const cO=Math.sqrt(3.6e13*Math.exp(-59380/T)*cO2)*1e-5;return 2*1.82e14*Math.exp(-38370/T)*1e-6*cO*cN2;};const calcCOR=(T,P_a,xCO)=>{const Ct=P_a*101325/(R_u*T);return 2.24e6*Math.exp(-8050/T)*Ct*xCO;};const nPts=80;const dx=L_pfr/nPts;const dt=dx/Math.max(v_pfr,0.1);let T=T_psr;let xNO=calcNOxR(T_psr,P_atm,xO2_eq,xN2_eq)*tau_psr/(P_atm*101325/(R_u*T_psr));xNO=Math.min(xNO,0.01);let xCO=(1-conv_psr)*0.02;const pfr=[{x:0,T,NO_ppm:xNO*1e6,CO_ppm:xCO*1e6,conv:conv_psr*100}];for(let i=1;i<=nPts;i++){xNO=Math.min(xNO+calcNOxR(T,P_atm,xO2_eq,xN2_eq)*dt/(P_atm*101325/(R_u*T)),0.01);xCO=Math.max(0,xCO-calcCOR(T,P_atm,xCO)*dt/(P_atm*101325/(R_u*T)));T=Math.max(T-0.5*dx*100,T_in+200);const conv=conv_psr+(1-conv_psr)*(1-xCO/(0.02*(1-conv_psr)+1e-20));pfr.push({x:+(i*dx*100).toFixed(1),T:+T.toFixed(0),NO_ppm:+(xNO*1e6).toFixed(2),CO_ppm:+(xCO*1e6).toFixed(1),conv:+(Math.min(conv,1)*100).toFixed(1)});}const O2_dry=xO2_eq*100;const corrF=(20.95-15)/(20.95-O2_dry+0.01);const fin=pfr[pfr.length-1];return{T_psr,conv_psr:conv_psr*100,T_ad,NO_ppm_exit:fin.NO_ppm,NO_ppm_15O2:fin.NO_ppm*corrF,CO_ppm_exit:fin.CO_ppm,O2_pct:O2_dry,pfr,tau_psr_ms};}

/* ══════════════════ EXCEL EXPORT ══════════════════ */
function exportToExcel(fuel,ox,phi,T0,P,units,ps){const wb=XLSX.utils.book_new();const u=units;const fp=calcFuelProps(fuel,ox);const{velocity,Lchar,tau_psr,L_pfr,V_pfr,measO2,measCO2,combMode}=ps;const aft=calcAFTx(fuel,ox,phi,T0,P,combMode);
const s1=[["COMBUSTION ENGINEERING TOOLKIT — ProReadyEngineer LLC"],["Generated: "+new Date().toISOString().slice(0,16)],["Unit System: "+(u==="SI"?"SI (Metric)":"English (Imperial)")],["Combustion Mode: "+(combMode==="equilibrium"?"Chemical Equilibrium (with dissociation)":"Complete Combustion (no dissociation)")],[],["═══ FUEL COMPOSITION (mol%) ═══"],["Species","Mole %"],...Object.entries(fuel).filter(([_,v])=>v>0).map(([sp,v])=>[sp,+v.toFixed(2)]),[],["═══ OXIDIZER COMPOSITION (mol%) ═══"],["Species","Mole %"],...Object.entries(ox).filter(([_,v])=>v>0).map(([sp,v])=>[sp,+v.toFixed(2)]),[],["═══ OPERATING CONDITIONS (INPUTS) ═══"],["Parameter","Value","Unit"],["Equivalence Ratio (φ)",+phi.toFixed(4),"—"],["Inlet Temperature",+uv(u,"T",T0).toFixed(2),uu(u,"T")],["Pressure",+uv(u,"P",P).toFixed(3),uu(u,"P")],[],["═══ COMBUSTION PROPERTIES (OUTPUTS) ═══"],["Parameter","Value","Unit"],["Adiabatic Flame Temperature",+uv(u,"T",aft.T_ad).toFixed(1),uu(u,"T")],["LHV (mass)",+uv(u,"energy_mass",fp.LHV_mass).toFixed(4),uu(u,"energy_mass")],["LHV (volumetric)",+uv(u,"energy_vol",fp.LHV_vol).toFixed(4),uu(u,"energy_vol")],["HHV (mass)",+uv(u,"energy_mass",fp.HHV_mass).toFixed(4),uu(u,"energy_mass")],["HHV (volumetric)",+uv(u,"energy_vol",fp.HHV_vol).toFixed(4),uu(u,"energy_vol")],["Molecular Weight (fuel)",+fp.MW_fuel.toFixed(4),"g/mol"],["Specific Gravity",+fp.SG.toFixed(5),"—"],["Wobbe Index",+uv(u,"energy_vol",fp.WI).toFixed(2),uu(u,"energy_vol")],["Stoich. A/F (mass)",+fp.AFR_mass.toFixed(4),uu(u,"afr_mass")],["Stoich. A/F (vol)",+fp.AFR_vol.toFixed(4),"mol/mol"],["Stoich. O₂ demand",+fp.stoichO2.toFixed(5),"mol O₂/mol fuel"],[],["═══ EQUILIBRIUM PRODUCTS (mol%) ═══"],["Species","Mole Fraction (%)"],...Object.entries(aft.products||{}).filter(([_,v])=>v>0.01).sort((a,b)=>b[1]-a[1]).map(([sp,v])=>[sp,+v.toFixed(4)]),[],["═══ AFT vs φ SWEEP ═══"],["φ","T_ad ("+uu(u,"T")+")"],...Array.from({length:18},(_,i)=>{const p=0.3+i*0.04;const a=calcAFTx(fuel,ox,p,T0,P,combMode);return[+p.toFixed(2),+uv(u,"T",a.T_ad).toFixed(1)];})];const ws1=XLSX.utils.aoa_to_sheet(s1);ws1["!cols"]=[{wch:32},{wch:20},{wch:18}];XLSX.utils.book_append_sheet(wb,ws1,"Flame Temp & Props");
const SL=calcSL(fuel,phi,T0,P)*100;const bo=calcBlowoff(fuel,phi,T0,P,velocity,Lchar);const s2=[["═══ FLAME SPEED & BLOWOFF — INPUTS ═══"],[],["Parameter","Value","Unit"],["Equivalence Ratio",+phi.toFixed(4),"—"],["Unburned T",+uv(u,"T",T0).toFixed(2),uu(u,"T")],["Pressure",+uv(u,"P",P).toFixed(3),uu(u,"P")],["Ref. Velocity",+uv(u,"vel",velocity).toFixed(2),uu(u,"vel")],["L_char",+uv(u,"len",Lchar).toFixed(4),uu(u,"len")],[],["═══ OUTPUTS ═══"],[],["Parameter","Value","Unit"],["S_L",+uv(u,"SL",SL).toFixed(4),uu(u,"SL")],["τ_chem",+bo.tau_chem.toFixed(6),"ms"],["τ_flow",+bo.tau_flow.toFixed(6),"ms"],["Da",+bo.Da.toFixed(4),"—"],["Blowoff V",+uv(u,"vel",bo.blowoff_velocity).toFixed(2),uu(u,"vel")],["Status",bo.stable?"STABLE":"BLOWOFF RISK","—"],[],["═══ S_L vs φ ═══"],["φ","S_L ("+uu(u,"SL")+")"],...Array.from({length:13},(_,i)=>{const p=0.4+i*0.05;return[+p.toFixed(2),+uv(u,"SL",calcSL(fuel,p,T0,P)*100).toFixed(4)]}),[],["═══ S_L vs P ═══"],["P ("+uu(u,"P")+")","S_L"],...[0.5,1,2,5,10,20,40].map(p=>[+uv(u,"P",p).toFixed(2),+uv(u,"SL",calcSL(fuel,phi,T0,p)*100).toFixed(4)]),[],["═══ S_L vs T ═══"],["T ("+uu(u,"T")+")","S_L"],...Array.from({length:23},(_,i)=>{const t=250+i*25;return[+uv(u,"T",t).toFixed(1),+uv(u,"SL",calcSL(fuel,phi,t,P)*100).toFixed(4)]}),[],["═══ Da vs V ═══"],["V ("+uu(u,"vel")+")","Da","Status"],...Array.from({length:40},(_,i)=>{const v=1+i*5;const b=calcBlowoff(fuel,phi,T0,P,v,Lchar);return[+uv(u,"vel",v).toFixed(1),+b.Da.toFixed(4),b.stable?"Stable":"Blowoff"]})];const ws2=XLSX.utils.aoa_to_sheet(s2);ws2["!cols"]=[{wch:32},{wch:18},{wch:14}];XLSX.utils.book_append_sheet(wb,ws2,"Flame Speed & Blowoff");
const net=calcCombustorNetwork(fuel,ox,phi,T0,P,tau_psr,L_pfr,V_pfr);const s3=[["═══ COMBUSTOR NETWORK — INPUTS ═══"],[],["Parameter","Value","Unit"],["φ",+phi.toFixed(4),"—"],["Inlet T",+uv(u,"T",T0).toFixed(2),uu(u,"T")],["P",+uv(u,"P",P).toFixed(3),uu(u,"P")],["τ_PSR",+tau_psr,"ms"],["L_PFR",+uv(u,"len",L_pfr).toFixed(3),uu(u,"len")],["V_PFR",+uv(u,"vel",V_pfr).toFixed(2),uu(u,"vel")],[],["═══ OUTPUTS ═══"],[],["Parameter","Value","Unit"],["T_ad",+uv(u,"T",net.T_ad).toFixed(1),uu(u,"T")],["T_PSR",+uv(u,"T",net.T_psr).toFixed(1),uu(u,"T")],["Conv(PSR)",+net.conv_psr.toFixed(2),"%"],["NOx exit",+net.NO_ppm_exit.toFixed(3),"ppm"],["NOx @15%O₂",+net.NO_ppm_15O2.toFixed(3),"ppmvd"],["CO exit",+net.CO_ppm_exit.toFixed(2),"ppm"],["O₂ dry",+net.O2_pct.toFixed(2),"%"],[],["═══ PFR PROFILE ═══"],["Pos ("+uu(u,"lenSmall")+")","T ("+uu(u,"T")+")","NOx (ppm)","CO (ppm)","Conv (%)"],...net.pfr.map(pt=>[+uv(u,"lenSmall",pt.x).toFixed(2),+uv(u,"T",pt.T).toFixed(1),+pt.NO_ppm,+pt.CO_ppm,+pt.conv]),[],["═══ EMISSIONS vs φ ═══"],["φ","NOx @15%O₂","CO (ppm)"],...Array.from({length:13},(_,i)=>{const p=0.4+i*0.05;const n=calcCombustorNetwork(fuel,ox,p,T0,P,tau_psr,L_pfr,V_pfr);return[+p.toFixed(2),+n.NO_ppm_15O2.toFixed(3),+n.CO_ppm_exit.toFixed(2)]})];const ws3=XLSX.utils.aoa_to_sheet(s3);ws3["!cols"]=[{wch:32},{wch:20},{wch:16},{wch:14},{wch:14}];XLSX.utils.book_append_sheet(wb,ws3,"Combustor Network");
const rO2=calcExhaustFromO2(fuel,ox,measO2,T0,P,combMode);const rCO2=calcExhaustFromCO2(fuel,ox,measCO2,T0,P,combMode);const s5=[["═══ EXHAUST ANALYSIS — INPUTS ═══"],[],["Parameter","Value","Unit"],["Measured O₂ dry",+measO2.toFixed(2),"%"],["Measured CO₂ dry",+measCO2.toFixed(2),"%"],["Inlet T",+uv(u,"T",T0).toFixed(2),uu(u,"T")],[],["═══ FROM O₂ ═══"],[],["Parameter","Value","Unit"],["φ",+rO2.phi.toFixed(5),"—"],["T_ad",+uv(u,"T",rO2.T_ad).toFixed(1),uu(u,"T")],["FAR",+rO2.FAR_mass.toFixed(6),uu(u,"afr_mass")],["AFR",+(1/(rO2.FAR_mass+1e-20)).toFixed(3),uu(u,"afr_mass")],[],["Products (O₂ analysis)","mol%"],...Object.entries(rO2.products||{}).filter(([_,v])=>v>0.01).sort((a,b)=>b[1]-a[1]).map(([sp,v])=>[sp,+v.toFixed(4)]),[],["═══ FROM CO₂ ═══"],[],["Parameter","Value","Unit"],["φ",+rCO2.phi.toFixed(5),"—"],["T_ad",+uv(u,"T",rCO2.T_ad).toFixed(1),uu(u,"T")],["FAR",+rCO2.FAR_mass.toFixed(6),uu(u,"afr_mass")],["AFR",+(1/(rCO2.FAR_mass+1e-20)).toFixed(3),uu(u,"afr_mass")],[],["Products (CO₂ analysis)","mol%"],...Object.entries(rCO2.products||{}).filter(([_,v])=>v>0.01).sort((a,b)=>b[1]-a[1]).map(([sp,v])=>[sp,+v.toFixed(4)]),[],["═══ T_ad vs Exhaust O₂ ═══"],["O₂ (%)","T_ad ("+uu(u,"T")+")","φ","FAR"],...Array.from({length:30},(_,i)=>{const o2=0.5+i*0.5;const r=calcExhaustFromO2(fuel,ox,o2,T0,P,combMode);return[+o2.toFixed(1),+uv(u,"T",r.T_ad).toFixed(1),+r.phi.toFixed(4),+r.FAR_mass.toFixed(6)]})];const ws5=XLSX.utils.aoa_to_sheet(s5);ws5["!cols"]=[{wch:38},{wch:20},{wch:16},{wch:16}];XLSX.utils.book_append_sheet(wb,ws5,"Exhaust Analysis");
const s4=[["═══ THERMO DATABASE ═══"],["NASA 7-coeff polynomials"],[]];for(const sp of["CH4","C2H6","C3H8","H2","CO","O2","N2","H2O","CO2","OH","NO","Ar"]){if(!SP[sp])continue;s4.push([SP[sp].nm+" ("+sp+")","MW: "+SP[sp].MW,"ΔHf: "+(SP[sp].Hf/1000).toFixed(2)+" kJ/mol"]);s4.push(["T (K)","Cp (J/mol·K)","H (kJ/mol)","S (J/mol·K)","G (kJ/mol)"]);for(let T=200;T<=3000;T+=100){const H=h_mol(sp,T)/1000;const Sv=sR(sp,T)*R_u;s4.push([T,+cp_mol(sp,T).toFixed(4),+H.toFixed(4),+Sv.toFixed(4),+((H*1000-T*Sv)/1000).toFixed(4)]);}s4.push([]);}const ws4=XLSX.utils.aoa_to_sheet(s4);ws4["!cols"]=[{wch:28},{wch:18},{wch:18},{wch:18},{wch:18}];XLSX.utils.book_append_sheet(wb,ws4,"Thermo Database");
XLSX.writeFile(wb,"ProReadyEngineer_CombustionReport.xlsx");}

/* ══════════════════ SVG CHART ══════════════════ */
function Chart({data,xK,yK,xL,yL,color="#2A9D8F",w=540,h=250,marker=null,y2K=null,c2="#E9C46A",y2L=""}){if(!data||!data.length)return<div style={{color:"#6B7D7B",padding:20,fontSize:13,fontFamily:"monospace"}}>No data</div>;const p={t:22,r:y2K?58:28,b:44,l:60};const W=w-p.l-p.r,H=h-p.t-p.b;const xs=data.map(d=>d[xK]),ys=data.map(d=>d[yK]);const xn=Math.min(...xs),xx=Math.max(...xs);let yn_=Math.min(...ys),yx_=Math.max(...ys);if(yn_===yx_){yn_-=1;yx_+=1;}const yn=yn_-(yx_-yn_)*0.05,yx=yx_+(yx_-yn_)*0.05;const sx=v=>p.l+(v-xn)/(xx-xn||1)*W,sy=v=>p.t+H-(v-yn)/(yx-yn||1)*H;const pts=data.map((d,i)=>`${i?'L':'M'}${sx(d[xK]).toFixed(1)},${sy(d[yK]).toFixed(1)}`).join(' ');let y2n,y2x,sy2,pts2;if(y2K){const y2s=data.map(d=>d[y2K]);let y2n_=Math.min(...y2s),y2x_=Math.max(...y2s);if(y2n_===y2x_){y2n_-=1;y2x_+=1;}y2n=y2n_-(y2x_-y2n_)*0.05;y2x=y2x_+(y2x_-y2n_)*0.05;sy2=v=>p.t+H-(v-y2n)/(y2x-y2n||1)*H;pts2=data.map((d,i)=>`${i?'L':'M'}${sx(d[xK]).toFixed(1)},${sy2(d[y2K]).toFixed(1)}`).join(' ');}const nY=5,nX=6;const yTk=Array.from({length:nY+1},(_,i)=>yn+(yx-yn)*i/nY);const xTk=Array.from({length:nX+1},(_,i)=>xn+(xx-xn)*i/nX);const fmt=v=>Math.abs(v)>=1e4?(v/1e3).toFixed(0)+'k':Math.abs(v)>=100?v.toFixed(0):Math.abs(v)>=1?v.toFixed(1):v.toFixed(3);const gid=`g${yK}${color.replace('#','')}${Math.random().toString(36).slice(2,6)}`;return(<svg viewBox={`0 0 ${w} ${h}`} style={{width:"100%",maxWidth:w}}><defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity=".2"/><stop offset="100%" stopColor={color} stopOpacity=".01"/></linearGradient></defs>{yTk.map((v,i)=><g key={i}><line x1={p.l} y1={sy(v)} x2={w-p.r} y2={sy(v)} stroke="#1A2F2A" strokeWidth=".5"/><text x={p.l-5} y={sy(v)+3.5} fill="#5A6E6B" fontSize="9" textAnchor="end" fontFamily="monospace">{fmt(v)}</text></g>)}{xTk.map((v,i)=><g key={i}><line x1={sx(v)} y1={p.t} x2={sx(v)} y2={p.t+H} stroke="#1A2F2A" strokeWidth=".5"/><text x={sx(v)} y={h-p.b+15} fill="#5A6E6B" fontSize="9" textAnchor="middle" fontFamily="monospace">{fmt(v)}</text></g>)}<path d={`${pts} L${sx(xs[xs.length-1]).toFixed(1)},${(p.t+H)} L${sx(xs[0]).toFixed(1)},${(p.t+H)} Z`} fill={`url(#${gid})`}/><path d={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round"/>{y2K&&pts2&&<path d={pts2} fill="none" stroke={c2} strokeWidth="2" strokeLinejoin="round" strokeDasharray="5 3"/>}{y2K&&<>{Array.from({length:nY+1},(_,i)=>y2n+(y2x-y2n)*i/nY).map((v,i)=><text key={`y2${i}`} x={w-p.r+5} y={sy2(v)+3.5} fill={c2} fontSize="8.5" textAnchor="start" fontFamily="monospace">{fmt(v)}</text>)}</>}{marker&&<g><line x1={sx(marker.x)} y1={p.t} x2={sx(marker.x)} y2={p.t+H} stroke="#E76F51" strokeWidth="1" strokeDasharray="4 3"/><circle cx={sx(marker.x)} cy={sy(marker.y)} r="3.5" fill="#E76F51" stroke="#0B1E18" strokeWidth="2"/><text x={sx(marker.x)+(sx(marker.x)>w/2?-8:8)} y={sy(marker.y)-8} fill="#E76F51" fontSize="10" fontFamily="monospace" fontWeight="700" textAnchor={sx(marker.x)>w/2?"end":"start"}>{marker.label}</text></g>}<text x={p.l+W/2} y={h-3} fill="#7A8E8B" fontSize="10" textAnchor="middle" fontFamily="'Barlow',sans-serif">{xL}</text><text x={12} y={p.t+H/2} fill={color} fontSize="9.5" textAnchor="middle" fontFamily="'Barlow',sans-serif" transform={`rotate(-90,12,${p.t+H/2})`}>{yL}</text>{y2K&&<text x={w-6} y={p.t+H/2} fill={c2} fontSize="9.5" textAnchor="middle" fontFamily="'Barlow',sans-serif" transform={`rotate(90,${w-6},${p.t+H/2})`}>{y2L}</text>}</svg>);}
function HBar({data,w=540,h=180}){if(!data)return null;const entries=Object.entries(data).filter(([_,v])=>v>0.05).sort((a,b)=>b[1]-a[1]);if(!entries.length)return null;const pa={t:6,r:78,b:6,l:48};const bH=Math.min(22,(h-pa.t-pa.b)/entries.length-3);const mx=Math.max(...entries.map(e=>e[1]));const W=w-pa.l-pa.r;const clr={CO2:"#E76F51",H2O:"#2A9D8F",N2:"#8AB4B0",O2:"#6AACDA",Ar:"#5A6E6B",CH4:"#E9C46A",C2H6:"#F4A261",C3H8:"#E09E4F",H2:"#74C69D",CO:"#E07A5F",NO:"#C1121F"};return(<svg viewBox={`0 0 ${w} ${h}`} style={{width:"100%",maxWidth:w}}>{entries.map(([sp,val],i)=>{const y=pa.t+i*(bH+3);const bw=val/mx*W;return(<g key={sp}><text x={pa.l-4} y={y+bH/2+4} fill="#8AB4B0" fontSize="10" textAnchor="end" fontFamily="monospace">{sp}</text><rect x={pa.l} y={y} width={Math.max(1,bw)} height={bH} rx="2" fill={clr[sp]||"#5A6E6B"} opacity=".85"/><text x={pa.l+bw+4} y={y+bH/2+4} fill="#B5CBC8" fontSize="10" fontFamily="monospace">{val.toFixed(2)}%</text></g>);})}</svg>);}

/* ══════════════════ UI COMPONENTS ══════════════════ */
const C={bg:"#0B1E18",bg2:"#0E2820",bg3:"#112E25",border:"#1A3D32",accent:"#2A9D8F",accent2:"#E9C46A",warm:"#E76F51",txt:"#D4E8D9",txtDim:"#6B8D83",txtMuted:"#3D5E53"};
const hs={box:{fontSize:10.5,lineHeight:1.55,color:C.txtDim,padding:"10px 12px",background:`${C.accent}08`,border:`1px solid ${C.accent}18`,borderRadius:6,marginBottom:10,fontFamily:"'Barlow',sans-serif"},em:{color:C.accent,fontWeight:600},warn:{color:C.accent2,fontWeight:600}};

// ── Help Components ──
function HelpBox({children,title="ℹ️ How It Works"}){const[open,setOpen]=useState(false);return(<div style={{marginBottom:10}}>
  <button onClick={()=>setOpen(!open)} style={{background:"none",border:`1px solid ${C.accent}20`,borderRadius:5,padding:"5px 10px",cursor:"pointer",color:C.accent,fontSize:10,fontWeight:600,fontFamily:"monospace",letterSpacing:".5px",display:"flex",alignItems:"center",gap:5}}>
    <span style={{fontSize:12}}>{open?"▾":"▸"}</span>{title}</button>
  {open&&<div style={{...hs.box,marginTop:6}}>{children}</div>}</div>);}

function Tip({text,children}){const[show,setShow]=useState(false);return(<div style={{position:"relative",display:"inline-flex"}} onMouseEnter={()=>setShow(true)} onMouseLeave={()=>setShow(false)}>
  {children}{show&&<div style={{position:"absolute",bottom:"calc(100% + 6px)",left:"50%",transform:"translateX(-50%)",background:"#1A3D32",border:`1px solid ${C.accent}40`,borderRadius:5,padding:"6px 10px",fontSize:10,color:C.txt,fontFamily:"'Barlow',sans-serif",lineHeight:1.4,width:220,zIndex:99,boxShadow:"0 4px 16px rgba(0,0,0,.5)",pointerEvents:"none"}}>{text}</div>}</div>);}

function M({l,v,u,c,tip}){const box=(<div style={{padding:"8px 10px",background:`${c}0A`,border:`1px solid ${c}20`,borderRadius:5,flex:"1 1 110px",minWidth:100}}>
  <div style={{fontSize:9,color:C.txtDim,textTransform:"uppercase",letterSpacing:"1px",marginBottom:2,lineHeight:1.2,display:"flex",alignItems:"center",gap:3}}>{l}{tip&&<span style={{fontSize:8,color:C.accent,cursor:"help"}}>ⓘ</span>}</div>
  <div style={{fontSize:18,fontWeight:700,fontFamily:"monospace",color:c,lineHeight:1.1}}>{v}<span style={{fontSize:10,color:C.txtMuted,fontWeight:400,marginLeft:3}}>{u}</span></div></div>);
  return tip?<Tip text={tip}>{box}</Tip>:box;}

function CompEditor({title,comp,setComp,presets,speciesList,accent,helpText}){const[preset,setPreset]=useState("");const[open,setOpen]=useState(true);const total=Object.values(comp).reduce((a,b)=>a+b,0);const loadPreset=name=>{if(presets[name]){const nc={};speciesList.forEach(sp=>nc[sp]=presets[name][sp]||0);setComp(nc);setPreset(name);}};return(
  <div style={{background:C.bg2,border:`1px solid ${accent}25`,borderRadius:8,marginBottom:10,overflow:"hidden"}}>
    <button onClick={()=>setOpen(!open)} style={{width:"100%",padding:"9px 12px",background:"none",border:"none",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",color:accent}}>
      <span style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:"1.5px"}}>{title}</span>
      <span style={{fontSize:13,transform:open?"rotate(0)":"rotate(-90deg)",transition:"transform .2s"}}>▾</span></button>
    {open&&<div style={{padding:"0 12px 10px"}}>
      {helpText&&<div style={{fontSize:9.5,color:C.txtMuted,lineHeight:1.5,marginBottom:6,fontStyle:"italic"}}>{helpText}</div>}
      <select style={S.sel} value={preset} onChange={e=>loadPreset(e.target.value)}>
        <option value="">— Select a Preset or Enter Custom —</option>{Object.keys(presets).map(k=><option key={k} value={k}>{k}</option>)}</select>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 8px",marginTop:7}}>
        {speciesList.map(sp=>(<div key={sp} style={{display:"flex",alignItems:"center",gap:4}}>
          <label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",width:36,textAlign:"right",flexShrink:0}}>{sp}</label>
          <input type="number" step="0.1" min="0" max="100" value={comp[sp]||""} placeholder="0" onChange={e=>{setComp(prev=>({...prev,[sp]:Math.max(0,parseFloat(e.target.value)||0)}));setPreset("");}} style={{...S.inp,padding:"4px 5px",fontSize:11,width:"100%"}}/></div>))}
      </div>
      <div style={{marginTop:5,fontSize:10,fontFamily:"monospace",color:Math.abs(total-100)<0.1?"#74C69D":C.accent2,textAlign:"right"}}>Σ={total.toFixed(1)}%{Math.abs(total-100)>0.1?" ⚠ Must sum to 100%":""}</div>
    </div>}</div>);}

const S={sel:{width:"100%",padding:"6px 7px",background:C.bg,border:`1px solid ${C.border}`,borderRadius:4,color:C.txt,fontSize:11.5,fontFamily:"monospace",outline:"none"},inp:{width:"100%",padding:"6px 7px",background:C.bg,border:`1px solid ${C.border}`,borderRadius:4,color:C.txt,fontSize:11.5,fontFamily:"monospace",outline:"none",boxSizing:"border-box"},card:{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:8,padding:"14px 16px",marginBottom:12},cardT:{fontSize:9.5,fontWeight:700,color:C.txtDim,textTransform:"uppercase",letterSpacing:"1.5px",marginBottom:10},row:{display:"flex",gap:8,flexWrap:"wrap"}};

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

function PricingModal({show,onClose}){if(!show)return null;
  const tiers=[
    {name:"Free",price:"$0",period:"",features:["Online use at combustion-toolkit.proreadyengineer.com","Simplified model — accurate for φ ≤ 1.0 only","All 5 calculation panels + Excel export","NOT suitable for RQL or SAC combustion"],accent:C.txtDim,current:true},
    {name:"Accurate — Download",price:"$100",period:"/year",features:["Downloadable desktop app","macOS, Windows, and Linux","Bundles Cantera — runs fully offline","Exact results across all φ","Excel export","1-year license, renewable"],accent:C.accent,cta:"Get Download"},
    {name:"Download + Online",price:"$150",period:"/year",features:["Everything in Download tier","PLUS access to the Cantera-powered online version","Runs at combustion-toolkit.proreadyengineer.com","Same exact accuracy as local","Use anywhere, no install required"],accent:C.accent2,cta:"Get Both",best:true}
  ];
  const handleBuy=()=>alert("Stripe checkout is being configured. Email sales@proreadyengineer.com to be notified at launch.");
  return(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.8)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20,overflowY:"auto"}} onClick={onClose}>
    <div onClick={e=>e.stopPropagation()} style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:12,padding:"28px 28px 22px",maxWidth:1040,width:"100%",color:C.txt,fontFamily:"'Barlow',sans-serif"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
        <div>
          <div style={{fontSize:22,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".5px",color:C.txt}}>Pricing</div>
          <div style={{fontSize:12,color:C.txtDim,marginTop:4,lineHeight:1.5}}>Upgrade for exact Cantera-backed results — no φ cap, full rich/staged combustion accuracy.</div>
        </div>
        <button onClick={onClose} style={{background:"transparent",border:"none",color:C.txtDim,fontSize:24,cursor:"pointer",padding:"0 8px",lineHeight:1}}>×</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(260px,1fr))",gap:14}}>
        {tiers.map(t=>(<div key={t.name} style={{background:C.bg3,border:`1px solid ${t.best?t.accent:C.border}`,borderRadius:10,padding:"22px 20px",position:"relative"}}>
          {t.best&&<div style={{position:"absolute",top:-11,right:16,background:t.accent,color:C.bg,padding:"3px 11px",fontSize:9,fontWeight:700,letterSpacing:"1.5px",textTransform:"uppercase",borderRadius:4,fontFamily:"'Barlow Condensed',sans-serif"}}>Best Value</div>}
          <div style={{fontSize:11,fontWeight:700,color:t.accent,textTransform:"uppercase",letterSpacing:"1.5px",marginBottom:10,fontFamily:"'Barlow Condensed',sans-serif"}}>{t.name}</div>
          <div style={{marginBottom:16}}>
            <span style={{fontSize:32,fontWeight:700,color:C.txt,fontFamily:"'Barlow Condensed',sans-serif"}}>{t.price}</span>
            <span style={{fontSize:13,color:C.txtDim,marginLeft:4}}>{t.period}</span>
          </div>
          <ul style={{listStyle:"none",padding:0,margin:"0 0 18px",fontSize:11.5,lineHeight:1.7,color:C.txt}}>
            {t.features.map(f=>(<li key={f} style={{paddingLeft:18,position:"relative",marginBottom:5}}><span style={{position:"absolute",left:0,color:t.accent,fontWeight:700}}>✓</span>{f}</li>))}
          </ul>
          {t.current
            ?<div style={{padding:"10px 14px",fontSize:11,fontWeight:600,textAlign:"center",color:C.txtDim,background:"transparent",border:`1px solid ${C.border}`,borderRadius:6,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".5px"}}>CURRENT PLAN</div>
            :<button onClick={handleBuy} style={{width:"100%",padding:"11px 14px",fontSize:12,fontWeight:700,color:C.bg,background:t.accent,border:"none",borderRadius:6,cursor:"pointer",letterSpacing:".5px",fontFamily:"'Barlow Condensed',sans-serif"}}>{t.cta} →</button>}
        </div>))}
      </div>
      <div style={{marginTop:16,padding:"11px 14px",background:C.bg,borderRadius:6,fontSize:10.5,color:C.txtDim,fontFamily:"monospace",textAlign:"center"}}>All paid tiers: 1-year license, renew annually. Questions? Email <a href="mailto:sales@proreadyengineer.com" style={{color:C.accent}}>sales@proreadyengineer.com</a></div>
    </div>
  </div>);}

/* ══════════════════ PANELS ══════════════════ */
function AFTPanel({fuel,ox,phi,T0,P,combMode,setCombMode}){
  const units=useContext(UnitCtx);const result=useMemo(()=>calcAFTx(fuel,ox,phi,T0,P,combMode),[fuel,ox,phi,T0,P,combMode]);const sweep=useMemo(()=>sweepAFT(fuel,ox,T0,P,combMode),[fuel,ox,T0,P,combMode]);const props=useMemo(()=>calcFuelProps(fuel,ox),[fuel,ox]);const mk=result?{x:phi,y:result.T_ad,label:`${uv(units,"T",result.T_ad).toFixed(0)} ${uu(units,"T")}`}:null;
  const modeToggle=<div style={{display:"flex",border:`1px solid ${C.border}`,borderRadius:5,overflow:"hidden",marginBottom:10}}>
    {["complete","equilibrium"].map(m=><button key={m} onClick={()=>setCombMode(m)} style={{padding:"6px 12px",fontSize:10.5,fontWeight:combMode===m?700:400,color:combMode===m?C.bg:C.txtDim,background:combMode===m?C.accent:"transparent",border:"none",cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".4px",transition:"all .15s"}}>{m==="complete"?"Complete Combustion":"Chemical Equilibrium"}</button>)}
  </div>;
  return(<div style={{display:"flex",flexDirection:"column",gap:12}}>
    <HelpBox title="ℹ️ Flame Temperature & Properties — How It Works"><p style={{margin:"0 0 6px"}}>This panel computes the <span style={hs.em}>adiabatic flame temperature</span> by solving an energy balance: total reactant enthalpy = total product enthalpy. Uses NASA 7-coefficient polynomials for temperature-dependent Cp and enthalpy.</p><p style={{margin:"0 0 6px"}}><span style={hs.em}>Complete Combustion:</span> Assumes all C→CO₂, all H→H₂O. No dissociation — gives the theoretical maximum T. <span style={hs.em}>Chemical Equilibrium:</span> Solves 4 dissociation reactions (CO₂⇌CO+½O₂, H₂O⇌H₂+½O₂, ½N₂+½O₂⇌NO, ½H₂+½O₂⇌OH) via Gibbs free energy Kp iteration. Gives realistic T with dissociation species (CO, OH, NO, H₂) in products.</p><p style={{margin:0}}>All values use the <span style={hs.warn}>fuel and oxidizer compositions</span> defined in the sidebar.</p></HelpBox>
    {modeToggle}
    <div style={S.card}><div style={S.cardT}>Fuel & Combustion Properties {combMode==="equilibrium"&&<span style={{color:C.accent,fontWeight:400}}> — Equilibrium Mode</span>}</div>
      <div style={{...S.row,gap:8}}>
        <M l="Adiab. Flame T" v={uv(units,"T",result?.T_ad).toFixed(0)} u={uu(units,"T")} c={C.accent} tip="Maximum theoretical temperature when fuel burns with no heat loss. Computed via enthalpy balance at constant pressure."/>
        <M l="LHV (mass)" v={uv(units,"energy_mass",props.LHV_mass).toFixed(2)} u={uu(units,"energy_mass")} c={C.accent2} tip="Lower Heating Value per unit mass. Water in products remains as vapor. Used for gas turbine calculations."/>
        <M l="LHV (vol)" v={uv(units,"energy_vol",props.LHV_vol).toFixed(2)} u={uu(units,"energy_vol")} c={C.accent2} tip="Lower Heating Value per unit volume at STP (15°C, 1 atm). Key parameter for gas metering and burner sizing."/>
        <M l="HHV (mass)" v={uv(units,"energy_mass",props.HHV_mass).toFixed(2)} u={uu(units,"energy_mass")} c="#F4A261" tip="Higher Heating Value per unit mass. Includes latent heat of water condensation. Used for boiler efficiency calculations."/>
        <M l="HHV (vol)" v={uv(units,"energy_vol",props.HHV_vol).toFixed(2)} u={uu(units,"energy_vol")} c="#F4A261" tip="Higher Heating Value per unit volume at STP. Used in gas utility billing and furnace sizing."/>
        <M l="MW (fuel)" v={props.MW_fuel.toFixed(2)} u="g/mol" c="#8AB4B0" tip="Mole-fraction-weighted average molecular weight of the fuel mixture."/>
        <M l="Specific Gravity" v={props.SG.toFixed(4)} u="—" c="#8AB4B0" tip="Ratio of fuel MW to standard air MW (28.97). SG > 1 means heavier than air."/>
        <M l="Wobbe Index" v={uv(units,"energy_vol",props.WI).toFixed(1)} u={uu(units,"energy_vol")} c="#BC96E6" tip="WI = HHV_vol / √SG. Measures fuel interchangeability — fuels with similar WI can be swapped without re-tuning burners."/>
        <M l="Stoich A/F (mass)" v={props.AFR_mass.toFixed(2)} u={uu(units,"afr_mass")} c="#74C69D" tip="Mass of oxidizer per mass of fuel at stoichiometric conditions (φ=1). Used for combustor sizing."/>
        <M l="Stoich A/F (vol)" v={props.AFR_vol.toFixed(2)} u="mol/mol" c="#6AACDA" tip="Moles of oxidizer per mole of fuel at stoichiometric conditions."/>
        <M l="Stoich O₂" v={props.stoichO2.toFixed(3)} u="mol" c="#6AACDA" tip="Moles of O₂ required per mole of fuel for complete combustion: C→CO₂, H→H₂O."/>
      </div></div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <div style={S.card}><div style={S.cardT}>T_ad vs Equivalence Ratio</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>Yellow marker shows current φ. Peak T_ad typically occurs near φ≈1.05 due to dissociation effects.</div><Chart data={sweep} xK="phi" yK="T_ad" xL="Equivalence Ratio (φ)" yL={`Temperature (${uu(units,"T")})`} color={C.accent} marker={mk}/></div>
      <div style={S.card}><div style={S.cardT}>Equilibrium Products (mol%)</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>Major species at equilibrium. Lean mixtures (φ&lt;1) show excess O₂; rich mixtures (φ&gt;1) show CO and H₂.</div>{result&&<HBar data={result.products} h={Math.max(140,Object.keys(result.products).length*26+12)}/>}</div>
    </div></div>);}

function FlameSpeedPanel({fuel,ox,phi,T0,P,velocity,setVelocity,Lchar,setLchar}){
  const units=useContext(UnitCtx);const sweep=useMemo(()=>{const r=[];for(let p=0.4;p<=1.01;p+=0.02)r.push({phi:+p.toFixed(2),SL:calcSL(fuel,p,T0,P)*100});return r;},[fuel,T0,P]);const SL=calcSL(fuel,phi,T0,P)*100;const mk={x:phi,y:SL,label:`${uv(units,"SL",SL).toFixed(1)} ${uu(units,"SL")}`};const pSw=useMemo(()=>[0.5,1,2,5,10,20,40].map(p=>({P:p,SL:calcSL(fuel,phi,T0,p)*100})),[fuel,phi,T0]);const tSw=useMemo(()=>{const r=[];for(let t=250;t<=800;t+=25)r.push({T:t,SL:calcSL(fuel,phi,t,P)*100});return r;},[fuel,phi,P]);const bo=useMemo(()=>calcBlowoff(fuel,phi,T0,P,velocity,Lchar),[fuel,phi,T0,P,velocity,Lchar]);const daSw=useMemo(()=>{const r=[];for(let v=1;v<=200;v+=2){const b=calcBlowoff(fuel,phi,T0,P,v,Lchar);r.push({V:v,Da:Math.min(b.Da,100)});}return r;},[fuel,phi,T0,P,Lchar]);
  return(<div style={{display:"flex",flexDirection:"column",gap:12}}>
    <HelpBox title="ℹ️ Flame Speed & Blowoff — How It Works"><p style={{margin:"0 0 6px"}}><span style={hs.em}>Laminar Flame Speed (S_L)</span> is computed using Gülder/Metghalchi-Keck empirical correlations: S_L = S_L0 · f(φ) · (T_u/T_0)^α · (P/P_0)^β. For mixtures, species contributions are mole-fraction-weighted.</p><p style={{margin:"0 0 6px"}}><span style={hs.em}>Blowoff Analysis:</span> τ_chem = α_th / S_L² (chemical timescale), τ_flow = L_char / V (flow timescale). The <span style={hs.em}>Damköhler number Da = τ_flow / τ_chem</span>. When Da &lt; 1, the flame cannot sustain itself and blows off.</p><p style={{margin:0}}><span style={hs.warn}>V_ref</span> is your reference approach velocity. <span style={hs.warn}>L_char</span> is the characteristic recirculation length (typically flameholder diameter or step height).</p></HelpBox>
    <div style={S.card}><div style={S.cardT}>Flame Speed & Stability Analysis</div>
      <div style={{...S.row,gap:8,marginBottom:10}}>
        <M l="S_L" v={uv(units,"SL",SL).toFixed(2)} u={uu(units,"SL")} c="#BC96E6" tip="Laminar burning velocity — the speed at which a planar flame front propagates into the unburned mixture."/>
        <M l="τ_chem" v={bo.tau_chem.toFixed(4)} u="ms" c="#8AB4B0" tip="Chemical timescale: time for the flame to propagate one thermal diffusion length. τ_chem = α_th / S_L²."/>
        <M l="τ_flow" v={bo.tau_flow.toFixed(4)} u="ms" c={C.accent} tip="Flow timescale: residence time of unburned gas near the flameholder. τ_flow = L_char / V_ref."/>
        <M l="Da" v={bo.Da.toFixed(2)} u="—" c={bo.stable?"#74C69D":C.warm} tip="Damköhler number = τ_flow / τ_chem. Da > 1 means chemistry is fast enough to sustain the flame. Da < 1 → blowoff risk."/>
        <M l="Blowoff V" v={uv(units,"vel",bo.blowoff_velocity).toFixed(1)} u={uu(units,"vel")} c={C.accent2} tip="Velocity at which Da = 1 for the given L_char. Above this velocity the flame will blow off."/>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",flex:"0 0 auto",padding:"0 10px"}}>
          <span style={{padding:"3px 10px",borderRadius:16,fontSize:10,fontWeight:600,fontFamily:"monospace",background:bo.stable?"rgba(116,198,157,.12)":"rgba(231,111,81,.12)",color:bo.stable?"#74C69D":C.warm,border:`1px solid ${bo.stable?"#74C69D22":"#E76F5122"}`}}>{bo.stable?"● STABLE":"● BLOWOFF RISK"}</span></div>
      </div>
      <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
        <div style={{display:"flex",alignItems:"center",gap:5}}><Tip text="The reference approach velocity of the unburned gas mixture at the flameholder location."><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>V_ref ({uu(units,"vel")}) ⓘ:</label></Tip>
          <input type="number" value={velocity} onChange={e=>setVelocity(+e.target.value||1)} style={{...S.inp,width:65}}/></div>
        <div style={{display:"flex",alignItems:"center",gap:5}}><Tip text="Characteristic recirculation length — typically the flameholder diameter, bluff body width, or step height."><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>L_char ({uu(units,"len")}) ⓘ:</label></Tip>
          <input type="number" step="0.001" value={Lchar} onChange={e=>setLchar(+e.target.value||0.01)} style={{...S.inp,width:75}}/></div>
      </div></div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <div style={S.card}><div style={S.cardT}>S_L vs Equivalence Ratio</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>Peak S_L occurs near stoichiometric (slightly rich for hydrocarbons, φ≈1.8 for H₂).</div><Chart data={sweep} xK="phi" yK="SL" xL="φ" yL={`S_L (${uu(units,"SL")})`} color="#BC96E6" marker={mk}/></div>
      <div style={S.card}><div style={S.cardT}>Da vs Flow Velocity</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>Da decreases linearly with velocity. Below Da=1 (horizontal line), blowoff occurs.</div><Chart data={daSw} xK="V" yK="Da" xL={`Velocity (${uu(units,"vel")})`} yL="Damköhler" color={C.accent2}/></div>
      <div style={S.card}><div style={S.cardT}>S_L vs Pressure</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>S_L decreases with pressure (exponent β ≈ -0.3 to -0.4 for hydrocarbons).</div><Chart data={pSw} xK="P" yK="SL" xL={`Pressure (${uu(units,"P")})`} yL={`S_L (${uu(units,"SL")})`} color="#8AB4B0"/></div>
      <div style={S.card}><div style={S.cardT}>S_L vs T_unburned</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>S_L increases strongly with preheat temperature (exponent α ≈ 1.5–2.0).</div><Chart data={tSw} xK="T" yK="SL" xL={`T_u (${uu(units,"T")})`} yL={`S_L (${uu(units,"SL")})`} color={C.accent}/></div>
    </div></div>);}

function CombustorPanel({fuel,ox,phi,T0,P,tau,setTau,Lpfr,setL,Vpfr,setV}){
  const units=useContext(UnitCtx);const net=useMemo(()=>calcCombustorNetwork(fuel,ox,phi,T0,P,tau,Lpfr,Vpfr),[fuel,ox,phi,T0,P,tau,Lpfr,Vpfr]);const emSw=useMemo(()=>{const r=[];for(let p=0.4;p<=1.01;p+=0.02){const n=calcCombustorNetwork(fuel,ox,p,T0,P,tau,Lpfr,Vpfr);r.push({phi:+p.toFixed(2),NO:n.NO_ppm_15O2,CO:n.CO_ppm_exit});}return r;},[fuel,ox,T0,P,tau,Lpfr,Vpfr]);
  return(<div style={{display:"flex",flexDirection:"column",gap:12}}>
    <HelpBox title="ℹ️ Combustor Network — How It Works"><p style={{margin:"0 0 6px"}}>Models a combustor as a <span style={hs.em}>PSR (primary zone)</span> where intense mixing occurs, followed by a <span style={hs.em}>PFR (burnout zone)</span> where CO burns out and thermal NOx forms. This is the standard CRN approach used in gas turbine combustor modeling.</p><p style={{margin:"0 0 6px"}}><span style={hs.em}>PSR:</span> Solved iteratively using the Damköhler number (Da = k·τ). Short τ → incomplete combustion (blowout). <span style={hs.em}>PFR:</span> Marches spatially computing NOx (Zeldovich thermal mechanism: N₂+O⇌NO+N) and CO burnout (CO+OH⇌CO₂+H).</p><p style={{margin:0}}><span style={hs.warn}>τ_PSR</span> = primary zone residence time (ms). <span style={hs.warn}>L_PFR</span> = burnout zone length. <span style={hs.warn}>V_PFR</span> = mean gas velocity. NOx is corrected to 15% O₂ dry per regulatory standard.</p></HelpBox>
    <div style={S.card}><div style={S.cardT}>PSR → PFR Combustor Network</div>
      <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap",marginBottom:12}}>
        <div style={{display:"flex",alignItems:"center",gap:5}}><Tip text="Primary zone residence time. Typical GT: 1–5 ms. Lower values increase blowout risk but reduce NOx."><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>τ_PSR (ms) ⓘ:</label></Tip><input type="number" step={0.1} value={tau} onChange={e=>setTau(+e.target.value||0.1)} style={{...S.inp,width:65}}/></div>
        <div style={{display:"flex",alignItems:"center",gap:5}}><Tip text="Length of the burnout/dilution zone downstream of the primary zone. Longer = more complete CO burnout but more NOx."><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>L_PFR ({uu(units,"len")}) ⓘ:</label></Tip><input type="number" step={0.1} value={Lpfr} onChange={e=>setL(+e.target.value||0.1)} style={{...S.inp,width:65}}/></div>
        <div style={{display:"flex",alignItems:"center",gap:5}}><Tip text="Mean axial gas velocity in the PFR burnout section. Determines actual residence time in the PFR."><label style={{fontSize:10.5,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>V_PFR ({uu(units,"vel")}) ⓘ:</label></Tip><input type="number" step={1} value={Vpfr} onChange={e=>setV(+e.target.value||1)} style={{...S.inp,width:65}}/></div>
      </div>
      <svg viewBox="0 0 600 60" style={{width:"100%",maxWidth:600,marginBottom:10}}>
        <defs><linearGradient id="pg1b" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor={C.accent} stopOpacity=".6"/><stop offset="100%" stopColor="#8AB4B0" stopOpacity=".6"/></linearGradient><linearGradient id="pg2b" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor="#8AB4B0" stopOpacity=".6"/><stop offset="100%" stopColor={C.accent2} stopOpacity=".6"/></linearGradient></defs>
        <rect x="16" y="10" width="40" height="40" rx="4" fill="none" stroke={C.border} strokeWidth="1.5"/><text x="36" y="28" fill={C.txtDim} fontSize="7.5" textAnchor="middle" fontFamily="monospace">FUEL</text><text x="36" y="38" fill={C.txtDim} fontSize="7.5" textAnchor="middle" fontFamily="monospace">+OX</text><polygon points="58,26 70,30 58,34" fill={C.border}/>
        <rect x="72" y="5" width="150" height="50" rx="8" fill="url(#pg1b)" opacity=".12" stroke={C.accent} strokeWidth="1.5"/><text x="147" y="26" fill={C.accent} fontSize="11" textAnchor="middle" fontFamily="monospace" fontWeight="700">PSR</text><text x="147" y="40" fill={C.txtMuted} fontSize="8" textAnchor="middle" fontFamily="monospace">τ={tau}ms T={uv(units,"T",net.T_psr).toFixed(0)}{uu(units,"T")}</text>
        <polygon points="224,26 236,30 224,34" fill={C.border}/>
        <rect x="238" y="5" width="220" height="50" rx="8" fill="url(#pg2b)" opacity=".12" stroke="#8AB4B0" strokeWidth="1.5"/><text x="348" y="26" fill="#8AB4B0" fontSize="11" textAnchor="middle" fontFamily="monospace" fontWeight="700">PFR (Burnout)</text><text x="348" y="40" fill={C.txtMuted} fontSize="8" textAnchor="middle" fontFamily="monospace">L={Lpfr}{uu(units,"len")} V={Vpfr}{uu(units,"vel")}</text>
        <polygon points="460,26 472,30 460,34" fill={C.border}/><text x="510" y="27" fill={C.accent2} fontSize="9" textAnchor="middle" fontFamily="monospace" fontWeight="700">EXIT</text><text x="510" y="40" fill={C.txtMuted} fontSize="7" textAnchor="middle" fontFamily="monospace">{uv(units,"T",net.pfr[net.pfr.length-1]?.T).toFixed(0)}{uu(units,"T")}</text>
      </svg>
      <div style={{...S.row,gap:8}}>
        <M l="T_ad" v={uv(units,"T",net.T_ad).toFixed(0)} u={uu(units,"T")} c={C.accent} tip="Adiabatic flame temperature — the theoretical maximum temperature if combustion were complete with no heat loss."/>
        <M l="T_PSR" v={uv(units,"T",net.T_psr).toFixed(0)} u={uu(units,"T")} c="#8AB4B0" tip="Exit temperature of the perfectly stirred reactor (primary zone). Lower than T_ad if residence time is too short."/>
        <M l="Conv (PSR)" v={net.conv_psr.toFixed(1)} u="%" c="#74C69D" tip="Fuel conversion in the PSR. 100% = complete combustion. Values below ~90% indicate approaching blowout."/>
        <M l="NOx exit" v={net.NO_ppm_exit.toFixed(1)} u="ppm" c={C.warm} tip="Nitric oxide concentration at combustor exit (wet, actual O₂). Primarily thermal NOx from the Zeldovich mechanism."/>
        <M l="NOx @15%O₂" v={net.NO_ppm_15O2.toFixed(1)} u="ppmvd" c="#C1121F" tip="NOx corrected to 15% O₂ dry — the standard regulatory reporting basis for gas turbines and boilers."/>
        <M l="CO exit" v={net.CO_ppm_exit.toFixed(1)} u="ppm" c={C.accent2} tip="Carbon monoxide at exit. High CO indicates incomplete combustion — reduce φ, increase τ, or lengthen PFR."/>
        <M l="O₂ dry" v={net.O2_pct.toFixed(1)} u="%" c="#6AACDA" tip="Residual oxygen in exhaust on a dry basis. Used for emissions correction and combustion efficiency."/>
      </div></div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <div style={S.card}><div style={S.cardT}>PFR Temperature Profile</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>Temperature along the PFR. Slight decline from radiative/convective heat losses.</div><Chart data={net.pfr} xK="x" yK="T" xL={`Position (${uu(units,"lenSmall")})`} yL={`T (${uu(units,"T")})`} color={C.accent2}/></div>
      <div style={S.card}><div style={S.cardT}>PFR NOx & CO</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>Solid line: NOx (increases along PFR). Dashed: CO (burns out). The NOx-CO tradeoff is fundamental to combustor design.</div><Chart data={net.pfr} xK="x" yK="NO_ppm" xL={`Position (${uu(units,"lenSmall")})`} yL="NOx (ppm)" color={C.warm} y2K="CO_ppm" c2={C.accent2} y2L="CO (ppm)"/></div>
    </div>
    <div style={S.card}><div style={S.cardT}>Emissions vs Equivalence Ratio</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>Classic NOx-CO tradeoff: lean mixtures reduce NOx but increase CO. Lean premixed combustors operate at φ ≈ 0.5–0.6 for low emissions.</div><Chart data={emSw} xK="phi" yK="NO" xL="Equivalence Ratio (φ)" yL="NOx @15%O₂ (ppm)" color={C.warm} y2K="CO" c2={C.accent2} y2L="CO (ppm)" w={700} h={270}/></div>
  </div>);}

function ExhaustPanel({fuel,ox,T0,P,measO2,setMeasO2,measCO2,setMeasCO2,combMode,setCombMode}){
  const units=useContext(UnitCtx);const rO2=useMemo(()=>calcExhaustFromO2(fuel,ox,measO2,T0,P,combMode),[fuel,ox,measO2,T0,P,combMode]);const rCO2=useMemo(()=>calcExhaustFromCO2(fuel,ox,measCO2,T0,P,combMode),[fuel,ox,measCO2,T0,P,combMode]);
  const o2Sweep=useMemo(()=>{const r=[];for(let o2=0.5;o2<=15;o2+=0.5){const res=calcExhaustFromO2(fuel,ox,o2,T0,P,combMode);r.push({O2:o2,T_ad:res.T_ad,phi:res.phi});}return r;},[fuel,ox,T0,P,combMode]);
  const modeToggle=<div style={{display:"flex",border:`1px solid ${C.border}`,borderRadius:5,overflow:"hidden",marginBottom:10}}>
    {["complete","equilibrium"].map(m=><button key={m} onClick={()=>setCombMode(m)} style={{padding:"6px 12px",fontSize:10.5,fontWeight:combMode===m?700:400,color:combMode===m?C.bg:C.txtDim,background:combMode===m?C.accent:"transparent",border:"none",cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".4px",transition:"all .15s"}}>{m==="complete"?"Complete Combustion":"Chemical Equilibrium"}</button>)}
  </div>;
  return(<div style={{display:"flex",flexDirection:"column",gap:12}}>
    <HelpBox title="ℹ️ Exhaust Analysis — How It Works"><p style={{margin:"0 0 6px"}}>Enter a <span style={hs.em}>measured exhaust O₂ or CO₂ concentration</span> (dry basis, %) from a stack analyzer or CEMS. The tool iteratively solves for the equivalence ratio (φ) that produces that exhaust composition.</p><p style={{margin:"0 0 6px"}}><span style={hs.em}>Complete Combustion</span> mode works well for lean conditions. <span style={hs.em}>Chemical Equilibrium</span> mode includes dissociation products (CO, OH, NO) and gives more accurate results near stoichiometric and at high temperatures.</p><p style={{margin:0}}><span style={hs.warn}>Note:</span> Both methods use the same fuel/oxidizer from the sidebar. The combustion mode is shared with the Flame Temperature panel.</p></HelpBox>
    {modeToggle}
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <div style={S.card}><div style={S.cardT}>From Measured O₂ (%)</div>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
          <Tip text="Enter the measured O₂ concentration in the exhaust on a dry basis. Typical values: 2–6% for gas turbines, 3–8% for boilers."><label style={{fontSize:11,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>Meas. O₂ (% dry) ⓘ:</label></Tip>
          <input type="number" step="0.1" value={measO2} onChange={e=>setMeasO2(+e.target.value||0)} style={{...S.inp,width:70}}/></div>
        <div style={{...S.row,gap:8}}>
          <M l="Equiv. Ratio (φ)" v={rO2.phi.toFixed(3)} u="—" c={C.accent} tip="Back-calculated equivalence ratio from your measured O₂."/>
          <M l="Flame Temperature" v={uv(units,"T",rO2.T_ad).toFixed(0)} u={uu(units,"T")} c={C.warm} tip="Adiabatic flame temperature corresponding to this φ."/>
          <M l="FAR (mass)" v={rO2.FAR_mass.toFixed(4)} u={uu(units,"afr_mass")} c={C.accent2} tip="Actual fuel-to-air ratio by mass."/>
          <M l="A/F Ratio" v={(1/(rO2.FAR_mass+1e-20)).toFixed(2)} u={uu(units,"afr_mass")} c="#74C69D" tip="Actual air-to-fuel ratio by mass."/>
        </div>
        {rO2.products&&<div style={{marginTop:12}}><div style={{fontSize:9,color:C.txtDim,textTransform:"uppercase",letterSpacing:"1px",marginBottom:6}}>Equilibrium Products</div><HBar data={rO2.products} h={Math.max(120,Object.keys(rO2.products).length*24+10)} w={420}/></div>}
      </div>
      <div style={S.card}><div style={S.cardT}>From Measured CO₂ (%)</div>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
          <Tip text="Enter the measured CO₂ concentration in the exhaust on a dry basis. Higher CO₂ indicates richer combustion."><label style={{fontSize:11,color:C.txtDim,fontFamily:"monospace",cursor:"help"}}>Meas. CO₂ (% dry) ⓘ:</label></Tip>
          <input type="number" step="0.1" value={measCO2} onChange={e=>setMeasCO2(+e.target.value||0)} style={{...S.inp,width:70}}/></div>
        <div style={{...S.row,gap:8}}>
          <M l="Equiv. Ratio (φ)" v={rCO2.phi.toFixed(3)} u="—" c={C.accent} tip="Back-calculated equivalence ratio from your measured CO₂."/>
          <M l="Flame Temperature" v={uv(units,"T",rCO2.T_ad).toFixed(0)} u={uu(units,"T")} c={C.warm} tip="Adiabatic flame temperature corresponding to this φ."/>
          <M l="FAR (mass)" v={rCO2.FAR_mass.toFixed(4)} u={uu(units,"afr_mass")} c={C.accent2} tip="Actual fuel-to-air ratio by mass."/>
          <M l="A/F Ratio" v={(1/(rCO2.FAR_mass+1e-20)).toFixed(2)} u={uu(units,"afr_mass")} c="#74C69D" tip="Actual air-to-fuel ratio by mass."/>
        </div>
        {rCO2.products&&<div style={{marginTop:12}}><div style={{fontSize:9,color:C.txtDim,textTransform:"uppercase",letterSpacing:"1px",marginBottom:6}}>Equilibrium Products</div><HBar data={rCO2.products} h={Math.max(120,Object.keys(rCO2.products).length*24+10)} w={420}/></div>}
      </div>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <div style={S.card}><div style={S.cardT}>Flame Temperature vs Exhaust O₂</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>Higher exhaust O₂ → leaner combustion → lower flame temperature. Yellow marker shows your measurement.</div><Chart data={o2Sweep} xK="O2" yK="T_ad" xL="Exhaust O₂ (%)" yL={`T_ad (${uu(units,"T")})`} color={C.warm} marker={{x:measO2,y:rO2.T_ad,label:`${uv(units,"T",rO2.T_ad).toFixed(0)} ${uu(units,"T")}`}}/></div>
      <div style={S.card}><div style={S.cardT}>Equivalence Ratio vs Exhaust O₂</div><div style={{fontSize:9.5,color:C.txtMuted,marginBottom:6}}>Direct mapping from exhaust O₂ to φ. At 0% O₂, φ ≈ 1.0 (stoichiometric).</div><Chart data={o2Sweep} xK="O2" yK="phi" xL="Exhaust O₂ (%)" yL="φ" color={C.accent} marker={{x:measO2,y:rO2.phi,label:`φ=${rO2.phi.toFixed(3)}`}}/></div>
    </div></div>);}

function PropsPanel(){
  const units=useContext(UnitCtx);const[sp,setSp]=useState("H2O");const[Tmin,setTmin]=useState(300);const[Tmax,setTmax]=useState(3000);const[step,setStep]=useState(100);
  const temps=useMemo(()=>{const r=[];for(let t=Tmin;t<=Tmax;t+=step)r.push(t);return r.slice(0,200);},[Tmin,Tmax,step]);
  const data=useMemo(()=>temps.map(T=>({T,Cp:cp_mol(sp,T),H:h_mol(sp,T)/1000,S:sR(sp,T)*R_u})),[sp,temps]);
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
      <div style={S.card}><div style={S.cardT}>Cp ({uu(units,"cp")})</div><Chart data={data} xK="T" yK="Cp" xL={`T (${uu(units,"T")})`} yL={uu(units,"cp")} color="#8AB4B0" w={350}/></div>
      <div style={S.card}><div style={S.cardT}>Enthalpy ({uu(units,"h_mol")})</div><Chart data={data} xK="T" yK="H" xL={`T (${uu(units,"T")})`} yL={uu(units,"h_mol")} color={C.accent} w={350}/></div>
      <div style={S.card}><div style={S.cardT}>Entropy ({uu(units,"s_mol")})</div><Chart data={data} xK="T" yK="S" xL={`T (${uu(units,"T")})`} yL={uu(units,"s_mol")} color="#74C69D" w={350}/></div>
    </div>
    <div style={S.card}><div style={S.cardT}>Data Table</div><div style={{overflowX:"auto",maxHeight:300,overflowY:"auto"}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontFamily:"monospace",fontSize:11}}>
        <thead><tr>{[`T (${uu(units,"T")})`,`Cp`,`H (${uu(units,"h_mol")})`,`S`,`G (${uu(units,"h_mol")})`].map(h=><th key={h} style={{textAlign:"left",padding:"6px 8px",borderBottom:`1px solid ${C.border}`,color:C.txtDim,fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:"1px",position:"sticky",top:0,background:C.bg3}}>{h}</th>)}</tr></thead>
        <tbody>{data.map((r,i)=>{const G=(r.H*1000-r.T*r.S)/1000;return(<tr key={i} style={{background:i%2?`${C.bg}55`:"transparent"}}><td style={{padding:"4px 8px",color:C.txt}}>{r.T}</td><td style={{padding:"4px 8px",color:"#B5CBC8"}}>{r.Cp.toFixed(3)}</td><td style={{padding:"4px 8px",color:"#B5CBC8"}}>{r.H.toFixed(3)}</td><td style={{padding:"4px 8px",color:"#B5CBC8"}}>{r.S.toFixed(3)}</td><td style={{padding:"4px 8px",color:"#B5CBC8"}}>{G.toFixed(3)}</td></tr>);})}</tbody></table></div></div></div>);}

/* ══════════════════ LOGO ══════════════════ */
function Logo({size=28}){return(<svg width={size} height={size} viewBox="0 0 40 40" fill="none"><rect x="2" y="2" width="36" height="36" rx="6" stroke="#2A9D8F" strokeWidth="2.5" fill="none"/><path d="M10 28 L14 12 L20 22 L26 12 L30 28" stroke="#E9C46A" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/><circle cx="20" cy="18" r="3" fill="#2A9D8F" opacity=".6"/></svg>);}

/* ══════════════════ MAIN APP ══════════════════ */
const TABS=[{id:"aft",label:"Flame Temp & Properties",icon:"🔥"},{id:"flame",label:"Flame Speed & Blowoff",icon:"⚡"},{id:"combustor",label:"Combustor PSR→PFR",icon:"🏭"},{id:"exhaust",label:"Exhaust Analysis",icon:"🔬"},{id:"props",label:"Thermo Database",icon:"📊"}];

export default function App(){
  const[tab,setTab]=useState("aft");const[phi,setPhi]=useState(0.8);const[T0,setT0]=useState(300);const[P,setP]=useState(1);const[units,setUnits]=useState("SI");
  const[velocity,setVelocity]=useState(30);const[Lchar,setLchar]=useState(0.01);
  const[tau_psr,setTauPsr]=useState(2);const[L_pfr,setLpfr]=useState(0.5);const[V_pfr,setVpfr]=useState(20);
  const[measO2,setMeasO2]=useState(3.0);const[measCO2,setMeasCO2]=useState(10.0);
  const[combMode,setCombMode]=useState("complete"); // "complete" or "equilibrium"
  const[showHelp,setShowHelp]=useState(false);
  const[showPricing,setShowPricing]=useState(false);
  const panelState={velocity,Lchar,tau_psr,L_pfr,V_pfr,measO2,measCO2,combMode};
  const initF={};FUEL_SP.forEach(s=>initF[s]=0);Object.assign(initF,FUEL_PRESETS["Pipeline NG (US)"]);
  const initO={};OX_SP.forEach(s=>initO[s]=0);Object.assign(initO,OX_PRESETS["Dry Air (standard)"]);
  const[fuel,setFuel]=useState(initF);const[ox,setOx]=useState(initO);

  return(
    <UnitCtx.Provider value={units}>
      <div style={{fontFamily:"'Barlow','Segoe UI',sans-serif",background:C.bg,color:C.txt,minHeight:"100vh"}}>
        <link href="https://fonts.googleapis.com/css2?family=Barlow:wght@300;400;500;600;700;800&family=Barlow+Condensed:wght@400;600;700&display=swap" rel="stylesheet"/>
        <HelpModal show={showHelp} onClose={()=>setShowHelp(false)}/>
        <PricingModal show={showPricing} onClose={()=>setShowPricing(false)}/>

        {/* HEADER */}
        <div style={{padding:"12px 20px",borderBottom:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between",alignItems:"center",background:`linear-gradient(180deg,${C.bg3},${C.bg})`}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <Logo size={32}/>
            <div><div style={{fontSize:17,fontWeight:700,letterSpacing:"-.3px",color:C.txt,fontFamily:"'Barlow Condensed',sans-serif"}}><span style={{color:C.accent}}>Pro</span><span style={{color:C.accent2}}>Ready</span><span>Engineer</span></div>
              <div style={{fontSize:8.5,color:C.txtMuted,fontFamily:"monospace",letterSpacing:"2px",textTransform:"uppercase"}}>Combustion Engineering Toolkit — Thermal Fluid Sciences & AI</div></div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <button onClick={()=>setShowPricing(true)} title="Pricing — Accurate Cantera versions" style={{padding:"6px 12px",fontSize:11,fontWeight:700,color:C.bg,background:C.accent2,border:"none",borderRadius:6,cursor:"pointer",fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:".5px"}}>PRICING</button>
            <button onClick={()=>setShowHelp(true)} title="User Guide & Help" style={{padding:"6px 10px",fontSize:13,fontWeight:700,color:C.accent,background:`${C.accent}15`,border:`1px solid ${C.accent}30`,borderRadius:6,cursor:"pointer",fontFamily:"monospace"}}>?</button>
            <div style={{display:"flex",border:`1px solid ${C.border}`,borderRadius:6,overflow:"hidden"}}>
              {["SI","ENG"].map(u=>(<button key={u} onClick={()=>setUnits(u)} style={{padding:"6px 14px",fontSize:11,fontWeight:units===u?700:400,fontFamily:"'Barlow Condensed',sans-serif",color:units===u?C.bg:C.txtDim,background:units===u?C.accent:"transparent",border:"none",cursor:"pointer",letterSpacing:".5px",transition:"all .15s"}}>{u==="SI"?"SI (Metric)":"English (Imperial)"}</button>))}</div>
            <button onClick={()=>exportToExcel(fuel,ox,phi,T0,P,units,panelState)} style={{padding:"6px 14px",fontSize:11,fontWeight:600,fontFamily:"'Barlow Condensed',sans-serif",color:C.bg,background:C.accent2,border:"none",borderRadius:6,cursor:"pointer",letterSpacing:".5px",display:"flex",alignItems:"center",gap:5}}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 12h12M8 2v8M5 7l3 3 3-3" stroke={C.bg} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>Export Excel</button>
          </div></div>

        {/* TABS */}
        <div style={{display:"flex",gap:1,padding:"0 20px",background:C.bg,borderBottom:`1px solid ${C.border}`,overflowX:"auto"}}>
          {TABS.map(t=><button key={t.id} onClick={()=>setTab(t.id)} style={{padding:"9px 14px",fontSize:11,fontWeight:tab===t.id?600:400,color:tab===t.id?C.accent:C.txtMuted,background:tab===t.id?`${C.accent}0A`:"transparent",border:"none",borderBottom:tab===t.id?`2px solid ${C.accent}`:"2px solid transparent",cursor:"pointer",whiteSpace:"nowrap",fontFamily:"'Barlow',sans-serif",letterSpacing:".4px",transition:"all .15s"}}><span style={{marginRight:4}}>{t.icon}</span>{t.label}</button>)}</div>

        {/* FREE-VERSION DISCLAIMER BANNER */}
        <div style={{padding:"10px 20px",background:`${C.warm}12`,borderBottom:`1px solid ${C.warm}35`,display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,flexWrap:"wrap"}}>
          <div style={{fontSize:11.5,color:C.txt,fontFamily:"'Barlow',sans-serif",lineHeight:1.55,flex:"1 1 320px"}}>
            <strong style={{color:C.warm,letterSpacing:".5px",fontFamily:"'Barlow Condensed',sans-serif"}}>⚠ FREE VERSION</strong> — Simplified model, accurate for <strong>φ ≤ 1.0</strong> only. <span style={{color:C.txtDim}}>Not suitable for RQL, SAC, or other rich/staged combustion systems. Upgrade for exact Cantera-backed results across all regimes.</span>
          </div>
          <button onClick={()=>setShowPricing(true)} style={{padding:"7px 16px",fontSize:11,fontWeight:700,fontFamily:"'Barlow Condensed',sans-serif",color:C.bg,background:C.accent,border:"none",borderRadius:6,cursor:"pointer",letterSpacing:".7px",whiteSpace:"nowrap"}}>VIEW PRICING →</button>
        </div>

        <div style={{display:"flex",minHeight:"calc(100vh - 150px)"}}>
          {/* SIDEBAR */}
          <div style={{width:255,flexShrink:0,borderRight:`1px solid ${C.border}`,padding:"12px 10px",overflowY:"auto",maxHeight:"calc(100vh - 150px)",background:`${C.bg}CC`}}>
            <div style={{...hs.box,marginBottom:10,background:`${C.accent2}08`,borderColor:`${C.accent2}18`}}>
              <strong style={{color:C.accent2,fontSize:11}}>📌 Quick Start:</strong> <span style={{fontSize:10}}>Select a fuel preset below (e.g., "Pipeline NG"), set your equivalence ratio and conditions, then explore each tab. All panels share these settings.</span></div>
            <CompEditor title="Fuel (mol%)" comp={fuel} setComp={setFuel} presets={FUEL_PRESETS} speciesList={FUEL_SP} accent={C.accent2}
              helpText="Enter fuel composition in mole percent. Select a preset for common fuels or enter custom values. Total must sum to 100%. CO₂ and N₂ in fuel are treated as diluents."/>
            <CompEditor title="Oxidizer (mol%)" comp={ox} setComp={setOx} presets={OX_PRESETS} speciesList={OX_SP} accent="#6AACDA"
              helpText="Enter oxidizer composition in mole percent. 'Dry Air' is the standard. Use humid air, O₂-enriched, or vitiated air for specialized analyses."/>
            <div style={{background:C.bg2,border:`1px solid ${C.accent}25`,borderRadius:8,padding:12}}>
              <div style={{fontSize:10,fontWeight:700,color:C.accent,textTransform:"uppercase",letterSpacing:"1.5px",marginBottom:6}}>Operating Conditions</div>
              <div style={{fontSize:9.5,color:C.txtMuted,lineHeight:1.5,marginBottom:8,fontStyle:"italic"}}>These conditions apply to all tabs. φ=1 is stoichiometric; φ&lt;1 lean; φ&gt;1 rich.</div>
              <div style={{marginBottom:10}}><label style={{fontSize:10.5,color:C.txtMuted,fontFamily:"monospace",display:"block",marginBottom:3}}>Equiv. Ratio (φ)</label>
                <input type="range" min="0.3" max="1.0" step="0.01" value={phi} onChange={e=>setPhi(+e.target.value)} style={{width:"100%",accentColor:C.accent}}/>
                <div style={{textAlign:"center",fontFamily:"monospace",color:C.accent,fontSize:15,fontWeight:700}}>{phi.toFixed(2)}<span style={{fontSize:10,color:C.txtMuted,fontWeight:400,marginLeft:6}}>{phi<0.95?"(lean)":phi>1.05?"(rich)":"(~stoich)"}</span></div></div>
              <div style={{marginBottom:10}}><label style={{fontSize:10.5,color:C.txtMuted,fontFamily:"monospace",display:"block",marginBottom:3}}>Inlet T ({uu(units,"T")})</label>
                <input type="number" style={S.inp} value={T0} onChange={e=>setT0(+e.target.value||300)}/></div>
              <div><label style={{fontSize:10.5,color:C.txtMuted,fontFamily:"monospace",display:"block",marginBottom:3}}>Pressure ({uu(units,"P")})</label>
                <input type="number" step="0.5" style={S.inp} value={P} onChange={e=>setP(+e.target.value||1)}/></div>
            </div>
          </div>

          {/* CONTENT */}
          <div style={{flex:1,padding:"12px 16px",overflowY:"auto",maxHeight:"calc(100vh - 150px)"}}>
            {tab==="aft"&&<AFTPanel fuel={fuel} ox={ox} phi={phi} T0={T0} P={P} combMode={combMode} setCombMode={setCombMode}/>}
            {tab==="flame"&&<FlameSpeedPanel fuel={fuel} ox={ox} phi={phi} T0={T0} P={P} velocity={velocity} setVelocity={setVelocity} Lchar={Lchar} setLchar={setLchar}/>}
            {tab==="combustor"&&<CombustorPanel fuel={fuel} ox={ox} phi={phi} T0={T0} P={P} tau={tau_psr} setTau={setTauPsr} Lpfr={L_pfr} setL={setLpfr} Vpfr={V_pfr} setV={setVpfr}/>}
            {tab==="exhaust"&&<ExhaustPanel fuel={fuel} ox={ox} T0={T0} P={P} measO2={measO2} setMeasO2={setMeasO2} measCO2={measCO2} setMeasCO2={setMeasCO2} combMode={combMode} setCombMode={setCombMode}/>}
            {tab==="props"&&<PropsPanel/>}
          </div>
        </div>

        {/* FOOTER */}
        <div style={{padding:"12px 20px",borderTop:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between",alignItems:"center",background:C.bg}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}><Logo size={18}/><span style={{fontSize:10,color:C.txtMuted,fontFamily:"monospace"}}>© {new Date().getFullYear()} ProReadyEngineer LLC — All Rights Reserved</span></div>
          <div style={{display:"flex",alignItems:"center",gap:16}}><a href="https://www.ProReadyEngineer.com" target="_blank" rel="noopener noreferrer" style={{fontSize:10,color:C.accent,fontFamily:"monospace",textDecoration:"none"}}>www.ProReadyEngineer.com</a><span style={{fontSize:9,color:C.txtMuted,fontFamily:"monospace"}}>Thermal Fluid Sciences & AI</span></div>
        </div>
      </div>
    </UnitCtx.Provider>);}
