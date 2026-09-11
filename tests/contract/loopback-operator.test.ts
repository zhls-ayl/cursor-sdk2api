import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, expect, test } from "vitest";
import { closeTestApp, startTestApp, type TestContext } from "../helpers/app.js";
import { isLoopbackAddress, isOperatorSurface, requireLoopbackOperator } from "../../src/server/loopback.js";

let ctx: TestContext;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
  ctx = undefined as never;
});

test("loopback detection covers IPv4-mapped and zoned IPv6 forms", () => {
  expect(isLoopbackAddress("127.0.0.1")).toBe(true);
  expect(isLoopbackAddress("127.1.2.3")).toBe(true);
  expect(isLoopbackAddress("::1")).toBe(true);
  expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  expect(isLoopbackAddress("[::1]")).toBe(true);
  expect(isLoopbackAddress("::1%lo0")).toBe(true);
  expect(isLoopbackAddress("localhost")).toBe(true);
  expect(isLoopbackAddress("10.0.0.8")).toBe(false);
  expect(isLoopbackAddress("192.168.1.20")).toBe(false);
  expect(isLoopbackAddress("::ffff:10.0.0.8")).toBe(false);
  expect(isLoopbackAddress("fe80::1%en0")).toBe(false);
  expect(isLoopbackAddress(undefined)).toBe(false);
});

test("operator surfaces are console and unauthenticated management only", () => {
  expect(isOperatorSurface("/console")).toBe(true);
  expect(isOperatorSurface("/console/")).toBe(true);
  expect(isOperatorSurface("/v0/management/accounts")).toBe(true);
  expect(isOperatorSurface("/health")).toBe(false);
  expect(isOperatorSurface("/v1/models")).toBe(false);
  expect(isOperatorSurface("/v1/messages")).toBe(false);
});

test("forwarded loopback headers do not satisfy the operator loopback check", () => {
  const req = fakeRequest("/console/", "10.8.0.4", {
    "x-forwarded-for": "127.0.0.1",
    "x-real-ip": "127.0.0.1",
  });
  expect(() => requireLoopbackOperator(req, "/console/")).toThrow(/loopback-only/);
});

test("non-loopback clients cannot open console or management even with spoofed forwarded IPs", async () => {
  ctx = await startTestApp();
  const consoleRes = await invoke(ctx, "/console/", "10.8.0.4", {
    "x-forwarded-for": "127.0.0.1",
  });
  expect(consoleRes.status).toBe(403);
  expect(consoleRes.body).toContain("loopback-only");

  const managementRes = await invoke(ctx, "/v0/management/accounts", "192.168.1.50");
  expect(managementRes.status).toBe(403);

  const health = await invoke(ctx, "/health", "192.168.1.50");
  expect(health.status).toBe(200);

  const models = await invoke(ctx, "/v1/models", "192.168.1.50");
  expect(models.status).toBe(401);
});

test("loopback clients still reach the operator console", async () => {
  ctx = await startTestApp();
  const response = await fetch(`${ctx.url}/console`, { redirect: "manual" });
  expect(response.status).toBe(308);
});

function fakeRequest(
  url: string,
  remoteAddress: string,
  headers: Record<string, string> = {},
): IncomingMessage {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", { value: remoteAddress });
  const req = new IncomingMessage(socket);
  req.method = "GET";
  req.url = url;
  req.headers = headers;
  req.push(null);
  return req;
}

async function invoke(
  testCtx: TestContext,
  url: string,
  remoteAddress: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const req = fakeRequest(url, remoteAddress, headers);
  const res = new ServerResponse(req);
  let status = 0;
  let body = "";
  const finished = new Promise<void>((resolve) => {
    res.writeHead = ((code: number) => {
      status = code;
      return res;
    }) as ServerResponse["writeHead"];
    res.end = ((chunk?: unknown) => {
      if (typeof chunk === "string") body += chunk;
      else if (Buffer.isBuffer(chunk)) body += chunk.toString("utf8");
      resolve();
      return res;
    }) as ServerResponse["end"];
  });
  await testCtx.app.handler(req, res);
  await finished;
  return { status, body };
}
