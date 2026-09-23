"""Cross-platform child-process spawning and tree teardown.

Historically omnigent terminated child agent processes by killing their POSIX
process group (``os.killpg``), which only works because children are spawned
with ``start_new_session=True`` so ``pid == pgid``. Neither process groups nor
``os.killpg`` exist on Windows, so this module centralizes the portable
equivalents:

* :func:`spawn_kwargs` — the ``Popen``/``create_subprocess_exec`` keyword args
  that put a child in its own group/session (so signals don't leak to the
  parent and the whole tree can be torn down).
* :func:`terminate_tree` / :func:`kill_tree` — recursively stop a process and
  all of its descendants, using the process-group fast path on POSIX and
  :mod:`psutil` walking on every platform.
* :func:`process_alive` — liveness check that doesn't rely on ``os.kill(pid, 0)``.

:mod:`psutil` is already a core dependency, so the descendant walk needs no new
package.
"""

from __future__ import annotations

import logging
import os
import signal
import subprocess
import time
from collections.abc import Mapping
from contextlib import suppress
from dataclasses import dataclass
from typing import Protocol, TypedDict

import psutil  # type: ignore[import-untyped]

from omnigent._platform import IS_LINUX, IS_POSIX

logger = logging.getLogger(__name__)

# glibc allocator defaults for spawned children. glibc creates up to 8*ncpu
# malloc arenas by default; on a many-core host a threaded child (the runner
# uses asyncio.to_thread heavily) multiplies RSS across arenas that never
# return to the OS. Capping arenas and setting a trim threshold bounds that
# growth. Both are read by the C runtime at startup, so the parent must set
# them in the child env before exec.
_DEFAULT_MALLOC_ARENA_MAX = "2"
_DEFAULT_MALLOC_TRIM_THRESHOLD = "134217728"  # 128 MiB


def malloc_tuning_env() -> dict[str, str]:
    """Env vars that bound glibc allocator RSS for a spawned child.

    Arena multiplication is specific to glibc's allocator. macOS libmalloc uses
    per-CPU magazines with madvise-based reclaim and exposes no equivalent knob
    (``MALLOC_ARENA_MAX`` is simply ignored there), so macOS hosts get their
    reduction from the threadpool cap instead — see ``_entry`` — not from here.

    Returns an empty dict off Linux (macOS has no ``mallopt``; Windows and musl
    ignore these), so callers can merge unconditionally without a platform
    branch. Honors operator overrides ``OMNIGENT_RUNNER_MALLOC_ARENA_MAX``
    (default ``"2"``; ``"0"`` disables the cap) and
    ``OMNIGENT_RUNNER_MALLOC_TRIM_THRESHOLD`` (default 128 MiB).

    :returns: Mapping to merge into a child ``env`` dict, e.g.
        ``{"MALLOC_ARENA_MAX": "2", "MALLOC_TRIM_THRESHOLD_": "134217728"}``.
    """
    if not IS_LINUX:
        return {}
    out: dict[str, str] = {}
    arena_max = os.environ.get(
        "OMNIGENT_RUNNER_MALLOC_ARENA_MAX", _DEFAULT_MALLOC_ARENA_MAX
    ).strip()
    if arena_max and arena_max != "0":
        out["MALLOC_ARENA_MAX"] = arena_max
    trim = os.environ.get(
        "OMNIGENT_RUNNER_MALLOC_TRIM_THRESHOLD", _DEFAULT_MALLOC_TRIM_THRESHOLD
    ).strip()
    if trim:
        out["MALLOC_TRIM_THRESHOLD_"] = trim
    return out


# Resolved via getattr so this module type-checks and imports on Windows, where
# process groups and SIGKILL do not exist. None on non-POSIX hosts.
_killpg_fn = getattr(os, "killpg", None)
_getpgid_fn = getattr(os, "getpgid", None)
_SIGKILL = getattr(signal, "SIGKILL", signal.SIGTERM)
_CREATE_NEW_PROCESS_GROUP = int(getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))


class SpawnKwargs(TypedDict, total=False):
    """Platform-specific process-group arguments accepted by subprocess APIs."""

    start_new_session: bool
    creationflags: int


@dataclass(frozen=True, slots=True)
class ProcessIdentity:
    """A PID paired with its creation time to make reuse detectable."""

    pid: int
    create_time: float

    def to_dict(self) -> dict[str, int | float]:
        """Return the stable JSON representation used in ownership records."""
        return {"pid": self.pid, "create_time": self.create_time}

    @classmethod
    def from_dict(cls, value: Mapping[str, object]) -> ProcessIdentity:
        """Parse an identity from an ownership record."""
        pid = value.get("pid")
        create_time = value.get("create_time")
        if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
            raise ValueError("process identity pid must be a positive integer")
        if not isinstance(create_time, (int, float)) or isinstance(create_time, bool):
            raise ValueError("process identity create_time must be numeric")
        return cls(pid=pid, create_time=float(create_time))


