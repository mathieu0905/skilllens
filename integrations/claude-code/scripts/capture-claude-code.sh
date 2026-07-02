#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SKILLLENS_ROOT:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"

npm --prefix "$REPO_ROOT" run capture -- --agent claude_code "$@"

if [[ "${SKILLLENS_NO_OPEN:-0}" != "1" ]]; then
  npm --prefix "$REPO_ROOT" run open
fi
