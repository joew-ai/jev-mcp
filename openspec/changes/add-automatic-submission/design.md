## Decisions
Keep all new fields optional so existing clients remain review-only. An eligible result requires explicit opt-in, explicit supported target, category output, concentration strictly above 0.85, and no evidence or review blocker. Do not use selected probability as confidence or round at the boundary.

Share at most 20 recent history entries across a batch, with at most 10 same-merchant entries per target. Use null for unknown categories and validate supplied aliases, duplicate history IDs and exclusion of current targets. Strip all opaque IDs upstream. Expand plain context to 4000 characters and the transport cap to 512 KiB with correct base64 padding bounds.

A dedicated fuel descriptor or explicitly verified whole-transaction purpose can establish a mixed-retailer purpose without a receipt. General history alone does not prove the current purpose. Receipt item verification is a caller assertion about receipt matching and split arithmetic; confidence cannot establish either. Invalid evidence blocks submission regardless of concentration.

## Risks
Caller attestations and exact target identity cannot be independently verified without sheet/receipt access, which remains out of scope. Merchant descriptor recognition is intentionally narrow; other specific purposes require grounded caller verification. The 0.85 policy is user-approved concentration routing, not calibrated accuracy. Upstream error validation and authenticated inference boundaries remain intact.
