# jev-mcp

Review-only transaction category suggestions on Family-PaaS Lambda + HTTP API Gateway. Bruh reads Tiller rows/categories using its existing Google Drive connection, sends only necessary descriptions and category definitions here, and presents suggestions for confirmation. This service has no Sheets access, Google credentials, budget writes, persistence, or arbitrary URL tool.

## Local verification

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm run lint
npm run build
npm run evaluate -- test/evaluation.synthetic.json
terraform -chdir=terraform init -backend=false
terraform -chdir=terraform validate
terraform -chdir=terraform test
terraform fmt -check -recursive terraform
```

Tests use synthetic data and mocked inference/Secrets Manager; JWT tests use ephemeral test keys. These commands do not call Jev or provision AWS. The Lambda bundle follows the platform's CommonJS `index.handler` convention; the deploy ZIP contains the bundle without this repository's ESM package.json.

## Tool and policy

`POST /mcp` implements stateless Streamable HTTP JSON responses (2025-06-18 and 2025-03-26). It supports initialize, ping, tools/list, tools/call, and notification acknowledgement. GET/DELETE return 405; no sessions or SSE streams are allocated. Send `Accept: application/json, text/event-stream`, JSON content type, and the negotiated `MCP-Protocol-Version` on subsequent requests.

The only tool is `suggest_transaction_categories`:

```json
{
  "transactions": [{"id":"opaque-1","description":"Synthetic coffee shop"}],
  "categories": [{"id":"food","definition":"Food and drink purchases"}]
}
```

Transactions may include `context` (500 characters) and `itemEvidence` (1000 characters). Descriptions are limited to 500 characters, opaque IDs to 80 ASCII letters/digits/underscore/hyphen. Maximum batch: 10 transactions; maximum categories: 50, each with a 500-character definition. IDs must be unique within each list. Inputs reject extra fields and requests exceed 64 KiB are rejected. Do not include account numbers, balances, full spreadsheet rows, unnecessary dates, or credentials. IDs never go to Jev; category IDs and definitions do.

Each result includes `categoryId` or an `insufficient_information` outcome, original `jevChoice`, `confidence`, full `probabilities`, `reviewRequired`, and policy-generated `reviewFlags`. Response metadata includes requested/returned model, service version and policy version. No explanation is invented. Confidence measures distribution concentration, **not calibrated correctness**. The 0.8 low-concentration flag is an initial review heuristic, not an accuracy guarantee. Every result needs human review.

Amazon/AMZN, Target and Costco descriptions without nonempty caller-supplied item evidence are forced to insufficient information regardless of confidence. Evidence presence is not evidence verification; fabricated or vague evidence and other mixed retailers still require human review. Embedded transaction instructions remain untrusted, scoped data; constrained output validation and review policy apply independently of the model.

## Authentication

This app is both the MCP resource server and a minimal OAuth 2.1 authorization server for ChatGPT. There is no external IdP. The API module's JWT authorizer is unused so 401s can emit the RFC 9728 challenge. All `/mcp` methods require a JWT issued by this app. Missing, invalid or expired credentials receive 401; tokens lacking `transactions:suggest` or an allowlisted username receive 403.

Public, unauthenticated routes:

- `GET /.well-known/oauth-protected-resource/mcp`
- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/jwks.json`
- `GET|POST /authorize`
- `POST /token`

Issuer and resource are `https://{apiId}.execute-api.{region}.amazonaws.com` and that origin plus `/mcp`. Tokens are RS256 via a dedicated KMS key. Authorization codes live in DynamoDB for 120 seconds and are single-use. PKCE S256 is required. ChatGPT's stable CIMD (`https://chatgpt.com/oauth/client.json`) and redirect (`https://chatgpt.com/connector_platform_oauth_redirect`) are allowlisted; callback-id CIMD documents under `https://chatgpt.com/oauth/` are fetched and checked for the requested redirect.

Set `allowed_subjects` to the username(s) that may sign in. Set `oauth_password_hash` to `printf '%s' 'your-password' | shasum -a 256`. After deploy, paste `mcp_url` into ChatGPT. The first connect opens `/authorize`; sign in with that username and password.

