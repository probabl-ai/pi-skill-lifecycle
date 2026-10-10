/**
 * Model tiers: a skill declares which tier of model it wants, and the config
 * maps tiers to models Pi already knows about.
 *
 * Pure logic — no Pi imports, fully testable in isolation. The extension
 * resolves a tier here, then applies it with `pi.setModel()`. A tier can only
 * name a model in Pi's model registry, so switching never needs a new
 * provider, API key, or header: it reuses what the user already configured.
 */

// ── Types ─────────────────────────────────────────────────────────

/** Thinking levels `pi.setThinkingLevel()` accepts (pi-agent-core's union, which includes "off"). */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export type TierScope = "session" | "run";

/**
 * What a `metadata.role: helper` skill does to the model while the skill that
 * loaded it keeps working:
 *
 * - "keep": leave the caller's model alone (the behavior before 0.4).
 * - "allow-downgrade" (default): apply the helper's tier only when it is
 *   strictly cheaper than the model now in use, so a small or medium sub-step
 *   does not run on a big caller's model. Never upgrades.
 * - "always": apply the helper's tier, upgrades included.
 *
 * A helper switch lasts for the rest of the run only: the caller keeps working
 * after the helper, so its model comes back when the run settles.
 */
export type HelperTierPolicy = "keep" | "allow-downgrade" | "always";

export const HELPER_TIER_POLICIES: readonly HelperTierPolicy[] = ["keep", "allow-downgrade", "always"];

/** One tier: the Pi model to switch to, and how the switch behaves. */
export interface ModelTier {
  /** Provider id in Pi's model registry, e.g. "openrouter". */
  provider: string;
  /** Model id in Pi's model registry, e.g. "deepseek/deepseek-v4.1-flash". */
  model: string;
  /**
   * Thinking level set together with the model; Pi clamps it to what the model
   * supports. Default: whatever Pi applies on any model switch (the per-model
   * or global default level), which is not necessarily the previous level.
   */
  thinkingLevel?: ThinkingLevel;
  /**
   * "session" (default): the model stays until another skill switches it.
   * "run": when the agent run settles, the model active just before this tier
   * is restored, so an expensive tier is used for the run that asked for it
   * only. A session-scoped switch later in the same run supersedes it.
   */
  scope?: TierScope;
}

/** A tier name resolved through `tiers`, or a model written out in full. */
export type ModelTierRef = string | ModelTier;

/** The `models` key of skill-lifecycle.json. Every field is optional. */
export interface ModelConfig {
  /** Switch models when a skill declares a tier. Default: true */
  enabled?: boolean;
  /** Tier name → model, e.g. `{ "big": { "provider": "openrouter", "model": "z-ai/glm-5.3" } }`. Default: {} */
  tiers?: Record<string, ModelTier>;
  /**
   * Model used when a skill declares no tier, and when it declares a tier that
   * is not defined: a tier name, or a model written out in full. Default: null,
   * i.e. leave the current model alone.
   */
  default?: ModelTierRef | null;
  /** Per-skill tier overrides, e.g. `{ "legacy-skill": "big" }`. Default: {} */
  skillTiers?: Record<string, string>;
  /**
   * Apply `default` to skills that declare no tier. Default: true. Set it to
   * false to switch only for skills that declare a tier, while still falling
   * back to `default` for one that names a tier that is not defined.
   */
  applyToUnlabeledSkills?: boolean;
  /**
   * What a helper loaded by a working caller does to the model: "keep",
   * "allow-downgrade", or "always". Default: "allow-downgrade".
   */
  helperTierPolicy?: HelperTierPolicy;
}

/** A normalized ModelConfig, with every field defined. */
export interface ModelSettings {
  enabled: boolean;
  tiers: Record<string, ModelTier>;
  default: ModelTierRef | null;
  skillTiers: Record<string, string>;
  applyToUnlabeledSkills: boolean;
  helperTierPolicy: HelperTierPolicy;
}

// ── Defaults ──────────────────────────────────────────────────────

/** Neutral defaults: with no config, no skill changes the model. */
export const DEFAULT_MODEL_CONFIG: ModelSettings = {
  enabled: true,
  tiers: {},
  default: null,
  skillTiers: {},
  applyToUnlabeledSkills: true,
  helperTierPolicy: "allow-downgrade",
};

/** Tier names that deliberately keep the current model. */
const OPT_OUT = new Set(["none", "off", "no", "false", "keep"]);

/** Tier name reported when `default` is written out as a model rather than a tier name. */
const DEFAULT_TIER = "default";

