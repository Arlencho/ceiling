#!/usr/bin/env bash
# Ground Truth: the CI coverage guard rejects a check that is disabled above
# the step, at the job or the workflow level.
#
# After round 2, ci-covers-packages.test.sh parses the steps of a job block and
# requires a live `run: npm run <check>` step: not a comment, not `|| true`,
# not gated by if:/continue-on-error:, not pointed at another package. Each of
# these edits leaves that step untouched and the guard green while CI never
# runs app's typecheck on a pull request:
#
#   job-defaults-wd   the job's defaults.run.working-directory becomes tools,
#                     so the untouched step typechecks another package
#   job-if-false      the job carries if: false; a skipped job satisfies a
#                     required check
#   job-continue      the job carries continue-on-error: true; the run stays
#                     green when the job fails
#   job-needs-skipped the job needs a job that is itself if: false, so it is
#                     skipped with it
#   on-dispatch-only  the workflow trigger drops pull_request and push
#   custom-shell      the step carries shell: true {0}; the script file is
#                     handed to true, which exits 0 without reading it
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

# edit <dir> <mode>: apply one edit to the copied workflow. Every edit leaves
# the app job's `- run: npm run typecheck` line exactly as it is.
edit() {
    python3 - "$1/.github/workflows/ci.yml" "$2" <<'PY'
import sys
path, mode = sys.argv[1], sys.argv[2]
s = open(path).read()

job_head = '  app:\n    runs-on: ubuntu-latest\n'
job_wd = '        working-directory: app\n'
step = '      - run: npm run typecheck\n'
trigger = 'on:\n  push:\n    branches: [main]\n  pull_request:\n'

def app_job(text):
    start = text.index('  app:\n')
    end = text.index('\n  terminal:')
    return start, end

if mode == 'job-defaults-wd':
    a, b = app_job(s)
    job = s[a:b]
    assert job.count(job_wd) == 1
    s = s[:a] + job.replace(job_wd, '        working-directory: tools\n') + s[b:]
elif mode == 'job-if-false':
    assert s.count(job_head) == 1
    s = s.replace(job_head, '  app:\n    if: false\n    runs-on: ubuntu-latest\n')
elif mode == 'job-continue':
    assert s.count(job_head) == 1
    s = s.replace(job_head, '  app:\n    continue-on-error: true\n    runs-on: ubuntu-latest\n')
elif mode == 'job-needs-skipped':
    assert s.count(job_head) == 1
    s = s.replace(job_head,
        '  never:\n    if: false\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n'
        '  app:\n    needs: never\n    runs-on: ubuntu-latest\n')
elif mode == 'on-dispatch-only':
    assert s.count(trigger) == 1
    s = s.replace(trigger, 'on:\n  workflow_dispatch:\n')
elif mode == 'custom-shell':
    a, b = app_job(s)
    job = s[a:b]
    assert job.count(step) == 1
    s = s[:a] + job.replace(step, step + '        shell: true {0}\n') + s[b:]
else:
    sys.exit('unknown mode ' + mode)

# The step itself must be untouched in every mode.
a, b = app_job(s)
assert step in s[a:b], 'edit removed the typecheck step; the case would prove nothing'
open(path, 'w').write(s)
PY
}

for mode in job-defaults-wd job-if-false job-continue job-needs-skipped on-dispatch-only custom-shell; do
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

echo "ci coverage round3 checks: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
