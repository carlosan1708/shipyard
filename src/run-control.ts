import type { Provider } from "./config.ts";

export interface RunDirective {
  provider?: Provider;
}

/** Coordinates interruptions with the pipeline. Each attempt owns its process and inbox requests. */
export class RunControl {
  private attempt?: AbortController;
  private pending?: RunDirective;
  readonly instructions: string[] = [];
  stopped = false;

  beginAttempt(): AbortSignal {
    this.attempt = new AbortController();
    if (this.stopped) this.attempt.abort();
    return this.attempt.signal;
  }

  stop(): void {
    this.stopped = true;
    this.attempt?.abort();
  }

  redirect(provider: Provider | undefined, message: string): void {
    this.pending ??= {};
    if (provider) this.pending.provider = provider;
    if (message) this.instructions.push(message);
    this.attempt?.abort();
  }

  takeDirective(): RunDirective | undefined {
    const directive = this.pending;
    this.pending = undefined;
    return directive;
  }
}
