import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  createJevClient,
  MAX_RESPONSE_BYTES,
  type JevRequest,
} from "../src/jev.js";
import {
  InferenceError,
  inferenceCategories,
  safeDiagnostic,
  validationReasons,
} from "../src/diagnostics.js";
import { createHandler } from "../src/server.js";
import type { AuthConfig } from "../src/auth.js";

const request: JevRequest = {
  state: "synthetic state",
  questions: {
    team: {
      type: "choice",
      instructions: "Choose a team",
      criteria: { Support: null, Other: null },
    },
  },
};
const answer = {
  model: "jev-synthetic",
  answers: {
    team: {
      type: "choice",
      choice: "Support",
      confidence: 0.8,
      probabilities: { Support: 0.8, Other: 0.2 },
    },
  },
  usage: { input_tokens: 10, output_tokens: 5 },
};
const config: AuthConfig = {
  issuer: "https://issuer.example/",
  resource: "https://mcp.example/mcp",
  subjects: ["member"],
  origins: [],
};
function event(body: unknown): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "POST /mcp",
    rawPath: "/mcp",
    rawQueryString: "",
    headers: {
      authorization: "Bearer test",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    requestContext: {
      accountId: "test",
      apiId: "test",
      domainName: "mcp.example",
      domainPrefix: "mcp",
      requestId: "api_request_123",
      routeKey: "POST /mcp",
      stage: "$default",
      time: "",
      timeEpoch: 0,
      http: {
        method: "POST",
        path: "/mcp",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "test",
      },
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}
const call = {
  jsonrpc: "2.0",
  id: "rpc-id-must-not-be-logged",
  method: "tools/call",
  params: { name: "evaluate_state", arguments: request },
};
const responseBody = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200 });

async function diagnosticFrom(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof InferenceError);
    return error.diagnostic;
  }
  assert.fail("expected inference failure");
}

test("upstream HTTP errors expose only fixed category, validated status and safe opaque ID", async () => {
  for (const status of [429, 422, 529]) {
    let attempts = 0;
    const client = createJevClient(
      "jev-latest",
      async () => "synthetic-secret",
      async () => {
        attempts++;
        return new Response("provider body with PRIVATE_TRANSACTION", {
          status,
          headers: { "x-request-id": "req_opaque_42" },
        });
      },
    );
    assert.deepEqual(await diagnosticFrom(() => client.evaluate(request)), {
      category: "upstream_http",
      upstreamStatus: status,
      upstreamRequestId: "req_opaque_42",
    });
    assert.equal(attempts, 1);
  }
});

test("response parsing and resource failures retain safe fixed diagnostics", async () => {
  let deep: unknown = "leaf";
  for (let i = 0; i < 40; i++) deep = { inner: deep };
  const cases: Array<[Response, string, string?]> = [
    [
      new Response("provider PRIVATE_TRANSACTION", { status: 200 }),
      "response_json",
    ],
    [responseBody(deep), "response_validation", "response_content"],
    [new Response(null, { status: 204 }), "response_json"],
  ];
  for (const [response, category, validationReason] of cases) {
    const client = createJevClient(
      "jev-latest",
      async () => "key",
      async () => response,
    );
    const diagnostic = await diagnosticFrom(() => client.evaluate(request));
    assert.equal(diagnostic.category, category);
    assert.equal(diagnostic.validationReason, validationReason);
    assert.equal(diagnostic.upstreamStatus, response.status);
  }
});

test("deadline, network and credential failures are classified without error text", async () => {
  const timeout = createJevClient(
    "jev-latest",
    async () => "key",
    async () => {
      throw new DOMException(
        "PRIVATE_TRANSACTION timeout detail",
        "TimeoutError",
      );
    },
  );
  assert.deepEqual(await diagnosticFrom(() => timeout.evaluate(request)), {
    category: "timeout",
  });

  const network = createJevClient(
    "jev-latest",
    async () => "key",
    async () => {
      throw new Error("PRIVATE_TRANSACTION network detail");
    },
  );
  assert.deepEqual(await diagnosticFrom(() => network.evaluate(request)), {
    category: "network",
  });

  const credentials = createJevClient(
    "jev-latest",
    async () => {
      throw new Error("SECRET_VALUE and PRIVATE_TRANSACTION");
    },
    async () => responseBody(answer),
  );
  assert.deepEqual(await diagnosticFrom(() => credentials.evaluate(request)), {
    category: "credentials",
  });

  const invalid = createJevClient(
    "jev-latest",
    async () => "key",
    async () => responseBody(answer),
  );
  const requestFailure = await diagnosticFrom(() =>
    invalid.evaluate({
      state: "state",
      questions: {},
    } as unknown as JevRequest),
  );
  assert.deepEqual(requestFailure, {
    category: "request_validation",
    validationReason: "request_schema",
  });
});

