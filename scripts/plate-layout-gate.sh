#!/bin/bash
# plate-layout-gate.sh — render the plate's pane fixtures and gate every one of them.
#
# Why a fixture bed at all: the LIVE sweep (a running app over CDP) is authoritative for the panel's real
# CSS, but it cannot run in CI and, in the probe bed, its deepest level renders "no settings to show" —
# an empty state reporting zero problems. This bed has all four states with eleven seeded settings, at five
# fixed container widths, so the levels with real content are covered deterministically.
#
# It gates the CSS and the markup. It does NOT gate host integration — the panel's own container rules are
# mirrored into the fixture (see faceplate-preview.mjs), and only the live sweep can catch those drifting.
#
# usage: bash scripts/plate-layout-gate.sh [out-dir]
#   CHROME=/path/to/chrome  override the browser
#   CDP_PORT=9223           debug port
set -uo pipefail
cd "$(dirname "$0")/.."

OUT=${1:-.faceplate-preview}
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
PORT=${CDP_PORT:-9223}
PROFILE=$(mktemp -d)
DUMP="$OUT/dumps"
rm -rf "$DUMP"; mkdir -p "$DUMP"

echo "=== render the fixtures ==="
node scripts/faceplate-preview.mjs "$OUT" || { echo "render failed"; exit 1; }

echo "=== start headless chrome ==="
"$CHROME" --headless=new $CHROME_FLAGS --remote-debugging-port="$PORT" --user-data-dir="$PROFILE" \
  --window-size=1600,1000 about:blank >/dev/null 2>&1 &
CHROME_PID=$!
trap 'kill $CHROME_PID 2>/dev/null; rm -rf "$PROFILE"' EXIT
for _ in $(seq 1 20); do
  curl -s -m 1 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -s -m 1 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1 || { echo "chrome did not come up"; exit 3; }

fail=0; pages=0
for page in "$OUT"/pane-*.html; do
  [ -e "$page" ] || { echo "no pane fixtures rendered"; exit 3; }
  pages=$((pages+1))
  name=$(basename "$page" .html)
  url="file://$(cd "$(dirname "$page")" && pwd)/$(basename "$page")"
  # one measurement per page: the container width is fixed by the fixture, so the viewport only has to be
  # wide enough not to constrain it. Determinism is the point of this bed.
  if STATIC=1 SIZES=1600x1000 CDP_PORT="$PORT" BBOX_OUT="$DUMP/$name" \
       node scripts/plate-containment-sweep.mjs "$url" > "$DUMP/$name.log" 2>&1; then
    printf '  PASS %s\n' "$name"
  else
    printf '  FAIL %s\n' "$name"
    grep -E "ESCAPES|OVERLAP|harness|never mounted" "$DUMP/$name.log" | sed 's/^/       /'
    fail=1
  fi
done

echo
if [ "$fail" -eq 0 ]; then echo "PASS — $pages fixtures, both predicates clean"; else echo "FAIL — see $DUMP"; fi
exit "$fail"
