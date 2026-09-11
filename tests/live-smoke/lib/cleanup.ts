import type { ChildGateway } from "./spawn.js";

/** Normal completion and signal termination share exactly one stop/cleanup operation. */
export function installSmokeCleanup(reportError: (error: unknown) => void): {
  signal: AbortSignal;
  attach(child: ChildGateway): void;
  finish(): Promise<void>;
  dispose(): void;
} {
  const abort = new AbortController();
  let child: ChildGateway | undefined;
  let finishing: Promise<void> | undefined;
  const finish = (): Promise<void> => {
    finishing ??= (async () => {
      if (!child) return;
      await child.stop();
      child.cleanup();
    })();
    return finishing;
  };
  const onSignal = (signal: "SIGINT" | "SIGTERM") => {
    abort.abort();
    void finish().then(
      () => process.exit(signal === "SIGINT" ? 130 : 143),
      (error) => {
        reportError(error);
        process.exit(1);
      },
    );
  };
  const onInterrupt = () => onSignal("SIGINT");
  const onTerminate = () => onSignal("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  return {
    signal: abort.signal,
    attach(next) {
      if (finishing) throw new Error("Live smoke is already stopping");
      child = next;
    },
    finish,
    dispose() {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    },
  };
}
