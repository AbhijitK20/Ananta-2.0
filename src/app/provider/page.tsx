import type { Metadata } from "next";

import { ProviderPanel } from "@/features/provider";

import { SiteHeader } from "../_components/SiteHeader";

export const metadata: Metadata = {
  title: "Provider console",
  description:
    "List what you host, set when it is available, and answer booking requests.",
};

/*
  The provider side of the product. It had no route before this file: the whole
  `src/features/provider` module — the listing editor, the availability editor
  and the request inbox — was reachable only from its own tests, so the demo
  script's provider half had nothing to point at.

  Client-rendered on purpose. `ProviderPanel` owns its own store and calls the
  demo API on mount, so there is nothing meaningful to render on the server and
  a prerender would only freeze an empty shell into the HTML.

  No `export const dynamic` here either. It used to say `force-static` for the
  same reason it was harmless, but the CSP nonce in `src/middleware.ts` requires
  dynamic rendering, and Next rejects the combination outright. Since a
  prerender was only ever freezing an empty shell, dropping it costs nothing.
*/

export default function ProviderPage() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-[90rem] px-4 py-6">
      <header className="mb-5">
        <p className="text-caps text-ink-muted">Provider</p>
        <h1 className="mt-1 font-display text-3xl text-ink">Your place, your hours</h1>
        <p className="mt-2 max-w-[60ch] text-sm text-ink-muted">
          Everything a traveller sees about you starts here. If a field is empty
          we say so on their card rather than guessing.
        </p>
      </header>
        <ProviderPanel />
      </main>
    </>
  );
}
