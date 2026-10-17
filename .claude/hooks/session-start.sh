#!/bin/bash
# Installs dependencies in Claude Code cloud sessions so typecheck and tests run straight away.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
# npm install (not ci) reuses the cached node_modules from earlier sessions.
# --ignore-scripts skips `prepare` (a full build); tests and typecheck run from source.
npm install --no-audit --no-fund --ignore-scripts