test("reader timeout and network errors retain status and do not retry", async () => {
  for (const [failure, category] of [
    [new DOMException("PRIVATE_TRANSACTION", "TimeoutError"), "timeout"],
    [new Error("PRIVATE_TRANSACTION"), "network"],
  ] as const) {
    let attempts = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure);
      },
    });
    const client = createJevClient(
      "jev-latest",
      async () => "key",
      async () => {
        attempts++;
        return new Response(body, { status: 200 });
      },
    );
    const diagnostic = await diagnosticFrom(() => client.evaluate(request));
    assert.equal(diagnostic.category, category);
    assert.equal(diagnostic.upstreamStatus, 200);
    assert.equal(attempts, 1);
  }
});

test("oversized provider bodies receive the fixed response_size category", async () => {
  const client = createJevClient(
    "jev-latest",
    async () => "key",
    async () => new Response("x".repeat(MAX_RESPONSE_BYTES + 1)),
  );
  const diagnostic = await diagnosticFrom(() => client.evaluate(request));
  assert.equal(diagnostic.category, "response_size");
  assert.equal(diagnostic.upstreamStatus, 200);
});

test("MCP returns safe diagnostics and emits one allowlisted failure record", async () => {
  const logs: Record<string, string | number>[] = [];
  const client = createJevClient(
    "jev-latest",
    async () => "synthetic-secret",
    async () =>
      new Response("PRIVATE_TRANSACTION SECRET_VALUE provider text", {
        status: 429,
        headers: { "x-request-id": "req_opaque_42" },
      }),
  );
  const handler = createHandler(
    config,
    async () => {},
    client,
    undefined,
    (entry) => logs.push(entry),
  );
  const result = await handler(event(call), {
    lambdaRequestId: "lambda_request_456",
  });
  const body = JSON.parse(result.body!);
  assert.equal(result.statusCode, 200);
  assert.equal(body.result.isError, true);
  assert.equal(
    body.result.content[0].text,
    "Inference unavailable. No results produced.",
  );
  assert.deepEqual(body.result.structuredContent.diagnostic, {
    diagnosticId: body.result.structuredContent.diagnostic.diagnosticId,
    category: "upstream_http",
    upstreamStatus: 429,
    upstreamRequestId: "req_opaque_42",
    apiGatewayRequestId: "api_request_123",
    lambdaRequestId: "lambda_request_456",
  });
  assert.match(
    body.result.structuredContent.diagnostic.diagnosticId,
    /^[0-9a-f-]{36}$/i,
  );
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0], {
    event: "inference_failure",
    diagnosticId: body.result.structuredContent.diagnostic.diagnosticId,
    category: "upstream_http",
    upstreamStatus: 429,
    upstreamRequestId: "req_opaque_42",
    apiGatewayRequestId: "api_request_123",
    lambdaRequestId: "lambda_request_456",
  });
  const serialized = JSON.stringify({ body, logs });
  for (const sentinel of [
    "PRIVATE_TRANSACTION",
    "SECRET_VALUE",
    "synthetic-secret",
  ])
    assert.equal(serialized.includes(sentinel), false);
  assert.equal(
    JSON.stringify(logs).includes("rpc-id-must-not-be-logged"),
    false,
  );
});