@dataclass(frozen=True, slots=True)
class TeardownOutcome:
    """Structured, auditable result of identity-verified process teardown."""

    terminated: tuple[ProcessIdentity, ...] = ()
    killed: tuple[ProcessIdentity, ...] = ()
    survivors: tuple[ProcessIdentity, ...] = ()
    skipped_mismatch: tuple[ProcessIdentity, ...] = ()


class _ProcessLike(Protocol):
    """The subset of ``subprocess.Popen`` / ``asyncio.subprocess.Process`` used here."""

    @property
    def pid(self) -> int | None:
        pass

    @property
    def returncode(self) -> int | None:
        pass

    def terminate(self) -> None:
        pass

    def kill(self) -> None:
        pass


def spawn_kwargs() -> SpawnKwargs:
    """
    Keyword args that isolate a child process into its own group/session.

    On POSIX returns ``{"start_new_session": True}`` (new session, so the child
    becomes a process-group leader and ``os.killpg(pid, ...)`` reaps the whole
    tree). On Windows returns ``{"creationflags": CREATE_NEW_PROCESS_GROUP}``
    so the child is in its own Ctrl-C group and can be torn down independently
    of the parent console.

    Pass via ``**spawn_kwargs()`` to :class:`subprocess.Popen` or
    :func:`asyncio.create_subprocess_exec`.
    """
    if IS_POSIX:
        return {"start_new_session": True}
    return {"creationflags": _CREATE_NEW_PROCESS_GROUP}


def process_identity(pid: int) -> ProcessIdentity | None:
    """Return the stable identity for a live PID, or ``None`` if unavailable."""
    if pid <= 0:
        return None
    try:
        proc = psutil.Process(pid)
        return ProcessIdentity(pid=pid, create_time=proc.create_time())
    except (psutil.NoSuchProcess, psutil.AccessDenied, ValueError, OSError):
        return None


def identity_matches(identity: ProcessIdentity) -> bool:
    """Whether the PID still names the exact process captured by ``identity``."""
    current = process_identity(identity.pid)
    return current is not None and current.create_time == identity.create_time


def snapshot_tree(pid: int) -> list[ProcessIdentity]:
    """Capture stable identities for ``pid`` and every current descendant."""
    identities: list[ProcessIdentity] = []
    seen: set[int] = set()
    for proc in _walk_descendants(pid):
        if proc.pid in seen:
            continue
        seen.add(proc.pid)
        try:
            identities.append(ProcessIdentity(pid=proc.pid, create_time=proc.create_time()))
        except (psutil.NoSuchProcess, psutil.AccessDenied, ValueError, OSError):
            continue
    return identities


def _identity_alive(identity: ProcessIdentity) -> bool:
    """Return true only while the exact captured process remains live."""
    return identity_matches(identity) and process_alive(identity.pid)


def _wait_identities(identities: list[ProcessIdentity], timeout: float) -> list[ProcessIdentity]:
    """Return identities still alive after at most ``timeout`` seconds."""
    deadline = time.monotonic() + max(timeout, 0.0)
    remaining = [identity for identity in identities if _identity_alive(identity)]
    while remaining and time.monotonic() < deadline:
        time.sleep(min(0.01, max(0.0, deadline - time.monotonic())))
        remaining = [identity for identity in remaining if _identity_alive(identity)]
    return remaining


def teardown_identities(
    identities: list[ProcessIdentity] | tuple[ProcessIdentity, ...],
    *,
    grace: float = 1.0,
) -> TeardownOutcome:
    """TERM, verify, then KILL only the exact processes captured earlier."""
    unique: list[ProcessIdentity] = []
    seen: set[tuple[int, float]] = set()
    for identity in identities:
        key = (identity.pid, identity.create_time)
        if key not in seen:
            seen.add(key)
            unique.append(identity)

    active: list[ProcessIdentity] = []
    skipped: list[ProcessIdentity] = []
    kill_targets: list[ProcessIdentity] = []
    for identity in reversed(unique):
        if not identity_matches(identity):
            skipped.append(identity)
            continue
        if not process_alive(identity.pid):
            continue
        try:
            process = psutil.Process(identity.pid)
            if IS_POSIX:
                process.terminate()
                active.append(identity)
            else:
                process.kill()
                kill_targets.append(identity)
        except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
            continue

    remaining = _wait_identities(active, grace)
    remaining_keys = {(item.pid, item.create_time) for item in remaining}
    terminated = [item for item in active if (item.pid, item.create_time) not in remaining_keys]
    for identity in remaining:
        if not identity_matches(identity):
            skipped.append(identity)
            continue
        try:
            psutil.Process(identity.pid).kill()
            kill_targets.append(identity)
        except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
            continue

    survivors = _wait_identities(kill_targets, grace)
    survivor_keys = {(item.pid, item.create_time) for item in survivors}
    killed = [item for item in kill_targets if (item.pid, item.create_time) not in survivor_keys]
    return TeardownOutcome(
        terminated=tuple(terminated),
        killed=tuple(killed),
        survivors=tuple(survivors),
        skipped_mismatch=tuple(skipped),
    )


