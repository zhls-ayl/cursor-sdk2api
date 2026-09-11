import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { expect, test } from "vitest";
import { FakeClock } from "../../src/clock.js";
import type { Logger } from "../../src/log.js";
import { markFirstResponseWrite, startRequestMetrics } from "../../src/server/request-metrics.js";

function setup() {
  const res = new ServerResponse(new IncomingMessage(new Socket()));
  const clock = new FakeClock();
  const logs: Array<{ fields: Record<string, unknown>; message: string }> = [];
  const logger: Logger = {
    info: (fields, message) => { logs.push({ fields, message }); },
    warn: () => undefined,
    error: () => undefined,
  };
  const input = { clock, logger, path: "/v1/messages", requestId: "request-test" };
  startRequestMetrics(res, input);
  return { res, clock, logs, input };
}

test("records one numeric receipt and removes listeners after response finish", () => {
  const { res, clock, logs, input } = setup();
  startRequestMetrics(res, input);
  expect(res.listenerCount("finish")).toBe(1);
  expect(res.listenerCount("close")).toBe(1);
  clock.advance(12);
  markFirstResponseWrite(res);
  clock.advance(8);
  markFirstResponseWrite(res);
  clock.advance(10);
  res.emit("finish");
  res.emit("close");
  expect(logs).toEqual([{
    message: "request completed",
    fields: {
      request_id: "request-test", path: "/v1/messages", http_status: 200,
      outcome: "finished", duration_ms: 30, first_write_ms: 12,
    },
  }]);
  expect(res.listenerCount("finish")).toBe(0);
  expect(res.listenerCount("close")).toBe(0);
});

test("disconnect before output records 499 without inventing a first-write time", () => {
  const { res, clock, logs } = setup();
  clock.advance(50);
  res.emit("close");
  res.emit("finish");
  expect(logs).toHaveLength(1);
  expect(logs[0]?.fields).toMatchObject({ http_status: 499, outcome: "client_closed", duration_ms: 50 });
  expect(logs[0]?.fields).not.toHaveProperty("first_write_ms");
  expect(res.listenerCount("finish")).toBe(0);
  expect(res.listenerCount("close")).toBe(0);
});

test("logger failure cannot escape the response event and still cleans listeners", () => {
  const { res, input } = setup();
  input.logger.info = () => { throw new Error("private-logger-canary"); };
  expect(() => res.emit("finish")).not.toThrow();
  expect(res.listenerCount("finish")).toBe(0);
  expect(res.listenerCount("close")).toBe(0);
});
