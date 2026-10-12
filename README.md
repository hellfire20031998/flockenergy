# Urja Meter API

A clean, documented, read-only API in front of the legacy **Urja Meter Ops** portal, built
for the Flock Energy take-home.

The portal is a SvelteKit app with no public API. This service logs into it, pulls the
data out through the JSON endpoints its own frontend uses (including a signed bulk
export the UI hides behind an "Export all meters" button), cleans it up, and serves it
as a small REST API with an OpenAPI description and a Swagger UI.

| Document | What it is |
|----------|------------|
| [PROTOCOL.md](PROTOCOL.md) | How the portal actually works: auth, endpoints, data shapes, quirks, dirty data, rate limits. Read this first if you want to understand the investigation. |
| [openapi.json](openapi.json) | OpenAPI 3.1 description of **this** API. Generated from the route schemas by `npm run openapi`; also served live at `/openapi.json` and rendered at `/docs`. |
| This README | What was built, how to run it, decisions, what was skipped, reflection. |

---

## 1. What was built

A single Node.js process (Fastify, plain JavaScript, no build step) that:

1. **Logs into the portal** with the operator credentials, keeps the one-hour session
   cookie alive, re-logs-in proactively and on 401, and paces requests so it never trips
   the portal's rate limit.
2. **Loads a snapshot** at startup: all 403 meters via the signed bulk export (one
   request) plus the 40 distribution transformers (two requests). The snapshot lives in
   memory.
3. **Fetches energy readings on demand**, per meter and date window, and caches them.
4. **Normalises everything**: string numbers become numbers, day-first timestamps become
   ISO 8601 with the IST offset, enums become `lower_snake_case`, cumulative registers
   get a derived per-interval consumption, and corrupt rows are dropped *and reported*.
5. **Rebuilds the network hierarchy** and lists every inconsistency it finds instead of
   hiding it.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/meters` | Filter by status, make, phase, install type, build, DT, feeder, free text; paginated with adjustable page size |
| GET | `/meters/{id}` | Nameplate, location, hierarchy as reported, resolved hierarchy, transformer, data-quality issues |
| GET | `/meters/{id}/readings?from&to` | Readings with numbers, ISO timestamps, per-interval kWh/kVAh, cadence, summary, dropped rows |
| GET | `/transformers` | Transformers with meter count and resolved hierarchy; filter by feeder |
| GET | `/transformers/{code}` | One transformer with its meters and issues |
| GET | `/network` | Zone → circle → division → subdivision → substation → feeder → DT → meter ids |
| GET | `/network/issues` | Blank fields (with recovered values), name conflicts, multi-parent nodes, orphans |
| GET | `/health` | Snapshot and portal-session status |
| POST | `/snapshot/refresh` | Re-pull the snapshot from the portal |
| GET | `/docs`, `/openapi.json` | Swagger UI and the spec |

All errors share one shape: `{"error": "<code>", "message": "<text>"}`.

### Code layout

```
src/
  index.js              process entry: config -> client -> store -> server
  server.js             builds the Fastify app, swagger, error mapping
  config.js             environment variables (.env supported)
  portal/
    client.js           live portal client: login, session, pacing, retries, signed export
    signer.js           HMAC-SHA256 request signing for /portal/export
    fixtureClient.js    same interface, served from ./fixtures (offline mode, tests)
    errors.js
  normalise/
    meters.js           portal records -> API shapes, enum mapping
    readings.js         timestamps, numbers, interval consumption, dropped rows
    hierarchy.js        tree by path + issue detection
  store/snapshot.js     in-memory snapshot + readings cache
  routes/               one file per resource, JSON schemas inline
  schemas/index.js      shared schemas (become OpenAPI components)
scripts/
  generate-openapi.js   writes openapi.json from the running route schemas
  crawl-fixtures.js     re-creates ./fixtures from the live portal
fixtures/               snapshot taken 12 Oct 2026: export, transformers, 403 energy series
test/                   node:test suites (no test framework dependency)
```

The dependency list is three packages: `fastify`, `@fastify/swagger`,
`@fastify/swagger-ui`. Tests use Node's built-in `node:test`.

---

## 2. Running it

Requirements: Node.js 20 or newer (developed on 22). No database, no build.

```bash
npm install
cp .env.example .env        # then put the portal credentials in .env
npm start                   # http://localhost:3000/docs
```

Startup logs in, pulls the snapshot (3 portal requests, a few seconds) and starts
serving. If the portal is unreachable the server still starts, `/health` reports
`degraded`, and it retries the load every minute.

**No credentials? Run from the bundled snapshot:**

```bash
PORTAL_MODE=fixtures npm start
```

This serves exactly the same API from `./fixtures` with no network access. The readings
in fixture mode cover the portal's default window (23–30 June 2026) only.

Other commands:

```bash
npm test            # unit + API tests, all offline
npm run openapi     # regenerate openapi.json
npm run crawl       # rebuild ./fixtures from the live portal (~7 min at 1 req/s)
docker build -t urja-meter-api . && docker run -p 3000:3000 urja-meter-api   # fixtures mode by default
```

Configuration (all optional except the credentials in live mode):

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORTAL_MODE` | `live` | `live` or `fixtures` |
| `PORTAL_BASE_URL` | `https://urja-ops.flockenergy.tech` | |
| `PORTAL_EMAIL`, `PORTAL_PASSWORD` | | portal login |
| `PORTAL_MIN_INTERVAL_MS` | `1000` | minimum spacing between portal requests |
| `PORT`, `HOST`, `LOG_LEVEL` | `3000`, `0.0.0.0`, `info` | |

