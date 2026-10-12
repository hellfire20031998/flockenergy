# PROTOCOL.md — how the Urja Meter Ops portal actually works

This is a write-up of the portal at `https://urja-ops.flockenergy.tech` as discovered
on 12 Oct 2026 by watching browser traffic, reading the served JavaScript bundles, and
probing the JSON endpoints with curl and Node. Everything here was done as a normal
logged-in user with read-only GET requests (plus the login POST). Nothing was fuzzed or
brute-forced.

Contents

1. [Big picture](#1-big-picture)
2. [Authentication and sessions](#2-authentication-and-sessions)
3. [Endpoints](#3-endpoints)
4. [Data model](#4-data-model)
5. [The network hierarchy](#5-the-network-hierarchy)
6. [Quirks, surprises and dirty data](#6-quirks-surprises-and-dirty-data)
7. [Rate limiting and robustness](#7-rate-limiting-and-robustness)
8. [Things that do not exist](#8-things-that-do-not-exist)
9. [How this was discovered](#9-how-this-was-discovered)

---

## 1. Big picture

- The portal is a **SvelteKit single-page app**. Pages (`/login`, `/meters`,
  `/meters/{id}`, `/transformers`) are server-rendered shells; the actual data is
  fetched client-side from **JSON endpoints under `/portal/…`**. There is no HTML to
  scrape: every piece of data the UI shows is available as JSON.
- Auth is session-cookie based, implemented with the **better-auth** library, wrapped
  behind a SvelteKit form action at `/login`.
- There are **403 meters** and **40 distribution transformers (DTs)**.
- Two ways to get meter data out:
  1. **Paginated search** (`/portal/meters/search`) + two per-meter sub-resources
     (`/geo`, `/energy`). 20 rows per page, fixed.
  2. **A signed bulk export** (`/portal/export`) that returns all 403 meters in one
     response, with a 7-level network hierarchy and coordinates included. It needs an
     HMAC request signature computed with a secret the portal hands out at
     `/portal/keys`. The "Export all meters" button on the Transformers page uses it.
- Consumption data is a **static snapshot of June 2026** (1–30 June). Nothing changes
  over time, which matters a lot for caching.
- The portal **rate-limits bursts** (HTTP 429) but tolerates a steady 1 request/second.

---

## 2. Authentication and sessions

### Login

```
POST /login
Origin: https://urja-ops.flockenergy.tech      <- REQUIRED, see below
Content-Type: application/x-www-form-urlencoded

email=operator%40urja.local&password=urja-ops-2026
```

- The form fields are `email` and `password` (sending `username` fails with the same
  "Invalid email or password." message).
- **Without an `Origin` header the request is rejected with `403 Cross-site POST form
  submissions are forbidden`.** This is SvelteKit's built-in CSRF check on form actions,
  not an application rule. Any non-browser client must send `Origin` equal to the site
  origin. There is no CSRF token.
- The browser sends `x-sveltekit-action: true` and `Accept: application/json`. Neither is
  required; the response is the same without them.
- **Success** is `HTTP 200` with a SvelteKit action result, not an HTTP redirect:
  ```json
  {"type":"redirect","status":303,"location":"/meters"}
  ```
  plus the session cookie:
  ```
  Set-Cookie: __Secure-better-auth.session_token=<token>.<signature>;
              Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax
  ```
- **Failure** is also `HTTP 200`. The body carries the real status:
  ```json
  {"type":"failure","status":401,"data":"[{\"email\":1,\"error\":2},\"operator@urja.local\",\"Invalid email or password.\"]"}
  ```
  (`data` is a devalue-serialised string, which is how SvelteKit encodes action data.)
  A client must inspect `type` in the body, not the HTTP status.

### Session lifetime

- The cookie has `Max-Age=3600`: **sessions last exactly one hour from login**.
- The expiry is **fixed, not sliding**. After several minutes of requests
  `GET /api/auth/get-session` still reported the original `updatedAt`/`expiresAt`, and no
  normal `/portal/…` response ever carried a `Set-Cookie`.
- `GET /api/auth/get-session` (the standard better-auth route) is reachable with the
  cookie and returns the exact `expiresAt` timestamp, the user (`Ops Desk`,
  `operator@urja.local`) and the session id. This is the cheapest way to decide when to
  re-login proactively rather than waiting for a 401.
- Sign-out is `POST /api/auth/sign-out` (what the "Sign out" link in the layout calls).

### Unauthenticated behaviour

| Request                        | Result                                                          |
|--------------------------------|-----------------------------------------------------------------|
| `/portal/…` without cookie     | `401 {"error":"unauthorized","message":"A valid session is required."}` |
| `/portal/…` with a bad cookie  | same 401 JSON                                                   |
| `/meters` (HTML) without cookie| `302 Found` → `/login`                                          |

All JSON errors share one shape: `{"error": "<snake_case_code>", "message": "<text>"}`.

---

## 3. Endpoints

All of these require the session cookie. All responses are `application/json`. None of
them send `ETag`, `Cache-Control` or `Last-Modified`, so there is no HTTP-level caching to
lean on.

### 3.1 `GET /portal/meters/search?q=<text>&page=<n>`

The meter list behind the Meters page.

```json
{
  "data": [
    {"meterId":"J100000","serialNo":"SE33962","make":"HPL","phaseType":"single",
     "installStatus":"Decommissioned","dtCode":"DT-001"},
    …
  ],
  "total": 403, "page": 1, "pageSize": 20
}
```

- **Page size is fixed at 20.** `pageSize`, `limit` and `size` query parameters are
  ignored. 403 meters → 21 pages, the last with 3 rows.
- `page=0`, `page=-1`, `page=abc` and a missing `page` all silently become page 1.
  Pages past the end return `200` with an empty `data` array and the same `total`.
- `q` is a **case-insensitive substring match on `meterId` and `serialNo` only**.
  `q=Genus`, `q=DT-001`, `q=Faulty`, `q=three` all return nothing. The placeholder text
  in the UI ("Search by meter number or serial…") says the same.
- `q` is **not trimmed**: `q=%20J100005%20` returns nothing.
- Serial numbers can contain `&` (e.g. `L&84997`); it must be URL-encoded as `%26` in `q`.
- Rows are ordered by `meterId` ascending. IDs are contiguous `J100000`–`J100402`.

### 3.2 `GET /portal/meters/{meterId}/geo`

```json
{"data":{"latitude":"26.938961002479868","longitude":"75.83095696146852"}}
```

- Coordinates are **strings**, not numbers.
- `meterId` is case-sensitive: `j100000` → 404.
- Unknown id → `404 {"error":"not_found","message":"Meter not found"}`.
- A trailing slash gets a `308` redirect to the slash-less URL.
- Values are identical to the `geo` object in the bulk export (checked on a sample).

### 3.3 `GET /portal/meters/{meterId}/energy[?from=YYYY-MM-DD&to=YYYY-MM-DD]`

The "Consumption" table/chart on the meter detail page.

```json
{"data":[
  {"timestamp":"23/06/2026 23:30","kwh":"48438.74","kvah":"52313.84","voltR":"226"},
  …
]}
```

- **Every value is a string**, including the numbers.
- `timestamp` is `DD/MM/YYYY HH:mm`, **day first, no timezone**. The meters are in
  Jaipur, so Indian Standard Time (UTC+05:30) is the only sensible interpretation.
- `kwh` and `kvah` are **cumulative register readings** (monotonically increasing), not
  interval consumption. Interval consumption is the difference between consecutive rows.
- Only a single voltage, `voltR` (R-phase). Three-phase meters have the same shape; there
  is no `voltY`/`voltB`.
- **Two reading cadences exist.** Exactly 40 meters, `J100000`–`J100039`, report every
  **30 minutes**; the other 363 report **once a day at 00:00**. The split follows meter
  id, not make, phase, build, install type or status, so every DT contains both kinds.
  A consumer must not assume 30-minute spacing.
- **Default window: the last 7 days of available data**, i.e. `23/06/2026 23:30` →
  `30/06/2026 23:30` (337 rows) for half-hourly meters and `23/06/2026 00:00` →
  `30/06/2026 00:00` (8 rows) for daily meters.
- **Five daily meters have a corrupt trailing row**: `J100089`, `J100134`, `J100195`,
  `J100211`, `J100330` return 9 rows, the last of which repeats the `30/06/2026 00:00`
  timestamp with `"kwh": ""` and `"voltR": ""` (kvah is copied from the row above).
  These are the only blank values, duplicate timestamps or irregular rows in all 403
  series.
- **Date range parameters** `from` and `to` (`YYYY-MM-DD`, inclusive) are honoured even
  though the UI never sends them:
  - `from` only → 7 days starting at `from`.
  - `to` only → 7 days ending at `to`.
  - both → the full range (`from=2026-06-01&to=2026-06-30` returns the whole month:
    1440 rows half-hourly, 30 rows daily).
  - `to < from` → empty array, status 200.
  - Unparseable values (`garbage`, `01/06/2026`, ISO datetimes with time) are ignored and
    the default for that bound applies. No error is ever returned for bad dates.
- **Data exists only for 1–30 June 2026.** Queries for any other month return an empty
  array. Today is October 2026, so this is a frozen snapshot, not live telemetry.
- `page`, `limit`, `days`, `interval`, `range` are ignored.
- Response headers carry no caching hints.

### 3.4 `GET /portal/dts?page=<n>`

The Transformers page list.

```json
{"data":[{"code":"DT-001","name":"Malviya Nagar DT 1","feederCode":"F-001","capacityKva":100}, …],
 "total":40,"page":1,"pageSize":20}
```

- Same pagination envelope and rules as the meter search (fixed 20 per page, 2 pages).
- `capacityKva` is a **real JSON number** here, unlike every numeric value in the meter
  endpoints.
- There is no DT detail endpoint and no `q` filter.

### 3.5 `GET /portal/keys` and `GET /portal/export` (the bulk path)

The "Export all meters" button on the Transformers page does this (reconstructed from
the page's JS bundle, `_app/immutable/nodes/4.*.js`):

1. `GET /portal/keys` → `{"data":{"signingSecret":"<32-char string>"}}`.
   The secret was identical across calls and across the session; treat it as stable but
   re-fetch it before each export to be safe.
2. Build the canonical string, four lines joined with `\n`:
   ```
   GET
   /portal/export
   page=1            <- the raw query string, may be empty
   1791785230        <- unix seconds, as a decimal string
   ```
3. `signature = hex(HMAC-SHA256(key = signingSecret, message = canonical))`.
4. `GET /portal/export?page=1` with headers `x-timestamp: <ts>` and
   `x-signature: <hex>`.

Response:

```json
{"data":[ …403 full meter records… ], "total":403}
```

Each record (see §4) has everything the search row has **plus** `installType`, `build`,
a 7-level `hierarchy` object, and `geo` as numbers. It does **not** include energy
readings.

Notes:

- The `page` parameter is accepted but ignored: every call returns all 403. There is no
  `page`/`pageSize` in the response.
- The signature covers the exact query string, so `page=1` and `page=2` need different
  signatures, but both return the same body. An empty query string signs fine too.
- **Timestamp skew is checked.** A timestamp 30 s old was accepted; one 400 s old was
  rejected with `401 {"error":"signature_invalid","message":"Missing or invalid request
  signature."}`. The exact window was not pinned down; stay within a minute.
- A missing or wrong signature gives the same `signature_invalid` 401.
- The UI reads the result and downloads it as `meter-export.json`.

### 3.6 Meter detail page data (`GET /meters/{id}/__data.json`)

The meter detail page's static details (the "Nameplate" card and the hierarchy
breadcrumb) are not fetched from `/portal/…`; they come from the SvelteKit page `load`,
which is reachable as `GET /meters/{id}/__data.json`. It returns SvelteKit's devalue
format and contains:

- `detail.data`: a list of `{parameterName, parameterValue}` pairs: Meter ID, Serial No,
  Make, Phase Type, Installation Status, Installation Type.
- `hierarchy`: a flat object of display strings, e.g. `"Feeder":"Feeder 1 (F-001)"`,
  `"Sub Station":"Substation 1 (SS-01)"`.

It is the same information as the export, in a third (worse) representation, so the
service does not use it. Documented so nobody wonders where the nameplate comes from.

---

## 4. Data model

### Meter (bulk export record; the search row is the first six fields)

| field           | type (as served)        | values seen                                               |
|-----------------|-------------------------|-----------------------------------------------------------|
| `meterId`       | string                  | `J100000` … `J100402`, contiguous, unique                 |
| `serialNo`      | string                  | 2-letter prefix + 5 digits, unique; prefixes `SE GE AL L& HP GN` |
| `make`          | string enum             | `HPL` 90, `Genus` 88, `Secure` 85, `Allied` 76, `L&T` 64  |
| `phaseType`     | string enum             | `single` 277, `three` 126                                 |
| `installStatus` | string enum             | `Installed` 238, `Faulty` 90, `Decommissioned` 75         |
| `installType`   | string enum (export only)| `Whole Current` 205, `CT Operated` 198                   |
| `build`         | string enum (export only)| `legacy` 238, `v2` 165                                   |
| `dtCode`        | string                  | `DT-001` … `DT-040`; always matches `hierarchy.dt.code`   |
| `hierarchy`     | object (export only)    | `{zone, circle, division, subdivision, substation, feeder, dt}`, each `{name, code}` |
| `geo`           | object (export only)    | `{lat: number, lng: number}`                              |

No field was ever `null` or missing in the export; blanks show up as empty strings inside
`hierarchy` (see §6).

### Distribution transformer

| field         | type   | values seen                                            |
|---------------|--------|--------------------------------------------------------|
| `code`        | string | `DT-001` … `DT-040`                                    |
| `name`        | string | `<area> DT <n>`, 10 Jaipur area names cycling          |
| `feederCode`  | string | `F-001` … `F-028`; `F-001`–`F-012` each serve 2 DTs, the rest 1 |
| `capacityKva` | number | 63, 100, 160, 250, 400                                 |

Each DT has between 10 and 13 meters; none are empty.

### Energy reading

| field       | type (as served) | meaning                                   |
|-------------|------------------|-------------------------------------------|
| `timestamp` | string           | `DD/MM/YYYY HH:mm`, IST assumed           |
| `kwh`       | string(number)   | cumulative active energy register; `""` in 5 corrupt rows |
| `kvah`      | string(number)   | cumulative apparent energy register       |
| `voltR`     | string(integer)  | R-phase voltage, 220–240 V in all data; `""` in the same 5 rows |

### Geo

All 403 points lie in a box around Jaipur (lat 26.79–27.04, lng 75.66–75.91). No
duplicates, no zeros, no swapped coordinates.

---

## 5. The network hierarchy

The export gives every meter a seven-level chain:

```
zone (Z-01..03) > circle (C-01..06) > division (D-01..10) > subdivision (SD-01..14)
  > substation (SS-01..18) > feeder (F-001..028) > dt (DT-001..040) > meter
```

What is actually consistent:

- **Meter → DT** is clean: `dtCode` always equals `hierarchy.dt.code`, every `dtCode`
  exists in `/portal/dts`, and every DT has meters.
- **DT → feeder** agrees between the DT list and the export for every meter that has a
  feeder code at all.
- **Within one DT, all its meters report the same upstream chain**, except for the
  blank-field cases in §6. So the chain can be treated as a property of the DT.

What is *not* a tree:

- Above the DT, **nodes have multiple parents**. Feeders `F-001`–`F-012` each sit under
  two different substations (e.g. `F-001` is under `SS-01` for DT-001's meters and under
  `SS-11` for DT-029's). Substations sit under 2–3 subdivisions, subdivisions under 2–3
  divisions, divisions under 3 circles. The codes repeat with a modular pattern that looks
  generated rather than real.
- Consequence: you cannot build a strict tree keyed by code above the feeder level. You
  can either (a) key tree nodes by their **full path** (so `F-001` appears twice, under
  different substations), or (b) treat the levels above feeder as labels on each DT and
  present the clean part (`feeder > dt > meter`) as the tree. The service does (a) and
  reports the multi-parent codes explicitly.

---

## 6. Quirks, surprises and dirty data

Portal/protocol quirks:

1. Login needs an `Origin` header or you get a 403 that has nothing to do with
   credentials.
2. Login success and failure are both HTTP 200; the real status is inside the JSON body.
3. Sessions expire exactly 60 minutes after login, with no sliding renewal.
4. Numbers are strings in `/geo` and `/energy` but real numbers in `/dts` and the export.
   The same coordinate is `"latitude": "26.93…"` in one endpoint and `lat: 26.93…` in
   the other.
5. Timestamps are day-first with no timezone.
6. `kwh`/`kvah` are cumulative registers, so the obvious "sum the column" is wrong.
7. The energy endpoint has undocumented `from`/`to` parameters that unlock the whole
   month; the UI only ever shows the last week.
8. The bulk export needs an HMAC signature, but the signing secret is handed to any
   logged-in user by `/portal/keys`, so it is a hoop rather than a security boundary.
9. The export ignores `page` and always returns everything.
10. Page size is fixed at 20 everywhere; invalid page numbers silently become 1; pages
    past the end are 200 with empty data.
11. No caching headers anywhere.
12. There are no endpoints for feeders, substations or anything above DT; that structure
    only exists inside each meter's export record.
13. Rate limiting returns 429 with **no `Retry-After` header** (see §7).

Dirty data (all found in the export; counts are out of 403 meters):

| issue | detail |
|-------|--------|
| Blank hierarchy codes | 11 meters have an empty `circle.code` or `circle.name`, 8 an empty `feeder.code`/`name`, 3 an empty `substation.code`. The rest of the chain is intact, so the value can be recovered from sibling meters on the same DT. Example: `J100044` on DT-005 has `feeder.code == ""` while its 9 siblings say `F-005`. |
| Conflicting DT name | `DT-007` is `Sanganer DT 7` in `/portal/dts` and for 10 of its meters, but `Old Malviya Nagar Xfmr` for the last three meters `J100400`–`J100402`. |
| Odd tail records | Those same three meters are the only ones with serial prefix `GN`, the only ones past `J100399`, and they report daily rather than half-hourly. They look like an appended legacy batch. |
| Serial prefix vs make | Prefixes look like manufacturer codes (`SE`=Secure, `GE`=Genus, `HP`=HPL, `AL`=Allied, `L&`=L&T) but are essentially uncorrelated with `make`: e.g. 25 `AL…` serials are `HPL` meters. Do not derive make from serial. |
| Decommissioned meters still consuming | e.g. `J100000` is `Decommissioned` yet its registers increase steadily through June. Faulty meters likewise have normal-looking data. |
| Two cadences | 40 half-hourly meters (`J100000`–`J100039`) vs 363 daily. Nothing in the meter record says which; you only find out by reading the series. Daily meters' `kwh` steps are ~48× larger per row, so naive per-row comparisons across meters are meaningless. |
| Corrupt trailing row | 5 daily meters (`J100089`, `J100134`, `J100195`, `J100211`, `J100330`) have a 9th row duplicating the last timestamp with empty `kwh` and `voltR`. Must be dropped or flagged before computing deltas, otherwise `parseFloat("")` gives `NaN`. |
| Multi-parent hierarchy | See §5. |
| Suspiciously smooth consumption | Every meter's per-interval delta is nearly constant (e.g. 0.42–0.43 kWh every 30 min for `J100000`, day and night; half-hourly meters range 0.12–0.54 kWh per interval). Voltage is uniform random 220–240. Apart from the 5 corrupt rows above, no series has gaps, duplicates, backwards timestamps or register resets. The data is synthetic; anomaly detection on it will find only what was planted. |

---

## 7. Rate limiting and robustness

- A burst of ~75 requests within a couple of seconds (4 concurrent workers) produced
  `429 {"error":"rate_limited","message":"Rate limit exceeded; slow down."}` for
  everything afterwards.
- No `Retry-After` or `X-RateLimit-*` headers. The limit cleared about 20 s after the
  burst stopped.
- A steady **1 request/second for 150 s was never limited**. A crawl at ~3 requests/s
  (330 ms spacing, sequential) tripped it once, after 114 requests in 45 s, then ran
  clean for the remaining 200 s after a 20 s pause and a slower pace.
- Both trips happened at roughly **115–120 requests within a minute** (counting the
  probes that preceded the burst), so the limit is most likely a window of about
  100–120 requests per minute. Not pinned down exactly; 60/min is demonstrably safe.
- The limit appears to be per session/IP across all `/portal/…` routes, not per route.
- Practical rules for a client:
  - one in-flight request at a time, ≥ 1 s apart, is safe; 300 ms is not;
  - on 429, back off ~20 s and retry;
  - on 401 `unauthorized`, re-login once (single-flight) and retry;
  - re-login proactively a few minutes before the 1-hour mark using `expiresAt` from
    `/api/auth/get-session`;
  - prefer the export for anything that touches more than a page of meters: one signed
    request replaces 21 search pages plus 403 geo calls.

Full-crawl cost with the export: 1 keys + 1 export + 2 DT pages + 403 energy calls
≈ 407 requests, about 7 minutes at 1 request/s (or ~4 minutes at the fastest pace that
only tripped the limit once). Since the data is a frozen June 2026
snapshot, that crawl only needs to happen once per process start (or on demand).

---

## 8. Things that do not exist

Tried and got a SvelteKit HTML 404 (so the route simply is not defined):

`/portal/meters` (list without `/search`), `/portal/meters/{id}` (no base detail
endpoint; the detail page gets its nameplate from the page load, §3.6),
`/portal/dts/{code}`, `/portal/dts/{code}/meters`, `/portal/feeders`,
`/portal/substations`, `/portal/hierarchy`, `/portal/network`,
`/portal/meters/export`, `/portal/dts/export`.

---

## 9. How this was discovered

1. Logged in through the browser with DevTools open; captured the login POST, the search
   XHR, and the two XHRs on a meter detail page and the DT list.
2. Deduced the login body from its 50-byte content length (matches
   `email=…&password=…` exactly, not `username=`), then confirmed with curl.
3. Probed pagination, search and error cases with curl; fetched the page HTML and the
   SvelteKit `_app/immutable` bundles it references, and read them to find how the
   "Export all meters" button signs its request and how the search box and sign-out
   work.
4. Reproduced the HMAC signing in Node, pulled the export, and cross-checked it against
   the DT list and the per-meter endpoints.
5. Crawled every meter's energy series (which is how the rate limit was found), and ran
   scripts over the whole dataset for the enum, hierarchy, geo and time-series checks
   in §6.

One correction to an early observation: the search box looked like it fired a request
on every keystroke, but the bundle shows a 250 ms debounce (`setTimeout(I, 250)` on the
`input` event). Fast typing simply out-paced it.
