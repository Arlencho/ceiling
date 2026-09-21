#!/usr/bin/env bash
# Ground Truth: a package with tests has a CI job that runs them.
#
# This exists because that was false three separate times and nobody noticed
# any of them until something else went looking:
#
#   app       100 tests, job ran only the typecheck. Found when the suite was
#             finally switched on and failed on the first run, on a real defect
#             that returned the wrong wallet for about one owner in 256.
#   tools     had a test file the hand-written script never named, so CI ran
#             every test except that one.
#   terminal  49 tests and no job at all, from the day it was merged.
#
# A suite nobody runs is worse than no suite, because it is quoted as evidence.
# No network, no cloud, no vendor CLIs.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CI="$ROOT/.github/workflows/ci.yml"

pass=0; fail=0
ok()  { printf 'ok - %s\n' "$1"; pass=$((pass+1)); }
bad() { printf 'not ok - %s\n' "$1"; fail=$((fail+1)); }

[ -f "$CI" ] || { echo "no workflow at $CI" >&2; exit 1; }

for pkg in "$ROOT"/*/package.json; do
    dir=$(dirname "$pkg")
    name=$(basename "$dir")
    [ "$name" = "node_modules" ] && continue

    has_test=$(python3 -c "
import json,sys
try: print('yes' if 'test' in json.load(open(sys.argv[1])).get('scripts',{}) else 'no')
except Exception: print('no')" "$pkg")
    [ "$has_test" = "yes" ] || continue

    # The job must exist, and it must actually run the tests. A job that stops
    # at the typecheck is how app stayed green while never running a test.
    block=$(awk -v p="  $name:" '
        $0 == p {inblock=1; next}
        inblock && /^  [a-zA-Z0-9_-]+:$/ {exit}
        inblock {print}
    ' "$CI")

    if [ -z "$block" ]; then
        bad "$name has a test script but no CI job"
        continue
    fi
    if printf '%s' "$block" | grep -qE "run: (npm test|npm run test)"; then
        ok "$name has a CI job that runs its tests"
    else
        bad "$name has a CI job that never runs its tests"
    fi

    # A hand-written list of test files silently drops the next file added.
    script=$(python3 -c "
import json,sys
print(json.load(open(sys.argv[1]))['scripts']['test'])" "$pkg")
    named=$(printf '%s' "$script" | grep -oE '[A-Za-z0-9_./-]+\.test\.tsx?' | wc -l | tr -d ' ')
    if [ "$named" -gt 1 ]; then
        bad "$name names $named test files by hand; use a glob so a new file cannot be skipped"
    else
        ok "$name selects its tests by pattern rather than by hand"
    fi
done

echo "ci coverage checks: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
