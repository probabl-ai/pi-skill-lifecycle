/**
 * Tests for the skill index (relevance.ts): text processing, BM25 ranking,
 * references, roles, and the relative relevance decision.
 */

import { describe, it, expect } from "vitest";
import {
  bodyExcerpt,
  buildSkillIndex,
  calledSkills,
  decideRelevance,
  declaredRole,
  inferEntrySkill,
  mentionedSkills,
  rankSkills,
  stem,
  terms,
  tokenize,
  words,
} from "../extensions/relevance.ts";
import type { IndexableSkill } from "../extensions/relevance.ts";
import { PACK } from "./fixtures.ts";

const OPTIONS = { topK: 3, relativeScore: 0.5, minSignal: 2 };
const names = (ranking: Array<{ name: string }>) => ranking.map((r) => r.name);

// ── Text processing ───────────────────────────────────────────────

describe("words", () => {
  it("splits on punctuation, hyphens, and underscores, lowercased", () => {
    expect(words("Build-ML_Pipeline, NOW!")).toEqual(["build", "pipeline"]);
  });

  it("drops words shorter than 3 characters and stopwords", () => {
    expect(words("a ml of the data and you")).toEqual(["data"]);
  });

  it("drops conversational words that say nothing about the task", () => {
    expect(words("please can you fix it, I would like to see")).toEqual([]);
  });

  it("handles empty input", () => {
    expect(words("")).toEqual([]);
  });
});

describe("stem", () => {
  it.each([
    ["explore", "explor"],
    ["exploring", "explor"],
    ["exploration", "explorat"],
    ["models", "model"],
    ["modelling", "model"],
    ["modeling", "model"],
    ["validate", "validat"],
    ["validation", "validat"],
    ["pipelines", "pipelin"],
    ["libraries", "library"],
    ["regression", "regress"],
    ["class", "class"],
    ["data", "data"],
  ])("%s → %s", (word, expected) => {
    expect(stem(word)).toBe(expected);
  });

  it("makes inflections of one word meet", () => {
    expect(stem("profiling")).toBe(stem("profile"));
    expect(stem("plots")).toBe(stem("plotting"));
    expect(stem("evaluated")).toBe(stem("evaluate"));
  });

  it("keeps at least three characters", () => {
    expect(stem("used")).toHaveLength(4);
    expect(stem("bed").length).toBeGreaterThanOrEqual(3);
  });
});

describe("terms", () => {
  it("returns stems followed by adjacent bigrams", () => {
    expect(terms("cross validation")).toEqual(["cross", "validat", "cross_validat"]);
  });

  it("forms bigrams across removed stopwords", () => {
    expect(terms("explore the data")).toContain("explor_data");
  });
});

describe("tokenize", () => {
  it("returns unique unstemmed words", () => {
    expect([...tokenize("data data pipelines")]).toEqual(["data", "pipelines"]);
  });
});

// ── Body excerpt ──────────────────────────────────────────────────

describe("bodyExcerpt", () => {
  it("keeps headings of every level and drops prose", () => {
    const out = bodyExcerpt("# Title\n\nFirst paragraph.\n\n## Details\n\nDetail text.\n\n###### Deep");
    expect(out.split("\n")).toEqual(["Title", "Details", "Deep"]);
  });

  it("skips negative headings", () => {
    const out = bodyExcerpt("# T\n\n## When not to use\n\n## Never plot here\n\n## Steps");
    expect(out.split("\n")).toEqual(["T", "Steps"]);
  });

  it("ignores comment lines inside code blocks", () => {
    const out = bodyExcerpt("# T\n\n```bash\n# install secretword\n```\n\n## Steps");
    expect(out).not.toContain("secretword");
    expect(out.split("\n")).toEqual(["T", "Steps"]);
  });

  it("caps the excerpt length", () => {
    const out = bodyExcerpt(Array.from({ length: 500 }, (_, i) => `# Heading number ${i}`).join("\n"));
    expect(out.length).toBeLessThanOrEqual(2000);
  });
});

// ── References and roles ──────────────────────────────────────────

describe("mentionedSkills", () => {
  const all = ["setup-git", "setup-git-hooks", "plot-ml-figure", "self"];

  it("matches whole hyphenated names only", () => {
    expect([...mentionedSkills("use setup-git-hooks here", "self", all)]).toEqual(["setup-git-hooks"]);
    expect([...mentionedSkills("run `setup-git` first", "self", all)]).toEqual(["setup-git"]);
  });

  it("ignores the skill itself and is case-insensitive", () => {
    expect([...mentionedSkills("self and PLOT-ML-FIGURE", "self", all)]).toEqual(["plot-ml-figure"]);
  });
});

