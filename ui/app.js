// shipyard ui client. No framework, no build step.
// Everything agents write is untrusted text: it only ever reaches the page through textContent.

const STAGE_ROLE = {
  orchestrate: "orchestrator",
  triage: "bug-triager",
  plan: "planner",
  design: "ui-ux",
  review: "reviewer",
  security: "security-auditor",
  "security-recheck": "security-auditor",
  e2e: "e2e-tester",
  docs: "docs-writer",
  release: "release-manager",
  "cloud-release": "google-cloud-releaser",
};
/** implement, revise, harden and repair belong to the run's implementer. */
const stageRole = (name, run) => STAGE_ROLE[name] ?? run?.implementer ?? "backend";
const PIPELINE_ORDER = ["triage", "plan", "implement", "design", "review", "revise", "security", "security-recheck", "harden", "e2e", "repair", "docs", "release", "cloud-release"];
const roleLabel = (role) => ({ orchestrator: "Orchestrator", "ui-ux": "UI/UX specialist", "dependency-updater": "Dependency updater", "docs-writer": "Docs writer", "e2e-tester": "E2E tester" })[role] ?? role;
const KIND_LABEL = { feature: "Feature", bug: "Bug fix", deps: "Dependency update" };
const KIND_SHORT = { feature: "ship", bug: "fix", deps: "deps" };
const DEPLOYMENT_PHASE_LABEL = { verifying: "Checking deployment", approval: "Awaiting approval", publishing: "Publishing", published: "Published", failed: "Deployment failed", cancelled: "Cancelled" };
const DEPLOYMENT_PROVIDERS = { firebase: "Firebase Hosting", aws: "AWS", azure: "Azure" };
const DEPLOYMENT_ACTIONS = { "firebase-release": "firebase", "aws-release": "aws", "azure-release": "azure" };
const deploymentPending = new Set();

/** The triage gate expects the project test command to fail. */
const gateOk = (g) => (g.expectFailure ? g.code !== 0 && !g.timedOut : g.code === 0);
function gateLabel(g) {
  const base = `${gateOk(g) ? "✓" : "✕"} ${g.command} · ${secs(g.durationMs)}${g.code === 0 ? "" : ` · exit ${g.code}`}`;
  if (!g.expectFailure) return base;
  return `${base} · ${g.timedOut ? "timed out" : gateOk(g) ? "failed as expected" : "expected failure, got a pass"}`;
}
const STATUS_LABEL = {
  starting: "Starting",
  running: "Running",
  waiting: "Needs you",
  passed: "Passed",
  failed: "Failed",
  error: "Error",
  stopped: "Stopped",
  interrupted: "Interrupted",
  queued: "Queued",
  skipped: "Skipped",
  redirected: "Redirected",
  changes: "Changes requested",
};

const state = {
  config: null,
  stages: [],
  targets: [],
  localRepos: [],
  localRepoStatus: "Searching for local repos…",
  runs: new Map(),
  active: new Set(),
  inbox: new Map(),
  referenceDrafts: new Map(),
  events: new Map(), // runId -> events, once loaded
  buffers: new Map(), // runId -> events that arrived while its history was loading
  lastActivity: new Map(), // runId -> last tool/text event
  stageActivity: new Map(), // runId -> each active agent's latest activity
  starting: new Map(), // runId -> request and repository, until its first record arrives
  open: new Map(), // <details> open state, so re-renders keep what you expanded
  selected: null,
  runDetailsOpen: false,
  showArchived: false,
  stopping: new Set(),
  resuming: new Set(),
  results: new Map(),
  previewPending: new Set(),
  localAppPending: new Set(),
  browserPending: new Set(),
  verificationPending: new Set(),
  pullRequestPending: new Map(),
  draftReview: null,
  branchPreparation: null,
  wasDown: false,
};

const $ = (id) => document.getElementById(id);

// ── DOM helper ───────────────────────────────────────────

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key === "text") el.textContent = value;
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** A disclosure whose open state survives re-renders. A function defers building its contents. */
function details(key, title, content, defaultOpen = false, cls = "block") {
  const open = state.open.has(key) ? state.open.get(key) : defaultOpen;
  const deferred = typeof content === "function";
  const el = h("details", { class: cls, open, "data-disclosure": key }, h("summary", {}, title), deferred ? null : content);
  const load = () => {
    if (deferred && el.open && el.childElementCount === 1) el.append(content());
  };
  load();
  el.addEventListener("toggle", () => {
    if (!el.isConnected) return;
    state.open.set(key, el.open);
    load();
  });
  return el;
}

// ── Markdown ─────────────────────────────────────────────
// Agents answer in markdown. This renders a safe subset by creating elements and text nodes,
// never by parsing HTML: raw HTML in agent text stays text, and only http(s) URLs become links.

const MD_FENCE = /^\s*(`{3,}|~{3,})/;
const MD_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const MD_SECTION_LABEL = /^\s{0,3}(\*\*|__)([^*_]+)\1(:?)\s*$/;
const MD_RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const MD_QUOTE = /^\s{0,3}>\s?/;
const MD_LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const MD_TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;
// Groups: 1 escaped char · 2-3 code · 4-5 bold · 6 strikethrough · 7-8 italic · 9-10 link · 11 bare URL
const MD_INLINE =
  /\\([\\`*_{}[\]()#+\-.!|~<>])|(`+)(.+?)\2(?!`)|\*\*(?=\S)(.+?)(?<=\S)\*\*|(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)|~~(?=\S)(.+?)(?<=\S)~~|(?<![\w*\\])\*(?=[^\s*])(.+?)(?<=[^\s*\\])\*(?![\w*])|(?<![\w\\])_(?=[^\s_])(.+?)(?<=[^\s_\\])_(?!\w)|\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"*_~`])/g;

/** Markdown text as a <div class="md">. */
function md(text, cls = "") {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  return h("div", { class: cls ? `md ${cls}` : "md" }, mdBlocks(lines));
}

const mdBlank = (line) => line === undefined || !line.trim();
const mdIsTable = (line, next) => line.includes("|") && next !== undefined && MD_TABLE_SEP.test(next);
function mdSectionLabel(line) {
  const match = line.match(MD_SECTION_LABEL);
  return match && (match[2].endsWith(":") || match[3]) ? (match[2] + match[3]).trim() : "";
}

const mdStartsBlock = (line, next) =>
  MD_FENCE.test(line) || MD_HEADING.test(line) || mdSectionLabel(line) || MD_RULE.test(line) || MD_QUOTE.test(line) || MD_LIST.test(line) || mdIsTable(line, next);

function mdBlocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    let label;
    if (mdBlank(line)) {
      i++;
    } else if ((m = line.match(MD_FENCE))) {
      const body = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(m[1]); i++) body.push(lines[i]);
      i++; // the closing fence
      out.push(h("pre", { class: "md-code" }, h("code", { text: body.join("\n") })));
    } else if ((m = line.match(MD_HEADING))) {
      // Headings stay small: they sit inside cards, under the page's own headings.
      out.push(h(`h${Math.min(m[1].length + 2, 6)}`, { class: "md-h" }, mdInline(m[2])));
      i++;
    } else if ((label = mdSectionLabel(line))) {
      out.push(h("h4", { class: "md-h" }, mdInline(label)));
      i++;
    } else if (MD_RULE.test(line)) {
      out.push(h("hr", {}));
      i++;
    } else if (MD_QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && MD_QUOTE.test(lines[i])) body.push(lines[i++].replace(MD_QUOTE, ""));
      out.push(h("blockquote", {}, mdBlocks(body)));
    } else if (MD_LIST.test(line)) {
      i = mdList(lines, i, out);
    } else if (mdIsTable(line, lines[i + 1])) {
      i = mdTable(lines, i, out);
    } else {
      // A paragraph. Agents put one fact per line, so line breaks are kept.
      const p = h("p", {}, mdInline(line.trim()));
      for (i++; i < lines.length && !mdBlank(lines[i]) && !mdStartsBlock(lines[i], lines[i + 1]); i++) p.append(h("br", {}), ...mdInline(lines[i].trim()));
      out.push(p);
    }
  }
  return out;
}

function mdList(lines, i, out) {
  const first = lines[i].match(MD_LIST);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const list = h(ordered ? "ol" : "ul", {});
  if (ordered && parseInt(first[2], 10) !== 1) list.setAttribute("start", String(parseInt(first[2], 10)));
  const sameList = (m) => m && m[1].length === indent && /\d/.test(m[2]) === ordered;

  for (let m = first; sameList(m); m = lines[i]?.match(MD_LIST)) {
    // An item is its first line plus what follows it: indented lines (more text, nested lists),
    // and plain lines right under it.
    const contentIndent = m[1].length + m[2].length + 1;
    const body = [m[3]];
    for (i++; i < lines.length; ) {
      const l = lines[i];
      if (mdBlank(l)) {
        let j = i;
        while (j < lines.length && mdBlank(lines[j])) j++;
        if (j < lines.length && lines[j].search(/\S/) > indent) {
          body.push(...lines.slice(i, j));
          i = j;
          continue;
        }
        break;
      }
      const lead = l.search(/\S/);
      if (lead > indent) body.push(l.slice(Math.min(lead, contentIndent)));
      else if (!mdStartsBlock(l, lines[i + 1])) body.push(l.trim());
      else break;
      i++;
    }

    const li = h("li", {});
    const task = body[0].match(/^\[([ xX])\]\s+(.*)$/);
    if (task) {
      body[0] = task[2];
      const done = task[1] !== " ";
      li.className = "md-task";
      li.append(h("span", { class: "md-check", role: "img", "aria-label": done ? "done" : "to do", text: done ? "☑" : "☐" }), " ");
    }
    // Tight list: the item's first paragraph sits directly in the <li>.
    mdBlocks(body).forEach((block, n) => li.append(...(n === 0 && block.tagName === "P" ? [...block.childNodes] : [block])));
    list.append(li);

    // Blank lines between items still make one list.
    let j = i;
    while (j < lines.length && mdBlank(lines[j])) j++;
    if (j > i && sameList(lines[j]?.match(MD_LIST))) i = j;
  }
  out.push(list);
  return i;
}

function mdCells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function mdTable(lines, i, out) {
  const head = mdCells(lines[i]);
  // Alignment uses classes: the CSP blocks inline styles.
  const align = mdCells(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "md-center" : c.endsWith(":") ? "md-right" : null));
  const rows = [];
  for (i += 2; i < lines.length && !mdBlank(lines[i]) && lines[i].includes("|"); i++) rows.push(mdCells(lines[i]));
  const cell = (tag, text, n) => h(tag, { class: align[n] }, mdInline(text ?? ""));
  out.push(
    h(
      "div",
      { class: "md-table" },
      h("table", {}, h("thead", {}, h("tr", {}, head.map((c, n) => cell("th", c, n)))), h("tbody", {}, rows.map((r) => h("tr", {}, head.map((_, n) => cell("td", r[n], n)))))),
    ),
  );
  return i;
}

/** Inline markdown as an array of nodes. */
function mdInline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(MD_INLINE)) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    last = m.index + m[0].length;
    if (m[1] !== undefined) out.push(document.createTextNode(m[1]));
    else if (m[3] !== undefined) out.push(h("code", { text: m[3].replace(/^ (.+) $/, "$1") }));
    else if ((m[4] ?? m[5]) !== undefined) out.push(h("strong", {}, mdInline(m[4] ?? m[5])));
    else if (m[6] !== undefined) out.push(h("del", {}, mdInline(m[6])));
    else if ((m[7] ?? m[8]) !== undefined) out.push(h("em", {}, mdInline(m[7] ?? m[8])));
    else if (m[9] !== undefined) out.push(mdLink(m[10], mdInline(m[9])));
    else out.push(mdLink(m[11], [m[11]]));
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

function mdLink(url, children) {
  if (!/^https?:\/\//i.test(url)) return h("span", {}, children);
  return h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, children);
}

// ── Formatting ───────────────────────────────────────────

const firstLine = (text) => (text ?? "").split("\n")[0].trim();
const money = (usd) => usd == null ? "Dollar cost unavailable" : `~$${usd.toFixed(2)} est.`;
const providerLabel = (provider) => provider === "codex" ? "Codex" : "Claude";
const tokens = (usage) => `${usage.inputTokens.toLocaleString()} input / ${usage.outputTokens.toLocaleString()} output tokens`;
const usageLabel = (summary) => [
  summary.costUsd == null && summary.usage ? null : money(summary.costUsd),
  summary.usage ? tokens(summary.usage) : null,
].filter(Boolean).join(" · ");
const stageUsage = (run, stage) => {
  const totals = { costUsd: null, usage: undefined };
  for (const attempt of stage.attempts) {
    if (attempt.costUsd != null) totals.costUsd = (totals.costUsd ?? 0) + attempt.costUsd;
    if (attempt.usage) {
      totals.usage ??= { inputTokens: 0, outputTokens: 0 };
      totals.usage.inputTokens += attempt.usage.inputTokens;
      totals.usage.outputTokens += attempt.usage.outputTokens;
    }
  }
  return stage.attempts.length ? usageLabel(totals) : run.provider === "codex" ? "Usage pending" : money(0);
};
const dollars = (usd) => `$${Number.isInteger(usd) ? usd : usd.toFixed(2)}`;
/** Spend so far, against the run's budget when it has one. */
const spend = (run) => (run.budgetUsd && run.totals.costUsd != null ? `~$${run.totals.costUsd.toFixed(2)} of ${dollars(run.budgetUsd)} est.` : money(run.totals.costUsd));

