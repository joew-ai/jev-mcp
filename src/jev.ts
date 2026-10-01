import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

export const MAX_REQUEST_BYTES = 512 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_QUESTIONS = 20;

// Shallow schemas let us bound arbitrary JSON iteratively, before recursive parsing
// could overflow the stack. These bounds also apply to structured instructions.
function boundedJson(value: unknown) {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (++nodes > 20000 || next.depth > 32) return false;
    const item = next.value;
    if (item === null || typeof item === "string" || typeof item === "boolean")
      continue;
    if (typeof item === "number" && Number.isFinite(item)) continue;
    if (typeof item !== "object" || item === null) return false;
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      return false;
    for (const child of Object.values(item))
      pending.push({ value: child, depth: next.depth + 1 });
  }
  return true;
}

const content = z
  .unknown()
  .refine(
    (value) =>
      (typeof value === "string" ||
        Array.isArray(value) ||
        (typeof value === "object" && value !== null)) &&
      boundedJson(value),
    "Content must be a string, JSON object or array with at most 32 nested levels and 20000 nodes",
  )
  .meta({
    anyOf: [
      { type: "string" },
      { type: "object", additionalProperties: {} },
      { type: "array", items: {} },
    ],
  });

// Labels may contain spaces and punctuation. Only prototype-sensitive map keys
// are excluded; arbitrary nested JSON remains caller data, never routing config.
const key = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) => !["__proto__", "constructor", "prototype"].includes(value),
    "Unsupported map key",
  );
const criteria = z
  .record(key, content.nullable())
  .refine(
    (value) =>
      Object.keys(value).length >= 1 && Object.keys(value).length <= 255,
    "Choice requires 1–255 options",
  )
  .meta({ minProperties: 1, maxProperties: 255 });

export const questionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("choice"),
    instructions: content,
    criteria,
  }),
  z.strictObject({
    type: z.literal("score"),
    instructions: content,
    criteria: z.array(content).min(2).max(10),
  }),
  z.strictObject({
    type: z.literal("noul"),
    instructions: content,
    criteria: z
      .strictObject({ true: content.optional(), false: content.optional() })
      .optional(),
  }),
]);

export const inputSchema = z.strictObject({
  state: content,
  model: z.string().min(1).max(100).optional(),
  questions: z
    .record(key, questionSchema)
    .refine(
      (value) =>
        Object.keys(value).length >= 1 &&
        Object.keys(value).length <= MAX_QUESTIONS,
      `Request requires 1–${MAX_QUESTIONS} questions`,
    )
    .meta({ minProperties: 1, maxProperties: MAX_QUESTIONS }),
});
export type JevRequest = z.infer<typeof inputSchema>;

const probability = z.number().min(0).max(1);
const distribution = z.record(z.string(), probability);
const answerSchema = z.discriminatedUnion("type", [
  z.looseObject({
    type: z.literal("choice"),
    choice: z.string(),
    confidence: probability,
    probabilities: distribution,
  }),
  z.looseObject({
    type: z.literal("score"),
    score: z.number(),
    confidence: probability,
    probabilities: distribution,
    legend: z.record(z.string(), content),
  }),
  z.looseObject({ type: z.literal("noul"), noul: probability }),
]);
const responseSchema = z.looseObject({
  model: z.string().min(1).max(100),
  answers: z.record(z.string(), answerSchema),
  usage: z.looseObject({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});
export type JevResponse = z.infer<typeof responseSchema>;
export interface JevClient {
  model: string;
  evaluate(request: JevRequest): Promise<JevResponse>;
}

function validDistribution(
  probabilities: Record<string, number>,
  keys: string[],
) {
  return (
    Object.keys(probabilities).length === keys.length &&
    keys.every((key) => Object.hasOwn(probabilities, key)) &&
    Math.abs(
      Object.values(probabilities).reduce((sum, value) => sum + value, 0) - 1,
    ) <= 0.001
  );
}

function validateResponse(raw: unknown, request: JevRequest): JevResponse {
  if (!boundedJson(raw)) throw new Error();
  const response = responseSchema.parse(raw);
  if (
    Object.keys(response.answers).length !==
    Object.keys(request.questions).length
  )
    throw new Error();
  for (const [id, question] of Object.entries(request.questions)) {
    if (!Object.hasOwn(response.answers, id)) throw new Error();
    const answer = response.answers[id];
    if (answer.type !== question.type) throw new Error();
    if (question.type === "choice" && answer.type === "choice") {
      const keys = Object.keys(question.criteria);
      if (
        !keys.includes(answer.choice) ||
        !validDistribution(answer.probabilities, keys) ||
        answer.probabilities[answer.choice] <
          Math.max(...Object.values(answer.probabilities))
      )
        throw new Error();
    }
    if (question.type === "score" && answer.type === "score") {
      const keys = question.criteria.map((_, index) => String(index));
      if (
        !validDistribution(answer.probabilities, keys) ||
        Object.keys(answer.legend).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(answer.legend, key))
      )
        throw new Error();
      // Legends echo the requested levels. Compare JSON values rather than
      // serialized text so object property order does not affect equality.
      if (
        keys.some(
          (key, index) =>
            !isDeepStrictEqual(answer.legend[key], question.criteria[index]),
        )
      )
        throw new Error();
      const mean = keys.reduce(
        (sum, key) => sum + Number(key) * answer.probabilities[key],
        0,
      );
      // Allow normal rounding of a weighted score, without altering its value.
      if (
        answer.score < 0 ||
        answer.score > keys.length - 1 ||
        Math.abs(answer.score - mean) > 0.01
      )
        throw new Error();
    }
  }
  // Validate without projecting fields or inventing confidence/explanations.
  return raw as JevResponse;
}

export function createJevClient(
  model: string,
  getKey: () => Promise<string>,
  fetcher: typeof fetch = fetch,
): JevClient {
  return {
    model,
    async evaluate(request) {
      try {
        // Validate before secret reads or paid calls, including direct client use.
        const input = inputSchema.parse({
          ...request,
          model: request.model ?? model,
        });
        const body = JSON.stringify(input);
        if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new Error();
        // Match legends against the JSON actually sent, including JSON's
        // normalization of negative zero and object prototypes.
        const sentInput = JSON.parse(body) as JevRequest;
        const key = await getKey();
        const response = await fetcher("https://api.typesafe.ai/v1/systemone", {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(12000),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body,
        });
        // No retries: a timed-out request may already have incurred a charge.
        if (!response.ok || !response.body) throw new Error();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = "";
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > MAX_RESPONSE_BYTES) throw new Error();
            text += decoder.decode(value, { stream: true });
          }
        } finally {
          await reader.cancel();
        }
        return validateResponse(JSON.parse(text + decoder.decode()), sentInput);
      } catch {
        throw new Error("Inference unavailable");
      }
    },
  };
}
