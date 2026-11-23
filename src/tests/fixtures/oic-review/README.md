# Synthetic OIC review fixture

All names and namespaces are fictitious. This is an IAR-shaped ZIP for reader
tests, not an integration that can be imported into Oracle.

Expected findings:

- `Resources/request.xsl:3`: `missing-common.xsl` is not supplied in the archive.
  Deterministic dependency check; it does not prove the tenant lacks the file.
- `Resources/request.xsl:6`: the `email` target receives `personNumber`.
  Model review should identify the suspicious mapping, explain the evidence and
  ask to confirm the intended contract rather than invent a replacement XPath.
- `Resources/service.wsdl:5`: `target.xsd` resolves within `Resources/`.
  This is a supplied dependency, not a missing-file finding.
- No instance logs, live connection settings or complete exported orchestration
  are supplied. The model must not certify retries, pagination or runtime success.

The tests package these files using ZIP, including both stored and deflated
entries. `review.iar` is the same fixture, ready to attach manually.
