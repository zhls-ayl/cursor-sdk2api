import type { Clock } from "../clock.js";
import { GatewayError } from "../errors.js";
import type { AnthropicTool } from "../protocols/anthropic/types.js";
import type {
  SdkAgent,
  SdkCustomToolResult,
  SdkDeltaUpdate,
  SdkRun,
  SdkRuntime,
} from "../sdk/port.js";
import { EventPump } from "./event-pump.js";
import type { Session } from "./session.js";
import { mapClientTools } from "./tool-bridge.js";

export type SdkAgentSource =
  | { type: "create"; apiKey: string; workspaceDir: string }
  | { type: "resume"; agentId: string; apiKey: string; workspaceDir: string }
  | { type: "existing"; agent: SdkAgent };

export interface DriveSdkRunInput {
  session: Session;
  tools: AnthropicTool[];
  agent: SdkAgentSource;
  send: {
    text: string;
    images?: Array<{ data: string; mimeType: string }>;
    force?: boolean;
  };
  completedResults?: Map<string, SdkCustomToolResult[]>;
  afterAgentReady?: (agent: SdkAgent) => void;
  beforeAgentStart?: () => Promise<void>;
  signal?: AbortSignal;
}

/** A pending SDK create/send cannot be retried safely until its late result is cleaned up. */
export class SdkStartupInterruptedError extends GatewayError {
  constructor(
    reason: "timeout" | "client_closed" | "cleanup_failed",
    /** Resolves only after pending SDK work and successful late resource cleanup settle. */
    readonly pendingSettlement: Promise<void> = Promise.resolve(),
  ) {
    super(
      reason === "timeout" ? "cursor_timeout" : reason === "cleanup_failed" ? "cursor_upstream_error" : "client_closed",
      reason === "timeout" ? "Timed out starting the SDK run" : reason === "cleanup_failed"
        ? "SDK startup cleanup failed; retry remains blocked"
        : "Client disconnected before the SDK run started",
      reason === "timeout" ? 504 : reason === "cleanup_failed" ? 502 : 499,
    );
  }
}

export interface SdkRunDriverDeps {
  sdk: SdkRuntime;
  clock: Clock;
  toolBatchSettleMs: number;
  firstEventTimeoutMs: number;
}

function createDeltaBridge() {
  const early: SdkDeltaUpdate[] = [];
  let pump: EventPump | undefined;
  let discarded = false;
  const ingest = (update: SdkDeltaUpdate) => {
    if (discarded) return;
    early.push(update);
    flush();
  };
  const flush = () => {
    if (!pump) return;
    while (early.length > 0) {
      const next = early.shift();
      if (next) pump.ingestDelta(next);
    }
  };
  return {
    ingest,
    attach(next: EventPump) {
      pump = next;
      flush();
    },
    discard() {
      discarded = true;
      early.length = 0;
      pump = undefined;
    },
  };
}

export class SdkRunDriver {
  constructor(private readonly deps: SdkRunDriverDeps) {}

