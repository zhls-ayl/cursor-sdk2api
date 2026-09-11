import type { ServerResponse } from "node:http";
import type { Clock } from "../clock.js";
import type { Logger } from "../log.js";

interface RequestMetrics {
  clock: Clock;
  startedAt: number;
  firstWriteAt?: number;
}

const requests = new WeakMap<ServerResponse, RequestMetrics>();

/** Numeric HTTP timings only; neither headers nor request/response bodies are retained. */
export function startRequestMetrics(
  res: ServerResponse,
  input: { clock: Clock; logger: Logger; requestId: string; path: string },
): void {
  if (requests.has(res)) return;
  const metrics: RequestMetrics = { clock: input.clock, startedAt: input.clock.now() };
  requests.set(res, metrics);
  const finish = () => report("finished");
  const close = () => report("client_closed");
  const report = (outcome: "finished" | "client_closed") => {
    res.off("finish", finish);
    res.off("close", close);
    requests.delete(res);
    const now = input.clock.now();
    try {
      input.logger.info({
        request_id: input.requestId,
        path: input.path,
        http_status: outcome === "client_closed" ? 499 : res.statusCode,
        outcome,
        duration_ms: Math.max(0, now - metrics.startedAt),
        ...(metrics.firstWriteAt === undefined
          ? {}
          : { first_write_ms: Math.max(0, metrics.firstWriteAt - metrics.startedAt) }),
      }, "request completed");
    } catch {
      // Observability must not turn a response event into an uncaught exception.
    }
  };
  res.once("finish", finish);
  res.once("close", close);
}

/** First body write, including SSE lifecycle frames; this is not model TTFT. */
export function markFirstResponseWrite(res: ServerResponse): void {
  const metrics = requests.get(res);
  if (metrics && metrics.firstWriteAt === undefined) metrics.firstWriteAt = metrics.clock.now();
}
