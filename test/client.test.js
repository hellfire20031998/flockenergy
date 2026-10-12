import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PortalClient } from '../src/portal/client.js';
import { PortalAuthError, PortalNotFoundError, PortalRateLimitError } from '../src/portal/errors.js';

const COOKIE = '__Secure-better-auth.session_token=tok.sig; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax';

function jsonResponse(status, body, headers = {}) {
  const h = new Headers(headers);
  return {
    status, ok: status >= 200 && status < 300, headers: h,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}
function loginOk() { return jsonResponse(200, { type: 'redirect', status: 303, location: '/meters' }, { 'set-cookie': COOKIE }); }

function makeClient(script, opts = {}) {
  const calls = [];
  let clock = 1_000_000;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const next = script.shift();
    if (!next) throw new Error(`unexpected request ${url}`);
    return typeof next === 'function' ? next(url, init) : next;
  };
  const client = new PortalClient({
    baseUrl: 'https://portal.test', email: 'e', password: 'p', minIntervalMs: 0,
    logger: { info() {}, warn() {}, error() {} }, fetchImpl,
    now: () => clock, sleepImpl: async (ms) => { clock += ms; }, ...opts,
  });
  return { client, calls, tick: (ms) => { clock += ms; } };
}

test('login posts a form with email/password and the Origin header, then stores the cookie', async () => {
  const { client, calls } = makeClient([loginOk()]);
  await client.login();
  assert.equal(calls[0].url, 'https://portal.test/login');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.origin, 'https://portal.test');
  assert.equal(String(calls[0].init.body), 'email=e&password=p');
  assert.equal(client.session.loggedIn, true);
  assert.equal(client.session.expiresAt, new Date(1_000_000 + 3_600_000).toISOString());
});

test('a failed login (HTTP 200 with type=failure) is an auth error', async () => {
  const { client } = makeClient([jsonResponse(200, { type: 'failure', status: 401, data: '[]' })]);
  await assert.rejects(client.login(), PortalAuthError);
});

test('a 403 from the CSRF check is reported as an auth error that mentions Origin', async () => {
  const { client } = makeClient([jsonResponse(403, 'Cross-site POST form submissions are forbidden')]);
  await assert.rejects(client.login(), /Origin/);
});

test('requests log in first and send the cookie', async () => {
  const { client, calls } = makeClient([loginOk(), jsonResponse(200, { data: [], total: 0, page: 1, pageSize: 20 })]);
  const res = await client.searchMeters('J10', 2);
  assert.equal(res.total, 0);
  assert.equal(calls[1].url, 'https://portal.test/portal/meters/search?q=J10&page=2');
  assert.equal(calls[1].init.headers.cookie, '__Secure-better-auth.session_token=tok.sig');
});

test('re-logs in proactively when the session is within 5 minutes of expiry', async () => {
  const { client, calls, tick } = makeClient([loginOk(), jsonResponse(200, { data: {} }), loginOk(), jsonResponse(200, { data: {} })]);
  await client.getGeo('J1');
  tick(56 * 60 * 1000);
  await client.getGeo('J1');
  assert.deepEqual(calls.map((c) => c.url.replace('https://portal.test', '')), ['/login', '/portal/meters/J1/geo', '/login', '/portal/meters/J1/geo']);
});

test('on a 401 it logs in again once and retries the request', async () => {
  const { client, calls } = makeClient([
    loginOk(),
    jsonResponse(401, { error: 'unauthorized', message: 'A valid session is required.' }),
    loginOk(),
    jsonResponse(200, { data: { latitude: '1', longitude: '2' } }),
  ]);
  const geo = await client.getGeo('J1');
  assert.deepEqual(geo, { latitude: '1', longitude: '2' });
  assert.equal(calls.filter((c) => c.url.endsWith('/login')).length, 2);
});

test('concurrent callers share one login (single-flight)', async () => {
  const { client, calls } = makeClient([loginOk(), jsonResponse(200, { data: {} }), jsonResponse(200, { data: {} }), jsonResponse(200, { data: {} })]);
  await Promise.all([client.getGeo('A'), client.getGeo('B'), client.getGeo('C')]);
  assert.equal(calls.filter((c) => c.url.endsWith('/login')).length, 1);
});

test('backs off and retries on 429, then gives up with a rate-limit error', async () => {
  const limited = () => jsonResponse(429, { error: 'rate_limited', message: 'slow down' });
  const { client } = makeClient([loginOk(), limited(), jsonResponse(200, { data: { ok: true } })]);
  assert.deepEqual(await client.getGeo('J1'), { ok: true });

  const { client: c2 } = makeClient([loginOk(), limited(), limited(), limited(), limited()]);
  await assert.rejects(c2.getGeo('J1'), PortalRateLimitError);
});

test('404 from the portal becomes a not-found error', async () => {
  const { client } = makeClient([loginOk(), jsonResponse(404, { error: 'not_found', message: 'Meter not found' })]);
  await assert.rejects(client.getGeo('J999999'), PortalNotFoundError);
});

test('export fetches the signing secret and sends x-timestamp / x-signature', async () => {
  const { client, calls } = makeClient([
    loginOk(),
    jsonResponse(200, { data: { signingSecret: 'secret' } }),
    jsonResponse(200, { data: [{ meterId: 'J1' }], total: 1 }),
  ]);
  const rows = await client.exportMeters();
  assert.equal(rows.length, 1);
  const exportCall = calls[2];
  assert.equal(exportCall.url, 'https://portal.test/portal/export');
  assert.match(exportCall.init.headers['x-timestamp'], /^\d+$/);
  assert.match(exportCall.init.headers['x-signature'], /^[0-9a-f]{64}$/);
});

test('energy passes from/to through and omits them when absent', async () => {
  const { client, calls } = makeClient([loginOk(), jsonResponse(200, { data: [] }), jsonResponse(200, { data: [] })]);
  await client.getEnergy('J1');
  await client.getEnergy('J1', { from: '2026-06-01', to: '2026-06-02' });
  assert.equal(calls[1].url, 'https://portal.test/portal/meters/J1/energy');
  assert.equal(calls[2].url, 'https://portal.test/portal/meters/J1/energy?from=2026-06-01&to=2026-06-02');
});

test('paces requests at least minIntervalMs apart', async () => {
  const { client, calls } = makeClient([loginOk(), jsonResponse(200, { data: {} }), jsonResponse(200, { data: {} })], { minIntervalMs: 1000 });
  let slept = 0;
  client.sleep = async (ms) => { slept += ms; };
  await client.getGeo('A');
  await client.getGeo('B');
  assert.equal(calls.length, 3);
  assert.ok(slept >= 1000, `expected to sleep >= 1000ms between requests, slept ${slept}`);
});
