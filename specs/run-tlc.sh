#!/usr/bin/env bash
# run-tlc.sh -- run TLC on a transport-layer spec (O8 mechanization, WS6).
#
# Usage:
#   specs/run-tlc.sh              # checks RowLane (default)
#   specs/run-tlc.sh RowLane      # explicit spec base name
#   specs/run-tlc.sh DocLane      # the doc-lane spec
#
# Extra args after the spec name are passed through to TLC, e.g.:
#   specs/run-tlc.sh RowLane -coverage 1
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

JAR="specs/tla2tools.jar"
if [ ! -f "$JAR" ]; then
  cat >&2 <<EOF
error: $JAR not found.

Download the TLA+ tools jar:
  1. Go to https://github.com/tlaplus/tlaplus/releases
  2. Download the asset named  tla2tools.jar  from the latest release
     (must be >= 1.6.0: the .cfg files use CHECK_DEADLOCK)
  3. Place it at  $REPO_ROOT/$JAR

Then re-run this script.
EOF
  exit 1
fi

SPEC="${1:-RowLane}"
shift || true

TLA="specs/${SPEC}.tla"
CFG="specs/${SPEC}.cfg"
for f in "$TLA" "$CFG"; do
  if [ ! -f "$f" ]; then
    echo "error: $f not found" >&2
    exit 1
  fi
done

# -deadlock duplicates the cfg's CHECK_DEADLOCK FALSE (harmlessly): the
# deadlock decision stays in force even for a spec whose cfg omits the
# statement.  (A jar < 1.6.0 rejects CHECK_DEADLOCK in the cfg itself --
# hence the minimum version in the download instructions above.)
exec java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC \
  -workers auto -deadlock -config "$CFG" "$TLA" "$@"
