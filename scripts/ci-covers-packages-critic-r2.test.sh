#!/usr/bin/env bash
# Critic fixture, PR 96 round 2, issue 95: shapes the round 3 and round 1
# fixtures did not try against the structural guard from 49f6563.
#
# Three groups. Every edit leaves CI never running app's typecheck on a pull
# request, or is a legitimate workflow the guard must not reject.
#
# must-reject (counted): the guard must go red.
#   order-*      the disabling key in positions the line scanner never saw
#   quote-*      'if', "if", `if :`, `? if` complex key
#   flow-job-if  the whole job as a one-line flow mapping carrying if: false
#   anchor-*     if: &skip false, if: *skip
#   matrix-*     a matrix that points the working directory elsewhere, a
#                matrix value driving a step if
#   needs-*      needs as a list, needs through a bridge job
#   on-*         trigger filters that exclude every pull request the same
#                way paths-ignore ** does, and types written other ways
#   step-*       step-level if/continue-on-error quoted, a flow-map step
#                carrying if, working-directory ../tools or an env value
#   defaults-flow-wd  defaults as a flow mapping pointing at tools
#
# info-escape (reported, not counted): shapes that get past the guard where
# whether the workflow still gates depends on GitHub behaviour this fixture
# cannot verify offline. Named in the review with that caveat.
#
# info-fp (reported, not counted): legitimate shapes; if the guard rejects
# them that is a false positive, not an escape.
#
# control (counted): shapes that must pass.
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

job_head = '  app:\n    runs-on: ubuntu-latest\n'
job_tail = '      - run: npm test\n\n  terminal:\n'
defaults = '    defaults:\n      run:\n        working-directory: app\n    steps:\n'
step = '      - run: npm run typecheck\n'
trigger = 'on:\n  push:\n    branches: [main]\n  pull_request:\n'
never = '  never:\n    if: false\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n'

def app_job(text):
    return text.index('  app:\n'), text.index('\n  terminal:')

def in_app(old, new):
    global s
    a, b = app_job(s)
    job = s[a:b]
    assert job.count(old) == 1, (mode, old)
    s = s[:a] + job.replace(old, new) + s[b:]

def once(old, new):
    global s
    assert s.count(old) == 1, (mode, old)
    s = s.replace(old, new)

if mode == 'order-if-between-defaults-and-steps':
    in_app(defaults, defaults.replace('    steps:\n', '    if: false\n    steps:\n'))
elif mode == 'order-if-after-blank-comment':
    once(job_tail, '      - run: npm test\n\n    # gate\n    if: false\n\n  terminal:\n')
elif mode == 'order-steps-first-if-last':
    a, b = app_job(s)
    body = s[a + len('  app:\n'):b]
    i = body.index('    steps:\n')
    s = s[:a] + '  app:\n' + body[i:].rstrip('\n') + '\n' + body[:i] + '    if: false\n' + s[b:]
elif mode == 'quote-single-if':
    once(job_head, "  app:\n    'if': false\n    runs-on: ubuntu-latest\n")
elif mode == 'quote-unicode-if':
    once(job_head, '  app:\n    "\\u0069f": false\n    runs-on: ubuntu-latest\n')
elif mode == 'quote-spaced-if':
    once(job_head, '  app:\n    if : false\n    runs-on: ubuntu-latest\n')
elif mode == 'quote-complex-key-if':
    once(job_head, '  app:\n    runs-on: ubuntu-latest\n    ? if\n    : false\n')
elif mode == 'flow-job-if' or mode == 'flow-job-live':
    a, b = app_job(s)
    cond = 'if: false, ' if mode == 'flow-job-if' else ''
    s = s[:a] + ('  app: {runs-on: ubuntu-latest, ' + cond +
                 'defaults: {run: {working-directory: app}}, '
                 'steps: [{uses: actions/checkout@v4}, {run: npm ci}, {run: npm run typecheck}, {run: npm test}]}\n') + s[b:]
elif mode == 'anchor-if-value':
    once(job_head, '  app:\n    if: &skip false\n    runs-on: ubuntu-latest\n')
elif mode == 'anchor-alias-if-value':
    once(job_head, never.replace('if: false', 'if: &skip false') + '  app:\n    if: *skip\n    runs-on: ubuntu-latest\n')
elif mode == 'anchor-merge-key-if':
    once(job_head, '  never: &skip\n    if: false\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n'
                   '  app:\n    <<: *skip\n    runs-on: ubuntu-latest\n')
elif mode == 'anchor-run-alias-live':
    once(job_head, '  anchors:\n    runs-on: ubuntu-latest\n    steps:\n      - run: &tc npm run typecheck\n        working-directory: app\n'
                   + job_head)
    in_app(step, '      - run: *tc\n')
elif mode == 'matrix-wd':
    in_app(defaults, '    strategy:\n      matrix:\n        pkg: [tools]\n'
                     '    defaults:\n      run:\n        working-directory: ${{ matrix.pkg }}\n    steps:\n')
elif mode == 'matrix-exclude-all':
    in_app(defaults, '    strategy:\n      matrix:\n        pkg: [app]\n        exclude:\n          - pkg: app\n' + defaults)
elif mode == 'matrix-step-if':
    in_app(defaults, '    strategy:\n      matrix:\n        run: [false]\n' + defaults)
    in_app(step, step + '        if: ${{ matrix.run }}\n')
elif mode == 'needs-list':
    once(job_head, never + '  app:\n    needs: [never]\n    runs-on: ubuntu-latest\n')
