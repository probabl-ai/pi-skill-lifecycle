/**
 * Configuration and eviction decisions.
 *
 * Relevance comes from the skill index (relevance.ts), built from the
 * installed skills. Keyword rules, helper lists, and the entry skill can still
 * be set in the config; they override or add to what the index derives.
 *
 * Pure logic — no Pi imports, fully testable in isolation.
 */

import { decideRelevance, tokenize, type RelevanceOptions, type SkillIndex } from "./relevance.ts";
import { DEFAULT_MODEL_CONFIG, type ModelConfig } from "./models.ts";

export { tokenize } from "./relevance.ts";

// ── Types ─────────────────────────────────────────────────────────

export interface Skill {
  name: string;
  description: string;
  /** Full path to SKILL.md */
  filePath: string;
  /** Directory containing the skill */
  baseDir: string;
  /** If true, skill only responds to explicit /skill:name commands */
  disableModelInvocation: boolean;
}

/**
 * Optional keyword rule: when enough of its keywords appear in the prompt,
 * the skill's body is kept whatever the index says.
 */
export interface RelevanceRule {
  /** Skill name this rule applies to */
  skillName: string;
  /** Keywords (substrings of the prompt, case-insensitive) */
  keywords: string[];
  /** Multiplier of the matched-keyword fraction (default 1.0) */
  weight?: number;
}

/** Configuration, loadable from skill-lifecycle.json. Every key is optional. */
export interface EngineConfig {
  // ── Relevance (derived from the installed skills) ────────────
  /** A loaded body stays when its skill ranks in the top N of all installed skills for the prompt. Default: 3 */
  topK?: number;
  /** …or scores at least this fraction of the best-scoring skill. Default: 0.5 */
  relativeScore?: number;
  /** Best score below this means the prompt carries no topic signal: nothing is evicted. Default: 2 */
  minSignal?: number;
  /**
   * When a skill is loaded mid-run, keep bodies whose skill tells the model
   * to load a new skill (the caller of a sub-step); a "Do not load" mention
   * is not a call. Default: false
   */
  protectCallers?: boolean;
  /**
   * When a skill is loaded mid-run, keep the body that was loaded immediately
   * before it: in a dispatch chain that body is usually the caller still being
   * worked from. Measured to cut reloads, not to prevent wrong evictions —
   * declaring `metadata.role: helper` is the precise fix. Default: false
   */
  protectLoader?: boolean;
  /** Infer the entry skill from the skills when neither the config nor a frontmatter declares one. Default: true */
  inferEntrySkill?: boolean;

  // ── Overrides ────────────────────────────────────────────────
  /** Keyword rules that keep a body when they match (see RelevanceRule). Default: [] */
  rules?: RelevanceRule[];
  /** Minimum rule score (0..1) for a rule to keep a body. Default: 0.15 */
  threshold?: number;
  /**
   * Skill the model should load first for ambiguous requests. Overrides a
   * frontmatter `metadata.role: entry` and the inferred one. Default: ""
   */
  entrySkill?: string;
  /** Never archive the entry skill's body. Default: true */
  pinEntrySkill?: boolean;
  /**
   * Skills called for a sub-step: loading one mid-run archives nothing.
   * Added to skills declaring `metadata.role: helper`. Default: []
   */
  helperSkills?: string[];
  /** Skills whose bodies are never archived. Default: [] */
  pinned?: string[];

  // ── Lifecycle ────────────────────────────────────────────────
  /** The N most recently loaded bodies are never evicted at a user prompt. Default: 2 */
  minKeep?: number;
  /** Maximum number of loaded bodies; 0 = unlimited. Default: 0 */
  maxKeep?: number;
  /** Archive unrelated bodies as soon as another skill is loaded mid-run. Default: true */
  evictOnSkillLoad?: boolean;
  /** Block `read` calls on a known SKILL.md and point to the skill tool. Default: true */
  blockDirectSkillReads?: boolean;
  /**
   * Archive irrelevant skill bodies at all. The persisted counterpart of
   * `/skills-off`; `/skills-reload` re-applies it. Default: true
   */
  enabled?: boolean;
  /** Notify when bodies are loaded or archived. Default: true */
  verbose?: boolean;

