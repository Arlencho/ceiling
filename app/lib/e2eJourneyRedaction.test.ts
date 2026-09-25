import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Exercise the actual journey callbacks without loading wallets or contacting devnet.
const source = ts.createSourceFile(
  'devnetJourney.test.ts',
  readFileSync(new URL('../e2e/devnetJourney.test.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);

function declaration(name: string): string {
  let found = '';
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(source);
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      found = `const ${node.getText(source)};`;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(found, `journey declaration ${name} is missing`);
  return found;
}

for (const failure of ['step', 'cleanup'] as const) {
  test(`a ${failure} error records every RPC occurrence redacted in the report and console`, async () => {
    const rpc = 'https://rpc.example.test/?api-key=private';
    const error = new Error(`request to ${rpc} failed; retry ${rpc}`);
    const rows: { detail: string }[] = [];
    const logs: string[] = [];
    const reports: string[] = [];
    const context = {
      RPC: rpc,
      rows,
      Error,
      console: { log: (line: string) => logs.push(line) },
      flush: () => reports.push(rows.map((row) => row.detail).join('\n')),
      sleep: async () => {},
    };
    const code = ts.transpileModule(
      `${declaration('errorText')}\n${declaration('record')}\n${declaration('step')}\n({ record, step, errorText });`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
    ).outputText;
    const journey = runInNewContext(code, context);
    if (failure === 'step') {
      await assert.rejects(journey.step('2', 'agent pays', async () => { throw error; }), (err) => err === error);
    } else {
      journey.record({ step: 'cleanup', action: 'reclaim', signature: '', result: 'fail', detail: journey.errorText(error) });
    }
    const expected = 'request to [redacted] failed; retry [redacted]';
    assert.equal(rows[0]?.detail, expected);
    assert.deepEqual(reports, [expected]);
    assert.deepEqual(logs, [failure === 'step'
      ? `2\tagent pays\t\tfail\t${expected}`
      : `cleanup\treclaim\t\tfail\t${expected}`]);
  });
}
