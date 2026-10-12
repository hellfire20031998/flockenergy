import { loadConfig } from './config.js';
import { PortalClient } from './portal/client.js';
import { FixturePortalClient } from './portal/fixtureClient.js';
import { SnapshotStore } from './store/snapshot.js';
import { buildServer } from './server.js';

const RETRY_LOAD_MS = 60 * 1000;

export function createClient(config, logger) {
  if (config.portal.mode === 'fixtures') {
    return new FixturePortalClient({ fixturesDir: config.portal.fixturesDir });
  }
  return new PortalClient({ ...config.portal, logger });
}

async function main() {
  const config = loadConfig();
  const client = createClient(config, console);
  const store = new SnapshotStore({ client, logger: console });
  const app = await buildServer({ config, store, logger: { level: config.server.logLevel } });
  client.log = app.log;
  store.log = app.log;

  const loadWithRetry = async () => {
    try {
      await store.load();
    } catch (err) {
      app.log.error({ err: err.message }, `snapshot load failed, retrying in ${RETRY_LOAD_MS / 1000}s`);
      setTimeout(loadWithRetry, RETRY_LOAD_MS).unref();
    }
  };
  await loadWithRetry();

  await app.listen({ port: config.server.port, host: config.server.host });
  app.log.info(`docs at http://localhost:${config.server.port}/docs (mode: ${config.portal.mode})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
