/**
 * Relevance index built from the installed skills, so no keyword list or
 * weight has to be written by hand.
 *
 * - Terms: stemmed words and bigrams from the skill name, description, and
 *   body headings, weighted by field.
 * - Weights: BM25 inverse document frequency over the installed skills, so
 *   words shared by many skills ("ml", "pipeline") count little and rare ones
 *   ("mkdocs", "leakage") count a lot.
 * - References: which skill bodies mention which other skill names.
 * - Roles: `metadata.role` (`entry` or `helper`) from the SKILL.md
 *   frontmatter, and an inferred entry skill (a router that mentions most
 *   skills of its directory).
 *
 * Pure logic — no Pi imports, fully testable in isolation.
 */

// ── Text processing ───────────────────────────────────────────────

/**
 * Common English words that carry no topic. Without this list, "and"/"the"
 * overlap between any prompt and any description keeps unrelated skills alive.
 */
export const STOPWORDS = new Set([
  "about", "after", "all", "also", "and", "any", "are", "before", "but", "can", "could",
  "does", "each", "for", "from", "has", "have", "how", "into", "its", "just", "may",
  "more", "most", "not", "now", "only", "other", "our", "out", "should", "some", "such",
  "than", "that", "the", "their", "them", "then", "there", "these", "they", "this",
  "use", "used", "using", "was", "were", "what", "when", "where", "which", "who", "why",
  "will", "with", "would", "you", "your",
  // Words every skill uses about itself.
  "skill", "skills", "load", "loads", "loaded", "trigger", "triggers", "user", "asks",
  // Conversational words that say nothing about the task.
  "please", "like", "want", "wanted", "need", "needs", "help", "get", "got", "make", "made",
  "let", "lets", "see", "show", "try", "call", "called", "fix", "thing", "things",
  "something", "way", "well", "yes", "okay", "sure", "know", "think", "look", "going",
  "done", "did", "don", "give", "take", "put", "keep", "work", "very", "really", "here",
  "pick", "one", "two", "able", "want", "wait", "since", "still", "again", "first", "next",
]);

/** Split into lowercase words of 3+ characters, minus stopwords. Hyphens and underscores separate words. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * Light English stemmer: enough for "explore/exploring/exploration",
 * "model/models/modelling", "validate/validation" to meet. Not Porter: it
 * only strips common inflections and keeps at least three characters.
 */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) w = w.slice(0, -3) + "y";
  else if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  for (const suffix of ["ing", "ed"]) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 3) {
      w = w.slice(0, -suffix.length);
      // modelling → modell → model; but keep "ll"/"ss" words like "skill".
      if (/([b-df-hj-np-tv-z])\1$/.test(w) && w.length > 4) w = w.slice(0, -1);
      break;
    }
  }
  if (/[ts]ion$/.test(w) && w.length > 5) w = w.slice(0, -3);
  if (w.endsWith("e") && w.length > 3) w = w.slice(0, -1);
  return w;
}

/** Stemmed words plus adjacent-pair bigrams ("cross_valid"). */
export function terms(text: string): string[] {
  const stems = words(text).map(stem);
  const out = [...stems];
  for (let i = 0; i + 1 < stems.length; i++) out.push(`${stems[i]}_${stems[i + 1]}`);
  return out;
}

/** Unique stemmed words of a text (no bigrams), for fingerprints and overlap checks. */
export function tokenize(text: string): Set<string> {
  return new Set(words(text));
}

// ── Body excerpt ──────────────────────────────────────────────────

