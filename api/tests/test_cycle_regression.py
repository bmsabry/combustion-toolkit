"""Regression tests for the gas-turbine cycle solver (LM6000PF, LMS100PB+).

The pinned design-point anchors are the hard constraints the user gave:

    LMS100PB+ at 44°F / 80% RH / 1.013 bar / 100% load:
        T3 = 644.26 K,  P3 = 44.0 bar,  T4 = 1825.37 K, MW_net = 107.5
        η_LHV ≈ 44 %  (heat rate ≈ 8180 kJ/kWh)

    LM6000PF  at 60°F / 60% RH / 1.013 bar / 100% load:
        T3 = 810.93 K,  P3 = 30.3  bar, T4 = 1755.37 K, MW_net = 45.0
        η_LHV ≈ 42 %  (heat rate ≈ 8500 kJ/kWh)

Efficiency is pinned by a PRIVATE per-engine `thermal_eff_calibration`
factor that folds in cooling/stack/mechanical losses a 1-D cycle model
doesn't resolve. It is NOT the same as combustor_air_frac.

combustor_air_frac is a pure intra-combustor split (flame zone / dilution),
exposed to the user to drive the bulk flame state:
    FAR_Bulk = FAR4 / combustor_air_frac
    phi_Bulk = phi4 / combustor_air_frac
    T_Bulk   = HP equilibrium product T at (T3, P3, phi_Bulk)
It MUST NOT affect MW_net, η, T3, T4, P3, or fuel flow.

Tests below pin both the thermodynamic stations and the design efficiency
so we catch regressions in either direction.
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
    # Published efficiency must land near 44 % LHV (±0.5 pt)
    assert r["efficiency_LHV"] == pytest.approx(0.440, abs=0.005), r["efficiency_LHV"]
    # Heat rate ~8180 kJ/kWh at 44 % eff
    assert r["heat_rate_kJ_per_kWh"] == pytest.approx(8180.0, abs=100.0)


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
    # Published efficiency must land near 42 % LHV
    assert r["efficiency_LHV"] == pytest.approx(0.424, abs=0.010), r["efficiency_LHV"]
    assert r["heat_rate_kJ_per_kWh"] == pytest.approx(8490.0, abs=150.0)


def test_lms100_efficiency_exceeds_lm6000_at_design():
    """The whole point of the LMS100 intercooler: thermal efficiency must
    beat the non-intercooled LM6000 at each engine's own design point."""
    r_lms = cycle.run("LMS100PB+", 1.01325, 279.817, 80.0, 100.0)
    r_lm = cycle.run("LM6000PF", 1.01325, 288.706, 60.0, 100.0)
    assert r_lms["efficiency_LHV"] > r_lm["efficiency_LHV"] + 0.010, (
        f"IC engine must beat non-IC engine by >1 pt: {r_lms['efficiency_LHV']} vs {r_lm['efficiency_LHV']}"
    )


def test_combustor_air_frac_is_pure_flame_dilution_split():
    """combustor_air_frac must NOT affect η, MW_net, fuel flow, or any
    thermodynamic station. It is a pure flame/dilution split: its only
    job is to set the flame-zone state (FAR_Bulk, phi_Bulk, T_Bulk).
    """
    r_low = cycle.run("LMS100PB+", 1.01325, 279.817, 80.0, 100.0, combustor_air_frac=0.60)
    r_default = cycle.run("LMS100PB+", 1.01325, 279.817, 80.0, 100.0)
    r_high = cycle.run("LMS100PB+", 1.01325, 279.817, 80.0, 100.0, combustor_air_frac=1.00)
    # Everything thermodynamic, flow-related, or performance-related is invariant:
    for r in (r_low, r_high):
        assert r["T3_K"] == pytest.approx(r_default["T3_K"])
        assert r["P3_bar"] == pytest.approx(r_default["P3_bar"])
        assert r["T4_K"] == pytest.approx(r_default["T4_K"])
        assert r["MW_net"] == pytest.approx(r_default["MW_net"])
        assert r["mdot_fuel_kg_s"] == pytest.approx(r_default["mdot_fuel_kg_s"])
        assert r["FAR4"] == pytest.approx(r_default["FAR4"])
        assert r["phi4"] == pytest.approx(r_default["phi4"])
        assert r["efficiency_LHV"] == pytest.approx(r_default["efficiency_LHV"])
        assert r["heat_rate_kJ_per_kWh"] == pytest.approx(r_default["heat_rate_kJ_per_kWh"])


def test_far_bulk_consistency():
    """FAR_Bulk = FAR4 / combustor_air_frac, phi_Bulk = phi4 / combustor_air_frac.
    These are the flame-zone values the downstream panels consume."""
    frac = 0.80
    r = cycle.run("LM6000PF", 1.01325, 288.706, 60.0, 100.0, combustor_air_frac=frac)
    assert r["FAR_Bulk"] == pytest.approx(r["FAR4"] / frac, rel=1e-9)
    assert r["phi_Bulk"] == pytest.approx(r["phi4"] / frac, rel=1e-9)
    # Legacy alias `phi` must now follow phi_Bulk (sidebar linkage target)
    assert r["phi"] == pytest.approx(r["phi_Bulk"], rel=1e-9)


