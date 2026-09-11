import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { installSmokeCleanup } from "./lib/cleanup.js";
import { ChildProcessLifecycle } from "./lib/process-lifecycle.js";
import { startChildGateway, type ChildGateway } from "./lib/spawn.js";

const running = new Set<ChildProcessLifecycle>();
const directories = new Set<string>();

afterEach(async () => {
  await Promise.all([...running].map((lifecycle) => lifecycle.stop()));
  running.clear();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

function watch(child: ChildProcess, graceMs = 50): ChildProcessLifecycle {
  const lifecycle = new ChildProcessLifecycle(child, { graceMs, killMs: 2_000 });
  running.add(lifecycle);
  return lifecycle;
}

function expectGone(pid: number): void {
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
}

function fixture(ready = true): { directory: string; entry: string } {
  const directory = mkdtempSync(join(tmpdir(), "cursor-smoke-lifecycle-test-"));
  directories.add(directory);
  const entry = join(directory, "gateway.cjs");
  writeFileSync(entry, `
    const { createServer } = require('node:http');
    const { writeFileSync } = require('node:fs');
    const { join } = require('node:path');
    writeFileSync(join(process.env.STATE_DIR, 'child.pid'), String(process.pid));
    process.on('SIGTERM', () => {});
    createServer((req, res) => { res.statusCode = ${ready ? 200 : 503}; res.end('{}'); }).listen(Number(process.env.PORT), '127.0.0.1');
  `);
  return { directory, entry };
}

test("stop waits for actual close despite killed=true and shares concurrent calls", async () => {
  const child = spawn(process.execPath, ["-e", `
    process.on('SIGTERM', () => {});
    console.log('ready');
    setInterval(() => {}, 1000);
  `], { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "ignore"] });
  const lifecycle = watch(child);
  await once(child.stdout!, "data");
  child.kill("SIGTERM");
  expect(child.killed).toBe(true);
  expect(child.exitCode).toBeNull();
  const first = lifecycle.stop();
  expect(lifecycle.stop()).toBe(first);
  await first;
  expect(lifecycle.hasClosed).toBe(true);
  expect(child.signalCode).toBe("SIGKILL");
  expectGone(child.pid!);
  await lifecycle.stop();
});

test("graceful stop waits for delayed exit rather than signal delivery", async () => {
  const child = spawn(process.execPath, ["-e", `
    process.on('SIGTERM', () => setTimeout(() => process.exit(0), 150));
    console.log('ready');
    setInterval(() => {}, 1000);
  `], { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "ignore"] });
  const lifecycle = watch(child, 2_000);
  await once(child.stdout!, "data");
  const started = Date.now();
  await lifecycle.stop();
  expect(Date.now() - started).toBeGreaterThanOrEqual(125);
  expect(child.exitCode).toBe(0);
  expect(lifecycle.hasClosed).toBe(true);
  expectGone(child.pid!);
});

test("SIGKILL escalation still waits for close when inherited stdio outlives the child", async () => {
  const child = spawn(process.execPath, ["-e", `
    const { spawn } = require('node:child_process');
    const follower = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 450)'], {
      env: { PATH: process.env.PATH }, stdio: ['ignore', process.stdout, 'ignore'],
    });
    process.on('SIGTERM', () => {});
    console.log(JSON.stringify({ pid: follower.pid }));
    setInterval(() => {}, 1000);
  `], { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "ignore"] });
  const lifecycle = watch(child);
  const [data] = await once(child.stdout!, "data") as [Buffer];
  const followerPid = (JSON.parse(data.toString()) as { pid: number }).pid;
  try {
    const started = Date.now();
    await lifecycle.stop();
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(child.signalCode).toBe("SIGKILL");
    expect(lifecycle.hasClosed).toBe(true);
    expectGone(child.pid!);
  } finally {
    try { process.kill(followerPid, "SIGKILL"); } catch { /* already exited */ }
  }
});

test("gateway cleanup requires confirmed shutdown and is idempotent afterward", async () => {
  const { directory, entry } = fixture();
  let gateway: ChildGateway | undefined;
  try {
    gateway = await startChildGateway({
      repoRoot: directory, distEntry: entry, canaries: [], stopTimeouts: { graceMs: 50, killMs: 2_000 },
    });
    const pid = Number(readFileSync(join(gateway.stateDir, "child.pid"), "utf8"));
    expect(() => gateway!.cleanup()).toThrow(/shutdown/);
    expect(existsSync(gateway.stateDir)).toBe(true);
    const first = gateway.stop();
    expect(gateway.stop()).toBe(first);
    await first;
    expectGone(pid);
    gateway.cleanup();
    gateway.cleanup();
    expect(existsSync(gateway.stateDir)).toBe(false);
    expect(existsSync(gateway.workspaceDir)).toBe(false);
  } finally {
    if (gateway) {
      await gateway.stop();
      gateway.cleanup();
    }
  }
});

