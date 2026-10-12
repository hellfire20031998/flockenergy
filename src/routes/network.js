import { errorResponses } from '../schemas/index.js';

export default async function networkRoutes(app) {
  const store = app.store;

  app.get('/network', {
    schema: {
      tags: ['Network'],
      summary: 'Network hierarchy',
      description: 'Zone → circle → division → subdivision → substation → feeder → DT → meter ids. Nodes are keyed by path, so a feeder that the data places under two substations appears under both; see /network/issues for the list.',
      response: {
        200: {
          type: 'object',
          properties: {
            stats: {
              type: 'object',
              properties: {
                meters: { type: 'integer' }, transformers: { type: 'integer' }, feeders: { type: 'integer' }, substations: { type: 'integer' },
                issueCounts: { type: 'object', additionalProperties: { type: 'integer' } },
              },
            },
            tree: { type: 'array', items: { $ref: 'NetworkNode#' } },
          },
        },
        ...errorResponses,
      },
    },
  }, async () => store.network());

  app.get('/network/issues', {
    schema: {
      tags: ['Network'],
      summary: 'Data-quality issues found in the portal data',
      description: 'Blank hierarchy fields (with the value recovered from sibling meters), conflicting names, feeders with more than one parent, orphans. Computed when the snapshot loads.',
      querystring: {
        type: 'object',
        properties: {
          type: { type: 'string', examples: ['blank_hierarchy_field'] },
          severity: { type: 'string', enum: ['info', 'warning', 'error'] },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            counts: { type: 'object', additionalProperties: { type: 'integer' } },
            data: { type: 'array', items: { $ref: 'Issue#' } },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => store.issues(req.query));
}
