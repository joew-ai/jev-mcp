## ADDED Requirements
### Requirement: General typed inference
The service SHALL expose evaluate_state accepting supported Jev state, optional model, and Choice/Score/Noul questions, and SHALL return upstream JSON values unchanged without answer-schema or semantic validation, normalization or invented fields.
#### Scenario: Mixed primitives
- WHEN the caller supplies Choice, Score and Noul in one question map
- THEN all are forwarded without instructions or policy being added, and all upstream result fields are returned.
#### Scenario: Domain policy separation
- WHEN state describes a receipt, merchant, transaction or any other topic
- THEN the service SHALL apply no domain threshold, evidence, review or submission policy.
### Requirement: Authenticated fixed-endpoint inference
The service SHALL retain current OAuth membership/scope enforcement, server-owned credential isolation, bounded input/output/time, no retries, and safe errors.
#### Scenario: Arbitrary routing or credentials
- WHEN tool arguments include URL/header/credential overrides
- THEN validation SHALL reject the request without secret reads or inference.
### Requirement: Explicit migration
The service SHALL remove the specialized tool and preserve prior published commit history.
#### Scenario: Legacy tool call
- WHEN suggest_transaction_categories is called
- THEN it SHALL return an unknown-tool error without inference.

### Requirement: Honest nonstandard provider content
The service SHALL forward JSON objects as structured content and JSON text, and arrays/scalars as JSON text without fabricating structured answers. Bounded non-JSON successful HTTP content or JSON outside structural serialization limits SHALL be exposed as clearly labeled raw provider text with an error marker and safe diagnostics. Provider bodies SHALL NOT enter diagnostic logs; non-success HTTP error bodies and incomplete/oversized reads SHALL remain withheld.
#### Scenario: Incomplete or rounded answers
- WHEN provider output has missing fields, extra fields, incomplete distributions or rounded probabilities
- THEN values SHALL pass through unchanged without repairing or rejecting answer semantics, and caller safety checks SHALL govern downstream actions.
#### Scenario: Malformed successful response
- WHEN a successful provider HTTP response contains malformed JSON within the byte cap
- THEN the caller SHALL receive explicitly labeled raw text without fabricated typed success data, and diagnostics SHALL retain safe status/correlation metadata.
