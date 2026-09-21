#!/usr/bin/env bash
# Critic fixture, PR 96 round 3, issue 95: trigger filters the round 2 fixture
# did not try against the filter reading added in 7688a2e.
#
# must-reject (counted): every edit leaves a pull request without any package
# check while push still runs it after the merge, so the guard must go red.
#   bi-*        branches-ignore written so that together the items exclude
#               every branch push names, or exactly the one it names
#   br-*        branches that admit only a base no pull request here targets
#   on-*        a workflow that runs only on schedule or manual dispatch
#   paths-*     a paths list whose own negation empties it
#
# info-escape (reported, not counted): shapes that get past the guard. The
# review says for each whether it matters.
#
# control (counted): legitimate filters the guard must accept.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARD=ci-covers-packages.test.sh

pass=0; fail=0
ok()   { printf 'ok - %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf 'not ok - %s\n' "$1"; fail=$((fail+1)); }
info() { printf 'info - %s\n' "$1"; }

scratch() {
    local dir name pkg
    dir=$(mktemp -d)
    mkdir -p "$dir/scripts" "$dir/.github/workflows"
    cp "$ROOT/scripts/$GUARD" "$dir/scripts/$GUARD"
    cp "$ROOT/.github/workflows/ci.yml" "$dir/.github/workflows/ci.yml"
    cp "$ROOT/README.md" "$dir/README.md"
    for pkg in "$ROOT"/*/package.json; do
        name=$(basename "$(dirname "$pkg")")
        [ "$name" = "node_modules" ] && continue
        mkdir -p "$dir/$name"
        cp "$pkg" "$dir/$name/package.json"
    done
    printf '%s' "$dir"
}

edit() {
    python3 - "$1/.github/workflows/ci.yml" "$2" <<'PY'
import sys
path, mode = sys.argv[1], sys.argv[2]
s = open(path).read()

trigger = 'on:\n  push:\n    branches: [main]\n  pull_request:\n'
assert s.count(trigger) == 1, (mode, trigger)

def under_pr(extra):
    return trigger + extra

def whole(new):
    return new

edits = {
    # branches-ignore that excludes everything, written other ways
    'bi-two-globs':      under_pr('    branches-ignore: ["*", "**/*"]\n'),
    'bi-exact-main':     under_pr('    branches-ignore: [main]\n'),
    'bi-single-quoted':  under_pr("    branches-ignore: ['**']\n"),
    'bi-block-list':     under_pr('    branches-ignore:\n      - "**"\n'),
    'bi-char-class':     under_pr('    branches-ignore: ["m[a-z]in"]\n'),
    # branches that admit only a base no pull request here targets
    'br-release':        under_pr('    branches: ["release/**"]\n'),
    'br-negation-only':  under_pr('    branches: ["!main"]\n'),
    'br-refs-heads':     under_pr('    branches: [refs/heads/main]\n'),
    'br-all-then-negate': under_pr('    branches: ["**", "!main"]\n'),
    'br-main-suffix':    under_pr('    branches: ["main-*"]\n'),
    # only schedule or manual dispatch
    'on-schedule-only':  whole('on:\n  schedule:\n    - cron: "0 3 * * *"\n'),
    'on-dispatch-only':  whole('on:\n  workflow_dispatch:\n'),
    'on-dispatch-scalar': whole('on: workflow_dispatch\n'),
    'on-dispatch-list':  whole('on: [workflow_dispatch]\n'),
    'on-dispatch-flow':  whole('on: {workflow_dispatch: {}, schedule: [{cron: "0 3 * * *"}]}\n'),
    'on-dispatch-pr-closed': whole('on:\n  workflow_dispatch:\n  pull_request:\n    types: [closed]\n'),
    # a paths list its own negation empties
    'paths-self-negated': under_pr('    paths: ["**", "!**"]\n'),
    # escapes to measure
    'esc-push-bare-br-never': whole('on:\n  push:\n  pull_request:\n    branches: [never]\n'),
    'esc-push-tags-bi-main':  whole('on:\n  push:\n    tags: ["v*"]\n  pull_request:\n    branches-ignore: [main]\n'),
    'esc-pr-tags':            under_pr('    tags: ["v*"]\n'),
    'esc-paths-readme':       under_pr('    paths: [README.md]\n'),
    'esc-paths-ignore-app':   under_pr('    paths-ignore: ["app/**"]\n'),
    'esc-paths-app-only':     under_pr('    paths: ["app/**"]\n'),
    # controls
    'ctl-br-main':            under_pr('    branches: [main]\n'),
    'ctl-br-glob':            under_pr('    branches: ["**"]\n'),
    'ctl-br-negate-then-all': under_pr('    branches: ["!main", "**"]\n'),
    'ctl-bi-other':           under_pr('    branches-ignore: [gh-pages]\n'),
    'ctl-paths-ignore-md':    under_pr('    paths-ignore: ["**.md"]\n'),
    'ctl-paths-all':          under_pr('    paths: ["**"]\n'),
    'ctl-push-bare':          whole('on:\n  push:\n  pull_request:\n'),
}
if mode not in edits:
    sys.exit('unknown mode ' + mode)
s = s.replace(trigger, edits[mode])
open(path, 'w').write(s)
PY
}

guard_passes() {
    "$1/scripts/$GUARD" >/dev/null 2>&1
}

MUST_REJECT="bi-two-globs bi-exact-main bi-single-quoted bi-block-list bi-char-class
br-release br-negation-only br-refs-heads br-all-then-negate br-main-suffix
on-schedule-only on-dispatch-only on-dispatch-scalar on-dispatch-list on-dispatch-flow on-dispatch-pr-closed
paths-self-negated
esc-push-bare-br-never esc-push-tags-bi-main esc-paths-readme esc-paths-ignore-app esc-paths-app-only
ctl-paths-ignore-md ctl-paths-all"
INFO_ESCAPE="esc-pr-tags"
CONTROL_PASS="ctl-br-main ctl-br-glob ctl-br-negate-then-all ctl-bi-other ctl-push-bare"

for mode in $MUST_REJECT; do
    dir=$(scratch)
    if ! edit "$dir" "$mode"; then bad "could not apply edit $mode"; rm -rf "$dir"; continue; fi
    if guard_passes "$dir"; then
        bad "guard stays green with $mode; a pull request never runs any package check"
    else
        ok "guard fails with $mode"
    fi
    rm -rf "$dir"
done

for mode in $INFO_ESCAPE; do
    dir=$(scratch)
    if ! edit "$dir" "$mode"; then bad "could not apply edit $mode"; rm -rf "$dir"; continue; fi
    if guard_passes "$dir"; then
        info "guard stays green with $mode (see review for whether it matters)"
    else
        info "guard rejects $mode"
    fi
    rm -rf "$dir"
done

for mode in $CONTROL_PASS; do
    dir=$(scratch)
    if ! edit "$dir" "$mode"; then bad "could not apply edit $mode"; rm -rf "$dir"; continue; fi
    if guard_passes "$dir"; then
        ok "guard accepts $mode (control)"
    else
        bad "guard rejects legitimate $mode"
    fi
    rm -rf "$dir"
done

dir=$(scratch)
if guard_passes "$dir"; then
    ok "unedited scratch copy passes the guard (control)"
else
    bad "unedited scratch copy fails the guard"
fi
rm -rf "$dir"

printf 'ci coverage critic r3 checks: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
