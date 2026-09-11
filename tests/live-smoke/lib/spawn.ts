import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "./redact.js";
import { proxyEnvironment } from "../../../src/sdk/proxy.js";
import { ChildProcessLifecycle } from "./process-lifecycle.js";

export interface ChildGateway {
  baseUrl: string;
  stateDir: string;
  workspaceDir: string;
  restart(): Promise<void>;
  restartWithoutLineage(): Promise<void>;
  stop(): Promise<void>;
  cleanup(): void;
}

export async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!port) throw new Error("failed to allocate loopback port");
  return port;
}

export async function startChildGateway(input: {
  repoRoot: string;
  distEntry: string;
  canaries: string[];
  readyTimeoutMs?: number;
  signal?: AbortSignal;
  onChild?: (child: ChildGateway) => void;
  stopTimeouts?: { graceMs?: number; killMs?: number };
}): Promise<ChildGateway> {
  let port = await freeLoopbackPort();
  input.signal?.throwIfAborted();
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-smoke-state-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-smoke-ws-"));
  let child = spawnChild({
    distEntry: input.distEntry,
    repoRoot: input.repoRoot,
    port,
    stateDir,
    workspaceDir,
  }, input.stopTimeouts);

  const readyTimeoutMs = input.readyTimeoutMs ?? 15_000;
  const stopping = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, stopping.signal]) : stopping.signal;
  let operation = Promise.resolve();
  let stopPromise: Promise<void> | undefined;
  let stopConfirmed = false;
  const restart = (withoutLineage: boolean): Promise<void> => {
    operation = operation.then(async () => {
      signal.throwIfAborted();
      await child.stop();
      signal.throwIfAborted();
      if (withoutLineage) rmSync(join(stateDir, "lineage"), { recursive: true, force: true });
      port = await freeLoopbackPort();
      signal.throwIfAborted();
      child = spawnChild({
        distEntry: input.distEntry,
        repoRoot: input.repoRoot,
        port,
        stateDir,
        workspaceDir,
      }, input.stopTimeouts);
      await waitHealth(`http://127.0.0.1:${port}`, readyTimeoutMs, child, input.canaries, signal);
    });
    return operation;
  };

  const handle: ChildGateway = {
    get baseUrl() {
      return `http://127.0.0.1:${port}`;
    },
    stateDir,
    workspaceDir,
    restart() {
      return restart(false);
    },
    restartWithoutLineage() {
      return restart(true);
    },
    stop() {
      stopping.abort();
      stopPromise ??= operation.catch(() => undefined).then(async () => {
        await child.stop();
        stopConfirmed = true;
      });
      return stopPromise;
    },
    cleanup() {
      if (!stopConfirmed || !child.hasClosed) {
        throw new Error("Cannot clean temporary state before gateway shutdown has completed");
      }
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    },
  };
  try {
    input.onChild?.(handle);
    await waitHealth(`http://127.0.0.1:${port}`, readyTimeoutMs, child, input.canaries, signal);
  } catch (error) {
    await handle.stop();
    handle.cleanup();
    throw error;
  }
  return handle;
}

function spawnChild(input: {
  distEntry: string;
  repoRoot: string;
  port: number;
  stateDir: string;
  workspaceDir: string;
}, stopTimeouts?: { graceMs?: number; killMs?: number }): ChildProcessLifecycle {
  const child = spawn(process.execPath, [input.distEntry], {
    cwd: input.repoRoot,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(input.port),
      AUTH_MODE: "byok",
      STATE_DIR: input.stateDir,
      EMPTY_WORKSPACE_DIR: input.workspaceDir,
      LOG_LEVEL: "error",
      DEBUG_PAYLOADS: "false",
      ...proxyEnvironment(process.env),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lifecycle = new ChildProcessLifecycle(child, stopTimeouts);
  child.stdout?.resume();
  child.stderr?.resume();
  return lifecycle;
}

async function waitHealth(
  baseUrl: string,
  timeoutMs: number,
  child: ChildProcessLifecycle,
  canaries: string[],
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "not contacted";
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (child.hasClosed || child.spawnFailed || child.child.exitCode !== null || child.child.signalCode !== null) {
      throw new Error("gateway child exited before ready");
    }
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
      if (res.ok) return;
      last = `http ${res.status}`;
    } catch (error) {
      last = error instanceof Error ? redactSecrets(error.message, canaries) : "fetch failed";
    }
    signal.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`gateway health not ready: ${last}`);
}
