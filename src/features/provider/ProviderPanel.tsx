"use client";

/**
 * The provider surface Karan can drop into a page: listings, availability and
 * the request inbox behind three tabs, with the loading / error / empty /
 * success states wired to the async API rather than faked per component.
 *
 * ponytail: ceiling — no routing, no auth, no persistence. `ProviderApi` is the
 * seam: swap it for route handlers in `src/app` and this file does not change.
 */
import { useCallback, useEffect, useState } from "react";
import type { Experience } from "../../contracts";
import type { ProviderApi } from "./api";
import { createDemoApi } from "./demo";
import { AvailabilityEditor } from "./AvailabilityEditor";
import { ListingEditor } from "./ListingEditor";
import { Alert, Badge, Button, Card, EmptyState, Skeleton } from "./primitives";
import { RequestInbox } from "./RequestInbox";

type Tab = "listings" | "availability" | "requests";

const TABS: { id: Tab; label: string }[] = [
  { id: "listings", label: "Listings" },
  { id: "availability", label: "Availability" },
  { id: "requests", label: "Requests" },
];

export function ProviderPanel({ api: provided }: { api?: ProviderApi } = {}) {
  const [api, setApi] = useState<ProviderApi>(() => provided ?? createDemoApi());
  const [tab, setTab] = useState<Tab>("listings");
  const [listings, setListings] = useState<Experience[]>([]);
  const [editing, setEditing] = useState<Experience | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openRequests, setOpenRequests] = useState<number | null>(null);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setListings(await api.listings());
      setOpenRequests((await api.requests()).filter((view) => view.request.state === "requested").length);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "The provider console could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const provider = api.provider();
  const today = api.today();

  return (
    <div style={{ display: "grid", gap: "1rem", fontFamily: "var(--font-ui, system-ui)" }}>
      <Card
        title={provider.name}
        description={`${provider.kind} · ${provider.neighbourhood}, ${provider.city} · today is ${today}`}
        actions={
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <Button onClick={() => void load()}>Refresh</Button>
            <Button
              onClick={() => {
                setApi(provided ?? createDemoApi());
                setEditing(null);
                setCreating(false);
                setVersion((value) => value + 1);
              }}
            >
              Reset demo
            </Button>
          </div>
        }
      >
        <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap" }}>
          <Badge tone={provider.verified ? "fit" : "warn"}>{provider.verified ? "Verified" : "Unverified"}</Badge>
          <Badge tone="muted">Reliability {(provider.reliability * 100).toFixed(0)}%</Badge>
          {openRequests !== null && (
            <Badge tone={openRequests > 0 ? "alarm" : "muted"}>
              {openRequests} request{openRequests === 1 ? "" : "s"} waiting
            </Badge>
          )}
        </div>

        <div role="group" aria-label="Provider sections" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {TABS.map((entry) => (
            <Button
              key={entry.id}
              variant={tab === entry.id ? "primary" : "quiet"}
              aria-pressed={tab === entry.id}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </Button>
          ))}
        </div>
      </Card>

      {loadError && (
        <Alert tone="alarm" title="Something went wrong" action={<Button onClick={() => void load()}>Retry</Button>}>
          {loadError}
        </Alert>
      )}

      {loading && listings.length === 0 && <Skeleton label="Loading your listings" />}

      {!loading && tab === "listings" && (
        <div style={{ display: "grid", gap: "1rem" }}>
          <Card
            title="Your listings"
            actions={
              <Button
                variant="primary"
                onClick={() => {
                  setEditing(null);
                  setCreating((value) => !value);
                }}
              >
                {creating ? "Close editor" : "New listing"}
              </Button>
            }
          >
            {listings.length === 0 ? (
              <EmptyState
                title="No listings yet"
                body="A listing is one row travellers can find: where it is, what it costs, how long it takes, and whether it works for a stroller."
                action={
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    Create your first listing
                  </Button>
                }
              />
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.5rem" }}>
                {listings.map((listing) => (
                  <li
                    key={listing.id}
                    style={{ borderTop: "1px solid var(--rule)", paddingTop: "0.5rem", display: "flex", justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}
                  >
                    <div>
                      <strong>{listing.name}</strong>
                      <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--ink-muted)" }}>
                        {listing.neighbourhood ?? listing.city} · {listing.durationMin} min ·{" "}
                        {listing.pricePerPerson ? `INR ${(listing.pricePerPerson.minor / 100).toFixed(0)}` : "Free"} ·{" "}
                        {listing.capacity === null ? "unlimited" : `${listing.capacity} places`}
                      </p>
                    </div>
                    <Button
                      onClick={() => {
                        setCreating(false);
                        setEditing(listing);
                      }}
                    >
                      Edit
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {creating && (
            <ListingEditor
              api={api}
              onSaved={() => {
                setCreating(false);
                void load();
              }}
            />
          )}
          {editing && (
            <ListingEditor
              key={editing.id}
              api={api}
              experience={editing}
              onSaved={() => {
                setEditing(null);
                void load();
              }}
            />
          )}
        </div>
      )}

      {!loading && tab === "availability" && (
        <AvailabilityEditor api={api} listings={listings} today={today} onChanged={() => void load()} />
      )}

      {!loading && tab === "requests" && (
        <RequestInbox api={api} today={today} onChanged={() => void load()} />
      )}
    </div>
  );
}
