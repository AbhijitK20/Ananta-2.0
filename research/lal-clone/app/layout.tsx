import type { Metadata, Viewport } from "next";
import { Fraunces, Inter } from "next/font/google";
import type { ReactNode } from "react";

import { Footer } from "../components/Footer";
import { Header } from "../components/Header";
import { NativeShell } from "../components/NativeShell";

import "./globals.css";
import "./interior.css";
import "./filmstrip.css";

/* The two families the live design actually uses, self-hosted by next/font so
   the clone makes no third-party request at runtime. */
const fraunces = Fraunces({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-fraunces",
});

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: {
    default: "Like a Local Guide – City Travel Guides & Local Tips",
    template: "%s – Like a Local Guide",
  },
  description:
    "Skip the tourist traps. Start with a city and get straight to the cafés, bars, culture and hidden gems that locals swear by.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Lets the page extend into the display cutout and the home-indicator area,
  // which is the only way `env(safe-area-inset-*)` reports anything but 0. The
  // --lal-safe-* tokens in globals.css feed back into body, .lal-header and
  // .lal-footer so they grow to clear those regions. In a browser this resolves
  // to 0 and changes nothing, so it needs no desktop counterpart.
  viewportFit: "cover",
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#ffffff" }],
};

/** Set LAL_FONTS=system to reproduce the live site's own rendering. See the
    FONT MODE note at the foot of globals.css for why that is not the default. */
const fontMode = process.env.LAL_FONTS === "system" ? " system" : "";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      data-lal-fonts={fontMode.trim() || undefined}
      className={`${fraunces.variable} ${inter.variable}`}
    >
      <body>
        <a href="#main" className="lal-skip">
          Skip to content
        </a>
        {/*
          Native shell wiring: launch-screen dismissal, status-bar theming,
          hardware back, push registration. Renders nothing and is inert in a
          browser, but it lives here rather than in a page so a new route cannot
          forget it.
        */}
        <NativeShell />
        <Header />
        <main id="main">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
