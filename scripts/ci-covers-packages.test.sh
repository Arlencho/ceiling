#!/usr/bin/env bash
# Ground Truth: a package that defines a check has a CI job that runs that
# npm script, and the job is not switched off above the step.
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
# A fourth time: app's job ran `npx tsc --noEmit` while the package script is
# `npm run typecheck`. Matching a command CI happened to carry, rather than
# the script the package defines, leaves a later change to that script off
# the gate.
#
# The step can also stay perfect while the job or the workflow never runs it:
# a job `if:`, `continue-on-error:`, or `needs:` of a skipped job, a default
# working directory pointed at another package, a `shell:` that discards the
# script, or an `on:` that is not a pull request or a push.
#
# A suite nobody runs is worse than no suite, because it is quoted as evidence.
# No network, no cloud, no vendor CLIs. Python stdlib only.
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

if reason=$(python3 - "$CI" <<'PY'
import re
import sys

text = open(sys.argv[1]).read()
lines = text.splitlines()
start = None
for i, line in enumerate(lines):
    if line == "on:" or line.startswith("on:"):
        start = i
        break
if start is None:
    print("has no on: block, so it never runs on a pull request")
    sys.exit(1)
block = []
for line in lines[start + 1 :]:
    if line and not line[0].isspace() and not line.startswith("#"):
        break
    block.append(line)
body = "\n".join(block)
has_pr = any(re.match(r"  pull_request\s*:", line) for line in block)
has_push = any(re.match(r"  push\s*:", line) for line in block)
if not has_pr and not has_push:
    print("on: has neither pull_request nor push, so a pull request never runs the checks")
    sys.exit(1)
if re.search(r"paths-ignore:.*\*\*", body):
    print("on: paths-ignore ** skips every pull request path")
    sys.exit(1)
sys.exit(0)
PY
); then
  ok "workflow runs on pull_request or push"
else
  bad "workflow ${reason}"
fi

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
    # defines. Keys on the job itself count: a step that is present but
    # sitting in a skipped job is not a check.
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
        if reason=$(python3 - "$check" "$name" "$block" <<'PY'
import sys

check, pkg, block = sys.argv[1], sys.argv[2], sys.argv[3]
commands = ["npm test", "npm run test"] if check == "test" else [f"npm run {check}"]


def strip_quotes(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1].strip()
    return value


def job_keys(text: str):
    lines = text.split("\n")
    keys = {}
    stack = []
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        stripped = line.lstrip()
        if stripped.startswith("steps:"):
            break
        indent = len(line) - len(stripped)
        if ":" not in stripped:
            continue
        key, _, value = stripped.partition(":")
        key = key.strip()
        while stack and stack[-1][0] >= indent:
            stack.pop()
        path = tuple(k for _, k in stack) + (key,)
        keys[path] = strip_quotes(value)
        stack.append((indent, key))
    return keys


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


def last_segment(wd: str) -> str:
    return wd.rstrip("/").split("/")[-1]


keys = job_keys(block)
problems = []
if ("if",) in keys:
    problems.append("if")
if ("continue-on-error",) in keys:
    problems.append("continue-on-error")
if ("needs",) in keys:
    problems.append("needs")
if problems:
    print("job " + ", ".join(problems) + " disables the check before the step runs")
    sys.exit(1)

default_wd = keys.get(("defaults", "run", "working-directory"), "")
disabled = []
for step in parse_steps(block):
    run = step.get("run", "")
    if run not in commands:
        continue
    if "shell" in step:
        disabled.append("shell")
        continue
    if "if" in step or "continue-on-error" in step:
        disabled.append("step if or continue-on-error")
        continue
    wd = step.get("working-directory") or default_wd
    if last_segment(wd) != pkg:
        disabled.append("working-directory " + (wd or "repo root"))
        continue
    sys.exit(0)

if disabled:
    print("the package script is present but not run (" + ", ".join(disabled) + ")")
else:
    print("a command CI happens to carry is not scripts." + check)
sys.exit(1)
PY
        ); then
            ok "$name CI job runs the package's $check script"
        else
            bad "$name CI job does not run the package's $check script (${reason})"
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
