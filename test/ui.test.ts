import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { decidePermission, type AgentAnswer, type AgentAsk } from "../src/agent.ts";
import { parseConfig } from "../src/config.ts";
import { loadRoles } from "../src/roles.ts";
import { DemoRunner } from "../src/ui/demo.ts";
import { RunManager, type InboxItem, type LiveMessage } from "../src/ui/manager.ts";
import { startUiServer } from "../src/ui/server.ts";
import { FakeRunner, makeTargetRepo, tempDir, UNIT_TEST, writeFiles, type Step } from "./helpers.ts";

async function makeManager(steps: Step[] | "demo", targets = 1) {
  const repos = await Promise.all(Array.from({ length: targets }, () => makeTargetRepo()));
  const config = parseConfig(
    {
      maxGateRetries: 1,
      worktreeRoot: tempDir("sy-wt-"),
      runsDir: tempDir("sy-runs-"),
      targets: Object.fromEntries(repos.map((path, i) => [`t${i}`, { path, test: "npm test", e2e: "npm run e2e" }])),
    },
    "/",
  );
  const runner = steps === "demo" ? new DemoRunner(5) : new FakeRunner(steps);
  const manager = new RunManager({ config, roles: loadRoles(), runner });
  const messages: LiveMessage[] = [];
  manager.bus.on("message", (m: LiveMessage) => messages.push(m));
  return { manager, config, runner, messages };
}

/** Resolves with the next inbox item matching `pred`, whether it is already waiting or arrives later. */
function nextItem(manager: RunManager, pred: (i: InboxItem) => boolean = () => true): Promise<InboxItem> {
  const existing = manager.inbox().find(pred);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const on = (m: LiveMessage) => {
      if (m.type === "inbox" && pred(m.item)) {
        manager.bus.off("message", on);
        resolve(m.item);
      }
    };
    manager.bus.on("message", on);
  });
}

