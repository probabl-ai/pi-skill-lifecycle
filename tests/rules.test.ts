/**
 * Tests for configuration, roles, and eviction decisions (rules.ts).
 */

import { describe, it, expect } from "vitest";
import { buildSkillIndex } from "../extensions/relevance.ts";
import {
  buildPlaceholder,
  configWithDefaults,
  DEFAULT_CONFIG,
  extractSkillNameFromContent,
  fingerprintPrompt,
  isMinorChange,
  resolveRoles,
  ruleScore,
  selectBodiesSupersededBy,
  selectBodiesToEvict,
} from "../extensions/rules.ts";
import { PACK } from "./fixtures.ts";

const index = buildSkillIndex(PACK);
const descriptions = new Map(PACK.map((s) => [s.name, s.description]));
const names = (out: Array<{ name: string }>) => out.map((e) => e.name).sort();
const loadedInOrder = (...skillNames: string[]) => skillNames.map((name, i) => ({ name, seq: i + 1 }));

// ── configWithDefaults ────────────────────────────────────────────

describe("configWithDefaults", () => {
  it("fills every field from DEFAULT_CONFIG", () => {
    expect(configWithDefaults({})).toEqual(DEFAULT_CONFIG);
    expect(configWithDefaults()).toEqual(DEFAULT_CONFIG);
  });

  it("needs no keyword rules, helpers, or entry skill by default", () => {
    expect(DEFAULT_CONFIG.rules).toEqual([]);
    expect(DEFAULT_CONFIG.helperSkills).toEqual([]);
    expect(DEFAULT_CONFIG.entrySkill).toBe("");
    expect(DEFAULT_CONFIG.inferEntrySkill).toBe(true);
  });

  it("keeps explicit values, including false, 0, and empty strings", () => {
    const cfg = configWithDefaults({ blockDirectSkillReads: false, minKeep: 0, topK: 5, entrySkill: "x" });
    expect(cfg.blockDirectSkillReads).toBe(false);
    expect(cfg.minKeep).toBe(0);
    expect(cfg.topK).toBe(5);
    expect(cfg.entrySkill).toBe("x");
  });

  it("falls back to defaults for null and undefined, and drops unknown keys", () => {
    const cfg = configWithDefaults({ topK: null, minKeep: undefined, bogus: 1 } as any);
    expect(cfg.topK).toBe(DEFAULT_CONFIG.topK);
    expect(cfg.minKeep).toBe(DEFAULT_CONFIG.minKeep);
    expect("bogus" in cfg).toBe(false);
  });
});

// ── resolveRoles ──────────────────────────────────────────────────

describe("resolveRoles", () => {
  it("uses the inferred entry skill without config", () => {
    expect(resolveRoles(index, configWithDefaults()).entry).toEqual({ name: "triage-ml-task", source: "inferred" });
  });

  it("lets the config entry override frontmatter and inference", () => {
    const declared = buildSkillIndex(PACK.map((s) => (s.name === "explore-ml-data" ? { ...s, metadata: { role: "entry" } } : s)));
    expect(resolveRoles(declared, configWithDefaults({ entrySkill: "setup-ml-project" })).entry).toEqual({
      name: "setup-ml-project",
      source: "config",
    });
    expect(resolveRoles(declared, configWithDefaults()).entry).toEqual({ name: "explore-ml-data", source: "frontmatter" });
  });

  it("can turn inference off, but keeps a frontmatter entry", () => {
    const off = configWithDefaults({ inferEntrySkill: false });
    expect(resolveRoles(index, off).entry).toBeUndefined();
    const declared = buildSkillIndex(PACK.map((s) => (s.name === "explore-ml-data" ? { ...s, metadata: { role: "entry" } } : s)));
    expect(resolveRoles(declared, off).entry?.name).toBe("explore-ml-data");
  });

  it("has no entry when the configured one is not installed", () => {
    expect(resolveRoles(index, configWithDefaults({ entrySkill: "nope" })).entry).toBeUndefined();
  });

  it("merges helpers from the frontmatter and the config, installed only", () => {
    const declared = buildSkillIndex(PACK.map((s) => (s.name === "persist-ml-git" ? { ...s, metadata: { role: "helper" } } : s)));
    const roles = resolveRoles(declared, configWithDefaults({ helperSkills: ["plot-ml-figure", "nope"] }));
    expect([...roles.helpers]).toEqual([
      ["persist-ml-git", "frontmatter"],
      ["plot-ml-figure", "config"],
    ]);
  });

  it("never treats the entry skill as a helper", () => {
    const roles = resolveRoles(index, configWithDefaults({ helperSkills: ["triage-ml-task"] }));
    expect(roles.helpers.has("triage-ml-task")).toBe(false);
  });

  it("keeps configured names before the skills are known", () => {
    const roles = resolveRoles(buildSkillIndex([]), configWithDefaults({ entrySkill: "triage-ml-task", helperSkills: ["x"] }));
    expect(roles.entry?.name).toBe("triage-ml-task");
    expect(roles.helpers.has("x")).toBe(true);
  });
});