function secs(ms) {
  const s = Math.round((ms ?? 0) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function ago(iso) {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  if (diff < 45_000) return "just now";
  const m = Math.round(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const hours = Math.round(m / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

const INITIALS = {
  orchestrator: "OR",
  backend: "BE",
  frontend: "FE",
  "ui-ux": "UX",
  "e2e-tester": "E2E",
  planner: "PL",
  reviewer: "RV",
  "docs-writer": "DOC",
  "release-manager": "REL",
  "google-cloud-releaser": "GCP",
  "bug-triager": "BUG",
  "security-auditor": "SEC",
  "dependency-updater": "DEP",
};
const initials = (role) => INITIALS[role] ?? role.slice(0, 2).toUpperCase();

const avatar = (role, small) => h("span", { class: `avatar role-${role}${small ? " sm" : ""}`, "aria-hidden": "true", text: initials(role) });

// ── Derived state ────────────────────────────────────────

const inboxFor = (runId, stage) => [...state.inbox.values()].filter((i) => i.runId === runId && (!stage || i.stage === stage));

function runStatus(run) {
  if (run.deployment?.phase === "approval") return "waiting";
  if (run.deployment?.phase === "publishing" && run.deployment.workflowRun) return "running";
  if (run.status === "running") {
    if (inboxFor(run.id).length) return "waiting";
    return state.active.has(run.id) ? "running" : "interrupted";
  }
  return run.status;
}

function stageStatus(run, stage) {
  if (stage.status === "running") return inboxFor(run.id, stage.name).length ? "waiting" : state.active.has(run.id) ? "running" : "stopped";
  // A review or audit that asks for changes did its job; it isn't a failure of the run.
  const verdict = stage.attempts.at(-1)?.output?.verdict;
  if (stage.status === "failed" && (verdict === "request_changes" || verdict === "fix_required")) return "changes";
  return stage.status;
}

function sortedRuns() {
  return [...state.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function visibleRuns() {
  return sortedRuns().filter((run) => Boolean(run.archivedAt) === state.showArchived);
}

function targetHasE2E(run) {
  const target = state.targets.find((t) => t.name === run.target);
  return target ? target.e2e : run.stages.some((s) => s.name === "e2e");
}

function completionLabel(run) {
  if (run.deployment) return run.finishedAt ? DEPLOYMENT_PHASE_LABEL[run.deployment.phase] : undefined;
  return { passed: "Run completed", failed: "Run failed", stopped: "Run stopped", error: "Run ended with an error" }[run.status];
}

function pendingDeployments() {
  return [...state.runs.values()].filter((run) => run.deployment?.phase === "approval" && !run.archivedAt);
}

function unreadResults() {
  const newest = new Set();
  return [...state.runs.values()]
    .filter((run) => run.finishedAt && completionLabel(run) && !run.archivedAt)
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
    .filter((run) => {
      const first = !newest.has(run.target);
      newest.add(run.target);
      // Existing histories did not track read state. Surface the latest result for each target.
      return run.completionRead === false || (first && run.completionRead === undefined);
    });
}

function activeReferenceAlerts() {
  return [...state.active].flatMap((id) => {
    const run = state.runs.get(id);
    return run ? (run.references ?? []).filter((check) => check.status !== "read" && !check.browserHelpSkipped && ![...state.inbox.values()].some((item) =>
      item.kind === "reference" && item.runId === id && item.url === check.url)).map((check) => ({ run, check })) : [];
  });
}

function workingTime(run) {
  const wall = run.finishedAt ? run.totals.durationMs : Date.now() - new Date(run.createdAt).getTime();
  const waiting = run.totals.reviewWaitMs ?? 0;
  if (run.stages.some(({ parallel }) => parallel) && waiting > 0) return `${secs(wall)} elapsed · ${secs(waiting)} combined agent wait`;
  return waiting > 0 ? `${secs(wall - waiting)} working · ${secs(waiting)} waiting for you` : secs(wall);
}

// ── API ──────────────────────────────────────────────────

async function api(path, { method = "GET", body, signal } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { code: data.code, unauthorized: res.status === 401 });
  return data;
}

async function loadState() {
  const s = await api("/api/state");
  state.config = s.config;
  state.acceptsAttachments = s.acceptsAttachments === true;
  state.chatProviders = s.chatProviders;
  state.feedbackReusesBranch = s.feedbackReusesBranch === true;
  state.stages = s.stages;
  state.efforts = s.efforts;
  state.codexEfforts = s.codexEfforts;
  state.roles = s.roles;
  state.targets = s.targets;
  if (state.config.canAddTargets) void refreshLocalRepos();
  state.runs = new Map(s.runs.map((r) => [r.id, r]));
  state.results.clear();
  state.active = new Set(s.active);
  state.inbox = new Map(s.inbox.map((i) => [i.id, i]));
  state.referenceDrafts = new Map((s.referenceHandoffs ?? []).map(({ runId, url, status }) => [referenceKey(runId, url), status]));
  if ($("new-run-dialog").open) {
    fillTargets(); // after a reconnect, an open dialog shows the current repos
    updateCrew();
  }
  if (state.selected && !state.runs.has(state.selected) && !state.starting.has(state.selected)) setRunContext(null);
  schedule();
  if (state.selected) loadEvents(state.selected);
  if ($("reference-handoff-dialog").open) void refreshReferenceHandoff();
}

async function readAttachments(input) {
  const files = [...(input.files ?? input)];
  if (!files.length) return undefined;
  if (!state.acceptsAttachments) throw new Error("This Shipyard server cannot receive attachments. Restart the dashboard before sending files.");
  const mb = 1024 * 1024;
  if (files.length > 6 || files.some((file) => file.size > 3 * mb) || files.reduce((total, file) => total + file.size, 0) > 8 * mb) {
    throw new Error("Attach up to 6 files, at most 3 MB each and 8 MB total.");
  }
  return Promise.all(files.map((file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, data: String(reader.result).split(",", 2)[1] });
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  })));
}

function reviewChatFiles(id, bundles = []) {
  const list = $(id);
  list.replaceChildren(...bundles.map(({ id, files }) => h("span", { class: "chat-file", "data-bundle": id },
    files.join(", "), chatButton("Remove", (event) => event.currentTarget.parentElement.remove(), { "aria-label": `Remove ${files.join(", ")}` }))));
}

function chatFileIds(id) {
  return [...$(id).querySelectorAll("[data-bundle]")].map((entry) => entry.dataset.bundle);
}

function attachmentField(input, id) {
  input.setAttribute("aria-describedby", id);
  return h("label", { class: "field" }, h("span", { class: "field-label", text: "Attach files or images" }),
    input, h("span", { id, class: "field-help", text: "Up to 6 files, 3 MB each and 8 MB total." }));
}

function initialSelection() {
  const fromHash = location.hash.match(/^#run\/([\w-]+)$/)?.[1];
  if (fromHash && state.runs.has(fromHash)) {
    state.showArchived = Boolean(state.runs.get(fromHash).archivedAt);
    return fromHash;
  }
  return null;
}

async function loadEvents(runId) {
  if (state.buffers.has(runId)) return; // already loading
  state.buffers.set(runId, []);
  try {
    const { run, events } = await api(`/api/runs/${runId}`);
    state.runs.set(run.id, run);
    const seen = new Set(events.slice(-300).map((e) => JSON.stringify(e)));
    const late = (state.buffers.get(runId) ?? []).filter((e) => !seen.has(JSON.stringify(e)));
    state.events.set(runId, [...events, ...late]);
  } catch (err) {
    // A run you just started may not be saved yet: keep what streamed in and append live from here.
    if (String(err.message).includes("No such run")) state.events.set(runId, state.buffers.get(runId) ?? []);
    else toast(`Couldn't load the run: ${err.message}`, true);
  } finally {
    state.buffers.delete(runId);
    schedule("detail");
  }
}

const isRunActivity = (event) => ["tool", "text", "gate_start", "attempt_start"].includes(event.type);
function runActivityLabel(event) {
  if (event.type === "gate_start") return `Running check · ${event.command}`;
  if (event.type === "attempt_start") return `Starting ${event.stage} · attempt ${event.attempt}`;
  if (event.type === "text") return "Agent update";
  return ({ Bash: "Ran a command", Edit: "Edited the worktree", WebRead: "Read a web page",
    WebSearch: "Searched the web", Browser: "Checked the page in a browser" })[event.tool] ?? event.tool;
}

// ── Live updates ─────────────────────────────────────────

function connect() {
  const es = new EventSource("/api/stream");
  es.addEventListener("open", () => {
    setConn("live");
    if (state.wasDown) {
      state.wasDown = false;
      state.events.clear();
      if (chat.messages.length) void saveChat();
    }
    // Reconcile any completions that landed between loading the page and subscribing.
    loadState().catch(() => {});
    void refreshChatHistory();
  });
  es.addEventListener("error", () => {
    setConn("down");
    state.wasDown = true;
    // The browser only retries network errors. After an HTTP error (say 401 because the server
    // restarted with a new token) it gives up for good, so take over the retrying ourselves.
    if (es.readyState === EventSource.CLOSED) {
      es.close();
      recheck();
    }
  });
  const on = (type, fn) => es.addEventListener(type, (e) => fn(JSON.parse(e.data)));

  on("run", ({ run }) => {
    const previous = state.runs.get(run.id);
    state.runs.set(run.id, run);
    if (run.deployment && !previous) state.results.delete(run.deployment.sourceRunId);
    if (run.followUp && (!previous || previous.branch !== run.branch)) {
      for (const other of state.runs.values()) {
        if (other.repo === run.repo && (other.branch === run.branch || other.branch === previous?.branch)) state.results.delete(other.id);
      }
    }
    if (previous?.finishedAt !== run.finishedAt) {
      state.results.delete(run.id);
      if (run.finishedAt && !run.completionRead && completionLabel(run)) notifyCompletion(run);
    }
    if (previous?.publication?.pullRequestUrl !== run.publication?.pullRequestUrl) state.results.delete(run.id);
    if (previous?.verification?.checks[0]?.checkedAt !== run.verification?.checks[0]?.checkedAt) state.results.delete(run.id);
    if (run.id === state.selected && run.status === "running" && !run.archivedAt && state.active.has(run.id)) state.showArchived = false;
    state.starting.delete(run.id);
    schedule();
  });
  on("run-deleted", ({ runId }) => {
    const dialog = $("reference-handoff-dialog");
    if (dialog.open && $("reference-handoff-form").dataset.runId === runId) dialog.close();
    const removed = state.runs.get(runId);
    if (removed) {
      for (const other of state.runs.values()) {
        if (other.repo === removed.repo && other.branch === removed.branch) state.results.delete(other.id);
      }
    }
    forgetRun(runId);
  });
  on("preview", ({ runId, url }) => {
    const result = state.results.get(runId);
    if (result && !result.loading) result.previewUrl = url;
    if (runId === state.selected) schedule("detail");
  });
  on("local-app", ({ runId, app }) => {
    const result = state.results.get(runId);
    if (result && !result.loading) result.localApp = app;
    if (runId === state.selected) schedule("detail");
  });
  on("git-remote", ({ repo }) => refreshRepoResults(repo));
  on("reference-handoff", ({ runId, url, status }) => {
    if (url && status) state.referenceDrafts.set(referenceKey(runId, url), status);
    else if (url) state.referenceDrafts.delete(referenceKey(runId, url));
    else {
      for (const key of state.referenceDrafts.keys()) if (key.startsWith(`${runId}\n`)) state.referenceDrafts.delete(key);
    }
    const form = $("reference-handoff-form");
    const open = $("reference-handoff-dialog").open && form.dataset.runId === runId && (!url || form.dataset.url === url);
    if (open && (status || !url)) void refreshReferenceHandoff();
    else if (!open && status) toast(status === "ready" ? "Reference notes ready for review" : "The browser reference needs attention", status === "blocked");
    schedule();
  });
  on("event", ({ runId, event }) => {
    if (isRunActivity(event)) {
      state.lastActivity.set(runId, event);
      if (event.stage) {
        if (!state.stageActivity.has(runId)) state.stageActivity.set(runId, new Map());
        state.stageActivity.get(runId).set(event.stage, event);
      }
    }
    const run = state.runs.get(runId);
    const willAsk = run?.browserReferenceHelp && run.referenceUrls?.includes(event.url) && ["partial", "blocked"].includes(event.status);
    if (event.type === "reference" && event.status !== "read" && event.source !== "manual" && !willAsk) {
      const message = `Reference needs attention · ${state.runs.get(runId)?.target ?? "Shipyard"}`;
      toast(message, true);
      if (document.hidden && "Notification" in window && Notification.permission === "granted") {
        const notice = new Notification(message, { body: event.detail });
        notice.onclick = () => { window.focus(); select(runId); notice.close(); };
      }
    }
    if (state.buffers.has(runId)) state.buffers.get(runId).push(event);
    else state.events.get(runId)?.push(event);
    schedule(runId === state.selected || runId === chat.runId ? "detail" : null, "runs");
  });
  on("inbox", ({ item }) => {
    state.inbox.set(item.id, item);
    notify(item);
    schedule();
  });
  on("inbox-resolved", ({ id }) => {
    const dialog = $("reference-handoff-dialog");
    if (dialog.open && !$("reference-handoff-close").disabled && $("reference-handoff-form").dataset.itemId === id) dialog.close();
    state.inbox.delete(id);
    schedule();
  });
  on("targets", ({ targets }) => {
    state.targets = targets;
    if (state.config?.canAddTargets) void refreshLocalRepos();
    if ($("new-run-dialog").open) {
      fillTargets();
      updateCrew();
    }
    schedule();
  });
  on("active", ({ runIds }) => {
    state.active = new Set(runIds);
    for (const id of state.stopping) if (!state.active.has(id)) state.stopping.delete(id);
    schedule();
  });
  on("chat-web", ({ turnId, activity }) => {
    if (chat.pending?.id === turnId) $("chat-status").textContent = activity === "read" ? "Reading public sources…" : "Searching the web…";
  });
  on("chat-history", ({ chat: saved }) => rememberSavedChat(saved));
  on("run-error", ({ runId, error }) => {
    state.starting.delete(runId);
    toast(`Couldn't start the run: ${error}`, true);
    if (state.selected === runId) setRunContext(null);
    schedule();
  });
}

/** Wait for the server, then reconnect. If it answers but no longer knows this tab, say so. */
function recheck(delay = 2000) {
  setTimeout(async () => {
    try {
      await api("/api/state");
      connect();
    } catch (err) {
      if (err.unauthorized) return unauthorized(true);
      recheck(Math.min(delay * 2, 15_000));
    }
  }, delay);
}

function setConn(kind) {
  const el = $("conn");
  el.className = `conn ${kind}`;
  el.querySelector(".conn-label").textContent = kind === "live" ? "Live" : "Reconnecting…";
}

function notify(item) {
  if (!document.hidden || !("Notification" in window) || Notification.permission !== "granted") return;
  const what = item.needsApproval ? "approval to read a public reference" :
    { checkpoint: "a checkpoint review", question: "a question", permission: "permission", reference: "browser help to read a reference" }[item.kind];
  new Notification("shipyard", { body: `${item.role} needs ${what}` });
}

function notifyCompletion(run) {
  const message = `${completionLabel(run)} · ${run.target}`;
  toast(message, run.status === "failed" || run.status === "error");
  if (!document.hidden || !("Notification" in window) || Notification.permission !== "granted") return;
  const notice = new Notification(message, { body: firstLine(run.request) });
  notice.onclick = () => {
    window.focus();
    viewResult(run);
    notice.close();
  };
}

// ── Render scheduling ────────────────────────────────────

const dirty = new Set();
let frame = 0;
let fallback = 0;

function schedule(...parts) {
  const wanted = parts.filter(Boolean);
  for (const p of wanted.length ? wanted : ["meta", "runs", "detail", "inbox"]) dirty.add(p);
  if (frame || fallback) return;
  // Draw on the next frame. Browsers pause frames in background tabs, so a timer backs it up:
  // otherwise the "(1) shipyard" title badge, there to catch you in another tab, would never update.
  frame = requestAnimationFrame(flush);
  fallback = setTimeout(flush, 250);
}

function flush() {
  cancelAnimationFrame(frame);
  clearTimeout(fallback);
  frame = 0;
  fallback = 0;
  const parts = new Set(dirty);
  dirty.clear();
  if (parts.has("meta")) renderMeta();
  if (parts.has("runs")) renderRuns();
  if (parts.has("detail")) renderDetail();
  if (parts.has("inbox")) renderInbox();
}

// ── Top bar ──────────────────────────────────────────────

function renderMeta() {
  const meta = $("meta");
  meta.replaceChildren();
  if (state.config?.demo) meta.append(h("span", { class: "pill s-waiting", text: "Demo mode · scripted agents, no provider usage" }));
  const requests = state.inbox.size + activeReferenceAlerts().length + pendingDeployments().length;
  const updates = unreadResults().length;
  const n = requests + updates;
  const label = [requests ? `${requests} waiting for your input` : "", updates ? `${updates} completed run updates` : ""].filter(Boolean).join(" · ");
  for (const el of [$("inbox-count"), $("inbox-toggle-count")]) {
    el.textContent = n ? String(n) : "";
    el.hidden = !n;
    el.title = label;
    el.classList.toggle("has", requests > 0);
    el.classList.toggle("has-updates", !requests && updates > 0);
  }
  $("inbox-toggle").title = label || "Inbox";
  if (label) $("inbox-toggle").setAttribute("aria-description", label);
  else $("inbox-toggle").removeAttribute("aria-description");
  document.title = n ? `(${n}) shipyard` : "shipyard";
  $("notifications-enable").hidden = !("Notification" in window) || Notification.permission !== "default";
  $("new-run").disabled = state.targets.length === 0 && !state.config?.canAddTargets;
}

// ── Runs column ──────────────────────────────────────────

function updateRunFilters() {
  const select = $("run-repo-filter");
  const repositories = new Map();
  for (const { repo, target } of [...state.runs.values(), ...state.starting.values()]) {
    if (repo) repositories.set(repo, target);
  }
  const entries = [...repositories].sort(([aPath, aName], [bPath, bName]) => aName.localeCompare(bName) || aPath.localeCompare(bPath));
  const names = new Map();
  for (const [, name] of entries) names.set(name, (names.get(name) ?? 0) + 1);
  const options = entries.map(([path, name]) => [path, names.get(name) === 1 ? name : `${name} (${path})`]);
  const current = [...select.options].slice(1);
  if (current.length === options.length && options.every(([path, label], index) => current[index].value === path && current[index].text === label)) return;
  const selected = select.value;
  select.replaceChildren(h("option", { value: "", text: "All repos" }), ...options.map(([path, label]) => h("option", { value: path, title: path, text: label })));
  select.value = repositories.has(selected) ? selected : "";
}

function renderRuns() {
  const list = $("run-list");
  updateRunFilters();
  const repo = $("run-repo-filter").value;
  const statusFilter = $("run-status-filter").value;
  const query = $("run-search").value.trim().toLowerCase();
  const terms = query ? query.split(/\s+/) : [];
  const matches = (run, status) => {
    if ((repo && run.repo !== repo) || (statusFilter && status !== statusFilter)) return false;
    const fields = [run.request, run.target, run.repo, run.branch, run.id, providerLabel(run.provider), run.followUp?.brief];
    return terms.every((term) => fields.some((field) => field?.toLowerCase().includes(term)));
  };
  const items = [];
  for (const [id, run] of state.showArchived ? [] : state.starting) {
    if (state.runs.has(id) || !matches({ ...run, id }, "starting")) continue;
    items.push(runItem({ id, title: firstLine(run.request), status: "starting", meta: `${run.target} · starting…` }));
  }
  const runs = visibleRuns();
  for (const run of runs) {
    const status = runStatus(run);
    if (!matches(run, status)) continue;
    const waiting = inboxFor(run.id).length;
    const live = state.active.has(run.id) ? state.lastActivity.get(run.id) : null;
    items.push(
      runItem({
        id: run.id,
        title: firstLine(run.request),
        status,
        badge: waiting ? waiting : null,
        meta: run.deployment ? `${run.target} · ${DEPLOYMENT_PROVIDERS[run.deployment.provider]} · ${status === "interrupted" ? "Interrupted" : DEPLOYMENT_PHASE_LABEL[run.deployment.phase]}` :
          `${run.target} · ${KIND_SHORT[run.kind] ?? run.kind} · ${providerLabel(run.provider)} · ${ago(run.createdAt)} · ${usageLabel(run.totals)}`,
        live: live ? runActivityLabel(live) : null,
      }),
    );
  }
  const filtered = Boolean(query || repo || statusFilter);
  const empty = filtered ? "No matching runs." : state.showArchived ? "No archived runs." : "No runs yet.";
  list.replaceChildren(...(items.length ? items : [h("li", { class: "list-empty", text: empty })]));
  const running = state.active.size;
  const summary = filtered ? `${items.length} ${items.length === 1 ? "match" : "matches"}`
    : !state.showArchived && running ? `${running} running` : runs.length ? `${runs.length} total` : "";
  if ($("runs-sub").textContent !== summary) $("runs-sub").textContent = summary;
  $("archive-toggle").setAttribute("aria-pressed", String(state.showArchived));
  $("archive-toggle").textContent = state.showArchived ? "Back to runs" : "Archived";
}

function runItem({ id, title, status, meta, badge, live }) {
  return h(
    "li",
    {},
    h(
      "button",
      { type: "button", class: `run-item${id === state.selected ? " selected" : ""}`, onclick: () => select(id), "aria-current": id === state.selected ? "true" : null },
      h("span", { class: `run-dot s-${status}`, title: STATUS_LABEL[status] ?? status }),
      h("span", { class: "run-title", text: title || "(untitled)" }),
      badge ? h("span", { class: "count has", title: "Needs your answer", text: String(badge) }) : h("span"),
      h("span", { class: "run-meta", text: meta }),
      live ? h("span", { class: "run-live", text: live }) : null,
    ),
  );
}

function setRunContext(id, details = false) {
  if (id !== state.selected) {
    $("chat-context").scrollTop = 0;
    $("chat-command-menu").open = false;
  }
  if (id !== chat.revisionMode?.runId) chat.revisionMode = null;
  if (chat.runAction && id !== chat.runAction.runId) {
    chat.runAction = null;
    renderRunAction();
  }
  chat.runId = id;
  renderRevisionDraft();
  state.selected = id;
  state.runDetailsOpen = Boolean(id && details);
  if (id) {
    const run = state.runs.get(id);
    state.showArchived = Boolean(run?.archivedAt);
    if (run?.finishedAt && (run.kind === "bug" || run.bugVerification)) state.results.delete(id);
    history.replaceState(null, "", `#run/${id}`);
    if (!state.events.has(id)) loadEvents(id);
  } else {
    history.replaceState(null, "", chat.messages.length ? `#chat/${chat.id}` : location.pathname + location.search);
  }
  renderChatHistory();
  schedule("runs", "detail");
  closeInboxDrawer();
}

async function select(id, { details = false, keepChat = false } = {}) {
  if (chat.revisionDraft?.busy && id !== chat.runId) {
    toast("Wait for Shipyard to finish starting the revision.");
    return false;
  }
  if (!id) {
    setRunContext(null);
    if (!chat.messages.length) renderChatThread();
    void saveChat();
    return true;
  }
  const run = state.runs.get(id) ?? state.starting.get(id);
  if (!run) return false;
  const linked = chat.history.find((entry) => entry.runIds?.includes(id));
  const inChat = chat.runId === id || chat.messages.some((message) => message.runId === id) || linked?.id === chat.id;
  if (!keepChat && !inChat) {
    if (linked) return openSavedChat(linked.id, { runId: id, details });
    if (chat.pending || chat.revisionDraft?.busy) {
      toast("Wait for the current request before switching chats.");
      return false;
    }
    if (chat.messages.length || $("chat-input").value || chat.files.length || chat.revisionDraft) {
      const navigation = ++chat.navigation;
      if (!await saveChat() || navigation !== chat.navigation) return false;
      rememberChatDraft();
      resetChatDraft(crypto.randomUUID());
      Object.assign(chat, { messages: [], removed: [], savedMessages: new Set(), target: run.target, provider: run.provider ?? "", cached: true });
    }
    setRunContext(id, details);
    appendChat({ role: "assistant", runId: id, runTitle: firstLine(run.request), content: run.finishedAt ? "Run linked to this chat." : "Run started." });
    return true;
  }
  setRunContext(id, details);
  void saveChat();
  if (!chat.messages.length) renderChatThread();
  return true;
}

async function viewResult(run) {
  if (!await select(run.id)) return;
  renderChatControls();
  const update = $("chat-run-update");
  update.scrollIntoView({ block: "nearest" });
  update.querySelector("h2")?.focus({ preventScroll: true });
  void acknowledgeResult(run);
}

// ── Detail column ────────────────────────────────────────

function runRepository(run) {
  return h("p", { class: "run-repository repo-context" }, "Repository ", h("strong", { text: run.target }), run.repo ? [" · ", h("code", { text: run.repo })] : null);
}

function renderDetail() {
  const root = $("detail");
  const run = state.runs.get(state.selected) ?? state.starting.get(state.selected);
  renderChatControls();
  root.hidden = !state.runDetailsOpen || !run;
  if (root.hidden) return;

  const result = run.id && run.finishedAt && !run.deployment && completionLabel(run) ? finishedResult(run.id) : undefined;
  const summary = runSummary(run, result);
  const focused = document.activeElement;
  const disclosure = root.contains(focused) && focused.matches("details[data-disclosure] > summary") ? focused.parentElement : null;
  if (disclosure) state.open.set(disclosure.dataset.disclosure, disclosure.open);
  const panel = $("chat-context");
  const scroll = panel.scrollTop;
  root.replaceChildren(
    h("div", { class: "run-detail-brief" },
      summary.description ? h("p", { text: summary.description }) : null,
      summary.change || summary.checks ? h("p", { class: "run-detail-facts", text: [summary.change, summary.checks].filter(Boolean).join(" ") }) : null,
      h("div", { class: "run-next-step" }, h("strong", { text: "Next step" }), h("p", { text: summary.next })),
    ),
    ...(run.id ? [details(`${run.id}:technical`, "Technical details",
      () => run.deployment ? renderDeployment(run) : renderTechnicalRun(run, result), false, "run-technical")] : []),
  );
  if (disclosure) root.querySelector(`details[data-disclosure="${CSS.escape(disclosure.dataset.disclosure)}"] > summary`)?.focus({ preventScroll: true });
  panel.scrollTop = scroll;
}

function renderTechnicalRun(run, result) {
  const status = runStatus(run);
  const assignments = revisionAssignments(run);
  const waiting = inboxFor(run.id);
  const recovery = result && (run.status === "failed" || run.status === "error" || result.recheckStage);
  const checking = recovery && (state.verificationPending.has(run.id) || result.savedEditsCheck === "checking");
  const lastStage = run.stages.at(-1);
  const repairInProgress = run.status === "running" && lastStage?.status === "running" && lastStage.repairRole;
  const repairing = repairInProgress && status === "running";
  const repairNeedsYou = repairInProgress && status === "waiting";
  const events = state.events.get(run.id);
  const latestActivity = status === "running" ? events?.findLast(isRunActivity) ?? state.lastActivity.get(run.id) : null;
  return h(
    "div",
    { class: "detail-inner" },
    h(
      "section",
      { class: "run-head" },
      latestActivity ? h("p", { class: "banner", role: "status" },
        runActivityLabel(latestActivity), latestActivity.at ?
          h("span", { class: "field-help", "data-time": latestActivity.at, text: ago(latestActivity.at) }) : null) : null,
      recovery ? recoveryHandoff(run, result, checking) : null,
      repairing ? h("p", { class: "banner", role: "status" },
        lastStage.autoRepair ? `The crew is repairing the ${lastStage.autoRepair.command} failure in this revision.` : "The crew is repairing the failed check in this revision.",
        " Shipyard will rerun the checks. No action is needed right now.",
      ) : null,
      run.followUp ? h("div", { class: "feedback-brief" },
        h("strong", { text: "Your feedback" }),
        h("p", { text: run.request }),
        state.runs.has(run.followUp.runId) ? h("a", { href: `#run/${run.followUp.runId}`, text: "View source run" }) : null,
      ) : null,
      details(`${run.id}:metadata`, "Run metadata", [runRepository(run),
        run.request ? h("p", { class: "chat-text", text: run.request }) : null, h(
        "div",
        { class: "run-facts" },
        h("span", { class: "chip", text: KIND_LABEL[run.kind] ?? run.kind }),
        h("span", { class: "chip", text: providerLabel(run.provider) }),
        h("span", { class: "chip", title: run.model, text: `${modelLabel(run.model)}${run.effort ? ` · ${run.effort}` : ""}` }),
        h(
          "span",
          { class: "chip mono", title: run.worktree },
          h("span", { class: "chip-text", text: run.branch }),
        ),
        h("span", { class: "chip", title: run.totals.costUsd == null ? undefined : "Claude usage estimated at API prices", text: spend(run) }),
        run.totals.usage ? h("span", { class: "chip", text: tokens(run.totals.usage) }) : null,
        h("span", { class: "chip", id: "elapsed", text: workingTime(run) }),
        h("span", { class: "chip", text: `${run.totals.attempts} attempt${run.totals.attempts === 1 ? "" : "s"}` }),
      )]),
    ),
    waiting.length
      ? h(
          "div",
          { class: "banner", role: "status" },
          repairNeedsYou ? "The crew is waiting for your decision before it can continue the repair." :
            waiting[0].kind === "reference" ? `${waiting.length === 1 ? "1 reference needs" : `${waiting.length} references need`} your input in chat.` :
            `${waiting.length === 1 ? "An agent is" : `${waiting.length} agents are`} waiting for your answer`,
        )
      : null,
    result ? runResult(run, result, recovery) : null,
    renderPipeline(run, assignments),
    assignments.length ? details(`${run.id}:assignments`, "Specialist assignments", h("ol", { class: "revision-assignments" },
      assignments.map(({ role, task }) => h("li", {}, h("strong", { text: roleLabel(role) }), h("p", { text: task }))),
    ), true) : null,
    h("section", { class: "lanes", "aria-label": "Agents" }, run.stages.map((stage) => renderLane(run, stage, events))),
    events === undefined ? h("div", { class: "working" }, h("span", { class: "spinner" }), "Loading activity…") : null,
  );
}

function loadResult(runId) {
  const pending = { loading: true };
  state.results.set(runId, pending);
  pending.ready = api(`/api/runs/${runId}/result`)
    .then((result) => { if (state.results.get(runId) === pending) state.results.set(runId, result); })
    .catch((error) => { if (state.results.get(runId) === pending) state.results.set(runId, { error: error.message }); })
    .finally(() => { if (state.selected === runId) schedule("detail"); });
}

function finishedResult(runId) {
  if (!state.results.has(runId)) loadResult(runId);
  return state.results.get(runId);
}

function runSummaryChecks(run, result) {
  if (state.verificationPending.has(run.id) || result.savedEditsCheck === "checking") return "Checks are running.";
  const savedEdits = result.handoff?.uncommittedCount > 0;
  const checkedEdits = ["passed", "failed"].includes(result.savedEditsCheck);
  if (savedEdits && !checkedEdits) return "The saved edits still need to be checked.";
  const gates = (run.stages ?? []).flatMap((stage) => stage.attempts.at(-1)?.gates ?? []);
  const latest = new Map(gates.map((gate) => [gate.command, gate]));
  if (checkedEdits || (run.verification?.head === result.handoff?.head && result.handoff?.uncommittedCount === 0)) {
    for (const gate of run.verification?.checks ?? []) latest.set(gate.command, gate);
  }
  if (run.browserCheck && !savedEdits) latest.set(run.browserCheck.command, run.browserCheck);
  const passed = [...latest.values()].filter(gateOk).length;
  const skipped = [...latest.values()].reduce((count, gate) => count + Number(gate.outputTail?.match(/^# skipped\s+(\d+)/m)?.[1] ?? 0), 0);
  if (!latest.size) return "No checks recorded.";
  return `${passed} of ${latest.size} recorded checks passed.${skipped ? ` ${skipped} tests skipped.` : ""}`;
}

function deliveredBrief(run) {
  const stages = run.stages ?? [];
  for (const stage of stages.toReversed()) {
    if (!stage.commit || ["e2e", "e2e-tester", "orchestrate"].includes(stage.name)) continue;
    const report = stage.attempts.findLast((attempt) => attempt.summary)?.summary;
    const text = report && reportSections(report).get("delivered")?.split("\n")
      .map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
    if (!text) continue;
    const clean = text.replace(/^[-*]\s+/, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*|`/g, "");
    const brief = clean.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? clean;
    return brief.length > 164 ? `${brief.slice(0, 161).replace(/\s+\S*$/, "")}…` : brief;
  }
}

function deploymentNextStep(run, result) {
  if (run.status !== "passed" || !run.finishedAt || run.deployment || result.loading || result.error) return;
  const publication = result.publish;
  const deployment = (result.deploymentIds ?? []).map((id) => state.runs.get(id)).find((entry) => entry?.deployment && !entry.archivedAt);
  if (deployment) return {
    next: deployment.deployment.phase === "published" ? "Deployment finished. Open it to see the outcome." :
      deployment.deployment.phase === "approval" ? "Your deployment approval is ready in chat." : "Open the deployment to see its status.",
    action: { label: "Open deployment", runId: deployment.id },
  };
  if (result.handoff?.uncommittedCount > 0) return { next: "The worktree has saved edits. Commit them before publishing this version." };
  if (publication?.pullRequestState === "merged" && !publication.pushed) return {
    heading: "New pull request needed",
    next: "The linked pull request was merged earlier. This newer commit still needs its own pull request before deployment.",
  };
  if (publication?.pullRequestState === "merged") return {
    heading: "Ready for deployment review",
    next: "The pull request is merged. Review the deployment destination and commit to continue.",
    action: { label: "Review deployment", question: "Deploy this run" },
  };
  if (/^https:\/\//i.test(publication?.pullRequestUrl ?? "")) return {
    heading: "Pull request ready",
    next: "Merge the pull request on GitHub. Then return to chat and say “Deploy this run”.",
    action: { label: "Open pull request", href: publication.pullRequestUrl },
  };
  if (publication?.closedPullRequestUrl && result.handoff?.uncommittedCount === 0) return {
    next: "Reopen and merge the pull request to make this commit available for deployment.",
    action: { label: "Review reopening the pull request", draftReview: "reopen" },
  };
  if (publication?.canDraftPullRequest && result.handoff?.uncommittedCount === 0) return {
    heading: "Ready for pull request",
    next: `${publication.pushed ? "The commit is on GitHub." : "The commit is saved locally."} Review a draft pull request, then merge it on GitHub to continue to deployment.`,
    action: { label: "Review draft pull request", draftReview: "create" },
  };
  if (result.hasRemote === false) return {
    heading: "Git remote needed",
    next: "Connect a GitHub repository to review this commit for publication.",
    action: { label: "Connect Git remote", command: "Connect Git remote" },
  };
  if (result.publishUnavailable) return { heading: "Git remote needs review", next: result.publishUnavailable };
}

function runSummary(run, result) {
  result ??= {};
  const status = run.id ? runStatus(run) : "starting";
  const item = inboxFor(run.id)[0];
  if (item) {
    const [next, label] = {
      question: ["Answer the crew’s question to keep the run moving.", "Answer question"],
      permission: ["Review the permission request to decide whether to continue.", "Review permission"],
      reference: ["Review the crew’s request for a reference.", "Review reference"],
      checkpoint: ["Review the crew’s work and choose what happens next.", "Review checkpoint"],
    }[item.kind] ?? ["Review the request from the crew.", "Review request"];
    return { heading: "Waiting for your input", next, action: { label, decisionId: item.id } };
  }
  if (run.deployment) {
    const { phase, review, workflowReview } = run.deployment;
    if (phase === "approval") return {
      heading: "Deployment needs approval", next: "Review the destination and commit before deploying.",
      action: review || workflowReview ? { label: "Review deployment", decisionId: deploymentDecisionId(run.id) } : undefined,
    };
    if (status === "interrupted") return { heading: "Deployment interrupted", next: "Check the deployment details before trying again." };
    if (phase === "published") {
      const href = run.firebaseRelease?.url ?? run.deployment.workflowRun?.url;
      const action = /^https:\/\//i.test(href ?? "") ? { label: run.firebaseRelease ? "Open live site" : "View deployment on GitHub", href } : undefined;
      return { heading: "Deployment complete", next: "The reviewed deployment finished successfully.", action };
    }
    if (phase === "failed" || phase === "cancelled") return { heading: DEPLOYMENT_PHASE_LABEL[phase], next: "Open Run details for the outcome." };
    return { heading: DEPLOYMENT_PHASE_LABEL[phase] ?? "Deployment in progress", next: "Shipyard will ask in chat if it needs your input." };
  }
  if (status === "starting" || status === "running") return {
    heading: status === "starting" ? "Starting the run" : "Run in progress",
    next: "Shipyard will ask here if the crew needs your input.",
  };

  const saved = result.handoff?.uncommittedCount;
  const committed = result.handoff?.fileCount;
  const change = saved > 0 ? `${saved} ${saved === 1 ? "file" : "files"} with saved edits.` :
    typeof committed === "number" ? committed === 0 ? "0 files changed." : `${committed} ${committed === 1 ? "file" : "files"} changed.` :
      run.cleanedUp ? "The empty worktree was removed." : undefined;
  const summary = {
    heading: status === "passed" ? run.followUp ? "Revision complete" : "Run complete" :
      status === "stopped" ? "Run stopped" : status === "interrupted" ? "Run interrupted" : "Run needs attention",
    change,
    description: saved === 0 && committed > 0 ? deliveredBrief(run) : undefined,
    checks: run.finishedAt ? runSummaryChecks(run, result) : undefined,
  };
  if (result.latestRevisionId) return {
    ...summary, next: "There’s a newer revision on this branch.", action: { label: "Open latest revision", runId: result.latestRevisionId },
  };
  if (result.loading) return { ...summary, next: "Loading the options for this run…" };
  if (result.error) return { ...summary, next: "Open this run again to reload its result." };
  const offer = (label, command, next) => ({ ...summary, next, action: { label, command } });
  if (result.budgetPause) return offer("Review budget", "Increase budget", "Review a new budget before continuing.");
  if (state.verificationPending.has(run.id) || result.savedEditsCheck === "checking") {
    return { ...summary, next: "Shipyard will show the result when the checks finish." };
  }
  if (result.recheckStage && result.savedEditsCheck === "passed") {
    return offer("Continue run", "Continue this run", "The saved edits passed their checks. You can continue.");
  }
  if (result.canResumeProjectCheck || !run.cleanedUp && ["stopped", "interrupted"].includes(status)) {
    return offer("Resume run", "Resume run", "Continue from the saved worktree.");
  }
  if (result.canFixRevision) return offer("Retry repair", "Retry repair", "The crew can retry the failed check.");
  if (result.recheckStage) return offer("Check saved edits", "Check saved edits", "Run the checks again on the saved edits.");
  if (result.canPrepareBranch) return offer("Review branch cleanup", "Review branch cleanup", "Review the branch before continuing.");
  const publishing = isDeployCommand(normalizeRunCommand(run.request ?? "")) || chat.messages.some((message) =>
    message.role === "user" && message.runId === run.id && !message.bundle && isDeployCommand(normalizeRunCommand(message.content ?? "")));
  const deploymentStep = publishing && deploymentNextStep(run, result);
  if (deploymentStep) return { ...summary, ...deploymentStep };
  if (status === "passed" && committed === 0 && !saved) {
    return { ...summary, next: "Tell Shipyard what you’d like to change." };
  }
  if (status === "passed" && (result.canPreview || result.previewUrl)) {
    return offer("Preview the changes", "Open local preview",
      saved ? "Preview the saved edits and tell Shipyard what you think." : "Preview this version and tell Shipyard what you think.");
  }
  if (status === "passed" && result.localApp?.url) {
    return offer("Open local app", "Open local app", "Open the app to try this version.");
  }
  if (status === "passed" && result.localApp?.starting) return { ...summary, next: "The local app is starting." };
  if (status === "passed" && saved) return { ...summary, next: "Review the saved edits before sharing this version." };
  return { ...summary, next: status === "passed" ? "Ask what changed or describe another revision." : "Open Run details to see where the run stopped." };
}

function placeChatRunUpdate(region, runId) {
  const messages = $("chat-messages");
  const launch = runId ? [...messages.querySelectorAll(`.chat-run-event[data-run-id="${CSS.escape(runId)}"]`)].at(-1) : null;
  const next = launch ? launch.nextElementSibling : messages.firstElementChild;
  if (next !== region) messages.insertBefore(region, next);
}

function renderChatRunUpdate(run, summary) {
  const region = $("chat-run-update");
  placeChatRunUpdate(region, chat.runId);
  const key = summary ? JSON.stringify([chat.runId, summary]) : "";
  if (region.dataset.snapshot === key) return;
  region.dataset.snapshot = key;
  const focus = region.contains(document.activeElement);
  const thread = $("chat-thread");
  const following = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 64;
  region.hidden = !summary;
  region.classList.toggle("is-complete", Boolean(run?.finishedAt && run.status === "passed"));
  const action = summary?.action;
  region.replaceChildren(...(summary ? [
    h("h2", { text: summary.heading, tabindex: "-1" }),
    summary.description ? h("p", { text: summary.description }) : null,
    summary.change || summary.checks ? h("p", { class: "chat-run-facts", text: [summary.change, summary.checks].filter(Boolean).join(" ") }) : null,
    h("p", { class: "chat-run-next", text: summary.next }),
    action?.href ? h("a", { class: "btn btn-primary btn-sm", href: action.href, target: "_blank", rel: "noopener noreferrer", text: action.label }) :
      action && !action.decisionId ? chatButton(action.label, () => useRunUpdateAction(run, action),
        { class: "btn btn-primary btn-sm" }) : null,
  ].filter(Boolean) : []));
  if (focus) region.querySelector("h2")?.focus({ preventScroll: true });
  if (summary && following && region === region.parentElement.lastElementChild) region.scrollIntoView({ block: "nearest" });
}

async function useRunUpdateAction(run, action) {
  if (run.id !== chat.runId) return;
  if (action.runId) {
    if (await select(action.runId)) {
      renderChatControls();
      if (!focusDecisionCard(deploymentDecisionId(action.runId))) $("chat-run-update").scrollIntoView({ block: "nearest" });
    }
    return;
  }
  if (action.question) {
    void askChat(action.question, run.id, undefined, { runQuestion: "Deploy from this run." });
    return;
  }
  const result = state.results.get(run.id);
  if (action.draftReview) {
    openDraftReview(run.id, action.draftReview === "reopen" ? result?.publish : undefined, action.draftReview === "reopen");
    return;
  }
  const command = runCommands(run, result).find(({ label }) => label === action.command);
  if (!command?.execute) return toast("That action is no longer available.", true);
  if (chat.runAction?.busy) return;
  const draft = { runId: run.id, id: command.id, label: command.label, hint: command.hint };
  if (command.id === "preview" || command.id === "open-local-app") {
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    chat.runAction = draft;
    draft.busy = true;
    renderRunAction();
    try {
      const outcome = command.id === "preview" ? await updatePreview(run.id, "POST", tab) : await command.execute();
      if (command.id === "open-local-app" && tab && outcome?.link) tab.location.replace(outcome.link);
      if (outcome?.error) tab?.close();
      if (chat.runAction === draft) {
        if (outcome?.error || !tab || tab.closed && outcome?.link) draft.outcome = outcome;
        else chat.runAction = null;
      }
    } catch (error) {
      tab?.close();
      if (chat.runAction === draft) draft.outcome = { text: error.message, error: true };
    } finally {
      draft.busy = false;
      if (chat.runId === run.id) renderRunAction();
    }
  } else chat.runAction = draft;
  if (chat.runAction === draft) {
    renderRunAction();
    $("chat-run-action").scrollIntoView({ block: "nearest" });
  }
}

function runResult(run, result, recovery) {
  const commits = run.stages.filter((stage) => stage.commit).length;
  const latest = new Map(run.stages.flatMap((stage) => stage.attempts.at(-1)?.gates ?? []).map((gate) => [gate.command, gate]));
  if (run.verification && (["passed", "failed"].includes(result.savedEditsCheck) ||
      run.verification.head === result.handoff?.head && result.handoff?.uncommittedCount === 0)) {
    for (const gate of run.verification.checks) latest.set(gate.command, gate);
  }
  const browserCheck = run.browserCheck ?? latest.get("Chrome browser check (desktop and phone)");
  if (browserCheck) latest.set(browserCheck.command, browserCheck);
  const gates = [...latest.values()];
  const passed = gates.filter(gateOk).length;
  const publication = result.publish;
  const gitStatus = result.loading ? "Checking Git remotes…" :
    result.hasRemote === false ? "Local branch awaiting a remote." :
    publication?.pullRequestState === "merged" ? (publication.pushed ? "Pull request merged." : "Pull request merged. This run has a local update.") :
    publication?.pushed ? `Branch pushed to ${publication.label}.` :
    publication ? `Ready to push to ${publication.label}.` :
    result.publishUnavailable ?? (result.hasRemote ? "No completed branch changes to push." : "Git remote status unavailable.");
  const browserBusy = state.browserPending.has(run.id);
  return h("section", { class: "run-result", "aria-label": "Run result" },
    h("div", { class: "run-result-heading" },
      h("h2", { id: recovery ? undefined : "run-handoff", tabindex: "-1", text: "Run handoff" }),
      h("span", { class: `pill s-${run.status}`, text: completionLabel(run) }),
      h("time", { datetime: run.finishedAt, text: ago(run.finishedAt), "data-time": run.finishedAt }),
    ),
    !recovery && run.error ? h("p", { class: "run-result-error", text: run.error }) : null,
    h("p", { text: [
      gates.length ? `${passed}/${gates.length} checks passed` : "No recorded checks",
      run.cleanedUp ? "Empty worktree removed" : result.handoff?.uncommittedCount ?
        `${result.handoff.uncommittedCount} file${result.handoff.uncommittedCount === 1 ? "" : "s"} with saved edits` : `${commits} local commit${commits === 1 ? "" : "s"}`,
    ].join(" · ") }),
    result.latestRevisionId ? h("p", { text: "This is an earlier result on the same branch." }) : null,
    result.handoff?.regression ? renderRegression(run, result.handoff.regression) : null,
    run.status === "passed" && run.stages.some((stage) => stage.repairRole && stage.attempts.at(-1)?.role === stage.repairRole)
      ? h("p", { text: "The crew repaired a failed check and verified this revision." }) : null,
    !run.cleanedUp ? h("dl", { class: "run-result-facts" },
      h("dt", { text: "Branch" }), h("dd", { class: "mono", text: run.branch }),
      run.status === "passed" && !result.latestRevisionId ? [
        h("dt", { text: "Pull request" }),
        h("dd", {}, gitStatus, /^https:\/\//i.test(publication?.pullRequestUrl ?? "") ?
          [" ", h("a", { href: publication.pullRequestUrl, target: "_blank", rel: "noopener noreferrer", text: "View on GitHub" })] : null),
      ] : null,
      result.localApp?.starting || result.localApp?.url ? [
        h("dt", { text: "Local app" }), h("dd", { text: result.localApp.starting ? "Starting" : "Ready" }),
      ] : null,
    ) : null,
    result.error ? h("p", { class: "run-result-error", text: result.error }) : null,
    result.cloudRelease ? h("p", { class: "field-help", text: `Cloud Run recorded revision ${result.cloudRelease.revision} for run commit ${result.cloudRelease.head.slice(0, 12)}. It had no traffic when verified.` }) : null,
    browserBusy ? h("p", { class: "browser-run-status", role: "status", text: "Checking desktop and phone layouts…" }) : null,
    browserCheck && !browserBusy ? details(`${run.id}:browser-check`, h("span", {},
      `Browser check ${gateOk(browserCheck) ? "passed" : "failed"}`,
      browserCheck.checkedAt ? h("time", { class: "browser-checked-at", datetime: browserCheck.checkedAt, "data-time": browserCheck.checkedAt, text: ago(browserCheck.checkedAt) }) : null,
    ), h("pre", { class: "browser-check-output", text: browserCheck.outputTail }), !gateOk(browserCheck)) : null,
    renderHandoff(run, result, latest),
    [...state.runs.values()].filter((child) => child.followUp?.runId === run.id).map((child) =>
      h("a", { class: "feedback-child", href: `#run/${child.id}`, text: `Revision · ${firstLine(child.request)}` })),
    (result.deploymentIds ?? []).map((id) => state.runs.get(id)).filter((deployment) => deployment?.deployment && !deployment.archivedAt)
      .map((deployment) => h("a", { href: `#run/${deployment.id}`, text: `View ${DEPLOYMENT_PROVIDERS[deployment.deployment.provider]} deployment` })),

  );
}

function renderRegression(run, { status, reason, evidence, patch, patchTruncated }) {
  const observation = (label, sha, result) => result ? h("li", {},
    h("strong", { text: label }), " ", h("code", { title: sha, text: sha.slice(0, 12) }),
    h("div", { text: `${result.detail} (exit ${result.exitCode})` }),
  ) : null;
  return h("section", { class: "block", "aria-label": "Bug verification" },
    h("h3", { text: `Bug verification · ${status}` }),
    reason ? h("p", { text: reason }) : null,
    evidence?.actual ? h("p", {}, h("strong", { text: "Reported behavior" }), ` · ${evidence.actual}`) : null,
    evidence?.expected ? h("p", {}, h("strong", { text: evidence.approved ? "Approved behavior" : "Proposed behavior" }), ` · ${evidence.expected}`) : null,
    evidence?.testName && evidence.testFile ? h("p", {}, "Regression test ", h("code", { text: evidence.testName }), " in ", h("code", { text: evidence.testFile })) : null,
    evidence?.before || evidence?.after ? h("ul", { class: "handoff-list" },
      observation("Before", evidence.baseSha, evidence.before), observation("After", evidence.head, evidence.after),
    ) : null,
    patch ? details(`${run.id}:bug-diff`, "Fix diff", h("div", {},
      renderDiff(patch), patchTruncated ? h("p", { text: "Showing the beginning of the diff. The full diff is in Git." }) : null,
    )) : null,
  );
}

function recoveryHandoff(run, result, checking) {
  if (result.budgetPause) {
    const pause = result.budgetPause;
    const stage = pause.stage === "docs" ? "documentation" : pause.stage;
    return h("section", { class: "run-recovery", "aria-label": "Next step" },
      h("h2", { id: "run-handoff", tabindex: "-1", text: "Run budget reached" }),
      h("p", { text: `Shipyard stopped before ${stage} after using an estimated ${dollars(pause.spent)} of the ${dollars(pause.current)} limit.` }),
      h("p", { text: "Say Increase budget in chat to review a new limit." }),
    );
  }
  const stage = run.stages.findLast((entry) => entry.status === "failed" || entry.status === "stopped");
  const attempt = stage?.attempts.findLast((entry) => !entry.interrupted);
  const ready = result.savedEditsCheck === "passed";
  const canFix = result.canFixRevision && !ready;
  const autoRepair = stage?.autoRepair;
  const recentFailure = result.savedEditsCheck === "failed" ? run.verification?.checks.find((gate) => !gateOk(gate)) : undefined;
  const failure = recentFailure ?? attempt?.gates.find((gate) => !gateOk(gate)) ??
    (autoRepair && stage.attempts.find((entry) => entry.attempt === autoRepair.afterAttempt)?.gates.find((gate) => !gateOk(gate)));
  const hint = failure?.outputTail?.split("\n").map((line) => line.trim())
    .find((line) => /^(?:AssertionError|(?:[\w]+)?Error:|fatal:)/i.test(line));
  const source = state.runs.get(run.followUp?.runId);
  const saved = result.handoff?.uncommittedCount;
  const olderDashboard = !state.acceptsAttachments && saved && failure && !result.recheckStage;
  return h("section", { class: `run-recovery${ready ? " is-ready" : ""}`, "aria-label": "Next step" },
    h("h2", { id: "run-handoff", tabindex: "-1", text: checking ? "Checking your saved edits" : ready ? "Checks passed. Ready to continue." :
      result.canPrepareBranch ? "This revision needs a Git change" : autoRepair ? "The repair couldn’t finish" : recentFailure ? "A check still needs a fix" : "The run paused after a failure" }),
    !checking && !ready && (failure || run.error) ? h("p", { class: "recovery-reason" },
      failure ? h("strong", { text: `${failure.command} ${failure.timedOut ? "timed out" : "failed"}` }) : null,
      run.error || hint ? h("span", { text: run.error || hint.slice(0, 280) }) : null) : null,
    h("p", { role: "status", text: checking ? "Shipyard is running the checks. No action is needed right now." :
      result.loading ? "Loading your available actions…" : ready ? `You can review the edits or continue. Continuing commits them after a final check and resumes any remaining stages with ${providerLabel(run.provider)}.` :
      result.canPrepareBranch ? "Review a new branch name and combine the existing commits. Shipyard will verify the project before creating the branch." :
      result.canResumeProjectCheck ? "The test sandbox stopped the run. Resume from the saved worktree to retry with the available sandbox." :
      olderDashboard ? "This tab is connected to an older Shipyard server. Open the current dashboard to recover this revision." :
      autoRepair && canFix ? `Shipyard tried to repair ${autoRepair.command}. Retry to have ${providerLabel(run.provider)} pick up this revision and rerun its checks.` :
      canFix ? `Ask the crew to fix the failure and rerun the checks using ${providerLabel(run.provider)}. It will pick up this revision and its saved edits.` :
      recentFailure ? "Your edits are still saved. Open the check details to see what failed, then check again after it’s fixed." :
      result.recheckStage ? "Say Check saved edits in chat to rerun the project checks." :
      result.canGiveFeedback ? "Give the crew updated instructions to continue on the same branch." :
      saved ? "Your edits are saved locally. Open the check details or copy the worktree path to inspect them." :
      source ? "Open the source run to review the last completed version." : "Review the failure before trying again." }),
    failure?.outputTail ? details(`${run.id}:recovery-output`, ready ? "View previous failure" : "View failed check output", h("pre", { class: "browser-check-output", text: failure.outputTail }), Boolean(recentFailure)) : null,
  );
}

function reportSections(text) {
  const sections = new Map();
  let current = "";
  for (const line of text.split("\n")) {
    const label = line.match(/^#{1,6}\s+(Delivered|Verified|Remaining)\s*:?[ \t]*$/i)?.[1]?.toLowerCase();
    if (label) current = label;
    else if (current) sections.set(current, (sections.get(current) ?? "") + line + "\n");
  }
  return sections;
}

function renderHandoff(run, result, checks) {
  const info = result.handoff;
  const reports = run.stages.filter((stage) => stage.name !== "orchestrate" && stage.name !== "plan")
    .flatMap((stage) => {
      const summary = stage.attempts.findLast((attempt) => !attempt.rechecked)?.summary?.trim();
      return summary ? [{ stage, summary, sections: reportSections(summary) }] : [];
    });
  const missing = (info?.configuredChecks ?? []).filter((command) => !checks.has(command) || checks.get(command).expectFailure);
  const unfinished = revisionAssignments(run).filter(({ role }) => !run.stages.some((stage) => stage.role === role));
  const blocked = [...checks.values()].filter((gate) => !gateOk(gate));
  const needsProjectChecks = [...missing, ...blocked.map((gate) => gate.command)].some((command) =>
    info?.configuredChecks?.includes(command) && command !== "Chrome browser check (desktop and phone)");
  const pending = [
    ...(run.status === "stopped" && !unfinished.length ? ["The run stopped before completion."] : []),
    ...unfinished.map(({ role }) => `${roleLabel(role)} is waiting for an earlier stage`),
    ...missing.map((command) => `${command} · awaiting verification`),
  ];
  const agentPending = reports.flatMap(({ stage, sections }) => {
    if (stage.attempts.at(-1)?.rechecked) return [];
    const text = sections.get("remaining")?.trim();
    return text && !/^(?:[-*]\s+)?(?:none|nothing pending|no outstanding items)\.?$/i.test(text) ? [{ stage, text }] : [];
  });
  const referenceGaps = (run.references ?? []).filter((check) => check.status !== "read");
  const inspections = run.stages.flatMap((stage) => stage.attempts.flatMap((attempt) => (attempt.browserInspections ?? []).map((label) => `${roleLabel(stage.role)} · ${label}`)));
  return h("div", { class: "handoff-grid" },
    h("section", { class: "handoff-panel" },
      h("h3", { text: "What changed" }),
      info?.head ? h("p", { class: "muted", text: `${info.fileCount ?? "—"} committed files · ${info.head.slice(0, 8)}` }) : null,
      info?.uncommittedFiles?.length ? details(`${run.id}:saved-edits`, `Saved worktree edits (${info.uncommittedCount})`,
        h("ul", { class: "handoff-files mono" }, info.uncommittedFiles.map((path) => h("li", { text: path })))) : null,
      reports.length ? reports.map(({ stage, summary, sections }) => {
        const excerpt = (sections.get("delivered") ?? summary).split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
        const intro = excerpt?.replace(/^[-*]\s+/, "").replace(/\*\*|`/g, "");
        return details(`${run.id}:report:${stage.name}`, h("span", { class: "handoff-report-line" },
          h("strong", { text: roleLabel(stage.repairRole ?? stage.role) }),
          intro ? h("span", { class: "muted", text: intro.length > 160 ? `${intro.slice(0, 157)}…` : intro }) : null,
        ), h("div", { class: "handoff-report md" }, md(summary)));
      }) : h("p", { class: "muted", text: "No specialist report was recorded." }),
      info?.files?.length ? details(`${run.id}:committed-files`, info.files.length < info.fileCount ? `Changed files · first ${info.files.length}` : "Changed files",
        h("ul", { class: "handoff-files mono" }, info.files.map(({ status, path }) => h("li", { text: `${status}  ${path}` })))) : null,
    ),
    h("section", { class: "handoff-panel" },
      h("h3", { text: "Project checks" }),
      checks.size ? h("ul", {}, [...checks.values()].map((gate) => h("li", {},
        h("span", { class: `handoff-check ${gateOk(gate) ? "is-pass" : "is-fail"}`, text: gateOk(gate) ? gate.expectFailure ? "Reproduced" : "Passed" : "Failed" }),
        gate.command,
        !gateOk(gate) && gate.outputTail ? details(`${run.id}:check:${gate.command}`, "Check output", h("pre", { class: "browser-check-output", text: gate.outputTail })) : null,
      ))) : h("p", { class: "muted", text: "No automated checks were recorded." }),
      inspections.length ? details(`${run.id}:browser-inspections`, "Agent browser inspections", h("ul", {}, inspections.map((label) => h("li", { text: label })))) : null,
    ),
    h("section", { class: "handoff-panel" },
      h("h3", { text: "Pending" }),
      pending.length ? h("ul", {}, pending.map((item) => h("li", { text: item }))) : null,
      referenceGaps.map((check) => h("div", { class: "handoff-report reference-warning" },
        h("strong", { text: `${({ partial: "Incomplete reference", blocked: "Reference blocked", "permission-required": "Reference needs approval" })[check.status]} · ${check.url ? check.url.replace(/^https:\/\/(?:www\.)?/, "") : check.label}` }),
        h("p", { text: check.detail }),
        check.coverage?.length ? h("p", { text: `Read: ${check.coverage.join(", ")}` }) : null,
        check.missing?.length ? h("ul", {}, check.missing.map((line) => h("li", { text: line }))) : null,
        check.url && run.referenceUrls?.includes(check.url) ? h("button", { class: "btn btn-sm", type: "button",
          text: state.referenceDrafts.has(referenceKey(run.id, check.url)) ? "Review reference" : "Retry in browser",
          onclick: () => openReferenceHandoff(run.id, check.url) }) : null,
      )),
      agentPending.length && run.status === "passed" && !needsProjectChecks ? details(`${run.id}:previous-handoff-notes`, "Earlier agent notes",
        agentPending.map(({ stage, text }) => h("div", { class: "handoff-report md" }, h("strong", { text: `From ${roleLabel(stage.role)}` }), md(text)))) :
        agentPending.map(({ stage, text }) => h("div", { class: "handoff-report md" }, h("strong", { text: `From ${roleLabel(stage.role)}` }), md(text))),
      !pending.length && !agentPending.length && !referenceGaps.length ? h("p", { class: "muted", text: "No additional items." }) : null,
    ),
  );
}

async function checkRunBrowser(runId) {
  if (state.browserPending.has(runId)) return;
  state.browserPending.add(runId);
  schedule("detail");
  try {
    const { check } = await api(`/api/runs/${runId}/browser-check`, { method: "POST" });
    const run = state.runs.get(runId);
    if (run) run.browserCheck = check;
    state.open.set(`${runId}:browser-check`, true);
    return gateOk(check) ? { text: "Browser check passed on desktop and phone." } :
      { text: "Browser check failed. Open Run details for the report.", error: true };
  } catch (error) {
    return { text: error.message, error: true };
  } finally {
    state.browserPending.delete(runId);
    schedule("detail");
  }
}

async function verifyRunResult(runId, regression = false) {
  if (state.verificationPending.has(runId)) return;
  state.verificationPending.add(runId);
  schedule("detail");
  try {
    const { verification } = await api(`/api/runs/${runId}/verify`, { method: "POST" });
    const run = state.runs.get(runId);
    if (run) run.verification = verification;
    state.results.delete(runId);
    const ok = verification.checks.every(gateOk);
    const text = ok ? regression ? "Regression recheck complete. See Run details." : "Project checks passed." : "A project check failed. See Run details.";
    if (chat.runAction?.runId !== runId) toast(text, !ok);
    return { text, error: !ok };
  } catch (error) {
    if (chat.runAction?.runId !== runId) toast(error.message, true);
    return { text: error.message, error: true };
  } finally {
    state.verificationPending.delete(runId);
    schedule("detail");
  }
}

function openRunPreview(runId) {
  const tab = window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  void updatePreview(runId, "POST", tab);
}

async function updatePreview(runId, method, tab) {
  if (state.previewPending.has(runId)) return;
  state.previewPending.add(runId);
  schedule("detail");
  try {
    const result = await api(`/api/runs/${runId}/preview`, { method });
    const info = state.results.get(runId);
    if (info) info.previewUrl = result.url;
    if (method === "POST") {
      if (tab && !tab.closed) tab.location.replace(result.url);
      return { text: "The preview is ready.", link: result.url, linkLabel: "Open local preview" };
    }
    return { text: "Preview stopped." };
  } catch (error) {
    tab?.close();
    if (tab) toast(error.message, true);
    return { text: error.message, error: true };
  } finally {
    state.previewPending.delete(runId);
    schedule("detail");
  }
}

async function updateLocalApp(runId, method) {
  if (state.localAppPending.has(runId)) return;
  state.localAppPending.add(runId);
  schedule("detail");
  try {
    const result = await api(`/api/runs/${runId}/local-app`, { method });
    state.results.delete(runId);
    if (method === "POST") return { text: "The local app is ready.", link: result.url, linkLabel: "Open local app" };
    return { text: "Local app stopped." };
  } catch (error) {
    state.results.delete(runId);
    return { text: error.message, error: true };
  } finally {
    state.localAppPending.delete(runId);
    schedule("detail");
  }
}

function revisionAssignments(run) {
  const stage = run.stages.find((stage) => stage.name === "orchestrate");
  return stage?.status === "passed" ? stage.attempts.at(-1)?.output?.assignments ?? [] : [];
}

function renderPipeline(run, assignments) {
  const nodes = [];
  const done = new Map(run.stages.map((s) => [s.name, s]));
  // Runs from before crews existed ran e2e + repair.
  const crew = new Set(run.crew ?? ["e2e", "repair"]);
  const running = run.status === "running";
  const show = (name) => {
    if (done.has(name) || name === "implement") return true;
    if (name === "e2e") return crew.has("e2e") && targetHasE2E(run);
    if (name === "repair") return running && crew.has("e2e") && crew.has("repair") && targetHasE2E(run);
    if (name === "revise") return running && crew.has("review");
    if (name === "security-recheck") return running && run.parallelReviews && crew.has("security");
    if (name === "harden") return running && crew.has("security");
    return crew.has(name);
  };
  const orchestrated = run.followUp?.orchestrated;
  const names = orchestrated ? ["orchestrate", ...assignments.map(({ role }) => role)] : executionOrder(PIPELINE_ORDER.filter(show), reviewsOverlap(run));
  const conditional = { repair: "only if E2E fails", revise: "only if review asks for changes", "security-recheck": "only if review fixes change the code", harden: "only if the audit requires fixes" };

  names.forEach((name, i) => {
    const stage = done.get(name);
    const status = stage ? stageStatus(run, stage) : "planned";
    const role = roleLabel(stage?.role ?? (orchestrated && name !== "orchestrate" ? name : stageRole(name, run)));
    const sub = stage
      ? `${role} · ${stage.attempts.length} attempt${stage.attempts.length === 1 ? "" : "s"} · ${stageUsage(run, stage)}`
      : conditional[name] ?? (running ? `${role} · waiting to start` : `${role} · didn't run`);
    if (i > 0) nodes.push(name === "security" && names[i - 1] === "review" && reviewsOverlap(run) ?
      h("span", { class: "chat-parallel-label", text: "parallel" }) : h("span", { class: "stage-link", "aria-hidden": "true" }));
    nodes.push(
      h(
        "div",
        { class: `stage-node${stage ? "" : " planned"}` },
        h("span", { class: "stage-name" }, h("span", { class: `stage-icon s-${status}`, "aria-hidden": "true", text: stageGlyph(status) }), orchestrated ? role : name),
        h("span", { class: "stage-sub", text: stage ? `${STATUS_LABEL[status] ?? status} · ${sub}` : sub }),
      ),
    );
  });
  return h("section", { class: "pipeline", "aria-label": "Pipeline" }, nodes);
}

const stageGlyph = (status) => ({ passed: "✓", failed: "✕", running: "…", waiting: "!", stopped: "■", changes: "↻" })[status] ?? "";

function renderLane(run, stage, events) {
  const status = stageStatus(run, stage);
  const time = stage.attempts.reduce((sum, a) => sum + a.durationMs, 0);

  // Group this stage's events by attempt. Inbox events carry no attempt number: they belong to the current one.
  const byAttempt = new Map();
  let current = 1;
  for (const e of events ?? []) {
    if (e.stage !== stage.name) continue;
    if (typeof e.attempt === "number") current = e.attempt;
    const n = typeof e.attempt === "number" ? e.attempt : current;
    if (!byAttempt.has(n)) byAttempt.set(n, []);
    byAttempt.get(n).push(e);
  }
  const numbers = [...new Set([...stage.attempts.map((attempt) => attempt.attempt), ...byAttempt.keys()])].sort((a, b) => b - a);
  if (!numbers.length) numbers.push(1);
  const attempts = numbers.map((n, index) => renderAttempt(run, stage, n, byAttempt.get(n) ?? [], index === 0, status));

  return h(
    "article",
    { class: `lane${status === "waiting" ? " waiting" : ""}` },
    h(
      "header",
      { class: "lane-head" },
      avatar(stage.repairRole ?? stage.role),
      h("div", { class: "lane-title" }, h("strong", { text: roleLabel(stage.repairRole ?? stage.role) }), h("span", { text: `${stage.name} stage` })),
      h(
        "div",
        { class: "lane-stats" },
        h("span", { text: `${stageUsage(run, stage)} · ${secs(time)}` }),
        h("span", { class: `pill s-${status}`, text: STATUS_LABEL[status] ?? status }),
      ),
    ),
    attempts,
  );
}

function attemptStatus(record, isLatest, stageStatus) {
  if (isLatest && stageStatus === "waiting") return "waiting";
  if (!record) return isLatest && stageStatus === "running" ? "running" : "interrupted";
  if (record.interrupted) return record.interrupted;
  if (record.review?.action === "stop") return "stopped";
  if (record.review?.action === "feedback") return "changes";
  if (record.passed) return "passed";
  const verdict = record.output?.verdict;
  return verdict === "request_changes" || verdict === "fix_required" ? "changes" : "failed";
}

function renderAttempt(run, stage, n, events, isLatest, stageStatus) {
  const record = stage.attempts.find((attempt) => attempt.attempt === n);
  const prev = stage.attempts.find((attempt) => attempt.attempt === n - 1);
  const reason = !prev ? "" : prev.interrupted === "redirected" ? "After your update" : prev.interrupted ? "After an interruption" : prev.review?.action === "feedback" ? "After your feedback" : prev.passed ? "" : prev.noChanges ? "After no changes" : "After a failed gate";
  const key = `${run.id}:${stage.name}:${n}`;
  const start = events.find((event) => event.type === "attempt_start");
  const status = attemptStatus(record, isLatest, stageStatus);
  const title = h("span", { class: "attempt-line" },
    h("strong", { text: `Attempt ${n}` }),
    h("span", { class: "attempt-meta", text: providerLabel(record?.provider ?? start?.provider ?? run.provider) }),
    record?.durationMs > 0 ? h("span", { class: "attempt-meta", text: secs(record.durationMs) }) : null,
    h("span", { class: `attempt-outcome pill s-${status}`, text: STATUS_LABEL[status] }),
  );

  const part = (name, label, content, open = false) => details(`${key}:${name}`, label, content, open, "attempt-part");
  return details(`${key}:attempt`, title, () => h(
    "div",
    { class: "attempt-body" },
    reason ? h("p", { class: "attempt-meta", text: reason }) : null,
    record?.summary ? part("summary", "Summary", () => md(record.summary, "prose"), true) : null,
    start?.prompt ? part("prompt", "Prompt", () => h("pre", { class: "prose", text: start.prompt })) : null,
    part("activity", "Activity", () => attemptActivity(record, events, key)),
  ), false, "attempt");
}

function attemptActivity(record, events, key) {
  const rows = [];
  // A checkpoint is reached after the gates run, so its waiting row follows the gate rows.
  const isCheckpointWait = (event) => event.type === "waiting" && event.kind === "checkpoint";
  for (const event of events) {
    if (isCheckpointWait(event)) continue;
    const entry = eventRow(event);
    if (entry) rows.push(entry);
  }
  if (record) {
    if (record.interrupted) {
      const description = { stopped: "You stopped this attempt", redirected: "The attempt was redirected", interrupted: "Shipyard exited during this attempt" };
      rows.push(row("interrupted", description[record.interrupted], "warn"));
    } else if (!record.agentOk && record.agentError) {
      rows.push(row("stopped", record.agentError, "bad"));
    }
    if (record.revertedFiles?.length) rows.push(row("reverted", `out-of-lane edits: ${record.revertedFiles.join(", ")}`, "warn"));
    if (record.noChanges) rows.push(row("gate", "No changes in the worktree, so the gates didn't run", "bad"));
    for (const gate of record.gates) {
      const label = gateLabel(gate);
      if (gateOk(gate) && !gate.expectFailure) rows.push(row("gate", label, "ok", true));
      else rows.push(h("li", { class: "row bad" }, h("span", { class: "row-tag", text: "gate" }), h("div", { class: "row-body mono" }, details(`${key}:gate:${gate.command}`, label, h("pre", { class: "prose mono", text: gate.outputTail }), false, ""))));
    }
  }
  for (const event of events.filter(isCheckpointWait)) rows.push(eventRow(event));
  for (const event of events.filter((entry) => entry.type === "checkpoint")) rows.push(checkpointRow(event));
  return rows.length ? h("ul", { class: "feed" }, rows) : h("p", { class: "attempt-meta", text: "No activity recorded yet." });
}

function row(tag, body, cls = "", mono = false) {
  return h("li", { class: `row ${cls}` }, h("span", { class: "row-tag", text: tag }), h("span", { class: `row-body${mono ? " mono" : ""}`, text: body }));
}

function eventRow(e) {
  switch (e.type) {
    case "tool":
      return row(e.tool, e.detail, "", true);
    case "text":
      return h("li", { class: "row text" }, h("span", { class: "row-tag", text: "says" }), md(e.text, "row-body"));
    case "denied":
      return row("blocked", `${e.tool}: ${e.reason}`, "bad");
    case "waiting": {
      const pending = state.inbox.has(e.item);
      const what = e.kind === "checkpoint" ? "your checkpoint review" : e.kind === "question" ? "your answer to a question" :
        e.kind === "reference" ? "your input on a reference" : "your permission";
      return h(
        "li",
        { class: "row warn" },
        h("span", { class: "row-tag", text: "waiting" }),
        h("span", { class: "row-body" }, `for ${what}`, pending ? [" · ", h("button", { type: "button", class: "link", onclick: () => focusItem(e.item) }, "answer now")] : null),
      );
    }
    case "answered":
      if (e.kind === "checkpoint") return null; // shown by the pipeline's own checkpoint event
      if (e.kind === "question") return row("you", `answered: ${Object.values(e.answer?.answers ?? {}).join("; ")}`, "you");
      if (e.kind === "reference") return row("you", { approve: "approved reference access", share: "shared reviewed reference notes", skip: "skipped the reference" }[e.answer?.action], "you");
      return row("you", e.answer?.decision === "deny" ? `denied${e.answer?.message ? `: ${e.answer.message}` : ""}` : e.answer?.decision === "allow-run" ? "allowed for this run" : "allowed once", "you");
    case "auto-allowed":
      return row("allowed", `${e.tool} (you allowed it for this run)`, "you");
    default:
      return null;
  }
}

function checkpointRow(e) {
  const text =
    e.action === "continue" ? "approved" : e.action === "stop" ? "stopped the run" : `sent feedback: ${e.message ?? ""}`;
  return row("you", `${text}${e.waitMs ? ` · after ${secs(e.waitMs)}` : ""}`, "you");
}

// ── Inbox column ─────────────────────────────────────────

function renderInbox() {
  const list = $("inbox-list");
  const items = [...state.inbox.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const outcomes = unreadResults();
  const references = activeReferenceAlerts();
  const deployments = pendingDeployments();
  const oldOutcomes = list.querySelector(".inbox-results");
  const oldReferences = list.querySelector(".inbox-references");
  const oldDeployments = list.querySelector(".inbox-deployments");

  for (const el of [...list.children]) {
    if (el === oldOutcomes || el === oldReferences || el === oldDeployments) continue;
    if (!el.dataset.id || !state.inbox.has(el.dataset.id)) el.remove();
  }
  if (!items.length && !outcomes.length && !references.length && !deployments.length) {
    list.replaceChildren(h("p", { class: "inbox-empty", text: "You're caught up. Questions and results will appear here." }));
    return;
  }
  if (deployments.length) {
    const approvals = h("section", { class: "inbox-deployments", "aria-label": "Deployment approvals" },
      h("h3", { class: "section-label", text: "Deployment approvals" }),
      deployments.map((run) => h("article", { class: "card completion-card" }, h("div", { class: "card-body" },
        h("strong", { text: run.request }), h("p", { text: run.deployment.review?.site ?? run.deployment.workflowReview?.environment }),
        chatButton("Review deployment in chat", () => focusDeploymentApproval(run.id)),
      ))),
    );
    if (oldDeployments) oldDeployments.replaceWith(approvals);
    else list.prepend(approvals);
  } else oldDeployments?.remove();
  if (references.length) {
    const alerts = h("section", { class: "inbox-references", "aria-label": "Reference access" },
      h("h3", { class: "section-label", text: "Reference access" }),
      references.map(({ run, check }) => h("article", { class: "card completion-card" }, h("div", { class: "card-body" },
        h("strong", { text: `${run.target} · ${check.label ?? new URL(check.url).hostname}` }),
        h("p", { class: "reference-warning", text: check.detail }),
        h("button", { type: "button", class: "btn btn-sm", onclick: () => select(run.id) }, "View run"),
      ))),
    );
    if (oldReferences) oldReferences.replaceWith(alerts);
    else list.insertBefore(alerts, oldOutcomes);
  } else oldReferences?.remove();
  for (const item of items) {
    const existing = list.querySelector(`[data-id="${item.id}"]`);
    if (existing) {
      existing.querySelector(".card-time").textContent = ago(item.createdAt);
      existing.querySelector(".inbox-decision-run").textContent = decisionRunLabel(item);
      continue;
    }
    list.insertBefore(inboxDecisionRow(item), oldOutcomes);
  }
  if (!outcomes.length) {
    oldOutcomes?.remove();
  } else {
    const resultList = h("section", { class: "inbox-results", "aria-label": "Run results" },
      h("h3", { class: "section-label", text: "Run results" }),
      outcomes.map(completionCard),
    );
    if (oldOutcomes) oldOutcomes.replaceWith(resultList);
    else list.append(resultList);
  }
}

function completionCard(run) {
  return h("article", { class: "card completion-card" },
    h("header", { class: "card-head" },
      h("span", { class: `pill s-${run.status}`, text: completionLabel(run) }),
      h("time", { class: "card-time", datetime: run.finishedAt, "data-time": run.finishedAt, text: ago(run.finishedAt) }),
    ),
    h("div", { class: "card-body" },
      h("div", { class: "completion-title", title: run.request, text: `${run.target} · ${firstLine(run.request)}` }),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: () => viewResult(run) }, "View result"),
        h("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: () => acknowledgeResult(run) }, "Dismiss"),
      ),
    ),
  );
}

async function acknowledgeResult(run) {
  try {
    const { run: saved } = await api(`/api/runs/${run.id}`, { method: "PATCH", body: { acknowledgeCompletion: run.finishedAt } });
    state.runs.set(saved.id, saved);
    schedule();
  } catch (error) {
    toast(error.message, true);
  }
}

function decisionKindLabel(item) {
  return item.needsApproval ? "Reference approval" :
    { checkpoint: item.checkpoint?.canContinue ? "Approval" : "Checkpoint", question: "Question",
      permission: "Permission", reference: "Browser help" }[item.kind];
}

function decisionRunLabel(item) {
  const run = state.runs.get(item.runId);
  return run ? `${run.target} · ${firstLine(run.request)}` : item.runId;
}

function inboxDecisionRow(item) {
  return h("article", { class: "card inbox-decision-row", "data-id": item.id },
    h("header", { class: "card-head" },
      h("span", { class: `kind kind-${item.kind}`, text: decisionKindLabel(item) }),
      h("span", { class: "card-from", text: roleLabel(item.role) }),
      h("time", { class: "card-time", datetime: item.createdAt, text: ago(item.createdAt) })),
    h("div", { class: "card-body" },
      h("span", { class: "inbox-decision-run", text: decisionRunLabel(item) }),
      chatButton("Review in chat", () => focusItem(item.id))),
  );
}

function inlineDecisionCard(item) {
  const run = state.runs.get(item.runId);
  const kindLabel = decisionKindLabel(item);
  const error = h("p", { class: "card-error", role: "alert", hidden: true });
  const el = h(
    "article",
    { class: "card chat-decision-card", "data-id": item.id, tabindex: "-1", "aria-label": kindLabel },
    h(
      "header",
      { class: "card-head" },
      h("span", { class: `kind kind-${item.kind}`, text: kindLabel }),
      avatar(item.role, true),
      h("span", { class: "card-from", text: roleLabel(item.role) }),
    ),
  );

  const send = async (answer, files) => {
    if (el.classList.contains("sending")) return;
    const conversationId = chat.id;
    const restoreFocus = el.contains(document.activeElement);
    el.classList.add("sending");
    el.setAttribute("aria-busy", "true");
    error.hidden = true;
    try {
      const attachments = files ? await readAttachments(files) : undefined;
      await api(`/api/inbox/${item.id}`, { method: "POST", body: { ...answer, attachments } });
      state.inbox.delete(item.id);
      if (conversationId === chat.id && chat.runId === item.runId) {
        appendChat({ role: "assistant", runId: item.runId, content: inlineDecisionReceipt(answer) });
        if (restoreFocus && (el.contains(document.activeElement) || document.activeElement === document.body)) {
          $("chat-input").focus({ preventScroll: true });
        }
      }
      schedule();
    } catch (err) {
      el.classList.remove("sending");
      el.removeAttribute("aria-busy");
      error.textContent = err.message;
      error.hidden = false;
    }
  };

  const body = item.kind === "checkpoint" ? checkpointBody(item, send) : item.kind === "question" ? questionBody(item, send)
    : item.kind === "reference" ? h("div", { class: "card-body" },
      h("p", { class: "card-title", text: item.url.replace(/^https:\/\/(?:www\.)?/, "") }),
      h("p", { text: item.detail }),
      h("div", { class: "actions" },
        item.needsApproval
          ? h("button", { type: "button", class: "btn btn-primary btn-sm", text: "Approve reference", onclick: () => send({ kind: "reference", action: "approve" }) })
          : h("button", { type: "button", class: "btn btn-primary btn-sm reference-handoff-card-action", text: referenceAction(run, item.url), onclick: () => openReferenceHandoff(item.runId, item.url, item.id) }),
        h("button", { type: "button", class: "btn btn-ghost btn-sm", text: "Skip reference", onclick: () => send({ kind: "reference", action: "skip" }) }),
      ),
    ) : permissionBody(item, send);
  body.append(error);
  el.append(body);
  return el;
}

function inlineDecisionReceipt(answer) {
  if (answer.kind === "question") return "Answer sent to the agent.";
  if (answer.kind === "checkpoint") return ({ continue: "Checkpoint confirmed.", feedback: "Feedback sent to the crew.", stop: "Stop requested." })[answer.action];
  if (answer.kind === "permission") return ({ allow: "Permission granted once.", "allow-run": "Permission granted for this run.", deny: "Permission denied." })[answer.decision];
  return answer.action === "approve" ? "Reference approved." : "Reference skipped.";
}

const deploymentApprovalStates = new WeakMap();
const deploymentDecisionId = (runId) => `deployment:${runId}`;

function renderInlineRunDecisions() {
  const region = $("chat-decisions");
  if (!region) return;
  const thread = $("chat-thread");
  const following = thread && thread.scrollHeight - thread.scrollTop - thread.clientHeight < 64;
  const items = chat.runId ? inboxFor(chat.runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : [];
  const wanted = new Set(items.map(({ id }) => id));
  const run = state.runs.get(chat.runId);
  const deployment = run?.deployment;
  const review = deployment?.phase === "approval" ? deployment.review ?? deployment.workflowReview : null;
  const deploymentId = review ? deploymentDecisionId(run.id) : null;
  if (deploymentId) wanted.add(deploymentId);
  const existing = new Map([...region.children].map((child) => [child.dataset.id, child]));
  for (const child of [...region.children]) {
    if (!wanted.has(child.dataset.id)) child.remove();
  }
  let firstNew;
  for (const item of items) {
    const element = existing.get(item.id);
    if (!element) {
      const decision = inlineDecisionCard(item);
      region.append(decision);
      firstNew ??= decision;
    } else if (item.kind === "reference" && !item.needsApproval) {
      element.querySelector(".reference-handoff-card-action").textContent = referenceAction(state.runs.get(item.runId), item.url);
    }
  }
  if (deploymentId) {
    const busy = deploymentPending.has(run.id) || state.active.has(run.id);
    const element = existing.get(deploymentId);
    const snapshot = JSON.stringify([review, deployment.provider, deployment.dispatchStarted, busy]);
    if (!element || deploymentApprovalStates.get(element) !== snapshot) {
      const approval = deploymentApprovalCard(run, review, busy);
      deploymentApprovalStates.set(approval, snapshot);
      if (element) {
        const focused = element.contains(document.activeElement);
        element.replaceWith(approval);
        if (focused) approval.focus({ preventScroll: true });
      } else {
        region.append(approval);
        firstNew ??= approval;
      }
    }
  }
  region.hidden = wanted.size === 0;
  if (following) firstNew?.scrollIntoView({ block: "nearest" });
}

function focusDecisionCard(id) {
  renderInlineRunDecisions();
  const item = $("chat-decisions")?.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!item || !item.getClientRects().length) return false;
  closeInboxDrawer();
  item.focus({ preventScroll: true });
  item.scrollIntoView({ block: "nearest" });
  return true;
}

function focusInlineRunDecision(id) {
  return chat.runId && state.inbox.get(id)?.runId === chat.runId ? focusDecisionCard(id) : false;
}

async function focusDeploymentApproval(runId) {
  if (chat.runId === runId || await select(runId)) focusDecisionCard(deploymentDecisionId(runId));
}

/** Break a plan at its own headings after Markdown has been parsed into safe DOM nodes. */
function checkpointSummary(text, key) {
  const rendered = md(text, "summary");
  const overview = { title: "Overview", blocks: [] };
  const sections = [overview];
  let section = overview;
  for (const block of rendered.children) {
    if (block.classList.contains("md-h")) {
      section = { title: block.textContent, blocks: [] };
      sections.push(section);
    } else {
      section.blocks.push(block);
    }
  }
  if (sections.length > 1 && !overview.blocks.length) sections.shift();

  if (sections.length === 1) {
    const short = text.length <= 300 && rendered.querySelectorAll("li, br").length < 5;
    return details(`${key}:summary`, "Summary", h("div", { class: "checkpoint-section-body" }, rendered), short, "checkpoint-section");
  }

  const panels = [];
  const rows = sections.map(({ title, blocks }, index) => {
    if (!blocks.length) return h("div", { class: "checkpoint-section-heading", text: title });
    const panel = details(
      `${key}:summary:${index}`,
      title,
      h("div", { class: "checkpoint-section-body md summary" }, blocks),
      false,
      "checkpoint-section",
    );
    panels.push(panel);
    return panel;
  });

  const all = panels.length > 1 ? h("button", { type: "button", class: "link" }) : null;
  if (all) {
    const update = () => { all.textContent = panels.every((panel) => panel.open) ? "Collapse all" : "Expand all"; };
    update();
    all.addEventListener("click", () => {
      const open = panels.some((panel) => !panel.open);
      for (const panel of panels) panel.open = open;
      update();
    });
    for (const panel of panels) panel.addEventListener("toggle", update);
  }
  return h("div", { class: "checkpoint-summary" }, all, rows);
}

function checkpointAccessBlocked(item) {
  const checkpoint = item.checkpoint;
  return checkpoint?.noChanges && !checkpoint.canContinue &&
    /\bread[- ]only (?:sandbox|workspace|worktree|access)|\b(?:sandbox|execution) policy (?:blocked|denied)|\bworktree (?:write access|is read[- ]only)/i.test(checkpoint.summary ?? "");
}

function checkpointProviderSwitch(item) {
  if (!state.active.has(item.runId)) return null;
  const current = item.checkpoint?.provider ?? state.runs.get(item.runId)?.provider ?? "claude";
  const alternative = state.chatProviders?.find((provider) => provider !== current);
  return alternative ? chatButton(`Switch to ${providerLabel(alternative)}`,
    () => openRunControl(item.runId, alternative), { class: "btn btn-primary btn-sm" }) : null;
}

function checkpointBody(item, send) {
  const c = item.checkpoint;
  const accessBlocked = checkpointAccessBlocked(item);
  const run = state.runs.get(item.runId);
  const readOnly = ["plan", "review", "security", "cloud-release"].includes(c.stage);
  const title =
    accessBlocked ? "Worktree access blocked" :
    c.stage === "plan"
      ? c.outcome === "passed" ? "The plan is ready" : "The planner hasn't produced a plan yet"
      : c.stage === "review"
        ? c.outcome === "passed" ? "The reviewer approved the change" : "The reviewer requested changes"
        : c.stage === "cloud-release"
          ? c.outcome === "passed" ? "The Cloud Run release plan is ready" : "The Cloud Run release plan needs attention"
        : c.stage === "security" || c.stage === "security-recheck"
          ? c.outcome === "passed" ? "The security audit passed" : "The security audit requires fixes"
          : c.stage === "triage"
            ? c.outcome === "passed" ? "Review the expected behavior" : "The bug isn't reproduced yet"
        : c.outcome === "passed" ? `${c.stage} passed its gates` : c.noChanges ? `${c.stage} made no changes` : `${c.stage} is still failing`;
  const body = h("div", { class: "card-body" }, h("div", { class: "card-title", text: accessBlocked ? title : `${title} (attempt ${c.attempt})` }));

  const key = `chat:checkpoint:${item.id}`;
  const extra = h("div", { class: "chat-decision-more" });
  const section = (name, title, ...children) =>
    details(`${key}:${name}`, title, h("div", { class: "checkpoint-section-body" }, children), false, "checkpoint-section");
  if (accessBlocked) {
    const current = c.provider ?? run?.provider ?? "claude";
    const switchProvider = checkpointProviderSwitch(item);
    body.append(h("div", { class: "checkpoint-recovery" },
      h("p", { text: "The agent reported that its permissions blocked edits. No changes are ready to approve." }),
      h("div", { class: "actions" },
        switchProvider,
        chatButton("Copy recovery handoff", () => copy([
          `Continue Shipyard run ${item.runId} at its ${c.stage} checkpoint.`,
          `Worktree: ${c.worktree}`,
          run?.request ? `Request: ${run.request}` : "",
          `${providerLabel(current)} reported that its permissions blocked worktree edits. The checkpoint has no changes to approve.`,
          "Inspect the existing worktree and use your normal approval flow if write access is required.",
        ].filter(Boolean).join("\n"), "Recovery handoff"))),
      switchProvider ? h("p", { class: "field-help", text: "Switching retries this step in the same worktree." }) : null));
  } else if (!c.canContinue && c.outcome !== "passed") {
    body.append(h("p", { class: "checkpoint-recovery", text: c.noChanges
      ? "No files changed. Add feedback to retry this step, or stop the run."
      : "This step needs another attempt. Review the details, then add feedback to retry or stop the run." }));
  }
  if (c.expectedBehavior) body.append(h("p", {}, h("strong", { text: "Expected behavior" }), ` · ${c.expectedBehavior}`));
  if (c.summary?.trim()) extra.append(accessBlocked ? section("report", `Agent report · attempt ${c.attempt}`, md(c.summary.trim(), "summary")) :
    checkpointSummary(c.summary.trim(), key));

  if (!readOnly && (!accessBlocked || item.diff.summary.length)) {
    const files = item.diff.summary;
    extra.append(section("files", `Changed files (${files.length})`,
      h("ul", { class: "files" }, files.length ? files.map((line) => h("li", { title: line, text: line })) : h("li", { text: "(none)" })),
    ));
  }

  if (c.gates.length) {
    const failures = c.gates.filter((gate) => !gateOk(gate));
    const detail = failures[0] ?? c.gates.find((gate) => gate.expectFailure && gate.code !== 0);
    const title = failures.length ? `Checks (${failures.length} failed)` : `Checks (${c.gates.length} passed)`;
    extra.append(section("checks", title,
      h("ul", { class: "gates" }, c.gates.map((gate) => h("li", { class: gateOk(gate) ? "ok" : "bad", text: gateLabel(gate) }))),
      detail ? h("pre", { class: "code", text: detail.outputTail.trim().split("\n").slice(-15).join("\n") }) : null,
    ));
  }

  if (item.diff.patch.trim()) {
    const patch = h("div", { class: "checkpoint-section-body" });
    const panel = details(`${key}:diff`, "Diff", patch, false, "checkpoint-section");
    const load = () => {
      if (panel.open && !patch.hasChildNodes()) patch.append(renderDiff(item.diff.patch));
    };
    load();
    panel.addEventListener("toggle", load);
    extra.append(panel);
  }

  const feedback = h("textarea", { rows: "3", placeholder: `Feedback for ${item.role}: what should change?`, "aria-label": `Feedback for ${item.role}` });
  const attachments = h("input", { type: "file", multiple: true });
  const sendFeedback = h("button", { type: "button", class: "btn btn-sm", disabled: true }, "Send feedback");
  feedback.addEventListener("input", () => (sendFeedback.disabled = !feedback.value.trim()));
  sendFeedback.addEventListener("click", () => send({ kind: "checkpoint", action: "feedback", message: feedback.value }, attachments));

  const actions = h("div", { class: "actions" });
  if (c.canContinue) {
    actions.append(
      h(
        "button",
        { type: "button", class: "btn btn-primary btn-sm", onclick: () => send({ kind: "checkpoint", action: "continue" }) },
        c.outcome === "passed" ? ({ plan: "Approve the plan", triage: "Approve expected behavior" }[c.stage] ?? "Approve") : ["review", "security", "security-recheck"].includes(c.stage) ? "Send findings to the implementer" : "Send failure to the implementer",
      ),
    );
  }
  const stop = armedButton("Stop run", "Confirm stop", () => send({ kind: "checkpoint", action: "stop" }));
  const feedbackPanel = section("feedback", c.outcome === "passed" ? "Write feedback" : "Retry with feedback", h("div", { class: "feedback" }, feedback,
    attachmentField(attachments, `${key}-files-input`), h("div", { class: "actions" }, sendFeedback)));
  const checksPassed = c.gates.filter(gateOk).length;
  const facts = [
    !readOnly && item.diff.summary.length ? `${item.diff.summary.length} changed ${item.diff.summary.length === 1 ? "file" : "files"}` : "",
    c.gates.length ? `${checksPassed}/${c.gates.length} checks passed` : "",
  ].filter(Boolean);
  if (facts.length) body.append(h("p", { class: "field-help", text: facts.join(" · ") }));
  extra.append(h("div", { class: "actions" }, stop));
  if (c.canContinue) body.append(actions);
  body.append(details(`${key}:more`, "Review details", extra, false, "chat-decision-disclosure"), feedbackPanel);
  return body;
}

/** A destructive button that needs a second click within 3 seconds. */
function armedButton(label, armedLabel, onConfirm) {
  const btn = h("button", { type: "button", class: "btn btn-sm btn-danger" }, label);
  let timer = 0;
  btn.addEventListener("click", () => {
    if (btn.classList.contains("armed")) {
      clearTimeout(timer);
      onConfirm();
      return;
    }
    btn.classList.add("armed");
    btn.textContent = armedLabel;
    timer = setTimeout(() => {
      btn.classList.remove("armed");
      btn.textContent = label;
    }, 3000);
  });
  return btn;
}

function renderDiff(patch) {
  const lines = patch.replace(/\n$/, "").split("\n");
  return h(
    "pre",
    { class: "diff" },
    lines.map((line) => {
      const cls = line.startsWith("diff --git")
        ? "file"
        : line.startsWith("@@")
          ? "hunk"
          : line.startsWith("+++") || line.startsWith("---") || line.startsWith("index ") || line.startsWith("new file")
            ? "meta"
            : line.startsWith("+")
              ? "add"
              : line.startsWith("-")
                ? "del"
                : "";
      return h("span", { class: cls, text: line || " " });
    }),
  );
}

function questionBody(item, send) {
  const body = h("div", { class: "card-body" });
  const groups = item.questions.map((q, qi) => {
    const name = `chat-${item.id}-q${qi}`;
    const type = q.multiSelect ? "checkbox" : "radio";
    const otherText = h("input", { type: "text", placeholder: "Your own answer", "aria-label": "Your own answer" });
    const otherInput = h("input", { type, name, value: "__other" });
    otherText.addEventListener("focus", () => (otherInput.checked = true));
    const options = q.options.map((o) =>
      h("label", { class: "option" }, h("input", { type, name, value: o.label }), h("span", { class: "option-label", text: o.label }), o.description ? h("span", { class: "option-desc" }, mdInline(o.description)) : null),
    );
    options.push(h("label", { class: "option option-other" }, otherInput, h("span", { class: "option-label", text: "Other" }), otherText));
    const group = h(
      "fieldset",
      { class: "question field" },
      h("legend", { class: "question-text" }, q.header ? h("span", { class: "chip", text: q.header }) : null, " ", mdInline(q.question)),
      h("div", { class: "options" }, options),
    );
    return {
      group,
      read() {
        const picked = [...group.querySelectorAll("input:checked")].map((i) => (i.value === "__other" ? otherText.value.trim() : i.value)).filter(Boolean);
        return picked.join(", ");
      },
      question: q.question,
    };
  });
  const attachments = h("input", { type: "file", multiple: true });
  const attachmentId = `chat-${item.id}-answer-files`;
  const fields = attachmentField(attachments, attachmentId);
  body.append(...groups.map((g) => g.group),
    details(attachmentId, "Attachments", fields, false, "chat-decision-disclosure"));
  const submit = h("button", { type: "button", class: "btn btn-primary btn-sm" }, item.questions.length > 1 ? "Send answers" : "Send answer");
  submit.addEventListener("click", () => {
    const answers = {};
    for (const g of groups) answers[g.question] = g.read();
    if (Object.values(answers).some((a) => !a)) {
      const err = body.querySelector(".card-error");
      err.textContent = "Pick an option (or write your own) for every question.";
      err.hidden = false;
      return;
    }
    send({ kind: "question", answers }, attachments);
  });
  body.append(h("div", { class: "actions" }, submit));
  return body;
}

function permissionBody(item, send) {
  const note = h("input", { type: "text", placeholder: "Note for the agent (optional)", "aria-label": "Note for the agent" });
  const attachments = h("input", { type: "file", multiple: true });
  const decide = (decision) => send({ kind: "permission", decision, message: note.value }, attachments);
  const attachmentId = `chat-${item.id}-permission-files`;
  const request = h("pre", { class: "code", text: JSON.stringify(item.input, null, 2) });
  const fields = attachmentField(attachments, attachmentId);
  return h(
    "div",
    { class: "card-body" },
    h("div", { class: "card-title", text: item.title || `${item.role} wants to use ${item.tool}` }),
    item.reason ? h("div", { class: "field-help", text: item.reason }) : null,
    request,
    details(attachmentId, "Add a note or files", h("div", { class: "chat-decision-more" }, note, fields), false, "chat-decision-disclosure"),
    h(
      "div",
      { class: "actions" },
      h("button", { type: "button", class: "btn btn-primary btn-sm", onclick: () => decide("allow") }, "Allow once"),
      h("button", { type: "button", class: "btn btn-sm", onclick: () => decide("allow-run") }, `Allow ${item.tool} for this run`),
      chatButton("Copy permission handoff", () => copy([
        `Review this pending Shipyard permission for run ${item.runId}.`,
        `Subagent ${item.role} · stage ${item.stage} · tool ${item.tool}.`,
        item.reason ?? item.title ?? "", "The request remains pending in Shipyard.",
      ].filter(Boolean).join("\n"), "Permission handoff")),
      h("span", { class: "spacer" }),
      h("button", { type: "button", class: "btn btn-sm btn-danger", onclick: () => decide("deny") }, "Deny"),
    ),
  );
}

async function focusItem(id) {
  if (focusInlineRunDecision(id)) return;
  const item = state.inbox.get(id);
  if (item && await select(item.runId)) focusInlineRunDecision(id);
}

function openInboxDrawer() {
  $("inbox").classList.add("open");
  $("inbox-toggle").setAttribute("aria-expanded", "true");
}

function closeInboxDrawer() {
  $("inbox").classList.remove("open");
  $("inbox-toggle").setAttribute("aria-expanded", "false");
}

// ── New run dialog ───────────────────────────────────────

// ── Run options: model, effort, crew ─────────────────────

const MODEL_NAMES = { "claude-opus-5-5": "Opus 5.5", "claude-sonnet-5-5": "Sonnet 5.5", "claude-haiku-5-5": "Haiku 5.5", "claude-fable-5-2": "Fable 5.2" };
const modelLabel = (id) => MODEL_NAMES[id] ?? id ?? "Codex CLI default";

/** The crew, in pipeline order. */
const CREW = [
  { stage: "triage", role: "bug-triager", title: "bug-triager", what: "Reproduces the bug and proposes the expected behavior", on: true, pause: true, only: "bug" },
  { stage: "plan", role: "planner", title: "planner", what: "Studies the repo, asks you questions, writes the plan", on: true, pause: true, not: "deps" },
  { stage: "implement", role: "implementer", title: "implementer", what: "Builds the change and its unit tests", required: true, pause: true },
  { stage: "design", role: "ui-ux", title: "UI/UX specialist", what: "Refines the interface, interaction, accessibility, and motion after implementation", on: false, pause: true, not: "deps" },
  { stage: "review", role: "reviewer", title: "reviewer", what: "Fresh-eyes review; blocking findings go back for a revision", on: true },
  { stage: "security", role: "security-auditor", title: "security-auditor", what: "Audits it like an attacker; critical/high findings go back to be fixed", on: false },
  { stage: "e2e", role: "e2e-tester", title: "e2e-tester", what: "Tests it end to end, from the outside", on: true },
  { stage: "repair", role: "implementer", title: "repair", what: "Fixes the code if E2E finds a problem", on: true },
  { stage: "docs", role: "docs-writer", title: "docs-writer", what: "Updates the README, changelog and docs", on: false },
  { stage: "release", role: "release-manager", title: "release-manager", what: "Bumps the version and writes release notes; never publishes", on: false },
  { stage: "cloud-release", role: "google-cloud-releaser", title: "Google Cloud release", what: "Plans a Cloud Run release and its permissions", on: false },
];

// Your last choices, remembered in this browser only. Everything works without them.
const PREFS_KEY = "shipyard.newRun.v2";
function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}
function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // private window or blocked storage: just don't remember
  }
}

function fillProviderOptions(provider, prefs) {
  const config = state.config ?? {};
  const codex = provider === "codex";
  const options = codex ? config.codex ?? {} : config;
  const modelChoices = options.models?.length ? options.models : options.model ? [options.model] : [];
  const defaultModel = options.model ?? "";
  const models = defaultModel ? modelChoices : ["", ...modelChoices];
  const model = models.includes(prefs.model) ? prefs.model : defaultModel;
  $("nr-model").replaceChildren(
    ...models.map((m) => h("option", { value: m, selected: m === model, text: m ? `${modelLabel(m)}${m === defaultModel ? " (default)" : ""}` : "Codex CLI default" })),
  );
  const effortChoices = codex ? state.codexEfforts ?? ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] : state.efforts ?? ["low", "medium", "high", "xhigh", "max"];
  const defaultEffort = options.effort ?? "";
  const efforts = defaultEffort ? effortChoices : ["", ...effortChoices];
  const effort = efforts.includes(prefs.effort) ? prefs.effort : defaultEffort;
  $("nr-effort").replaceChildren(
    ...efforts.map((e) => h("option", { value: e, selected: e === effort, text: e ? `${e}${e === defaultEffort ? " (default)" : ""}` : "Codex CLI default" })),
  );
  const budget = config.maxBudgetUsdPerRun;
  const hasBudget = !codex && typeof budget === "number";
  const budgetInput = $("nr-budget");
  budgetInput.closest("label").hidden = !hasBudget;
  budgetInput.closest(".field-grid").classList.toggle("field-grid-3", hasBudget);
  budgetInput.required = hasBudget;
  budgetInput.disabled = !hasBudget;
  budgetInput.value = hasBudget ? String(budget) : "";
  const stageCap = config.maxBudgetUsdPerStage ? ` Each agent also stops at ${dollars(config.maxBudgetUsdPerStage)}.` : "";
  $("nr-options-help").textContent = codex
    ? "Codex reports token usage. Agents work unattended between checkpoints."
    : "For every agent in this run. Higher effort uses more of your plan." +
      (hasBudget ? ` The run stops at its budget, estimated at API prices.${stageCap}` : "");
  $("nr-inbox-help").textContent = codex ? "At a checkpoint you can approve, send feedback, or stop." :
    "At a checkpoint you can approve, send feedback, or stop. Claude agents can also ask you questions while they work.";
}

function fillRunOptions() {
  const prefs = loadPrefs();
  const config = state.config ?? {};
  const provider = config.demo ? "claude" : prefs.provider ?? config.defaultProvider ?? "claude";
  const select = $("nr-provider");
  select.value = provider;
  select.disabled = Boolean(config.demo);
  const providerPrefs = prefs.provider === provider || (!prefs.provider && provider === "claude") ? prefs : {};
  fillProviderOptions(provider, providerPrefs);

  const pause = new Set(prefs.pause ?? CREW.filter((c) => c.pause).map((c) => c.stage));
  const runs = Object.fromEntries(CREW.filter((c) => !c.required).map((c) => [c.stage, prefs.run?.[c.stage] ?? c.on]));
  $("nr-crew").replaceChildren(
    ...CREW.map((c) => {
      const role = state.roles?.find((r) => r.name === c.role);
      const title = h("strong", { class: c.role === "implementer" ? "crew-implementer-name" : null, text: c.title });
      return h(
        "tr",
        { "data-stage": c.stage },
        h(
          "td",
          {},
          h(
            "div",
            { class: "crew-agent", title: role?.description ?? "" },
            h("span", { class: "crew-avatar", "data-role": c.role }, c.role === "implementer" ? null : avatar(c.role, true)),
            h("div", {}, title, h("span", { class: "crew-what", text: c.what })),
          ),
        ),
        h(
          "td",
          {},
          c.required
            ? h("span", { class: "always", text: "always" })
            : h("input", { type: "checkbox", name: "run", value: c.stage, checked: runs[c.stage], "aria-label": `Run ${c.title}` }),
        ),
        h("td", {}, h("input", { type: "checkbox", name: "checkpoints", value: c.stage, checked: pause.has(c.stage), "aria-label": `Pause after ${c.stage}` })),
      );
    }),
  );
  updateCrew();
}

/** Which agents will run: E2E needs an E2E command on the repo, repair needs E2E. */
function crewState() {
  const target = state.targets.find((t) => t.name === $("nr-target").value);
  const hasE2E = target ? target.e2e : true;
  const kind = $("new-run-form").querySelector('input[name="kind"]:checked')?.value ?? "feature";
  const box = (stage) => $("nr-crew").querySelector(`tr[data-stage="${stage}"] input[name="run"]`);
  const checked = (stage) => Boolean(box(stage)?.checked);
  // Which agents can run at all for this kind of run and this repo.
  const available = { implement: true, e2e: hasE2E };
  for (const c of CREW) {
    if (c.only && c.only !== kind) available[c.stage] = false;
    if (c.not === kind) available[c.stage] = false;
  }
  const on = { implement: true };
  for (const c of CREW) if (!c.required) on[c.stage] = available[c.stage] !== false && checked(c.stage);
  available.repair = on.e2e;
  on.repair = on.e2e && checked("repair");
  return { hasE2E, kind, box, on, available };
}

function updateCrew() {
  if (!$("nr-crew").children.length) return;
  const { hasE2E, kind, box, on, available } = crewState();
  $("nr-parallel-field").hidden = !(on.review && on.security);
  $("nr-parallel").disabled = !(on.review && on.security);
  // A box that can't apply shows a dash, not a greyed tick that reads as "on".
  for (const c of CREW) {
    if (!c.required) setCell(box(c.stage), available[c.stage] === false);
    const row = $("nr-crew").querySelector(`tr[data-stage="${c.stage}"]`);
    row.classList.toggle("off", !on[c.stage]);
    setCell(row.querySelector('input[name="checkpoints"]'), !on[c.stage]);
  }
  const what = (stage) => $("nr-crew").querySelector(`tr[data-stage="${stage}"] .crew-what`);
  const spec = (stage) => CREW.find((c) => c.stage === stage);
  what("e2e").textContent = hasE2E ? spec("e2e").what : "This repo has no E2E command yet (add one in shipyard.config.yaml)";
  what("repair").textContent = on.e2e ? spec("repair").what : "Only runs together with the E2E tester";
  what("triage").textContent = kind === "bug" ? spec("triage").what : "Only for bug fixes";
  what("plan").textContent = kind === "deps" ? "Not used for dependency updates" : spec("plan").what;
  what("implement").textContent = kind === "deps" ? "Upgrades the dependencies and keeps the tests green" : spec("implement").what;
  const implementer = kind === "deps" ? "dependency-updater" : "backend";
  const implementerLabel = kind === "deps" ? roleLabel(implementer) : "BE-FE";
  const description = state.roles?.find((r) => r.name === implementer)?.description ?? "";
  for (const icon of $("nr-crew").querySelectorAll('.crew-avatar[data-role="implementer"]')) {
    const row = icon.closest("tr");
    row.querySelector(".crew-implementer-name").textContent = row.dataset.stage === "implement" ? implementerLabel : `${implementerLabel} · ${spec(row.dataset.stage).title}`;
    icon.replaceChildren(avatar(implementer, true));
    row.querySelector(".crew-agent").title = description;
  }
}

function setCell(input, notApplicable) {
  input.disabled = notApplicable;
  input.hidden = notApplicable;
  input.parentElement.classList.toggle("na", notApplicable);
}

function fillTargets(selected) {
  const select = $("nr-target");
  const keep = selected ?? select.value;
  const needsChoice = selected === "" || (keep === "" && select.options[0]?.value === "");
  select.replaceChildren(
    needsChoice ? h("option", { value: "", text: "Choose a repository", disabled: true, selected: true }) : null,
    ...state.targets.map((t) => h("option", { value: t.name, text: t.name, selected: t.name === keep })),
  );
  $("nr-target-path").textContent = state.targets.find((target) => target.name === select.value)?.path ?? "";
}

function openNewRun(selected, proposal = null) {
  if (!state.targets.length && state.config?.canAddTargets) return openAddRepo();
  const dialog = $("new-run-dialog");
  if (!dialog.open) {
    chat.proposal = proposal;
    reviewChatFiles("nr-chat-files", proposal?.bundles);
    $("nr-parallel").checked = true;
  }
  fillTargets(typeof selected === "string" ? selected : undefined);
  if (!dialog.open || typeof selected === "string") $("nr-browser").checked = Boolean(state.targets.find((t) => t.name === $("nr-target").value)?.browserAccess);
  $("nr-add-repo").hidden = !state.config?.canAddTargets;
  if (!dialog.open) fillRunOptions();
  const form = $("new-run-form");
  if (proposal) {
    const kind = [...form.elements.kind].find(({ value }) => value === proposal.kind);
    if (kind) kind.checked = true;
    $("nr-request").value = proposal.request;
    $("nr-attachments").value = "";
    const provider = $("nr-provider");
    if (provider.value !== proposal.provider && !provider.disabled) {
      provider.value = proposal.provider;
      fillProviderOptions(provider.value, {});
    }
    for (const input of $("nr-crew").querySelectorAll('input[name="run"]')) input.checked = proposal.crew.includes(input.value);
  }
  applyKind(form.querySelector('input[name="kind"]:checked')?.value ?? "feature");
  $("demo-note").hidden = !state.config?.demo;
  $("nr-error").hidden = true;
  if (!dialog.open) dialog.showModal();
  $("nr-request").focus();
}

// ── Add repo dialog ──────────────────────────────────────

const addRepo = { inspected: null, seq: 0, timer: 0, edited: new Set(), busy: false };
let localRepoRequest = 0;

async function refreshLocalRepos() {
  const request = ++localRepoRequest;
  try {
    const { repos } = await api("/api/targets/suggestions");
    if (request !== localRepoRequest) return;
    state.localRepos = repos;
    state.localRepoStatus = repos.length ? "" : "No other local repos found";
  } catch {
    if (request !== localRepoRequest) return;
    state.localRepoStatus = "Local repos unavailable";
  }
  schedule("detail");
}

const cloneUrlEntered = () => /^(?:[a-z][\w+.-]*:\/\/|[\w.-]+@[\w.-]+:)/i.test($("ar-path").value.trim());

async function openAddRepo(onAdded, locator = "") {
  const dialog = $("add-repo-dialog");
  addRepo.onAdded = typeof onAdded === "function" ? onAdded : openNewRun;
  $("add-repo-form").reset();
  clearTimeout(addRepo.timer);
  addRepo.seq++;
  addRepo.inspected = null;
  addRepo.edited.clear();
  $("ar-status").replaceChildren();
  $("ar-details").hidden = $("ar-details").disabled = true;
  $("ar-error").hidden = true;
  $("ar-submit").disabled = true;
  $("ar-submit").textContent = "Add repo";
  $("ar-hint").textContent = "";
  $("ar-suggestions").replaceChildren();
  $("ar-suggestions-field").hidden = true;
  dialog.showModal();
  if (locator) pickRepo(locator);
  $("ar-path").focus();
  try {
    const { repos } = await api("/api/targets/suggestions");
    if (!repos.length) return;
    $("ar-suggestions").replaceChildren(
      ...repos.map((r) =>
        h(
          "button",
          { type: "button", class: "repo-pick", "data-path": r.path, onclick: () => pickRepo(r.displayPath) },
          h("strong", { text: r.name }),
          h("span", { text: r.displayPath }),
        ),
      ),
    );
    $("ar-suggestions-field").hidden = false;
  } catch {
    // No suggestions: typing a path still works.
  }
}

function pickRepo(path) {
  if (addRepo.busy) return;
  clearTimeout(addRepo.timer);
  $("ar-path").value = path;
  addRepo.edited.clear(); // a new repo: let detection fill the fields again
  inspectPath();
}

async function inspectPath() {
  const path = $("ar-path").value.trim();
  const seq = ++addRepo.seq;
  addRepo.inspected = null;
  $("ar-details").hidden = $("ar-details").disabled = true;
  updateAddRepoSubmit();
  if (!path || cloneUrlEntered()) {
    $("ar-status").replaceChildren(path ? h("span", { class: "muted", text: "Clone the repository to inspect its test commands before adding it." }) : null);
    return;
  }
  $("ar-status").replaceChildren(h("span", { class: "muted", text: "Checking…" }));
  let info;
  try {
    info = await api("/api/targets/inspect", { method: "POST", body: { path } });
  } catch (err) {
    if (seq === addRepo.seq) $("ar-status").replaceChildren(h("span", { class: "err", text: err.message }));
    return;
  }
  if (seq !== addRepo.seq) return; // a newer path was typed meanwhile
  showRepoInspection(info);
}

function showRepoInspection(info) {
  addRepo.inspected = info;

  for (const el of document.querySelectorAll(".repo-pick")) el.classList.toggle("chosen", el.dataset.path === info.path);
  const lines = [];
  if (info.ok) lines.push(h("span", { class: "ok", text: `✓ ${info.displayPath} · ${info.branch} · ${info.commits} commit${info.commits === 1 ? "" : "s"}` }));
  for (const e of info.errors) lines.push(h("span", { class: "err", text: e }));
  for (const w of info.warnings) lines.push(h("span", { class: "warn", text: w }));
  if (info.existingName) lines.push(chatButton(`Use ${info.existingName}`, () => {
    $("add-repo-dialog").close();
    addRepo.onAdded(info.existingName);
  }));
  $("ar-status").replaceChildren(...lines);

  $("ar-details").hidden = $("ar-details").disabled = !info.ok;
  if (info.ok) {
    const fill = (id, value) => {
      if (!addRepo.edited.has(id)) $(id).value = value ?? "";
    };
    fill("ar-name", info.suggestedName);
    // A brand-new repo has no tests yet: npm test is the usual choice, and the first run creates it.
    fill("ar-test", info.test[0]?.command ?? (info.empty ? "npm test" : ""));
    fill("ar-e2e", info.e2e[0]?.command);
    const common = [
      { command: "npm test", source: "a common choice for JavaScript projects" },
      { command: "pytest", source: "a common choice for Python projects" },
      { command: "make test", source: "a common choice with a Makefile" },
    ];
    commandChips("ar-test-chips", "ar-test", info.test.length ? info.test : common);
    commandChips("ar-e2e-chips", "ar-e2e", info.e2e);
    if (info.empty) {
      $("ar-status").append(
        h("span", {
          class: "muted",
          text: "New, empty repo. Keep npm test (or pick your stack's command): in your first run, describe the project and ask for tests, and the agent sets it all up. The run only passes once that command works.",
        }),
      );
    } else if (!info.test.length) {
      $("ar-status").append(h("span", { class: "muted", text: "No test command found in the repo. Pick or type the one you use." }));
    }
  }
  updateAddRepoSubmit();
}

function commandChips(containerId, inputId, candidates) {
  const input = $(inputId);
  const chips = candidates.map((c) => {
    const chip = h("button", { type: "button", class: `cmd-chip${input.value === c.command ? " chosen" : ""}`, title: `From ${c.source}`, text: c.command });
    chip.addEventListener("click", () => {
      input.value = c.command;
      addRepo.edited.add(inputId);
      for (const other of $(containerId).children) other.classList.toggle("chosen", other === chip);
      updateAddRepoSubmit();
    });
    return chip;
  });
  $(containerId).replaceChildren(...chips);
}

function updateAddRepoSubmit() {
  const clone = cloneUrlEntered();
  const submit = $("ar-submit");
  submit.textContent = clone ? addRepo.busy ? "Cloning…" : "Clone repo" : addRepo.busy ? "Adding…" : "Add repo";
  if (clone) {
    $("ar-hint").textContent = state.config?.canCloneTargets ? "" : "Restart Shipyard to enable cloning from URLs";
    submit.disabled = addRepo.busy || !state.config?.canCloneTargets;
    return;
  }
  const missing = !addRepo.inspected
    ? "Pick or type a repo first"
    : !addRepo.inspected.ok
      ? ""
      : !$("ar-name").value.trim()
        ? "Give it a name"
        : !$("ar-test").value.trim()
          ? "Enter a test command to continue"
          : "";
  $("ar-hint").textContent = missing;
  submit.disabled = addRepo.busy || !addRepo.inspected?.ok || Boolean(missing);
}

function wireAddRepo() {
  const dialog = $("add-repo-dialog");
  const cancel = $("ar-cancel");
  const path = $("ar-path");
  $("nr-add-repo").addEventListener("click", openAddRepo);
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => { if (addRepo.busy) event.preventDefault(); });
  path.addEventListener("input", () => {
    clearTimeout(addRepo.timer);
    addRepo.seq++;
    addRepo.inspected = null;
    addRepo.edited.clear();
    $("ar-error").hidden = true;
    $("ar-details").hidden = $("ar-details").disabled = true;
    updateAddRepoSubmit();
    if (!path.value.trim() || cloneUrlEntered()) void inspectPath();
    else addRepo.timer = setTimeout(inspectPath, 400);
  });
  for (const id of ["ar-name", "ar-test", "ar-e2e"]) {
    $(id).addEventListener("input", () => {
      addRepo.edited.add(id);
      updateAddRepoSubmit();
    });
  }
  $("add-repo-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const clone = cloneUrlEntered();
    if (addRepo.busy || (clone ? !state.config?.canCloneTargets : !addRepo.inspected?.ok)) return;
    addRepo.busy = cancel.disabled = path.disabled = true;
    updateAddRepoSubmit();
    $("ar-error").hidden = true;
    try {
      if (clone) {
        const info = await api("/api/targets/clone", { method: "POST", body: { url: path.value.trim() } });
        path.value = info.displayPath;
        showRepoInspection(info);
        if (info.ok) $("ar-name").focus();
        return;
      }
      const { target } = await api("/api/targets", {
        method: "POST",
        body: { path: addRepo.inspected.path, name: $("ar-name").value.trim(), test: $("ar-test").value.trim(), e2e: $("ar-e2e").value.trim() },
      });
      if (!state.targets.some((t) => t.name === target.name)) state.targets.push(target);
      dialog.close();
      toast(`Added ${target.name}. It's saved in shipyard.config.yaml.`);
      addRepo.onAdded(target.name);
    } catch (err) {
      $("ar-error").textContent = err.message;
      $("ar-error").hidden = false;
    } finally {
      addRepo.busy = cancel.disabled = path.disabled = false;
      updateAddRepoSubmit();
    }
  });
}

/** Labels and crew availability for the kind of run: ship a feature, fix a bug, or update dependencies. */
function applyKind(kind) {
  const request = $("nr-request");
  const copy = {
    feature: ["Feature request", 'Add a GET /health endpoint that returns {"status": "ok"}'],
    bug: ["Bug report", "Describe what goes wrong, as a user would report it"],
    deps: ["Notes (optional)", "For example: patch and minor only, leave react on 18. Empty means safe upgrades."],
  }[kind] ?? ["Request", ""];
  $("nr-request-label").textContent = copy[0];
  request.placeholder = copy[1];
  request.required = kind !== "deps"; // a dependency update needs no description
  updateCrew();
}

function wireNewRun() {
  const form = $("new-run-form");
  const dialog = $("new-run-dialog");
  form.addEventListener("change", (e) => {
    if (e.target.name !== "kind") return;
    applyKind(e.target.value);
  });
  $("nr-provider").addEventListener("change", (event) => {
    const provider = event.target.value;
    const prefs = loadPrefs();
    fillProviderOptions(provider, prefs.provider === provider ? prefs : {});
  });
  $("nr-cancel").addEventListener("click", () => { if (!$("nr-submit").disabled) dialog.close(); });
  dialog.addEventListener("close", () => {
    if (!chat.proposal) return;
    chat.proposal = null;
    $("nr-request").value = "";
    $("nr-attachments").value = "";
    form.querySelector('input[name="kind"][value="feature"]').checked = true;
  });
  dialog.addEventListener("cancel", (e) => { if ($("nr-submit").disabled) e.preventDefault(); });
  $("nr-crew").addEventListener("change", updateCrew);
  $("nr-target").addEventListener("change", () => {
    const target = state.targets.find((t) => t.name === $("nr-target").value);
    $("nr-target-path").textContent = target?.path ?? "";
    $("nr-browser").checked = Boolean(target?.browserAccess);
    updateCrew();
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submit = $("nr-submit");
    if (submit.disabled) return;
    const data = new FormData(form);
    const { box, on } = crewState();
    const paused = [...$("nr-crew").querySelectorAll('input[name="checkpoints"]:checked')].map((i) => i.value);
    // Only pause after agents that will actually run. A revision after review pauses like implement.
    const checkpoints = paused.filter((s) => on[s]);
    if (checkpoints.includes("implement")) checkpoints.push("revise");
    const body = {
      target: data.get("target"),
      kind: data.get("kind"),
      request: String(data.get("request") ?? "").trim(),
      provider: $("nr-provider").value,
      browserAccess: $("nr-browser").checked,
      browserReferenceHelp: true,
      model: $("nr-model").value || undefined,
      effort: $("nr-effort").value || undefined,
      budgetUsd: $("nr-budget").required ? Number($("nr-budget").value) : undefined,
      crew: CREW.filter((c) => !c.required && on[c.stage]).map((c) => c.stage),
      parallelReviews: on.review && on.security && $("nr-parallel").checked,
      checkpoints,
    };
    const proposal = chat.proposal;
    const fromChat = Boolean(proposal);
    if (!fromChat) savePrefs({
      provider: body.provider,
      model: body.model,
      effort: body.effort,
      run: Object.fromEntries(CREW.filter((c) => !c.required).map((c) => [c.stage, Boolean(box(c.stage)?.checked)])),
      pause: paused,
    });
    submit.disabled = true;
    try {
      body.attachments = await readAttachments($("nr-attachments"));
      body.chatAttachmentIds = chatFileIds("nr-chat-files");
      const { id } = await api("/api/runs", { method: "POST", body });
      if (!state.runs.has(id)) state.starting.set(id, { request: body.request, target: body.target, provider: body.provider, kind: body.kind, crew: body.crew, parallelReviews: body.parallelReviews,
        repo: state.targets.find((t) => t.name === body.target)?.path });
      dialog.close();
      $("nr-request").value = "";
      $("nr-attachments").value = "";
      if (fromChat) {
        setRunContext(id);
        appendChat({ role: "assistant", content: `Run started for ${body.target}.`, runId: id,
          runTitle: proposal.title, proposalMessageId: proposal.messageId });
        schedule();
        $("chat-input").focus();
      } else select(id);
    } catch (err) {
      $("nr-error").textContent = err.message;
      $("nr-error").hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
}

// ── Misc ─────────────────────────────────────────────────

function toast(message, bad = false) {
  const el = h("div", { class: `toast${bad ? " bad" : ""}`, role: bad ? "alert" : "status", text: message });
  $("toasts").append(el);
  setTimeout(() => el.remove(), 6000);
}

function runCommands(run, result = {}) {
  const commands = [];
  const add = (id, label, execute, hint) => commands.push({ id, label, execute, hint });
  const id = run.id;
  if (run.deployment) {
    const deployment = run.deployment;
    if (!deployment.dispatchStarted && (deployment.phase === "failed" || runStatus(run) === "interrupted")) {
      add("verify-deployment", "Verify deployment again", () => updateDeploymentRun(id, "review"));
    }
    if (!deployment.dispatchStarted && runStatus(run) === "interrupted") {
      add("cancel-deployment", "Cancel deployment", () => updateDeploymentRun(id, "cancel"));
    }
    if (run.finishedAt) add("archive", run.archivedAt ? "Restore run" : "Archive run", () => archiveRun(id, !run.archivedAt));
    return commands;
  }
  const active = (state.active.has(run.id) || !state.runs.has(run.id)) && run.status === "running";
  if (active) {
    if (!state.stopping.has(id)) {
      add("steer", "Steer this run", () => openRunControl(id));
      add("stop", "Stop run", () => stopRun(id), "The run stops and keeps its worktree.");
      const provider = run.provider === "codex" ? "claude" : "codex";
      if (!state.config?.demo && state.chatProviders?.includes(provider)) {
        add(`switch-${provider}`, `Switch to ${providerLabel(provider)}`, () => openRunControl(id, provider));
      }
    }
    return commands;
  }
  if (result.canGiveFeedback) add("revise", "Request code changes");
  if (run.finishedAt) add("deployment-status", "Check live deployment");
  if (result.canPreview || result.previewUrl) {
    add("preview", "Open local preview", () => updatePreview(id, "POST"));
    if (result.previewUrl) add("stop-preview", "Stop preview", () => updatePreview(id, "DELETE"));
  }
  if (result.canPreview && run.status === "passed" && !state.browserPending.has(id)) {
    add("browser-check", "Run browser check", () => checkRunBrowser(id), "Shipyard will test the desktop and phone layouts.");
  }
  if (!state.localAppPending.has(id)) {
    if (result.localApp?.url) {
      add("open-local-app", "Open local app", () => ({ text: "The local app is ready.", link: result.localApp.url, linkLabel: "Open local app" }));
      add("stop-local-app", "Stop local app", () => updateLocalApp(id, "DELETE"));
    } else if (result.canRunLocally && !result.localApp?.starting) {
      add("local-app", "Run locally", () => updateLocalApp(id, "POST"), "Shipyard will prepare and start a local app from this run.");
    }
  }
  const publication = result.publish;
  if (run.status === "passed" && !result.latestRevisionId) {
    if (result.hasRemote === false) add("git-remote", "Connect Git remote", () => openGitRemote(run));
    if (!state.pullRequestPending.has(id)) {
      if (publication?.closedPullRequestUrl) add("reopen-pr", "Reopen PR", () => openDraftReview(id, publication, true));
      if (publication?.canDraftPullRequest && !publication.pullRequestUrl) {
        add("draft-pr", "Create draft PR", () => openDraftReview(id, publication), "Review the destination and changes before publishing.");
      } else if (publication?.canCreatePullRequest) {
        add("draft-pr", "Create draft PR", () => createPullRequest(id, publication, true), `Publish ${run.branch} to ${publication.label} as a draft PR.`);
      }
      if (publication?.canCreatePullRequest) add("create-pr", "Create PR on GitHub", () => createPullRequest(id, publication, false),
        `Publish ${run.branch} to ${publication.label} and open a pull request.`);
    }
    if (publication && !publication.pushed) add("push", "Push branch", () => openPublish(run, publication), "Review the destination and commit before pushing.");
    if (!state.config?.demo && publication?.pullRequestState === "merged") add("deploy", "Start deployment");
    if (result.canReleaseToCloudRun && !state.config?.demo) add("cloud-release", "Review Cloud Run release", () => openCloudRelease(id));
  }
  if (result.budgetPause) add("budget", "Increase budget", () => openBudgetIncrease(run, result.budgetPause));
  if (!state.resuming.has(id)) {
    if (result.canResumeProjectCheck || !result.latestRevisionId && !run.cleanedUp && ["stopped", "running"].includes(run.status)) {
      add("resume", "Resume run", () => resumeRun(id));
    }
    if (result.canFixRevision && result.savedEditsCheck !== "passed") add("repair", "Retry repair", () => resumeRun(id, "fix"));
    if (result.recheckStage && result.savedEditsCheck === "passed") add("continue", "Continue this run", () => resumeRun(id, "recheck"));
  }
  if (!state.verificationPending.has(id)) {
    if (result.recheckStage && result.savedEditsCheck !== "passed" && result.savedEditsCheck !== "checking") {
      add("saved-edits", "Check saved edits", () => verifyRunResult(id));
    }
    if (result.handoff?.regression?.canRecheck) add("regression", "Recheck regression", () => verifyRunResult(id, true));
    if (result.canVerifyStoppedRun || run.status === "passed" && !run.cleanedUp && !result.latestRevisionId) {
      add("checks", "Run project checks", () => verifyRunResult(id));
    }
  }
  if (result.canPrepareBranch) add("cleanup", "Review branch cleanup", () => openBranchPreparation(run));
  if (run.worktree && !run.cleanedUp) add("copy-worktree", "Copy worktree path", () => copy(run.worktree, "Worktree path"));
  if (run.branch) add("copy-branch", "Copy branch name", () => copy(run.branch));
  add("archive", run.archivedAt ? "Restore run" : "Archive run", () => archiveRun(id, !run.archivedAt));
  add("delete", "Delete run", () => deleteRun(id), "This removes the run history and keeps the Git worktree.");
  return commands;
}

const runCommandAliases = new Map([
  ["open preview", "preview"], ["show local preview", "preview"], ["preview saved edits", "preview"],
  ["open the local preview", "preview"], ["open my local preview", "preview"], ["show me a preview", "preview"],
  ["open local preview", "preview"], ["run locally", "local-app"], ["open local app", "open-local-app"],
  ["run browser check", "browser-check"], ["create draft pr", "draft-pr"], ["push branch", "push"],
  ["request code changes", "revise"], ["recheck regression", "regression"],
  ["start local app", "local-app"], ["start the local app", "local-app"], ["run it locally", "local-app"], ["run the app locally", "local-app"],
  ["open the local app", "open-local-app"], ["run the browser check", "browser-check"], ["run a browser check", "browser-check"],
  ["create a draft pr", "draft-pr"], ["create draft pull request", "draft-pr"], ["create a draft pull request", "draft-pr"],
  ["push the branch", "push"], ["push updates", "push"], ["review local update", "push"],
  ["request a revision", "revise"], ["revise this run", "revise"], ["start a revision", "revise"],
  ["resume saved run", "resume"], ["stop this run", "stop"], ["check saved edits again", "saved-edits"],
  ["check live deployment", "deployment-status"], ["check the live deployment", "deployment-status"], ["deploy this run", "deploy"],
  ["commands", "help"], ["show commands", "help"], ["list run actions", "help"],
  ["what now", "next-step"], ["what should i do next", "next-step"], ["what should i do now", "next-step"], ["what should i do", "next-step"],
  ["what do i do now", "next-step"], ["what do i do next", "next-step"],
  ["not sure what to do", "next-step"], ["i’m not sure what to do", "next-step"], ["i'm not sure what to do", "next-step"],
  ["what needs my attention", "next-step"], ["summarize progress", "next-step"],
]);

function normalizeRunCommand(text) {
  return text.trim().toLowerCase().replace(/^[\/]/, "")
    .replace(/^(?:(?:can|could|would) you|i (?:want|would like) (?:you )?to)\s+/, "").replace(/^please\s+/, "")
    .replace(/[?.!]+$/, "").replace(/\s+please$/, "").replace(/\s+/g, " ");
}

function isDeployCommand(phrase) {
  return /^(?:start deployment|(?:(?:commit|push) (?:the )?(?:(?:changes|updates|this (?:run|revision)|it),? )?(?:and (?:then )?|then ))?(?:re)?deploy(?: (?:it|this(?: run| revision)?|the (?:site|portfolio|app)))?(?: now)?)$/.test(phrase);
}

function renderCommandMenu(run, result) {
  const menu = $("chat-command-menu");
  const commands = run?.id && !chat.revisionMode ? runCommands(run, result) : [];
  menu.hidden = !commands.length;
  if (menu.hidden) menu.open = false;
  const key = JSON.stringify([run?.id, commands.map(({ label }) => label)]);
  if (menu.dataset.commands === key) return;
  menu.dataset.commands = key;
  $("chat-command-list").replaceChildren(...commands.map(({ label }) => chatButton(label, () => {
    menu.open = false;
    const input = $("chat-input");
    if (!input.value.trim() || input.value.trim() === "/") input.value = label;
    else $("chat-status").textContent = `Command · ${label}`;
    input.focus();
  }, { class: "btn btn-ghost btn-sm" })));
}

function renderRunAction() {
  const region = $("chat-run-action");
  const draft = chat.runAction;
  region.hidden = !draft;
  if (!draft) {
    region.replaceChildren();
    return;
  }
  const launch = draft.outcome?.link ? h("a", { class: "btn btn-sm", href: draft.outcome.link,
    target: "_blank", rel: "noopener noreferrer", text: draft.outcome.linkLabel }) : null;
  region.replaceChildren(
    h("h3", { text: draft.label }),
    ...[draft.outcome?.text ?? draft.hint].filter(Boolean).map((message) =>
      h("p", { text: message, role: draft.outcome?.error ? "alert" : "status" })),
    h("div", { class: "actions" },
      launch ?? chatButton(draft.busy ? "Working…" : draft.label, () => confirmRunAction(draft),
        { class: "btn btn-primary btn-sm", disabled: draft.busy }),
      chatButton("Dismiss", () => { chat.runAction = null; renderRunAction(); }, { disabled: draft.busy })),
  );
}

async function confirmRunAction(draft) {
  if (chat.runAction !== draft || chat.runId !== draft.runId || draft.busy) return;
  const run = state.runs.get(draft.runId);
  const action = run && runCommands(run, state.results.get(run.id)).find(({ id }) => id === draft.id);
  if (!action?.execute) {
    draft.outcome = { text: "This action is no longer available for the run.", error: true };
    renderRunAction();
    return;
  }
  draft.busy = true;
  draft.outcome = null;
  renderRunAction();
  try {
    const outcome = await action.execute();
    if (chat.runAction !== draft) return;
    if (outcome?.link || outcome?.error) draft.outcome = outcome;
    else {
      chat.runAction = null;
      if (outcome?.text) appendChat({ role: "assistant", content: outcome.text, runId: draft.runId });
    }
  } catch (error) {
    draft.outcome = { text: error.message, error: true };
  } finally {
    draft.busy = false;
    renderRunAction();
  }
}

function submitRunCommand(text) {
  const run = state.runs.get(chat.runId);
  if (!run || !text || chat.files.length) return false;
  const brief = /^(?:request code changes|revise this run|start a revision)\s*:\s*(\S[\s\S]*)$/i.exec(text)?.[1];
  const phrase = normalizeRunCommand(text);
  const result = run.finishedAt && !run.deployment && completionLabel(run) ? finishedResult(run.id) : undefined;
  const choices = runCommands(run, result);
  const id = brief ? "revise" : isDeployCommand(phrase) ? "deploy" : runCommandAliases.get(phrase) ??
    choices.find(({ label }) => normalizeRunCommand(label) === phrase)?.id;
  if (!id) return false;
  if (id === "deployment-status") {
    if (!run.finishedAt || run.deployment) return false;
    void askChat(text, run.id, undefined, { runQuestion: true });
    return true;
  }
  if (id === "help") {
    $("chat-input").value = "";
    appendChat({ role: "user", content: text, runId: run.id });
    const examples = choices.slice(0, 4).map(({ label }) => `${label}`).join(", ");
    appendChat({ role: "assistant", runId: run.id,
      content: examples ? `Try one of these in chat: ${examples}. Open Commands to see the rest.` : "Ask about this run in chat." });
    return true;
  }
  const action = choices.find((entry) => entry.id === id) ??
    (id === "local-app" ? choices.find((entry) => entry.id === "open-local-app") : undefined);
  if (!action && result?.loading) {
    const chatId = chat.id;
    const loading = "Loading the run’s available actions…";
    $("chat-status").textContent = loading;
    void result.ready.then(() => {
      if (chat.id !== chatId || chat.runId !== run.id) return;
      if ($("chat-status").textContent === loading) $("chat-status").textContent = "";
      if ($("chat-input").value.trim() === text && !chat.pending) submitRunCommand(text);
    });
    return true;
  }
  if (id === "deploy") {
    if (!run.finishedAt || run.deployment) return false;
    const summary = runSummary(run, result);
    const handoff = result?.latestRevisionId ? summary : deploymentNextStep(run, result ?? {});
    if (handoff && !handoff.action?.question && !handoff.action?.href) {
      $("chat-input").value = "";
      $("chat-status").textContent = "";
      const primary = handoff.action;
      const replyAction = primary?.draftReview === "create" ? "draft-pr" : primary?.draftReview === "reopen" ? "reopen-pr" :
        primary?.runId ? result?.latestRevisionId ? "open-latest-revision" : "open-deployment" : undefined;
      appendChat({ role: "user", content: text, runId: run.id });
      appendChat({ role: "assistant", runId: run.id, content: handoff.next, question: text,
        answer: replyAction ? { actions: [{ label: primary.label, action: replyAction }] } : undefined });
      renderChatControls();
    } else void askChat(text, run.id, undefined, { runQuestion: "Deploy from this run." });
    return true;
  }
  if (id === "next-step") {
    $("chat-input").value = "";
    $("chat-status").textContent = "";
    appendChat({ role: "user", content: text, runId: run.id });
    const summary = runSummary(run, result);
    appendChat({ role: "assistant", runId: run.id, content: `${summary.heading}. ${summary.next}` });
    return true;
  }
  if (chat.runAction?.busy) {
    $("chat-status").textContent = "A run action is still in progress.";
    return true;
  }
  $("chat-input").value = "";
  $("chat-status").textContent = "";
  chat.runAction = null;
  renderRunAction();
  appendChat({ role: "user", content: text, runId: run.id });
  if (!action) {
    appendChat({ role: "assistant", runId: run.id, content: "This action isn’t available for the current run. Open Commands to see the available actions." });
  } else if (id === "revise") {
    void openFeedback(run, brief);
  } else {
    chat.runAction = { runId: run.id, id: action.id, label: action.label, hint: action.hint };
    renderRunAction();
    $("chat-run-action").scrollIntoView({ block: "nearest" });
  }
  return true;
}

async function resumeRun(id, action = "resume") {
  if (state.resuming.has(id)) return;
  state.resuming.add(id);
  schedule("detail");
  try {
    await api(`/api/runs/${id}/${action}`, { method: "POST" });
    if (state.selected === id) state.showArchived = false;
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.resuming.delete(id);
    schedule("runs", "detail");
  }
}

function forgetRun(id) {
  state.runs.delete(id);
  state.events.delete(id);
  state.buffers.delete(id);
  state.lastActivity.delete(id);
  state.stageActivity.delete(id);
  state.results.delete(id);
  state.starting.delete(id);
  if (state.selected === id) void select(null);
  schedule("runs", "detail");
}

async function deleteRun(id) {
  if (!window.confirm("Permanently delete this run’s history and activity? Its Git branch and worktree stay available.")) return;
  try {
    await api(`/api/runs/${id}`, { method: "DELETE", body: { confirm: true } });
    forgetRun(id);
    toast("Run history deleted");
  } catch (error) {
    toast(error.message, true);
  }
}

async function stopRun(id) {
  if (state.stopping.has(id)) return;
  state.stopping.add(id);
  schedule("detail");
  try {
    await api(`/api/runs/${id}/control`, { method: "POST", body: { action: "stop" } });
  } catch (error) {
    state.stopping.delete(id);
    schedule("detail");
    toast(error.message, true);
  }
}

async function archiveRun(id, archived) {
  try {
    const { run } = await api(`/api/runs/${id}`, { method: "PATCH", body: { archived } });
    state.runs.set(id, run);
    if (state.selected === id) void select(null);
    schedule("runs", "detail");
    toast(archived ? "Run archived" : "Run restored");
  } catch (error) {
    toast(error.message, true);
  }
}

function openRunControl(id, provider, bundles) {
  const dialog = $("run-control-dialog");
  const form = $("run-control-form");
  form.dataset.runId = id;
  form.dataset.provider = provider ?? "";
  const title = provider ? `Switch to ${providerLabel(provider)}` : "Steer this run";
  $("run-control-title").textContent = title;
  $("run-control-submit").textContent = provider ? "Switch provider" : "Send instruction";
  $("run-control-help").textContent = provider
    ? "Shipyard interrupts the current attempt and starts a fresh agent session on the same worktree."
    : "Shipyard interrupts the current attempt and continues with your instruction.";
  $("run-control-label").textContent = provider ? "Instructions for the new agent (optional)" : "Instructions";
  const input = $("run-control-message");
  input.value = "";
  $("run-control-attachments").value = "";
  reviewChatFiles("run-control-chat-files", bundles);
  input.required = !provider;
  dialog.showModal();
  input.focus();
}

function wireRunControls() {
  $("run-search").addEventListener("input", () => schedule("runs"));
  $("run-repo-filter").addEventListener("change", () => schedule("runs"));
  const statusFilter = $("run-status-filter");
  const runStatuses = ["starting", "running", "waiting", "passed", "failed", "error", "stopped", "interrupted"];
  statusFilter.append(...runStatuses.map((value) => h("option", { value, text: STATUS_LABEL[value] })));
  statusFilter.addEventListener("change", () => schedule("runs"));
  $("archive-toggle").addEventListener("click", () => {
    state.showArchived = !state.showArchived;
    schedule("runs");
  });
  const dialog = $("run-control-dialog");
  $("run-control-cancel").addEventListener("click", () => dialog.close());
  $("run-control-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const { runId, provider } = event.currentTarget.dataset;
    const message = $("run-control-message").value.trim();
    if (!provider && !message) return toast("Enter an instruction for the agent", true);
    const button = $("run-control-submit");
    if (button.disabled) return;
    button.disabled = true;
    try {
      await api(`/api/runs/${runId}/control`, {
        method: "POST",
        body: { action: provider ? "switch-provider" : "steer", provider: provider || undefined, message,
          attachments: await readAttachments($("run-control-attachments")), chatAttachmentIds: chatFileIds("run-control-chat-files") },
      });
      dialog.close();
      toast(provider ? `Switching to ${providerLabel(provider)}` : "Instruction sent");
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
}

function openBudgetIncrease(run, pause) {
  const form = $("run-budget-form");
  const input = $("run-budget-amount");
  form.dataset.runId = run.id;
  input.value = "";
  input.min = String(pause.minimum);
  $("run-budget-context").textContent = `Repository ${run.target} · estimated ${dollars(pause.spent)} used of ${dollars(pause.current)}.`;
  $("run-budget-minimum").textContent = `Enter at least ${dollars(pause.minimum)} to resume this run.`;
  $("run-budget-error").hidden = true;
  $("run-budget-dialog").showModal();
  input.focus();
}

function wireBudgetIncrease() {
  const dialog = $("run-budget-dialog");
  const submit = $("run-budget-submit");
  const cancel = $("run-budget-cancel");
  const error = $("run-budget-error");
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => { if (submit.disabled) event.preventDefault(); });
  $("run-budget-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const { runId } = event.currentTarget.dataset;
    const budgetUsd = $("run-budget-amount").valueAsNumber;
    submit.disabled = cancel.disabled = true;
    state.resuming.add(runId);
    error.hidden = true;
    try {
      await api(`/api/runs/${runId}/resume`, { method: "POST", body: { budgetUsd } });
      dialog.close();
      toast("Budget increased. Resuming run.");
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    } finally {
      state.resuming.delete(runId);
      submit.disabled = cancel.disabled = false;
      schedule("runs", "detail");
    }
  });
}

async function openFeedback(run, message = "", bundles = [], proposalMessageId) {
  if (!state.feedbackReusesBranch) {
    toast("Open the current Shipyard dashboard to revise this branch.", true);
    return;
  }
  if (chat.pending || chat.revisionDraft?.busy) return;
  if (proposalMessageId && launchedChatProposals().has(proposalMessageId)) return;
  if (chat.revisionDraft) {
    if (await select(chat.revisionDraft.runId, { keepChat: true })) $("chat-revision").scrollIntoView({ block: "nearest" });
    return;
  }
  if (!await select(run.id, { details: state.runDetailsOpen, keepChat: true })) return;
  if (message) prepareRevision(run, message, [], bundles, { fromChat: true, proposalMessageId });
  else {
    chat.revisionMode = { runId: run.id, bundles };
    renderChatControls();
    $("chat-input").focus();
  }
}

function prepareRevision(run, message, files, bundles, { fromChat = false, proposalMessageId } = {}) {
  chat.revisionMode = null;
  chat.revisionDraft = { runId: run.id, message, files, bundles, fromChat, proposalMessageId,
    provider: run.provider ?? "claude", browserAccess: Boolean(run.browserAccess ??
      state.targets.find((target) => target.name === run.target)?.browserAccess) };
  renderChatControls();
  renderRevisionDraft();
  $("chat-revision").scrollIntoView({ block: "nearest" });
  $("chat-revision").querySelector("button.btn-primary")?.focus({ preventScroll: true });
}

function renderRevisionDraft() {
  const region = $("chat-revision");
  const draft = chat.revisionDraft;
  region.hidden = !draft || draft.runId !== chat.runId;
  if (region.hidden) {
    region.replaceChildren();
    return;
  }
  const run = state.runs.get(draft.runId);
  const provider = h("select", { "aria-label": "Revision provider", disabled: draft.busy,
    onchange: ({ target }) => { draft.provider = target.value; } }, (state.chatProviders ?? ["claude"]).map((choice) =>
    h("option", { value: choice, text: providerLabel(choice), selected: choice === draft.provider })));
  const browser = h("input", { type: "checkbox", checked: draft.browserAccess, disabled: draft.busy,
    onchange: ({ target }) => { draft.browserAccess = target.checked; } });
  const start = chatButton(draft.busy ? "Starting revision…" : "Start revision", () => startRevision(draft),
    { class: "btn btn-primary btn-sm", disabled: draft.busy });
  region.replaceChildren(
    h("h3", { text: "Review revision" }),
    h("p", { class: "field-help", text: `Continue on the same branch${run?.target ? ` · ${run.target}` : ""}` }),
    h("p", { class: "chat-revision-brief", text: draft.message }),
    h("div", { class: "chat-files" },
      draft.files.map((file, index) => h("span", { class: "chat-file" }, file.name,
        chatButton("Remove", () => { draft.files.splice(index, 1); renderRevisionDraft(); },
          { disabled: draft.busy, "aria-label": `Remove ${file.name}` }))),
      draft.bundles.map((bundle, index) => h("span", { class: "chat-file" }, bundle.files.join(", "),
        chatButton("Remove", () => { draft.bundles.splice(index, 1); renderRevisionDraft(); },
          { disabled: draft.busy, "aria-label": `Remove ${bundle.files.join(", ")}` })))),
    details(`revision-settings:${draft.runId}`, "Revision settings",
      h("div", { class: "chat-revision-settings" }, h("label", {}, "Provider ", provider),
        h("label", {}, browser, " Allow local browser access")), false, "chat-past-options"),
    ...(draft.error ? [h("p", { class: "form-error", role: "alert", text: draft.error })] : []),
    h("div", { class: "actions" }, start,
      chatButton("Edit request", () => {
        chat.revisionDraft = null;
        chat.revisionMode = { runId: draft.runId, bundles: draft.bundles, proposalMessageId: draft.proposalMessageId };
        $("chat-input").value = draft.message;
        chat.files = [...draft.files, ...chat.files];
        renderDraftFiles();
        renderRevisionDraft();
        renderChatControls();
        $("chat-input").focus();
      }, { disabled: draft.busy }),
      chatButton("Dismiss", () => { chat.revisionDraft = null; renderRevisionDraft(); }, { disabled: draft.busy })));
}

async function startRevision(draft) {
  if (draft.busy || chat.revisionDraft !== draft || draft.runId !== chat.runId) return;
  draft.busy = true;
  draft.error = "";
  renderRevisionDraft();
  renderChatControls();
  try {
    const { id } = await api(`/api/runs/${draft.runId}/feedback`, { method: "POST", body: {
      message: draft.message, provider: draft.provider, browserAccess: draft.browserAccess,
      attachments: await readAttachments(draft.files), chatAttachmentIds: draft.bundles.map(({ id }) => id),
    } });
    const source = state.runs.get(draft.runId);
    if (!state.runs.has(id) && source) state.starting.set(id, { request: draft.message, target: source.target, repo: source.repo, provider: draft.provider });
    chat.revisionDraft = null;
    if (!draft.fromChat) appendChat({ role: "user", content: draft.message, runId: draft.runId });
    setRunContext(id);
    appendChat({ role: "assistant", content: "Revision started.", runId: id, runTitle: firstLine(draft.message),
      proposalMessageId: draft.proposalMessageId });
    $("chat-input").focus();
  } catch (error) {
    draft.error = error.message === "Internal error" ? "Shipyard couldn’t start the revision. Your request and files are still here. Try again." : error.message;
  } finally {
    draft.busy = false;
    renderRevisionDraft();
    renderChatControls();
  }
}

const referenceKey = (runId, url) => `${runId}\n${url}`;

function referenceAction(run, url) {
  if (state.referenceDrafts.has(referenceKey(run?.id, url))) return "Review reference";
  return `Continue in ${providerLabel(run?.provider)}`;
}

let shownHandoff;
let handoffRequest = 0;

function openReferenceHandoff(runId, url, itemId = "") {
  const form = $("reference-handoff-form");
  form.dataset.runId = runId;
  form.dataset.url = url;
  form.dataset.itemId = itemId;
  const link = $("reference-handoff-link");
  link.href = url;
  link.textContent = url;
  shownHandoff = undefined;
  $("reference-handoff-text").value = "";
  $("reference-handoff-attachments").value = "";
  $("reference-handoff-status").textContent = "Preparing the handoff…";
  $("reference-handoff-coverage").replaceChildren();
  for (const id of ["continue", "copy", "retry", "revoke", "coverage", "load", "error"]) $("reference-handoff-" + id).hidden = true;
  $("reference-handoff-dialog").showModal();
  void refreshReferenceHandoff(true);
}

function referenceHandoffRequest() {
  const { runId, url, itemId } = $("reference-handoff-form").dataset;
  return { runId, url, itemId, path: `/api/runs/${runId}/references/handoff` };
}

function loadReturnedReference() {
  const draft = shownHandoff?.draft;
  if (draft?.status !== "ready") return;
  $("reference-handoff-text").value = draft.text;
  $("reference-handoff-text").scrollTop = 0;
  $("reference-handoff-load").hidden = true;
}

async function refreshReferenceHandoff(focus = false) {
  const request = ++handoffRequest;
  const { url, itemId, path } = referenceHandoffRequest();
  const dialog = $("reference-handoff-dialog");
  const error = $("reference-handoff-error");
  const status = $("reference-handoff-status");
  try {
    const info = await api(path, { method: "POST", body: { url, itemId } });
    if (!dialog.open || request !== handoffRequest) return;
    const old = shownHandoff;
    shownHandoff = info;
    error.hidden = true;
    const link = $("reference-handoff-continue");
    link.href = info.href;
    link.textContent = `Continue in ${providerLabel(info.provider)}`;
    link.hidden = $("reference-handoff-copy").hidden = Boolean(info.draft);
    $("reference-handoff-retry").hidden = false;
    $("reference-handoff-revoke").hidden = false;
    const coverage = $("reference-handoff-coverage");
    coverage.replaceChildren(
      ...(info.draft?.coverage ?? []).map((line) => h("li", { text: `Read: ${line}` })),
      ...(info.draft?.missing ?? []).map((line) => h("li", { class: "reference-warning", text: `Missing: ${line}` })),
    );
    coverage.hidden = !coverage.childElementCount;
    if (info.draft?.status === "ready") {
      const linkedin = url.startsWith("https://www.linkedin.com/");
      status.textContent = info.draft.missing?.length || (linkedin && (!info.draft.coverage.length || !info.draft.missing))
        ? "The browser returned notes with incomplete or unverified coverage."
        : "Notes returned. Review them before sharing with the crew.";
      const input = $("reference-handoff-text");
      if (!input.value || input.value === old?.draft?.text) loadReturnedReference();
      $("reference-handoff-load").hidden = input.value === info.draft.text;
    } else {
      $("reference-handoff-load").hidden = true;
      status.textContent = info.draft?.status === "blocked" ? info.draft.reason : "Waiting for the provider to return notes.";
    }
    if (focus && !link.hidden) link.focus();
  } catch (err) {
    if (!dialog.open || request !== handoffRequest) return;
    status.textContent = "";
    error.textContent = err.message;
    error.hidden = false;
  }
}

function wireReferenceHandoff() {
  const dialog = $("reference-handoff-dialog");
  const form = $("reference-handoff-form");
  const input = $("reference-handoff-text");
  const close = $("reference-handoff-close");
  const retry = $("reference-handoff-retry");
  const revoke = $("reference-handoff-revoke");
  const submit = $("reference-handoff-submit");
  const status = $("reference-handoff-status");
  const error = $("reference-handoff-error");

  async function revokeHandoff(startNew) {
    const { path, url, itemId } = referenceHandoffRequest();
    revoke.disabled = retry.disabled = true;
    try {
      await api(path, { method: "DELETE", body: { url, itemId } });
      if (startNew) {
        status.textContent = "Preparing a fresh handoff…";
        await refreshReferenceHandoff();
      } else dialog.close();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      revoke.disabled = retry.disabled = false;
    }
  }

  close.addEventListener("click", () => dialog.close());
  retry.addEventListener("click", () => revokeHandoff(true));
  revoke.addEventListener("click", () => revokeHandoff(false));
  $("reference-handoff-load").addEventListener("click", loadReturnedReference);
  $("reference-handoff-copy").addEventListener("click", () => {
    if (shownHandoff) void copy(shownHandoff.prompt, "Browser task");
  });
  dialog.addEventListener("cancel", (event) => { if (close.disabled) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    handoffRequest++;
    shownHandoff = undefined;
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = close.disabled = revoke.disabled = retry.disabled = true;
    error.hidden = true;
    try {
      const { itemId, url } = referenceHandoffRequest();
      const text = input.value.trim();
      const attachments = await readAttachments($("reference-handoff-attachments"));
      if (itemId) {
        await api(`/api/inbox/${itemId}`, { method: "POST", body: { kind: "reference", action: "share", text, attachments } });
        state.inbox.delete(itemId);
      } else {
        const { run } = await api(`/api/runs/${form.dataset.runId}/references/shared`, { method: "POST", body: { url, text, attachments } });
        state.runs.set(run.id, run);
      }
      dialog.close();
      schedule();
      toast(itemId ? "Reference shared with the crew." : "Reference notes saved for the next revision.");
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      submit.disabled = close.disabled = revoke.disabled = retry.disabled = false;
    }
  });
}

function refreshRepoResults(repo) {
  for (const run of state.runs.values()) if (run.repo === repo) state.results.delete(run.id);
  if (state.runs.get(state.selected)?.repo === repo) schedule("detail");
}

function openGitRemote(run) {
  $("git-remote-form").dataset.runId = run.id;
  $("git-remote-context").textContent = `Add origin to the ${run.target} repository.`;
  $("git-remote-url").value = "";
  $("git-remote-error").hidden = true;
  $("git-remote-dialog").showModal();
  $("git-remote-url").focus();
}

function openPublish(run, publication) {
  const form = $("publish-form");
  form.dataset.runId = run.id;
  form.dataset.destination = publication.destination;
  form.dataset.head = publication.head;
  $("publish-destination").textContent = `${publication.remote} · ${publication.label}`;
  $("publish-branch").textContent = run.branch;
  $("publish-commit").textContent = publication.head.slice(0, 12);
  $("publish-status").textContent = "";
  $("publish-error").hidden = true;
  $("publish-dialog").showModal();
  $("publish-submit").focus();
}

function openDraftReview(runId, publication, reopen = false) {
  const view = { runId, reopen, review: null };
  state.draftReview = view;
  $("draft-pr-title").textContent = reopen ? "Reopen pull request" : "Create draft pull request";
  $("draft-pr-dialog").showModal();
  void loadDraftReview(view, publication);
}

async function loadDraftReview(view, publication) {
  const dialog = $("draft-pr-dialog");
  const submit = $("draft-pr-submit");
  const status = $("draft-pr-status");
  const error = $("draft-pr-error");
  const facts = $("draft-pr-facts");
  const conflicts = $("draft-pr-conflicts");
  const description = $("draft-pr-description");
  const regression = $("draft-pr-regression");
  view.review = null;
  submit.disabled = true;
  error.hidden = facts.hidden = conflicts.hidden = regression.hidden = true;
  $("draft-pr-description-field").hidden = true;
  description.disabled = true;
  status.textContent = "Checking the branch and GitHub destination…";
  submit.textContent = view.reopen ? "Approve and reopen PR" : "Approve and create draft PR";
  try {
    if (!publication) {
      const result = await api(`/api/runs/${view.runId}/result`);
      if (!dialog.open || state.draftReview !== view) return;
      state.results.set(view.runId, result);
      publication = result.publish;
      if (publication?.pullRequestUrl) {
        dialog.close();
        schedule("detail");
        toast("Pull request ready");
        return;
      }
      if (!publication) throw new Error("The handoff no longer has a GitHub branch to publish.");
    }
    const { review } = await api(`/api/runs/${view.runId}/draft-pull-request`, { method: "POST",
      body: { action: "review", head: publication.head, destination: publication.destination, reopen: view.reopen } });
    if (!dialog.open || state.draftReview !== view) return;
    view.review = review;
    description.value = view.description ?? review.description;
    description.maxLength = review.descriptionMaxLength;
    description.disabled = false;
    if (review.regressionNotes) {
      regression.replaceChildren(h("p", { class: "field-help", text: "Shipyard adds this evidence to the draft description." }), md(review.regressionNotes));
      regression.hidden = false;
    }
    $("draft-pr-description-field").hidden = false;
    facts.replaceChildren(...[
      ["Repository", new URL(review.repository).pathname.slice(1)], ["Base", `${review.base.branch} · ${review.base.head.slice(0, 12)}`], ["Branch", review.branch],
      ...(review.reopen ? [["Pull request", `#${review.reopen.number}`]] : []),
    ].flatMap(([label, value]) => [h("dt", { text: label }), h("dd", { class: "mono", text: value })]));
    facts.hidden = false;
    if (review.transplant?.conflicts.length) {
      $("draft-pr-conflict-files").replaceChildren(...review.transplant.conflicts.map((file) => h("li", { text: file })));
      conflicts.hidden = false;
    }
    status.textContent = review.reopen ? "Shipyard will push the verified commit if needed and reopen this pull request with the description below." : review.transplant
      ? "Shipyard will verify a new branch based on GitHub’s default branch, push it, and open a draft. The original branch is available as a backup."
      : "Shipyard will push the verified commit if needed and open a draft pull request.";
    submit.disabled = false;
    submit.focus();
  } catch (err) {
    if (!dialog.open || state.draftReview !== view) return;
    status.textContent = "";
    error.textContent = err.message;
    error.hidden = false;
    submit.textContent = "Review again";
    submit.disabled = false;
  }
}

function wireDraftReview() {
  const dialog = $("draft-pr-dialog");
  const cancel = $("draft-pr-cancel");
  const submit = $("draft-pr-submit");
  const error = $("draft-pr-error");
  const status = $("draft-pr-status");
  const description = $("draft-pr-description");
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => { if (cancel.disabled) event.preventDefault(); });
  $("draft-pr-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const view = state.draftReview;
    if (!view || submit.disabled) return;
    if (!view.review) return loadDraftReview(view);
    if (!description.value.trim()) {
      error.textContent = "Enter a description for the pull request.";
      error.hidden = false;
      description.focus();
      return;
    }
    view.description = description.value;
    description.disabled = true;
    submit.disabled = cancel.disabled = true;
    error.hidden = true;
    status.textContent = view.reopen ? "Reopening the pull request…" : view.review.transplant ? "Verifying the compatible branch and opening the draft…" : "Opening the draft pull request…";
    try {
      const { result } = await api(`/api/runs/${view.runId}/draft-pull-request`, { method: "POST",
        body: { action: "create", token: view.review.token, description: view.description } });
      state.results.set(view.runId, result);
      dialog.close();
      toast(view.reopen ? "Pull request reopened" : "Draft pull request ready");
    } catch (err) {
      state.results.delete(view.runId);
      view.review = null;
      status.textContent = "";
      error.textContent = err.message;
      error.hidden = false;
      submit.textContent = "Review again";
    } finally {
      description.disabled = !view.review;
      cancel.disabled = submit.disabled = false;
      schedule("detail");
    }
  });
}

async function createPullRequest(runId, { destination, head }, draft) {
  if (state.pullRequestPending.has(runId)) return;
  state.pullRequestPending.set(runId, draft);
  schedule("detail");
  try {
    const result = await api(`/api/runs/${runId}/pull-request`, { method: "POST", body: { destination, head, draft } });
    state.results.set(runId, result);
    toast("Pull request ready");
  } catch (error) {
    toast(error.message, true);
    state.results.delete(runId);
  } finally {
    state.pullRequestPending.delete(runId);
    schedule("detail");
  }
}

function wirePublish() {
  const dialog = $("publish-dialog");
  const form = $("publish-form");
  const submit = $("publish-submit");
  const cancel = $("publish-cancel");
  const status = $("publish-status");
  const error = $("publish-error");
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => { if (submit.disabled) event.preventDefault(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const { runId, destination, head } = form.dataset;
    submit.disabled = cancel.disabled = true;
    status.textContent = "Pushing the run branch…";
    error.hidden = true;
    try {
      const result = await api(`/api/runs/${runId}/publish`, { method: "POST", body: { destination, head } });
      state.results.set(runId, result);
      dialog.close();
      toast("Branch pushed");
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      state.results.delete(runId);
    } finally {
      status.textContent = "";
      submit.disabled = cancel.disabled = false;
      schedule("detail");
    }
  });
}

function openCloudRelease(runId) {
  const form = $("cloud-release-form");
  form.reset();
  form.dataset.runId = runId;
  const run = state.runs.get(runId);
  $("cloud-release-repo").textContent = run ? `Repository ${run.target} · ${run.repo}` : "";
  $("cloud-release-cancel").textContent = "Cancel";
  $("cloud-release-submit").hidden = false;
  $("cloud-release-status").textContent = "";
  setCloudReleaseReview(null);
  $("cloud-release-dialog").showModal();
  form.elements.project.focus();
}

function setCloudReleaseReview(review) {
  const form = $("cloud-release-form");
  form.dataset.reviewToken = review?.token ?? "";
  $("cloud-release-target").disabled = Boolean(review);
  $("cloud-release-review").hidden = !review;
  $("cloud-release-edit").hidden = !review;
  $("cloud-release-error").hidden = true;
  $("cloud-release-submit").textContent = review ? "Approve and create revision" : "Review release";
  const facts = review ? [
    ["Google Cloud account", review.account],
    ["Runtime identity", review.runtimeIdentity ?? "Service default"],
    ["Target", `${review.project} / ${review.region} / ${review.service}`],
    ["Image", review.image],
    ["Run commit", review.head.slice(0, 12)],
    ["Revision", review.revision],
  ] : [];
  $("cloud-release-details").replaceChildren(...facts.flatMap(([label, value]) => [
    h("dt", { text: label }), h("dd", { class: "mono cloud-release-value", text: value }),
  ]));
}

function wireCloudRelease() {
  const dialog = $("cloud-release-dialog");
  const form = $("cloud-release-form");
  const submit = $("cloud-release-submit");
  const cancel = $("cloud-release-cancel");
  const edit = $("cloud-release-edit");
  const status = $("cloud-release-status");
  const error = $("cloud-release-error");
  cancel.addEventListener("click", () => dialog.close());
  edit.addEventListener("click", () => {
    setCloudReleaseReview(null);
    status.textContent = "";
    form.elements.project.focus();
  });
  dialog.addEventListener("cancel", (event) => {
    if (submit.disabled) event.preventDefault();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled || submit.hidden) return;
    const { runId, reviewToken } = form.dataset;
    const body = reviewToken ? { action: "deploy", token: reviewToken, confirm: true }
      : { action: "prepare", ...Object.fromEntries(new FormData(form)) };
    submit.disabled = cancel.disabled = edit.disabled = true;
    $("cloud-release-target").disabled = true;
    error.hidden = true;
    status.textContent = reviewToken ? "Waiting for Cloud Run to confirm the revision…" : "Checking the Google Cloud account and service…";
    try {
      const result = await api(`/api/runs/${runId}/cloud-release`, { method: "POST", body });
      if (result.review) {
        setCloudReleaseReview(result.review);
        status.textContent = "Confirm the deployment details above.";
      } else {
        setCloudReleaseReview(null);
        $("cloud-release-target").disabled = true;
        submit.hidden = true;
        cancel.textContent = "Close";
        status.textContent = `Revision ${result.release.revision} is ready with no traffic.`;
        loadResult(runId);
      }
    } catch (failure) {
      setCloudReleaseReview(null);
      status.textContent = "";
      error.textContent = failure.message;
      error.hidden = false;
    } finally {
      submit.disabled = cancel.disabled = edit.disabled = false;
      (submit.hidden ? cancel : submit).focus();
    }
  });
}

function wireGitRemote() {
  const dialog = $("git-remote-dialog");
  const form = $("git-remote-form");
  const button = $("git-remote-submit");
  const cancel = $("git-remote-cancel");
  const error = $("git-remote-error");
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => { if (button.disabled) event.preventDefault(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    const id = form.dataset.runId;
    const url = $("git-remote-url").value.trim();
    button.disabled = true;
    button.textContent = "Saving origin…";
    cancel.disabled = true;
    error.hidden = true;
    try {
      await api(`/api/runs/${id}/remote`, { method: "POST", body: { url } });
      refreshRepoResults(state.runs.get(id)?.repo);
      dialog.close();
      toast("Git remote saved as origin");
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = "Save origin";
      cancel.disabled = false;
    }
  });
}

async function openBranchPreparation(run) {
  const dialog = $("branch-preparation-dialog");
  const planText = $("branch-preparation-plan");
  const error = $("branch-preparation-error");
  const submit = $("branch-preparation-submit");
  const name = $("branch-preparation-name");
  state.branchPreparation = { runId: run.id };
  planText.textContent = "Reading the commits on this branch…";
  name.value = "";
  submit.disabled = true;
  error.hidden = true;
  dialog.showModal();
  const opening = state.branchPreparation;
  try {
    const { plan } = await api(`/api/runs/${run.id}/prepare-branch`);
    if (state.branchPreparation !== opening || !dialog.open) return;
    opening.plan = plan;
    planText.textContent = `Combine ${plan.commits} commit${plan.commits === 1 ? "" : "s"} into one, based on ${plan.base.slice(0, 8)}.`;
    name.value = plan.name;
    submit.disabled = false;
    name.focus();
  } catch (err) {
    if (state.branchPreparation !== opening || !dialog.open) return;
    planText.textContent = "";
    error.textContent = err.message;
    error.hidden = false;
  }
}

function wireBranchPreparation() {
  const dialog = $("branch-preparation-dialog");
  const cancel = $("branch-preparation-cancel");
  const submit = $("branch-preparation-submit");
  const error = $("branch-preparation-error");
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => { if (cancel.disabled) event.preventDefault(); });
  $("branch-preparation-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const { runId, plan } = state.branchPreparation ?? {};
    if (!plan || submit.disabled) return;
    cancel.disabled = submit.disabled = true;
    submit.textContent = "Verifying…";
    error.hidden = true;
    try {
      const { run } = await api(`/api/runs/${runId}/prepare-branch`, { method: "POST", body: {
        name: $("branch-preparation-name").value.trim(), head: plan.head, base: plan.base, confirm: true,
      } });
      state.runs.set(runId, run);
      state.results.delete(runId);
      dialog.close();
      schedule();
      toast("Squashed branch verified and ready.");
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      cancel.disabled = submit.disabled = false;
      submit.textContent = "Verify and create branch";
    }
  });
}

async function openRunQuestion(run, question = "") {
  if (!await select(run.id, { keepChat: true, details: state.runDetailsOpen })) return;
  const input = $("chat-input");
  input.focus();
  if (question && !chat.pending && !chat.revisionMode && !input.value && !chat.files.length) {
    void askChat(question, run.id, undefined, { runQuestion: true });
  } else if (question) $("chat-status").textContent = `Suggested question · ${question}`;
}

function runAnswerControls(runId, answer, question, ask, messageId) {
  const links = (answer.links ?? []).filter(({ url }) => /^https:\/\//.test(url)).map(({ label, url }) =>
    h("a", { class: "btn btn-sm", href: url, target: "_blank", rel: "noopener noreferrer", text: label }));
  const primary = [];
  const related = [...links];
  const publishing = isDeployCommand(normalizeRunCommand(question ?? ""));
  for (const { label, action } of answer.actions ?? []) {
    const provider = Object.hasOwn(DEPLOYMENT_ACTIONS, action) ? DEPLOYMENT_ACTIONS[action] : undefined;
    const recommended = action === answer.review || publishing && (provider || ["draft-pr", "reopen-pr"].includes(action));
    const button = chatButton(label, async () => {
      if (action === "deployment") return void ask("Is it deployed?");
      const run = state.runs.get(runId);
      if (!run) return toast("This run is no longer available", true);
      if (action === "draft-pr" || action === "reopen-pr") openDraftReview(runId, undefined, action === "reopen-pr");
      if (action === "open-latest-revision" || action === "open-deployment") {
        try {
          const result = await api(`/api/runs/${runId}/result`);
          const nextRunId = action === "open-latest-revision" ? result.latestRevisionId : deploymentNextStep(run, result)?.action?.runId;
          if (nextRunId && await select(nextRunId)) {
            renderChatControls();
            if (!focusDecisionCard(deploymentDecisionId(nextRunId))) $("chat-run-update").scrollIntoView({ block: "nearest" });
          }
        } catch (error) { toast(error.message, true); }
      }
      if (action === "cloud-release") openCloudRelease(runId);
      if (provider) void updateDeploymentRun(runId, "review", provider);
      if (action === "budget") {
        try {
          const result = state.results.get(runId);
          const info = result && !result.loading ? result : await api(`/api/runs/${runId}/result`);
          if (info.budgetPause) openBudgetIncrease(run, info.budgetPause);
        } catch (error) { toast(error.message, true); }
      }
      if (action === "checks") void verifyRunResult(runId);
      if (action === "preview") openRunPreview(runId);
      if (action === "revision") openFeedback(run, question);
    }, recommended ? { class: "btn btn-primary btn-sm" } : undefined);
    (recommended ? primary : related).push(button);
  }
  const controls = related.length ? h("div", { class: "actions" }, related) : null;
  const secondary = controls && (related.length > 1 || primary.length)
    ? details(`chat:${messageId}:related-actions`, "Related actions", controls, false, "chat-past-options") : controls;
  return primary.length ? [h("div", { class: "actions" }, primary), secondary] : secondary;
}

async function updateDeploymentRun(runId, action, provider, review) {
  if (deploymentPending.has(runId)) return;
  const originChat = chat.id;
  deploymentPending.add(runId);
  schedule("detail");
  try {
    const { run } = await api(`/api/runs/${runId}/deployment`, {
      method: "POST", body: action === "deploy" ? { action, token: review.token, confirm: true } : { action, provider },
    });
    state.runs.set(run.id, run);
    if (run.id !== runId) {
      state.results.delete(runId);
      if (chat.id === originChat) {
        setRunContext(run.id);
        appendChat({ role: "assistant", runId: run.id, runTitle: run.request, content: "Deployment review started." });
      } else toast("Deployment review started.");
    }
  } catch (error) {
    toast(error.message, true);
  } finally {
    deploymentPending.delete(runId);
    schedule("runs", "detail", "meta", "inbox");
  }
}

function deploymentFactList(run, facts, checks) {
  const scope = run.deployment.provider === "firebase" ?
    [["Firebase project", facts.project], ["Hosting site", facts.site], ["Account", facts.account]] :
    [["GitHub repository", new URL(facts.repository).pathname.slice(1)], ["Workflow", facts.workflow], ["Environment", facts.environment]];
  return h("dl", { class: "run-result-facts" }, [
    ["Branch", facts.branch], ["Commit", facts.head.slice(0, 12), facts.head], ...scope,
    ...(checks?.length ? [["Passed checks", checks.join(", ")]] : []),
  ].flatMap(([label, value, title]) => [
    h("dt", { text: label }), h("dd", { class: "mono cloud-release-value", text: value, title }),
  ]));
}

function deploymentApprovalCard(run, review, busy) {
  const deployment = run.deployment;
  const provider = DEPLOYMENT_PROVIDERS[deployment.provider];
  return h("article", { class: "card chat-decision-card", "data-id": deploymentDecisionId(run.id),
    "aria-label": "Deployment approval", tabindex: "-1" },
  h("header", { class: "card-head" },
    h("span", { class: "kind kind-checkpoint", text: "Deployment approval" }),
    h("span", { class: "card-from", text: provider })),
  h("div", { class: "card-body" },
    h("p", { text: deployment.provider === "firebase" ? "Approval publishes this commit to the live hosting site." :
      "Approval starts this GitHub Actions workflow for the reviewed commit and environment." }),
    deploymentFactList(run, review, review.checks),
    h("div", { class: "actions" },
      chatButton("Approve and deploy", () => updateDeploymentRun(run.id, "deploy", deployment.provider, review),
        { class: "btn btn-primary btn-sm", disabled: busy }),
      !deployment.dispatchStarted ? chatButton("Cancel deployment", () => updateDeploymentRun(run.id, "cancel"), { disabled: busy }) : null),
  ));
}

function renderDeployment(run) {
  const deployment = run.deployment;
  const status = runStatus(run);
  const busy = deploymentPending.has(run.id) || state.active.has(run.id);
  const provider = DEPLOYMENT_PROVIDERS[deployment.provider];
  const workflow = deployment.workflowRun;
  const usesWorkflow = deployment.provider !== "firebase";
  const release = run.firebaseRelease;
  const review = deployment.review ?? deployment.workflowReview;
  const facts = release ?? review;
  const awaitingApproval = deployment.phase === "approval";
  const link = (label, url) => typeof url === "string" && /^https:\/\//.test(url) ?
    h("a", { href: url, target: "_blank", rel: "noopener noreferrer", text: label }) : null;
  return h("div", { class: "detail-inner" },
    h("section", { class: "run-head" },
      h("div", { class: "run-head-top" }, h("h1", { text: run.request }),
        h("span", { class: `pill s-${status}`, text: status === "interrupted" ? "Interrupted" : DEPLOYMENT_PHASE_LABEL[deployment.phase] })),
      runRepository(run),
    ),
    h("section", { class: "run-result", "aria-label": "Deployment run" },
      h("h2", { text: `${provider} deployment` }),
      status === "interrupted" ? h("p", { text: deployment.dispatchStarted ?
        "GitHub may have received the request. Check Actions history for the workflow before starting another deployment." :
        "Shipyard was interrupted. Start verification again when ready." }) :
        awaitingApproval ? h("p", { text: "Review the destination and commit in the conversation." }) :
        deployment.phase === "verifying" ? h("p", { role: "status", text: usesWorkflow ?
          "Checking the GitHub commit, deployment workflow, and environment…" : "Checking the GitHub commit, project tests, and Firebase site…" }) :
        deployment.phase === "publishing" ? h("p", { role: "status", text: usesWorkflow ?
          workflow ? `GitHub Actions status · ${workflow.status.replaceAll("_", " ")}` : "Starting the approved workflow…" :
          "Publishing the reviewed commit to Firebase Hosting…" }) :
        deployment.phase === "published" && usesWorkflow ? h("p", { text: "GitHub Actions reported success for the reviewed commit." }) :
        release ? h("p", { text: `Firebase confirmed this release on ${new Date(release.deployedAt).toLocaleString()}.` }) : null,
      run.error ? h("p", { class: "run-result-error", role: "alert", text: run.error }) : null,
      facts && !awaitingApproval ? deploymentFactList(run, facts, review?.checks) : null,
      h("div", { class: "run-result-links" },
        awaitingApproval && review ? chatButton("Review approval in chat", () => focusDeploymentApproval(run.id),
          { class: "link", disabled: busy }) : null,
        workflow ? link("View GitHub Actions run", workflow.url) : usesWorkflow && facts ?
          link("View GitHub workflow", `${facts.repository}/actions/workflows/${encodeURIComponent(facts.workflow)}`) : null,
        link("Open live site", facts?.url), link("View merged PR", deployment.pullRequest),
        state.runs.has(deployment.sourceRunId) ? h("a", { href: `#run/${deployment.sourceRunId}`, text: "Open source run" }) : null,
      ),
    ),
  );
}

async function copy(text, label = "Branch name") {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} copied`);
  } catch {
    toast(`Couldn't copy the ${label.toLowerCase()}`, true);
  }
}

function unauthorized(sessionChanged = false) {
  document.title = "shipyard";
  document.body.replaceChildren(
    h(
      "div",
      { class: "empty" },
      h("h1", { text: sessionChanged ? "shipyard ui restarted with a new link" : "Open the link from your terminal" }),
      h("p", {
        text: sessionChanged
          ? "This tab belongs to an earlier session. Open the link that `shipyard ui` printed in your terminal; your runs and their history are all still there."
          : "For safety, shipyard ui only accepts the private link it printed when it started (it includes a private token). Copy that link into this browser.",
      }),
    ),
  );
}

function tick() {
  for (const el of document.querySelectorAll("[data-time]")) el.textContent = ago(el.dataset.time);
  const run = state.selected && state.runs.get(state.selected);
  if (run && state.active.has(run.id)) {
    const el = $("elapsed");
    if (el) el.textContent = workingTime(run);
  }
}

async function refreshRegressionHead() {
  const id = state.selected;
  const result = state.results.get(id);
  if (document.hidden || !result?.handoff?.regression || result.latestRevisionId || state.verificationPending.has(id)) return;
  try {
    const { head } = await api(`/api/runs/${id}/result?head=1`);
    if (state.results.get(id) === result && head !== result.handoff.head) {
      state.results.delete(id);
      schedule("detail");
    }
  } catch {
    // A normal result refresh will surface any persistent errors.
  }
}

const CHAT_STORAGE = "shipyard.chat.v1";
const CHAT_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const chat = { id: crypto.randomUUID(), messages: [], removed: [], files: [], target: "", provider: "", runId: null, pending: null, proposal: null,
  workKey: "", contextKey: "", history: [], historyReady: false, historyError: "", writes: Promise.resolve(true), navigation: 0, cached: false,
  booting: true, savedMessages: new Set(), drafts: new Map(), revisionMode: null, revisionDraft: null, runAction: null };
const chatButton = (text, action, options = {}) => h("button", { type: "button", class: "btn btn-sm", text, onclick: action, ...options });
const chatStageLabel = (stage, role) => ({ implement: role === "dependency-updater" ? "Dependency updater" : "Implementer",
  revise: "Revision if requested", "security-recheck": "Security recheck after code changes", harden: "Security fixes if needed", repair: "Repair if E2E fails" })[stage] ?? roleLabel(role);
const conditionalChatStages = new Set(["revise", "security-recheck", "harden", "repair"]);

function reviewsOverlap(run) {
  if (!run.parallelReviews) return false;
  const reviews = run.stages?.filter(({ name }) => name === "review" || name === "security") ?? [];
  return reviews.length ? reviews.some(({ parallel }) => parallel) : true;
}

function executionOrder(names, parallel) {
  if (!parallel || !names.includes("review") || !names.includes("security")) return names;
  return names.filter((name) => name !== "security").flatMap((name) => name === "review" ? [name, "security"] : [name]);
}

function chatSequence({ kind, crew = [], implementer, parallelReviews }) {
  const stages = new Set(["implement", ...crew]);
  if (stages.has("review")) stages.add("revise");
  if (stages.has("security")) stages.add("harden");
  if (parallelReviews) stages.add("security-recheck");
  return executionOrder(PIPELINE_ORDER.filter((stage) => stages.has(stage)), parallelReviews).map((name) => ({ name,
    role: STAGE_ROLE[name] ?? implementer ?? (kind === "deps" ? "dependency-updater" : "backend"),
    parallel: parallelReviews && ["review", "security"].includes(name) }));
}

function chatTimeline(stages) {
  if (!stages.length) return null;
  const chip = ({ name, role, status }) => h("span", {
    class: `chat-stage${status ? ` s-${status}` : ""}`, title: CREW.find(({ stage }) => stage === name)?.what },
    avatar(role, true), h("span", { class: "chat-stage-name", text: chatStageLabel(name, role) }),
    status && status !== "conditional" ? h("small", { text: STATUS_LABEL[status] ?? status }) : null);
  const parallel = stages.filter((stage) => stage.parallel);
  return h("ol", { class: "chat-timeline", "aria-label": "Subagents in execution order" }, stages.flatMap((stage) => {
    if (!stage.parallel || parallel.length < 2) return [h("li", {}, chip(stage))];
    return stage === parallel[0] ? [h("li", {}, h("div", { class: "chat-parallel-group" },
      h("strong", { class: "chat-parallel-label", text: "Parallel reviews" }), ...parallel.map(chip)))] : [];
  }));
}

function chatRunStarted(message) {
  return message.role === "assistant" && message.runId && (message.runTitle || /^Run started for [\w.-]+\.$/.test(message.content ?? ""));
}

function rememberChatTab() {
  try {
    sessionStorage.setItem(CHAT_STORAGE, JSON.stringify({ id: chat.id, messages: chat.messages.slice(-40), removed: chat.removed.slice(-40),
      target: chat.target, provider: chat.provider, runId: chat.runId }));
  } catch { /* Chat still works when storage is unavailable. */ }
}

function renderChatHistory() {
  const list = $("chat-history-list");
  const selected = chat.id;
  list.replaceChildren(...chat.history.map((entry) => h("li", {},
    chatButton(entry.title, () => void openSavedChat(entry.id), { class: `chat-history-item${selected === entry.id ? " selected" : ""}`,
      title: entry.title, "aria-current": selected === entry.id ? "true" : undefined }))));
  const status = $("chat-history-status");
  status.textContent = chat.historyError || (!chat.historyReady ? "Loading chats…" : chat.history.length ? "" : "No saved chats yet.");
  status.hidden = !status.textContent;
}

function rememberSavedChat(saved) {
  if (chat.history.some((entry) => entry.id === saved.id && entry.updatedAt > saved.updatedAt)) return;
  chat.history = [saved, ...chat.history.filter((entry) => entry.id !== saved.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  chat.historyReady = true;
  renderChatHistory();
}

function saveChat({ context = true } = {}) {
  rememberChatTab();
  if (!chat.messages.length && !chat.removed.length) return Promise.resolve(true);
  const id = chat.id;
  const known = chat.savedMessages;
  const body = { messages: chat.messages.filter((message) => !known.has(message.id)), removed: chat.removed.slice(-40),
    context: { target: chat.target, provider: chat.provider, runId: chat.runId }, preserveContext: !context };
  if (!state.selected && !location.hash.startsWith("#chat/")) history.replaceState(null, "", `#chat/${id}`);
  chat.writes = chat.writes.then(async () => {
    try {
      const unseen = body.messages.filter((message) => !known.has(message.id));
      for (let offset = 0; offset < Math.max(1, unseen.length); offset += 40) {
        const messages = unseen.slice(offset, offset + 40);
        const { chat: saved } = await api(`/api/chat/history/${id}`, { method: "PATCH", body: { ...body, messages } });
        for (const message of messages) known.add(message.id);
        rememberSavedChat(saved);
      }
      chat.historyError = "";
      return true;
    } catch {
      chat.historyError = "Chat couldn’t be saved to disk. Keep this tab open until Shipyard reconnects.";
      return false;
    } finally { renderChatHistory(); }
  });
  return chat.writes;
}

async function refreshChatHistory() {
  try {
    const { chats } = await api("/api/chat/history");
    const combined = new Map(chat.history.map((entry) => [entry.id, entry]));
    for (const saved of chats) {
      if (!combined.has(saved.id) || combined.get(saved.id).updatedAt < saved.updatedAt) combined.set(saved.id, saved);
    }
    chat.history = [...combined.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    chat.historyReady = true;
    renderChatHistory();
  } catch {
    if (!chat.historyReady) {
      chat.historyError = "Saved chats are unavailable. Shipyard will retry when it reconnects.";
      renderChatHistory();
    }
  }
}

function rememberChatDraft() {
  const text = $("chat-input").value;
  if (text || chat.files.length || chat.revisionMode || chat.revisionDraft) {
    chat.drafts.set(chat.id, { text, files: chat.files, revisionMode: chat.revisionMode, revisionDraft: chat.revisionDraft });
  } else chat.drafts.delete(chat.id);
}

function resetChatDraft(id) {
  const draft = chat.drafts.get(id);
  chat.id = id;
  chat.files = draft?.files ?? [];
  chat.revisionMode = draft?.revisionMode ?? null;
  chat.revisionDraft = draft?.revisionDraft ?? null;
  chat.runAction = null;
  $("chat-input").value = draft?.text ?? "";
  $("chat-status").textContent = "";
  renderDraftFiles();
  renderRevisionDraft();
  renderRunAction();
}

async function openSavedChat(id, { runId, details = false } = {}) {
  if (chat.pending || chat.revisionDraft?.busy) {
    toast("Wait for the current request before switching chats.");
    return false;
  }
  const request = ++chat.navigation;
  try {
    if (!await chat.writes && chat.messages.length && !await saveChat()) return false;
    const { chat: saved } = await api(`/api/chat/history/${id}`);
    if (request !== chat.navigation || chat.pending || chat.revisionDraft?.busy) return false;
    rememberChatDraft();
    resetChatDraft(saved.id);
    Object.assign(chat, { messages: saved.messages, savedMessages: new Set(saved.messages.map(({ id }) => id)), removed: [],
      target: saved.context.target, provider: saved.context.provider, cached: true });
    const linkedRun = runId ?? saved.context.runId;
    setRunContext(state.runs.has(linkedRun) || state.starting.has(linkedRun) ? linkedRun : null, details);
    rememberChatTab();
    renderChatThread();
    renderChatControls();
    return true;
  } catch (error) {
    if (request === chat.navigation && error.code !== "chat-not-found") toast(`Couldn’t open the saved chat. ${error.message}`, true);
    return false;
  }
}

async function restoreChatHistory() {
  const navigation = chat.navigation;
  const runId = initialSelection();
  const linked = location.hash.match(/^#chat\/([a-f0-9-]+)$/i)?.[1];
  // Earlier Shipyard versions stored chats in the tab only. Write that copy before loading the shared list.
  if (chat.messages.length) await saveChat({ context: !chat.cached });
  await refreshChatHistory();
  if (runId && navigation === chat.navigation) {
    const owningChat = chat.history.find((entry) => entry.runIds?.includes(runId));
    if (owningChat) await openSavedChat(owningChat.id, { runId });
    else await select(runId);
    return;
  }
  const requested = linked && chat.history.find((entry) => entry.id === linked);
  const sameTab = chat.history.find((entry) => entry.id === chat.id);
  const latest = !chat.cached && !chat.messages.length ? chat.history[0] : undefined;
  const next = requested ?? sameTab ?? latest;
  if (next && navigation === chat.navigation) await openSavedChat(next.id);
  else if (chat.runId && state.runs.has(chat.runId)) setRunContext(chat.runId);
}

async function showChatForRun(runId) {
  if (await select(runId)) $("chat-input").focus();
}

function renderChatControls() {
  const target = $("chat-target");
  const placeholder = state.config || !chat.booting ? "No repository selected" : "Loading repositories…";
  const showLocal = state.config?.canAddTargets;
  const repoKey = JSON.stringify([placeholder, state.targets, showLocal, state.localRepos, state.localRepoStatus]);
  if (chat.repoKey !== repoKey) {
    chat.repoKey = repoKey;
    target.replaceChildren(h("option", { value: "", text: placeholder }));
    if (state.targets.length) target.append(h("optgroup", { label: "Added repositories" },
      state.targets.map(({ name, path }) => h("option", { value: name, text: name, title: path }))));
    if (showLocal && (state.localRepos.length || state.localRepoStatus)) target.append(h("optgroup", { label: "Local repositories • add to use" },
      state.localRepos.map(({ name, path, displayPath }) => h("option", { value: `local:${path}`, text: name, title: displayPath, "data-repo": displayPath })),
      state.localRepoStatus ? h("option", { disabled: true, text: state.localRepoStatus }) : null));
  }
  target.value = state.targets.some(({ name }) => name === chat.target) ? chat.target : "";
  $("chat-add-repo").hidden = !state.config?.canAddTargets;
  const providers = state.chatProviders ?? ["claude"];
  for (const option of $("chat-provider").options) option.disabled = !providers.includes(option.value);
  $("chat-provider-field").hidden = providers.length < 2;
  $("chat-provider").value = [chat.provider, state.config?.defaultProvider, ...providers].find((provider) => providers.includes(provider));

  const work = $("chat-work");
  const active = [...new Set([...state.active, ...state.starting.keys()])].flatMap((id) => {
    const run = state.runs.get(id) ?? state.starting.get(id);
    if (!run || run.finishedAt) return [];
    return [{ id, target: run.target, request: firstLine(run.request), status: run.id ? runStatus(run) : "starting" }];
  });
  const workKey = JSON.stringify([chat.runId, active]);
  if (chat.workKey !== workKey) {
    chat.workKey = workKey;
    work.hidden = !active.some(({ id }) => id !== chat.runId);
    if (work.hidden) work.open = false;
    $("chat-work-label").textContent = active.length > 1 ? `${active.length} runs in parallel` : "Active run";
    $("chat-work-list").replaceChildren(...active.map(({ id, target, request, status }) => h("li", {},
      h("button", { type: "button", class: "chat-run-link", "aria-current": id === chat.runId ? "true" : undefined,
        "aria-label": `${target} · ${request}`,
        onclick: () => { work.open = false; showChatForRun(id); } },
      h("span", {}, h("strong", { text: target }), h("span", { class: "chat-run-request", title: request, text: request })),
      h("span", { class: `pill s-${status}`, text: STATUS_LABEL[status] ?? status })))));
  }

  renderInlineRunDecisions();
  const context = $("chat-context");
  const runId = chat.runId;
  const run = state.runs.get(runId) ?? state.starting.get(runId);
  const launch = chat.messages.findLast((message) => message.runId === runId && chatRunStarted(message));
  const request = firstLine(run?.request);
  const description = launch?.runTitle ?? request;
  const title = description.length <= 66 ? description : run?.followUp ? "Revision" : run?.deployment ? "Deployment" : "Run";
  // Revisions can have a different sequence. Show the actual stage records for those runs.
  const actual = (run?.stages ?? []).map((stage) => ({ name: stage.name, role: stage.repairRole ?? stage.role, status: stageStatus(run, stage), parallel: stage.parallel }));
  const planned = run?.crew && !run.followUp ? chatSequence({ ...run, parallelReviews: reviewsOverlap(run) }) : [];
  const stages = planned.length ? planned.map((stage) => actual.find(({ name }) => name === stage.name) ??
    { ...stage, status: run.finishedAt ? "skipped" : conditionalChatStages.has(stage.name) ? "conditional" : "queued" }) : actual;
  const status = run?.id ? runStatus(run) : "starting";
  const result = run?.finishedAt && !run.deployment && completionLabel(run) ? finishedResult(run.id) : null;
  renderChatRunUpdate(run, run ? runSummary(run, result) : null);
  const expanded = state.runDetailsOpen;
  const contextKey = JSON.stringify([runId, title, request, run?.target, status, stages, expanded]);
  if (chat.contextKey !== contextKey) {
    chat.contextKey = contextKey;
    context.hidden = !run;
    context.classList.toggle("show-details", expanded);
    $("run-overview").replaceChildren(...(run ? [
      h("div", { class: "chat-context-meta" }, h("span", { class: "chat-context-repo", text: run.target }),
        h("span", { class: `pill s-${status}`, text: status === "passed" ? "Complete" : STATUS_LABEL[status] ?? status })),
      h("h2", { class: "chat-context-title", text: title || "Run progress", title: request }),
      expanded || run.finishedAt ? null : chatTimeline(stages),
      h("div", { class: "chat-context-actions" },
        chatButton(expanded ? "Hide details" : "Run details", () => {
          const thread = $("chat-thread");
          const following = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 64;
          state.runDetailsOpen = !state.runDetailsOpen;
          renderDetail();
          if (following) thread.scrollTop = thread.scrollHeight;
          $("run-overview").querySelector("[aria-controls=detail]")?.focus();
        }, { "aria-expanded": String(expanded), "aria-controls": "detail" }),
        chatButton("Back to planning", () => showChatForRun(null), { class: "btn btn-ghost btn-sm" })),
    ].filter(Boolean) : []));
  }
  $("chat-settings").hidden = Boolean(run);
  renderCommandMenu(run, result ?? undefined);
  $("chat-revision-mode").hidden = !chat.revisionMode;
  $("chat-input").maxLength = chat.revisionMode ? 8000 : 3500;
  $("chat-input").placeholder = chat.revisionMode ? "Describe what should change in this revision" :
    run ? "Ask about this run or type a command like “open preview”" : "Describe a change or ask about your options";
  $("chat-submit").textContent = chat.revisionMode ? "Review revision" : "Send";
  $("chat-submit").disabled = !state.config || chat.booting || Boolean(chat.pending || chat.revisionDraft?.busy);
  $("chat-cancel").hidden = !chat.pending;
}

function reviewChatOption(option, provider, bundles, messageId) {
  const target = state.targets.some(({ name }) => name === option.target) ? option.target :
    state.targets.some(({ name }) => name === chat.target) ? chat.target : state.targets.length === 1 ? state.targets[0].name : "";
  const proposal = { ...option, provider, bundles, messageId };
  if (!state.targets.length && state.config?.canAddTargets) return openAddRepo((name) => openNewRun(name, proposal));
  if (!state.targets.length) return toast("Add a repository before starting a run", true);
  openNewRun(target, proposal);
}

function renderChatOption(option, provider, bundles, messageId) {
  const parallelReviews = option.crew.includes("review") && option.crew.includes("security");
  return h("article", { class: "chat-option" },
    h("h3", { text: option.title }),
    h("p", { text: option.detail }),
    chatTimeline(chatSequence({ ...option, parallelReviews })),
    h("div", { class: "chat-option-actions" },
      chatButton("Review setup", () => reviewChatOption(option, provider, bundles, messageId), { "aria-label": `Review setup for ${option.title}` }),
      option.target ? h("span", { class: "field-help", text: option.target }) : null),
  );
}

function selectChatTarget(name) {
  if (!state.targets.some((target) => target.name === name)) return toast("This repository is no longer configured", true);
  chat.target = name;
  chat.runId = null;
  renderChatControls();
  appendChat({ role: "assistant", content: `Using ${name} for your next request.` });
  $("chat-input").focus();
}

function chatRepoActions(actions) {
  return h("div", { class: "actions" }, actions.map((action) => {
    if (action.kind === "use-target") return chatButton(action.label, () => selectChatTarget(action.target));
    if (action.kind === "add-repo" && state.config?.canAddTargets) return chatButton(action.label, () => openAddRepo(selectChatTarget, action.locator));
  }));
}

function renderChatFailure({ failure, runId, provider }) {
  const label = provider ? providerLabel(provider) : "Shipyard";
  let [title, detail, command] = ["Shipyard couldn’t reply", "Retry or edit your message.", ""];
  const providerFailure = failure.code.startsWith("provider-");
  switch (failure.code) {
    case "provider-auth":
      title = `${label} needs authentication`;
      if (provider === "claude" && failure.auth === "api-key") detail = "Check the Claude API credentials used to launch Shipyard, then restart the dashboard and retry.";
      else {
        detail = `Sign in to ${label} from a terminal with `;
        command = provider === "codex" ? "codex login" : "claude auth login";
      }
      break;
    case "provider-unavailable":
      title = `${label} is unavailable`;
      detail = `Check that ${label} is installed and available to the dashboard, then retry.`;
      break;
    case "provider-limit":
      title = `${label} reached a usage limit`;
      detail = "Wait for the limit to reset or try another provider.";
      break;
    case "provider-timeout":
      title = `${label} took too long to reply`;
      detail = "Retry the message or try another provider.";
      break;
    case "provider-response":
      title = `${label} returned an unreadable reply`;
      detail = "Retry the message or try another provider.";
      break;
    case "dashboard-auth":
      title = "Your dashboard session needs to be reopened";
      detail = "Open the dashboard using the current link printed by ";
      command = "npm run shipyard -- ui-link";
      break;
    case "connection":
      title = "Can’t reach the Shipyard dashboard";
      detail = "Check that Shipyard is running and then retry.";
      break;
    default:
      if (failure.detail) detail = failure.detail;
      if (providerFailure) title = `${label} couldn’t reply`;
  }
  const retry = (next = provider) => {
    if (chat.pending) return;
    if (next) chat.provider = next;
    void askChat(failure.request, runId, next);
    $("chat-input").focus();
  };
  const alternate = providerFailure && provider && (state.chatProviders ?? []).find((candidate) => candidate !== provider);
  return h("article", { class: "chat-message chat-error", tabindex: "-1" },
    h("div", { role: "alert" }, h("h3", { text: title }), h("p", {}, detail, command ? h("code", { text: command }) : null, command ? "." : null)),
    h("div", { class: "actions" },
      alternate ? chatButton(`Retry with ${providerLabel(alternate)}`, () => retry(alternate), { class: "btn btn-sm btn-primary" }) : null,
      chatButton(providerFailure ? `Retry ${label}` : "Retry message", () => retry()),
      chatButton("Edit message", () => { $("chat-input").value = failure.request; $("chat-input").focus(); }),
    ),
  );
}

function renderChatMessage(message, launched) {
  if (message.failure) return renderChatFailure(message);
  const { id, role, content, runId, options, provider, answer, question, steer, repoActions, bundle, bundles, revision, web } = message;
  if (chatRunStarted(message)) return h("div", { class: "chat-run-event", "data-run-id": runId },
    h("button", { type: "button", class: "link", text: content,
      onclick: () => state.runs.has(runId) || state.starting.has(runId) ? select(runId) : toast("This run is no longer available", true) }));
  const cards = options?.length ? h("div", { class: "chat-options" }, options.map((option) => renderChatOption(option, provider, bundles, id))) : null;
  const sources = web?.sources.filter(({ url }) => /^https?:\/\//i.test(url)) ?? [];
  const webLabel = web?.searched ? "Searched the web" : "Read public pages";
  return h("article", { class: `chat-message chat-${role}` },
    h("strong", { class: "chat-byline", text: role === "user" ? "You" : "Shipyard" }),
    role === "user" ? h("p", { class: "chat-text", text: content }) : md(content, "chat-text"),
    bundle ? h("div", { class: "chat-files" }, bundle.files.map((name) => h("span", { class: "chat-file", text: name }))) : null,
    sources.length ? h("section", { "aria-label": "Web sources" },
      details(`chat:${id}:sources`, `${webLabel} · ${sources.length} ${sources.length === 1 ? "source" : "sources"}`,
        h("ul", {}, sources.map(({ title, url }) => h("li", {},
          h("a", { href: url, target: "_blank", rel: "noopener noreferrer", text: title })))), false, "chat-sources")) :
      web ? h("p", { class: "chat-sources", text: webLabel }) : null,
    cards && launched ? details(`chat:${id}:options`, cards.childElementCount === 1 ? "Run proposal" : "Run proposals", cards, false, "chat-past-options") : cards,
    repoActions?.length ? chatRepoActions(repoActions) : null,
    answer && runId ? runAnswerControls(runId, answer, question, (text) => askChat(text, runId), id) : null,
    role === "assistant" && runId && (steer || revision && !launched) ? h("div", { class: "actions" },
      steer ? chatButton("Review instruction", () => {
        if (!state.active.has(runId)) return toast("This run is no longer active", true);
        openRunControl(runId, undefined, bundles);
        $("run-control-message").value = question;
      }) : null,
      revision && !launched ? chatButton("Review revision", () => {
        const run = state.runs.get(runId);
        if (run) openFeedback(run, question, bundles, id);
      }) : null,
    ) : null,
  );
}

function launchedChatProposals() {
  return new Set(chat.messages.flatMap((message, index) => {
    if (!chatRunStarted(message)) return [];
    if (message.proposalMessageId) return [message.proposalMessageId];
    const previous = chat.messages[index - 1];
    if (previous?.options?.length) return [previous.id];
    if (message.content === "Revision started." && previous?.revision && firstLine(previous.question) === message.runTitle) return [previous.id];
    return [];
  }));
}

function renderChatThread() {
  const thread = $("chat-thread");
  const messages = $("chat-messages");
  const update = $("chat-run-update");
  const launched = launchedChatProposals();
  messages.replaceChildren(...chat.messages.map((message) => renderChatMessage(message, launched.has(message.id))));
  const latest = messages.lastElementChild;
  if (!chat.messages.length) {
    const inRun = Boolean(chat.runId);
    const suggestions = inRun ? ["Summarize progress", "What needs my attention?"] : ["Search the web", "Plan a feature", "Investigate a bug", "Update dependencies"];
    messages.append(h("div", { class: "chat-welcome" },
      h("h2", { text: inRun ? "Ask about this run" : "What do you want to work on?" }),
      inRun ? null : h("p", { text: "Describe the outcome. Shipyard can help you choose an approach and assemble a crew." }),
      h("div", { class: "actions" },
        !inRun && state.config?.canAddTargets ? chatButton("Add a repo", () => openAddRepo(selectChatTarget)) : null,
        suggestions.map((label) => chatButton(label, () => {
          $("chat-input").value = inRun ? label : `${label}: `;
          $("chat-input").focus();
        })),
      ),
    ));
  }
  placeChatRunUpdate(update, chat.runId);
  renderInlineRunDecisions();
  if (latest) {
    const top = latest.getBoundingClientRect().top - thread.getBoundingClientRect().top;
    thread.scrollTop += top;
  }
}

function appendChat(message) {
  chat.messages.push({ ...message, id: crypto.randomUUID() });
  saveChat();
  renderChatThread();
}

function renderDraftFiles() {
  $("chat-files").replaceChildren(...chat.files.map((file, index) => h("span", { class: "chat-file" }, file.name,
    chatButton("Remove", () => { chat.files.splice(index, 1); renderDraftFiles(); }, { "aria-label": `Remove ${file.name}` }))));
}

function addChatFiles(files) {
  const next = [...chat.files, ...files];
  const mb = 1024 * 1024;
  if (next.length > 6 || next.some((file) => file.size > 3 * mb) || next.reduce((size, file) => size + file.size, 0) > 8 * mb) {
    appendChat({ role: "assistant", content: "**Attachment limit reached**\n\nSend up to six files per message, up to 3 MB each and 8 MB total." });
    return;
  }
  chat.files = next;
  renderDraftFiles();
}

async function askChat(text, runId = chat.runId, selectedProvider, { runQuestion = false } = {}) {
  if (chat.pending || (!text && !chat.files.length)) return;
  text ||= "Review the attached files and tell me what you find.";
  const run = state.runs.get(runId);
  const inRun = Boolean(run || state.starting.has(runId));
  const provider = selectedProvider ?? (inRun ? run?.provider ?? $("chat-provider").value : $("chat-provider").value);
  const pending = { id: crypto.randomUUID(), controller: new AbortController(), text };
  chat.pending = pending;
  const input = $("chat-input");
  const status = $("chat-status");
  input.value = "";
  status.textContent = "Preparing a reply…";
  renderChatControls();
  const scope = inRun ? runId : undefined;
  const previous = chat.messages.at(-1);
  if (previous?.failure?.request === text && previous.runId === scope) {
    chat.messages.pop();
    chat.removed.push(previous.id);
    saveChat();
    renderChatThread();
  }
  const signal = pending.controller.signal;
  try {
    const last = chat.messages.at(-1);
    const picked = [...chat.files];
    const bundle = picked.length ? await api("/api/chat/attachments", { method: "POST", body: { attachments: await readAttachments(picked) }, signal }) : undefined;
    if (chat.pending !== pending) return;
    if (bundle) {
      chat.files = chat.files.filter((file) => !picked.includes(file));
      renderDraftFiles();
    }
    if (bundle || last?.role !== "user" || last.content !== text || last.runId !== scope) appendChat({ role: "user", content: text, runId: scope, bundle });
    const thread = chat.messages.filter((message) => message.runId === scope && !message.failure).slice(-12);
    const bundles = thread.flatMap((message) => message.bundle ? [message.bundle] : []);
    const messages = thread.map(({ role, content, options, web }) => ({
      role, content: [content, options?.length ? JSON.stringify(options) : "", web?.sources.map(({ title, url }) => `${title}: ${url}`).join("\n")]
        .filter(Boolean).join("\n").slice(0, 3500),
    }));
    const runAnswer = runQuestion ? await api(`/api/runs/${runId}/question`, { method: "POST",
      body: { question: typeof runQuestion === "string" ? runQuestion : text }, signal }) : undefined;
    const result = runAnswer ? { text: [runAnswer.heading, ...runAnswer.details].join("\n\n"), options: [], runAnswer } :
      await api("/api/chat", { method: "POST", body: { messages, target: run?.target ?? $("chat-target").value, provider,
        attachmentIds: bundles.map(({ id }) => id), runId: scope, turnId: pending.id, conversationId: chat.id, firstRecentId: thread[0]?.id }, signal });
    if (typeof result.text !== "string" || !result.text.trim() || !Array.isArray(result.options)) {
      throw Object.assign(new Error("The chat reply was unreadable."), { code: "provider-response" });
    }
    const reply = { content: result.text, options: inRun ? [] : result.options, repoActions: result.repoActions, provider, bundles, runId: scope,
      web: result.web, answer: result.runAnswer, question: text, steer: inRun && state.active.has(runId),
      revision: Boolean(run?.finishedAt && !run.deployment && !result.runAnswer) };
    if (chat.pending === pending) {
      appendChat({ role: "assistant", ...reply });
      status.textContent = "";
    }
  } catch (error) {
    if (chat.pending !== pending) return;
    status.textContent = "";
    const code = error.unauthorized ? "dashboard-auth" : error.code ?? (error instanceof TypeError ? "connection" : "request");
    appendChat({ role: "assistant", runId: scope, provider, failure: { code, request: text,
      detail: code === "request" ? error.message : undefined, auth: state.config?.auth } });
    if (!input.value) input.value = text;
  } finally {
    if (chat.pending === pending) {
      chat.pending = null;
      renderChatControls();
    }
  }
}

function wireChat() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(CHAT_STORAGE) ?? "null");
    if (saved && Array.isArray(saved.messages)) {
      const cached = typeof saved.id === "string" && CHAT_ID.test(saved.id);
      Object.assign(chat, { id: cached ? saved.id : chat.id, cached,
        messages: saved.messages.map((message) => ({ ...message, id: CHAT_ID.test(message.id ?? "") ? message.id : crypto.randomUUID() })),
        removed: Array.isArray(saved.removed) ? saved.removed.filter((id) => CHAT_ID.test(id)) : [],
        target: saved.target ?? "", provider: saved.provider ?? "", runId: saved.runId ?? null });
    }
  } catch { /* An unreadable transcript starts a fresh chat. */ }
  renderChatThread();
  $("show-chat").addEventListener("click", () => $("chat-input").focus());
  $("chat-cancel").addEventListener("click", () => {
    const pending = chat.pending;
    if (!pending) return;
    chat.pending = null;
    pending.controller.abort();
    if (!$("chat-input").value) $("chat-input").value = pending.text;
    $("chat-status").textContent = "Reply cancelled.";
    renderChatControls();
    $("chat-input").focus();
  });
  $("chat-reset").addEventListener("click", async () => {
    if (chat.revisionDraft?.busy) return;
    const navigation = ++chat.navigation;
    chat.pending?.controller.abort();
    chat.pending = null;
    if (!await saveChat() || navigation !== chat.navigation) return;
    rememberChatDraft();
    resetChatDraft(crypto.randomUUID());
    chat.savedMessages = new Set();
    chat.cached = true;
    chat.messages = [];
    chat.removed = [];
    setRunContext(null);
    renderChatThread();
    renderChatControls();
    $("chat-input").focus();
  });
  $("chat-target").addEventListener("change", ({ target }) => {
    const locator = target.selectedOptions[0]?.dataset.repo;
    if (locator) {
      renderChatControls();
      void openAddRepo(selectChatTarget, locator);
      return;
    }
    chat.target = target.value;
    saveChat();
  });
  $("chat-provider").addEventListener("change", (event) => { chat.provider = event.target.value; saveChat(); });
  $("chat-add-repo").addEventListener("click", () => openAddRepo(selectChatTarget));
  const picker = $("chat-attachment-input");
  const composer = $("chat-form");
  $("chat-attach").addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => { addChatFiles(picker.files); picker.value = ""; });
  composer.addEventListener("dragover", (event) => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  });
  composer.addEventListener("drop", (event) => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    addChatFiles(event.dataTransfer.files);
  });
  $("chat-input").addEventListener("paste", (event) => {
    if (!event.clipboardData?.files.length) return;
    event.preventDefault();
    addChatFiles(event.clipboardData.files);
  });
  $("chat-cancel-revision-mode").addEventListener("click", () => {
    chat.revisionMode = null;
    renderChatControls();
    $("chat-input").focus();
  });
  $("chat-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if ($("chat-submit").disabled) return;
    const input = $("chat-input");
    const text = input.value.trim();
    if (!chat.revisionMode) {
      if (!submitRunCommand(text)) void askChat(text);
      return;
    }
    const run = state.runs.get(chat.revisionMode.runId);
    if (!run || (!text && !chat.files.length && !chat.revisionMode.bundles.length)) return;
    const { bundles, proposalMessageId } = chat.revisionMode;
    if (!chat.files.length && !bundles.length && /^(?:(?:is|was|has|did)\b.*\bdeploy\w*\b.*\?|it[’'´]?s\s+deployed\s*\?|deploy(?:\s+(?:it|this|now))*[.!]?)$/i.test(text)) {
      chat.revisionMode = null;
      return void askChat(text, run.id);
    }
    const files = chat.files;
    input.value = "";
    chat.files = [];
    renderDraftFiles();
    prepareRevision(run, text || "Revise this run using the attached feedback.", files, bundles, { proposalMessageId });
  });
  $("chat-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!$("chat-submit").disabled) $("chat-form").requestSubmit();
    }
  });
}