const fix: Step = (req) => writeFiles(req.cwd, { "src/add.js": "export const add = (a, b) => Number(a) + Number(b);\n", "test/add.test.js": UNIT_TEST });
const imageAttachment = (name: string) => ({
  name, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkX8AAAAASUVORK5CYII=",
});
const e2e: Step = (req) =>
  writeFiles(req.cwd, { "e2e/add.e2e.test.js": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/add.js";\ntest("e2e", () => assert.equal(add(2, 2), 4));\n' });

test("checkpoints from the UI: an inbox item per stage, answered over the manager", async () => {
  const { manager } = await makeManager([fix, e2e]);
  const id = manager.start({ target: "t0", kind: "bug", request: "add() subtracts", checkpoints: ["implement", "e2e"] });

  const first = await nextItem(manager);
  assert.equal(first.kind, "checkpoint");
  assert.equal(first.runId, id);
  assert.equal(first.stage, "implement");
  assert.ok(first.kind === "checkpoint" && first.diff.summary.some((l) => l.includes("src/add.js")), "the diff comes with the item");
  manager.answer(first.id, { kind: "checkpoint", action: "continue" });

  const second = await nextItem(manager, (i) => i.stage === "e2e");
  manager.answer(second.id, { kind: "checkpoint", action: "continue" });

  const run = await manager.whenDone(id);
  assert.equal(run?.status, "passed");
  assert.deepEqual(manager.inbox(), []);
});

test("two runs wait in the inbox at once, and answering one never blocks the other", async () => {
  const { manager } = await makeManager([fix, fix, e2e], 2);
  const a = manager.start({ target: "t0", kind: "bug", request: "run A", checkpoints: ["implement"] });
  const b = manager.start({ target: "t1", kind: "bug", request: "run B", checkpoints: ["implement"] });

  const itemA = await nextItem(manager, (i) => i.runId === a);
  const itemB = await nextItem(manager, (i) => i.runId === b);
  assert.equal(manager.inbox().length, 2);
  assert.deepEqual(new Set(manager.activeRunIds()), new Set([a, b]));

  // Answer B first: B finishes while A is still waiting for its human.
  manager.answer(itemB.id, { kind: "checkpoint", action: "stop" });
  const runB = await manager.whenDone(b);
  assert.equal(runB?.status, "stopped");
  assert.deepEqual(manager.inbox().map((i) => i.id), [itemA.id]);
  assert.deepEqual(manager.activeRunIds(), [a]);

  manager.answer(itemA.id, { kind: "checkpoint", action: "stop" });
  assert.equal((await manager.whenDone(a))?.status, "stopped");
});

test("an agent's question reaches the inbox and the answer goes back to that agent only", async () => {
  let received: AgentAnswer | undefined;
  const { manager } = await makeManager([
    async (req) => {
      received = await req.ask!({
        kind: "question",
        questions: [{ question: "Which status code?", header: "Status", multiSelect: false, options: [{ label: "200", description: "" }, { label: "204", description: "" }] }],
      });
      fix(req);
    },
    (req) => {
      assert.doesNotMatch(req.prompt, /answer-example\.png/);
      assert.equal(req.images, undefined);
      e2e(req);
    },
  ]);
  const id = manager.start({ target: "t0", kind: "feature", request: "health check", checkpoints: [] });

  const item = await nextItem(manager);
  assert.equal(item.kind, "question");
  assert.throws(() => manager.answer(item.id, { kind: "question", answers: {} }), /Answer every question/);
  await new Promise((r) => setTimeout(r, 25)); // a human takes a moment; an instant answer can round to 0 ms
  manager.answer(item.id, { kind: "question", answers: { "Which status code?": "200" }, attachments: [imageAttachment("answer-example.png")] });

  const run = await manager.whenDone(id);
  assert.equal(run?.status, "passed");
  assert.ok(received?.kind === "question");
  assert.deepEqual(received.answers, { "Which status code?": "200" });
  assert.match(received.attachmentContext ?? "", /answer-example\.png/);
  assert.ok((run!.stages[0]!.attempts[0]!.askWaitMs ?? 0) > 0, "time blocked on the question counts as waiting for you");
  assert.equal(run!.totals.reviewWaitMs, run!.stages[0]!.attempts[0]!.askWaitMs);
});

test("'allow for this run' stops asking for that tool, but only in that run", async () => {
  const decisions: boolean[] = [];
  const evidence: Array<string | undefined> = [];
  const askWeb = async (req: Parameters<Step>[0]) => {
    const a = await req.ask!({ kind: "permission", tool: "WebFetch", input: { url: "https://example.com" } });
    decisions.push(a.kind === "permission" && a.allow);
    evidence.push(a.attachmentContext);
  };
  const { manager } = await makeManager([
    async (req) => {
      await askWeb(req);
      await askWeb(req); // second call: no inbox item
      fix(req);
    },
    e2e,
  ]);
  const id = manager.start({ target: "t0", kind: "feature", request: "x", checkpoints: [] });
  const item = await nextItem(manager);
  assert.equal(item.kind, "permission");
  manager.answer(item.id, { kind: "permission", decision: "allow-run", attachments: [imageAttachment("permission-context.png")] });
  assert.equal((await manager.whenDone(id))?.status, "passed");
  assert.deepEqual(decisions, [true, true]);
  assert.match(evidence[0] ?? "", /permission-context\.png/);
  assert.equal(evidence[1], undefined);
  const events = manager.store.events(id);
  assert.equal(events.filter((e) => e.type === "waiting").length, 1);
  assert.equal(events.filter((e) => e.type === "auto-allowed").length, 1);
});

test("bad start requests are refused with a clear message", async () => {
  const { manager } = await makeManager([]);
  assert.throws(() => manager.start({ target: "nope", kind: "bug", request: "x", checkpoints: [] }), /Unknown target/);
  assert.throws(() => manager.start({ target: "t0", kind: "bug", request: "  ", checkpoints: [] }), /Describe/);
  assert.throws(() => manager.start({ target: "t0", kind: "bug", request: "x", checkpoints: ["deploy" as never] }), /Unknown stage/);
  assert.throws(() => manager.start({ target: "t0", kind: "bug", request: "x", checkpoints: [], model: "gpt-5" }), /Unknown model "gpt-5"/);
  assert.throws(() => manager.start({ target: "t0", kind: "bug", request: "x", checkpoints: [], effort: "extreme" as never }), /effort must be/);
  assert.throws(() => manager.start({ target: "t0", kind: "bug", request: "x", checkpoints: [], crew: ["implement" as never] }), /implement always runs/);
  assert.throws(() => manager.start({ target: "t0", kind: "bug", request: "x", checkpoints: [], implementer: "designer" as never }), /implementer must be/);
  for (const budgetUsd of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => manager.start({ target: "t0", kind: "bug", request: "x", checkpoints: [], budgetUsd }), /budget must be a positive number/);
  }
});

test("the UI's run choices (model, effort, crew) reach the run", async () => {
  const { manager, runner } = await makeManager([fix]);
  const id = manager.start({ target: "t0", kind: "bug", request: "x", checkpoints: [], model: "claude-sonnet-5-5", effort: "medium", crew: [] });
  const run = await manager.whenDone(id);
  assert.equal(run?.status, "passed");
  assert.deepEqual([run?.model, run?.effort, run?.crew], ["claude-sonnet-5-5", "medium", []]);
  assert.equal((runner as FakeRunner).calls[0]!.model, "claude-sonnet-5-5");
});

test("decidePermission maps questions into the tool input and denials into a message", async () => {
  const asked: AgentAsk[] = [];
  const answerWith = (a: AgentAnswer) => async (ask: AgentAsk) => (asked.push(ask), a);

  const q = await decidePermission(
    "AskUserQuestion",
    { questions: [{ question: "Q?", header: "H", options: [], multiSelect: false }] },
    answerWith({ kind: "question", answers: { "Q?": "yes" } }),
  );
  assert.deepEqual(q, { behavior: "allow", updatedInput: { questions: [{ question: "Q?", header: "H", options: [], multiSelect: false }], answers: { "Q?": "yes" } } });

  const denied = await decidePermission("WebFetch", { url: "u" }, answerWith({ kind: "permission", allow: false, message: "use the RFC you know" }), { title: "t" });
  assert.equal(denied.behavior, "deny");
  assert.match((denied as { message: string }).message, /denied WebFetch\. Their note: use the RFC you know/);
  assert.equal((asked.at(-1) as { title?: string }).title, "t");
});

test("the UI token survives restarts, is owner-only, and rotates on request", async () => {
  const { loadOrCreateToken } = await import("../src/ui/server.ts");
  const { statSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const file = join(tempDir(), "sub", "ui-token");
  const first = loadOrCreateToken(file);
  assert.match(first, /^[0-9a-f]{48}$/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(loadOrCreateToken(file), first, "restart keeps the token, so open tabs keep working");
  const rotated = loadOrCreateToken(file, true);
  assert.notEqual(rotated, first);
  writeFileSync(file, "tampered");
  assert.notEqual(loadOrCreateToken(file), "tampered", "a malformed file is replaced");
});

test("ui-link lists the running UIs (real first), ignores crashed ones, and a demo can't erase the real one", async () => {
  const { writeSession, readLiveSessions, clearSession } = await import("../src/ui/session.ts");
  const dir = tempDir();
  const ports = () => readLiveSessions(dir).map((s) => s.port);
  assert.deepEqual(ports(), []);
  writeSession({ port: 4711, pid: process.pid, demo: true, startedAt: "2026-01-02" }, dir);
  writeSession({ port: 4710, pid: process.pid, demo: false, startedAt: "2026-01-01" }, dir);
  assert.deepEqual(ports(), [4710, 4711], "the real UI is listed first");
  writeSession({ port: 4712, pid: 2 ** 22 + 12345, demo: false, startedAt: "now" }, dir); // no such process
  assert.deepEqual(ports(), [4710, 4711], "a crashed UI's record is ignored");
  clearSession(4711, process.pid, dir); // the demo stops
  assert.deepEqual(ports(), [4710], "the real UI's record survives");
  clearSession(4710, process.pid + 1, dir);
  assert.deepEqual(ports(), [4710], "another process can't clear our record");
});

// ── HTTP server ──────────────────────────────────────────

function request(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers = { host: `127.0.0.1:${port}`, ...opts.headers, ...(payload !== undefined && { "content-length": String(Buffer.byteLength(payload)) }) };
    const req = http.request(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

test("the server needs its token, checks Host and Origin, and serves the API", async () => {
  const { manager, config } = await makeManager([]);
  const server = await startUiServer({ manager, config, token: "t".repeat(48) });
  const auth = { "x-shipyard-token": "t".repeat(48) };
  try {
    assert.equal((await request(server.port, "/api/state")).status, 401);
    assert.equal((await request(server.port, "/api/state", { headers: { ...auth, host: "evil.example:80" } })).status, 403, "DNS rebinding");

    // Without a token: a helpful page (not a dead end), styled, and nothing of the app.
    const signIn = await request(server.port, "/");
    assert.equal(signIn.status, 401);
    assert.match(String(signIn.headers["content-type"]), /text\/html/);
    assert.match(signIn.body, /Open your shipyard link/);
    assert.match(signIn.body, /ui-link/);
    assert.match((await request(server.port, "/?token=wrong")).body, /earlier session, or the token in it is wrong/);
    assert.equal((await request(server.port, "/styles.css")).status, 200, "the stylesheet is public");
    assert.equal((await request(server.port, "/app.js")).status, 401, "the app is not");

    const login = await request(server.port, `/?token=${"t".repeat(48)}`);
    assert.equal(login.status, 302);
    assert.match(String(login.headers["set-cookie"]), /shipyard_token=t+; HttpOnly; SameSite=Strict/);

    const page = await request(server.port, "/", { headers: { cookie: `shipyard_token=${"t".repeat(48)}` } });
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>shipyard<\/title>/);
    assert.match(String(page.headers["content-security-policy"]), /script-src 'self'/);

    const state = JSON.parse((await request(server.port, "/api/state", { headers: auth })).body);
    assert.equal(state.acceptsAttachments, true);
    assert.deepEqual(state.targets.map((t: { name: string }) => t.name), ["t0"]);
    assert.deepEqual(state.stages, ["triage", "plan", "implement", "design", "review", "revise", "security", "harden", "e2e", "repair", "docs", "release", "cloud-release"]);
    assert.deepEqual(state.optionalStages, ["triage", "plan", "design", "review", "security", "e2e", "repair", "docs", "release", "cloud-release"]);
    assert.deepEqual(state.implementers, ["backend", "frontend", "ui-ux"]);
    assert.deepEqual(state.config.models, ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    assert.deepEqual(state.efforts, ["low", "medium", "high", "xhigh", "max"]);
    assert.ok(state.roles.some((role: { name: string }) => role.name === "google-cloud-releaser"));

    const cross = await request(server.port, "/api/runs", { method: "POST", headers: { ...auth, origin: "http://evil.example" }, body: {} });
    assert.equal(cross.status, 403);

    const bad = await request(server.port, "/api/runs", { method: "POST", headers: auth, body: { target: "t0", kind: "bug", request: "" } });
    assert.equal(bad.status, 400);
    assert.match(JSON.parse(bad.body).error, /Describe/);
    // The dialog's model, effort and crew choices reach the manager's checks.
    for (const [extra, error] of [
      [{ model: "gpt-5" }, /Unknown model/],
      [{ effort: "extreme" }, /effort must be/],
      [{ crew: ["implement"] }, /implement always runs/],
    ] as const) {
      const res = await request(server.port, "/api/runs", { method: "POST", headers: auth, body: { target: "t0", kind: "bug", request: "x", ...extra } });
      assert.equal(res.status, 400);
      assert.match(JSON.parse(res.body).error, error);
    }

    assert.equal((await request(server.port, "/../../etc/passwd", { headers: auth })).status, 404, "no file paths from URLs");
  } finally {
    await server.close();
  }
});

test("end to end over HTTP with the demo crew: start, stream, answer the question, permission and checkpoints", async () => {
  const { manager, config } = await makeManager("demo");
  // The demo crew edits the demo-shop app; point the target at a real copy of it.
  const { makeSandbox, loadTasks } = await import("../src/eval.ts");
  const shop = await makeSandbox(loadTasks()[0]!, []);
  config.targets.t0 = { name: "t0", path: shop, test: "npm test", e2e: "npm run e2e" };

  const server = await startUiServer({ manager, config, token: "s".repeat(48), demo: true });
  const auth = { "x-shipyard-token": "s".repeat(48) };
  const seen: string[] = [];
  const stream = http.get({ host: "127.0.0.1", port: server.port, path: "/api/stream", headers: { host: `127.0.0.1:${server.port}`, ...auth } }, (res) => {
    res.on("data", (d: Buffer) => seen.push(...[...d.toString().matchAll(/^event: (\S+)/gm)].map((m) => m[1]!)));
  });
  try {
    const created = await request(server.port, "/api/runs", {
      method: "POST",
      headers: auth,
      body: { target: "t0", kind: "feature", request: "Add GET /health", checkpoints: ["implement", "e2e"] },
    });
    assert.equal(created.status, 201);
    const { id } = JSON.parse(created.body);

    const answer = async (item: InboxItem, body: unknown) => {
      const res = await request(server.port, `/api/inbox/${item.id}`, { method: "POST", headers: auth, body });
      assert.equal(res.status, 200, res.body);
    };
    const question = await nextItem(manager, (i) => i.kind === "question");
    await answer(question, { kind: "question", answers: { [question.kind === "question" ? question.questions[0]!.question : ""]: "Add product count" } });
    await answer(await nextItem(manager, (i) => i.kind === "checkpoint" && i.stage === "implement"), { kind: "checkpoint", action: "continue" });
    await answer(await nextItem(manager, (i) => i.kind === "permission"), { kind: "permission", decision: "allow" });
    await answer(await nextItem(manager, (i) => i.kind === "checkpoint" && i.stage === "e2e"), { kind: "checkpoint", action: "continue" });

    const run = await manager.whenDone(id);
    assert.equal(run?.status, "passed", JSON.stringify(run?.stages.map((s) => [s.name, s.status, s.attempts.map((a) => a.gates)])));
    const detail = JSON.parse((await request(server.port, `/api/runs/${id}`, { headers: auth })).body);
    assert.ok(detail.events.some((e: { type: string }) => e.type === "tool"));
    for (const type of ["active", "run", "event", "inbox", "inbox-resolved"]) assert.ok(seen.includes(type), `stream sent ${type}`);
    // The question's answer changed what the agent built.
    const { git } = await import("../src/exec.ts");
    assert.match(await git(["show", `${run!.branch}:src/server.js`], run!.repo), /products: catalog\.list/);
  } finally {
    stream.destroy();
    await server.close();
  }
});

test("the UI routes concurrent Claude and Codex runs, and checkpoint feedback resumes the selected provider", async () => {
  const { config, runner: claude } = await makeManager([fix]);
  config.defaultProvider = "codex";
  config.codex = { model: "codex-test", models: ["codex-test"], effort: "xhigh", timeoutMsPerAttempt: 10_000 };
  const usage = { inputTokens: 7, cachedInputTokens: 2, outputTokens: 3 };
  const codex = new FakeRunner([
    (req) => {
      assert.equal(req.ask, undefined);
      assert.equal(req.model, "codex-test");
      assert.equal(req.effort, "xhigh");
      assert.match(req.prompt, /initial\.png/);
      assert.ok(req.images?.[0]?.path.endsWith("initial.png"));
      fix(req);
      return { sessionId: "codex-thread", costUsd: null, usage };
    },
    (req) => {
      assert.equal(req.resumeSessionId, "codex-thread");
      assert.match(req.prompt, /Add one more case/);
      assert.match(req.prompt, /checkpoint\.png/);
      assert.equal(req.images?.length, 1);
      assert.ok(req.images?.[0]?.path.endsWith("checkpoint.png"));
      writeFiles(req.cwd, { "test/extra.test.js": UNIT_TEST });
      return { sessionId: "codex-thread", costUsd: null, usage };
    },
  ]);
  const manager = new RunManager({ config, roles: loadRoles(), runner: claude, codexRunner: codex });
  const server = await startUiServer({ manager, config, token: "p".repeat(48) });
  const post = (body: object) => request(server.port, "/api/runs", {
    method: "POST", headers: { "x-shipyard-token": "p".repeat(48) }, body,
  });
  const base = { target: "t0", kind: "feature", request: "Fix addition", crew: [], checkpoints: ["implement"] };
  try {
    assert.match((await post({ ...base, model: config.model })).body, /Unknown model.*for codex/);
    assert.match((await post({ ...base, budgetUsd: 3 })).body, /Dollar budgets are only supported for Claude/);
    assert.match((await post({ ...base, provider: "invalid" })).body, /Provider must be claude or codex/);
    const [codexResponse, claudeResponse] = await Promise.all([
      post({ ...base, attachments: [imageAttachment("initial.png")] }), post({ ...base, provider: "claude" }),
    ]);
    assert.equal(codexResponse.status, 201);
    assert.equal(claudeResponse.status, 201);
    const codexId = JSON.parse(codexResponse.body).id;
    const claudeId = JSON.parse(claudeResponse.body).id;
    const [codexItem, claudeItem] = await Promise.all([
      nextItem(manager, (item) => item.runId === codexId),
      nextItem(manager, (item) => item.runId === claudeId),
    ]);
    assert.ok(codexItem.kind === "checkpoint" && codexItem.checkpoint.provider === "codex");
    assert.ok(claudeItem.kind === "checkpoint" && claudeItem.checkpoint.provider === "claude");
    assert.equal((await request(server.port, `/api/inbox/${codexItem.id}`, {
      method: "POST", headers: { "x-shipyard-token": server.token },
      body: { kind: "checkpoint", action: "feedback", message: "Add one more case", attachments: [imageAttachment("checkpoint.png")] },
    })).status, 200);
    manager.answer(claudeItem.id, { kind: "checkpoint", action: "continue" });
    const codexRetry = await nextItem(manager, (item) => item.runId === codexId);
    manager.answer(codexRetry.id, { kind: "checkpoint", action: "continue" });
    const [codexRun, claudeRun] = await Promise.all([manager.whenDone(codexId), manager.whenDone(claudeId)]);
    assert.equal(codexRun?.status, "passed");
    assert.equal(claudeRun?.status, "passed");
    assert.equal(claudeRun?.totals.costUsd, 0.1);
    assert.equal(codexRun?.totals.costUsd, null);
    assert.deepEqual(codexRun?.totals.usage, { inputTokens: 14, cachedInputTokens: 4, outputTokens: 6 });
  } finally {
    await server.close();
  }
});

test("steer interrupts a Claude question, then switching at a checkpoint continues on the same worktree", { timeout: 20_000 }, async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { config } = await makeManager([]);
  const claude = new FakeRunner([
    async (req) => {
      fix(req);
      await req.ask!({
        kind: "question",
        questions: [{ question: "Use strings?", header: "Input", options: [{ label: "Yes", description: "" }], multiSelect: false }],
      });
      assert.equal(req.signal?.aborted, true);
      return { ok: false, sessionId: "claude-implement", error: "interrupted" };
    },
    (req) => {
      assert.equal(req.resumeSessionId, "claude-implement");
      assert.match(req.prompt, /Keep the original tests/);
      assert.ok(req.images?.[0]?.path.endsWith("steer.png"));
      return { sessionId: "claude-implement" };
    },
  ]);
  const codex = new FakeRunner([
    (req) => {
      assert.equal(req.resumeSessionId, undefined);
      assert.equal(req.ask, undefined);
      assert.match(req.prompt, /Original request: Fix addition/);
      assert.match(req.prompt, /Keep the original tests/);
      assert.match(req.prompt, /Also cover strings/);
      assert.deepEqual(req.images?.map(({ path }) => path.split("-").at(-1)), ["steer.png", "switch.png"]);
      assert.equal(req.cwd, claude.calls[0]!.cwd);
      assert.match(readFileSync(join(req.cwd, "src/add.js"), "utf8"), /Number\(a\)/);
      writeFiles(req.cwd, { "test/strings.test.js": UNIT_TEST.replace("add(2, 3)", 'add("2", "3")') });
      return { sessionId: "codex-implement", costUsd: null, usage: { inputTokens: 5, outputTokens: 2, cachedInputTokens: 0 } };
    },
  ]);
  const manager = new RunManager({ config, roles: loadRoles(), runner: claude, codexRunner: codex });
  const auth = { "x-shipyard-token": "e".repeat(48) };
  const server = await startUiServer({ manager, config, token: auth["x-shipyard-token"] });
  const id = manager.start({ target: "t0", kind: "feature", request: "Fix addition", crew: [], checkpoints: ["implement"] });
  const controls = (body: object) => request(server.port, `/api/runs/${id}/control`, { method: "POST", headers: auth, body });
  const archive = (archived: boolean, headers: Record<string, string> = auth) =>
    request(server.port, `/api/runs/${id}`, { method: "PATCH", headers, body: { archived } });
  try {
    const question = await nextItem(manager, (item) => item.kind === "question");
    assert.equal((await archive(true)).status, 400, "an active run must stop before it can be archived");
    assert.equal((await controls({ action: "steer", message: "Keep the original tests", attachments: [imageAttachment("steer.png")] })).status, 202);
    const claudeCheckpoint = await nextItem(manager, (item) => item.kind === "checkpoint");
    assert.ok(claudeCheckpoint.kind === "checkpoint" && claudeCheckpoint.checkpoint.provider === "claude");
    assert.ok(!manager.inbox().some((item) => item.id === question.id));
    assert.equal((await controls({ action: "switch-provider", provider: "codex", message: "Also cover strings", attachments: [imageAttachment("switch.png")] })).status, 202);
    const codexCheckpoint = await nextItem(manager, (item) => item.kind === "checkpoint" && item.checkpoint.provider === "codex");
    assert.ok(!manager.inbox().some((item) => item.id === claudeCheckpoint.id));
    manager.answer(codexCheckpoint.id, { kind: "checkpoint", action: "continue" });
    const run = await manager.whenDone(id);
    assert.equal(run?.status, "passed");
    assert.equal(run?.provider, "codex");
    assert.equal(run?.totals.costUsd, 0.2);
    assert.equal(run?.totals.usage?.inputTokens, 5);
    assert.deepEqual(run?.stages[0]?.attempts.map((attempt) => [attempt.provider, attempt.interrupted]), [
      ["claude", "redirected"], ["claude", "redirected"], ["codex", undefined],
    ]);

    assert.equal((await archive(true, { ...auth, origin: "http://evil.example" })).status, 403);
    const archived = await archive(true);
    assert.equal(archived.status, 200);
    assert.ok(manager.store.get(id)?.archivedAt);
    assert.equal(manager.store.get(id)?.branch, run?.branch);
    assert.ok(manager.store.events(id).length);
    assert.equal((await archive(false)).status, 200);
    assert.equal(manager.store.get(id)?.archivedAt, undefined);
  } finally {
    await Promise.all([manager.shutdown(), server.close()]);
  }
});

test("stop interrupts a running gate and keeps the worktree and unrelated runs", { timeout: 20_000 }, async () => {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { setTimeout: sleep } = await import("node:timers/promises");
  const { config } = await makeManager([], 2);
  config.targets.t0!.test = `node -e "require('node:fs').writeFileSync('gate-ready', 'ready'); setInterval(() => {}, 1000)"`;
  config.targets.t1!.test = "true";
  const runner = new FakeRunner([fix, fix]);
  const manager = new RunManager({ config, roles: loadRoles(), runner });
  const start = (target: string) => manager.start({ target, request: "Fix addition", kind: "feature", crew: [], checkpoints: [] });
  const stopping = start("t0");
  const other = start("t1");
  try {
    let worktree = "";
    for (let i = 0; i < 140; i++) {
      worktree = manager.store.get(stopping)?.worktree ?? "";
      if (worktree && existsSync(join(worktree, "gate-ready"))) break;
      await sleep(20);
    }
    assert.ok(worktree && existsSync(join(worktree, "gate-ready")), "the test command must be active when Stop is requested");
    manager.controlRun(stopping, { action: "stop" });
    const run = await manager.whenDone(stopping);
    assert.equal(run?.status, "stopped");
    assert.equal(run?.stages[0]?.attempts[0]?.interrupted, "stopped");
    assert.equal(run?.stages[0]?.commit, undefined);
    assert.ok(existsSync(join(worktree, "test/add.test.js")));
    assert.equal((await manager.whenDone(other))?.status, "passed");
  } finally {
    await manager.shutdown();
  }
});

test("switching an active Codex run to Claude enables the Claude budget and starts a fresh Claude session", { timeout: 20_000 }, async () => {
  const { once } = await import("node:events");
  const { config } = await makeManager([]);
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const codex = new FakeRunner([
    async (req) => {
      fix(req);
      const aborted = once(req.signal!, "abort");
      started();
      await aborted;
      return { ok: false, costUsd: null, sessionId: "codex-thread" };
    },
  ]);
  const claude = new FakeRunner([
    (req) => {
      assert.equal(req.resumeSessionId, undefined);
      assert.equal(req.cwd, codex.calls[0]!.cwd);
      assert.equal(req.model, config.model);
      assert.equal(req.maxBudgetUsd, config.maxBudgetUsdPerRun);
      assert.ok(req.ask);
      return { sessionId: "claude-thread" };
    },
  ]);
  const manager = new RunManager({ config, roles: loadRoles(), runner: claude, codexRunner: codex });
  try {
    const id = manager.start({ provider: "codex", target: "t0", kind: "feature", request: "Fix addition", crew: [], checkpoints: [] });
    await waiting;
    manager.controlRun(id, { action: "switch-provider", provider: "claude" });
    const run = await manager.whenDone(id);
    assert.equal(run?.status, "passed");
    assert.equal(run?.provider, "claude");
    assert.deepEqual(run?.stages[0]?.attempts.map((attempt) => [attempt.provider, attempt.sessionId]), [
      ["codex", "codex-thread"], ["claude", "claude-thread"],
    ]);
  } finally {
    await manager.shutdown();
  }
});

for (const provider of ["claude", "codex"] as const) {
  test(`resuming an interrupted ${provider} run preserves completed work and recovers the active attempt`, { timeout: 20_000 }, async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { git } = await import("../src/exec.ts");
    const { config } = await makeManager([]);
    const roles = loadRoles();
    const first = new FakeRunner([fix]);
    const initial = new RunManager({ config, roles, runner: first, codexRunner: first });
    const id = initial.start({ provider, target: "t0", kind: "feature", request: "Fix addition", crew: [], checkpoints: [] });
    const run = await initial.whenDone(id);
    assert.equal(run?.status, "passed");
    assert.ok(run);
    const commit = run.stages[0]?.commit;
    assert.ok(commit);

    run.status = "running";
    run.finishedAt = undefined;
    run.crew = ["review"];
    run.stages.push({ name: "review", role: "reviewer", status: "running", attempts: [] });
    initial.store.save(run);
    initial.store.event(id, { stage: "review", attempt: 1, type: "attempt_start", provider, prompt: "Interrupted review" });
    if (provider === "codex") {
      initial.store.event(id, { stage: "review", attempt: 1, type: "session", sessionId: "review-codex" });
    } else {
      // Legacy records did not persist either the checkpoint selection or early session IDs.
      delete run.checkpointStages;
      initial.store.save(run);
    }

    const review = new FakeRunner([(req) => {
      assert.equal(req.role.name, "reviewer");
      assert.equal(req.cwd, run.worktree);
      assert.equal(req.resumeSessionId, provider === "codex" ? "review-codex" : undefined);
      assert.match(req.prompt, /Resume the interrupted stage/);
      assert.match(req.prompt, /Fix addition/);
      assert.match(readFileSync(join(req.cwd, "src/add.js"), "utf8"), /Number\(a\)/);
      return { structured: { verdict: "approve", summary: "Reviewed", findings: [] } };
    }]);
    const manager = new RunManager({ config, roles, runner: review, codexRunner: review });
    const auth = { "x-shipyard-token": "q".repeat(48) };
    const server = await startUiServer({ manager, config, token: auth["x-shipyard-token"] });
    const deleteRun = (body: object) => request(server.port, `/api/runs/${id}`, { method: "DELETE", headers: auth, body });
    try {
      const accepted = await request(server.port, `/api/runs/${id}/resume`, { method: "POST", headers: auth });
      assert.equal(accepted.status, 202);
      if (provider === "claude") {
        const checkpoint = await nextItem(manager);
        assert.equal(checkpoint.stage, "review");
        assert.equal((await deleteRun({ confirm: true })).status, 400);
        manager.answer(checkpoint.id, { kind: "checkpoint", action: "continue" });
      }
      const resumed = await manager.whenDone(id);
      assert.equal(resumed?.status, "passed");
      assert.equal(resumed?.id, id);
      assert.equal(resumed?.stages[0]?.commit, commit);
      assert.deepEqual(resumed?.stages[1]?.attempts.map((attempt) => [attempt.attempt, attempt.interrupted]), [
        [1, "interrupted"], [2, undefined],
      ]);
      assert.equal(review.calls.length, 1);

      assert.equal((await deleteRun({})).status, 400);
      const crossSite = await request(server.port, `/api/runs/${id}`, {
        method: "DELETE", headers: { ...auth, origin: "http://evil.example" }, body: { confirm: true },
      });
      assert.equal(crossSite.status, 403);
      assert.equal((await deleteRun({ confirm: true })).status, 200);
      assert.equal(manager.store.get(id), null);
      assert.ok(existsSync(run.worktree));
      assert.equal(await git(["rev-parse", run.branch], run.repo), commit);
    } finally {
      await Promise.all([manager.shutdown(), server.close()]);
    }
  });
}

test("completed runs persist an unread result and can acknowledge only the current finish", async () => {
  const { manager, config } = await makeManager([fix]);
  const id = manager.start({ target: "t0", kind: "feature", request: "Show run result", crew: [], checkpoints: [] });
  const run = await manager.whenDone(id);
  assert.equal(run?.status, "passed");
  assert.equal(run?.completionRead, false);
  assert.ok(run?.finishedAt);
  const restarted = new RunManager({ config, roles: loadRoles(), runner: new FakeRunner([]) });
  assert.equal(restarted.store.get(id)?.completionRead, false);
  assert.throws(() => restarted.acknowledgeCompletion(id, "stale"), /result has changed/);
  assert.equal(restarted.acknowledgeCompletion(id, run.finishedAt).completionRead, true);
  assert.equal(manager.store.get(id)?.completionRead, true);
});

test("multiple references request approval and browser help independently before either provider starts", { timeout: 45_000 }, async (t) => {
  const { config } = await makeManager([]);
  config.targets.t0!.test = "true";
  const source = "https://www.linkedin.com/in/example";
  const other = "https://www.linkedin.com/in/another";
  const skipped = "https://www.linkedin.com/in/skip";
  const review = "Reviewed reference content from the profile";
  const otherReview = "Notes for the second source";
  const fetched: string[] = [];
  const reads = t.mock.method(globalThis, "fetch", async (input: unknown) => {
    fetched.push(String(input));
    return new Response(null, { status: 302, headers: { location: "/authwall" } });
  });
  const work: Step = (req) => {
    assert.ok(req.prompt.includes(review));
    assert.ok(req.prompt.includes(otherReview));
    return fix(req);
  };
  const claude = new FakeRunner([work]);
  const codex = new FakeRunner([work]);
  const manager = new RunManager({ config, roles: loadRoles(), runner: claude, codexRunner: codex });
  const server = await startUiServer({ manager, config, token: "a".repeat(48) });
  const headers = { "x-shipyard-token": server.token };
  try {
    for (const [provider, runner] of [["claude", claude], ["codex", codex]] as const) {
      const readCount = fetched.length;
      const id = manager.start({ target: "t0", kind: "feature", request: `Build with ${source}, ${other}, and ${skipped}`, provider,
        referenceUrls: [source], browserReferenceHelp: true, crew: [], checkpoints: [] });
      const itemFor = (url: string, needsApproval = false) => nextItem(manager, (item) =>
        item.kind === "reference" && item.runId === id && item.url === url && Boolean(item.needsApproval) === needsApproval);
      const [item, approval, skip] = await Promise.all([itemFor(source), itemFor(other, true), itemFor(skipped, true)]);
      assert.deepEqual(fetched.slice(readCount), [source]);
      assert.equal(manager.store.get(id)?.stages.length, 0);
      assert.equal(runner.calls.length, 0);
      const answer = (id: string, action: string, text?: string) => request(server.port, `/api/inbox/${id}`, {
        method: "POST", headers, body: { kind: "reference", action, text },
      });
      assert.equal((await answer(approval.id, "share", otherReview)).status, 400);
      assert.equal((await answer(skip.id, "skip")).status, 200);
      assert.equal((await answer(approval.id, "approve")).status, 200);
      const second = await itemFor(other);
      assert.ok(manager.inbox().some((pending) => pending.id === item.id));
      const handoffFor = (url: string, itemId: string) => manager.openReferenceHandoff(id, { url, itemId }, server.port);
      const firstHandoff = handoffFor(source, item.id);
      const ticket = firstHandoff.prompt.match(/\b[0-9a-f]{48}\b/)?.[0];
      assert.ok(ticket);
      const draft = { status: "ready", text: review, coverage: ["Profile"], missing: ["Earlier experience required sign-in"] };
      manager.returnReferenceHandoff(ticket, draft);
      assert.equal(handoffFor(other, second.id).draft, undefined);
      assert.equal((await answer(second.id, "share", otherReview)).status, 200);
      assert.deepEqual(handoffFor(source, item.id).draft, draft);
      assert.equal(runner.calls.length, 0);
      assert.equal((await answer(item.id, "share", review)).status, 200);
      const run = await manager.whenDone(id);
      assert.equal(run?.status, "passed");
      assert.deepEqual(run?.referenceUrls, [source, other]);
      assert.deepEqual(run?.references?.filter((ref) => ref.shared).map(({ url, content }) => [url, content]), [
        [other, otherReview], [source, review],
      ]);
      const partial = run?.references?.find(({ url }) => url === source);
      assert.equal(partial?.status, "partial");
      assert.deepEqual(partial?.coverage, draft.coverage);
      assert.deepEqual(partial?.missing, draft.missing);
      const shared = manager.store.events(id).find((event) => event.kind === "reference" && event.type === "answered" && (event.answer as { action?: string })?.action === "share");
      assert.deepEqual(shared?.answer, { kind: "reference", action: "share" });
      assert.deepEqual(fetched.slice(readCount), [source, other]);
    }
    assert.equal(reads.mock.callCount(), 4);
  } finally {
    await Promise.all([manager.shutdown(), server.close()]);
  }
});

test("checking another reference after completion preserves previously reviewed notes", async (t) => {
  const { manager, config } = await makeManager([fix]);
  config.targets.t0!.test = "true";
  const first = "https://www.linkedin.com/in/first";
  const second = "https://www.linkedin.com/in/second";
  const fetched = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 302, headers: { location: "/authwall" } }));
  const id = manager.start({ target: "t0", kind: "feature", request: `Research ${first} and ${second}`,
    referenceUrls: [first], crew: [], checkpoints: [] });
  assert.equal((await manager.whenDone(id))?.status, "passed");
  manager.saveSharedReference(id, first, "Reviewed notes for the first profile");
  const updated = await manager.checkResultReferences(id, [second]);
  assert.deepEqual(updated.referenceUrls, [first, second]);
  assert.deepEqual(updated.references?.map(({ url, status, content }) => [url, status, content]), [
    [first, "partial", "Reviewed notes for the first profile"], [second, "blocked", undefined],
  ]);
  const handoff = manager.openReferenceHandoff(id, { url: first }, 3000);
  const ticket = handoff.prompt.match(/\b[0-9a-f]{48}\b/)?.[0];
  assert.ok(ticket);
  manager.returnReferenceHandoff(ticket, { status: "ready", text: "Full work history", coverage: ["Experience"], missing: [] });
  const completed = manager.saveSharedReference(id, first, "Full work history");
  assert.equal(completed.references?.find(({ url }) => url === first)?.status, "read");
  assert.equal(fetched.mock.callCount(), 2);
});

