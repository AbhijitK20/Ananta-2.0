"use client";

/**
 * Feature-local stand-ins for Karan's `src/components/ui` primitives.
 *
 * The mission says: if his components exist, consume them; if not, represent
 * them here rather than writing into his directory. These are deliberately plain
 * and read every colour from his tokens by name, so when the real
 * primitives land this file can be deleted and the JSX barely moves.
 *
 * ponytail: ceiling — no hex literals, no Tailwind classes, no motion. Swap for
 * `@/components/ui` as soon as Button/Card/Badge/EmptyState/Skeleton ship.
 */
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

const INK: CSSProperties = { color: "var(--ink)", background: "var(--surface)" };
const RULE: CSSProperties = { border: "1px solid var(--rule)" };

const focusable: CSSProperties = {
  font: "inherit",
  color: "var(--ink)",
  background: "var(--surface)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-sm, 4px)",
  padding: "0.5rem 0.625rem",
  width: "100%",
};

const focusRing: CSSProperties = { outlineOffset: 2 };

export function Card({
  title,
  description,
  actions,
  children,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      style={{
        ...RULE,
        ...INK,
        borderRadius: "var(--radius-md, 8px)",
        padding: "1rem",
        display: "grid",
        gap: "0.75rem",
      }}
    >
      {(title || actions) && (
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "0.5rem" }}>
          <div>
            {title && <h2 style={{ margin: 0, fontSize: "1.0625rem" }}>{title}</h2>}
            {description && (
              <p style={{ margin: "0.125rem 0 0", color: "var(--ink-muted)", fontSize: "0.8125rem" }}>{description}</p>
            )}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div style={{ display: "grid", gap: "0.25rem" }}>
      <label htmlFor={id} style={{ fontSize: "0.8125rem", color: "var(--ink-muted)" }}>
        {label}
      </label>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} style={{ margin: 0, fontSize: "0.75rem", color: "var(--ink-faint)" }}>
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" style={{ margin: 0, fontSize: "0.75rem", color: "var(--alarm)" }}>
          {error}
        </p>
      )}
    </div>
  );
}

const describedBy = (id: string, error?: string | undefined): string | undefined =>
  error ? `${id}-error` : undefined;

export function TextInput({
  id,
  error,
  ...props
}: { id: string; error?: string | undefined } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "id" | "style" | "className"
>) {
  return (
    <input
      {...props}
      id={id}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(id, error)}
      style={{ ...focusable, ...(error ? { borderColor: "var(--alarm)" } : {}), ...focusRing }}
    />
  );
}

export function TextArea({
  id,
  error,
  ...props
}: { id: string; error?: string | undefined } & Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "id" | "style" | "className"
>) {
  return (
    <textarea
      {...props}
      id={id}
      rows={props.rows ?? 4}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(id, error)}
      style={{ ...focusable, resize: "vertical", ...(error ? { borderColor: "var(--alarm)" } : {}), ...focusRing }}
    />
  );
}

export function Select({
  id,
  error,
  children,
  ...props
}: { id: string; error?: string | undefined; children: ReactNode } & Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "id" | "style" | "className"
>) {
  return (
    <select
      {...props}
      id={id}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(id, error)}
      style={{ ...focusable, ...(error ? { borderColor: "var(--alarm)" } : {}), ...focusRing }}
    >
      {children}
    </select>
  );
}

export function Checkbox({
  id,
  label,
  ...props
}: { id: string; label: string } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "id" | "type" | "style" | "className"
>) {
  return (
    <label htmlFor={id} style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontSize: "0.8125rem" }}>
      <input {...props} id={id} type="checkbox" style={{ width: "auto" }} />
      {label}
    </label>
  );
}

export type ButtonVariant = "primary" | "quiet" | "danger";