def test_t_bulk_hotter_when_flame_zone_is_smaller():
    """Smaller combustor_air_frac → flame zone sees less air at the same fuel
    load → richer bulk φ → hotter T_Bulk. At frac = 1.0, T_Bulk collapses to T4.
    """
    r_full = cycle.run("LM6000PF", 1.01325, 288.706, 60.0, 100.0, combustor_air_frac=1.00)
    r_split = cycle.run("LM6000PF", 1.01325, 288.706, 60.0, 100.0, combustor_air_frac=0.70)
    # With no split, bulk = exit
    assert r_full["T_Bulk_K"] == pytest.approx(r_full["T4_K"], abs=3.0)
    assert r_full["phi_Bulk"] == pytest.approx(r_full["phi4"], rel=1e-9)
    # With a split, flame is richer and hotter
    assert r_split["phi_Bulk"] > r_split["phi4"]
    assert r_split["T_Bulk_K"] > r_split["T4_K"] + 50.0, (
        f"T_Bulk={r_split['T_Bulk_K']:.1f} should exceed T4={r_split['T4_K']:.1f} "
        f"by >50 K at frac=0.70"
    )


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

def test_phi4_from_t4_is_lean():
    """Design-point combustor-exit phi4 must be clearly lean (<0.6) for both engines.

    FAR4 must be near phi4·FAR_stoich ≈ 0.03 for lean DLE combustion. FAR4 is
    the only physically meaningful FAR — it's what produces T4 adiabatically
    and what feeds Flame Temp / Flame Speed / PSR-PFR / Blowoff / Exhaust.
    """
    r_lms = cycle.run("LMS100PB+", 1.01325, 279.817, 80.0, 100.0)
    r_lm = cycle.run("LM6000PF", 1.01325, 288.706, 60.0, 100.0)
    # Combustor-exit phi4 (also the linked sidebar phi that drives T_ad on Flame Temp)
    assert 0.4 < r_lms["phi4"] < 0.6
    assert 0.4 < r_lm["phi4"] < 0.6
    # FAR4 ~ phi4·FAR_stoich, where FAR_stoich(CH4/humid-air) ≈ 0.058
    assert 0.020 < r_lms["FAR4"] < 0.040
    assert 0.020 < r_lm["FAR4"] < 0.040
    # Legacy `phi` alias tracks phi_Bulk (sidebar linkage drives the flame zone,
    # which is what the downstream panels model — not the diluted combustor exit).
    for r in (r_lms, r_lm):
        assert r["phi"] == pytest.approx(r["phi_Bulk"], rel=1e-9)


def test_aft_at_phi_bulk_equals_t_bulk():
    """Integration guard for the sidebar linkages. With Oxidizer linked to
    humid air, T_air=T3, P=P3, and phi=phi_Bulk, the AFT panel must reproduce
    T_Bulk. This is what the user sees on the Flame Temp / Flame Speed /
    PSR-PFR / Blowoff / Exhaust panels when all link toggles are ON — they
    all model the flame zone, which is exactly T_Bulk.

    At combustor_air_frac = 1.0 the bulk collapses to the combustor exit,
    so T_Bulk = T4. This is a good debug point. We test a real split too.
    """
    from app.science import aft
    fuel = {"CH4": 95.0, "C2H6": 3.0, "C3H8": 1.0, "N2": 1.0}
    # Case A: no split — bulk = exit, so AFT @ phi_Bulk must equal T4.
    r = cycle.run("LM6000PF", 1.01325, 288.706, 60.0, 100.0, combustor_air_frac=1.0)
    r_aft = aft.run(
        fuel_pct=fuel, ox_pct=r["oxidizer_humid_mol_pct"],
        phi=r["phi_Bulk"], T0_K=r["T3_K"], P_bar=r["P3_bar"],
        heat_loss_fraction=0.0, T_fuel_K=r["T3_K"], T_air_K=r["T3_K"],
        WFR=0.0, water_mode="liquid",
    )
    assert r_aft["T_ad"] == pytest.approx(r["T_Bulk_K"], abs=15.0)
    assert r_aft["T_ad"] == pytest.approx(r["T4_K"], abs=15.0)

    # Case B: realistic DLE split — T_Bulk > T4, and AFT @ phi_Bulk must match T_Bulk.
    r2 = cycle.run("LM6000PF", 1.01325, 288.706, 60.0, 100.0, combustor_air_frac=0.88)
    r2_aft = aft.run(
        fuel_pct=fuel, ox_pct=r2["oxidizer_humid_mol_pct"],
        phi=r2["phi_Bulk"], T0_K=r2["T3_K"], P_bar=r2["P3_bar"],
        heat_loss_fraction=0.0, T_fuel_K=r2["T3_K"], T_air_K=r2["T3_K"],
        WFR=0.0, water_mode="liquid",
    )
    assert r2_aft["T_ad"] == pytest.approx(r2["T_Bulk_K"], abs=15.0), (
        f"AFT T_ad={r2_aft['T_ad']:.1f} vs cycle T_Bulk={r2['T_Bulk_K']:.1f} — "
        f"downstream panels will NOT match the cycle's flame zone."
    )


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
