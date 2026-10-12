import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(projectRoot, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

const env = (name, fallback) => (process.env[name] === undefined || process.env[name] === '' ? fallback : process.env[name]);

export function loadConfig(overrides = {}) {
  const mode = env('PORTAL_MODE', 'live');
  if (!['live', 'fixtures'].includes(mode)) {
    throw new Error(`PORTAL_MODE must be "live" or "fixtures", got "${mode}"`);
  }
  const cfg = {
    projectRoot,
    portal: {
      mode,
      baseUrl: env('PORTAL_BASE_URL', 'https://urja-ops.flockenergy.tech').replace(/\/$/, ''),
      email: env('PORTAL_EMAIL', ''),
      password: env('PORTAL_PASSWORD', ''),
      minIntervalMs: Number(env('PORTAL_MIN_INTERVAL_MS', 1000)),
      fixturesDir: path.resolve(projectRoot, env('FIXTURES_DIR', 'fixtures')),
    },
    server: {
      port: Number(env('PORT', 3000)),
      host: env('HOST', '0.0.0.0'),
      logLevel: env('LOG_LEVEL', 'info'),
    },
    ...overrides,
  };
  if (cfg.portal.mode === 'live' && (!cfg.portal.email || !cfg.portal.password)) {
    throw new Error('PORTAL_EMAIL and PORTAL_PASSWORD are required in live mode (see .env.example)');
  }
  return cfg;
}
