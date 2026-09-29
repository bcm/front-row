---
name: TypeScript incremental cache
description: An environment-specific check for false type errors after compiler configuration changes.
---

When changing TypeScript's compilation target, a cached incremental typecheck can continue reporting errors that disappear on a clean run.

**Why:** An incremental check continued reporting downlevel-iteration errors even though the effective compiler configuration showed a modern target; running against a fresh build-info location passed, and clearing the generated cache let the normal check pass.

**How to apply:** If a typecheck contradicts `tsc --showConfig` after a compiler option change, check with a fresh build-info cache before changing source code to work around the error.