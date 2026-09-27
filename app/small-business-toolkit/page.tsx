import type { Metadata } from "next";

import { StaticPageView, staticPageMetadata } from "../../components/StaticPage";
import { getPage } from "../../lib/pages";

export const metadata: Metadata = staticPageMetadata("small-business-toolkit");

export default function SmallBusinessToolkitPage() {
  return <StaticPageView page={getPage("small-business-toolkit")} />;
}
