#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
const reports = new URL('../../reports/', import.meta.url);
const lines = ['# Scale measurements', '', 'Laptop results are a single-machine lower bound. Target arrival rates are not achieved throughput.', '', 'Not measured: production RPC delivery, webhook HTTP overhead, network latency, validator throughput unless separately reported, physical disk IO on Compose tmpfs, multi-node scaling, or long-duration stability. One million events per second through one Postgres is not claimed.', '', 'Determinism compares decisions, decision_keys, deltas, rule_stats and agent_stats across all business columns; decisions.source provenance and rule_stats/agent_stats wall-clock updated_at are excluded explicitly.', ''];
function flatten(value, prefix = '') {
  return Object.entries(value).flatMap(([key, item]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return item !== null && typeof item === 'object' ? flatten(item, path) : [[path, item]];
  });
}
for (const name of ['cu', 'validator', 'replay']) {
  let report;
  try { report = JSON.parse(await readFile(new URL(`${name}.json`, reports), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && name === 'validator') { lines.push('Validator report absent; validator throughput not measured.', ''); continue; } throw error; }
  const m = report.metadata ?? {};
  // Array reports store provenance per entry. Deduplicate recorded values and
  // retain differing values rather than describing them as absent.
  function fromEntries(select) {
    const values = (Array.isArray(report) ? report : []).map(select)
      .filter(value => value !== undefined && value !== null)
      .map(value => typeof value === 'object' ? JSON.stringify(value) : String(value));
    return [...new Set(values)].join(' / ') || undefined;
  }
  const duration = m.duration_seconds ?? report.run_wall_seconds ?? fromEntries(entry => entry?.durationSeconds);
  const provenance = { ...m };
  for (const key of ['machine', 'node', 'postgres', 'commit']) {
    provenance[key] ??= fromEntries(entry => entry?.[key]);
  }
  provenance.os ??= fromEntries(entry => entry?.os ??
    (entry?.machine?.os == null ? undefined : [entry.machine.os, entry.machine.release].filter(value => value != null).join(' ')));
  const conditions = m.conditions ?? report.measurement ?? fromEntries(entry => entry?.label);
  // Compute units are deterministic cost per instruction, so the lower-bound
  // throughput caveat does not apply to them.
  const context = ['machine', 'os', 'node', 'postgres', 'commit'].map(k => `${k}=${provenance[k] ?? 'not recorded'}`).join('; ')
    + `; duration=${duration ?? 'not recorded'} seconds; conditions=${conditions ?? 'not recorded'}`
    + (name === 'cu' ? '' : '; single-machine lower bound');
  for (const [key, value] of flatten(report)) {
    if (key.startsWith('metadata.')) continue;
    lines.push(`- ${name}.${key}: ${JSON.stringify(value)} | ${context}`);
  }
  lines.push('');
}
await writeFile(new URL('../../../docs/SCALE.md', import.meta.url), lines.join('\n').replaceAll('\u2014', '-'));
