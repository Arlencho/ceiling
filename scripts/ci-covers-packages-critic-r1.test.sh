#!/usr/bin/env bash
# Critic fixture, PR 96 round 1, issue 95: the CI coverage guard still passes
# a check that is switched off at the job or workflow level by an edit the
# round 3 fixture did not try. Each edit below leaves CI never running app's
# typecheck on a pull request, and the guard on the branch stays green.
#
#   job-if-after-steps        the job's if: false sits after steps:, where
#                             job_keys() has already stopped reading
#   job-continue-after-steps  continue-on-error: true after steps:
#   job-needs-after-steps     needs: never after steps:, never is if: false
#   job-quoted-if             "if": false, a quoted key YAML reads as if
#   on-paths-ignore-list      pull_request paths-ignore as a block list, one
#                             item per line, so ** is not on the key's line
#   on-pr-types-closed        pull_request types: [closed]; the workflow runs
#                             only after a merge, never as a gate
#   step-nested-run           the live step is `run: echo skipped`; the text
#                             `npm run typecheck` sits under env:, and the
#                             step parser folds nested keys into the step
#
# Same shape as ci-covers-packages-round3.test.sh: copy guard, workflow and
# package.json files into a scratch tree, apply one edit, expect the copied
# guard to fail. No network.
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

edit() {
    python3 - "$1/.github/workflows/ci.yml" "$2" <<'PY'
import sys
path, mode = sys.argv[1], sys.argv[2]
s = open(path).read()

job_head = '  app:\n    runs-on: ubuntu-latest\n'
job_tail = (
    '      - name: Prove the app tests ran\n'
    '        run: |\n'
    '          bash "$GITHUB_WORKSPACE/scripts/ci-assert-test-count.sh" app "$RUNNER_TEMP/ci-app-tests.txt"\n'
    '\n'
    '  terminal:\n'
)
step = '      - run: npm run typecheck\n'
trigger = 'on:\n  push:\n    branches: [main]\n  pull_request:\n'

def app_job(text):
    return text.index('  app:\n'), text.index('\n  terminal:')

def after_steps(extra):
    return job_tail.replace('\n\n  terminal:\n', '\n' + extra + '\n\n  terminal:\n')

if mode == 'job-if-after-steps':
    assert s.count(job_tail) == 1
    s = s.replace(job_tail, after_steps('    if: false'))
elif mode == 'job-continue-after-steps':
    assert s.count(job_tail) == 1
    s = s.replace(job_tail, after_steps('    continue-on-error: true'))
elif mode == 'job-needs-after-steps':
    assert s.count(job_head) == 1 and s.count(job_tail) == 1
    s = s.replace(job_head,
        '  never:\n    if: false\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n'
        '  app:\n    runs-on: ubuntu-latest\n')
    s = s.replace(job_tail, after_steps('    needs: never'))
elif mode == 'job-quoted-if':
    assert s.count(job_head) == 1
    s = s.replace(job_head, '  app:\n    "if": false\n    runs-on: ubuntu-latest\n')
elif mode == 'on-paths-ignore-list':
    assert s.count(trigger) == 1
    s = s.replace(trigger, trigger + '    paths-ignore:\n      - "**"\n')
elif mode == 'on-pr-types-closed':
    assert s.count(trigger) == 1
    s = s.replace(trigger, trigger + '    types: [closed]\n')
elif mode == 'step-nested-run':
    a, b = app_job(s)
    job = s[a:b]
    assert job.count(step) == 1
    s = s[:a] + job.replace(step, '      - run: echo skipped\n        env:\n          run: npm run typecheck\n') + s[b:]
else:
    sys.exit('unknown mode ' + mode)

a, b = app_job(s)
if mode == 'step-nested-run':
    assert step not in s[a:b], 'the live typecheck step must be gone in this mode'
else:
    assert step in s[a:b], 'edit removed the typecheck step; the case would prove nothing'
open(path, 'w').write(s)
PY
}

for mode in job-if-after-steps job-continue-after-steps job-needs-after-steps job-quoted-if on-paths-ignore-list on-pr-types-closed step-nested-run; do
    dir=$(scratch)
    if ! edit "$dir" "$mode"; then
        bad "could not apply edit $mode to the scratch workflow"
        rm -rf "$dir"
        continue
    fi
    if "$dir/scripts/$GUARD" >/dev/null 2>&1; then
        bad "guard stays green with $mode; CI never runs app's npm run typecheck on a pull request"
    else
        ok "guard fails with $mode"
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

echo "ci coverage critic r1 checks: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
