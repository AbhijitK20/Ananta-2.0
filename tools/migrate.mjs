/**
 * Creates Better Auth's own tables.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS INSTEAD OF `npx @better-auth/cli migrate`
 * ---------------------------------------------------------------------------
 *
 * The published CLI lags the library. `@better-auth/cli@latest` resolves to
 * 1.4.21 — deprecated, and three minor versions behind the `better-auth` this
 * project installs — while the newest CLI of any tag is a 1.5.0 beta. Running a
 * 1.4 CLI against a 1.7 library generates a schema from the older version's
 * expectations, and the mismatch surfaces much later as a failed sign-in rather
 * than as a migration error.
 *
 * `getMigrations` is the same code the CLI calls, imported from the installed
 * package, so the schema always matches the version actually running.
 *
 * ---------------------------------------------------------------------------
 * WHY IT READS `authOptions` RATHER THAN ITS OWN CONFIG
 * ---------------------------------------------------------------------------
 *
 * See `lib/auth.ts`. One config, one schema.
 *
 * Run: `npm run auth:migrate`        (applies)
 *      `npm run auth:migrate -- --print`   (prints SQL, changes nothing)
 */

import { getMigrations } from "better-auth/db/migration";

import { authOptions } from "../lib/auth.ts";

const printOnly = process.argv.includes("--print");

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is not set.\n\n" +
      "  Copy .env.example to .env.local and fill it in first. The value is\n" +
      "  Supabase → Project Settings → Database → Connection string → URI on\n" +
      "  port 5432, and it is the database password — not the service_role key.",
  );
  process.exit(1);
}

const plan = await getMigrations(authOptions);

if (plan.schemaProblems.length) {
  console.error("Schema problems:\n" + plan.schemaProblems.map((l) => `  - ${l}`).join("\n"));
  process.exit(1);
}

if (plan.unsafeChanges.length) {
  console.warn(
    "Unsafe changes (refused by default):\n" +
      plan.unsafeChanges.map((l) => `  - ${l}`).join("\n"),
  );
}

if (plan.toBeCreated.length === 0 && plan.toBeAdded.length === 0) {
  console.log("Nothing to do — the schema is already up to date.");
  process.exit(0);
}

if (printOnly) {
  console.log(await plan.compileMigrations());
  process.exit(0);
}

console.log(
  `Creating ${plan.toBeCreated.length} table(s), adding ${plan.toBeAdded.length} column(s).`,
);
await plan.runMigrations();
console.log("Done. Now run supabase/schema.sql in the Supabase SQL editor.");
