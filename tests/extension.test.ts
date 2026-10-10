/**
 * Integration tests for the extension entry point.
 *
 * The extension is driven through a fake `ExtensionAPI`, but the system prompt
 * is rendered with Pi's real builder and section differ so the assertions
 * reflect what Pi actually sends to the model.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, Skill as PiSkill } from "@earendil-works/pi-coding-agent";
// Not part of Pi's public exports; imported by path so the tests use the real
// prompt builder rather than a re-implementation.
import {
  buildSystemPromptSections,
  diffSystemPromptSections,
  normalizeBuildSystemPromptOptions,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import extension from "../extensions/index.ts";
import { PACK } from "./fixtures.ts";

// ── Fixtures ──────────────────────────────────────────────────────

type Handler = (event: any, ctx: any) => any;

interface SkillSpec {
  name: string;
  description: string;
  body?: string;
  disableModelInvocation?: boolean;
  /** Extra frontmatter lines, e.g. "metadata:\n  role: helper". */
  frontmatter?: string;
}

function writeSkills(root: string, specs: SkillSpec[]): PiSkill[] {
  return specs.map((spec) => {
    const baseDir = join(root, ".agents", "skills", spec.name);
    mkdirSync(join(baseDir, "references"), { recursive: true });
    const filePath = join(baseDir, "SKILL.md");
    writeFileSync(
      filePath,
      `---\nname: ${spec.name}\ndescription: ${JSON.stringify(spec.description)}\n${spec.frontmatter ? `${spec.frontmatter}\n` : ""}---\n\n${spec.body ?? `Body of ${spec.name}.`}\n`,
    );
    writeFileSync(join(baseDir, "references", "notes.md"), "notes");
    return {
      name: spec.name,
      description: spec.description,
      filePath,
      baseDir,
      sourceInfo: { path: filePath, source: "project", scope: "project", origin: "top-level" } as any,
      disableModelInvocation: spec.disableModelInvocation ?? false,
    };
  });
}

const SPECS: SkillSpec[] = [
  { name: "triage-ml-task", description: "Route an ambiguous request to the right skill." },
  { name: "explore-ml-data", description: "Explore and profile the data before modelling." },
  { name: "setup-ml-project", description: "Set up and bootstrap a new ML workspace." },
  { name: "build-ml-pipeline", description: "Build a skrub pipeline for the predictor." },
  { name: "plot-ml-figure", description: "Pick how to draw a chart before custom plot code." },
  { name: "hidden-skill", description: "Only invoked by an explicit command.", disableModelInvocation: true },
];

/** Models the fake registry knows about, keyed "provider/modelId". */
const REGISTRY_KEYS = [
  "openrouter/moonshotai/kimi-k2.6",
  "openrouter/deepseek/deepseek-v4.1-flash",
  "openrouter/qwen/qwen3.7-flash",
  "openrouter/z-ai/glm-5.3",
];

function fakeModel(provider: string, id: string) {
  return { provider, id, name: id };
}

function modelFromKey(key: string) {
  const index = key.indexOf("/");
  return fakeModel(key.slice(0, index), key.slice(index + 1));
}

function createHarness(
  cwd: string,
  skills: PiSkill[],
  activeTools = ["read", "bash", "edit", "write", "skill"],
  trusted = true,
  initialModel = REGISTRY_KEYS[0],
) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const notifications: string[] = [];
  const entries: Array<{ customType: string; data: any }> = [];
  const entryRenderers = new Map<string, any>();
  let branch: any[] = [];
  let previousSections: Record<string, string> | undefined;
  let callCounter = 0;
  // Model-tier state: a registry the extension can resolve against, and the
  // calls it makes. `deny` models a provider without credentials.
  const registry = new Map<string, any>(REGISTRY_KEYS.map((key) => [key, modelFromKey(key)]));
  const deny = new Set<string>();
  // Like Pi: setModel can throw after the auth pre-check, can be slow, re-applies
  // the default thinking level on a switch, and levels are clamped per model.
  const failSetModel = new Set<string>();
  const setModelDelay = new Map<string, number>();
  const thinkingClamp = new Map<string, string[]>();
  const clampFor = (key: string, level: string) => {
    const allowed = thinkingClamp.get(key);
    return !allowed || allowed.includes(level) ? level : allowed[allowed.length - 1];
  };
  const modelCalls: Array<{ provider: string; id: string }> = [];
  const thinkingCalls: string[] = [];
  let thinkingLevel = "medium";

  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
    getActiveTools: () => activeTools,
    setModel: async (model: any) => {
      const key = `${model.provider}/${model.id}`;
      if (deny.has(key)) return false;
      const delay = setModelDelay.get(key);
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (failSetModel.has(key)) throw new Error(`No API key for ${key}`);
      const previousModel = ctx.model;
      ctx.model = model;
      modelCalls.push({ provider: model.provider, id: model.id });
      thinkingLevel = clampFor(key, "medium");
      await emit("model_select", { type: "model_select", model, previousModel, source: "set" });
      return true;
    },
    getThinkingLevel: () => thinkingLevel,
    setThinkingLevel: (level: string) => {
      thinkingLevel = clampFor(`${ctx.model.provider}/${ctx.model.id}`, level);
      thinkingCalls.push(level);
    },
    appendEntry: (customType: string, data?: unknown) => {
      entries.push({ customType, data });
    },
    registerEntryRenderer: (customType: string, renderer: any) => {
      entryRenderers.set(customType, renderer);
    },
  } as unknown as ExtensionAPI;

  extension(pi);

  const ctx: any = {
    cwd,
    hasUI: true,
    mode: "tui",
    ui: { notify: (message: string) => notifications.push(message) },
    sessionManager: { getBranch: () => branch },
    isProjectTrusted: () => trusted,
    modelRegistry: { find: (provider: string, id: string) => registry.get(`${provider}/${id}`) },
    model: registry.get(initialModel) ?? modelFromKey(initialModel),
  };

  async function emit(event: string, payload: any) {
    let result: any;
    for (const handler of handlers.get(event) ?? []) {
      const value = await handler(payload, ctx);
      if (value !== undefined) result = value;
    }
    return result;
  }

  /** Emulate one user prompt: fresh options per run, exactly like Pi. */
  async function prompt(text: string) {
    const options = normalizeBuildSystemPromptOptions({
      cwd,
      selectedTools: activeTools,
      skills,
    });
    await emit("before_agent_start", {
      type: "before_agent_start",
      prompt: text,
      systemPrompt: "",
      systemPromptOptions: options,
    });
    const sections = buildSystemPromptSections(options);
    const patch = previousSections ? diffSystemPromptSections(previousSections, sections) : undefined;
    previousSections = sections;
    return { sections, patch };
  }

  /** Call the `skill` tool and return a transcript tool-result message. */
  async function loadSkill(name: string) {
    const toolCallId = `call-${++callCounter}`;
    const result = await tools.get("skill").execute(toolCallId, { name }, undefined, undefined, ctx);
    return {
      role: "toolResult",
      toolCallId,
      toolName: "skill",
      content: result.content,
      isError: false,
      timestamp: Date.now(),
    };
  }

  async function context(messages: any[]) {
    const result = await emit("context", { type: "context", messages });
    return result?.messages ?? messages;
  }

  return {
    pi,
    ctx,
    tools,
    commands,
    notifications,
    entries,
    entryRenderers,
    modelCalls,
    thinkingCalls,
    registry,
    deny,
    failSetModel,
    setModelDelay,
    thinkingClamp,
    getModel: () => ctx.model,
    thinkingLevel: () => thinkingLevel,
    emit,
    prompt,
    loadSkill,
    context,
    setBranch: (entries: any[]) => {
      branch = entries;
    },
  };
}

