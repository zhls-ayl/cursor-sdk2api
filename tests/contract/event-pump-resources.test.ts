import { afterEach, expect, test, vi } from "vitest";
import { SystemClock } from "../../src/clock.js";
import { EventPump } from "../../src/core/event-pump.js";
import { Session } from "../../src/core/session.js";
import type { SdkRun } from "../../src/sdk/port.js";

afterEach(() => vi.useRealTimers());

function harness() {
  const clock = new SystemClock();
  const session = new Session({
    credentialFingerprint: "test-fingerprint",
    modelId: "test-model",
    sessionPolicyFingerprint: "test-policy",
    executableToolCatalogFingerprint: "test-catalog",
    instanceId: "test-instance",
    clock,
  });
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const run: SdkRun = {
    id: "test-run",
    async *stream() { await done; },
    async wait() { return { id: "test-run", status: "finished", result: "done" }; },
    async cancel() { finish(); },
  };
  const pump = new EventPump(session, run, clock, 1500, 40_000);
  return { clock, session, pump, finish };
}

test("first delta releases the first-event timer while the run is still active", async () => {
  vi.useFakeTimers();
  const { pump, finish } = harness();
  pump.start();
  expect(vi.getTimerCount()).toBe(1);
  pump.ingestDelta({ type: "text-delta", text: "hello" });
  expect(vi.getTimerCount()).toBe(0);
  finish();
  expect((await pump.waitForBoundary()).type).toBe("final");
  expect(vi.getTimerCount()).toBe(0);
});

test("early SDK output does not leave a redundant first-event timer", async () => {
  vi.useFakeTimers();
  const { pump, finish } = harness();
  pump.ingestDelta({ type: "thinking-delta", text: "early" });
  pump.start();
  expect(vi.getTimerCount()).toBe(0);
  finish();
  expect((await pump.waitForBoundary()).type).toBe("final");
});

test("staggered tool callbacks keep one timer and the complete 1500 ms batch window", async () => {
  vi.useFakeTimers();
  const { pump, session, clock } = harness();
  const first = session.createPending("lookup", { q: "first" }, clock);
  const second = session.createPending("lookup", { q: "second" }, clock);
  pump.notifyTool(first);
  await vi.advanceTimersByTimeAsync(500);
  pump.notifyTool(second);
  expect(vi.getTimerCount()).toBe(1);

  // The usage-only delta does not guarantee that all custom-tool callbacks arrived.
  pump.ingestDelta({ type: "turn-ended" });
  let settled = false;
  const boundary = pump.waitForBoundary().then((value) => { settled = true; return value; });
  await vi.advanceTimersByTimeAsync(1499);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const result = await boundary;
  expect(result.type).toBe("tools");
  if (result.type !== "tools") throw new Error("expected tool boundary");
  expect(result.turn.blocks.filter((block) => block.type === "tool_use")).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
  first.resolve("done");
  second.resolve("done");
});

test("a first-event timeout leaves no timer behind", async () => {
  vi.useFakeTimers();
  const { pump, finish } = harness();
  pump.start();
  await vi.advanceTimersByTimeAsync(40_000);
  expect((await pump.waitForBoundary()).type).toBe("error");
  expect(vi.getTimerCount()).toBe(0);
  finish();
});
