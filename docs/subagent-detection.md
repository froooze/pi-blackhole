# Subagent Detection and Memory Gating

How Blackhole decides that a session is a subagent's, and why those sessions run no observational memory by default — the signal order, the `subagentMemory` knob, precedence, and the known blind spots.

Audience: users whose subagent runner is not recognised, extension authors adding a runner, and anyone debugging a `subagent.memory_skipped` record.

See also: [[CONFIG.md]] (`subagentMemory` reference), [[observational-memory.md]] (the OM pipeline that is gated), [[mid-run-compaction.md]] (compaction, which is **not** gated), [[recall.md]] and [[architecture.md]] (module map).

## Why subagents are gated

Issue [#147](https://github.com/k0valik/pi-blackhole/issues/147) measured 163 real sessions (67 main, 96 subagents) with `memory: true`:

| | Main sessions | Subagent sessions |
|---|---|---|
| Compactions | 259 | 1 |
| Memories injected | 5,853 / 6,751 (86.7%) | **15 / 1,111 (1.35%)** |
| Observer / reflector / dropper runs | 1,295 / 944 / 195 | 185 / 108 / 10 |
| Generated observation + reflection text | ~480k tokens | **~138k tokens** |

The workers fire on token thresholds (`observeAfterTokens`, `reflectAfterTokens`) that a subagent can reach, but child sessions are short-lived: they rarely reach a compaction, and non-persisted ones can lose the `agent_end` deferred-compaction race entirely. The generated memory is then almost never injected — pure cost, and on local-inference rigs it also contends with the model serving the subagent itself.

There is no pi-level "this is a subagent" flag. Every runner needs a different answer — exclude Blackhole from the child's extension list, wrap it in an env-setting shim, or turn memory off per child — and several of those options do not exist for in-process runners. `subagentMemory` replaces that with one builtin default plus centralized, best-effort detection.

Compaction is deliberately untouched: children keep whatever `compactionEngine` their own config resolves to. The knob gates OM workers and OM content injection only.

## The knob

| Surface | Behavior |
|---|---|
| Config file | `subagentMemory: "off" \| "inherit"`, default `"off"`, case-insensitive; invalid values are ignored at load |
| Settings modal | enum field, same two values |
| Env | `PI_BLACKHOLE_SUBAGENT_MEMORY` (`off`/`inherit`), declarative override of the file; a non-empty invalid value warns and is ignored |
| Global kill switch | `memory: false` disables OM everywhere, regardless of `subagentMemory` |

What `"off"` gates, in order of the session lifecycle:

- `maybeLaunchConsolidation` — no observer/reflector/dropper run starts.
- `observeTailOnShutdown` — no shutdown observer attempt.
- The OM-injection sites in `before-compact.ts` — no observations/reflections are injected into the summary.
- Status-bar O/P gauges — hidden for a gated session.

Compaction scheduling, eligibility and the summary pipeline are not gated.

## Decision order

`src/core/subagent-detector.ts` is the single decision point. `detectSubagentSession(probe)` is pure (no I/O, no config reads), so it is directly unit-testable; `probeFromContext` builds the probe with every accessor guarded, because a stale extension context throws on use and detection must never be the reason a session crashes.

Signals are evaluated strongest-first:

1. **User-declared extra markers** — env names listed in `PI_BLACKHOLE_SUBAGENT_MARKERS` (comma-separated), checked with the shared truthy rule.
2. **Known runner env markers** — the Tier 1 table below.
3. **Runner-owned custom entry types** in the session branch — `pi-subagent:thread:v1` (`pi-subagent-manager`), `pi-herdsman-agent-definition` (`pi-herdsman`).
4. **Runner-owned session-file locations** — `<parent>.subagents/<child>.jsonl` (`pi-submarine`), `.pi-worktrees/<name>/` (`@bacnh85/pi-subagent`).
5. **In-memory fork** — `sessionStartReason === "fork"` with `isPersisted() === false` and an id that is not a known root. Forked subagents (ESSO-style) run on in-memory sessions; a user `/fork` is persisted.
6. **Generic ancestry mismatch** — every main session registers its id in `PI_BLACKHOLE_ROOT_SESSIONS` (and in module state) at `session_start`; any session with a different id is a child. This is the workhorse: it covers marker-less in-process runners Blackhole has never heard of, as long as the child inherits the parent environment.
7. **Root-reason tie-breakers** — `new`, `resume` and persisted `fork` all end the ancestry check in favour of "main" (see the ambiguity notes below).
8. Otherwise: **main session**.

### Tier 1 markers

Non-empty value ⇒ subagent session:

```text
PI_SUBAGENT_CHILD
PI_SUBAGENT_PARENT_SESSION
PI_SUBAGENT_AGENT
PI_SUBAGENT_NAME
PI_SUBAGENT_SESSION
PI_SUBAGENT_SURFACE
PI_SUBAGENT_EXECUTION_BUDGET
PI_SUBAGENT_PROCESS_LEASE
PI_SUBAGENT_STEER_FILE
PI_SUBAGENT_HERDR
GENTLE_PI_AGENTS_CHILD
GENTLE_PI_AGENTS_OWNED_IPC
PI_SUBAGENT_DEPTH
```

Two markers use their own value test:

- `PI_SUBAGENT_HERDR` is accepted unless its value is empty, `0` or `false`. `off` **is** a child marker: `@bacnh85/pi-subagent` sets `off` in children to disable its herdr tool.
- `PI_SUBAGENT_DEPTH` is accepted only when it parses to an integer `> 0` (narumiruna's runner).

Everything else uses the shared truthy rule: non-empty after trimming, and not `0`, `false`, `no` or `off`.

Deliberately **not** used as identity markers:

- Parent-side configuration vars (`PI_SUBAGENT_TIMEOUT*`, `PI_SUBAGENT_DEADLINE*`, `PI_SUBAGENTS_DEBUG`) — the parent usually has them too.
- Ambient vars (`PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`).
- `PI_HERDSMAN_*` / `HERDR_*` topology vars and `GENTLE_PI_AGENTS_REQUESTED_TOOLS` — corroboration only.
- `PI_SUBAGENT_BROKER_FD` / `PI_SUBAGENT_READINESS_FD` — deleted on import, visible only very early.

### Ancestry, forks, resumes

The ancestry marker deserves its own explanation because it is the only signal that generalises to unknown in-process runners. A main session writes its id to `PI_BLACKHOLE_ROOT_SESSIONS` and to module state. An in-memory child shares `process.env` and inherits both; a detached child inherits the env var. Either way the child's own session id is different from every registered root id, so the mismatch is the signal. Module state exists as a fallback for hosts that clear or overwrite the env var.

The registry is pruned on `session_shutdown` (`unregisterRootSession`) except when the reason is `reload` — the same session continues, so its id must stay. Without the teardown, a session id from a previous session in the same host would misclassify a later main session. The shutdown handler runs `observeTailOnShutdown` first (it reads the per-session decision synchronously), then unregisters.

Three session-start reasons can look like a child without being one, so each has an explicit rule:

| Reason | Rule | Why |
|---|---|---|
| `new` | main (`session:new_root`) | `/new` in the same process is a new root, not a child of the previous session. |
| `resume` | main unless positive child evidence above (`session:resumed_root`) | `/resume` cannot distinguish a user resuming a main session from one resuming a session originally created as a child. Resuming a main session and silently losing OM is the worse failure, so the tie goes to main. |
| `fork` | persisted ⇒ main (`session:manual_fork`); in-memory ⇒ child | A user `/fork` is a persisted main session; forked subagents run on in-memory sessions. |

A manually resumed *child* therefore keeps OM unless one of the stronger signals (an env marker, a runner entry type, a runner session path) still identifies it. That false negative is accepted: it costs tokens, it never disables the user's own memory.

## Gating internals

- `Runtime.noteSessionStart(ctx, event)` decides once at `session_start`, caches the decision per session id, and registers main ancestry. `Runtime.getSubagentDecision(ctx)` lazily probes and self-heals a missing `session_start` for main sessions.
- `Runtime.isMemoryEnabled(ctx, config)` is the gate. It reads the *current* config and the per-session decision; it never writes `runtime.config`, because in-process children share one `Runtime` with the parent. Mutating config to gate a child would turn OM off for the parent too.
- `noteSubagentMemorySkip` writes one `subagent.memory_skipped` debug record per session, including the reason (`env:PI_SUBAGENT_CHILD`, `session:root_ancestor_mismatch`, …). It is debug-only; no toast.

## Precedence

| Situation | Result |
|---|---|
| Main session, any knob | OM follows `memory` (unchanged) |
| Detected child, `subagentMemory: "off"` (default) | OM off, even if `memory` resolved to `true` (including an inherited `PI_BLACKHOLE_MEMORY=true`) |
| Detected child, `subagentMemory: "inherit"` | OM follows the child's resolved `memory`; an explicit `PI_BLACKHOLE_MEMORY=true` in that child works |
| Any session, `memory: false` | OM off everywhere |
| One child wants in under the default | Set `PI_BLACKHOLE_SUBAGENT_MEMORY=inherit` (or the config value) for that child |

"Knob wins under `off`" is intentional. Several runners copy `process.env` into the child wholesale, so a parent exporting `PI_BLACKHOLE_MEMORY=true` would otherwise silently re-enable workers in every child — exactly the failure the `pi-blackhole-child-guard` shim had to work around by setting two variables. The cost is that `PI_BLACKHOLE_MEMORY=true` alone cannot opt a child in; the opt-in is the one documented knob.

## False-positive posture

Unknown sessions are treated as **main**. A detection miss costs tokens; a false positive silently disables the user's own memory, which is the failure worth engineering against. Concretely:

- Env markers and runner evidence only fire on positive evidence, and the value tests reject falsey tokens.
- The ancestry marker is written by the main session itself, and the `new`/`resume`/persisted-`fork` reasons break ties before the mismatch rule.
- Every `ctx` accessor is guarded; an unfamiliar host shape yields an undefined field instead of a throw.
- The registry is pruned at shutdown (reload excepted), so a dead id cannot leak into the next session.

Residual cases:

- A new main session that emits an OM event *before* its own `session_start` has no registered id yet and can be seen as a child until the event arrives. Handled for `session_start` reasons; otherwise accepted.
- A detached runner that builds a clean environment instead of inheriting it does not pass `PI_BLACKHOLE_ROOT_SESSIONS` down. It needs a Tier 1 marker (or the extra-markers escape hatch).
- Detection reads the environment and session evidence only; marker names cannot come from the config file (see below).

## Unsupported runners: `PI_BLACKHOLE_SUBAGENT_MARKERS`

Runners Blackhole has not surveyed can still be detected without a code change, if the runner sets a stable child-only env var:

```sh
PI_BLACKHOLE_SUBAGENT_MARKERS=MY_RUNNER_CHILD,MY_RUNNER_TASK_ID
```

The value is a comma-separated list of **env var names**, not values. Each name is checked with the shared truthy rule, and a hit produces `env_custom:<name>` in the debug record. The runner must still set the variable inside the child — the list only tells Blackhole which names to inspect.

Do not list a name the parent also sets; that is a false positive by construction.

## Not implemented: config-file parity for extra markers

`PI_BLACKHOLE_SUBAGENT_MARKERS` is env-only today. A config-file equivalent (for example `subagentMarkers: string[]`) would help JSON-only users and Windows/PowerShell users who would rather not write shell-specific env syntax, and it is the same data in a second source. It is deferred, for three reasons:

1. **Ordering.** The original obstacle — config being read after the detection decision — is gone: the `session_start` handler loads config before `noteSessionStart`, so a config-file list could be read there. What remains is that `detectSubagentSession` is deliberately a pure probe over env plus session evidence; feeding it config would add a second input and a new precedence rule against the env list.
2. **Scope.** The config file is shared by parent and child, and it is project/global rather than per-session. The list is therefore not a per-child signal, and a listed name that happens to be set in the parent becomes a false positive for the parent.
3. **Surface.** A new key needs parsing, docs, example-config entry, precedence rules with the env list, and tests; the settings modal has no natural list widget.

The env list is also already an integration escape hatch: users of an unsupported runner are configuring that runner's environment anyway, and the marker itself comes from that runner. If parity is added later, the intended shape is: `subagentMarkers: string[]` holding env **names**; union with `PI_BLACKHOLE_SUBAGENT_MARKERS` (deduped, not replaced); JSON-only at first; empty/non-string entries dropped; and the same "the runner must still set the marker" caveat in the docs.

## Debugging

With `debugLog: true`, every session writes a `subagent.detect` record with the decision and reason, and a gated session writes one `subagent.memory_skipped` record containing the same reason. (`session_start` loads config before deciding, so `subagent.detect` appears in a fresh detached child too.) Use them to answer "why is my child running OM?" (no `memory_skipped`, so look at the reason tables) and "why did my main session lose OM?" (a record with an unexpected reason, usually an ambient env var or a shared config).

Checklist:

1. `grep subagent.memory_skipped ~/.pi/agent/pi-blackhole/debug.ndjson` — is the child gated at all?
2. If not, is any Tier 1 marker or extra marker visible in the child's environment?
3. If neither, does the child inherit `PI_BLACKHOLE_ROOT_SESSIONS`? A clean-env runner will not.
4. Is the session `resume` or `new`? Those reasons resolve to main unless stronger evidence exists.
5. If the main session was gated instead, look for a marker name that the parent also sets.
