import fs from 'node:fs';
import path from 'node:path';
import { PortalNotFoundError } from './errors.js';

const PAGE_SIZE = 20;

function parsePortalDate(s) {
  const m = /^(\d\d)\/(\d\d)\/(\d{4}) (\d\d):(\d\d)$/.exec(s);
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]) : NaN;
}
function parseIsoDate(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(s ?? '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}

export class FixturePortalClient {
  constructor({ fixturesDir }) {
    this.dir = fixturesDir;
    this.export = JSON.parse(fs.readFileSync(path.join(this.dir, 'export.json'), 'utf8')).data;
    this.transformers = JSON.parse(fs.readFileSync(path.join(this.dir, 'dts.json'), 'utf8'));
    this.byId = new Map(this.export.map((m) => [m.meterId, m]));
  }

  get session() {
    return { loggedIn: true, expiresAt: null, mode: 'fixtures' };
  }

  async login() {}
  async ensureSession() {}

  async searchMeters(q = '', page = 1) {
    const needle = q.toLowerCase();
    const hits = this.export.filter((m) => m.meterId.toLowerCase().includes(needle) || m.serialNo.toLowerCase().includes(needle));
    const p = Number.isInteger(page) && page > 0 ? page : 1;
    const slice = hits.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE)
      .map(({ meterId, serialNo, make, phaseType, installStatus, dtCode }) => ({ meterId, serialNo, make, phaseType, installStatus, dtCode }));
    return { data: slice, total: hits.length, page: p, pageSize: PAGE_SIZE };
  }

  async listTransformers() {
    return this.transformers;
  }

  async getGeo(meterId) {
    const m = this.byId.get(meterId);
    if (!m) throw new PortalNotFoundError('Meter not found');
    return { latitude: String(m.geo.lat), longitude: String(m.geo.lng) };
  }

  async getEnergy(meterId, { from, to } = {}) {
    if (!this.byId.has(meterId)) throw new PortalNotFoundError('Meter not found');
    const file = path.join(this.dir, 'energy', `${meterId}.json`);
    if (!fs.existsSync(file)) return [];
    let rows = JSON.parse(fs.readFileSync(file, 'utf8')).data;
    const lo = parseIsoDate(from);
    const hi = parseIsoDate(to);
    if (!Number.isNaN(lo)) rows = rows.filter((r) => parsePortalDate(r.timestamp) >= lo);
    if (!Number.isNaN(hi)) rows = rows.filter((r) => parsePortalDate(r.timestamp) < hi + 24 * 3600 * 1000);
    return rows;
  }

  async getSigningSecret() {
    return 'fixture-secret';
  }

  async exportMeters() {
    return this.export;
  }

  async sessionInfo() {
    return { session: { expiresAt: null }, user: { name: 'fixtures', email: 'fixtures@local' } };
  }
}
