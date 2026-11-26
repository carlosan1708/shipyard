import type { Provider } from "./config.ts";
import type { FeedbackAttachment } from "./attachments.ts";

export interface RunDirective {
  provider?: Provider;
}

/** Coordinates interruptions with the pipeline. Each attempt owns its process and inbox requests. */
export class RunControl {
  private readonly attempts = new Map<string, AbortController>();
  private pending?: RunDirective;
  readonly instructions: string[] = [];
  readonly attachments: FeedbackAttachment[] = [];
  private readonly stoppedSignal = new AbortController();
  get stopSignal(): AbortSignal { return this.stoppedSignal.signal; }
  stopped = false;
  get requestedProvider(): Provider | undefined { return this.pending?.provider; }

  beginAttempt(scope = "run"): AbortSignal {
    const attempt = new AbortController();
    this.attempts.set(scope, attempt);
    if (this.stopped) attempt.abort();
    return attempt.signal;
  }

  stop(): void {
    this.stopped = true;
    this.stoppedSignal.abort();
    for (const attempt of this.attempts.values()) attempt.abort();
  }

  redirect(provider: Provider | undefined, message: string, attachments: FeedbackAttachment[] = []): void {
    this.pending ??= {};
    if (provider) this.pending.provider = provider;
    if (message) this.instructions.push(message);
    this.attachments.push(...attachments);
    for (const attempt of this.attempts.values()) attempt.abort();
  }

  takeDirective(): RunDirective | undefined {
    const directive = this.pending;
    this.pending = undefined;
    return directive;
  }
}
