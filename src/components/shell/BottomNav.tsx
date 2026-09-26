"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bookmark, Compass, Map as MapIcon, House, User } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/components/cn";
import { PLAN_CHANGE_EVENT, readPlan } from "@/lib/plan-state";

/**
 * Bottom navigation for small screens; a plain inline row from `lg` up.
 *
 * Ported from the `ananta` prototype, with two deliberate changes.
 *
 * 1. Active state comes from the pathname. The prototype hardcoded
 *    `index === 0 ? "text-blue" : "text-muted"`, so Home was highlighted on
 *    every single page — the one page where being wrong about "where am I" is
 *    most confusing. A nav that lies about the current page is worse than no
 *    nav, and `text-muted` is not a token in this app; it is `text-ink-muted`.
 * 2. The plan badge counts from `readPlan()`, so it reflects the draft the
 *    traveller has actually built rather than a prop someone has to remember to
 *    thread down.
 */

const ITEMS = [
  { href: "/", label: "Home", Icon: House },
  { href: "/explore", label: "Explore", Icon: MapIcon },
  { href: "/plan", label: "Plan", Icon: Compass },
  { href: "/saved", label: "Saved", Icon: Bookmark },
  { href: "/profile", label: "Profile", Icon: User },
] as const;

/** A nav item is current on its own route, or on a nested route beneath it. */
function isCurrent(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function BottomNav() {
  const pathname = usePathname();
  const [planned, setPlanned] = useState(0);

  useEffect(() => {
    const sync = () => setPlanned(readPlan().length);
    sync();
    window.addEventListener(PLAN_CHANGE_EVENT, sync);
    return () => window.removeEventListener(PLAN_CHANGE_EVENT, sync);
  }, []);

  return (
    <>
      {/* Keeps the last row clear of the fixed bar on small screens. */}
      <div className="h-20 lg:hidden" aria-hidden="true" />
      <nav
        aria-label="Primary"
        className={cn(
          "fixed inset-x-0 bottom-0 z-20 border-t border-rule bg-surface/95 px-3 py-3 backdrop-blur",
          "lg:static lg:mx-5 lg:border-t-0 lg:bg-transparent lg:px-8 lg:py-5",
        )}
      >
        <div className="mx-auto flex w-full max-w-md items-center justify-between lg:max-w-none">
          {ITEMS.map(({ href, label, Icon }) => {
            const current = isCurrent(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "flex min-w-[58px] flex-col items-center gap-1 text-xs font-semibold",
                  current ? "text-accent" : "text-ink-muted",
                )}
              >
                <span className="relative">
                  <Icon size={21} strokeWidth={current ? 2.4 : 2} aria-hidden="true" />
                  {href === "/plan" && planned > 0 ? (
                    <span className="absolute -right-2.5 -top-1.5 inline-flex min-w-[18px] items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-bold leading-[18px] text-on-accent">
                      {planned}
                    </span>
                  ) : null}
                </span>
                {label}
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
