import { createHmac } from 'node:crypto';

export function canonicalString({ method, path, query, timestamp }) {
  return [method.toUpperCase(), path, query ?? '', String(timestamp)].join('\n');
}

export function signRequest({ method = 'GET', path, query = '', secret, timestamp = Math.floor(Date.now() / 1000) }) {
  if (!secret) throw new Error('signing secret is required');
  const ts = String(timestamp);
  const signature = createHmac('sha256', secret)
    .update(canonicalString({ method, path, query, timestamp: ts }))
    .digest('hex');
  return { timestamp: ts, signature };
}
