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
# Those keys are read from the workflow as a structure. Key order does not
# matter, a quoted key is the same key, and a nested key is not the step's
# own key. A pull_request types list that never runs during review does not
# gate, and paths-ignore ** counts when it is a list item on the next line.
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

ci_py() {
    python3 - "$@" <<'PY'
import sys

# The workflow is a mapping, not a sequence of lines. A key after steps:,
# a quoted key, a block list, and a key nested under another key are all
# visible here. Python stdlib only: the scripts job does not install PyYAML.
def strip_comment(line: str) -> str:
    out = []
    quote = None
    i = 0
    while i < len(line):
        c = line[i]
        if quote:
            out.append(c)
            if c == quote and line[i - 1] != "\\":
                quote = None
            i += 1
            continue
        if c in "\"'":
            quote = c
            out.append(c)
            i += 1
            continue
        if c == "#" and (i == 0 or line[i - 1].isspace()):
            break
        out.append(c)
        i += 1
    return "".join(out).rstrip()


def content_indent(line: str) -> int:
    i = 0
    while i < len(line) and line[i] == " ":
        i += 1
    return i


def decode_quoted(s: str) -> str:
    q = s[0]
    body = s[1:-1]
    if q == "'":
        return body.replace("''", "'")
    out = []
    i = 0
    while i < len(body):
        if body[i] == "\\" and i + 1 < len(body):
            n = body[i + 1]
            mapping = {"n": "\n", "t": "\t", "r": "\r", "\\": "\\", '"': '"', "/": "/"}
            if n in mapping:
                out.append(mapping[n])
                i += 2
                continue
            if n == "u" and i + 6 <= len(body):
                out.append(chr(int(body[i + 2 : i + 6], 16)))
                i += 6
                continue
        out.append(body[i])
        i += 1
    return "".join(out)


def unquote(s: str) -> str:
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'":
        return decode_quoted(s)
    return s


def try_split_key(content: str):
    quote = None
    i = 0
    while i < len(content):
        c = content[i]
        if quote:
            if c == quote and content[i - 1] != "\\":
                quote = None
            i += 1
            continue
        if c in "\"'":
            quote = c
            i += 1
            continue
        if c == ":" and (i + 1 == len(content) or content[i + 1].isspace()):
            key = content[:i].strip()
            val = content[i + 1 :].strip()
            if key == "":
                return None
            return key, val
        i += 1
    return None


def is_block_header(raw: str) -> bool:
    if not raw or raw[0] not in "|>":
        return False
    rest = raw[1:].replace("+", "").replace("-", "")
    return rest == "" or rest.isdigit()


def split_flow(s: str):
    parts = []
    buf = []
    depth = 0
    quote = None
    i = 0
    while i < len(s):
        c = s[i]
        if quote:
            buf.append(c)
            if c == quote and s[i - 1] != "\\":
                quote = None
            i += 1
            continue
        if c in "\"'":
            quote = c
            buf.append(c)
            i += 1
            continue
        if c in "[{":
            depth += 1
            buf.append(c)
            i += 1
            continue
        if c in "]}":
            depth -= 1
            buf.append(c)
            i += 1
            continue
        if c == "," and depth == 0:
            parts.append("".join(buf).strip())
            buf = []
            i += 1
            continue
        buf.append(c)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        parts.append(tail)
    return parts


def parse_scalar(raw: str):
    s = raw.strip()
    if s == "" or s in {"null", "Null", "NULL", "~"}:
        return None
    if s in {"true", "True", "TRUE"}:
        return True
    if s in {"false", "False", "FALSE"}:
        return False
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'":
        return decode_quoted(s)
    if s.startswith("[") and s.endswith("]"):
        return parse_flow_seq(s)
    if s.startswith("{") and s.endswith("}"):
        return parse_flow_map(s)
    return s


def parse_flow_seq(s: str):
    inner = s.strip()[1:-1].strip()
    if not inner:
        return []
    return [parse_scalar(part) for part in split_flow(inner)]


def parse_flow_map(s: str):
    inner = s.strip()[1:-1].strip()
    node = {}
    if not inner:
        return node
    for part in split_flow(inner):
        split = try_split_key(part)
        if split is None:
            continue
        key, val = split
        node[unquote(key)] = parse_scalar(val) if val else None
    return node


def next_meaningful(lines, i):
    while i < len(lines):
        content = strip_comment(lines[i]).strip()
        if content == "" or content == "---" or content == "...":
            i += 1
            continue
        return i, content_indent(lines[i]), content
    return None


def read_block(lines, i, parent_indent):
    chunks = []
    while i < len(lines):
        line = lines[i]
        if line.strip() == "":
            chunks.append("")
            i += 1
            continue
        ind = content_indent(line)
        if ind <= parent_indent:
            break
        chunks.append(line[ind:])
        i += 1
    while chunks and chunks[-1] == "":
        chunks.pop()
    return "\n".join(chunks), i


def parse_node(lines, i, parent_indent):
    found = next_meaningful(lines, i)
    if found is None:
        return None, i
    j, ind, content = found
    if ind <= parent_indent:
        return None, i
    if content == "-" or content.startswith("- "):
        return parse_seq(lines, j, ind)
    return parse_map(lines, j, ind)


def parse_map(lines, i, map_indent):
    node = {}
    while True:
        found = next_meaningful(lines, i)
        if found is None:
            break
        j, ind, content = found
        if ind != map_indent or content == "-" or content.startswith("- "):
            break
        split = try_split_key(content)
        if split is None:
            break
        key, raw_val = split
        i = j + 1
        key = unquote(key)
        if is_block_header(raw_val):
            scalar, i = read_block(lines, i, map_indent)
            node[key] = scalar
        elif raw_val == "":
            nested, i = parse_node(lines, i, map_indent)
            node[key] = nested
        else:
            node[key] = parse_scalar(raw_val)
    return node, i


def key_column(line: str, key: str) -> int:
    stripped = strip_comment(line)
    idx = stripped.find(key)
    if idx < 0:
        raise ValueError("key not on line: " + key)
    return idx


def parse_seq(lines, i, seq_indent):
    items = []
    while True:
        found = next_meaningful(lines, i)
        if found is None:
            break
        j, ind, content = found
        if ind != seq_indent or not (content == "-" or content.startswith("- ")):
            break
        rest = content[1:].strip()
        i = j + 1
        if rest == "":
            nested, i = parse_node(lines, i, seq_indent)
            items.append(nested)
            continue
        split = try_split_key(rest)
        if split is None:
            items.append(parse_scalar(rest))
            continue
        key, raw_val = split
        col = key_column(lines[j], key)
        item = {}
        if is_block_header(raw_val):
            scalar, i = read_block(lines, i, col)
            item[unquote(key)] = scalar
        elif raw_val == "":
            nested, i = parse_node(lines, i, col)
            item[unquote(key)] = nested
        else:
            item[unquote(key)] = parse_scalar(raw_val)
        extra, i = parse_map(lines, i, col)
        item.update(extra)
        items.append(item)
    return items, i


def parse_document(text: str):
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    node, _ = parse_node(lines, 0, -1)
    return node


GATE_TYPES = {"opened", "synchronize", "reopened", "ready_for_review"}


def as_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def item_text(value) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, bool) or value is None:
        return ""
    return str(value).strip()


