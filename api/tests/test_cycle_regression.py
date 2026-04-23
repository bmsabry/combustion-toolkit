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
    # Cold-fuel convention (fuel at user T_fuel_K, not preheated to T3) shifts
    # η about −1 pt vs the OEM-deck convention. OEM published 44 % LHV implicitly
    # assumes fuel preheat from recuperation; our honest Brayton number is ~43 %.
    assert r["efficiency_LHV"] == pytest.approx(0.430, abs=0.005), r["efficiency_LHV"]
    # Heat rate ~8360 kJ/kWh at 43 % eff
    assert r["heat_rate_kJ_per_kWh"] == pytest.approx(8360.0, abs=100.0)


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
    # Cold-fuel convention lowers η ~1.5 pts vs OEM-deck (fuel-preheated)
    # convention. OEM published 41.5 % LHV assumes recuperation; honest Brayton
    # number with user cold T_fuel is ~41 %.
    assert r["efficiency_LHV"] == pytest.approx(0.409, abs=0.010), r["efficiency_LHV"]
    assert r["heat_rate_kJ_per_kWh"] == pytest.approx(8800.0, abs=150.0)


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
    load → richer bulk φ → hotter T_Bulk.

    Convention note: T_Bulk uses cold-fuel enthalpy mix (matches Flame Temp
    panel). T4 back-solve uses deck convention (fuel preheated to T3) so the
    published LHV efficiency anchors hold. So at frac = 1.0 with cold fuel,
    T_Bulk ≈ T4 − ΔT_fuel_cooling (small for natural gas, ~25–30 K).
    Pass T_fuel_K=T3_K to recover the strict T_Bulk = T4 collapse.
    """
    r_full = cycle.run(
        "LM6000PF", 1.01325, 288.706, 60.0, 100.0,
        combustor_air_frac=1.00, T_fuel_K=811.0,  # fuel at T3 → no mix cooling
    )
    r_split = cycle.run("LM6000PF", 1.01325, 288.706, 60.0, 100.0, combustor_air_frac=0.70)
    # With no split AND no fuel-mix cooling, bulk = exit
    assert r_full["T_Bulk_K"] == pytest.approx(r_full["T4_K"], abs=3.0)
    assert r_full["phi_Bulk"] == pytest.approx(r_full["phi4"], rel=1e-9)
    # With a split, flame is richer and hotter than the diluted exit
    assert r_split["phi_Bulk"] > r_split["phi4"]
    assert r_split["T_Bulk_K"] > r_split["T4_K"] + 30.0, (
        f"T_Bulk={r_split['T_Bulk_K']:.1f} should exceed T4={r_split['T4_K']:.1f} "
        f"by >30 K at frac=0.70 (split brings hotter primary zone)"
    )


# ------------------------- ambient density trends --------------------------

def test_lms100_is_relatively_flat_on_hot_day():
    """LMS100 intercooler regulates T3; hot-day MW drop is bounded by mass-flow
    lapse in the Option A physics (>0 % but capped). Intercooler duty goes UP.
    Relative comparison vs LM6000 is in `test_intercooler_beats_non_ic_on_hot_day`.
    """
    T_amb_95F = (95.0 - 32.0) * 5.0 / 9.0 + 273.15
    r = cycle.run("LMS100PB+", 1.01325, T_amb_95F, 60.0, 100.0)
    # T3 is regulated
    assert r["T3_K"] == pytest.approx(644.26, abs=1.0)
    # MW drop is physics-limited (mass-flow lapse dominates once cap is exceeded)
    mw_drop = (107.5 - r["MW_net"]) / 107.5
    assert 0.0 < mw_drop < 0.20
    # Intercooler duty is higher on the hot day (compressor rejects more heat)
    assert r["intercooler_duty_MW"] > 35.0


def test_lm6000_loses_power_on_hot_day():
    """LM6000 has no intercooler; drops more aggressively than LMS100 at 95 °F.
    Option A physics gives a stronger drop (T3 rises + mass flow drops + comp
    work rises per kg) than the old β_MW correlation — both are acceptable.
    """
    T_amb_95F = (95.0 - 32.0) * 5.0 / 9.0 + 273.15
    r = cycle.run("LM6000PF", 1.01325, T_amb_95F, 60.0, 100.0)
    # T3 rises as ambient rises
    assert r["T3_K"] > 830.0
    # Non-IC machine: MW drop is 10–25 % depending on VSV control modeling
    mw_drop = (45.0 - r["MW_net"]) / 45.0
    assert 0.07 < mw_drop < 0.25


def test_intercooler_beats_non_ic_on_hot_day():
    """The whole reason LMS100 is intercooled: at 95 °F it must lose LESS power
    (as a fraction of design) than LM6000. This is the architectural invariant.
    """
    T_amb_95F = (95.0 - 32.0) * 5.0 / 9.0 + 273.15
    r_lms = cycle.run("LMS100PB+", 1.01325, T_amb_95F, 60.0, 100.0)
    r_lm = cycle.run("LM6000PF", 1.01325, T_amb_95F, 60.0, 100.0)
    drop_lms = (107.5 - r_lms["MW_net"]) / 107.5
    drop_lm = (45.0 - r_lm["MW_net"]) / 45.0
    assert drop_lms < drop_lm, (
        f"Intercooled LMS100 must lose less fractional MW than non-IC LM6000 on hot day: "
        f"LMS100 drop={drop_lms:.3f}, LM6000 drop={drop_lm:.3f}"
    )


# ------------------------------ part-load ----------------------------------

def test_load_scales_mw_monotonically():
    """MW_net decreases monotonically from 100 % → 50 % → 20 % load.

    With Option A the scaling is not exactly linear: part-load T4 droop
    plus reduced mass flow compound into a slightly super-linear MW drop
    (real gas-turbine behavior). We check monotonicity and rough ranges.
    """
    for engine, T_amb, RH, MW_des in [
        ("LMS100PB+", 279.817, 80.0, 107.5),
        ("LM6000PF",  288.706, 60.0,  45.0),
    ]:
        r100 = cycle.run(engine, 1.01325, T_amb, RH, 100.0)
        r50  = cycle.run(engine, 1.01325, T_amb, RH,  50.0)
        r20  = cycle.run(engine, 1.01325, T_amb, RH,  20.0)
        assert r100["MW_net"] > r50["MW_net"] > r20["MW_net"]
        assert r100["MW_net"] == pytest.approx(MW_des, abs=0.1), engine
        # 50 % load: MW between 35 % and 55 % of design (typical part-load lapse)
        frac_50 = r50["MW_net"] / MW_des
        assert 0.35 < frac_50 < 0.55, f"{engine} 50%-load fraction {frac_50:.3f}"


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


def test_aft_at_phi_bulk_equals_t_bulk_with_cold_fuel():
    """The realistic case: T_fuel ≪ T_air. Cycle's T_Bulk must include the
    enthalpy cooling from cold fuel mixing in, so it matches what the Flame
    Temp panel computes (which always does the proper enthalpy mix). Without
    this fix, T_Bulk overshoots by ~30–80 K and the Flame Temp value visibly
    'drops' to a lower number when the user switches tabs.
    """
    from app.science import aft
    fuel = {"CH4": 95.0, "C2H6": 3.0, "C3H8": 1.0, "N2": 1.0}
    T_fuel = 294.261  # 70 °F — typical sidebar default
    r = cycle.run(
        "LM6000PF", 1.01325, 288.706, 60.0, 100.0,
        combustor_air_frac=0.88, T_fuel_K=T_fuel,
    )
    r_aft = aft.run(
        fuel_pct=fuel, ox_pct=r["oxidizer_humid_mol_pct"],
        phi=r["phi_Bulk"], T0_K=r["T3_K"], P_bar=r["P3_bar"],
        heat_loss_fraction=0.0,
        T_fuel_K=T_fuel, T_air_K=r["T3_K"],
        WFR=0.0, water_mode="liquid",
    )
    assert r_aft["T_ad"] == pytest.approx(r["T_Bulk_K"], abs=5.0), (
        f"AFT T_ad={r_aft['T_ad']:.1f} vs cycle T_Bulk={r['T_Bulk_K']:.1f} — "
        f"cycle T_Bulk is not using the same enthalpy-balanced mix as AFT, "
        f"so the Cycle and Flame Temp panels will disagree."
    )


def test_aft_at_phi_bulk_equals_t_bulk():
    """Integration guard for the sidebar linkages. With Oxidizer linked to
    humid air, T_air=T3, P=P3, and phi=phi_Bulk, the AFT panel must reproduce
    T_Bulk. This is what the user sees on the Flame Temp / Flame Speed /
    PSR-PFR / Blowoff / Exhaust panels when all link toggles are ON — they
    all model the flame zone, which is exactly T_Bulk.

    For this collapse to be exact, both the cycle's T_Bulk and the AFT call
    must use the SAME T_fuel. Here we set T_fuel = T3 on both sides — that's
    the no-cooling reference point. The realistic cold-fuel case is covered
    by test_aft_at_phi_bulk_equals_t_bulk_with_cold_fuel.
    """
    from app.science import aft
    fuel = {"CH4": 95.0, "C2H6": 3.0, "C3H8": 1.0, "N2": 1.0}
    # Case A: no split, no fuel-mix cooling — bulk = exit, AFT @ phi_Bulk = T4.
    r = cycle.run(
        "LM6000PF", 1.01325, 288.706, 60.0, 100.0,
        combustor_air_frac=1.0, T_fuel_K=811.0,
    )
    r_aft = aft.run(
        fuel_pct=fuel, ox_pct=r["oxidizer_humid_mol_pct"],
        phi=r["phi_Bulk"], T0_K=r["T3_K"], P_bar=r["P3_bar"],
        heat_loss_fraction=0.0, T_fuel_K=r["T3_K"], T_air_K=r["T3_K"],
        WFR=0.0, water_mode="liquid",
    )
    assert r_aft["T_ad"] == pytest.approx(r["T_Bulk_K"], abs=15.0)
    assert r_aft["T_ad"] == pytest.approx(r["T4_K"], abs=15.0)

    # Case B: realistic DLE split, no fuel-mix cooling — T_Bulk > T4, and AFT
    # @ phi_Bulk must match T_Bulk.
    r2 = cycle.run(
        "LM6000PF", 1.01325, 288.706, 60.0, 100.0,
        combustor_air_frac=0.88, T_fuel_K=811.0,
    )
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


# ---------------- Option A — energy-balance components --------------------

def test_option_a_turbine_beats_compressor():
    """Sanity: W_turb > W_comp > 0, MW_gross ≈ (or just above) MW_cap at design."""
    for engine, T_amb, RH in [("LMS100PB+", 279.817, 80.0), ("LM6000PF", 288.706, 60.0)]:
        r = cycle.run(engine, 1.01325, T_amb, RH, 100.0)
        assert r["W_turbine_MW"] > r["W_compressor_MW"] > 0.0, engine
        assert r["W_parasitic_MW"] > 0.0, engine
        # MW_gross ≈ MW_cap at design (cap binds)
        assert r["MW_gross"] >= r["MW_cap"] - 0.25, (
            f"{engine}: MW_gross {r['MW_gross']:.3f} below cap {r['MW_cap']:.3f}"
        )
        # T5 > T5_isen (actual turbine exit is hotter than isentropic, per 2nd law)
        assert r["T5_K"] > r["T5_isen_K"], engine
        # T5 < T4 (turbine cools the gas)
        assert r["T5_K"] < r["T4_K"], engine


def test_option_a_exposes_polytropic_efficiencies():
    r = cycle.run("LMS100PB+", 1.01325, 279.817, 80.0, 100.0)
    assert 0.5 < r["eta_isen_turb"] < 0.95
    assert 0.5 < r["eta_isen_comp"] < 0.95
    assert 0.3 < r["combustor_bypass_frac"] < 1.0
    assert r["P_exhaust_bar"] == pytest.approx(1.05, abs=0.01)


# ---------------- Option B — fuel flexibility / MWI ------------------------

def test_pure_ch4_is_in_spec():
    """Pure CH4 at 60 °F: MWI ≈ 53.6 (inside 40–54 band), zero derate."""
    r = cycle.run("LMS100PB+", 1.01325, 279.817, 80.0, 100.0, fuel_pct={"CH4": 100.0})
    ff = r["fuel_flexibility"]
    assert 50.0 < ff["mwi"] < 56.0, ff["mwi"]
    assert ff["mwi_status"] == "in_spec", ff
    assert ff["mwi_derate_pct"] == 0.0
    assert ff["warnings"] == []


def test_dilute_low_lhv_fuel_forces_out_of_spec_derate():
    """60 % CH4 / 40 % N2: LHV drops → fuel-mass flow rises (energy balance),
    MWI is far below 40 → out-of-spec → 20 % derate → MW_net falls."""
    r_ch4 = cycle.run("LMS100PB+", 1.01325, 279.817, 80.0, 100.0, fuel_pct={"CH4": 100.0})
    r_dil = cycle.run("LMS100PB+", 1.01325, 279.817, 80.0, 100.0,
                      fuel_pct={"CH4": 60.0, "N2": 40.0})
    # Option A physics: more fuel needed per kg of air to reach same T4
    assert r_dil["mdot_fuel_kg_s"] > r_ch4["mdot_fuel_kg_s"] * 1.5, (
        f"Dilute-fuel mass flow only rose {r_dil['mdot_fuel_kg_s']/r_ch4['mdot_fuel_kg_s']:.2f}x"
    )
    # LHV per kg of fuel drops
    assert r_dil["LHV_fuel_MJ_per_kg"] < r_ch4["LHV_fuel_MJ_per_kg"] * 0.6
    # Option B: MWI out-of-spec → 20 % derate
    ff = r_dil["fuel_flexibility"]
    assert ff["mwi_status"] == "out_of_spec", ff
    assert ff["mwi_derate_pct"] == pytest.approx(20.0)
    assert any("MWI" in w for w in ff["warnings"])
    # MW_net drops by exactly the 20 % derate relative to what the cap would give
    assert r_dil["MW_net"] < r_ch4["MW_net"] * 0.85
    assert r_dil["derate_factor"] == pytest.approx(0.80, abs=1e-4)


def test_high_h2_fuel_emits_flashback_warning():
    """60 % H₂ / 40 % CH₄: MWI may land in-spec, but H₂ > 30 % triggers an
    operator warning for DLE premixer flashback risk."""
    r = cycle.run("LMS100PB+", 1.01325, 279.817, 80.0, 100.0,
                  fuel_pct={"H2": 60.0, "CH4": 40.0})
    ff = r["fuel_flexibility"]
    assert ff["h2_frac_pct"] == pytest.approx(60.0, abs=0.5)
    assert any("H" in w and "30" in w for w in ff["warnings"]), ff["warnings"]


def test_heavy_hydrocarbon_fuel_is_out_of_spec_high():
    """80 % C3H8 / 20 % CH4: MWI well above 60 → out-of-spec band → 20 % derate."""
    r = cycle.run("LMS100PB+", 1.01325, 279.817, 80.0, 100.0,
                  fuel_pct={"C3H8": 80.0, "CH4": 20.0})
    ff = r["fuel_flexibility"]
    assert ff["mwi"] > 60.0
    assert ff["mwi_status"] == "out_of_spec"
    assert ff["mwi_derate_pct"] == pytest.approx(20.0)


def test_derate_factor_is_applied_to_MW_net():
    """derate_factor = 1 − mwi_derate_pct/100; MW_net = MW_uncapped × derate."""
    r = cycle.run("LMS100PB+", 1.01325, 279.817, 80.0, 100.0,
                  fuel_pct={"CH4": 60.0, "N2": 40.0})
    expected = r["MW_uncapped_before_derate"] * r["derate_factor"]
    assert r["MW_net"] == pytest.approx(expected, rel=1e-9)


def test_T_fuel_affects_mwi_via_denominator():
    """MWI = LHV_vol / √(SG · T_fuel[°R]) — heating fuel raises the denominator
    so MWI drops. A warm fuel can push a borderline composition into derate.
    """
    low = cycle.run("LMS100PB+", 1.01325, 279.817, 80.0, 100.0, T_fuel_K=288.706)
    hot = cycle.run("LMS100PB+", 1.01325, 279.817, 80.0, 100.0, T_fuel_K=500.0)
    assert hot["fuel_flexibility"]["mwi"] < low["fuel_flexibility"]["mwi"]


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


# ----------------------------- water injection -----------------------------

def test_wfr_zero_is_byte_identical_to_legacy_dry_call():
    """WFR=0 must short-circuit straight to the legacy dry path so the OEM
    efficiency anchor and every published-deck test above is preserved bit-for-bit.
    """
    legacy = cycle.run("LMS100PB+", 1.01325, 279.817, 80.0, 100.0)
    explicit_dry = cycle.run(
        "LMS100PB+", 1.01325, 279.817, 80.0, 100.0,
        WFR=0.0, water_mode="liquid",
    )
    for key in (
        "T3_K", "P3_bar", "T4_K", "MW_net", "phi4", "FAR4",
        "phi_Bulk", "T_Bulk_K", "efficiency_LHV", "mdot_fuel_kg_s",
    ):
        assert explicit_dry[key] == pytest.approx(legacy[key], rel=1e-12), key


def test_wfr_drops_t4_and_tflame_and_raises_power():
    """Water injection under the A-controller physics model (cold fuel at user
    T_fuel_K, cold water at user T_water_K, empirical k × WFR controller fuel
    bump). All four user-stated physical expectations must hold:
      • T4 FLOATS DOWN from the dry setpoint (water cooling > fuel-bump heating).
      • T_Bulk drops (flame zone cools — NOx reduction mechanism).
      • Power goes UP (added water mass + fuel pass through turbine).
      • η_LHV drops (fuel rises more than MW rises).
    Plus water mass is correctly threaded and the T4_dry_deck diagnostic echoes
    the pre-water setpoint.
    """
    dry = cycle.run("LM6000PF", 1.01325, 288.706, 60.0, 100.0, T_fuel_K=294.261)
    wet = cycle.run(
        "LM6000PF", 1.01325, 288.706, 60.0, 100.0, T_fuel_K=294.261,
        WFR=0.5, water_mode="liquid",
    )
    # T4 drops at least 10 K (at k=0.10 observed ~17 K)
    assert wet["T4_K"] < dry["T4_K"] - 10.0, (wet["T4_K"], dry["T4_K"])
    # T_Bulk (flame zone) drops more than T4 (dilution hasn't happened yet)
    assert wet["T_Bulk_K"] < dry["T_Bulk_K"] - 15.0, (wet["T_Bulk_K"], dry["T_Bulk_K"])
    # Fuel bumps ~5 % (controller response at k=0.10, WFR=0.5)
    assert wet["mdot_fuel_kg_s"] > dry["mdot_fuel_kg_s"] * 1.04
    assert wet["mdot_fuel_kg_s"] < dry["mdot_fuel_kg_s"] * 1.06
    # Water mass threads through the turbine at WFR × mdot_fuel
    assert wet["mdot_water_kg_s"] > 0.0
    assert wet["mdot_water_kg_s"] == pytest.approx(wet["mdot_fuel_kg_s"] * 0.5, rel=1e-6)
    # MW_net rises ~2-3 % over dry cap (user expectation: "power up a bit")
    assert wet["MW_net"] > dry["MW_net"], (wet["MW_net"], dry["MW_net"])
    assert wet["MW_net"] < dry["MW_net"] * 1.10, wet["MW_net"]
    # η drops (fuel rises more than MW rises — the GE-published penalty)
    assert wet["efficiency_LHV"] < dry["efficiency_LHV"] - 0.005, (
        wet["efficiency_LHV"], dry["efficiency_LHV"],
    )
    # Diagnostic: T4_dry_deck_K snapshot equals the pre-water setpoint
    assert wet["T4_dry_deck_K"] == pytest.approx(dry["T4_K"], abs=1e-6)
    # Echoed inputs
    assert wet["WFR"] == pytest.approx(0.5)
    assert wet["water_mode"] == "liquid"


def test_aft_at_phi_bulk_equals_t_bulk_with_water_injection():
    """End-to-end interface guard: with WFR > 0, the cycle's T_Bulk must
    match what the AFT panel computes when fed the same water-injection
    inputs and the linked sidebar state. This is the wet-cycle analog of
    test_aft_at_phi_bulk_equals_t_bulk_with_cold_fuel — without it the
    Cycle and Flame Temp panels visibly disagree on tab switch.
    """
    from app.science import aft
    fuel = {"CH4": 95.0, "C2H6": 3.0, "C3H8": 1.0, "N2": 1.0}
    T_fuel = 294.261
    WFR = 0.4
    r = cycle.run(
        "LM6000PF", 1.01325, 288.706, 60.0, 100.0,
        combustor_air_frac=0.88, T_fuel_K=T_fuel,
        fuel_pct=fuel, WFR=WFR, water_mode="liquid",
    )
    r_aft = aft.run(
        fuel_pct=fuel, ox_pct=r["oxidizer_humid_mol_pct"],
        phi=r["phi_Bulk"], T0_K=r["T3_K"], P_bar=r["P3_bar"],
        heat_loss_fraction=0.0,
        T_fuel_K=T_fuel, T_air_K=r["T3_K"],
        WFR=WFR, water_mode="liquid",
    )
    assert r_aft["T_ad"] == pytest.approx(r["T_Bulk_K"], abs=5.0), (
        f"AFT T_ad={r_aft['T_ad']:.1f} vs cycle T_Bulk={r['T_Bulk_K']:.1f} — "
        f"the cycle's water-aware T_Bulk does not match the Flame Temp panel."
    )


def test_water_mode_liquid_cools_more_than_steam():
    """Liquid water absorbs h_fg before combustion, so it cools the hot gas
    more aggressively than steam at the same WFR. Under the A-controller
    physics model fuel bumps by the same k × WFR factor regardless of phase,
    so the asymmetry shows up in T4 and T_Bulk (liquid drops them more)
    rather than in phi4 or fuel flow.
    """
    base = dict(engine="LM6000PF", P_amb_bar=1.01325, T_amb_K=288.706,
                RH_pct=60.0, load_pct=100.0, T_fuel_K=294.261, WFR=0.5)
    r_liq = cycle.run(**base, water_mode="liquid")
    r_steam = cycle.run(**base, water_mode="steam")
    # Both drop T4 below the dry setpoint, liquid more than steam
    assert r_liq["T4_K"] < r_steam["T4_K"], (r_liq["T4_K"], r_steam["T4_K"])
    # Both cool T_Bulk, liquid more than steam
    assert r_liq["T_Bulk_K"] < r_steam["T_Bulk_K"], (r_liq["T_Bulk_K"], r_steam["T_Bulk_K"])
    # Same fuel-bump factor (k × WFR) → same fuel flow within rounding
    assert r_liq["mdot_fuel_kg_s"] == pytest.approx(r_steam["mdot_fuel_kg_s"], rel=1e-3)
    # Echoed inputs
    assert r_liq["water_mode"] == "liquid"
    assert r_steam["water_mode"] == "steam"