// ── ruleScore ─────────────────────────────────────────────────────

describe("ruleScore", () => {
  const rules = [{ skillName: "explore-ml-data", keywords: ["eda", "profile", "data analysis"] }];

  it("is the fraction of matched keywords, as substrings, case-insensitive", () => {
    expect(ruleScore("Run the EDA and the data analysis", "explore-ml-data", rules).score).toBeCloseTo(2 / 3);
    expect(ruleScore("eda", "explore-ml-data", rules).reason).toBe("rule matched 1/3 keywords");
  });

  it("applies the weight, capped at 1", () => {
    expect(ruleScore("eda", "explore-ml-data", [{ ...rules[0], weight: 2 }]).score).toBeCloseTo(2 / 3);
    expect(ruleScore("eda profile", "explore-ml-data", [{ ...rules[0], weight: 10 }]).score).toBe(1);
  });

  it("is 0 for other skills, no match, or empty keyword lists", () => {
    expect(ruleScore("eda", "build-ml-pipeline", rules).score).toBe(0);
    expect(ruleScore("nothing", "explore-ml-data", rules).score).toBe(0);
    expect(ruleScore("eda", "x", [{ skillName: "x", keywords: [] }]).score).toBe(0);
  });
});

// ── isMinorChange ─────────────────────────────────────────────────

describe("isMinorChange", () => {
  const cfg = configWithDefaults({});
  const prev = fingerprintPrompt("build a random forest classifier with sklearn");

  it("scores the first prompt", () => {
    expect(isMinorChange("build a classifier", undefined, cfg)).toBe(false);
    expect(isMinorChange("build a classifier", new Set(), cfg)).toBe(false);
  });

  it("skips short follow-ups, unless disabled", () => {
    for (const p of ["yes", "ok", "run it", "continue", "go ahead"]) expect(isMinorChange(p, prev, cfg)).toBe(true);
    expect(isMinorChange("use pixi", prev, configWithDefaults({ skipOnShortPrompts: false }))).toBe(false);
  });

  it("respects minScorablePromptLength", () => {
    const short = configWithDefaults({ minScorablePromptLength: 5 });
    expect(isMinorChange("hello", prev, short)).toBe(false);
    expect(isMinorChange("hi", prev, short)).toBe(true);
  });

  it("skips prompts on the same topic and scores topic changes", () => {
    expect(isMinorChange("random forest classifier sklearn", prev, cfg)).toBe(true);
    expect(isMinorChange("explore the data distributions and outliers", prev, cfg)).toBe(false);
  });

  it("uses topicChangeThreshold", () => {
    // "build an xgboost model": 1 of 3 words overlaps.
    expect(isMinorChange("build an xgboost model", prev, configWithDefaults({ topicChangeThreshold: 0.4 }))).toBe(false);
    expect(isMinorChange("build an xgboost model", prev, configWithDefaults({ topicChangeThreshold: 0.2 }))).toBe(true);
  });

  it("skips prompts without meaningful words", () => {
    expect(isMinorChange("", prev, cfg)).toBe(true);
    expect(isMinorChange("a", prev, cfg)).toBe(true);
  });
});

// ── Skill body helpers ────────────────────────────────────────────

describe("extractSkillNameFromContent", () => {
  it("finds the <skill_content> wrapper in any text block", () => {
    expect(extractSkillNameFromContent([{ type: "text", text: '<skill_content name="build-ml-pipeline">\n#' }])).toBe("build-ml-pipeline");
    expect(
      extractSkillNameFromContent([
        { type: "image" } as any,
        { type: "text", text: "preamble" },
        { type: "text", text: '<skill_content name="explore-ml-data">' },
      ]),
    ).toBe("explore-ml-data");
  });

  it("returns null without a wrapper", () => {
    expect(extractSkillNameFromContent([])).toBeNull();
    expect(extractSkillNameFromContent([{ type: "text", text: "plain output" }])).toBeNull();
  });
});

