# General Jev interface verification

The previous requested push completed as fork-main commit `ed04929`. This implementation is its follow-up and preserves the original history. Base OAuth/deployment implementation remains from synchronized upstream `69a7e80`. No local AGENTS.md or skills were found.

## Contract

`evaluate_state({state, model?, questions})` is the sole tool. State and instructions/criteria use the documented text/JSON forms; Choice, Score and Noul are supported together. The deployed model is the default. Results are upstream model, answers, usage and actual additional fields, unchanged. There is no finance schema, receipt/merchant/history policy, threshold, review flag or submission eligibility. Old tool calls fail before inference; refresh discovery and migrate the caller.

OAuth is unchanged, including the existing legacy `transactions:suggest` scope identifier and explicit membership. The URL, method and key are server-owned. Limits: 20 questions, 255 Choice options, 2–10 Score levels, 512 KiB decoded requests, 1 MiB responses, 32 JSON nesting levels/20000 nodes per content, 12-second inference deadline and zero retries. Actual Jev token-window limits may be lower than the byte cap.

## Verification

Synthetic/mocked tests cover all primitive schemas and their response shapes, structured instructions/criteria, arbitrary JSON and literal labels, default/override model, complete response preservation, no invented Noul confidence, input validation/limits, matching IDs/types/distributions/scores, no URL/credential override, timeout/response cap/no retry, safe errors, initialize/list/call, removed tool rejection, signed-token negative cases and existing OAuth/secret tests.

Passed: 24 tests, TypeScript checking, ESLint, Lambda build, formatting/diff checks, Terraform validation/formatting and all four mock-provider tests. No paid Jev calls, real/private data, deployment, Terraform apply, credential changes or upstream merges are part of this implementation. Old verification reports are historical. An authorized operator must publish/review the code and update the Lambda live alias with the existing deploy:lambdas workflow, then confirm initialize 0.3.0 and sole tool evaluate_state before using the updated live endpoint.
