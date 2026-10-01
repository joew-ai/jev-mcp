## ADDED Requirements
### Requirement: General typed inference
The service SHALL expose evaluate_state accepting supported Jev state, optional model, and Choice/Score/Noul questions, and SHALL return validated upstream model/answers/usage unchanged.
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
