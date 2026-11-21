// shipyard ui client. No framework, no build step.
// Everything agents write is untrusted text: it only ever reaches the page through textContent.

const STAGE_ROLE = {
  orchestrate: "orchestrator",
  triage: "bug-triager",
  plan: "planner",
  design: "ui-ux",
  review: "reviewer",
  security: "security-auditor",
  e2e: "e2e-tester",
  docs: "docs-writer",
  release: "release-manager",
};
/** implement, revise, harden and repair belong to the run's implementer. */
const stageRole = (name, run) => STAGE_ROLE[name] ?? run?.implementer ?? "backend";
const PIPELINE_ORDER = ["triage", "plan", "implement", "design", "review", "revise", "security", "harden", "e2e", "repair", "docs", "release"];
const roleLabel = (role) => ({ orchestrator: "Orchestrator", "ui-ux": "UI/UX specialist", "dependency-updater": "Dependency updater", "docs-writer": "Docs writer", "e2e-tester": "E2E tester" })[role] ?? role;
const KIND_LABEL = { feature: "Feature", bug: "Bug fix", deps: "Dependency update" };
const KIND_SHORT = { feature: "ship", bug: "fix", deps: "deps" };

/** Did a gate go the way it should? For a bug triage the tests must fail: that proves the bug. */
const gateOk = (g) => (g.expectFailure ? g.code !== 0 && !g.timedOut : g.code === 0);
function gateLabel(g) {
  const base = `${gateOk(g) ? "✓" : "✕"} ${g.command} · ${secs(g.durationMs)}${g.code === 0 ? "" : ` · exit ${g.code}`}`;
  if (!g.expectFailure) return base;
  return `${base} · ${gateOk(g) ? "fails as expected: bug reproduced" : "passes: bug not reproduced"}`;
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
  redirected: "Redirected",
  changes: "Changes requested",
};

const state = {
  config: null,
  stages: [],
  targets: [],
  runs: new Map(),
  active: new Set(),
  inbox: new Map(),
  referenceDrafts: new Map(),
  events: new Map(), // runId -> events, once loaded
  buffers: new Map(), // runId -> events that arrived while its history was loading
  lastActivity: new Map(), // runId -> last tool/text event
  starting: new Map(), // runId -> request, until its first record arrives
  open: new Map(), // <details> open state, so re-renders keep what you expanded
  selected: null,
  focusHandoff: null,
  showArchived: false,
  stopping: new Set(),
  resuming: new Set(),
  results: new Map(),
  previewPending: new Set(),
  localAppPending: new Set(),
  browserPending: new Set(),
  verificationPending: new Set(),
  pullRequestPending: new Set(),
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
  "bug-triager": "BUG",
  "security-auditor": "SEC",
  "dependency-updater": "DEP",
};
const initials = (role) => INITIALS[role] ?? role.slice(0, 2).toUpperCase();

const avatar = (role, small) => h("span", { class: `avatar role-${role}${small ? " sm" : ""}`, "aria-hidden": "true", text: initials(role) });

// ── Derived state ────────────────────────────────────────

const inboxFor = (runId, stage) => [...state.inbox.values()].filter((i) => i.runId === runId && (!stage || i.stage === stage));

function runStatus(run) {
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
  return { passed: "Run completed", failed: "Run failed", stopped: "Run stopped", error: "Run ended with an error" }[run.status];
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
  return waiting > 0 ? `${secs(wall - waiting)} working · ${secs(waiting)} waiting for you` : secs(wall);
}

// ── API ──────────────────────────────────────────────────

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw Object.assign(new Error(data.error || "Not signed in"), { unauthorized: true });
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function loadState() {
  const s = await api("/api/state");
  state.config = s.config;
  state.acceptsAttachments = s.acceptsAttachments === true;
  state.stages = s.stages;
  state.efforts = s.efforts;
  state.codexEfforts = s.codexEfforts;
  state.roles = s.roles;
  state.targets = s.targets;
  state.runs = new Map(s.runs.map((r) => [r.id, r]));
  state.results.clear();
  state.active = new Set(s.active);
  state.inbox = new Map(s.inbox.map((i) => [i.id, i]));
  state.referenceDrafts = new Map((s.referenceHandoffs ?? []).map(({ runId, url, status }) => [referenceKey(runId, url), status]));
  if ($("new-run-dialog").open) {
    fillTargets(); // after a reconnect, an open dialog shows the current repos
    updateCrew();
  }
  if (!state.selected || (!state.runs.has(state.selected) && !state.starting.has(state.selected))) state.selected = initialSelection();
  schedule();
  if (state.selected) loadEvents(state.selected);
  if ($("reference-handoff-dialog").open) void refreshReferenceHandoff();
}

