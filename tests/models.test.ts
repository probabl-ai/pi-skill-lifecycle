/**
 * Tests for model tiers: config normalization and skill → tier resolution
 * (models.ts).
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_MODEL_CONFIG,
  describeModelEvent,
  frontmatterTier,
  modelSettingsFrom,
  normalizeTier,
  resolveSkillModel,
} from "../extensions/models.ts";

const TIERS = {
  tiers: {
    small: { provider: "openrouter", model: "qwen/qwen3.7-flash", thinkingLevel: "low" },
    medium: { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" },
    big: { provider: "openrouter", model: "z-ai/glm-5.3", thinkingLevel: "max", scope: "run" },
  },
} as const;

const settings = (partial?: Parameters<typeof modelSettingsFrom>[0]) => modelSettingsFrom(partial);

// ── Defaults ──────────────────────────────────────────────────────

describe("modelSettingsFrom", () => {
  it("needs no config: no tiers, no default, nothing switches", () => {
    expect(modelSettingsFrom()).toEqual(DEFAULT_MODEL_CONFIG);
    expect(modelSettingsFrom({})).toEqual(DEFAULT_MODEL_CONFIG);
    expect(DEFAULT_MODEL_CONFIG.tiers).toEqual({});
    expect(DEFAULT_MODEL_CONFIG.default).toBeNull();
    expect(DEFAULT_MODEL_CONFIG.enabled).toBe(true);
  });

  it("keeps provider, model, thinking level, and scope of a tier", () => {
    const s = settings({ ...TIERS });
    expect(s.tiers.big).toEqual({
      provider: "openrouter",
      model: "z-ai/glm-5.3",
      thinkingLevel: "max",
      scope: "run",
    });
    expect(s.tiers.medium).toEqual({ provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" });
  });

  it("lowercases tier names so a skill's casing never matters", () => {
    const s = settings({ tiers: { Big: { provider: "openrouter", model: "z-ai/glm-5.3" } } });
    expect(Object.keys(s.tiers)).toEqual(["big"]);
  });

  it("drops tiers that do not name a provider and a model", () => {
    const s = settings({
      tiers: {
        noModel: { provider: "openrouter" } as any,
        noProvider: { model: "z-ai/glm-5.3" } as any,
        blank: { provider: "  ", model: "  " } as any,
        string: "big" as any,
        ok: { provider: "openrouter", model: "z-ai/glm-5.3" },
      },
    });
    expect(Object.keys(s.tiers)).toEqual(["ok"]);
  });

  it("ignores an unknown thinking level or scope instead of failing", () => {
    const s = settings({
      tiers: {
        big: { provider: "openrouter", model: "z-ai/glm-5.3", thinkingLevel: "extreme", scope: "forever" } as any,
      },
    });
    expect(s.tiers.big).toEqual({ provider: "openrouter", model: "z-ai/glm-5.3" });
  });

  it("normalizes the default, whether it is a tier name or a model", () => {
    expect(settings({ ...TIERS, default: " Medium " }).default).toBe("medium");
    expect(settings({ ...TIERS, default: { provider: "openrouter", model: "z-ai/glm-5.3" } }).default).toEqual({
      provider: "openrouter",
      model: "z-ai/glm-5.3",
    });
    expect(settings({ default: "" }).default).toBeNull();
    expect(settings({ default: { model: "no-provider" } as any }).default).toBeNull();
  });

  it("lowercases per-skill tier overrides and ignores empty ones", () => {
    const s = settings({ tiers: { big: { provider: "openrouter", model: "z-ai/glm-5.3" } }, skillTiers: { A: "BIG", b: "" } });
    expect(s.skillTiers).toEqual({ A: "big" });
  });

  it("reads booleans only, falling back to the defaults otherwise", () => {
    expect(settings({ enabled: false, applyToUnlabeledSkills: false })).toMatchObject({
      enabled: false,
      applyToUnlabeledSkills: false,
    });
    expect(settings({ enabled: "no" } as any).enabled).toBe(true);
  });
});

// ── Tier declarations ─────────────────────────────────────────────

describe("frontmatterTier", () => {
  it("reads metadata.modelTier and metadata.model-tier", () => {
    expect(frontmatterTier({ modelTier: " BIG " })).toBe("big");
    expect(frontmatterTier({ "model-tier": "small" })).toBe("small");
  });

  it("returns undefined for a missing or non-string tier", () => {
    expect(frontmatterTier(undefined)).toBeUndefined();
    expect(frontmatterTier({})).toBeUndefined();
    expect(frontmatterTier({ modelTier: 3 })).toBeUndefined();
    expect(frontmatterTier({ modelTier: "   " })).toBeUndefined();
  });

  it("prefers modelTier over model-tier when both are present", () => {
    expect(frontmatterTier({ modelTier: "big", "model-tier": "small" })).toBe("big");
  });
});

// ── Resolution ────────────────────────────────────────────────────

describe("resolveSkillModel", () => {
  it("switches to the tier a skill declares", () => {
    const decision = resolveSkillModel("do-things", { modelTier: "big" }, settings({ ...TIERS }));
    expect(decision).toMatchObject({ action: "switch", tier: "big", source: "frontmatter" });
    expect(decision.ref?.model).toBe("z-ai/glm-5.3");
  });

  it("lets the config override the frontmatter", () => {
    const decision = resolveSkillModel(
      "do-things",
      { modelTier: "big" },
      settings({ ...TIERS, skillTiers: { "do-things": "small" } }),
    );
    expect(decision).toMatchObject({ action: "switch", tier: "small", source: "config" });
  });

  it("applies the default to a skill without a tier", () => {
    const decision = resolveSkillModel("unlabeled", undefined, settings({ ...TIERS, default: "medium" }));
    expect(decision).toMatchObject({ action: "switch", tier: "medium", source: "default" });
    expect(decision.ref?.model).toBe("deepseek/deepseek-v4.1-flash");
  });

  it("uses a default written as a model directly", () => {
    const config = settings({ default: { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" } });
    const decision = resolveSkillModel("unlabeled", undefined, config);
    expect(decision).toMatchObject({ action: "switch", tier: "default", source: "default" });
    expect(decision.ref?.provider).toBe("openrouter");
  });

  it("can keep the current model for unlabeled skills", () => {
    const config = settings({ ...TIERS, default: "medium", applyToUnlabeledSkills: false });
    expect(resolveSkillModel("unlabeled", undefined, config)).toEqual({ action: "none" });
  });

  it("keeps the current model when a skill opts out", () => {
    const decision = resolveSkillModel("stay", { modelTier: "none" }, settings({ ...TIERS, default: "medium" }));
    expect(decision).toMatchObject({ action: "none", optedOut: true, tier: "none" });
  });

  it("falls back to the default for an unknown tier and reports it", () => {
    const decision = resolveSkillModel("typo", { modelTier: "huge" }, settings({ ...TIERS, default: "medium" }));
    expect(decision).toMatchObject({ action: "switch", tier: "medium", source: "default" });
    expect(decision.problem).toContain('tier "huge" is not defined');
  });

  it("reports an unknown tier without a default", () => {
    const decision = resolveSkillModel("typo", { modelTier: "huge" }, settings({ ...TIERS }));
    expect(decision).toMatchObject({ action: "none", tier: "huge" });
    expect(decision.problem).toContain('tier "huge" is not defined');
  });

  it("reports a default that names an undefined tier", () => {
    const decision = resolveSkillModel("unlabeled", undefined, settings({ ...TIERS, default: "huge" }));
    expect(decision).toMatchObject({ action: "none" });
    expect(decision.problem).toContain('models.default names tier "huge"');
  });
});

describe("normalizeTier", () => {
  it("trims whitespace around the provider and the model", () => {
    expect(normalizeTier({ provider: " openrouter ", model: " z-ai/glm-5.3 " })).toEqual({
      provider: "openrouter",
      model: "z-ai/glm-5.3",
    });
  });

  it("rejects anything that is not a provider/model object", () => {
    expect(normalizeTier(null)).toBeUndefined();
    expect(normalizeTier("big")).toBeUndefined();
    expect(normalizeTier([])).toBeUndefined();
    expect(normalizeTier({})).toBeUndefined();
  });
});

describe("describeModelEvent", () => {
  const SWITCH = {
    event: "switch" as const,
    from: "openrouter/moonshotai/kimi-k2.6",
    to: "openrouter/z-ai/glm-5.3",
    thinkingLevel: "max",
    trigger: 'skill("build-ml-pipeline")',
    tier: "big",
    source: "frontmatter" as const,
    scope: "run" as const,
  };
  const LINE = '🎚️ Model openrouter/z-ai/glm-5.3 (thinking max) · tier "big" for skill("build-ml-pipeline"), this run only';

  it("says which skill and tier switched the model", () => {
    expect(describeModelEvent(SWITCH)).toBe(LINE);
    expect(describeModelEvent({ ...SWITCH, scope: "session" })).not.toContain("this run only");
  });

  it("adds where the model came from when expanded", () => {
    expect(describeModelEvent(SWITCH, true)).toBe(`${LINE}\n   was openrouter/moonshotai/kimi-k2.6 · tier from frontmatter`);
  });

  it("describes the end of a run-scoped tier and a reset", () => {
    expect(describeModelEvent({ event: "restore", to: "openrouter/moonshotai/kimi-k2.6", thinkingLevel: "medium", tier: "big" })).toBe(
      '🎚️ Model openrouter/moonshotai/kimi-k2.6 (thinking medium) · restored at the end of the run (tier "big" was for that run only)',
    );
    expect(describeModelEvent({ event: "reset", to: "openrouter/moonshotai/kimi-k2.6" })).toBe(
      "🎚️ Model openrouter/moonshotai/kimi-k2.6 · restored by /skills-model reset",
    );
  });
});
