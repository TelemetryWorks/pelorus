import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { PositionBuffer } from '../src/buffer.ts';
import * as protocol from '../src/protocol.ts';
import { decodeBatch } from '../src/decode.ts';
import { tableFromArrays, tableToIPC } from 'apache-arrow';

function append(buffer, times, ids = times.map(() => 'A')) {
  const n = times.length;
  buffer.append(BigInt64Array.from(times, BigInt), Float64Array.from(times), new Float64Array(n), null, null, null, Array(n).fill('alpha'), ids);
}

test('history merges chronologically and preserves accurate bounds', () => {
  const buffer = new PositionBuffer({ maxRows: 10 });
  append(buffer, [100, 200]);
  append(buffer, [10, 20]);
  assert.deepEqual(buffer.timeRange, [10, 200]);
  assert.deepEqual([...buffer.timestamps], [10, 20, 100, 200]);
});

test('overlapping queries deduplicate by object and timestamp', () => {
  const buffer = new PositionBuffer({ maxRows: 10 });
  append(buffer, [100, 200]);
  append(buffer, [100, 100, 200], ['A', 'B', 'A']);
  assert.equal(buffer.length, 3);
});

test('eviction retains newest rows even for oversized old history', () => {
  const buffer = new PositionBuffer({ maxRows: 3 });
  append(buffer, [100, 200]);
  append(buffer, [1, 2, 3, 4]);
  assert.deepEqual([...buffer.timestamps], [4, 100, 200]);
});

// Run the actual entry point with deterministic socket/DOM/timer boundaries.
// No browser/GPU is needed to exercise its request and reconnect behavior.
function client(maxRows = 4) {
  const timers = [];
  const logs = [];
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    static instances = [];
    readyState = 1;
    sent = [];
    handlers = {};
    constructor() { Socket.instances.push(this); }
    addEventListener(type, callback) { this.handlers[type] = callback; }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.emit('close', { code: 1006 }); }
    emit(type, data) { if (type === "close") this.readyState = 3; this.handlers[type]?.(data); }
  }
  const element = () => ({ querySelector: element, classList: { add() {}, remove() {} }, addEventListener() {}, appendChild(entry) { logs.push(entry.textContent); }, childElementCount: 0 });
  const code = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').replace(/^import[\s\S]*?from ["'][^"']+["'];/gm, '').replace('const BUFFER_MAX_ROWS = 1_200_000;', `const BUFFER_MAX_ROWS = ${maxRows};`);
  const context = vm.createContext({
    ...protocol, PositionBuffer, decodeBatch, WebSocket: Socket, window: { location: { host: 'test' } },
    document: { getElementById: element, createElement: element },
    initTheme() {}, toggleTheme() {}, getTheme: () => 'dark',
    MapRenderer: class { setBuffer(buffer) { this.buffer = buffer; } setFilterRange() {} markDataDirty() {} },
    TimeSlider: class { mode = "live"; setServerRange() {} setBufferRange() {} },
    PerfMonitor: class { recordBatch() {} setBufferRows() {} },
    setInterval() {}, setTimeout(callback) { timers.push(callback); return timers.length; },
    clearTimeout(id) { timers[id - 1] = null; }, requestAnimationFrame() {},
    ArrayBuffer, console,
  });
  vm.runInContext(transformSync(code, { loader: 'ts', target: 'es2022' }).code, context);
  return { logs, socket: () => Socket.instances.at(-1), run: code => vm.runInContext(code, context), expire: () => timers.find(Boolean)?.() };
}

test('disconnect clears in-flight query, pending frames and range dedup', () => {
  const c = client();
  c.run('requestHistoricalChunks(10, 20)');
  c.socket().emit('message', { data: JSON.stringify({ type: 'query_response', chunk_count: 2, total_rows: 8, min_us: 10, max_us: 20 }) });
  c.socket().emit('close', { code: 1006 });
  c.run('connect()');
  c.socket().emit('open');
  c.run('requestHistoricalChunks(10, 20)');
  assert.equal(c.socket().sent.filter(m => m.type === 'query').length, 1);
});

test('empty reply and error permit retrying the same range', () => {
  for (const reply of [{ type: 'query_response', chunk_count: 0, total_rows: 0, min_us: 10, max_us: 20 }, { type: 'error', message: 'retry' }]) {
    const c = client();
    c.run('requestHistoricalChunks(10, 20)');
    c.socket().emit('message', { data: JSON.stringify(reply) });
    c.run('requestHistoricalChunks(10, 20)');
    assert.equal(c.socket().sent.filter(m => m.type === 'query').length, 2);
  }
});

