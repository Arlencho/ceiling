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
# gate. For each package directory that has a job, a paths list must admit
# that package and a paths-ignore must not exclude it. Leaving the package
# unchecked on the changes that need checking is the same as switching its
# job off. An ignore glob that matches every path still counts, not only the
# literal **, and so does a paths list that matches no file here. A branches
# list must admit a branch push names. When push names no branch, that name
# is the repository default branch.
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
import os
import re
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


# One ignore pattern that matches every probe matches every path: a root file
# with no dot, a nested source file, and a hidden path. A list of ordinary
# globs does not, so this is not a comparison with the literal **.
_PATH_PROBES = (
    "README.md",
    "Makefile",
    "app/package.json",
    "programs/veto/src/lib.rs",
    "watcher/src/journal.ts",
    ".github/workflows/ci.yml",
    "a/b/c.d",
)
# Samples a push branch glob is expanded against. Not the branch list when
# push names none: that list is the repository default branch. The fourth
# name is a placeholder nobody would write, so a branches filter cannot pass
# by naming a probe.
_BRANCH_PROBES = ("main", "master", "develop", "zz-unwritten-branch-probe", "feature/foo", "release/1")
_SKIP_DIRS = {".git", "node_modules", "target", "dist", ".next", "coverage"}
_glob_cache = {}


def glob_to_regex(pattern: str) -> str:
    """GitHub filter pattern, matched against the whole path or branch.

    * does not cross /, ** crosses /, and **/ may match zero directories so
    **/* covers a root file as well as a nested one. ? and + quantify the
    preceding character, as in the filter cheat sheet.
    """
    out = ["^"]
    i = 0
    while i < len(pattern):
        c = pattern[i]
        if c == "\\" and i + 1 < len(pattern):
            out.append(re.escape(pattern[i + 1]))
            i += 2
            continue
        if c == "*" and i + 1 < len(pattern) and pattern[i + 1] == "*":
            if i + 2 < len(pattern) and pattern[i + 2] == "/":
                out.append("(?:.*/)?")
                i += 3
                continue
            out.append(".*")
            i += 2
            continue
        if c == "*":
            out.append("[^/]*")
            i += 1
            continue
        if c in "?+" and len(out) > 1:
            out.append(c)
            i += 1
            continue
        if c == "[":
            end = pattern.find("]", i + 1)
            body = pattern[i + 1 : end] if end != -1 else ""
            if end != -1 and re.fullmatch(r"[A-Za-z0-9\-]+", body):
                out.append("[" + body + "]")
                i = end + 1
                continue
        out.append(re.escape(c))
        i += 1
    out.append("$")
    return "".join(out)


def glob_match(pattern: str, value: str) -> bool:
    regex = _glob_cache.get(pattern)
    if regex is None:
        try:
            regex = re.compile(glob_to_regex(pattern))
        except re.error:
            return False
        _glob_cache[pattern] = regex
    return regex.fullmatch(value) is not None


def list_matches(patterns, value: str) -> bool:
    """Last matching pattern wins. A leading ! on a pattern excludes."""
    matched = False
    for item in patterns:
        text = item_text(item)
        if text == "":
            continue
        neg = text.startswith("!")
        if glob_match(text[1:] if neg else text, value):
            matched = not neg
    return matched


def repo_paths(workflow_path: str) -> list[str]:
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(workflow_path))))
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name not in _SKIP_DIRS]
        for name in filenames:
            full = os.path.join(dirpath, name)
            found.append(os.path.relpath(full, root).replace(os.sep, "/"))
    return found


def covers_all(patterns, values) -> bool:
    return all(list_matches(patterns, value) for value in values)


def matches_any(patterns, values) -> bool:
    return any(list_matches(patterns, value) for value in values)


def push_branch_names(push) -> list[str]:
    if not isinstance(push, dict) or "branches" not in push:
        return []
    names = []
    for item in as_list(push.get("branches")):
        text = item_text(item)
        if text == "" or text.startswith("!"):
            continue
        if any(ch in text for ch in "*?["):
            matched = [probe for probe in _BRANCH_PROBES if glob_match(text, probe)]
            if matched:
                names.extend(matched)
                continue
            witness = text.replace("**", "a/b").replace("*", "a")
            if glob_match(text, witness):
                names.append(witness)
            continue
        names.append(text)
    return names


def _git_dir(root: str) -> str:
    entry = os.path.join(root, ".git")
    if os.path.isdir(entry):
        return entry
    if not os.path.isfile(entry):
        return ""
    try:
        text = open(entry, encoding="utf-8").read().strip()
    except OSError:
        return ""
    if not text.startswith("gitdir:"):
        return ""
    raw = text.split(":", 1)[1].strip()
    if raw == "":
        return ""
    if not os.path.isabs(raw):
        raw = os.path.normpath(os.path.join(root, raw))
    return raw


