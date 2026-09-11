import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SystemClock } from "../../src/clock.js";
import { loadConfig } from "../../src/config.js";
import { ModelCatalog } from "../../src/sdk/catalog.js";
import type { SdkCatalogResult } from "../../src/sdk/port.js";
import { FakeSdk } from "../fixtures/fake-sdk.js";

const models: SdkCatalogResult = { ok: true, models: [{ id: "composer-2.5" }] };
const unavailable: SdkCatalogResult = {
  ok: false,
  reason: "cursor_models_list_unavailable",
  message: "Unavailable",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function setup(options = {}) {
  const sdk = new FakeSdk();
  const list = vi.spyOn(sdk, "listModels");
  const catalog = new ModelCatalog(sdk, new SystemClock(), 1_000, {
    refreshTimeoutMs: 100,
    retryMs: 200,
    maxStaleMs: 500,
    ...options,
  });
  return { sdk, list, catalog };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

test("eight concurrent misses for one credential share one SDK catalog query", async () => {
  const { list, catalog } = setup();
  const live = deferred<SdkCatalogResult>();
  list.mockReturnValue(live.promise);
  const requests = Array.from({ length: 8 }, () => catalog.list("key-a", "fingerprint-a"));
  await Promise.resolve();
  expect(list).toHaveBeenCalledTimes(1);
  live.resolve(models);
  const results = await Promise.all(requests);
  expect(results).toEqual(Array.from({ length: 8 }, () => ({
    status: "ok", models: [{ id: "composer-2.5" }], stale: false,
  })));
  expect(await catalog.list("key-a", "fingerprint-a")).toEqual(results[0]);
  expect(list).toHaveBeenCalledTimes(1);
});

test("different credentials refresh independently while one query hangs", async () => {
  const { list, catalog } = setup();
  list.mockImplementation((apiKey) => apiKey === "key-a"
    ? new Promise(() => undefined)
    : Promise.resolve({ ok: true, models: [{ id: "only-for-b" }] }));
  const slow = catalog.list("key-a", "fingerprint-a");
  expect(await catalog.list("key-b", "fingerprint-b")).toEqual({
    status: "ok", models: [{ id: "only-for-b" }], stale: false,
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(await slow).toMatchObject({ status: "unavailable", reason: "cursor_models_list_timeout" });
  expect(list).toHaveBeenCalledTimes(2);
});

test("the fresh TTL starts when the SDK response completes", async () => {
  const { list, catalog } = setup();
  const live = deferred<SdkCatalogResult>();
  list.mockReturnValueOnce(live.promise);
  const pending = catalog.list("key-a", "fingerprint-a");
  await vi.advanceTimersByTimeAsync(90);
  live.resolve(models);
  await pending;
  await vi.advanceTimersByTimeAsync(999);
  await catalog.list("key-a", "fingerprint-a");
  expect(list).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await catalog.list("key-a", "fingerprint-a");
  expect(list).toHaveBeenCalledTimes(2);
});

test("failed misses use a bounded retry delay and recover after it", async () => {
  const { list, catalog } = setup();
  list.mockResolvedValueOnce(unavailable).mockResolvedValue(models);
  expect(await catalog.list("key-a", "fingerprint-a")).toEqual({
    status: "unavailable", reason: unavailable.reason, models: [], stale: false,
  });
  await vi.advanceTimersByTimeAsync(199);
  await Promise.all(Array.from({ length: 8 }, () => catalog.list("key-a", "fingerprint-a")));
  expect(list).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await catalog.list("key-a", "fingerprint-a")).toMatchObject({ status: "ok" });
  expect(list).toHaveBeenCalledTimes(2);
});

test("repeated refresh failures never extend the stale catalog lifetime", async () => {
  const { list, catalog } = setup();
  list.mockResolvedValueOnce(models).mockResolvedValue(unavailable);
  await catalog.list("key-a", "fingerprint-a");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await catalog.list("key-a", "fingerprint-a")).toEqual({
    status: "stale", reason: unavailable.reason, models: [{ id: "composer-2.5" }], stale: true,
  });
  await vi.advanceTimersByTimeAsync(400);
  expect(await catalog.list("key-a", "fingerprint-a")).toMatchObject({ status: "stale" });
  await vi.advanceTimersByTimeAsync(100);
  expect(await catalog.list("key-a", "fingerprint-a")).toEqual({
    status: "unavailable", reason: unavailable.reason, models: [], stale: false,
  });
  expect(list).toHaveBeenCalledTimes(3);
});

test("stale fallback can be disabled", async () => {
  const { list, catalog } = setup({ maxStaleMs: 0 });
  list.mockResolvedValueOnce(models).mockResolvedValue(unavailable);
  await catalog.list("key-a", "fingerprint-a");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await catalog.list("key-a", "fingerprint-a")).toMatchObject({
    status: "unavailable", models: [], stale: false,
  });
});

test("timeouts release all callers but never stack retries behind a hanging SDK promise", async () => {
  const { list, catalog } = setup();
  const live = deferred<SdkCatalogResult>();
  list.mockReturnValueOnce(live.promise).mockResolvedValue({ ok: true, models: [{ id: "fresh" }] });
  const first = catalog.list("key-a", "fingerprint-a");
  const duplicate = catalog.list("key-a", "fingerprint-a");
  await vi.advanceTimersByTimeAsync(100);
  expect(await first).toMatchObject({ status: "unavailable", reason: "cursor_models_list_timeout" });
  expect(await duplicate).toEqual(await first);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await catalog.list("key-a", "fingerprint-a")).toMatchObject({ status: "unavailable" });
  }
  expect(list).toHaveBeenCalledTimes(1);

  live.resolve({ ok: true, models: [{ id: "late" }] });
  await vi.advanceTimersByTimeAsync(0);
  expect(await catalog.list("key-a", "fingerprint-a")).toEqual({
    status: "ok", models: [{ id: "fresh" }], stale: false,
  });
  expect(list).toHaveBeenCalledTimes(2);
});

