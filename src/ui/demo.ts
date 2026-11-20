import { setTimeout as sleep } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentRequest, AgentResult, AgentRunner } from "../agent.ts";

/**
 * A scripted crew for `shipyard ui --demo`: it makes real, passing changes to the demo-shop app,
 * asks a real question and requests a real permission, but never calls Claude. Use it to show the
 * UI, or to work on the UI, without spending any subscription usage.
 */
export class DemoRunner implements AgentRunner {
  constructor(private readonly stepMs = 700) {}

  async run(req: AgentRequest): Promise<AgentResult> {
    const started = Date.now();
    const sessionId = req.resumeSessionId ?? `demo-${req.role.name}-${randomBytes(3).toString("hex")}`;
    let turns = 0;
    const tool = async (name: string, detail: string, effect?: () => void) => {
      req.signal?.throwIfAborted();
      req.onEvent?.({ type: "tool", tool: name, detail });
      turns++;
      await sleep(this.stepMs * (0.6 + Math.random() * 0.8), undefined, { signal: req.signal });
      effect?.();
    };
    const say = (text: string) => req.onEvent?.({ type: "text", text });

    let summary: string;
    let structured: unknown;
    switch (req.role.name) {
      case "planner":
        summary = await this.planner(req, tool);
        break;
      case "reviewer":
        ({ summary, structured } = await this.reviewer(req, tool));
        break;
      case "e2e-tester":
        summary = await this.tester(req, tool, say);
        break;
      case "docs-writer":
        summary = await this.docs(req, tool);
        break;
      case "release-manager":
        summary = await this.release(req, tool);
        break;
      case "bug-triager":
        ({ summary, structured } = await this.triager(req, tool));
        break;
      case "security-auditor":
        ({ summary, structured } = await this.auditor(tool));
        break;
      case "dependency-updater":
        summary = await this.updater(tool);
        break;
      default: // backend or frontend
        summary = req.resumeSessionId ? await this.followUp(req, tool) : await this.implementer(req, tool, say);
    }

    return { ok: true, sessionId, costUsd: 0, turns, durationMs: Date.now() - started, summary, structured };
  }

  private async planner(req: AgentRequest, tool: Tool): Promise<string> {
    await tool("Bash", "ls -R src test e2e && cat package.json CLAUDE.md");
    await tool("Read", join(req.cwd, "src/server.js"));
    const withCount = await this.askPayload(req);
    return [
      "Goal: a GET /health endpoint that monitors can poll to see the shop is up.",
      `Approach: one route in src/server.js next to the other GET routes, returning ${withCount ? '{"status": "ok", "products": <count>} (you asked for the product count)' : '{"status": "ok"}'} with 200.`,
      "Files: src/server.js (route), test/health.test.js (new).",
      "Tasks:\n1. Add the route before GET /products.\n2. Add unit tests that start the server on port 0.\n3. Run npm test.",
      "Tests: 200 + JSON body + content type; other methods on /health get the standard 404.",
      "Risks / open questions: none.",
    ].join("\n");
  }

  private async askPayload(req: AgentRequest): Promise<boolean> {
    if (!req.ask) return false;
    const answer = await req.ask({
      kind: "question",
      questions: [
        {
          question: "Should the health check also report how many products the catalog has?",
          header: "Payload",
          multiSelect: false,
          options: [
            { label: "Just the status", description: 'Return exactly {"status": "ok"}, as the request says.' },
            { label: "Add product count", description: 'Return {"status": "ok", "products": 5}. Handy for smoke tests.' },
          ],
        },
      ],
    });
    return answer.kind === "question" && Object.values(answer.answers).some((a) => /count/i.test(a));
  }

  private async reviewer(req: AgentRequest, tool: Tool): Promise<{ summary: string; structured: unknown }> {
    await tool("Bash", "git diff --stat HEAD~1..HEAD && git diff HEAD~1..HEAD");
    await tool("Read", join(req.cwd, "test/health.test.js"));
    // The scripted reviewer only knows the /health change: anything else (a dependency update) it approves.
    const healthTest = join(req.cwd, "test/health.test.js");
    const covered = !existsSync(healthTest) || readFileSync(healthTest, "utf8").includes('method: "POST"');
    const structured = covered
      ? { verdict: "approve", summary: "Small, correct change with good tests.", findings: [] }
      : {
          verdict: "request_changes",
          summary: "The route works, but the tests don't prove that other methods are rejected.",
          findings: [
            {
              severity: "major",
              file: "test/health.test.js",
              issue: "Nothing tests that POST /health is not a route, so a catch-all bug there would go unnoticed.",
              suggestion: "Add a test that POST /health answers 404 with the standard error body.",
            },
            { severity: "nit", file: "src/server.js", issue: "The route could sit with the other GET routes for readability." },
          ],
        };
    return { summary: "", structured };
  }

