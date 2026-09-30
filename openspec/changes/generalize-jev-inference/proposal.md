## Why
Joe clarified that jev-mcp should expose general supported Jev input. The receipt and daily categorization logic belongs in the caller workflow, not the inference service.

## What Changes
Replace the finance-specific tool with evaluate_state: arbitrary bounded text/JSON state, optional model override, and documented Choice/Score/Noul questions. Return original model outputs and usage. Remove transaction schemas, merchant guards, evidence/history policy, thresholds, review flags and finance evaluation utilities.

## Impact
This is a deliberate tool-contract change: old tool calls are rejected without inference, and clients must refresh discovery and construct Jev requests. Preserve published commits and existing OAuth/storage/deployment configuration. No credential or grant changes, upstream merge, deployment or paid inference.
