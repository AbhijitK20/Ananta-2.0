"use client";

/**
 * The persistent chrome: an XP rail across the top, a four-item nav pinned to
 * the bottom.
 *
 * Mounted from the root layout rather than per page, for the same reason
 * `NativeShell` is: there are six routes and a per-page mount is six chances
 * for one of them to come up without a level indicator.
 *
 * Everything here reads from `useProgress`, so the rail cannot show an XP total
 * that disagrees with the page below it — both come from the same derived
 * value.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { StreakState } from "../lib/game/daily";
import { useProgress } from "../lib/game/store";
import type { LevelState } from "../lib/game/types";

type NavItem = { href: string; label: string; glyph: string };

const NAV: NavItem[] = [
  { href: "/", label: "Today", glyph: "◉" },
  { href: "/quests", label: "Quests", glyph: "✦" },
  { href: "/cities", label: "Cities", glyph: "⌂" },
  { href: "/stamps", label: "Stamps", glyph: "❖" },
];

export function GameShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { xp, level, streak, hydrated, storageWorks, discarded, quests, stamps } =
    useProgress();

  // Only quests that are finished and unpaid are worth interrupting the player
  // for. A count of "in progress" would be a number that rises all day.
  const claimable = quests.filter((q) => q.claimable).length;

  return (
    <>
      <div className="lq-rail">
        <div className="lq-rail__inner">
          <Link href="/" className="lq-rail__brand">
            Local<span>Legends</span>
          </Link>

          <XpRail xp={xp} level={level} hydrated={hydrated} />

          <div className="lq-rail__spacer" />

          <StreakChip streak={streak} />
        </div>
      </div>

      {/* Storage problems are surfaced rather than swallowed, because a save
          that silently stops persisting looks identical to a player as a
          collection that keeps resetting. */}
      {!storageWorks ? (
        <p className="lq-warn">
          <strong>Progress is not being saved.</strong> This browser is blocking
          site data, so your collection lasts until you close the tab.
        </p>
      ) : null}

      {discarded ? (
        <p className="lq-warn">
          <strong>A previous save could not be read</strong> and the collection
          has started fresh. Nothing was overwritten.
        </p>
      ) : null}

      <div className="lq-shell">{children}</div>

      <nav className="lq-nav" aria-label="Main">
        <div className="lq-nav__inner">
          {NAV.map((item) => {
            // Root has to match exactly; every other route matches on prefix, so
            // /cities/lisbon keeps "Cities" lit.
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname === item.href || pathname.startsWith(`${item.href}/`);

            return (
              <Link
                key={item.href}
                href={item.href}
                className="lq-nav__item"
                aria-current={active ? "page" : undefined}
              >
                <span className="lq-nav__glyph" aria-hidden="true">
                  {item.glyph}
                </span>
                <span>{item.label}</span>
                {item.href === "/quests" && claimable > 0 ? (
                  <span className="lq-nav__badge">
                    {claimable > 9 ? "9+" : claimable}
                    <span className="lq-sr"> quests ready to claim</span>
                  </span>
                ) : null}
                {item.href === "/stamps" && hydrated && stamps.size > 0 ? (
                  <span className="lq-sr">
                    {stamps.size} places stamped so far
                  </span>
                ) : null}
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}

function XpRail({
  xp,
  level,
  hydrated,
}: {
  xp: number;
  level: LevelState;
  hydrated: boolean;
}) {
  return (
    <div className="lq-xp">
      <div className="lq-xp__top">
        {/* Before hydration the save has not been read, so the honest thing to
            show is the level every player starts at rather than a zeroed bar
            that suggests a wiped collection. */}
        <span className="lq-xp__title">
          {hydrated ? level.level.title : "Newcomer"}
        </span>
        <span className="lq-xp__num">
          {hydrated ? `${xp.toLocaleString()} XP` : "—"}
        </span>
      </div>
      <div
        className="lq-xp__track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(level.progress * 100)}
        aria-label={`Level ${level.level.index + 1}, ${level.level.title}`}
      >
        <div
          className="lq-xp__fill"
          style={{ transform: `scaleX(${hydrated ? level.progress : 0})` }}
        />
      </div>
      <p className="lq-xp__note">
        {hydrated
          ? level.maxed
            ? "Highest level reached"
            : `${level.xpToNext} XP to ${level.next?.title}`
          : " "}
      </p>
    </div>
  );
}

function StreakChip({ streak }: { streak: StreakState }) {
  // Three visual states, because "you have a streak" and "your streak is alive
  // but you have not played today" are different facts and the chip should not
  // claim the first when only the second is true.
  const tone = streak.current === 0 ? "" : streak.atRisk ? "lq-streak--risk" : "lq-streak--hot";

  return (
    <div className={`lq-streak ${tone}`}>
      <span className="lq-streak__flame" aria-hidden="true">
        {streak.current > 0 ? "▲" : "▽"}
      </span>
      <span className="lq-streak__n">{streak.current}</span>
      <span className="lq-streak__label">
        {streak.current === 0
          ? "No streak"
          : streak.atRisk
            ? "At risk"
            : "Day streak"}
      </span>
    </div>
  );
}