test("native handoffs open the selected provider and return a draft for human review", { timeout: 25_000 }, async (t) => {
  const { config } = await makeManager([]);
  config.targets.t0!.test = "true";
  const source = "https://www.linkedin.com/in/example";
  const text = "Reviewed notes returned by the interactive browser";
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 302, headers: { location: "/authwall" } }));
  const work: Step = (req) => {
    assert.match(req.prompt, /Reviewed notes returned by the interactive browser/);
    fix(req);
  };
  const claude = new FakeRunner([work]);
  const codex = new FakeRunner([work]);
  const manager = new RunManager({ config, roles: loadRoles(), runner: claude, codexRunner: codex });
  const server = await startUiServer({ manager, config });
  const headers = { "x-shipyard-token": server.token };
  const runHelper = promisify(execFile);
  const notes = join(tempDir(), "notes.json");
  writeFileSync(notes, JSON.stringify({ status: "ready", text, coverage: ["Experience"] }));
  try {
    for (const [provider, runner] of [["claude", claude], ["codex", codex]] as const) {
      const id = manager.start({ target: "t0", kind: "feature", request: "Research the attached profile", provider,
        referenceUrls: [source], browserReferenceHelp: true, crew: [], checkpoints: [] });
      const item = await nextItem(manager);
      const route = `/api/runs/${id}/references/handoff`;
      const body = { url: source, itemId: item.id };
      const issue = (input = body) => request(server.port, route, { method: "POST", headers, body: input });
      assert.equal((await issue({ ...body, itemId: "other" })).status, 400);
      assert.equal((await issue({ ...body, url: "https://www.linkedin.com/in/unapproved" })).status, 400);

      const response = await issue();
      assert.equal(response.status, 200);
      const handoff = JSON.parse(response.body);
      const link = new URL(handoff.href);
      const draftPrompt = link.searchParams.get(provider === "codex" ? "prompt" : "q");
      assert.equal(link.protocol, `${provider}:`);
      assert.equal(draftPrompt, handoff.prompt);
      assert.equal(handoff.provider, provider);
      assert.ok(!handoff.prompt.includes(server.token));
      const ticket = handoff.prompt.match(/\b[0-9a-f]{48}\b/)?.[0];
      assert.ok(ticket);
      const scopedHeaders = { authorization: `Bearer ${ticket}` };
      assert.equal((await request(server.port, "/api/state", { headers: scopedHeaders })).status, 401);
      assert.equal((await request(server.port, "/api/reference-handoff", { headers: { ...scopedHeaders, origin: "https://other.example" } })).status, 403);

      const context = await runHelper(process.execPath, ["bin/shipyard-reference.mjs", "context", String(server.port), ticket]);
      assert.deepEqual(JSON.parse(context.stdout), { url: source, provider, brief: "Research the attached profile", submitted: false });
      await runHelper(process.execPath, ["bin/shipyard-reference.mjs", "submit", String(server.port), ticket, notes]);
      assert.equal(runner.calls.length, 0);
      assert.equal(manager.store.get(id)?.references?.[0]?.content, undefined);
      const returned = JSON.parse((await issue()).body);
      assert.deepEqual(returned.draft, { status: "ready", text, coverage: ["Experience"] });
      assert.ok(!JSON.stringify(manager.store.events(id)).includes(ticket));

      manager.answer(item.id, { kind: "reference", action: "share", text });
      assert.equal((await manager.whenDone(id))?.status, "passed");
      assert.equal((await request(server.port, "/api/reference-handoff", { headers: scopedHeaders })).status, 400);
      assert.equal(runner.calls.length, 1);
      assert.equal(manager.store.get(id)?.references?.[0]?.content, text);
    }
  } finally {
    await Promise.all([manager.shutdown(), server.close()]);
  }
});

