# Front Row

TV show tracking application built with React, Express, and PostgreSQL.

## Run locally

Install dependencies with `npm install`, configure the required environment
variables described in `replit.md`, then run `npm run dev`.

## Update the public GitHub repository

The public repository is [bcm/front-row](https://github.com/bcm/front-row).
Its history began with a reviewed source snapshot, **not** this Replit
project's older Git history. Do not force-push local `main` to GitHub.

1. Track any new source files you want to publish with `git add <file>`.
2. Run `npm run github:sync` to preview exactly which files will change.
3. Review the list, then run `npm run github:sync -- --publish`.

The command uses the Replit GitHub connection; it does not require copying a
token into the project. It publishes eligible tracked application files from
the current working tree (including uncommitted edits), excludes
`attached_assets/`, agent notes, and local secret files, and creates a new
commit on GitHub. It does not alter local Git commits or publish their history.
Run it from the connected Replit workspace, not an unauthenticated machine.