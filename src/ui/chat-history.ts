import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CHAT_HISTORY_LIMIT = 4_000_000;
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

interface SavedMessage extends Record<string, unknown> {
  id: string;
  role: "user" | "assistant";
  content?: string;
}

interface ChatContext {
  target: string;
  provider: "claude" | "codex" | "";
  runId: string | null;
}

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  runIds: string[];
}

interface ChatRecord extends Omit<ChatSummary, "runIds"> {
  context: ChatContext;
  messages: SavedMessage[];
  removed: string[];
}

const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
const validId = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const validRunId = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,160}$/.test(value);

function summary({ messages, context, removed: _removed, ...fields }: ChatRecord): ChatSummary {
  return { ...fields, runIds: [...new Set([context.runId, ...messages.map(({ runId }) => runId)].filter(validRunId))] };
}

export class ChatHistoryInputError extends Error {}

export class ChatHistory {
  constructor(private readonly root: string, private readonly onSave?: (chat: ChatSummary) => void) {}

  private read(id: string): ChatRecord | undefined {
    if (!validId(id)) return;
    try { return JSON.parse(readFileSync(join(this.root, `${id}.json`), "utf8")) as ChatRecord; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  list(): ChatSummary[] {
    let names: string[];
    try { names = readdirSync(this.root); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return names.filter((name) => name.endsWith(".json")).flatMap((name) => {
      try {
        const chat = this.read(name.slice(0, -5));
        return chat ? [summary(chat)] : [];
      } catch (error) {
        if (error instanceof SyntaxError) return [];
        throw error;
      }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string) {
    const chat = this.read(id);
    if (!chat) return;
    const { removed: _removed, ...visible } = chat;
    return visible;
  }

  earlierContext(id: unknown, runId: unknown, firstRecentId: unknown) {
    if (!validId(id) || !validId(firstRecentId)) return;
    const chat = this.read(id);
    const relevant = chat?.messages.filter((message) => (message.runId ?? null) === (runId ?? null) && typeof message.content === "string") ?? [];
    const boundary = relevant.findIndex((message) => message.id === firstRecentId);
    if (boundary <= 0) return;
    const earlier = relevant.slice(0, boundary);
    // Keep the original goal plus the most recent information beyond the live context window.
    return [...earlier.slice(0, 2), ...earlier.slice(Math.max(2, earlier.length - 8))]
      .map(({ role, content }) => ({ role, content: content!.slice(0, 800) }));
  }

  save(id: string, input: unknown): ChatSummary {
    const patch = object(input);
    if (!validId(id) || !patch || !Array.isArray(patch.messages) || patch.messages.length > 40 ||
        (patch.removed !== undefined && (!Array.isArray(patch.removed) || patch.removed.length > 40 || !patch.removed.every(validId)))) {
      throw new ChatHistoryInputError("Invalid chat history update");
    }
    const incoming: SavedMessage[] = patch.messages.map((value) => {
      const message = object(value);
      if (!message || !validId(message.id) || (message.role !== "user" && message.role !== "assistant") ||
          (typeof message.content !== "string" && (message.role !== "assistant" || !object(message.failure)))) {
        throw new ChatHistoryInputError("Invalid message in chat history");
      }
      return message as SavedMessage;
    });
    const prior = this.read(id);
    const context = prior && patch.preserveContext === true ? undefined : object(patch.context);
    const selected: ChatContext = context ? {
      target: typeof context.target === "string" ? context.target.slice(0, 255) : "",
      provider: context.provider === "claude" || context.provider === "codex" ? context.provider : "",
      runId: validRunId(context.runId) ? context.runId : null,
    } : prior?.context ?? { target: "", provider: "", runId: null };

    const removed = new Set(prior?.removed ?? []);
    const messages = new Map((prior?.messages ?? []).map((message) => [message.id, message]));
    for (const message of incoming) if (!removed.has(message.id) && !messages.has(message.id)) messages.set(message.id, message);
    for (const messageId of patch.removed ?? []) {
      if (messages.get(messageId)?.failure) {
        removed.add(messageId);
        messages.delete(messageId);
      }
    }
    const timeline = [...messages.values()];
    const linkedTitle = timeline.find(({ runTitle }) => typeof runTitle === "string")?.runTitle;
    const opening = timeline.find((message) => message.role === "user")?.content ?? (typeof linkedTitle === "string" ? linkedTitle : "");
    const title = opening.replace(/\s+/g, " ").trim().slice(0, 85) || "New chat";
    if (prior && incoming.every((message) => prior.messages.some((entry) => entry.id === message.id) || removed.has(message.id)) &&
        timeline.length === prior.messages.length && JSON.stringify(prior.context) === JSON.stringify(selected)) return summary(prior);
    const now = new Date().toISOString();
    const chat: ChatRecord = { id, title, context: selected, messages: timeline, removed: [...removed], createdAt: prior?.createdAt ?? now,
      updatedAt: now, messageCount: timeline.length };
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temporary = join(this.root, `${id}.tmp`);
    writeFileSync(temporary, JSON.stringify(chat), { mode: 0o600 });
    renameSync(temporary, join(this.root, `${id}.json`));
    const saved = summary(chat);
    this.onSave?.(saved);
    return saved;
  }
}