### Sample requests

```bash
# Faulty three-phase Genus meters, 5 per page
curl "http://localhost:3000/meters?installStatus=faulty&phaseType=three&make=Genus&pageSize=5"

# One meter, with its resolved hierarchy and any issues
curl http://localhost:3000/meters/J100044

# Two days of half-hourly readings, with per-interval consumption
curl "http://localhost:3000/meters/J100000/readings?from=2026-06-01&to=2026-06-02"

# Everything that is wrong with the hierarchy data
curl "http://localhost:3000/network/issues?severity=warning"
```

Sample response, trimmed, for `GET /meters/J100044`:

```json
{
  "id": "J100044",
  "serialNo": "HP44211",
  "make": "Secure",
  "phaseType": "single",
  "installStatus": "installed",
  "installType": "ct_operated",
  "build": "legacy",
  "dtCode": "DT-005",
  "location": { "lat": 26.85587993237898, "lng": 75.8167241689262 },
  "hierarchy":         { "...": "...", "feeder": { "code": null,    "name": "Feeder 5" } },
  "resolvedHierarchy": { "...": "...", "feeder": { "code": "F-005", "name": "Feeder 5" } },
  "transformer": { "code": "DT-005", "name": "Bani Park DT 5", "feederCode": "F-005", "capacityKva": 63 },
  "issues": [
    {
      "type": "blank_hierarchy_field",
      "severity": "warning",
      "level": "feeder",
      "field": "code",
      "resolvedValue": "F-005",
      "message": "Meter J100044 has a blank feeder code; resolved from 9 sibling meters on DT-005"
    }
  ]
}
```

---

## 3. Assumptions

- **Timestamps are Indian Standard Time.** The portal gives `DD/MM/YYYY HH:mm` with no
  zone; the meters are in Jaipur. The API emits `+05:30` explicitly so nobody has to
  guess again.
- **`kwh` and `kvah` are cumulative registers**, because they only ever increase and the
  per-row step is tiny. Consumption is therefore the difference between consecutive
  rows, which the API provides as `intervalKwh`.
- **The data is a frozen snapshot.** Energy exists for 1–30 June 2026 only and the
  nameplate data never changed across a morning of probing. The service is designed for
  "load once, serve from memory", with a manual refresh.
- **The transformer list is authoritative** for a DT's name and feeder when meters
  disagree with it, because it is the screen an operator would look at. Meter-level
  values are still visible under `hierarchy`.
- **Within a DT, the majority chain is the truth.** Blank hierarchy fields are
  recovered from sibling meters on the same DT. Every recovery is reported as an issue.
- **The signing secret is not secret.** The portal hands it to any logged-in user, so
  it is treated as a protocol detail rather than a credential, and is re-fetched before
  every export.
- **One operator account is shared** by every consumer of this API. The API itself has
  no auth; see "Left out".

---

## 4. Design decisions and trade-offs

**Bulk export over page-walking.** The UI's search endpoint is fixed at 20 rows per page
and lacks half the fields. The signed export gives all 403 meters, the full hierarchy
and coordinates in one request. Reproducing the signature meant reading the portal's
JavaScript bundle; it cost half an hour and removed 420 requests from every refresh.

**In-memory snapshot, no database.** 403 meters and 40 transformers fit in a couple of
`Map`s. A database would add setup for the reviewer and buy nothing at this size. The
honest limit: this approach is fine to a few hundred thousand meters in memory, and the
list filters are linear scans, so somewhere around 10⁵ meters with concurrent filtering
I would move the snapshot into SQLite (one file, still no server) with indexes on the
filter columns, and page the energy cache to disk. At that scale the real problem is
the portal side anyway: a full energy crawl at 1 req/s would take days, so I would
switch to incremental, per-DT refreshes driven by demand.

**Readings fetched lazily, cached forever (until refresh).** Pulling 403 energy series at
boot would take seven minutes at the safe rate and most of them would never be read.
Because the data is frozen, a fetched series is simply kept. If the portal ever started
serving live data, the cache key already includes the window, and
`SnapshotStore.readingsTtlMs` is the one knob to turn.

**Request pacing at 1 request/second** rather than a token bucket tuned to the exact
limit. I measured the portal tolerating 60/min indefinitely and tripping at roughly
115/min; the exact window is unknown, and nothing in this service needs to go faster.
On a 429 the client backs off 20 s and retries three times before surfacing a 503.

**Session handling.** The cookie lasts exactly one hour with no renewal. The client
re-logs-in five minutes before expiry, and also once reactively on a 401. Login is
single-flight so a burst of requests on an expired session triggers one login, not
many.