test("cached models expire while a timed-out refresh remains in flight", async () => {
  const { list, catalog } = setup();
  const live = deferred<SdkCatalogResult>();
  list.mockResolvedValueOnce(models).mockReturnValueOnce(live.promise);
  await catalog.list("key-a", "fingerprint-a");
  await vi.advanceTimersByTimeAsync(1_000);
  const refreshing = catalog.list("key-a", "fingerprint-a");
  await vi.advanceTimersByTimeAsync(100);
  expect(await refreshing).toMatchObject({ status: "stale", reason: "cursor_models_list_timeout" });
  await vi.advanceTimersByTimeAsync(400);
  expect(await catalog.list("key-a", "fingerprint-a")).toMatchObject({ status: "unavailable", models: [] });
  expect(list).toHaveBeenCalledTimes(2);
  live.reject(new Error("late failure"));
  await vi.advanceTimersByTimeAsync(0);
});

test("thrown SDK errors become safe unavailable responses without leaking credential text", async () => {
  const { list, catalog } = setup();
  list.mockImplementation(() => { throw new Error("private-credential-in-upstream-error"); });
  const result = await catalog.list("key-a", "fingerprint-a");
  expect(result).toEqual({ status: "unavailable", reason: unavailable.reason, models: [], stale: false });
  expect(JSON.stringify(result)).not.toContain("private-credential");
});

test("catalog timing options are configurable and reject invalid bounds", () => {
  vi.stubEnv("AUTH_MODE", "byok");
  vi.stubEnv("CATALOG_REFRESH_TIMEOUT_MS", "1234");
  vi.stubEnv("CATALOG_RETRY_MS", "2345");
  vi.stubEnv("CATALOG_MAX_STALE_MS", "0");
  expect(loadConfig()).toMatchObject({
    catalogRefreshTimeoutMs: 1234,
    catalogRetryMs: 2345,
    catalogMaxStaleMs: 0,
  });
  expect(() => setup({ refreshTimeoutMs: 0 })).toThrow("CATALOG_REFRESH_TIMEOUT_MS");
  expect(() => setup({ retryMs: -1 })).toThrow("CATALOG_RETRY_MS");
  expect(() => setup({ maxStaleMs: Infinity })).toThrow("CATALOG_MAX_STALE_MS");
});
