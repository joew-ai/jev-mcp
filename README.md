# jev-mcp

Transaction category suggestions on Family-PaaS Lambda + HTTP API Gateway, with review-only defaults and explicit opt-in eligibility for automatic submission. Bruh reads Tiller rows/categories using its existing Google Drive connection and submits eligible results itself. This service has no Sheets access, Google credentials, budget writes, transaction persistence, or arbitrary URL tool. Existing OAuth authorization-code storage is unchanged.

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

Transactions may include `context` (now 4000 characters) and `itemEvidence` (1000 characters). Descriptions remain limited to 500 characters, opaque IDs to 80 ASCII letters/digits/underscore/hyphen, batches to 10 targets, and categories to 50 definitions of 500 characters each. Category IDs remain safe aliases; Bruh maps them back to the exact Tiller labels, including spaces and punctuation. Supply only submit-ready budget categories, excluding Categorize Later/unknown placeholders, and map those history labels to `null`. Inputs reject extra fields. The decoded request limit is now 512 KiB, including JSON-RPC framing; both raw and base64-encoded requests are bounded. Avoid account numbers, balances, credentials and unnecessary spreadsheet columns.

### Daily-workflow contract (service 0.2.0, policy 2)

All new fields are optional. An existing request still returns suggestions requiring human review. To enable submission eligibility, pass `allowAutomaticSubmission: true` and set each target's `target` to `categorize_later` or `receipt_line_item`. These are caller assertions about the exact row or item being processed; the service cannot inspect the sheet to verify them. Opaque target IDs must map to the exact row or receipt item. Only exact Categorize Later rows and caller-verified receipt items are authorized workflow targets.

```json
{
  "allowAutomaticSubmission": true,
  "categories": [
    {"id": "fuel", "definition": "Exact Tiller label: Auto: Fuel & Gas"},
    {"id": "food", "definition": "Exact Tiller label: Food & Dining"}
  ],
  "recentTransactions": [
    {"transactionId": "prior-1", "description": "Synthetic coffee shop", "categoryId": "food", "amount": -4.5},
    {"transactionId": "prior-2", "description": "Synthetic unknown purchase", "categoryId": null}
  ],
  "transactions": [
    {
      "id": "current-1",
      "target": "categorize_later",
      "description": "COSTCO GAS #123",
      "context": "Synthetic whole-transaction example; no receipt is available.",
      "sameMerchantTransactions": [
        {"transactionId": "prior-3", "description": "COSTCO GAS #123", "categoryId": "fuel"}
      ]
    },
    {
      "id": "receipt-item-1",
      "target": "receipt_line_item",
      "description": "Synthetic Walmart purchase",
      "itemEvidence": "Coffee beans, exact verified receipt line item",
      "receiptVerification": {"matchesTransaction": true, "splitArithmeticVerified": true}
    }
  ]
}
```

`recentTransactions` holds up to 20 actual recent transactions, shared across the batch. `sameMerchantTransactions` holds up to 10 prior transactions for each target's merchant. Each history entry requires `transactionId`, `description` (1–400 characters), and `categoryId` (a supplied alias or `null` for unknown); `amount` is optional and bounded to ±1 billion. Use `null` for uncategorized/Categorize Later labels rather than inventing a category. IDs are unique within each history list, must exclude **all current batch targets**, and are stripped before calling Jev. Overlap between recent and same-merchant lists is permitted; those repeated examples are not independent evidence. The caller selects the true recent ordering and verifies same-merchant identity; the server cannot fetch or verify sheet history. Up to 30 context slots per target are supported without flattening histories across merchants.

With line items available, set `target: "receipt_line_item"` and supply the exact `itemEvidence`. The caller must verify receipt-to-transaction matching and the entire split's arithmetic, including tax, shipping and adjustments, before asserting both receipt verification booleans. Each item gets its own opaque ID. The service does not perform receipt lookup, matching, amount reconciliation, splitting, or spreadsheet updates. An item mistakenly tagged `categorize_later` remains review-required. Legacy `itemEvidence` without verification still produces review-only suggestions.

Without line items, categorize the whole transaction. A specific dedicated fuel descriptor (for example `COSTCO GAS #123` or `Walmart Fuel 123`) establishes whole-transaction purpose without a receipt. For other purposes or a generic merchant descriptor, the caller can supply:

```json
"wholeTransactionEvidence": {
  "purpose": "Fuel-only purchase established from the transaction record and specific context",
  "verified": true
}
```

