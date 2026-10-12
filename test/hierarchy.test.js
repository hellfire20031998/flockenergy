import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normaliseMeter, normaliseTransformer } from '../src/normalise/meters.js';
import { buildNetwork } from '../src/normalise/hierarchy.js';

const exportRecords = JSON.parse(fs.readFileSync(new URL('../fixtures/export.json', import.meta.url))).data;
const dtRows = JSON.parse(fs.readFileSync(new URL('../fixtures/dts.json', import.meta.url)));

const meters = exportRecords.map(normaliseMeter);
const transformers = dtRows.map(normaliseTransformer);
const network = buildNetwork(meters, transformers);

test('normaliseMeter maps enums to lower_snake and blanks to null', () => {
  const m = normaliseMeter({
    meterId: 'J1', serialNo: 'S', make: 'HPL', phaseType: 'three', installStatus: 'Faulty', installType: 'CT Operated', build: 'v2', dtCode: 'DT-001',
    hierarchy: { zone: { name: 'Z', code: 'Z-01' }, feeder: { name: '', code: '' }, dt: { name: 'D', code: 'DT-001' } },
    geo: { lat: 26.9, lng: 75.8 },
  });
  assert.equal(m.installStatus, 'faulty');
  assert.equal(m.installType, 'ct_operated');
  assert.equal(m.phaseType, 'three');
  assert.deepEqual(m.hierarchy.feeder, { code: null, name: null });
  assert.deepEqual(m.hierarchy.circle, { code: null, name: null });
  assert.deepEqual(m.location, { lat: 26.9, lng: 75.8 });
});

test('finds the 22 blank hierarchy fields and resolves each from siblings', () => {
  const blanks = network.issues.filter((i) => i.type === 'blank_hierarchy_field');
  assert.equal(blanks.length, 22);
  const j100044 = blanks.find((i) => i.meterId === 'J100044');
  assert.equal(j100044.level, 'feeder');
  assert.equal(j100044.field, 'code');
  assert.equal(j100044.resolvedValue, 'F-005');
  assert.ok(blanks.every((i) => i.resolvedValue !== null));
});

test('flags the DT-007 name conflict on the three odd tail meters', () => {
  const conflicts = network.issues.filter((i) => i.type === 'conflicting_hierarchy_name');
  assert.deepEqual(conflicts.map((i) => i.meterId).sort(), ['J100400', 'J100401', 'J100402']);
  assert.equal(conflicts[0].value, 'Old Malviya Nagar Xfmr');
  assert.equal(conflicts[0].resolvedValue, 'Sanganer DT 7');
});

test('reports feeders F-001..F-012 as having two parent substations', () => {
  const feeders = network.issues.filter((i) => i.type === 'multiple_parents' && i.level === 'feeder');
  assert.equal(feeders.length, 12);
  assert.deepEqual(feeders.find((i) => i.code === 'F-001').parents, ['SS-01', 'SS-11']);
});

test('no orphans, no empty transformers, no feeder disagreements in this dataset', () => {
  for (const type of ['orphan_meter', 'empty_transformer', 'transformer_feeder_mismatch', 'conflicting_hierarchy_code']) {
    assert.equal(network.issues.filter((i) => i.type === type).length, 0, type);
  }
});

test('tree is keyed by path: F-001 appears under both of its substations', () => {
  const found = [];
  const walk = (node, path) => {
    if (node.level === 'feeder' && node.code === 'F-001') found.push(path);
    for (const c of node.children ?? []) walk(c, [...path, c.code]);
  };
  for (const z of network.tree) walk(z, [z.code]);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((p) => p[4]).sort(), ['SS-01', 'SS-11']);
});

test('every DT lands in the tree exactly once with its meters', () => {
  const dts = [];
  const walk = (node) => { if (node.level === 'dt') dts.push(node); for (const c of node.children ?? []) walk(c); };
  network.tree.forEach(walk);
  assert.equal(dts.length, 40);
  assert.equal(dts.reduce((n, d) => n + d.meterIds.length, 0), 403);
  const dt7 = dts.find((d) => d.code === 'DT-007');
  assert.equal(dt7.name, 'Sanganer DT 7');
  assert.equal(dt7.capacityKva, 63);
  assert.equal(dt7.meterCount, 13);
});

test('stats summarise the dataset', () => {
  assert.equal(network.stats.meters, 403);
  assert.equal(network.stats.transformers, 40);
  assert.equal(network.stats.feeders, 28);
  assert.equal(network.stats.substations, 18);
});
