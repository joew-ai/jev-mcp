import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createJevClient,
  inputSchema,
  MAX_RESPONSE_BYTES,
  MAX_REQUEST_BYTES,
  ProviderContentError,
  type JevRequest,
} from "../src/jev.js";

const request: JevRequest = {
  state: {
    message: "Synthetic damaged parcel",
    metadata: { attempts: 2, active: true, previous: null },
    context: ["Caller instructions remain unchanged"],
  },
  questions: {
    "Which team?": {
      type: "choice",
      instructions: {
        question: "Which team handles this?",
        guidance: ["Use the evidence", { fallback: "Other" }],
      },
      criteria: {
        "Customer Support": { covers: ["Damaged parcel", "Returns"] },
        Other: null,
      },
    },
    severity: {
      type: "score",
      instructions: ["How severe is it?", { context: "Synthetic scale" }],
      criteria: [
        "Low",
        { level: "Medium", examples: ["Damage"] },
        ["High", "No workaround"],
      ],
    },
    urgent: {
      type: "noul",
      instructions: "Is this urgent?",
      criteria: { true: "Time-sensitive", false: { description: "Can wait" } },
    },
  },
};
const response = {
  model: "jev-1.13.0",
  answers: {
    "Which team?": {
      type: "choice",
      choice: "Customer Support",
      confidence: 0.85,
      probabilities: { "Customer Support": 0.95, Other: 0.05 },
    },
    severity: {
      type: "score",
      score: 1.25,
      confidence: 0.5,
      legend: {
        "0": "Low",
        "1": { level: "Medium", examples: ["Damage"] },
        "2": ["High", "No workaround"],
      },
      probabilities: { "0": 0, "1": 0.75, "2": 0.25 },
    },
    urgent: { type: "noul", noul: 0.8 },
  },
  usage: { input_tokens: 1234, output_tokens: 56 },
};
const copy = () => structuredClone(response);

test("all Jev primitive shapes accept arbitrary bounded JSON and labels, without finance fields", () => {
  assert.deepEqual(inputSchema.parse(request), request);
  for (const state of [
    "arbitrary text",
    [],
    {},
    {
      context: [
        { imageText: "OCR was prepared by the caller", arbitrary: true },
      ],
    },
  ])
    assert.equal(inputSchema.safeParse({ ...request, state }).success, true);
  assert.equal(
    inputSchema.safeParse({
      state: "x",
      questions: { q: { type: "noul", instructions: "yes?" } },
    }).success,
    true,
  );
  const properties = Object.keys(inputSchema.shape);
  assert.deepEqual(properties, ["state", "model", "questions"]);
});

test("general request, fallback/override model and complete response are preserved", async () => {
  for (const override of [undefined, "jev-preview", "jev-1.13.0"]) {
    let calls = 0;
    const raw = {
      ...response,
      provider_metadata: { synthetic: true },
      usage: { ...response.usage, provider_extra: 7 },
    };
    const client = createJevClient(
      "jev-latest",
      async () => "synthetic-api-key",
      async (url, options) => {
        calls++;
        assert.equal(url, "https://api.typesafe.ai/v1/systemone");
        assert.equal(options?.method, "POST");
        assert.equal(options?.redirect, "error");
        assert.ok(options?.signal);
        assert.deepEqual(JSON.parse(String(options?.body)), {
          ...request,
          model: override ?? "jev-latest",
        });
        assert.equal(
          (options?.headers as Record<string, string>).Authorization,
          "Bearer synthetic-api-key",
        );
        return Response.json(raw);
      },
    );
    const result = await client.evaluate({
      ...request,
      ...(override ? { model: override } : {}),
    });
    assert.deepEqual(result, raw);
    assert.ok(result !== null && typeof result === "object");
    assert.ok(!Object.hasOwn(result, "reviewRequired"));
    assert.ok(!Object.hasOwn(result, "automaticSubmissionEligible"));
    assert.equal(calls, 1);
  }
});

test("Score legends preserve structured levels and provider object key order", async () => {
  const raw = copy();
  raw.answers.severity.legend["1"] = {
    examples: ["Damage"],
    level: "Medium",
  };
  const client = createJevClient(
    "jev-latest",
    async () => "synthetic",
    async () => Response.json(raw),
  );
  assert.deepEqual(await client.evaluate(request), raw);
});

