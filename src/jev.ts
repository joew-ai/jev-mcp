import { z } from "zod";
import {
  InferenceError,
  type InferenceDiagnostic,
  validatedStatus,
  validOpaqueId,
} from "./diagnostics.js";

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

// Provider JSON is untrusted data, not a validated set of Jev answers.
export type JevResponse = unknown;
export interface JevClient {
  model: string;
  evaluate(request: JevRequest): Promise<JevResponse>;
}

/** Bounded successful HTTP content that cannot be exposed as structured JSON. */
export class ProviderContentError extends InferenceError {
  constructor(
    readonly providerText: string,
    diagnostic: InferenceDiagnostic,
  ) {
    super(diagnostic);
  }
}

export function createJevClient(
  model: string,
  getKey: () => Promise<string>,
  fetcher: typeof fetch = fetch,
): JevClient {
  return {
    model,
    async evaluate(request) {
      let diagnostic: InferenceDiagnostic = { category: "internal" };
      let signal: AbortSignal | undefined;
      try {
        // Validate before secret reads or paid calls, including direct client use.
        const inputResult = inputSchema.safeParse({
          ...request,
          model: request.model ?? model,
        });
        if (!inputResult.success) {
          diagnostic = {
            category: "request_validation",
            validationReason: "request_schema",
          };
          throw new Error();
        }
        const input = inputResult.data;
        const body = JSON.stringify(input);
        if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
          diagnostic = {
            category: "request_validation",
            validationReason: "request_size",
          };
          throw new Error();
        }
        let key: string;
        try {
          key = await getKey();
        } catch {
          diagnostic = { category: "credentials" };
          throw new Error();
        }
        signal = AbortSignal.timeout(12000);
        const response = await fetcher("https://api.typesafe.ai/v1/systemone", {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body,
        });
        // No retries: a timed-out request may already have incurred a charge.
        if (!response.ok) {
          diagnostic = {
            category: "upstream_http",
            upstreamStatus: validatedStatus(response.status),
          };
          const upstreamId =
            response.headers.get("x-request-id") ??
            response.headers.get("request-id");
          if (
            validOpaqueId(upstreamId) &&
            (!key || (!key.includes(upstreamId) && !upstreamId.includes(key)))
          )
            diagnostic.upstreamRequestId = upstreamId;
          throw new Error();
        }
        const upstreamId =
          response.headers.get("x-request-id") ??
          response.headers.get("request-id");
        if (
          validOpaqueId(upstreamId) &&
          (!key || (!key.includes(upstreamId) && !upstreamId.includes(key)))
        )
          diagnostic.upstreamRequestId = upstreamId;
        diagnostic.upstreamStatus = validatedStatus(response.status);
        if (!response.body) {
          diagnostic = { ...diagnostic, category: "response_json" };
          throw new Error();
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = "";
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > MAX_RESPONSE_BYTES) {
              diagnostic = { ...diagnostic, category: "response_size" };
              throw new Error();
            }
            text += decoder.decode(value, { stream: true });
          }
        } finally {
          await reader.cancel();
        }
        const providerText = text + decoder.decode();
        let raw: unknown;
        try {
          raw = JSON.parse(providerText);
        } catch {
          throw new ProviderContentError(providerText, {
            ...diagnostic,
            category: "response_json",
          });
        }
        // These are serialization/resource limits, not answer semantics. Keep
        // the raw body available when JSON cannot safely be serialized again.
        if (!boundedJson(raw)) {
          throw new ProviderContentError(providerText, {
            ...diagnostic,
            category: "response_validation",
            validationReason: "response_content",
          });
        }
        return raw;
      } catch (error) {
        if (error instanceof ProviderContentError) throw error;
        if (error instanceof InferenceError) {
          throw new InferenceError({ ...diagnostic, ...error.diagnostic });
        }
        if (diagnostic.category === "internal") {
          const timedOut =
            signal?.aborted ||
            (error instanceof Error &&
              (error.name === "TimeoutError" || error.name === "AbortError"));
          diagnostic = {
            ...diagnostic,
            category: timedOut ? "timeout" : signal ? "network" : "internal",
          };
        }
        throw new InferenceError(diagnostic);
      }
    },
  };
}
