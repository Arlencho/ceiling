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
# script, or an `on:` that does not run on pull_request.
#
# Those keys are read from the workflow as a structure. Key order does not
# matter, a quoted key is the same key, and a nested key is not the step's
# own key. A pull_request types list that never runs during review does not
# gate. The workflow that carries those checks may not declare a paths or
# paths-ignore filter on any trigger. A filter that admits one witness file
# and excludes the sources leaves the package unchecked, and the next witness
# can be excluded the same way, so the guard does not read the globs. A
# branches list must admit a branch push names. When push names no branch,
# that name is the repository default branch. The placeholder a push glob
# expands to is not a branch that list may name.
#
# The guard refuses a construct that can stop a check. It does not decide
# whether that construct actually stops one. push without pull_request does
# not gate review. pull_request_target in place of pull_request runs the base
# branch and still paints the pull request green. A YAML anchor or alias on
# the trigger body is refused, because the guard would be reading a different
# trigger from the one that runs. A push branches list, or a push
# branches-ignore list, that skips the default branch skips the merge push.
#
# defaults.run.shell at workflow or job level is refused whatever the string
# says. So is any env key whose name starts with npm_config_, in any case, at
# those same levels, and on the step that runs the check. A committed .npmrc
# anywhere in the tree that sets script-shell is the same switch outside the
# workflow file. A strategy key on a check job is refused too, because that
# key can stop the job before a step runs.
#
# The program is not a package.json package. A job must run `make test` from
# the repo root, not switched off, and not behind a paths filter. The job
# that runs `make test-scripts` is held to that same rule: it must exist, it
# must not be switched off, and a paths filter must not skip it. Both jobs
# capture the runner output, and the immediately following step asserts the
# count floor.
#
# Reach of this guard ends at the workflow file as written and the .npmrc
# files the tree commits. A step that writes npm_config_script_shell into
# GITHUB_ENV, a step that writes .npmrc, a composite action, and a container
# image all change the run after this file has been read. The guard does not
# see them.
#
# The test-count floor proves the runner printed a summary at or above the
# floor committed for that package in scripts/ci-test-floors.txt, not that
# the summary is genuine. A controlled script-shell, a rewritten log, or a
# container npm that prints a summary defeats it. That forged-summary case is
# the accepted risk under issue 108. Each check job's test step is
# `set -o pipefail` and the test command piped to tee. The step immediately
# after it runs scripts/ci-assert-test-count.sh on that log and fails if the
# parsed count is zero or below the floor. The program and scripts jobs use
# the same floor.
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
import subprocess
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


# Samples a push branch glob is expanded against. Not the branch list when
# push names none: that list is the repository default branch. The fourth
# name is a placeholder nobody would write. A pull_request branches list is
# judged without it, so a push glob cannot satisfy that filter by landing on
# the placeholder. A branches-ignore list is still judged against the full
# expansion, placeholder included.
_BRANCH_PLACEHOLDER = "zz-unwritten-branch-probe"
_BRANCH_PROBES = ("main", "master", "develop", _BRANCH_PLACEHOLDER, "feature/foo", "release/1")
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


def pull_request_filter_problem(events, workflow_path: str) -> str:
    body = events.get("pull_request")
    if not isinstance(body, dict):
        return ""
    names = branch_names_for(events.get("push"), workflow_path)
    # A push glob expands onto the placeholder. That name is not a branch a
    # pull_request branches list may cite. branches-ignore still uses the
    # full list, placeholder included.
    admitted = [name for name in names if name != _BRANCH_PLACEHOLDER]
    if "branches" in body and not matches_any(as_list(body.get("branches")), admitted):
        return "on: pull_request branches admit no pull request to a branch push names"
    if "branches-ignore" in body and covers_all(as_list(body.get("branches-ignore")), names):
        return "on: pull_request branches-ignore skips every branch push names"
    return ""