test("canceling or switching providers revokes the pending native handoff", { timeout: 15_000 }, async (t) => {
  const { config } = await makeManager([]);
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 302, headers: { location: "/authwall" } }));
  const url = "https://www.linkedin.com/in/example";
  const manager = new RunManager({ config, roles: loadRoles(), runner: new FakeRunner([]), codexRunner: new FakeRunner([]) });
  const server = await startUiServer({ manager, config });
  const headers = { "x-shipyard-token": server.token };
  try {
    const id = manager.start({ target: "t0", kind: "feature", request: "Research", referenceUrls: [url], browserReferenceHelp: true, crew: [], checkpoints: [] });
    const item = await nextItem(manager);
    const route = `/api/runs/${id}/references/handoff`;
    const body = { itemId: item.id, url };
    const issue = async () => JSON.parse((await request(server.port, route, { method: "POST", headers, body })).body);
    const first = await issue();
    const old = first.prompt.match(/\b[0-9a-f]{48}\b/)[0];
    manager.controlRun(id, { action: "switch-provider", provider: "codex" });
    const latest = await issue();
    const current = latest.prompt.match(/\b[0-9a-f]{48}\b/)[0];
    assert.equal(latest.provider, "codex");
    assert.notEqual(old, current);
    const context = (ticket: string) => request(server.port, "/api/reference-handoff", { headers: { authorization: `Bearer ${ticket}` } });
    assert.equal((await context(old)).status, 400);
    assert.equal((await context(current)).status, 200);
    assert.equal((await request(server.port, route, { method: "DELETE", headers, body })).status, 200);
    assert.equal((await context(current)).status, 400);
    assert.equal(manager.inbox()[0]?.id, item.id);
  } finally {
    await Promise.all([manager.shutdown(), server.close()]);
  }
});

test("the handoff pushes only the confirmed completed branch to the selected remote", async () => {
  const { git } = await import("../src/exec.ts");
  const { manager, config } = await makeManager([fix,
    () => ({ structured: { assignments: [{ role: "backend", task: "Add a description" }] } }),
    (req) => writeFiles(req.cwd, { "description.md": "A new description.\n" }),
  ]);
  const server = await startUiServer({ manager, config });
  const headers = { "x-shipyard-token": server.token };
  const id = manager.start({ target: "t0", kind: "feature", request: "Publish the completed run", crew: [], checkpoints: [] });
  const path = `/api/runs/${id}`;
  const remote = tempDir("sy-publish-");
  const push = (body: Record<string, string>, authenticated = true) =>
    request(server.port, `${path}/publish`, { method: "POST", headers: authenticated ? headers : undefined, body });
  try {
    const run = await manager.whenDone(id);
    assert.ok(run && run.status === "passed");
    await git(["init", "--bare"], remote);
    await git(["remote", "add", "origin", remote], run.repo);
    await git(["config", "remote.origin.mirror", "true"], run.repo);
    await git(["config", "push.followTags", "true"], run.repo);
    await git(["-c", "user.name=test", "-c", "user.email=test@example.com", "tag", "-am", "do not push", "local-only", run.baseSha], run.repo);
    const readResult = async () => JSON.parse((await request(server.port, `${path}/result`, { headers })).body);
    const ready = (await readResult()).publish;
    assert.equal(ready.remote, "origin");
    assert.equal(ready.pushed, false);
    const confirmation = { head: ready.head, destination: ready.destination };
    assert.equal((await push(confirmation, false)).status, 401);
    assert.equal((await push({ ...confirmation, head: run.baseSha })).status, 400);
    assert.equal((await push({ ...confirmation, destination: "outdated" })).status, 400);
    assert.equal(await git(["for-each-ref"], remote), "");
    assert.equal((await push(confirmation)).status, 200);
    assert.equal(await git(["for-each-ref", "--format=%(refname)"], remote), `refs/heads/${run.branch}`);
    assert.equal(await git(["rev-parse", `refs/heads/${run.branch}`], remote), ready.head);
    assert.equal((await readResult()).publish.pushed, true);
    assert.equal((await push(confirmation)).status, 200);
    assert.equal(manager.store.events(id).filter(({ type }) => type === "branch-pushed").length, 1);

    const pullRequestUrl = "https://github.com/example/fixture/pull/42";
    const published = manager.store.get(id)!;
    published.publication = { ...published.publication!, pullRequestUrl };
    manager.store.save(published);
    writeFiles(run.worktree, { "saved-notes.txt": "Keep these edits." });
    await assert.rejects(manager.startFollowUp(id, { message: "Add a description" }), /has saved edits/);
    assert.equal(readFileSync(join(run.worktree, "saved-notes.txt"), "utf8"), "Keep these edits.");
    unlinkSync(join(run.worktree, "saved-notes.txt"));
    const submissions = await Promise.allSettled([
      manager.startFollowUp(id, { message: "Add a description" }),
      manager.startFollowUp(id, { message: "Add a description" }),
    ]);
    assert.equal(submissions.filter((submission) => submission.status === "rejected").length, 1);
    const revisionId = submissions.find((submission) => submission.status === "fulfilled")!.value;
    const revision = await manager.whenDone(revisionId);
    assert.equal(revision?.status, "passed");
    assert.equal(revision?.worktree, run.worktree);
    assert.equal(revision?.branch, run.branch);
    assert.equal(revision?.baseSha, ready.head);
    const history = await readResult();
    assert.equal(history.handoff.head, ready.head);
    assert.equal(history.latestRevisionId, revisionId);
    assert.equal(history.publish, undefined);
    const update = (await manager.result(revisionId)).publish!;
    assert.ok(update.head);
    assert.equal(update.pullRequestUrl, pullRequestUrl);
    assert.equal(update.pushed, false);
    assert.equal((await push({ head: update.head, destination: update.destination })).status, 400);
    await manager.publish(revisionId, { head: update.head, destination: update.destination });
    assert.equal((await manager.result(revisionId)).publish?.pullRequestUrl, pullRequestUrl);
    assert.equal(await git(["for-each-ref", "--format=%(refname)"], remote), `refs/heads/${run.branch}`);
    assert.equal(await git(["rev-parse", `refs/heads/${run.branch}`], remote), update.head);
  } finally {
    await Promise.all([manager.shutdown(), server.close()]);
  }
});

