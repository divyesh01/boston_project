# Status and Evidence Vocabulary

## Evidence origin

- `OBSERVED`: directly verified by source, command, output, schema, or receipt.
- `INFERRED`: supported by evidence but not directly executed.
- `NOT_RUN`: the verification was not executed.
- `UNKNOWN`: evidence is insufficient.

## Claim status

- `PROVEN`
- `STRONGLY_SUPPORTED`
- `HYPOTHESIS`
- `UNKNOWN`
- `DISPROVEN`

## Gate status

- `PASS`
- `FAIL`
- `UNPROVEN`
- `SKIPPED — reason`

## Failure type

- `HARD_FAILURE`
- `SILENT_FAILURE`
- `PARTIAL_FAILURE`
- `CONTRADICTION`
- `CASCADE_FAILURE`
- `LOOP_FAILURE`
- `CONTEXT_FAILURE`
- `ENVIRONMENT_FAILURE`
- `AUTHORITY_FAILURE`
- `EVIDENCE_FAILURE`

Confidence never promotes evidence or gate status.

