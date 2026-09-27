import type { Metadata } from "next";

import { StaticPageView, staticPageMetadata } from "../../components/StaticPage";
import { getPage } from "../../lib/pages";

export const metadata: Metadata = staticPageMetadata("privacy");

export default function PrivacyPage() {
  return <StaticPageView page={getPage("privacy")} />;
}
