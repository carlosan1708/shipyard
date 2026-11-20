// shipyard ui client. No framework, no build step.
// Everything agents write is untrusted text: it only ever reaches the page through textContent.

const STAGE_ROLE = {
  triage: "bug-triager",
  plan: "planner",
  review: "reviewer",
  security: "security-auditor",
  e2e: "e2e-tester",
  docs: "docs-writer",
  release: "release-manager",
};
/** implement, revise, harden and repair belong to the run's implementer. */
const stageRole = (name, run) => STAGE_ROLE[name] ?? run?.implementer ?? "backend";
const PIPELINE_ORDER = ["triage", "plan", "implement", "review", "revise", "security", "harden", "e2e", "repair", "docs", "release"];
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
  changes: "Changes requested",
};

const state = {
  config: null,
  stages: [],
  targets: [],
  runs: new Map(),
  active: new Set(),
  inbox: new Map(),
  events: new Map(), // runId -> events, once loaded
  buffers: new Map(), // runId -> events that arrived while its history was loading
  lastActivity: new Map(), // runId -> last tool/text event
  starting: new Map(), // runId -> request, until its first record arrives
  open: new Map(), // <details> open state, so re-renders keep what you expanded
  selected: null,
  showArchived: false,
  stopping: new Set(),
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

/** A <details> whose open state survives re-renders. */
function details(key, summaryText, content, defaultOpen = false, cls = "block") {
  const open = state.open.has(key) ? state.open.get(key) : defaultOpen;
  const el = h("details", { class: cls, open }, h("summary", { text: summaryText }), content);
  el.addEventListener("toggle", () => state.open.set(key, el.open));
  return el;
}

// ── Markdown ─────────────────────────────────────────────
// Agents answer in markdown. This renders a safe subset by creating elements and text nodes,
// never by parsing HTML: raw HTML in agent text stays text, and only http(s) URLs become links.

const MD_FENCE = /^\s*(`{3,}|~{3,})/;
const MD_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
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
const mdStartsBlock = (line, next) =>
  MD_FENCE.test(line) || MD_HEADING.test(line) || MD_RULE.test(line) || MD_QUOTE.test(line) || MD_LIST.test(line) || mdIsTable(line, next);

function mdBlocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
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
  backend: "BE",
  frontend: "FE",
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
  state.stages = s.stages;
  state.efforts = s.efforts;
  state.codexEfforts = s.codexEfforts;
  state.implementers = s.implementers;
  state.roles = s.roles;
  state.targets = s.targets;
  state.runs = new Map(s.runs.map((r) => [r.id, r]));
  state.active = new Set(s.active);
  state.inbox = new Map(s.inbox.map((i) => [i.id, i]));
  if ($("new-run-dialog").open) {
    fillTargets(); // after a reconnect, an open dialog shows the current repos
    updateCrew();
  }
  if (!state.selected || (!state.runs.has(state.selected) && !state.starting.has(state.selected))) state.selected = initialSelection();
  schedule();
  if (state.selected) loadEvents(state.selected);
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
      loadState().catch(() => {});
    }
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
    state.runs.set(run.id, run);
    state.starting.delete(run.id);
    schedule();
  });
  on("event", ({ runId, event }) => {
    if (event.type === "tool" || event.type === "text") state.lastActivity.set(runId, event);
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
  const what = item.kind === "checkpoint" ? "a checkpoint review" : item.kind === "question" ? "a question" : "permission";
  new Notification("shipyard", { body: `${item.role} needs ${what}` });
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
  const n = state.inbox.size;
  for (const el of [$("inbox-count"), $("inbox-toggle-count")]) {
    el.textContent = String(n);
    el.classList.toggle("has", n > 0);
  }
  document.title = n ? `(${n}) shipyard` : "shipyard";
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
  const waiting = inboxFor(run.id);
  const events = state.events.get(run.id);
  const inner = h(
    "div",
    { class: "detail-inner" },
    h(
      "section",
      { class: "run-head" },
      h("div", { class: "run-head-top" }, h("h1", { text: run.request }), h("span", { class: `pill s-${status}`, text: STATUS_LABEL[status] ?? status })),
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
      runActions(run),
    ),
    waiting.length
      ? h(
          "div",
          { class: "banner", role: "status" },
          `${waiting.length === 1 ? "An agent is" : `${waiting.length} agents are`} waiting for your answer`,
          h("button", { type: "button", class: "btn btn-sm", onclick: () => focusItem(waiting[0].id) }, "Answer"),
        )
      : null,
    run.error ? h("div", { class: "banner banner-error", text: run.error }) : null,
    renderPipeline(run),
    h("section", { class: "lanes", "aria-label": "Agents" }, run.stages.map((stage) => renderLane(run, stage, events))),
    events === undefined ? h("div", { class: "working" }, h("span", { class: "spinner" }), "Loading activity…") : null,
  );
  const scroll = root.scrollTop;
  root.replaceChildren(inner);
  root.scrollTop = scroll;
}

function renderPipeline(run) {
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
  const names = PIPELINE_ORDER.filter(show);
  const conditional = { repair: "only if E2E fails", revise: "only if review asks for changes", harden: "only if the audit requires fixes" };

  names.forEach((name, i) => {
    const stage = done.get(name);
    const status = stage ? stageStatus(run, stage) : "planned";
    const role = stage?.role ?? stageRole(name, run);
    const sub = stage
      ? `${role} · ${stage.attempts.length} attempt${stage.attempts.length === 1 ? "" : "s"} · ${stageUsage(run, stage)}`
      : conditional[name] ?? (running ? `${role} · waiting to start` : `${role} · didn't run`);
    if (i > 0) nodes.push(h("span", { class: "stage-link", "aria-hidden": "true" }));
    nodes.push(
      h(
        "div",
        { class: `stage-node${stage ? "" : " planned"}` },
        h("span", { class: "stage-name" }, h("span", { class: `stage-icon s-${status}`, "aria-hidden": "true", text: stageGlyph(status) }), name),
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
  const count = Math.max(stage.attempts.length, ...byAttempt.keys(), 1);
  const attempts = [];
  for (let n = 1; n <= count; n++) attempts.push(renderAttempt(run, stage, n, byAttempt.get(n) ?? [], n === count, status));

  return h(
    "article",
    { class: `lane${status === "waiting" ? " waiting" : ""}` },
    h(
      "header",
      { class: "lane-head" },
      avatar(stage.role),
      h("div", { class: "lane-title" }, h("strong", { text: stage.role }), h("span", { text: `${stage.name} stage` })),
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

function renderAttempt(run, stage, n, events, isLast, status) {
  const record = stage.attempts[n - 1];
  const prev = stage.attempts[n - 2];
  const why = !prev ? "" : prev.interrupted === "redirected" ? "after your update" : prev.review?.action === "feedback" ? "after your feedback" : prev.passed ? "" : prev.noChanges ? "after no changes" : "after a failed gate";
  const key = `${run.id}:${stage.name}:${n}`;
  const start = events.find((e) => e.type === "attempt_start");

  const rows = [];
  // A checkpoint is reached after the gates run, so its "waiting" row goes after the gate rows.
  const isCheckpointWait = (e) => e.type === "waiting" && e.kind === "checkpoint";
  for (const e of events.filter((e) => !isCheckpointWait(e))) {
    const row = eventRow(e);
    if (row) rows.push(row);
  }
  if (record) {
    if (record.interrupted) rows.push(row("interrupted", record.interrupted === "stopped" ? "You stopped this attempt" : "Waiting for the updated attempt", "warn"));
    else if (!record.agentOk && record.agentError) rows.push(row("stopped", record.agentError, "bad"));
    if (record.revertedFiles?.length) rows.push(row("reverted", `out-of-lane edits: ${record.revertedFiles.join(", ")}`, "warn"));
    if (record.noChanges) rows.push(row("gate", "No changes in the worktree, so the gates didn't run", "bad"));
    for (const g of record.gates) {
      const label = gateLabel(g);
      if (gateOk(g) && !g.expectFailure) rows.push(row("gate", label, "ok", true));
      else rows.push(h("li", { class: "row bad" }, h("span", { class: "row-tag", text: "gate" }), h("div", { class: "row-body mono" }, details(`${key}:gate:${g.command}`, label, h("pre", { class: "prose mono", text: g.outputTail }), isLast, ""))));
    }
  }
  for (const e of events.filter(isCheckpointWait)) rows.push(eventRow(e));
  for (const e of events.filter((e) => e.type === "checkpoint")) rows.push(checkpointRow(e));

  let tail = null;
  if (!record && status === "waiting") tail = h("div", { class: "working s-waiting" }, `${stage.role} is waiting for you`);
  else if (!record && state.active.has(run.id) && isLast) tail = h("div", { class: "working" }, h("span", { class: "spinner" }), `${stage.role} is working…`);

  return h(
    "div",
    { class: "attempt" },
    h("div", { class: "attempt-label" }, `Attempt ${n} · ${providerLabel(record?.provider ?? start?.provider ?? run.provider)}`, why ? h("span", { text: `· ${why}` }) : null),
    start?.prompt ? details(`${key}:prompt`, "What it was told", h("pre", { class: "prose", text: start.prompt })) : null,
    h("ul", { class: "feed" }, rows),
    tail,
    record?.summary ? details(`${key}:summary`, `${stage.role}'s summary`, md(record.summary, "prose"), isLast) : null,
  );
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
      const what = e.kind === "checkpoint" ? "your checkpoint review" : e.kind === "question" ? "your answer to a question" : "your permission";
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
  for (const el of [...list.children]) {
    if (el.dataset.id ? !state.inbox.has(el.dataset.id) : items.length) el.remove();
  }
  if (!items.length) {
    if (!list.children.length) list.append(h("p", { class: "inbox-empty", text: "Nothing needs you right now. Agents will ask here when they need a decision." }));
    return;
  }
  for (const item of items) {
    const existing = list.querySelector(`[data-id="${item.id}"]`);
    if (existing) {
      existing.querySelector(".card-time").textContent = ago(item.createdAt);
      continue;
    }
    list.append(card(item));
  }
}

function card(item) {
  const run = state.runs.get(item.runId);
  const kindLabel = { checkpoint: "Checkpoint", question: "Question", permission: "Permission" }[item.kind];
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

  const send = async (answer) => {
    el.classList.add("sending");
    error.hidden = true;
    try {
      await api(`/api/inbox/${item.id}`, { method: "POST", body: answer });
      state.inbox.delete(item.id);
      schedule();
    } catch (err) {
      el.classList.remove("sending");
      error.textContent = err.message;
      error.hidden = false;
    }
  };

  const body = item.kind === "checkpoint" ? checkpointBody(item, send) : item.kind === "question" ? questionBody(item, send) : permissionBody(item, send);
  body.append(error);
  el.append(body);
  return el;
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

  if (c.summary?.trim()) {
    const summary = md(c.summary.trim(), "summary");
    body.append(summary);
    requestAnimationFrame(() => {
      if (summary.scrollHeight > summary.clientHeight + 4) {
        summary.classList.add("clamped");
        const more = h("button", { type: "button", class: "link" }, "Show all");
        more.addEventListener("click", () => {
          const open = summary.classList.toggle("open");
          summary.classList.toggle("clamped", !open);
          more.textContent = open ? "Show less" : "Show all";
        });
        summary.after(more);
      }
    });
  }

  // Planner and reviewer never change files, so there is no diff to show for them.
  if (!readOnly) {
    body.append(
      h("div", {}, h("div", { class: "section-label", text: "Changes" }), h("ul", { class: "files" }, item.diff.summary.length ? item.diff.summary.map((line) => h("li", { title: line, text: line })) : h("li", { text: "(none)" }))),
    );
  }
  if (c.gates.length) {
    body.append(
      h(
        "div",
        {},
        h("div", { class: "section-label", text: "Gates" }),
        h("ul", { class: "gates" }, c.gates.map((g) => h("li", { class: gateOk(g) ? "ok" : "bad", text: gateLabel(g) }))),
      ),
    );
    // The output matters for a real failure, and for a triage it shows the reproduction failing.
    const failed = c.gates.find((g) => !gateOk(g) || (g.expectFailure && g.code !== 0));
    if (failed) body.append(h("pre", { class: "code", text: failed.outputTail.trim().split("\n").slice(-15).join("\n") }));
  }

  if (item.diff.patch.trim()) {
    let diffEl = null;
    const toggle = h("button", { type: "button", class: "link" }, "View diff");
    toggle.addEventListener("click", () => {
      diffEl ??= renderDiff(item.diff.patch);
      if (diffEl.isConnected) {
        diffEl.remove();
        toggle.textContent = "View diff";
      } else {
        toggle.after(diffEl);
        toggle.textContent = "Hide diff";
      }
    });
    body.append(toggle);
  }

  const feedback = h("textarea", { rows: "3", placeholder: `Feedback for ${item.role}: what should change?`, "aria-label": `Feedback for ${item.role}` });
  const sendFeedback = h("button", { type: "button", class: "btn btn-sm", disabled: true }, "Send feedback");
  feedback.addEventListener("input", () => (sendFeedback.disabled = !feedback.value.trim()));
  sendFeedback.addEventListener("click", () => send({ kind: "checkpoint", action: "feedback", message: feedback.value }));

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

  body.append(h("div", { class: "feedback" }, feedback, h("div", { class: "actions" }, sendFeedback)), actions);
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
  body.append(...groups.map((g) => g.group));
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
    send({ kind: "question", answers });
  });
  body.append(h("div", { class: "actions" }, submit));
  return body;
}

function permissionBody(item, send) {
  const note = h("input", { type: "text", placeholder: "Note for the agent (optional)", "aria-label": "Note for the agent" });
  return h(
    "div",
    { class: "card-body" },
    h("div", { class: "card-title", text: item.title || `${item.role} wants to use ${item.tool}` }),
    item.reason ? h("div", { class: "field-help", text: item.reason }) : null,
    h("pre", { class: "code", text: JSON.stringify(item.input, null, 2) }),
    note,
    h(
      "div",
      { class: "actions" },
      h("button", { type: "button", class: "btn btn-primary btn-sm", onclick: () => send({ kind: "permission", decision: "allow", message: note.value }) }, "Allow once"),
      h("button", { type: "button", class: "btn btn-sm", onclick: () => send({ kind: "permission", decision: "allow-run", message: note.value }) }, `Allow ${item.tool} for this run`),
      h("span", { class: "spacer" }),
      h("button", { type: "button", class: "btn btn-sm btn-danger", onclick: () => send({ kind: "permission", decision: "deny", message: note.value }) }, "Deny"),
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

/** The crew, in pipeline order. "implementer" rows follow the backend/frontend choice. */
const CREW = [
  { stage: "triage", role: "bug-triager", title: "bug-triager", what: "Proves the bug with a failing test before anyone fixes it", on: true, only: "bug" },
  { stage: "plan", role: "planner", title: "planner", what: "Studies the repo, asks you questions, writes the plan", on: true, pause: true, not: "deps" },
  { stage: "implement", role: "implementer", title: "implementer", what: "Builds the change and its unit tests", required: true, pause: true },
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
  const implementer = (state.implementers ?? ["backend", "frontend"]).includes(prefs.implementer) ? prefs.implementer : "backend";
  $("nr-crew").replaceChildren(
    ...CREW.map((c) => {
      const roleName = c.role === "implementer" ? implementer : c.role;
      const role = state.roles?.find((r) => r.name === roleName);
      const title =
        c.stage === "implement"
          ? h(
              "select",
              { class: "crew-implementer", id: "nr-implementer", "aria-label": "Who implements" },
              (state.implementers ?? ["backend", "frontend"]).map((i) => h("option", { value: i, selected: i === implementer, text: i })),
            )
          : h("strong", { class: c.role === "implementer" ? "crew-implementer-name" : null, text: c.role === "implementer" ? `${implementer} · ${c.title}` : c.title });
      return h(
        "tr",
        { "data-stage": c.stage },
        h(
          "td",
          {},
          h(
            "div",
            { class: "crew-agent", title: role?.description ?? "" },
            h("span", { class: "crew-avatar", "data-role": c.role }, avatar(roleName, true)),
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
  // Dependency updates always have the dependency-updater as their implementer.
  const implementer = kind === "deps" ? "dependency-updater" : ($("nr-implementer")?.value ?? "backend");
  return { hasE2E, kind, box, on, available, implementer };
}

function updateCrew() {
  if (!$("nr-crew").children.length) return;
  const { hasE2E, kind, box, on, available, implementer } = crewState();
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
  // For dependency runs the implementer is fixed, so the backend/frontend picker steps aside.
  const picker = $("nr-implementer");
  picker.hidden = kind === "deps";
  let fixed = picker.parentElement.querySelector(".crew-fixed-implementer");
  if (!fixed) {
    fixed = h("strong", { class: "crew-fixed-implementer", text: "dependency-updater" });
    picker.after(fixed);
  }
  fixed.hidden = kind !== "deps";
  // Rows done by the implementer follow the backend/frontend choice.
  for (const el of $("nr-crew").querySelectorAll(".crew-implementer-name")) {
    el.textContent = `${implementer} · ${spec(el.closest("tr").dataset.stage).title}`;
  }
  for (const el of $("nr-crew").querySelectorAll('.crew-avatar[data-role="implementer"]')) el.replaceChildren(avatar(implementer, true));
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
  $("nr-add-repo").hidden = !state.config?.canAddTargets;
  if (!dialog.open) fillRunOptions();
  applyKind($("new-run-form").querySelector('input[name="kind"]:checked')?.value ?? "feature");
  $("demo-note").hidden = !state.config?.demo;
  $("nr-error").hidden = true;
  if (!dialog.open) dialog.showModal();
  $("nr-request").focus();
}

// ── Add repo dialog ──────────────────────────────────────

const addRepo = { inspected: null, seq: 0, timer: 0, edited: new Set() };

async function openAddRepo() {
  const dialog = $("add-repo-dialog");
  $("add-repo-form").reset();
  addRepo.inspected = null;
  addRepo.edited.clear();
  $("ar-status").replaceChildren();
  $("ar-details").hidden = true;
  $("ar-error").hidden = true;
  $("ar-submit").disabled = true;
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
  $("ar-path").value = path;
  addRepo.edited.clear(); // a new repo: let detection fill the fields again
  inspectPath();
}

async function inspectPath() {
  const path = $("ar-path").value.trim();
  const seq = ++addRepo.seq;
  if (!path) {
    $("ar-status").replaceChildren();
    $("ar-details").hidden = true;
    $("ar-submit").disabled = true;
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
  addRepo.inspected = info;

  for (const el of document.querySelectorAll(".repo-pick")) el.classList.toggle("chosen", el.dataset.path === info.path);
  const lines = [];
  if (info.ok) lines.push(h("span", { class: "ok", text: `✓ ${info.displayPath} · ${info.branch} · ${info.commits} commit${info.commits === 1 ? "" : "s"}` }));
  for (const e of info.errors) lines.push(h("span", { class: "err", text: e }));
  for (const w of info.warnings) lines.push(h("span", { class: "warn", text: w }));
  $("ar-status").replaceChildren(...lines);

  $("ar-details").hidden = !info.ok;
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
  $("ar-submit").disabled = !addRepo.inspected?.ok || Boolean(missing);
}

function wireAddRepo() {
  const dialog = $("add-repo-dialog");
  $("nr-add-repo").addEventListener("click", openAddRepo);
  $("ar-cancel").addEventListener("click", () => dialog.close());
  $("ar-path").addEventListener("input", () => {
    clearTimeout(addRepo.timer);
    addRepo.timer = setTimeout(inspectPath, 400);
  });
  for (const id of ["ar-name", "ar-test", "ar-e2e"]) {
    $(id).addEventListener("input", () => {
      addRepo.edited.add(id);
      updateAddRepoSubmit();
    });
  }
  $("add-repo-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!addRepo.inspected?.ok) return;
    const submit = $("ar-submit");
    submit.disabled = true;
    $("ar-error").hidden = true;
    try {
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
  $("nr-target").addEventListener("change", updateCrew);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const { box, on, implementer, kind } = crewState();
    const paused = [...$("nr-crew").querySelectorAll('input[name="checkpoints"]:checked')].map((i) => i.value);
    // Only pause after agents that will actually run. A revision after review pauses like implement.
    const checkpoints = paused.filter((s) => on[s]);
    if (checkpoints.includes("implement")) checkpoints.push("revise");
    const body = {
      target: data.get("target"),
      kind: data.get("kind"),
      request: String(data.get("request") ?? "").trim(),
      provider: $("nr-provider").value,
      model: $("nr-model").value || undefined,
      effort: $("nr-effort").value || undefined,
      budgetUsd: $("nr-budget").required ? Number($("nr-budget").value) : undefined,
      implementer: kind === "deps" ? undefined : implementer,
      crew: CREW.filter((c) => !c.required && on[c.stage]).map((c) => c.stage),
      checkpoints,
    };
    savePrefs({
      provider: body.provider,
      model: body.model,
      effort: body.effort,
      implementer: $("nr-implementer").value,
      run: Object.fromEntries(CREW.filter((c) => !c.required).map((c) => [c.stage, Boolean(box(c.stage)?.checked)])),
      pause: paused,
    });
    const submit = $("nr-submit");
    submit.disabled = true;
    try {
      const { id } = await api("/api/runs", { method: "POST", body });
      state.starting.set(id, body.request);
      dialog.close();
      $("nr-request").value = "";
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
    : button(run.archivedAt ? "Restore run" : "Archive run", () => archiveRun(run.id, !run.archivedAt), "btn-ghost", state.active.has(run.id)));
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
    button.disabled = true;
    try {
      await api(`/api/runs/${runId}/control`, {
        method: "POST",
        body: { action: provider ? "switch-provider" : "steer", provider: provider || undefined, message },
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

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Branch name copied");
  } catch {
    toast("Couldn't copy: select the branch name instead", true);
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
  window.addEventListener("hashchange", () => {
    const id = location.hash.match(/^#run\/([\w-]+)$/)?.[1];
    if (id && id !== state.selected && state.runs.has(id)) select(id);
  });
  wireNewRun();
  wireAddRepo();
  wireRunControls();
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
