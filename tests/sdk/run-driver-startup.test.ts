import { expect, test } from "vitest";
import { FakeClock } from "../../src/clock.js";
import { Session } from "../../src/core/session.js";
import { SdkRunDriver, SdkStartupInterruptedError, type DriveSdkRunInput } from "../../src/core/sdk-run-driver.js";
import type { SdkRun } from "../../src/sdk/port.js";
import { FakeSdk } from "../fixtures/fake-sdk.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const clock = new FakeClock();
  const sdk = new FakeSdk({ scripts: [[{ type: "hang" }]] });
  const session = new Session({
    clock,
    credentialFingerprint: "test-fingerprint",
    modelId: "composer-2.5",
    sessionPolicyFingerprint: "test-policy",
    executableToolCatalogFingerprint: "test-tools",
    instanceId: "test-instance",
  });
  const driver = new SdkRunDriver({ sdk, clock, toolBatchSettleMs: 0, firstEventTimeoutMs: 100 });
  const input: DriveSdkRunInput = {
    session,
    tools: [],
    agent: { type: "create", apiKey: "test-key", workspaceDir: "/unused-fake-workspace" },
    send: { text: "test" },
  };
  return { clock, sdk, session, driver, input };
}

test.each(["create", "resume"] as const)("%s startup timeout closes the late Agent without sending", async (kind) => {
  const { clock, sdk, session, driver, input } = setup();
  const held = gate();
  const returned = gate();
  const entered = gate();
  if (kind === "resume") {
    input.agent = { type: "resume", agentId: "test-agent", apiKey: "test-key", workspaceDir: "/unused-fake-workspace" };
    const original = sdk.resumeAgent.bind(sdk);
    sdk.resumeAgent = async (args) => {
      entered.resolve();
      await held.promise;
      const agent = await original(args);
      returned.resolve();
      return agent;
    };
  } else {
    const original = sdk.createAgent.bind(sdk);
    sdk.createAgent = async (args) => {
      entered.resolve();
      await held.promise;
      const agent = await original(args);
      returned.resolve();
      return agent;
    };
  }
  const started = driver.start(input);
  const rejected = expect(started).rejects.toMatchObject({ code: "cursor_timeout", httpStatus: 504 });
  await entered.promise;
  clock.advance(100);
  await rejected;
  expect(sdk.agents).toHaveLength(0);
  held.resolve();
  await returned.promise;
  await Promise.resolve();
  expect(sdk.agents[0]?.closed).toBe(true);
  expect(sdk.agents[0]?.sendCount).toBe(0);
  expect(session.run).toBeUndefined();
});

test("a pre-aborted request never creates an SDK Agent", async () => {
  const { sdk, driver, input } = setup();
  const abort = new AbortController();
  abort.abort();
  await expect(driver.start({ ...input, signal: abort.signal })).rejects.toBeInstanceOf(SdkStartupInterruptedError);
  expect(sdk.createCalls).toHaveLength(0);
});

test.each(["timeout", "disconnect"] as const)("pending send %s waits before disposing the Agent and cancels the late Run", async (reason) => {
  const { clock, sdk, session, driver, input } = setup();
  const held = gate();
  const atSend = gate();
  const abort = new AbortController();
  let lateRun: SdkRun | undefined;
  const originalCreate = sdk.createAgent.bind(sdk);
  sdk.createAgent = async (args) => {
    const agent = await originalCreate(args);
    const originalSend = agent.send.bind(agent);
    agent.send = async (send) => {
      lateRun = await originalSend(send);
      atSend.resolve();
      await held.promise;
      return lateRun;
    };
    return agent;
  };
  const started = driver.start({ ...input, signal: abort.signal });
  const rejected = expect(started).rejects.toBeInstanceOf(SdkStartupInterruptedError);
  await atSend.promise;
  if (reason === "timeout") clock.advance(100);
  else abort.abort();
  await rejected;
  expect(sdk.agents[0]?.closed).toBe(false);
  expect(session.agent).toBeUndefined();
  expect(sdk.agents[0]?.runs[0]?.cancelled).toBe(false);
  held.resolve();
  await held.promise;
  await Promise.resolve();
  expect(sdk.agents[0]?.runs[0]?.cancelled).toBe(true);
  expect(sdk.agents[0]?.runs[0]?.streamStarts).toBe(0);
  expect(session.run).toBeUndefined();
  expect(session.pump).toBeUndefined();
});

