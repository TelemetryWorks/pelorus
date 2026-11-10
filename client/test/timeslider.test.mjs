import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimeSlider } from '../src/timeslider.ts';

function slider() {
  const nodes = new Map();
  const element = () => ({ value: '1000', textContent: '',
    classList: { add() {}, remove() {} }, handlers: {},
    addEventListener(type, callback) { this.handlers[type] = callback; },
  });
  const container = { innerHTML: '', querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  } };
  const ranges = [], queries = [];
  const control = new TimeSlider({ container,
    onRangeChange: (min, max) => ranges.push([min, max]),
    onScrubBeyondBuffer: (min, max) => queries.push([min, max]),
  });
  return { control, ranges, queries, input(selector, value, event = 'input') {
    const el = nodes.get(selector); el.value = value; el.handlers[event]();
  } };
}

test('scrubbing requests the visible window, not the gap to live retention', () => {
  const s = slider();
  s.control.setBufferRange(100_000_000, 200_000_000);
  s.control.setServerRange(10_000_000, 150_000_000);
  assert.equal(s.queries.length, 0);
  s.input('.ts-slider', '0');
  assert.deepEqual(s.queries.at(-1), [9_500_000, 10_500_000]);
  s.input('.ts-window', '100');
  assert.deepEqual(s.queries.at(-1), [-5_000_000, 25_000_000]);
});

test('LIVE immediately follows latest live time without waiting for another frame', () => {
  const s = slider();
  s.control.setBufferRange(100_000_000, 200_000_000);
  s.control.setServerRange(10_000_000, 150_000_000);
  s.input('.ts-slider', '0');
  s.input('.ts-mode', '', 'click');
  assert.equal(s.control.mode, 'live');
  assert.deepEqual(s.ranges.at(-1), [199_500_000, 200_500_000]);
});