def event_map(on):
    if isinstance(on, dict):
        return on
    if isinstance(on, list):
        return {item_text(item): None for item in on}
    if isinstance(on, str):
        return {on: None}
    return {}


def pull_request_gates(on) -> bool:
    events = event_map(on)
    if "pull_request" not in events:
        return False
    body = events["pull_request"]
    if not isinstance(body, dict):
        return True
    if "types" not in body:
        return True
    types = [item_text(item).lower() for item in as_list(body.get("types"))]
    return any(t in GATE_TYPES for t in types)


def paths_ignore_all(on) -> bool:
    for body in event_map(on).values():
        if not isinstance(body, dict) or "paths-ignore" not in body:
            continue
        for item in as_list(body.get("paths-ignore")):
            if item_text(item) == "**":
                return True
    return False


def trigger_problem(doc) -> str:
    if not isinstance(doc, dict) or "on" not in doc:
        return "has no on: block, so it never runs on a pull request"
    on = doc["on"]
    events = event_map(on)
    if "pull_request" not in events and "push" not in events:
        return "on: has neither pull_request nor push, so a pull request never runs the checks"
    if paths_ignore_all(on):
        return "on: paths-ignore ** skips every pull request path"
    if "pull_request" in events and not pull_request_gates(on):
        return "on: pull_request types do not include a review event, so a pull request is not gated"
    return ""