// ── Normalization ─────────────────────────────────────────────────

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Normalize one tier, or undefined when it does not name both a provider and a model. */
export function normalizeTier(value: unknown): ModelTier | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!provider || !model) return undefined;
  const tier: ModelTier = { provider, model };
  if (isThinkingLevel(raw.thinkingLevel)) tier.thinkingLevel = raw.thinkingLevel;
  if (raw.scope === "session" || raw.scope === "run") tier.scope = raw.scope;
  return tier;
}

function normalizeHelperPolicy(value: unknown): HelperTierPolicy | undefined {
  if (typeof value !== "string") return undefined;
  const policy = value.trim().toLowerCase();
  return (HELPER_TIER_POLICIES as readonly string[]).includes(policy) ? (policy as HelperTierPolicy) : undefined;
}

function normalizeRef(value: unknown): ModelTierRef | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") {
    const name = value.trim();
    return name ? name.toLowerCase() : undefined;
  }
  return normalizeTier(value);
}

/** Fill in defaults for the `models` config; missing or invalid entries are dropped. */
export function modelSettingsFrom(partial?: ModelConfig | ModelSettings | null): ModelSettings {
  const raw = (partial ?? {}) as ModelConfig;
  const tiers: Record<string, ModelTier> = {};
  for (const [name, value] of Object.entries(raw.tiers ?? {})) {
    const key = name.trim().toLowerCase();
    const tier = normalizeTier(value);
    if (key && tier) tiers[key] = tier;
  }
  const skillTiers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw.skillTiers ?? {})) {
    if (typeof value === "string" && value.trim()) skillTiers[name] = value.trim().toLowerCase();
  }
  const def = normalizeRef(raw.default);
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_MODEL_CONFIG.enabled,
    tiers,
    default: def === undefined ? DEFAULT_MODEL_CONFIG.default : def,
    skillTiers,
    applyToUnlabeledSkills:
      typeof raw.applyToUnlabeledSkills === "boolean"
        ? raw.applyToUnlabeledSkills
        : DEFAULT_MODEL_CONFIG.applyToUnlabeledSkills,
    helperTierPolicy: normalizeHelperPolicy(raw.helperTierPolicy) ?? DEFAULT_MODEL_CONFIG.helperTierPolicy,
  };
}

// ── Price comparison ──────────────────────────────────────────────

/** The part of a Pi model that the price comparison reads. */
export interface PricedModel {
  provider: string;
  id: string;
  cost?: { input?: number; output?: number };
}

/**
 * Price used to rank models: input plus output price per million tokens, as
 * listed in Pi's model registry. Undefined when either price is missing or
 * invalid, so an unpriced model never counts as cheaper.
 */
export function modelPrice(model: PricedModel | undefined): number | undefined {
  const input = model?.cost?.input;
  const output = model?.cost?.output;
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  return valid(input) && valid(output) ? input + output : undefined;
}

const levelRank = (level: string | undefined) =>
  level === undefined ? -1 : (THINKING_LEVELS as readonly string[]).indexOf(level);

/** How a tier's model compares with the model in use: "unknown" when it cannot be told. */
export type CostComparison = "cheaper" | "not-cheaper" | "unknown";

/**
 * Compare moving from the current model to a tier's model. It is cheaper when
 * the other model has a lower price, or when it is the same model at a lower
 * thinking level. A missing price or thinking level gives "unknown".
 */
export function compareModelCost(
  current: PricedModel | undefined,
  currentLevel: string | undefined,
  target: PricedModel | undefined,
  targetLevel: string | undefined,
): CostComparison {
  if (!current || !target) return "unknown";
  if (current.provider === target.provider && current.id === target.id) {
    const from = levelRank(currentLevel);
    const to = levelRank(targetLevel);
    if (from < 0 || to < 0) return "unknown";
    return to < from ? "cheaper" : "not-cheaper";
  }
  const from = modelPrice(current);
  const to = modelPrice(target);
  if (from === undefined || to === undefined) return "unknown";
  return to < from ? "cheaper" : "not-cheaper";
}

/** Whether moving to a tier's model is known to be strictly cheaper; unknown is not cheaper. */
export function isCheaperModel(
  current: PricedModel | undefined,
  currentLevel: string | undefined,
  target: PricedModel | undefined,
  targetLevel: string | undefined,
): boolean {
  return compareModelCost(current, currentLevel, target, targetLevel) === "cheaper";
}

// ── Tier lookup ───────────────────────────────────────────────────

export type TierSource = "config" | "frontmatter" | "default";

export interface SkillModelDecision {
  action: "switch" | "none";
  /** Where the tier came from. */
  source?: TierSource;
  /** Tier name, or "default" when `models.default` names a model instead of a tier. */
  tier?: string;
  /** Model to switch to; defined when `action` is "switch". */
  ref?: ModelTier;
  /** A misconfiguration worth reporting, even when a fallback model was used. */
  problem?: string;
  /** The skill explicitly keeps the current model (`modelTier: none`). */
  optedOut?: boolean;
}

