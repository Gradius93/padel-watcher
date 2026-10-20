#!/bin/zsh
# Runs the watcher from this Mac (launchd). playtomic.com blocks GitHub's runner IPs.
# NTFY_TOPIC comes from .env (gitignored).
set -euo pipefail
cd "${0:A:h}"
export PATH="/Users/sean.gray/.nvm/versions/node/v22.14.0/bin:/usr/bin:/bin"
[[ -f .env ]] && source .env
echo "── $(date '+%Y-%m-%d %H:%M:%S')"
exec npx --yes tsx playtomic-watch.ts
