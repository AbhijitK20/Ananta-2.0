/**
 * GET /api/assistant/health — what the assistant is actually running on.
 *
 * This is the endpoint that makes the customization claim checkable rather than
 * asserted. It reports the model id, whether that id came from an alignment
 * record, and the alignment id it came from — so "did you actually align a model,
 * or is this the base model with a prompt?" is one `curl` away.
 *
 * `customized: false` with a non-null `model` is not reachable: `config.ts` has
 * no base-model fallback, so a model id here always came from
 * `NUGEN_CUSTOMIZED_MODEL_ID` or from the alignment record on disk.
 *
 * `?deep=1` makes a one-token call to the provider to distinguish "we have a
 * model configured" from "the provider is actually answering". It costs a call,
 * so it is opt-in and off by default.
 *
 * The API key is never in the payload. The provider builds its own headers and
 * never stores them, so there is no field here that could hold one.
 */
import { NugenProvider } from "@/features/assistant/provider";
import { DeterministicProvider } from "@/features/assistant/provider/deterministic";
import { assistantStatus } from "@/features/assistant/orchestration/chat";
import { storageKind } from "@/features/assistant/db";
import type { ProviderHealth } from "@/features/assistant/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const deep = new URL(request.url).searchParams.get("deep") === "1";

  const nugen = await NugenProvider.create();
  const status = await assistantStatus();

  const health: ProviderHealth = deep && nugen.available
    ? await (async (): Promise<ProviderHealth> => {
        const probe = await nugen.healthCheck();
        const base = nugen.health();
        return {
          ...base,
          status: probe.ok ? "ready" : "degraded",
          detail: probe.ok ? `provider answered in ${probe.latencyMs}ms` : probe.detail,
        };
      })()
    : nugen.available
      ? nugen.health()
      : { ...new DeterministicProvider().health(), detail: nugen.health().detail };

  // 200 even when degraded: the assistant is working, on the offline path. A 503
  // would tell a monitor the product is down, which it is not — and would make
  // the "assistant unavailable" state indistinguishable from "assistant broken".
  return Response.json(
    {
      ...health,
      promptVersion: status.promptVersion,
      alignment: {
        customized: status.customized,
        model: status.model,
        /** Null until `npm run assistant:align` has produced a record. */
        detail: status.detail,
      },
      /**
       * Whether conversations survive a restart.
       *
       * `durable` on a server or a laptop. `ephemeral` on a serverless deploy,
       * where the only writable path is a per-instance tmpfs — the assistant
       * works, and a cold start loses the history. Reported rather than assumed,
       * because a chat that silently forgets is indistinguishable from a bug.
       */
      storage: storageKind(),
      checkedAt: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
