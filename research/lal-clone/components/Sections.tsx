import Link from "next/link";

import { PROMISES, TIPS, type Tip } from "../lib/data";

function TipCard({ tip }: { tip: Tip }) {
  return (
    <Link href={`/blog/${tip.slug}`} className="lal-tip">
      <span className="lal-tip__media">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={tip.image} alt="" loading="lazy" />
      </span>
      <span className="lal-tip__body">
        <span className="lal-tip__cat">{tip.category}</span>
        <span className="lal-tip__title">{tip.title}</span>
        <span className="lal-tip__ex">{tip.excerpt}</span>
        <span className="lal-tip__meta">{tip.date}</span>
      </span>
    </Link>
  );
}

export function Promise() {
  return (
    <section className="lal-promise lal-box">
      <div className="lal-promise__inner">
        {PROMISES.map((item) => (
          <div key={item.title} className="lal-promise__item">
            <h3 className="lal-promise__title">{item.title}</h3>
            <p className="lal-promise__desc">{item.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Tips({ limit }: { limit?: number }) {
  const shown = limit ? TIPS.slice(0, limit) : TIPS;

  return (
    <section className="lal-tips">
      <div className="lal-tips__head">
        <div>
          <h2 className="lal-tips__title">Fresh local tips</h2>
          <p className="lal-tips__sub">New stories and guides from locals around the world.</p>
        </div>
        <Link href="/blog" className="lal-tips__all">
          See all on the blog
        </Link>
      </div>

      <div className="lal-tips__grid">
        {shown.map((tip) => (
          <TipCard key={tip.slug} tip={tip} />
        ))}
      </div>
    </section>
  );
}
