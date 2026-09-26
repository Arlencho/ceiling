#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpus, platform, release, totalmem } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
const start = performance.now();
execFileSync('make', ['loadtest-cu'], { stdio: 'inherit' });
const path = new URL('../../reports/cu.json', import.meta.url);
const report = JSON.parse(readFileSync(path, 'utf8'));
report.metadata = {
  machine: `${cpus()[0]?.model}, ${cpus().length} CPUs, ${totalmem()} bytes RAM`,
  os: `${platform()} ${release()}`, node: process.version, postgres: 'not used',
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  duration_seconds: report.run_wall_seconds,
  build_and_run_seconds: (performance.now() - start) / 1000,
  conditions: report.measurement,
};
writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
