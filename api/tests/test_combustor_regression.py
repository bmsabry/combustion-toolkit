"""Regression tests for the PSR+PFR combustor pinned to reference Cantera runs.

Three cases exercise the combustor:

    Case A — legacy fixture (tau_PSR=2 ms). Same fuel/air T=1000 F, so the
    adiabatic mix of T_fuel==T_air reduces to the old single-inlet behavior.
    Guards that the cold-ignited + advance-based scheme still converges to the
    same answer the earlier test expected.

    Case B — short tau (tau_PSR=0.5 ms), same fuel/air T=1000 F. Pins the
    new cold-ignited-with-NOx-zeroed seed + chunked-advance convergence at
    short residence time. Matches the user's 2026-04-17 screenshot within 2%.

    Case C — separate T_fuel (70 F) and T_air (1000 F) adiabatically mixed.
    Verifies the adiabatic mixing produces a lower mixed inlet T than Case B,
    which in turn lowers T_psr and NO_exit. This case pins the new
    T_fuel/T_air feature.

Expected values were obtained by running an independent clean Cantera script
using the same GRI-Mech 3.0 mechanism and reactor topology; see
psr_new_scheme.py at the repo root.

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
T_1000F = F_TO_K(1000.0)
T_70F = F_TO_K(70.0)
P_BAR = 400.025 * PSIA_TO_BAR
L_PFR = 0.539 * 0.3048
V_PFR = 100.0 * 0.3048


# ------------- Case A: legacy tau=2 ms, single inlet T ----------------
@pytest.fixture(scope="module")
def result_A():
    return combustor.run(FUEL, OX, PHI, T_1000F, P_BAR, 2e-3, L_PFR, V_PFR, profile_points=60)


def test_A_temperatures(result_A):
    # T_PSR and T_exit should both converge to AFT (~1895 K) to within a few K
    assert 1890.0 < result_A["T_psr"] < 1900.0, f'T_psr={result_A["T_psr"]}'
    assert 1890.0 < result_A["T_exit"] < 1900.0, f'T_exit={result_A["T_exit"]}'


def test_A_nox_ppmvd(result_A):
    # Reference Cantera: NO exit ~ 1790 ppmvd at tau=2ms
    assert 1770 < result_A["NO_ppm_vd_exit"] < 1810, f'NO_exit={result_A["NO_ppm_vd_exit"]}'
    assert result_A["NO_ppm_vd_exit"] >= result_A["NO_ppm_vd_psr"]


def test_A_nox_corrected(result_A):
    assert 1000 < result_A["NO_ppm_15O2"] < 1040, f'NO_15={result_A["NO_ppm_15O2"]}'


def test_A_co_ppmvd(result_A):
    assert 17 < result_A["CO_ppm_vd_exit"] < 22, f'CO_exit={result_A["CO_ppm_vd_exit"]}'


def test_A_exhaust_o2_dry(result_A):
    assert 10.3 < result_A["O2_pct_dry_exit"] < 10.7, f'O2_exit={result_A["O2_pct_dry_exit"]}'
    assert 10.3 < result_A["O2_pct_dry_psr"] < 10.7, f'O2_psr={result_A["O2_pct_dry_psr"]}'


def test_A_residence_times(result_A):
    assert abs(result_A["tau_pfr_ms"] - 5.390) < 0.01
    assert abs(result_A["tau_total_ms"] - 7.390) < 0.01


def test_A_mixed_inlet_T_equals_T0(result_A):
    # With T_fuel==T_air==T0 (default), mixed inlet T should equal T0
    assert abs(result_A["T_mixed_inlet_K"] - T_1000F) < 0.5


# ------------- Case B: short tau=0.5 ms, single inlet T ----------------
@pytest.fixture(scope="module")
def result_B():
    return combustor.run(FUEL, OX, PHI, T_1000F, P_BAR, 0.5e-3, L_PFR, V_PFR, profile_points=60)


def test_B_temperatures(result_B):
    assert 1890.0 < result_B["T_psr"] < 1900.0, f'T_psr={result_B["T_psr"]}'


def test_B_nox_ppmvd(result_B):
    # Reference Cantera (new cold-ignited + advance scheme at tau=0.5ms): NO_exit ~ 681, NO_psr ~ 673
    assert 660 < result_B["NO_ppm_vd_exit"] < 700, f'NO_exit={result_B["NO_ppm_vd_exit"]}'
    assert 650 < result_B["NO_ppm_vd_psr"] < 695, f'NO_psr={result_B["NO_ppm_vd_psr"]}'
    assert result_B["NO_ppm_vd_exit"] >= result_B["NO_ppm_vd_psr"]


def test_B_nox_corrected(result_B):
    assert 375 < result_B["NO_ppm_15O2"] < 400, f'NO_15={result_B["NO_ppm_15O2"]}'


def test_B_o2_dry(result_B):
    assert 10.3 < result_B["O2_pct_dry_exit"] < 10.7


# ------------- Case C: separate T_fuel=70F, T_air=1000F ----------------
@pytest.fixture(scope="module")
def result_C():
    return combustor.run(
        FUEL, OX, PHI, T_1000F, P_BAR, 0.5e-3, L_PFR, V_PFR,
        profile_points=60, T_fuel_K=T_70F, T_air_K=T_1000F,
    )


def test_C_mixed_inlet_T_is_lower(result_C, result_B):
    # Adiabatic mix of cold fuel + hot air must be below the hot-air-only inlet T
    assert result_C["T_mixed_inlet_K"] < T_1000F
    # From psr_new_scheme.py validation: T_mixed ~ 798 K
    assert 790 < result_C["T_mixed_inlet_K"] < 805, f'T_mixed={result_C["T_mixed_inlet_K"]}'


def test_C_T_psr_lower_than_case_B(result_C, result_B):
    # Colder inlet → lower adiabatic flame temperature
    assert result_C["T_psr"] < result_B["T_psr"], (
        f'T_psr_C={result_C["T_psr"]} vs T_psr_B={result_B["T_psr"]}'
    )


def test_C_nox_lower_than_case_B(result_C, result_B):
    # Colder inlet → lower T_psr → less Zeldovich → less NO
    assert result_C["NO_ppm_vd_exit"] < result_B["NO_ppm_vd_exit"], (
        f'NO_exit_C={result_C["NO_ppm_vd_exit"]} vs NO_exit_B={result_B["NO_ppm_vd_exit"]}'
    )


def test_C_correction_factor_is_consistent(result_C):
    NO = result_C["NO_ppm_vd_exit"]
    NO15 = result_C["NO_ppm_15O2"]
    O2 = result_C["O2_pct_dry_exit"]
    expected = NO * (20.95 - 15.0) / (20.95 - O2)
    assert abs(NO15 - expected) / expected < 1e-3, f"NO15={NO15} != {expected} (O2={O2})"
