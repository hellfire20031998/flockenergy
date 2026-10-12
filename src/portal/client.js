import { PortalError, PortalAuthError, PortalNotFoundError, PortalRateLimitError } from './errors.js';
import { signRequest } from './signer.js';

const SESSION_COOKIE = '__Secure-better-auth.session_token';
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;
const RELOGIN_MARGIN_MS = 5 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MS = 20 * 1000;
const MAX_RATE_LIMIT_RETRIES = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class PortalClient {
  #cookie = null;
  #expiresAt = 0;
  #loginInFlight = null;
  #lastRequestAt = 0;
  #queue = Promise.resolve();

  constructor({ baseUrl, email, password, minIntervalMs = 1000, logger = console, fetchImpl = globalThis.fetch, now = Date.now, sleepImpl = sleep }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.email = email;
    this.password = password;
    this.minIntervalMs = minIntervalMs;
    this.log = logger;
    this.fetch = fetchImpl;
    this.now = now;
    this.sleep = sleepImpl;
  }

  get session() {
    return { loggedIn: Boolean(this.#cookie), expiresAt: this.#expiresAt ? new Date(this.#expiresAt).toISOString() : null };
  }

  async login() {
    const body = new URLSearchParams({ email: this.email, password: this.password });
    const res = await this.fetch(`${this.baseUrl}/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        origin: this.baseUrl,
      },
      body,
      redirect: 'manual',
    });
    const text = await res.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch {}

    if (res.status === 403) {
      throw new PortalAuthError('Portal rejected the login as cross-site (missing Origin header?)', { status: 403 });
    }
    if (!payload || payload.type !== 'redirect') {
      const msg = payload?.type === 'failure' ? 'Invalid email or password' : `Unexpected login response (HTTP ${res.status})`;
      throw new PortalAuthError(msg, { status: res.status });
    }
    const cookie = this.#extractSessionCookie(res);
    if (!cookie) throw new PortalAuthError('Login succeeded but no session cookie was returned');
    this.#cookie = cookie.value;
    this.#expiresAt = this.now() + (cookie.maxAgeMs ?? DEFAULT_SESSION_TTL_MS);
    this.log.info?.({ expiresAt: new Date(this.#expiresAt).toISOString() }, 'portal: logged in');
  }

  #extractSessionCookie(res) {
    const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
    for (const raw of cookies) {
      const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
      const eq = pair.indexOf('=');
      if (eq < 0 || pair.slice(0, eq) !== SESSION_COOKIE) continue;
      const maxAge = attrs.map((a) => a.match(/^max-age=(\d+)$/i)).find(Boolean);
      return { value: pair.slice(eq + 1), maxAgeMs: maxAge ? Number(maxAge[1]) * 1000 : undefined };
    }
    return null;
  }

  async ensureSession({ force = false } = {}) {
    const fresh = this.#cookie && this.#expiresAt - this.now() > RELOGIN_MARGIN_MS;
    if (fresh && !force) return;
    if (!this.#loginInFlight) {
      this.#loginInFlight = this.login().finally(() => { this.#loginInFlight = null; });
    }
    await this.#loginInFlight;
  }

  async #takeSlot() {
    const previous = this.#queue;
    let release;
    this.#queue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const wait = this.#lastRequestAt + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.#lastRequestAt = this.now();
    } finally {
      release();
    }
  }

  async request(path, { headers = {}, retryAuth = true, rateLimitRetries = MAX_RATE_LIMIT_RETRIES } = {}) {
    await this.ensureSession();
    await this.#takeSlot();
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      headers: { accept: 'application/json', cookie: `${SESSION_COOKIE}=${this.#cookie}`, ...headers },
    });
    const text = await res.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch {}

    if (res.ok && payload !== null) return payload;

    if (res.status === 401 && payload?.error === 'unauthorized' && retryAuth) {
      this.log.warn?.('portal: session rejected, logging in again');
      this.#cookie = null;
      await this.ensureSession({ force: true });
      return this.request(path, { headers, retryAuth: false, rateLimitRetries });
    }
    if (res.status === 429) {
      if (rateLimitRetries > 0) {
        this.log.warn?.({ path, retriesLeft: rateLimitRetries }, 'portal: rate limited, backing off');
        await this.sleep(RATE_LIMIT_BACKOFF_MS);
        return this.request(path, { headers, retryAuth, rateLimitRetries: rateLimitRetries - 1 });
      }
      throw new PortalRateLimitError('Portal rate limit exceeded and retries exhausted');
    }
    if (res.status === 404) {
      throw new PortalNotFoundError(payload?.message ?? `Portal has no resource at ${path}`);
    }
    if (res.status === 401) {
      throw new PortalAuthError(payload?.message ?? 'Portal rejected the request', { status: 401 });
    }
    throw new PortalError(payload?.message ?? `Portal returned HTTP ${res.status} for ${path}`, { status: res.status, code: payload?.error });
  }

  async searchMeters(q = '', page = 1) {
    return this.request(`/portal/meters/search?q=${encodeURIComponent(q)}&page=${page}`);
  }

  async listTransformers() {
    const all = [];
    for (let page = 1; ; page++) {
      const res = await this.request(`/portal/dts?page=${page}`);
      all.push(...res.data);
      if (all.length >= res.total || res.data.length === 0) break;
    }
    return all;
  }

  async getGeo(meterId) {
    return (await this.request(`/portal/meters/${encodeURIComponent(meterId)}/geo`)).data;
  }

  async getEnergy(meterId, { from, to } = {}) {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const suffix = qs.size ? `?${qs}` : '';
    return (await this.request(`/portal/meters/${encodeURIComponent(meterId)}/energy${suffix}`)).data;
  }

  async getSigningSecret() {
    return (await this.request('/portal/keys')).data.signingSecret;
  }

  async exportMeters() {
    const secret = await this.getSigningSecret();
    const query = '';
    const { timestamp, signature } = signRequest({ method: 'GET', path: '/portal/export', query, secret });
    const res = await this.request(`/portal/export${query ? `?${query}` : ''}`, {
      headers: { 'x-timestamp': timestamp, 'x-signature': signature },
    });
    return res.data;
  }

  async sessionInfo() {
    return this.request('/api/auth/get-session');
  }
}
