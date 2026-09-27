import type { Metadata } from "next";

import { PostCard } from "../../components/Interior";
import { POSTS } from "../../lib/content";
import "../interior.css";

export const metadata: Metadata = {
  title: "Blog",
  description: "Travel tips and city guides.",
};

export default function BlogPage() {
  return (
    <div className="g-page">
      <div className="g-wrap">
        <h1 className="g-h1">Blog</h1>
        <p className="g-lede">Travel tips and city guides</p>
        <p className="g-count">
          {POSTS.length} posts, newest first.
        </p>

        <div className="lal-tips">
          <div className="lal-tips__grid">
            {POSTS.map((post) => (
              <PostCard key={post.slug} post={post} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
