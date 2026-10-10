/**
 * End-to-end test in a real Pi process with an offline scripted provider.
 *
 * Opt-in because it spawns Pi:  npm run test:e2e
 * PI_BIN selects the Pi executable (default: the `pi` on PATH).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const PI = process.env.PI_BIN ?? "pi";

const SCRIPT = [
  { tool: "read", args: { path: ".agents/skills/explore-ml-data/SKILL.md" } },
  { tool: "skill", args: { name: "explore-ml-data" } },
  { text: "loaded explore" },
  { tool: "skill", args: { name: "setup-ml-project" } },
  { text: "loaded setup" },
];

const SKILLS = {
  "triage-ml-task": "Route an ambiguous request to the right skill.",
  "explore-ml-data": "Explore and profile the data before modelling.",
  "setup-ml-project": "Set up and bootstrap a new ML workspace.",
};

describe.skipIf(!process.env.PI_E2E)("pi end-to-end", () => {
  let workspace: string;
  let requests: any[];

  function runPi(prompt: string, extraArgs: string[] = []) {
    execFileSync(
      PI,
      [
        "-p", "--offline", "--approve", "--no-extensions",
        "-e", join(ROOT, "extensions", "index.ts"),
        "-e", join(ROOT, "tests", "e2e", "scripted-provider.ts"),
        "--model", "scripted/m",
        "--session-dir", join(workspace, "sessions"),
        ...extraArgs,
        prompt,
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          // Fresh agent dir: no user settings, packages, or config leak into the run.
          PI_CODING_AGENT_DIR: join(workspace, "agent"),
          E2E_LOG: join(workspace, "requests.jsonl"),
          E2E_SCRIPT: JSON.stringify(SCRIPT),
        },
        stdio: "pipe",
        timeout: 60_000,
      },
    );
  }

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), "skill-lifecycle-e2e-"));
    for (const [name, description] of Object.entries(SKILLS)) {
      const dir = join(workspace, ".agents", "skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${"Instructions. ".repeat(400)}\n`);
    }
    mkdirSync(join(workspace, ".pi"), { recursive: true });
    writeFileSync(join(workspace, ".pi", "skill-lifecycle.json"), JSON.stringify({ entrySkill: "triage-ml-task", minKeep: 1 }));

    runPi("I would like to explore the data");
    runPi("now set up the project workspace", ["--continue"]);
    runPi("bootstrap and scaffold the new project workspace", ["--continue"]);

    requests = readFileSync(join(workspace, "requests.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  }, 200_000);

  afterAll(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  const skillResults = (request: any) => request.messages.filter((m: any) => m.toolName === "skill");

  it("renders one skills section with the protocol and the entry skill", () => {
    const system: string = requests[0].system[0];
    expect(system.match(/<skills>/g)).toHaveLength(1);
    expect(system).toContain('skill("triage-ml-task")');
    expect(system).not.toContain("Use the read tool to load a skill's file");
  });

  it("blocks the direct SKILL.md read and loads the body through the tool", () => {
    const read = requests[1].messages.find((m: any) => m.toolName === "read");
    expect(read.isError).toBe(true);
    expect(read.text).toContain('skill("explore-ml-data")');
    expect(skillResults(requests[2])[0].text).toContain('<skill_content name="explore-ml-data">');
  });

  it("never adds a system prompt update across turns and processes", () => {
    for (const request of requests) expect(request.system).toHaveLength(1);
  });

  it("keeps the resumed body, then archives it once the topic moves on", () => {
    const resumed = requests[3];
    expect(skillResults(resumed)[0].text).toContain("Instructions.");

    const last = requests[requests.length - 1];
    const [explore, setup] = skillResults(last);
    expect(explore.text).toContain("Skill body archived");
    expect(setup.text).toContain("Instructions.");
  });
});

/**
 * Mid-run eviction: one user prompt, the model loads a skill, gets an answer
 * from the user (a bash echo stands in for ask_user_question), then loads an
 * unrelated skill. The first body is archived within the same run.
 */