  // ── Model tiers ──────────────────────────────────────────────
  /**
   * Switch models when a skill declares a tier (`metadata.modelTier`). Tiers
   * map to models already registered in Pi, so no new API key is needed.
   * See models.ts. Default: no tiers, nothing switches.
   */
  models?: ModelConfig;

  // ── Change detection ─────────────────────────────────────────
  /** Skip scoring when the prompt is a short follow-up. Default: true */
  skipOnShortPrompts?: boolean;
  /** Prompts shorter than this many characters skip scoring. Default: 15 */
  minScorablePromptLength?: number;
  /** Token overlap ratio (0..1) above which a prompt counts as the same topic. Default: 0.7 */
  topicChangeThreshold?: number;
}

// ── Defaults ──────────────────────────────────────────────────────

export const DEFAULT_CONFIG: Required<EngineConfig> = {
  topK: 3,
  relativeScore: 0.5,
  minSignal: 2,
  protectCallers: false,
  protectLoader: false,
  inferEntrySkill: true,
  rules: [],
  threshold: 0.15,
  entrySkill: "",
  pinEntrySkill: true,
  helperSkills: [],
  pinned: [],
  minKeep: 2,
  maxKeep: 0,
  evictOnSkillLoad: true,
  blockDirectSkillReads: true,
  enabled: true,
  verbose: true,
  models: DEFAULT_MODEL_CONFIG,
  skipOnShortPrompts: true,
  minScorablePromptLength: 15,
  topicChangeThreshold: 0.7,
};

/** Fill in defaults for a partial config; `undefined` and `null` values fall back to the default. */
export function configWithDefaults(partial?: EngineConfig): Required<EngineConfig> {
  const out: Record<string, unknown> = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(partial ?? {})) {
    if (value !== undefined && value !== null && key in DEFAULT_CONFIG) out[key] = value;
  }
  return out as Required<EngineConfig>;
}

export function relevanceOptions(config: Required<EngineConfig>): RelevanceOptions {
  return { topK: config.topK, relativeScore: config.relativeScore, minSignal: config.minSignal };
}

/** Config file name, looked up in the user agent directory and the project `.pi` directory. */
export const CONFIG_FILENAME = "skill-lifecycle.json";

// ── Roles ─────────────────────────────────────────────────────────

export type RoleSource = "config" | "frontmatter" | "inferred";

export interface Roles {
  entry?: { name: string; source: RoleSource };
  helpers: Map<string, RoleSource>;
}

/**
 * Entry and helper skills, from the config first, then the frontmatter, then
 * (entry only) inference. Only installed skills are returned; before the
 * skills are known (empty index, no prompt yet), configured names are kept.
 */
export function resolveRoles(index: SkillIndex, config: Required<EngineConfig>): Roles {
  const known = new Set(index.names);
  const installed = { has: (name: string) => known.size === 0 || known.has(name) };
  let entry: Roles["entry"];
  if (config.entrySkill) {
    if (installed.has(config.entrySkill)) entry = { name: config.entrySkill, source: "config" };
  } else if (index.entry && (index.entry.source === "frontmatter" || config.inferEntrySkill)) {
    entry = { name: index.entry.name, source: index.entry.source };
  }
  const helpers = new Map<string, RoleSource>();
  for (const [name, role] of index.declaredRoles) if (role === "helper") helpers.set(name, "frontmatter");
  for (const name of config.helperSkills) if (installed.has(name)) helpers.set(name, "config");
  if (entry) helpers.delete(entry.name);
  return { entry, helpers };
}

// ── Keyword rules ─────────────────────────────────────────────────

/** Best rule score (0..1) of a skill for a prompt, or 0 without a matching rule. */
export function ruleScore(prompt: string, skillName: string, rules: readonly RelevanceRule[]): { score: number; reason: string } {
  const lower = prompt.toLowerCase();
  let best = { score: 0, reason: "" };
  for (const rule of rules) {
    if (rule.skillName !== skillName || rule.keywords.length === 0) continue;
    const matched = rule.keywords.filter((kw) => lower.includes(kw.toLowerCase())).length;
    const score = Math.min(1, (matched / rule.keywords.length) * (rule.weight ?? 1));
    if (score > best.score) best = { score, reason: `rule matched ${matched}/${rule.keywords.length} keywords` };
  }
  return best;
}