test("stop wins over a queued restart before state cleanup", async () => {
  const { directory, entry } = fixture();
  const gateway = await startChildGateway({
    repoRoot: directory, distEntry: entry, canaries: [], stopTimeouts: { graceMs: 50, killMs: 2_000 },
  });
  try {
    const pid = Number(readFileSync(join(gateway.stateDir, "child.pid"), "utf8"));
    const restart = gateway.restart();
    const stop = gateway.stop();
    const [restarted] = await Promise.allSettled([restart, stop]);
    expect(restarted.status).toBe("rejected");
    await stop;
    expectGone(pid);
    gateway.cleanup();
    expect(existsSync(gateway.stateDir)).toBe(false);
  } finally {
    await gateway.stop();
    gateway.cleanup();
  }
});

test("cleanup helper preserves state if stop fails and removes its signal listeners", async () => {
  const beforeInt = process.listenerCount("SIGINT");
  const beforeTerm = process.listenerCount("SIGTERM");
  const cleanup = vi.fn();
  const stop = vi.fn(async () => { throw new Error("stop failed"); });
  const lifecycle = installSmokeCleanup(() => undefined);
  lifecycle.attach({ stop, cleanup } as unknown as ChildGateway);
  try {
    const first = lifecycle.finish();
    expect(lifecycle.finish()).toBe(first);
    await expect(first).rejects.toThrow("stop failed");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
  } finally {
    lifecycle.dispose();
  }
  expect(process.listenerCount("SIGINT")).toBe(beforeInt);
  expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
});

test.each(["SIGINT", "SIGTERM"] as const)("%s stops the real child and removes state before the runner exits", async (signal) => {
  const { directory, entry } = fixture();
  const cleanupUrl = new URL("./lib/cleanup.ts", import.meta.url).href;
  const spawnUrl = new URL("./lib/spawn.ts", import.meta.url).href;
  const runner = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { installSmokeCleanup } from ${JSON.stringify(cleanupUrl)};
    import { startChildGateway } from ${JSON.stringify(spawnUrl)};
    const cleanup = installSmokeCleanup(() => process.stderr.write('shutdown failed'));
    const gateway = await startChildGateway({
      repoRoot: ${JSON.stringify(directory)}, distEntry: ${JSON.stringify(entry)}, canaries: [],
      stopTimeouts: { graceMs: 50, killMs: 2000 }, signal: cleanup.signal, onChild: cleanup.attach,
    });
    console.log(JSON.stringify({ stateDir: gateway.stateDir, workspaceDir: gateway.workspaceDir }));
    setInterval(() => {}, 1000);
  `], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"],
  });
  const lifecycle = watch(runner, 3_000);
  const [data] = await once(runner.stdout!, "data") as [Buffer];
  const paths = JSON.parse(data.toString()) as { stateDir: string; workspaceDir: string };
  const pid = Number(readFileSync(join(paths.stateDir, "child.pid"), "utf8"));
  const closed = once(runner, "close");
  runner.kill(signal);
  await closed;
  expect(lifecycle.hasClosed).toBe(true);
  expect(runner.exitCode).toBe(signal === "SIGINT" ? 130 : 143);
  expectGone(pid);
  expect(existsSync(paths.stateDir)).toBe(false);
  expect(existsSync(paths.workspaceDir)).toBe(false);
});

test("a signal during startup cleans the child before health becomes ready", async () => {
  const { directory, entry } = fixture(false);
  const cleanupUrl = new URL("./lib/cleanup.ts", import.meta.url).href;
  const spawnUrl = new URL("./lib/spawn.ts", import.meta.url).href;
  const runner = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { installSmokeCleanup } from ${JSON.stringify(cleanupUrl)};
    import { startChildGateway } from ${JSON.stringify(spawnUrl)};
    const cleanup = installSmokeCleanup(() => process.stderr.write('shutdown failed'));
    try {
      await startChildGateway({
        repoRoot: ${JSON.stringify(directory)}, distEntry: ${JSON.stringify(entry)}, canaries: [],
        stopTimeouts: { graceMs: 50, killMs: 2000 }, signal: cleanup.signal,
        onChild(child) {
          cleanup.attach(child);
          console.log(JSON.stringify({ stateDir: child.stateDir, workspaceDir: child.workspaceDir }));
        },
      });
    } catch (error) {
      if (!cleanup.signal.aborted) throw error;
    } finally {
      await cleanup.finish();
      cleanup.dispose();
    }
  `], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"],
  });
  const lifecycle = watch(runner, 3_000);
  const [data] = await once(runner.stdout!, "data") as [Buffer];
  const paths = JSON.parse(data.toString()) as { stateDir: string; workspaceDir: string };
  await vi.waitFor(() => expect(existsSync(join(paths.stateDir, "child.pid"))).toBe(true));
  const pid = Number(readFileSync(join(paths.stateDir, "child.pid"), "utf8"));
  const closed = once(runner, "close");
  runner.kill("SIGTERM");
  await closed;
  expect(lifecycle.hasClosed).toBe(true);
  expect(runner.exitCode).toBe(143);
  expectGone(pid);
  expect(existsSync(paths.stateDir)).toBe(false);
  expect(existsSync(paths.workspaceDir)).toBe(false);
});
