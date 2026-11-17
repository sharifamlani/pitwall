#!/usr/bin/env bash
# Runs every Pitwall check. Prints PASS/FAIL per check; exits 1 on the first failure.
#
#   bash scripts/verify.sh                # host: all checks, including the container build and Linux tests
#   bash scripts/verify.sh --skip-docker  # skip the container build and Linux tests (e.g. inside the container)
set -euo pipefail

SKIP_DOCKER=0
[[ "${1:-}" == "--skip-docker" ]] && SKIP_DOCKER=1

cd "$(git rev-parse --show-toplevel)"
# An inherited, activated venv from another project would hijack poetry — never use it here.
unset VIRTUAL_ENV

pass() { echo "PASS $1"; }
fail() { echo "FAIL $1: $2"; exit 1; }

# 1. eol — no tracked text file is stored with CRLF (breaks shell scripts in the container)
crlf=$(git ls-files --eol | grep -c 'i/crlf' || true)
[[ "$crlf" == "0" ]] || fail eol "$crlf tracked files stored with CRLF"
pass eol

# 2. poetry — install and run the Python test suite
poetry install --no-interaction -q || fail poetry "poetry install failed"
poetry run pytest -q || fail poetry "tests failed"
pass poetry

# 3. ignore — nothing private is tracked (this repo is public); any depth, any casing
poetry run python -m tools.check_private_paths || fail ignore "private paths are tracked (see LEAKED lines)"
pass ignore

# 4. env — every .env.example key exists in .env
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "created .env from .env.example (values empty)"
fi
poetry run python -m tools.check_env || fail env "check_env reported a problem"
pass env

# 5. isolation — inside the dev container only: node_modules writable, no credentials visible
if [[ "${PITWALL_CLAUDE_HOME:-}" == "/home/vscode/.claude-host" ]]; then
  { touch node_modules/.write-probe 2>/dev/null && rm -f node_modules/.write-probe; } \
    || fail isolation "node_modules is not writable by $(whoami)"
  [[ ! -e "$PITWALL_CLAUDE_HOME/.credentials.json" ]] \
    || fail isolation "Claude login credentials are visible in the container"
  [[ -z "$(ls -A .packages 2>/dev/null)" ]] \
    || fail isolation ".packages/ (local credentials) is visible in the container"
  pass isolation
fi

# 6. docker — container builds with the pinned toolchain (host only)
if [[ $SKIP_DOCKER -eq 1 || -f /.dockerenv ]]; then
  echo "SKIP docker (inside container or --skip-docker)"
elif ! command -v docker >/dev/null 2>&1; then
  echo "SKIP docker (docker not installed)"
else
  docker build -q -t pitwall-dev -f .devcontainer/Dockerfile .devcontainer >/dev/null \
    || fail docker "image build failed"
  versions=$(docker run --rm pitwall-dev sh -c 'node -v; python --version; poetry --version')
  grep -q '^v22\.' <<<"$versions" || fail docker "node is not v22: $versions"
  grep -q '^Python 3\.13\.' <<<"$versions" || fail docker "python is not 3.13: $versions"
  grep -q 'Poetry (version 2\.3\.4)' <<<"$versions" || fail docker "poetry is not 2.3.4: $versions"
  pass docker
fi

# 7. npm � the extension installs, typechecks and compiles
npm ci --no-audit --no-fund >/dev/null || fail npm "npm ci failed"
npm run typecheck >/dev/null || fail npm "typecheck failed"
npm run compile >/dev/null || fail npm "compile failed"
pass npm

# 8. linux-tests � the npm test suite on Linux in the container (host only)
if [[ $SKIP_DOCKER -eq 1 || -f /.dockerenv ]]; then
  echo "SKIP linux-tests (inside container or --skip-docker)"
elif ! command -v docker >/dev/null 2>&1; then
  echo "SKIP linux-tests (docker not installed)"
else
  bash scripts/run-linux-tests.sh || fail linux-tests "Linux npm tests failed"
  pass linux-tests
fi

echo "VERIFY: ALL CHECKS PASSED"
