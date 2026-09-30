import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportSPKI, createLocalJWKSet } from "jose";
import {
  CHATGPT_CIMD,
  CHATGPT_REDIRECT,
  authorizationServerMetadata,
  handleAuthorize,
  handleToken,
  jwkFromSpki,
  passwordMatches,
  publicJwks,
  s256,
  sha256Hex,
  type AuthCode,
  type OAuthConfig,
} from "../src/oauth.js";
import { createHandler } from "../src/server.js";
import { createVerifier } from "../src/auth.js";
import type { ChoiceClient } from "../src/jev.js";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

const issuer = "https://mcp.example";
const resource = `${issuer}/mcp`;
const password = "correct-horse";
const passwordHash = sha256Hex(password);
const subject = "member";

function memoryStore() {
  const codes = new Map<string, AuthCode>();
  return {
    async putCode(code: string, record: AuthCode) {
      codes.set(code, record);
    },
    async takeCode(code: string) {
      const record = codes.get(code);
      codes.delete(code);
      return record;
    },
    codes,
  };
}

async function signerConfig(overrides: Partial<OAuthConfig> = {}) {
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const jwk = await jwkFromSpki(spki, "test-key");
  const store = memoryStore();
  const config: OAuthConfig = {
    issuer,
    resource,
    subjects: [subject],
    passwordHash,
    kid: "test-key",
    async sign(signingInput: string) {
      const { createSign } = await import("node:crypto");
      const signer = createSign("RSA-SHA256");
      signer.update(signingInput);
      signer.end();
      return signer.sign(privateKey);
    },
    async publicJwk() {
      return jwk;
    },
    putCode: store.putCode,
    takeCode: store.takeCode,
    fetch: async () => {
      throw new Error("unexpected fetch");
    },
    ...overrides,
  };
  return { config, store, jwk };
}

function challenge() {
  const verifier = "a".repeat(43);
  return { verifier, challenge: s256(verifier) };
}

function authorizeQuery(extra: Record<string, string> = {}) {
  const { challenge: codeChallenge } = challenge();
  return new URLSearchParams({
    response_type: "code",
    client_id: CHATGPT_CIMD,
    redirect_uri: CHATGPT_REDIRECT,
    code_challenge: extra.code_challenge || codeChallenge,
    code_challenge_method: "S256",
    state: "abc",
    resource,
    scope: "transactions:suggest",
    ...extra,
  }).toString();
}

test("password hash comparison is exact and bounded", () => {
  assert.equal(passwordMatches(password, passwordHash), true);
  assert.equal(passwordMatches("wrong", passwordHash), false);
  assert.equal(passwordMatches(password, "zzzz"), false);
});

test("authorization server metadata advertises PKCE, CIMD and issuer identification", () => {
  const meta = authorizationServerMetadata(issuer);
  assert.equal(meta.issuer, issuer);
  assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
  assert.equal(meta.client_id_metadata_document_supported, true);
  assert.equal(meta.authorization_response_iss_parameter_supported, true);
  assert.equal(meta.jwks_uri, `${issuer}/.well-known/jwks.json`);
});

test("authorize GET shows login; POST issues a one-time code for ChatGPT CIMD", async () => {
  const { config, store } = await signerConfig();
  const query = authorizeQuery();
  const form = await handleAuthorize("GET", query, "", undefined, config);
  assert.equal(form.statusCode, 200);
  assert.match(String(form.body), /<form method="post"/);

  const body = `${query}&username=${subject}&password=${password}`;
  const granted = await handleAuthorize(
    "POST",
    "",
    body,
    "application/x-www-form-urlencoded",
    config,
  );
  assert.equal(granted.statusCode, 302);
  const location = new URL(granted.headers!.location!);
  assert.equal(location.origin + location.pathname, CHATGPT_REDIRECT);
  assert.equal(location.searchParams.get("iss"), issuer);
  assert.equal(location.searchParams.get("state"), "abc");
  const code = location.searchParams.get("code")!;
  assert.ok(store.codes.has(code));
});

test("authorize rejects unknown clients, wrong password, and outsider usernames", async () => {
  const { config } = await signerConfig();
  const deniedClient = await handleAuthorize(
    "GET",
    authorizeQuery({ client_id: "https://evil.example/client.json" }),
    "",
    undefined,
    config,
  );
  assert.equal(deniedClient.statusCode, 400);

  const query = authorizeQuery();
  const badPassword = await handleAuthorize(
    "POST",
    "",
    `${query}&username=${subject}&password=wrong`,
    "application/x-www-form-urlencoded",
    config,
  );
  assert.equal(badPassword.statusCode, 400);

  const outsider = await handleAuthorize(
    "POST",
    "",
    `${query}&username=outsider&password=${password}`,
    "application/x-www-form-urlencoded",
    config,
  );
  assert.equal(outsider.statusCode, 400);
});

