import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

function script(file) {
  return readFileSync(new URL(file, import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?from ["'][^"']+["'];/gm, '').replace(/^export /gm, '');
}

test('actual basemap loader logs rejected fetches without retries or changing empty-map behavior', async () => {
  const warnings = [];
  const requests = [];
  const context = vm.createContext({
    fetch: url => { requests.push(url); return Promise.reject(new Error('offline fixture')); },
    console: { warn: (...args) => warnings.push(args) },
    getTheme: () => 'dark', GeoJsonLayer: class {},
  });
  vm.runInContext(transformSync(script('../src/basemap.ts'), { loader: 'ts', target: 'es2022' }).code
    + '\nglobalThis.basemap = new BaseMap();', context);
  await context.basemap.load();
  assert.equal(requests.length, 4);
  assert.equal(context.basemap.loaded, true); // allSettled behavior remains intact
  assert.equal(context.basemap.getLayers().length, 0);
  assert.equal(warnings.length, 4);
  assert.deepEqual(warnings.map(args => args[0]), requests.map(url => `Failed to load basemap asset ${url}`));
  assert.ok(warnings.every(args => args[1].message === 'offline fixture'));
});

test('renderer catches and logs a rejected loader promise without an unhandled rejection', () => {
  // Isolate the rejection event from node:test; use the real renderer source,
  // with only Deck/loader boundaries stubbed. No browser/GPU or network required.
  const child = `
    import vm from 'node:vm';
    import { transformSync } from 'esbuild';
    import { readFileSync } from 'node:fs';
    const source = readFileSync(${JSON.stringify(fileURLToPath(new URL('../src/map.ts', import.meta.url)))}, 'utf8')
      .replace(/^import[\\s\\S]*?from ["'][^"']+["'];/gm, '').replace(/^export /gm, '');
    const result = { unhandled: [], warnings: [], calls: 0 };
    process.on('unhandledRejection', error => result.unhandled.push(error.message));
    const context = vm.createContext({
      Deck: class {}, MapView: class {},
      BaseMap: class { load() { result.calls++; return Promise.reject(new Error('loader fixture')); } },
      console: { warn: (...args) => result.warnings.push([args[0], args[1]?.message]) },
    });
    vm.runInContext(transformSync(source, { loader: 'ts', target: 'es2022' }).code + '\\nnew MapRenderer({ container: {} });', context);
    setImmediate(() => process.stdout.write(JSON.stringify(result)));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', child], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 5000, encoding: 'utf8',
  }));
  assert.deepEqual(result.unhandled, []);
  assert.equal(result.calls, 1);
  assert.deepEqual(result.warnings, [['Failed to load basemap', 'loader fixture']]);
});
