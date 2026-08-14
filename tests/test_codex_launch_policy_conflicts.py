"""Regression tests for Codex full-bypass launch-argument precedence."""

from __future__ import annotations

from typing import Any

import pytest

from omnigent.harness_startup_config import resolve_harness_launch_args
from omnigent.runner.app import _codex_native_launch_config


_BYPASS = "--dangerously-bypass-approvals-and-sandbox"


class _Response:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.status_code = 200
        self._payload = payload

    def json(self) -> dict[str, Any]:
        return self._payload


class _Client:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._response = _Response(payload)

    async def get(self, url: str, timeout: float | None = None) -> _Response:
        del url, timeout
        return self._response


def test_global_bypass_removes_later_policy_conflicts_without_corrupting_args() -> None:
    global_cfg = {
        "harness": {
            "codex-native": {
                "args": [
                    "--config",
                    "model_reasoning_effort=high",
                    _BYPASS,
                ]
            }
        }
    }
    workspace_cfg = {
        "harness": {
            "codex-native": {
                "args": [
                    "--sandbox",
                    "read-only",
                    "--config",
                    "model_reasoning_effort=xhigh",
                    _BYPASS,
                ]
            }
        }
    }
    session_args = [
        "--ask-for-approval",
        "on-request",
        "--config",
        "model_reasoning_effort=medium",
        "--color",
        "always",
    ]

    assert resolve_harness_launch_args(
        "codex-native",
        session_args,
        config_layers=(global_cfg, workspace_cfg),
    ) == [
        "--config",
        "model_reasoning_effort=high",
        _BYPASS,
        "--config",
        "model_reasoning_effort=xhigh",
        "--config",
        "model_reasoning_effort=medium",
        "--color",
        "always",
    ]


@pytest.mark.asyncio
async def test_web_launch_cannot_weaken_global_full_bypass(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    global_cfg = {
        "harness": {
            "codex-native": {
                "args": [
                    "--config",
                    "model_reasoning_effort=high",
                    _BYPASS,
                ]
            }
        }
    }
    workspace_cfg = {
        "harness": {
            "codex-native": {
                "args": [
                    "--sandbox",
                    "read-only",
                    "--config",
                    "model_reasoning_effort=xhigh",
                ]
            }
        }
    }
    snapshot = {
        "workspace": str(tmp_path),
        "terminal_launch_args": [
            "--ask-for-approval",
            "on-request",
            "--config",
            "model_reasoning_effort=medium",
            "--color",
            "always",
        ],
    }
    monkeypatch.setenv("RUNNER_SERVER_URL", "http://127.0.0.1:8123")
    monkeypatch.setattr("omnigent.config.load_global_config", lambda: global_cfg)
    monkeypatch.setattr("omnigent.config.load_local_config", lambda _path: workspace_cfg)

    launch = await _codex_native_launch_config(
        session_id="conv_full_bypass",
        server_client=_Client(snapshot),  # type: ignore[arg-type]
    )

    assert launch.terminal_launch_args == [
        "--config",
        "model_reasoning_effort=high",
        _BYPASS,
        "--config",
        "model_reasoning_effort=xhigh",
        "--config",
        "model_reasoning_effort=medium",
        "--color",
        "always",
    ]
