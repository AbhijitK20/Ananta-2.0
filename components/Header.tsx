"use client";

import Link from "next/link";

import { GAME_LINK, NAV } from "../lib/data";

import { useState } from "react";

import { AccountMenu } from "./AccountMenu";

export function Header() {
  const [open, setOpen] = useState(false);

  return (
    <header className="lal-header" data-open={open}>
      <div className="lal-box">
        <div className="lal-header__inner lal-container">
        <Link href="/" className="lal-header__logo" aria-label="Ananta home">
          {/* Horizontal lockup (mark + ANANTA + SINCE 2026). The stacked source
              is portrait 394x462 and would render 223px tall at this width.
              eslint-disable-next-line @next/next/no-img-element */}
          <img src="/ananta-logo-horizontal.png" width={725} height={262} alt="Ananta" />
        </Link>

        <div className="lal-header__right">
          <button
            type="button"
            className="lal-burger"
            aria-label="Menu"
            aria-expanded={open}
            aria-controls="lal-primary-nav"
            onClick={() => setOpen((v) => !v)}
          >
            <span aria-hidden="true">&#9776;</span>
          </button>

          <nav aria-label="Primary">
            <ul className="lal-nav" id="lal-primary-nav">
              {NAV.map((item) => (
                <li key={item.href}>
                  <Link href={item.href}>{item.label}</Link>
                </li>
              ))}
              {/* Absolutely positioned, so it is out of flow and cannot move the
                  list or any link the replica is measured on. See GAME_LINK. */}
              <li className="lal-nav__game">
                <Link href={GAME_LINK.href}>{GAME_LINK.label}</Link>
              </li>
            </ul>
          </nav>

          <span className="lal-cta-wrap">
            <AccountMenu />
            <Link href="/cities" className="lal-cta">
              Explore Places
            </Link>
          </span>
        </div>
        </div>
      </div>
    </header>
  );
}
