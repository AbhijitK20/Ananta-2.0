/**
 * Link-scheme validation for rendered chat replies.
 *
 * Its own module for two reasons: a URL-scheme allowlist is not a rendering
 * concern, and `Markdown.tsx` is a `.tsx` file, which the Node-environment test
 * suite cannot import (no JSX transform configured). Keeping the policy here means
 * it is testable on its own and the component only has to call it.
 *
 * ## Why an allowlist
 *
 * A chat reply is untrusted text, and an `href` is the one attribute that can
 * execute. React escapes the string content of a reply, so the ONLY way a reply
 * becomes script is an `href` (or an image `src`) that a person clicks. Because
 * `javascript:alert(1)` is a perfectly valid URL as far as a parser is concerned,
 * the safe move is to refuse anything not on a short list rather than to try to
 * detect the bad ones — new schemes appear, and "we block the ones we know about"
 * is the shape of bug that ships.
 *
 * Rejected values render as plain text rather than being dropped, so the words a
 * model wrote still reach the reader instead of vanishing.
 */

/** Only these. `javascript:`, `data:` and `vbscript:` are the ones that matter. */
const SAFE_SCHEME = /^(https?:|mailto:|tel:)/i;

export function safeHref(raw: string): string | null {
  const value = raw.trim();
  // A scheme-relative URL (//evil.example) inherits the page's scheme, which is
  // http(s) by definition. Rewritten to https rather than passed through so a
  // reader cannot be downgraded by a link in a reply.
  if (value.startsWith("//")) return `https:${value}`;
  // A root-relative or fragment link cannot carry a scheme, so it is safe.
  if (value.startsWith("/") || value.startsWith("#")) return value;
  return SAFE_SCHEME.test(value) ? value : null;
}
