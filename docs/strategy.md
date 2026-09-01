# omnigent strategy

**Mode:** A — preferred internal interface and multi-agent operating harness.

**Evidence tier:** `assumed-stated` for Calvin's preferred-interface decision; repository capability claims are grounded in `README.md`.

## Ranked objectives

| ID | Objective | Weight | Evidence and backlog vocabulary |
|---|---|---:|---|
| OBJ-1 | Be Calvin's preferred interface for working across repositories and projects | 0.9 | Operator decision, 2026-09-01. Prioritize project discovery, navigation, context, cross-repo work, and operator continuity. |
| OBJ-2 | Run agents consistently across models, harnesses, and execution environments | 0.8 | `README.md` defines Omnigent as a meta-harness and documents agent execution, model switching, deployment, and harness interoperability. |
| OBJ-3 | Make multi-repository work reliable from request through verified result | 0.8 | Operator decision plus the repository's runtime, server, SDK, test-harness, and deployment surfaces. Prioritize truthful progress, evidence, errors, and resumability. |
| OBJ-4 | Preserve policy, permission, and collaboration boundaries while scaling use | 0.6 | `README.md` documents team collaboration and policy-based agent governance. |

## Success measures

- Calvin can start or resume work in the correct repository without rebuilding context manually.
- Agent runs report durable outputs, failures, and evidence rather than prose-only completion.
- Model or execution-environment changes do not silently change the requested work contract.

## Anti-goals

- Do not create a second project state that drifts from repository systems of record.
- Do not hide provider or execution failures behind a successful interface response.
- Do not broaden permissions merely to make a workflow complete.

## Sources

- `README.md`
- `CLAUDE.md`
- Repository runtime, server, SDK, and test documentation
- Operator decision, 2026-09-01
