/**
 * The catalogue schema.
 *
 * Design decision — nested contract objects vs. flat indexed columns:
 *
 * The `Experience` contract in src/contracts is nested (`location`, `hours`,
 * `accessibility`, `rating`, `perception`, `booking`, `provenance`). Storing it
 * as one JSON blob would be the lazy answer and it is the wrong one, because
 * almost every engine query is a filter or a sort:
 *
 *   - `durationMin` is filtered against a time budget       -> needs an index
 *   - `pricePerPerson` is summed against a budget            -> needs to be numeric
 *   - `location.lat/lon` is a bounding-box prefilter         -> needs both columns
 *   - `category` is a facet count                            -> needs an index
 *
 * So: everything the engine FILTERS or SORTS ON is a real scalar column.
 * Everything it only DISPLAYS or hands to the LLM stays as JSON. That split is
 * the whole reason this file is longer than `Experience`.
 *
 * The tri-state trap: `accessibility.*` and `pricePerPerson` are
 * `boolean | null` and `Money | null`. NULL means UNKNOWN and must never
 * collapse to false or 0. `price_minor = 0` means genuinely FREE. Getting this
 * wrong would make the engine confidently recommend a free wheelchair-accessible
 * beach because nobody filled the field in.
 */

import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { Category, Provenance } from "../contracts";

/**
 * The single catalogue table. One row per experience, all attributes, so the
 * engine can reason about price and category *inside* a query instead of
 * joining three lists (the TripWeaver anti-pattern we rejected).
 */
export const experience = sqliteTable(
  "experience",
  {
    /** Slug or `osm:<kind>/<id>`. Stable across re-seeds — see src/lib/id.ts. */
    id: text("id").primaryKey(),

    name: text("name").notNull(),
    category: text("category").$type<Category>().notNull(),
    city: text("city").notNull().default("Mumbai"),
    neighbourhood: text("neighbourhood"),

    // --- geo: two columns, not a JSON point, because Session 2 prefilters on it
    lat: real("lat").notNull(),
    lon: real("lon").notNull(),

    /**
     * Typical minutes on site. THE most important field OSM does not have
     * (1% coverage), which is precisely why 250 curated rows beat 400 scraped
     * ones. Not nullable: a row with no duration cannot be packed.
     */
    durationMin: integer("duration_min").notNull(),

    /**
     * Paise. NULL = price not listed, which is a DIFFERENT state from 0 = free.
     * Do not coalesce this to 0 anywhere.
     */
    priceMinor: integer("price_minor"),
    priceCurrency: text("price_currency"),

    /** NULL = unlimited. */
    capacity: integer("capacity"),

    indoorOutdoor: text("indoor_outdoor").$type<"indoor" | "outdoor" | "covered" | "mixed">().notNull(),

    kidFriendly: integer("kid_friendly", { mode: "boolean" }),
    minAge: integer("min_age"),

    // --- opening hours: raw string kept for provenance, plus the normalised
    // expansion in experience_open_interval for SQL-speed gate checks.
    hoursRaw: text("hours_raw"),
    hoursStatus: text("hours_status")
      .$type<"ok" | "partial" | "unparsable" | "absent">()
      .notNull()
      .default("absent"),
    hoursLastVerified: text("hours_last_verified"),

    // --- rating: value is ALREADY Bayesian-smoothed. raw_mean and rating_count
    // are kept alongside so the UI can show "4.6 (312)" and so we can see the
    // shrinkage rather than hiding it.
    ratingValue: real("rating_value").notNull(),
    ratingCount: integer("rating_count").notNull().default(0),
    ratingRawMean: real("rating_raw_mean"),

    // --- accessibility. All six are tri-state. NULL is meaningful.
    accStepFree: integer("acc_step_free", { mode: "boolean" }),
    accStrollerOk: integer("acc_stroller_ok", { mode: "boolean" }),
    accLowStairs: integer("acc_low_stairs", { mode: "boolean" }),
    accHearingLoop: integer("acc_hearing_loop", { mode: "boolean" }),
    accSeatingAvailable: integer("acc_seating_available", { mode: "boolean" }),
    accRestroomOnSite: integer("acc_restroom_on_site", { mode: "boolean" }),

    requiresJourney: integer("requires_journey", { mode: "boolean" }).notNull().default(false),
    weatherSensitive: text("weather_sensitive")
      .$type<"none" | "rain" | "heat" | "wind" | "any">()
      .notNull()
      .default("none"),

    // --- display + LLM input. JSON because we display it, we don't filter on it.
    blurb: text("blurb"),
    description: text("description"),

    /** Comma-joined. SQLite has no array type; parsed in seed.ts. */
    diets: text("diets", { mode: "json" }).$type<string[]>().notNull().default([]),
    cuisines: text("cuisines", { mode: "json" }).$type<string[]>().notNull().default([]),
    keywords: text("keywords", { mode: "json" }).$type<string[]>().notNull().default([]),
    bestMonths: text("best_months", { mode: "json" }).$type<number[]>().notNull().default([]),
    bestTimeOfDay: text("best_time_of_day", { mode: "json" })
      .$type<("early_morning" | "morning" | "afternoon" | "evening" | "night")[]>()
      .notNull()
      .default([]),

    perception: text("perception", { mode: "json" })
      .$type<{ landscape: string[]; activities: string[]; atmosphere: string[] }>()
      .notNull()
      .default({ landscape: [], activities: [], atmosphere: [] }),

    booking: text("booking", { mode: "json" })
      .$type<{ required: boolean; leadTimeMin: number; walkIn: boolean }>()
      .notNull()
      .default({ required: false, leadTimeMin: 0, walkIn: true }),

    /**
     * Per-field provenance, matching the contract. Kept as JSON because it is
     * read as a whole (to render badges) and never filtered on. Session 6 uses
     * it to answer "how much of this row is a guess?".
     */
    provenance: text("provenance", { mode: "json" })
      .$type<Record<string, Provenance>>()
      .notNull()
      .default({}),

    providerId: text("provider_id"),

    /** ISO-8601, set by seed.ts. */
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    // Session 2's retrieve() is a bbox prefilter + category facet + FTS5.
    // This composite covers the common "in this box, in this category" case.
    index("idx_experience_geo_category").on(t.lat, t.lon, t.category),
    index("idx_experience_neighbourhood").on(t.city, t.neighbourhood),
    // Session 3's gate sorts survivors by score, which starts from duration and
    // price. Cheap single-column indexes that let SQLite skip rather than sort.
    index("idx_experience_duration").on(t.durationMin),
    index("idx_experience_price").on(t.priceMinor),
    index("idx_experience_category").on(t.category),
  ],
);

