## Decisions
Separate Jev transport/response validation from transaction policy. Send one request for a bounded batch, using internal positional question IDs and omitting caller transaction IDs. Always include insufficient information; preserve raw model selection when policy abstains. Return no generated rationale.

Use stateless JSON Streamable HTTP over API Gateway v2 Lambda proxy. This app issues its own OAuth 2.1 authorization-code + PKCE tokens (KMS RS256, DynamoDB single-use codes) and verifies them in Lambda before MCP dispatch. Public metadata, authorize, token and JWKS do not expose tools or invoke inference. Do not provision Cognito.

Retrieve a user-populated exact Secrets Manager ARN lazily, never through Terraform. Disable application/request logging, bound input/output/time, and avoid retries. Runtime canonical resource is constructed from trusted API Gateway context to avoid a Terraform dependency cycle between API routes, Lambda aliases and Lambda environment.

## Risks and trade-offs
Model confidence is concentration, not accuracy. Merchant aliases are conservative, not exhaustive; itemEvidence is caller supplied. Human review applies to every result. Gateway throttling is best effort; no persistent quotas. ChatGPT CIMD/redirect compatibility and the real browser login require operator verification after deployment. Browser direct access and custom domains are outside the minimal integration. Single shared password is sufficient for a personal MCP; it is not a multi-user IdP.
