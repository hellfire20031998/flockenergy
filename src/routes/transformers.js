import { errorResponses } from '../schemas/index.js';

export default async function transformerRoutes(app) {
  const store = app.store;

  app.get('/transformers', {
    schema: {
      tags: ['Network'],
      summary: 'List distribution transformers',
      querystring: { type: 'object', properties: { feederCode: { type: 'string', examples: ['F-001'] } } },
      response: {
        200: { type: 'object', properties: { data: { type: 'array', items: { $ref: 'Transformer#' } }, total: { type: 'integer' } } },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const data = store.listTransformers(req.query);
    return { data, total: data.length };
  });

  app.get('/transformers/:code', {
    schema: {
      tags: ['Network'],
      summary: 'Get one transformer with its meters',
      params: { type: 'object', properties: { code: { type: 'string', examples: ['DT-007'] } }, required: ['code'] },
      response: {
        200: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            name: { type: 'string' },
            feederCode: { type: ['string', 'null'] },
            capacityKva: { type: 'number' },
            meterCount: { type: 'integer' },
            hierarchy: { $ref: 'Hierarchy#' },
            meters: { type: 'array', items: { $ref: 'MeterSummary#' } },
            issues: { type: 'array', items: { $ref: 'Issue#' } },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const t = store.getTransformer(req.params.code.toUpperCase());
    if (!t) return reply.code(404).send({ error: 'not_found', message: `No transformer ${req.params.code}` });
    return t;
  });
}