test("outbound JSON normalizes negative zero without mutating caller input", async () => {
  const criteria = [{ value: -0 }, { value: 1 }];
  const raw = {
    model: "jev-1.13.0",
    answers: {
      level: {
        type: "score",
        score: 0.75,
        confidence: 0.5,
        probabilities: { "0": 0.25, "1": 0.75 },
        legend: { "0": { value: 0 }, "1": { value: 1 } },
      },
    },
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  const client = createJevClient(
    "jev-latest",
    async () => "synthetic",
    async (_url, options) => {
      const sent = JSON.parse(String(options?.body));
      assert.equal(Object.is(sent.questions.level.criteria[0].value, 0), true);
      assert.deepEqual(sent.questions.level.criteria, [
        { value: 0 },
        { value: 1 },
      ]);
      return Response.json(raw);
    },
  );
  assert.deepEqual(
    await client.evaluate({
      state: "Synthetic report",
      questions: { level: { type: "score", instructions: "Rate", criteria } },
    }),
    raw,
  );
  assert.equal(Object.is(criteria[0].value, -0), true);
});

test("Score legends preserve swapped strings, reordered arrays and altered nested levels", async () => {
  const cases = [
    {
      criteria: ["Low", "High"],
      legend: { "0": "High", "1": "Low" },
    },
    {
      criteria: [{ level: "Low" }, { level: "High" }],
      legend: { "0": { level: "High" }, "1": { level: "Low" } },
    },
    {
      criteria: ["Low", ["High", "No workaround"]],
      legend: { "0": "Low", "1": ["No workaround", "High"] },
    },
    {
      criteria: ["Low", { level: "High", examples: ["Blocked"] }],
      legend: { "0": "Low", "1": { level: "High", examples: ["Altered"] } },
    },
    { criteria: ["Low", "High"], legend: { "0": "Low", "1": null } },
  ];
  for (const { criteria, legend } of cases) {
    const client = createJevClient(
      "jev-latest",
      async () => "synthetic",
      async () =>
        Response.json({
          model: "jev-1.13.0",
          answers: {
            severity: {
              type: "score",
              score: 0.75,
              confidence: 0.5,
              probabilities: { "0": 0.25, "1": 0.75 },
              legend,
            },
          },
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
    );
    const result = await client.evaluate({
      state: "Synthetic report",
      questions: {
        severity: {
          type: "score",
          instructions: "Rate severity",
          criteria,
        },
      },
    });
    assert.deepEqual(result, {
      model: "jev-1.13.0",
      answers: {
        severity: {
          type: "score",
          score: 0.75,
          confidence: 0.5,
          probabilities: { "0": 0.25, "1": 0.75 },
          legend,
        },
      },
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  }
});

test("provider request metadata cannot be supplied as URL, credentials or arbitrary headers", () => {
  for (const extra of [
    { url: "https://evil.example" },
    { headers: { Authorization: "synthetic" } },
    { apiKey: "synthetic" },
    { method: "DELETE" },
    { allowAutomaticSubmission: true },
  ])
    assert.equal(
      inputSchema.safeParse({ ...request, ...extra }).success,
      false,
    );
});

test("question/option limits and actual typed decision schemas are enforced", () => {
  const choice = {
    type: "choice",
    instructions: "choose",
    criteria: { a: "A" },
  };
  const valid = {
    state: "x",
    questions: Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`q${i}`, choice]),
    ),
  };
  assert.equal(inputSchema.safeParse(valid).success, true);
  const options = Object.fromEntries(
    Array.from({ length: 255 }, (_, i) => [`Option ${i}`, null]),
  );
  assert.equal(
    inputSchema.safeParse({
      state: "x",
      questions: { q: { ...choice, criteria: options } },
    }).success,
    true,
  );
  const invalid = [
    { state: null, questions: { q: choice } },
    { state: true, questions: { q: choice } },
    { state: 123, questions: { q: choice } },
    { state: "x", questions: {} },
    { ...valid, questions: { ...valid.questions, extra: choice } },
    { state: "x", questions: { q: { ...choice, criteria: {} } } },
    {
      state: "x",
      questions: { q: { ...choice, criteria: { ...options, extra: null } } },
    },
    { state: "x", questions: { q: { ...choice, criteria: { a: 1 } } } },
    { state: "x", questions: { q: { ...choice, instructions: null } } },
    {
      state: "x",
      questions: {
        q: { type: "score", instructions: "rate", criteria: ["One"] },
      },
    },
    {
      state: "x",
      questions: {
        q: {
          type: "score",
          instructions: "rate",
          criteria: Array(11).fill("Level"),
        },
      },
    },
    {
      state: "x",
      questions: {
        q: {
          type: "noul",
          instructions: "yes?",
          criteria: { other: "Not supported" },
        },
      },
    },
    { state: "x", questions: { q: { type: "boolean", instructions: "yes?" } } },
    { ...request, model: "" },
    { ...request, model: "x".repeat(101) },
    { state: "x", questions: { q: { ...choice, temperature: 1 } } },
  ];
  for (const input of invalid)
    assert.equal(inputSchema.safeParse(input).success, false);
  for (const count of [2, 10])
    assert.equal(
      inputSchema.safeParse({
        state: "x",
        questions: {
          q: {
            type: "score",
            instructions: "rate",
            criteria: Array(count).fill("Level"),
          },
        },
      }).success,
      true,
    );
});

test("untrusted JSON depth/nodes, unsafe map keys and non-JSON values are rejected safely", () => {
  let deep: unknown = "leaf";
  for (let i = 0; i < 1000; i++) deep = { inner: deep };
  for (const state of [
    deep,
    Array(20001).fill(null),
    { notJson: undefined },
    { notJson: Infinity },
    { function: () => {} },
  ])
    assert.equal(inputSchema.safeParse({ ...request, state }).success, false);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.equal(
    inputSchema.safeParse({ ...request, state: cycle }).success,
    false,
  );
  for (const mapKey of ["__proto__", "constructor", "prototype"]) {
    assert.equal(
      inputSchema.safeParse({
        state: "x",
        questions: JSON.parse(
          `{"${mapKey}":{"type":"noul","instructions":"yes?"}}`,
        ),
      }).success,
      false,
    );
  }
  // These keys are harmless content inside state, not question/option map keys.
  const prototypeNamedContent = {
    ...request,
    state: JSON.parse('{"__proto__":{"text":"data"}}'),
  };
  assert.deepEqual(
    inputSchema.parse(prototypeNamedContent),
    prototypeNamedContent,
  );
});

test("invalid client input and oversized state do not read secrets or incur inference", async () => {
  let reads = 0;
  let calls = 0;
  const client = createJevClient(
    "jev-latest",
    async () => {
      reads++;
      return "synthetic";
    },
    async () => {
      calls++;
      return Response.json(response);
    },
  );
  await assert.rejects(
    () => client.evaluate({ ...request, state: "x".repeat(MAX_REQUEST_BYTES) }),
    /Inference unavailable/,
  );
  await assert.rejects(
    () => client.evaluate({ ...request, questions: {} }),
    /Inference unavailable/,
  );
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test("provider semantics pass through without repairing answers, probabilities, confidence or usage", async () => {
  const outputs: unknown[] = [];
  let r = copy();
  delete (r.answers as Partial<typeof r.answers>).urgent;
  outputs.push(r);
  r = copy();
  r.answers["Which team?"].choice = "Missing option";
  outputs.push(r);
  r = copy();
  r.answers["Which team?"].probabilities.Other = 0.5;
  outputs.push(r);
  r = copy();
  r.answers["Which team?"].probabilities = {
    "Customer Support": 1,
  } as (typeof r.answers)["Which team?"]["probabilities"];
  outputs.push(r);
  r = copy();
  r.answers["Which team?"].confidence = 1.1;
  outputs.push(r);
  r = copy();
  r.answers["Which team?"].probabilities = {
    "Customer Support": 0.1,
    Other: 0.9,
  };
  outputs.push(r);
  r = copy();
  r.answers.severity.score = 1.9;
  outputs.push(r);
  r = copy();
  r.answers.severity.legend = {
    "0": "Low",
  } as typeof r.answers.severity.legend;
  outputs.push(r);
  r = copy();
  r.answers.severity.probabilities["0"] = -0.1;
  outputs.push(r);
  r = copy();
  r.answers.urgent.noul = 2;
  outputs.push(r);
  r = copy();
  r.usage.input_tokens = -1;
  outputs.push(r);
  outputs.push({ ...response, usage: undefined });
  outputs.push({
    ...response,
    answers: {
      ...response.answers,
      urgent: {
        type: "score",
        score: 0,
        confidence: 1,
        legend: { "0": "No" },
        probabilities: { "0": 1 },
      },
    },
  });
  outputs.push({
    ...response,
    answers: { ...response.answers, extra: { type: "noul", noul: 0 } },
  });
  r = copy();
  r.answers["Which team?"].probabilities.Other = 0.055;
  outputs.push(r); // Rounded distribution sums to 1.005, beyond the old tolerance.
  outputs.push({ answers: { partial: { confidence: "uncertain" } }, extra: true });
  outputs.push({ answers: { partial: { type: "new-primitive", value: "raw" } } });
  outputs.push({});
  for (const raw of outputs) {
    const client = createJevClient(
      "jev-latest",
      async () => "synthetic",
      async () => Response.json(raw),
    );
    assert.deepEqual(
      await client.evaluate(request),
      JSON.parse(JSON.stringify(raw)),
    );
  }
});

test("zero retries, deadline, response byte cap and sanitized failures remain in place", async () => {
  for (const upstream of [
    () => new Response("private provider error", { status: 429 }),
    () => new Response("private provider error", { status: 529 }),
    () => new Response("invalid json", { status: 200 }),
    () => new Response("x".repeat(MAX_RESPONSE_BYTES + 1)),
    () => {
      throw new DOMException("private context", "TimeoutError");
    },
  ]) {
    let calls = 0;
    const client = createJevClient(
      "jev-latest",
      async () => "synthetic",
      async (_url, options) => {
        calls++;
        assert.ok(options?.signal);
        return upstream();
      },
    );
    await assert.rejects(
      () => client.evaluate(request),
      /^Error: Inference unavailable$/,
    );
    assert.equal(calls, 1);
  }
  let calls = 0;
  const client = createJevClient(
    "jev-latest",
    async () => {
      throw new Error("private secret");
    },
    async () => {
      calls++;
      return Response.json(response);
    },
  );
  await assert.rejects(
    () => client.evaluate(request),
    /^Error: Inference unavailable$/,
  );
  assert.equal(calls, 0);
});

test("nonstandard top-level JSON is preserved without claiming typed answers", async () => {
  for (const raw of [
    null,
    true,
    42,
    "provider text",
    [response, { partial: true }],
  ]) {
    const client = createJevClient(
      "jev-latest",
      async () => "synthetic",
      async () => Response.json(raw),
    );
    assert.deepEqual(await client.evaluate(request), raw);
  }
});

test("malformed successful provider content remains available without JSON repair", async () => {
  for (const raw of [
    '{"answers": {"team": "Support",}}',
    "plain provider output",
    "",
  ]) {
    let calls = 0;
    const client = createJevClient(
      "jev-latest",
      async () => "synthetic",
      async () => {
        calls++;
        return new Response(raw, { headers: { "x-request-id": "req_opaque_42" } });
      },
    );
    await assert.rejects(() => client.evaluate(request), (error: unknown) => {
      assert.ok(error instanceof ProviderContentError);
      assert.equal(error.providerText, raw);
      assert.deepEqual(error.diagnostic, {
        category: "response_json",
        upstreamStatus: 200,
        upstreamRequestId: "req_opaque_42",
      });
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("JSON beyond serialization limits remains raw instead of being truncated or normalized", async () => {
  let deep: unknown = "leaf";
  for (let i = 0; i < 40; i++) deep = { inner: deep };
  for (const raw of [
    JSON.stringify(deep),
    JSON.stringify(Array(20001).fill(null)),
    '{"probability":1e999}',
  ]) {
    const client = createJevClient(
      "jev-latest",
      async () => "synthetic",
      async () => new Response(raw),
    );
    await assert.rejects(() => client.evaluate(request), (error: unknown) => {
      assert.ok(error instanceof ProviderContentError);
      assert.equal(error.providerText, raw);
      assert.equal(error.diagnostic.category, "response_validation");
      assert.equal(error.diagnostic.validationReason, "response_content");
      assert.equal(error.diagnostic.upstreamStatus, 200);
      return true;
    });
  }
});