  private async triager(req: AgentRequest, tool: Tool): Promise<{ summary: string; structured: unknown }> {
    await tool("Read", join(req.cwd, "src/server.js"));
    await tool("Grep", "health");
    await tool("Write", join(req.cwd, "test/triage-health.test.js"), () => writeFile(req.cwd, "test/triage-health.test.js", triageTest));
    await tool("Bash", "npm test");
    return {
      summary: "",
      structured: {
        reproduced: true,
        reproduction_test: "test/triage-health.test.js",
        steps: "Start the server and request GET /health.",
        expected: '200 with {"status": "ok"}',
        actual: '404 {"error": "not_found"}: there is no such route',
        suspected_cause: "src/server.js has no /health route, so the request falls through to the 404 handler.",
        suspected_files: ["src/server.js"],
      },
    };
  }

  private async auditor(tool: Tool): Promise<{ summary: string; structured: unknown }> {
    await tool("Bash", "git diff HEAD~1..HEAD");
    await tool("Bash", "npm audit --omit=dev");
    return {
      summary: "",
      structured: {
        verdict: "pass",
        summary: "The endpoint takes no input and exposes nothing sensitive. The project has no dependencies to audit.",
        findings: [
          {
            severity: "low",
            category: "unsafe-default",
            file: "src/server.js",
            issue: "Unauthenticated health checks are fine, but they shouldn't grow to include internal details (versions, hostnames).",
            fix: "Keep the body to status (and counts) only.",
          },
        ],
      },
    };
  }

  private async updater(tool: Tool): Promise<string> {
    await tool("Bash", "cat package.json");
    await tool("Bash", "npm outdated");
    return "Nothing to update: demo-shop has no dependencies (it only uses Node's built-ins). No changes.";
  }

  private async docs(req: AgentRequest, tool: Tool): Promise<string> {
    await tool("Read", join(req.cwd, "CLAUDE.md"));
    const server = join(req.cwd, "src/server.js");
    if (!existsSync(server) || !readFileSync(server, "utf8").includes("GET /health")) {
      await tool("Bash", "git diff --stat HEAD~1..HEAD");
      return "Nothing user-facing changed, so the docs stay as they are.";
    }
    await tool("Write", join(req.cwd, "docs/api.md"), () =>
      appendFile(req.cwd, "docs/api.md", "\n## GET /health\n\nReturns `200` with `{\"status\": \"ok\"}` while the shop is up. Use it for uptime checks.\n"),
    );
    return "Documented GET /health in docs/api.md.";
  }

  private async release(req: AgentRequest, tool: Tool): Promise<string> {
    await tool("Read", join(req.cwd, "package.json"));
    await tool("Edit", join(req.cwd, "package.json"), () => {
      const file = join(req.cwd, "package.json");
      const pkg = JSON.parse(readFileSync(file, "utf8")) as { version?: string };
      const [major = 1, minor = 0] = (pkg.version ?? "1.0.0").split(".").map(Number);
      writeFileSync(file, JSON.stringify({ ...pkg, version: `${major}.${minor + 1}.0` }, null, 2) + "\n");
    });
    await tool("Write", join(req.cwd, "CHANGELOG.md"), () => appendFile(req.cwd, "CHANGELOG.md", `\n## ${new Date().toISOString().slice(0, 10)}\n\n- Added GET /health for uptime checks.\n`));
    return "Release notes: new GET /health endpoint for uptime monitors. Minor version bump. Nothing to do to upgrade.";
  }

  private async implementer(req: AgentRequest, tool: Tool, say: (t: string) => void): Promise<string> {
    await tool("Bash", "ls -R src test e2e && cat package.json");
    await tool("Read", join(req.cwd, "src/server.js"));
    say("The API routes are in src/server.js. I'll add the endpoint next to the other GET routes.");

    // With a planner, the question was already asked and its answer is in the plan.
    const plan = req.prompt.match(/<plan>([\s\S]*?)<\/plan>/)?.[1];
    const withCount = plan ? /product count/i.test(plan) : await this.askPayload(req);

    await tool("Edit", join(req.cwd, "src/server.js"), () => addHealthRoute(req.cwd, withCount));
    await tool("Write", join(req.cwd, "test/health.test.js"), () => writeFile(req.cwd, "test/health.test.js", unitTest(withCount)));
    await tool("Bash", "npm test");
    return [
      `Added GET /health in src/server.js, returning ${withCount ? '{"status": "ok", "products": <count>}' : '{"status": "ok"}'} with 200.`,
      "Added test/health.test.js, which starts the server on port 0 and checks the status, the body and the JSON content type.",
      "npm test passes.",
    ].join("\n");
  }

  private async followUp(req: AgentRequest, tool: Tool): Promise<string> {
    await tool("Read", join(req.cwd, "test/health.test.js"));
    await tool("Edit", join(req.cwd, "test/health.test.js"), () => appendFile(req.cwd, "test/health.test.js", extraUnitTest));
    await tool("Bash", "npm test");
    return "Done: added a test that POST /health is not a route and gets the standard 404 body. npm test passes.";
  }