test("malicious header IDs, unknown errors and sink failures stay safe", async () => {
  const maliciousProvider = createJevClient(
    "jev-latest",
    async () => "SECRET_VALUE",
    async () =>
      new Response("SECRET_VALUE PRIVATE_TRANSACTION", {
        status: 422,
        headers: { "x-request-id": "PRIVATE_TRANSACTION SECRET_VALUE" },
      }),
  );
  const handler = createHandler(
    config,
    async () => {},
    maliciousProvider,
    undefined,
    () => {
      throw new Error("SECRET_VALUE");
    },
  );
  const result = await handler(event(call));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("PRIVATE_TRANSACTION"), false);
  assert.equal(serialized.includes("SECRET_VALUE"), false);
  assert.equal(
    JSON.parse(result.body!).result.structuredContent.diagnostic
      .upstreamRequestId,
    undefined,
  );

  const unknown = createHandler(config, async () => {}, {
    model: "x",
    evaluate: async () => {
      throw new Error("SECRET_VALUE");
    },
  });
  const unknownResult = await unknown(event(call));
  assert.equal(
    JSON.parse(unknownResult.body!).result.structuredContent.diagnostic
      .category,
    "internal",
  );
  assert.equal(JSON.stringify(unknownResult).includes("SECRET_VALUE"), false);

  const forged = new InferenceError({ category: "internal" });
  (forged as unknown as { diagnostic: unknown }).diagnostic = {
    category: "SECRET_VALUE",
    validationReason: "PRIVATE_TRANSACTION",
    upstreamStatus: 700,
    upstreamRequestId: "PRIVATE_TRANSACTION",
    callerContent: "SECRET_VALUE",
  };
  const forgedLogs: unknown[] = [];
  const forgedHandler = createHandler(
    config,
    async () => {},
    {
      model: "x",
      evaluate: async () => {
        throw forged;
      },
    },
    undefined,
    (entry) => forgedLogs.push(entry),
  );
  const forgedResult = await forgedHandler(event(call));
  const forgedSerialized = JSON.stringify({
    result: forgedResult,
    logs: forgedLogs,
  });
  assert.equal(
    JSON.parse(forgedResult.body!).result.structuredContent.diagnostic.category,
    "internal",
  );
  assert.equal(forgedSerialized.includes("SECRET_VALUE"), false);
  assert.equal(forgedSerialized.includes("PRIVATE_TRANSACTION"), false);
});

test("provider request IDs containing the API credential are omitted from MCP and logs", async () => {
  const credential = "123e4567-e89b-42d3-a456-426614174000";
  const client = createJevClient(
    "jev-latest",
    async () => credential,
    async () =>
      new Response("provider detail", {
        status: 429,
        headers: { "x-request-id": `req_${credential}` },
      }),
  );
  const logs: Record<string, string | number>[] = [];
  const handler = createHandler(
    config,
    async () => {},
    client,
    undefined,
    (entry) => logs.push(entry),
  );
  const result = await handler(event(call));
  const serialized = JSON.stringify({ result, logs });
  assert.equal(serialized.includes(credential), false);
  assert.equal(
    JSON.parse(result.body!).result.structuredContent.diagnostic
      .upstreamRequestId,
    undefined,
  );
  assert.equal(logs[0].upstreamRequestId, undefined);
});

test("diagnostic and AWS request metadata getters are read once before validation", async () => {
  const forged = new InferenceError({ category: "internal" });
  const readCounts = {
    category: 0,
    reason: 0,
    upstreamId: 0,
    apiRequestId: 0,
    lambdaRequestId: 0,
  };
  const metadata = {
    get category() {
      return ++readCounts.category === 1 ? "upstream_http" : "SECRET_VALUE";
    },
    get validationReason() {
      return ++readCounts.reason === 1 ? "answer_id" : "SECRET_VALUE";
    },
    upstreamStatus: 429,
    get upstreamRequestId() {
      return ++readCounts.upstreamId === 1 ? "req_opaque_42" : "SECRET_VALUE";
    },
  };
  (forged as unknown as { diagnostic: unknown }).diagnostic = metadata;
  const logs: Record<string, string | number>[] = [];
  const handler = createHandler(
    config,
    async () => {},
    {
      model: "x",
      evaluate: async () => {
        throw forged;
      },
    },
    undefined,
    (entry) => logs.push(entry),
  );
  const request = event(call);
  Object.defineProperty(request.requestContext, "requestId", {
    configurable: true,
    get() {
      return ++readCounts.apiRequestId === 1 ? "apiSafe_123" : "SECRET_VALUE";
    },
  });
  const context = {
    get lambdaRequestId() {
      return ++readCounts.lambdaRequestId === 1
        ? "lambdaSafe_456"
        : "SECRET_VALUE";
    },
  };
  const result = await handler(request, context);
  const response = JSON.parse(result.body!).result.structuredContent.diagnostic;
  assert.equal(response.category, "upstream_http");
  assert.equal(response.validationReason, "answer_id");
  assert.equal(response.upstreamRequestId, "req_opaque_42");
  assert.equal(response.apiGatewayRequestId, "apiSafe_123");
  assert.equal(response.lambdaRequestId, "lambdaSafe_456");
  assert.equal(
    JSON.stringify({ result, logs }).includes("SECRET_VALUE"),
    false,
  );
  assert.deepEqual(readCounts, {
    category: 1,
    reason: 1,
    upstreamId: 1,
    apiRequestId: 1,
    lambdaRequestId: 1,
  });
});

