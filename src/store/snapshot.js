import { normaliseMeter, normaliseTransformer, meterSummary } from '../normalise/meters.js';
import { normaliseReadings } from '../normalise/readings.js';
import { buildNetwork } from '../normalise/hierarchy.js';

export class SnapshotStore {
  #meters = new Map();
  #transformers = new Map();
  #network = null;
  #readingsCache = new Map();
  #loading = null;

  constructor({ client, logger = console, readingsTtlMs = Infinity, now = Date.now }) {
    this.client = client;
    this.log = logger;
    this.readingsTtlMs = readingsTtlMs;
    this.now = now;
    this.loadedAt = null;
    this.lastError = null;
  }

  get ready() {
    return this.#network !== null;
  }

  status() {
    return {
      loaded: this.ready,
      loadedAt: this.loadedAt ? new Date(this.loadedAt).toISOString() : null,
      meters: this.#meters.size,
      transformers: this.#transformers.size,
      cachedReadingSeries: this.#readingsCache.size,
      lastError: this.lastError,
      portalSession: this.client.session,
    };
  }

  async load() {
    if (!this.#loading) {
      this.#loading = this.#doLoad().finally(() => { this.#loading = null; });
    }
    return this.#loading;
  }

  async #doLoad() {
    try {
      const [rawMeters, rawTransformers] = await Promise.all([this.client.exportMeters(), this.client.listTransformers()]);
      const meters = rawMeters.map(normaliseMeter);
      const transformers = rawTransformers.map(normaliseTransformer);
      this.#meters = new Map(meters.map((m) => [m.id, m]));
      this.#transformers = new Map(transformers.map((t) => [t.code, t]));
      this.#network = buildNetwork(meters, transformers);
      this.#readingsCache.clear();
      this.loadedAt = this.now();
      this.lastError = null;
      this.log.info?.({ meters: meters.length, transformers: transformers.length, issues: this.#network.issues.length }, 'snapshot loaded');
    } catch (err) {
      this.lastError = { at: new Date(this.now()).toISOString(), message: err.message, code: err.code ?? null };
      throw err;
    }
  }

  #assertReady() {
    if (!this.ready) {
      const err = new Error('Snapshot not loaded yet');
      err.code = 'snapshot_unavailable';
      err.status = 503;
      throw err;
    }
  }

  listMeters({ q, installStatus, make, phaseType, installType, build, dtCode, feederCode, page = 1, pageSize = 50 } = {}) {
    this.#assertReady();
    const needle = q?.trim().toLowerCase();
    let items = [...this.#meters.values()];
    if (needle) items = items.filter((m) => m.id.toLowerCase().includes(needle) || m.serialNo.toLowerCase().includes(needle));
    if (installStatus) items = items.filter((m) => m.installStatus === installStatus);
    if (make) items = items.filter((m) => m.make.toLowerCase() === make.toLowerCase());
    if (phaseType) items = items.filter((m) => m.phaseType === phaseType);
    if (installType) items = items.filter((m) => m.installType === installType);
    if (build) items = items.filter((m) => m.build === build);
    if (dtCode) items = items.filter((m) => m.dtCode === dtCode.toUpperCase());
    if (feederCode) items = items.filter((m) => this.#network.chainsByDt.get(m.dtCode)?.feeder.code === feederCode.toUpperCase());
    const total = items.length;
    const start = (page - 1) * pageSize;
    return {
      data: items.slice(start, start + pageSize).map(meterSummary),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  getMeter(id) {
    this.#assertReady();
    const m = this.#meters.get(id);
    if (!m) return null;
    const chain = this.#network.chainsByDt.get(m.dtCode);
    const transformer = this.#transformers.get(m.dtCode) ?? null;
    return {
      ...m,
      resolvedHierarchy: chain ?? null,
      transformer,
      issues: this.#network.issues.filter((i) => i.meterId === id),
    };
  }

  async getReadings(id, { from, to } = {}) {
    this.#assertReady();
    if (!this.#meters.has(id)) return null;
    const key = `${id}|${from ?? ''}|${to ?? ''}`;
    const cached = this.#readingsCache.get(key);
    if (cached && this.now() - cached.at < this.readingsTtlMs) return cached.value;
    const rows = await this.client.getEnergy(id, { from, to });
    const value = { meterId: id, window: { from: from ?? null, to: to ?? null }, ...normaliseReadings(rows) };
    this.#readingsCache.set(key, { at: this.now(), value });
    return value;
  }

  listTransformers({ feederCode } = {}) {
    this.#assertReady();
    let items = [...this.#transformers.values()];
    if (feederCode) items = items.filter((t) => t.feederCode === feederCode.toUpperCase());
    return items.map((t) => this.#transformerView(t));
  }

  getTransformer(code) {
    this.#assertReady();
    const t = this.#transformers.get(code);
    if (!t) return null;
    const meters = (this.#network.metersByDt.get(code) ?? []).map(meterSummary);
    return { ...this.#transformerView(t), meters, issues: this.#network.issues.filter((i) => i.dtCode === code && !i.meterId) };
  }

  #transformerView(t) {
    const chain = this.#network.chainsByDt.get(t.code) ?? null;
    return { ...t, meterCount: this.#network.metersByDt.get(t.code)?.length ?? 0, hierarchy: chain };
  }

  network() {
    this.#assertReady();
    return { stats: this.#network.stats, tree: this.#network.tree };
  }

  issues({ type, severity } = {}) {
    this.#assertReady();
    let items = this.#network.issues;
    if (type) items = items.filter((i) => i.type === type);
    if (severity) items = items.filter((i) => i.severity === severity);
    return { total: items.length, counts: this.#network.stats.issueCounts, data: items };
  }
}
