"""Regression tests for the gas-turbine cycle solver (LM6000PF, LMS100PB+).

The pinned design-point anchors are the hard constraints the user gave:

    LMS100PB+ at 44°F / 80% RH / 1.013 bar / 100% load:
        T3 = 644.26 K,  P3 = 44.0 bar,  T4 = 1825.37 K, MW_net = 107.5
        η_LHV ≈ 44 %  (heat rate ≈ 8180 kJ/kWh)

    LM6000PF  at 60°F / 60% RH / 1.013 bar / 100% load:
        T3 = 810.93 K,  P3 = 30.3  bar, T4 = 1755.37 K, MW_net = 45.0
        η_LHV ≈ 42 %  (heat rate ≈ 8500 kJ/kWh)

Efficiency is a DERIVED output from the user-tunable combustor_air_frac
(the hot-section cooling-air bypass fraction). The per-engine default
combustor_air_frac is calibrated so the published design-point η is
reproduced when the user leaves the knob alone. Tests below pin both
the thermodynamic stations AND the design efficiency so we catch
regressions in either direction.
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


def test_combustor_air_frac_drives_efficiency():
    """Efficiency is a monotonic function of combustor_air_frac: smaller
    fraction (more cooling bypass) → less fuel burned → higher η."""
    r_low = cycle.run("LMS100PB+", 1.01325, 279.817, 80.0, 100.0, combustor_air_frac=0.60)
    r_default = cycle.run("LMS100PB+", 1.01325, 279.817, 80.0, 100.0)
    r_high = cycle.run("LMS100PB+", 1.01325, 279.817, 80.0, 100.0, combustor_air_frac=0.90)
    assert r_low["efficiency_LHV"] > r_default["efficiency_LHV"] > r_high["efficiency_LHV"]
    # Thermodynamic stations must NOT depend on the air split
    assert r_low["T3_K"] == pytest.approx(r_default["T3_K"])
    assert r_low["T4_K"] == pytest.approx(r_default["T4_K"])
    assert r_low["MW_net"] == pytest.approx(r_default["MW_net"])


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
    # Legacy `phi` alias must equal phi4 (so the linkFAR wiring still works)
    for r in (r_lms, r_lm):
        assert r["phi"] == pytest.approx(r["phi4"], rel=1e-9)


def test_t_ad_equals_t4_when_no_bypass():
    """Integration guard: when combustor_air_frac = 1.0 there's no air split,
    so running the adiabatic-flame-temperature solver (AFT) at (T3, P3, phi4,
    humid air at ambient) must reproduce T4. This proves the sidebar linkages
    (T_air←T3, Pressure←P3, phi←phi4, Oxidizer←humid air) carry the user
    from the Cycle panel to the Flame Temp / Flame Speed / PSR-PFR / Blowoff /
    Exhaust panels in a self-consistent way — the whole point of the link
    toggles. If this test ever breaks, the downstream panels will disagree
    with the cycle panel about what temperature the combustor actually hits.
    """
    from app.science import aft
    r = cycle.run("LM6000PF", 1.01325, 288.706, 60.0, 100.0, combustor_air_frac=1.0)
    # Use the exact default fuel that cycle.run uses internally
    fuel = {"CH4": 95.0, "C2H6": 3.0, "C3H8": 1.0, "N2": 1.0}
    ox = r["oxidizer_humid_mol_pct"]  # humid air at ambient (mol %)
    r_aft = aft.run(
        fuel_pct=fuel,
        ox_pct=ox,
        phi=r["phi4"],
        T0_K=r["T3_K"],
        P_bar=r["P3_bar"],
        heat_loss_fraction=0.0,
        T_fuel_K=r["T3_K"],   # matched to air so there's no enthalpy-mix offset
        T_air_K=r["T3_K"],
        WFR=0.0,
        water_mode="liquid",
    )
    # AFT uses the same mechanism (GRI) and the same equilibrium assumption as
    # cycle's T4 back-solve; they must agree to within numerical tolerance.
    assert r_aft["T_ad"] == pytest.approx(r["T4_K"], abs=15.0), (
        f"T_ad={r_aft['T_ad']:.1f} vs T4={r['T4_K']:.1f} — downstream panels "
        f"will NOT match the cycle at this operating point."
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
