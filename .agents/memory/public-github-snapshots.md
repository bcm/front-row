---
name: Public GitHub history
description: Rationale and constraints for publishing this project's Git history publicly.
---

Public GitHub history excludes screenshots from all commits, not just the current tree. Active branches should track the cleaned public branches, while unfiltered history stays in local-only backup refs.

**Why:** The user chose to publish past source history while excluding historical screenshots, and wants ordinary `git push` for future updates. `.gitignore` cannot hide files already committed; rewriting history changed commit IDs. Keeping the original history on active branches would make a future force push expose those screenshots again.

**How to apply:** Commit and push from cleaned active branches; never push backup refs containing unfiltered history. Review new assets before making them public.