export const IST_OFFSET = '+05:30';
const MINUTE = 60 * 1000;

export function parsePortalTimestamp(s) {
  const m = /^(\d\d)\/(\d\d)\/(\d{4}) (\d\d):(\d\d)$/.exec(s ?? '');
  if (!m) return null;
  const [, dd, mm, yyyy, hh, mi] = m;
  const wallUtc = Date.UTC(+yyyy, +mm - 1, +dd, +hh, +mi);
  if (Number.isNaN(wallUtc)) return null;
  const d = new Date(wallUtc);
  if (d.getUTCDate() !== +dd || d.getUTCMonth() !== +mm - 1) return null;
  return { iso: `${yyyy}-${mm}-${dd}T${hh}:${mi}:00${IST_OFFSET}`, epoch: wallUtc - 330 * MINUTE };
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(n, places = 3) {
  return n === null ? null : Math.round(n * 10 ** places) / 10 ** places;
}

export function detectCadence(readings) {
  if (readings.length < 2) return 'unknown';
  const steps = [];
  for (let i = 1; i < readings.length; i++) steps.push(readings[i].intervalMinutes);
  steps.sort((a, b) => a - b);
  const median = steps[Math.floor(steps.length / 2)];
  if (median === 30) return '30min';
  if (median === 1440) return 'daily';
  return 'irregular';
}

export function normaliseReadings(rows) {
  const dropped = [];
  const seen = new Set();
  const parsed = [];

  rows.forEach((row, index) => {
    const ts = parsePortalTimestamp(row.timestamp);
    const kwh = toNumber(row.kwh);
    const kvah = toNumber(row.kvah);
    const voltR = toNumber(row.voltR);
    const reasons = [];
    if (!ts) reasons.push('unparsable_timestamp');
    if (kwh === null) reasons.push('missing_kwh');
    if (kvah === null) reasons.push('missing_kvah');
    if (ts && seen.has(ts.iso)) reasons.push('duplicate_timestamp');
    if (reasons.length) {
      dropped.push({ index, timestamp: row.timestamp ?? null, reasons });
      return;
    }
    seen.add(ts.iso);
    parsed.push({ timestamp: ts.iso, epoch: ts.epoch, kwh, kvah, voltR });
  });

  parsed.sort((a, b) => a.epoch - b.epoch);

  const readings = parsed.map((r, i) => {
    const prev = i > 0 ? parsed[i - 1] : null;
    const intervalMinutes = prev ? Math.round((r.epoch - prev.epoch) / MINUTE) : null;
    const intervalKwh = prev ? round(r.kwh - prev.kwh) : null;
    const intervalKvah = prev ? round(r.kvah - prev.kvah) : null;
    return {
      timestamp: r.timestamp,
      kwh: r.kwh,
      kvah: r.kvah,
      voltR: r.voltR,
      intervalMinutes,
      intervalKwh,
      intervalKvah,
      anomalies: intervalKwh !== null && intervalKwh < 0 ? ['register_decrease'] : [],
    };
  });

  const cadence = detectCadence(readings);
  const first = readings[0];
  const last = readings[readings.length - 1];
  const spanMs = parsed.length ? parsed[parsed.length - 1].epoch - parsed[0].epoch : 0;
  const days = spanMs / (24 * 60 * MINUTE);
  const totalKwh = first && last ? round(last.kwh - first.kwh) : null;

  return {
    cadence,
    readings,
    dropped,
    summary: {
      count: readings.length,
      from: first?.timestamp ?? null,
      to: last?.timestamp ?? null,
      totalKwh,
      totalKvah: first && last ? round(last.kvah - first.kvah) : null,
      averageDailyKwh: totalKwh !== null && days > 0 ? round(totalKwh / days, 2) : null,
      averageKva: first && last && spanMs > 0 ? round((last.kvah - first.kvah) / (spanMs / (60 * MINUTE)), 3) : null,
      minVoltR: readings.length ? Math.min(...readings.map((r) => r.voltR).filter((v) => v !== null)) : null,
      maxVoltR: readings.length ? Math.max(...readings.map((r) => r.voltR).filter((v) => v !== null)) : null,
    },
  };
}
