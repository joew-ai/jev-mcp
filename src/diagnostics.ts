export const inferenceCategories = Object.freeze([
  "upstream_http",
  "timeout",
  "network",
  "credentials",
  "request_validation",
  "response_json",
  "response_size",
  "response_validation",
  "internal",
] as const);
export type InferenceCategory = (typeof inferenceCategories)[number];

export const validationReasons = Object.freeze([
  "request_schema",
  "request_size",
  "response_content",
  "response_schema",
  "answer_count",
  "answer_id",
  "answer_type",
  "choice",
  "probability_distribution",
  "score_legend",
  "score_value",
] as const);
export type ValidationReason = (typeof validationReasons)[number];

export interface InferenceDiagnostic {
  category: InferenceCategory;
  validationReason?: ValidationReason;
  upstreamStatus?: number;
  upstreamRequestId?: string;
}

/** Safe to expose to callers: all fields are fixed labels or bounded metadata. */
export class InferenceError extends Error {
  readonly diagnostic: InferenceDiagnostic;

  constructor(diagnostic: InferenceDiagnostic) {
    super("Inference unavailable");
    this.name = "Error";
    this.diagnostic = diagnostic;
  }
}

export function safeDiagnostic(error: unknown): InferenceDiagnostic {
  if (error instanceof InferenceError) {
    try {
      const candidate = error.diagnostic as Partial<InferenceDiagnostic>;
      const rawCategory = candidate.category;
      const rawValidationReason = candidate.validationReason;
      const rawStatus = candidate.upstreamStatus;
      const rawUpstreamRequestId = candidate.upstreamRequestId;
      const category = inferenceCategories.includes(
        rawCategory as InferenceCategory,
      )
        ? (rawCategory as InferenceCategory)
        : "internal";
      const validationReason = validationReasons.includes(
        rawValidationReason as ValidationReason,
      )
        ? (rawValidationReason as ValidationReason)
        : undefined;
      const upstreamStatus = validatedStatus(rawStatus);
      const upstreamRequestId = validOpaqueId(rawUpstreamRequestId)
        ? rawUpstreamRequestId
        : undefined;
      return {
        category,
        ...(validationReason ? { validationReason } : {}),
        ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
        ...(upstreamRequestId ? { upstreamRequestId } : {}),
      };
    } catch {
      return { category: "internal" };
    }
  }
  return { category: "internal" };
}

export function validOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    ) ||
      /^[a-f0-9]{16,64}$/i.test(value) ||
      /^req_[A-Za-z0-9_-]{8,60}$/.test(value))
  );
}

export function validCorrelationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+={0,2}$/.test(value)
  );
}

export function validatedStatus(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}