describe("buildPlaceholder", () => {
  it("keeps the wrapper and tells the model how to reload", () => {
    const text = buildPlaceholder("build-ml-pipeline");
    expect(text).toMatch(/^<skill_content name="build-ml-pipeline">/);
    expect(text).toMatch(/<\/skill_content>$/);
    expect(text).toContain("archived to save context");
    expect(text).toContain('skill("build-ml-pipeline")');
    // Mid-run archives happen without a topic change; do not claim one.
    expect(text).not.toContain("topic");
  });
});

// ── selectBodiesToEvict ───────────────────────────────────────────

describe("selectBodiesToEvict", () => {
  const loaded = loadedInOrder("explore-ml-data", "setup-ml-project", "build-ml-pipeline");

  it("evicts bodies whose skills are not relevant to the prompt", () => {
    const out = selectBodiesToEvict("evaluate the pipeline with cross-validation", loaded, index, new Set(), configWithDefaults({ minKeep: 0 }));
    // build-ml-pipeline shares "pipeline" with the best match and stays.
    expect(names(out)).toEqual(["explore-ml-data", "setup-ml-project"]);
    expect(out[0].reason).toMatch(/no match|rank/);
  });

  it("protects the minKeep most recent bodies", () => {
    const out = selectBodiesToEvict("draw a chart with matplotlib", loaded, index, new Set(), configWithDefaults({ minKeep: 2 }));
    expect(names(out)).toEqual(["explore-ml-data"]);
  });

  it("keeps an old body that is still relevant", () => {
    const out = selectBodiesToEvict("explore the data again", loaded, index, new Set(), configWithDefaults({ minKeep: 1 }));
    expect(names(out)).not.toContain("explore-ml-data");
    expect(names(out)).toContain("setup-ml-project");
  });

  it("never evicts pinned bodies", () => {
    const out = selectBodiesToEvict("draw a chart with matplotlib", loaded, index, new Set(["explore-ml-data"]), configWithDefaults({ minKeep: 0 }));
    expect(names(out)).toEqual(["build-ml-pipeline", "setup-ml-project"]);
  });

  it("evicts nothing for relevance when the prompt carries no topic signal", () => {
    const out = selectBodiesToEvict("please fix it", loaded, index, new Set(), configWithDefaults({ minKeep: 0 }));
    expect(out).toEqual([]);
  });

  it("lets a keyword rule keep a body the index would evict", () => {
    const config = configWithDefaults({ minKeep: 0, rules: [{ skillName: "setup-ml-project", keywords: ["matplotlib"] }] });
    const out = selectBodiesToEvict("draw a chart with matplotlib", loaded, index, new Set(), config);
    expect(names(out)).toEqual(["build-ml-pipeline", "explore-ml-data"]);
  });

  it("evicts bodies of skills that are no longer installed", () => {
    const out = selectBodiesToEvict("please fix it", [{ name: "gone", seq: 0 }, ...loaded], index, new Set(), configWithDefaults({ minKeep: 3 }));
    expect(out).toEqual([{ name: "gone", reason: "skill no longer installed" }]);
  });

  it("caps the total with maxKeep by evicting the oldest unprotected survivors", () => {
    const out = selectBodiesToEvict("please fix it", loaded, index, new Set(), configWithDefaults({ minKeep: 1, maxKeep: 2 }));
    expect(out).toEqual([{ name: "explore-ml-data", reason: "over maxKeep (2)" }]);
  });

  it("returns nothing when nothing is loaded", () => {
    expect(selectBodiesToEvict("explore", [], index, new Set(), configWithDefaults())).toEqual([]);
  });
});

// ── selectBodiesSupersededBy ──────────────────────────────────────

