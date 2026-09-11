import type { ChildProcess } from "node:child_process";

/** Attach immediately after spawn so even an early spawn failure is observed. */
export class ChildProcessLifecycle {
  private closed = false;
  private readonly closedPromise: Promise<void>;
  private stopping?: Promise<void>;
  spawnFailed = false;

  constructor(
    readonly child: ChildProcess,
    private readonly options: { graceMs?: number; killMs?: number } = {},
  ) {
    this.closedPromise = new Promise((resolve) => {
      child.once("close", () => {
        this.closed = true;
        resolve();
      });
    });
    child.on("error", () => { this.spawnFailed = !child.pid; });
  }

  get hasClosed(): boolean {
    return this.closed;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const stopping = this.stopOnce();
    this.stopping = stopping;
    void stopping.catch(() => {
      if (this.stopping === stopping) this.stopping = undefined;
    });
    return stopping;
  }

  private async stopOnce(): Promise<void> {
    if (this.closed) return;
    // killed only records successful signal delivery; it says nothing about exit.
    if (!this.hasExited()) this.child.kill("SIGTERM");
    if (await this.waitForClose(this.options.graceMs ?? 8_000)) return;
    if (!this.hasExited()) this.child.kill("SIGKILL");
    if (!(await this.waitForClose(this.options.killMs ?? 5_000))) {
      throw new Error(`Gateway child ${this.child.pid ?? "unknown"} did not close after shutdown; temporary state retained`);
    }
  }

  private hasExited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  private waitForClose(timeoutMs: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void this.closedPromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
