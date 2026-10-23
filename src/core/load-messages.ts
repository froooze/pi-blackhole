import { statSync } from "fs";
import type { Message } from "@earendil-works/pi-ai";
import { renderMessage, type RenderedEntry } from "./render-entries";
import { isCountedMessageEntry } from "./global-indices.js";
import { scanSessionEntries } from "./session-lines.js";

export interface LoadedMessages {
  rendered: RenderedEntry[];
  rawMessages: Message[];
  entryIds: string[];
}

// ── Session-file cache (LRU, invalidated by mtime) ─────────────────────────

interface CacheEntry {
  result: LoadedMessages;
  mtimeMs: number;
  timestamp: number;
  /** Source JSONL bytes held by this entry — an approximate retained weight. */
  sourceBytes: number;
  timer?: NodeJS.Timeout;
}

const MAX_CACHE_SIZE = 3;
const CACHE_TTL_MS = 2_000;
// A cache entry keeps a complete parse of the file (raw messages plus rendered
// summaries), and decoded objects can be several times the JSONL size. Without
// a weight bound, three distinct recall keys retained three complete parses of
// the same large session (#183). Sessions above the per-entry limit are still
// recalled, just rescanned instead of cached.
const MAX_CACHE_ENTRY_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_TOTAL_SOURCE_BYTES = 128 * 1024 * 1024;

interface CacheLimits {
  maxEntries: number;
  maxEntrySourceBytes: number;
  maxTotalSourceBytes: number;
  ttlMs: number;
}

const limits: CacheLimits = {
  maxEntries: MAX_CACHE_SIZE,
  maxEntrySourceBytes: MAX_CACHE_ENTRY_SOURCE_BYTES,
  maxTotalSourceBytes: MAX_CACHE_TOTAL_SOURCE_BYTES,
  ttlMs: CACHE_TTL_MS,
};

const cache = new Map<string, CacheEntry>();
let retainedSourceBytes = 0;

/** Drop one cached entry, releasing its timer and weight exactly once. */
function release(key: string): void {
  const entry = cache.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  retainedSourceBytes -= entry.sourceBytes;
  cache.delete(key);
}

// ── Diagnostics (not part of the extension API) ────────────────────────────
// Exposed so tests and local probes can assert bounds without writing
// hundreds of MiB. Production code never calls these.

export interface SessionCacheStats {
  entries: number;
  retainedSourceBytes: number;
  keys: string[];
}

export const getSessionCacheStats = (): SessionCacheStats => ({
  entries: cache.size,
  retainedSourceBytes,
  keys: [...cache.keys()],
});

export const clearSessionCache = (): void => {
  // Map iteration stays valid while the current entry is deleted.
  for (const key of cache.keys()) release(key);
};

export const configureSessionCache = (next: Partial<CacheLimits>): void => {
  Object.assign(limits, next);
};

function cacheKey(
  sessionFile: string,
  full: boolean,
  allowedEntryIds: Set<string> | undefined,
): string {
  let hash = `${sessionFile}::${full}`;
  if (allowedEntryIds && allowedEntryIds.size > 0) {
    // Include the full set as sorted JSON for collision-free caching
    hash += `::${JSON.stringify([...allowedEntryIds].sort())}`;
  }
  return hash;
}

function getCached(
  sessionFile: string,
  full: boolean,
  allowedEntryIds?: Set<string>,
): LoadedMessages | undefined {
  const key = cacheKey(sessionFile, full, allowedEntryIds);
  const entry = cache.get(key);
  if (!entry) return undefined;

  // Check TTL (mtime-based invalidation)
  if (Date.now() - entry.timestamp > limits.ttlMs) {
    release(key);
    return undefined;
  }

  // Verify file mtime hasn't changed
  try {
    const mtimeMs = statSync(sessionFile).mtimeMs;
    if (mtimeMs !== entry.mtimeMs) {
      release(key);
      return undefined;
    }
  } catch {
    release(key);
    return undefined;
  }

  return entry.result;
}

function setCache(
  sessionFile: string,
  full: boolean,
  allowedEntryIds: Set<string> | undefined,
  result: LoadedMessages,
): void {
  let sourceBytes: number;
  let mtimeMs: number;
  try {
    const stat = statSync(sessionFile);
    sourceBytes = stat.size;
    mtimeMs = stat.mtimeMs;
  } catch {
    // Can't stat the file — don't cache
    return;
  }

  const key = cacheKey(sessionFile, full, allowedEntryIds);
  // Replace a previous entry for this key (its timer and weight go with it).
  release(key);

  // Too large to retain (individually or at all): recall rescans every call.
  if (sourceBytes > limits.maxEntrySourceBytes || sourceBytes > limits.maxTotalSourceBytes) {
    return;
  }

  // Evict oldest until both the entry-count and retained-byte budgets fit.
  while (
    cache.size >= limits.maxEntries ||
    retainedSourceBytes + sourceBytes > limits.maxTotalSourceBytes
  ) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    release(oldest.value);
  }

  const entry: CacheEntry = {
    result,
    mtimeMs,
    timestamp: Date.now(),
    sourceBytes,
  };
  const timer = setTimeout(() => {
    // A newer entry may own this key by now (e.g. this callback was queued
    // before the replacement landed) — only expire our own entry.
    if (cache.get(key) === entry) release(key);
  }, limits.ttlMs);
  timer.unref();
  entry.timer = timer;

  cache.set(key, entry);
  retainedSourceBytes += sourceBytes;
}

export const loadAllMessages = (
  sessionFile: string,
  full: boolean,
  allowedEntryIds?: Set<string>,
): LoadedMessages => {
  // Check cache first (same sessionFile + full flag + lineage size — approximate)
  const cached = getCached(sessionFile, full, allowedEntryIds);
  if (cached) return cached;

  const rendered: RenderedEntry[] = [];
  const rawMessages: Message[] = [];
  const entryIds: string[] = [];

  let messageIndex = 0;
  // Streamed per upstream pi-vcc #26: never materialize the whole session
  // file as one string (V8 limit). Counting rule shared with
  // src/core/global-indices.ts — both index spaces must agree by construction.
  const scan = scanSessionEntries(sessionFile, (e) => {
    if (!isCountedMessageEntry(e)) return;

    const allowed = !allowedEntryIds || allowedEntryIds.has(e.id);
    if (allowed) {
      const entryId = e.id != null ? String(e.id) : "";
      rendered.push(renderMessage(e.message, messageIndex, entryId, full));
      rawMessages.push(e.message);
      entryIds.push(entryId);
    }
    messageIndex++;
  });
  if (scan.missing) {
    // Pi does not create a new session's JSONL until its first persisted
    // entry: empty current-session history, not a failure. Not cached — the
    // file may appear at any moment.
    return { rendered, rawMessages, entryIds };
  }
  if (scan.parseErrors > 0) {
    console.warn(`blackhole: ${scan.parseErrors} malformed JSONL line(s) in ${sessionFile}`);
  }

  const result: LoadedMessages = { rendered, rawMessages, entryIds };
  setCache(sessionFile, full, allowedEntryIds, result);
  return result;
};
