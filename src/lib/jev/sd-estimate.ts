/**
 * Back-of-envelope system-design estimator: pure and deterministic. Decimal units throughout
 * (1 KB = 1000 B, 1 day = 86 400 s), as interview estimates are done.
 */

export interface EstimateInput {
  dau: number;
  /** Writes (creates) per user per day. */
  writesPerUser: number;
  /** Reads per write. */
  readWriteRatio: number;
  payloadBytes: number;
  retentionYears: number;
  peakFactor: number;
}

export const ESTIMATE_DEFAULTS: EstimateInput = {
  dau: 1e6,
  writesPerUser: 10,
  readWriteRatio: 10,
  payloadBytes: 1000,
  retentionYears: 5,
  peakFactor: 3,
};

const SECONDS_PER_DAY = 86_400;
const CACHE_HOT_FRACTION = 0.2;

export interface EstimateResult {
  input: EstimateInput;
  writesPerDay: number;
  readsPerDay: number;
  avgWriteQps: number;
  peakWriteQps: number;
  avgReadQps: number;
  peakReadQps: number;
  storagePerDay: number;
  storagePerYear: number;
  storageTotal: number;
  ingressBytesPerSec: number;
  egressBytesPerSec: number;
  cacheBytes: number;
}

export function estimate(input: EstimateInput): EstimateResult {
  const writesPerDay = input.dau * input.writesPerUser;
  const readsPerDay = writesPerDay * input.readWriteRatio;
  const avgWriteQps = writesPerDay / SECONDS_PER_DAY;
  const avgReadQps = avgWriteQps * input.readWriteRatio;
  const storagePerDay = writesPerDay * input.payloadBytes;
  return {
    input,
    writesPerDay,
    readsPerDay,
    avgWriteQps,
    peakWriteQps: avgWriteQps * input.peakFactor,
    avgReadQps,
    peakReadQps: avgReadQps * input.peakFactor,
    storagePerDay,
    storagePerYear: storagePerDay * 365,
    storageTotal: storagePerDay * 365 * input.retentionYears,
    ingressBytesPerSec: avgWriteQps * input.payloadBytes,
    egressBytesPerSec: avgReadQps * input.payloadBytes,
    cacheBytes: readsPerDay * input.payloadBytes * CACHE_HOT_FRACTION,
  };
}

function scaled(value: number, units: readonly string[]): { text: string; unit: string } {
  if (!Number.isFinite(value) || value === 0) return { text: "0", unit: units[0] };
  const abs = Math.abs(value);
  let i = 0;
  while (abs >= 1000 ** (i + 1) && i < units.length - 1) i++;
  const n = (abs / 1000 ** i) * (1 + 1e-12);
  let text = String(Number(n.toPrecision(3)));
  if (text === "1000" && i < units.length - 1) {
    i++;
    text = "1";
  }
  return { text: `${value < 0 ? "-" : ""}${text}`, unit: units[i] };
}

export function formatCount(value: number): string {
  const s = scaled(value, ["", "K", "M", "B", "T"]);
  return `${s.text}${s.unit}`;
}

export function formatBytes(value: number): string {
  const s = scaled(value, ["B", "KB", "MB", "GB", "TB", "PB", "EB"]);
  return `${s.text} ${s.unit}`;
}

export interface ParsedEstimate {
  input: EstimateInput;
  /** Inputs the text did not state, so the defaults were used. */
  assumed: Array<keyof EstimateInput>;
}

const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };
const NUM = String.raw`(\d+(?:\.\d+)?)`;

interface Rule {
  key: keyof EstimateInput;
  patterns: RegExp[];
  value: (m: RegExpMatchArray) => number;
}