function textOf(message: any): string {
  return message.content.map((block: any) => block.text ?? "").join("");
}

function isPlaceholder(message: any): boolean {
  return textOf(message).includes("Skill body archived");
}

// ── Tests ─────────────────────────────────────────────────────────

let root: string;
let agentDir: string;
let skills: PiSkill[];
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-lifecycle-"));
  // Isolate from the developer's real ~/.pi/agent.
  agentDir = mkdtempSync(join(tmpdir(), "skill-lifecycle-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  skills = writeSkills(root, SPECS);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

function writeProjectConfig(config: object) {
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi", "skill-lifecycle.json"), JSON.stringify(config));
}

async function startSession(config?: object, activeTools?: string[], trusted = true, withSkills = skills) {
  if (config) writeProjectConfig(config);
  const harness = createHarness(root, withSkills, activeTools, trusted);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  return harness;
}

describe("system prompt", () => {
  it("lists model-invocable skills once, without double-wrapped tags", async () => {
    const h = await startSession();
    const { sections } = await h.prompt("hello");
    const skillsSection = sections.skills;

    expect(skillsSection.startsWith("<skills>\n")).toBe(true);
    expect(skillsSection).not.toMatch(/<skills>\s*<skills>/);
    expect(skillsSection.match(/<available_skills>/g)).toHaveLength(1);
    expect(skillsSection).toContain("<name>explore-ml-data</name>");
    expect(skillsSection).not.toContain("hidden-skill");
    expect(skillsSection).not.toContain("Body of explore-ml-data");
    expect(skillsSection).toContain("skill tool");
    // The default "use the read tool to load a skill" instruction is replaced.
    expect(skillsSection).not.toContain("Use the read tool to load a skill's file");
    expect(Object.keys(sections).filter((name) => name.includes("skill"))).toEqual(["skills"]);
  });

  it("keeps the skill section identical across turns (no removal patch)", async () => {
    const h = await startSession();
    await h.prompt("explore the data please");
    const second = await h.prompt("now build a pipeline for the predictor");
    expect(second.patch).toBeUndefined();
  });

  it("mentions the entry skill only when it is configured and installed", async () => {
    const withEntry = await startSession({ entrySkill: "triage-ml-task" });
    expect((await withEntry.prompt("hi")).sections.skills).toContain('skill("triage-ml-task")');

    const missingEntry = await startSession({ entrySkill: "does-not-exist" });
    expect((await missingEntry.prompt("hi")).sections.skills).not.toContain("does-not-exist");

    rmSync(join(root, ".pi", "skill-lifecycle.json"));
    const noEntry = await startSession();
    expect((await noEntry.prompt("hi")).sections.skills).not.toContain("triage-ml-task\")");
  });

  it("keeps Pi's default listing when the skill tool is not active", async () => {
    const h = await startSession(undefined, ["read", "bash"]);
    const { sections } = await h.prompt("hello");
    expect(sections.skills).toContain("Use the read tool to load a skill's file");
    const blocked = await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "t0",
      toolName: "read",
      input: { path: ".agents/skills/explore-ml-data/SKILL.md" },
    });
    expect(blocked?.block).toBeFalsy();
  });
});

describe("skill tool", () => {
  it("returns the body wrapped in <skill_content> with base directory and files", async () => {
    const h = await startSession();
    await h.prompt("explore the data");
    const message = await h.loadSkill("explore-ml-data");
    const text = textOf(message);
    expect(text).toContain('<skill_content name="explore-ml-data">');
    expect(text).toContain("Body of explore-ml-data.");
    expect(text).toContain(`Base directory for this skill: ${join(root, ".agents", "skills", "explore-ml-data")}`);
    expect(text).toContain("references/");
    // Frontmatter is already in the prompt listing; do not pay for it twice.
    expect(text).not.toContain("description: Explore and profile");
  });

  it("throws for unknown and command-only skills so Pi marks the result as an error", async () => {
    const h = await startSession();
    await h.prompt("hello");
    await expect(h.loadSkill("nope")).rejects.toThrow(/not found/);
    await expect(h.loadSkill("hidden-skill")).rejects.toThrow(/\/skill:hidden-skill/);
  });
});

describe("context handler", () => {
  it("keeps only the latest copy of a skill body that was loaded twice", async () => {
    const h = await startSession();
    await h.prompt("explore the data");
    const first = await h.loadSkill("explore-ml-data");
    const second = await h.loadSkill("explore-ml-data");
    const out = await h.context([first, second]);
    expect(isPlaceholder(out[0])).toBe(true);
    expect(isPlaceholder(out[1])).toBe(false);
  });

  it("only rewrites results of the skill tool", async () => {
    const h = await startSession();
    await h.prompt("explore the data");
    const readResult = {
      role: "toolResult",
      toolCallId: "r1",
      toolName: "read",
      content: [{ type: "text", text: '<skill_content name="explore-ml-data"> quoted in a file' }],
      isError: false,
      timestamp: 0,
    };
    const out = await h.context([readResult]);
    expect(out[0]).toBe(readResult);
  });

  it("does nothing when eviction is disabled", async () => {
    const h = await startSession();
    await h.commands.get("skills-off").handler("", h.ctx);
    await h.prompt("explore the data");
    const first = await h.loadSkill("explore-ml-data");
    const second = await h.loadSkill("explore-ml-data");
    const out = await h.context([first, second]);
    expect(out.some(isPlaceholder)).toBe(false);
  });
});