/** Tier declared in a SKILL.md, from `metadata.modelTier` (or `metadata.model-tier`). */
export function frontmatterTier(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined;
  for (const key of ["modelTier", "model-tier"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }
  return undefined;
}

interface DefaultRef {
  tier: string;
  ref?: ModelTier;
  problem?: string;
}

/** The configured fallback model, resolved through `tiers` when it is a tier name. */
function defaultRef(settings: ModelSettings): DefaultRef | undefined {
  const def = settings.default;
  if (def === null || def === undefined) return undefined;
  if (typeof def === "string") {
    const ref = settings.tiers[def];
    return ref
      ? { tier: def, ref }
      : { tier: def, problem: `models.default names tier "${def}", which is not defined in models.tiers` };
  }
  return { tier: DEFAULT_TIER, ref: def };
}

/**
 * Which model a skill asks for.
 *
 * Precedence: `models.skillTiers` (config) over `metadata.modelTier`
 * (frontmatter) over `models.default`. A tier of "none"/"off" keeps the
 * current model. An unknown tier name falls back to `models.default` when
 * there is one, and is reported either way.
 */
export function resolveSkillModel(
  name: string,
  metadata: Record<string, unknown> | undefined,
  settings: ModelSettings,
): SkillModelDecision {
  const fromConfig = settings.skillTiers[name];
  const declared = fromConfig ?? frontmatterTier(metadata);
  const source: TierSource | undefined =
    fromConfig !== undefined ? "config" : declared !== undefined ? "frontmatter" : undefined;

  if (declared !== undefined) {
    if (OPT_OUT.has(declared)) return { action: "none", source, tier: declared, optedOut: true };
    const ref = settings.tiers[declared];
    if (ref) return { action: "switch", source, tier: declared, ref };
    const fallback = defaultRef(settings);
    if (fallback?.ref) {
      return {
        action: "switch",
        source: "default",
        tier: fallback.tier,
        ref: fallback.ref,
        problem: `tier "${declared}" is not defined in models.tiers; using "${fallback.tier}"`,
      };
    }
    return {
      action: "none",
      source,
      tier: declared,
      problem: fallback?.problem ?? `tier "${declared}" is not defined in models.tiers`,
    };
  }

  if (!settings.applyToUnlabeledSkills) return { action: "none" };
  const fallback = defaultRef(settings);
  if (!fallback) return { action: "none" };
  if (!fallback.ref) return { action: "none", problem: fallback.problem };
  return { action: "switch", source: "default", tier: fallback.tier, ref: fallback.ref };
}

// ── Session record ────────────────────────────────────────────────

/** Custom entry type of a model change, drawn in the chat by the extension. */
export const MODEL_EVENT_TYPE = "skill-lifecycle-model";

/**
 * A model change made by the extension. Pi records `model_change` entries but
 * does not draw them in the chat, so the extension records its own: durable,
 * shown in the transcript (also after resume), and never sent to the model.
 */
export interface ModelEvent {
  /** "switch": a skill's tier; "restore": end of a run-scoped tier; "reset": /skills-model reset. */
  event: "switch" | "restore" | "reset";
  /** Model after the change, `provider/id`. */
  to: string;
  /** Model before the change, `provider/id`. */
  from?: string;
  /** Thinking level after the change. */
  thinkingLevel?: string;
  /** What asked for the switch: `skill("x")` or `/skill:x`. */
  trigger?: string;
  /** Tier applied (switch) or ended (restore). */
  tier?: string;
  source?: TierSource;
  scope?: TierScope;
  /** The switch was made by a helper while its caller keeps working. */
  helper?: boolean;
}

/** The chat line for a model change; `expanded` adds where the model came from. */
export function describeModelEvent(e: ModelEvent, expanded = false): string {
  const model = `${e.to}${e.thinkingLevel ? ` (thinking ${e.thinkingLevel})` : ""}`;
  const why =
    e.event === "switch"
      ? `tier "${e.tier}" for ${e.trigger}${e.helper ? " (helper of a working caller)" : ""}${e.scope === "run" ? ", this run only" : ""}`
      : e.event === "restore"
        ? `restored at the end of the run${e.tier ? ` (tier "${e.tier}" was for that run only)` : ""}`
        : "restored by /skills-model reset";
  const line = `🎚️ Model ${model} · ${why}`;
  if (!expanded) return line;
  const details = [e.from && `was ${e.from}`, e.source && `tier from ${e.source}`].filter(Boolean).join(" · ");
  return details ? `${line}\n   ${details}` : line;
}
