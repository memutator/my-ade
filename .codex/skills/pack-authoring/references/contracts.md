# Pack contracts and manifest rules

Authority files (read them, do not copy their field lists into a Pack README):

- `packages/mahas-contracts/src/integration/schema.ts` — `CAPABILITY_PAYLOAD_SCHEMAS`,
  `PACK_BOUNDARY_SCHEMAS`, `validateCapabilityPayload`, `validatePackBoundaryPayload`,
  `PACK_BOUNDARY_NEGATIVE_CASES`.
- `packages/mahas-contracts/src/integration/index.ts` — `AdapterPack`,
  `AdapterPackRevision`, `CapabilityImplementation`, `IntegrationContract`,
  `IntegrationSubjectRef`, `IntegrationTargetRef`.
- `packages/mahas-runtime/src/integration/registry.ts` — manifest validation, digest,
  immutability, `packEntrypoint`.
- `packages/mahas-runtime/src/integration/runner.ts` — request validation and the
  script invocation contract.
- `packages/mahas-runtime/src/integration/types.ts` — `INTEGRATION_CAPABILITIES`,
  `PackManifestFile`, support states.

## Manifest validation (registration fails on any of these)

- `schemaVersion` is exactly `1`; `pack` and `revision` objects are present.
- `pack.id` matches `^[a-z0-9][a-z0-9._-]{0,127}$` (case-insensitive) and is
  publisher-namespaced, for example `mahas.codex.files` or `mahas.opencode`.
- `pack.name` and `pack.publisher` are non-empty strings; `pack.createdAt` is a
  non-negative safe integer; `pack.metadata` is an object.
- `revision.revision` is a positive integer, `revision.packId` equals `pack.id`,
  `revision.runnerProtocol` is a non-empty string, `revision.createdAt` is a
  non-negative safe integer.
- `revision.subjectRefs`, `revision.requirements`, and `revision.implementations`
  are arrays; each subject ref has a non-empty id; each requirement has `kind`,
  `key`, and a boolean `required`.
- Each implementation has one distinct known capability, a non-empty `id`, and a
  `contract` with a non-empty `id` and a positive integer `revision`.
- `support.state` is `implemented` or `unsupported`. `unsupported` requires a
  reason and forbids an entrypoint; `implemented` requires an entrypoint with
  `mode` of `script` or `declarative`, a non-empty `resource`, and (for scripts) a
  non-empty `runtime`.
- `limits.timeoutMs` and `limits.maxOutputBytes` are positive integers;
  `limits.maxBatchRecords`, when present, is a positive integer.
- `supportDetails` is an object — this is where capability-specific precision goes.

## Entrypoint invocation contract

The runner starts `process.execPath <snapshot>/<resource>` with:

- **cwd** = the immutable snapshot directory of the registered revision,
- **environment** limited to `PATH`, `LANG`, and `MAHAS_PACK_PROTOCOL` (there is no
  `HOME`, so all paths must come from the request payload),
- the **request envelope as one JSON line on stdin**,
- **stdout must be exactly one JSON object** (the result envelope) and the process
  must exit 0; anything else — extra output, a non-zero exit, invalid JSON — is a
  failed invocation.

A result envelope must: echo `protocolVersion` and `operationId`; carry a `status`
of `success`, `partial`, `failed`, `cancelled`, or `timed-out`; carry a `diagnostics`
array; match the requested `action` for boundary actions. Identity (`capability`,
`target`, `contract`, `pack`) is pinned by the runner — echoing it is optional, but a
**different** echo is a hard failure, because identity is not something a Pack asserts.
Payloads are schema-validated on the way in and out, and per-array lengths are checked
against `maxBatchRecords`.

## Capabilities

`identify`, `launch`, `resume`, `wake`, `events`, `sessions`, `usage`, `bindings`,
`maintenance`, `auth`, `quota`. Contract ids are `mahas.integration.<capability>`
with the revision a manifest declares (current packs use revision `1`).

`launch`, `resume`, `wake`, `maintenance`, and `auth` are effectful: the runner
refuses to exercise them for conformance (`EFFECTFUL_CHECK_FORBIDDEN`), so a Pack
must declare what they need and be verified for them by an explicit, separately
authorized invocation.

## Digest and snapshot rules

- `revision.contentDigest` may be `""` while authoring. Registration computes the
  digest over the snapshot; a non-empty declared digest that does not match the
  content is `INVALID_MANIFEST`.
- Registering the same `packId@revision` with different content is
  `IMMUTABLE_REVISION`; an existing snapshot that no longer matches its digest is
  `CONTENT_DRIFT`; an unknown revision is `PACK_NOT_FOUND`.
- The snapshot root may not be inside the Pack source directory, and the declared
  entrypoint must exist inside the snapshot (`packEntrypoint`).
- Registration itself never invokes the Pack and never scans user configuration.

## Discovery metadata

Discovery metadata in `pack.metadata.discovery` is descriptive for the source
scheduler and is **provisional** — the scheduler and the key names are still being
agreed. Shapes currently in use:

- file packs: `configRoots` / `dataRoots` with kinds `home-relative`,
  `config-relative`, or `environment` (with `variable`), plus
  `executableCandidates` and `capabilities`.
- SQL packs: `configDirectories` / `dataDirectories` with a `base` of
  `xdg-config-home`, `xdg-data-home`, or `home`, plus a relative `path`.

Keep these values truthful: they decide where the scheduler will look, and a wrong
root silently produces empty collection instead of an error.
