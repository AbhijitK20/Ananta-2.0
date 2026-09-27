import type { Metadata, Viewport } from "next";
import { Fraunces, Inter } from "next/font/google";
import type { ReactNode } from "react";

import { GameShell } from "../components/GameShell";
import { ProgressProvider } from "../lib/game/store";

import "./globals.css";

/* Self-hosted by next/font so the game makes no third-party request at
   runtime — the same two families the clone uses, for the same reason. */
const fraunces = Fraunces({ subsets: ["latin"], display: "swap", variable: "--font-fraunces" });
const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });

export const metadata: Metadata = {
  title: {
    default: "Local Legends — collect the places locals actually go to",
    template: "%s — Local Legends",
  },
  description:
    "A stamp album for the 890 places locals recommended across 202 cities. Clear quests, keep a streak, fill the book.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The bottom nav is fixed, so it has to be able to extend past the home
  // indicator. Without this, `env(safe-area-inset-bottom)` is always 0 and the
  // nav sits under the gesture bar on a device that has one.
  viewportFit: "cover",
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#ffffff" }],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${inter.variable}`}>
      <body>
        <a href="#main" className="lq-skip">
          Skip to content
        </a>
        {/*
          The provider and the shell are both in the root layout, not in a page.
          Six routes means six chances for a route to render without a level
          indicator, and the XP rail has to survive navigation for the rail to be
          worth having.
        */}
        <ProgressProvider>
          <GameShell>
            <main id="main">{children}</main>
          </GameShell>
        </ProgressProvider>
      </body>
    </html>
  );
}
