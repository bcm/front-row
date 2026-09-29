---
name: Public GitHub snapshots
description: Rationale and constraints for publishing this project's source publicly.
---

For a public GitHub repository, publish a reviewed source snapshot rather than blindly pushing the full local Replit Git history or uploaded assets.

**Why:** The pre-existing history is long and has not been audited commit by commit; uploaded screenshots and notes may contain information unrelated to the application. The first public upload used a clean source snapshot, so the public branch and local branch have unrelated histories. GitHub's Git Trees API rejects tree creation against an empty repository (409); create an initial commit first when using that API.

**How to apply:** Before subsequent public updates, screen the outgoing files and reconcile branch history deliberately. Do not assume a normal `git push` from the existing local main branch will fast-forward the public branch. Avoid exposing old commits or attachments without reviewing them.