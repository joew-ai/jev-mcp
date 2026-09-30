## Decisions
Use one clear general tool rather than maintaining specialized compatibility policy. Match official state/model/questions shapes and all three typed primitives. Do not inject questions, criteria, uncertainty options, prompts or workflow decisions. The default deployed model remains available with optional caller override; the fixed endpoint and server-owned key cannot be overridden.

Validate and bound JSON using iterative depth/node checks so arbitrary content is preserved safely without recursive parser overflow. Limit question count, option/level counts, request and response bytes, and time. Validate response structure and correspondence to requested questions, returning the original response rather than projecting, rounding, filtering metadata or inventing confidence for Noul.

Keep current OAuth enforcement and legacy scope identifier to avoid modifying grants. Preserve the already-published 0.2.0 commit as a parent; the correction is visible in new history. The caller migrates data into state and questions and owns all domain policy and downstream actions.
