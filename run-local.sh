#!/bin/zsh
# Runs the watcher from this Mac (launchd). playtomic.com blocks GitHub's runner IPs.
# NTFY_TOPIC comes from ~/.config/padel-watcher/env so it stays out of the repo.
set -euo pipefail
cd "${0:A:h}"
export PATH="/Users/sean.gray/.nvm/versions/node/v22.14.0/bin:/usr/bin:/bin"
[[ -f ~/.config/padel-watcher/env ]] && source ~/.config/padel-watcher/env
echo "── $(date '+%Y-%m-%d %H:%M:%S')"
exec npx --yes tsx playtomic-watch.ts
