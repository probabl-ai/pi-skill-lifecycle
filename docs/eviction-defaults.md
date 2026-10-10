# Eviction defaults: implemented

**Status:** implemented in the working tree; 189 unit/extension tests and 12
real-Pi e2e tests pass, typecheck clean.

## What was implemented

| Change | Where | Notes |
|---|---|---|
| `enabled` config key | `rules.ts` (`EngineConfig`, `DEFAULT_CONFIG`), `index.ts` (`reloadConfig`) | the persisted counterpart of `/skills-off`, re-applied on `/skills-reload` |
| Archive decisions recorded on the session | `index.ts` `evict()` | `pi.appendEntry("skill-lifecycle", { event: "archived", archived })`; headless runs (`-p`, JSON, replay) can explain a loss. Custom entries are not sent to the model |
| Dispatcher hint in the reason | `rules.ts` `selectBodiesSupersededBy` | an evicted body that tells the model to load the new skill ("Do not load" prohibitions excluded) is labelled `this body calls X — declare metadata.role: helper to keep it`; the hint reaches the notification and the session entry |
| `protectLoader` knob | `rules.ts`, `DEFAULT_CONFIG: false` | keeps the body loaded immediately before the new one. Opt-in only: see the numbers below |
| Replay orphan metric + `--orphan-dir` | `scripts/replay.ts` | an orphan now requires a tool call touching the skill's own directory (or `<orphan-dir>/<name>/`), instead of any path containing `/<name>/` |

Tests added: `protectLoader` keeps only the immediate predecessor; the dispatcher
hint is present/absent as appropriate; the archiving switch comes from the config
and is re-applied on reload; the session entry is written and carries reasons;
e2e unchanged and green.

## Why no protection default changed

20 recorded sessions of the probabl pack, 3784 requests, replay with the
corrected metric. The pack already declares its roles (13 skills), so `derived`
below includes them.

| Strategy | Cost | Peak ctx | Reloads | Orphans |
|---|---|---|---|---|
| today's defaults | 87.4% | 69.8% | 56 | 1 |
| `protectLoader: true` | 90.0% | 70.3% | 55 | 2 |
| `protectCallers: true` | 93.5% | 71.8% | 46 | 1 |
| `evictOnSkillLoad: false` | 104.5% | 82.2% | 16 | 1 |
| never archive | 100.0% | 100.0% | 0 | 0 |

None of the protection knobs is worth defaulting: +2.6pp to +17pp for a handful
of reloads and no orphan reduction. `evictOnSkillLoad: false` remains a trap
(104.5% — worse than never archiving, because user-prompt evictions still pay a
cache rewrite). This is why the implementation ships observability and the
knobs, and leaves the defaults alone.

## Correction to the earlier measurement

The first pass reported 11 orphan uses for the defaults and claimed roles cut
them to 8. That metric matched `/<name>/` anywhere in a tool call, so it counted
the sessions that were *authoring* this pack (`grep -rn … skills/audit-ml-pipeline/`,
`read …/skills/setup-workspace/references/…`). With the metric corrected, both
the no-roles and the roles pack show ≈0-1 orphans: the harm is not observable in
this corpus at all. The role declarations remain the right fix — the mechanism
(52% of mid-run evictions archiving a dispatcher) is measured and unambiguous —
but their benefit cannot be quantified from skill-authoring sessions.

## Open item

Record one end-user session with the pack installed at
`<workspace>/.agents/skills`, then re-run:

```bash
npm run replay -- --skills <pack>/skills --orphan-dir <workspace>/.agents/skills <session.jsonl>
```

and compare a copy of the pack with the `role:` lines stripped against the real
one. That is the acceptance test for the pack-side fix. No further extension
default should be tuned before it exists.
