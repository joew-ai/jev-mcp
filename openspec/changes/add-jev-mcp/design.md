## Decisions
Separate Jev transport/response validation from transaction policy. Send one request for a bounded batch, using internal positional question IDs and omitting caller transaction IDs. Always include insufficient information; preserve raw model selection when policy abstains. Return no generated rationale.

Use stateless JSON Streamable HTTP over API Gateway v2 Lambda proxy. Verify signatures, issuer, resource audience, expiry, scope and explicit subject membership in Lambda before MCP dispatch. This preserves standards-compliant 401 resource discovery challenges that the existing gateway JWT module does not customize. Public metadata does not expose tools or invoke inference. Do not provision cross-account Cognito or claim OAuth is configured.

Retrieve a user-populated exact Secrets Manager ARN lazily, never through Terraform. Disable application/request logging, bound input/output/time, and avoid retries. Runtime canonical resource is constructed from trusted API Gateway context to avoid a Terraform dependency cycle between API routes, Lambda aliases and Lambda environment.

## Risks and trade-offs
Model confidence is concentration, not accuracy. Merchant aliases are conservative, not exhaustive; itemEvidence is caller supplied. Human review applies to every result. Gateway throttling is best effort; no persistent quotas. Provider compatibility and real OAuth flow require operator verification after deployment. Browser direct access and custom domains are outside the minimal integration.
