#!/usr/bin/env bash
# Critic fixture, PR 102 round 1, issue 99: the per-package witness added in
# e52b9f2 is the single file <pkg>/package.json. A filter that admits that
# file and nothing else in the package, or ignores the package's sources but
# not its manifest, leaves every code change to the package unchecked while
# the guard stays green. That is the outcome issue 99 closed for app/**,
# written one directory deeper.
#
# The scratch copy gives each package a src/index.ts so the guard sees a
# source file next to the manifest, as the real tree has.
#
# must-reject (counted): every edit leaves at least one package's source
# changes without that package's checks on a pull request.
#   src-*     the sources are excluded, the manifest is not
#   man-*     only manifests are admitted
#   one-*     one package's sources are admitted, no other package's are
#   probe-*   a pull_request branches list that names the branch probe
#             placeholder, which a push glob still expands to
#
# info-escape (reported, not counted): shapes outside the fix diff. The
# review says for each whether it matters.
#
# The ctl-* rows are paths filters the review called legitimate. The guard
# now refuses every paths filter, so they are counted failures.
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
    mkdir -p "$dir/scripts" "$dir/.github/workflows" "$dir/programs/veto/src"
    cp "$ROOT/scripts/$GUARD" "$dir/scripts/$GUARD"
    cp "$ROOT/.github/workflows/ci.yml" "$dir/.github/workflows/ci.yml"
    cp "$ROOT/README.md" "$dir/README.md"
    printf 'pub fn veto() {}\n' > "$dir/programs/veto/src/lib.rs"
    for pkg in "$ROOT"/*/package.json; do
        name=$(basename "$(dirname "$pkg")")
        [ "$name" = "node_modules" ] && continue
        mkdir -p "$dir/$name/src"
        cp "$pkg" "$dir/$name/package.json"
        printf 'export const x = 1;\n' > "$dir/$name/src/index.ts"
        printf '# %s\n' "$name" > "$dir/$name/README.md"
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
    # sources excluded, manifest admitted
    'src-ignore-app':        under_pr('    paths-ignore: ["app/src/**"]\n'),
    'src-ignore-all':        under_pr('    paths-ignore: ["**/src/**"]\n'),
    'src-ignore-ts':         under_pr('    paths-ignore: ["**.ts", "**.tsx"]\n'),
    'src-negate-all':        under_pr('    paths: ["**", "!**/src/**"]\n'),
    'src-negate-app':        under_pr('    paths: ["**", "!app/src/**"]\n'),
    # only manifests admitted
    'man-any-depth':         under_pr('    paths: ["**/package.json"]\n'),
    'man-one-depth':         under_pr('    paths: ["*/package.json"]\n'),
    'man-json':              under_pr('    paths: ["**/*.json"]\n'),
    # one package's sources admitted, the rest only by manifest
    'one-app':               under_pr('    paths: ["*/package.json", "app/**"]\n'),
    'one-watcher-file':      under_pr('    paths: ["**/package.json", "watcher/src/journal.ts"]\n'),
    # a branches list that names the placeholder a push glob expands to
    'probe-named':           whole('on:\n  push:\n    branches: ["**"]\n  pull_request:\n    branches: [zz-unwritten-branch-probe]\n'),
    # escapes outside the fix diff, measured only
    'esc-push-only':         whole('on:\n  push:\n    branches: [main]\n'),
    'esc-ignore-programs':   under_pr('    paths-ignore: ["programs/**"]\n'),
    'esc-paths-node-only':   under_pr('    paths: ["app/**", "terminal/**", "watcher/**", "tools/**", "indexer/**"]\n'),
    'esc-leading-qmark':     under_pr('    paths-ignore: ["?pp/**"]\n'),
    'esc-push-negated-main': whole('on:\n  push:\n    branches: ["!main"]\n  pull_request:\n    branches: [main]\n'),
    # controls
    'ctl-ignore-md':         under_pr('    paths-ignore: ["**.md"]\n'),
    'ctl-ignore-docs-md':    under_pr('    paths-ignore: ["docs/**", "**/*.md", "LICENSE"]\n'),
    'ctl-paths-all-not-md':  under_pr('    paths: ["**", "!**.md"]\n'),
    'ctl-paths-all':         under_pr('    paths: ["**"]\n'),
    'ctl-ignore-lockfiles':  under_pr('    paths-ignore: ["**/package-lock.json"]\n'),
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

MUST_REJECT="src-ignore-app src-ignore-all src-ignore-ts src-negate-all src-negate-app
man-any-depth man-one-depth man-json
one-app one-watcher-file
probe-named
ctl-ignore-md ctl-ignore-docs-md ctl-paths-all-not-md ctl-paths-all ctl-ignore-lockfiles"
INFO_ESCAPE="esc-push-only esc-ignore-programs esc-paths-node-only esc-leading-qmark esc-push-negated-main"
CONTROL_PASS=""

for mode in $MUST_REJECT; do
    dir=$(scratch)
    if ! edit "$dir" "$mode"; then bad "could not apply edit $mode"; rm -rf "$dir"; continue; fi
    if guard_passes "$dir"; then
        bad "guard stays green with $mode; a pull request carrying a change to a package runs none of its checks"
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

printf 'ci coverage critic r4 checks: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
