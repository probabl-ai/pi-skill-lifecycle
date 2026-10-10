/**
 * Offline end-to-end check: a scripted model provider for a real Pi process.
 *
 * Each request Pi sends is appended to $E2E_LOG as one JSON line (rendered
 * system prompt, declared tools, messages). Replies follow $E2E_SCRIPT, a JSON
 * array of steps: { "tool": name, "args": {...} } or { "text": "..." }.
 * The step counter lives in "$E2E_LOG.step" so `--continue` runs resume it.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createAssistantMessageEventStream, getSystemMessageText } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Step = { tool: string; args: Record<string, unknown> } | { text: string };

export default function (pi: ExtensionAPI) {
  const log = process.env.E2E_LOG!;
  const script: Step[] = JSON.parse(process.env.E2E_SCRIPT ?? "[]");
  const stepFile = `${log}.step`;

  pi.registerProvider("scripted", {
    baseUrl: "http://localhost.invalid",
    apiKey: "unused",
    api: "scripted-api" as any,
    models: [
      {
        id: "m",
        name: "scripted",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 1000,
      },
      {
        id: "second",
        name: "scripted second",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 1000,
      },
    ],
    streamSimple(model, context) {
      const messages = context.messages as any[];
      const system = messages.filter((m) => m.role === "system");
      appendFileSync(
        log,
        JSON.stringify({
          model: `${model.provider}/${model.id}`,
          system: system.map((m) => getSystemMessageText(m)),
          systemSections: system.map((m) => m.sections ?? null),
          tools: system.flatMap((m) => (m.tools ?? []).map((t: any) => t.name)),
          messages: messages
            .filter((m) => m.role !== "system")
            .map((m) => ({
              role: m.role,
              toolName: m.toolName,
              isError: m.isError,
              text: Array.isArray(m.content)
                ? m.content.map((c: any) => c.text ?? (c.type === "toolCall" ? `[toolCall ${c.name}]` : "")).join("")
                : String(m.content ?? ""),
            })),
        }) + "\n",
      );

      const index = existsSync(stepFile) ? Number(readFileSync(stepFile, "utf-8")) : 0;
      writeFileSync(stepFile, String(index + 1));
      const step: Step = script[index] ?? { text: "done" };

      const usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const message: any = {
        role: "assistant",
        content:
          "tool" in step
            ? [{ type: "toolCall", id: `call-${index}`, name: step.tool, arguments: step.args }]
            : [{ type: "text", text: step.text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason: "tool" in step ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
}