test("the handoff creates a draft or regular GitHub pull request and recovers its link on retry", async () => {
  const { git } = await import("../src/exec.ts");
  const { manager, config } = await makeManager([fix]);
  const server = await startUiServer({ manager, config });
  const headers = { "x-shipyard-token": server.token };
  const id = manager.start({ target: "t0", kind: "feature", request: "Create the pull request", crew: [], checkpoints: [] });
  const path = `/api/runs/${id}`;
  const create = (body: Record<string, unknown>, authenticated = true) => request(server.port, `${path}/pull-request`, {
    method: "POST", headers: authenticated ? headers : undefined, body,
  });
  try {
    const run = await manager.whenDone(id);
    assert.ok(run && run.status === "passed");
    await git(["remote", "add", "origin", "git@github.com:example/fixture.git"], run.repo);
    const ready = (await manager.result(id)).publish!;
    const confirmation = { head: ready.head!, destination: ready.destination };
    assert.equal((await create(confirmation, false)).status, 401);
    assert.equal((await create(confirmation)).status, 400);

    // Simulate a successful GitHub push, then exercise the real authenticated HTTP route with a fake CLI.
    const saved = manager.store.get(id)!;
    saved.publication = { ...confirmation, pushedAt: new Date().toISOString() };
    manager.store.save(saved);
    const fake = tempDir("sy-gh-");
    const log = join(fake, "calls");
    const pr = "https://github.com/example/fixture/pull/42";
    const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const input = args.includes("--input") ? JSON.parse(fs.readFileSync(args[args.indexOf("--input") + 1], "utf8")) : undefined;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(input ? [...args, input] : args) + "\\n");
const endpoint = args[3];
if (endpoint.includes("/git/ref/heads/")) console.log(process.env.SHIPYARD_TEST_GITHUB_HEAD);
else if (endpoint === "repos/example/fixture") console.log("trunk");
else if (endpoint.includes("/compare/")) {
  const scenario = process.env.SHIPYARD_TEST_GITHUB_COMPARISON;
  if (scenario === "unrelated") {
    console.error("gh: No common ancestor between trunk and the run commit. (HTTP 404)");
    process.exitCode = 1;
  } else console.log(scenario === "merged" ? "0" : "1");
}
else if (endpoint === "repos/example/fixture/pulls" && args.includes("POST")) {
  fs.writeFileSync(${JSON.stringify(join(fake, "created"))}, ${JSON.stringify(pr)});
  console.log(${JSON.stringify(pr)});
} else if (endpoint === "repos/example/fixture/pulls" && fs.existsSync(${JSON.stringify(join(fake, "created"))})) {
  console.log(${JSON.stringify(pr)});
}
`;
    writeFileSync(join(fake, "gh"), script, { mode: 0o755 });
    const originalPath = process.env.PATH;
    const originalHead = process.env.SHIPYARD_TEST_GITHUB_HEAD;
    const originalComparison = process.env.SHIPYARD_TEST_GITHUB_COMPARISON;
    process.env.PATH = `${fake}:${originalPath}`;
    try {
      process.env.SHIPYARD_TEST_GITHUB_HEAD = run.baseSha;
      assert.match((await create(confirmation)).body, /no longer matches the pushed commit/);
      process.env.SHIPYARD_TEST_GITHUB_HEAD = confirmation.head;
      assert.equal((await create({ ...confirmation, destination: "stale" })).status, 400);
      assert.equal((await create({ ...confirmation, draft: "true" })).status, 400);
      for (const [scenario, message] of [["unrelated", /unrelated histories/], ["merged", /no commits to merge/]] as const) {
        process.env.SHIPYARD_TEST_GITHUB_COMPARISON = scenario;
        const blocked = (await manager.result(id)).publish!;
        assert.equal(blocked.canCreatePullRequest, undefined);
        assert.match(blocked.pullRequestUnavailable ?? "", message);
        const rejected = await create(confirmation);
        assert.equal(rejected.status, 400);
        assert.match(rejected.body, message);
      }
      delete process.env.SHIPYARD_TEST_GITHUB_COMPARISON;
      assert.equal((await manager.result(id)).publish?.canCreatePullRequest, true);
      const response = await create({ ...confirmation, draft: true });
      assert.equal(response.status, 200, response.body);
      assert.equal(JSON.parse(response.body).publish.pullRequestUrl, pr);
      assert.equal((await manager.result(id)).publish?.pullRequestUrl, pr);
      assert.equal((await create(confirmation)).status, 200);

      manager.store.save(saved); // GitHub accepted the PR, but the local result was not saved.
      assert.equal(JSON.parse((await create({ ...confirmation, draft: true })).body).publish.pullRequestUrl, pr);
      unlinkSync(join(fake, "created")); // Simulate the original PR closing before testing the legacy request.
      manager.store.save(saved);
      assert.equal((await create(confirmation)).status, 200);
      const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Array<string | { head: string; base: string; draft: boolean; body: string }>);
      const posts = calls.filter((args) => args.includes("POST"));
      assert.equal(posts.length, 2);
      assert.deepEqual(posts[0]?.slice(0, 7), ["api", "--hostname", "github.com", "repos/example/fixture/pulls", "--method", "POST", "--input"]);
      const payloads = posts.map((args) => args.at(-1));
      assert.ok(payloads.every((payload) => typeof payload === "object" && payload.head === run.branch && payload.base === "trunk" && /## Verification/.test(payload.body)));
      assert.deepEqual(payloads.map((payload) => typeof payload === "object" && payload.draft), [true, false]);
      assert.ok(calls.some((args) => args.includes(`head=example:${run.branch}`) && args.includes("state=open")));
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalHead === undefined) delete process.env.SHIPYARD_TEST_GITHUB_HEAD;
      else process.env.SHIPYARD_TEST_GITHUB_HEAD = originalHead;
      if (originalComparison === undefined) delete process.env.SHIPYARD_TEST_GITHUB_COMPARISON;
      else process.env.SHIPYARD_TEST_GITHUB_COMPARISON = originalComparison;
    }
  } finally {
    await Promise.all([manager.shutdown(), server.close()]);
  }
});

test("the draft PR handoff reviews unrelated histories, verifies a compatible branch, and publishes only after approval", { timeout: 60_000 }, async () => {
  const { git } = await import("../src/exec.ts");
  const { initRepoWithCommit } = await import("../src/worktree.ts");
  const { manager, config } = await makeManager([fix]);
  const server = await startUiServer({ manager, config });
  const headers = { "x-shipyard-token": server.token };
  const id = manager.start({ target: "t0", kind: "feature", request: "Fix addition", crew: [], checkpoints: [] });
  const post = (body: object) => request(server.port, `/api/runs/${id}/draft-pull-request`, { method: "POST", headers, body });
  const target = config.targets.t0!;
  const defaultRepo = tempDir("sy-draft-base-");
  const remote = tempDir("sy-draft-remote-");
  const fake = tempDir("sy-draft-cli-");
  const log = join(fake, "draft-created");
  const closed = join(fake, "draft-closed");
  const originalPath = process.env.PATH;
  try {
    const source = await manager.whenDone(id);
    assert.ok(source?.status === "passed");
    writeFiles(defaultRepo, {
      "package.json": readFileSync(join(target.path, "package.json"), "utf8"),
      "e2e/smoke.e2e.test.js": readFileSync(join(target.path, "e2e/smoke.e2e.test.js"), "utf8"),
      "src/add.js": "export const add = (a, b) => a * b;\n",
      "remote-only.md": "Keep the README from GitHub.\n",
    });
    await initRepoWithCommit(defaultRepo);
    await git(["clone", "--bare", defaultRepo, remote], defaultRepo);
    const base = await git(["rev-parse", "HEAD"], defaultRepo);
    await git(["fetch", "--no-write-fetch-head", "--", remote, base], source.repo);
    await git(["remote", "add", "origin", "https://github.com/example/draft-fixture"], source.repo);
    const realGit = (await promisify(execFile)("which", ["git"])).stdout.trim();
    writeFileSync(join(fake, "git"), `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const origin = args.indexOf("origin");
if (args.includes("push") && origin >= 0) args[origin] = ${JSON.stringify(remote)};
process.exit(spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" }).status ?? 1);
`, { mode: 0o755 });
    const pr = "https://github.com/example/draft-fixture/pull/42";
    writeFileSync(join(fake, "gh"), `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const endpoint = args[3];
if (endpoint === "repos/example/draft-fixture") console.log("main");
else if (endpoint.includes("/git/ref/heads/")) {
  const branch = decodeURIComponent(endpoint.split("/git/ref/heads/")[1]);
  console.log(execFileSync(${JSON.stringify(realGit)}, ["rev-parse", "--verify", "refs/heads/" + branch], { cwd: ${JSON.stringify(remote)}, encoding: "utf8" }).trim());
} else if (endpoint.includes("/compare/")) console.log("1");
else if (endpoint.endsWith("/pulls") && args.includes("POST")) {
  const input = readFileSync(args[args.indexOf("--input") + 1], "utf8");
  const payload = JSON.parse(input);
  if (payload.draft !== true || payload.base !== "main" || !payload.body.trim()) process.exit(1);
  writeFileSync(${JSON.stringify(log)}, input);
  console.log(${JSON.stringify(pr)});
} else if (endpoint.endsWith("/pulls/42")) console.log(existsSync(${JSON.stringify(closed)}) ? "closed" : "open");
else if (endpoint.endsWith("/pulls") && existsSync(${JSON.stringify(log)}) && !existsSync(${JSON.stringify(closed)})) console.log(${JSON.stringify(pr)});
`, { mode: 0o755 });
    process.env.PATH = `${fake}:${originalPath}`;
    const ready = (await manager.result(id)).publish!;
    assert.equal(ready.pushed, false);
    assert.equal(ready.canDraftPullRequest, true);
    const response = await post({ action: "review", head: ready.head, destination: ready.destination });
    assert.equal(response.status, 200, response.body);
    const { review } = JSON.parse(response.body);
    assert.equal(review.base.head, base);
    assert.deepEqual(review.transplant.conflicts, ["src/add.js"]);
    assert.match(review.description, /## Summary[\s\S]*src\/add\.js[\s\S]*## Verification[\s\S]*npm run e2e/);
    assert.equal(await git(["branch", "--list", review.branch], source.repo), "");
    assert.equal(await git(["branch", "--list", review.branch], remote), "");
    assert.equal((await post({ action: "create", token: "stale" })).status, 400);
    assert.equal((await post({ action: "create", token: review.token, description: " \n " })).status, 400);
    const originalTest = target.test;
    target.test = "false";
    assert.match((await post({ action: "create", token: review.token })).body, /failed on the proposed draft branch/);
    target.test = originalTest;
    assert.equal(await git(["branch", "--list", review.branch], remote), "");
    const description = "## Summary\n\nFix numeric addition.\n\n## Verification\n\n- Unit and integration checks passed.\n";
    const approved = await post({ action: "create", token: review.token, description });
    assert.equal(approved.status, 200, approved.body);
    assert.equal(JSON.parse(approved.body).result.publish.pullRequestUrl, pr);
    const run = manager.store.get(id)!;
    assert.equal(run.branch, review.branch);
    assert.equal(await git(["rev-parse", "HEAD^"], run.worktree), base);
    assert.equal(await git(["rev-parse", `refs/heads/${run.branch}`], remote), run.publication?.head);
    assert.equal(await git(["rev-parse", `refs/heads/${source.branch}`], source.repo), ready.head);
    assert.match(readFileSync(join(run.worktree, "remote-only.md"), "utf8"), /Keep the README/);
    assert.match(readFileSync(join(run.worktree, "src/add.js"), "utf8"), /Number\(a\) \+ Number\(b\)/);
    assert.deepEqual(run.verification?.checks.map(({ code }) => code), [0, 0]);
    assert.equal(JSON.parse(readFileSync(log, "utf8")).body, description);
    writeFileSync(closed, "closed");
    const handoff = (await manager.result(id)).publish;
    assert.equal(handoff?.pullRequestUrl, undefined);
    assert.equal(handoff?.closedPullRequestUrl, pr);
    assert.equal(handoff?.canDraftPullRequest, true);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await Promise.all([manager.shutdown(), server.close()]);
  }
});

test("a Cloud Run release requires approval of the exact service and image before updating it", async () => {
  const { manager, config, runner } = await makeManager([fix, () => ({ summary: "Review the Cloud Run service and verify the image digest." })]);
  const server = await startUiServer({ manager, config });
  const id = manager.start({ target: "t0", kind: "feature", request: "Prepare a cloud release", crew: ["cloud-release"], checkpoints: [] });
  const path = `/api/runs/${id}/cloud-release`;
  const post = (body: Record<string, unknown>, authenticated = true) => request(server.port, path, {
    method: "POST", headers: authenticated ? { "x-shipyard-token": server.token } : undefined, body,
  });
  const fake = tempDir("sy-gcloud-");
  const log = join(fake, "calls");
  const deployed = join(fake, "deployed");
  const originalPath = process.env.PATH;
  try {
    const run = await manager.whenDone(id);
    assert.equal(run?.status, "passed");
    assert.equal(run?.stages.at(-1)?.name, "cloud-release");
    assert.equal(run?.stages.at(-1)?.commit, undefined);
    assert.ok(runner instanceof FakeRunner);
    assert.equal(runner.calls.at(-1)?.role.name, "google-cloud-releaser");
    assert.equal(runner.calls.at(-1)?.lane, "none");
    assert.equal((await manager.result(id)).canReleaseToCloudRun, true);
    writeFileSync(join(fake, "gcloud"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const command = args.slice(0, 3).join(" ");
const deployed = ${JSON.stringify(deployed)};
const json = (value) => console.log(JSON.stringify(value));
if (args[0] === "auth") console.log("operator@example.test");
else if (args[0] === "config") console.log("(unset)");
else if (command === "run services describe" && args.some((arg) => arg.includes("status.traffic"))) {
  json({ status: { traffic: [{ revisionName: "portfolio-previous", percent: 100 }] } });
} else if (command === "run services describe") {
  json({ metadata: { uid: "service-id" }, spec: { template: { spec: { containers: [{}], serviceAccountName: "runtime@example.test" } } } });
} else if (command === "run revisions list") {
  json(fs.existsSync(deployed) ? [{ spec: { containers: [{ image: fs.readFileSync(deployed, "utf8") }] },
    status: { conditions: [{ type: "Ready", status: "True" }] } }] : []);
} else if (command === "run services update") fs.writeFileSync(deployed, args.find((arg) => arg.startsWith("--image=")).slice(8));
else process.exitCode = 1;
`, { mode: 0o755 });
    process.env.PATH = `${fake}:${originalPath}`;
    const image = `us-central1-docker.pkg.dev/example-project/app/portfolio@sha256:${"a".repeat(64)}`;
    const target = { action: "prepare", project: "example-project", region: "us-central1", service: "portfolio", image };
    assert.equal((await post(target, false)).status, 401);
    assert.equal((await post({ ...target, image: "portfolio:latest" })).status, 400);
    assert.equal(existsSync(log), false);
    const prepared = await post(target);
    assert.equal(prepared.status, 200, prepared.body);
    const { review } = JSON.parse(prepared.body);
    assert.equal(review.account, "operator@example.test");
    assert.equal(review.runtimeIdentity, "runtime@example.test");
    assert.equal(review.image, image);
    const approval = { action: "deploy", token: review.token, confirm: true };
    assert.equal((await post({ ...approval, confirm: false })).status, 400);
    assert.equal((await post({ ...approval, token: "other" })).status, 400);
    assert.equal(existsSync(deployed), false);
    const outcome = await post({ ...approval, project: "wrong-project", image: "unreviewed-image" });
    assert.equal(outcome.status, 200, outcome.body);
    assert.equal(JSON.parse(outcome.body).release.revision, review.revision);
    assert.equal((await manager.result(id)).cloudRelease?.revision, review.revision);
    assert.equal((await post(approval)).status, 400);
    const reviewedAgain = JSON.parse((await post(target)).body).review;
    assert.equal((await post({ ...approval, token: reviewedAgain.token })).status, 200);
    const updates = readFileSync(log, "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as string[]).filter((args) => args[2] === "update");
    assert.equal(updates.length, 1);
    assert.ok(updates[0]?.includes("--no-traffic"));
    assert.ok(updates[0]?.includes("--project=example-project"));
    assert.ok(updates[0]?.includes("--account=operator@example.test"));
    assert.ok(updates[0]?.includes(`--image=${image}`));
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await Promise.all([manager.shutdown(), server.close()]);
  }
});

