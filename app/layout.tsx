import type { Metadata, Viewport } from "next";
import { Fraunces, Inter } from "next/font/google";
import type { ReactNode } from "react";

import { CookieConsent } from "../components/CookieConsent";
import { Footer } from "../components/Footer";
import { Header } from "../components/Header";
import { MeshDriftBackground } from "../components/MeshDriftBackground";

import "./globals.css";
import "./interior.css";
import "./filmstrip.css";
import "./globe.css";
import "./parallax.css";
import "./legal.css";

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
        {/*
          Last, so it paints above the footer. It renders nothing until it has
          read a stored choice, so a visitor who has already answered never sees
          it, and until they answer components/WorldGlobe.tsx does not import
          Cesium at all - so no tile request goes out and no IP address is
          exposed.
        */}
        <CookieConsent />
      </body>
    </html>
  );
}