def path_filter_problem(events) -> str:
    """Refuse a paths filter outright. Do not match the glob.

    Any list, on any trigger, decides which files run the checks. A narrow
    list and a list of everything are the same kind of gate, and the checks
    in this repository are not gated that way.
    """
    for name, body in events.items():
        if not isinstance(body, dict):
            continue
        if "paths" in body or "paths-ignore" in body:
            return "on: " + name + " declares a paths filter, so a file change can skip the checks"
    return ""


def is_root_on_line(line: str) -> bool:
    if line.startswith(" ") or line.startswith("\t"):
        return False
    content = strip_comment(line).strip()
    if content == "":
        return False
    split = try_split_key(content)
    if split is None:
        return False
    key, _val = split
    return unquote(key) == "on"


def on_block_text(text: str) -> str:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    chunks = []
    i = 0
    while i < len(lines):
        if not is_root_on_line(lines[i]):
            i += 1
            continue
        start = i
        i += 1
        while i < len(lines):
            raw = lines[i]
            if raw.strip() == "":
                i += 1
                continue
            if content_indent(raw) == 0:
                break
            i += 1
        chunks.append("\n".join(lines[start:i]))
    return "\n".join(chunks)


def has_yaml_anchor_or_alias(text: str) -> bool:
    """An unquoted &name anchor or *name alias. Quoted globs are not aliases."""
    quote = None
    i = 0
    while i < len(text):
        c = text[i]
        if quote:
            if c == quote and text[i - 1] != "\\":
                quote = None
            i += 1
            continue
        if c in "\"'":
            quote = c
            i += 1
            continue
        if c == "#" and (i == 0 or text[i - 1].isspace()):
            nl = text.find("\n", i)
            if nl < 0:
                break
            i = nl + 1
            continue
        if c in "&*" and (i == 0 or text[i - 1] in " \t\n\r:[{,"):
            nxt = text[i + 1] if i + 1 < len(text) else ""
            if nxt.isalpha() or nxt == "_":
                return True
        i += 1
    return False


def trigger_anchor_problem(text: str) -> str:
    block = on_block_text(text)
    if block and has_yaml_anchor_or_alias(block):
        return "on: uses a YAML anchor or alias, so the trigger that runs is not the one the guard reads"
    return ""


def push_branch_filter_problem(events, workflow_path: str) -> str:
    """Refuse a push filter that skips the default branch.

    Absent branches means every branch, which is not a skip. A list that is
    present and does not admit the default branch skips the merge push.
    """
    push = events.get("push")
    if not isinstance(push, dict):
        return ""
    default = repository_default_branch(workflow_path)
    if "branches" in push and not list_matches(as_list(push.get("branches")), default):
        return "on: push branches skip " + default + ", so the merge push does not run the checks"
    if "branches-ignore" in push and list_matches(as_list(push.get("branches-ignore")), default):
        return "on: push branches-ignore skips " + default + ", so the merge push does not run the checks"
    return ""


def trigger_problem(doc, workflow_path: str, text: str) -> str:
    anchored = trigger_anchor_problem(text)
    if anchored:
        return anchored
    if not isinstance(doc, dict) or "on" not in doc:
        return "has no on: block, so it never runs on a pull request"
    on = doc["on"]
    events = event_map(on)
    if "pull_request" not in events:
        if "pull_request_target" in events:
            return "on: pull_request_target stands in for pull_request, so review runs the base branch"
        if "push" in events:
            return "on: push without pull_request, so a pull request never runs the checks"
        return "on: has neither pull_request nor push, so a pull request never runs the checks"
    filtered = path_filter_problem(events)
    if filtered:
        return filtered
    problem = pull_request_filter_problem(events, workflow_path)
    if problem:
        return problem
    pushed = push_branch_filter_problem(events, workflow_path)
    if pushed:
        return pushed
    if not pull_request_gates(on):
        return "on: pull_request types do not include a review event, so a pull request is not gated"
    return ""


def last_segment(wd: str) -> str:
    return wd.rstrip("/").split("/")[-1]


def run_defaults_of(node):
    if not isinstance(node, dict):
        return {}
    defaults = node.get("defaults")
    if not isinstance(defaults, dict):
        return {}
    run = defaults.get("run")
    if not isinstance(run, dict):
        return {}
    return run


