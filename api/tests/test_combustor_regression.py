"""Regression test for the PSR+PFR combustor pinned to a reference Cantera run.

Fixture case (from a user-reported screenshot on 2026-04-17):
    Fuel: Pipeline NG US  — CH4 93.1, C2H6 3.2, C3H8 0.7, C4H10 0.4, CO2 1.0, N2 1.6  (mol%)
    Oxidizer: Humid Air 60%RH 25C  — O2 20.29, N2 75.67, Ar 0.9, CO2 0.03, H2O 3.11  (mol%)
    phi=0.52, Tin=1000 F, P=400.025 psia, tau_PSR=2 ms, L_PFR=0.539 ft, V_PFR=100 ft/s

Expected values were obtained by running an independent clean Cantera script using the
exact same GRI-Mech 3.0 mechanism and reactor topology. See api/tests/ref_combustor.py
for the fixture generator.

If these assertions fail after a code change, either:
  (a) the change broke the physics → fix the code, OR
  (b) the change was an intentional methodology update → update the pinned values.
"""
from __future__ import annotations

import pytest

from app.science import combustor

F_TO_K = lambda f: (f - 32) * 5 / 9 + 273.15
PSIA_TO_BAR = 1.0 / 14.5037738

FUEL = {"CH4": 93.1, "C2H6": 3.2, "C3H8": 0.7, "C4H10": 0.4, "CO2": 1.0, "N2": 1.6}
OX = {"O2": 20.29, "N2": 75.67, "AR": 0.9, "CO2": 0.03, "H2O": 3.11}
PHI = 0.52
TIN = F_TO_K(1000.0)
P_BAR = 400.025 * PSIA_TO_BAR
TAU_PSR = 2e-3
L_PFR = 0.539 * 0.3048
V_PFR = 100.0 * 0.3048


@pytest.fixture(scope="module")
def result():
    return combustor.run(FUEL, OX, PHI, TIN, P_BAR, TAU_PSR, L_PFR, V_PFR, profile_points=60)


def test_temperatures(result):
    # T_PSR and T_exit should both converge to AFT (~1895 K) to within 1 K
    assert 1894.0 < result["T_psr"] < 1897.0, f'T_psr={result["T_psr"]}'
    assert 1894.0 < result["T_exit"] < 1897.0, f'T_exit={result["T_exit"]}'


def test_nox_ppmvd(result):
    # Reference Cantera: NO exit = 1790.7 ppmvd (±1%)
    assert 1770 < result["NO_ppm_vd_exit"] < 1810, f'NO_exit={result["NO_ppm_vd_exit"]}'
    # PSR NO is slightly lower than PFR exit (Zeldovich keeps growing in PFR)
    assert result["NO_ppm_vd_exit"] >= result["NO_ppm_vd_psr"]


def test_nox_corrected(result):
    # Reference Cantera: NO @15% O2 = 1019.4 ppmvd (±1%)
    assert 1005 < result["NO_ppm_15O2"] < 1035, f'NO_15={result["NO_ppm_15O2"]}'


def test_co_ppmvd(result):
    # Reference Cantera: CO exit = 19.6 ppmvd (±2 ppm)
    assert 17 < result["CO_ppm_vd_exit"] < 22, f'CO_exit={result["CO_ppm_vd_exit"]}'


def test_exhaust_o2_dry(result):
    # Reference Cantera: O2 dry = 10.50 % — regression guard against the hardcoded-zero bug
    assert 10.3 < result["O2_pct_dry_exit"] < 10.7, f'O2_exit={result["O2_pct_dry_exit"]}'
    assert 10.3 < result["O2_pct_dry_psr"] < 10.7, f'O2_psr={result["O2_pct_dry_psr"]}'


def test_residence_times(result):
    # tau_PFR = 0.539 ft / 100 ft/s = 5.390 ms exactly (geometry only, no chemistry)
    assert abs(result["tau_pfr_ms"] - 5.390) < 0.01
    assert abs(result["tau_total_ms"] - 7.390) < 0.01


def test_correction_factor_is_consistent(result):
    # Verify NO_15 = NO_exit * (20.95 - 15) / (20.95 - O2_exit) — this pins the dry-O2 math
    NO = result["NO_ppm_vd_exit"]
    NO15 = result["NO_ppm_15O2"]
    O2 = result["O2_pct_dry_exit"]
    expected = NO * (20.95 - 15.0) / (20.95 - O2)
    assert abs(NO15 - expected) / expected < 1e-3, f"NO15={NO15} != {expected} (O2={O2})"
