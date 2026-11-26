import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startAgentWebTools } from "../src/browser-tool.ts";
import { runPipeline } from "../src/pipeline.ts";
import { missingReferencePermissions, parseReferencePermissions, readPublicReference } from "../src/references.ts";
import { loadRoles } from "../src/roles.ts";
import { RunStore } from "../src/store.ts";
import { FakeRunner, makeTargetRepo, tempDir, writeFiles } from "./helpers.ts";

test("public reference permissions constrain the sites, remove credentials from URLs, and flag missing access", () => {
  assert.deepEqual(parseReferencePermissions(["https://www.github.com/Example?tab=repositories#about", "https://github.com/example"]), ["https://github.com/example"]);
  assert.throws(() => parseReferencePermissions(["https://github.com@127.0.0.1/example"]), /Use HTTPS links/);
  assert.throws(() => parseReferencePermissions(["https://www.linkedin.com/login"]), /Use HTTPS links/);
  assert.deepEqual(parseReferencePermissions(["https://www.linkedin.com/in/example/details/experience/"]), ["https://www.linkedin.com/in/example"]);
  const warnings = missingReferencePermissions("Read my GitHub profile https://github.com/example. Check my LinkedIn too.", []);
  assert.deepEqual(warnings.map(({ status, url, label }) => [status, url ?? label]), [
    ["permission-required", "https://github.com/example"], ["permission-required", "LinkedIn profile"],
  ]);
  assert.deepEqual(missingReferencePermissions("Look at https://github.com/Example.", ["https://github.com/example"]), []);
});

test("only approved public source material is returned and LinkedIn sign-in is surfaced", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: URL | string, options?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    assert.equal(options?.redirect, "manual");
    assert.equal(new Headers(options?.headers).has("authorization"), false);
    if (url.endsWith("/public-profile")) return new Response(
      '<meta property="og:title" content="Example Profile"><section><h2>Experience</h2><ul><li>Engineer &amp; researcher</li><li>Earlier role</li></ul></section>',
    );
    if (url.includes("linkedin")) return new Response(null, { status: 302, headers: { location: "/authwall" } });
    if (url.includes("/readme")) return new Response("Profile README");
    if (url.includes("/repos?")) return Response.json([{ full_name: "example/demo", description: "Public demo", private_auth_token: "discard-me" }]);
    return Response.json({ login: "example", bio: "Builds demos", email: "exclude@example.test" });
  });
  const github = await readPublicReference("https://github.com/example");
  assert.equal(github.status, "read");
  assert.match(github.content ?? "", /Builds demos[\s\S]*Public demo[\s\S]*Profile README/);
  assert.doesNotMatch(github.content ?? "", /exclude@example|discard-me/);
  const linkedin = await readPublicReference("https://www.linkedin.com/in/example");
  assert.equal(linkedin.status, "blocked");
  assert.match(linkedin.detail, /sign-in/);
  const publicProfile = await readPublicReference("https://www.linkedin.com/in/public-profile");
  assert.equal(publicProfile.status, "partial");
  assert.deepEqual(publicProfile.coverage, ["Public title and description", "Experience"]);
  assert.match(publicProfile.content ?? "", /Engineer & researcher[\s\S]*Earlier role/);
  assert.equal(calls.length, 5);
});

test("the browser MCP endpoint requires its attempt token and accepts only scoped browser inputs", async () => {
  const tool = await startAgentWebTools(tempDir(), true);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const headers = { authorization: `Bearer ${tool.token}` };
  try {
    assert.equal((await fetch(tool.url, { method: "POST" })).status, 401);
    assert.equal((await fetch(tool.url, { method: "POST", headers: { ...headers, origin: "https://example.test" } })).status, 403);
    await client.connect(new StreamableHTTPClientTransport(new URL(tool.url), { requestInit: { headers } }));
    assert.deepEqual((await client.listTools()).tools.map(({ name }) => name), ["read_public_page", "inspect_preview"]);
    for (const url of ["http://127.0.0.1/", "http://[::ffff:169.254.169.254]/", "http://169.254.169.254/", "https://example.org/?token=secret"]) {
      const result = await client.callTool({ name: "read_public_page", arguments: { url } });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /private, and reserved|without credentials/);
    }
    const write = await client.callTool({ name: "read_public_page", arguments: { url: "https://example.org", method: "POST" } });
    assert.equal(write.isError, true);
    const external = await client.callTool({ name: "inspect_preview", arguments: { viewport: "phone", url: "https://example.test" } });
    assert.equal(external.isError, true);
    const local = await client.callTool({ name: "inspect_preview", arguments: { viewport: "phone" } });
    assert.equal(local.isError, true);
    assert.match(JSON.stringify(local.content), /index.html/);
  } finally {
    await client.close();
    await tool.close();
  }
});

test("a run delivers approved references and records warnings for links outside its grants", async (t) => {
  const fetched = t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.match(url, /^https:\/\/api\.github\.com\//);
    assert.doesNotMatch(url, /unapproved/);
    return url.includes("/repos?") ? Response.json([]) : url.includes("/readme") ? new Response("Approved profile README") : Response.json({ login: "example" });
  });
  const store = new RunStore(tempDir());
  const runner = new FakeRunner([(req) => {
    assert.equal(req.browserAccess, false);
    assert.match(req.prompt, /Approved profile README/);
    assert.match(req.prompt, /Approve this URL to let Shipyard read it/);
    writeFiles(req.cwd, { "README.md": "Updated the project." });
  }]);
  const run = await runPipeline({
    target: { name: "fixture", path: await makeTargetRepo(), test: 'node -e "0"', browserAccess: true },
    kind: "feature", request: "Use https://github.com/example and https://www.linkedin.com/in/unapproved", crew: [],
    browserAccess: false, referenceUrls: ["https://github.com/example"],
  }, { config: { model: "test", maxGateRetries: 0, worktreeRoot: tempDir() }, runner, store, roles: loadRoles() });
  assert.equal(run.status, "passed");
  assert.equal(fetched.mock.callCount(), 3);
  assert.deepEqual(run.references?.map(({ status }) => status), ["permission-required", "read"]);
  assert.deepEqual(store.events(run.id).filter((event) => event.type === "reference").map((event) => event.status), ["permission-required", "read"]);
});

test("public links in a run request are read by default without approval", async (t) => {
  const url = "https://github.com/example/project";
  t.mock.method(globalThis, "fetch", async (input: string) => {
    assert.match(input, /^https:\/\/api.github.com\/repos\/example\/project/);
    return input.endsWith("/readme") ? new Response("Public source text") : Response.json({ full_name: "example/project" });
  });
  const runner = new FakeRunner([(req) => {
    assert.match(req.prompt, /Public source text/);
    writeFiles(req.cwd, { "README.md": "Updated the project." });
  }]);
  const run = await runPipeline({ target: { name: "fixture", path: await makeTargetRepo(), test: 'node -e "0"' },
    kind: "feature", request: `Use ${url}`, crew: [], browserReferenceHelp: true }, {
    config: { model: "test", maxGateRetries: 0, worktreeRoot: tempDir() }, runner, store: new RunStore(tempDir()), roles: loadRoles(),
    approveReference: async () => assert.fail("Public reads should not ask for approval"),
  });
  assert.equal(run.status, "passed");
  assert.deepEqual(run.referenceUrls, [url]);
  assert.equal(run.references?.[0]?.status, "read");
});
