## Why
Joe approved automatic category submission for exact Categorize Later targets or verified receipt items when Jev concentration is strictly greater than 0.85. The daily workflow needs the latest 20 and up to 10 prior same-merchant transactions as context.

## What Changes
Add optional, explicit automation opt-in and target provenance, caller evidence verification, bounded structured history, a 4000-character context limit and 512 KiB aggregate request limit. Return automatic eligibility while preserving review-only defaults. Permit specifically evidenced whole-transaction purposes without a receipt; extend mixed-retailer ambiguity checks to Walmart.

## Impact
Changes the tool schema and domain policy only, preserving the current OAuth/deployment implementation. No spreadsheet/email access, transaction state, credential change, OAuth expansion, merge or deployment. The caller performs actual submission. Publication and Lambda rollout remain separate authorized actions.
