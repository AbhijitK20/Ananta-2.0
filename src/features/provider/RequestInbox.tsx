"use client";

/**
 * The inbox. Confirm and Decline are the only two actions a provider has, and
 * both are gated by the same `confirmDecision` / `declineDecision` guards the
 * store uses — so a disabled button and a refused write always agree, and every
 * refusal arrives as a finished sentence with the real numbers in it.
 */
import { useEffect, useState } from "react";
import type { BookingState } from "../../contracts";
import type { ProviderApi } from "./api";
import { slotLabel, type SlotView } from "./availability";
import type { RequestView } from "./bookings";
import { Alert, Badge, Button, CapacityBar, Card, Data, EmptyState, Field, TextInput, type Tone } from "./primitives";

const STATE_TONE: Record<BookingState, Tone> = {
  requested: "info",
  confirmed: "fit",
  declined: "muted",
  cancelled: "muted",
  completed: "muted",
};

const STATE_COPY: Record<BookingState, string> = {
  requested: "Needs an answer",
  confirmed: "Confirmed",
  declined: "Declined",
  cancelled: "Cancelled by the traveller",
  completed: "Completed",
};

type Outcome = { id: string; kind: "success" | "failure"; message: string } | null;

export function RequestInbox({
  api,
  today,
  onChanged,
}: {
  api: ProviderApi;
  today: string;
  onChanged?: () => void;
}) {
  const [views, setViews] = useState<RequestView[]>([]);
  const [slots, setSlots] = useState<SlotView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [declining, setDeclining] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [nextRequests, nextSlots] = await Promise.all([api.requests(), api.availability()]);
      setViews(nextRequests);
      setSlots(nextSlots);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "Requests could not be loaded.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const confirm = async (view: RequestView) => {
    setWorking(view.request.id);
    setOutcome(null);
    const result = await api.confirm(view.request.id);
    setWorking(null);
    setOutcome(
      result.ok
        ? {
            id: view.request.id,
            kind: "success",
            message: `Confirmed ${view.request.travellerName}'s party of ${view.request.partySize}. ${view.remaining - view.request.partySize} places left in that slot.`,
          }
        : { id: view.request.id, kind: "failure", message: result.error.message },
    );
    await refresh();
    onChanged?.();
  };

  const decline = async (view: RequestView) => {
    setWorking(view.request.id);
    setOutcome(null);
    const result = await api.decline(view.request.id, reasons[view.request.id] ?? "");
    setWorking(null);
    if (!result.ok) {
      setOutcome({ id: view.request.id, kind: "failure", message: result.error.message });
      await refresh();
      return;
    }
    setDeclining(null);
    setReasons((current) => ({ ...current, [view.request.id]: "" }));
    setOutcome({
      id: view.request.id,
      kind: "success",
      message: `Declined ${view.request.travellerName}'s request. The places are still free.`,
    });
    await refresh();
    onChanged?.();
  };

  const waiting = views.filter((view) => view.request.state === "requested").length;
  const slotFor = (view: RequestView) => slots.find((slot) => slot.dated.slot.id === view.request.slotId);

  return (
    <Card
      title="Booking requests"
      description={
        waiting === 0
          ? "Nothing is waiting on you."
          : `${waiting} request${waiting === 1 ? "" : "s"} waiting on you.`
      }
      actions={
        <Button onClick={() => void refresh()} busy={loading}>
          Refresh
        </Button>
      }
    >
      <div aria-live="polite" style={{ display: "grid", gap: "0.5rem" }}>
        {outcome && (
          <Alert tone={outcome.kind === "success" ? "fit" : "alarm"} title={outcome.kind === "success" ? "Done" : "Not done"}>
            {outcome.message}
          </Alert>
        )}
        {loadError && (
          <Alert tone="alarm" title="Could not load requests" action={<Button onClick={() => void refresh()}>Retry</Button>}>
            {loadError}
          </Alert>
        )}
        {loading && views.length === 0 && (
          <p style={{ color: "var(--ink-muted)", fontSize: "0.8125rem" }}>Loading requests</p>
        )}
        {!loading && views.length === 0 && !loadError && (
          <EmptyState
            title="No requests yet"
            body="When a traveller asks for a place, it lands here. Requests hold no capacity until you confirm."
          />
        )}

        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.75rem" }}>
          {views.map((view) => {
            const { request } = view;
            const busy = working === request.id;
            const slot = slotFor(view);
            const confirmable = view.canConfirm.allowed;
            const declineable = view.canDecline.allowed;
            const reason = !confirmable && !declineable ? view.canConfirm.reason : null;
            return (
              <li
                key={request.id}
                style={{ border: "1px solid var(--rule)", borderRadius: "var(--radius-md, 8px)", padding: "0.75rem", display: "grid", gap: "0.5rem" }}
              >
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "baseline", flexWrap: "wrap" }}>
                  <strong>{request.travellerName}</strong>
                  <Badge tone={STATE_TONE[request.state]}>{STATE_COPY[request.state]}</Badge>
                  <span style={{ fontSize: "0.8125rem", color: "var(--ink-muted)" }}>
                    party of <Data>{request.partySize}</Data> · {view.experience?.name ?? request.experienceId}
                  </span>
                </div>

                <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--ink-muted)" }}>
                  {view.slot ? (
                    <>
                      <Data>
                        {view.slot.date} {slotLabel(view.slot)}
                      </Data>
                      {view.slot.date < today && " · this slot has already passed"}
                    </>
                  ) : (
                    "The slot for this request is no longer published."
                  )}
                </p>

                {slot && (
                  <CapacityBar remaining={slot.availability.remaining} capacity={slot.dated.slot.capacity} />
                )}

                {request.declineReason && (
                  <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--ink-faint)" }}>
                    Declined: {request.declineReason}
                  </p>
                )}

                {reason && (
                  <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--ink-faint)" }}>{reason}</p>
                )}

                {declining === request.id && (
                  <Field
                    id={`decline-reason-${request.id}`}
                    label="Why are you declining?"
                    hint="Sent to the traveller. It is the difference between a marketplace and a black hole."
                  >
                    <TextInput
                      id={`decline-reason-${request.id}`}
                      value={reasons[request.id] ?? ""}
                      onChange={(event) => setReasons((current) => ({ ...current, [request.id]: event.target.value }))}
                      placeholder="The press is booked that afternoon."
                    />
                  </Field>
                )}

                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                  <Button
                    variant="primary"
                    disabled={!confirmable}
                    title={confirmable ? undefined : view.canConfirm.reason}
                    busy={busy}
                    onClick={() => void confirm(view)}
                  >
                    Confirm
                  </Button>
                  <Button
                    variant="danger"
                    disabled={!declineable}
                    title={declineable ? undefined : view.canDecline.reason}
                    busy={busy}
                    onClick={() => (declining === request.id ? void decline(view) : setDeclining(request.id))}
                  >
                    {declining === request.id ? "Confirm decline" : "Decline"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}