test.each([false, true])("late Run terminal confirmation precedes Agent disposal (cancel rejects: %s)", async (cancelRejects) => {
  const { clock, sdk, driver, input } = setup();
  const returned = gate();
  const terminal = gate();
  const entered = gate();
  const waiting = gate();
  const create = sdk.createAgent.bind(sdk);
  sdk.createAgent = async (args) => {
    const agent = await create(args);
    const send = agent.send.bind(agent);
    agent.send = async (args) => {
      const run = await send(args);
      const wait = run.wait.bind(run);
      const cancel = run.cancel.bind(run);
      run.cancel = async () => { await cancel(); if (cancelRejects) throw new Error("cancellation acknowledgement failed"); };
      run.wait = async () => { waiting.resolve(); await terminal.promise; return wait(); };
      entered.resolve();
      await returned.promise;
      return run;
    };
    return agent;
  };
  const started = driver.start(input).catch((error: unknown) => error);
  await entered.promise;
  clock.advance(100);
  const error = await started as SdkStartupInterruptedError;
  let settled = false;
  void error.pendingSettlement.then(() => { settled = true; });
  expect(sdk.agents[0]?.closed).toBe(false);
  returned.resolve();
  await waiting.promise;
  expect(sdk.agents[0]?.runs[0]?.cancelled).toBe(true);
  expect(sdk.agents[0]?.closed).toBe(false);
  expect(settled).toBe(false);
  terminal.resolve();
  if (cancelRejects) await new Promise<void>((done) => setImmediate(done));
  else await error.pendingSettlement;
  expect(sdk.agents[0]?.closed).toBe(true);
  expect(settled).toBe(!cancelRejects);
});

test("SDK startup and first-event observation share the same deadline budget", async () => {
  const { clock, sdk, driver, input } = setup();
  const held = gate();
  const original = sdk.createAgent.bind(sdk);
  sdk.createAgent = async (args) => { await held.promise; return original(args); };
  const started = driver.start(input);
  clock.advance(70);
  held.resolve();
  const pump = await started;
  pump.start();
  let finished = false;
  const boundary = pump.waitForBoundary().then((result) => { finished = true; return result; });
  clock.advance(29);
  await Promise.resolve();
  expect(finished).toBe(false);
  clock.advance(1);
  expect(await boundary).toMatchObject({ type: "error", error: { code: "cursor_timeout" } });
  await sdk.agents[0]?.runs[0]?.cancel();
});

test("a late custom-tool callback cannot recreate pending work after startup cancellation", async () => {
  const { sdk, driver, input, session } = setup();
  const abort = new AbortController();
  const held = gate();
  const atSend = gate();
  input.tools = [{ name: "lookup", input_schema: { type: "object" } }];
  const original = sdk.createAgent.bind(sdk);
  sdk.createAgent = async (args) => {
    const agent = await original(args);
    const send = agent.send.bind(agent);
    agent.send = async (args) => { atSend.resolve(); await held.promise; return send(args); };
    return agent;
  };
  const started = driver.start({ ...input, signal: abort.signal });
  const rejected = expect(started).rejects.toBeInstanceOf(SdkStartupInterruptedError);
  await atSend.promise;
  abort.abort();
  await rejected;
  expect(() => sdk.lastCreate?.customTools.lookup?.execute({}, { toolCallId: "late-call" }))
    .toThrow(SdkStartupInterruptedError);
  expect(session.pending.size).toBe(0);
  held.resolve();
  await held.promise;
});

test.each(["timeout", "disconnect"] as const)("startup preparation %s prevents a late SDK create", async (reason) => {
  const { clock, sdk, driver, input } = setup();
  const held = gate();
  const abort = new AbortController();
  const starting = driver.start({ ...input, signal: abort.signal, beforeAgentStart: () => held.promise });
  const interrupted = starting.catch((error: unknown) => error);
  if (reason === "timeout") clock.advance(100);
  else abort.abort();
  const error = await interrupted;
  expect(error).toBeInstanceOf(SdkStartupInterruptedError);
  held.resolve();
  await (error as SdkStartupInterruptedError).pendingSettlement;
  expect(sdk.createCalls).toHaveLength(0);
});