describe("eviction", () => {
  it("does not evict the skill being worked on when the user answers its questions", async () => {
    const h = await startSession();
    await h.prompt("set up the project");
    const body = await h.loadSkill("setup-ml-project");
    // A reply to the skill's own questions shares no keywords with it.
    await h.prompt("use pixi and call the package housing please");
    const out = await h.context([body]);
    expect(isPlaceholder(out[0])).toBe(false);
  });

  it("evicts older irrelevant bodies beyond minKeep", async () => {
    const h = await startSession({ minKeep: 1 });
    await h.prompt("explore the data");
    const explore = await h.loadSkill("explore-ml-data");
    await h.prompt("set up the project workspace");
    const setup = await h.loadSkill("setup-ml-project");
    await h.prompt("bootstrap and scaffold the new project workspace");
    const out = await h.context([explore, setup]);
    expect(isPlaceholder(out[0])).toBe(true);
    expect(isPlaceholder(out[1])).toBe(false);
  });

  it("never evicts pinned bodies", async () => {
    const h = await startSession({ minKeep: 0 });
    await h.commands.get("skills-pin").handler("explore-ml-data", h.ctx);
    await h.prompt("explore the data");
    const explore = await h.loadSkill("explore-ml-data");
    await h.prompt("bootstrap and scaffold the new project workspace");
    const out = await h.context([explore]);
    expect(isPlaceholder(out[0])).toBe(false);
  });

  it("archives an unrelated body when another skill is loaded later in the same run", async () => {
    const h = await startSession();
    await h.prompt("explore the data");
    const explore = await h.loadSkill("explore-ml-data");
    await h.emit("turn_end", { type: "turn_end", toolResults: [explore] });
    // ask_user_question answer redirects the work; no new user prompt.
    const setup = await h.loadSkill("setup-ml-project");
    await h.emit("turn_end", { type: "turn_end", toolResults: [setup] });
    const out = await h.context([explore, setup]);
    expect(isPlaceholder(out[0])).toBe(true);
    expect(isPlaceholder(out[1])).toBe(false);
  });

  it("keeps skills loaded together in one turn", async () => {
    const h = await startSession();
    await h.prompt("explore the data");
    const explore = await h.loadSkill("explore-ml-data");
    const setup = await h.loadSkill("setup-ml-project");
    await h.emit("turn_end", { type: "turn_end", toolResults: [explore, setup] });
    const out = await h.context([explore, setup]);
    expect(out.some(isPlaceholder)).toBe(false);
  });

  it("keeps pinned bodies and related bodies on mid-run loads", async () => {
    const h = await startSession({
      rules: [{ skillName: "explore-ml-data", keywords: ["workspace"] }],
    });
    await h.commands.get("skills-pin").handler("triage-ml-task", h.ctx);
    await h.prompt("what should I do");
    const triage = await h.loadSkill("triage-ml-task");
    const explore = await h.loadSkill("explore-ml-data");
    await h.emit("turn_end", { type: "turn_end", toolResults: [triage, explore] });
    const setup = await h.loadSkill("setup-ml-project");
    await h.emit("turn_end", { type: "turn_end", toolResults: [setup] });
    const out = await h.context([triage, explore, setup]);
    expect(out.some(isPlaceholder)).toBe(false);
  });

  it("can disable mid-run eviction in the config", async () => {
    const h = await startSession({ evictOnSkillLoad: false });
    await h.prompt("explore the data");
    const explore = await h.loadSkill("explore-ml-data");
    const setup = await h.loadSkill("setup-ml-project");
    await h.emit("turn_end", { type: "turn_end", toolResults: [setup] });
    const out = await h.context([explore, setup]);
    expect(out.some(isPlaceholder)).toBe(false);
  });

  it("keeps the calling skill when a helper skill is loaded mid-run", async () => {
    const h = await startSession({ helperSkills: ["plot-ml-figure"] });
    await h.prompt("explore the data");
    const explore = await h.loadSkill("explore-ml-data");
    await h.emit("turn_end", { type: "turn_end", toolResults: [explore] });
    const plot = await h.loadSkill("plot-ml-figure");
    await h.emit("turn_end", { type: "turn_end", toolResults: [plot] });
    const out = await h.context([explore, plot]);
    expect(out.some(isPlaceholder)).toBe(false);
  });

  it("archives the helper and the caller when a non-helper skill is loaded next", async () => {
    const h = await startSession({ helperSkills: ["plot-ml-figure"] });
    await h.prompt("explore the data");
    const explore = await h.loadSkill("explore-ml-data");
    await h.emit("turn_end", { type: "turn_end", toolResults: [explore] });
    const plot = await h.loadSkill("plot-ml-figure");
    await h.emit("turn_end", { type: "turn_end", toolResults: [plot] });
    const setup = await h.loadSkill("setup-ml-project");
    await h.emit("turn_end", { type: "turn_end", toolResults: [setup] });
    const out = await h.context([explore, plot, setup]);
    expect(out.map(isPlaceholder)).toEqual([true, true, false]);
  });

  it("without helperSkills, a helper load archives the calling skill", async () => {
    const h = await startSession();
    await h.prompt("explore the data");
    const explore = await h.loadSkill("explore-ml-data");
    await h.emit("turn_end", { type: "turn_end", toolResults: [explore] });
    const plot = await h.loadSkill("plot-ml-figure");
    await h.emit("turn_end", { type: "turn_end", toolResults: [plot] });
    const out = await h.context([explore, plot]);
    expect(isPlaceholder(out[0])).toBe(true);
  });

  it("pins the entry skill so the model does not have to reload it after each stage", async () => {
    const h = await startSession({ entrySkill: "triage-ml-task", minKeep: 0 });
    await h.prompt("what should I do");
    const triage = await h.loadSkill("triage-ml-task");
    await h.emit("turn_end", { type: "turn_end", toolResults: [triage] });
    const setup = await h.loadSkill("setup-ml-project");
    await h.emit("turn_end", { type: "turn_end", toolResults: [setup] });
    await h.prompt("bootstrap and scaffold the new project workspace");
    const out = await h.context([triage, setup]);
    expect(out.some(isPlaceholder)).toBe(false);
  });

  it("can stop pinning the entry skill", async () => {
    const h = await startSession({ entrySkill: "triage-ml-task", pinEntrySkill: false });
    await h.prompt("what should I do");
    const triage = await h.loadSkill("triage-ml-task");
    await h.emit("turn_end", { type: "turn_end", toolResults: [triage] });
    const setup = await h.loadSkill("setup-ml-project");
    await h.emit("turn_end", { type: "turn_end", toolResults: [setup] });
    const out = await h.context([triage, setup]);
    expect(isPlaceholder(out[0])).toBe(true);
  });

  it("explains that the entry skill pin comes from the config", async () => {
    const h = await startSession({ entrySkill: "triage-ml-task" });
    await h.commands.get("skills-unpin").handler("triage-ml-task", h.ctx);
    expect(h.notifications.at(-1)).toContain("pinEntrySkill");
  });

  it("restores loaded bodies from the session branch on resume", async () => {
    const first = await startSession();
    await first.prompt("explore the data");
    const body = await first.loadSkill("explore-ml-data");

    const resumed = createHarness(root, skills);
    resumed.setBranch([{ type: "message", id: "e1", message: body }]);
    await resumed.emit("session_start", { type: "session_start", reason: "resume" });
    await resumed.prompt("ok");
    const out = await resumed.context([body]);
    expect(isPlaceholder(out[0])).toBe(false);
  });
});

