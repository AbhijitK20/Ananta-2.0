import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { POSTS, postsByCategory } from "../../../lib/content";
import "../../globals.css";
import "../../interior.css";

type Params = { params: Promise<{ slug: string }> };

/** All 160 captured posts, not a hand-written handful. */
export function generateStaticParams() {
  return POSTS.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const post = POSTS.find((p) => p.slug === slug);
  return { title: post?.title ?? "Post", description: post?.excerpt };
}

export default async function PostPage({ params }: Params) {
  const { slug } = await params;
  const post = POSTS.find((p) => p.slug === slug);
  if (!post) notFound();

  const related = postsByCategory(post.category)
    .filter((p) => p.slug !== post.slug)
    .slice(0, 3);

  return (
    <div className="g-edit lal-page">
      <div className="g-edit__inner">
        <span className="lal-tip__cat">{post.category}</span>
        <h1 className="g-edit__title g-edit__title--about" style={{ marginTop: 14 }}>
          {post.title}
        </h1>
        {post.date && <p className="g-edit__sub">{post.date}</p>}

        {post.src && (
          <div className="lal-feature">
            <span
              className="lal-feature__scrim"
              style={{ backgroundImage: `url(${post.src})` }}
            />
          </div>
        )}

        <div className="g-edit__lede" style={{ maxWidth: 760, margin: "28px auto" }}>
          {post.excerpt}
        </div>

        <div className="g-edit__aside">
          <p>
            The short answer is that the best things to buy are the ones a local buys
            for themselves, on a Tuesday, without thinking about it. Everything below
            clears that bar; everything further down does not.
          </p>

          <h2>How we verify</h2>
          <ul>
            <li>Someone on the team went, paid, and went back a second time.</li>
            <li>The maker or owner is named wherever the region allows it.</li>
            <li>If a shop only exists for tourists, we say so instead of listing it.</li>
          </ul>

          <h2>What to skip</h2>
          <p>
            Anything sold in the same shape, in the same tin, on three consecutive
            streets. That is not a judgement about the product — it is a signal you
            are in a tourist corridor rather than a neighbourhood.
          </p>
        </div>

        {related.length > 0 && (
          <>
            <hr className="g-divider" />
            <h2>More in {post.category}</h2>
            <div className="lal-tips__grid">
              {related.map((p) => (
                <a key={p.slug} href={`/blog/${p.slug}`} className="lal-tip">
                  <span className="lal-tip__body">
                    <span className="lal-tip__cat">{p.category}</span>
                    <span className="lal-tip__title">{p.title}</span>
                    {p.excerpt && <span className="lal-tip__ex">{p.excerpt}</span>}
                  </span>
                </a>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
