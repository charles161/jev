import type { CSSProperties } from "react";
import { ICONS, IconBox, IconSpark, SkotMark } from "./index";
import { appUrl } from "@/lib/base-path";

const TERRACOTTA = "#D94E28";

const THEMES = {
  light: { name: "Paper", bg: "#f7f4ed", fg: "#181b22", muted: "#6b6f78", line: "#e2dccf", cell: "#fdfbf7" },
  dark: { name: "Ink", bg: "#11151d", fg: "#edeae2", muted: "#8e98a8", line: "#232a38", cell: "#161b25" },
} as const;

type Theme = (typeof THEMES)[keyof typeof THEMES];

const mono: CSSProperties = { fontFamily: "var(--font-mono), ui-monospace, monospace" };
const sans: CSSProperties = { fontFamily: "var(--font-sans), system-ui, sans-serif" };
const sketch: CSSProperties = { fontFamily: "var(--font-sketch), var(--font-serif), cursive" };

const RULES = [
  ["Grid", "24 x 24, 2px live-area padding"],
  ["Stroke", "1.75, round caps and joins"],
  ["Corners", "2px radius on every rectangle"],
  ["Skot corner", "top-left stays open: top edge overshoots 2px"],
  ["Spark", "solid four-point star marks anything AI"],
  ["Colour", "currentColor only"],
] as const;

function Panel({ theme }: { theme: Theme }) {
  return (
    <section
      style={{
        background: theme.bg,
        color: theme.fg,
        border: `1px solid ${theme.line}`,
        borderRadius: 14,
        padding: 20,
        flex: "1 1 420px",
        minWidth: 0,
      }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
        <h2 style={{ ...sans, fontSize: 14, fontWeight: 600, margin: 0 }}>{theme.name}</h2>
        <span style={{ ...mono, fontSize: 11, color: theme.muted }}>24px / 16px</span>
      </header>
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
          gap: 6,
        }}
      >
        {ICONS.map(({ name, Icon }) => (
          <li
            key={name}
            style={{
              background: theme.cell,
              border: `1px solid ${theme.line}`,
              borderRadius: 8,
              padding: "12px 6px 8px",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12, height: 24 }}>
              <Icon size={24} title={name} />
              <Icon size={16} />
            </div>
            <span style={{ ...mono, fontSize: 9.5, color: theme.muted, letterSpacing: "-0.01em" }}>
              {name.replace(/^Icon/, "")}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Keyline() {
  const cells = Array.from({ length: 25 }, (_, i) => i);
  return (
    <svg viewBox="-1 -1 26 26" width={168} height={168} aria-hidden="true" style={{ color: THEMES.light.fg }}>
      {cells.map((i) => (
        <g key={i} stroke={THEMES.light.line} strokeWidth={0.05}>
          <line x1={i} y1={0} x2={i} y2={24} />
          <line x1={0} y1={i} x2={24} y2={i} />
        </g>
      ))}
      <rect x={2} y={2} width={20} height={20} fill="none" stroke={TERRACOTTA} strokeWidth={0.06} strokeDasharray="0.4 0.3" />
      <IconBox x={0} y={0} width={24} height={24} />
      <circle cx={2} cy={5} r={1.3} fill="none" stroke={TERRACOTTA} strokeWidth={0.12} />
    </svg>
  );
}

export function ContactSheet({ faviconSrc = appUrl("/icon.svg") }: { faviconSrc?: string }) {
  return (
    <main
      style={{
        ...sans,
        minHeight: "100%",
        background: "#ece7dc",
        color: THEMES.light.fg,
        padding: "32px 16px 48px",
      }}
    >
      <div style={{ maxWidth: 1240, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        <header style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <span
              style={{
                width: 28,
                height: 28,
                borderRadius: 7,
                background: TERRACOTTA,
                color: "#fff",
                display: "grid",
                placeItems: "center",
              }}
            >
              <SkotMark size={18} />
            </span>
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>Skot icons</h1>
              <p style={{ ...sketch, margin: 0, fontSize: 15, color: THEMES.light.muted }}>
                drawn at the speed of thought
              </p>
            </div>
          </div>
          <span style={{ ...mono, fontSize: 12, color: THEMES.light.muted }}>{ICONS.length} glyphs</span>
        </header>

        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: 16,
            background: THEMES.light.cell,
            border: `1px solid ${THEMES.light.line}`,
            borderRadius: 14,
            padding: 20,
            alignItems: "center",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <span
              style={{
                width: 112,
                height: 112,
                borderRadius: 26,
                background: TERRACOTTA,
                color: "#fff",
                display: "grid",
                placeItems: "center",
                flex: "none",
              }}
            >
              <SkotMark size={76} />
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <span style={{ ...mono, fontSize: 11, color: THEMES.light.muted }}>favicon</span>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 12 }}>
                {/* eslint-disable-next-line @next/next/no-img-element -- static SVG preview at exact pixel sizes */}
                <img src={faviconSrc} width={16} height={16} alt="Skot favicon at 16px" />
                {/* eslint-disable-next-line @next/next/no-img-element -- static SVG preview at exact pixel sizes */}
                <img src={faviconSrc} width={32} height={32} alt="Skot favicon at 32px" />
                {/* eslint-disable-next-line @next/next/no-img-element -- static SVG preview at exact pixel sizes */}
                <img src={faviconSrc} width={64} height={64} alt="Skot favicon at 64px" />
              </div>
              <span style={{ display: "flex", gap: 8, alignItems: "center", color: TERRACOTTA }}>
                <IconSpark size={20} />
                <span style={{ ...mono, fontSize: 11, color: THEMES.light.muted }}>spark = AI</span>
              </span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Keyline />
            <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: 12 }}>
              {RULES.map(([k, v]) => (
                <div key={k} style={{ display: "contents" }}>
                  <dt style={{ ...mono, color: THEMES.light.muted }}>{k}</dt>
                  <dd style={{ margin: 0 }}>{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
          <Panel theme={THEMES.light} />
          <Panel theme={THEMES.dark} />
        </div>
      </div>
    </main>
  );
}
