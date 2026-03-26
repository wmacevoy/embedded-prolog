#!/bin/bash
# ============================================================
# Run all tests — Python and JavaScript (Datalog layer)
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

if [ -z "$1" ] || [ "$1" = "python" ]; then
  PYTHON=""
  if command -v python3 >/dev/null 2>&1; then PYTHON=python3
  elif command -v python >/dev/null 2>&1; then PYTHON=python
  fi
  if [ -n "$PYTHON" ]; then
    run "Python Y8 Datalog ($PYTHON, 45 tests)" \
      "$PYTHON src/test_y8_datalog.py"
    run "Python vending Datalog ($PYTHON, 16 tests)" \
      "$PYTHON examples/vending/test_datalog.py"
    run "Python family tree ($PYTHON, 13 tests)" \
      "$PYTHON examples/family/test_family.py"
    run "Python tutorial Datalog ($PYTHON, 13 tests)" \
      "$PYTHON examples/tutorial/test_datalog.py"
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
    run "JS Y8 Datalog ($JS, 16 tests)" \
      "$JS src/test-y8-datalog.js"
    run "JS parser ($JS, 94 tests)" \
      "$JS src/test-parser.js"
  else
    echo "  (skipping JS tests — no runtime found)"
  fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  $PASS suite(s) passed, $FAIL failed"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
[ "$FAIL" -eq 0 ]