/** Headings of sections about what a skill must NOT be used for; they would add false matches. */
const NEGATIVE_HEADING = /\b(not|never|avoid|don'?t|out of scope|anti-?patterns?)\b/i;
const MAX_EXCERPT = 2000;

/**
 * The part of a body indexed next to the name and description: its headings,
 * minus negative ones ("When not to use") and those inside code blocks.
 *
 * Headings name what a skill covers. Prose paragraphs were measured to hurt
 * (session replay, ML skill pack): skills share procedural vocabulary
 * ("run", "stage", "workspace"), which blurs them together.
 */
export function bodyExcerpt(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^#{1,6}\s+(.*)$/)?.[1])
    .filter((title): title is string => !!title && !NEGATIVE_HEADING.test(title))
    .join("\n")
    .slice(0, MAX_EXCERPT);
}

// ── Index ─────────────────────────────────────────────────────────

export type SkillRole = "entry" | "helper";

/** What the index needs to know about one installed skill. */
export interface IndexableSkill {
  name: string;
  description: string;
  /** SKILL.md body without frontmatter; optional (descriptions alone still work). */
  body?: string;
  /** Frontmatter `metadata` map. */
  metadata?: Record<string, unknown>;
  /** Directory containing the skill directory; skills of one pack share it. */
  packDir?: string;
}

interface Doc {
  tf: Map<string, number>;
  len: number;
}

export interface SkillIndex {
  names: string[];
  docs: Map<string, Doc>;
  idf: Map<string, number>;
  avgLen: number;
  /** name → names of other skills its body mentions (used to infer the router). */
  refs: Map<string, Set<string>>;
  /**
   * name → names of other skills its body tells the model to load: `refs`
   * without prohibitions such as "Do not load `x`". Used for caller
   * relations (`protectCallers`, the dispatcher hint).
   */
  calls: Map<string, Set<string>>;
  /** Roles declared in frontmatter (`metadata.role`). */
  declaredRoles: Map<string, SkillRole>;
  /** Entry skill: declared in frontmatter, else inferred from references, else undefined. */
  entry?: { name: string; source: "frontmatter" | "inferred" };
}

/** Field weights: a word in the name says more than one in the body. */
const FIELD_WEIGHTS = { name: 3, description: 2, excerpt: 1 } as const;
const K1 = 1.2;
const B = 0.75;

/**
 * Names of other skills a body mentions, matched as whole hyphenated names
 * ("setup-git" does not match inside "setup-git-hooks"). One pass over the
 * body, whatever the number of skills.
 */
export function mentionedSkills(body: string, self: string, names: readonly string[]): Set<string> {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  wanted.delete(self.toLowerCase());
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const out = new Set<string>();
  for (const token of body.toLowerCase().match(/[\w-]+/g) ?? []) {
    // Trailing hyphens are punctuation ("setup-git--"), not part of the name.
    const name = token.replace(/^-+|-+$/g, "");
    if (wanted.has(name)) out.add(byLower.get(name)!);
  }
  return out;
}

/**
 * A prohibition: a negation governing a load-like verb, then the skill name
 * (optionally quoted). Whitespace includes newlines, so a sentence wrapped
 * across lines ("Do not\n   load `build-ml-pipeline`") is still caught. The
 * negation must sit right before the verb, so a condition such as "if it is
 * not installed, load `x`" stays a call.
 */
const PROHIBITION =
  /\b(?:do not|don't|never|must not|should not|shouldn't|not to)\s+(?:\w+\s+)?(?:load|call|invoke|use|route to|hand off to)\s+[`'"]?[\w-]+[`'"]?/gi;

/** Skills a body tells the model to load: its mentions, minus prohibitions. */
export function calledSkills(body: string, self: string, names: readonly string[]): Set<string> {
  return mentionedSkills(body.replace(PROHIBITION, " "), self, names);
}

/** `metadata.role` from the frontmatter, if it is a role this extension knows. */
export function declaredRole(metadata: Record<string, unknown> | undefined): SkillRole | undefined {
  const role = typeof metadata?.role === "string" ? metadata.role.trim().toLowerCase() : "";
  return role === "entry" || role === "helper" ? role : undefined;
}

/** Minimum pack size for entry inference, and how dominant the router must be. */
const ENTRY_MIN_PACK = 4;
const ENTRY_MIN_SHARE = 0.75;
const ENTRY_MIN_LEAD = 1.5;

/**
 * The router of a skill pack: the skill whose body mentions at least 75% of
 * the other skills in its directory and at least 1.5× as many as the
 * runner-up. Without a clear winner there is no entry skill: a wrong one
 * would send every ambiguous request to the wrong place.
 */
export function inferEntrySkill(skills: readonly IndexableSkill[], refs: ReadonlyMap<string, ReadonlySet<string>>): string | undefined {
  const packs = new Map<string, string[]>();
  for (const s of skills) packs.set(s.packDir ?? "", [...(packs.get(s.packDir ?? "") ?? []), s.name]);
  let best: { name: string; share: number } | undefined;
  for (const members of packs.values()) {
    if (members.length < ENTRY_MIN_PACK) continue;
    const memberSet = new Set(members);
    const counts = members
      .map((name) => ({ name, n: [...(refs.get(name) ?? [])].filter((r) => memberSet.has(r)).length }))
      .sort((a, b) => b.n - a.n);
    const [first, second] = counts;
    const share = first.n / (members.length - 1);
    if (share < ENTRY_MIN_SHARE || first.n < ENTRY_MIN_LEAD * (second?.n ?? 0)) continue;
    if (!best || share > best.share) best = { name: first.name, share };
  }
  return best?.name;
}

function addTerms(tf: Map<string, number>, text: string, weight: number): number {
  const ts = terms(text);
  for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + weight);
  return ts.length * weight;
}

/** Build the index. Cheap: a few milliseconds for dozens of skills. */
export function buildSkillIndex(skills: readonly IndexableSkill[]): SkillIndex {
  const names = skills.map((s) => s.name);
  const docs = new Map<string, Doc>();
  const df = new Map<string, number>();
  const refs = new Map<string, Set<string>>();
  const calls = new Map<string, Set<string>>();
  const declaredRoles = new Map<string, SkillRole>();

  for (const s of skills) {
    const tf = new Map<string, number>();
    let len = 0;
    len += addTerms(tf, s.name.replace(/-/g, " "), FIELD_WEIGHTS.name);
    len += addTerms(tf, s.description, FIELD_WEIGHTS.description);
    if (s.body) len += addTerms(tf, bodyExcerpt(s.body), FIELD_WEIGHTS.excerpt);
    docs.set(s.name, { tf, len });
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    refs.set(s.name, s.body ? mentionedSkills(s.body, s.name, names) : new Set());
    calls.set(s.name, s.body ? calledSkills(s.body, s.name, names) : new Set());
    const role = declaredRole(s.metadata);
    if (role) declaredRoles.set(s.name, role);
  }

  const n = skills.length;
  const idf = new Map<string, number>();
  for (const [t, d] of df) idf.set(t, Math.log(1 + (n - d + 0.5) / (d + 0.5)));
  const avgLen = n > 0 ? [...docs.values()].reduce((a, d) => a + d.len, 0) / n : 0;

  const declaredEntry = [...declaredRoles].find(([, r]) => r === "entry")?.[0];
  const inferred = declaredEntry ? undefined : inferEntrySkill(skills, refs);
  const entry = declaredEntry
    ? { name: declaredEntry, source: "frontmatter" as const }
    : inferred
      ? { name: inferred, source: "inferred" as const }
      : undefined;

  return { names, docs, idf, avgLen, refs, calls, declaredRoles, entry };
}

// ── Scoring ───────────────────────────────────────────────────────

export interface RankedSkill {
  name: string;
  score: number;
  /** Matched query terms, highest contribution first. */
  matched: string[];
}

/**
 * BM25 score of every installed skill for a query text, best first.
 * Repeated query words count once, so a long prompt is not dominated by
 * one word.
 */
export function rankSkills(index: SkillIndex, text: string): RankedSkill[] {
  const query = new Set(terms(text));
  const out: RankedSkill[] = [];
  for (const name of index.names) {
    const doc = index.docs.get(name)!;
    let score = 0;
    const contributions: Array<[string, number]> = [];
    for (const t of query) {
      const f = doc.tf.get(t);
      if (!f) continue;
      const norm = index.avgLen > 0 ? doc.len / index.avgLen : 1;
      const c = (index.idf.get(t) ?? 0) * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * norm)));
      score += c;
      contributions.push([t, c]);
    }
    contributions.sort((a, b) => b[1] - a[1]);
    out.push({ name, score, matched: contributions.map(([t]) => t) });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/** Options of the relevance decision. */
