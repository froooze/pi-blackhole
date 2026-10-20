/**
 * Reflector tool schema, factored out of agent.ts so the consolidation stage
 * can measure the exact serialized schema as part of the worker prompt budget
 * (src/om/prompt-budget.ts) without importing the agent loop. Single source
 * of truth: the agent builds its tool from these same objects.
 */
import { Type } from "typebox";
import type { Static } from "typebox";

// Compose both schemas from these shared fields. Reading `.properties` back
// from a built schema throws on hosts that shim typebox (omp).
const reflectionItemFields = {
  content: Type.String({ minLength: 1 }),
  supportingObservationIds: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
  }),
};

// Optional on purpose: a model that omits the flag must lose only the
// early-stop hint, never the batch itself (a required field would fail
// host-side validation and drop every reflection in the call).
const completeField = Type.Optional(
  Type.Boolean({
    description:
      "Whether this batch completes reflection review. Set false when more reflections or corrections remain.",
  }),
);

export const RecordReflectionsSchema = Type.Object({
  reflections: Type.Array(Type.Object(reflectionItemFields), { minItems: 1 }),
  complete: completeField,
});

export const RecordReflectionsWithSupersedesSchema = Type.Object({
  reflections: Type.Array(
    Type.Object({
      ...reflectionItemFields,
      supersedes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    }),
    { minItems: 1 },
  ),
  complete: completeField,
});

export type RecordReflectionsArgs = Static<typeof RecordReflectionsWithSupersedesSchema>;
