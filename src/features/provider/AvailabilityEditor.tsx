"use client";

/**
 * Availability: publish slots, mark unavailable windows, watch remaining capacity.
 *
 * Native controls do the heavy lifting — `<input type="date">` and
 * `<input type="time">` already produce the `YYYY-MM-DD` and `HH:MM` strings the
 * contract wants, so there is no date picker dependency to justify.
 *
 * Remaining capacity is always the derived `SlotAvailability`, never a counter
 * this component keeps. Confirming in the inbox is what moves it.
 */
import { useEffect, useState } from "react";
import type { Experience } from "../../contracts";
import type { ProviderApi } from "./api";
import {
  type BlockDraft,
  EMPTY_BLOCK_DRAFT,
  EMPTY_SLOT_DRAFT,
  slotLabel,
  type SlotDraft,
  type SlotErrors,
  type SlotView,
} from "./availability";
import { Alert, Badge, Button, CapacityBar, Card, Data, EmptyState, Field, Select, TextInput, type Tone } from "./primitives";

const STATUS_TONE: Record<SlotView["availability"]["status"], Tone> = {
  ok: "muted",
  reserved: "info",
  ordered: "warn",
  gone: "alarm",
};

const STATUS_COPY: Record<SlotView["availability"]["status"], string> = {
  ok: "Open",
  reserved: "Requests waiting",
  ordered: "Partly booked",
  gone: "Full",
};

function SlotRow({ view, past }: { view: SlotView; past: boolean }) {
  const { availability, dated, blockedBy } = view;
  return (
    <li
      style={{
        borderTop: "1px solid var(--rule)",
        padding: "0.5rem 0",
        display: "grid",
        gap: "0.25rem",
      }}
    >
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
        <Data>{slotLabel(dated)}</Data>
        <Badge tone={STATUS_TONE[availability.status]}>{STATUS_COPY[availability.status]}</Badge>
        {past && <Badge tone="muted">Past</Badge>}
        {blockedBy && <Badge tone="alarm">Unavailable: {blockedBy.reason}</Badge>}
      </div>
      <CapacityBar remaining={availability.remaining} capacity={dated.slot.capacity} />
      <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--ink-faint)" }}>
        {availability.derivedFrom.join(" · ")}
      </p>
    </li>
  );
}

