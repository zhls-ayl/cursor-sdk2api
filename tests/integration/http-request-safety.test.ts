import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { SystemClock } from "../../src/clock.js";
import { loadConfig } from "../../src/config.js";
import { createApp, type App } from "../../src/server/app.js";
import { FakeSdk } from "../fixtures/fake-sdk.js";

let app: App | undefined;
let server: Server | undefined;
let stateDir: string | undefined;

afterEach(async () => {
  app?.beginShutdown();
  app?.close();
  if (server) await new Promise<void>((resolve, reject) => {
    server!.close((error) => error ? reject(error) : resolve());
  });
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  app = undefined;
  server = undefined;
  stateDir = undefined;
});

async function listen(failErrorLogging = false): Promise<{ port: number; logs: string[] }> {
  stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-http-safety-"));
  const logs: string[] = [];
  app = createApp({
    config: loadConfig({ host: "127.0.0.1", port: 0, authMode: "byok", managedCursorKey: undefined, stateDir }),
    sdk: new FakeSdk(),
    clock: new SystemClock(),
    workspaceDir: stateDir,
    logger: {
      info: () => undefined,
      warn: (fields, message) => {
        if (failErrorLogging) throw new Error("private-logger-failure-payload");
        logs.push(JSON.stringify({ ...fields, message }));
      },
      error: (fields, message) => logs.push(JSON.stringify({ ...fields, message })),
    },
    sandHealth: { ready: true, sdk_version: "1.0.30", patch_contract_version: "1.0.30" },
  });
  // Exercise the production callback, including its final rejection boundary.
  server = app.listen();
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  return { port: address.port, logs };
}

async function rawRequest(port: number, target: string): Promise<string> {
  const socket = connect(port, "127.0.0.1");
  socket.setTimeout(2_000, () => socket.destroy(new Error("test request timed out")));
  socket.setEncoding("utf8");
  let response = "";
  socket.on("data", (chunk: string) => { response += chunk; });
  const closed = once(socket, "close");
  socket.on("connect", () => {
    socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
  });
  await closed;
  return response;
}

test("malformed request targets return safe 400s and leave the real listener healthy", async () => {
  const { port, logs } = await listen();
  for (const target of ["//[", "//[private-request-target-canary", "http://["]) {
    const response = await rawRequest(port, target);
    expect(response).toMatch(/^HTTP\/1\.1 400 /);
    expect(response).toContain("Invalid request target");
    expect(response).not.toContain(target);
  }
  expect(logs.join("\n")).not.toContain("private-request-target-canary");
  expect(logs.join("\n")).not.toContain("ERR_INVALID_URL");
  expect((await fetch(`http://127.0.0.1:${port}/livez`)).status).toBe(200);
  expect((await fetch(`http://127.0.0.1:${port}/v1/models`)).status).toBe(401);
});

test("a failure in error handling is contained without exposing its payload", async () => {
  const { port, logs } = await listen(true);
  const response = await rawRequest(port, "//[private-request-target-canary");
  expect(response).toMatch(/^HTTP\/1\.1 500 /);
  expect(response).toContain("Internal server error");
  expect(`${response}\n${logs.join("\n")}`).not.toContain("private-request-target-canary");
  expect(`${response}\n${logs.join("\n")}`).not.toContain("private-logger-failure-payload");
  expect((await fetch(`http://127.0.0.1:${port}/livez`)).status).toBe(200);
});
