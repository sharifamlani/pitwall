#!/usr/bin/env bash
# Runs the extension's npm test suite on Linux inside the pitwall-dev container.
# Only tracked and unignored files are sent in, so .packages/, .env and transcripts/ never reach it.
#
#   bash scripts/run-linux-tests.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

git ls-files -co --exclude-standard -z | tar --null -T - -cf - | docker run -i --rm pitwall-dev sh -c 'mkdir -p /tmp/w && tar -xf - -C /tmp/w && cd /tmp/w && npm ci --no-audit --no-fund && npm test'
