#!/usr/bin/env bash
set -euo pipefail

# Restore exactly the dependency versions recorded by the merged lockfile.
npm ci --no-audit --no-fund