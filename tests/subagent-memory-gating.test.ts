/**
 * Per-session gating for the subagentMemory knob.
 *
 * The gate must be evaluated per event from the current ctx: in-process
 * subagents share one Runtime with the parent, so mutating runtime.config
 * would turn memory off for the parent too.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Runtime } from "../src/om/runtime.js";
import { registerConsolidationTrigger } from "../src/om/consolidation.js";
import { observeTailOnShutdown } from "../src/om/shutdown-observe.js";
import {
  ROOT_SESSIONS_ENV,
  readRootSessionIds,
  resetSubagentDetectorState,
} from "../src/core/subagent-detector.js";

interface CtxOptions {
  sessionFile?: string;
  isPersisted?: boolean;
  name?: string;
  entries?: Array<{ type: string; customType?: string }>;
}

function ctxFor(sessionId: string, options: CtxOptions = {}) {
  return {
    cwd: "/tmp",
    hasUI: false,
    model: undefined,
    ui: { notify: vi.fn() },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => options.sessionFile,
      isPersisted: () => options.isPersisted ?? true,
      getSessionName: () => options.name,
      getHeader: () => null,
      getEntries: () => options.entries ?? [],
      getBranch: () => [],
    },
  } as any;
}

function makePi() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  return {
    pi: {
      on(event: string, handler: (event: any, ctx: any) => unknown) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return () => {};
      },
    } as any,
    fire(event: string, payload: any, ctx: any) {
      for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
    },
  };
}

afterEach(() => {
  resetSubagentDetectorState();
  delete process.env[ROOT_SESSIONS_ENV];
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_DEPTH;
  delete process.env.PI_BLACKHOLE_MEMORY;
  vi.restoreAllMocks();
});

describe("Runtime.isMemoryEnabled", () => {
  it("disables OM for a detected subagent when the knob is off", () => {
    const runtime = new Runtime();
    runtime.config.memory = true;
    runtime.config.subagentMemory = "off";
    process.env.PI_SUBAGENT_CHILD = "1";

    expect(runtime.isMemoryEnabled(ctxFor("child-1"))).toBe(false);
  });

  it("keeps OM for the parent session in the same runtime", () => {
    const runtime = new Runtime();
    runtime.config.memory = true;
    runtime.config.subagentMemory = "off";

    const parent = ctxFor("parent-1");
    runtime.noteSessionStart(parent, { reason: "startup" });

    expect(runtime.isMemoryEnabled(parent)).toBe(true);
    expect(runtime.isMemoryEnabled(ctxFor("child-1"))).toBe(false);
  });

  it("keeps OM on for a resumed main session absent from the registry", () => {
    process.env[ROOT_SESSIONS_ENV] = "other-root";
    const runtime = new Runtime();
    runtime.config.memory = true;
    runtime.config.subagentMemory = "off";
    const resumed = ctxFor("resumed-main");

    runtime.noteSessionStart(resumed, { reason: "resume" });

    expect(runtime.isMemoryEnabled(resumed)).toBe(true);
  });

  it("knob off wins even when PI_BLACKHOLE_MEMORY=true resolved memory on", () => {
    process.env.PI_BLACKHOLE_MEMORY = "true";
    const runtime = new Runtime();
    runtime.config.memory = true; // what PI_BLACKHOLE_MEMORY=true resolves to
    runtime.config.subagentMemory = "off";
    process.env.PI_SUBAGENT_CHILD = "1";

    expect(runtime.isMemoryEnabled(ctxFor("child-1"))).toBe(false);
  });

  it("honours inherit for a detected subagent", () => {
    const runtime = new Runtime();
    runtime.config.memory = true;
    runtime.config.subagentMemory = "inherit";
    process.env.PI_SUBAGENT_CHILD = "1";

    expect(runtime.isMemoryEnabled(ctxFor("child-1"))).toBe(true);
  });

  it("keeps the explicit memory:false kill switch for every session", () => {
    const runtime = new Runtime();
    runtime.config.memory = false;
    runtime.config.subagentMemory = "inherit";

    expect(runtime.isMemoryEnabled(ctxFor("parent-1"))).toBe(false);
    expect(runtime.isMemoryEnabled(ctxFor("child-1"))).toBe(false);
  });

  it("does not mutate the shared config while gating a child", () => {
    const runtime = new Runtime();
    runtime.config.memory = true;
    runtime.config.subagentMemory = "off";
    process.env.PI_SUBAGENT_CHILD = "1";
    const before = JSON.stringify(runtime.config);

    runtime.isMemoryEnabled(ctxFor("child-1"));

    expect(JSON.stringify(runtime.config)).toBe(before);
  });

  it("caches one decision per session id", () => {
    const runtime = new Runtime();
    const ctx = ctxFor("child-1");
    const getEntries = vi.spyOn(ctx.sessionManager, "getEntries");
    process.env.PI_SUBAGENT_CHILD = "1";

    runtime.isMemoryEnabled(ctx);
    runtime.isMemoryEnabled(ctx);

    expect(getEntries).toHaveBeenCalledTimes(1);
  });
});

describe("consolidation trigger wiring", () => {
  it("returns before launching a worker when isMemoryEnabled is false", () => {
    const runtime = {
      config: { memory: true, subagentMemory: "off", debugLog: false },
      ensureConfig: vi.fn(),
      startSession: vi.fn(),
      isConsolidationRetryGated: vi.fn(() => false),
      isMemoryEnabled: vi.fn(() => false),
      noteSubagentMemorySkip: vi.fn(),
      launchConsolidationTask: vi.fn(),
    } as any;
    const { pi, fire } = makePi();
    registerConsolidationTrigger(pi, runtime);

    const ctx = ctxFor("child-1");
    fire("agent_start", {}, ctx);

    expect(runtime.isMemoryEnabled).toHaveBeenCalledWith(ctx);
    expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
  });
});

describe("root registry teardown", () => {
  it("unregisters the ending main session id on shutdown", () => {
    const runtime = new Runtime();
    const { pi, fire } = makePi();
    registerConsolidationTrigger(pi, runtime);
    const parent = ctxFor("parent-1");
    runtime.noteSessionStart(parent, { reason: "startup" });
    expect(readRootSessionIds(process.env)).toContain("parent-1");

    fire("session_shutdown", { type: "session_shutdown", reason: "new" }, parent);

    expect(readRootSessionIds(process.env)).not.toContain("parent-1");
  });

  it("keeps the root id registered on a reload", () => {
    const runtime = new Runtime();
    const { pi, fire } = makePi();
    registerConsolidationTrigger(pi, runtime);
    const parent = ctxFor("parent-1");
    runtime.noteSessionStart(parent, { reason: "startup" });

    fire("session_shutdown", { type: "session_shutdown", reason: "reload" }, parent);

    expect(readRootSessionIds(process.env)).toContain("parent-1");
  });
});

describe("shutdown observer wiring", () => {
  it("does not start a shutdown observation for a memory-disabled session", async () => {
    const runtime = {
      config: {
        observeOnShutdown: true,
        memory: true,
        subagentMemory: "off",
        compaction: "auto",
        compactionEngine: "blackhole",
        debugLog: false,
      },
      isConsolidationRetryGated: vi.fn(() => false),
      isMemoryEnabled: vi.fn(() => false),
      noteSubagentMemorySkip: vi.fn(),
      captureGeneration: vi.fn(),
      dispose: vi.fn(),
    } as any;

    await observeTailOnShutdown({} as any, runtime, ctxFor("child-1"), "quit");

    expect(runtime.isMemoryEnabled).toHaveBeenCalled();
    expect(runtime.captureGeneration).not.toHaveBeenCalled();
  });
});
