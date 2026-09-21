#!/usr/bin/env bash
# Ground Truth: the CI coverage guard rejects a check step that is present in
# the workflow text but does not run.
#
# ci-covers-packages.test.sh greps a job block for `run: npm run <check>`. The
# pattern is not tied to a live step, so each of these edits to app's typecheck
# step keeps the guard green while CI never runs the package typecheck again:
#
#   comment    `# - run: npm run typecheck`
#   or-true    `- run: npm run typecheck || true`
#   if-false   `- run: npm run typecheck` followed by `if: false`
#
# Each case copies the guard, the workflow and every package.json into a
# scratch tree, applies one edit, and expects the copied guard to fail. An
# unedited copy is run as the control. No network.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARD=ci-covers-packages.test.sh

pass=0; fail=0
ok()  { printf 'ok - %s\n' "$1"; pass=$((pass+1)); }
bad() { printf 'not ok - %s\n' "$1"; fail=$((fail+1)); }

scratch() {
    local dir name pkg
    dir=$(mktemp -d)
    mkdir -p "$dir/scripts" "$dir/.github/workflows"
    cp "$ROOT/scripts/$GUARD" "$dir/scripts/$GUARD"
    cp "$ROOT/.github/workflows/ci.yml" "$dir/.github/workflows/ci.yml"
    for pkg in "$ROOT"/*/package.json; do
        name=$(basename "$(dirname "$pkg")")
        [ "$name" = "node_modules" ] && continue
        mkdir -p "$dir/$name"
        cp "$pkg" "$dir/$name/package.json"
    done
    printf '%s' "$dir"
}

# edit <dir> <mode>: rewrite the first `- run: npm run typecheck` inside the
# app job of the copied workflow.
edit() {
    python3 - "$1/.github/workflows/ci.yml" "$2" <<'PY'
import sys
path, mode = sys.argv[1], sys.argv[2]
lines = open(path).read().split('\n')
out, inapp, hit = [], False, False
for line in lines:
    if line == '  app:':
        inapp = True
    elif inapp and line.startswith('  ') and not line.startswith('   ') and line.endswith(':'):
        inapp = False
    if inapp and not hit and line.strip() == '- run: npm run typecheck':
        hit = True
        indent = line[:len(line) - len(line.lstrip())]
        if mode == 'comment':
            out.append(indent + '# - run: npm run typecheck')
        elif mode == 'or-true':
            out.append(indent + '- run: npm run typecheck || true')
        elif mode == 'if-false':
            out.append(line)
            out.append(indent + '  if: false')
        else:
            sys.exit('unknown mode ' + mode)
        continue
    out.append(line)
if not hit:
    sys.exit('app typecheck step not found')
open(path, 'w').write('\n'.join(out))
PY
}

for mode in comment or-true if-false; do
    dir=$(scratch)
    if ! edit "$dir" "$mode"; then
        bad "could not apply edit $mode to the scratch workflow"
        rm -rf "$dir"
        continue
    fi
    if "$dir/scripts/$GUARD" >/dev/null 2>&1; then
        bad "guard stays green with app's typecheck step $mode; CI never runs npm run typecheck"
    else
        ok "guard fails with app's typecheck step $mode"
    fi
    rm -rf "$dir"
done

dir=$(scratch)
if "$dir/scripts/$GUARD" >/dev/null 2>&1; then
    ok "unedited scratch copy passes the guard (control)"
else
    bad "unedited scratch copy fails the guard; the scratch tree is wrong, not the workflow"
fi
rm -rf "$dir"

echo "ci coverage round2 checks: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
