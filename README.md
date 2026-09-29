# Front Row

TV show tracking application built with React, Express, and PostgreSQL.

## Run locally

Install dependencies with `npm install`, configure the required environment
variables described in `replit.md`, then run `npm run dev`.

## Update the public GitHub repository

The public repository is [bcm/front-row](https://github.com/bcm/front-row).
Its history was rebuilt from this Replit project's local history with
screenshots removed from past commits. That changed the commit IDs. The local
`main` still retains the original history, so do **not** force-push local
`main` to GitHub: it would put those screenshots back into the public history.

1. Track any new source files you want to publish with `git add <file>`.
2. Run `npm run github:sync` to preview exactly which files will change.
3. Review the list, then run `npm run github:sync -- --publish`.

The command uses the Replit GitHub connection; it does not require copying a
token into the project. It publishes eligible tracked application files from
the current working tree (including uncommitted edits), excludes
`attached_assets/`, agent notes, and local secret files, and creates a new
commit on GitHub. It does not alter local Git commits or republish their
history. For direct Git pushes instead, start from the sanitized `origin/main`
branch, not this workspace's original `main`.
Run it from the connected Replit workspace, not an unauthenticated machine.