test("adding a repository URL clones and inspects once, then registers its local checkout", async (t) => {
  const { git } = await import("../src/exec.ts");
  const { config } = await makeManager([]);
  const remote = await makeTargetRepo();
  const folder = tempDir("sy-clone-");
  const configFile = join(folder, "shipyard.config.yaml");
  const ssh = join(folder, "fixture-ssh");
  writeFileSync(configFile, "targets: {}\n");
  writeFileSync(ssh, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
if (!process.argv.at(-1).includes("example/fixture-app.git")) {
  console.error("Repository not found");
  process.exit(1);
}
process.exit(spawnSync("git", ["upload-pack", ${JSON.stringify(remote)}], { stdio: "inherit" }).status ?? 1);
`, { mode: 0o700 });
  for (const [key, value] of Object.entries({ GIT_SSH_COMMAND: ssh, GIT_SSH_VARIANT: "simple" })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const manager = new RunManager({ config, roles: loadRoles(), runner: new FakeRunner([fix]), configFile });
  const server = await startUiServer({ manager, config });
  const headers = { "x-shipyard-token": server.token };
  const clone = (url: string, auth = headers) => request(server.port, "/api/targets/clone", { method: "POST", headers: auth, body: { url } });
  try {
    const url = "git@fixture.invalid:example/fixture-app.git";
    assert.equal((await clone(url, {} as typeof headers)).status, 401);
    for (const invalid of ["file:///tmp/repo", "https://token@host.example/owner/repo", "ext::example"]) {
      assert.equal((await clone(invalid)).status, 400);
    }
    const [first, concurrent] = await Promise.all([clone(url), clone(url)]);
    assert.equal(first.status, 200, first.body);
    assert.equal(concurrent.status, 200, concurrent.body);
    const repo = JSON.parse(first.body);
    assert.equal(repo.ok, true);
    assert.equal(repo.path, JSON.parse(concurrent.body).path);
    assert.equal(repo.suggestedName, "fixture-app");
    assert.equal(repo.test[0].command, "npm test");
    assert.equal(repo.e2e[0].command, "npm run e2e");
    assert.equal(await git(["remote", "get-url", "origin"], repo.path), url);
    assert.equal(await git(["rev-parse", "HEAD"], repo.path), await git(["rev-parse", "HEAD"], remote));
    assert.equal(readFileSync(configFile, "utf8"), "targets: {}\n");
    assert.equal(JSON.parse((await clone(url)).body).path, repo.path);
    assert.match((await clone("git@fixture.invalid:example/missing.git")).body, /could not access/);
    assert.equal(readdirSync(join(folder, ".shipyard", "repos")).length, 1);
    const added = await request(server.port, "/api/targets", {
      method: "POST", headers, body: { name: repo.suggestedName, path: repo.path, test: repo.test[0].command },
    });
    assert.equal(added.status, 201, added.body);
    assert.equal(JSON.parse((await clone(url)).body).existingName, "fixture-app");
    const id = manager.start({ target: repo.suggestedName, kind: "feature", request: "Fix addition", crew: [], checkpoints: [] });
    assert.equal((await manager.whenDone(id))?.status, "passed");
  } finally {
    await manager.shutdown();
    await server.close();
  }
});

test("the result can save a Git remote locally while preserving an existing origin", async () => {
  const { git } = await import("../src/exec.ts");
  const { manager, config, messages } = await makeManager([fix]);
  const server = await startUiServer({ manager, config, token: "r".repeat(48) });
  const headers = { "x-shipyard-token": server.token };
  const id = manager.start({ target: "t0", kind: "feature", request: "Connect the run repository", crew: [], checkpoints: [] });
  const path = `/api/runs/${id}`;
  const connect = (url: string) => request(server.port, `${path}/remote`, { method: "POST", headers, body: { url } });
  try {
    const run = await manager.whenDone(id);
    assert.ok(run && run.status === "passed");
    assert.equal(JSON.parse((await request(server.port, `${path}/result`, { headers })).body).hasRemote, false);
    for (const url of ["file:///tmp/repo.git", "ext::example", "https://secret@github.com/user/repo.git", "https://github.com/user/repo?token=secret"]) {
      assert.equal((await connect(url)).status, 400);
    }
    const url = "git@github.com:example/private.git";
    const unauthenticated = await request(server.port, `${path}/remote`, { method: "POST", body: { url } });
    assert.equal(unauthenticated.status, 401);
    assert.equal(await git(["remote"], run.repo), "");

    assert.equal((await connect(url)).status, 200);
    assert.equal((await connect(url)).status, 200);
    assert.equal((await connect("https://github.com/example/other.git")).status, 400);
    assert.equal(await git(["config", "--local", "--get", "remote.origin.url"], run.repo), url);
    assert.equal(await git(["for-each-ref", "refs/remotes"], run.repo), "");
    assert.equal(JSON.parse((await request(server.port, `${path}/result`, { headers })).body).hasRemote, true);
    assert.ok(messages.some((m) => m.type === "git-remote" && m.repo === run.repo));
  } finally {
    await Promise.all([manager.shutdown(), server.close()]);
  }
});

test("the handoff can verify a finished worktree and approve references without starting a new run", async (t) => {
  const { manager, config, runner } = await makeManager([fix]);
  config.targets.t0!.e2e = "printf 'host E2E passed'";
  const server = await startUiServer({ manager, config, token: "q".repeat(48) });
  const auth = { "x-shipyard-token": server.token };
  const requested = "Use https://github.com/example";
  const id = manager.start({ target: "t0", kind: "feature", request: requested, crew: [], checkpoints: [] });
  const send = (path: string, body?: object) => request(server.port, `/api/runs/${id}/${path}`, { method: "POST", headers: auth, body });
  try {
    const run = await manager.whenDone(id);
    assert.equal(run?.status, "passed");
    assert.equal(run?.references?.[0]?.status, "permission-required");
    const checked = await send("verify");
    assert.equal(checked.status, 200);
    const saved = manager.store.get(id)!;
    assert.equal(saved.verification?.head, saved.stages[0]?.commit);
    assert.deepEqual(saved.verification?.checks.map((check) => check.code), [0, 0]);
    assert.match(saved.verification!.checks[1]!.outputTail, /host E2E passed/);
    assert.equal(saved.stages[0]?.attempts[0]?.gates.length, 1);
    writeFiles(saved.worktree, { "later.txt": "Unsaved work" });
    assert.equal((await send("verify")).status, 400);
    assert.equal((await send("references", { referenceUrls: ["https://127.0.0.1/secret"] })).status, 400);
    t.mock.method(globalThis, "fetch", async (input: string) => {
      assert.match(input, /^https:\/\/api.github.com\//);
      return input.includes("/repos?") ? Response.json([]) : input.includes("/readme") ? new Response("Example README") : Response.json({ login: "example" });
    });
    const refs = await send("references", { referenceUrls: ["https://github.com/example"] });
    assert.equal(refs.status, 200);
    const revised = manager.store.get(id)!;
    assert.deepEqual(revised.referenceUrls, ["https://github.com/example"]);
    assert.equal(revised.references?.[0]?.status, "read");
    assert.equal(manager.activeRunIds().length, 0);
    assert.equal((runner as FakeRunner).calls.length, 1);
  } finally {
    await Promise.all([manager.shutdown(), server.close()]);
  }
});

test("feedback retrieves references and routes through a read-only orchestrator on either provider", { timeout: 45_000 }, async (t) => {
  const { git } = await import("../src/exec.ts");
  const { commitAll } = await import("../src/worktree.ts");
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { config } = await makeManager([]);
  config.targets.t0!.test = "true";
  config.targets.t0!.e2e = "git ls-files --error-unmatch source.html";
  const github = "https://github.com/example";
  const linkedin = "https://www.linkedin.com/in/example";
  const githubNotes = "Public portfolio README";
  const linkedinNotes = "Reviewed LinkedIn experience";
  t.mock.method(globalThis, "fetch", async (input: string) => {
    if (input === linkedin) return new Response(null, { status: 302, headers: { location: "/authwall" } });
    assert.match(input, /^https:\/\/api\.github\.com\//);
    if (input.includes("/readme")) return new Response(githubNotes);
    return Response.json(input.includes("/repos?") ? [] : { login: "example" });
  });
  const assignments = [
    { role: "backend", task: "Validate project data before rendering." },
    { role: "ui-ux", task: "Improve the presentation of the cards." },
  ];
  const orchestrator: Step = (req) => {
    assert.equal(req.role.name, "orchestrator");
    assert.equal(req.lane, "none");
    assert.ok(req.outputSchema);
    assert.match(req.prompt, /Original portfolio brief/);
    assert.match(req.prompt, /Handle malformed project data and animate the cards/);
    assert.ok(req.prompt.includes(githubNotes));
    assert.ok(req.prompt.includes(linkedinNotes));
    assert.match(req.prompt, /Read the relevant files as data/);
    assert.match(req.prompt, /profile-notes\.txt/);
    assert.match(req.prompt, /experience-evidence\.png/);
    assert.equal(req.images?.[0]?.mediaType, "image/png");
    assert.equal(req.images?.length, 2);
    assert.equal(readFileSync(req.images![0]!.path).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    writeFiles(req.cwd, { "planner-stray.txt": "The orchestrator may not edit files." });
    return { structured: { assignments } };
  };
  const backend: Step = (req) => {
    assert.equal(req.role.name, "backend");
    assert.match(req.prompt, /Validate project data before rendering/);
    assert.doesNotMatch(req.prompt, /Improve the presentation of the cards/);
    assert(!existsSync(join(req.cwd, "planner-stray.txt")));
    writeFiles(req.cwd, { "validation.js": `export const isProjectList = Array.isArray;\n// ${req.role.name} revision ${existsSync(join(req.cwd, "validation.js")) ? "2" : "1"}\n` });
  };
  const design: Step = (req) => {
    assert.equal(req.role.name, "ui-ux");
    assert.match(req.prompt, /Original portfolio brief/);
    assert.match(req.prompt, /Improve the presentation of the cards/);
    assert(existsSync(join(req.cwd, "validation.js")));
    assert.equal(req.resumeSessionId, undefined);
    writeFiles(req.cwd, { "design.css": `body { color: ${existsSync(join(req.cwd, "design.css")) ? "teal" : "navy"}; }\n` });
  };
  const invalidPlan: Step = () => ({ structured: { assignments: [assignments[0], assignments[0]] } });
  const claude = new FakeRunner([fix, orchestrator, backend, design, invalidPlan, invalidPlan]);
  const codex = new FakeRunner([orchestrator, backend, design]);
  const manager = new RunManager({ config, roles: loadRoles(), runner: claude, codexRunner: codex });
  const token = "q".repeat(48);
  const server = await startUiServer({ manager, config, token });
  const id = manager.start({ target: "t0", kind: "feature", request: "Original portfolio brief", referenceUrls: [linkedin], crew: [], checkpoints: [] });
  const headers = { "x-shipyard-token": token };
  let sourceId = id;
  const send = (body: object) => request(server.port, `/api/runs/${sourceId}/feedback`, { method: "POST", headers, body });
  try {
    const parent = await manager.whenDone(id);
    assert.ok(parent?.status === "passed");
    const previousHandoff = manager.openReferenceHandoff(id, { url: linkedin }, server.port);
    const ticket = previousHandoff.prompt.match(/\b[0-9a-f]{48}\b/)?.[0];
    assert.ok(ticket);
    manager.returnReferenceHandoff(ticket, { status: "ready", text: linkedinNotes, coverage: ["Experience"], missing: [] });
    const savedReference = await request(server.port, `/api/runs/${id}/references/shared`, {
      method: "POST", headers, body: { url: linkedin, text: linkedinNotes, attachments: [imageAttachment("experience-evidence.png")] },
    });
    assert.equal(savedReference.status, 200);
    assert.equal(manager.store.get(id)?.references?.[0]?.status, "read");
    writeFiles(parent.worktree, { "source.html": "<h1>Portfolio</h1>" });
    let parentTip = await commitAll(parent.worktree, "Refine the source locally");
    assert.ok(parentTip);
    assert.equal((await send({ message: "   " })).status, 400);
    assert.equal((await send({ message: "Change it", provider: "unknown" })).status, 400);
    assert.equal((await send({ message: "Change it", attachments: [{ name: "../outside.txt", data: "eA==" }] })).status, 400);
    for (const provider of ["claude", "codex"] as const) {
      const attachments = [
        { name: "profile-notes.txt", data: Buffer.from("Notes from the user").toString("base64") },
        imageAttachment("design.png"),
      ];
      const response = await send({ message: `Handle malformed project data and animate the cards using [GitHub](${github}) and ${linkedin}/.`, provider, implementer: "frontend", attachments });
      assert.equal(response.status, 201);
      const { id: childId } = JSON.parse(response.body) as { id: string };
      const item = await nextItem(manager, (item) => item.runId === childId);
      assert.ok(item.kind === "reference" && item.url === linkedin && !item.needsApproval);
      assert.match(item.detail, /Check LinkedIn coverage again/);
      assert.equal(manager.store.get(childId)?.stages.length, 0);
      const handoff = manager.openReferenceHandoff(childId, { url: linkedin, itemId: item.id }, server.port);
      assert.equal(new URL(handoff.href).protocol, `${provider}:`);
      const handoffTicket = handoff.prompt.match(/\b[0-9a-f]{48}\b/)?.[0];
      assert.ok(handoffTicket);
      manager.returnReferenceHandoff(handoffTicket, { status: "ready", text: linkedinNotes, coverage: ["Experience"], missing: [] });
      manager.answer(item.id, { kind: "reference", action: "share", text: linkedinNotes });
      const revision = await manager.whenDone(childId);
      assert.equal(revision?.status, "passed");
      assert.equal(revision?.provider, provider);
      assert.equal(revision?.branch, parent.branch);
      assert.equal(revision?.worktree, parent.worktree);
      assert.equal(revision?.baseSha, parentTip);
      assert.equal(revision?.followUp?.runId, sourceId);
      assert.equal(revision?.followUp?.orchestrated, true);
      const savedFile = revision?.followUp?.attachments?.find(({ name }) => name === "profile-notes.txt");
      assert.ok(savedFile);
      assert.equal(readFileSync(join(manager.store.dir(childId), "attachments", savedFile.file), "utf8"), "Notes from the user");
      assert.equal(await git(["ls-files", "--", "attachments", "profile-notes.txt", "design.png"], revision.worktree), "");
      assert.deepEqual(revision?.referenceUrls, [github, linkedin]);
      assert.deepEqual(revision?.stages.map((stage) => stage.role), ["orchestrator", "backend", "ui-ux"]);
      assert.deepEqual(revision?.stages[0]?.attempts[0]?.output, { assignments });
      assert.deepEqual(revision?.stages[0]?.attempts[0]?.revertedFiles, ["planner-stray.txt"]);
      assert.deepEqual(revision?.stages.slice(1).map((stage) => stage.attempts[0]?.gates.map((gate) => gate.code)), [[0, 0], [0, 0]]);
      assert.ok(revision?.stages.slice(1).every((stage) => stage.commit));
      sourceId = childId;
      parentTip = await git(["rev-parse", "HEAD"], parent.worktree);
    }
    const invalid = await send({ message: "Improve the result", provider: "claude" });
    const failed = await manager.whenDone(JSON.parse(invalid.body).id);
    assert.equal(failed?.status, "failed");
    assert.match(failed?.error ?? "", /valid revision plan/);
    assert.deepEqual(failed?.stages.map((stage) => stage.role), ["orchestrator"]);
    assert.equal(await git(["rev-parse", "HEAD"], parent.worktree), parentTip);
    assert.equal(await git(["status", "--porcelain"], parent.worktree), "");
    assert.equal(claude.calls.length, 6);
    assert.equal(codex.calls.length, 3);
  } finally {
    await Promise.all([manager.shutdown(), server.close()]);
  }
});

