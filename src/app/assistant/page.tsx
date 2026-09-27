import type { Metadata } from "next";

import { SiteHeader } from "../_components/SiteHeader";
import { AssistantView } from "@/features/assistant/AssistantView";

export const metadata: Metadata = {
  title: "Assistant",
  description:
    "Ask about your hours, your budget and how TravelBuddy works. Answers come from the app's own catalogue, and the assistant says so when it does not have a fact.",
};

/**
 * The AI assistant.
 *
 * A server component that renders one client island. Everything interactive —
 * the transcript, the composer, the voice state machine — is in
 * `src/features/assistant/`, and this file's only jobs are the page title and
 * the shared header, so the surface looks like the rest of the app without
 * knowing anything about chat.
 *
 * `force-dynamic` because the transcript is per-cookie and must never be cached
 * into a shared response.
 */
export const dynamic = "force-dynamic";

export default function AssistantPage() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="min-h-0">
        <AssistantView />
      </main>
    </>
  );
}
