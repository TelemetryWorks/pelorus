// Linux CI gate: a real executable server and a complete, unskipped TAP run.
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const integrationTests = [
  'Rust query header, contiguous IPC frames, real row counts and shared fanout',
  'invalid and explicitly empty settings exit cleanly before serving',
];

export function verifyTestOutput(output) {
  const summary = key => {
    const matches = [...output.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))];
    if (matches.length !== 1) throw new Error(`Missing or ambiguous TAP summary: ${key}`);
    return Number(matches[0][1]);
  };
  const total = summary('tests');
  if (total < integrationTests.length || summary('pass') !== total
    || ['fail', 'cancelled', 'skipped', 'todo'].some(key => summary(key) !== 0)) {
    throw new Error('CI requires every test to pass with zero skips, failures, cancellations or TODOs');
  }
  for (const name of integrationTests) {
    if (!new RegExp(`^ok \\d+ - ${name}\\r?$`, 'm').test(output)) {
      throw new Error(`Required integration test did not pass: ${name}`);
    }
  }
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const configured = process.env.PELORUS_SERVER_BIN;
  if (!configured) throw new Error('PELORUS_SERVER_BIN must name the built Rust server');
  const binary = resolve(root, configured);
  if (!statSync(binary).isFile()) throw new Error('PELORUS_SERVER_BIN must be a file');
  accessSync(binary, constants.X_OK);
  const tests = readdirSync(resolve(root, 'test')).filter(file => file.endsWith('.test.mjs')).sort();
  const result = spawnSync(process.execPath,
    ['--test', '--test-concurrency=2', '--test-reporter=tap', ...tests.map(file => `test/${file}`)], {
      cwd: root, env: { ...process.env, PELORUS_SERVER_BIN: binary },
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 120_000,
    });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  verifyTestOutput(result.stdout);
  console.log('CI verified: all registered tests passed; 0 integration skips; both required integration tests passed.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
