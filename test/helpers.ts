import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentRequest, AgentResult, AgentRunner } from "../src/agent.ts";
import { initRepoWithCommit } from "../src/worktree.ts";

export function tempDir(prefix = "af-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/** A tiny git repo with a unit test and an E2E command, and a bug in add(). */
export async function makeTargetRepo(): Promise<string> {
  const dir = join(tempDir(), "target");
  writeFiles(dir, {
    "package.json": JSON.stringify({
      type: "module",
      scripts: { test: 'node --test "test/**/*.test.js"', e2e: 'node --test "e2e/**/*.test.js"' },
    }),
    "src/add.js": "export const add = (a, b) => a - b;\n",
    "test/smoke.test.js": 'import { test } from "node:test";\ntest("smoke", () => {});\n',
    "e2e/smoke.e2e.test.js": 'import { test } from "node:test";\ntest("smoke", () => {});\n',
  });
  await initRepoWithCommit(dir);
  return dir;
}

export const UNIT_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/add.js";
test("adds", () => assert.equal(add(2, 3), 5));
`;

export type Step = (req: AgentRequest) => void | Partial<AgentResult> | Promise<void | Partial<AgentResult>>;

/** Plays a scripted step per call, in order, and records every request it received. */
export class FakeRunner implements AgentRunner {
  readonly calls: AgentRequest[] = [];
  constructor(private readonly steps: Step[]) {}

  async run(req: AgentRequest): Promise<AgentResult> {
    const step = this.steps[this.calls.length];
    this.calls.push(req);
    if (!step) throw new Error(`FakeRunner: no step scripted for call ${this.calls.length}`);
    const override = (await step(req)) ?? {};
    return {
      ok: true,
      sessionId: `session-${req.role.name}`,
      costUsd: 0.1,
      turns: 3,
      durationMs: 10,
      summary: `${req.role.name} done`,
      ...override,
    };
  }
}
