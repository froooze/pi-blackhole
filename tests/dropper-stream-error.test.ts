/**
 * Dropper failure guard — mirrors tests/observer.test.ts and
 * tests/reflector-stream-error.test.ts.
 *
 * The dropper has no complete=true close: every candidate it proposes is
 * recorded, and the stage then writes an OM_OBSERVATIONS_DROPPED marker over
 * the observation coverage window. A run that failed halfway therefore must not
 * report its prefix as a finished evaluation — the observations it had not got
 * to would never be evaluated again by a cadence run.
 */

import { describe, expect, it } from "vitest";

import { runDropper } from "../src/om/agents/dropper/agent.js";
import {
  isDeterministicError,
  isRetryableError,
  WorkerStreamError,
} from "../src/om/retryable-error.js";
import { observation, reflection } from "./fixtures/session.js";

describe("runDropper failure guard", () => {
  const baseArgs = {
    model: {} as any,
    apiKey: "test",
    reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
    observations: [
      observation("aaaaaaaaaaaa", { relevance: "medium" }),
      observation("bbbbbbbbbbbb", { relevance: "low" }),
      observation("cccccccccccc", { relevance: "critical" }),
    ],
    budgetTokens: 20,
  };

  function scriptedLoop(
    batches: ReadonlyArray<Record<string, unknown>>,
    options: { capEndsRun?: boolean; agentError?: string } = {},
  ) {
    return ((_prompts: any[], context: any, config: any) => ({
      async *[Symbol.asyncIterator]() {
        for (const [index, batch] of batches.entries()) {
          await context.tools[0].execute(`call-${index}`, batch);
        }
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

  it("throws when a trailing turn errors after candidates were proposed", async () => {
    const error = await runDropper({
      ...baseArgs,
      agentLoop: scriptedLoop([{ ids: ["aaaaaaaaaaaa"] }], {
        agentError: "Stream connection severed",
      }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: "Dropper API error: Stream connection severed",
      discardedCount: 1,
    });
  });

  it("carries a zero count when the run proposed nothing before the error", async () => {
    const error = await runDropper({
      ...baseArgs,
      agentLoop: scriptedLoop([], { agentError: "Stream connection severed" }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({ discardedCount: 0 });
  });

  it("throws when the turn cap ends a run that proposed candidates", async () => {
    const error = await runDropper({
      ...baseArgs,
      agentLoop: scriptedLoop([{ ids: ["aaaaaaaaaaaa"] }], { capEndsRun: true }),
      maxTurns: 1,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(error).toMatchObject({
      message: expect.stringContaining("turn cap"),
      discardedCount: 1,
    });
  });

  it("returns undefined when the turn cap cuts a run that proposed nothing", async () => {
    await expect(
      runDropper({
        ...baseArgs,
        agentLoop: scriptedLoop([], { capEndsRun: true }),
        maxTurns: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it("does not classify turn-cap exhaustion as a provider error", async () => {
    const error = await runDropper({
      ...baseArgs,
      agentLoop: scriptedLoop([{ ids: ["aaaaaaaaaaaa"] }], { capEndsRun: true }),
      maxTurns: 1,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerStreamError);
    expect(isDeterministicError(error)).toBe(false);
    expect(isRetryableError(error)).toBe(false);
  });
});