describe("direct SKILL.md reads", () => {
  it("blocks reading a known SKILL.md and points to the skill tool", async () => {
    const h = await startSession();
    await h.prompt("explore the data");
    const result = await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "t1",
      toolName: "read",
      input: { path: ".agents/skills/explore-ml-data/SKILL.md" },
    });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('skill("explore-ml-data")');
  });

  it("allows reading files referenced by a skill", async () => {
    const h = await startSession();
    await h.prompt("explore the data");
    const result = await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "t2",
      toolName: "read",
      input: { path: join(root, ".agents", "skills", "explore-ml-data", "references", "notes.md") },
    });
    expect(result?.block).toBeFalsy();
  });

  it("can be turned off in the config", async () => {
    const h = await startSession({ blockDirectSkillReads: false });
    await h.prompt("explore the data");
    const result = await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "t3",
      toolName: "read",
      input: { path: ".agents/skills/explore-ml-data/SKILL.md" },
    });
    expect(result?.block).toBeFalsy();
  });
});

describe("config location", () => {
  it("reads the user config from the agent directory", async () => {
    writeFileSync(join(agentDir, "skill-lifecycle.json"), JSON.stringify({ entrySkill: "triage-ml-task" }));
    const h = await startSession();
    expect((await h.prompt("hi")).sections.skills).toContain('skill("triage-ml-task")');
  });

  it("lets the project .pi config override the user config key by key", async () => {
    writeFileSync(
      join(agentDir, "skill-lifecycle.json"),
      JSON.stringify({ entrySkill: "triage-ml-task", blockDirectSkillReads: false }),
    );
    const h = await startSession({ entrySkill: "setup-ml-project" });
    const { sections } = await h.prompt("explore the data");
    expect(sections.skills).toContain('skill("setup-ml-project")');
    expect(sections.skills).not.toContain('skill("triage-ml-task")');
    // Not overridden by the project file, so the user value still applies.
    const result = await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "c1",
      toolName: "read",
      input: { path: ".agents/skills/explore-ml-data/SKILL.md" },
    });
    expect(result?.block).toBeFalsy();
  });

  it("ignores the project config until the project is trusted, and says so", async () => {
    const h = await startSession({ entrySkill: "triage-ml-task" }, undefined, false);
    expect((await h.prompt("hi")).sections.skills).not.toContain('skill("triage-ml-task")');
    expect(h.notifications.some((n) => n.includes("ignored until the project is trusted"))).toBe(true);
  });

  it("no longer reads skill-lifecycle.json from the working directory root", async () => {
    writeFileSync(join(root, "skill-lifecycle.json"), JSON.stringify({ entrySkill: "triage-ml-task" }));
    const h = await startSession();
    expect((await h.prompt("hi")).sections.skills).not.toContain('skill("triage-ml-task")');
  });

  it("reports an invalid config file and falls back to defaults", async () => {
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(join(root, ".pi", "skill-lifecycle.json"), "{ not json");
    const h = await startSession();
    await h.prompt("hi");
    expect(h.notifications.some((n) => n.includes("ignoring invalid"))).toBe(true);
  });

  it("lists the config sources in /skills-list", async () => {
    writeFileSync(join(agentDir, "skill-lifecycle.json"), "{}");
    const h = await startSession({ minKeep: 1 });
    await h.prompt("hi");
    await h.commands.get("skills-list").handler("", h.ctx);
    const listing = h.notifications.at(-1)!;
    expect(listing).toContain(join(agentDir, "skill-lifecycle.json"));
    expect(listing).toContain(join(root, ".pi", "skill-lifecycle.json"));
  });

  it("marks helper skills in /skills-list", async () => {
    const h = await startSession({ helperSkills: ["plot-ml-figure"] });
    await h.prompt("hi");
    await h.commands.get("skills-list").handler("", h.ctx);
    const listing = h.notifications.at(-1)!;
    expect(listing).toContain("plot-ml-figure 🧩");
    expect(listing).not.toContain("explore-ml-data 🧩");
  });
});

// ── Derived roles and relevance (no config) ───────────────────────

