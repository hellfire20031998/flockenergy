import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

const config = loadConfig({ portal: { mode: 'fixtures', fixturesDir: 'fixtures', baseUrl: '', email: '', password: '', minIntervalMs: 0 } });
const app = await buildServer({ config, store: null, logger: false });
await app.ready();
const spec = app.swagger();
const out = path.join(config.projectRoot, 'openapi.json');
fs.writeFileSync(out, JSON.stringify(spec, null, 2) + '\n');
console.log(`wrote ${out} (${Object.keys(spec.paths).length} paths)`);
await app.close();
