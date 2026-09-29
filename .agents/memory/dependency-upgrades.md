---
name: Dependency upgrades
description: Compatibility considerations when upgrading JavaScript build dependencies.
---

Avoid forcing one transitive package major across the whole tree when build tools consume different majors. In particular, the CSS watcher stack consumes an older glob-matcher major while the bundler consumes a newer one.

**Why:** A global override resolves the audit but causes npm peer-resolution warnings in the bundler's dependency tree. Scoped overrides preserve each parent's compatible major. The schema tooling's latest stable release still includes an outdated build-tool binary transitively, so that override must be scoped to its parent as well.

**How to apply:** When refreshing security pins, inspect the dependency tree and peer requirements before broadening overrides; run the audit, type check, build, and app startup after changing the lockfile.