**Issues are a first-class resource.** The brief warned about messy data. Rather than
quietly cleaning it, every correction the service makes is visible: per meter, per
transformer, and in aggregate at `/network/issues`. A consumer can decide whether to
trust a recovered value.

**Tree keyed by path, not by code.** Above the DT level the portal's hierarchy is not
a tree: feeders F-001 to F-012 each appear under two substations. Keying by path means
the same feeder code shows up under each of its parents, which is what the data says,
and the multi-parent cases are listed as issues.

**Fixture mode as a first-class client.** `FixturePortalClient` implements the same
interface as the live client and serves the raw portal shapes, so the normalisers and
routes are exercised identically offline. It makes the tests hermetic, lets a reviewer
run the API without credentials, and doubles as a record of what the portal returned on
12 Oct 2026.

**Plain JavaScript, Fastify, three dependencies.** JavaScript is not my strongest
language; I chose it because the portal is a SvelteKit app and its export signing is
JavaScript I could port line for line, because Node was already on the machine, and
because Fastify's schema-driven routes produce the OpenAPI document for free. The
client logic is ~250 lines and would port to Python or Java in an afternoon.

---

## 5. What was intentionally left out

- **Authentication on this API.** It would be an API key or a JWT check in one Fastify
  hook. Left out because the brief is about the portal integration, and the operator
  account is the only identity available anyway.
- **A database.** See above.
- **Automatic refresh / staleness policy.** The data does not change. A cron-style
  refresh would be a `setInterval` around `store.load()`; the manual endpoint exists.
- **Per-meter geo endpoint calls.** The export already carries identical coordinates
  (verified on a sample), so the service never calls `/portal/meters/{id}/geo`.
- **The meter detail page's `__data.json`.** Same data as the export in a worse shape.
- **A web client, map, charts.** Optional in the brief; the time went into the
  investigation and the write-up instead.
- **Bulk readings across meters** (e.g. "total consumption per DT"). Would need all 403
  series. I built the ingredients (`averageKva` per series, `capacityKva` per DT) but
  not the aggregation; see "With more time".
- **Retry on transient 5xx / network errors.** Only 401 and 429 are retried. A generic
  retry with jitter is a small addition I did not get to.

---

## 6. With more time

1. **Transformer loading.** Sum each DT's meters' `averageKva` against `capacityKva`
   and expose a "loading %" with an over/under list. All the inputs exist; it needs a
   background crawl of the 403 series (7 minutes) and a small aggregation.
2. **A tiny web view** on top of `/network` and `/meters/{id}/readings`: a map of the
   403 points coloured by status, and a consumption chart that handles the two
   cadences properly.
3. **Pin down the rate limit** with one controlled experiment and replace the fixed
   1 s spacing with a token bucket sized to it.
4. **Generic retry with jitter** for 5xx and connection errors, and a circuit breaker so
   a dead portal does not make every request wait 60 s.
5. **Contract tests against the live portal** (opt-in, credentials required) that
   assert the shapes in PROTOCOL.md still hold, so drift is caught early.
6. **Stream the readings response** for large windows. A full month of half-hourly
   data is 1,440 rows, fine today, but the response is built in memory.

---

## 7. Reflection

**What assumptions did you make?** The big ones are in section 3: IST for timestamps,
cumulative registers, a frozen dataset, and "the majority of a DT's meters is right".
The one I am least sure about is treating the transformer list as more authoritative
than the meters when they disagree on a DT's name. For DT-007 that means three meters
that say "Old Malviya Nagar Xfmr" are overruled by ten that say "Sanganer DT 7". It
could equally be a transformer that was renamed and three records that were never
updated. I kept both values visible rather than pick silently.

**Which part was the most difficult, and how did you get unstuck?** The bulk export.
Guessing the route gave a 401 asking for a "request signature", which looked like a
dead end. Getting unstuck meant stopping guessing and reading what the browser was
served: the transformers page bundle contained the signing function in the clear. My
first reimplementation then failed with the same 401 for twenty minutes, and the cause
was not the protocol but my shell mangling the secret when I passed it between tools.
Rewriting the probe as one self-contained script made it work first time. Lesson: when
reproducing a protocol, remove every layer between you and the bytes.

**If you had another day, what would you improve?** Section 6, in that order. The
transformer-loading view is the one thing here a utility would actually look at every
morning.

**What mistake did you make?** Two. I crawled all 403 energy series with four
concurrent workers and got rate-limited after 75 requests, which is how I learned about
the limit, but it is also exactly the behaviour the brief warned against. And I
confidently noted early on that the search box fires a request on every keystroke with
no debounce. The bundle shows a 250 ms debounce. I had just typed faster than it. Both
are in PROTOCOL.md as corrections rather than erased.

**If you were reviewing your own submission, what would you criticise?** The filters on
`/meters` are linear scans over an array, which is fine at 403 and embarrassing at
400,000. The issue detector assigns severities by my judgement with no way for a
consumer to tune them. The fixture mode only holds the default 7-day window, so
`from`/`to` behaves differently offline than live, and that is documented but still a
trap. And the README is long: a reviewer in a hurry would be better served by a
one-screen version with links.
