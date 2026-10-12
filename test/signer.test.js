import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { canonicalString, signRequest } from '../src/portal/signer.js';

test('canonical string is METHOD, path, query, timestamp joined by newlines', () => {
  assert.equal(canonicalString({ method: 'get', path: '/portal/export', query: 'page=1', timestamp: 1791785230 }), 'GET\n/portal/export\npage=1\n1791785230');
});

test('empty query string is kept as an empty line, exactly like the portal frontend', () => {
  assert.equal(canonicalString({ method: 'GET', path: '/portal/export', query: '', timestamp: 1 }), 'GET\n/portal/export\n\n1');
});

test('signature is hex HMAC-SHA256 of the canonical string', () => {
  const secret = 'I3dZPPexamplesecret';
  const { timestamp, signature } = signRequest({ path: '/portal/export', query: 'page=1', secret, timestamp: 1791785230 });
  const expected = createHmac('sha256', secret).update('GET\n/portal/export\npage=1\n1791785230').digest('hex');
  assert.equal(timestamp, '1791785230');
  assert.equal(signature, expected);
  assert.match(signature, /^[0-9a-f]{64}$/);
});

test('defaults the timestamp to now in unix seconds', () => {
  const before = Math.floor(Date.now() / 1000);
  const { timestamp } = signRequest({ path: '/portal/export', secret: 's' });
  assert.ok(Number(timestamp) >= before && Number(timestamp) <= before + 2);
});

test('refuses to sign without a secret', () => {
  assert.throws(() => signRequest({ path: '/portal/export', secret: '' }), /secret/);
});
