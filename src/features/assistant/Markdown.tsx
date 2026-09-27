"use client";

/**
 * Markdown for chat replies, rendered without `dangerouslySetInnerHTML`.
 *
 * A chat reply is untrusted text by construction: it is model output that may
 * have been steered by whatever the traveller typed. React already escapes every
 * string it renders, so the *only* way a reply becomes executable is to opt out
 * of that with `dangerouslySetInnerHTML` — which this file never does, and which
 * the reviewer's eye can check in one grep.
 *
 * That is also why this is a hand-rolled renderer rather than a markdown
 * dependency. The reason to reach for `react-markdown` is usually "it handles
 * everything", and the cost is a large transitive tree plus a
 * `rehype-raw`-shaped footgun. What a chat reply actually needs is headings,
 * lists, bold, inline code, fenced code and links — about eighty lines — and the
 * version that ships here is auditable in one sitting.
 *
 * ## What is deliberately not supported
 *
 * Raw HTML (escaped and shown as text), images (a remote image in a reply is a
 * tracking pixel), tables (nothing in the assistant's output is tabular, and a
 * table is the one construct that reliably produces horizontal overflow on a
 * phone), and setext headings.
 *
 * Link handling is the one place that needs care: `href` is validated against an
 * allowlist of schemes, because `javascript:` survives a naive attribute render.
 * `rel="noopener noreferrer"` is set because every external link opens a new tab.
 */
import { Fragment, type ReactNode } from "react";

import { cn } from "@/components/cn";

import { safeHref } from "./links";

/** Inline spans. Order matters: code before emphasis, so `**` inside code stays literal. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // `code`, **bold**, *italic*, [link](href)
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-i${index}`;
    index += 1;

    if (token.startsWith("`")) {
      nodes.push(
        <code key={key} className="rounded-sm bg-accent-soft px-1 py-0.5 font-data text-[0.9em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const parts = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const label = parts?.[1] ?? token;
      const href = parts?.[2] ? safeHref(parts[2]) : null;
      nodes.push(
        href ? (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline underline-offset-2 hover:brightness-110"
          >
            {label}
          </a>
        ) : (
          // A link with an unsafe scheme is rendered as plain text rather than
          // dropped: the words still mean something to the reader.
          <span key={key}>{label}</span>
        ),
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export interface MarkdownProps {
  children: string;
  className?: string;
}

export function Markdown({ children, className }: MarkdownProps) {
  const blocks = parseBlocks(children ?? "");
  return (
    <div className={cn("space-y-2 text-body leading-relaxed", className)}>
      {blocks.map((block, index) => (
        <Block key={`b${index}`} block={block} index={index} />
      ))}
    </div>
  );
}

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "code"; language: string; lines: string[] }
  | { kind: "h"; level: 2 | 3; text: string };

/**
 * Split into blocks.
 *
 * Line-based rather than a single regex sweep, because fenced code has to win
 * over everything else in its region — a line of markdown inside a code block is
 * markdown the reader should see literally, and any regex that does not track
 * fences will style it.
 */
function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trimStart().startsWith("```")) {
      const language = line.trim().slice(3).trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trimStart().startsWith("```")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1; // closing fence, or EOF
      blocks.push({ kind: "code", language, lines: body });
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading?.[2]) {
      // h1 is folded to h2: a reply has no business owning the page's h1, and two
      // h1s in a document is an accessibility bug, not a style choice.
      blocks.push({ kind: "h", level: (heading[1]?.length ?? 1) as 2 | 3, text: heading[2] });
      index += 1;
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^\s*[-*]\s+(.*)$/.exec(lines[index] ?? "");
        if (!item?.[1]) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^\s*\d+[.)]\s+(.*)$/.exec(lines[index] ?? "");
        if (!item?.[1]) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (
        current.trim().length === 0 ||
        current.trimStart().startsWith("```") ||
        /^\s*[-*]\s+/.test(current) ||
        /^\s*\d+[.)]\s+/.test(current) ||
        /^#{1,3}\s+/.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    blocks.push({ kind: "p", lines: paragraph });
  }

  return blocks;
}

function Block({ block, index }: { block: Block; index: number }) {
  switch (block.kind) {
    case "h": {
      const Tag = block.level === 2 ? "h2" : "h3";
      return (
        <Tag className={cn("font-display text-ink", block.level === 2 ? "text-body-lg" : "text-body")}>
          {inline(block.text, `h${index}`)}
        </Tag>
      );
    }
    case "ul":
      return (
        <ul className="list-disc space-y-1 pl-5 marker:text-ink-faint">
          {block.items.map((item, at) => (
            <li key={at}>{inline(item, `ul${index}-${at}`)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="list-decimal space-y-1 pl-5 marker:text-ink-muted">
          {block.items.map((item, at) => (
            <li key={at}>{inline(item, `ol${index}-${at}`)}</li>
          ))}
        </ol>
      );
    case "code":
      return (
        <pre className="overflow-x-auto rounded-md border border-rule bg-surface p-3 font-data text-meta">
          {block.language ? (
            <div className="mb-1 font-ui text-meta-sm uppercase tracking-wide text-ink-faint">
              {block.language}
            </div>
          ) : null}
          <code>{block.lines.join("\n")}</code>
        </pre>
      );
    case "p":
    default:
      return (
        <p>
          {block.lines.map((line, at) => (
            <Fragment key={at}>
              {at > 0 ? <br /> : null}
              {inline(line, `p${index}-${at}`)}
            </Fragment>
          ))}
        </p>
      );
  }
}