describe("derived from the installed skills", () => {
  const packSpecs = (overrides: Record<string, Partial<SkillSpec>> = {}): SkillSpec[] =>
    PACK.map((s) => ({ name: s.name, description: s.description, body: s.body, ...overrides[s.name] }));
  const startPack = (config?: object, overrides?: Record<string, Partial<SkillSpec>>) => {
    rmSync(join(root, ".agents"), { recursive: true, force: true });
    const pack = writeSkills(root, packSpecs(overrides));
    return { pack, session: startSession(config, undefined, true, pack) };
  };

  it("infers the entry skill from cross-references and names it in the prompt", async () => {
    const h = await startPack().session;
    const { sections } = await h.prompt("hello there");
    expect(sections.skills).toContain('skill("triage-ml-task")');
  });

  it("pins the inferred entry skill", async () => {
    const h = await startPack({ minKeep: 0 }).session;
    await h.prompt("what should I do next");
    const triage = await h.loadSkill("triage-ml-task");
    await h.emit("turn_end", { type: "turn_end", toolResults: [triage] });
    const setup = await h.loadSkill("setup-ml-project");
    await h.emit("turn_end", { type: "turn_end", toolResults: [setup] });
    const out = await h.context([triage, setup]);
    expect(out.some(isPlaceholder)).toBe(false);
  });

  it("does not infer an entry skill when inference is off", async () => {
    const h = await startPack({ inferEntrySkill: false }).session;
    expect((await h.prompt("hello there")).sections.skills).not.toContain('skill("triage-ml-task")');
  });

  it("uses an entry skill declared in the frontmatter", async () => {
    const h = await startPack(undefined, { "setup-ml-project": { frontmatter: "metadata:\n  role: entry" } }).session;
    const { sections } = await h.prompt("hello there");
    expect(sections.skills).toContain('skill("setup-ml-project")');
    expect(sections.skills).not.toContain('skill("triage-ml-task")');
  });

  it("archives the caller on a mid-run load unless the loaded skill declares itself a helper", async () => {
    for (const [overrides, archived] of [
      [{}, true],
      [{ "persist-ml-git": { frontmatter: "metadata:\n  role: helper" } }, false],
    ] as const) {
      const h = await startPack(undefined, overrides).session;
      await h.prompt("explore the data");
      const explore = await h.loadSkill("explore-ml-data");
      await h.emit("turn_end", { type: "turn_end", toolResults: [explore] });
      const persist = await h.loadSkill("persist-ml-git");
      await h.emit("turn_end", { type: "turn_end", toolResults: [persist] });
      const out = await h.context([explore, persist]);
      expect(isPlaceholder(out[0])).toBe(archived);
    }
  });

  it("with protectLoader, keeps the body that loaded the new skill", async () => {
    const h = await startPack({ protectLoader: true }).session;
    await h.prompt("explore the data");
    const explore = await h.loadSkill("explore-ml-data");
    await h.emit("turn_end", { type: "turn_end", toolResults: [explore] });
    const persist = await h.loadSkill("persist-ml-git");
    await h.emit("turn_end", { type: "turn_end", toolResults: [persist] });
    const out = await h.context([explore, persist]);
    expect(isPlaceholder(out[0])).toBe(false);
  });

  it("says when an evicted body dispatched to the skill that replaced it", async () => {
    // explore-ml-data's body says "When done, load `persist-ml-git`".
    const h = await startPack().session;
    await h.prompt("explore the data");
    const explore = await h.loadSkill("explore-ml-data");
    await h.emit("turn_end", { type: "turn_end", toolResults: [explore] });
    const persist = await h.loadSkill("persist-ml-git");
    await h.emit("turn_end", { type: "turn_end", toolResults: [persist] });

    const notice = h.notifications.filter((n) => n.includes("Archived skill bodies")).at(-1)!;
    expect(notice).toContain("explore-ml-data");
    expect(notice).toContain("this body calls persist-ml-git");
    expect(notice).toContain("metadata.role: helper");
    // The same reason reaches headless runs through the session entry.
    const record = h.entries.filter((e) => e.customType === "skill-lifecycle").at(-1)!;
    const reasons = record.data.archived.map((b: any) => b.reason).join("\n");
    expect(reasons).toContain("metadata.role: helper");
  });

  it("keeps the caller when the loaded skill is related to it", async () => {
    const h = await startPack().session;
    await h.prompt("explore the data");
    const explore = await h.loadSkill("explore-ml-data");
    await h.emit("turn_end", { type: "turn_end", toolResults: [explore] });
    // Build and evaluate share "pipeline"; explore shares nothing with evaluate.
    const build = await h.loadSkill("build-ml-pipeline");
    await h.emit("turn_end", { type: "turn_end", toolResults: [build] });
    const evaluate = await h.loadSkill("evaluate-ml-pipeline");
    await h.emit("turn_end", { type: "turn_end", toolResults: [evaluate] });
    const out = await h.context([explore, build, evaluate]);
    expect(out.map(isPlaceholder)).toEqual([true, false, false]);
  });

  it("evicts nothing for relevance when the prompt carries no topic signal", async () => {
    const h = await startPack({ minKeep: 0 }).session;
    await h.prompt("explore the data");
    const explore = await h.loadSkill("explore-ml-data");
    await h.prompt("the frobnicator broke yesterday");
    expect(isPlaceholder((await h.context([explore]))[0])).toBe(false);
    await h.prompt("now bootstrap a new project with pixi");
    expect(isPlaceholder((await h.context([explore]))[0])).toBe(true);
  });

  it("rebuilds the index when a SKILL.md changes", async () => {
    const { pack, session } = startPack();
    const h = await session;
    await h.prompt("hello there");
    await h.commands.get("skills-list").handler("", h.ctx);
    expect(h.notifications.at(-1)).not.toContain("persist-ml-git 🧩");

    const persist = pack.find((s) => s.name === "persist-ml-git")!;
    writeFileSync(persist.filePath, `---\nname: persist-ml-git\ndescription: ${persist.description}\nmetadata:\n  role: helper\n---\n\nRun git commit.\n`);
    const later = new Date(Date.now() + 5000);
    utimesSync(persist.filePath, later, later);
    await h.prompt("commit this with git");
    await h.commands.get("skills-list").handler("", h.ctx);
    expect(h.notifications.at(-1)).toContain("persist-ml-git 🧩 (frontmatter)");
  });

  it("shows roles and their source in /skills-list", async () => {
    const h = await startPack({ helperSkills: ["plot-ml-figure"] }).session;
    await h.prompt("hello there");
    await h.commands.get("skills-list").handler("", h.ctx);
    const listing = h.notifications.at(-1)!;
    expect(listing).toContain("triage-ml-task 📌 🚪 (inferred)");
    expect(listing).toContain("plot-ml-figure 🧩 (config)");
  });

  it("/skills-explain ranks the skills and explains each loaded body", async () => {
    const h = await startPack({ minKeep: 0 }).session;
    await h.prompt("explore the data");
    await h.loadSkill("explore-ml-data");
    await h.loadSkill("setup-ml-project");
    await h.commands.get("skills-explain").handler("draw a chart with matplotlib", h.ctx);
    const text = h.notifications.at(-1)!;
    expect(text).toContain("Entry skill: triage-ml-task (inferred)");
    expect(text).toMatch(/✓ plot-ml-figure\s+\d/);
    expect(text).toMatch(/setup-ml-project — archived: no match/);

    await h.commands.get("skills-explain").handler("the frobnicator broke", h.ctx);
    expect(h.notifications.at(-1)).toContain("nothing would be archived");
  });

  it("/skills-explain without a prompt shows roles and usage", async () => {
    const h = await startPack().session;
    await h.commands.get("skills-explain").handler("", h.ctx);
    expect(h.notifications.at(-1)).toContain("No skills known yet");
    await h.prompt("hello there");
    await h.commands.get("skills-explain").handler("", h.ctx);
    expect(h.notifications.at(-1)).toContain("Usage: /skills-explain <prompt>");
  });
});

// ── Model tiers ───────────────────────────────────────────────────