export interface RelevanceOptions {
  /** A body is relevant when its skill ranks in the top N for the text. */
  topK: number;
  /** …or scores at least this fraction of the best score. */
  relativeScore: number;
  /** Best score below this means the text carries no topic signal: decide nothing. */
  minSignal: number;
}

export interface RelevanceDecision {
  /** True when the text carries no usable signal; callers keep everything. */
  abstain: boolean;
  top: number;
  ranking: RankedSkill[];
  /** Is this skill relevant to the text? Always true when abstaining. */
  relevant(name: string): boolean;
  /** Human-readable reason for one skill. */
  explain(name: string): string;
}

/**
 * Decide which skills a text is about, relative to all installed skills.
 * Absolute scores depend on the number of skills and description lengths;
 * ranks and fractions of the best score do not.
 */
export function decideRelevance(
  index: SkillIndex,
  text: string,
  options: RelevanceOptions,
  exclude: ReadonlySet<string> = new Set(),
): RelevanceDecision {
  const ranking = rankSkills(index, text).filter((r) => !exclude.has(r.name));
  const top = ranking[0]?.score ?? 0;
  const abstain = top < options.minSignal;
  const rank = new Map(ranking.map((r, i) => [r.name, i]));
  const byName = new Map(ranking.map((r) => [r.name, r]));
  const relevant = (name: string) => {
    if (abstain) return true;
    const r = byName.get(name);
    if (!r || r.score <= 0) return false;
    return (rank.get(name) ?? Infinity) < options.topK || r.score >= options.relativeScore * top;
  };
  const explain = (name: string) => {
    if (abstain) return `no topic signal (best score ${top.toFixed(2)} < ${options.minSignal})`;
    const r = byName.get(name);
    if (!r || r.score <= 0) return "no match";
    const terms = r.matched.slice(0, 3).join(", ");
    return `rank ${(rank.get(name) ?? 0) + 1}/${ranking.length}, ${((100 * r.score) / top).toFixed(0)}% of best (${terms})`;
  };
  return { abstain, top, ranking, relevant, explain };
}