describe("declaredRole", () => {
  it("reads metadata.role entry or helper", () => {
    expect(declaredRole({ role: "entry" })).toBe("entry");
    expect(declaredRole({ role: " Helper " })).toBe("helper");
  });

  it("ignores unknown roles, non-strings, and missing metadata", () => {
    expect(declaredRole({ role: "data engineer" })).toBeUndefined();
    expect(declaredRole({ role: 3 })).toBeUndefined();
    expect(declaredRole(undefined)).toBeUndefined();
  });
});

describe("inferEntrySkill", () => {
  const refsOf = (skills: IndexableSkill[]) =>
    new Map(skills.map((s) => [s.name, mentionedSkills(s.body ?? "", s.name, skills.map((x) => x.name))]));

  it("finds the router that mentions most skills of its pack", () => {
    expect(inferEntrySkill(PACK, refsOf(PACK))).toBe("triage-ml-task");
  });

  it("finds nothing without a clear winner", () => {
    // explore-ml-data mentions 3 of the 5 others: below the 75% share.
    const withoutRouter = PACK.filter((s) => s.name !== "triage-ml-task");
    expect(inferEntrySkill(withoutRouter, refsOf(withoutRouter))).toBeUndefined();
  });

  it("requires a lead over the runner-up", () => {
    const two = PACK.map((s) => (s.name === "explore-ml-data" ? { ...s, body: PACK[0].body } : s));
    expect(inferEntrySkill(two, refsOf(two))).toBeUndefined();
  });

  it("ignores packs that are too small", () => {
    const small = PACK.slice(0, 3);
    expect(inferEntrySkill(small, refsOf(small))).toBeUndefined();
  });

  it("only counts mentions of skills in the same directory", () => {
    const split = PACK.map((s) => (s.name === "triage-ml-task" ? { ...s, packDir: "/elsewhere" } : s));
    expect(inferEntrySkill(split, refsOf(split))).toBeUndefined();
  });
});

// ── Index and ranking ─────────────────────────────────────────────

describe("buildSkillIndex", () => {
  const index = buildSkillIndex(PACK);

  it("weights rare terms above terms shared by many skills", () => {
    expect(index.idf.get("pipelin")!).toBeLessThan(index.idf.get("matplotlib")!);
  });

  it("records which skills each body mentions", () => {
    expect([...index.refs.get("explore-ml-data")!].sort()).toEqual(["persist-ml-git", "plot-ml-figure", "setup-ml-project"]);
    expect(index.refs.get("plot-ml-figure")!.size).toBe(0);
  });

  it("infers the entry skill", () => {
    expect(index.entry).toEqual({ name: "triage-ml-task", source: "inferred" });
  });

  it("prefers an entry declared in the frontmatter over the inferred one", () => {
    const declared = PACK.map((s) => (s.name === "setup-ml-project" ? { ...s, metadata: { role: "entry" } } : s));
    expect(buildSkillIndex(declared).entry).toEqual({ name: "setup-ml-project", source: "frontmatter" });
  });

  it("collects declared roles", () => {
    const declared = PACK.map((s) => (s.name === "persist-ml-git" ? { ...s, metadata: { role: "helper" } } : s));
    expect(buildSkillIndex(declared).declaredRoles.get("persist-ml-git")).toBe("helper");
  });

  it("works with descriptions only and with no skills", () => {
    const bare = buildSkillIndex(PACK.map(({ body: _body, ...s }) => s));
    expect(rankSkills(bare, "profile the raw data")[0].name).toBe("explore-ml-data");
    expect(rankSkills(buildSkillIndex([]), "anything")).toEqual([]);
  });
});

describe("rankSkills", () => {
  const index = buildSkillIndex(PACK);

  it.each([
    ["I would like to explore the data", "explore-ml-data"],
    ["profiling the columns", "explore-ml-data"],
    ["evaluate with cross-validation", "evaluate-ml-pipeline"],
    ["bootstrap a new project with pixi", "setup-ml-project"],
    ["draw a chart with matplotlib", "plot-ml-figure"],
    ["commit this with git", "persist-ml-git"],
  ])("%s → %s", (prompt, expected) => {
    expect(rankSkills(index, prompt)[0].name).toBe(expected);
  });

  it("lets a rare term outweigh a term shared by many skills", () => {
    // "pipeline" appears in three skills, "skrub" in one.
    expect(rankSkills(index, "pipeline with skrub")[0].name).toBe("build-ml-pipeline");
  });

  it("reports the matched terms, best first", () => {
    const [best] = rankSkills(index, "explore the data");
    expect(best.matched.slice(0, 2).sort()).toEqual(["explor", "explor_data"]);
    expect(best.matched).toContain("data");
  });

  it("scores every skill and gives 0 to skills without a match", () => {
    const ranking = rankSkills(index, "matplotlib");
    expect(ranking).toHaveLength(PACK.length);
    expect(ranking.filter((r) => r.score > 0).map((r) => r.name)).toEqual(["plot-ml-figure"]);
  });

  it("counts a repeated query word once", () => {
    expect(rankSkills(index, "git git git git")[0].score).toBe(rankSkills(index, "git")[0].score);
  });
});

