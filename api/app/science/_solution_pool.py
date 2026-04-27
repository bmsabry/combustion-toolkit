"""Process-wide Cantera Solution pool.

Cantera Solutions are expensive to construct (parsing the YAML mechanism
and building the kinetics graph costs ~80-400 ms on a 1-vCPU VM for
GRI-Mech 3.0) but cheap to re-state via TPX / TP / set_equivalence_ratio.
The science modules used to build a fresh Solution on every call —
including inside the per-row bisection on /calc/solve-phi-for-tflame,
where one solver invocation triggered ~9 Solution constructions and a
single matrix run could pay 30 s of mechanism-loading overhead per row.

This pool fixes that. `get_solution(mechanism, slot)` returns a single
Solution per (mechanism, slot) pair, lazily constructed on first request.
Callers that need a Cantera Solution at the same time as another caller
must use a *different* slot label so their state doesn't collide; pure
metadata reads (species_names, n_atoms) are slot-shareable since they
don't mutate state.

Thread safety: every endpoint that touches Cantera is already serialized
through `ThreadPoolExecutor(max_workers=1)` in calc.py's `_run_in_pool`,
so the pool itself doesn't need an internal lock. If that serialization
is ever relaxed the pool will need a per-key Lock.
"""

from __future__ import annotations

from typing import Dict, Tuple

import cantera as ct

from .mixture import mech_yaml

_POOL: Dict[Tuple[str, str], ct.Solution] = {}


def get_solution(mechanism: str = "gri30", slot: str = "default") -> ct.Solution:
    """Return the pooled Solution for (mechanism, slot), constructing on first miss.

    Slot labels prevent concurrent-state corruption between callers that
    keep references alive simultaneously. State (T, P, X) lingers from
    previous calls — every caller MUST overwrite via TPX / set_equivalence_ratio
    before reading any thermo property.
    """
    key = (mechanism, slot)
    g = _POOL.get(key)
    if g is None:
        g = ct.Solution(mech_yaml(mechanism))
        _POOL[key] = g
    return g
