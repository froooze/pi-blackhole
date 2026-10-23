import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, statSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadAllMessages,
  clearSessionCache,
  configureSessionCache,
  getSessionCacheStats,
} from "../src/core/load-messages.js";

/**
 * Session-file cache bounds (#183): a cache entry retains a complete parse of
 * the session, so entry count and TTL alone could keep several copies of a
 * very large JSONL alive. These tests pin the size and expiry behavior.
 */
describe("recall session cache bounds (#183)", () => {
  let dirs: string[] = [];

  const newDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "pi-blackhole-cache-"));
    dirs.push(dir);
    return dir;
  };

  const writeSession = (file: string, texts: string[]): void => {
    const lines = texts.map((text, i) =>
      JSON.stringify({
        type: "message",
        id: `m${i}`,
        message: { role: "user", content: text },
      }),
    );
    writeFileSync(file, lines.join("\n") + "\n", "utf8");
  };

  beforeEach(() => {
    clearSessionCache();
    configureSessionCache({
      maxEntries: 3,
      maxEntrySourceBytes: 64 * 1024 * 1024,
      maxTotalSourceBytes: 128 * 1024 * 1024,
      ttlMs: 2_000,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    clearSessionCache();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  it("does not retain a source file above the per-entry byte limit", () => {
    const dir = newDir();
    const file = join(dir, "session.jsonl");
    writeSession(file, ["x".repeat(200)]);
    configureSessionCache({ maxEntrySourceBytes: 64 });

    loadAllMessages(file, false);

    expect(getSessionCacheStats().entries).toBe(0);
  });

  it("still returns every message when a large source is not cached", () => {
    const dir = newDir();
    const file = join(dir, "session.jsonl");
    writeSession(file, ["u1", "u2", "u3"]);
    configureSessionCache({ maxEntrySourceBytes: 64 });

    const first = loadAllMessages(file, false);
    const second = loadAllMessages(file, false);

    expect(first.rendered.map((e) => e.summary)).toEqual(["u1", "u2", "u3"]);
    expect(second.rendered.map((e) => e.summary)).toEqual(["u1", "u2", "u3"]);
    expect(second.rawMessages).toHaveLength(3);
  });

  it("evicts entries to stay inside the total retained-source budget", () => {
    const dir = newDir();
    const first = join(dir, "a.jsonl");
    const second = join(dir, "b.jsonl");
    writeSession(first, ["a".repeat(100)]);
    writeSession(second, ["b".repeat(100)]);
    const firstBytes = statSync(first).size;
    const secondBytes = statSync(second).size;
    // Budget fits one file but not both, so caching the second must evict the first.
    configureSessionCache({
      maxEntrySourceBytes: secondBytes,
      maxTotalSourceBytes: firstBytes + secondBytes - 1,
    });

    loadAllMessages(first, false);
    loadAllMessages(second, false);

    const stats = getSessionCacheStats();
    expect(stats.entries).toBe(1);
    expect(stats.keys.some((key) => key.startsWith(first))).toBe(false);
    expect(stats.keys.some((key) => key.startsWith(second))).toBe(true);
    expect(stats.retainedSourceBytes).toBeLessThanOrEqual(firstBytes + secondBytes - 1);
  });

  it("evicts the oldest entry when the entry-count limit is reached", () => {
    const dir = newDir();
    const first = join(dir, "a.jsonl");
    const second = join(dir, "b.jsonl");
    const third = join(dir, "c.jsonl");
    writeSession(first, ["a"]);
    writeSession(second, ["b"]);
    writeSession(third, ["c"]);
    configureSessionCache({ maxEntries: 2 });

    loadAllMessages(first, false);
    loadAllMessages(second, false);
    loadAllMessages(third, false);

    const stats = getSessionCacheStats();
    expect(stats.entries).toBe(2);
    expect(stats.keys.some((key) => key.startsWith(first))).toBe(false);
    expect(stats.keys.some((key) => key.startsWith(second))).toBe(true);
    expect(stats.keys.some((key) => key.startsWith(third))).toBe(true);
  });

  it("drops an entry when its TTL elapses without another cache access", () => {
    vi.useFakeTimers();
    const dir = newDir();
    const file = join(dir, "session.jsonl");
    writeSession(file, ["u1"]);
    configureSessionCache({ ttlMs: 2_000 });

    loadAllMessages(file, false);
    expect(getSessionCacheStats().entries).toBe(1);

    vi.advanceTimersByTime(1_999);
    expect(getSessionCacheStats().entries).toBe(1);

    vi.advanceTimersByTime(1);
    expect(getSessionCacheStats().entries).toBe(0);
  });

  it("keeps a replacement entry alive when the previous entry's timer fires", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const dir = newDir();
    const file = join(dir, "session.jsonl");
    writeSession(file, ["u1"]);
    configureSessionCache({ ttlMs: 1_000 });

    loadAllMessages(file, false);
    // Force a TTL miss without running the scheduled callback, then replace.
    vi.setSystemTime(Date.now() + 5_000);
    loadAllMessages(file, false);
    expect(getSessionCacheStats().entries).toBe(1);

    // This range contains the previous entry's due time; it must not drop the
    // replacement, which expires one millisecond later.
    vi.advanceTimersByTime(999);
    expect(getSessionCacheStats().entries).toBe(1);

    vi.advanceTimersByTime(1);
    expect(getSessionCacheStats().entries).toBe(0);
  });

  it("rescans when the session file mtime changes", () => {
    const dir = newDir();
    const file = join(dir, "session.jsonl");
    writeSession(file, ["before"]);
    configureSessionCache({ ttlMs: 60_000 });

    expect(loadAllMessages(file, false).rendered[0].summary).toBe("before");

    writeSession(file, ["after"]);
    const past = new Date(Date.now() - 60_000);
    utimesSync(file, past, past);

    expect(loadAllMessages(file, false).rendered[0].summary).toBe("after");
  });
});
