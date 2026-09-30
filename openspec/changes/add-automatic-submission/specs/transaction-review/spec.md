## MODIFIED Requirements
### Requirement: Explicit automation eligibility
The service SHALL default to human review and SHALL return automatic eligibility only for explicit opt-in, explicit Categorize Later or verified receipt-item targets, valid category output, confidence strictly greater than 0.85 and no blocker. It SHALL NOT submit categories or access sheet/email data.
#### Scenario: Boundary score
- WHEN confidence is exactly 0.85
- THEN the result SHALL remain review-required.
#### Scenario: Mixed retailer with specific whole-transaction evidence
- WHEN a whole transaction has a dedicated fuel descriptor or verified purpose evidence and no receipt
- THEN receipt absence alone SHALL NOT block eligibility.
#### Scenario: Ambiguous mixed retailer
- WHEN Amazon, Target, Costco or Walmart lacks item or established whole-transaction purpose evidence
- THEN it SHALL abstain regardless of confidence or historical category frequency.
#### Scenario: Receipt verification
- WHEN item evidence lacks receipt matching or split arithmetic verification, or either verification fails
- THEN eligibility SHALL be false regardless of confidence.
### Requirement: Bounded structured history
The service SHALL support up to 20 recent examples and 10 prior same-merchant examples per target, with null unknown labels, no current-target or duplicate IDs in a list, and no upstream opaque transaction IDs. Context SHALL be bounded at 4000 characters and decoded JSON requests at 512 KiB.