function frame(times, ids = times.map(() => 'A')) {
  const bytes = tableToIPC(tableFromArrays({
    timestamp_us: BigInt64Array.from(times, BigInt), object_id: ids,
    longitude: Float64Array.from(times), latitude: new Float64Array(times.length),
  }), 'stream');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
function text(c, msg) { c.socket().emit('message', { data: JSON.stringify(msg) }); }
function binary(c, times) { c.socket().emit('message', { data: frame(times) }); }
function header(c, min, max, count, rows) {
  text(c, { type: 'query_response', min_us: min, max_us: max, chunk_count: count, total_rows: rows });
}

test('real Arrow IPC history remains viewable with a full live buffer', () => {
  const c = client();
  binary(c, [100, 200, 300, 400]);
  c.run('timeSlider.mode = "scrub"; filterRange = [10, 20]; requestHistoricalChunks(10, 20)');
  header(c, 10, 20, 2, 4);
  binary(c, [20, 10]);
  binary(c, [10, 20]);
  assert.equal(c.run('historyBuffer.length'), 2);
  assert.deepEqual(Array.from(c.run('map.buffer.timeRange')), [10, 20]);
  binary(c, [500]);
  assert.deepEqual(Array.from(c.run('buffer.timeRange')), [200, 500]);
  assert.deepEqual(Array.from(c.run('map.buffer.timeRange')), [10, 20]);
  c.run('timeSlider.mode = "live"; selectView()');
  assert.deepEqual(Array.from(c.run('map.buffer.timeRange')), [200, 500]);
});

test('only the latest scrub range queues; live before header stays live', () => {
  const c = client();
  c.run('requestHistoricalChunks(10, 20); requestHistoricalChunks(30, 40); requestHistoricalChunks(50, 60)');
  binary(c, [100]);
  assert.equal(c.run('buffer.length'), 1);
  header(c, 10, 20, 1, 1);
  binary(c, [10]);
  assert.deepEqual(c.socket().sent.filter(m => m.type === 'query').map(m => m.min_us), [10, 50]);
  header(c, 50, 60, 1, 1);
  binary(c, [50]);
  assert.equal(c.run('queryInFlight'), false);
  binary(c, [200]);
  assert.deepEqual(Array.from(c.run('buffer.timestamps')), [100, 200]);
});

test('decode failure disconnects, discards frame state and permits retry', () => {
  const c = client();
  c.run('requestHistoricalChunks(10, 20)');
  header(c, 10, 20, 2, 2);
  c.socket().emit('message', { data: new ArrayBuffer(3) });
  assert.equal(c.socket().readyState, 3);
  assert.equal(c.run('queryInFlight'), false);
  assert.equal(c.run('pendingQueryChunks'), 0);
  c.run('connect(); requestHistoricalChunks(10, 20)');
  assert.equal(c.socket().sent.filter(m => m.type === 'query').length, 1);
});

test('request bounds normalize to integers; invalid bounds send nothing', () => {
  const c = client();
  c.run('requestHistoricalChunks(NaN, 2); requestHistoricalChunks(10, 2); requestHistoricalChunks(0, Infinity)');
  assert.equal(c.socket().sent.length, 0);
  c.run('requestHistoricalChunks(1.2, 2.8)');
  assert.deepEqual(c.socket().sent[0], { type: 'query', min_us: 1, max_us: 3 });
});

test('protocol parser rejects malformed headers and accepts real metadata', () => {
  for (const value of [null, {}, { type: 'error' }, { type: 'query_response', min_us: 2, max_us: 1, chunk_count: 1, total_rows: 1 },
    { type: 'query_response', min_us: 1, max_us: 2, chunk_count: -1, total_rows: 1 },
    { type: 'query_response', min_us: 1, max_us: 2, chunk_count: 0, total_rows: 1 }]) {
    assert.equal(protocol.parseServerMessage(JSON.stringify(value)), null);
  }
  const meta = { type: 'meta', chunk_count: 0, total_rows: 0, min_us: 0, max_us: 0, chunk_interval_us: 5_000_000 };
  assert.deepEqual(protocol.parseServerMessage(JSON.stringify(meta)), meta);
});

test('buffer rejects empty settings and mismatched columns; empty batch is harmless', () => {
  for (const maxRows of [0, -1, NaN, 1.5]) assert.throws(() => new PositionBuffer({ maxRows }), RangeError);
  const buffer = new PositionBuffer({ maxRows: 3 });
  append(buffer, []);
  assert.equal(buffer.timeRange, null);
  assert.throws(() => append(buffer, [1, 2], ['A']), RangeError);
});

test('response timeout closes the socket and clears pending state', () => {
  const c = client();
  c.run('requestHistoricalChunks(10, 20)');
  c.expire();
  assert.equal(c.socket().readyState, 3);
  assert.equal(c.run('queryInFlight'), false);
  assert.equal(c.run('pendingQueryChunks'), 0);
});

test('error advances only the latest queued request', () => {
  const c = client();
  c.run('requestHistoricalChunks(10, 20); requestHistoricalChunks(30, 40); requestHistoricalChunks(50, 60)');
  text(c, { type: 'error', message: 'retry' });
  assert.deepEqual(c.socket().sent.filter(m => m.type === 'query').map(m => m.min_us), [10, 50]);
});

test('stale socket events cannot poison a reconnected request', () => {
  const c = client();
  c.run('requestHistoricalChunks(10, 20)');
  const old = c.socket();
  old.close();
  c.run('connect(); requestHistoricalChunks(30, 40)');
  old.emit('message', { data: JSON.stringify({ type: 'query_response', min_us: 10, max_us: 20, chunk_count: 1, total_rows: 1 }) });
  assert.equal(c.socket().readyState, 1);
  assert.equal(c.run('pendingQueryChunks'), 0);
  header(c, 30, 40, 1, 1);
  binary(c, [30]);
  assert.equal(c.run('queryInFlight'), false);
});

test('mismatched row counts and malformed frames close the connection', () => {
  const c = client();
  c.run('requestHistoricalChunks(10, 20)');
  header(c, 10, 20, 1, 2);
  binary(c, [10]);
  assert.equal(c.socket().readyState, 3);
  c.run('connect()');
  text(c, { type: 'query_response', min_us: 10, max_us: 20, chunk_count: -1, total_rows: 1 });
  assert.equal(c.socket().readyState, 3);
});

test('completed history cannot replace a newer live selection', () => {
  const c = client();
  binary(c, [100, 200]);
  c.run('timeSlider.mode = "scrub"; filterRange = [150, 180]; requestHistoricalChunks(10, 20)');
  header(c, 10, 20, 1, 1);
  binary(c, [10]);
  assert.deepEqual(Array.from(c.run('map.buffer.timeRange')), [100, 200]);
});

test('historical merge keeps all numeric columns aligned and existing duplicates win', () => {
  const b = new PositionBuffer({ maxRows: 3 });
  const put = (times, values) => b.append(BigInt64Array.from(times, BigInt), Float64Array.from(values),
    Float64Array.from(values, n => n + 1), Float64Array.from(values, n => n + 2),
    Float64Array.from(values, n => n + 3), Float64Array.from(values, n => n + 4), times.map(() => 'alpha'), times.map(() => 'A'));
  put([100, 200], [10, 20]);
  put([50, 100, 150], [5, 999, 15]);
  assert.deepEqual([...b.timestamps], [100, 150, 200]);
  assert.deepEqual([...b.longitudes], [10, 15, 20]);
  assert.deepEqual([...b.latitudes], [11, 16, 21]);
  assert.deepEqual([...b.altitudes], [12, 17, 22]);
  assert.deepEqual([...b.speeds], [13, 18, 23]);
  assert.deepEqual([...b.headings], [14, 19, 24]);
});

test('renderer switches view and removes stale cached points when cleared', () => {
  const source = readFileSync(new URL('../src/map.ts', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?from ["'][^"']+["'];/gm, '').replace(/^export /gm, '');
  let props;
  const context = vm.createContext({
    PositionBuffer, performance, getTheme: () => 'dark',
    Deck: class { setProps(value) { props = value; } }, MapView: class {},
    ScatterplotLayer: class { constructor(config) { Object.assign(this, config); } },
    DataFilterExtension: class {},
    BaseMap: class { load() { return Promise.resolve(); } getLayers() { return []; } },
  });
  vm.runInContext(transformSync(source, { loader: 'ts', target: 'es2022' }).code, context);
  const live = new PositionBuffer({ maxRows: 3 });
  const history = new PositionBuffer({ maxRows: 3 });
  append(live, [100, 200]); append(history, [10]);
  context.live = live; context.history = history;
  vm.runInContext('const map = new MapRenderer({ container: {} }); map.setBuffer(live); map.update()', context);
  assert.equal(props.layers[0].data.length, 2);
  vm.runInContext('map.setBuffer(history); map.update()', context);
  assert.equal(props.layers[0].data.length, 1);
  assert.equal(props.layers[0].data.attributes.getPosition.value[0], 10);
  history.clear();
  vm.runInContext('map.markDataDirty(); map.update()', context);
  assert.equal(props.layers.length, 0);
});


test('socket error resets active query before reconnect', () => {
  const c = client();
  c.run('requestHistoricalChunks(10, 20)');
  header(c, 10, 20, 2, 2);
  c.socket().emit('error');
  assert.equal(c.run('queryInFlight'), false);
  assert.equal(c.run('pendingQueryChunks'), 0);
  assert.equal(c.socket().readyState, 3);
});


test('history view includes live rows where the requested window crosses retention', () => {
  const c = client();
  binary(c, [100, 200, 300, 400]);
  c.run('timeSlider.mode = "scrub"; filterRange = [50, 150]; requestHistoricalChunks(50, 150)');
  header(c, 50, 150, 1, 1);
  binary(c, [50]);
  assert.deepEqual(Array.from(c.run('map.buffer.timestamps')), [50, 100]);
  assert.deepEqual(Array.from(c.run('buffer.timestamps')), [100, 200, 300, 400]);
});

test('empty archive response still displays retained live rows within the window', () => {
  const c = client();
  binary(c, [100, 200, 300, 400]);
  c.run('timeSlider.mode = "scrub"; filterRange = [50, 150]; requestHistoricalChunks(50, 150)');
  header(c, 50, 150, 0, 0);
  assert.deepEqual(Array.from(c.run('map.buffer.timestamps')), [100]);
  c.run('requestHistoricalChunks(50, 150)');
  assert.equal(c.socket().sent.filter(m => m.type === 'query').length, 2);
});

test('post-query live reset keeps history and coverage while clearing only live continuity', () => {
  const c = client();
  binary(c, [100, 200]);
  c.run('timeSlider.mode = "scrub"; filterRange = [10, 20]; requestHistoricalChunks(10, 20)');
  header(c, 10, 20, 1, 2);
  binary(c, [10, 20]);
  text(c, { type: 'live_reset', skipped_frames: 4 });
  assert.equal(c.socket().readyState, 1);
  assert.equal(c.run('buffer.length'), 0);
  assert.ok(c.logs.some(log => log.includes('4 frames skipped') && log.includes('oldest retained')));
  assert.deepEqual(Array.from(c.run('map.buffer.timestamps')), [10, 20]);
  c.run('requestHistoricalChunks(10, 20)');
  assert.equal(c.socket().sent.filter(m => m.type === 'query').length, 1);
  binary(c, [300]);
  assert.deepEqual(Array.from(c.run('buffer.timestamps')), [300]);
  assert.deepEqual(Array.from(c.run('map.buffer.timestamps')), [10, 20]);
});


test('malformed live reset markers close the connection', () => {
  for (const skipped_frames of [undefined, null, 0, -1, 1.5, '4', 9007199254740992]) {
    const c = client();
    c.run('requestHistoricalChunks(10, 20)');
    header(c, 10, 20, 0, 0);
    text(c, { type: 'live_reset', skipped_frames });
    assert.equal(c.socket().readyState, 3);
  }
  assert.equal(protocol.parseServerMessage('{"type":"live_reset","skipped_frames":4,"other":true}'), null);
});

test('live reset is allowed once only before the first post-query live frame', () => {
  for (const scenario of ['no-query', 'partial-query', 'normal-live', 'duplicate']) {
    const c = client();
    if (scenario !== 'no-query') {
      c.run('requestHistoricalChunks(10, 20)');
      header(c, 10, 20, 1, 2);
      if (scenario !== 'partial-query') binary(c, [10, 20]);
    }
    if (scenario === 'normal-live') binary(c, [100]);
    if (scenario === 'duplicate') text(c, { type: 'live_reset', skipped_frames: 4 });
    text(c, { type: 'live_reset', skipped_frames: 4 });
    assert.equal(c.socket().readyState, 3, scenario);
  }
});

test('real disconnect after a live reset still clears completed history', () => {
  const c = client();
  c.run('requestHistoricalChunks(10, 20)');
  header(c, 10, 20, 1, 2);
  binary(c, [10, 20]);
  text(c, { type: 'live_reset', skipped_frames: 4 });
  assert.equal(c.run('historyBuffer.length'), 2);
  c.socket().close();
  assert.equal(c.run('historyBuffer.length'), 0);
  assert.equal(c.run('loadedRange'), null);
});


test('previous query marker preserves completed view and next request awaiting its header', () => {
  const c = client();
  binary(c, [100, 200]);
  c.run('timeSlider.mode = "scrub"; filterRange = [10, 20]; requestHistoricalChunks(10, 20)');
  header(c, 10, 20, 1, 2);
  binary(c, [10, 20]);
  c.run('requestHistoricalChunks(30, 40)');
  text(c, { type: 'live_reset', skipped_frames: 4 });
  assert.equal(c.socket().readyState, 1);
  assert.equal(c.run('queryInFlight'), true);
  assert.equal(c.run('pendingQueryChunks'), 0);
  assert.deepEqual(Array.from(c.run('activeRange')), [30, 40]);
  assert.deepEqual(Array.from(c.run('loadedRange')), [10, 20]);
  assert.deepEqual(Array.from(c.run('map.buffer.timestamps')), [10, 20]);
  assert.equal(c.run('buffer.length'), 0);
  header(c, 30, 40, 1, 1);
  binary(c, [30]);
  assert.equal(c.run('queryInFlight'), false);
});

test('wide query does not cache the missing live-reset gap as archived coverage', () => {
  const c = client(10);
  binary(c, [100]);
  c.run('timeSlider.mode = "scrub"; filterRange = [0, 200]; requestHistoricalChunks(0, 200)');
  header(c, 0, 200, 1, 1);
  binary(c, [50]);
  assert.deepEqual(Array.from(c.run('loadedRange')), [50, 50]);
  text(c, { type: 'live_reset', skipped_frames: 4 });
  assert.deepEqual(Array.from(c.run('loadedRange')), [50, 50]);
  binary(c, [150]);
  assert.deepEqual(Array.from(c.run('map.buffer.timestamps')), [50, 100]);
  c.run('requestHistoricalChunks(110, 120)');
  assert.equal(c.socket().sent.filter(m => m.type === 'query').length, 2);
});

for (const [min, max] of [[100, 100], [110, 120]]) {
  test(`wide query leaves live-only/open-tail [${min}, ${max}] queryable`, () => {
    const c = client(10);
    binary(c, [100]);
    c.run('requestHistoricalChunks(0, 200)');
    header(c, 0, 200, 1, 1);
    binary(c, [50]);
    c.run(`requestHistoricalChunks(${min}, ${max})`);
    assert.equal(c.socket().sent.filter(m => m.type === 'query').length, 2, `[${min}, ${max}] must requery`);
  });
}


test('coverage caches only the intersection of requested and archived bounds', () => {
  const c = client(10);
  c.run('requestHistoricalChunks(15, 25)');
  header(c, 15, 25, 1, 3);
  binary(c, [10, 20, 30]);
  assert.deepEqual(Array.from(c.run('loadedRange')), [15, 25]);
  c.run('requestHistoricalChunks(16, 24)');
  assert.equal(c.socket().sent.filter(m => m.type === 'query').length, 1);
  c.run('requestHistoricalChunks(14, 15)');
  assert.equal(c.socket().sent.filter(m => m.type === 'query').length, 2);
});

test('truncated archive or archive plus live rows never caches coverage', () => {
  for (const live of [[], [30]]) {
    const c = client(2);
    if (live.length) binary(c, live);
    c.run('requestHistoricalChunks(0, 100)');
    const times = live.length ? [10, 20] : [10, 20, 30];
    header(c, 0, 100, 1, times.length);
    binary(c, times);
    assert.equal(c.run('loadedRange'), null);
    assert.equal(c.run('historyBuffer.length'), 2);
    c.run('requestHistoricalChunks(20, 20)');
    assert.equal(c.socket().sent.filter(m => m.type === 'query').length, 2);
  }
});