This optional object belongs inside the target transaction. `purpose` is 1–500 characters; `verified` is an explicit caller attestation that the supplied evidence establishes this transaction's purpose. Merely observing that previous trips were usually groceries does not justify asserting it. Do not fabricate `itemEvidence` or verified purpose to bypass review. Amazon/AMZN, Target, Costco and Walmart/WM/Wal-Mart with no item evidence or established whole-transaction purpose are forced to insufficient information, even at maximum confidence. General free-text context/history informs Jev, but does not independently waive this deterministic review safeguard. Missing receipts alone do not block non-mixed transactions or specifically evidenced whole transactions.

Each result retains `id`, `outcome`, `categoryId`, `jevChoice`, `confidence`, `probabilities`, `reviewRequired` and `reviewFlags`, and adds `automaticSubmissionEligible`. Response metadata includes `serviceVersion: "0.2.0"`, `policyVersion: "2"`, requested/returned model, unchanged concentration semantics, and `automaticSubmissionThreshold: 0.85`. No explanatory prose is invented.

Automatic eligibility requires explicit opt-in, an explicit workflow target, a valid category, **confidence strictly greater than 0.85**, and no blocker. Exactly 0.85 stays review-required; scores are never rounded and the selected option's probability is not the threshold value. Confidence measures distribution concentration, **not calibrated probability of correctness**, receipt verification or arithmetic correctness. Every ineligible result has `reviewRequired: true`; an eligible result has `reviewRequired: false` and empty review flags. Bruh may submit only eligible results under the approved workflow and must recheck exact row/item identity before writing. The MCP itself never submits anything.

Review flags include `human_review_required`, `concentration_not_above_threshold`, `insufficient_information`, `automation_target_required`, `automation_target_evidence_mismatch`, `mixed_merchant_without_purpose_evidence`, `receipt_line_item_evidence_missing`, `receipt_verification_required`, `invalid_receipt_evidence`, and `invalid_whole_transaction_evidence`. The legacy `low_concentration` (<0.8) and `mixed_merchant_without_item_evidence` flags remain available for compatibility. Invalid evidence, missing line-item evidence, ambiguity or the model's insufficient-information outcome suppresses category output. Missing receipt verification can retain a suggestion for review but never grants eligibility. Upstream invalid distributions/timeouts remain sanitized MCP tool errors, with no suggestions.

Embedded transaction text, history and category definitions remain untrusted data. History is background, not proof of this purchase's purpose; receipts and verification are never inferred from concentration. Jev credentials, OAuth permissions, session behavior, throttling and infrastructure are unchanged.

### Publishing and the first live pass

This code change must be published and deployed before the connected tool sees the new fields. The operator should use the existing workload SSO session and `npm run deploy:lambdas` to publish the Lambda bundle and update the live alias after code review; this update does not require Terraform apply, new credentials or OAuth scope changes. Refresh/reconnect the MCP client's tool discovery if it caches schemas. Verify initialize advertises 0.2.0 and tools/list includes `allowAutomaticSubmission`, `recentTransactions` and transaction evidence/history fields before submitting the first real batch. Calls against an older deployment reject these new fields or retain the old mandatory-review policy. No deployment or real-data call was performed for this change.

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

`npm run evaluate -- <local-file.json>` reads only saved predictions paired with later user-confirmed labels. See `test/evaluation.synthetic.json` for the schema. It reports coverage, abstentions and exact-label agreement overall and by concentration band, plus model/policy versions. Synthetic results prove mechanics only, not model accuracy. Keep actual labels in ignored `evaluation-private/` and do not commit them. Use a separate held-out set, preserve taxonomy version in evaluation records, deduplicate recurring merchants across train/test splits, compare model/policy versions, inspect ambiguous merchants and per-category errors, and report sample sizes before adjusting thresholds. Review remains required for ineligible results. Evaluate the >0.85 eligible subset separately for wrong automatic submissions and abstention rates before broad use; confidence bands are concentration bands, not measured accuracy. Running evaluation never invokes Jev.

## Verified contracts

Reviewed September 30, 2026:
- [Jev introduction](https://docs.typesafe.ai/introduction), [Choice](https://docs.typesafe.ai/primitives/choice), [API](https://docs.typesafe.ai/api), [confidence](https://docs.typesafe.ai/confidence): fixed `/v1/systemone`, Bearer API key, `state/model/questions`, Choice criteria map, `answers` with choice/confidence/probabilities and returned model. `jev-latest` can change; select a supported pinned model after evaluation when reproducibility matters.
- [MCP HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) and [authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization).
- [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth): provider discovery, resource binding, PKCE and client registration are necessary beyond JWT verification.
