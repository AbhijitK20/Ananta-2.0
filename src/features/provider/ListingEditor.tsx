"use client";

/**
 * Create / edit / preview one listing.
 *
 * Validation is not duplicated here: `validateListing` runs on submit and then on
 * every keystroke, so the provider sees the same sentences the store enforces.
 * Nothing is written to the catalogue until `api.saveListing` comes back ok.
 */
import { useMemo, useState } from "react";
import type { Category, Experience, IndoorOutdoor, Provenance } from "../../contracts";
import type { ProviderApi } from "./api";
import {
  buildExperience,
  CATEGORY_OPTIONS,
  draftFromExperience,
  EMPTY_DRAFT,
  INDOOR_OUTDOOR_OPTIONS,
  type ListingDraft,
  type ListingErrors,
  validateListing,
} from "./listing";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Data,
  EmptyState,
  Field,
  Select,
  TextArea,
  TextInput,
  type Tone,
} from "./primitives";

const ACCESS_ROWS: { label: string; key: keyof Experience["accessibility"] }[] = [
  { label: "Step-free", key: "stepFree" },
  { label: "Stroller ok", key: "strollerOk" },
  { label: "Few stairs", key: "lowStairs" },
  { label: "Seating", key: "seatingAvailable" },
  { label: "Hearing loop", key: "hearingLoop" },
  { label: "Restroom on site", key: "restroomOnSite" },
];

const triTone = (value: "yes" | "no" | "unknown"): Tone =>
  value === "yes" ? "fit" : value === "no" ? "alarm" : "warn";

const provenanceTone: Record<Provenance, Tone> = {
  provider: "accent",
  curated: "info",
  osm: "info",
  inferred: "warn",
  derived: "muted",
};