test("interrupted startup settlement waits for the SDK return and asynchronous cleanup", async () => {
  const { clock, sdk, driver, input } = setup();
  const returned = gate();
  const closing = gate();
  const atSend = gate();
  const create = sdk.createAgent.bind(sdk);
  sdk.createAgent = async (args) => {
    const agent = await create(args);
    const send = agent.send.bind(agent);
    const close = agent.close.bind(agent);
    agent.close = async () => { await closing.promise; await close(); };
    agent.send = async (args) => {
      const run = await send(args);
      atSend.resolve();
      await returned.promise;
      return run;
    };
    return agent;
  };
  const interrupted = driver.start(input).catch((error: unknown) => error);
  await atSend.promise;
  clock.advance(100);
  const error = await interrupted as SdkStartupInterruptedError;
  expect(error).toBeInstanceOf(SdkStartupInterruptedError);
  let settled = false;
  void error.pendingSettlement.then(() => { settled = true; });
  expect(settled).toBe(false);
  returned.resolve();
  await returned.promise;
  await Promise.resolve();
  expect(sdk.agents[0]?.runs[0]?.cancelled).toBe(true);
  expect(settled).toBe(false);
  closing.resolve();
  await error.pendingSettlement;
  expect(sdk.agents[0]?.closed).toBe(true);
  expect(settled).toBe(true);
});

test("failed late cleanup keeps the interrupted startup retry gate closed", async () => {
  const { clock, sdk, driver, input } = setup();
  const held = gate();
  const entered = gate();
  const create = sdk.createAgent.bind(sdk);
  sdk.createAgent = async (args) => {
    const agent = await create(args);
    agent.close = async () => { throw new Error("cleanup unavailable"); };
    entered.resolve();
    await held.promise;
    return agent;
  };
  const interrupted = driver.start(input).catch((error: unknown) => error);
  await entered.promise;
  clock.advance(100);
  const error = await interrupted as SdkStartupInterruptedError;
  let settled = false;
  void error.pendingSettlement.then(() => { settled = true; });
  held.resolve();
  await new Promise<void>((done) => setImmediate(done));
  expect(settled).toBe(false);
  expect(sdk.agents[0]?.sendCount).toBe(0);
});

test("a failed Send with blocked disposal still respects the startup deadline", async () => {
  const { clock, sdk, driver, input } = setup();
  const closing = gate();
  const entered = gate();
  const create = sdk.createAgent.bind(sdk);
  sdk.createAgent = async (args) => {
    const agent = await create(args);
    agent.send = async () => { throw new Error("upstream failed"); };
    agent.close = async () => { entered.resolve(); await closing.promise; };
    return agent;
  };
  const started = driver.start(input).catch((error: unknown) => error);
  await entered.promise;
  clock.advance(100);
  const error = await started as SdkStartupInterruptedError;
  expect(error).toBeInstanceOf(SdkStartupInterruptedError);
  let settled = false;
  void error.pendingSettlement.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  closing.resolve();
  await error.pendingSettlement;
});

test("failed disposal after a Send error retains the protected startup gate", async () => {
  const { sdk, driver, input } = setup();
  const create = sdk.createAgent.bind(sdk);
  sdk.createAgent = async (args) => {
    const agent = await create(args);
    agent.send = async () => { throw new Error("upstream failed"); };
    agent.close = async () => { throw new Error("disposal failed"); };
    return agent;
  };
  const error = await driver.start(input).catch((error: unknown) => error) as SdkStartupInterruptedError;
  expect(error).toBeInstanceOf(SdkStartupInterruptedError);
  expect(error).toMatchObject({ code: "cursor_upstream_error", httpStatus: 502 });
  let settled = false;
  void error.pendingSettlement.then(() => { settled = true; });
  await new Promise<void>((done) => setImmediate(done));
  expect(settled).toBe(false);
});
