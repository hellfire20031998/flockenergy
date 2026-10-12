export default async function systemRoutes(app) {
  const store = app.store;

  app.get('/health', {
    schema: {
      tags: ['System'],
      summary: 'Service health and snapshot status',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ok', 'degraded'] },
            mode: { type: 'string', enum: ['live', 'fixtures'] },
            snapshot: {
              type: 'object',
              properties: {
                loaded: { type: 'boolean' },
                loadedAt: { type: ['string', 'null'] },
                meters: { type: 'integer' },
                transformers: { type: 'integer' },
                cachedReadingSeries: { type: 'integer' },
                lastError: { type: ['object', 'null'], additionalProperties: true },
                portalSession: { type: 'object', additionalProperties: true },
              },
            },
          },
        },
      },
    },
  }, async (_req, reply) => {
    const snapshot = store.status();
    const status = snapshot.loaded ? 'ok' : 'degraded';
    reply.code(snapshot.loaded ? 200 : 503);
    return { status, mode: app.config.portal.mode, snapshot };
  });

  app.post('/snapshot/refresh', {
    schema: {
      tags: ['System'],
      summary: 'Re-fetch the snapshot from the portal',
      description: 'The portal data is a frozen June 2026 snapshot, so there is no automatic refresh. Call this if the portal ever changes. Costs 3 portal requests and clears the readings cache.',
      response: { 200: { type: 'object', properties: { refreshed: { type: 'boolean' }, snapshot: { type: 'object', additionalProperties: true } } } },
    },
  }, async () => {
    await store.load();
    return { refreshed: true, snapshot: store.status() };
  });
}
