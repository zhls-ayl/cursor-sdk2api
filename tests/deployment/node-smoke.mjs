#!/usr/bin/env node
// Run the built package with synthetic local configuration and an empty account
// pool. No caller environment, .env file, or upstream credential is inherited.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
// Parse this deliberately simple command, then execute Node directly so that
// SIGTERM reaches the gateway rather than an npm or shell parent process.
const start = manifest.scripts?.start?.trim().split(/\s+/);
assert.deepEqual(start, ["node", "--env-file-if-exists=.env", "dist/index.js"],
  "Update this smoke's safe start-command parser when the package start command changes");
await access(join(repoRoot, "dist", "index.js"));
await access(join(repoRoot, "dist", "console", "index.html"));

const interruption = new AbortController();
const onInterrupt = () => { process.exitCode = 130; interruption.abort(); };
const onTerminate = () => { process.exitCode = 143; interruption.abort(); };
process.once("SIGINT", onInterrupt);
process.once("SIGTERM", onTerminate);

const smokeDir = await mkdtemp(join(tmpdir(), "cursor-sdk2api-node-smoke-"));
try {
  await cp(join(repoRoot, "dist"), join(smokeDir, "dist"), { recursive: true });
  await copyFile(join(repoRoot, "package.json"), join(smokeDir, "package.json"));
  await symlink(join(repoRoot, "node_modules"), join(smokeDir, "node_modules"), "dir");

  for (const scenario of ["dotenv", "environment-override", "without-dotenv"]) {
    interruption.signal.throwIfAborted();
    await runScenario(scenario);
    console.log(`Node start smoke passed: ${scenario}`);
  }
} finally {
  // runScenario always waits for the child to close before this tree is removed.
  await rm(smokeDir, { recursive: true, force: true });
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onTerminate);
}

async function runScenario(scenario) {
  const port = await freeLoopbackPort();
  const caseDir = join(smokeDir, scenario);
  const stateDir = join(caseDir, "state");
  const workspaceDir = join(caseDir, "workspace");
  await mkdir(caseDir, { recursive: true, mode: 0o700 });
  const syntheticKey = `node-smoke-${scenario}-synthetic-key`;
  const dotenvKey = "node-smoke-ignored-dotenv-synthetic-key";
  const config = {
    AUTH_MODE: "managed",
    GATEWAY_ACCESS_KEY: syntheticKey,
    HOST: "127.0.0.1",
    PORT: String(port),
    STATE_DIR: stateDir,
    EMPTY_WORKSPACE_DIR: workspaceDir,
    LOG_LEVEL: "error",
  };
  const envFile = join(smokeDir, ".env");
  const env = {
    PATH: dirname(process.execPath),
    NODE_ENV: "production",
  };
  if (scenario === "without-dotenv") {
    await rm(envFile, { force: true });
    Object.assign(env, config);
  } else {
    const fileConfig = scenario === "environment-override"
      ? { ...config, PORT: "not-a-port", GATEWAY_ACCESS_KEY: dotenvKey }
      : config;
    await writeFile(envFile, Object.entries(fileConfig)
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n") + "\n", { mode: 0o600 });
    if (scenario === "environment-override") {
      env.PORT = String(port);
      env.GATEWAY_ACCESS_KEY = syntheticKey;
    }
  }

  const child = spawn(process.execPath, start.slice(1), {
    cwd: smokeDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let outcome;
  let spawnFailed = false;
  let output = "";
  const collect = (chunk) => { output = (output + chunk.toString()).slice(-16_384); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("error", () => { spawnFailed = true; });
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      outcome = { code, signal };
      resolve(outcome);
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const request = (path, init = {}) => fetch(`${origin}${path}`, {
    ...init,
    signal: AbortSignal.any([interruption.signal, AbortSignal.timeout(2_000)]),
  });

  try {
    const deadline = Date.now() + 15_000;
    let live = false;
    while (Date.now() < deadline && !live) {
      interruption.signal.throwIfAborted();
      assert.ok(!spawnFailed && !outcome, `${scenario}: gateway exited before listening`);
      try {
        const response = await request("/livez");
        live = response.status === 200;
        await response.arrayBuffer();
      } catch {
        interruption.signal.throwIfAborted();
      }
      if (!live) await delay(100, undefined, { signal: interruption.signal });
    }
    assert.ok(live, `${scenario}: gateway did not become live within 15 seconds`);

    const healthResponse = await request("/health");
    assert.equal(healthResponse.status, 503, `${scenario}: empty managed pool must not be ready`);
    const health = await healthResponse.json();
    assert.equal(health.status, "not_ready");
    assert.equal(health.readiness.scope, "local");
    assert.equal(health.readiness.upstream_verified, false);
    assert.equal(health.readiness.credential_pool_ready, false);
    assert.deepEqual(health.readiness.reasons, ["cursor_account_pool_empty"]);

    const roster = await request("/v0/management/accounts");
    assert.equal(roster.status, 200);
    assert.deepEqual((await roster.json()).accounts, []);
    // Only query models after proving managed mode with no stored credentials:
    // this route returns its empty-pool response without any upstream request.
    const rejected = await request("/v1/models", {
      headers: { authorization: `Bearer ${dotenvKey}` },
    });
    assert.equal(rejected.status, 401, `${scenario}: incorrect gateway key must be rejected`);
    await rejected.arrayBuffer();
    const models = await request("/v1/models", {
      headers: { authorization: `Bearer ${syntheticKey}` },
    });
    assert.equal(models.status, 200, `${scenario}: configured gateway key must be accepted`);
    assert.deepEqual(await models.json(), {
      object: "list",
      data: [],
      status: "unavailable",
      reason: "cursor_account_pool_empty",
      cache: { stale: false },
      account_pool_size: 0,
    });
    const consoleResponse = await request("/console/");
    assert.equal(consoleResponse.status, 200, `${scenario}: built console must be served`);
    assert.match(consoleResponse.headers.get("content-type"), /text\/html/);
    assert.match(await consoleResponse.text(), /<!doctype html>/i);

    child.kill("SIGTERM");
    const exit = await deadlineResult(closed, 8_000);
    assert.ok(exit, `${scenario}: idle SIGTERM did not terminate within eight seconds`);
    assert.deepEqual(exit, { code: 0, signal: null }, `${scenario}: idle SIGTERM must exit cleanly`);
    assert.ok(!output.includes(syntheticKey) && !output.includes(dotenvKey),
      `${scenario}: synthetic key leaked into process output`);
  } finally {
    if (!outcome) {
      child.kill("SIGTERM");
      if (!await deadlineResult(closed, 2_000)) {
        child.kill("SIGKILL");
        // Always reap the actual child before deleting its state/workspace.
        await closed;
      }
    }
    await rm(caseDir, { recursive: true, force: true });
    await rm(envFile, { force: true });
  }
}

async function freeLoopbackPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const closed = once(server, "close");
  server.close();
  await closed;
  return address.port;
}

async function deadlineResult(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
