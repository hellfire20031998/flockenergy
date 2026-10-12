import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { FixturePortalClient } from '../src/portal/fixtureClient.js';
import { SnapshotStore } from '../src/store/snapshot.js';

const silent = { info() {}, warn() {}, error() {} };
let app;

before(async () => {
  const config = loadConfig({ portal: { mode: 'fixtures', fixturesDir: 'fixtures', baseUrl: '', email: '', password: '', minIntervalMs: 0 } });
  const store = new SnapshotStore({ client: new FixturePortalClient({ fixturesDir: config.portal.fixturesDir }), logger: silent });
  await store.load();
  app = await buildServer({ config, store, logger: false });
  await app.ready();
});
after(async () => app.close());

const get = async (url) => {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() };
};

test('GET /health reports a loaded snapshot', async () => {
  const { status, body } = await get('/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.snapshot.meters, 403);
});

test('GET /meters paginates and filters', async () => {
  let r = await get('/meters?pageSize=5');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.length, 5);
  assert.equal(r.body.total, 403);
  assert.equal(r.body.totalPages, 81);
  assert.equal(typeof r.body.data[0].location.lat, 'number');

  r = await get('/meters?installStatus=faulty&phaseType=three&make=genus');
  assert.equal(r.body.total, 7);
  assert.ok(r.body.data.every((m) => m.installStatus === 'faulty' && m.phaseType === 'three' && m.make === 'Genus'));

  r = await get('/meters?dtCode=dt-007');
  assert.equal(r.body.total, 13);

  r = await get('/meters?feederCode=F-001');
  assert.equal(r.body.total, 20);

  r = await get('/meters?q=l%2684997');
  assert.equal(r.body.total, 1);
  assert.equal(r.body.data[0].id, 'J100003');
});

test('GET /meters validates its query', async () => {
  let r = await get('/meters?page=0');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'bad_request');
  r = await get('/meters?installStatus=broken');
  assert.equal(r.status, 400);
  r = await get('/meters?pageSize=10000');
  assert.equal(r.status, 400);
});

test('GET /meters/:id merges nameplate, hierarchy, transformer and issues', async () => {
  const { status, body } = await get('/meters/j100044');
  assert.equal(status, 200);
  assert.equal(body.id, 'J100044');
  assert.equal(body.hierarchy.feeder.code, null);
  assert.equal(body.resolvedHierarchy.feeder.code, 'F-005');
  assert.equal(body.transformer.capacityKva, 63);
  assert.equal(body.issues.length, 1);
  assert.equal(body.issues[0].type, 'blank_hierarchy_field');
});

test('GET /meters/:id -> 404 for unknown ids', async () => {
  const { status, body } = await get('/meters/J999999');
  assert.equal(status, 404);
  assert.deepEqual(body, { error: 'not_found', message: 'No meter J999999' });
});

test('GET /meters/:id/readings returns normalised readings and reports dropped rows', async () => {
  const { status, body } = await get('/meters/J100089/readings');
  assert.equal(status, 200);
  assert.equal(body.cadence, 'daily');
  assert.equal(body.readings.length, 8);
  assert.equal(body.dropped.length, 1);
  assert.match(body.readings[0].timestamp, /\+05:30$/);
  assert.equal(body.summary.totalKwh, 53.51);
});

test('GET /meters/:id/readings honours from/to and rejects bad ranges', async () => {
  let r = await get('/meters/J100000/readings?from=2026-06-28&to=2026-06-29');
  assert.equal(r.status, 200);
  assert.equal(r.body.readings.length, 96);
  assert.equal(r.body.summary.from, '2026-06-28T00:00:00+05:30');

  r = await get('/meters/J100000/readings?from=2026-06-29&to=2026-06-28');
  assert.equal(r.status, 400);
  r = await get('/meters/J100000/readings?from=28/06/2026');
  assert.equal(r.status, 400);
  r = await get('/meters/J999999/readings');
  assert.equal(r.status, 404);
});

test('GET /transformers and /transformers/:code', async () => {
  let r = await get('/transformers');
  assert.equal(r.body.total, 40);
  r = await get('/transformers?feederCode=F-001');
  assert.deepEqual(r.body.data.map((t) => t.code), ['DT-001', 'DT-029']);
  r = await get('/transformers/DT-007');
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Sanganer DT 7');
  assert.equal(r.body.meters.length, 13);
  assert.equal(r.body.hierarchy.feeder.code, 'F-007');
  r = await get('/transformers/DT-999');
  assert.equal(r.status, 404);
});

test('GET /network returns the tree and /network/issues the findings', async () => {
  let r = await get('/network');
  assert.equal(r.status, 200);
  assert.equal(r.body.stats.transformers, 40);
  assert.equal(r.body.tree.length, 3);
  assert.equal(r.body.tree[0].level, 'zone');

  r = await get('/network/issues?type=conflicting_hierarchy_name');
  assert.equal(r.body.total, 3);
  r = await get('/network/issues?severity=warning');
  assert.equal(r.body.total, 25);
  r = await get('/network/issues?severity=loud');
  assert.equal(r.status, 400);
});

test('unknown routes return the standard error shape', async () => {
  const { status, body } = await get('/nothing/here');
  assert.equal(status, 404);
  assert.equal(body.error, 'not_found');
});

test('serves the OpenAPI document and the docs UI', async () => {
  const spec = await get('/openapi.json');
  assert.equal(spec.status, 200);
  assert.equal(spec.body.openapi, '3.1.0');
  assert.ok(spec.body.paths['/meters/{id}/readings']);
  const ui = await app.inject({ method: 'GET', url: '/docs/' });
  assert.equal(ui.statusCode, 200);
});
