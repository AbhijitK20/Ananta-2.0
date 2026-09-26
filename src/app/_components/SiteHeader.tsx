import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The site header: wordmark, the product's surfaces, and an optional slot for
 * page-specific actions.
 *
 * WHY THIS EXISTS. The app shipped exactly one page and nine feature modules
 * with no route to any of them, so "where do I go" had no answer and the
 * provider and analytics surfaces were reachable only from their own tests.
 * A product with more than one surface needs a way to name them, and that is
 * all this is.
 *
 * The `actions` slot is how the discovery page keeps its own toolbar — the
 * engine-versus-fixtures badge and the "ask in words" button — without this
 * component having to know about either. Passing nothing renders just the nav,
 * which is what the provider and analytics pages want.
 */
export interface SiteHeaderProps {
  /** Page-specific controls, rendered to the right of the nav. */
  actions?: ReactNode;
}

interface Surface {
  href: string;
  label: string;
  /** One line, used as the title attribute so a hover explains the surface. */
  about: string;
}

/**
 * The three surfaces, in the order a person meets them: plan a trip, offer one,
 * then read what the demand says. There is no fourth because there is nothing
 * else behind a link — a nav that lists a page you cannot visit is worse than a
 * short nav.
 */
const SURFACES: readonly Surface[] = [
  { href: "/", label: "Discover", about: "Find something that fits your hours" },
  { href: "/provider", label: "Provider", about: "List what you host and answer requests" },
  { href: "/analytics", label: "Analytics", about: "What travellers wanted and could not find" },
];

export function SiteHeader({ actions }: SiteHeaderProps) {
  return (
    <header className="sticky top-0 z-sticky border-b border-rule bg-canvas">
      <div className="mx-auto flex max-w-[90rem] flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
          <Link href="/" className="text-display text-ink hover:text-accent">
            TravelBuddy
          </Link>
          <nav aria-label="Sections">
            <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {SURFACES.map((surface) => (
                <li key={surface.href}>
                  <Link
                    href={surface.href}
                    title={surface.about}
                    className="text-meta-sm text-ink-muted hover:text-ink"
                  >
                    {surface.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        {actions !== undefined && (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
    </header>
  );
}
