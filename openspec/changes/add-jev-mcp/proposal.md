## Why
Bruh needs typed, reviewable category suggestions without granting an inference service spreadsheet access.

## What Changes
Add a standalone Family-PaaS app using a bounded Jev Choice batch, a separate domain review policy, stateless HTTP MCP, provider-backed token validation, protected resource metadata, runtime secret loading, and offline evaluation.

## Capabilities
- `transaction-review`: authenticated category suggestions with explicit abstention and human review.

## Non-goals
No spreadsheet access or writes, arbitrary proxy, automatic categorization, external IdP, deployment, real credentials, or live inference during development.

## Impact
Reuses pinned Lambda/API modules and deploy CLI. No Family-PaaS platform modifications. External OAuth and secret population remain operator setup.
