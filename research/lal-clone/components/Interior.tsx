"use client";

import Link from "next/link";
import { useRef, useState } from "react";

import type { City, Entry, Highlight, Post } from "../lib/content";

/* ------------------------------------------------------------------ cards -- */

export function CityCard({ city }: { city: City }) {
  return (
    <Link href={`/${city.slug}`} className="g-citycard">
      <span className="g-citycard__name">{city.name}</span>
      {city.picks != null && (
        <span className="g-citycard__count">{city.picks} local picks</span>
      )}
    </Link>
  );
}

export function EntryCard({ entry }: { entry: Entry }) {
  return (
    <Link href={entry.href || "#"} className="g-card">
      <span className="g-card__body">
        <span className="g-card__meta">{entry.meta}</span>
        <span className="g-card__title">{entry.name}</span>
        {entry.hood && <span className="g-card__hood">{entry.hood}</span>}
        {entry.snippet && <span className="g-card__snip">{entry.snippet}</span>}
        {entry.link && <span className="g-card__link">{entry.link}</span>}
      </span>
    </Link>
  );
}

export function PostCard({ post }: { post: Post }) {
  return (
    <Link href={`/blog/${post.slug}`} className="lal-tip">
      <span className="lal-tip__media">
        {post.src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={post.src} alt="" loading="lazy" />
        ) : null}
      </span>
      <span className="lal-tip__body">
        {post.category && <span className="lal-tip__cat">{post.category}</span>}
        <span className="lal-tip__title">{post.title}</span>
        {post.excerpt && <span className="lal-tip__ex">{post.excerpt}</span>}
        {post.date && <span className="lal-tip__meta">{post.date}</span>}
      </span>
    </Link>
  );
}

/**
 * A horizontally scrolling strip. The arrows are the reason this is a client
 * component: the original scrolls the track with JS and the buttons are real
 * controls rather than decoration.
 */
export function HighlightRow({
  title,
  more,
  items,
}: {
  title: string;
  more?: string;
  items: Highlight[];
}) {
  const track = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  const sync = () => {
    const el = track.current;
    if (!el) return;
    setAtStart(el.scrollLeft <= 2);
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);
  };

  const nudge = (dir: 1 | -1) => {
    const el = track.current;
    if (!el) return;
    el.scrollBy({ left: dir * (el.clientWidth - 28), behavior: "smooth" });
  };

  if (!items.length) return null;

  return (
    <div className="g-hlrow">
      <div className="g-hlhead">
        <h3>{title}</h3>
        {more && (
          <button type="button" className="g-hlmore">
            {more}
          </button>
        )}
      </div>
      <div className="g-hlcarousel">
        <button
          type="button"
          className="g-hlarrow g-hlprev"
          aria-label={`Scroll ${title} left`}
          disabled={atStart}
          onClick={() => nudge(-1)}
        >
          <span aria-hidden="true">&#8249;</span>
        </button>
        <div className="g-hlcards" ref={track} onScroll={sync}>
          {items.map((item) => (
            <Link key={item.href || item.title} href={item.href || "#"} className="g-hlcard">
              <span
                className="g-hlimg"
                style={item.src ? { backgroundImage: `url(${item.src})` } : undefined}
              />
              <span className="g-hltitle">{item.title}</span>
              <span className="g-hlcity">{item.city}</span>
              {item.why && <span className="g-hlwhy">{item.why}</span>}
            </Link>
          ))}
        </div>
        <button
          type="button"
          className="g-hlarrow g-hlnext"
          aria-label={`Scroll ${title} right`}
          disabled={atEnd}
          onClick={() => nudge(1)}
        >
          <span aria-hidden="true">&#8250;</span>
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- search -- */

/**
 * The original filters 892 cards client-side against a text box, a category
 * select and a budget select. Same three controls, same result count line.
 */
export function DirectoryFilter({
  categories,
  budgets,
}: {
  categories: { tag: string; label: string }[];
  budgets: string[];
}) {
  return (
    <>
      <div className="g-controls">
        <div className="g-field">
          <label htmlFor="g-q">Search</label>
          <input id="g-q" type="search" placeholder="Name, city or neighbourhood" />
        </div>
        <div className="g-field">
          <label htmlFor="g-cat">Category</label>
          <select id="g-cat" defaultValue="all">
            <option value="all">All categories</option>
            {categories.map((c) => (
              <option key={c.tag} value={c.tag}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="g-field">
          <label htmlFor="g-budget">Budget</label>
          <select id="g-budget" defaultValue="all">
            <option value="all">Any budget</option>
            {budgets.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
      </div>
    </>
  );
}
