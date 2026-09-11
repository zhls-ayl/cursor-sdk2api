import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const mode = process.argv[2];
assert.ok(mode === "local" || mode === "external", "Expected local or external probe mode");
const host = mode === "local" ? "127.0.0.1" : "gateway";
const base = `http://${host}:8080`;
const get = (path, headers) => fetch(`${base}${path}`, {
  headers,
  redirect: "manual",
  signal: AbortSignal.timeout(3_000),
});

if (mode === "local") {
  const deadline = Date.now() + 30_000;
  let started = false;
  while (Date.now() < deadline) {
    try {
      const response = await get("/livez");
      await response.arrayBuffer();
      if (response.status === 200) {
        started = true;
        break;
      }
    } catch {
      // The runtime process may still be importing the SDK.
    }
    await delay(250);
  }
  assert.ok(started, "Runtime did not become live within 30 seconds");
  assert.equal(JSON.parse(readFileSync("/app/package.json", "utf8")).name, "cursor-sdk2api");
  assert.notEqual(process.getuid(), 0, "Runtime must use the non-root image user");
  assert.equal(statSync("/data").mode & 0o777, 0o700, "State volume must be owner-only");

  const consolePage = await get("/console/");
  assert.equal(consolePage.status, 200, "Container loopback console must be reachable");
  assert.match(consolePage.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await consolePage.text(), /<html/i, "Console build must be present");

  const health = await get("/health");
  assert.equal(health.status, 503, "An empty managed pool must not be ready");
  const healthBody = await health.json();
  assert.equal(healthBody.readiness.accepting_sessions, false);
  const models = await get("/v1/models");
  assert.equal(models.status, 401, "Protocol APIs must require authentication");
  await models.arrayBuffer();
  const wrongKey = await get("/v1/models", { authorization: "Bearer wrong-synthetic-key" });
  assert.equal(wrongKey.status, 401, "Protocol APIs must reject an incorrect gateway key");
  await wrongKey.arrayBuffer();
} else {
  for (const path of ["/console/", "/v0/management/accounts"]) {
    const response = await get(path, { "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" });
    assert.equal(response.status, 403, `Non-loopback access to ${path} must fail closed`);
    await response.arrayBuffer();
  }

  const malformedStatus = await new Promise((resolve, reject) => {
    const socket = connect({ host, port: 8080 });
    let response = "";
    socket.setTimeout(3_000, () => socket.destroy(new Error("Malformed request probe timed out")));
    socket.on("connect", () => socket.write("GET //[ HTTP/1.1\r\nHost: gateway\r\nConnection: close\r\n\r\n"));
    socket.on("data", (chunk) => { response += chunk.toString("utf8"); });
    socket.on("error", reject);
    socket.on("end", () => resolve(response.split("\r\n", 1)[0]));
  });
  assert.match(malformedStatus, /^HTTP\/1\.1 400\b/, "Malformed request-target must return 400");
  const alive = await get("/livez");
  assert.equal(alive.status, 200, "Runtime must survive a malformed request-target");
  await alive.arrayBuffer();
}
console.log(`${mode} production image probe passed`);