export function AvailabilityEditor({
  api,
  listings,
  today,
  onChanged,
}: {
  api: ProviderApi;
  listings: Experience[];
  today: string;
  onChanged?: () => void;
}) {
  const [slotDraft, setSlotDraft] = useState<SlotDraft>({
    ...EMPTY_SLOT_DRAFT,
    experienceId: listings[0]?.id ?? "",
  });
  const [blockDraft, setBlockDraft] = useState<BlockDraft>({
    ...EMPTY_BLOCK_DRAFT,
    experienceId: listings[0]?.id ?? "",
  });
  const [slotErrors, setSlotErrors] = useState<SlotErrors>({});
  const [blockErrors, setBlockErrors] = useState<SlotErrors>({});
  const [views, setViews] = useState<SlotView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"slot" | "block" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setViews(await api.availability());
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "Availability could not be loaded.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, today]);

  const publishSlot = async () => {
    setBusy("slot");
    setNotice(null);
    const result = await api.addSlot(slotDraft);
    setBusy(null);
    if (!result.ok) {
      setSlotErrors(result.error);
      return;
    }
    setSlotErrors({});
    setSlotDraft((current) => ({ ...current, start: "", end: "" }));
    setNotice(`Published ${slotLabel(result.value)} on ${result.value.date}.`);
    await refresh();
    onChanged?.();
  };

  const publishBlock = async () => {
    setBusy("block");
    setNotice(null);
    const result = await api.addBlock(blockDraft);
    setBusy(null);
    if (!result.ok) {
      setBlockErrors(result.error);
      return;
    }
    setBlockErrors({});
    setNotice(`Marked ${result.value.reason} on ${result.value.date} as unavailable.`);
    await refresh();
    onChanged?.();
  };

  if (listings.length === 0) {
    return (
      <EmptyState
        title="Publish a listing first"
        body="A slot belongs to an experience, so there is nothing to schedule until a listing exists."
      />
    );
  }

  const byDate = new Map<string, SlotView[]>();
  for (const view of views) {
    byDate.set(view.dated.date, [...(byDate.get(view.dated.date) ?? []), view]);
  }

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <Card title="Publish a slot" description={`Today is ${today}. Past dates are refused.`}>
        <div style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))" }}>
          <Field id="slot-experienceId" label="Experience" error={slotErrors.experienceId}>
            <Select
              id="slot-experienceId"
              value={slotDraft.experienceId}
              onChange={(event) => setSlotDraft((current) => ({ ...current, experienceId: event.target.value }))}
            >
              {listings.map((listing) => (
                <option key={listing.id} value={listing.id}>
                  {listing.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="slot-date" label="Date" error={slotErrors.date}>
            <TextInput
              id="slot-date"
              type="date"
              min={today}
              value={slotDraft.date}
              onChange={(event) => setSlotDraft((current) => ({ ...current, date: event.target.value }))}
            />
          </Field>
          <Field id="slot-start" label="Start" error={slotErrors.start}>
            <TextInput
              id="slot-start"
              type="time"
              value={slotDraft.start}
              onChange={(event) => setSlotDraft((current) => ({ ...current, start: event.target.value }))}
            />
          </Field>
          <Field id="slot-end" label="End" error={slotErrors.end}>
            <TextInput
              id="slot-end"
              type="time"
              value={slotDraft.end}
              onChange={(event) => setSlotDraft((current) => ({ ...current, end: event.target.value }))}
            />
          </Field>
          <Field id="slot-capacity" label="Places" error={slotErrors.capacity}>
            <TextInput
              id="slot-capacity"
              type="number"
              min={1}
              inputMode="numeric"
              value={slotDraft.capacity}
              onChange={(event) => setSlotDraft((current) => ({ ...current, capacity: event.target.value }))}
            />
          </Field>
        </div>
        <Button variant="primary" onClick={publishSlot} busy={busy === "slot"}>
          Publish slot
        </Button>
      </Card>

      <Card title="Mark time unavailable" description="Lunch breaks, market days, teaching hours. Existing bookings are not cancelled.">
        <div style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))" }}>
          <Field id="block-experienceId" label="Experience" error={blockErrors.experienceId}>
            <Select
              id="block-experienceId"
              value={blockDraft.experienceId}
              onChange={(event) => setBlockDraft((current) => ({ ...current, experienceId: event.target.value }))}
            >
              {listings.map((listing) => (
                <option key={listing.id} value={listing.id}>
                  {listing.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="block-date" label="Date" error={blockErrors.date}>
            <TextInput
              id="block-date"
              type="date"
              min={today}
              value={blockDraft.date}
              onChange={(event) => setBlockDraft((current) => ({ ...current, date: event.target.value }))}
            />
          </Field>
          <Field id="block-start" label="From" error={blockErrors.start}>
            <TextInput
              id="block-start"
              type="time"
              value={blockDraft.start}
              onChange={(event) => setBlockDraft((current) => ({ ...current, start: event.target.value }))}
            />
          </Field>
          <Field id="block-end" label="To" error={blockErrors.end}>
            <TextInput
              id="block-end"
              type="time"
              value={blockDraft.end}
              onChange={(event) => setBlockDraft((current) => ({ ...current, end: event.target.value }))}
            />
          </Field>
          <Field id="block-reason" label="Reason" hint="Shown to the traveller if they try to book.">
            <TextInput
              id="block-reason"
              value={blockDraft.reason}
              onChange={(event) => setBlockDraft((current) => ({ ...current, reason: event.target.value }))}
              placeholder="Studio closed for lunch"
            />
          </Field>
        </div>
        <Button onClick={publishBlock} busy={busy === "block"}>
          Mark unavailable
        </Button>
      </Card>

      <Card
        title="Published slots"
        description="Remaining is derived from confirmed requests, carts and capacity, so it can never drift."
        actions={
          <Button onClick={() => void refresh()} busy={loading}>
            Refresh
          </Button>
        }
      >
        {notice && (
          <Alert tone="fit" title="Done">
            {notice}
          </Alert>
        )}
        {loadError && (
          <Alert tone="alarm" title="Could not load availability" action={<Button onClick={() => void refresh()}>Retry</Button>}>
            {loadError}
          </Alert>
        )}
        {loading && views.length === 0 && <p style={{ color: "var(--ink-muted)", fontSize: "0.8125rem" }}>Loading slots</p>}
        {!loading && views.length === 0 && !loadError && (
          <EmptyState
            title="No slots yet"
            body="Publish one above and travellers searching nearby will start seeing you."
          />
        )}
        {[...byDate.entries()].map(([date, dateViews]) => (
          <div key={date} style={{ display: "grid", gap: "0.25rem" }}>
            <h3 style={{ margin: "0.5rem 0 0", fontSize: "0.875rem" }}>
              <Data>{date}</Data>
            </h3>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {dateViews.map((view) => (
                <SlotRow key={view.dated.slot.id} view={view} past={date < today} />
              ))}
            </ul>
          </div>
        ))}
      </Card>
    </div>
  );
}