def _common_git_dir(git_dir: str) -> str:
    path = os.path.join(git_dir, "commondir")
    if not os.path.isfile(path):
        return git_dir
    try:
        raw = open(path, encoding="utf-8").read().strip()
    except OSError:
        return git_dir
    if raw == "":
        return git_dir
    if not os.path.isabs(raw):
        raw = os.path.normpath(os.path.join(git_dir, raw))
    return raw


def repository_default_branch(workflow_path: str) -> str:
    """Branch a pull request is judged against when push names none.

    A checkout records it in origin/HEAD. A scratch copy of the workflow has
    no .git, and this repository's default branch is main.
    """
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(workflow_path))))
    git_dir = _git_dir(root)
    if git_dir == "":
        return "main"
    common = _common_git_dir(git_dir)
    marker = "ref: refs/remotes/origin/"
    for base in (common, git_dir):
        head = os.path.join(base, "refs", "remotes", "origin", "HEAD")
        try:
            ref = open(head, encoding="utf-8").read().strip()
        except OSError:
            continue
        if ref.startswith(marker):
            name = ref[len(marker):].strip()
            if name != "" and "/" not in name:
                return name
    return "main"


def branch_names_for(push, workflow_path: str) -> list[str]:
    names = push_branch_names(push)
    if names:
        return names
    return [repository_default_branch(workflow_path)]


def one_pattern_matches_every_path(patterns) -> bool:
    for item in patterns:
        text = item_text(item)
        if text == "" or text.startswith("!"):
            continue
        if covers_all([text], _PATH_PROBES):
            return True
    return False


def paths_ignore_blocks(patterns, files) -> bool:
    if one_pattern_matches_every_path(patterns):
        return True
    return bool(files) and covers_all(patterns, files)


def paths_admit(patterns, files) -> bool:
    if matches_any(patterns, files):
        return True
    return not files and covers_all(patterns, _PATH_PROBES)


def any_paths_ignore_blocks(events, files) -> bool:
    for body in events.values():
        if not isinstance(body, dict) or "paths-ignore" not in body:
            continue
        if paths_ignore_blocks(as_list(body.get("paths-ignore")), files):
            return True
    return False


def packages_with_jobs(doc, workflow_path: str) -> list[str]:
    jobs = doc.get("jobs") if isinstance(doc, dict) else None
    if not isinstance(jobs, dict):
        return []
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(workflow_path))))
    found = []
    try:
        entries = os.listdir(root)
    except OSError:
        return []
    for name in entries:
        if name == "node_modules" or name not in jobs:
            continue
        if os.path.isfile(os.path.join(root, name, "package.json")):
            found.append(name)
    found.sort()
    return found


def pull_request_filter_problem(events, files, packages, workflow_path: str) -> str:
    body = events.get("pull_request")
    if not isinstance(body, dict):
        return ""
    names = branch_names_for(events.get("push"), workflow_path)
    if "branches" in body and not matches_any(as_list(body.get("branches")), names):
        return "on: pull_request branches admit no pull request to a branch push names"
    if "branches-ignore" in body and covers_all(as_list(body.get("branches-ignore")), names):
        return "on: pull_request branches-ignore skips every branch push names"
    if "paths" in body:
        patterns = as_list(body.get("paths"))
        if not paths_admit(patterns, files):
            return "on: pull_request paths match no file in the repository"
        for pkg in packages:
            if not list_matches(patterns, pkg + "/package.json"):
                return "on: pull_request paths leave " + pkg + " unchecked"
    if "paths-ignore" in body:
        patterns = as_list(body.get("paths-ignore"))
        for pkg in packages:
            if list_matches(patterns, pkg + "/package.json"):
                return "on: pull_request paths-ignore leaves " + pkg + " unchecked"
    return ""


def trigger_problem(doc, workflow_path: str) -> str:
    if not isinstance(doc, dict) or "on" not in doc:
        return "has no on: block, so it never runs on a pull request"
    on = doc["on"]
    events = event_map(on)
    if "pull_request" not in events and "push" not in events:
        return "on: has neither pull_request nor push, so a pull request never runs the checks"
    files = repo_paths(workflow_path)
    if any_paths_ignore_blocks(events, files):
        return "on: paths-ignore matches every path, so a pull request never runs the checks"
    problem = pull_request_filter_problem(
        events, files, packages_with_jobs(doc, workflow_path), workflow_path
    )
    if problem:
        return problem
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
        problem = trigger_problem(doc, sys.argv[2])
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