// ── Change detection ──────────────────────────────────────────────

/** Token set of a previous prompt, used to decide whether the topic shifted. */
export type PromptFingerprint = Set<string>;

export function fingerprintPrompt(prompt: string): PromptFingerprint {
  return tokenize(prompt);
}

/**
 * Whether a new prompt continues the previous task, so scoring is skipped:
 * a very short follow-up ("yes", "continue") or a prompt whose words mostly
 * appeared in the previous one.
 */
export function isMinorChange(
  currentPrompt: string,
  previousFingerprint: PromptFingerprint | undefined,
  config: Required<EngineConfig>,
): boolean {
  if (previousFingerprint === undefined || previousFingerprint.size === 0) return false;
  const trimmed = currentPrompt.trim();
  if (config.skipOnShortPrompts && trimmed.length < config.minScorablePromptLength) return true;
  const current = tokenize(trimmed);
  if (current.size === 0) return true;
  let overlap = 0;
  for (const token of current) if (previousFingerprint.has(token)) overlap++;
  return overlap / current.size >= config.topicChangeThreshold;
}

// ── Skill body helpers ────────────────────────────────────────────

/** Regex to extract a skill name from its `<skill_content>` wrapper. */
export const SKILL_CONTENT_RE = /<skill_content name="([^"]+)">/;

/** Skill name of a `<skill_content>` tool result, or null if this isn't skill body content. */
export function extractSkillNameFromContent(content: Array<{ type: string; text?: string }>): string | null {
  for (const block of content) {
    if (block.type === "text" && block.text) {
      const match = block.text.match(SKILL_CONTENT_RE);
      if (match) return match[1];
    }
  }
  return null;
}

/** Placeholder that replaces an evicted skill body. */
export function buildPlaceholder(skillName: string): string {
  return [
    `<skill_content name="${skillName}">`,
    `  [Skill body archived to save context.`,
    `   Call \`skill("${skillName}")\` to reload it if you need its instructions again.]`,
    `</skill_content>`,
  ].join("\n");
}

// ── Body eviction ─────────────────────────────────────────────────

/** A loaded skill body; a larger `seq` means a more recent load. */
export interface LoadedBody {
  name: string;
  seq: number;
}

export interface Eviction {
  name: string;
  reason: string;
}

/**
 * Evict bodies that are unprotected and not relevant to `text`, then apply
 * `maxKeep`. Relevance is decided against all installed skills; a matching
 * keyword rule keeps a body too. When the text carries no topic signal,
 * nothing is evicted for relevance.
 */
function evictUnrelated(
  text: string,
  loaded: readonly LoadedBody[],
  index: SkillIndex,
  isProtected: (name: string) => boolean,
  config: Required<EngineConfig>,
  options: RelevanceOptions,
  exclude: ReadonlySet<string> = new Set(),
): Eviction[] {
  const byRecency = [...loaded].sort((a, b) => b.seq - a.seq);
  const decision = decideRelevance(index, text, options, exclude);
  const installed = new Set(index.names);
  const evicted: Eviction[] = [];
  const survivors: LoadedBody[] = [];

  for (const body of byRecency) {
    if (isProtected(body.name)) {
      survivors.push(body);
    } else if (!installed.has(body.name)) {
      evicted.push({ name: body.name, reason: "skill no longer installed" });
    } else if (ruleScore(text, body.name, config.rules).score >= config.threshold || decision.relevant(body.name)) {
      survivors.push(body);
    } else {
      evicted.push({ name: body.name, reason: decision.explain(body.name) });
    }
  }

  if (config.maxKeep > 0) {
    // Survivors are ordered most recent first; drop from the oldest end.
    for (let i = survivors.length - 1; i >= 0 && survivors.length > config.maxKeep; i--) {
      if (isProtected(survivors[i].name)) continue;
      const [body] = survivors.splice(i, 1);
      evicted.push({ name: body.name, reason: `over maxKeep (${config.maxKeep})` });
    }
  }
  return evicted;
}

