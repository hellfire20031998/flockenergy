import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { PortalClient } from '../src/portal/client.js';

const config = loadConfig({ portal: { ...loadConfig().portal, mode: 'live' } });
const out = config.portal.fixturesDir;
fs.mkdirSync(path.join(out, 'energy'), { recursive: true });

const client = new PortalClient({ ...config.portal, logger: console });
const started = Date.now();

const meters = await client.exportMeters();
fs.writeFileSync(path.join(out, 'export.json'), JSON.stringify({ data: meters, total: meters.length }, null, 1) + '\n');
console.log(`export: ${meters.length} meters`);

const dts = await client.listTransformers();
fs.writeFileSync(path.join(out, 'dts.json'), JSON.stringify(dts, null, 1) + '\n');
console.log(`transformers: ${dts.length}`);

let done = 0;
for (const m of meters) {
  const rows = await client.getEnergy(m.meterId);
  fs.writeFileSync(path.join(out, 'energy', `${m.meterId}.json`), JSON.stringify({ data: rows }) + '\n');
  if (++done % 50 === 0) console.log(`energy: ${done}/${meters.length}`);
}
console.log(`done in ${Math.round((Date.now() - started) / 1000)}s`);
