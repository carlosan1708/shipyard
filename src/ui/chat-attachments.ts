import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { MAX_FEEDBACK_BYTES, parseFeedbackAttachments, resolveAttachments, writeFeedbackAttachments, type FeedbackAttachment } from "../attachments.ts";

export class ChatAttachments {
  constructor(private readonly root: string) {}

  upload(input: unknown) {
    const files = parseFeedbackAttachments(input);
    if (!files.length) throw new Error("Choose at least one file to attach.");
    const id = randomUUID();
    const dir = join(this.root, id);
    const saved = writeFeedbackAttachments(dir, files, true);
    try {
      writeFileSync(join(dir, "files.json"), JSON.stringify(saved), { mode: 0o600, flag: "wx" });
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    return { id, files: saved.map(({ name }) => name) };
  }

  private read(input: unknown) {
    if (input === undefined) return [];
    if (!Array.isArray(input) || input.length > 12 || input.some((id) => typeof id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))) {
      throw new Error("Choose up to 12 chat attachment groups.");
    }
    return [...new Set(input)].flatMap((id) => {
      const dir = join(this.root, id);
      try {
        const files = JSON.parse(readFileSync(join(dir, "files.json"), "utf8")) as FeedbackAttachment[];
        return resolveAttachments(dir, files).map((file) => ({ ...file, bytes: readFileSync(file.path) }));
      } catch {
        throw new Error("A chat attachment could not be found. Attach it again and retry.");
      }
    });
  }

  forRun(input: unknown) {
    return this.read(input).map(({ name, bytes }) => ({ name, bytes }));
  }

  async forReply(input: unknown) {
    const files = this.read(input);
    const images = [];
    let imageBytes = 0;
    let textBudget = 48_000;
    const context = [];
    for (const { name, bytes, path, imageType } of files.toReversed()) {
      const label = name;
      if (imageType && imageBytes + bytes.length <= MAX_FEEDBACK_BYTES) {
        images.unshift({ path, mediaType: imageType });
        imageBytes += bytes.length;
        context.unshift({ name: label, format: "image" });
        continue;
      }
      const limit = Math.min(textBudget, 16_000);
      const text = !imageType && limit > 0 ? await attachmentText(name, bytes, limit) : undefined;
      if (text !== undefined) {
        const excerpt = text.content.slice(0, limit);
        textBudget -= excerpt.length;
        context.unshift({ name: label, format: "text", excerpt, truncated: text.truncated || excerpt.length < text.content.length });
      } else context.unshift({ name: label, format: "original available for the run", excerpt: undefined });
    }
    return { images, context };
  }
}

const xmlEntities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

async function attachmentText(name: string, bytes: Buffer, limit: number): Promise<{ content: string; truncated?: boolean } | undefined> {
  try {
    if (bytes.subarray(0, 5).toString() === "%PDF-") {
      const { getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(Uint8Array.from(bytes));
      try {
        const pages = Math.min(12, pdf.numPages);
        let content = "";
        let page = 1;
        for (; page <= pages && content.length <= limit; page++) {
          const { items } = await (await pdf.getPage(page)).getTextContent();
          for (const item of items) {
            if ("str" in item) content += item.str + (item.hasEOL ? "\n" : " ");
            if (content.length > limit) break;
          }
          content += "\n";
        }
        if (content.trim()) return { content, truncated: page <= pdf.numPages || content.length > limit };
      } finally { await pdf.loadingTask.destroy(); }
      return;
    }
    if (/\.docx$/i.test(name)) {
      const document = unzipSync(bytes, { filter: ({ name, originalSize }) => name === "word/document.xml" && originalSize <= 2_000_000 })["word/document.xml"];
      if (!document) return;
      const xml = new TextDecoder().decode(document);
      const content = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<\/w:p>/g)]
        .map((match) => match[1]?.replace(/&(amp|lt|gt|quot|apos);/g, (_, key: string) => xmlEntities[key] ?? "") ?? "\n").join("");
      if (content.trim()) return { content };
      return;
    }
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!/[\u0000-\u0008\u000e-\u001f]/.test(content)) return { content };
  } catch { /* The original remains attached if a document is unreadable here. */ }
}
