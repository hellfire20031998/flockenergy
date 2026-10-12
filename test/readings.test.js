import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parsePortalTimestamp, normaliseReadings } from '../src/normalise/readings.js';

const fixture = (id) => JSON.parse(fs.readFileSync(new URL(`../fixtures/energy/${id}.json`, import.meta.url))).data;

test('parses day-first timestamps as IST', () => {
  const t = parsePortalTimestamp('23/06/2026 23:30');
  assert.equal(t.iso, '2026-06-23T23:30:00+05:30');
  assert.equal(new Date(t.epoch).toISOString(), '2026-06-23T18:00:00.000Z');
});

test('rejects garbage and impossible dates', () => {
  assert.equal(parsePortalTimestamp('2026-06-23T23:30'), null);
  assert.equal(parsePortalTimestamp('31/02/2026 00:00'), null);
  assert.equal(parsePortalTimestamp(''), null);
  assert.equal(parsePortalTimestamp(undefined), null);
});

test('converts strings to numbers and computes per-interval consumption', () => {
  const out = normaliseReadings([
    { timestamp: '24/06/2026 00:00', kwh: '100', kvah: '110', voltR: '230' },
    { timestamp: '24/06/2026 00:30', kwh: '100.42', kvah: '110.45', voltR: '229' },
    { timestamp: '24/06/2026 01:00', kwh: '100.85', kvah: '110.91', voltR: '231' },
  ]);
  assert.equal(out.cadence, '30min');
  assert.equal(out.readings[0].intervalKwh, null);
  assert.equal(out.readings[1].intervalMinutes, 30);
  assert.equal(out.readings[1].intervalKwh, 0.42);
  assert.equal(out.readings[2].intervalKwh, 0.43);
  assert.equal(typeof out.readings[0].kwh, 'number');
  assert.equal(out.summary.totalKwh, 0.85);
  assert.equal(out.dropped.length, 0);
});

test('sorts out-of-order rows and flags a register that goes backwards', () => {
  const out = normaliseReadings([
    { timestamp: '25/06/2026 00:00', kwh: '50', kvah: '55', voltR: '230' },
    { timestamp: '24/06/2026 00:00', kwh: '100', kvah: '110', voltR: '230' },
  ]);
  assert.deepEqual(out.readings.map((r) => r.timestamp), ['2026-06-24T00:00:00+05:30', '2026-06-25T00:00:00+05:30']);
  assert.deepEqual(out.readings[1].anomalies, ['register_decrease']);
  assert.equal(out.cadence, 'daily');
});

test('drops the portal\'s corrupt trailing row and says why (real fixture J100089)', () => {
  const out = normaliseReadings(fixture('J100089'));
  assert.equal(out.readings.length, 8);
  assert.equal(out.cadence, 'daily');
  assert.equal(out.dropped.length, 1);
  assert.equal(out.dropped[0].index, 8);
  assert.equal(out.dropped[0].timestamp, '30/06/2026 00:00');
  assert.deepEqual(out.dropped[0].reasons, ['missing_kwh', 'duplicate_timestamp']);
});

test('half-hourly fixture J100000 keeps all 337 rows and a 7-day window', () => {
  const out = normaliseReadings(fixture('J100000'));
  assert.equal(out.readings.length, 337);
  assert.equal(out.cadence, '30min');
  assert.equal(out.summary.from, '2026-06-23T23:30:00+05:30');
  assert.equal(out.summary.to, '2026-06-30T23:30:00+05:30');
  assert.ok(out.summary.averageDailyKwh > 19 && out.summary.averageDailyKwh < 22);
});

test('empty input gives an empty, well-formed result', () => {
  const out = normaliseReadings([]);
  assert.equal(out.cadence, 'unknown');
  assert.deepEqual(out.readings, []);
  assert.equal(out.summary.count, 0);
  assert.equal(out.summary.totalKwh, null);
});