def _killpg(pid: int, sig: int) -> bool:
    """
    POSIX fast path: signal the child's whole process group.

    Refuses to signal our OWN process group. A child spawned without
    ``start_new_session`` never becomes a group leader, so ``getpgid(pid)``
    resolves to the group we *share* with our parent — pytest, the
    harness/runner supervisor, the CI job step. ``killpg`` on that group would
    take down this process and everything around it (observed in CI as a
    job-wide "runner received shutdown signal" cancelling e2e at ~96%). The old
    code passed ``pid`` itself as the pgid, which failed safe for a non-leader
    (no group is numbered ``pid`` → ``ProcessLookupError`` → caller falls back);
    resolving the real group removed that accidental safety. Returning False
    here makes :func:`terminate_tree` / :func:`kill_tree` fall back to the
    psutil per-descendant walk, which signals only the real target subtree.

    :returns: True if the group signal was delivered, False if process groups
        are unavailable (Windows), the lookup failed, or the target group is
        our own.
    """
    if not IS_POSIX or _killpg_fn is None or _getpgid_fn is None:
        return False
    try:
        target_pgid = _getpgid_fn(pid)
        if target_pgid == _getpgid_fn(0):
            return False
        _killpg_fn(target_pgid, sig)
        return True
    except (ProcessLookupError, PermissionError, OSError):
        return False


def _walk_descendants(pid: int) -> list[psutil.Process]:
    """Return the process plus all live descendants, innermost-last is not guaranteed."""
    try:
        root = psutil.Process(pid)
    except psutil.NoSuchProcess:
        return []
    procs = [root]
    with suppress(psutil.NoSuchProcess, psutil.AccessDenied):
        procs.extend(root.children(recursive=True))
    return procs


def terminate_tree(process: _ProcessLike | None, *, grace: float = 0.0) -> None:
    """
    Gracefully stop ``process`` and all of its descendants.

    Sends ``SIGTERM`` (POSIX) / ``terminate()`` (Windows ``TerminateProcess``)
    to the whole tree. On POSIX the process-group fast path is tried first;
    otherwise (and on Windows) the tree is walked with :mod:`psutil`. Already
    exited processes are no-ops. All "process gone / not permitted" errors are
    swallowed — teardown is best-effort.

    :param process: A ``Popen``/``asyncio`` process handle, or ``None``.
    :param grace: Optional seconds to wait for the tree to exit after signaling.
    """
    if process is None or process.returncode is not None:
        return
    pid = getattr(process, "pid", None)
    if pid is None:
        terminate = getattr(process, "terminate", None)
        if callable(terminate):
            with suppress(Exception):
                terminate()
        else:
            send_signal = getattr(process, "send_signal", None)
            if callable(send_signal):
                with suppress(Exception):
                    send_signal(signal.SIGTERM)
        return

    if _killpg(pid, signal.SIGTERM):
        if grace:
            _wait_gone(pid, grace)
        return

    procs = _walk_descendants(pid)
    for proc in procs:
        with suppress(psutil.NoSuchProcess, psutil.AccessDenied):
            proc.terminate()
    if not procs:
        with suppress(Exception):
            process.terminate()
    if grace:
        _wait_gone(pid, grace)


def kill_tree(process: _ProcessLike | None) -> None:
    """
    Forcibly kill ``process`` and all of its descendants.

    Like :func:`terminate_tree` but with ``SIGKILL`` (POSIX) /
    ``TerminateProcess`` (Windows). Use after a grace period when a graceful
    terminate did not take.
    """
    if process is None or process.returncode is not None:
        return
    pid = getattr(process, "pid", None)
    if pid is None:
        kill = getattr(process, "kill", None)
        if callable(kill):
            with suppress(Exception):
                kill()
        return

    if _killpg(pid, _SIGKILL):
        return

    procs = _walk_descendants(pid)
    for proc in procs:
        with suppress(psutil.NoSuchProcess, psutil.AccessDenied):
            proc.kill()
    if not procs:
        with suppress(Exception):
            process.kill()


def _wait_gone(pid: int, timeout: float) -> None:
    with suppress(psutil.NoSuchProcess, psutil.AccessDenied):
        psutil.Process(pid).wait(timeout=timeout)


def process_alive(pid: int) -> bool:
    """
    Whether ``pid`` names a live, non-zombie process.

    Cross-platform replacement for the ``os.kill(pid, 0)`` liveness probe (which
    behaves differently on Windows). A zombie/defunct process counts as not
    alive — it has exited and is only awaiting reaping.

    :param pid: The process id to probe.
    :returns: True if the process exists and has not exited.
    """
    if pid <= 0:
        return False
    try:
        return bool(psutil.Process(pid).status() != psutil.STATUS_ZOMBIE)
    except psutil.NoSuchProcess:
        # Includes psutil.ZombieProcess (a NoSuchProcess subclass).
        return False
    except psutil.AccessDenied:
        # Exists but belongs to another user / can't introspect -> alive.
        return True