  private async tester(req: AgentRequest, tool: Tool, say: (t: string) => void): Promise<string> {
    if (req.resumeSessionId) {
      await tool("Edit", join(req.cwd, "e2e/health.e2e.test.js"), () => appendFile(req.cwd, "e2e/health.e2e.test.js", extraE2ETest));
      await tool("Bash", "npm run e2e");
      return "Added a check that /health answers within 200 ms. npm run e2e passes.";
    }
    await tool("Bash", "git show HEAD --stat && cat e2e/api.e2e.test.js");
    if (req.ask) {
      const url = "https://www.rfc-editor.org/rfc/rfc9110#name-200-ok";
      const answer = await req.ask({
        kind: "permission",
        tool: "WebFetch",
        input: { url, prompt: "Which status code should a healthy service return?" },
        title: `${req.role.name} wants to fetch www.rfc-editor.org`,
      });
      if (answer.kind === "permission" && answer.allow) await tool("WebFetch", url);
      else say("No web access, so I'll go with the usual 200 OK.");
    }
    // The scripted tester tests what the run actually built: /health if it exists, otherwise the existing API.
    const server = join(req.cwd, "src/server.js");
    if (existsSync(server) && readFileSync(server, "utf8").includes("GET /health")) {
      await tool("Write", join(req.cwd, "e2e/health.e2e.test.js"), () => writeFile(req.cwd, "e2e/health.e2e.test.js", e2eTest));
      await tool("Bash", "npm run e2e");
      return "Added e2e/health.e2e.test.js: GET /health over real HTTP returns 200 with JSON, and the rest of the API still answers. No defects found.";
    }
    await tool("Write", join(req.cwd, "e2e/smoke.e2e.test.js"), () => writeFile(req.cwd, "e2e/smoke.e2e.test.js", smokeTest));
    await tool("Bash", "npm run e2e");
    return "Added e2e/smoke.e2e.test.js: the product list and cart still work over real HTTP after the change. No defects found.";
  }
}

type Tool = (name: string, detail: string, effect?: () => void) => Promise<void>;


function writeFile(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function appendFile(root: string, rel: string, content: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, (existsSync(file) ? readFileSync(file, "utf8") : "") + content);
}

function addHealthRoute(root: string, withCount: boolean): void {
  const file = join(root, "src/server.js");
  if (!existsSync(file)) return writeFile(root, "DEMO.md", "The demo crew only knows the demo-shop app.\n");
  const anchor = '      if (route === "GET /products") {';
  const body = withCount ? '{ status: "ok", products: catalog.list({ pageSize: 50 }).total }' : '{ status: "ok" }';
  const text = readFileSync(file, "utf8");
  if (!text.includes(anchor) || text.includes("GET /health")) return;
  writeFileSync(file, text.replace(anchor, `      if (route === "GET /health") return send(res, 200, ${body});\n\n${anchor}`));
}

const serverHelper = `import { createApp } from "../src/server.js";

async function withServer(fn) {
  const server = createApp();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = \`http://127.0.0.1:\${server.address().port}\`;
  try {
    await fn(base);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
`;

const unitTest = (withCount: boolean) => `import { test } from "node:test";
import assert from "node:assert/strict";
${serverHelper}
test("GET /health reports ok", () =>
  withServer(async (base) => {
    const res = await fetch(\`\${base}/health\`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.deepEqual(await res.json(), ${withCount ? '{ status: "ok", products: 5 }' : '{ status: "ok" }'});
  }));
`;

const extraUnitTest = `
test("POST /health is not a route", () =>
  withServer(async (base) => {
    const res = await fetch(\`\${base}/health\`, { method: "POST" });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, "not_found");
  }));
`;

const e2eTest = `import { test } from "node:test";
import assert from "node:assert/strict";
${serverHelper}
test("GET /health over HTTP returns 200 with JSON", () =>
  withServer(async (base) => {
    const res = await fetch(\`\${base}/health\`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^application\\/json/);
    assert.equal((await res.json()).status, "ok");
  }));

test("the rest of the API still answers", () =>
  withServer(async (base) => {
    assert.equal((await fetch(\`\${base}/products\`)).status, 200);
  }));
`;

const smokeTest = `import { test } from "node:test";
import assert from "node:assert/strict";
${serverHelper}
test("the product list still answers", () =>
  withServer(async (base) => {
    const res = await fetch(\`\${base}/products\`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).total, 5);
  }));

test("the cart still accepts items", () =>
  withServer(async (base) => {
    const res = await fetch(\`\${base}/cart/items\`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productId: "mug" }) });
    assert.equal(res.status, 201);
  }));
`;

const triageTest = `import { test } from "node:test";
import assert from "node:assert/strict";
${serverHelper}
test("uptime monitors can poll GET /health", () =>
  withServer(async (base) => {
    const res = await fetch(\`\${base}/health\`);
    assert.equal(res.status, 200);
  }));
`;

const extraE2ETest = `
test("GET /health answers quickly", () =>
  withServer(async (base) => {
    const started = Date.now();
    await fetch(\`\${base}/health\`);
    assert.ok(Date.now() - started < 200);
  }));
`;
