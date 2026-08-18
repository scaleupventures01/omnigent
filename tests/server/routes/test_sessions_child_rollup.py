"""Sub-agent child rollup: persisted-status fallback and any-depth walk.

``_session_status_with_child_rollup`` keeps a sidebar row ``"running"``
while any sub-agent descendant is active. Two things can hide that
activity from the parent's row:

1. A child whose runner tunnel lives on ANOTHER replica has no local
   cache entry; the rollup must consult the persisted ``live_status`` the
   tunnel-holding replica wrote (passed in as ``child_db_statuses``), not
   treat the child as idle.
2. The rollup function itself is depth-agnostic — it just checks whatever
   ids it's handed. The depth defect lives one level up, in what the
   caller passes as ``child_session_ids``: it must be every sub-agent
   descendant (child, grandchild, ...), via
   ``_collect_descendant_conversation_ids_by_root``, not only direct
   children. The grandchild-depth tests below exercise that real
   collection-plus-rollup pipeline for that reason.
"""

from __future__ import annotations

import pytest

from omnigent.server.routes import sessions as _sessions_mod
from omnigent.server.routes.sessions import _session_status_with_child_rollup

_PARENT = "conv_rollup_parent"
_CHILD = "conv_rollup_child"
_GRANDCHILD = "conv_rollup_grandchild"


class _FakeChildStore:
    """Store double exposing only ``list_child_conversation_ids_by_parent``,
    the sole method the descendant walk needs."""

    def __init__(self, children_by_parent: dict[str, list[str]]) -> None:
        self._children_by_parent = children_by_parent

    def list_child_conversation_ids_by_parent(
        self, parent_ids: list[str]
    ) -> dict[str, list[str]]:
        return {pid: self._children_by_parent.get(pid, []) for pid in parent_ids}


@pytest.fixture(autouse=True)
def _clear_status_cache() -> None:
    """Isolate each case from leaked module-level cache state."""
    for cid in (_PARENT, _CHILD, _GRANDCHILD):
        _sessions_mod._session_status_cache.pop(cid, None)
    yield
    for cid in (_PARENT, _CHILD, _GRANDCHILD):
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


async def test_grandchild_running_direct_child_idle_makes_parent_running() -> None:
    # The direct child is idle, but ITS child (a grandchild of _PARENT) is
    # still running. The list builder must feed the rollup every descendant,
    # not just direct children, so the parent's row still spins.
    from omnigent.server.routes.sessions import _collect_descendant_conversation_ids_by_root

    store = _FakeChildStore({_PARENT: [_CHILD], _CHILD: [_GRANDCHILD]})
    _sessions_mod._session_status_cache[_CHILD] = "idle"
    _sessions_mod._session_status_cache[_GRANDCHILD] = "running"
    descendants_by_root = await _collect_descendant_conversation_ids_by_root(store, [_PARENT])
    status = _session_status_with_child_rollup(
        _PARENT, descendants_by_root[_PARENT], db_status="idle"
    )
    assert status == "running"


async def test_grandchild_idle_direct_child_idle_stays_idle() -> None:
    # Negative control: nothing running anywhere in the sub-tree.
    from omnigent.server.routes.sessions import _collect_descendant_conversation_ids_by_root

    store = _FakeChildStore({_PARENT: [_CHILD], _CHILD: [_GRANDCHILD]})
    _sessions_mod._session_status_cache[_CHILD] = "idle"
    _sessions_mod._session_status_cache[_GRANDCHILD] = "idle"
    descendants_by_root = await _collect_descendant_conversation_ids_by_root(store, [_PARENT])
    status = _session_status_with_child_rollup(
        _PARENT, descendants_by_root[_PARENT], db_status="idle"
    )
    assert status == "idle"
