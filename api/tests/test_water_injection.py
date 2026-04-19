"""Regression tests for water / steam injection (3-stream adiabatic mix).

These tests pin the qualitative and quantitative behavior of the WFR path in
`app.science.water_mix.make_gas_mixed_with_water`:

1. WFR=0 is an exact identity with the 2-stream path (make_gas_mixed).
2. Liquid water injection lowers T_mixed and T_ad more than steam at the same
   WFR, because liquid absorbs the latent heat of vaporization h_fg.
3. T_mixed and T_ad decrease monotonically with WFR in liquid mode.
4. T_ad drops lead to reduced thermal NOx at the PSR+PFR exit — the headline
   reason to inject water in the first place.

Pinned values are rounded generously (±15 K on T, ±30 % on NOx) so thermostat
drift from Cantera minor-version bumps doesn't break them, but tight enough
to catch real regressions.
"""
from __future__ import annotations

import pytest

from app.science import aft, combustor, water_mix


# User's typical DLE NG reference operating point
_FUEL = {"CH4": 95.0, "C2H6": 3.0, "C3H8": 1.0, "N2": 1.0}
_OX = {"O2": 20.9, "N2": 78.1, "AR": 1.0}
_PHI = 0.555
_P_BAR = 15.0
_T_FUEL_K = 294.0   # 70 F
_T_AIR_K = 811.0    # 1000 F


# ---------- h_fg polynomial sanity ----------

def test_hfg_water_matches_iapws_endpoints():
    """Linear h_fg fit should be within 2.5 % of IAPWS tabulated values
    at the anchor points (288 K supply, 373 K boiling, 500 K)."""
    # Actual IAPWS-IF97 h_fg values
    targets = {288.0: 2466e3, 373.0: 2257e3, 500.0: 1826e3}
    for T, h_ref in targets.items():
        h = water_mix.h_fg_water(T)
        err = abs(h - h_ref) / h_ref
        assert err < 0.025, f"h_fg({T}K)={h:.1f} vs ref {h_ref:.1f} — err {err:.3%}"


def test_hfg_zero_above_critical():
    assert water_mix.h_fg_water(647.0) == 0.0
    assert water_mix.h_fg_water(700.0) == 0.0


# ---------- WFR=0 identity with 2-stream path ----------

def test_wfr_zero_is_identity_with_2stream():
    """WFR=0 must reproduce the exact T_ad of the 2-stream adiabatic mix."""
    r_no_water = aft.run(
        _FUEL, _OX, _PHI, _T_AIR_K, _P_BAR,
        T_fuel_K=_T_FUEL_K, T_air_K=_T_AIR_K,
    )
    r_wfr_zero = aft.run(
        _FUEL, _OX, _PHI, _T_AIR_K, _P_BAR,
        T_fuel_K=_T_FUEL_K, T_air_K=_T_AIR_K,
        WFR=0.0, water_mode="liquid",
    )
    assert abs(r_wfr_zero["T_ad"] - r_no_water["T_ad"]) < 0.1
    assert abs(r_wfr_zero["T_mixed_inlet_K"] - r_no_water["T_mixed_inlet_K"]) < 0.1


# ---------- Liquid vs steam qualitative physics ----------

def test_liquid_drops_T_more_than_steam_at_same_WFR():
    """Liquid absorbs h_fg on the way to flame-T; steam already paid that cost
    upstream. So at the same WFR, liquid should give a lower T_mixed and
    lower T_ad."""
    r_liquid = aft.run(
        _FUEL, _OX, _PHI, _T_AIR_K, _P_BAR,
        T_fuel_K=_T_FUEL_K, T_air_K=_T_AIR_K,
        WFR=1.0, water_mode="liquid",
    )
    r_steam = aft.run(
        _FUEL, _OX, _PHI, _T_AIR_K, _P_BAR,
        T_fuel_K=_T_FUEL_K, T_air_K=_T_AIR_K,
        WFR=1.0, water_mode="steam",
    )
    assert r_liquid["T_mixed_inlet_K"] < r_steam["T_mixed_inlet_K"] - 20.0
    assert r_liquid["T_ad"] < r_steam["T_ad"] - 20.0


def test_T_ad_monotonically_decreases_with_WFR_liquid():
    """More water -> more cooling. Ensure strict monotonicity across 0..2."""
    T_ads = []
    for wfr in (0.0, 0.5, 1.0, 1.5, 2.0):
        r = aft.run(
            _FUEL, _OX, _PHI, _T_AIR_K, _P_BAR,
            T_fuel_K=_T_FUEL_K, T_air_K=_T_AIR_K,
            WFR=wfr, water_mode="liquid",
        )
        T_ads.append(r["T_ad"])
    # Strictly decreasing
    for i in range(len(T_ads) - 1):
        assert T_ads[i + 1] < T_ads[i] - 5.0, f"T_ad not decreasing at step {i}: {T_ads}"