def last_segment(wd: str) -> str:
    return wd.rstrip("/").split("/")[-1]


def job_problem(job, pkg: str, check: str) -> str:
    commands = ["npm test", "npm run test"] if check == "test" else [f"npm run {check}"]
    if not isinstance(job, dict):
        return "job is not a mapping"
    problems = [key for key in ("if", "continue-on-error", "needs") if key in job]
    if problems:
        return "job " + ", ".join(problems) + " disables the check before the step runs"
    default_wd = ""
    defaults = job.get("defaults")
    if isinstance(defaults, dict):
        run_defaults = defaults.get("run")
        if isinstance(run_defaults, dict) and run_defaults.get("working-directory"):
            default_wd = item_text(run_defaults.get("working-directory"))
    disabled = []
    steps = job.get("steps")
    if not isinstance(steps, list):
        steps = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        run = step.get("run")
        if not isinstance(run, str):
            continue
        if run.strip() not in commands:
            continue
        if "shell" in step:
            disabled.append("shell")
            continue
        if "if" in step or "continue-on-error" in step:
            disabled.append("step if or continue-on-error")
            continue
        wd = item_text(step.get("working-directory")) if "working-directory" in step else default_wd
        if last_segment(wd) != pkg:
            disabled.append("working-directory " + (wd or "repo root"))
            continue
        return ""
    if disabled:
        return "the package script is present but not run (" + ", ".join(disabled) + ")"
    return "a command CI happens to carry is not scripts." + check


def main():
    mode = sys.argv[1]
    if mode == "trigger":
        doc = parse_document(open(sys.argv[2]).read())
        problem = trigger_problem(doc)
        if problem:
            print(problem)
            sys.exit(1)
        sys.exit(0)
    if mode == "has-job":
        doc = parse_document(open(sys.argv[2]).read())
        jobs = doc.get("jobs") if isinstance(doc, dict) else None
        pkg = sys.argv[3]
        if not isinstance(jobs, dict) or pkg not in jobs:
            sys.exit(1)
        sys.exit(0)
    if mode == "check":
        doc = parse_document(open(sys.argv[2]).read())
        jobs = doc.get("jobs") if isinstance(doc, dict) else None
        pkg, check = sys.argv[3], sys.argv[4]
        job = jobs.get(pkg) if isinstance(jobs, dict) else None
        problem = job_problem(job, pkg, check)
        if problem:
            print(problem)
            sys.exit(1)
        sys.exit(0)
    sys.exit("unknown mode " + mode)

main()
PY
}

if reason=$(ci_py trigger "$CI"); then
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
    # defines. Keys on the job itself count wherever they sit: a step that
    # is present but sitting in a skipped job is not a check.
    if ! ci_py has-job "$CI" "$name" >/dev/null 2>&1; then
        bad "$name defines check script(s) ($defined) but has no CI job"
        continue
    fi

    for check in $defined; do
        if reason=$(ci_py check "$CI" "$name" "$check"); then
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