describe("model tiers", () => {
  const TIER_CONFIG = {
    models: {
      tiers: {
        small: { provider: "openrouter", model: "qwen/qwen3.7-flash", thinkingLevel: "low" },
        medium: { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" },
        big: { provider: "openrouter", model: "z-ai/glm-5.3", thinkingLevel: "max", scope: "run" },
      },
      default: "medium",
    },
  };

  const EXTRA_SPECS: SkillSpec[] = [
    { name: "big-skill", description: "Do the hardest work.", frontmatter: "metadata:\n  modelTier: big" },
    { name: "small-skill", description: "Do the mechanical work.", frontmatter: "metadata:\n  modelTier: small" },
    { name: "opt-out-skill", description: "Keep whatever model is current.", frontmatter: "metadata:\n  modelTier: none" },
  ];

  let tierSkills: PiSkill[];
  beforeEach(() => {
    tierSkills = writeSkills(root, [...SPECS, ...EXTRA_SPECS]);
  });

  const start = (config: object = TIER_CONFIG, withSkills: PiSkill[] = tierSkills) =>
    startSession(config, undefined, true, withSkills);

  it("switches to the tier a skill declares in its frontmatter", async () => {
    const h = await start();
    await h.prompt("do the hardest work");
    await h.loadSkill("big-skill");
    expect(h.modelCalls).toEqual([{ provider: "openrouter", id: "z-ai/glm-5.3" }]);
    expect(h.thinkingCalls).toEqual(["max"]);
    expect(h.getModel().id).toBe("z-ai/glm-5.3");
    expect(h.notifications.some((n) => n.includes('tier "big"'))).toBe(true);
  });

  it("applies the default model to a skill that declares no tier", async () => {
    const h = await start();
    await h.prompt("explore the data");
    await h.loadSkill("explore-ml-data");
    expect(h.modelCalls).toEqual([{ provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" }]);
  });

  it("lets the config assign a tier without editing the skill", async () => {
    const h = await start({ models: { ...TIER_CONFIG.models, skillTiers: { "big-skill": "small" } } });
    await h.prompt("do the hardest work");
    await h.loadSkill("big-skill");
    expect(h.modelCalls).toEqual([{ provider: "openrouter", id: "qwen/qwen3.7-flash" }]);
    expect(h.thinkingCalls).toEqual(["low"]);
  });

  it("keeps the current model for a skill that opts out", async () => {
    const h = await start();
    await h.prompt("keep whatever model is current");
    await h.loadSkill("opt-out-skill");
    expect(h.modelCalls).toEqual([]);
    expect(h.getModel().id).toBe("moonshotai/kimi-k2.6");
  });

  it("does not switch unlabeled skills when applyToUnlabeledSkills is false", async () => {
    const h = await start({ models: { ...TIER_CONFIG.models, applyToUnlabeledSkills: false } });
    await h.prompt("explore the data");
    await h.loadSkill("explore-ml-data");
    expect(h.modelCalls).toEqual([]);
  });

  it("falls back to the default model when a skill names an unknown tier", async () => {
    const withTypo = writeSkills(root, [
      ...SPECS,
      { name: "typo-skill", description: "Names a tier that does not exist.", frontmatter: "metadata:\n  modelTier: huge" },
    ]);
    const h = await start(TIER_CONFIG, withTypo);
    await h.prompt("typo");
    await h.loadSkill("typo-skill");
    expect(h.getModel().id).toBe("deepseek/deepseek-v4.1-flash");
    expect(h.notifications.some((n) => n.includes('tier "huge" is not defined'))).toBe(true);
  });

  it("keeps the current model when the tier model is not registered in Pi", async () => {
    const h = await start();
    h.registry.delete("openrouter/z-ai/glm-5.3");
    await h.prompt("do the hardest work");
    await h.loadSkill("big-skill");
    expect(h.modelCalls).toEqual([]);
    expect(h.getModel().id).toBe("moonshotai/kimi-k2.6");
    expect(h.notifications.some((n) => n.includes("not registered"))).toBe(true);
  });

  it("keeps the current model when the provider has no credentials", async () => {
    const h = await start();
    h.deny.add("openrouter/z-ai/glm-5.3");
    await h.prompt("do the hardest work");
    await h.loadSkill("big-skill");
    expect(h.modelCalls).toEqual([]);
    expect(h.notifications.some((n) => n.includes("no credentials"))).toBe(true);
  });

  it("restores a run-scoped tier when the agent settles", async () => {
    const h = await start();
    await h.prompt("do the hardest work");
    await h.loadSkill("big-skill");
    expect(h.getModel().id).toBe("z-ai/glm-5.3");
    await h.emit("agent_settled", { type: "agent_settled" });
    expect(h.getModel().id).toBe("moonshotai/kimi-k2.6");
    expect(h.thinkingLevel()).toBe("medium");
  });

  it("keeps a session-scoped tier after the agent settles", async () => {
    const h = await start();
    await h.prompt("explore the data");
    await h.loadSkill("explore-ml-data");
    await h.emit("agent_settled", { type: "agent_settled" });
    expect(h.getModel().id).toBe("deepseek/deepseek-v4.1-flash");
  });

  it("does not switch again when the tier already matches", async () => {
    const h = await start();
    await h.prompt("do the mechanical work");
    await h.loadSkill("small-skill");
    await h.loadSkill("small-skill");
    expect(h.modelCalls).toHaveLength(1);
    expect(h.thinkingCalls).toEqual(["low"]);
  });

  it("switches for an explicit /skill: command before the first request", async () => {
    const h = await start();
    await h.prompt('<skill name="big-skill" location="/skills/big-skill/SKILL.md">body</skill>');
    expect(h.modelCalls).toEqual([{ provider: "openrouter", id: "z-ai/glm-5.3" }]);

    const raw = await start();
    await raw.prompt("/skill:small-skill please");
    expect(raw.modelCalls).toEqual([{ provider: "openrouter", id: "qwen/qwen3.7-flash" }]);
  });

  it("resets to the model from before the first switch", async () => {
    const h = await start();
    await h.prompt("explore the data");
    await h.loadSkill("explore-ml-data");
    expect(h.getModel().id).toBe("deepseek/deepseek-v4.1-flash");
    await h.commands.get("skills-model").handler("reset", h.ctx);
    expect(h.getModel().id).toBe("moonshotai/kimi-k2.6");
    expect(h.thinkingLevel()).toBe("medium");
    expect(h.notifications.at(-1)).toContain("Restored");
  });

  it("lists the tiers and flags models Pi does not know", async () => {
    const h = await start();
    h.registry.delete("openrouter/qwen/qwen3.7-flash");
    await h.prompt("hi");
    await h.commands.get("skills-model").handler("", h.ctx);
    const text = h.notifications.at(-1)!;
    expect(text).toContain("Model tiers on");
    expect(text).toContain("z-ai/glm-5.3 max (run)");
    expect(text).toContain("qwen/qwen3.7-flash low (session) ⚠ not registered");
    expect(text).toContain('default  tier "medium"');
  });

  it("does nothing without a models config", async () => {
    const h = await start({ minKeep: 1 });
    await h.prompt("do the hardest work");
    await h.loadSkill("big-skill");
    expect(h.modelCalls).toEqual([]);
  });
});

// ── Archiving switch and headless visibility ──────────────────────

describe("archiving switch and visibility", () => {
  /** Load explore, then setup mid-run: explore is unrelated, so it is archived. */
  async function archiveExplore(h: Awaited<ReturnType<typeof startSession>>) {
    await h.prompt("explore the data");
    const explore = await h.loadSkill("explore-ml-data");
    await h.emit("turn_end", { type: "turn_end", toolResults: [explore] });
    const setup = await h.loadSkill("setup-ml-project");
    await h.emit("turn_end", { type: "turn_end", toolResults: [setup] });
    return { explore, setup };
  }

  it("can be disabled from the config", async () => {
    const h = await startSession({ enabled: false });
    const { explore, setup } = await archiveExplore(h);
    const out = await h.context([explore, setup]);
    expect(out.some(isPlaceholder)).toBe(false);
    expect(h.notifications.some((n) => n.includes("Archived skill bodies"))).toBe(false);
  });

  it("re-applies the configured switch on reload, so it can be persisted", async () => {
    const h = await startSession({ enabled: false });
    // A session-only override, then a reload: the config wins again.
    await h.commands.get("skills-on").handler("", h.ctx);
    await h.commands.get("skills-reload").handler("", h.ctx);
    const { explore, setup } = await archiveExplore(h);
    expect((await h.context([explore, setup])).some(isPlaceholder)).toBe(false);
  });

  it("keeps the session-only /skills-off working when the config enables archiving", async () => {
    const h = await startSession({ enabled: true });
    await h.commands.get("skills-off").handler("", h.ctx);
    const { explore, setup } = await archiveExplore(h);
    expect((await h.context([explore, setup])).some(isPlaceholder)).toBe(false);
  });

  it("records the archive decision on the session for headless runs", async () => {
    const h = await startSession();
    await archiveExplore(h);
    const record = h.entries.filter((e) => e.customType === "skill-lifecycle").at(-1)!;
    expect(record.data.event).toBe("archived");
    expect(record.data.archived.map((b: any) => b.name)).toContain("explore-ml-data");
    expect(record.data.archived[0].reason).toEqual(expect.any(String));
  });

  it("records nothing when nothing was archived", async () => {
    const h = await startSession();
    await h.prompt("explore the data");
    await h.loadSkill("explore-ml-data");
    expect(h.entries).toEqual([]);
  });
});

// ── Model tiers: robustness (review findings) ─────────────────────

describe("model tiers: robustness", () => {
  const CONFIG = {
    models: {
      tiers: {
        small: { provider: "openrouter", model: "qwen/qwen3.7-flash", thinkingLevel: "low" },
        medium: { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", thinkingLevel: "high" },
        big: { provider: "openrouter", model: "z-ai/glm-5.3", thinkingLevel: "max", scope: "run" },
      },
      default: "medium",
    },
  };
  const EXTRA: SkillSpec[] = [
    { name: "big-skill", description: "Do the hardest work.", frontmatter: "metadata:\n  modelTier: big" },
    { name: "small-skill", description: "Do the mechanical work.", frontmatter: "metadata:\n  modelTier: small" },
    {
      name: "coordinator",
      description: "Coordinate the study.",
      frontmatter: "metadata:\n  modelTier: big",
      body: "Load `step-skill` for the sub-step, then continue.",
    },
    { name: "step-skill", description: "Run one sub-step.", frontmatter: "metadata:\n  role: helper\n  modelTier: small" },
    { name: "router", description: "Route the request.", frontmatter: "metadata:\n  role: entry\n  modelTier: medium" },
    { name: "deep-skill", description: "Think very deeply.", frontmatter: "metadata:\n  modelTier: deep" },
    { name: "aux-helper", description: "Run another sub-step.", frontmatter: "metadata:\n  role: helper\n  modelTier: medium" },
  ];
  let tierSkills: PiSkill[];
  beforeEach(() => {
    tierSkills = writeSkills(root, [...SPECS, ...EXTRA]);
  });
  const start = (config: object = CONFIG) => startSession(config, undefined, true, tierSkills);
  const switches = (h: ReturnType<typeof createHarness>) => h.notifications.filter((n) => n.startsWith("🎚️"));

  it("still loads the skill when the model switch fails", async () => {
    const h = await start();
    h.failSetModel.add("openrouter/z-ai/glm-5.3");
    await h.prompt("do the hardest work");
    const message = await h.loadSkill("big-skill");
    expect(textOf(message)).toContain('<skill_content name="big-skill">');
    expect(h.getModel().id).toBe("moonshotai/kimi-k2.6");
    expect(h.notifications.some((n) => n.includes("could not switch"))).toBe(true);
  });

  it("applies the tier's thinking level even though a model switch resets it", async () => {
    const h = await start();
    h.pi.setThinkingLevel("high"); // raised by the user before the switch
    await h.prompt("explore the data");
    await h.loadSkill("explore-ml-data"); // default tier: medium, thinking high
    expect(h.getModel().id).toBe("deepseek/deepseek-v4.1-flash");
    expect(h.thinkingLevel()).toBe("high");
  });

  it("accepts thinkingLevel off", async () => {
    const h = await start({
      models: { tiers: { small: { provider: "openrouter", model: "qwen/qwen3.7-flash", thinkingLevel: "off" } }, default: "small" },
    });
    await h.prompt("do the mechanical work");
    await h.loadSkill("small-skill");
    expect(h.thinkingLevel()).toBe("off");
  });

  it("does not re-announce a tier whose thinking level the model clamps", async () => {
    const h = await start({
      models: { tiers: { small: { provider: "openrouter", model: "qwen/qwen3.7-flash", thinkingLevel: "max" } }, default: "small" },
    });
    h.thinkingClamp.set("openrouter/qwen/qwen3.7-flash", ["low", "high"]);
    await h.prompt("do the mechanical work");
    await h.loadSkill("small-skill");
    await h.loadSkill("small-skill");
    expect(switches(h)).toHaveLength(1);
  });

  it("restores a run-scoped tier to the model active when that run started", async () => {
    const h = await start();
    await h.prompt("explore the data");
    await h.loadSkill("explore-ml-data"); // medium, session-scoped
    await h.emit("agent_settled", { type: "agent_settled" });
    await h.prompt("do the hardest work");
    await h.loadSkill("big-skill"); // big, run-scoped
    await h.emit("agent_settled", { type: "agent_settled" });
    expect(h.getModel().id).toBe("deepseek/deepseek-v4.1-flash");
  });

  it("restores a run-scoped tier to the model just before it, within one run", async () => {
    const h = await start();
    await h.prompt("explore then work hard");
    await h.loadSkill("explore-ml-data"); // medium, session
    await h.loadSkill("big-skill"); // big, run
    await h.emit("agent_settled", { type: "agent_settled" });
    expect(h.getModel().id).toBe("deepseek/deepseek-v4.1-flash");
  });

  it("keeps a session-scoped tier chosen after a run-scoped one", async () => {
    const h = await start();
    await h.prompt("work hard then do the mechanical part");
    await h.loadSkill("big-skill"); // big, run
    await h.loadSkill("small-skill"); // small, session: supersedes the temporary tier
    await h.emit("agent_settled", { type: "agent_settled" });
    expect(h.getModel().id).toBe("qwen/qwen3.7-flash");
  });

  it("restores the model from before the first of two run-scoped tiers", async () => {
    const h = await start({
      models: {
        ...CONFIG.models,
        tiers: { ...CONFIG.models.tiers, deep: { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", scope: "run" } },
      },
    });
    await h.prompt("work hard, then think deeply");
    await h.loadSkill("big-skill"); // run-scoped glm
    await h.loadSkill("deep-skill"); // another run-scoped tier: our own switch, not the user's
    await h.emit("agent_settled", { type: "agent_settled" });
    expect(h.getModel().id).toBe("moonshotai/kimi-k2.6");
  });

  it("does not override a model the user picked during a run-scoped tier", async () => {
    const h = await start();
    await h.prompt("explore then work hard");
    await h.loadSkill("explore-ml-data"); // medium, session
    await h.loadSkill("big-skill"); // big, run: would restore medium at settle
    // The user picks a model with /model: Pi reports it with source "set" too.
    const picked = h.registry.get("openrouter/qwen/qwen3.7-flash");
    const previousModel = h.ctx.model;
    h.ctx.model = picked;
    await h.emit("model_select", { type: "model_select", model: picked, previousModel, source: "set" });
    await h.emit("agent_settled", { type: "agent_settled" });
    expect(h.getModel().id).toBe("qwen/qwen3.7-flash");
  });

  it("does not throw when restoring a run-scoped tier fails", async () => {
    const h = await start();
    await h.prompt("do the hardest work");
    await h.loadSkill("big-skill");
    h.failSetModel.add("openrouter/moonshotai/kimi-k2.6");
    await expect(h.emit("agent_settled", { type: "agent_settled" })).resolves.toBeUndefined();
    await expect(h.commands.get("skills-model").handler("reset", h.ctx)).resolves.not.toThrow();
  });

  it("applies tiers in call order when skills load in parallel", async () => {
    const h = await start();
    h.setModelDelay.set("openrouter/z-ai/glm-5.3", 30); // the first switch is the slow one
    await h.prompt("do two things");
    await Promise.all([h.loadSkill("big-skill"), h.loadSkill("small-skill")]);
    expect(h.getModel().id).toBe("qwen/qwen3.7-flash");
  });

  it("keeps the caller's model when a helper is loaded mid-task", async () => {
    const h = await start();
    await h.prompt("coordinate the study");
    await h.loadSkill("coordinator"); // big
    await h.loadSkill("step-skill"); // small helper; the coordinator keeps working
    expect(h.getModel().id).toBe("z-ai/glm-5.3");
  });

  /**
   * One assistant message loading several skills, as Pi runs it: every call is
   * prepared first (firing `tool_call`), then all of them execute together.
   */
  async function loadTogether(h: ReturnType<typeof createHarness>, names: string[]) {
    for (const [i, name] of names.entries()) {
      await h.emit("tool_call", { type: "tool_call", toolCallId: `batch-${i}`, toolName: "skill", input: { name } });
    }
    const results = await Promise.all(names.map((name) => h.loadSkill(name)));
    await h.emit("turn_end", { type: "turn_end", toolResults: results });
    return results;
  }

  it("keeps the caller's model when caller and helper load in the same message, in either order", async () => {
    for (const order of [["coordinator", "step-skill"], ["step-skill", "coordinator"]]) {
      const h = await start();
      await h.prompt("coordinate the study");
      await loadTogether(h, order);
      expect(h.getModel().id).toBe("z-ai/glm-5.3");
      // The helper never switched: one switch, to the caller's tier.
      expect(h.modelCalls).toEqual([{ provider: "openrouter", id: "z-ai/glm-5.3" }]);
    }
  });

  it("lets sibling helpers loaded without a caller apply their tiers in call order", async () => {
    const h = await start();
    await h.prompt("two sub-steps");
    await loadTogether(h, ["aux-helper", "step-skill"]);
    expect(h.getModel().id).toBe("qwen/qwen3.7-flash");
  });

  it("forgets the message's batch at turn end", async () => {
    const h = await start();
    await h.prompt("coordinate the study");
    // A skill call that was requested but never ran (blocked by another extension, say).
    await h.emit("tool_call", { type: "tool_call", toolCallId: "blocked", toolName: "skill", input: { name: "coordinator" } });
    await h.emit("turn_end", { type: "turn_end", toolResults: [] });
    await h.loadSkill("step-skill"); // next message: no caller loaded or requested
    expect(h.getModel().id).toBe("qwen/qwen3.7-flash");
  });

  it("shows in /skills-model what each load did to the model, and says when a helper kept it", async () => {
    const h = await start();
    await h.prompt("coordinate the study");
    await h.loadSkill("coordinator");
    await h.loadSkill("step-skill");
    expect(h.notifications).toContainEqual(
      expect.stringContaining('skill("step-skill") keeps openrouter/z-ai/glm-5.3: helper loaded by a working caller (tier "small" not applied)'),
    );
    await h.commands.get("skills-model").handler("", h.ctx);
    const text = h.notifications.at(-1)!;
    expect(text).toContain("coordinator → big (frontmatter) — switched to openrouter/z-ai/glm-5.3");
    expect(text).toContain(
      'step-skill → small (frontmatter, helper) — kept openrouter/z-ai/glm-5.3 (helper of a working caller; tier "small" not applied)',
    );
  });

  it("applies a helper's own tier when only the entry skill is loaded", async () => {
    const h = await start();
    await h.prompt("route this");
    await h.loadSkill("router"); // entry, medium
    await h.loadSkill("step-skill"); // helper with no working caller
    expect(h.getModel().id).toBe("qwen/qwen3.7-flash");
  });

  const modelEvents = (h: ReturnType<typeof createHarness>) =>
    h.entries.filter((e) => e.customType === "skill-lifecycle-model").map((e) => e.data);

  it("records each model switch on the session and draws it in the chat", async () => {
    const h = await start();
    await h.prompt("do the hardest work");
    await h.loadSkill("big-skill");
    expect(modelEvents(h)).toEqual([
      {
        event: "switch",
        from: "openrouter/moonshotai/kimi-k2.6",
        to: "openrouter/z-ai/glm-5.3",
        thinkingLevel: "max",
        trigger: 'skill("big-skill")',
        tier: "big",
        source: "frontmatter",
        scope: "run",
      },
    ]);
    // Drawn through pi-tui's Text, as Pi's chat does it.
    const render = h.entryRenderers.get("skill-lifecycle-model");
    const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text };
    const entry = { type: "custom", customType: "skill-lifecycle-model", data: modelEvents(h)[0] };
    expect(render(entry, { expanded: false }, theme).render(160).join("\n")).toContain(
      'Model openrouter/z-ai/glm-5.3 (thinking max) · tier "big" for skill("big-skill"), this run only',
    );
    expect(render(entry, { expanded: true }, theme).render(160).join("\n")).toContain("was openrouter/moonshotai/kimi-k2.6");
  });

  it("records the restore at the end of a run-scoped tier, and a reset", async () => {
    const h = await start();
    await h.prompt("do the hardest work");
    await h.loadSkill("big-skill"); // big, run-scoped
    await h.emit("agent_settled", { type: "agent_settled" });
    await h.loadSkill("explore-ml-data"); // medium, session
    await h.commands.get("skills-model").handler("reset", h.ctx);
    expect(modelEvents(h).map((e) => [e.event, e.to])).toEqual([
      ["switch", "openrouter/z-ai/glm-5.3"],
      ["restore", "openrouter/moonshotai/kimi-k2.6"],
      ["switch", "openrouter/deepseek/deepseek-v4.1-flash"],
      ["reset", "openrouter/moonshotai/kimi-k2.6"],
    ]);
    expect(modelEvents(h)[1]).toMatchObject({ from: "openrouter/z-ai/glm-5.3", tier: "big" });
  });

  it("records nothing when the model does not change", async () => {
    const h = await start();
    h.failSetModel.add("openrouter/z-ai/glm-5.3");
    await h.prompt("coordinate the study");
    await h.loadSkill("big-skill"); // the switch fails
    h.failSetModel.clear();
    await h.loadSkill("coordinator"); // switches
    await h.loadSkill("step-skill"); // helper: keeps the caller's model
    await h.loadSkill("coordinator"); // already on the tier
    expect(modelEvents(h).map((e) => e.trigger)).toEqual(['skill("coordinator")']);
  });

  it("records no model change when verbose is off", async () => {
    const h = await start({ ...CONFIG, verbose: false });
    await h.prompt("do the hardest work");
    await h.loadSkill("big-skill");
    expect(h.getModel().id).toBe("z-ai/glm-5.3");
    expect(modelEvents(h)).toEqual([]);
  });

  it("reports a misconfigured tier once per session, not on every load", async () => {
    const h = await start();
    h.registry.delete("openrouter/z-ai/glm-5.3");
    await h.prompt("do the hardest work");
    await h.loadSkill("big-skill");
    await h.loadSkill("big-skill");
    expect(h.notifications.filter((n) => n.includes("not registered"))).toHaveLength(1);
  });
});
