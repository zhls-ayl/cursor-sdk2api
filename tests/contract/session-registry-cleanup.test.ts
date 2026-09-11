import { expect, test, vi } from "vitest";
import { FakeClock } from "../../src/clock.js";
import { SessionRegistry } from "../../src/core/session-registry.js";

test.each(["synchronous", "asynchronous"] as const)("forget remains best effort when SDK close fails %sly", async (kind) => {
  const clock = new FakeClock();
  const registry = new SessionRegistry(clock, "test-instance", {
    globalActiveRuns: 2,
    perCredentialActiveRuns: 1,
    maxAwaitingSessions: 2,
    sessionTtlMs: 100,
    replayTtlMs: 100,
    runDeadlineMs: 1_000,
  });
  const session = registry.create({
    credentialFingerprint: "test-credential",
    modelId: "test-model",
    sessionPolicyFingerprint: "test-policy",
    executableToolCatalogFingerprint: "test-tools",
  });
  const error = new Error("SDK cleanup failed");
  const close = vi.fn(kind === "asynchronous"
    ? async () => { throw error; }
    : () => { throw error; });
  session.agent = {
    agentId: "test-agent",
    send: async () => { throw new Error("unexpected Send"); },
    close,
  };
  const call = session.createPending("test-tool", {}, clock);
  registry.indexTool(call.toolUseId, session.sessionId);
  const rejectedTool = expect(call.promise).rejects.toMatchObject({ name: "SessionClosedError" });
  expect(() => registry.forget(session, "test_closed")).not.toThrow();
  await rejectedTool;
  // Yield past rejected-Promise delivery. Vitest must observe no unhandled
  // rejection from the SDK's asynchronous close implementation.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(close).toHaveBeenCalledTimes(1);
  expect(session.state).toBe("closed");
  expect(registry.get(session.sessionId)).toBeUndefined();
  expect(registry.lookupByToolIds([call.toolUseId]).missing).toEqual([call.toolUseId]);
  expect(registry.activeCount()).toBe(0);
});
