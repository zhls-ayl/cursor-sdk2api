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
    reason: "timeout" | "client_closed",
    /** Resolves only after pending SDK work and successful late resource cleanup settle. */
    readonly pendingSettlement: Promise<void> = Promise.resolve(),
  ) {
    super(
      reason === "timeout" ? "cursor_timeout" : "client_closed",
      reason === "timeout" ? "Timed out starting the SDK run" : "Client disconnected before the SDK run started",
      reason === "timeout" ? 504 : 499,
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
    let readyAgent: SdkAgent | undefined;
    let closedAgent: SdkAgent | undefined;
    let cancelledRun: SdkRun | undefined;
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
    const cancelRun = (run: SdkRun) => {
      if (cancelledRun === run) return;
      cancelledRun = run;
      if (session.run === run) session.run = undefined;
      cleanup(() => run.cancel());
    };
    let rejectInterrupted!: (error: SdkStartupInterruptedError) => void;
    const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
    const interrupt = (reason: "timeout" | "client_closed") => {
      if (interruption) return;
      interruption = new SdkStartupInterruptedError(reason, pendingSettlement);
      deltas.discard();
      if (session.run) cancelRun(session.run);
      if (readyAgent) closeAgent(readyAgent);
      rejectInterrupted(interruption);
    };
    const onAbort = () => interrupt("client_closed");
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
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
      session.agent = agent;
      session.sdkAgentId = agent.agentId;
      input.afterAgentReady?.(agent);
      assertActive();
      const run = await agent.send({
        text: input.send.text,
        images: input.send.images,
        customTools,
        force: input.send.force,
        onDelta: deltas.ingest,
      });
      if (interruption || session.state === "closed") {
        cancelRun(run);
        closeAgent(agent);
      }
      assertActive();
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
      await Promise.all(cleanupTasks);
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
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
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
