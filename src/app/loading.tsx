import { ResultListSkeleton } from "@/components/ui/Skeleton";

/**
 * Route-level loading boundary.
 *
 * The homepage reads a 5.1 MB catalogue and runs the real engine over it on
 * every request, so a cold start is genuinely slow. Without this the browser
 * shows a blank white rectangle for the whole of it; with it, the shape of the
 * page is on screen immediately and only the numbers are late.
 */
export default function Loading() {
  return (
    <main id="main" className="mx-auto max-w-[90rem] px-4 py-6">
      <h1 className="font-display text-3xl text-ink">Working out what fits</h1>
      <p className="mt-2 text-sm text-ink-muted">
        Reading the catalogue and checking every constraint. This takes a moment
        on a cold start.
      </p>
      <div className="mt-6">
        <ResultListSkeleton count={3} />
      </div>
    </main>
  );
}