describe.skipIf(!process.env.PI_E2E)("pi end-to-end: mid-run skill switch", () => {
  const MID_RUN_SCRIPT = [
    { tool: "skill", args: { name: "explore-ml-data" } },
    { tool: "bash", args: { command: "echo 'answer: there is no project yet'" } },
    { tool: "skill", args: { name: "setup-ml-project" } },
    { text: "switched to setup" },
  ];
  let workspace: string;
  let requests: any[];

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), "skill-lifecycle-e2e-midrun-"));
    for (const [name, description] of Object.entries(SKILLS)) {
      const dir = join(workspace, ".agents", "skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${"Instructions. ".repeat(400)}\n`);
    }
    execFileSync(
      PI,
      [
        "-p", "--offline", "--approve", "--no-extensions",
        "-e", join(ROOT, "extensions", "index.ts"),
        "-e", join(ROOT, "tests", "e2e", "scripted-provider.ts"),
        "--model", "scripted/m",
        "--session-dir", join(workspace, "sessions"),
        "I would like to explore the data",
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: join(workspace, "agent"),
          E2E_LOG: join(workspace, "requests.jsonl"),
          E2E_SCRIPT: JSON.stringify(MID_RUN_SCRIPT),
        },
        stdio: "pipe",
        timeout: 60_000,
      },
    );
    requests = readFileSync(join(workspace, "requests.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  }, 100_000);

  afterAll(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  const skillResults = (request: any) => request.messages.filter((m: any) => m.toolName === "skill");

  it("keeps the first body while it is the only skill in use", () => {
    // Request after the bash answer: explore is still the active skill.
    expect(skillResults(requests[2])[0].text).toContain("Instructions.");
  });

  it("archives the first body as soon as an unrelated skill is loaded", () => {
    const last = requests[3];
    expect(last.messages.filter((m: any) => m.role === "user")).toHaveLength(1);
    const [explore, setup] = skillResults(last);
    expect(explore.text).toContain("Skill body archived");
    expect(setup.text).toContain("Instructions.");
  });
});

/**
 * Helper skills: explore-ml-data calls a helper (setup-ml-project is declared
 * as a helper here). The helper load must not archive the calling skill.
 */
describe.skipIf(!process.env.PI_E2E)("pi end-to-end: helper skill", () => {
  const HELPER_SCRIPT = [
    { tool: "skill", args: { name: "explore-ml-data" } },
    { tool: "skill", args: { name: "setup-ml-project" } },
    { text: "used the helper" },
  ];
  let workspace: string;
  let requests: any[];

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), "skill-lifecycle-e2e-helper-"));
    for (const [name, description] of Object.entries(SKILLS)) {
      const dir = join(workspace, ".agents", "skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${"Instructions. ".repeat(400)}\n`);
    }
    mkdirSync(join(workspace, ".pi"), { recursive: true });
    writeFileSync(join(workspace, ".pi", "skill-lifecycle.json"), JSON.stringify({ helperSkills: ["setup-ml-project"] }));
    execFileSync(
      PI,
      [
        "-p", "--offline", "--approve", "--no-extensions",
        "-e", join(ROOT, "extensions", "index.ts"),
        "-e", join(ROOT, "tests", "e2e", "scripted-provider.ts"),
        "--model", "scripted/m",
        "--session-dir", join(workspace, "sessions"),
        "I would like to explore the data",
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: join(workspace, "agent"),
          E2E_LOG: join(workspace, "requests.jsonl"),
          E2E_SCRIPT: JSON.stringify(HELPER_SCRIPT),
        },
        stdio: "pipe",
        timeout: 60_000,
      },
    );
    requests = readFileSync(join(workspace, "requests.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  }, 100_000);

  afterAll(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  it("keeps the calling skill's body after the helper is loaded", () => {
    const last = requests.at(-1);
    const [explore, helper] = last.messages.filter((m: any) => m.toolName === "skill");
    expect(explore.text).toContain("Instructions.");
    expect(helper.text).toContain("Instructions.");
  });
});

/**
 * No config file: the entry skill is inferred (its body mentions every other
 * skill), and persist-ml-git declares `metadata.role: helper`. Loading the
 * helper keeps the caller; loading an unrelated stage archives both, while
 * the inferred entry skill stays pinned.
 */
describe.skipIf(!process.env.PI_E2E)("pi end-to-end: derived roles without config", () => {
  const DERIVED_SCRIPT = [
    { tool: "skill", args: { name: "triage-ml-task" } },
    { tool: "skill", args: { name: "explore-ml-data" } },
    { tool: "skill", args: { name: "persist-ml-git" } },
    { tool: "skill", args: { name: "setup-ml-project" } },
    { text: "done" },
  ];
  const DERIVED_SKILLS: Record<string, { description: string; frontmatter?: string; intro?: string }> = {
    "triage-ml-task": {
      description: "Route an ambiguous request to the right skill.",
      intro: "Route to `explore-ml-data`, `setup-ml-project`, or `persist-ml-git`.",
    },
    "explore-ml-data": { description: "Explore and profile the data before modelling.", intro: "Then load `persist-ml-git`." },
    "setup-ml-project": { description: "Set up and bootstrap a new ML workspace." },
    "persist-ml-git": { description: "Commit the stage with git.", frontmatter: "metadata:\n  role: helper" },
  };
  let workspace: string;
  let requests: any[];

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), "skill-lifecycle-e2e-derived-"));
    for (const [name, spec] of Object.entries(DERIVED_SKILLS)) {
      const dir = join(workspace, ".agents", "skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${spec.description}\n${spec.frontmatter ? spec.frontmatter + "\n" : ""}---\n\n# ${name}\n\n${spec.intro ?? ""}\n\n${"Instructions. ".repeat(400)}\n`,
      );
    }
    execFileSync(
      PI,
      [
        "-p", "--offline", "--approve", "--no-extensions",
        "-e", join(ROOT, "extensions", "index.ts"),
        "-e", join(ROOT, "tests", "e2e", "scripted-provider.ts"),
        "--model", "scripted/m",
        "--session-dir", join(workspace, "sessions"),
        "I would like to explore the data",
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: join(workspace, "agent"),
          E2E_LOG: join(workspace, "requests.jsonl"),
          E2E_SCRIPT: JSON.stringify(DERIVED_SCRIPT),
        },
        stdio: "pipe",
        timeout: 60_000,
      },
    );
    requests = readFileSync(join(workspace, "requests.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  }, 100_000);

  afterAll(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  const skillResults = (request: any) => request.messages.filter((m: any) => m.toolName === "skill");

  it("names the inferred entry skill in the protocol", () => {
    expect(requests[0].system[0]).toContain('skill("triage-ml-task")');
  });

  it("keeps the caller when a declared helper is loaded", () => {
    const [, explore, persist] = skillResults(requests[3]);
    expect(explore.text).toContain("Instructions.");
    expect(persist.text).toContain("Instructions.");
  });

  it("archives the caller and the helper when an unrelated stage is loaded, keeping the entry skill", () => {
    const [triage, explore, persist, setup] = skillResults(requests[4]);
    expect(triage.text).toContain("Instructions.");
    expect(explore.text).toContain("Skill body archived");
    expect(persist.text).toContain("Skill body archived");
    expect(setup.text).toContain("Instructions.");
  });
});

/**
 * Model tiers: a skill declares `metadata.modelTier`, the config maps the tier
 * to a model registered in Pi, and the real session switches before the next
 * request. The scripted provider registers a second model ("scripted/second")
 * so the switch is observable in the request log.
 */
describe.skipIf(!process.env.PI_E2E)("pi end-to-end: model tier switch", () => {
  const TIER_SCRIPT = [
    { tool: "skill", args: { name: "big-skill" } },
    { text: "used the big model" },
  ];
  let workspace: string;
  let requests: any[];

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), "skill-lifecycle-e2e-tier-"));
    const dir = join(workspace, ".agents", "skills", "big-skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: big-skill\ndescription: Do the hardest work.\nmetadata:\n  modelTier: big\n---\n\n# big-skill\n\n${"Instructions. ".repeat(400)}\n`,
    );
    mkdirSync(join(workspace, ".pi"), { recursive: true });
    writeFileSync(
      join(workspace, ".pi", "skill-lifecycle.json"),
      JSON.stringify({
        models: {
          tiers: { big: { provider: "scripted", model: "second", thinkingLevel: "high" } },
          default: { provider: "scripted", model: "second" },
        },
      }),
    );
    execFileSync(
      PI,
      [
        "-p", "--offline", "--approve", "--no-extensions",
        "-e", join(ROOT, "extensions", "index.ts"),
        "-e", join(ROOT, "tests", "e2e", "scripted-provider.ts"),
        "--model", "scripted/m",
        "--session-dir", join(workspace, "sessions"),
        "do the hardest work",
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: join(workspace, "agent"),
          E2E_LOG: join(workspace, "requests.jsonl"),
          E2E_SCRIPT: JSON.stringify(TIER_SCRIPT),
        },
        stdio: "pipe",
        timeout: 60_000,
      },
    );
    requests = readFileSync(join(workspace, "requests.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  }, 100_000);

  afterAll(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  it("runs the first request on the session model, then on the skill's tier", () => {
    expect(requests[0].model).toBe("scripted/m");
    expect(requests[1].model).toBe("scripted/second");
  });

  it("switches only for the model, keeping one system prompt", () => {
    for (const request of requests) expect(request.system).toHaveLength(1);
  });

  it("records the switch on the session, where the chat draws it", () => {
    const files = readdirSync(join(workspace, "sessions"), { recursive: true, encoding: "utf-8" }).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const entries = readFileSync(join(workspace, "sessions", files[0]), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const switches = entries.filter((e) => e.type === "custom" && e.customType === "skill-lifecycle-model");
    expect(switches.map((e) => e.data)).toEqual([
      expect.objectContaining({ event: "switch", from: "scripted/m", to: "scripted/second", tier: "big", trigger: 'skill("big-skill")' }),
    ]);
    // Pi's own record of the selection is there too; ours is what the chat shows.
    expect(entries.some((e) => e.type === "model_change" && e.modelId === "second")).toBe(true);
  });
});
