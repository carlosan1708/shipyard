import { OPTIONAL_STAGES, type OptionalStage } from "../pipeline.ts";
import type { Target } from "../config.ts";
import type { RepoAction } from "./repository-chat.ts";
import type { RunAnswer } from "./run-question.ts";

export const CHAT_KINDS = ["feature", "bug", "deps"] as const;
export const CHAT_LIMIT = 256_000;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatOption {
  title: string;
  detail: string;
  request: string;
  target: string;
  kind: (typeof CHAT_KINDS)[number];
  crew: OptionalStage[];
}

export interface ChatReply {
  text: string;
  options: ChatOption[];
  repoActions?: RepoAction[];
  runAnswer?: RunAnswer;
  web?: { searched: boolean; sources: ChatSource[] };
}

interface ChatSource { title: string; url: string }

export function chatSourceUrl(input: unknown): string | undefined {
  if (typeof input !== "string" || input.length > 2048) return;
  try {
    const url = new URL(input);
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !url.port &&
        ![...url.searchParams.keys()].some((key) => /^(?:access[_-]?token|api[_-]?key|auth(?:orization)?|client[_-]?secret|key|password|sig(?:nature)?|token|x-amz-.+|x-goog-.+)$/i.test(key))) return url.href;
  } catch { /* The provider may return an unusable citation. */ }
}

export function chatResearch(output: unknown, searched: boolean, pages: Set<string>): ChatReply["web"] {
  if (!searched && !pages.size) return;
  const value = record(output);
  const sources = new Map<string, ChatSource>();
  for (const raw of Array.isArray(value?.sources) ? value.sources.slice(0, 8) : []) {
    const source = record(raw);
    const url = chatSourceUrl(source?.url);
    if (url && typeof source?.title === "string" && source.title.trim()) sources.set(url, { url, title: source.title.trim().slice(0, 140) });
  }
  for (const url of pages) if (!sources.has(url)) sources.set(url, { url, title: new URL(url).hostname });
  return { searched, sources: [...sources.values()].slice(0, 8) };
}

/** Keep precise run-status and handoff questions grounded in Shipyard's own records. */
export function isLocalRunQuestion(question: string): boolean {
  const text = question.trim().toLowerCase().replace(/[.!?]+$/, "");
  return [
    /^(?:what(?:'s| is) (?:the )?(?:run )?status|(?:run )?status|what(?:'s| is) next|what now)$/,
    /^(?:what changed|(?:which|what) files changed|show (?:the )?(?:diff|test results))$/,
    /^(?:(?:did|have) (?:the )?(?:project |unit |e2e )?(?:tests?|checks?) pass(?:ed)?|were (?:the )?(?:tests|checks) successful)$/,
    /^(?:which|what) (?:project |unit |e2e )?(?:tests?|checks?) (?:passed|failed)$/,
    /^(?:was|is) (?:the )?(?:pr|pull request) merged$/,
    /^(?:is it (?:live|deployed)|(?:check|verify) (?:the )?(?:live site|live deployment|deployment status))$/,
    /^deploy(?: (?:it|this|now)){0,3}(?: (?:on|to) (?:firebase|aws|azure))?$/,
    /^i (?:just )?merged (?:the )?(?:pr|pull request)[.!]\s+deploy (?:it|this)(?: now)?$/,
  ].some((pattern) => pattern.test(text));
}

const CHAT_FAILURES = {
  "provider-auth": { status: 422, message: "The selected provider could not authenticate." },
  "provider-unavailable": { status: 503, message: "The selected provider is unavailable in this dashboard session." },
  "provider-limit": { status: 429, message: "The selected provider reported a usage limit or too many requests." },
  "provider-timeout": { status: 504, message: "The selected provider did not reply in time." },
  "provider-response": { status: 502, message: "The selected provider returned an unreadable reply." },
  "provider-error": { status: 502, message: "The selected provider could not complete the reply." },
};

export class ChatProviderError extends Error {
  readonly status: number;

  constructor(readonly code: keyof typeof CHAT_FAILURES) {
    super(CHAT_FAILURES[code].message);
    this.status = CHAT_FAILURES[code].status;
  }
}

export function chatProviderFailure(detail = ""): ChatProviderError {
  if (/not found on path|command not found|executable not found|ENOENT/i.test(detail)) return new ChatProviderError("provider-unavailable");
  if (/rate.?limit|usage limit|hit your limit|too many requests|quota|\b429\b|out of credits/i.test(detail)) return new ChatProviderError("provider-limit");
  if (/authenticat|unauthori[sz]ed|not logged in|sign.?in|(?:re)?log[ -]?in|credential|api.?key|\boauth\b|\b401\b/i.test(detail)) return new ChatProviderError("provider-auth");
  if (/timed?\s*out|timeout/i.test(detail)) return new ChatProviderError("provider-timeout");
  if (/schema|structured output|without a final response/i.test(detail)) return new ChatProviderError("provider-response");
  return new ChatProviderError("provider-error");
}

export const CHAT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text", "options", "sources"],
  properties: {
    text: { type: "string" },
    sources: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "url"],
      properties: { title: { type: "string" }, url: { type: "string" } } } },
    options: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "detail", "request", "target", "kind", "crew"],
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          request: { type: "string" },
          target: { type: "string" },
          kind: { type: "string", enum: CHAT_KINDS },
          crew: { type: "array", items: { type: "string", enum: OPTIONAL_STAGES } },
        },
      },
    },
  },
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function parseChatMessages(value: unknown): ChatMessage[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 12) return;
  const messages: ChatMessage[] = [];
  for (const item of value) {
    const message = record(item);
    if ((message?.role !== "user" && message?.role !== "assistant") || typeof message.content !== "string" ||
        !message.content.trim() || message.content.length > 3_500) return;
    messages.push({ role: message.role, content: message.content.trim() });
  }
  if (messages.at(-1)?.role === "user") return messages;
}

export function parseChatReply(value: unknown, targets: Target[], selected?: Target): ChatReply | undefined {
  const reply = record(value);
  if (typeof reply?.text !== "string" || !reply.text.trim() || !Array.isArray(reply.options)) return;
  const options: ChatOption[] = [];
  for (const suggestion of reply.options.slice(0, 3)) {
    const option = record(suggestion);
    if (typeof option?.title !== "string" || !option.title.trim() || typeof option.detail !== "string" ||
        typeof option.request !== "string" || !option.request.trim() || option.request.length > 8_000 ||
        (option.kind !== "feature" && option.kind !== "bug" && option.kind !== "deps") || !Array.isArray(option.crew)) continue;
    const target = selected ?? targets.find(({ name }) => name === option.target);
    const kind = option.kind;
    const suggested = option.crew;
    const crew = OPTIONAL_STAGES.filter((stage) => suggested.includes(stage) &&
      (stage !== "triage" || kind === "bug") &&
      ((stage !== "plan" && stage !== "design") || kind !== "deps") &&
      ((stage !== "e2e" && stage !== "repair") || !target || Boolean(target.e2e)) &&
      (stage !== "repair" || suggested.includes("e2e")));
    options.push({ title: option.title.trim().slice(0, 100), detail: option.detail.trim().slice(0, 500),
      request: option.request.trim(), target: target?.name ?? "", kind, crew });
  }
  if (!reply.options.length || options.length) return { text: reply.text.trim().slice(0, 3_500), options };
}