def npm_config_keys(env):
    if not isinstance(env, dict):
        return []
    found = []
    for key in env:
        if isinstance(key, str) and key.lower().startswith("npm_config_"):
            found.append(key)
    found.sort()
    return found


def blocking_surface(node) -> str:
    """defaults.run.shell or an npm_config_ env key. The value is not read."""
    if not isinstance(node, dict):
        return ""
    if "shell" in run_defaults_of(node):
        return "defaults.run.shell can stop the script from executing"
    keys = npm_config_keys(node.get("env"))
    if keys:
        return "env " + ", ".join(keys) + " can stop the script from executing"
    return ""


def is_repo_root(wd: str) -> bool:
    text = wd.strip()
    while text.endswith("/"):
        text = text[:-1]
    return text in {"", "."}


def effective_workdir(doc, job, step) -> str:
    wd = ""
    wf = run_defaults_of(doc)
    if "working-directory" in wf:
        wd = item_text(wf.get("working-directory"))
    job_run = run_defaults_of(job)
    if "working-directory" in job_run:
        wd = item_text(job_run.get("working-directory"))
    if isinstance(step, dict) and "working-directory" in step:
        wd = item_text(step.get("working-directory"))
    return wd


# The test step that proves a count is two lines: pipefail, then the test
# command piped to tee. The immediately following step is the assert script,
# the check name, and the same quoted log path. A step in that slot can
# rewrite the captured log, so the guard refuses it and names the job.
# Exact `npm test` or `make test` with no tee does not prove the runner
# produced a count.
CAPTURED_RUN = re.compile(
    r'^set -o pipefail\n([^\n]+) 2>&1 \| tee ("[^"\n]+")\s*$'
)
PROOF_RUN = re.compile(
    r'^bash "\$GITHUB_WORKSPACE/scripts/ci-assert-test-count\.sh" '
    r'([A-Za-z0-9_-]+) ("[^"\n]+")\s*$'
)


def captured_run(step):
    if not isinstance(step, dict):
        return None
    run = step.get("run")
    if not isinstance(run, str):
        return None
    match = CAPTURED_RUN.match(run.strip())
    if match is None:
        return None
    return match.group(1), match.group(2)


def bare_run(step, command: str) -> bool:
    if not isinstance(step, dict):
        return False
    run = step.get("run")
    return isinstance(run, str) and run.strip() == command


def proof_after(steps, name: str, log_path: str, after: int, job: str) -> str:
    """The count proof is steps[after + 1]. Anything else there can rewrite the log."""
    nxt = after + 1
    if nxt >= len(steps):
        return job + ": no step asserts the test count from the captured runner output"
    step = steps[nxt]
    if not isinstance(step, dict):
        return job + ": a step between the capture and the count proof can rewrite the log"
    run = step.get("run")
    match = PROOF_RUN.match(run.strip()) if isinstance(run, str) else None
    if match is None or match.group(1) != name or match.group(2) != log_path:
        return job + ": a step between the capture and the count proof can rewrite the log"
    if "shell" in step or "if" in step or "continue-on-error" in step:
        return job + ": the test-count step is switched off"
    return ""


def test_step_problem(job, pkg: str, default_wd: str) -> str:
    commands = ("npm test", "npm run test")
    steps = job.get("steps")
    if not isinstance(steps, list):
        steps = []
    disabled = []
    bare_live = False
    for index, step in enumerate(steps):
        if not isinstance(step, dict):
            continue
        captured = captured_run(step)
        bare = any(bare_run(step, command) for command in commands)
        if captured is None and not bare:
            continue
        if captured is not None and captured[0] not in commands:
            continue
        if "shell" in step:
            disabled.append("shell")
            continue
        step_env = npm_config_keys(step.get("env"))
        if step_env:
            disabled.append("env " + ", ".join(step_env))
            continue
        if "if" in step or "continue-on-error" in step:
            disabled.append("step if or continue-on-error")
            continue
        wd = item_text(step.get("working-directory")) if "working-directory" in step else default_wd
        if last_segment(wd) != pkg:
            disabled.append("working-directory " + (wd or "repo root"))
            continue
        if captured is None:
            bare_live = True
            continue
        proof = proof_after(steps, pkg, captured[1], index, pkg)
        if proof:
            return proof
        return ""
    if bare_live:
        return "the test step does not capture runner output for the count floor"
    if disabled:
        return "the package script is present but not run (" + ", ".join(disabled) + ")"
    return "a command CI happens to carry is not scripts.test"