elif mode == 'needs-chain':
    once(job_head, never + '  bridge:\n    needs: never\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n'
                   '  app:\n    needs: bridge\n    runs-on: ubuntu-latest\n')
elif mode == 'on-paths-ignore-star-slash':
    once(trigger, trigger + '    paths-ignore: ["**/*"]\n')
elif mode == 'on-paths-never':
    once(trigger, trigger + '    paths: ["never/**"]\n')
elif mode == 'on-branches-never':
    once(trigger, trigger + '    branches: [never]\n')
elif mode == 'on-branches-ignore-all':
    once(trigger, trigger + '    branches-ignore: ["**"]\n')
elif mode == 'on-quoted-key-paths-ignore':
    once(trigger, '"on":\n  push:\n    branches: [main]\n  pull_request:\n    paths-ignore:\n      - "**"\n')
elif mode == 'on-types-block-closed':
    once(trigger, trigger + '    types:\n      - closed\n')
elif mode == 'on-types-quoted-closed':
    once(trigger, trigger + "    types: ['closed']\n")
elif mode == 'on-types-quoted-key':
    once(trigger, trigger + '    "types": [closed]\n')
elif mode == 'on-pr-flow-closed':
    once(trigger, 'on:\n  push:\n    branches: [main]\n  pull_request: {types: [closed]}\n')
elif mode == 'step-if-quoted':
    in_app(step, step + '        "if": false\n')
elif mode == 'step-continue-quoted':
    in_app(step, step + "        'continue-on-error': true\n")
elif mode == 'step-flow-if':
    in_app(step, '      - {run: npm run typecheck, if: false}\n')
elif mode == 'step-flow-live':
    in_app(step, '      - {run: npm run typecheck}\n')
elif mode == 'step-block-live':
    in_app(step, '      - run: |\n          npm run typecheck\n')
elif mode == 'step-wd-dotdot':
    in_app(step, step + '        working-directory: ../tools\n')
elif mode == 'step-wd-env':
    in_app(defaults, '    env:\n      PKG: tools\n' + defaults)
    in_app(step, step + '        working-directory: ${{ env.PKG }}\n')
elif mode == 'defaults-flow-wd':
    in_app(defaults, '    defaults: {run: {working-directory: tools}}\n    steps:\n')
elif mode == 'job-if-expression':
    once(job_head, "  app:\n    if: ${{ github.event_name == 'never' }}\n    runs-on: ubuntu-latest\n")
elif mode == 'job-duplicate-first-disabled':
    once(job_head, '  app:\n    if: false\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n' + job_head)
else:
    sys.exit('unknown mode ' + mode)
open(path, 'w').write(s)
PY
}

guard_passes() {
    "$1/scripts/$GUARD" >/dev/null 2>&1
}

MUST_REJECT="order-if-between-defaults-and-steps order-if-after-blank-comment order-steps-first-if-last
quote-single-if quote-unicode-if quote-spaced-if quote-complex-key-if flow-job-if
anchor-if-value anchor-alias-if-value matrix-wd matrix-step-if needs-list needs-chain
on-paths-ignore-star-slash on-paths-never on-branches-never on-branches-ignore-all
on-quoted-key-paths-ignore on-types-block-closed on-types-quoted-closed on-types-quoted-key on-pr-flow-closed
step-if-quoted step-continue-quoted step-flow-if step-wd-dotdot step-wd-env defaults-flow-wd job-if-expression"
INFO_ESCAPE="anchor-merge-key-if matrix-exclude-all job-duplicate-first-disabled"
INFO_FP="flow-job-live step-flow-live anchor-run-alias-live"
CONTROL_PASS="step-block-live"

for mode in $MUST_REJECT; do
    dir=$(scratch)
    if ! edit "$dir" "$mode"; then bad "could not apply edit $mode"; rm -rf "$dir"; continue; fi
    if guard_passes "$dir"; then
        bad "guard stays green with $mode; CI never runs app's npm run typecheck on a pull request"
    else
        ok "guard fails with $mode"
    fi
    rm -rf "$dir"
done

for mode in $INFO_ESCAPE; do
    dir=$(scratch)
    if ! edit "$dir" "$mode"; then bad "could not apply edit $mode"; rm -rf "$dir"; continue; fi
    if guard_passes "$dir"; then
        info "guard stays green with $mode (gates only if GitHub honours the shape; see review)"
    else
        info "guard rejects $mode"
    fi
    rm -rf "$dir"
done

for mode in $INFO_FP; do
    dir=$(scratch)
    if ! edit "$dir" "$mode"; then bad "could not apply edit $mode"; rm -rf "$dir"; continue; fi
    if guard_passes "$dir"; then
        info "guard accepts legitimate $mode"
    else
        info "guard rejects legitimate $mode (false positive, fails closed)"
    fi
    rm -rf "$dir"
done

for mode in $CONTROL_PASS; do
    dir=$(scratch)
    if ! edit "$dir" "$mode"; then bad "could not apply edit $mode"; rm -rf "$dir"; continue; fi
    if guard_passes "$dir"; then ok "guard accepts $mode (control)"; else bad "guard rejects legitimate $mode"; fi
    rm -rf "$dir"
done

dir=$(scratch)
if guard_passes "$dir"; then ok "unedited scratch copy passes the guard (control)"; else bad "unedited scratch copy fails the guard"; fi
rm -rf "$dir"

echo "ci coverage critic r2 checks: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
