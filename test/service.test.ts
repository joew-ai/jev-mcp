import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createHandler } from "../src/server.js";
import { createVerifier, type AuthConfig } from "../src/auth.js";
import {
  MAX_REQUEST_BYTES,
  type JevClient,
  type JevRequest,
  type JevResponse,
} from "../src/jev.js";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";

const config: AuthConfig = {
  issuer: "https://issuer.example/",
  resource: "https://mcp.example/mcp",
  subjects: ["member"],
  origins: ["https://chatgpt.com"],
};
export const input: JevRequest = {
  state: {
    message: "Synthetic support request",
    context: ["Caller-owned background"],
  },
  questions: {
    department: {
      type: "choice",
      instructions: "Which department?",
      criteria: {
        "Customer Support": "Help requests",
        "Other / unknown": null,
      },
    },
  },
};
export const answer: JevResponse = {
  model: "jev-synthetic",
  answers: {
    department: {
      type: "choice",
      choice: "Customer Support",
      confidence: 0.75,
      probabilities: { "Customer Support": 0.9, "Other / unknown": 0.1 },
    },
  },
  usage: { input_tokens: 123, output_tokens: 45 },
};
const client: JevClient = { model: "jev-latest", evaluate: async () => answer };
function event(
  body: unknown,
  headers: Record<string, string> = {},
  method = "POST",
  path = "/mcp",
): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "ANY /mcp",
    rawQueryString: "",
    rawPath: path,
    headers: {
      authorization: "Bearer test",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    requestContext: {
      accountId: "test",
      apiId: "test",
      domainName: "mcp.example",
      domainPrefix: "mcp",
      requestId: "test",
      routeKey: "ANY /mcp",
      stage: "$default",
      time: "",
      timeEpoch: 0,
      http: {
        method,
        path,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "test",
      },
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}
const rpc = (method: string, params?: unknown) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params,
});
const body = (r: { body?: string }) => JSON.parse(r.body!);
const handler = createHandler(
  config,
  async (token) => {
    if (token !== "test") throw new Error();
  },
  client,
);

test("initialize, discovery and call advertise a single general tool and preserve the response", async () => {
  const init = body(
    await handler(
      event(
        rpc("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        }),
      ),
    ),
  );
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.version, "0.3.0");
  const tools = body(await handler(event(rpc("tools/list")))).result.tools;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "evaluate_state");
  assert.deepEqual(tools[0].inputSchema.required.sort(), [
    "questions",
    "state",
  ]);
  assert.equal(tools[0].inputSchema.properties.questions.maxProperties, 20);
  assert.deepEqual(
    tools[0].inputSchema.properties.state.anyOf.map(
      (shape: { type: string }) => shape.type,
    ),
    ["string", "object", "array"],
  );
  assert.deepEqual(Object.keys(tools[0].inputSchema.properties).sort(), [
    "model",
    "questions",
    "state",
  ]);
  const result = body(
    await handler(
      event(rpc("tools/call", { name: "evaluate_state", arguments: input })),
    ),
  );
  assert.deepEqual(result.result.structuredContent, answer);
  assert.deepEqual(JSON.parse(result.result.content[0].text), answer);
  assert.equal(result.result.isError, false);
  assert.deepEqual(body(await handler(event(rpc("ping")))).result, {});
  assert.equal(
    (
      await handler(
        event({ jsonrpc: "2.0", method: "notifications/initialized" }),
      )
    ).statusCode,
    202,
  );
});

test("all MCP methods require auth; only path-specific resource metadata is public", async () => {
  for (const method of ["initialize", "tools/list", "tools/call"]) {
    const r = await handler(event(rpc(method), { authorization: "" }));
    assert.equal(r.statusCode, 401);
    assert.match(String(r.headers?.["www-authenticate"]), /resource_metadata=/);
  }
  const r = await handler(
    event(
      null,
      { authorization: "", origin: "https://browser.example" },
      "GET",
      "/.well-known/oauth-protected-resource/mcp",
    ),
  );
  assert.equal(body(r).resource, config.resource);
  assert.equal(
    (
      await handler(
        event(null, {}, "GET", "/.well-known/oauth-protected-resource"),
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await handler(
        event(rpc("tools/list"), { origin: "https://evil.example" }),
      )
    ).statusCode,
    403,
  );
});

test("invalid transports, schemas, notifications and old finance calls never reach inference", async () => {
  let calls = 0;
  const h = createHandler(config, async () => {}, {
    model: "mock",
    evaluate: async () => {
      calls++;
      return answer;
    },
  });
  for (const [request, status] of [
    [event(rpc("ping"), {}, "GET"), 405],
    [event(rpc("ping"), { "mcp-protocol-version": "bad" }), 400],
    [event(rpc("ping"), { accept: "application/json" }), 406],
    [event(rpc("ping"), { "content-type": "text/plain" }), 415],
    [event([]), 400],
    [
      event({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "evaluate_state", arguments: input },
      }),
      400,
    ],
    [{ ...event(null), body: "{" }, 400],
    [{ ...event(null), body: "x".repeat(MAX_REQUEST_BYTES + 1) }, 413],
  ] as const)
    assert.equal((await h(request)).statusCode, status);
  for (const request of [
    rpc("unknown"),
    rpc("initialize", {}),
    rpc("tools/call", {
      name: "suggest_transaction_categories",
      arguments: { transactions: [], categories: [] },
    }),
    rpc("tools/call", {
      name: "evaluate_state",
      arguments: { ...input, allowAutomaticSubmission: true },
    }),
    rpc("tools/call", {
      name: "evaluate_state",
      arguments: { state: "x", questions: {} },
    }),
  ])
    assert.ok(body(await h(event(request))).error);
  assert.equal(calls, 0);
});

