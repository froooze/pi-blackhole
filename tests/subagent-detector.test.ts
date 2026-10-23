/**
 * Runner-agnostic subagent detection.
 *
 * The detector is the single place to teach blackhole about a new subagent
 * runner: env markers, session-file markers, custom entry types, and the
 * generic parent→child ancestry marker.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  EXTRA_MARKERS_ENV,
  ROOT_SESSIONS_ENV,
  SUBAGENT_ENV_MARKERS,
  detectSubagentSession,
  readExtraMarkers,
  readRootSessionIds,
  registerRootSession,
  resetSubagentDetectorState,
  unregisterRootSession,
  type SubagentProbe,
} from "../src/core/subagent-detector.js";

function probe(overrides: Partial<SubagentProbe> = {}): SubagentProbe {
  return {
    env: {},
    sessionId: "main-1",
    isPersisted: true,
    sessionStartReason: "startup",
    rootSessionIds: [],
    ...overrides,
  };
}

afterEach(() => {
  resetSubagentDetectorState();
});

describe("known env markers", () => {
  it.each(SUBAGENT_ENV_MARKERS.map((marker) => [marker.name, marker.name] as const))(
    "%s marks a subagent session",
    (name) => {
      const value = name === "PI_SUBAGENT_DEPTH" ? "2" : "1";
      const decision = detectSubagentSession(probe({ env: { [name]: value } }));
      expect(decision.isSubagent).toBe(true);
      expect(decision.reason).toBe(`env:${name}`);
    },
  );

  it("PI_SUBAGENT_DEPTH=0 is not a child marker", () => {
    const decision = detectSubagentSession(probe({ env: { PI_SUBAGENT_DEPTH: "0" } }));
    expect(decision.isSubagent).toBe(false);
  });

  it("an empty marker value is ignored", () => {
    const decision = detectSubagentSession(probe({ env: { PI_SUBAGENT_CHILD: "   " } }));
    expect(decision.isSubagent).toBe(false);
  });

  it("PI_SUBAGENT_CHILD=false is ignored", () => {
    const decision = detectSubagentSession(probe({ env: { PI_SUBAGENT_CHILD: "false" } }));
    expect(decision.isSubagent).toBe(false);
  });
});

describe("user-extensible markers", () => {
  it("reads a comma-separated marker list", () => {
    expect(readExtraMarkers({ [EXTRA_MARKERS_ENV]: " MY_RUNNER , OTHER " })).toEqual([
      "MY_RUNNER",
      "OTHER",
    ]);
  });

  it("marks a child when an extra marker is non-empty", () => {
    const decision = detectSubagentSession(
      probe({ env: { MY_MARKER: "1", [EXTRA_MARKERS_ENV]: "MY_MARKER" } }),
    );
    expect(decision.isSubagent).toBe(true);
    expect(decision.reason).toBe("env_custom:MY_MARKER");
  });

  it("ignores an empty extra marker", () => {
    const decision = detectSubagentSession(
      probe({ env: { MY_MARKER: "", [EXTRA_MARKERS_ENV]: "MY_MARKER" } }),
    );
    expect(decision.isSubagent).toBe(false);
  });
});

describe("session evidence", () => {
  it("recognizes a pi-submarine session file", () => {
    const decision = detectSubagentSession(
      probe({ sessionFile: "/sessions/parent.jsonl.subagents/child.jsonl" }),
    );
    expect(decision.isSubagent).toBe(true);
    expect(decision.reason).toBe("path:pi-submarine");
  });

  it("recognizes a pi-subagent-manager thread entry", () => {
    const decision = detectSubagentSession(probe({ entryCustomTypes: ["pi-subagent:thread:v1"] }));
    expect(decision.isSubagent).toBe(true);
    expect(decision.reason).toBe("entry:pi-subagent:thread:v1");
  });

  it("recognizes a pi-herdsman managed-agent entry", () => {
    const decision = detectSubagentSession(
      probe({ entryCustomTypes: ["pi-herdsman-agent-definition"] }),
    );
    expect(decision.isSubagent).toBe(true);
    expect(decision.reason).toBe("entry:pi-herdsman-agent-definition");
  });

  it("does not treat an ordinary persisted session file as a subagent path", () => {
    const decision = detectSubagentSession(
      probe({
        sessionFile: "/sessions/child.jsonl",
      }),
    );
    expect(decision.isSubagent).toBe(false);
  });
});

describe("generic root ancestry marker", () => {
  it("marks a session whose id is absent from an inherited root list", () => {
    const decision = detectSubagentSession(
      probe({ sessionId: "child-9", rootSessionIds: ["root-1"] }),
    );
    expect(decision.isSubagent).toBe(true);
    expect(decision.reason).toBe("session:root_ancestor_mismatch");
  });

  it("leaves a known root session alone", () => {
    const decision = detectSubagentSession(
      probe({ sessionId: "root-1", rootSessionIds: ["root-1"] }),
    );
    expect(decision.isSubagent).toBe(false);
    expect(decision.reason).toBe("session:main");
  });

  it("reads the inherited root list from the environment", () => {
    const decision = detectSubagentSession(
      probe({ sessionId: "child-9", env: { [ROOT_SESSIONS_ENV]: "root-1, root-2" } }),
    );
    expect(decision.isSubagent).toBe(true);
  });
});

describe("fork ambiguity", () => {
  it("treats a persisted fork as a manual user fork, not a subagent", () => {
    const decision = detectSubagentSession(
      probe({
        sessionId: "fork-1",
        rootSessionIds: ["root-1"],
        sessionStartReason: "fork",
        isPersisted: true,
      }),
    );
    expect(decision.isSubagent).toBe(false);
    expect(decision.reason).toBe("session:manual_fork");
  });

  it("treats a non-persisted fork as a subagent fork", () => {
    const decision = detectSubagentSession(
      probe({
        sessionId: "fork-1",
        rootSessionIds: ["root-1"],
        sessionStartReason: "fork",
        isPersisted: false,
      }),
    );
    expect(decision.isSubagent).toBe(true);
    expect(decision.reason).toBe("session:fork_in_memory");
  });

  it("treats a non-persisted fork with no inherited roots as a subagent fork", () => {
    const decision = detectSubagentSession(
      probe({
        sessionId: "fork-1",
        rootSessionIds: [],
        sessionStartReason: "fork",
        isPersisted: false,
      }),
    );
    expect(decision.isSubagent).toBe(true);
    expect(decision.reason).toBe("session:fork_in_memory");
  });

  it("treats a /new session as a new root, not a child", () => {
    const decision = detectSubagentSession(
      probe({
        sessionId: "main-2",
        rootSessionIds: ["root-1"],
        sessionStartReason: "new",
        isPersisted: true,
      }),
    );
    expect(decision.isSubagent).toBe(false);
    expect(decision.reason).toBe("session:new_root");
  });
});

describe("resume ambiguity", () => {
  it("treats a resumed main session as a root when its id is absent from the registry", () => {
    const decision = detectSubagentSession(
      probe({
        sessionId: "resumed-main",
        rootSessionIds: ["root-1"],
        sessionStartReason: "resume",
        isPersisted: true,
      }),
    );
    expect(decision.isSubagent).toBe(false);
    expect(decision.reason).toBe("session:resumed_root");
  });

  it("still gates a resumed session with positive child evidence", () => {
    const decision = detectSubagentSession(
      probe({
        sessionId: "resumed-child",
        rootSessionIds: ["root-1"],
        sessionStartReason: "resume",
        isPersisted: true,
        env: { PI_SUBAGENT_CHILD: "1" },
      }),
    );
    expect(decision.isSubagent).toBe(true);
    expect(decision.reason).toBe("env:PI_SUBAGENT_CHILD");
  });
});

describe("root registry", () => {
  it("registerRootSession appends the id and exports it to child processes", () => {
    const env: Record<string, string | undefined> = {};
    registerRootSession("root-1", env);
    registerRootSession("root-2", env);
    expect(readRootSessionIds(env)).toEqual(["root-1", "root-2"]);
  });

  it("keeps inherited ancestors when a root registers itself", () => {
    const env: Record<string, string | undefined> = { [ROOT_SESSIONS_ENV]: "outer-root" };
    registerRootSession("root-1", env);
    expect(readRootSessionIds(env)).toEqual(["outer-root", "root-1"]);
  });

  it("unregisterRootSession removes only the named id", () => {
    const env: Record<string, string | undefined> = {};
    registerRootSession("root-1", env);
    registerRootSession("root-2", env);
    unregisterRootSession("root-1", env);
    expect(readRootSessionIds(env)).toEqual(["root-2"]);
  });

  it("unregisterRootSession clears the env var when no roots remain", () => {
    const env: Record<string, string | undefined> = {};
    registerRootSession("root-1", env);
    unregisterRootSession("root-1", env);
    expect(env[ROOT_SESSIONS_ENV]).toBeUndefined();
  });
});

describe("fails closed", () => {
  it("treats an unknown plain session as main", () => {
    expect(detectSubagentSession(probe()).isSubagent).toBe(false);
  });

  it("does not throw on malformed marker lists", () => {
    expect(() =>
      detectSubagentSession(probe({ env: { [EXTRA_MARKERS_ENV]: ",, ," } })),
    ).not.toThrow();
  });
});