  async start(input: DriveSdkRunInput): Promise<EventPump> {
    const { session } = input;
    session.run = undefined;
    session.pump = undefined;
    const startedAt = this.deps.clock.now();
    const timerController = new AbortController();
    const deltas = createDeltaBridge();
    let interruption: SdkStartupInterruptedError | undefined;
    let readyAgent: SdkAgent | undefined = input.agent.type === "existing" ? input.agent.agent : undefined;
    // The driver owns startup resources, including while registry sweep/drain
    // closes the Session. Return ownership only after Send has resolved.
    if (readyAgent && session.agent === readyAgent) session.agent = undefined;
    let closedAgent: SdkAgent | undefined;
    let cancelledRun: SdkRun | undefined;
    let sending = false;
    let resolveSettlement!: () => void;
    const pendingSettlement = new Promise<void>((resolve) => { resolveSettlement = resolve; });
    let finishAttempt!: () => void;
    const attemptFinished = new Promise<void>((resolve) => { finishAttempt = resolve; });
    const cleanupTasks: Promise<void>[] = [];
    let cleanupSucceeded = true;
    const cleanup = (action: () => void | Promise<void>) => {
      try {
        cleanupTasks.push(Promise.resolve(action()).catch(() => { cleanupSucceeded = false; }));
      } catch {
        cleanupSucceeded = false;
      }
    };
    const closeAgent = (agent: SdkAgent) => {
      if (closedAgent === agent) return;
      closedAgent = agent;
      if (session.agent === agent) session.agent = undefined;
      cleanup(() => agent.close());
    };
    const cancelRun = (run: SdkRun, agent: SdkAgent) => {
      if (cancelledRun === run) return;
      cancelledRun = run;
      if (session.run === run) session.run = undefined;
      cleanup(async () => {
        try {
          await run.cancel();
        } finally {
          // Cancellation is a request. Keep admission reserved until the SDK
          // confirms that the late Run has actually reached a terminal state.
          // Even a failed cancel must not dispose a still-running executor.
          try {
            await run.wait();
          } finally {
            closeAgent(agent);
          }
        }
      });
    };
    let rejectInterrupted!: (error: SdkStartupInterruptedError) => void;
    const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
    const interrupt = (reason: "timeout" | "client_closed" | "cleanup_failed") => {
      if (interruption) return;
      interruption = new SdkStartupInterruptedError(reason, pendingSettlement);
      deltas.discard();
      // SDK send may still be acquiring its executor lease. Disposing the
      // Agent here would race that acquisition; the late result owns cleanup.
      if (readyAgent && session.agent === readyAgent) session.agent = undefined;
      if (session.run && readyAgent) cancelRun(session.run, readyAgent);
      else if (readyAgent && !sending && !cancelledRun) closeAgent(readyAgent);
      rejectInterrupted(interruption);
    };
    const onAbort = () => interrupt("client_closed");
    input.signal?.addEventListener("abort", onAbort, { once: true });
    session.closedSignal.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    if (session.closedSignal.aborted) onAbort();
    const timer = this.deps.clock.sleep(this.deps.firstEventTimeoutMs, timerController.signal)
      .then(() => interrupt("timeout"), () => undefined);
    const assertActive = () => {
      if (session.state === "closed" && !interruption) interrupt("client_closed");
      if (interruption) throw interruption;
    };
    const customTools = mapClientTools(
      input.tools,
      session,
      this.deps.clock,
      () => undefined,
      input.completedResults,
    );
    for (const tool of Object.values(customTools)) {
      const execute = tool.execute;
      tool.execute = (args, context) => {
        assertActive();
        return execute(args, context);
      };
    }
    const starting = (async () => {
      assertActive();
      await input.beforeAgentStart?.();
      assertActive();
      const agent = await this.resolveAgent(input, customTools);
      readyAgent = agent;
      if (interruption || session.state === "closed") closeAgent(agent);
      assertActive();
      session.sdkAgentId = agent.agentId;
      input.afterAgentReady?.(agent);
      assertActive();
      sending = true;
      let run: SdkRun;
      try {
        run = await agent.send({
          text: input.send.text,
          images: input.send.images,
          customTools,
          force: input.send.force,
          onDelta: deltas.ingest,
        });
      } catch (error) {
        if (interruption || session.state === "closed") closeAgent(agent);
        throw error;
      } finally {
        sending = false;
      }
      if (interruption || session.state === "closed") {
        cancelRun(run, agent);
      }
      assertActive();
      session.agent = agent;
      session.run = run;
      const pump = new EventPump(
        session,
        run,
        this.deps.clock,
        this.deps.toolBatchSettleMs,
        Math.max(0, this.deps.firstEventTimeoutMs - (this.deps.clock.now() - startedAt)),
      );
      session.pump = pump;
      deltas.attach(pump);
      pump.ingestEarly(session.earlyCalls.splice(0));
      return pump;
    })();
    void Promise.allSettled([starting, attemptFinished]).then(async () => {
      // Run cancellation can enqueue Agent disposal after the initial tasks.
      for (let index = 0; index < cleanupTasks.length; index += 1) await cleanupTasks[index];
      // If cleanup fails, leave the request's retry gate closed. A replacement
      // Send would otherwise overlap SDK work whose cancellation is unproven.
      if (cleanupSucceeded) resolveSettlement();
    });
    try {
      const pump = await Promise.race([starting, interrupted]);
      assertActive();
      return pump;
    } catch (error) {
      deltas.discard();
      if (!interruption && readyAgent) {
        closeAgent(readyAgent);
        await Promise.race([
          (async () => {
            for (let index = 0; index < cleanupTasks.length; index += 1) await cleanupTasks[index];
          })(),
          interrupted,
        ]);
        if (!cleanupSucceeded) {
          interrupt("cleanup_failed");
          throw interruption;
        }
      }
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
      session.closedSignal.removeEventListener("abort", onAbort);
      timerController.abort();
      finishAttempt();
      void timer;
    }
  }

  private resolveAgent(
    input: DriveSdkRunInput,
    customTools: ReturnType<typeof mapClientTools>,
  ): Promise<SdkAgent> {
    const common = {
      modelId: input.session.modelId,
      modelParams: input.session.modelParams,
      clientToolNames: input.tools.map((tool) => tool.name),
      customTools,
      runtimeProfile: input.session.runtimeProfile,
      hostedSearch: input.session.hostedSearch,
    };
    if (input.agent.type === "existing") return Promise.resolve(input.agent.agent);
    if (input.agent.type === "resume") {
      return this.deps.sdk.resumeAgent({
        ...common,
        agentId: input.agent.agentId,
        apiKey: input.agent.apiKey,
        workspaceDir: input.agent.workspaceDir,
      });
    }
    return this.deps.sdk.createAgent({
      ...common,
      apiKey: input.agent.apiKey,
      workspaceDir: input.agent.workspaceDir,
    });
  }
}
