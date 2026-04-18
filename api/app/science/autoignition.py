"""Constant-pressure autoignition delay via Cantera 0D reactor.

Used to assess premixer flashback-by-autoignition safety: if the premixer
residence time τ_res is shorter than the ignition delay τ_ign, the premixed
mixture will not autoignite inside the premixer.

The ignition delay is defined here as the time at which the temperature
derivative dT/dt reaches its peak — the classic "max dT/dt" criterion.
"""
from __future__ import annotations

from typing import Dict, Optional

import cantera as ct
import numpy as np

from .mixture import make_gas, make_gas_mixed, mech_yaml


def run(
    fuel_pct: Dict[str, float],
    ox_pct: Dict[str, float],
    phi: float,
    T0_K: float,
    P_bar: float,
    max_time_s: float = 0.5,
    T_fuel_K: Optional[float] = None,
    T_air_K: Optional[float] = None,
    mechanism: str = "gri30",
) -> dict:
    """Integrate a const-P reactor from the premixed (fuel+air) state until
    max|dT/dt| occurs or max_time_s elapses.

    Returns τ_ign in seconds (= max_time_s if the mixture did not ignite),
    plus a downsampled (t, T) trace for plotting.
    """
    T_f = float(T_fuel_K) if T_fuel_K is not None else float(T0_K)
    T_a = float(T_air_K) if T_air_K is not None else float(T0_K)
    if T_fuel_K is not None or T_air_K is not None:
        gas, _, _, T_mixed = make_gas_mixed(
            fuel_pct, ox_pct, phi, T_f, T_a, P_bar, mechanism=mechanism
        )
    else:
        # make_gas is gri30-only; for non-gri mech fall back to mixed path w/ equal T's
        if mechanism != "gri30":
            gas, _, _, T_mixed = make_gas_mixed(
                fuel_pct, ox_pct, phi, float(T0_K), float(T0_K), P_bar, mechanism=mechanism
            )
        else:
            gas, _, _ = make_gas(fuel_pct, ox_pct, phi, T0_K, P_bar)
            T_mixed = float(T0_K)

    reactor = ct.IdealGasConstPressureReactor(gas)
    sim = ct.ReactorNet([reactor])
    sim.rtol = 1e-9
    sim.atol = 1e-15

    times = [0.0]
    temps = [float(reactor.T)]
    t = 0.0
    # Adaptive marching: start small, grow up to ~max_time/50
    dt = 1e-7
    dt_max = max_time_s / 50.0
    while t < max_time_s:
        t += dt
        try:
            sim.advance(t)
        except Exception:
            break
        times.append(t)
        temps.append(float(reactor.T))
        # If T has risen significantly from the initial value, we're past ignition
        if reactor.T > T_mixed + 400.0 and len(times) > 20:
            # continue a little beyond ignition to capture the full trace peak
            if reactor.T > T_mixed + 1200.0 or t > 5.0 * (times[np.argmax(np.gradient(temps, times))]):
                break
        dt = min(dt * 1.15, dt_max)

    t_arr = np.asarray(times)
    T_arr = np.asarray(temps)
    if len(t_arr) < 3:
        return {
            "tau_ign_s": float(max_time_s),
            "ignited": False,
            "T_mixed_inlet_K": float(T_mixed),
            "T_peak": float(T_arr.max() if len(T_arr) else T_mixed),
            "t_trace": t_arr.tolist(),
            "T_trace": T_arr.tolist(),
        }

    dTdt = np.gradient(T_arr, t_arr)
    idx_peak = int(np.argmax(dTdt))
    # Ignition considered observed only if temperature rose meaningfully
    ignited = bool((T_arr.max() - T_mixed) > 200.0 and dTdt[idx_peak] > 1e3)
    tau_ign = float(t_arr[idx_peak]) if ignited else float(max_time_s)

    # Downsample trace to <=200 points
    n = len(t_arr)
    step = max(1, n // 200)
    return {
        "tau_ign_s": tau_ign,
        "ignited": ignited,
        "T_mixed_inlet_K": float(T_mixed),
        "T_peak": float(T_arr.max()),
        "t_trace": t_arr[::step].tolist(),
        "T_trace": T_arr[::step].tolist(),
    }
