/** @jsxImportSource react */
/**
 * Feature-local analytics visualisations.
 *
 * DELIBERATE: no imports from `src/components/ui` or `src/components/fit`.
 * Karan owns those and they may not exist yet — a hard import from a parallel
 * session's directory is how a typecheck dies on someone else's schedule. Every
 * colour here reads a CSS custom property with the value from
 * `docs/DESIGN_SYSTEM.md` as its fallback, so these components drop into the
 * design system the moment the tokens land, and render correctly if they do not.
 *
 * Accessibility is not optional on a data view: every chart carries an
 * `aria-label` summary and a visually hidden table, so the numbers are readable
 * by a screen reader and by anyone who cannot tell two shades of teal apart.
 */
import type { CSSProperties, ReactNode } from "react";
import { formatDay } from "../format";
import type { ClaimTier, DemandDimension, Opportunity, TrendPoint } from "../types";

/** Token names from docs/DESIGN_SYSTEM.md §2, with the documented hex fallback. */
const TOKEN = {
  canvas: "var(--canvas, #F6F4EF)",
  surface: "var(--surface, #FFFDF8)",
  ink: "var(--ink, #17150F)",
  inkMuted: "var(--ink-muted, #6F6A5E)",
  inkFaint: "var(--ink-faint, #9A948A)",
  rule: "var(--rule, #E4E0D6)",
  accent: "var(--accent, #0E4F4A)",
  accentSoft: "var(--accent-soft, #D7E4E2)",
  alarm: "var(--alarm, #B23A2E)",
  fit: "var(--fit, #4A6B3A)",
  warn: "var(--warn, #9A6B1F)",
  info: "var(--info, #3D5A80)",
} as const;

const TIER_TONE: Record<ClaimTier, string> = {
  observed: TOKEN.fit,
  inferred: TOKEN.warn,
  suggested: TOKEN.info,
};

const TIER_LABEL: Record<ClaimTier, string> = {
  observed: "Observed",
  inferred: "Inferred",
  suggested: "Suggested",
};

/** Warm carbon, never #000. Serif display, UI sans, mono figures. */
const type = {
  display: "var(--font-display, Georgia, serif)",
  ui: "var(--font-ui, system-ui, sans-serif)",
  data: "var(--font-data, ui-monospace, monospace)",
} as const;

const srOnly: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
};

export function SrOnly({ children }: { children: ReactNode }): ReactNode {
  return <span style={srOnly}>{children}</span>;
}

/** OBSERVED / INFERRED / SUGGESTED. The badge the whole feature hangs on. */
export function TierBadge({ tier, title }: { tier: ClaimTier; title?: string }): ReactNode {
  return (
    <span
      title={title}
      style={{
        display: "inline-block",
        border: `1px solid ${TIER_TONE[tier]}`,
        color: TIER_TONE[tier],
        borderRadius: 2,
        padding: "0 4px",
        fontFamily: type.data,
        fontSize: 10,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    >
      {TIER_LABEL[tier]}
    </span>
  );
}

export function Panel({
  title,
  subtitle,
  aside,
  children,
}: {
  title: string;
  subtitle?: string;
  aside?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <section
      style={{
        background: TOKEN.surface,
        border: `1px solid ${TOKEN.rule}`,
        borderRadius: 8,
        padding: 16,
        fontFamily: type.ui,
        color: TOKEN.ink,
      }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontFamily: type.display, fontSize: 18, fontWeight: 400 }}>{title}</h3>
          {subtitle === undefined ? null : (
            <p style={{ margin: "2px 0 0", fontSize: 12, color: TOKEN.inkMuted }}>{subtitle}</p>
          )}
        </div>
        {aside}
      </header>
      <div style={{ marginTop: 12 }}>{children}</div>
    </section>
  );
}

/** Compact metric card. `value` is a pre-formatted string so the caller owns the unit. */
export function MetricCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "alarm" | "fit";
}): ReactNode {
  const colour = tone === "alarm" ? TOKEN.alarm : tone === "fit" ? TOKEN.fit : TOKEN.ink;
  return (
    <div
      style={{
        border: `1px solid ${TOKEN.rule}`,
        borderRadius: 8,
        padding: "10px 12px",
        background: TOKEN.surface,
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: 11, color: TOKEN.inkMuted, letterSpacing: "0.04em" }}>{label}</div>
      <div
        style={{
          fontFamily: type.data,
          fontVariantNumeric: "tabular-nums",
          fontSize: 24,
          lineHeight: 1.2,
          color: colour,
        }}
      >
        {value}
      </div>
      {sub === undefined ? null : (
        <div style={{ fontSize: 11, color: TOKEN.inkFaint, fontFamily: type.data }}>{sub}</div>
      )}
    </div>
  );
}

/**
 * Horizontal bars. The default representation for a count with a label, because
 * a bar chart of 3 to 7 categories beats an axis you have to decode.
 */