/**
 * Normalised opening hours: one row per (weekday, interval).
 *
 * Why not parse the raw string at query time: the feasibility gate asks "is this
 * open for the whole visit window" for every candidate on every replan. Doing
 * that with the LGPL npm port inside a loop is fine at 250 rows and is the wrong
 * shape for anything larger. Expanding once at seed time turns the gate into a
 * single indexed range query.
 *
 * Intervals that wrap midnight (a 22:00-02:00 night market) are stored as TWO
 * rows: 22:00->1440 and 0->120. That keeps every row a simple start<end range,
 * so the SQL needs no wrap logic and cannot get it wrong.
 */
export const experienceOpenInterval = sqliteTable(
  "experience_open_interval",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    experienceId: text("experience_id")
      .notNull()
      .references(() => experience.id, { onDelete: "cascade" }),
    /** 0 = Monday .. 6 = Sunday. Matches OSM's Mo..Su. */
    weekday: integer("weekday").notNull(),
    startMin: integer("start_min").notNull(),
    endMin: integer("end_min").notNull(),
  },
  (t) => [
    index("idx_open_interval_lookup").on(t.experienceId, t.weekday),
    uniqueIndex("uq_open_interval").on(t.experienceId, t.weekday, t.startMin, t.endMin),
  ],
);

/**
 * Embedding storage. Created now so migrations don't churn in Session 5, but
 * nothing writes to it until the Embedder interface lands behind O3.
 * `dim` is 384 because that is what the chosen encoder emits.
 */
export const experienceEmbedding = sqliteTable(
  "experience_embedding",
  {
    experienceId: text("experience_id")
      .primaryKey()
      .references(() => experience.id, { onDelete: "cascade" }),
    dim: integer("dim").notNull(),
    /** Float32 little-endian blob. Faster than a JSON array of 384 numbers. */
    // Float32 little-endian blob. Drizzle's sqlite `text()` has no "buffer"
    // mode, so the column is declared as a blob via raw sql below.
    vector: text("vector").notNull(),
    model: text("model").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_embedding_model").on(t.model)],
);

/**
 * Harvest provenance. Records which Overpass query produced which row, so a
 * bad harvest can be re-run for one area instead of the whole city.
 */
export const harvestRun = sqliteTable(
  "harvest_run",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    city: text("city").notNull(),
    bbox: text("bbox").notNull(),
    queryHash: text("query_hash").notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    status: text("status").$type<"ok" | "partial" | "failed">().notNull(),
    mirrorUsed: text("mirror_used"),
    elementCount: integer("element_count").notNull().default(0),
    note: text("note"),
  },
  (t) => [uniqueIndex("uq_harvest_query").on(t.queryHash)],
);

