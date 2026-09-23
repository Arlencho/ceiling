#!/usr/bin/env bash
# Prove a check job's tests ran.
#
# Usage: ci-assert-test-count.sh <name> <logfile> [floors-file]
#
# The floors file committed at scripts/ci-test-floors.txt names each check,
# the runner that produced the log, and the minimum count. This exits 1 when
# the log is missing, the runner summary is missing, the count is zero, or
# the count is below that floor. A third argument selects another floors
# file. The workflow step does not pass one: the committed file is the floor.
#
# node:  "# tests N" (tap) or the spec reporter's tests line. Several
#        summaries in one log are added.
# cargo: passed plus failed, summed across every "test result:" line.
#        Ignored tests did not run, so they are not part of the count.
# shell: lines that start with "ok - " (make test-scripts).
set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: ci-assert-test-count.sh <name> <logfile> [floors-file]" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="$1"
LOG="$2"
FLOORS="${3:-$ROOT/scripts/ci-test-floors.txt}"

exec python3 - "$NAME" "$LOG" "$FLOORS" <<'PY'
import re
import sys

ANSI = re.compile(r"\x1b\[[0-9;]*m")
NODE_SUMMARY = re.compile("(?m)^(?:\u2139\ufe0f?|#) tests (\\d+)\\s*$")
CARGO_SUMMARY = re.compile(
    r"test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured;"
)


def clean(text: str) -> str:
    return ANSI.sub("", text).replace("\r\n", "\n").replace("\r", "\n")


def parse_node(text: str):
    nums = [int(n) for n in NODE_SUMMARY.findall(clean(text))]
    if not nums:
        return 0, False
    return sum(nums), True


def parse_cargo(text: str):
    rows = CARGO_SUMMARY.findall(clean(text))
    if not rows:
        return 0, False
    total = 0
    for passed, failed, _ignored, _measured in rows:
        total += int(passed) + int(failed)
    return total, True


def parse_shell(text: str):
    count = 0
    for line in clean(text).splitlines():
        if line.startswith("ok - "):
            count += 1
    if count == 0:
        return 0, False
    return count, True


PARSERS = {"node": parse_node, "cargo": parse_cargo, "shell": parse_shell}


def load_floors(path: str):
    try:
        raw_lines = open(path, encoding="utf-8").read().splitlines()
    except OSError as exc:
        sys.exit("cannot read floors file: " + str(exc))
    floors = {}
    runners = {}
    for raw in raw_lines:
        line = raw.split("#", 1)[0].strip()
        if line == "":
            continue
        parts = line.split()
        if len(parts) != 3:
            sys.exit("bad floor line: " + raw.strip())
        name, runner, floor = parts
        if runner not in PARSERS:
            sys.exit("bad runner on floor line: " + raw.strip())
        if not floor.isdigit() or int(floor) < 1:
            sys.exit("floor must be a positive integer: " + raw.strip())
        if name in floors:
            sys.exit("duplicate floor: " + name)
        floors[name] = int(floor)
        runners[name] = runner
    return floors, runners


def main():
    name, log_path, floors_path = sys.argv[1], sys.argv[2], sys.argv[3]
    floors, runners = load_floors(floors_path)
    if name not in floors:
        sys.exit(name + ": no floor committed")
    floor = floors[name]
    try:
        text = open(log_path, encoding="utf-8", errors="replace").read()
    except OSError:
        text = ""
        found = False
        count = 0
    else:
        count, found = PARSERS[runners[name]](text)
    if count <= 0 or count < floor:
        extra = "" if found else " (no test summary in the log)"
        sys.exit(name + ": " + str(count) + " tests is below the floor " + str(floor) + extra)
    print(name + ": " + str(count) + " tests (floor " + str(floor) + ")")


main()
PY
