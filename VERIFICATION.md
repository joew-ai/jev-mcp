# Verification — September 30, 2026

Implementation resides only in `/workspace/jev-mcp`, branch `feat/jev-mcp`. Existing remote is `https://github.com/joew-ai/jev-mcp.git`; no authentication changes or remote writes were made. `/workspace/family-paas` remains clean at `a59d41e0469d1a1336110fa2d6e46ee07f2eb168`. No AGENTS.md or local skills were found in either checkout or the mounted workspace instructions directory.

## Passed locally

- `npm test`: 10 test groups. Covers initialize, tools/list, tools/call, ping, notifications, public metadata, unauthorized requests, invalid/oversized input, Origin and protocol/content negotiation failures, category and batch bounds, mixed retailers, explicit abstention, low concentration, invalid upstream responses, upstream errors/timeouts, no retries, secret lazy loading/cache expiry, and offline evaluation.
- Real locally signed JWT verification: valid token accepted; expired, future-not-before, wrong issuer/audience, absent expiry, wrong scope, outsider subject, ID-token and malformed-token cases rejected. Ephemeral test keys only.
- `npm run typecheck`, `npm run lint`, `npm run build`: pass. Bundle is approximately 1.8 MB, includes dependencies, exports `handler`, and uses Family-PaaS's Node 20/CommonJS packaging convention.
- Bundled runtime smoke: without config returns sanitized 503; with synthetic config and no bearer token returns 401 without network access.
- `npm run evaluate -- test/evaluation.synthetic.json`: three synthetic rows, 2/3 coverage, 1/2 agreement among suggestions, one abstention. This is a mechanics check, not accuracy evidence.
- Terraform 1.13.3: downloaded locally with SHA-256 matched to vendor checksums. `init -backend=false` installed pinned platform modules and AWS provider 5.100.0; no AWS backend or credentials used.
- `terraform validate` and `terraform fmt -check -recursive terraform`: pass.
- `terraform test`: three mock-provider plan tests pass: exact secret permission, cross-account-secret rejection, empty-member-list rejection. No real provider plan or apply.
- `git diff --check`: pass.

An initial type check caught an incomplete API Gateway test fixture, fixed with a complete fixture. Initial Terraform validation caught an API/Lambda environment dependency cycle, fixed by deriving the resource URL from trusted API Gateway context in the handler. Final checks passed after both corrections.

## Not performed / remaining setup

No real Jev inference, private financial input, secret retrieval or population, OAuth registration, AWS resource creation, deployment, Terraform apply, real-cloud plan, push, PR or merge. No working ChatGPT connection is claimed. Tests invoke the Lambda adapter locally; no deployed gateway or real OAuth provider flow has been exercised.

Before use, the operator must replace app/tenant placeholders, supply an existing workload-local populated secret ARN, configure an OAuth issuer/JWKS URL and authorized subject IDs, deploy with the existing workload account/state conventions, then bind the provider's resource audience to the resulting `mcp_url`. Configure PKCE S256, resource-bound access tokens with `transactions:suggest`, supported client registration and the exact ChatGPT redirect URI. Finish browser authorization and verify authorized/unauthorized discovery before separately authorizing any paid calls. See README for detailed steps.

Known limits: handcrafted minimal stateless MCP subset; no SSE/session state, browser-direct CORS expansion, custom domain audience handling, or durable per-user cost quotas. Throttling is best effort. Item evidence is caller supplied and merchant matching is conservative; every suggestion stays review-only. Jev schema compatibility is documentation-verified and mock-tested, not live-tested.
