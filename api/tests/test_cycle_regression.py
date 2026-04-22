"""Regression tests for the gas-turbine cycle solver (LM6000PF, LMS100PB+).

The pinned design-point anchors are the two hard constraints the user gave:

    LMS100PB+ at 44°F / 80% RH / 1.013 bar / 100% load:
        T3 = 644.26 K,  P3 = 44.0 bar,  T4 = 1825.37 K,  MW_net = 107.5

    LM6000PF  at 60°F / 60% RH / 1.013 bar / 100% load:
        T3 = 810.93 K,  P3 = 30.3  bar, T4 = 1755.37 K,  MW_net = 45.0

At design these should be reproduced exactly (engine decks anchor there).
Off-design values are pinned loosely so that minor-version drift in Cantera
or tweaks to the correlation don't trigger false regressions.
"""
from __future__ import annotations

import pytest

from app.science import cycle


# -------------------------- design-point anchors ---------------------------

def test_lms100_design_anchor_exact():
    r = cycle.run("LMS100PB+", 1.01325, 279.817, 80.0, 100.0)
    assert r["T3_K"] == pytest.approx(644.26, abs=0.05)
    assert r["P3_bar"] == pytest.approx(44.0, abs=0.01)
    assert r["T4_K"] == pytest.approx(1825.37, abs=0.05)
    assert r["MW_net"] == pytest.approx(107.5, abs=0.05)
    assert r["intercooled"] is True
    # Intercooler duty must be positive and in a sensible range
    assert 20.0 < r["intercooler_duty_MW"] < 60.0


def test_lm6000_design_anchor_exact():
    r = cycle.run("LM6000PF", 1.01325, 288.706, 60.0, 100.0)
    assert r["T3_K"] == pytest.approx(810.93, abs=0.05)
    assert r["P3_bar"] == pytest.approx(30.3, abs=0.01)
    assert r["T4_K"] == pytest.approx(1755.37, abs=0.05)
    assert r["MW_net"] == pytest.approx(45.0, abs=0.05)
    assert r["intercooled"] is False
    # No intercooler path → T2 == T3, no IC duty
    assert r["T2_K"] == pytest.approx(r["T3_K"], abs=0.1)
    assert r["intercooler_duty_MW"] == 0.0


# ------------------------- ambient density trends --------------------------

def test_lms100_is_flat_on_hot_day():
    """LMS100's intercooler holds T3; MW drop to 95°F should be modest (<6 %)."""
    T_amb_95F = (95.0 - 32.0) * 5.0 / 9.0 + 273.15
    r = cycle.run("LMS100PB+", 1.01325, T_amb_95F, 60.0, 100.0)
    # T3 is regulated
    assert r["T3_K"] == pytest.approx(644.26, abs=1.0)
    # MW drop is famously flat
    mw_drop = (107.5 - r["MW_net"]) / 107.5
    assert 0.0 < mw_drop < 0.06
    # Intercooler duty is higher on the hot day
    assert r["intercooler_duty_MW"] > 35.0


def test_lm6000_loses_power_on_hot_day():
    """LM6000 has no intercooler; should drop ~9–12 % MW at 95°F vs 60°F design."""
    T_amb_95F = (95.0 - 32.0) * 5.0 / 9.0 + 273.15
    r = cycle.run("LM6000PF", 1.01325, T_amb_95F, 60.0, 100.0)
    # T3 rises as ambient rises
    assert r["T3_K"] > 830.0
    # MW drop is roughly 10 % per published lapse
    mw_drop = (45.0 - r["MW_net"]) / 45.0
    assert 0.07 < mw_drop < 0.13


# ------------------------------ part-load ----------------------------------

def test_load_scales_mw_linearly():
    """MW_net scales ~linearly with load (at the design ambient for each engine)."""
    # LMS100 at 50% load
    r50 = cycle.run("LMS100PB+", 1.01325, 279.817, 80.0, 50.0)
    assert r50["MW_net"] == pytest.approx(53.75, abs=0.1)
    # LM6000 at 50% load
    r50b = cycle.run("LM6000PF", 1.01325, 288.706, 60.0, 50.0)
    assert r50b["MW_net"] == pytest.approx(22.5, abs=0.1)


def test_part_load_drops_t4():
    """T4 decreases monotonically from 100 % → 50 % → 20 % load."""
    r100 = cycle.run("LM6000PF", 1.01325, 288.706, 60.0, 100.0)
    r50 = cycle.run("LM6000PF", 1.01325, 288.706, 60.0, 50.0)
    r20 = cycle.run("LM6000PF", 1.01325, 288.706, 60.0, 20.0)
    assert r100["T4_K"] > r50["T4_K"] > r20["T4_K"]
    # Idle T4 should be above combustor blowout (>1100 K) and below design
    assert 1050.0 < r20["T4_K"] < 1300.0


# ----------------------- FAR / phi consistency -----------------------------

def test_phi_from_t4_is_lean():
    """Design-point phi must be clearly lean (<0.6) for both engines."""
    r_lms = cycle.run("LMS100PB+", 1.01325, 279.817, 80.0, 100.0)
    r_lm = cycle.run("LM6000PF", 1.01325, 288.706, 60.0, 100.0)
    assert 0.4 < r_lms["phi"] < 0.6
    assert 0.4 < r_lm["phi"] < 0.6
    # FAR ~ 0.025–0.035 for lean natural gas DLE (phi·FAR_stoich, with FAR_stoich ≈ 0.058)
    assert 0.020 < r_lms["FAR"] < 0.040
    assert 0.020 < r_lm["FAR"] < 0.040


def test_efficiency_and_heat_rate_sensible():
    """Efficiency should land in the aero-derivative band (25–50 %) and HR > 6500 kJ/kWh."""
    for eng, T_amb, RH in [("LMS100PB+", 279.817, 80.0), ("LM6000PF", 288.706, 60.0)]:
        r = cycle.run(eng, 1.01325, T_amb, RH, 100.0)
        assert 0.25 < r["efficiency_LHV"] < 0.50, (eng, r["efficiency_LHV"])
        assert 6500.0 < r["heat_rate_kJ_per_kWh"] < 14000.0, (eng, r["heat_rate_kJ_per_kWh"])


# ------------------------------ input guards -------------------------------

def test_unknown_engine_raises():
    with pytest.raises(ValueError):
        cycle.run("7FA", 1.01325, 288.706, 60.0, 100.0)


def test_load_clamped_to_min_20():
    """load < 20 % gets clamped to 20 % internally."""
    r_low = cycle.run("LM6000PF", 1.01325, 288.706, 60.0, 5.0)
    r_20 = cycle.run("LM6000PF", 1.01325, 288.706, 60.0, 20.0)
    assert r_low["load_pct"] == pytest.approx(20.0)
    assert r_low["MW_net"] == pytest.approx(r_20["MW_net"], abs=0.01)