def job_problem(job, pkg: str, check: str, doc=None) -> str:
    commands = ["npm test", "npm run test"] if check == "test" else [f"npm run {check}"]
    if not isinstance(job, dict):
        return "job is not a mapping"
    problems = [key for key in ("if", "continue-on-error", "needs", "strategy") if key in job]
    if problems:
        return "job " + ", ".join(problems) + " disables the check before the step runs"
    surface = blocking_surface(doc) or blocking_surface(job)
    if surface:
        return surface
    default_wd = ""
    defaults = job.get("defaults")
    if isinstance(defaults, dict):
        run_defaults = defaults.get("run")
        if isinstance(run_defaults, dict) and run_defaults.get("working-directory"):
            default_wd = item_text(run_defaults.get("working-directory"))
    if check == "test":
        return test_step_problem(job, pkg, default_wd)
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
        step_env = npm_config_keys(step.get("env"))
        if step_env:
            disabled.append("env " + ", ".join(step_env))
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


def repo_root_command_problem(doc, command: str, floor_name: str) -> str:
    """A live repo-root step that runs command and then proves the count.

    The same rule covers `make test` and `make test-scripts`: the job must
    exist, must not be switched off, must not sit behind a paths filter,
    and the immediately following step must assert the committed floor from
    the captured runner output.
    """
    if not isinstance(doc, dict):
        return "workflow is not a mapping, so " + command + " never runs"
    events = event_map(doc.get("on")) if "on" in doc else {}
    filtered = path_filter_problem(events)
    if filtered:
        return "not admitted by every change (" + filtered + ")"
    jobs = doc.get("jobs")
    if not isinstance(jobs, dict):
        return "no job runs " + command + " from the repo root"
    wf = blocking_surface(doc)
    reasons = []
    bare_live = False
    for name, job in jobs.items():
        if not isinstance(job, dict):
            continue
        steps = job.get("steps")
        if not isinstance(steps, list):
            continue
        for index, step in enumerate(steps):
            captured = captured_run(step)
            is_bare = bare_run(step, command)
            if captured is None and not is_bare:
                continue
            if captured is not None and captured[0] != command:
                continue
            label = name if isinstance(name, str) else "job"
            if wf:
                reasons.append(label + " " + wf)
                continue
            switched = [key for key in ("if", "continue-on-error", "needs", "strategy") if key in job]
            if switched:
                reasons.append(
                    label + " job " + ", ".join(switched) + " disables the check before the step runs"
                )
                continue
            job_surface = blocking_surface(job)
            if job_surface:
                reasons.append(label + " " + job_surface)
                continue
            step_bits = []
            if "shell" in step:
                step_bits.append("shell")
            if "if" in step or "continue-on-error" in step:
                step_bits.append("if or continue-on-error")
            step_keys = npm_config_keys(step.get("env"))
            if step_keys:
                step_bits.append("env " + ", ".join(step_keys))
            if step_bits:
                reasons.append(label + " step " + ", ".join(step_bits) + " can stop " + command)
                continue
            wd = effective_workdir(doc, job, step)
            if not is_repo_root(wd):
                reasons.append(label + " working-directory " + (wd or "empty") + " is not the repo root")
                continue
            if captured is None:
                bare_live = True
                continue
            proof = proof_after(steps, floor_name, captured[1], index, label)
            if proof:
                reasons.append(proof)
                continue
            return ""
    if reasons:
        return command + " is present but not a live repo-root check (" + "; ".join(reasons) + ")"
    if bare_live:
        return command + " does not capture runner output for the count floor"
    return "no job runs " + command + " from the repo root"


def program_job_problem(doc) -> str:
    return repo_root_command_problem(doc, "make test", "program")