describe("decideRelevance", () => {
  const index = buildSkillIndex(PACK);

  it("abstains when the prompt carries no topic signal", () => {
    const d = decideRelevance(index, "please fix it", OPTIONS);
    expect(d.abstain).toBe(true);
    expect(PACK.every((s) => d.relevant(s.name))).toBe(true);
    expect(d.explain("explore-ml-data")).toContain("no topic signal");
  });

  it("keeps the top K skills that matched", () => {
    const d = decideRelevance(index, "explore the data", { ...OPTIONS, topK: 1, relativeScore: 2 });
    expect(PACK.filter((s) => d.relevant(s.name)).map((s) => s.name)).toEqual(["explore-ml-data"]);
  });

  it("keeps skills scoring a fraction of the best one beyond the top K", () => {
    const d = decideRelevance(index, "the ml pipeline", { ...OPTIONS, topK: 0, relativeScore: 0.5 });
    // "pipeline" is shared by build and evaluate equally.
    expect(d.relevant("build-ml-pipeline")).toBe(true);
    expect(d.relevant("evaluate-ml-pipeline")).toBe(true);
    expect(d.relevant("plot-ml-figure")).toBe(false);
  });

  it("never treats a skill without a match as relevant, whatever its rank", () => {
    const d = decideRelevance(index, "matplotlib", { ...OPTIONS, topK: 10, minSignal: 0 });
    expect(d.relevant("persist-ml-git")).toBe(false);
    expect(d.explain("persist-ml-git")).toBe("no match");
  });

  it("excludes skills from the ranking", () => {
    const d = decideRelevance(index, "explore the data", OPTIONS, new Set(["explore-ml-data"]));
    expect(names(d.ranking)).not.toContain("explore-ml-data");
  });

  it("explains rank, share of the best score, and matched terms", () => {
    const d = decideRelevance(index, "explore the data", OPTIONS);
    expect(d.explain("explore-ml-data")).toMatch(/^rank 1\/7, 100% of best \(explor/);
  });
});

// ── calledSkills ──────────────────────────────────────────────────

describe("calledSkills", () => {
  const names = ["build-ml-pipeline", "setup-git", "plot-ml-figure", "persist-ml-git"];
  const called = (body: string) => [...calledSkills(body, "self", names)].sort();

  it("drops a prohibition, also when the sentence wraps across lines", () => {
    // Shapes from the probabl pack (frame-ml-problem, model-ml-pipeline).
    const body = "Do not\n   load `build-ml-pipeline`. Stop this turn. Then load `plot-ml-figure`.";
    expect(called(body)).toEqual(["plot-ml-figure"]);
    expect([...mentionedSkills(body, "self", names)].sort()).toEqual(["build-ml-pipeline", "plot-ml-figure"]);
  });

  it("keeps a call behind a condition or an exception", () => {
    expect(called("If it is not installed, load `setup-git`.")).toEqual(["setup-git"]);
    expect(called("Do not commit except by loading `setup-git`.")).toEqual(["setup-git"]);
  });

  it("drops only the prohibited name in a mixed sentence", () => {
    expect(called("Do not load `build-ml-pipeline` but load `plot-ml-figure`.")).toEqual(["plot-ml-figure"]);
  });

  it("recognises the other negations and verbs", () => {
    for (const body of ["Never load setup-git.", "You must not call `setup-git`.", "Don't use 'setup-git' here."]) {
      expect(called(body)).toEqual([]);
    }
  });

  it("is exposed on the index next to the mentions", () => {
    const index = buildSkillIndex([
      { name: "a-skill", description: "First.", body: "Load `b-skill`. Do not load `c-skill`." },
      { name: "b-skill", description: "Second." },
      { name: "c-skill", description: "Third." },
    ]);
    expect([...index.refs.get("a-skill")!].sort()).toEqual(["b-skill", "c-skill"]);
    expect([...index.calls.get("a-skill")!]).toEqual(["b-skill"]);
  });
});
