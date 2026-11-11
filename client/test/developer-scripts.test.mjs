import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, chmod, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer as httpsServer } from 'node:https';
import { createServer as httpServer } from 'node:http';
import { once } from 'node:events';

async function fixture(t, name) {
  const root = await mkdtemp(join(tmpdir(), 'pelorus scripts '));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'client'));
  const source = await readFile(new URL(`../../scripts/${name}`, import.meta.url), 'utf8');
  const script = join(root, 'scripts', name);
  await writeFile(script, source);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, script, source };
}

function run(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [script], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(deadline);
      if (signal) reject(new Error(`fixture child terminated: ${signal}`));
      else resolve({ code, stdout, stderr });
    });
  });
}

async function executable(path, source) {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

for (const name of ['dev.sh', 'watch.sh']) {
  test(`${name}: missing local esbuild fails before any package manager or Cargo`, { timeout: 10000 }, async t => {
    const { root, script } = await fixture(t, name);
    const bin = join(root, 'bin'); await mkdir(bin);
    const log = join(root, 'commands');
    for (const command of ['npx', 'npm', 'cargo']) {
      await executable(join(bin, command), `#!/bin/sh\necho ${command} >> "$PELORUS_TEST_LOG"\nexit 97\n`);
    }
    const result = await run(script, { PATH: `${bin}:${process.env.PATH}`, PELORUS_TEST_LOG: log });
    const calls = await readFile(log, 'utf8').catch(() => '');
    assert.equal(calls, '', 'missing dependencies must not invoke download fallback or start Cargo');
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /local esbuild.*npm ci --ignore-scripts/i);
  });

  test(`${name}: existing locked local executable receives unchanged bundle/watch arguments`, { timeout: 10000 }, async t => {
    const { root, script } = await fixture(t, name);
    const bin = join(root, 'bin'); await mkdir(bin);
    const local = join(root, 'client/node_modules/.bin'); await mkdir(local, { recursive: true });
    const log = join(root, 'args');
    await executable(join(local, 'esbuild'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$PELORUS_TEST_LOG"\n');
    await executable(join(bin, 'cargo'), '#!/bin/sh\nexit 0\n');
    await executable(join(bin, 'npx'), '#!/bin/sh\nexit 97\n');
    await executable(join(bin, 'npm'), '#!/bin/sh\nexit 97\n');
    const result = await run(script, { PATH: `${bin}:${process.env.PATH}`, PELORUS_TEST_LOG: log });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), [
      'src/main.ts', '--bundle', '--outfile=dist/app.js', '--sourcemap', '--target=es2022', '--format=esm',
      ...(name === 'watch.sh' ? ['--watch'] : []),
    ]);
  });
}

for (const mode of ['https success', 'HTTP error', 'HTTPS downgrade', 'initial HTTP']) {
  test(`geodata curl: ${mode}`, { timeout: 15000 }, async t => {
    const { root, script, source } = await fixture(t, 'download-geodata.sh');
    const key = join(root, 'fixture-key.pem'), cert = join(root, 'fixture-cert.pem');
    // Fresh test-only loopback identity, never committed or used outside this test.
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ed25519', '-noenc', '-keyout', key,
      '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
    { stdio: 'ignore', timeout: 5000 });
    let plainRequests = 0, secureRequests = 0;
    const body = '{"type":"FeatureCollection","features":[]}';
    const plain = httpServer((_req, res) => { plainRequests++; res.end(body); });
    plain.listen(0, '127.0.0.1'); await once(plain, 'listening');
    const secure = httpsServer({ key: await readFile(key), cert: await readFile(cert) }, (_req, res) => {
      secureRequests++;
      if (mode === 'HTTP error') res.writeHead(503).end('fixture failure');
      else if (mode === 'HTTPS downgrade') res.writeHead(302, { Location: `http://127.0.0.1:${plain.address().port}/downgrade` }).end();
      else res.end(body);
    });
    secure.listen(0, '127.0.0.1'); await once(secure, 'listening');
    t.after(async () => {
      for (const server of [plain, secure]) server.closeAllConnections();
      await Promise.all([plain, secure].map(server => new Promise(resolve => server.close(resolve))));
    });
    const endpoint = mode === 'initial HTTP' ? `http://127.0.0.1:${plain.address().port}` : `https://127.0.0.1:${secure.address().port}`;
    // Substitute only the fixed upstream URL in the isolated script copy.
    await writeFile(script, source.replace('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson', endpoint));
    const result = await run(script, { CURL_CA_BUNDLE: cert, CURL_HOME: root, NO_PROXY: '127.0.0.1,localhost' });
    if (mode === 'https success') {
      assert.equal(result.code, 0, result.stderr);
      assert.equal(secureRequests, 5);
      assert.equal((await readdir(join(root, 'client/dist/data'))).length, 5);
    } else if (mode === 'HTTP error') {
      assert.equal(result.code, 22, 'HTTP 503 must fail, not report a successful download');
      assert.equal(secureRequests, 1, 'set -e must stop at the first failed asset');
    } else {
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, /Protocol.*http.*(?:disabled|not supported)/i);
    }
    assert.equal(plainRequests, 0, 'initial URLs and redirects must never reach HTTP');
  });
}
