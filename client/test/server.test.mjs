import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { decodeBatch } from '../src/decode.ts';

// Optional real Rust → WebSocket → JavaScript Arrow integration. No new package.
test('Rust query header, contiguous IPC frames, real row counts and shared fanout', {
  skip: !process.env.PELORUS_SERVER_BIN,
  timeout: 20_000,
}, async t => {
  const server = spawn(resolve(process.env.PELORUS_SERVER_BIN), [], {
    cwd: resolve('..'),
    env: { ...process.env, TOKIO_WORKER_THREADS: '2', PELORUS_OBJECTS: '3', PELORUS_HZ: '20',
      PELORUS_CHUNK_INTERVAL_US: '100000', PELORUS_MAX_CHUNKS: '2', PELORUS_MAX_ROWS: '30', RUST_LOG: 'server=info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const ready = new Promise((resolveReady, reject) => {
    for (const stream of [server.stdout, server.stderr]) stream.on('data', data => {
      log += data;
      if (log.includes('pelorus server listening')) resolveReady();
    });
    server.once('error', reject);
    server.once('exit', code => reject(new Error(`server exited ${code}: ${log}`)));
  });
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      await once(server, 'exit');
    }
  });
  await ready;

  async function socket() {
    const ws = new WebSocket('ws://127.0.0.1:3000/ws');
    ws.binaryType = 'arraybuffer';
    const queue = [];
    let waiter;
    ws.addEventListener('message', ({ data }) => {
      if (waiter) { const next = waiter; waiter = null; next(data); } else queue.push(data);
    });
    t.after(() => ws.close());
    await once(ws, 'open');
    return { ws, next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolveNext => { waiter = resolveNext; }) };
  }
  const a = await socket();
  const b = await socket();
  const trajectories = new Map();
  for (let i = 0; i < 8; i++) {
    const batch = decodeBatch(await a.next());
    trajectories.set(Number(batch.timestamps[0]), [...batch.longitudes]);
  }
  let matches = 0;
  for (let i = 0; i < 8; i++) {
    const batch = decodeBatch(await b.next());
    const expected = trajectories.get(Number(batch.timestamps[0]));
    if (expected) { assert.deepEqual([...batch.longitudes], expected); matches++; }
  }
  assert.ok(matches > 0, 'clients receive identical trajectories at shared source timestamps');

  a.ws.send(JSON.stringify({ type: 'meta' }));
  let meta;
  while (!meta) {
    const message = await a.next();
    if (typeof message === 'string') meta = JSON.parse(message);
  }
  assert.equal(meta.type, 'meta');
  assert.ok(meta.chunk_count > 0 && meta.chunk_count <= 2);
  assert.ok(meta.total_rows > meta.chunk_count && meta.total_rows <= 30);
  a.ws.send(JSON.stringify({ type: 'query', min_us: meta.min_us, max_us: meta.max_us }));
  let header;
  while (!header) {
    const message = await a.next();
    if (typeof message === 'string') header = JSON.parse(message);
  }
  assert.equal(header.type, 'query_response');
  let rows = 0;
  for (let i = 0; i < header.chunk_count; i++) {
    const message = await a.next();
    assert.ok(message instanceof ArrayBuffer, 'no text interleaves within response');
    const batch = decodeBatch(message);
    rows += batch.stats.rowCount;
    // Every source tick has three objects; live-frame interleaving would violate
    // the server snapshot total/count contract checked below.
    assert.equal(batch.stats.rowCount % 3, 0);
  }
  assert.equal(rows, header.total_rows);
  assert.ok(rows > header.chunk_count);

  a.ws.send(JSON.stringify({ type: 'query', min_us: 20, max_us: 10 }));
  let error;
  while (!error) {
    const message = await a.next();
    if (typeof message === 'string') error = JSON.parse(message);
  }
  assert.equal(error.type, 'error');
});


test('invalid and explicitly empty settings exit cleanly before serving', {
  skip: !process.env.PELORUS_SERVER_BIN,
  timeout: 10_000,
}, async () => {
  for (const overrides of [{ PELORUS_HZ: '' }, { PELORUS_HZ: 'NaN' }, { PELORUS_HZ: '0' },
    { PELORUS_CHUNK_INTERVAL_US: '-1' }, { PELORUS_MAX_CHUNKS: '0' }, { PELORUS_MAX_ROWS: '0' }, { PELORUS_OBJECTS: '0' }]) {
    const server = spawn(resolve(process.env.PELORUS_SERVER_BIN), [], {
      env: { ...process.env, TOKIO_WORKER_THREADS: '2', PELORUS_OBJECTS: '3', PELORUS_HZ: '1',
        PELORUS_MAX_ROWS: '30', ...overrides }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    server.stdout.on('data', data => { log += data; });
    server.stderr.on('data', data => { log += data; });
    const [code] = await once(server, 'exit');
    assert.equal(code, 1, JSON.stringify(overrides));
    assert.ok(!log.includes('panicked'), log);
    assert.ok(!log.includes('pelorus server listening'), log);
  }
});