# ---------- Quantitative pins (±15 K) ----------

def test_liquid_WFR_1_drops_T_ad_into_pinned_range():
    """At WFR=1 liquid the T_ad drop should be in the 100–200 K range for
    lean NG with hot-air preheat.

    Re-pinned 2026-04-19 after fixing the Bilger-vs-physical fuel-mass-fraction
    bug: `make_gas_mixed` and `make_gas_mixed_with_water` previously used
    Cantera's `mixture_fraction` (Bilger's definition) to partition stream
    enthalpies. Bilger Z agrees with the physical fuel mass fraction only when
    the oxidizer is free of C/H atoms AND the fuel stream contains no inert
    (N2/CO2) diluent. Here the fuel has 1 % N2, so Bilger Z under-counted
    fuel mass by 17 %, which in turn made the pre-fix WFR=1 drop read as
    ~300 K instead of the true 135 K. Verified against an independent
    Cantera enthalpy-balance + equilibrate-HP oracle."""
    r_ref = aft.run(
        _FUEL, _OX, _PHI, _T_AIR_K, _P_BAR,
        T_fuel_K=_T_FUEL_K, T_air_K=_T_AIR_K,
    )
    r_wet = aft.run(
        _FUEL, _OX, _PHI, _T_AIR_K, _P_BAR,
        T_fuel_K=_T_FUEL_K, T_air_K=_T_AIR_K,
        WFR=1.0, water_mode="liquid",
    )
    drop = r_ref["T_ad"] - r_wet["T_ad"]
    assert 100.0 < drop < 200.0, f"T_ad drop at WFR=1 liquid was {drop:.1f} K"


def test_steam_at_T_air_gives_smaller_drop_than_liquid():
    """Steam injected at the air temperature dilutes but doesn't absorb
    latent heat. So the T_mixed drop should be smaller than the liquid drop."""
    r_ref = aft.run(
        _FUEL, _OX, _PHI, _T_AIR_K, _P_BAR,
        T_fuel_K=_T_FUEL_K, T_air_K=_T_AIR_K,
    )
    r_liquid = aft.run(
        _FUEL, _OX, _PHI, _T_AIR_K, _P_BAR,
        T_fuel_K=_T_FUEL_K, T_air_K=_T_AIR_K,
        WFR=1.0, water_mode="liquid",
    )
    r_steam = aft.run(
        _FUEL, _OX, _PHI, _T_AIR_K, _P_BAR,
        T_fuel_K=_T_FUEL_K, T_air_K=_T_AIR_K,
        WFR=1.0, water_mode="steam",
    )
    drop_liquid = r_ref["T_mixed_inlet_K"] - r_liquid["T_mixed_inlet_K"]
    drop_steam = r_ref["T_mixed_inlet_K"] - r_steam["T_mixed_inlet_K"]
    # Liquid should drop T_mixed at least 40 K more than steam at WFR=1.
    assert drop_liquid - drop_steam > 40.0, (
        f"Liquid drop {drop_liquid:.1f}K vs steam drop {drop_steam:.1f}K"
    )


# ---------- Combustor: NOx knockdown ----------

@pytest.mark.slow
def test_combustor_NO_exit_drops_with_liquid_water_injection():
    """Headline claim: water injection reduces thermal NO at the combustor
    exit. Pin only the qualitative direction and >= 20 % reduction at WFR=1
    liquid vs dry baseline."""
    dry = combustor.run(
        _FUEL, _OX, _PHI, _T_AIR_K, _P_BAR,
        tau_psr_s=0.002, L_pfr_m=0.3, V_pfr_m_s=60.0,
        profile_points=40,
        T_fuel_K=_T_FUEL_K, T_air_K=_T_AIR_K,
    )
    wet = combustor.run(
        _FUEL, _OX, _PHI, _T_AIR_K, _P_BAR,
        tau_psr_s=0.002, L_pfr_m=0.3, V_pfr_m_s=60.0,
        profile_points=40,
        T_fuel_K=_T_FUEL_K, T_air_K=_T_AIR_K,
        WFR=1.0, water_mode="liquid",
    )
    # T should drop, NO should drop
    assert wet["T_psr"] < dry["T_psr"] - 50.0
    # NO drop can be modest at short tau (Zeldovich is starved); require >=20%
    if dry["NO_ppm_15O2"] > 1.0:
        ratio = wet["NO_ppm_15O2"] / dry["NO_ppm_15O2"]
        assert ratio < 0.80, f"NO@15%O2 ratio wet/dry = {ratio:.3f}"