async function main() {
  $("new-run").addEventListener("click", openNewRun);
  $("inbox-toggle").addEventListener("click", () => ($("inbox").classList.contains("open") ? closeInboxDrawer() : openInboxDrawer()));
  $("inbox-close").addEventListener("click", closeInboxDrawer);
  $("notifications-enable").addEventListener("click", async () => {
    try {
      if (await Notification.requestPermission() === "granted") toast("Desktop alerts enabled");
    } catch (error) {
      toast(error.message, true);
    } finally {
      schedule("meta");
    }
  });
  window.addEventListener("hashchange", () => {
    const id = location.hash.match(/^#run\/([\w-]+)$/)?.[1];
    if (id && id !== state.selected && state.runs.has(id)) select(id);
    const chatId = location.hash.match(/^#chat\/([a-f0-9-]+)$/i)?.[1];
    if (chatId) void openSavedChat(chatId);
  });
  wireNewRun();
  wireChat();
  wireAddRepo();
  wireRunControls();
  wireBudgetIncrease();
  wireBranchPreparation();
  wireGitRemote();
  wirePublish();
  wireDraftReview();
  wireCloudRelease();
  wireReferenceHandoff();
  try {
    await loadState();
    await restoreChatHistory();
    renderChatThread();
  } catch (err) {
    if (err.unauthorized) return unauthorized();
    toast(`Couldn't load shipyard: ${err.message}`, true);
  } finally {
    chat.booting = false;
    renderChatControls();
  }
  connect();
  setInterval(tick, 1000);
  setInterval(refreshRegressionHead, 5000);
  setInterval(() => schedule("runs"), 30_000);
}

main();
