/**
 * Replay recorded Pi sessions through the extension and compare strategies.
 *
 *   npm run replay -- --skills <skills-dir> [--config name=file.json ...]
 *                     [--orphan-dir <dir>] [--per-session] [--no-reload]
 *                     <session.jsonl ...>
 *   REPLAY_TRACE=1 npm run replay -- …   # print prompts, archives, orphan uses
 *
 * The real extension is driven through a minimal fake ExtensionAPI: every
 * recorded user prompt fires `before_agent_start`, every recorded skill load
 * runs the `skill` tool, every assistant message ends a turn (`turn_end`) and
 * starts a request (`context`). Direct `read` calls on a SKILL.md in older
 * recordings are replayed as skill-tool loads. Loads of skills missing from
 * <skills-dir> are left as plain tool results.
 *
 * Orphan use: a recorded tool call touches the directory of a skill whose
 * body the strategy archived, so the model would have worked without its
 * instructions. The directory is the skill's own by default; pass
 * `--orphan-dir <dir>` to measure a specific install (for example the
 * workspace copy at `<workspace>/.agents/skills`). Sessions recorded while
 * authoring the skill pack reference the pack source, which counts as an
 * orphan under the default: they are not a clean end-user corpus.
 * Unless --no-reload, the replay then simulates the reload a model following
 * the protocol would make (one extra request, body re-sent), so a wrong
 * eviction pays its price.
 *
 * Each request is costed by prefix caching (Anthropic ratios: cache read
 * 0.1×, cache write 1.25×): the longest prefix shared with the previous
 * request is read from the cache, the rest is written. Sizes are characters;
 * thinking blocks are not counted (most providers do not re-send them).
 *
 * Reported per strategy, summed over sessions, relative to keep-all:
 * cost, peak context, reloads (loads of a skill whose body was archived), and
 * orphan uses. Built-in strategies: keep-all (archiving off) and derived (no
 * config file); add more with --config name=file.json.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.ts";

// ── Arguments ─────────────────────────────────────────────────────

const args = process.argv.slice(2);
let skillsDir = "";
const strategies: Array<{ name: string; config?: object; off?: boolean }> = [
  { name: "keep-all", off: true },
  { name: "derived", config: undefined },
];
const sessions: string[] = [];
let perSession = false;
let reloadOnOrphan = true;
let orphanDir = "";
const trace = !!process.env.REPLAY_TRACE;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--skills") skillsDir = args[++i];
  else if (a === "--orphan-dir") orphanDir = args[++i];
  else if (a === "--config") {
    const [name, file] = args[++i].split("=");
    strategies.push({ name, config: JSON.parse(readFileSync(file, "utf-8")) });
  } else if (a === "--per-session") perSession = true;
  else if (a === "--no-reload") reloadOnOrphan = false;
  else sessions.push(a);
}
if (!skillsDir || sessions.length === 0) {
  console.error("usage: node scripts/replay.ts --skills <dir> [--orphan-dir <dir>] [--config name=file.json] [--per-session] <session.jsonl ...>");
  process.exit(2);
}

// ── Skills ────────────────────────────────────────────────────────

const skills = readdirSync(skillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(path.join(skillsDir, d.name, "SKILL.md")))
  .map((d) => {
    const filePath = path.resolve(skillsDir, d.name, "SKILL.md");
    const { frontmatter } = parseFrontmatter<Record<string, any>>(readFileSync(filePath, "utf-8"));
    return {
      name: String(frontmatter.name ?? d.name),
      description: String(frontmatter.description ?? "").trim(),
      filePath,
      baseDir: path.dirname(filePath),
      sourceInfo: { path: filePath, source: "replay", scope: "project", origin: "top-level" } as any,
      disableModelInvocation: frontmatter["disable-model-invocation"] === true,
    };
  });
const skillNames = new Set(skills.map((s) => s.name));
const bodySizes = new Map(skills.map((s) => [s.name, readFileSync(s.filePath, "utf-8").length]));
const bodySize = (name: string) => bodySizes.get(name) ?? 0;

// Directory a tool call must touch for a skill to count as used: the skill's
// own directory (`baseDir`), or `--orphan-dir`/<name>/ to measure a specific
// install root such as `<workspace>/.agents/skills`.
const toPosix = (p: string) => p.split(path.sep).join("/");
const orphanRoot = orphanDir ? toPosix(path.resolve(orphanDir)) : undefined;
const orphanDirs = new Map(
  skills.map((s) => [s.name, orphanRoot ? `${orphanRoot}/${s.name}/` : `${toPosix(s.baseDir)}/`]),
);

// ── Session parsing ───────────────────────────────────────────────

function activeBranch(file: string): any[] {
  const entries = readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id, e]));
  const leaf = [...entries].reverse().find((e) => e.type === "message");
  const branch: any[] = [];
  for (let e = leaf; e; e = e.parentId ? byId.get(e.parentId) : undefined) branch.push(e);
  return branch.reverse();
}

function textSize(content: any): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const c of content) {
    if (c.type === "text") n += (c.text ?? "").length;
    else if (c.type === "toolCall") n += c.name.length + JSON.stringify(c.arguments ?? {}).length;
    else if (c.type === "image") n += 6000;
    // Thinking blocks are not re-sent on later requests by most providers.
  }
  return n;
}

function promptText(content: any): string {
  if (typeof content === "string") return content;
  return (content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

// ── Fake Pi ───────────────────────────────────────────────────────

function createRuntime(cwd: string) {
  const handlers = new Map<string, Array<(e: any, c: any) => any>>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const pi = {
    on: (event: string, h: any) => void handlers.set(event, [...(handlers.get(event) ?? []), h]),
    registerTool: (t: any) => void tools.set(t.name, t),
    registerCommand: (n: string, o: any) => void commands.set(n, o),
    getActiveTools: () => ["read", "bash", "edit", "write", "skill"],
    appendEntry: () => {},
    registerEntryRenderer: () => {},
  } as any;
  extension(pi);
  const ctx = {
    cwd,
    hasUI: trace,
    ui: { notify: (m: string) => trace && !m.startsWith("📖") && console.log(`    ${m.replace(/\n/g, "\n    ")}`) },
    sessionManager: { getBranch: () => [] },
    isProjectTrusted: () => true,
  };
  async function emit(event: string, payload: any) {
    let result: any;
    for (const h of handlers.get(event) ?? []) {
      const v = await h(payload, ctx);
      if (v !== undefined) result = v;
    }
    return result;
  }
  return { tools, commands, ctx, emit };
}

// ── Replay ────────────────────────────────────────────────────────

interface Result {
  cost: number;
  peak: number;
  reloads: number;
  orphan: number;
  requests: number;
}

const CACHE_READ = 0.1;
const CACHE_WRITE = 1.25;

async function replay(file: string, strategy: { config?: object; off?: boolean }): Promise<Result> {
  const agentDir = mkdtempSync(path.join(tmpdir(), "replay-agent-"));
  const cwd = mkdtempSync(path.join(tmpdir(), "replay-cwd-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  if (strategy.config) writeFileSync(path.join(agentDir, "skill-lifecycle.json"), JSON.stringify(strategy.config));
  const rt = createRuntime(cwd);
  await rt.emit("session_start", { type: "session_start", reason: "startup" });
  if (strategy.off) await rt.commands.get("skills-off").handler("", rt.ctx);

  const branch = activeBranch(file);
  const messages: any[] = [];
  const sizes = new Map<any, number>();
  let systemSize = 0;
  let pending: any[] = [];
  const callArgs = new Map<string, { name: string; args: any }>();
  const seenLoaded = new Set<string>();
  let prevKeys: string[] = [];
  const res: Result = { cost: 0, peak: 0, reloads: 0, orphan: 0, requests: 0 };
  let currentContext: any[] = [];

  const archivedNow = () => {
    // Names whose latest body is a placeholder in the current context.
    const out = new Set<string>();
    for (const m of currentContext) {
      if (m.toolName !== "skill") continue;
      const t = m.content?.[0]?.text ?? "";
      const name = t.match(/<skill_content name="([^"]+)">/)?.[1];
      if (!name) continue;
      if (t.includes("Skill body archived")) out.add(name);
      else out.delete(name);
    }
    return out;
  };

  async function request() {
    const out = (await rt.emit("context", { type: "context", messages: [...messages] }))?.messages ?? messages;
    currentContext = out;
    const keys = out.map((x: any, i: number) => `${i}:${x === messages[i] ? "o" : "p"}`);
    const sz = out.map((x: any, i: number) => (x === messages[i] ? sizes.get(messages[i]) ?? 0 : textSize(x.content)));
    let lcp = 0;
    let cached = systemSize;
    while (lcp < keys.length && lcp < prevKeys.length && keys[lcp] === prevKeys[lcp]) cached += sz[lcp++];
    const total = systemSize + sz.reduce((a: number, b: number) => a + b, 0);
    const first = res.requests === 0;
    res.cost += first ? total * CACHE_WRITE : cached * CACHE_READ + (total - cached) * CACHE_WRITE;
    res.peak = Math.max(res.peak, total);
    res.requests++;
    prevKeys = keys;
  }

  const loadSkill = async (name: string, recorded: any) => {
    if (!skillNames.has(name)) return undefined;
    if (seenLoaded.has(name) && archivedNow().has(name)) res.reloads++;
    seenLoaded.add(name);
    const out = await rt.tools.get("skill").execute(recorded.toolCallId, { name }, undefined, undefined, rt.ctx);
    const msg = { role: "toolResult", toolCallId: recorded.toolCallId, toolName: "skill", content: out.content, isError: false };
    sizes.set(msg, textSize(recorded.content));
    return msg;
  };

  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const m = entry.message;
    if (m.role === "system") {
      systemSize = Object.values(m.sections ?? {}).reduce((n: number, s: any) => n + String(s).length, 0) || textSize(m.content);
      continue;
    }
    if (m.role === "user" && trace) console.log(`  [${res.requests}] user: ${promptText(m.content).slice(0, 90).replace(/\n/g, " ")}`);
    if (m.role === "user") {
      if (pending.length) await rt.emit("turn_end", { type: "turn_end", toolResults: pending });
      pending = [];
      await rt.emit("before_agent_start", {
        type: "before_agent_start",
        prompt: promptText(m.content),
        systemPrompt: "",
        systemPromptOptions: { skills, sections: {} },
      });
      messages.push(m);
      sizes.set(m, textSize(m.content));
      continue;
    }
    if (m.role === "assistant") {
      if (pending.length) await rt.emit("turn_end", { type: "turn_end", toolResults: pending });
      pending = [];
      await request();
      // Orphan use: a call touches the directory of a skill whose body is
      // archived. A model following the protocol would reload it first:
      // simulate that reload (one extra request, body re-sent) so the cost of
      // a wrong eviction is paid, then redo this request.
      const archived = archivedNow();
      const orphans = new Set<string>();
      for (const c of m.content ?? []) {
        if (c.type !== "toolCall" || c.name === "skill") continue;
        const blob = toPosix(JSON.stringify(c.arguments ?? {}));
        for (const name of archived) {
          const dir = orphanDirs.get(name);
          if (dir && blob.includes(dir)) orphans.add(name);
        }
      }
      if (trace && orphans.size > 0) console.log(`    ⚠️  orphan use at request ${res.requests}: ${[...orphans].join(", ")}`);
      if (orphans.size > 0 && reloadOnOrphan) {
        res.orphan += orphans.size;
        const call = { role: "assistant", content: [...orphans].map((name, i) => ({ type: "toolCall", id: `reload-${res.requests}-${i}`, name: "skill", arguments: { name } })) };
        messages.push(call);
        sizes.set(call, textSize(call.content));
        const results: any[] = [];
        for (const name of orphans) {
          const body = await loadSkill(name, { toolCallId: `reload-${name}`, content: [{ type: "text", text: "x".repeat(bodySize(name)) }] });
          if (body) {
            messages.push(body);
            results.push(body);
          }
        }
        await rt.emit("turn_end", { type: "turn_end", toolResults: results });
        await request();
      } else res.orphan += orphans.size;
      for (const c of m.content ?? []) if (c.type === "toolCall") callArgs.set(c.id, { name: c.name, args: c.arguments ?? {} });
      messages.push(m);
      sizes.set(m, textSize(m.content));
      continue;
    }
    if (m.role === "toolResult") {
      let msg = m;
      const call = callArgs.get(m.toolCallId);
      if (!m.isError && m.toolName === "skill") {
        const name = promptText(m.content).match(/<skill_content name="([^"]+)">/)?.[1];
        msg = (name && (await loadSkill(name, m))) ?? { ...m, toolName: "skill-not-installed" };
      } else if (!m.isError && m.toolName === "read" && /\/SKILL\.md$/.test(String(call?.args?.path ?? ""))) {
        const name = path.basename(path.dirname(String(call!.args.path)));
        msg = (await loadSkill(name, m)) ?? m;
      }
      if (!sizes.has(msg)) sizes.set(msg, textSize(m.content));
      messages.push(msg);
      pending.push(msg);
      continue;
    }
    // Other context messages (custom, bash execution, …).
    messages.push(m);
    sizes.set(m, textSize(m.content));
  }

  rmSync(agentDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  return res;
}

// ── Main ──────────────────────────────────────────────────────────

const totals = new Map<string, Result>();
const rows: string[] = [];
for (const file of sessions) {
  const perStrategy: Record<string, Result> = {};
  for (const s of strategies) {
    if (trace) console.log(`\n=== ${path.basename(file).slice(0, 24)} — ${s.name}`);
    const r = await replay(file, s);
    perStrategy[s.name] = r;
    const t = totals.get(s.name) ?? { cost: 0, peak: 0, reloads: 0, orphan: 0, requests: 0 };
    t.cost += r.cost;
    t.peak += r.peak;
    t.reloads += r.reloads;
    t.orphan += r.orphan;
    t.requests += r.requests;
    totals.set(s.name, t);
  }
  if (perSession) {
    const base = perStrategy["keep-all"];
    rows.push(
      `${path.basename(file).slice(0, 24)} (${base.requests} req): ` +
        strategies
          .map((s) => {
            const r = perStrategy[s.name];
            return `${s.name} ${((100 * r.cost) / base.cost).toFixed(0)}%/${((100 * r.peak) / base.peak).toFixed(0)}%/${r.reloads}r/${r.orphan}o`;
          })
          .join("  "),
    );
  }
}

const base = totals.get("keep-all")!;
console.log(
  `${sessions.length} sessions, ${base.requests} requests, ${skills.length} skills` +
    (orphanRoot ? `, orphan dir ${orphanRoot}` : "") +
    "\n",
);
console.log("| Strategy | Cost | Peak context | Reloads | Orphan uses |");
console.log("|---|---|---|---|---|");
for (const s of strategies) {
  const t = totals.get(s.name)!;
  console.log(
    `| ${s.name} | ${((100 * t.cost) / base.cost).toFixed(1)}% | ${((100 * t.peak) / base.peak).toFixed(1)}% | ${t.reloads} | ${t.orphan} |`,
  );
}
if (perSession) console.log("\n" + rows.join("\n"));
