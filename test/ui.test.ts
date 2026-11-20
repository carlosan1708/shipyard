import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
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
    e2e,
  ]);
  const id = manager.start({ target: "t0", kind: "feature", request: "health check", checkpoints: [] });

  const item = await nextItem(manager);
  assert.equal(item.kind, "question");
  assert.throws(() => manager.answer(item.id, { kind: "question", answers: {} }), /Answer every question/);
  await new Promise((r) => setTimeout(r, 25)); // a human takes a moment; an instant answer can round to 0 ms
  manager.answer(item.id, { kind: "question", answers: { "Which status code?": "200" } });

  const run = await manager.whenDone(id);
  assert.equal(run?.status, "passed");
  assert.deepEqual(received, { kind: "question", answers: { "Which status code?": "200" } });
  assert.ok((run!.stages[0]!.attempts[0]!.askWaitMs ?? 0) > 0, "time blocked on the question counts as waiting for you");
  assert.equal(run!.totals.reviewWaitMs, run!.stages[0]!.attempts[0]!.askWaitMs);
});

test("'allow for this run' stops asking for that tool, but only in that run", async () => {
  const decisions: boolean[] = [];
  const askWeb = async (req: Parameters<Step>[0]) => {
    const a = await req.ask!({ kind: "permission", tool: "WebFetch", input: { url: "https://example.com" } });
    decisions.push(a.kind === "permission" && a.allow);
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
  manager.answer(item.id, { kind: "permission", decision: "allow-run" });
  assert.equal((await manager.whenDone(id))?.status, "passed");
  assert.deepEqual(decisions, [true, true]);
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
    const req = http.request(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: { host: `127.0.0.1:${port}`, ...opts.headers } },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.end(JSON.stringify(opts.body));
    else req.end();
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
    assert.deepEqual(state.targets.map((t: { name: string }) => t.name), ["t0"]);
    assert.deepEqual(state.stages, ["triage", "plan", "implement", "review", "revise", "security", "harden", "e2e", "repair", "docs", "release"]);
    assert.deepEqual(state.optionalStages, ["triage", "plan", "review", "security", "e2e", "repair", "docs", "release"]);
    assert.deepEqual(state.implementers, ["backend", "frontend"]);
    assert.deepEqual(state.config.models, ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    assert.deepEqual(state.efforts, ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(state.roles.length, 10);

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
      fix(req);
      return { sessionId: "codex-thread", costUsd: null, usage };
    },
    (req) => {
      assert.equal(req.resumeSessionId, "codex-thread");
      assert.match(req.prompt, /Add one more case/);
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
    const [codexResponse, claudeResponse] = await Promise.all([post(base), post({ ...base, provider: "claude" })]);
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
    manager.answer(codexItem.id, { kind: "checkpoint", action: "feedback", message: "Add one more case" });
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
    assert.equal((await controls({ action: "steer", message: "Keep the original tests" })).status, 202);
    const claudeCheckpoint = await nextItem(manager, (item) => item.kind === "checkpoint");
    assert.ok(claudeCheckpoint.kind === "checkpoint" && claudeCheckpoint.checkpoint.provider === "claude");
    assert.ok(!manager.inbox().some((item) => item.id === question.id));
    assert.equal((await controls({ action: "switch-provider", provider: "codex", message: "Also cover strings" })).status, 202);
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