test("larger general state and exact request-byte bounds work in raw and base64 form", async () => {
  const larger = { ...input, state: "界".repeat(30000) };
  assert.equal(
    body(
      await handler(
        event(rpc("tools/call", { name: "evaluate_state", arguments: larger })),
      ),
    ).result.isError,
    false,
  );
  const ping = event(rpc("ping"));
  const exact =
    ping.body! + " ".repeat(MAX_REQUEST_BYTES - Buffer.byteLength(ping.body!));
  for (const isBase64Encoded of [false, true]) {
    const body = isBase64Encoded
      ? Buffer.from(exact).toString("base64")
      : exact;
    assert.equal(
      (await handler({ ...ping, body, isBase64Encoded })).statusCode,
      200,
    );
    const oversized = exact + "x";
    assert.equal(
      (
        await handler({
          ...ping,
          body: isBase64Encoded
            ? Buffer.from(oversized).toString("base64")
            : oversized,
          isBase64Encoded,
        })
      ).statusCode,
      413,
    );
  }
});

test("upstream errors are generic MCP tool errors, without input or token leakage", async () => {
  const h = createHandler(config, async () => {}, {
    model: "mock",
    evaluate: async () => {
      throw new Error("private token and private state");
    },
  });
  const r = body(
    await h(
      event(rpc("tools/call", { name: "evaluate_state", arguments: input })),
    ),
  );
  assert.equal(r.result.isError, true);
  assert.ok(!JSON.stringify(r).includes("private"));
  assert.equal(r.result.structuredContent.diagnostic.category, "internal");
});

test("signed-token expiry, issuer, audience, scope and membership remain enforced before inference", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const verify = createVerifier(
    config,
    createLocalJWKSet({ keys: [{ ...jwk, kid: "test", alg: "RS256" }] }),
  );
  let calls = 0;
  const h = createHandler(config, verify, {
    model: "mock",
    evaluate: async () => {
      calls++;
      return answer;
    },
  });
  async function token(overrides: Record<string, unknown> = {}) {
    return new SignJWT({
      iss: config.issuer,
      aud: config.resource,
      sub: "member",
      scope: "transactions:suggest",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...overrides,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .sign(privateKey);
  }
  const cases: [string, number, boolean][] = [
    ["", 401, false],
    ["invalid", 401, false],
    [await token({ exp: 1 }), 401, false],
    [await token({ iss: "https://evil/" }), 401, false],
    [await token({ aud: "wrong" }), 401, false],
    [await token({ exp: undefined }), 401, false],
    [await token({ nbf: Math.floor(Date.now() / 1000) + 500 }), 401, false],
    [await token({ token_use: "id" }), 401, false],
    [await token({ scope: "openid" }), 403, true],
    [await token({ scope: undefined }), 403, true],
    [await token({ scope: "transactions:suggest:extra" }), 403, true],
    [await token({ sub: "outsider" }), 403, false],
  ];
  for (const [credential, status, insufficientScope] of cases) {
    for (const method of ["initialize", "tools/list", "tools/call"]) {
      const r = await h(
        event(rpc(method), {
          authorization: credential ? `Bearer ${credential}` : "",
        }),
      );
      assert.equal(r.statusCode, status);
      if (status === 401 || insufficientScope)
        assert.match(
          String(r.headers?.["www-authenticate"]),
          /resource_metadata=/,
        );
      if (insufficientScope)
        assert.match(
          String(r.headers?.["www-authenticate"]),
          /insufficient_scope/,
        );
    }
  }
  assert.equal(calls, 0);
  const r = await h(
    event(rpc("tools/call", { name: "evaluate_state", arguments: input }), {
      authorization: `Bearer ${await token()}`,
    }),
  );
  assert.equal(body(r).result.isError, false);
  assert.equal(calls, 1);
});

test("MCP returns arrays and scalar provider JSON as text without fabricated structured objects", async () => {
  for (const raw of [null, false, 42, "provider text", [{ partial: true }]]) {
    const h = createHandler(config, async () => {}, {
      model: "mock",
      evaluate: async () => raw,
    });
    const result = body(
      await h(
        event(rpc("tools/call", { name: "evaluate_state", arguments: input })),
      ),
    ).result;
    assert.equal(result.isError, false);
    assert.deepEqual(JSON.parse(result.content[0].text), raw);
    assert.equal(Object.hasOwn(result, "structuredContent"), false);
  }
});
