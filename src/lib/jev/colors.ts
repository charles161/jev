import { BoardTheme, ColorTone } from "./types";

export interface TonePalette {
  stroke: string;
  fill: string;
  fillSolid: string;
  text: string;
  subtext: string;
  swatch: string;
  label: string;
}

export const VELLUM_PALETTES: Record<ColorTone, TonePalette> = {
  ink: {
    stroke: "#1F232B",
    fill: "rgba(255, 253, 248, 0.92)",
    fillSolid: "#FFFDF8",
    text: "#181B22",
    subtext: "#5C6370",
    swatch: "#1F232B",
    label: "Charcoal Ink",
  },
  terracotta: {
    stroke: "#C84B28",
    fill: "rgba(232, 108, 69, 0.13)",
    fillSolid: "#FCEEE8",
    text: "#7F2A12",
    subtext: "#A3452A",
    swatch: "#D94E28",
    label: "Terracotta",
  },
  cobalt: {
    stroke: "#2354B8",
    fill: "rgba(59, 113, 224, 0.12)",
    fillSolid: "#ECF2FD",
    text: "#163578",
    subtext: "#355DA8",
    swatch: "#2563EB",
    label: "Drafting Cobalt",
  },
  teal: {
    stroke: "#166E63",
    fill: "rgba(22, 138, 122, 0.12)",
    fillSolid: "#E7F6F3",
    text: "#0E4B43",
    subtext: "#2B6E64",
    swatch: "#0F766E",
    label: "Studio Teal",
  },
  ochre: {
    stroke: "#B36A13",
    fill: "rgba(224, 149, 38, 0.14)",
    fillSolid: "#FDF5E4",
    text: "#724108",
    subtext: "#985C16",
    swatch: "#D97706",
    label: "Warm Ochre",
  },
  plum: {
    stroke: "#7A3485",
    fill: "rgba(147, 68, 161, 0.12)",
    fillSolid: "#F7EDF9",
    text: "#521E5B",
    subtext: "#783E82",
    swatch: "#9333EA",
    label: "Studio Plum",
  },
  slate: {
    stroke: "#5A6577",
    fill: "rgba(100, 116, 139, 0.09)",
    fillSolid: "#F1F3F6",
    text: "#2F3744",
    subtext: "#5A6577",
    swatch: "#64748B",
    label: "Drafting Slate",
  },
};

export const MIDNIGHT_PALETTES: Record<ColorTone, TonePalette> = {
  ink: {
    stroke: "#E6E1D6",
    fill: "rgba(31, 37, 49, 0.92)",
    fillSolid: "#1F2531",
    text: "#F4F1EA",
    subtext: "#9EA7B8",
    swatch: "#E6E1D6",
    label: "Chalk Ivory",
  },
  terracotta: {
    stroke: "#F47D5B",
    fill: "rgba(240, 100, 62, 0.18)",
    fillSolid: "#2F201E",
    text: "#FFD5C7",
    subtext: "#E59D87",
    swatch: "#F0643E",
    label: "Ember Coral",
  },
  cobalt: {
    stroke: "#60A5FA",
    fill: "rgba(59, 130, 246, 0.18)",
    fillSolid: "#1B283D",
    text: "#DBEAFE",
    subtext: "#93C5FD",
    swatch: "#3B82F6",
    label: "Blueprint Blue",
  },
  teal: {
    stroke: "#34D399",
    fill: "rgba(16, 185, 129, 0.16)",
    fillSolid: "#172E2B",
    text: "#D1FAE5",
    subtext: "#6EE7B7",
    swatch: "#10B981",
    label: "Mint Signal",
  },
  ochre: {
    stroke: "#FBBF24",
    fill: "rgba(245, 158, 11, 0.17)",
    fillSolid: "#2E2718",
    text: "#FEF3C7",
    subtext: "#FCD34D",
    swatch: "#F59E0B",
    label: "Amber Ochre",
  },
  plum: {
    stroke: "#C084FC",
    fill: "rgba(168, 85, 247, 0.18)",
    fillSolid: "#291E36",
    text: "#F3E8FF",
    subtext: "#D8B4FE",
    swatch: "#A855F7",
    label: "Violet Chalk",
  },
  slate: {
    stroke: "#94A3B8",
    fill: "rgba(148, 163, 184, 0.12)",
    fillSolid: "#1E2430",
    text: "#E2E8F0",
    subtext: "#94A3B8",
    swatch: "#94A3B8",
    label: "Steel Slate",
  },
};

export function getTonePalette(tone: ColorTone, theme: BoardTheme): TonePalette {
  const palettes = theme === "midnight" ? MIDNIGHT_PALETTES : VELLUM_PALETTES;
  if (
    typeof tone === "string" &&
    Object.prototype.hasOwnProperty.call(palettes, tone)
  ) {
    return palettes[tone];
  }
  return palettes.ink;
}

export const ALL_TONES: ColorTone[] = [
  "ink",
  "terracotta",
  "cobalt",
  "teal",
  "ochre",
  "plum",
  "slate",
];

export const PEER_COLORS = [
  "#D94E28",
  "#2563EB",
  "#0F766E",
  "#9333EA",
  "#D97706",
  "#DB2777",
];

export function inferToneFromLabel(label: string): ColorTone {
  const lower = label.toLowerCase();
  if (
    /(user|client|browser|mobile|\bapp\b|customer|frontend|\bweb\b|\bui\b|visitor|creator|team)/.test(
      lower
    )
  ) {
    return "terracotta";
  }
  if (
    /(\bdb\b|database|postgres|mysql|mongo|sqlite|redis|cache|store|storage|\bs3\b|bucket|warehouse|vector|index|replica)/.test(
      lower
    )
  ) {
    return "teal";
  }
  if (
    /(queue|kafka|rabbit|pubsub|event|stream|webhook|worker|\bjob\b|cron|\bbus\b|broker|async|notification)/.test(
      lower
    )
  ) {
    return "ochre";
  }
  if (
    /(\?|check|valid|auth|oauth|jwt|guard|policy|decide|router|condition|filter|verify|\bgate\b|score)/.test(
      lower
    )
  ) {
    return "plum";
  }
  if (
    /(\bapi\b|gateway|server|service|engine|webrtc|signal|sync|backend|edge|\bcdn\b|proxy|\bllm\b|agent|model|mesh)/.test(
      lower
    )
  ) {
    return "cobalt";
  }
  if (/(zone|\bvpc\b|cluster|layer|group|cloud|region|boundary|frame)/.test(lower)) {
    return "slate";
  }
  return "ink";
}