/**
 * The search index. FTS5 virtual table, maintained by TRIGGERs in
 * migrations.ts so it can never drift from the base table.
 *
 * Column weights are deliberate: a match in `name` is a much stronger signal
 * than a match in `keywords`, so bm25() is given name the highest weight.
 * Without this, "shore dive" ranks a row whose description happens to mention
 * swimming above the row actually called Shore Dive.
 */
export const experienceFts = sql`
  CREATE VIRTUAL TABLE IF NOT EXISTS experience_fts USING fts5(
    name,
    neighbourhood,
    blurb,
    description,
    keywords,
    cuisines,
    category UNINDEXED,
    experience_id UNINDEXED,
    tokenize = 'porter unicode61'
  )
`;

export const experienceFtsTriggers = [
  sql`
  CREATE TRIGGER IF NOT EXISTS experience_fts_ai AFTER INSERT ON experience BEGIN
    INSERT INTO experience_fts(rowid, name, neighbourhood, blurb, description, keywords, cuisines, category, experience_id)
    VALUES (new.rowid, new.name, new.neighbourhood, new.blurb, new.description, new.keywords, new.cuisines, new.category, new.id);
  END
  `,
  sql`
  CREATE TRIGGER IF NOT EXISTS experience_fts_ad AFTER DELETE ON experience BEGIN
    DELETE FROM experience_fts WHERE rowid = old.rowid;
  END
  `,
  sql`
  CREATE TRIGGER IF NOT EXISTS experience_fts_au AFTER UPDATE ON experience BEGIN
    DELETE FROM experience_fts WHERE rowid = old.rowid;
    INSERT INTO experience_fts(rowid, name, neighbourhood, blurb, description, keywords, cuisines, category, experience_id)
    VALUES (new.rowid, new.name, new.neighbourhood, new.blurb, new.description, new.keywords, new.cuisines, new.category, new.id);
  END
  `,
];

/**
 * The AI assistant's conversations and messages.
 *
 * Separate tables from `experience` on purpose: the catalogue is shared reference
 * data that every engine reads, and chat transcripts are per-owner private state
 * that only the assistant feature touches. One table would force a nullable
 * `owner_id` onto 250 catalogue rows and a nullable `duration_min` onto every
 * message.
 *
 * `ownerId` is the SHA-256 of the session cookie, not the cookie. See migration 5
 * in migrations.ts for why that distinction is load-bearing.
 */
export const assistantConversation = sqliteTable(
  "assistant_conversation",
  {
    id: text("id").primaryKey(),
    /** SHA-256 hex of the owner secret. Indexed with updatedAt: that is the sidebar query. */
    ownerId: text("owner_id").notNull(),
    /** Derived from the first user message. Empty string until then, never NULL. */
    title: text("title").notNull().default(""),
    createdAt: text("created_at").notNull(),
    /** Bumped on every message write, so the sidebar sorts without a join. */
    updatedAt: text("updated_at").notNull(),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
  },
  (t) => [index("idx_assistant_conv_owner").on(t.ownerId, t.updatedAt)],
);

export const assistantMessage = sqliteTable(
  "assistant_message",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => assistantConversation.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant" | "system">().notNull(),
    content: text("content").notNull().default(""),
    /**
     * Why a message can be incomplete. `streaming` is written by the route before
     * the first token and rewritten to `complete`/`stopped`/`error` in a finally,
     * so a crashed request leaves a `streaming` row rather than a truncated
     * answer that reads as finished.
     */
    status: text("status").$type<"complete" | "streaming" | "stopped" | "error">()
      .notNull()
      .default("complete"),
    createdAt: text("created_at").notNull(),
    /** The model that produced it. Provenance for a prediction, per src/llm/nugen.ts. */
    modelId: text("model_id"),
    /** Provider-reported counts. NULL means the provider did not report them. */
    tokenUsage: text("token_usage", { mode: "json" }).$type<Record<string, number> | null>(),
    latencyMs: integer("latency_ms"),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
  },
  (t) => [index("idx_assistant_msg_conversation").on(t.conversationId, t.createdAt)],
);

/** Convenience alias so callers write `Schema.experience`, matching Drizzle docs. */
export const Schema = {
  experience,
  experienceOpenInterval,
  experienceEmbedding,
  harvestRun,
  assistantConversation,
  assistantMessage,
};

export type ExperienceRow = typeof experience.$inferSelect;
export type NewExperienceRow = typeof experience.$inferInsert;
export type OpenIntervalRow = typeof experienceOpenInterval.$inferSelect;
export type AssistantConversationRow = typeof assistantConversation.$inferSelect;
export type AssistantMessageRow = typeof assistantMessage.$inferSelect;
