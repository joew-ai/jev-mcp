## ADDED Requirements
### Requirement: Authenticated review-only suggestions
The service SHALL require valid resource-bound scoped JWTs and explicit membership for all MCP requests and SHALL NOT access Sheets or write budget data.
#### Scenario: Unauthenticated discovery
- WHEN a caller requests tools/list without a valid token
- THEN it receives 401 with protected-resource metadata discovery, with no inference call.
### Requirement: Typed bounded decisions
The service SHALL accept at most ten transactions and fifty caller-defined categories, use Choice with insufficient information, and return model metadata and unmodified confidence/probabilities alongside review policy results.
#### Scenario: Ambiguous retailer
- WHEN Amazon, Target or Costco lacks item evidence
- THEN the result SHALL abstain regardless of confidence and SHALL retain the model decision separately.
### Requirement: Safe failure and secret isolation
The service SHALL read only a configured runtime secret, SHALL NOT log raw inputs or credentials, and SHALL bound inference with no retries.
#### Scenario: Upstream failure
- WHEN Jev times out or returns invalid probabilities
- THEN the MCP tool returns a sanitized error without category suggestions.