describe("selectBodiesSupersededBy", () => {
  const supersede = (fresh: string[], loaded: Array<{ name: string; seq: number }>, opts: object = {}, pins: string[] = [], helpers: string[] = []) =>
    selectBodiesSupersededBy(fresh, loaded, index, new Set(pins), new Set(helpers), configWithDefaults(opts), descriptions);

  it("evicts bodies unrelated to the new skill, ignoring minKeep", () => {
    const out = supersede(["persist-ml-git"], loadedInOrder("explore-ml-data", "persist-ml-git"), { minKeep: 5 });
    expect(names(out)).toEqual(["explore-ml-data"]);
    expect(out[0].reason).toContain("superseded by persist-ml-git");
  });

  it("keeps bodies related to the new skill", () => {
    // Build and evaluate share "ml pipeline" and "data".
    expect(supersede(["evaluate-ml-pipeline"], loadedInOrder("build-ml-pipeline", "evaluate-ml-pipeline"))).toEqual([]);
  });

  it("never abstains: with no shared terms everything unprotected goes", () => {
    const out = supersede(["persist-ml-git"], loadedInOrder("plot-ml-figure", "explore-ml-data", "persist-ml-git"));
    expect(names(out)).toEqual(["explore-ml-data", "plot-ml-figure"]);
  });

  it("never evicts the new skills or pinned bodies", () => {
    const loaded = loadedInOrder("explore-ml-data", "setup-ml-project", "persist-ml-git");
    expect(supersede(["setup-ml-project", "persist-ml-git"], loaded, {}, ["explore-ml-data"])).toEqual([]);
  });

  it("evicts nothing when every new skill is a helper", () => {
    expect(supersede(["persist-ml-git"], loadedInOrder("explore-ml-data", "persist-ml-git"), {}, [], ["persist-ml-git"])).toEqual([]);
  });

  it("judges against the non-helper skills only when helpers load with an owner", () => {
    // plot-ml-figure is a helper; persist-ml-git decides and evicts explore.
    const out = supersede(["persist-ml-git", "plot-ml-figure"], loadedInOrder("explore-ml-data", "persist-ml-git", "plot-ml-figure"), {}, [], ["plot-ml-figure"]);
    expect(names(out)).toEqual(["explore-ml-data"]);
    expect(out[0].reason).toContain("superseded by persist-ml-git (");
  });

  it("with protectCallers, keeps bodies whose skill mentions the new skill", () => {
    const loaded = loadedInOrder("explore-ml-data", "build-ml-pipeline", "persist-ml-git");
    // explore-ml-data mentions persist-ml-git; build-ml-pipeline does not.
    expect(names(supersede(["persist-ml-git"], loaded, { protectCallers: true }))).toEqual(["build-ml-pipeline"]);
    expect(names(supersede(["persist-ml-git"], loaded))).toEqual(["build-ml-pipeline", "explore-ml-data"]);
  });

  it("with protectLoader, keeps the body loaded just before the new skill", () => {
    const loaded = loadedInOrder("explore-ml-data", "persist-ml-git");
    // explore-ml-data is not relevant to persist-ml-git; only the loader rule keeps it.
    expect(names(supersede(["persist-ml-git"], loaded, { protectLoader: true }))).toEqual([]);
    expect(names(supersede(["persist-ml-git"], loaded))).toEqual(["explore-ml-data"]);
  });

  it("protectLoader keeps only the immediate predecessor", () => {
    const loaded = loadedInOrder("plot-ml-figure", "explore-ml-data", "persist-ml-git");
    expect(names(supersede(["persist-ml-git"], loaded, { protectLoader: true }))).toEqual(["plot-ml-figure"]);
  });

  it("labels an evicted body that dispatched to the new skill", () => {
    const out = supersede(["persist-ml-git"], loadedInOrder("explore-ml-data", "persist-ml-git"));
    expect(out[0].reason).toContain("this body calls persist-ml-git");
    expect(out[0].reason).toContain("metadata.role: helper");
  });

  it("does not label an unrelated evicted body", () => {
    // build-ml-pipeline does not mention persist-ml-git.
    const out = supersede(["persist-ml-git"], loadedInOrder("build-ml-pipeline", "persist-ml-git"));
    expect(out[0].reason).not.toContain("metadata.role: helper");
  });

  it("returns nothing without a new skill", () => {
    expect(supersede([], loadedInOrder("explore-ml-data"))).toEqual([]);
  });
});

// ── Prohibitions are not calls ────────────────────────────────────

describe("selectBodiesSupersededBy with a prohibition", () => {
  // explore-ml-data now forbids persist-ml-git instead of calling it.
  const forbidding = buildSkillIndex(
    PACK.map((s) => (s.name === "explore-ml-data" ? { ...s, body: "# Explore ML Data\n\nDo not load `persist-ml-git` here." } : s)),
  );
  const supersede = (opts: object = {}) =>
    selectBodiesSupersededBy(
      ["persist-ml-git"],
      loadedInOrder("explore-ml-data", "persist-ml-git"),
      forbidding,
      new Set(),
      new Set(),
      configWithDefaults(opts),
      descriptions,
    );

  it("does not label the body as a dispatcher", () => {
    const out = supersede();
    expect(names(out)).toEqual(["explore-ml-data"]);
    expect(out[0].reason).not.toContain("metadata.role: helper");
  });

  it("is not protected by protectCallers", () => {
    expect(names(supersede({ protectCallers: true }))).toEqual(["explore-ml-data"]);
  });
});
