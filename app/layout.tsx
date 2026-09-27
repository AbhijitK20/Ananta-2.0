import type { Metadata, Viewport } from "next";
import { Fraunces, Inter } from "next/font/google";
import type { ReactNode } from "react";

import { Footer } from "../components/Footer";
import { Header } from "../components/Header";
import { MeshDriftBackground } from "../components/MeshDriftBackground";

import "./globals.css";
import "./interior.css";
import "./filmstrip.css";
import "./globe.css";
import "./parallax.css";

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

/* No Ananta domain is recorded anywhere in the repo yet, and Next resolves a
   relative og:image against this. Left unset it would emit
   http://localhost:3000/og.png into every shared link, so the deploy sets it. */
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:4310";

const description =
  "Skip the tourist traps. Start with a city and get straight to the cafés, bars, culture and hidden gems that locals swear by.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Ananta – City Travel Guides & Local Tips",
    template: "%s – Ananta",
  },
  description,
  openGraph: {
    type: "website",
    siteName: "Ananta",
    title: "Ananta – City Travel Guides & Local Tips",
    description,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Ananta" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Ananta – City Travel Guides & Local Tips",
    description,
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
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
          One canvas for the whole replica, mounted here rather than per page so
          the backdrop cannot drift between routes: a new page gets it for free
          and there is no way to forget it. It is position:fixed, takes no
          layout space and ignores pointer events, so it does not disturb any
          page's own stacking or hit-testing.
        */}
        <MeshDriftBackground />
        <Header />
        <main id="main">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
