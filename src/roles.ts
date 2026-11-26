import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { SHIPYARD_ROOT } from "./config.ts";

/**
 * An agent role. Roles live as Claude Code subagent files in plugins/shipyard/agents/,
 * so the same definition drives both the interactive plugin and this pipeline.
 */
export interface Role {
  name: string;
  description: string;
  tools: string[];
  /** A model id or alias, or undefined to use the configured model ("inherit"). */
  model?: string;
  prompt: string;
}

export const ROLES_DIR = join(SHIPYARD_ROOT, "plugins", "shipyard", "agents");

export function parseRole(markdown: string, source = "role"): Role {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error(`${source}: missing YAML frontmatter`);
  const meta = (YAML.parse(match[1]!) ?? {}) as Record<string, unknown>;
  const prompt = match[2]!.trim();
  if (typeof meta.name !== "string") throw new Error(`${source}: frontmatter needs a name`);
  if (typeof meta.description !== "string") throw new Error(`${source}: frontmatter needs a description`);
  if (!prompt) throw new Error(`${source}: prompt body is empty`);

  const rawTools = meta.tools;
  const tools = Array.isArray(rawTools)
    ? rawTools.map(String)
    : typeof rawTools === "string"
      ? rawTools.split(",").map((t) => t.trim()).filter(Boolean)
      : [];
  if (tools.length === 0 && !Array.isArray(rawTools)) throw new Error(`${source}: list the role's tools explicitly`);

  const model = typeof meta.model === "string" && meta.model !== "inherit" ? meta.model : undefined;
  return { name: meta.name, description: meta.description, tools, model, prompt };
}

export function loadRoles(dir = ROLES_DIR): Map<string, Role> {
  const roles = new Map<string, Role>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const role = parseRole(readFileSync(join(dir, file), "utf8"), file);
    roles.set(role.name, role);
  }
  return roles;
}

export function requireRole(roles: Map<string, Role>, name: string): Role {
  const role = roles.get(name);
  if (!role) throw new Error(`Role "${name}" not found. Expected plugins/shipyard/agents/${name}.md`);
  return role;
}