function Preview({ experience }: { experience: Experience }) {
  const provenance = useMemo(() => {
    const grouped = new Map<Provenance, string[]>();
    for (const [field, source] of Object.entries(experience.provenance)) {
      grouped.set(source, [...(grouped.get(source) ?? []), field]);
    }
    return [...grouped.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [experience]);

  return (
    <Card
      title="How a traveller will see this"
      description="Provenance is the honesty backbone: anything inferred is badged, never blended."
    >
      <div style={{ display: "grid", gap: "0.5rem" }}>
        <div>
          <strong>{experience.name}</strong>
          <p style={{ margin: "0.125rem 0 0", color: "var(--ink-muted)", fontSize: "0.8125rem" }}>
            {experience.neighbourhood ?? experience.city} · {experience.category.replace(/_/g, " ")} ·{" "}
            <Data>{experience.durationMin} min</Data> ·{" "}
            <Data>
              {experience.pricePerPerson
                ? `INR ${(experience.pricePerPerson.minor / 100).toFixed(0)} per person`
                : "Free"}
            </Data>{" "}
            · <Data>{experience.capacity === null ? "unlimited places" : `${experience.capacity} places`}</Data>
          </p>
        </div>

        {experience.blurb && <p style={{ margin: 0, fontSize: "0.875rem" }}>{experience.blurb}</p>}

        <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--ink-muted)" }}>
          Family fit:{" "}
          {experience.kidFriendly === null
            ? "not stated"
            : experience.kidFriendly
              ? `suits children from ${experience.minAge ?? 0}`
              : "not a children-friendly experience"}
          {" · "}
          {experience.indoorOutdoor}
          {" · "}
          {experience.hours.raw ?? "hours not surveyed"}
        </p>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem" }}>
          {ACCESS_ROWS.map((row) => {
            const value = experience.accessibility[row.key];
            return (
              <Badge key={row.key} tone={triTone(value === null ? "unknown" : value ? "yes" : "no")}>
                {row.label}: {value === null ? "Not surveyed" : value ? "Yes" : "No"}
              </Badge>
            );
          })}
        </div>

        {experience.keywords.length > 0 && (
          <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--ink-faint)" }}>
            Tags: {experience.keywords.join(", ")}
          </p>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem" }}>
          {provenance.map(([source, fields]) => (
            <Badge key={source} tone={provenanceTone[source]}>
              {source}: {fields.length} field{fields.length === 1 ? "" : "s"}
            </Badge>
          ))}
        </div>
        <ul style={{ margin: 0, paddingLeft: "1.125rem", fontSize: "0.75rem", color: "var(--ink-faint)" }}>
          {provenance.map(([source, fields]) => (
            <li key={source}>
              {source}: {fields.join(", ")}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

export function ListingEditor({
  api,
  experience,
  onSaved,
}: {
  api: ProviderApi;
  experience?: Experience | undefined;
  onSaved?: (experience: Experience) => void;
}) {
  const [id, setId] = useState<string | null>(experience?.id ?? null);
  const [draft, setDraft] = useState<ListingDraft>(() =>
    experience ? draftFromExperience(experience) : EMPTY_DRAFT,
  );
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Experience | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const existing = saved ?? experience;
  const errors: ListingErrors = submitted ? validateListing(draft, experience) : {};
  const errorCount = Object.keys(errors).length;
  const patch = (changes: Partial<ListingDraft>) => setDraft((current) => ({ ...current, ...changes }));
  const errorFor = (field: keyof ListingDraft): string | undefined => errors[field];

  const submit = async () => {
    setSubmitted(true);
    setFailure(null);
    const found = validateListing(draft, experience);
    if (Object.keys(found).length > 0) {
      const first = document.getElementById(`listing-${Object.keys(found)[0] ?? "name"}`);
      first?.focus();
      return;
    }
    setSaving(true);
    const result = await api.saveListing(id, draft);
    setSaving(false);
    if (!result.ok) {
      setFailure(`The listing was not saved: ${Object.values(result.error).join(" ")}`);
      return;
    }
    setId(result.value.id);
    setSaved(result.value);
    onSaved?.(result.value);
  };

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <Card
        title={id ? `Edit ${experience?.name ?? "listing"}` : "Create a listing"}
        description="Every field you answer is marked as yours. Fields you leave blank are badged as not surveyed."
        actions={
          <Button onClick={() => setShowPreview((value) => !value)} aria-expanded={showPreview}>
            {showPreview ? "Hide preview" : "Preview"}
          </Button>
        }
      >
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {saved && (
            <Alert tone="fit" title="Saved">
              {saved.name} is live. Travellers searching nearby will see it with your provenance badges.
            </Alert>
          )}
          {failure && <Alert tone="alarm" title="Not saved">{failure}</Alert>}
          {submitted && errorCount > 0 && (
            <Alert tone="alarm" title={`${errorCount} field${errorCount === 1 ? "" : "s"} need attention`}>
              Nothing has been saved yet. Fix the highlighted fields and try again.
            </Alert>
          )}

          <Field id="listing-name" label="Title" error={errorFor("name")}>
            <TextInput
              id="listing-name"
              value={draft.name}
              maxLength={120}
              onChange={(event) => patch({ name: event.target.value })}
              placeholder="Block Print Studio Session"
            />
          </Field>

          <div style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))" }}>
            <Field id="listing-category" label="Category" error={errorFor("category")}>
              <Select
                id="listing-category"
                value={draft.category}
                onChange={(event) => patch({ category: event.target.value as Category })}
              >
                <option value="">Choose a category</option>
                {CATEGORY_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option.replace(/_/g, " ")}
                  </option>
                ))}
              </Select>
            </Field>

            <Field id="listing-indoorOutdoor" label="Indoor or outdoor">
              <Select
                id="listing-indoorOutdoor"
                value={draft.indoorOutdoor}
                onChange={(event) => patch({ indoorOutdoor: event.target.value as IndoorOutdoor })}
              >
                {INDOOR_OUTDOOR_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            </Field>

            <Field id="listing-neighbourhood" label="Neighbourhood" error={errorFor("neighbourhood")}>
              <TextInput
                id="listing-neighbourhood"
                value={draft.neighbourhood}
                onChange={(event) => patch({ neighbourhood: event.target.value })}
                placeholder="Fort"
              />
            </Field>

            <Field id="listing-city" label="City">
              <TextInput id="listing-city" value={draft.city} onChange={(event) => patch({ city: event.target.value })} />
            </Field>
          </div>

          <Field id="listing-blurb" label="One-line blurb" hint="Shown on the card, so keep it under 90 characters.">
            <TextInput id="listing-blurb" value={draft.blurb} onChange={(event) => patch({ blurb: event.target.value })} />
          </Field>

          <Field id="listing-description" label="Description" hint="The LLM enriches from this, so specifics beat adjectives.">
            <TextArea
              id="listing-description"
              value={draft.description}
              onChange={(event) => patch({ description: event.target.value })}
            />
          </Field>

          <div style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))" }}>
            <Field id="listing-priceRupees" label="Price per person (INR)" error={errorFor("priceRupees")} hint="Blank means free.">
              <TextInput
                id="listing-priceRupees"
                inputMode="decimal"
                value={draft.priceRupees}
                onChange={(event) => patch({ priceRupees: event.target.value })}
                placeholder="450"
              />
            </Field>
            <Field id="listing-durationMin" label="Duration (min)" error={errorFor("durationMin")}>
              <TextInput
                id="listing-durationMin"
                inputMode="numeric"
                value={draft.durationMin}
                onChange={(event) => patch({ durationMin: event.target.value })}
              />
            </Field>
            <Field id="listing-capacity" label="Places" error={errorFor("capacity")} hint="Blank means unlimited.">
              <TextInput
                id="listing-capacity"
                inputMode="numeric"
                value={draft.capacity}
                onChange={(event) => patch({ capacity: event.target.value })}
              />
            </Field>
          </div>

          <div style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))" }}>
            <Field id="listing-lat" label="Latitude" error={errorFor("lat")}>
              <TextInput
                id="listing-lat"
                inputMode="decimal"
                value={draft.lat}
                onChange={(event) => patch({ lat: event.target.value })}
                placeholder="18.9335"
              />
            </Field>
            <Field id="listing-lon" label="Longitude" error={errorFor("lon")}>
              <TextInput
                id="listing-lon"
                inputMode="decimal"
                value={draft.lon}
                onChange={(event) => patch({ lon: event.target.value })}
                placeholder="72.8345"
              />
            </Field>
            <Field id="listing-hoursRaw" label="Opening hours" error={errorFor("hoursRaw")} hint="OpenStreetMap format.">
              <TextInput
                id="listing-hoursRaw"
                value={draft.hoursRaw}
                onChange={(event) => patch({ hoursRaw: event.target.value })}
                placeholder="Tu-Su 11:00-19:00"
              />
            </Field>
          </div>

          <fieldset style={{ ...{ border: "1px solid var(--rule)" }, borderRadius: "var(--radius-sm, 4px)", padding: "0.75rem", display: "grid", gap: "0.5rem" }}>
            <legend style={{ fontSize: "0.8125rem", color: "var(--ink-muted)" }}>Family fit</legend>
            <Field id="listing-kidFriendly" label="Suits children" hint="Leave as not surveyed rather than guessing.">
              <Select
                id="listing-kidFriendly"
                value={draft.kidFriendly}
                onChange={(event) => patch({ kidFriendly: event.target.value as ListingDraft["kidFriendly"] })}
              >
                <option value="unknown">Not surveyed</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </Select>
            </Field>
            <Field id="listing-minAge" label="Minimum age" error={errorFor("minAge")} hint="Blank means anyone can come.">
              <TextInput
                id="listing-minAge"
                inputMode="numeric"
                value={draft.minAge}
                onChange={(event) => patch({ minAge: event.target.value })}
              />
            </Field>
          </fieldset>

          <fieldset style={{ ...{ border: "1px solid var(--rule)" }, borderRadius: "var(--radius-sm, 4px)", padding: "0.75rem", display: "grid", gap: "0.5rem" }}>
            <legend style={{ fontSize: "0.8125rem", color: "var(--ink-muted)" }}>Accessibility</legend>
            {ACCESS_ROWS.map((row) => (
              <Field key={row.key} id={`listing-${row.key}`} label={row.label}>
                <Select
                  id={`listing-${row.key}`}
                  value={draft[row.key]}
                  onChange={(event) => patch({ [row.key]: event.target.value } as Partial<ListingDraft>)}
                >
                  <option value="unknown">Not surveyed</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </Select>
              </Field>
            ))}
          </fieldset>

          <div style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))" }}>
            <Field id="listing-keywords" label="Tags" hint="Comma separated, up to 12.">
              <TextInput
                id="listing-keywords"
                value={draft.keywords}
                onChange={(event) => patch({ keywords: event.target.value })}
                placeholder="block printing, textile, workshop"
              />
            </Field>
            <Field id="listing-diets" label="Dietary tags" hint="Open vocabulary, comma separated.">
              <TextInput id="listing-diets" value={draft.diets} onChange={(event) => patch({ diets: event.target.value })} />
            </Field>
            <Field id="listing-cuisines" label="Cuisines" hint="Comma separated.">
              <TextInput
                id="listing-cuisines"
                value={draft.cuisines}
                onChange={(event) => patch({ cuisines: event.target.value })}
              />
            </Field>
          </div>

          <fieldset style={{ ...{ border: "1px solid var(--rule)" }, borderRadius: "var(--radius-sm, 4px)", padding: "0.75rem", display: "grid", gap: "0.5rem" }}>
            <legend style={{ fontSize: "0.8125rem", color: "var(--ink-muted)" }}>Booking</legend>
            <Checkbox
              id="listing-requiresBooking"
              label="Booking required"
              checked={draft.requiresBooking}
              onChange={(event) => patch({ requiresBooking: event.target.checked })}
            />
            <Checkbox
              id="listing-walkIn"
              label="Walk-ins possible"
              checked={draft.walkIn}
              onChange={(event) => patch({ walkIn: event.target.checked })}
            />
            <Field
              id="listing-leadTimeMin"
              label="Notice needed (min)"
              error={errorFor("leadTimeMin")}
              hint="Only used when booking is required."
            >
              <TextInput
                id="listing-leadTimeMin"
                inputMode="numeric"
                value={draft.leadTimeMin}
                onChange={(event) => patch({ leadTimeMin: event.target.value })}
              />
            </Field>
            <Checkbox
              id="listing-requiresJourney"
              label="Getting there is part of the experience"
              checked={draft.requiresJourney}
              onChange={(event) => patch({ requiresJourney: event.target.checked })}
            />
          </fieldset>

          <details>
            <summary style={{ fontSize: "0.8125rem", color: "var(--ink-muted)", cursor: "pointer" }}>
              Seed a rating (only if reviews already exist)
            </summary>
            <div style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))", marginTop: "0.5rem" }}>
              <Field id="listing-ratingValue" label="Rating 0 to 5" error={errorFor("ratingValue")}>
                <TextInput
                  id="listing-ratingValue"
                  inputMode="decimal"
                  value={draft.ratingValue}
                  onChange={(event) => patch({ ratingValue: event.target.value })}
                />
              </Field>
              <Field id="listing-ratingCount" label="Reviews behind it" error={errorFor("ratingCount")}>
                <TextInput
                  id="listing-ratingCount"
                  inputMode="numeric"
                  value={draft.ratingCount}
                  onChange={(event) => patch({ ratingCount: event.target.value })}
                />
              </Field>
            </div>
          </details>

          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <Button variant="primary" onClick={submit} busy={saving}>
              {id ? "Save changes" : "Publish listing"}
            </Button>
            <span style={{ fontSize: "0.75rem", color: "var(--ink-faint)" }}>
              {saving ? "Saving" : "Nothing is published until this succeeds."}
            </span>
          </div>
        </div>
      </Card>

      {showPreview &&
        (existing ? (
          <Preview experience={previewOf(draft, api, existing)} />
        ) : (
          <EmptyState
            title="Nothing to preview yet"
            body="Publish a listing once and every later change can be previewed before it goes live."
          />
        ))}
    </div>
  );
}

/**
 * The preview is the real contract object, not a parallel shape: build it
 * through `buildExperience`, and fall back to the saved row while a required
 * field is still blank, because `Experience` cannot hold an invalid row.
 */
function previewOf(draft: ListingDraft, api: ProviderApi, fallback: Experience): Experience {
  try {
    return buildExperience(draft, {
      id: fallback.id,
      providerId: api.provider().id,
      today: api.today(),
      existing: fallback,
    });
  } catch {
    return fallback;
  }
}