test("runtime diagnostic allowlists are immutable and reject forged enum labels", () => {
  assert.equal(Object.isFrozen(inferenceCategories), true);
  assert.equal(Object.isFrozen(validationReasons), true);
  assert.throws(() =>
    (inferenceCategories as unknown as string[]).push("SECRET_VALUE"),
  );
  assert.throws(() =>
    (validationReasons as unknown as string[]).push("SECRET_VALUE"),
  );
  const forged = new InferenceError({ category: "internal" });
  (forged as unknown as { diagnostic: unknown }).diagnostic = {
    category: "SECRET_VALUE",
    validationReason: "SECRET_VALUE",
  };
  assert.deepEqual(safeDiagnostic(forged), { category: "internal" });
});

test("successful inference response remains unchanged and produces no diagnostic log", async () => {
  const logs: unknown[] = [];
  const raw = { ...answer, provider_metadata: { retained: true } };
  const client = createJevClient(
    "jev-latest",
    async () => "key",
    async () => responseBody(raw),
  );
  const handler = createHandler(
    config,
    async () => {},
    client,
    undefined,
    (entry) => logs.push(entry),
  );
  const result = await handler(event(call));
  const body = JSON.parse(result.body!);
  assert.equal(body.result.isError, false);
  assert.deepEqual(body.result.structuredContent, raw);
  assert.deepEqual(JSON.parse(body.result.content[0].text), raw);
  assert.deepEqual(logs, []);
});

test("nonstandard JSON succeeds unchanged without semantic diagnostic logs", async () => {
  for (const raw of [
    { model: "jev-synthetic", answers: {}, usage: {} },
    {
      ...answer,
      answers: {
        team: { ...answer.answers.team, probabilities: { Support: 0.1 } },
      },
    },
    {
      ...answer,
      answers: { team: { ...answer.answers.team, choice: "Other" } },
    },
    { answers: { team: { choice: "unknown", provider_note: "retained" } } },
  ]) {
    const logs: unknown[] = [];
    const handler = createHandler(
      config,
      async () => {},
      createJevClient(
        "jev-latest",
        async () => "key",
        async () => responseBody(raw),
      ),
      undefined,
      (entry) => logs.push(entry),
    );
    const result = JSON.parse((await handler(event(call))).body!).result;
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, raw);
    assert.deepEqual(JSON.parse(result.content[0].text), raw);
    assert.deepEqual(logs, []);
  }
});

test("MCP labels malformed HTTP-200 output as raw text and logs only safe diagnostics", async () => {
  for (const resourceLimited of [false, true]) {
    const raw = resourceLimited
      ? JSON.stringify({ values: Array(20001).fill("PRIVATE_PROVIDER_CONTENT") })
      : '{"answers":{"team":"PRIVATE_PROVIDER_CONTENT",}}';
    const logs: Record<string, string | number>[] = [];
    const handler = createHandler(
      config,
      async () => {},
      createJevClient(
        "jev-latest",
        async () => "key",
        async () => new Response(raw, {
          headers: { "x-request-id": "req_opaque_42" },
        }),
      ),
      undefined,
      (entry) => logs.push(entry),
    );
    const response = await handler(event(call), {
      lambdaRequestId: "lambda_request_456",
    });
    const result = JSON.parse(response.body!).result;
    assert.equal(result.isError, true);
    assert.match(
      result.content[0].text,
      /Raw provider response follows; no typed result is asserted/,
    );
    assert.equal(result.content[1].text, raw);
    assert.deepEqual(Object.keys(result.structuredContent), ["diagnostic"]);
    const diagnostic = result.structuredContent.diagnostic;
    assert.equal(
      diagnostic.category,
      resourceLimited ? "response_validation" : "response_json",
    );
    assert.equal(diagnostic.upstreamStatus, 200);
    assert.equal(diagnostic.upstreamRequestId, "req_opaque_42");
    assert.equal(diagnostic.apiGatewayRequestId, "api_request_123");
    assert.equal(diagnostic.lambdaRequestId, "lambda_request_456");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].diagnosticId, diagnostic.diagnosticId);
    assert.equal(logs[0].category, diagnostic.category);
    assert.equal(JSON.stringify(logs).includes("PRIVATE_PROVIDER_CONTENT"), false);
    assert.equal(JSON.stringify(logs).includes("rpc-id-must-not-be-logged"), false);
  }
});