export function Button({
  variant = "quiet",
  busy,
  children,
  style,
  ...props
}: { variant?: ButtonVariant; busy?: boolean } & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className"
>) {
  const tone: Record<ButtonVariant, CSSProperties> = {
    primary: { background: "var(--accent)", color: "var(--surface)", borderColor: "var(--accent)" },
    quiet: {},
    danger: { background: "var(--alarm-soft)", color: "var(--alarm)", borderColor: "var(--alarm)" },
  };
  return (
    <button
      {...props}
      aria-busy={busy || undefined}
      disabled={props.disabled === true || busy === true}
      style={{
        ...focusable,
        width: "auto",
        cursor: props.disabled === true || busy === true ? "not-allowed" : "pointer",
        opacity: props.disabled === true || busy === true ? 0.55 : 1,
        ...tone[variant],
        ...style,
      }}
    >
      {busy ? "Working" : children}
    </button>
  );
}

export type Tone = "accent" | "fit" | "warn" | "alarm" | "info" | "muted";

const TONES: Record<Tone, CSSProperties> = {
  accent: { color: "var(--accent)", background: "var(--accent-soft)", borderColor: "var(--accent)" },
  fit: { color: "var(--fit)", background: "var(--fit-soft)", borderColor: "var(--fit)" },
  warn: { color: "var(--warn)", background: "var(--surface)", borderColor: "var(--warn)" },
  alarm: { color: "var(--alarm)", background: "var(--alarm-soft)", borderColor: "var(--alarm)" },
  info: { color: "var(--info)", background: "var(--surface)", borderColor: "var(--info)" },
  muted: { color: "var(--ink-muted)", background: "var(--surface)", borderColor: "var(--rule)" },
};

export function Badge({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      style={{
        ...TONES[tone],
        display: "inline-block",
        border: "1px solid",
        borderRadius: "var(--radius-pill)",
        padding: "0.0625rem 0.5rem",
        fontSize: "0.75rem",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

export function Alert({
  tone = "alarm",
  title,
  children,
  action,
}: {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role={tone === "alarm" ? "alert" : "status"}
      style={{
        ...TONES[tone],
        border: "1px solid",
        borderRadius: "var(--radius-sm, 4px)",
        padding: "0.625rem 0.75rem",
        display: "flex",
        justifyContent: "space-between",
        gap: "0.75rem",
        alignItems: "center",
        fontSize: "0.8125rem",
      }}
    >
      <span>
        {title && <strong style={{ display: "block" }}>{title}</strong>}
        {children}
      </span>
      {action}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div
      style={{
        ...RULE,
        borderStyle: "dashed",
        borderRadius: "var(--radius-md, 8px)",
        padding: "1.25rem",
        display: "grid",
        gap: "0.375rem",
        justifyItems: "start",
      }}
    >
      <strong>{title}</strong>
      <p style={{ margin: 0, color: "var(--ink-muted)", fontSize: "0.8125rem" }}>{body}</p>
      {action}
    </div>
  );
}

export function Skeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" style={{ display: "grid", gap: "0.5rem" }}>
      <span style={{ fontSize: "0.8125rem", color: "var(--ink-muted)" }}>{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          style={{
            height: "0.75rem",
            borderRadius: "var(--radius-sm, 4px)",
            background: "var(--rule)",
            width: `${100 - index * 12}%`,
          }}
        />
      ))}
    </div>
  );
}

/** The one number a provider checks first: how many places are still free. */
export function CapacityBar({ remaining, capacity }: { remaining: number; capacity: number }) {
  const tone = remaining === 0 ? "var(--alarm)" : remaining <= 2 ? "var(--warn)" : "var(--fit)";
  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: "0.375rem", fontSize: "0.75rem" }}
      title={`${remaining} of ${capacity} places left`}
    >
      <span
        aria-hidden="true"
        style={{ display: "inline-block", width: "3.5rem", height: "0.375rem", background: "var(--rule)", borderRadius: "999px" }}
      >
        <span
          style={{
            display: "block",
            height: "100%",
            width: `${capacity === 0 ? 0 : (remaining / capacity) * 100}%`,
            background: tone,
            borderRadius: "999px",
          }}
        />
      </span>
      <span style={{ fontFamily: "var(--font-data, monospace)", color: tone }}>
        {remaining}/{capacity} free
      </span>
    </span>
  );
}

/** Every duration, distance and rupee figure goes through this, in mono. */
export const Data = ({ children }: { children: ReactNode }) => (
  <span style={{ fontFamily: "var(--font-data, monospace)", fontVariantNumeric: "tabular-nums" }}>{children}</span>
);