test("rechecking a failed revision verifies saved edits and continues the same run", { timeout: 30_000 }, async () => {
  const { git } = await import("../src/exec.ts");
  const { commitAll } = await import("../src/worktree.ts");
  const { config } = await makeManager([]);
  config.maxGateRetries = 0;
  const target = config.targets.t0!;
  target.test = "true";
  target.e2e = "sh e2e/metric.sh";
  const e2eCheck = (metric: number) => `grep -q '${metric}%' index.html || { echo "Missing metric ${metric}%"; exit 1; }\n`;
  writeFiles(target.path, { "index.html": "<p>50%</p>", "e2e/metric.sh": e2eCheck(50) });
  await commitAll(target.path, "Add the original portfolio metric");
  const plan: Step = () => ({ structured: { assignments: [
    { role: "frontend", task: "Update the displayed metric" },
    { role: "docs-writer", task: "Record the correction in the README" },
  ] } });
  const update: Step = (req) => writeFiles(req.cwd, { "index.html": "<p>18%</p>" });
  const docs: Step = (req) => {
    assert.equal(req.role.name, "docs-writer");
    assert.match(readFileSync(join(req.cwd, "e2e/metric.sh"), "utf8"), /18%/);
    writeFiles(req.cwd, { "README.md": "The corrected metric is 18%.\n" });
  };
  const unsuccessfulRepair: Step = () => ({ summary: "Could not repair the failed check." });
  const claude = new FakeRunner([fix, plan, update, unsuccessfulRepair, docs]);
  const codex = new FakeRunner([fix, plan, update, unsuccessfulRepair, docs]);
  const manager = new RunManager({ config, roles: loadRoles(), runner: claude, codexRunner: codex });
  const server = await startUiServer({ manager, config });
  const headers = { "x-shipyard-token": server.token };
  try {
    for (const [provider, runner] of [["claude", claude], ["codex", codex]] as const) {
      const parentId = manager.start({ target: "t0", kind: "feature", request: "Prepare the portfolio", provider, crew: [], checkpoints: [] });
      assert.equal((await manager.whenDone(parentId))?.status, "passed");
      const id = await manager.startFollowUp(parentId, { message: "Use 18% for the metric", provider });
      const failed = await manager.whenDone(id);
      assert.ok(failed && failed.status === "failed");
      assert.equal((await manager.result(id)).recheckStage, "frontend");
      assert.equal((await manager.result(id)).canPreview, true);
      const callsBeforeRecheck = runner.calls.length;
      const verify = () => request(server.port, `/api/runs/${id}/verify`, { method: "POST", headers });
      const recheck = () => request(server.port, `/api/runs/${id}/recheck`, { method: "POST", headers });
      assert.equal((await manager.result(id)).savedEditsCheck, "unchecked");
      assert.equal((await verify()).status, 200);
      assert.equal((await manager.result(id)).savedEditsCheck, "failed");
      assert.equal((await recheck()).status, 202);
      const rechecked = await manager.whenDone(id);
      assert.equal(rechecked?.status, "failed");
      assert.equal(rechecked?.stages.at(-1)?.attempts.at(-1)?.rechecked, true);
      assert.equal(runner.calls.length, callsBeforeRecheck);
      assert.equal(await git(["rev-parse", "HEAD"], failed.worktree), failed.baseSha);

      writeFiles(failed.worktree, { "e2e/metric.sh": e2eCheck(18) });
      assert.equal((await manager.result(id)).savedEditsCheck, "unchecked");
      assert.equal((await verify()).status, 200);
      assert.equal((await manager.result(id)).savedEditsCheck, "passed");
      assert.equal(manager.store.get(id)?.status, "failed");
      assert.equal(runner.calls.length, callsBeforeRecheck);
      assert.equal(await git(["rev-parse", "HEAD"], failed.worktree), failed.baseSha);
      assert.equal((await recheck()).status, 202);
      const recovered = await manager.whenDone(id);
      assert.ok(recovered && recovered.status === "passed", recovered?.error ?? "Recheck did not complete");
      assert.equal(recovered.id, id);
      assert.equal(recovered.worktree, failed.worktree);
      assert.equal(recovered.branch, failed.branch);
      assert.deepEqual(recovered.stages.map(({ name, status }) => [name, status]), [
        ["orchestrate", "passed"], ["frontend", "passed"], ["docs-writer", "passed"],
      ]);
      assert.equal(runner.calls.length, callsBeforeRecheck + 1);
      assert.equal((await manager.result(id)).recheckStage, undefined);
      assert.match(await git(["show", "HEAD:e2e/metric.sh"], failed.worktree), /18%/);
      assert.equal(await git(["status", "--porcelain"], failed.worktree), "");
    }
    assert.match(readFileSync(join(target.path, "e2e/metric.sh"), "utf8"), /50%/);
  } finally {
    await Promise.all([manager.shutdown(), server.close()]);
  }
});

