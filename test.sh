#!/bin/bash
# ============================================================
# Run all tests — C, Python, and JavaScript
#
#   ./test.sh           run all
#   ./test.sh python    python only
#   ./test.sh js        javascript only
#   ./test.sh c         c native core only
# ============================================================

set -e
cd "$(dirname "$0")"

PASS=0
FAIL=0

run() {
  echo ""
  echo "━━━ $1 ━━━"
  if eval "$2"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "  FAILED"
  fi
}

if [ -z "$1" ] || [ "$1" = "c" ]; then
  if command -v gcc >/dev/null 2>&1; then
    run "C native core (19 tests)" \
      "gcc -O2 -Wall -std=c11 -o native/test_core native/test_core.c native/prolog_core.c && ./native/test_core && rm -f native/test_core"
  else
    echo "  (skipping C tests — gcc not found)"
  fi
fi

if [ -z "$1" ] || [ "$1" = "python" ]; then
  PYTHON=""
  if command -v python3 >/dev/null 2>&1; then PYTHON=python3
  elif command -v python >/dev/null 2>&1; then PYTHON=python
  elif command -v micropython >/dev/null 2>&1; then PYTHON=micropython
  fi
  if [ -n "$PYTHON" ]; then
    run "Python vending machine ($PYTHON, 17 tests)" \
      "$PYTHON examples/vending/test.py"
    run "Python message router ($PYTHON, 28 tests)" \
      "$PYTHON examples/router/test.py"
  else
    echo "  (skipping Python tests — no interpreter found)"
  fi
fi

if [ -z "$1" ] || [ "$1" = "js" ]; then
  JS=""
  if command -v node >/dev/null 2>&1; then JS="node"
  elif command -v qjs >/dev/null 2>&1; then JS="qjs --module"
  elif command -v deno >/dev/null 2>&1; then JS="deno run"
  fi
  if [ -n "$JS" ]; then
    run "JS vending machine ($JS, 22 tests)" \
      "$JS examples/vending/test.js"
  else
    echo "  (skipping JS tests — no runtime found)"
  fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  $PASS suite(s) passed, $FAIL failed"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
[ "$FAIL" -eq 0 ]
