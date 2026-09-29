# Contributing

Thanks for taking the time to improve pi-blackhole. This guide covers the
workflow we use for issues, pull requests, and releases.

## Branching model

- **All pull requests target `dev`.** `dev` is the integration branch where
  changes accumulate between releases.
- **`main` is release-only.** Do not open pull requests against `main`, and do
  not treat `main` as a merge base. Pull requests opened against `main` (or any
  other branch) will be rebased or repointed to `dev` before they are reviewed
  or merged.
- Work from a feature branch cut from `dev`:
  ```bash
  git fetch origin
  git switch -c fix/short-description origin/dev
  ```
- Keep the branch focused. Small, single-purpose pull requests are easier to
  review, test, and revert.

## Development setup

This project uses [pnpm](https://pnpm.io/) only.

```bash
pnpm install
pnpm build        # tsup bundle -> dist/ (required before Pi can load the extension)
pnpm test         # vitest run, all tests (pure unit tests, no network)
pnpm typecheck    # tsc --noEmit
pnpm lint         # oxlint .
pnpm format:check # oxfmt --check .
pnpm check        # typecheck + lint
```

CI runs `build` → `typecheck` → `lint` → `test` → `format:check`. A pull request
is expected to be green across all of these.

### Tests

- Write tests for new behavior and bug fixes. Prefer tests that can fail
  without the change: prove the test is red before it is green.
- Cover the branches, not just the happy path (fallbacks, empty input, error
  paths).
- Keep tests deterministic and offline. The suite uses fake agent loops and
  mocks; nothing should require a live model or the network.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/), with a scope
where it helps:

```
feat(recall): add page guard
fix(om): retry when the runtime generation is stale
docs: clarify config precedence
chore(release): 0.5.8
```

## Pull request description

Every pull request must open with a **short, human-facing preamble in plain
language**. This is the first thing a reviewer reads, so it must stand on its
own:

- Describe the problem and the change in everyday terms.
- No jargon, no internal identifiers, no code dumps. A person who does not work
  on this codebase should understand what was wrong and what is better now.
- Two to four sentences is plenty.

After that preamble, continue with the normal engineering detail. A suggested
structure:

```markdown
## Summary (plain language)

<2–4 sentences a layperson can follow.>

## Problem

What is broken, missing, or risky? Include symptoms and, where relevant, a
minimal reproduction or the failing path.

## Proposed fix

What changed and why this approach. Call out anything a reviewer should look at
closely.

## Alternatives considered

Other approaches you weighed and why you did not take them. Note known
trade-offs or follow-up work.

## Testing

How the change is covered: new/updated tests, manual verification, edge cases.

## Docs & changelog

- [ ] `docs/` updated (required for substantial changes — see below)
- [ ] `CHANGELOG.md` updated under `[Unreleased]`
```

### Documentation gate

If the change is **substantial** — new or changed behavior, configuration,
commands, hooks, or public surface — the matching file under `docs/` must be
updated in the same pull request. At minimum:

- `docs/architecture.md` for structural/internal changes.
- `docs/observational-memory.md`, `docs/recall.md`, `docs/vcc-compaction.md`,
  `docs/APPEND_COMPACTION.md`, or `docs/CONFIG.md` for the relevant feature.
- `README.md` and `llms.txt` when defaults, config keys, or user-facing numbers
  change (they must stay in sync with `src/core/unified-config.ts`).

If a change is small and internal, say so explicitly in the pull request instead
of leaving the checklist blank.

### Changelog gate

**Always** add an entry to `CHANGELOG.md` under `## [Unreleased]`, in the
appropriate section (`Added`, `Changed`, `Fixed`, `Removed`).

- Write **2–3 sentences** describing the issue that was fixed (or the feature
  added) and its user-visible effect.
- Explain the problem and the outcome, not a line-by-line account of the diff.
  Keep it factual and readable; avoid marketing prose.
- Keep the existing style, including a link to the issue or pull request where
  one exists.

Example:

```markdown
### Fixed

- **Consolidation is cancelled across session reloads.** Reloading a session
  during active consolidation could append late worker output through the stale
  extension instance while reflection work was lost instead of retried. Worker
  stages, model resolution, and deferred compaction are now guarded by a runtime
  generation and aborted on session shutdown, and a fresh runtime retries the
  work ([#74](https://github.com/k0valik/pi-blackhole/pull/74)).
```

## Review expectations

- Keep the diff scoped to the stated problem; unrelated cleanup belongs in its
  own pull request.
- Respond to review comments or push follow-up commits on the same branch. Do
  not force-push away context a reviewer is actively looking at.
- Maintainers may rebase your branch onto the latest `dev` and repoint the pull
  request before merging; this is normal and does not require action from you.