/**
 * Bodies to evict for the next user prompt.
 *
 * - Pinned bodies and the `minKeep` most recently loaded bodies are kept, so
 *   the skill being worked on survives replies such as "use pixi".
 * - Other bodies are evicted when their skill is not relevant to the prompt.
 * - `maxKeep` > 0 evicts the oldest unprotected survivors beyond the cap.
 */
export function selectBodiesToEvict(
  prompt: string,
  loaded: readonly LoadedBody[],
  index: SkillIndex,
  pinnedSet: ReadonlySet<string>,
  config: Required<EngineConfig>,
): Eviction[] {
  const byRecency = [...loaded].sort((a, b) => b.seq - a.seq);
  const recent = new Set(byRecency.slice(0, Math.max(0, config.minKeep)).map((b) => b.name));
  const isProtected = (name: string) => pinnedSet.has(name) || recent.has(name);
  return evictUnrelated(prompt, loaded, index, isProtected, config, relevanceOptions(config));
}

/** The most recently loaded body that is not one of `fresh`, if any. */
function mostRecentBefore(loaded: readonly LoadedBody[], fresh: ReadonlySet<string>): string | undefined {
  let best: LoadedBody | undefined;
  for (const body of loaded) {
    if (fresh.has(body.name)) continue;
    if (!best || body.seq > best.seq) best = body;
  }
  return best?.name;
}

/**
 * Bodies made obsolete by skills loaded in the middle of a run.
 *
 * Loading a skill means the work moved to that skill's domain, so the other
 * bodies are judged against the new skills' names and descriptions.
 *
 * - Loading only helpers (`roles.helpers`) evicts nothing: the calling skill
 *   keeps its instructions. Otherwise only non-helpers are judged against.
 * - The new skills and pinned bodies are kept; with `protectCallers`, so are
 *   bodies whose skill tells the model to load a new skill (a "Do not load"
 *   mention is not a call); with `protectLoader`, so is the body loaded just
 *   before the new one.
 * - `minKeep` does not apply: the new skill is the one being worked on.
 * - There is no abstaining: when no other skill shares terms with the new
 *   one, every unprotected body is unrelated.
 * - An evicted body that dispatched to the new skill is labelled as such: 52%
 *   of mid-run evictions in the measured pack are of that kind, and the label
 *   points the pack author at `metadata.role: helper`.
 */
export function selectBodiesSupersededBy(
  newNames: readonly string[],
  loaded: readonly LoadedBody[],
  index: SkillIndex,
  pinnedSet: ReadonlySet<string>,
  helpers: ReadonlySet<string>,
  config: Required<EngineConfig>,
  descriptions: ReadonlyMap<string, string>,
): Eviction[] {
  const fresh = new Set(newNames);
  const owners = [...fresh].filter((name) => !helpers.has(name));
  if (owners.length === 0) return [];
  const callers = (name: string) =>
    config.protectCallers && owners.some((owner) => index.calls.get(name)?.has(owner));
  const loader = config.protectLoader ? mostRecentBefore(loaded, fresh) : undefined;
  const isProtected = (name: string) =>
    pinnedSet.has(name) || fresh.has(name) || name === loader || callers(name);
  const text = owners.map((name) => `${name.replace(/-/g, " ")} ${descriptions.get(name) ?? ""}`).join("\n");
  // The new skill is the topic signal, so never abstain here.
  const options = { ...relevanceOptions(config), minSignal: 0 };
  return evictUnrelated(text, loaded, index, isProtected, config, options, fresh).map((b) => {
    if (b.reason.startsWith("over maxKeep") || b.reason === "skill no longer installed") return b;
    const dispatchers = owners.filter((owner) => index.calls.get(b.name)?.has(owner));
    const hint = dispatchers.length > 0
      ? `; this body calls ${dispatchers.join(", ")} — declare metadata.role: helper to keep it`
      : "";
    return { ...b, reason: `superseded by ${owners.join(", ")} (${b.reason})${hint}` };
  });
}