def scripts_job_problem(doc) -> str:
    return repo_root_command_problem(doc, "make test-scripts", "scripts")


_NPMRC_SKIP = {".git", "node_modules", "target", "dist", ".next", "coverage", ".anchor"}


def committed_npmrc_paths(root: str):
    if _git_dir(root):
        try:
            out = subprocess.check_output(
                ["git", "-C", root, "ls-files", "-z"],
                stderr=subprocess.DEVNULL,
            )
        except (OSError, subprocess.CalledProcessError):
            out = None
        if out is not None:
            paths = []
            for rel in out.decode("utf-8", "replace").split("\0"):
                if rel and os.path.basename(rel) == ".npmrc":
                    paths.append(os.path.join(root, rel))
            return paths
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name not in _NPMRC_SKIP]
        if ".npmrc" in filenames:
            found.append(os.path.join(dirpath, ".npmrc"))
    return found


def npmrc_sets_script_shell(path: str) -> bool:
    try:
        lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
    except OSError:
        return False
    for raw in lines:
        line = raw.strip()
        if line == "" or line.startswith("#") or line.startswith(";"):
            continue
        cut = []
        quote = None
        i = 0
        while i < len(line):
            c = line[i]
            if quote:
                cut.append(c)
                if c == quote:
                    quote = None
                i += 1
                continue
            if c in "\"'":
                quote = c
                cut.append(c)
                i += 1
                continue
            if c in "#;" and (i == 0 or line[i - 1].isspace()):
                break
            cut.append(c)
            i += 1
        body = "".join(cut).strip()
        if "=" not in body:
            continue
        key, _, _val = body.partition("=")
        if key.strip().lower() == "script-shell":
            return True
    return False


def npmrc_problem(root: str) -> str:
    if not os.path.isdir(root):
        return "npmrc scan root is not a directory"
    hits = []
    for path in committed_npmrc_paths(root):
        if npmrc_sets_script_shell(path):
            hits.append(os.path.relpath(path, root))
    if not hits:
        return ""
    return "committed .npmrc sets script-shell (" + ", ".join(hits) + "), so npm scripts can spawn nothing"


def main():
    mode = sys.argv[1]
    if mode == "trigger":
        text = open(sys.argv[2]).read()
        doc = parse_document(text)
        problem = trigger_problem(doc, sys.argv[2], text)
        if problem:
            print(problem)
            sys.exit(1)
        sys.exit(0)
    if mode == "workflow":
        doc = parse_document(open(sys.argv[2]).read())
        problem = blocking_surface(doc)
        if problem:
            print(problem)
            sys.exit(1)
        sys.exit(0)
    if mode == "program":
        doc = parse_document(open(sys.argv[2]).read())
        problem = program_job_problem(doc)
        if problem:
            print(problem)
            sys.exit(1)
        sys.exit(0)
    if mode == "scripts":
        doc = parse_document(open(sys.argv[2]).read())
        problem = scripts_job_problem(doc)
        if problem:
            print(problem)
            sys.exit(1)
        sys.exit(0)
    if mode == "npmrc":
        problem = npmrc_problem(sys.argv[2])
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
        problem = job_problem(job, pkg, check, doc)
        if problem:
            print(problem)
            sys.exit(1)
        sys.exit(0)
    sys.exit("unknown mode " + mode)

main()
PY
}

if reason=$(ci_py trigger "$CI"); then
  ok "workflow runs on pull_request"
else
  bad "workflow ${reason}"
fi

if reason=$(ci_py workflow "$CI"); then
  ok "workflow defaults and env cannot stop a run step"
else
  bad "workflow ${reason}"
fi

if reason=$(ci_py program "$CI"); then
  ok "a job runs make test from the repo root"
else
  bad "program check: ${reason}"
fi

if reason=$(ci_py scripts "$CI"); then
  ok "a job runs make test-scripts from the repo root"
else
  bad "scripts check: ${reason}"
fi

if reason=$(ci_py npmrc "$ROOT"); then
  ok "no committed .npmrc sets script-shell"
else
  bad "${reason}"
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
