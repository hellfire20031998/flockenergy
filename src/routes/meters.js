import { pageQuery, errorResponses } from '../schemas/index.js';

const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD, inclusive' };

export default async function meterRoutes(app) {
  const store = app.store;

  app.get('/meters', {
    schema: {
      tags: ['Meters'],
      summary: 'List meters',
      description: 'Filterable, paginated list. Unlike the portal, any attribute can be filtered and the page size is adjustable.',
      querystring: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Case-insensitive substring of meter id or serial number' },
          installStatus: { type: 'string', enum: ['installed', 'faulty', 'decommissioned'] },
          make: { type: 'string', examples: ['Genus'] },
          phaseType: { type: 'string', enum: ['single', 'three'] },
          installType: { type: 'string', enum: ['whole_current', 'ct_operated'] },
          build: { type: 'string', enum: ['legacy', 'v2'] },
          dtCode: { type: 'string', examples: ['DT-007'] },
          feederCode: { type: 'string', examples: ['F-001'] },
          ...pageQuery,
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { $ref: 'MeterSummary#' } },
            page: { type: 'integer' },
            pageSize: { type: 'integer' },
            total: { type: 'integer' },
            totalPages: { type: 'integer' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => store.listMeters(req.query));

  app.get('/meters/:id', {
    schema: {
      tags: ['Meters'],
      summary: 'Get one meter',
      description: 'Nameplate, location, the hierarchy as the portal reports it, the resolved hierarchy for its transformer, and any data-quality issues on this meter.',
      params: { type: 'object', properties: { id: { type: 'string', examples: ['J100000'] } }, required: ['id'] },
      response: { 200: { $ref: 'Meter#' }, ...errorResponses },
    },
  }, async (req, reply) => {
    const meter = store.getMeter(req.params.id.toUpperCase());
    if (!meter) return reply.code(404).send({ error: 'not_found', message: `No meter ${req.params.id}` });
    return meter;
  });

  app.get('/meters/:id/readings', {
    schema: {
      tags: ['Meters'],
      summary: 'Energy readings',
      description: 'Interval readings with proper numbers, ISO timestamps and per-interval consumption. Defaults to the portal\'s last-7-days window; data exists for June 2026 only.',
      params: { type: 'object', properties: { id: { type: 'string', examples: ['J100000'] } }, required: ['id'] },
      querystring: { type: 'object', properties: { from: DATE, to: DATE } },
      response: { 200: { $ref: 'ReadingsResponse#' }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { from, to } = req.query;
    if (from && to && from > to) {
      return reply.code(400).send({ error: 'bad_request', message: '`from` must not be after `to`' });
    }
    const result = await store.getReadings(req.params.id.toUpperCase(), { from, to });
    if (!result) return reply.code(404).send({ error: 'not_found', message: `No meter ${req.params.id}` });
    return result;
  });
}