test("authorize accepts a matched callback-specific ChatGPT client", async () => {
  const { config } = await signerConfig();
  const callbackId = "callback-123";
  const response = await handleAuthorize(
    "GET",
    authorizeQuery({
      client_id: `https://chatgpt.com/oauth/${callbackId}/client.json`,
      redirect_uri: `https://chatgpt.com/connector/oauth/${callbackId}`,
    }),
    "",
    undefined,
    config,
  );
  assert.equal(response.statusCode, 200);

  const mismatched = await handleAuthorize(
    "GET",
    authorizeQuery({
      client_id: `https://chatgpt.com/oauth/${callbackId}/client.json`,
      redirect_uri: "https://chatgpt.com/connector/oauth/different",
    }),
    "",
    undefined,
    config,
  );
  assert.equal(mismatched.statusCode, 400);
});

test("token exchange consumes the code, checks PKCE, and issues a resource-bound JWT", async () => {
  const { config, store, jwk } = await signerConfig();
  const { verifier, challenge: codeChallenge } = challenge();
  const query = authorizeQuery({ code_challenge: codeChallenge });
  const granted = await handleAuthorize(
    "POST",
    "",
    `${query}&username=${subject}&password=${password}`,
    "application/x-www-form-urlencoded",
    config,
  );
  const code = new URL(granted.headers!.location!).searchParams.get("code")!;

  const token = await handleToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: CHATGPT_REDIRECT,
      client_id: CHATGPT_CIMD,
      resource,
    }).toString(),
    "application/x-www-form-urlencoded",
    config,
  );
  assert.equal(token.statusCode, 200);
  const body = token.body as {
    access_token: string;
    token_type: string;
    scope: string;
  };
  assert.equal(body.token_type, "Bearer");
  assert.equal(body.scope, "transactions:suggest");
  assert.equal(store.codes.size, 0);

  const replay = await handleToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: CHATGPT_REDIRECT,
      client_id: CHATGPT_CIMD,
      resource,
    }).toString(),
    "application/x-www-form-urlencoded",
    config,
  );
  assert.equal(replay.statusCode, 400);

  const verify = createVerifier(
    { issuer, resource, subjects: [subject], origins: [] },
    createLocalJWKSet({ keys: [jwk] }),
  );
  await verify(body.access_token);
});

test("token exchange rejects a wrong PKCE verifier", async () => {
  const { config } = await signerConfig();
  const query = authorizeQuery();
  const granted = await handleAuthorize(
    "POST",
    "",
    `${query}&username=${subject}&password=${password}`,
    "application/x-www-form-urlencoded",
    config,
  );
  const code = new URL(granted.headers!.location!).searchParams.get("code")!;
  const denied = await handleToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: "b".repeat(43),
      redirect_uri: CHATGPT_REDIRECT,
      client_id: CHATGPT_CIMD,
      resource,
    }).toString(),
    "application/x-www-form-urlencoded",
    config,
  );
  assert.equal(denied.statusCode, 400);
});

test("handler exposes AS metadata and JWKS without MCP auth", async () => {
  const { config, jwk } = await signerConfig();
  const client: ChoiceClient = {
    model: "mock",
    evaluate: async () => {
      throw new Error("no inference");
    },
  };
  const handler = createHandler(
    { issuer, resource, subjects: [subject], origins: [] },
    async () => {},
    client,
    config,
  );
  function event(path: string, method = "GET"): APIGatewayProxyEventV2 {
    return {
      version: "2.0",
      routeKey: `${method} ${path}`,
      rawQueryString: "",
      rawPath: path,
      headers: {},
      requestContext: {
        accountId: "test",
        apiId: "test",
        domainName: "mcp.example",
        domainPrefix: "mcp",
        requestId: "test",
        routeKey: `${method} ${path}`,
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
      isBase64Encoded: false,
    };
  }
  const meta = await handler(event("/.well-known/oauth-authorization-server"));
  assert.equal(meta.statusCode, 200);
  assert.equal(JSON.parse(meta.body!).issuer, issuer);
  const jwks = await handler(event("/.well-known/jwks.json"));
  assert.deepEqual(JSON.parse(jwks.body!).keys[0].kid, jwk.kid);
  assert.equal((await publicJwks(config.publicJwk)).keys[0].kid, jwk.kid);
});

test("SPKI conversion keeps kid and RS256 metadata", async () => {
  const { publicKey } = await generateKeyPair("RS256");
  const pem = await exportSPKI(publicKey);
  const der = Buffer.from(
    pem.replace(/-----(BEGIN|END) PUBLIC KEY-----|\s/g, ""),
    "base64",
  );
  const jwk = await jwkFromSpki(der, "kms-kid");
  assert.equal(jwk.kid, "kms-kid");
  assert.equal(jwk.alg, "RS256");
  assert.equal(jwk.kty, "RSA");
});
