# content/eval — pointer only

The eval scenarios are **not** in this directory. They are one directory up:

```
content/evaluation/scenarios.jsonl
```

`docs/EVAL_SPEC.md` §3 specifies `content/eval/scenarios.jsonl`. The session
ownership map allowed `content/evaluation/`, so that is where they were written
and this file exists so a lookup in the old place finds an explanation instead of
a missing directory.

**Action for Abhijit:** repoint the scenario path in `scripts/eval.ts`. The line
shape is unchanged from EVAL_SPEC §3, plus two optional additions:

- `notes` — free text explaining what the scenario is really testing and which
  part of it is expected to be weak.
- `replan.expectKeptIntentTerms` — terms that must survive a replan, which is
  what makes `preservedIntent: true` mean something rather than just being a
  boolean the replanner sets to itself.

Run the content check with `npx tsx content/tools/validate-content.ts` from the
repo root; it validates the scenarios, including that every `forbiddenBecause`
code is a real `RejectionCode` and that `context.original` agrees with
`context`.
