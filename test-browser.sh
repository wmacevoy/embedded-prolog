#!/bin/bash
# ============================================================
# Browser smoke tests — verify demos render visible content
#
# Uses a static file server + curl to check pages are servable,
# then uses Playwright (if available) to check actual rendering.
#
# Run:  ./test-browser.sh
# ============================================================

set -e
cd "$(dirname "$0")"

PASS=0
FAIL=0
PORT=8765

# ── Phase 1: File structure checks ──────────────────────────

echo ""
echo "━━━ Browser demo smoke tests ━━━"
echo ""
echo "Phase 1: File checks"

DEMOS=(
  "docs/index.html:Y@:PrologEngine"
  "docs/demos/form.html:Form:PrologEngine"
  "docs/demos/tictactoe.html:Tic:PrologEngine"
  "docs/demos/adventure.html:Obsidian:PrologEngine"
)

for entry in "${DEMOS[@]}"; do
  IFS=: read -r file title engine <<< "$entry"
  if [ ! -f "$file" ]; then
    echo "  ✗ $file — not found"
    FAIL=$((FAIL + 1))
    continue
  fi
  SIZE=$(wc -c < "$file" | tr -d ' ')
  if [ "$SIZE" -lt 1000 ]; then
    echo "  ✗ $file — too small ($SIZE bytes)"
    FAIL=$((FAIL + 1))
    continue
  fi
  if ! grep -q "$engine" "$file"; then
    echo "  ✗ $file — missing $engine"
    FAIL=$((FAIL + 1))
    continue
  fi
  if ! grep -q "$title" "$file"; then
    echo "  ✗ $file — missing title '$title'"
    FAIL=$((FAIL + 1))
    continue
  fi
  echo "  ✓ $file ($SIZE bytes)"
  PASS=$((PASS + 1))
done

# ── Phase 2: HTTP serve + fetch ─────────────────────────────

echo ""
echo "Phase 2: HTTP serve + fetch"

if command -v python3 >/dev/null 2>&1; then
  python3 -m http.server $PORT --bind 127.0.0.1 >/dev/null 2>&1 &
  SERVER_PID=$!
  # Wait for server to be ready (retry up to 5s)
  for _i in 1 2 3 4 5 6 7 8 9 10; do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break
    sleep 0.5
  done

  for entry in "${DEMOS[@]}"; do
    IFS=: read -r file title engine <<< "$entry"
    URL="http://127.0.0.1:$PORT/$file"
    STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$URL" 2>/dev/null || echo "000")
    if [ "$STATUS" = "200" ]; then
      # Check response body contains engine
      BODY=$(curl -s "$URL" 2>/dev/null || true)
      if printf '%s' "$BODY" | grep -q "$engine" 2>/dev/null; then
        echo "  ✓ GET $file → 200 (contains $engine)"
        PASS=$((PASS + 1))
      else
        echo "  ✗ GET $file → 200 but missing $engine"
        FAIL=$((FAIL + 1))
      fi
    else
      echo "  ✗ GET $file → $STATUS"
      FAIL=$((FAIL + 1))
    fi
  done

  kill $SERVER_PID 2>/dev/null || true
  wait $SERVER_PID 2>/dev/null || true
else
  echo "  (skipping — python3 not found)"
fi

# ── Phase 3: JS import resolution ────────────────────────────

echo ""
echo "Phase 3: Import resolution (Node module check)"

# Check that all local JS imports resolve — catches "module" and bare specifier errors
if command -v node >/dev/null 2>&1; then
  for entry in "${DEMOS[@]}"; do
    IFS=: read -r file title engine <<< "$entry"
    # Extract local JS imports from the HTML
    BAD=0
    for jsfile in $(grep -oE 'from "[^"]*"' "$file" 2>/dev/null | grep -v 'https://' | grep -v 'cdn\.' | sed 's/from "//;s/"$//' | grep '\.js$'); do
      # Resolve relative to the HTML file's directory
      DIR=$(dirname "$file")
      RESOLVED="$DIR/$jsfile"
      # Normalize path
      RESOLVED=$(cd "$DIR" 2>/dev/null && realpath "$jsfile" 2>/dev/null || echo "$RESOLVED")
      if [ -f "$RESOLVED" ]; then
        # Check the JS file doesn't import Node-only builtins
        if grep -qE 'from "module"|from "fs"|from "path"|from "crypto"|from "os"' "$RESOLVED" 2>/dev/null; then
          echo "  ✗ $RESOLVED imports Node-only builtin"
          FAIL=$((FAIL + 1))
          BAD=1
        fi
      fi
    done
    if [ "$BAD" = "0" ]; then
      echo "  ✓ $file — local imports clean"
      PASS=$((PASS + 1))
    fi
  done
else
  echo "  (skipping — node not found)"
fi

# ── Phase 4: Playwright rendering (optional) ────────────────

echo ""
echo "Phase 4: Headless browser rendering"

if command -v npx >/dev/null 2>&1 && npx playwright --version >/dev/null 2>&1; then
  python3 -m http.server $PORT --bind 127.0.0.1 >/dev/null 2>&1 &
  SERVER_PID=$!
  sleep 1

  # Quick Playwright script: load page, check for visible text
  node -e "
    const { chromium } = require('playwright');
    (async () => {
      const browser = await chromium.launch();
      const demos = [
        ['docs/index.html', 'Y@'],
        ['docs/demos/form.html', 'Sign Up'],
        ['docs/demos/tictactoe.html', 'Tic'],
        ['docs/demos/adventure.html', 'Obsidian'],
      ];
      let pass = 0, fail = 0;
      for (const [path, text] of demos) {
        const page = await browser.newPage();
        await page.goto('http://127.0.0.1:$PORT/' + path, { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {});
        const content = await page.textContent('body').catch(() => '');
        if (content && content.includes(text)) {
          console.log('  ✓ ' + path + ' renders (contains \"' + text + '\")');
          pass++;
        } else {
          console.log('  ✗ ' + path + ' — \"' + text + '\" not visible');
          fail++;
        }
        await page.close();
      }
      await browser.close();
      process.exit(fail);
    })();
  " 2>/dev/null && PASS=$((PASS + 4)) || FAIL=$((FAIL + 1))

  kill $SERVER_PID 2>/dev/null || true
  wait $SERVER_PID 2>/dev/null || true
else
  echo "  (skipping — playwright not installed)"
  echo "  install: npx playwright install chromium"
fi

# ── Summary ─────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  $PASS checks passed, $FAIL failed"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
[ "$FAIL" -eq 0 ]
