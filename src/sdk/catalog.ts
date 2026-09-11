import type { Clock } from "../clock.js";
import type { SdkCatalogResult, SdkModel, SdkRuntime } from "./port.js";

interface CacheEntry {
  fetchedAt: number;
  models: SdkModel[];
}

interface RefreshFailure {
  reason: string;
  retryAt: number;
}

export interface ModelCatalogOptions {
  refreshTimeoutMs?: number;
  retryMs?: number;
  /** Additional time after the fresh TTL during which refresh failures may use old models. */
  maxStaleMs?: number;
}

export interface ModelCatalogResult {
  status: "ok" | "unavailable" | "stale";
  reason?: string;
  models: SdkModel[];
  stale: boolean;
}

export class ModelCatalog {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly failures = new Map<string, RefreshFailure>();
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly refreshTimeoutMs: number;
  private readonly retryMs: number;
  private readonly maxStaleMs: number;

  constructor(
    private readonly sdk: SdkRuntime,
    private readonly clock: Clock,
    private readonly ttlMs: number,
    options: ModelCatalogOptions = {},
  ) {
    this.refreshTimeoutMs = options.refreshTimeoutMs ?? 5_000;
    this.retryMs = options.retryMs ?? 5_000;
    this.maxStaleMs = options.maxStaleMs ?? 5 * 60_000;
    for (const [name, value, minimum] of [
      ["CATALOG_CACHE_MS", ttlMs, 0],
      ["CATALOG_REFRESH_TIMEOUT_MS", this.refreshTimeoutMs, 1],
      ["CATALOG_RETRY_MS", this.retryMs, 1],
      ["CATALOG_MAX_STALE_MS", this.maxStaleMs, 0],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < minimum) {
        throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
      }
    }
  }

  async list(apiKey: string, fingerprint: string): Promise<ModelCatalogResult> {
    const cached = this.cache.get(fingerprint);
    const now = this.clock.now();
    if (cached && now - cached.fetchedAt < this.ttlMs) {
      return { status: "ok", models: cached.models, stale: false };
    }

    const refreshing = this.refreshing.get(fingerprint);
    if (refreshing) {
      await refreshing;
    } else if (now >= (this.failures.get(fingerprint)?.retryAt ?? 0)) {
      await this.refresh(apiKey, fingerprint);
    }
    return this.current(fingerprint);
  }

  private current(fingerprint: string): ModelCatalogResult {
    const cached = this.cache.get(fingerprint);
    const failure = this.failures.get(fingerprint);
    if (cached && !failure) {
      return { status: "ok", models: cached.models, stale: false };
    }
    const reason = failure?.reason ?? "cursor_models_list_unavailable";
    if (cached && this.clock.now() - cached.fetchedAt < this.ttlMs + this.maxStaleMs) {
      return {
        status: "stale",
        reason,
        models: cached.models,
        stale: true,
      };
    }
    this.cache.delete(fingerprint);
    return { status: "unavailable", reason, models: [], stale: false };
  }

  private refresh(apiKey: string, fingerprint: string): Promise<void> {
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => { complete = resolve; });
    this.refreshing.set(fingerprint, pending);
    const timeout = new AbortController();
    let finished = false;
    const finish = (result: SdkCatalogResult, timedOut = false): void => {
      if (!finished) {
        finished = true;
        timeout.abort();
        const now = this.clock.now();
        if (result.ok) {
          this.cache.set(fingerprint, { fetchedAt: now, models: result.models });
          this.failures.delete(fingerprint);
        } else {
          this.failures.set(fingerprint, { reason: result.reason, retryAt: now + this.retryMs });
        }
        complete();
      }
      // The SDK catalog API has no cancellation signal. A timeout releases
      // callers, but keeps this key locked until the upstream Promise settles.
      // Late results are ignored and cannot overwrite the cache.
      if (!timedOut && this.refreshing.get(fingerprint) === pending) {
        this.refreshing.delete(fingerprint);
      }
    };
    void this.clock.sleep(this.refreshTimeoutMs, timeout.signal).then(
      () => finish({ ok: false, reason: "cursor_models_list_timeout", message: "Catalog refresh timed out" }, true),
      () => undefined,
    );
    void Promise.resolve().then(() => this.sdk.listModels(apiKey)).then(
      (result) => finish(result),
      () => finish({ ok: false, reason: "cursor_models_list_unavailable", message: "Catalog refresh failed" }),
    );
    return pending;
  }
}
