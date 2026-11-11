import assert from 'node:assert/strict';
import { test } from 'node:test';
import { integrationTests, verifyTestOutput } from '../scripts/ci-test.mjs';

const complete = `${integrationTests.map((name, i) => `ok ${i + 1} - ${name}`).join('\n')}
# tests 2
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
`;

test('CI proof accepts a complete unskipped TAP run', () => {
  assert.doesNotThrow(() => verifyTestOutput(complete));
});

test('CI proof rejects skips, failures, incomplete counts and missing integration results', () => {
  for (const output of [
    complete.replace('# skipped 0', '# skipped 1'),
    complete.replace('# fail 0', '# fail 1'),
    complete.replace('# cancelled 0', '# cancelled 1'),
    complete.replace('# todo 0', '# todo 1'),
    complete.replace('# pass 2', '# pass 1'),
    complete.replace('# tests 2', '# tests 0'),
    complete.replace('# pass 2', ''),
    complete + '# tests 2\n',
    complete.replace('ok 1 -', 'not ok 1 -'),
    complete.replace('ok 2 -', 'ok 2 - unrelated test: '),
    complete.replace(integrationTests[0], `${integrationTests[0]} # SKIP unavailable`),
  ]) assert.throws(() => verifyTestOutput(output));
});