/** Rules run in this order and each consumes its match, so "100M DAU" is gone before the byte-size rule runs. */
const RULES: Rule[] = [
  {
    key: "dau",
    patterns: [new RegExp(String.raw`${NUM}\s*([kmb])?\s*(?:dau|daily active users|daily users|users)\b`, "i")],
    value: (m) => Number(m[1]) * (m[2] ? SUFFIX[m[2].toLowerCase()] : 1),
  },
  {
    key: "writesPerUser",
    patterns: [new RegExp(String.raw`${NUM}\s*[a-z]*\s*(?:\/|per)\s*(?:user|u)\b(?:\s*(?:\/|per)\s*day)?`, "i")],
    value: (m) => Number(m[1]),
  },
  {
    key: "peakFactor",
    patterns: [
      new RegExp(String.raw`${NUM}\s*[x×]\s*peak`, "i"),
      new RegExp(String.raw`peak(?:\s*factor)?\s*[x×]?\s*${NUM}\s*[x×]?`, "i"),
    ],
    value: (m) => Number(m[1]),
  },
  {
    key: "readWriteRatio",
    patterns: [
      new RegExp(String.raw`(?:read\s*[:/]\s*write|r\s*:\s*w|rw)\s*${NUM}\s*:\s*${NUM}`, "i"),
      new RegExp(String.raw`${NUM}\s*reads?\s*(?:\/|per)\s*write`, "i"),
      new RegExp(String.raw`${NUM}\s*[x×]\s*reads?`, "i"),
      new RegExp(String.raw`\b${NUM}\s*:\s*${NUM}\b`),
    ],
    value: (m) => (m[2] !== undefined ? Number(m[1]) / Math.max(1e-9, Number(m[2])) : Number(m[1])),
  },
  {
    key: "retentionYears",
    patterns: [new RegExp(String.raw`${NUM}\s*(?:y|yr|yrs|years?)\b`, "i")],
    value: (m) => Number(m[1]),
  },
  {
    key: "payloadBytes",
    patterns: [new RegExp(String.raw`${NUM}\s*(bytes?|b|kb|mb)\b`, "i")],
    value: (m) => {
      const unit = m[2].toLowerCase();
      return Number(m[1]) * (unit === "kb" ? 1e3 : unit === "mb" ? 1e6 : 1);
    },
  },
];

/** Free text such as "100M DAU, 10 writes/user/day, 1KB, 5y" → estimator inputs, defaults for the rest. */
export function parseEstimateText(text: string): ParsedEstimate {
  let rest = ` ${text} `;
  const input: EstimateInput = { ...ESTIMATE_DEFAULTS };
  const stated = new Set<keyof EstimateInput>();
  for (const rule of RULES) {
    for (const re of rule.patterns) {
      const m = rest.match(re);
      if (!m) continue;
      const v = rule.value(m);
      if (Number.isFinite(v) && v >= 0) {
        input[rule.key] = v;
        stated.add(rule.key);
      }
      rest = rest.replace(m[0], " ");
      break;
    }
  }
  const order = Object.keys(ESTIMATE_DEFAULTS) as Array<keyof EstimateInput>;
  return { input, assumed: order.filter((k) => !stated.has(k)) };
}

function assumption(key: keyof EstimateInput, input: EstimateInput): string {
  switch (key) {
    case "dau":
      return `${formatCount(input.dau)} DAU`;
    case "writesPerUser":
      return `${input.writesPerUser} writes/user/day`;
    case "readWriteRatio":
      return `read:write ${input.readWriteRatio}:1`;
    case "payloadBytes":
      return `${formatBytes(input.payloadBytes)} per write`;
    case "retentionYears":
      return `${input.retentionYears} y retention`;
    case "peakFactor":
      return `peak ×${input.peakFactor}`;
  }
}

/** A numbers card: label = title, sublabel = one line per result with the arithmetic that produced it. */
export function formatEstimateCard(parsed: ParsedEstimate): { label: string; sublabel: string } {
  const { input } = parsed;
  const r = estimate(input);
  const pay = formatBytes(input.payloadBytes);
  const lines = [
    `Writes: ${formatCount(input.dau)} DAU × ${input.writesPerUser} / 86 400 s ≈ ${formatCount(r.avgWriteQps)} QPS (peak ×${input.peakFactor} ≈ ${formatCount(r.peakWriteQps)})`,
    `Reads: ${formatCount(r.avgWriteQps)} × ${input.readWriteRatio} ≈ ${formatCount(r.avgReadQps)} QPS (peak ≈ ${formatCount(r.peakReadQps)})`,
    `Storage: ${formatCount(r.writesPerDay)} writes/day × ${pay} ≈ ${formatBytes(r.storagePerDay)}/day, ${formatBytes(r.storagePerYear)}/yr`,
    `Total over ${input.retentionYears} y: ${formatBytes(r.storagePerYear)} × ${input.retentionYears} ≈ ${formatBytes(r.storageTotal)}`,
    `Bandwidth: in ≈ ${formatBytes(r.ingressBytesPerSec)}/s, out ${formatCount(r.avgReadQps)} × ${pay} ≈ ${formatBytes(r.egressBytesPerSec)}/s`,
    `Cache (20% hot): ${formatCount(r.readsPerDay)} reads/day × ${pay} × 0.2 ≈ ${formatBytes(r.cacheBytes)}`,
  ];
  if (parsed.assumed.length > 0) {
    lines.push(`Assumed: ${parsed.assumed.map((k) => assumption(k, input)).join(", ")}`);
  }
  return { label: `Numbers · ${formatCount(input.dau)} DAU`, sublabel: lines.join("\n") };
}
