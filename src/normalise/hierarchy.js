import { HIERARCHY_LEVELS } from './meters.js';

const UPSTREAM = HIERARCHY_LEVELS.slice(0, -1);

function majority(values) {
  const counts = new Map();
  for (const v of values) if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = null;
  for (const [v, n] of counts) if (best === null || n > best.n) best = { v, n };
  return best;
}

export function buildNetwork(meters, transformers) {
  const issues = [];
  const dtByCode = new Map(transformers.map((t) => [t.code, t]));
  const metersByDt = new Map();
  for (const m of meters) {
    if (!metersByDt.has(m.dtCode)) metersByDt.set(m.dtCode, []);
    metersByDt.get(m.dtCode).push(m);
    if (!dtByCode.has(m.dtCode)) {
      issues.push({ type: 'orphan_meter', severity: 'error', meterId: m.id, dtCode: m.dtCode, message: `Meter ${m.id} references DT ${m.dtCode}, which is not in the transformer list` });
    }
  }
  for (const t of transformers) {
    if (!metersByDt.has(t.code)) {
      issues.push({ type: 'empty_transformer', severity: 'warning', dtCode: t.code, message: `DT ${t.code} has no meters` });
    }
  }

  const chainsByDt = new Map();
  for (const [dtCode, dtMeters] of metersByDt) {
    const chain = {};
    for (const level of HIERARCHY_LEVELS) {
      const codeWinner = majority(dtMeters.map((m) => m.hierarchy[level].code));
      const nameWinner = majority(dtMeters.map((m) => m.hierarchy[level].name));
      chain[level] = { code: codeWinner?.v ?? null, name: nameWinner?.v ?? null };
      for (const m of dtMeters) {
        const { code, name } = m.hierarchy[level];
        if (code === null || name === null) {
          issues.push({
            type: 'blank_hierarchy_field', severity: 'warning', meterId: m.id, dtCode, level,
            field: code === null ? 'code' : 'name', resolvedValue: code === null ? chain[level].code : chain[level].name,
            message: `Meter ${m.id} has a blank ${level} ${code === null ? 'code' : 'name'}; resolved from ${dtMeters.length - 1} sibling meters on ${dtCode}`,
          });
        } else if (code !== chain[level].code) {
          issues.push({ type: 'conflicting_hierarchy_code', severity: 'error', meterId: m.id, dtCode, level, value: code, resolvedValue: chain[level].code, message: `Meter ${m.id} says ${level} is ${code}, majority on ${dtCode} says ${chain[level].code}` });
        } else if (name !== chain[level].name) {
          issues.push({ type: 'conflicting_hierarchy_name', severity: 'warning', meterId: m.id, dtCode, level, value: name, resolvedValue: chain[level].name, message: `Meter ${m.id} calls ${level} ${code} "${name}", majority on ${dtCode} says "${chain[level].name}"` });
        }
      }
    }
    const listed = dtByCode.get(dtCode);
    if (listed) {
      if (chain.dt.name !== null && listed.name !== chain.dt.name) {
        issues.push({ type: 'transformer_name_mismatch', severity: 'warning', dtCode, value: chain.dt.name, resolvedValue: listed.name, message: `Transformer list calls ${dtCode} "${listed.name}" but its meters call it "${chain.dt.name}"` });
      }
      if (listed.feederCode && chain.feeder.code && listed.feederCode !== chain.feeder.code) {
        issues.push({ type: 'transformer_feeder_mismatch', severity: 'error', dtCode, value: chain.feeder.code, resolvedValue: listed.feederCode, message: `Transformer list puts ${dtCode} on ${listed.feederCode} but its meters say ${chain.feeder.code}` });
      }
      chain.dt = { code: dtCode, name: listed.name };
      if (listed.feederCode) chain.feeder = { ...chain.feeder, code: listed.feederCode };
    }
    chainsByDt.set(dtCode, chain);
  }

  for (let i = 1; i < UPSTREAM.length; i++) {
    const level = UPSTREAM[i];
    const parentLevel = UPSTREAM[i - 1];
    const parents = new Map();
    for (const chain of chainsByDt.values()) {
      const code = chain[level].code;
      const parent = chain[parentLevel].code;
      if (code === null || parent === null) continue;
      if (!parents.has(code)) parents.set(code, new Set());
      parents.get(code).add(parent);
    }
    for (const [code, set] of parents) {
      if (set.size > 1) {
        issues.push({ type: 'multiple_parents', severity: 'info', level, code, parents: [...set].sort(), message: `${level} ${code} appears under ${set.size} different ${parentLevel}s: ${[...set].sort().join(', ')}` });
      }
    }
  }

  const root = { level: 'root', code: null, name: 'Network', children: new Map() };
  for (const [dtCode, chain] of [...chainsByDt].sort(([a], [b]) => a.localeCompare(b))) {
    let node = root;
    for (const level of UPSTREAM) {
      const { code, name } = chain[level];
      const key = code ?? '(unknown)';
      if (!node.children.has(key)) node.children.set(key, { level, code, name, children: new Map() });
      node = node.children.get(key);
    }
    const dtMeters = metersByDt.get(dtCode) ?? [];
    const listed = dtByCode.get(dtCode);
    node.children.set(dtCode, {
      level: 'dt', code: dtCode, name: chain.dt.name, capacityKva: listed?.capacityKva ?? null,
      meterCount: dtMeters.length, meterIds: dtMeters.map((m) => m.id).sort(),
    });
  }
  const toPlain = (node) => ({
    ...node,
    children: node.children ? [...node.children.values()].map(toPlain) : undefined,
  });
  const tree = toPlain(root).children;

  const counts = {};
  for (const issue of issues) counts[issue.type] = (counts[issue.type] ?? 0) + 1;

  return {
    tree,
    chainsByDt,
    metersByDt,
    issues,
    stats: {
      meters: meters.length,
      transformers: transformers.length,
      feeders: new Set([...chainsByDt.values()].map((c) => c.feeder.code).filter(Boolean)).size,
      substations: new Set([...chainsByDt.values()].map((c) => c.substation.code).filter(Boolean)).size,
      issueCounts: counts,
    },
  };
}
