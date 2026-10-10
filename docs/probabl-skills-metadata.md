# Skill metadata: status

**Audience:** `probabl-ai/skills` maintainers.
**Status:** complete in the working tree, uncommitted.

## Done

- **`metadata.modelTier`** on all 28 skills (2 `big`, 12 `medium`, 14 `small`);
  `tests/eval/tiers.py` reads the frontmatter (no `SKILL_TIER` table), and
  `tools/validate_catalog.py` rejects a missing or invalid value.
- **`metadata.role`** on 13 skills: `triage-ml-task: entry` plus 12 helpers —
  `add-python-package`, `plot-ml-figure`, `choose-python-library`,
  `shape-user-idea`, `research-ml-practice`, `setup-workspace`,
  `setup-python-env`, `setup-git`, `build-ml-pipeline`, `smoke-test-ml-pipeline`,
  `evaluate-ml-pipeline`, `audit-ml-pipeline`. `tools/validate_catalog.py`
  enforces `entry`/`helper` and at most one `entry`.
- **Handoffs stay undeclared on purpose**: `persist-ml-git` → `triage-ml-task`,
  `export-*` / `sync-ml-reports` at end of work, `frame-ml-problem`. Freeing the
  caller's context there is the point.
- `pixi run hash` refreshed; `hash_skills.py --check` and
  `validate_catalog.py` are green.
- `README.md` and `eval/README.md` mention the metadata and no longer list tier
  memberships by hand.

Nothing is left but committing.

## Why these fields

`metadata.role: helper` means "loading me must not archive the caller's
instructions". In the measured pack, **52% of mid-run evictions archived a body
that itself names the skill causing the eviction** — the coordinator's checklist
dropped at the step it dispatched to. Declaring the sub-step edges removes those
evictions; that was the reported failure.

## The measured trade, with the caveat

20 recorded sessions of this pack, 3784 requests, the Pi `replay` harness with
its orphan metric corrected to the skill's own directory (it used to match any
path containing `/<name>/`, which counted pack-authoring references):

| Pack | Cost | Peak ctx | Reloads | Orphans |
|---|---|---|---|---|
| no roles | 81.9% | 66.7% | 88 | 0 |
| roles declared (today) | 87.4% | 69.8% | 56 | 1 |
| never archive | 100.0% | 100.0% | 0 | 0 |

Roles cut reloads by 36% for +5.5pp of context. **The corpus cannot show the
harm they prevent**: it is recorded while this pack was being authored and tested
in scratch workspaces, so almost no tool call touches a workspace *install* of a
skill (orphans ≈ 0 in both configurations). The mechanism statistic above is
unaffected; only the harm metric is blind here.

To actually validate the role declarations, record one end-user ML session with
the pack installed at `<workspace>/.agents/skills`, then:

```bash
cd ../pi-extension/pi-skill-lifecycle
npm run replay -- --skills <pack>/skills --orphan-dir <workspace>/.agents/skills <session.jsonl>
```

Compare a pack copy with the `role:` lines stripped against the real one; the
reload count is the signal, and an orphan use is the failure.