export function DemandBars({
  dimension,
  max = 8,
  onSelect,
}: {
  dimension: DemandDimension;
  max?: number;
  onSelect?: (key: string) => void;
}): ReactNode {
  const shown = dimension.bars.slice(0, max);
  const peak = Math.max(1, ...shown.map((b) => b.value));
  const summary = `${dimension.n} searches. ${shown
    .map((b) => `${b.label} ${b.value}`)
    .join(", ")}`;

  if (!dimension.reliable) {
    return (
      <div style={{ fontSize: 12, color: TOKEN.inkMuted }}>
        Not enough signal yet. {dimension.n} searches, and we need{" "}
        <span style={{ fontFamily: type.data }}>{dimension.n < 1 ? 1 : dimension.n}</span> more before this
        chart says anything.
      </div>
    );
  }

  return (
    <figure style={{ margin: 0 }}>
      <SrOnly>{summary}</SrOnly>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
        {shown.map((bar) => (
          <li key={bar.key}>
            <button
              type="button"
              onClick={onSelect === undefined ? undefined : () => onSelect(bar.key)}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(90px, 34%) 1fr auto",
                alignItems: "center",
                gap: 8,
                width: "100%",
                background: "none",
                border: 0,
                padding: "2px 0",
                cursor: onSelect === undefined ? "default" : "pointer",
                font: "inherit",
                textAlign: "left",
                color: TOKEN.ink,
              }}
            >
              <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {bar.label}
              </span>
              <span
                style={{
                  height: 10,
                  background: TOKEN.rule,
                  borderRadius: 2,
                  overflow: "hidden",
                }}
              >
                <span
                  style={{
                    display: "block",
                    height: "100%",
                    width: `${Math.round((bar.value / peak) * 100)}%`,
                    background: bar.tier === "inferred" ? TOKEN.warn : TOKEN.accent,
                  }}
                />
              </span>
              <span style={{ fontFamily: type.data, fontVariantNumeric: "tabular-nums", fontSize: 12 }}>
                {bar.value}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {dimension.bars.length > shown.length ? (
        <figcaption style={{ marginTop: 6, fontSize: 11, color: TOKEN.inkFaint }}>
          {dimension.bars.length - shown.length} more not shown
        </figcaption>
      ) : null}
    </figure>
  );
}

/**
 * Two series over the window as inline SVG. A sparkline nobody can read the
 * values off is decoration, so each point carries a title and the whole series
 * is repeated in a hidden table.
 */
export function TrendLine({
  points,
  height = 96,
}: {
  points: readonly TrendPoint[];
  height?: number;
}): ReactNode {
  const width = 320;
  const pad = 4;
  const peak = Math.max(1, ...points.map((p) => Math.max(p.impressions, p.requests)));
  const x = (i: number): number =>
    points.length <= 1 ? pad : pad + (i * (width - pad * 2)) / (points.length - 1);
  const y = (v: number): number => height - pad - (v / peak) * (height - pad * 2);
  const line = (pick: (p: TrendPoint) => number): string =>
    points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(pick(p)).toFixed(1)}`).join(" ");

  const totalImpressions = points.reduce((a, p) => a + p.impressions, 0);
  const totalRequests = points.reduce((a, p) => a + p.requests, 0);

  return (
    <figure style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Impressions ${totalImpressions}, requests ${totalRequests}, over ${points.length} days`}
        style={{ width: "100%", height, display: "block" }}
      >
        <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke={TOKEN.rule} strokeWidth={1} />
        <path d={line((p) => p.impressions)} fill="none" stroke={TOKEN.accent} strokeWidth={1.5} />
        <path d={line((p) => p.requests)} fill="none" stroke={TOKEN.alarm} strokeWidth={1.5} strokeDasharray="3 2" />
        {points.map((p, i) => (
          <circle key={p.date} cx={x(i)} cy={y(p.requests)} r={2} fill={TOKEN.alarm}>
            <title>{`${p.date}: ${p.impressions} impressions, ${p.requests} requests`}</title>
          </circle>
        ))}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: TOKEN.inkFaint, fontFamily: type.data }}>
        <span>{points.length === 0 ? "" : formatDay(points[0]!.date)}</span>
        <span style={{ color: TOKEN.accent }}>impressions {totalImpressions}</span>
        <span style={{ color: TOKEN.alarm }}>requests {totalRequests}</span>
        <span>{points.length === 0 ? "" : formatDay(points[points.length - 1]!.date)}</span>
      </div>
      <table style={{ ...srOnly, position: "static", width: 1, height: 1 }}>
        <caption>Daily impressions and requests</caption>
        <tbody>
          {points.map((p) => (
            <tr key={p.date}>
              <th scope="row">{p.date}</th>
              <td>{p.impressions}</td>
              <td>{p.requests}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/**
 * Locality by time-of-day. The compact version of the demand picture: one glance
 * answers "where and when", which is the question a provider actually has.
 */
export function DemandHeatGrid({
  rows,
  columns,
  cells,
}: {
  rows: readonly string[];
  columns: readonly string[];
  /** `${row}|${column}` -> count. Missing keys are zero, not unknown. */
  cells: Readonly<Record<string, number>>;
}): ReactNode {
  const peak = Math.max(1, ...Object.values(cells));
  return (
    <table
      style={{ borderCollapse: "separate", borderSpacing: 2, fontSize: 11, fontFamily: type.ui }}
      aria-label="Unmet searches by area and time of day"
    >
      <thead>
        <tr>
          <th scope="col" style={axisStyle} />
          {columns.map((c) => (
            <th key={c} scope="col" style={axisStyle}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row}>
            <th scope="row" style={{ ...axisStyle, textAlign: "left", fontWeight: 400, color: TOKEN.inkMuted }}>
              {row}
            </th>
            {columns.map((col) => {
              const value = cells[`${row}|${col}`] ?? 0;
              const intensity = value / peak;
              return (
                <td
                  key={col}
                  title={`${row}, ${col}: ${value}`}
                  style={{
                    background: value === 0 ? TOKEN.canvas : TOKEN.accentSoft,
                    border: `1px solid ${TOKEN.rule}`,
                    borderRadius: 2,
                    minWidth: 34,
                    height: 22,
                    textAlign: "center",
                    fontFamily: type.data,
                    fontVariantNumeric: "tabular-nums",
                    color: intensity > 0.6 ? TOKEN.ink : TOKEN.inkMuted,
                    // Depth is carried by the border as well as the fill, so the
                    // grid still reads without colour.
                    borderWidth: intensity > 0.6 ? 2 : 1,
                  }}
                >
                  {value === 0 ? "" : value}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const axisStyle: CSSProperties = {
  fontFamily: "var(--font-data, ui-monospace, monospace)",
  fontSize: 10,
  color: "var(--ink-muted, #6F6A5E)",
  textAlign: "center",
  fontWeight: 400,
  padding: 2,
};

/** One opportunity. The headline is the claim; the evidence is the receipt. */
export function OpportunityCard({
  opportunity,
  onAction,
}: {
  opportunity: Opportunity;
  onAction?: (opportunity: Opportunity) => void;
}): ReactNode {
  return (
    <article
      style={{
        border: `1px solid ${TOKEN.rule}`,
        borderLeft: `3px solid ${opportunity.tier === "inferred" ? TOKEN.warn : TOKEN.accent}`,
        borderRadius: 6,
        padding: 12,
        background: TOKEN.surface,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
        <TierBadge tier={opportunity.tier} title={`${TIER_LABEL[opportunity.tier]} demand evidence`} />
        <span style={{ fontSize: 11, color: TOKEN.inkFaint, fontFamily: type.data }}>
          {opportunity.sampleSize} searches
          {opportunity.tier === "inferred" ? ", below our sample bar" : ""}
        </span>
      </div>
      <p style={{ margin: "0 0 8px", fontSize: 13, lineHeight: 1.45 }}>{opportunity.contract.headline}</p>
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "2px 10px",
          margin: "0 0 10px",
          fontSize: 11,
        }}
      >
        {opportunity.evidence.slice(0, 6).map((e) => (
          <div key={e.label} style={{ display: "contents" }}>
            <dt style={{ color: TOKEN.inkMuted }}>{e.label}</dt>
            <dd style={{ margin: 0, fontFamily: type.data }}>{e.value}</dd>
          </div>
        ))}
      </dl>
      {onAction === undefined ? null : (
        <button
          type="button"
          onClick={() => onAction(opportunity)}
          style={{
            font: "inherit",
            fontSize: 12,
            padding: "6px 10px",
            borderRadius: 4,
            border: `1px solid ${TOKEN.accent}`,
            background: TOKEN.accentSoft,
            color: TOKEN.accent,
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          {opportunity.contract.cta}
        </button>
      )}
    </article>
  );
}

/** One suggestion. Always reads as a proposal, never as a fact. */
export function SuggestionRow({
  action,
  cta,
  tier,
  sampleSize,
  onAction,
}: {
  action: string;
  cta: string;
  tier: ClaimTier;
  sampleSize: number;
  onAction?: () => void;
}): ReactNode {
  return (
    <li
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        padding: "10px 0",
        borderBottom: `1px solid ${TOKEN.rule}`,
      }}
    >
      <div style={{ flex: "1 1 auto", minWidth: 0 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
          <TierBadge tier={tier} title="tier of the demand behind this suggestion" />
          <span style={{ fontSize: 11, color: TOKEN.inkFaint, fontFamily: type.data }}>
            {sampleSize} searches
          </span>
        </div>
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.45 }}>{action}</p>
      </div>
      {onAction === undefined ? null : (
        <button
          type="button"
          onClick={onAction}
          style={{
            flex: "0 0 auto",
            font: "inherit",
            fontSize: 12,
            padding: "6px 10px",
            borderRadius: 4,
            border: `1px solid ${TOKEN.accent}`,
            background: TOKEN.surface,
            color: TOKEN.accent,
            cursor: "pointer",
          }}
        >
          {cta}
        </button>
      )}
    </li>
  );
}

export { TOKEN as ANALYTICS_TOKENS, TIER_LABEL, TIER_TONE, type as ANALYTICS_TYPE };