/**
 * Reflector failure guard — mirrors tests/observer.test.ts.
 *
 * The reflector stage records whatever `runReflector` returns and advances the
 * reflector cursor to the observation coverage marker, so a run that failed
 * before it closed the review must not report its partial reflections as
 * success: the observations behind them would never be crystallized again.
 */

import { describe, expect, it, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testRoot = join(tmpdir(), `pi-blackhole-reflector-stream-${process.pid}-${Date.now()}`);
const agentDir = join(testRoot, "agent");

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, getAgentDir: () => agentDir };
});

import { runReflector } from "../src/om/agents/reflector/agent.js";
import {
  DEBUG_LOG_RELATIVE_PATH,
  flushDebugLog,
  withDebugLogContext,
} from "../src/om/debug-log.js";
import {
  getDiscardedCount,
  isDeterministicError,
  isRetryableError,
  WorkerStreamError,
} from "../src/om/retryable-error.js";
import { observation } from "./fixtures/session.js";

describe("runReflector failure guard", () => {
  const baseArgs = {
    model: {} as any,
    apiKey: "test",
    reflections: [],
    observations: [observation("aaaaaaaaaaaa"), observation("bbbbbbbbbbbb")],
  };

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  function readLog(): Array<{ event: string; data: Record<string, unknown> }> {
    const path = join(agentDir, DEBUG_LOG_RELATIVE_PATH);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  function reflectionBatch(content: string, complete: boolean) {
    return {
      reflections: [{ content, supportingObservationIds: ["aaaaaaaaaaaa"] }],
      complete,
    };
  }

  /**
   * Drive the tool the way a real run does, then optionally end the run the way
   * the host would when the turn cap or the provider cuts it off.
   */
  function scriptedLoop(
    batches: ReadonlyArray<Record<string, unknown>>,
    options: { capEndsRun?: boolean; agentError?: string; streamFailure?: unknown } = {},
  ) {
    return ((_prompts: any[], context: any, config: any) => ({
      async *[Symbol.asyncIterator]() {
        for (const [index, batch] of batches.entries()) {
          await context.tools[0].execute(`call-${index}`, batch);
        }
        if (options.streamFailure !== undefined) throw options.streamFailure;
        if (options.capEndsRun) {
          config.finishTurn?.({ message: { stopReason: "toolUse" } });
        }
        if (options.agentError !== undefined) {
          yield {
            type: "agent_end",
            messages: [
              {
                role: "assistant",
                content: [],
                stopReason: "error",
                errorMessage: options.agentError,
              },
            ],
          };
        }
      },
      result: async () => ({}),
    })) as any;
  }

  it("throws when a trailing turn errors before the review closed", async () => {
    const error = await runReflector({
      ...baseArgs,
      agentLoop: scriptedLoop([reflectionBatch("Partial reflection", false)], {
        agentError: "Stream connection severed",
      }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Reflector API error: Stream connection severed",
      discardedCount: 1,
    });
  });

  it("throws with a zero count when the run recorded nothing before the error", async () => {
    const error = await runReflector({
      ...baseArgs,
      agentLoop: scriptedLoop([], { agentError: "Stream connection severed" }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({ discardedCount: 0 });
  });

  it("keeps a complete=true close when a later turn errors on a host that ignores terminate", async () => {
    const result = await runReflector({
      ...baseArgs,
      agentLoop: scriptedLoop([reflectionBatch("Closed reflection", true)], {
        agentError: "Stream connection severed",
      }),
    });

    expect(result?.map((item) => item.content)).toEqual(["Closed reflection"]);
  });

  it("logs the failure it kept after a valid close instead of swallowing it", async () => {
    mkdirSync(agentDir, { recursive: true });
    await withDebugLogContext({ enabled: true }, () =>
      runReflector({
        ...baseArgs,
        agentLoop: scriptedLoop([reflectionBatch("Closed reflection", true)], {
          agentError: "Stream connection severed",
        }),
      }),
    );
    flushDebugLog();

    expect(readLog()).toEqual([
      {
        ts: expect.any(String),
        event: "reflector.error_after_close",
        cwd: undefined,
        runId: undefined,
        data: { error: "Stream connection severed", deterministic: false },
      },
    ]);
  });

  it("retracts the close when a later batch records new reflections", async () => {
    const error = await runReflector({
      ...baseArgs,
      agentLoop: scriptedLoop(
        [reflectionBatch("Closed reflection", true), reflectionBatch("Another one", false)],
        { agentError: "Stream connection severed" },
      ),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({ discardedCount: 2 });
  });

  it("throws when the turn cap ends a run that never closed", async () => {
    const error = await runReflector({
      ...baseArgs,
      agentLoop: scriptedLoop([reflectionBatch("Partial reflection", false)], {
        capEndsRun: true,
      }),
      maxTurns: 1,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: expect.stringContaining("turn cap"),
      discardedCount: 1,
    });
  });

  it("keeps a complete=true close when the turn cap fires after it", async () => {
    const result = await runReflector({
      ...baseArgs,
      agentLoop: scriptedLoop([reflectionBatch("Closed reflection", true)], {
        capEndsRun: true,
      }),
      maxTurns: 1,
    });

    expect(result?.map((item) => item.content)).toEqual(["Closed reflection"]);
  });

  it("returns undefined when the turn cap cuts a run that recorded nothing", async () => {
    await expect(
      runReflector({
        ...baseArgs,
        agentLoop: scriptedLoop([], { capEndsRun: true }),
        maxTurns: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it("does not classify turn-cap exhaustion as a provider error", async () => {
    const error = await runReflector({
      ...baseArgs,
      agentLoop: scriptedLoop([reflectionBatch("Partial reflection", false)], {
        capEndsRun: true,
      }),
      maxTurns: 1,
    }).catch((caught: unknown) => caught);

    // `agentMaxTurns` is a config limit, so it must neither cool the model as
    // deterministic nor look retryable to the cooldown classifier.
    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(isDeterministicError(error)).toBe(false);
    expect(isRetryableError(error)).toBe(false);
  });

  // A stream that breaks outright never produces agent_end, so the run's guard
  // never runs — but the reflections it had already recorded still exist.
  it("reports the records a raw stream failure discarded", async () => {
    const failure = new Error("stream blew up");
    const error = await runReflector({
      ...baseArgs,
      agentLoop: scriptedLoop([reflectionBatch("Partial reflection", false)], {
        streamFailure: failure,
      }),
    }).catch((caught: unknown) => caught);

    expect(error).toBe(failure);
    expect(getDiscardedCount(error)).toBe(1);
  });

  it("reports a zero count when the stream fails before anything was recorded", async () => {
    const failure = new Error("stream blew up");
    const error = await runReflector({
      ...baseArgs,
      agentLoop: scriptedLoop([], { streamFailure: failure }),
    }).catch((caught: unknown) => caught);

    expect(error).toBe(failure);
    expect(getDiscardedCount(error)).toBe(0);
  });
});
