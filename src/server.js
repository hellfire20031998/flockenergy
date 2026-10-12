import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { schemas } from './schemas/index.js';
import meterRoutes from './routes/meters.js';
import transformerRoutes from './routes/transformers.js';
import networkRoutes from './routes/network.js';
import systemRoutes from './routes/system.js';
import { PortalError, PortalNotFoundError, PortalRateLimitError, PortalAuthError } from './portal/errors.js';

export const openapiInfo = {
  title: 'Urja Meter API',
  version: '1.0.0',
  description: [
    'A clean, read-only API over the legacy Urja Meter Ops portal.',
    '',
    'All data comes from the portal (see PROTOCOL.md). Meters and transformers are loaded once into memory from the',
    'portal\'s bulk export; energy readings are fetched on demand and cached. Timestamps are ISO 8601 in IST (+05:30),',
    'numbers are numbers, enums are lower_snake_case, and every row the service had to discard is reported, not hidden.',
  ].join('\n'),
};

export async function buildServer({ config, store, logger = true }) {
  const app = Fastify({
    logger,
    ajv: { customOptions: { coerceTypes: 'array', removeAdditional: false, useDefaults: true } },
  });

  app.decorate('config', config);
  app.decorate('store', store);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: openapiInfo,
      servers: [{ url: '/', description: 'This server' }],
      tags: [
        { name: 'Meters', description: 'Smart meters, their nameplate, location and readings' },
        { name: 'Network', description: 'Distribution transformers and the hierarchy above them' },
        { name: 'System', description: 'Health and snapshot control' },
      ],
    },
    refResolver: { buildLocalReference: (json) => json.$id },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  for (const s of schemas) app.addSchema(s);

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: 'not_found', message: `No route ${req.method} ${req.url}` });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err.validation) {
      return reply.code(400).send({ error: 'bad_request', message: err.message });
    }
    if (err instanceof PortalNotFoundError) {
      return reply.code(404).send({ error: 'not_found', message: err.message });
    }
    if (err instanceof PortalRateLimitError) {
      return reply.code(503).send({ error: 'portal_rate_limited', message: 'The portal is rate-limiting us; try again in a few seconds' });
    }
    if (err instanceof PortalAuthError) {
      req.log.error({ err }, 'portal auth failure');
      return reply.code(502).send({ error: 'portal_auth_failed', message: err.message });
    }
    if (err instanceof PortalError) {
      req.log.error({ err }, 'portal failure');
      return reply.code(502).send({ error: 'portal_error', message: err.message });
    }
    if (err.code === 'snapshot_unavailable') {
      return reply.code(503).send({ error: 'snapshot_unavailable', message: 'The snapshot has not loaded yet; check /health' });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error', message: 'Unexpected error' });
  });

  await app.register(meterRoutes);
  await app.register(transformerRoutes);
  await app.register(networkRoutes);
  await app.register(systemRoutes);

  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  app.get('/', { schema: { hide: true } }, async (_req, reply) => reply.redirect('/docs'));

  return app;
}