Canonical resource uses API Gateway's trusted `requestContext.apiId` and Lambda's AWS region, never Host headers. Only the default execute-api endpoint is supported. An Origin header is rejected unless listed in `allowed_origins`. Verification failures fail closed.

## Secret and infrastructure setup (operator actions, not performed)

1. Obtain tenant/account/state settings from the platform operator. Replace placeholders in `app.config.json`; retain the tenant-specific state prefix and state role. Set the same app/environment/region/account values in ignored `terraform/terraform.tfvars`, using the example. The frontend fields exist only for deploy CLI compatibility; do not run frontend deployment.
2. In the workload account/region, the user creates/populates a Secrets Manager secret themselves through the AWS console. Store the Jev API key as the **raw plaintext SecretString**, not JSON. Supply only its exact ARN as `jev_secret_arn`. No secret resource version or secret-value data source exists in Terraform. For a customer-managed KMS key, supply its exact ARN and ensure its existing policy permits this Lambda role. Default AWS-managed encryption needs no explicit KMS permission here.
3. Set `allowed_subjects` and `oauth_password_hash` in `terraform.tfvars`. The hash is a SHA-256 hex digest, not the password.
4. With a workload SSO session, follow the Family-PaaS workflow: `npm run deploy:seed`, `npm run terraform:init`, then review a Terraform plan and explicitly approve/apply it. Seeding uploads `jev-mcp/prod/mcp.zip` before Lambda creation. Use only `npm run deploy:lambdas` for later code updates; use Terraform for configuration changes. The deploy CLI validates the selected workload account before mutations.
5. Read `terraform output -raw mcp_url` and connect that URL in ChatGPT. Complete the browser login once, then verify initialize/list before a paid tools/call.

Infrastructure pins Family-PaaS `a59d41e0469d1a1336110fa2d6e46ee07f2eb168`. The runtime role can read the exact Jev secret, sign/get-public-key on the OAuth KMS key, read/write/delete authorization codes, and write its own log streams. The password hash is an environment variable (not recoverable as the password). The Jev API key never enters Terraform state or outputs. Jev key retrieval is lazy, cached for 5 minutes, with a 3-second timeout and one attempt.

Jev calls use a fixed HTTPS endpoint, 12-second timeout, response-size/schema/distribution validation, no redirects and **zero retries** to avoid duplicate charges after uncertain failures. Lambda timeout is 25 seconds. API stage throttling is 1 request/second, burst 2. AWS throttling is best effort, not a monthly spending cap or per-user quota. Disable access logging here and never log event bodies, headers, tokens, transaction text, secret values or upstream error bodies. The application emits no request logs. API errors are generic. Caller-supplied content is transmitted to TypeSafe AI only on an authorized tool call; assess provider retention separately before real use.

## Offline evaluation

`npm run evaluate -- <local-file.json>` reads only saved predictions paired with later user-confirmed labels. See `test/evaluation.synthetic.json` for the schema. It reports coverage, abstentions and exact-label agreement overall and by concentration band, plus model/policy versions. Synthetic results prove mechanics only, not model accuracy. Keep actual labels in ignored `evaluation-private/` and do not commit them. Use a separate held-out set, preserve taxonomy version in evaluation records, deduplicate recurring merchants across train/test splits, compare model/policy versions, inspect ambiguous merchants and per-category errors, and report sample sizes before adjusting thresholds. Human review remains required. Running evaluation never invokes Jev.

## Verified contracts

Reviewed September 30, 2026:
- [Jev introduction](https://docs.typesafe.ai/introduction), [Choice](https://docs.typesafe.ai/primitives/choice), [API](https://docs.typesafe.ai/api), [confidence](https://docs.typesafe.ai/confidence): fixed `/v1/systemone`, Bearer API key, `state/model/questions`, Choice criteria map, `answers` with choice/confidence/probabilities and returned model. `jev-latest` can change; select a supported pinned model after evaluation when reproducibility matters.
- [MCP HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) and [authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization).
- [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth): provider discovery, resource binding, PKCE and client registration are necessary beyond JWT verification.
