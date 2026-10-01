# Historical daily-workflow update verification

Superseded by the 0.3.0 general interface. See [general-inference-verification.md](general-inference-verification.md). This report records the previous implementation, whose commit is preserved in history.

Based on synchronized upstream `69a7e80` (`fix oauth server`). No AGENTS.md or local skills exist in the checkout or mounted `.agents` directory. OAuth server, KMS/DynamoDB authorization-code storage, credentials, IAM permissions and deployment configuration are preserved. Inference remains stateless with no transaction storage, sheet/email access or category writes.

## Passed locally

- `npm test`: 30 tests, including all existing OAuth/auth/protocol/secret tests and eight new domain/protocol test groups. Synthetic data and mocked inference only.
- Strict boundary tests: 0.85 is ineligible, 0.850001 is eligible only with explicit opt-in/target and no blockers. Model probabilities are not substituted for confidence.
- Insufficient information, ambiguous Amazon/Target/Costco/Walmart, invalid receipt/purpose evidence, missing item evidence, missing verification, wrong target type, and default review behavior covered.
- Specific whole-transaction fuel descriptors and grounded caller-verified purpose work without a receipt. Generic historical categories and instruction-like merchant strings do not waive ambiguity guards.
- 20 recent + 10 per-target same-merchant examples, null unknown categories, aliases, exclusion of current targets, duplicate IDs, invalid labels and bounds covered. Current/history correlation IDs stay local.
- 4000-character context; valid payloads above the old 64 KiB limit; exact 512 KiB acceptance and one-byte-over rejection in raw/base64 forms; maximum bounded Unicode input below aggregate cap covered.
- `npm run typecheck`, `npm run lint`, `npm run build`: pass.
- Existing offline synthetic evaluation runs successfully; it is mechanics verification, not accuracy evidence for automatic categorization.
- Terraform `fmt -check`, `init -backend=false`, `validate`, and four mock-provider tests pass. No AWS backend access, live-cloud plan or apply.
- Prettier check on changed code and `git diff --check`: pass.

## Contract and rollout

See README's daily-workflow contract. Service version is 0.2.0; policy version is 2. Eligibility is advisory and only for explicitly approved exact targets. Caller asserts verification and performs submission itself. Confidence is distribution concentration, not correctness, receipt matching or split verification.

Ready for publication as a local feature commit. This update has not been pushed, merged or deployed, and the connected live tool has not been exercised. Publish/review the commit, then an authorized operator runs `npm run deploy:lambdas` using the existing workload SSO/profile and app configuration. Refresh tool discovery and confirm initialize 0.2.0 and the new schema before real calls. No Terraform apply, OAuth permissions or credential changes are required by this update.