test("frontend revisions repair in place, with a dashboard retry when automatic repair cannot finish", { timeout: 30_000 }, async () => {
  const { git } = await import("../src/exec.ts");
  const { commitAll } = await import("../src/worktree.ts");
  const { config } = await makeManager([]);
  config.maxGateRetries = 0;
  const target = config.targets.t0!;
  target.test = "true";
  target.e2e = "sh e2e/title.sh";
  const check = (title: string) => `grep -Fq '${title}' index.html || { echo "Expected title: ${title}"; exit 1; }\n`;
  writeFiles(target.path, { "index.html": "<h1>Original title</h1>", "e2e/title.sh": check("Original title") });
  await commitAll(target.path, "Add the original title and its test");
  const plan: Step = () => ({ structured: { assignments: [{ role: "frontend", task: "Change the heading" }] } });
  const frontend: Step = (req) => {
    assert.equal(req.lane, "no-e2e");
    writeFiles(req.cwd, { "index.html": "<h1>Updated title</h1>" });
  };
  const repair: Step = (req) => {
    assert.equal(req.role.name, "backend");
    assert.equal(req.lane, "any");
    assert.equal(req.resumeSessionId, undefined);
    assert.match(req.prompt, /Expected title: Original title/);
    assert.match(readFileSync(join(req.cwd, "index.html"), "utf8"), /Updated title/);
    writeFiles(req.cwd, { "e2e/title.sh": check("Updated title") });
  };
  const requestDecision: Step = async (req) => {
    assert.equal(req.role.name, "backend");
    const answer = await req.ask!({ kind: "permission", tool: "WebFetch", input: { url: "https://example.com" } });
    assert.deepEqual(answer, { kind: "permission", allow: true, message: undefined });
    return repair(req);
  };
  const unsuccessfulRepair: Step = (req) => {
    assert.equal(req.role.name, "backend");
    return { summary: "The check still fails." };
  };
  const claude = new FakeRunner([fix, plan, frontend, requestDecision, fix, plan, frontend, unsuccessfulRepair, repair]);
  const codex = new FakeRunner([fix, plan, frontend, repair, fix, plan, frontend, unsuccessfulRepair, repair]);
  const manager = new RunManager({ config, roles: loadRoles(), runner: claude, codexRunner: codex });
  const server = await startUiServer({ manager, config });
  const headers = { "x-shipyard-token": server.token };
  const startParent = async (provider: "claude" | "codex") => {
    const id = manager.start({ target: "t0", kind: "feature", request: "Prepare the portfolio", provider, crew: [], checkpoints: [] });
    assert.equal((await manager.whenDone(id))?.status, "passed");
    return id;
  };
  try {
    for (const provider of ["claude", "codex"] as const) {
      const id = await manager.startFollowUp(await startParent(provider), { message: "Use Updated title as the heading", provider });
      if (provider === "claude") {
        const inboxOrCompletion = await Promise.race([nextItem(manager, (item) => item.runId === id), manager.whenDone(id)]);
        assert.ok(inboxOrCompletion && "kind" in inboxOrCompletion && inboxOrCompletion.kind === "permission");
        const repairing = manager.store.get(id);
        assert.equal(repairing?.status, "running");
        assert.equal(repairing?.stages.at(-1)?.autoRepair?.command, "sh e2e/title.sh");
        manager.answer(inboxOrCompletion.id, { kind: "permission", decision: "allow" });
      }
      const automatic = await manager.whenDone(id);
      assert.equal(automatic?.status, "passed", automatic?.error ?? "Automatic repair did not pass");
      const repairedStage = automatic?.stages.at(-1);
      assert.deepEqual(repairedStage?.autoRepair, { command: "sh e2e/title.sh", afterAttempt: 1 });
      assert.deepEqual(repairedStage?.attempts.map(({ passed, role }) => [passed, role]), [[false, undefined], [true, "backend"]]);
      assert.match(await git(["show", "HEAD:e2e/title.sh"], automatic!.worktree), /Updated title/);

      const retryId = await manager.startFollowUp(await startParent(provider), { message: "Still use Updated title as the heading", provider });
      const failed = await manager.whenDone(retryId);
      assert.equal(failed?.status, "failed");
      assert.equal(failed?.stages.at(-1)?.attempts.length, 2);
      assert.equal((await manager.result(retryId)).canFixRevision, true);
      const accepted = await request(server.port, `/api/runs/${retryId}/fix`, { method: "POST", headers });
      assert.equal(accepted.status, 202, accepted.body);
      const recovered = await manager.whenDone(retryId);
      assert.equal(recovered?.status, "passed", recovered?.error ?? "The repair did not complete");
      assert.equal(recovered?.id, retryId);
      assert.equal(recovered?.worktree, failed?.worktree);
      assert.deepEqual(recovered?.stages.map((stage) => stage.name), ["orchestrate", "frontend"]);
      assert.equal(recovered?.stages.at(-1)?.attempts.at(-1)?.role, "backend");
      assert.match(await git(["show", "HEAD:e2e/title.sh"], recovered!.worktree), /Updated title/);
    }
    assert.match(readFileSync(join(target.path, "e2e/title.sh"), "utf8"), /Original title/);
  } finally {
    await Promise.all([manager.shutdown(), server.close()]);
  }
});

test("a Git-only revision can review and create a verified squashed branch from the dashboard", async () => {
  const { git } = await import("../src/exec.ts");
  const plan: Step = () => ({ structured: { assignments: [{ role: "backend", task: "Handle the feedback" }] } });
  const noEdits: Step = () => ({ summary: "This request changes Git history." });
  const { manager, config } = await makeManager([fix, plan,
    (req) => writeFiles(req.cwd, { "notes.md": "Portfolio notes.\n" }), plan, noEdits, noEdits,
  ]);
  const server = await startUiServer({ manager, config });
  const headers = { "x-shipyard-token": server.token };
  const sourceId = manager.start({ target: "t0", kind: "feature", request: "Prepare the portfolio", crew: [], checkpoints: [] });
  try {
    const source = await manager.whenDone(sourceId);
    assert.ok(source?.status === "passed");
    const addNotes = await manager.startFollowUp(sourceId, { message: "Add portfolio notes" });
    assert.equal((await manager.whenDone(addNotes))?.status, "passed");
    const id = await manager.startFollowUp(addNotes, { message: "Rename the branch and squash its commits" });
    const failed = await manager.whenDone(id);
    assert.ok(failed?.status === "failed");
    assert.equal((await manager.result(id)).canPrepareBranch, true);
    const route = `/api/runs/${id}/prepare-branch`;
    const read = await request(server.port, route, { headers });
    assert.equal(read.status, 200);
    const { plan } = JSON.parse(read.body);
    assert.equal(plan.base, source.baseSha);
    assert.equal(plan.commits, 2);
    const oldTree = await git(["rev-parse", `${plan.head}^{tree}`], source.repo);
    const approve = (override: object = {}) => request(server.port, route, { method: "POST", headers,
      body: { name: "portfolio-update", confirm: true, head: plan.head, base: plan.base, ...override } });
    assert.equal((await approve({ head: source.baseSha })).status, 400);
    const target = config.targets.t0!;
    const originalTest = target.test;
    target.test = "false";
    assert.match((await approve()).body, /project check failed/i);
    target.test = originalTest;
    assert.equal(await git(["branch", "--list", "shipyard/portfolio-update"], source.repo), "");
    const prepared = await approve();
    assert.equal(prepared.status, 200, prepared.body);
    const run = manager.store.get(id)!;
    assert.equal(run.id, id);
    assert.equal(run.branch, "shipyard/portfolio-update");
    assert.equal(run.status, "passed");
    assert.equal(await git(["rev-list", "--count", `${plan.base}..HEAD`], run.worktree), "1");
    assert.equal(await git(["rev-parse", "HEAD^{tree}"], run.worktree), oldTree);
    assert.equal(await git(["rev-parse", "HEAD"], failed.worktree), plan.head);
    assert.deepEqual(run.verification?.checks.map((gate) => gate.code), [0, 0]);
  } finally {
    await Promise.all([manager.shutdown(), server.close()]);
  }
});

test("Run locally calls the run’s provider once and supervises the app in its worktree", { timeout: 25_000 }, async () => {
  const { config } = await makeManager([]);
  const identify: Step = (req) => {
    assert.equal(req.role.name, "local-app");
    assert.equal(req.lane, "none");
    assert.ok(req.outputSchema);
    assert.ok(readFileSync(join(req.cwd, "src/add.js"), "utf8").includes("Number(a)"));
    return { structured: { framework: "vite", directory: ".", entry: "", detail: "" } };
  };
  const claude = new FakeRunner([fix, identify]);
  const codex = new FakeRunner([fix, identify]);
  const manager = new RunManager({ config, roles: loadRoles(), runner: claude, codexRunner: codex });
  const server = await startUiServer({ manager, config });
  const headers = { "x-shipyard-token": server.token };
  try {
    for (const [provider, runner] of [["claude", claude], ["codex", codex]] as const) {
      const id = manager.start({ target: "t0", kind: "feature", request: "Make the local app runnable", provider, crew: [], checkpoints: [] });
      const run = await manager.whenDone(id);
      assert.ok(run?.status === "passed");
      assert.equal(runner.calls.length, 1);
      const cli = `
import { createServer } from "node:http";
const host = process.argv[process.argv.indexOf("--host") + 1];
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
createServer((req, res) => res.end(process.cwd())).listen(port, host);
`;
      writeFiles(run.worktree, { "node_modules/vite/bin/vite.js": cli });
      const path = `/api/runs/${id}/local-app`;
      assert.equal((await request(server.port, path, { method: "POST" })).status, 401);
      assert.equal((await manager.result(id)).canRunLocally, true);
      const launches = await Promise.all(Array.from({ length: 2 }, () => request(server.port, path, { method: "POST", headers })));
      for (const launch of launches) assert.equal(launch.status, 200, launch.body);
      const { url } = JSON.parse(launches[0]!.body);
      assert.equal(JSON.parse(launches[1]!.body).url, url);
      assert.equal(new URL(url).hostname, "[::1]");
      const { realpath } = await import("node:fs/promises");
      assert.equal(await (await fetch(url)).text(), await realpath(run.worktree));
      assert.equal(runner.calls.length, 2);
      assert.equal((await manager.result(id)).localApp?.url, url);
      assert.equal((await request(server.port, path, { method: "DELETE", headers })).status, 200);
      await assert.rejects(fetch(url));
      assert.equal((await manager.result(id)).localApp, undefined);
    }
  } finally {
    await Promise.all([manager.shutdown(), server.close()]);
  }
});

test("the result endpoint serves a private static preview on a separate loopback origin", { timeout: 20_000 }, async () => {
  const { symlinkSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { manager, config } = await makeManager([
    (req) => {
      writeFiles(req.cwd, {
        "index.html": '<link rel="stylesheet" href="/style.css"><main>Fixture preview</main>',
        "style.css": "main { color: black; }",
        ".private.json": '{"private":true}',
      });
      const outside = join(tempDir(), "outside.json");
      writeFileSync(outside, '{"outside":true}');
      symlinkSync(outside, join(req.cwd, "linked.json"));
    },
  ]);
  config.targets.t0!.test = "true";
  const token = "q".repeat(48);
  const server = await startUiServer({ manager, config, token });
  const origin = `http://127.0.0.1:${server.port}`;
  const headers = { "x-shipyard-token": token };
  const id = manager.start({ target: "t0", kind: "feature", request: "Provide a preview", crew: [], checkpoints: [] });
  try {
    const run = await manager.whenDone(id);
    assert.equal(run?.status, "passed");
    const resultPath = `${origin}/api/runs/${id}/result`;
    const previewPath = `${origin}/api/runs/${id}/preview`;
    const result = await fetch(resultPath, { headers }).then((res) => res.json());
    assert.equal(result.hasRemote, false);
    assert.equal(result.canPreview, true);
    assert.equal(result.handoff.fileCount, 4);
    assert.equal(result.handoff.uncommittedCount, 0);
    assert.ok(result.handoff.files.some(({ path }: { path: string }) => path === "index.html"));
    assert.equal((await fetch(previewPath, { method: "POST" })).status, 401);
    const launches = await Promise.all(Array.from({ length: 2 }, () =>
      fetch(previewPath, { method: "POST", headers }).then((res) => res.json())));
    assert.ok(launches[0].url && launches[0].url === launches[1].url, "Concurrent requests must reuse one preview");
    const preview = new URL(launches[0].url);
    assert.equal(preview.hostname, "[::1]");
    const unauthed = await fetch(new URL("/", preview));
    assert.equal(unauthed.status, 401);
    const signIn = await fetch(preview, { redirect: "manual" });
    assert.equal(signIn.status, 302);
    const cookie = signIn.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const get = (path: string) => fetch(new URL(path, preview), { headers: { cookie } });
    assert.match(await (await get("/")).text(), /Fixture preview/);
    assert.equal((await get("/style.css")).status, 200);
    assert.equal((await get("/.private.json")).status, 404);
    assert.equal((await get("/linked.json")).status, 404);
    const dismiss = await fetch(`${origin}/api/runs/${id}`, {
      method: "PATCH", headers, body: JSON.stringify({ acknowledgeCompletion: run?.finishedAt }),
    });
    assert.equal(dismiss.status, 200);
    assert.equal(manager.store.get(id)?.completionRead, true);
    assert.equal((await fetch(previewPath, { method: "DELETE", headers })).status, 200);
    await assert.rejects(fetch(new URL("/", preview)));
  } finally {
    await Promise.all([manager.shutdown(), server.close()]);
  }
});
