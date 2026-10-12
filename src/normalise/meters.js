export const HIERARCHY_LEVELS = ['zone', 'circle', 'division', 'subdivision', 'substation', 'feeder', 'dt'];

const STATUS = { Installed: 'installed', Faulty: 'faulty', Decommissioned: 'decommissioned' };
const PHASE = { single: 'single', three: 'three' };
const INSTALL_TYPE = { 'Whole Current': 'whole_current', 'CT Operated': 'ct_operated' };
const BUILD = { legacy: 'legacy', v2: 'v2' };

function mapEnum(table, value) {
  if (value in table) return table[value];
  return value === undefined || value === null || value === '' ? null : String(value).toLowerCase().replace(/\s+/g, '_');
}

const blankToNull = (v) => (v === undefined || v === null || v === '' ? null : v);

export function normaliseMeter(rec) {
  const hierarchy = {};
  for (const level of HIERARCHY_LEVELS) {
    const node = rec.hierarchy?.[level] ?? {};
    hierarchy[level] = { code: blankToNull(node.code), name: blankToNull(node.name) };
  }
  const lat = Number(rec.geo?.lat ?? rec.geo?.latitude);
  const lng = Number(rec.geo?.lng ?? rec.geo?.longitude);
  return {
    id: rec.meterId,
    serialNo: rec.serialNo,
    make: rec.make,
    phaseType: mapEnum(PHASE, rec.phaseType),
    installStatus: mapEnum(STATUS, rec.installStatus),
    installType: mapEnum(INSTALL_TYPE, rec.installType),
    build: mapEnum(BUILD, rec.build),
    dtCode: rec.dtCode,
    location: Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null,
    hierarchy,
  };
}

export function normaliseTransformer(row) {
  return {
    code: row.code,
    name: row.name,
    feederCode: blankToNull(row.feederCode),
    capacityKva: Number(row.capacityKva),
  };
}

export function meterSummary(m) {
  const { hierarchy, ...rest } = m;
  return { ...rest, feederCode: hierarchy.feeder.code };
}
