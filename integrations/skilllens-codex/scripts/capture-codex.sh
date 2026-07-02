#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SKILLLENS_ROOT:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"

npm --prefix "$REPO_ROOT" run codex -- "$@"
