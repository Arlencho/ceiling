#!/usr/bin/env bash
# Ground Truth: a package that defines a check has a CI job that runs that
# npm script, not a similar command the workflow happens to carry.
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
# A fourth time: app's job ran `npx tsc --noEmit` while package.json typecheck
# added tsconfig.test.json. Matching the command CI happened to carry, rather
# than the script the package defines, left the new tsconfig off the gate.
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

# Checks the package itself defines. CI must invoke these npm scripts.
# `test` also accepts the `npm test` alias. A bare `npx tsc --noEmit` does
# not count as the package's typecheck script.
CHECKS="test typecheck"

for pkg in "$ROOT"/*/package.json; do
    dir=$(dirname "$pkg")
    name=$(basename "$dir")
    [ "$name" = "node_modules" ] && continue

    defined=$(python3 -c "
import json,sys
try:
    scripts = json.load(open(sys.argv[1])).get('scripts', {})
except Exception:
    scripts = {}
wanted = sys.argv[2].split()
print(' '.join(s for s in wanted if s in scripts))
" "$pkg" "$CHECKS")
    [ -n "$defined" ] || continue

    # The job must exist, and it must actually run the scripts the package
    # defines. A job that stops at a bare tsc is how app stayed green while
    # never typechecking the test files.
    block=$(awk -v p="  $name:" '
        $0 == p {inblock=1; next}
        inblock && /^  [a-zA-Z0-9_-]+:$/ {exit}
        inblock {print}
    ' "$CI")

    if [ -z "$block" ]; then
        bad "$name defines check script(s) ($defined) but has no CI job"
        continue
    fi

    for check in $defined; do
        # A live step: a list item whose `run` is exactly the package script,
        # not a comment, not `|| true`, not gated by `if:` / `continue-on-error:`,
        # and not pointed at another package via working-directory.
        if python3 - "$check" "$name" "$block" <<'PY'
import sys

check, pkg, block = sys.argv[1], sys.argv[2], sys.argv[3]
commands = ["npm test", "npm run test"] if check == "test" else [f"npm run {check}"]


def strip_quotes(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1].strip()
    return value


def parse_steps(text: str):
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        if lines[i].lstrip().startswith("steps:"):
            i += 1
            break
        i += 1
    else:
        return []
    steps = []
    current = None
    step_indent = None
    while i < len(lines):
        line = lines[i]
        i += 1
        if not line.strip():
            continue
        stripped = line.lstrip()
        indent = len(line) - len(stripped)
        if stripped.startswith("#"):
            continue
        if stripped.startswith("- "):
            current = {}
            steps.append(current)
            step_indent = indent
            rest = stripped[2:]
            if ":" in rest:
                key, _, value = rest.partition(":")
                current[key.strip()] = strip_quotes(value)
            continue
        if current is not None and step_indent is not None and indent > step_indent:
            if ":" in stripped:
                key, _, value = stripped.partition(":")
                current[key.strip()] = strip_quotes(value)
            continue
        break
    return steps


def working_directory_is_this_package(wd):
    if not wd:
        return True
    last = wd.rstrip("/").split("/")[-1]
    return last == pkg


for step in parse_steps(block):
    run = step.get("run", "")
    if run not in commands:
        continue
    if "if" in step or "continue-on-error" in step:
        continue
    if not working_directory_is_this_package(step.get("working-directory")):
        continue
    sys.exit(0)
sys.exit(1)
PY
        then
            ok "$name CI job runs the package's $check script"
        else
            bad "$name CI job does not run the package's $check script (a command CI happens to carry is not scripts.$check)"
        fi
    done

    case " $defined " in
        *" test "*) ;;
        *) continue ;;
    esac
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
