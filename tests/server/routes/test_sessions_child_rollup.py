"""Sub-agent child rollup: persisted-status fallback for wrong-pod children.

``_session_status_with_child_rollup`` keeps a sidebar row ``"running"``
while any sub-agent child is active. A child whose runner tunnel lives on
ANOTHER replica has no local cache entry; the rollup must consult the
persisted ``live_status`` the tunnel-holding replica wrote (passed in as
``child_db_statuses``), not treat the child as idle.
"""

from __future__ import annotations

import pytest

from omnigent.server.routes import sessions as _sessions_mod
from omnigent.server.routes.sessions import _session_status_with_child_rollup

_PARENT = "conv_rollup_parent"
_CHILD = "conv_rollup_child"


@pytest.fixture(autouse=True)
def _clear_status_cache() -> None:
    """Isolate each case from leaked module-level cache state."""
    for cid in (_PARENT, _CHILD):
        _sessions_mod._session_status_cache.pop(cid, None)
    yield
    for cid in (_PARENT, _CHILD):
        _sessions_mod._session_status_cache.pop(cid, None)


def test_no_children_idle_parent_is_idle() -> None:
    # Negative control: nothing running anywhere must read "idle".
    assert _session_status_with_child_rollup(_PARENT, [], db_status="idle") == "idle"


def test_cached_running_child_makes_parent_running() -> None:
    _sessions_mod._session_status_cache[_CHILD] = "running"
    assert _session_status_with_child_rollup(_PARENT, [_CHILD], db_status="idle") == "running"


def test_child_db_running_falls_back_to_persisted_status() -> None:
    # The child's runner tunnel lives on another replica: no local cache
    # entry, but the row it persisted says "running". The parent's row must
    # still spin.
    assert (
        _session_status_with_child_rollup(
            _PARENT, [_CHILD], db_status="idle", child_db_statuses={_CHILD: "running"}
        )
        == "running"
    )


def test_child_db_idle_stays_idle() -> None:
    # Negative control for the DB fallback: a persisted "idle" child must
    # NOT spin the parent.
    assert (
        _session_status_with_child_rollup(
            _PARENT, [_CHILD], db_status="idle", child_db_statuses={_CHILD: "idle"}
        )
        == "idle"
    )


def test_cached_waiting_child_makes_parent_running() -> None:
    _sessions_mod._session_status_cache[_CHILD] = "waiting"
    assert _session_status_with_child_rollup(_PARENT, [_CHILD], db_status="idle") == "running"


def test_failed_parent_with_no_running_children_is_failed() -> None:
    assert (
        _session_status_with_child_rollup(
            _PARENT, [_CHILD], db_status="failed", child_db_statuses={_CHILD: "idle"}
        )
        == "failed"
    )