async function readAttachments(input) {
  const files = [...input.files];
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
  const runs = visibleRuns();
  return (runs.find((r) => state.active.has(r.id)) ?? runs[0])?.id ?? null;
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

// ── Live updates ─────────────────────────────────────────

function connect() {
  const es = new EventSource("/api/stream");
  es.addEventListener("open", () => {
    setConn("live");
    if (state.wasDown) {
      state.wasDown = false;
      state.events.clear();
    }
    // Reconcile any completions that landed between loading the page and subscribing.
    loadState().catch(() => {});
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
    if (event.type === "tool" || event.type === "text") state.lastActivity.set(runId, event);
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
    schedule(runId === state.selected ? "detail" : null, "runs");
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
  on("run-error", ({ runId, error }) => {
    state.starting.delete(runId);
    toast(`Couldn't start the run: ${error}`, true);
    if (state.selected === runId) state.selected = initialSelection();
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
  else if (state.config?.defaultProvider === "codex") {
    meta.append(h("span", { text: `Default Codex · ${state.config.codex?.model ?? "CLI default"} · saved CLI sign-in` }));
  } else if (state.config) {
    const auth = state.config.auth === "subscription" ? "your subscription" : "API key";
    const cap = state.config.maxBudgetUsdPerRun ? ` · up to ${dollars(state.config.maxBudgetUsdPerRun)} a run` : "";
    meta.append(h("span", { text: `Default Claude · ${state.config.model} · effort ${state.config.effort} · runs on ${auth}${cap}` }));
  }
  const n = state.inbox.size + unreadResults().length + activeReferenceAlerts().length;
  for (const el of [$("inbox-count"), $("inbox-toggle-count")]) {
    el.textContent = String(n);
    el.classList.toggle("has", n > 0);
  }
  document.title = n ? `(${n}) shipyard` : "shipyard";
  $("notifications-enable").hidden = !("Notification" in window) || Notification.permission !== "default";
  $("new-run").disabled = state.targets.length === 0 && !state.config?.canAddTargets;
}

// ── Runs column ──────────────────────────────────────────

function renderRuns() {
  const list = $("run-list");
  const items = [];
  for (const [id, request] of state.showArchived ? [] : state.starting) {
    if (state.runs.has(id)) continue;
    items.push(runItem({ id, title: firstLine(request), status: "starting", meta: "starting…" }));
  }
  const runs = visibleRuns();
  for (const run of runs) {
    const status = runStatus(run);
    const waiting = inboxFor(run.id).length;
    const live = state.active.has(run.id) ? state.lastActivity.get(run.id) : null;
    items.push(
      runItem({
        id: run.id,
        title: firstLine(run.request),
        status,
        badge: waiting ? waiting : null,
        meta: `${run.target} · ${KIND_SHORT[run.kind] ?? run.kind} · ${providerLabel(run.provider)} · ${ago(run.createdAt)} · ${usageLabel(run.totals)}`,
        live: live ? (live.type === "tool" ? `${live.tool} ${live.detail}` : live.text) : null,
      }),
    );
  }
  const empty = state.showArchived ? "No archived runs." : "No runs yet. Start one with New run.";
  list.replaceChildren(...(items.length ? items : [h("li", { class: "list-empty", text: empty })]));
  const running = state.active.size;
  $("runs-sub").textContent = !state.showArchived && running ? `${running} running` : runs.length ? `${runs.length} total` : "";
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

function select(id) {
  if (state.focusHandoff !== id) state.focusHandoff = null;
  state.selected = id;
  if (id) {
    state.showArchived = Boolean(state.runs.get(id)?.archivedAt);
    history.replaceState(null, "", `#run/${id}`);
    if (!state.events.has(id)) loadEvents(id);
  } else {
    history.replaceState(null, "", location.pathname + location.search);
  }
  schedule("runs", "detail");
  closeInboxDrawer();
}

function viewResult(run) {
  state.focusHandoff = run.id;
  select(run.id);
  void acknowledgeResult(run);
}

// ── Detail column ────────────────────────────────────────

function renderDetail() {
  const root = $("detail");
  const run = state.selected ? state.runs.get(state.selected) : null;

  if (!run && state.selected && state.starting.has(state.selected)) {
    root.replaceChildren(
      h("div", { class: "detail-inner" }, h("div", { class: "run-head" }, h("h1", { text: firstLine(state.starting.get(state.selected)) }), h("div", { class: "working" }, h("span", { class: "spinner" }), "Creating the worktree…"), runActions({ id: state.selected, status: "running" }))),
    );
    return;
  }
  if (!run) {
    root.replaceChildren(
      h(
        "div",
        { class: "empty" },
        h("h1", { text: "Point the crew at a repo" }),
        h("p", { text: "Start a run and watch each agent work in its own git worktree. Questions, permission requests and checkpoints land in Needs you. Nothing leaves your machine." }),
        state.targets.length || !state.config?.canAddTargets
          ? h("button", { type: "button", class: "btn btn-primary", onclick: openNewRun, disabled: state.targets.length === 0 }, "New run")
          : h("button", { type: "button", class: "btn btn-primary", onclick: openAddRepo }, "Add a repo"),
        state.targets.length === 0 && !state.config?.canAddTargets ? h("p", { class: "field-help", text: "Add a target repo to shipyard.config.yaml first." }) : null,
      ),
    );
    return;
  }

  const status = runStatus(run);
  const assignments = revisionAssignments(run);
  const waiting = inboxFor(run.id);
  const result = run.finishedAt && completionLabel(run) ? finishedResult(run.id) : undefined;
  const recovery = result && (run.status === "failed" || run.status === "error" || result.recheckStage);
  const checking = recovery && (state.verificationPending.has(run.id) || result.savedEditsCheck === "checking");
  const badge = recovery ? checking ? "Checking saved edits" : result.savedEditsCheck === "passed" ? "Ready to continue" : "Action needed" : STATUS_LABEL[status] ?? status;
  const events = state.events.get(run.id);
  const focused = document.activeElement;
  const restoreHandoff = root.contains(focused) && focused.id === "run-handoff";
  const disclosure = root.contains(focused) && focused.matches("details[data-disclosure] > summary") ? focused.parentElement : null;
  if (disclosure) state.open.set(disclosure.dataset.disclosure, disclosure.open);
  const inner = h(
    "div",
    { class: "detail-inner" },
    h(
      "section",
      { class: "run-head" },
      h("div", { class: "run-head-top" }, h("h1", { text: run.followUp ? "Revision" : run.request }), h("span", { class: `pill s-${recovery ? "waiting" : status}`, text: badge })),
      recovery ? recoveryHandoff(run, result, checking) : null,
      run.followUp ? h("div", { class: "feedback-brief" },
        h("strong", { text: "Your feedback" }),
        h("p", { text: run.request }),
        state.runs.has(run.followUp.runId) ? h("button", { type: "button", class: "btn btn-sm", onclick: () => select(run.followUp.runId) }, "View source run") : null,
      ) : null,
      h(
        "div",
        { class: "run-facts" },
        h("span", { class: "chip", text: run.target }),
        h("span", { class: "chip", text: KIND_LABEL[run.kind] ?? run.kind }),
        h("span", { class: "chip", text: providerLabel(run.provider) }),
        h("span", { class: "chip", title: run.model, text: `${modelLabel(run.model)}${run.effort ? ` · ${run.effort}` : ""}` }),
        h(
          "span",
          { class: "chip mono", title: run.worktree },
          h("span", { class: "chip-text", text: run.branch }),
          h("button", { type: "button", "aria-label": "Copy branch name", onclick: () => copy(run.branch) }, "copy"),
        ),
        h("span", { class: "chip", title: run.totals.costUsd == null ? undefined : "Claude usage estimated at API prices", text: spend(run) }),
        run.totals.usage ? h("span", { class: "chip", text: tokens(run.totals.usage) }) : null,
        h("span", { class: "chip", id: "elapsed", text: workingTime(run) }),
        h("span", { class: "chip", text: `${run.totals.attempts} attempt${run.totals.attempts === 1 ? "" : "s"}` }),
      ),
      !run.finishedAt ? runActions(run) : null,
    ),
    waiting.length
      ? h(
          "div",
          { class: "banner", role: "status" },
          waiting[0].kind === "reference" ? `${waiting.length === 1 ? "1 reference needs" : `${waiting.length} references need`} your input in Needs you.` :
            `${waiting.length === 1 ? "An agent is" : `${waiting.length} agents are`} waiting for your answer`,
          h("button", { type: "button", class: "btn btn-sm", onclick: () => focusItem(waiting[0].id) }, "Review"),
        )
      : null,
    result ? runResult(run, result, recovery) : null,
    run.finishedAt ? runActions(run) : null,
    renderPipeline(run, assignments),
    assignments.length ? details(`${run.id}:assignments`, "Specialist assignments", h("ol", { class: "revision-assignments" },
      assignments.map(({ role, task }) => h("li", {}, h("strong", { text: roleLabel(role) }), h("p", { text: task }))),
    ), true) : null,
    h("section", { class: "lanes", "aria-label": "Agents" }, run.stages.map((stage) => renderLane(run, stage, events))),
    events === undefined ? h("div", { class: "working" }, h("span", { class: "spinner" }), "Loading activity…") : null,
  );
  const scroll = root.scrollTop;
  root.replaceChildren(inner);
  if (disclosure) {
    root.querySelector(`details[data-disclosure="${CSS.escape(disclosure.dataset.disclosure)}"] > summary`)?.focus({ preventScroll: true });
  }
  root.scrollTop = scroll;
  const handoffHeading = $("run-handoff");
  if (handoffHeading && state.focusHandoff === run.id) {
    state.focusHandoff = null;
    handoffHeading.focus({ preventScroll: true });
    handoffHeading.scrollIntoView({ block: "start" });
  } else if (restoreHandoff) handoffHeading?.focus({ preventScroll: true });
}

function loadResult(runId) {
  const pending = { loading: true };
  state.results.set(runId, pending);
  api(`/api/runs/${runId}/result`)
    .then((result) => { if (state.results.get(runId) === pending) state.results.set(runId, result); })
    .catch((error) => { if (state.results.get(runId) === pending) state.results.set(runId, { error: error.message }); })
    .finally(() => { if (state.selected === runId) schedule("detail"); });
}

function finishedResult(runId) {
  if (!state.results.has(runId)) loadResult(runId);
  return state.results.get(runId);
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
    publication?.pushed ? `Branch pushed to ${publication.label}.` :
    publication ? `Ready to push to ${publication.label}.` :
    result.publishUnavailable ?? (result.hasRemote ? "No completed branch changes to push." : "Git remote status unavailable.");
  const previewBusy = state.previewPending.has(run.id);
  const localAppBusy = state.localAppPending.has(run.id) || result.localApp?.starting;
  const browserBusy = state.browserPending.has(run.id);
  const pullRequestBusy = state.pullRequestPending.has(run.id);
  const button = (label, onclick, disabled = false) =>
    h("button", { type: "button", class: "btn btn-sm", text: label, onclick, disabled });
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
    !run.cleanedUp ? h("dl", { class: "run-result-facts" },
      h("dt", { text: "Branch" }), h("dd", { class: "mono", text: run.branch }),
      run.status === "passed" ? [h("dt", { text: "Pull request" }), h("dd", { class: "git-remote-status" },
        h("span", { text: gitStatus }),
        result.hasRemote === false ? button("Connect Git remote", () => openGitRemote(run)) : null,
        publication && !publication.pushed ? button("Push branch", () => openPublish(run, publication)) : null,
        publication?.pullRequestUrl ? h("a", {
          class: "btn btn-primary btn-sm", href: publication.pullRequestUrl, target: "_blank", rel: "noopener noreferrer", text: "Open PR on GitHub",
        }) : publication?.compareUrl ? [
          h("button", { type: "button", class: "btn btn-primary btn-sm", disabled: pullRequestBusy,
            text: pullRequestBusy ? "Creating PR…" : "Create PR on GitHub", onclick: () => createPullRequest(run.id, publication) }),
          h("a", { class: "btn btn-sm", href: publication.compareUrl, target: "_blank", rel: "noopener noreferrer", text: "Compare on GitHub" }),
        ] : publication?.pullRequestUnavailable ? h("span", { text: publication.pullRequestUnavailable }) : null,
      )] : null,
    ) : null,
    result.error ? h("p", { class: "run-result-error", text: result.error }) : null,
    h("div", { class: "run-result-actions" },
      run.status === "passed" && !run.cleanedUp ? button("Give feedback", () => openFeedback(run)) : null,
      !recovery && !run.cleanedUp ? button("Copy worktree path", () => copy(run.worktree, "Worktree path")) : null,
      result.localApp?.url ? [
        h("a", { class: "btn btn-primary btn-sm", href: result.localApp.url, target: "_blank", rel: "noopener noreferrer", text: "Open local app" }),
        button(localAppBusy ? "Stopping app…" : "Stop local app", () => updateLocalApp(run.id, "DELETE"), localAppBusy),
      ] : result.canRunLocally ? h("button", { type: "button", class: "btn btn-primary btn-sm", disabled: localAppBusy,
        text: localAppBusy ? "Local app agent is starting…" : "Run locally", onclick: () => updateLocalApp(run.id, "POST") }) : null,
      recovery ? null : result.previewUrl ? [
        h("a", { class: "btn btn-primary btn-sm", href: result.previewUrl, target: "_blank", rel: "noopener noreferrer", text: "Open local preview" }),
        button(previewBusy ? "Stopping…" : "Stop preview", () => updatePreview(run.id, "DELETE"), previewBusy),
      ] : result.canPreview ? h("button", { type: "button", class: "btn btn-primary btn-sm", text: previewBusy ? "Opening preview…" : "Open local preview", disabled: previewBusy, onclick: () => openRunPreview(run.id) }) : null,
      result.canPreview && run.status === "passed" ? button(browserBusy ? "Running browser check…" : "Run browser check", () => checkRunBrowser(run.id), browserBusy) : null,
    ),
    result.canPreview && run.status === "passed" ? h("p", { class: "browser-run-status", role: "status", text: browserBusy ? "Testing desktop and phone layouts in the background…" : "The browser check tests desktop and phone layouts in the background." }) : null,
    browserCheck && !browserBusy ? details(`${run.id}:browser-check`, h("span", {},
      `Browser check ${gateOk(browserCheck) ? "passed" : "failed"}`,
      browserCheck.checkedAt ? h("time", { class: "browser-checked-at", datetime: browserCheck.checkedAt, "data-time": browserCheck.checkedAt, text: ago(browserCheck.checkedAt) }) : null,
    ), h("pre", { class: "browser-check-output", text: browserCheck.outputTail }), !gateOk(browserCheck)) : null,
    renderHandoff(run, result, latest),
    [...state.runs.values()].filter((child) => child.followUp?.runId === run.id).map((child) =>
      h("button", { type: "button", class: "btn btn-sm feedback-child", onclick: () => select(child.id) }, `Revision · ${firstLine(child.request)}`),
    ),
  );
}

function recoveryHandoff(run, result, checking) {
  const stage = run.stages.findLast((entry) => entry.status === "failed" || entry.status === "stopped");
  const attempt = stage?.attempts.findLast((entry) => !entry.interrupted);
  const ready = result.savedEditsCheck === "passed";
  const recentFailure = result.savedEditsCheck === "failed" ? run.verification?.checks.find((gate) => !gateOk(gate)) : undefined;
  const failure = recentFailure ?? attempt?.gates.find((gate) => !gateOk(gate));
  const hint = failure?.outputTail?.split("\n").map((line) => line.trim())
    .find((line) => /^(?:AssertionError|(?:[\w]+)?Error:|fatal:)/i.test(line));
  const busy = state.resuming.has(run.id) || state.active.has(run.id);
  const source = state.runs.get(run.followUp?.runId);
  const saved = result.handoff?.uncommittedCount;
  const previewBusy = state.previewPending.has(run.id);
  const choose = (label, onclick, primary = false, disabled = false) =>
    h("button", { type: "button", class: `btn btn-sm${primary ? " btn-primary" : ""}`, text: label, onclick, disabled });
  return h("section", { class: `run-recovery${ready ? " is-ready" : ""}`, "aria-label": "Next step" },
    h("h2", { id: "run-handoff", tabindex: "-1", text: checking ? "Checking your saved edits" : ready ? "Checks passed. Ready to continue." :
      recentFailure ? "A check still needs a fix" : "The run paused after a failure" }),
    !checking && !ready && (failure || run.error) ? h("p", { class: "recovery-reason" },
      failure ? h("strong", { text: `${failure.command} ${failure.timedOut ? "timed out" : "failed"}` }) : null,
      run.error || hint ? h("span", { text: run.error || hint.slice(0, 280) }) : null) : null,
    h("p", { role: "status", text: checking ? "Shipyard is running the checks. No action is needed right now." :
      result.loading ? "Loading your available actions…" : ready ? `You can review the edits or continue. Continuing commits them after a final check and resumes any remaining stages with ${providerLabel(run.provider)}.` :
      recentFailure ? "Your edits are still saved. Open the check details to see what failed, then check again after it’s fixed." :
      result.recheckStage ? "Start with Check saved edits. It runs the project checks and leaves the revision and its files as they are." :
      saved ? "Your edits are saved locally. Open the check details or copy the worktree path to inspect them." :
      source ? "Open the source run to review the last completed version." : "Review the failure before trying again." }),
    h("div", { class: "run-result-actions" },
      result.recheckStage && !checking ? ready
        ? choose(busy ? "Continuing…" : "Continue this run", () => resumeRun(run.id, true), true, busy)
        : choose(recentFailure ? "Check saved edits again" : "Check saved edits", () => verifyRunResult(run.id), true, busy)
        : null,
      result.previewUrl ? [
        h("a", { class: "btn btn-sm", href: result.previewUrl, target: "_blank", rel: "noopener noreferrer", text: "Open local preview" }),
        choose("Stop preview", () => updatePreview(run.id, "DELETE"), false, previewBusy),
      ] : result.canPreview ? choose(previewBusy ? "Opening preview…" : "Preview saved edits", () => openRunPreview(run.id), false, previewBusy) : null,
      saved && run.worktree ? choose("Copy worktree path", () => copy(run.worktree, "Worktree path")) : null,
      !result.recheckStage && !result.loading && source ? choose("Open source run", () => select(source.id)) : null,
    ),
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
  const verifying = state.verificationPending.has(run.id);
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
          h("strong", { text: roleLabel(stage.role) }),
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
      agentPending.map(({ stage, text }) => h("div", { class: "handoff-report md" }, h("strong", { text: `From ${roleLabel(stage.role)}` }), md(text))),
      !pending.length && !agentPending.length && !referenceGaps.length ? h("p", { class: "muted", text: "No additional items." }) : null,
      needsProjectChecks && !run.cleanedUp && run.status === "passed" ? h("button", { type: "button", class: "btn btn-sm handoff-action", onclick: () => verifyRunResult(run.id), disabled: verifying, text: verifying ? "Running project checks…" : "Run project checks" }) : null,
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
    toast(gateOk(check) ? "Browser check passed on desktop and phone" : "Browser check failed. See the result for details.", !gateOk(check));
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.browserPending.delete(runId);
    schedule("detail");
  }
}

async function verifyRunResult(runId) {
  if (state.verificationPending.has(runId)) return;
  state.verificationPending.add(runId);
  schedule("detail");
  try {
    const { verification } = await api(`/api/runs/${runId}/verify`, { method: "POST" });
    const run = state.runs.get(runId);
    if (run) run.verification = verification;
    state.results.delete(runId);
    const ok = verification.checks.every(gateOk);
    toast(ok ? "Project checks passed" : "A project check failed. See the handoff.", !ok);
  } catch (error) {
    toast(error.message, true);
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
      else toast("Preview ready. Click Open local preview.");
    }
  } catch (error) {
    tab?.close();
    toast(error.message, true);
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
    await api(`/api/runs/${runId}/local-app`, { method });
    state.results.delete(runId);
    if (method === "POST") toast("Local app is ready");
  } catch (error) {
    state.results.delete(runId);
    toast(error.message, true);
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
    if (name === "harden") return running && crew.has("security");
    return crew.has(name);
  };
  const orchestrated = run.followUp?.orchestrated;
  const names = orchestrated ? ["orchestrate", ...assignments.map(({ role }) => role)] : PIPELINE_ORDER.filter(show);
  const conditional = { repair: "only if E2E fails", revise: "only if review asks for changes", harden: "only if the audit requires fixes" };

  names.forEach((name, i) => {
    const stage = done.get(name);
    const status = stage ? stageStatus(run, stage) : "planned";
    const role = roleLabel(stage?.role ?? (orchestrated && name !== "orchestrate" ? name : stageRole(name, run)));
    const sub = stage
      ? `${role} · ${stage.attempts.length} attempt${stage.attempts.length === 1 ? "" : "s"} · ${stageUsage(run, stage)}`
      : conditional[name] ?? (running ? `${role} · waiting to start` : `${role} · didn't run`);
    if (i > 0) nodes.push(h("span", { class: "stage-link", "aria-hidden": "true" }));
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
      avatar(stage.role),
      h("div", { class: "lane-title" }, h("strong", { text: roleLabel(stage.role) }), h("span", { text: `${stage.name} stage` })),
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
  const oldOutcomes = list.querySelector(".inbox-results");
  const oldReferences = list.querySelector(".inbox-references");

  for (const el of [...list.children]) {
    if (el === oldOutcomes || el === oldReferences) continue;
    if (!el.dataset.id || !state.inbox.has(el.dataset.id)) el.remove();
  }
  if (!items.length && !outcomes.length && !references.length) {
    list.replaceChildren(h("p", { class: "inbox-empty", text: "You're caught up. Questions and results will appear here." }));
    return;
  }
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
      if (item.kind === "reference" && !item.needsApproval) {
        existing.querySelector(".reference-handoff-card-action").textContent = referenceAction(state.runs.get(item.runId), item.url);
      }
      continue;
    }
    list.insertBefore(card(item), oldOutcomes);
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

function card(item) {
  const run = state.runs.get(item.runId);
  const kindLabel = item.needsApproval ? "Reference approval" :
    { checkpoint: "Checkpoint", question: "Question", permission: "Permission", reference: "Browser help" }[item.kind];
  const error = h("p", { class: "card-error", role: "alert", hidden: true });
  const el = h(
    "article",
    { class: "card", "data-id": item.id },
    h(
      "header",
      { class: "card-head" },
      h("span", { class: `kind kind-${item.kind}`, text: kindLabel }),
      avatar(item.role, true),
      h("span", { class: "card-from", text: `${item.role} · ${item.stage}` }),
      h("span", { class: "card-time", "data-time": item.createdAt, text: ago(item.createdAt) }),
    ),
    h("button", { type: "button", class: "card-run", onclick: () => select(item.runId), title: "Open this run" }, run ? firstLine(run.request) : item.runId),
  );

  const send = async (answer, files) => {
    if (el.classList.contains("sending")) return;
    el.classList.add("sending");
    error.hidden = true;
    try {
      const attachments = files ? await readAttachments(files) : undefined;
      await api(`/api/inbox/${item.id}`, { method: "POST", body: { ...answer, attachments } });
      state.inbox.delete(item.id);
      schedule();
    } catch (err) {
      el.classList.remove("sending");
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

function checkpointBody(item, send) {
  const c = item.checkpoint;
  const readOnly = c.stage === "plan" || c.stage === "review" || c.stage === "security";
  const title =
    c.stage === "plan"
      ? c.outcome === "passed" ? "The plan is ready" : "The planner hasn't produced a plan yet"
      : c.stage === "review"
        ? c.outcome === "passed" ? "The reviewer approved the change" : "The reviewer requested changes"
        : c.stage === "security"
          ? c.outcome === "passed" ? "The security audit passed" : "The security audit requires fixes"
          : c.stage === "triage"
            ? c.outcome === "passed" ? "The bug is reproduced" : "The bug isn't reproduced yet"
        : c.outcome === "passed" ? `${c.stage} passed its gates` : c.noChanges ? `${c.stage} made no changes` : `${c.stage} is still failing`;
  const body = h("div", { class: "card-body" }, h("div", { class: "card-title", text: `${title} (attempt ${c.attempt})` }));

  const key = `checkpoint:${item.id}`;
  const section = (name, title, ...children) =>
    details(`${key}:${name}`, title, h("div", { class: "checkpoint-section-body" }, children), false, "checkpoint-section");
  if (c.summary?.trim()) body.append(checkpointSummary(c.summary.trim(), key));

  if (!readOnly) {
    const files = item.diff.summary;
    body.append(section("files", `Changed files (${files.length})`,
      h("ul", { class: "files" }, files.length ? files.map((line) => h("li", { title: line, text: line })) : h("li", { text: "(none)" })),
    ));
  }

  if (c.gates.length) {
    const failures = c.gates.filter((gate) => !gateOk(gate));
    const detail = failures[0] ?? c.gates.find((gate) => gate.expectFailure && gate.code !== 0);
    const title = failures.length ? `Checks (${failures.length} failed)` : `Checks (${c.gates.length} passed)`;
    body.append(section("checks", title,
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
    body.append(panel);
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
        c.outcome === "passed" ? (c.stage === "plan" ? "Approve the plan" : "Approve") : c.stage === "review" || c.stage === "security" ? "Send findings to the implementer" : "Send failure to the implementer",
      ),
    );
  }
  actions.append(h("span", { class: "spacer" }), armedButton("Stop run", "Confirm stop", () => send({ kind: "checkpoint", action: "stop" })));

  body.append(section("feedback", "Write feedback", h("div", { class: "feedback" }, feedback,
    attachmentField(attachments, `${item.id}-checkpoint-files`), h("div", { class: "actions" }, sendFeedback))), actions);
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
    const name = `${item.id}-q${qi}`;
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
  body.append(...groups.map((g) => g.group), attachmentField(attachments, `${item.id}-answer-files`));
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
  return h(
    "div",
    { class: "card-body" },
    h("div", { class: "card-title", text: item.title || `${item.role} wants to use ${item.tool}` }),
    item.reason ? h("div", { class: "field-help", text: item.reason }) : null,
    h("pre", { class: "code", text: JSON.stringify(item.input, null, 2) }),
    note,
    attachmentField(attachments, `${item.id}-permission-files`),
    h(
      "div",
      { class: "actions" },
      h("button", { type: "button", class: "btn btn-primary btn-sm", onclick: () => decide("allow") }, "Allow once"),
      h("button", { type: "button", class: "btn btn-sm", onclick: () => decide("allow-run") }, `Allow ${item.tool} for this run`),
      h("span", { class: "spacer" }),
      h("button", { type: "button", class: "btn btn-sm btn-danger", onclick: () => decide("deny") }, "Deny"),
    ),
  );
}

function focusItem(id) {
  openInboxDrawer();
  const el = document.querySelector(`.card[data-id="${id}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1600);
  el.querySelector("textarea, input, button.btn-primary")?.focus({ preventScroll: true });
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
  { stage: "triage", role: "bug-triager", title: "bug-triager", what: "Proves the bug with a failing test before anyone fixes it", on: true, only: "bug" },
  { stage: "plan", role: "planner", title: "planner", what: "Studies the repo, asks you questions, writes the plan", on: true, pause: true, not: "deps" },
  { stage: "implement", role: "implementer", title: "implementer", what: "Builds the change and its unit tests", required: true, pause: true },
  { stage: "design", role: "ui-ux", title: "UI/UX specialist", what: "Refines the interface, interaction, accessibility, and motion after implementation", on: false, pause: true, not: "deps" },
  { stage: "review", role: "reviewer", title: "reviewer", what: "Fresh-eyes review; blocking findings go back for a revision", on: true },
  { stage: "security", role: "security-auditor", title: "security-auditor", what: "Audits it like an attacker; critical/high findings go back to be fixed", on: false },
  { stage: "e2e", role: "e2e-tester", title: "e2e-tester", what: "Tests it end to end, from the outside", on: true },
  { stage: "repair", role: "implementer", title: "repair", what: "Fixes the code if E2E finds a problem", on: true },
  { stage: "docs", role: "docs-writer", title: "docs-writer", what: "Updates the README, changelog and docs", on: false },
  { stage: "release", role: "release-manager", title: "release-manager", what: "Bumps the version and writes release notes; never publishes", on: false },
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
  select.replaceChildren(...state.targets.map((t) => h("option", { value: t.name, text: t.name, selected: t.name === keep })));
}

function openNewRun(selected) {
  if (!state.targets.length && state.config?.canAddTargets) return openAddRepo();
  const dialog = $("new-run-dialog");
  fillTargets(typeof selected === "string" ? selected : undefined);
  if (!dialog.open || typeof selected === "string") $("nr-browser").checked = Boolean(state.targets.find((t) => t.name === $("nr-target").value)?.browserAccess);
  $("nr-add-repo").hidden = !state.config?.canAddTargets;
  if (!dialog.open) fillRunOptions();
  applyKind($("new-run-form").querySelector('input[name="kind"]:checked')?.value ?? "feature");
  $("demo-note").hidden = !state.config?.demo;
  $("nr-error").hidden = true;
  if (!dialog.open) dialog.showModal();
  $("nr-request").focus();
}

// ── Add repo dialog ──────────────────────────────────────

const addRepo = { inspected: null, seq: 0, timer: 0, edited: new Set(), busy: false };
const cloneUrlEntered = () => /^(?:[a-z][\w+.-]*:\/\/|[\w.-]+@[\w.-]+:)/i.test($("ar-path").value.trim());

async function openAddRepo() {
  const dialog = $("add-repo-dialog");
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
      openNewRun(target.name);
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
  $("nr-cancel").addEventListener("click", () => dialog.close());
  $("nr-crew").addEventListener("change", updateCrew);
  $("nr-target").addEventListener("change", () => {
    $("nr-browser").checked = Boolean(state.targets.find((t) => t.name === $("nr-target").value)?.browserAccess);
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
      checkpoints,
    };
    savePrefs({
      provider: body.provider,
      model: body.model,
      effort: body.effort,
      run: Object.fromEntries(CREW.filter((c) => !c.required).map((c) => [c.stage, Boolean(box(c.stage)?.checked)])),
      pause: paused,
    });
    submit.disabled = true;
    try {
      body.attachments = await readAttachments($("nr-attachments"));
      const { id } = await api("/api/runs", { method: "POST", body });
      state.starting.set(id, body.request);
      dialog.close();
      $("nr-request").value = "";
      $("nr-attachments").value = "";
      select(id);
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

function runActions(run) {
  const active = (state.active.has(run.id) || !state.runs.has(run.id)) && run.status === "running";
  const button = (label, handler, style = "btn-ghost", disabled = false) => h("button", {
    type: "button", class: `btn btn-sm ${style}`, text: label, onclick: handler, disabled,
  });
  const stopping = state.stopping.has(run.id);
  const nextProvider = run.provider === "codex" ? "claude" : "codex";
  return h("div", { class: "run-actions", "aria-label": "Run actions" }, active
    ? [
        button(stopping ? "Stopping…" : "Stop run", () => stopRun(run.id), "btn-danger", stopping),
        button("Steer", () => openRunControl(run.id), "btn-ghost", stopping),
        state.config?.demo ? null : button(`Switch to ${providerLabel(nextProvider)}`, () => openRunControl(run.id, nextProvider), "btn-ghost", stopping),
      ]
    : [
        !run.cleanedUp && (run.status === "stopped" || run.status === "running")
          ? button(state.resuming.has(run.id) ? "Resuming…" : "Resume run", () => resumeRun(run.id), "btn-primary", state.active.has(run.id) || state.resuming.has(run.id))
          : null,
        button(run.archivedAt ? "Restore run" : "Archive run", () => archiveRun(run.id, !run.archivedAt), "btn-ghost", state.active.has(run.id)),
        button("Delete run", () => deleteRun(run.id), "btn-danger", state.active.has(run.id)),
      ]);
}

async function resumeRun(id, recheck = false) {
  if (state.resuming.has(id)) return;
  state.resuming.add(id);
  schedule("detail");
  try {
    await api(`/api/runs/${id}/${recheck ? "recheck" : "resume"}`, { method: "POST" });
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
  state.results.delete(id);
  state.starting.delete(id);
  if (state.selected === id) select(visibleRuns()[0]?.id ?? null);
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
    if (state.selected === id) select(visibleRuns()[0]?.id ?? null);
    schedule("runs", "detail");
    toast(archived ? "Run archived" : "Run restored");
  } catch (error) {
    toast(error.message, true);
  }
}

function openRunControl(id, provider) {
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
  input.required = !provider;
  dialog.showModal();
  input.focus();
}

function wireRunControls() {
  $("archive-toggle").addEventListener("click", () => {
    state.showArchived = !state.showArchived;
    select(visibleRuns()[0]?.id ?? null);
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
          attachments: await readAttachments($("run-control-attachments")) },
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

function openFeedback(run) {
  $("feedback-form").dataset.runId = run.id;
  $("feedback-message").value = "";
  $("feedback-attachments").value = "";
  $("feedback-provider").value = run.provider ?? "claude";
  $("feedback-browser").checked = Boolean(run.browserAccess ?? state.targets.find((target) => target.name === run.target)?.browserAccess);
  $("feedback-error").hidden = true;
  $("feedback-dialog").showModal();
  $("feedback-message").focus();
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

async function createPullRequest(runId, { destination, head }) {
  if (state.pullRequestPending.has(runId)) return;
  state.pullRequestPending.add(runId);
  schedule("detail");
  try {
    const result = await api(`/api/runs/${runId}/pull-request`, { method: "POST", body: { destination, head } });
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

function wireFeedback() {
  const dialog = $("feedback-dialog");
  const button = $("feedback-submit");
  const cancel = $("feedback-cancel");
  const error = $("feedback-error");
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => { if (button.disabled) event.preventDefault(); });
  $("feedback-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    const { runId } = event.currentTarget.dataset;
    const message = $("feedback-message").value.trim();
    const body = {
      message, provider: $("feedback-provider").value, browserAccess: $("feedback-browser").checked,
    };
    button.disabled = true;
    cancel.disabled = true;
    error.hidden = true;
    try {
      body.attachments = await readAttachments($("feedback-attachments"));
      const { id } = await api(`/api/runs/${runId}/feedback`, { method: "POST", body });
      if (!state.runs.has(id)) state.starting.set(id, "Revision");
      dialog.close();
      select(id);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      button.disabled = false;
      cancel.disabled = false;
    }
  });
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
  });
  wireNewRun();
  wireAddRepo();
  wireRunControls();
  wireFeedback();
  wireGitRemote();
  wirePublish();
  wireReferenceHandoff();
  try {
    await loadState();
  } catch (err) {
    if (err.unauthorized) return unauthorized();
    toast(`Couldn't load shipyard: ${err.message}`, true);
  }
  connect();
  setInterval(tick, 1000);
  setInterval(() => schedule("runs"), 30_000);
}

main();
