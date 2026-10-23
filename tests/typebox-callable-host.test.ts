/**
 * Hosts that shim typebox (omp's omptype) return callable schemas that expose
 * toJsonSchema() but no `.properties`. Module-level code must never read
 * schema internals back, or the extension fails to load (#174).
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import type * as ReflectorToolSchema from "../src/om/agents/reflector/tool-schema.js";

type Json = Record<string, unknown>;

const optionalSchemas = new WeakSet<object>();

function callable(json: Json, optional = false) {
  const schema = Object.assign(function shimSchema(): void {}, { toJsonSchema: () => json });
  if (optional) optionalSchemas.add(schema);
  return schema;
}

function jsonOf(schema: unknown): Json {
  if (
    typeof schema === "function" &&
    "toJsonSchema" in schema &&
    typeof schema.toJsonSchema === "function"
  ) {
    const json: Json = schema.toJsonSchema();
    return json;
  }
  throw new Error("not a callable shim schema");
}

// Models omp's callable shape only, not TypeBox output: no `~kind`/`~optional` markers, and an
// empty `required` is kept. The golden schema test in reflector.test.ts pins real typebox output.
const shimType = {
  Object: (fields: Record<string, unknown>) =>
    callable({
      type: "object",
      properties: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, jsonOf(v)])),
      required: Object.entries(fields)
        .filter(([, v]) => !(typeof v === "function" && optionalSchemas.has(v)))
        .map(([k]) => k),
    }),
  Array: (item: unknown, options: Json = {}) =>
    callable({ type: "array", items: jsonOf(item), ...options }),
  String: (options: Json = {}) => callable({ type: "string", ...options }),
  Number: (options: Json = {}) => callable({ type: "number", ...options }),
  Boolean: (options: Json = {}) => callable({ type: "boolean", ...options }),
  Literal: (value: unknown) => callable({ const: value }),
  Union: (members: unknown[]) => callable({ anyOf: members.map(jsonOf) }),
  Optional: (inner: unknown) => callable(jsonOf(inner), true),
};

// Dynamic import: the typebox mock must be registered before the schema modules evaluate.
async function loadReflectorSchemasUnderShim(
  type: typeof shimType = shimType,
): Promise<typeof ReflectorToolSchema> {
  vi.doMock("typebox", () => ({ Type: type }));
  vi.resetModules();
  return await import("../src/om/agents/reflector/tool-schema.js");
}

// Hosts may expose `.properties` as a non-enumerable accessor instead of
// omitting it. The module must never touch it, so make any read fatal: the
// pre-fix formulation threw here, and the fix must keep it unreachable.
const shimTypeWithReadGuard: typeof shimType = {
  ...shimType,
  Object: (fields: Record<string, unknown>) => {
    const schema = shimType.Object(fields);
    Object.defineProperty(schema, "properties", {
      configurable: true,
      get() {
        throw new Error("host shim .properties must not be read");
      },
    });
    return schema;
  },
};

afterEach(() => {
  vi.doUnmock("typebox");
  vi.resetModules();
});

describe("typebox shim with callable schemas and no .properties", () => {
  test("prompt-budget imports, which loads every worker tool schema", async () => {
    vi.doMock("typebox", () => ({ Type: shimType }));
    vi.resetModules();
    await expect(import("../src/om/prompt-budget.js")).resolves.toBeDefined();
  });

  test("never reads .properties, even when the shim exposes it as a throwing getter", async () => {
    await expect(loadReflectorSchemasUnderShim(shimTypeWithReadGuard)).resolves.toBeDefined();
  });

  test("supersedes schema adds an array-typed supersedes to the reflection item", async () => {
    const { RecordReflectionsWithSupersedesSchema } = await loadReflectorSchemasUnderShim();
    expect(jsonOf(RecordReflectionsWithSupersedesSchema)).toHaveProperty(
      "properties.reflections.items.properties.supersedes.type",
      "array",
    );
  });

  test("supersedes stays optional on the reflection item", async () => {
    const { RecordReflectionsWithSupersedesSchema } = await loadReflectorSchemasUnderShim();
    expect(jsonOf(RecordReflectionsWithSupersedesSchema)).toHaveProperty(
      "properties.reflections.items.required",
      ["content", "supportingObservationIds"],
    );
  });

  test("base schema leaves supersedes out of the reflection item", async () => {
    const { RecordReflectionsSchema } = await loadReflectorSchemasUnderShim();
    expect(jsonOf(RecordReflectionsSchema)).not.toHaveProperty(
      "properties.reflections.items.properties.supersedes",
    );
  });

  test.each(["RecordReflectionsSchema", "RecordReflectionsWithSupersedesSchema"] as const)(
    "%s keeps complete optional at the top level",
    async (name) => {
      const schemas = await loadReflectorSchemasUnderShim();
      expect(jsonOf(schemas[name])).toMatchObject({
        properties: { complete: { type: "boolean" } },
        required: ["reflections"],
      });
    },
  );
});
