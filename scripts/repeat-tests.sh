#!/usr/bin/env bash
# Runs dry tests many times to measure flakiness.
#
#   bash scripts/repeat-tests.sh <file-filter> <runs> [--parallel P] [--name <pattern>]
#
# P workers (default 1), each with its own build dir test/dry/.build-<worker>, share <runs> runs.
# Prints "RUNS n PASS p FAIL f" (or "RUNS n SKIPPED" when every run only skipped, or "RUNS n NOMATCH" and exit 2 when a run executed no test) and the log of each failed run.
# Exit 1 when any run failed.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

[ $# -ge 2 ] || { echo "usage: repeat-tests.sh <file-filter> <runs> [--parallel P] [--name <pattern>]" >&2; exit 2; }
FILTER=$1; RUNS=$2; shift 2
PAR=1; NAME=""
while [ $# -gt 0 ]; do
  case $1 in
    --parallel) PAR=$2; shift 2 ;;
    --name) NAME=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

LOGS=$(mktemp -d)
worker() {
  local w=$1 n=$2 i
  for ((i = 1; i <= n; i++)); do
    PITWALL_TEST_BUILD_DIR=".build-$w" PITWALL_TEST_NAME_PATTERN="$NAME" \
      node test/dry/run.js "$FILTER" > "$LOGS/w$w-r$i.log" 2>&1
    echo $? > "$LOGS/w$w-r$i.rc"
  done
}
base=$((RUNS / PAR)); extra=$((RUNS % PAR))
for ((w = 1; w <= PAR; w++)); do
  n=$base; [ "$w" -le "$extra" ] && n=$((n + 1))
  worker "$w" "$n" &
done
wait

pass=0; fail=0; skipped=0; nomatch=0
# Test-level lines only: node also prints a file-level line (`✔ <file>.test.cjs (12ms)`) that is not a test.
FILE_LINE='\.cjs \([0-9.]+ms\)'
for rc in "$LOGS"/*.rc; do
  log="${rc%.rc}.log"
  if [ "$(cat "$rc")" = 0 ]; then
    pass=$((pass + 1))
    if grep -E "^ *✔ " "$log" | grep -qvE "$FILE_LINE"; then
      :
    elif grep -E "^ *﹣ " "$log" | grep -qvE "$FILE_LINE"; then
      skipped=$((skipped + 1))
    else
      nomatch=$((nomatch + 1))
    fi
  else
    fail=$((fail + 1)); echo "FAILED RUN LOG: $log"; grep -E "^ *✖ |Error|^ *at " "$log" | head -8
  fi
done
total=$((pass + fail))
if [ "$nomatch" -gt 0 ]; then
  echo "RUNS $total NOMATCH (pattern matched no test)"
  rm -f "$LOGS"/*.rc
  exit 2
fi
if [ "$fail" = 0 ] && [ "$skipped" = "$total" ]; then
  echo "RUNS $total SKIPPED"
else
  echo "RUNS $total PASS $pass FAIL $fail"
fi
rm -f "$LOGS"/*.rc
[ "$fail" = 0 ]
