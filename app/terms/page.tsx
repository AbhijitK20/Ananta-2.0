import type { Metadata } from "next";

import { StaticPageView, staticPageMetadata } from "../../components/StaticPage";
import { getPage } from "../../lib/pages";

export const metadata: Metadata = staticPageMetadata("terms");

export default function TermsPage() {
  return <StaticPageView page={getPage("terms")} />;
}
