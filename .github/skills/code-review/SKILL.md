---
name: code-review
description: Review policy for this repository's Copilot code reviews. Use when reviewing pull requests: sets the finding bar, anti-dribble and no-relitigation rules, and the repo's domain invariants to check first.
---

# Code review policy

## The bar for a finding
Comment only on:
- bugs (wrong behavior, not style),
- security issues,
- violations of this repo's stated guardrails (`docs/agent-interface-design.md` §11).

Do not comment on:
- style or formatting — prettier/eslint own that and CI enforces it,
- speculative "consider..." suggestions — if it isn't clearly wrong, it isn't a finding,
- anything the repo's tests or CI already cover.

## One full pass
Report everything that meets the bar in a single review. Do not hold findings back for later rounds.

## No re-litigation
If a thread was resolved (fixed, or explicitly disagreed-with and resolved with reasoning), do not raise the same point again in a later round.

## Check the domain invariants first
Before general review, verify these repo-specific invariants from the design doc:
- Token hygiene: store only SHA-256 hashes; constant-time comparison; never log token material, user codes, or device codes (§11.3).
- No demo-user fallback on the new surface: invalid token → 401, scope mismatch → 403, never silent fallback (§11.2).
- Surgical diffs: UI routes, scheduler timing, and existing API response shapes untouched unless the PR says otherwise (§11.1).
- Stateless across replicas: no in-memory session, device-code, or MCP session state — everything in Postgres (§11.7).
- Idempotent producers: event emission uses `dedupe_key` with insert-on-conflict-do-nothing (§11.4).

## Convergence
If nothing meets the bar, say so plainly ("no findings") rather than manufacturing comments. A short, clean review is the goal — thorough once, not endless rounds.
