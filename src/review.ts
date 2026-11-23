import type { Readable, Writable } from "node:stream";
import type { CheckpointContext, CheckpointDecision } from "./pipeline.ts";
import { gateOk } from "./store.ts";
import { diffSinceHead } from "./worktree.ts";

/**
 * Lines from an input stream, queued so none are lost between checkpoints (readline drops lines
 * that arrive while no question is pending, which breaks scripted or pasted answers). The stream
 * is paused whenever nobody is waiting, so it never holds the process open or competes with Ctrl-C.
 */
export class LineQueue {
  private buffer = "";
  private lines: string[] = [];
  private waiters: Array<(line: string | null) => void> = [];
  private ended = false;

  constructor(private readonly input: Readable) {
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (let i = this.buffer.indexOf("\n"); i >= 0; i = this.buffer.indexOf("\n")) {
        this.push(this.buffer.slice(0, i).replace(/\r$/, ""));
        this.buffer = this.buffer.slice(i + 1);
      }
    });
    input.on("end", () => {
      if (this.buffer) this.push(this.buffer);
      this.buffer = "";
      this.ended = true;
      for (const waiter of this.waiters.splice(0)) waiter(null);
    });
    input.pause();
  }

  /** The next line, or null once the input has ended. */
  next(): Promise<string | null> {
    if (this.lines.length) return Promise.resolve(this.lines.shift()!);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.input.resume();
    });
  }

  private push(line: string): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(line);
    else this.lines.push(line);
    if (this.waiters.length === 0) this.input.pause();
  }
}

/** Checkpoint reviews in the terminal. If input ends (piped answers run out, or Ctrl-D), the run stops rather than guessing. */
export function terminalReviewer(io: { input: Readable; output: Writable } = { input: process.stdin, output: process.stdout }) {
  const write = (text = "") => io.output.write(text + "\n");
  let queue: LineQueue | undefined;
  const ask = async (prompt: string): Promise<string | null> => {
    io.output.write(prompt);
    queue ??= new LineQueue(io.input);
    return queue.next();
  };

  return async function review(ctx: CheckpointContext): Promise<CheckpointDecision> {
    const diff = await diffSinceHead(ctx.worktree);
    const title =
      ctx.outcome === "passed"
        ? `${ctx.stage} passed its gates (attempt ${ctx.attempt})`
        : ctx.noChanges
          ? `${ctx.stage} made no changes (attempt ${ctx.attempt})`
          : `${ctx.stage} is still failing after attempt ${ctx.attempt}`;

    write();
    write(`━━ checkpoint · ${title} ━━`);
    if (ctx.expectedBehavior) write(`\nExpected behavior to approve: ${ctx.expectedBehavior}`);
    if (ctx.summary.trim()) {
      write(`\n${ctx.role} says:`);
      for (const line of ctx.summary.trim().split("\n")) write(`  ${line}`);
    }
    write(`\nChanges in this stage:`);
    if (diff.summary.length) for (const line of diff.summary) write(`  ${line}`);
    else write("  (none)");
    if (ctx.gates.length) {
      write(`\nGates:`);
      for (const g of ctx.gates) {
        const expected = g.expectFailure ? (g.timedOut ? ", timed out" : gateOk(g) ? ", failed as expected" : ", expected failure, got a pass") : "";
        write(`  ${gateOk(g) ? "✓" : "✗"} ${g.command} (${(g.durationMs / 1000).toFixed(1)}s${g.code === 0 ? "" : `, exit ${g.code}`}${expected})`);
      }
      // Show test output for a failed gate or the expected failure at triage.
      const failedGate = ctx.gates.find((g) => !gateOk(g) || (g.expectFailure && g.code !== 0));
      if (failedGate) {
        write(failedGate.expectFailure ? `\nThe reproduction failing:` : `\nEnd of the failing output:`);
        for (const line of failedGate.outputTail.trim().split("\n").slice(-15)) write(`  ${line}`);
      }
    }
    if (ctx.sessionId && ctx.provider !== "codex") write(`\nTo talk to this agent directly: cd ${ctx.worktree} && claude --resume ${ctx.sessionId}`);

    const choices: Array<[key: string, label: string]> = [];
    if (ctx.canContinue) choices.push(ctx.outcome === "passed" ? ["a", "approve and continue"] : ["c", "continue: send the failure to the implementer"]);
    choices.push(["d", "full diff"], ["f", "feedback to the agent"], ["s", "stop the run"]);
    const menu = choices.map(([k, label]) => `[${k}] ${label}`).join("   ");

    for (;;) {
      write(`\n${menu}`);
      const answer = await ask("> ");
      if (answer === null) {
        write("\n(input ended: stopping the run)");
        return { action: "stop" };
      }
      const key = answer.trim().toLowerCase();
      if ((key === "a" || key === "c") && ctx.canContinue) return { action: "continue" };
      if (key === "s") return { action: "stop" };
      if (key === "d") {
        write(diff.patch.trim() || "(no changes)");
        continue;
      }
      if (key === "f") {
        write(`Feedback for ${ctx.role}. Finish with an empty line:`);
        const lines: string[] = [];
        for (;;) {
          const line = await ask("| ");
          if (line === null || line.trim() === "") break;
          lines.push(line);
        }
        const message = lines.join("\n").trim();
        if (message) return { action: "feedback", message };
        write("(no feedback given)");
        continue;
      }
      write(`Type one of: ${choices.map(([k]) => k).join(", ")}`);
    }
  };
}
