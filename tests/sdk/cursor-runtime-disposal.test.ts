import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const sdk = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("@cursor/sdk", () => ({
  Agent: { create: sdk.create },
  Cursor: {},
  JsonlLocalAgentStore: class {},
}));

import { createCursorRuntime } from "../../src/sdk/cursor-runtime.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "cursor-runtime-disposal-test-"));
  sdk.create.mockReset();
});

afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

async function wrap(agent: { agentId: string; close: () => void; [Symbol.asyncDispose]?: () => Promise<void> }) {
  sdk.create.mockResolvedValue(agent);
  return createCursorRuntime({ stateDir }).createAgent({
    apiKey: "test-key",
    modelId: "test-model",
    workspaceDir: join(stateDir, "workspace"),
    clientToolNames: [],
    customTools: {},
  });
}

test("adapter close awaits one SDK asyncDispose with the SDK Agent receiver", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const raw = {
    agentId: "test-agent",
    close: vi.fn(),
    [Symbol.asyncDispose]: vi.fn(async function (this: { agentId: string }) {
      expect(this.agentId).toBe("test-agent");
      await pending;
    }),
  };
  const agent = await wrap(raw);
  const closing = agent.close();
  expect(agent.close()).toBe(closing);
  let settled = false;
  void Promise.resolve(closing).then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(raw.close).not.toHaveBeenCalled();
  expect(raw[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
  release();
  await closing;
  expect(settled).toBe(true);
});

test("adapter close propagates asyncDispose rejection without retrying unsafe cleanup", async () => {
  const error = new Error("SDK disposal failed");
  const raw = {
    agentId: "test-agent",
    close: vi.fn(),
    [Symbol.asyncDispose]: vi.fn(async () => { throw error; }),
  };
  const agent = await wrap(raw);
  await expect(agent.close()).rejects.toBe(error);
  await expect(agent.close()).rejects.toBe(error);
  expect(raw[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
  expect(raw.close).not.toHaveBeenCalled();
});

test("adapter close falls back to close only when asyncDispose is unavailable", async () => {
  const raw = { agentId: "test-agent", close: vi.fn() };
  const agent = await wrap(raw);
  await agent.close();
  await agent.close();
  expect(raw.close).toHaveBeenCalledTimes(1);
});

test("adapter close propagates synchronous fallback failure", async () => {
  const error = new Error("SDK close failed");
  const raw = { agentId: "test-agent", close: vi.fn(() => { throw error; }) };
  const agent = await wrap(raw);
  await expect(agent.close()).rejects.toBe(error);
});
