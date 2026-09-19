import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import {
  INTEGRATION_CAPABILITIES,
  type CapabilityState,
  type CapabilityImplementation,
  type IntegrationCapability,
  type IntegrationCheckResult,
  type IntegrationDiagnostic,
  type PackManifestFile,
  type PackRegistryOptions,
  type PreparedPackRegistration,
  type RegisteredPackRevision
} from './types.ts'
import { canonicalJson, redactValue, sha256 } from './safety.ts'

export class PackRegistryError extends Error {
  // NOTE: no TypeScript parameter property here — these files run directly
  // under `node file.ts` (Node's strip-only type removal), which rejects
  // parameter properties outright.
  readonly code: 'INVALID_MANIFEST' | 'IMMUTABLE_REVISION' | 'PACK_NOT_FOUND' | 'CONTENT_DRIFT'

  constructor(
    code: 'INVALID_MANIFEST' | 'IMMUTABLE_REVISION' | 'PACK_NOT_FOUND' | 'CONTENT_DRIFT',
    message: string
  ) {
    super(message)
    this.name = 'PackRegistryError'
    this.code = code
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseManifest(raw: unknown): PackManifestFile {
  const root = object(raw)
  const pack = object(root?.pack)
  const revision = object(root?.revision)
  if (root?.schemaVersion !== 1 || !pack || !revision)
    throw new PackRegistryError(
      'INVALID_MANIFEST',
      'manifest must contain schemaVersion 1, pack and revision'
    )
  if (typeof pack.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(pack.id))
    throw new PackRegistryError('INVALID_MANIFEST', 'pack.id is invalid')
  if (
    typeof pack.name !== 'string' ||
    !pack.name.trim() ||
    typeof pack.publisher !== 'string' ||
    !pack.publisher.trim()
  )
    throw new PackRegistryError(
      'INVALID_MANIFEST',
      'pack.name and pack.publisher must be non-empty strings'
    )
  if (!Number.isSafeInteger(pack.createdAt) || Number(pack.createdAt) < 0 || !object(pack.metadata))
    throw new PackRegistryError('INVALID_MANIFEST', 'pack.createdAt and pack.metadata are invalid')
  if (!Number.isSafeInteger(revision.revision) || Number(revision.revision) < 1)
    throw new PackRegistryError('INVALID_MANIFEST', 'revision.revision must be a positive integer')
  if (revision.packId !== pack.id)
    throw new PackRegistryError('INVALID_MANIFEST', 'revision.packId must equal pack.id')
  if (typeof revision.runnerProtocol !== 'string' || !revision.runnerProtocol.trim())
    throw new PackRegistryError(
      'INVALID_MANIFEST',
      'revision.runnerProtocol must be a non-empty string'
    )
  if (!Number.isSafeInteger(revision.createdAt) || Number(revision.createdAt) < 0)
    throw new PackRegistryError(
      'INVALID_MANIFEST',
      'revision.createdAt must be a non-negative integer'
    )
  if (
    !Array.isArray(revision.subjectRefs) ||
    !Array.isArray(revision.requirements) ||
    !Array.isArray(revision.implementations)
  )
    throw new PackRegistryError(
      'INVALID_MANIFEST',
      'revision subjectRefs, requirements and implementations must be arrays'
    )
  for (const rawSubject of revision.subjectRefs) {
    const subject = object(rawSubject)
    const id =
      subject?.kind === 'harness'
        ? subject.harnessId
        : subject?.kind === 'provider'
          ? subject.providerId
          : subject?.kind === 'offering'
            ? subject.offeringId
            : null
    if (typeof id !== 'string' || !id.trim())
      throw new PackRegistryError(
        'INVALID_MANIFEST',
        'revision contains an invalid subject reference'
      )
  }
  for (const rawRequirement of revision.requirements) {
    const requirement = object(rawRequirement)
    if (
      !requirement ||
      typeof requirement.kind !== 'string' ||
      !requirement.kind ||
      typeof requirement.key !== 'string' ||
      !requirement.key ||
      typeof requirement.required !== 'boolean'
    )
      throw new PackRegistryError('INVALID_MANIFEST', 'revision contains an invalid requirement')
  }
  const seen = new Set<string>()
  const implementations = revision.implementations.map((rawImpl): CapabilityImplementation => {
    const impl = object(rawImpl)
    const support = object(impl?.support)
    const contract = object(impl?.contract)
    const entrypoint = object(impl?.entrypoint)
    const limits = object(impl?.limits)
    if (!impl || !INTEGRATION_CAPABILITIES.includes(impl.capability as IntegrationCapability))
      throw new PackRegistryError('INVALID_MANIFEST', 'implementation capability is unknown')
    if (seen.has(String(impl.capability)))
      throw new PackRegistryError(
        'INVALID_MANIFEST',
        `duplicate implementation for ${String(impl.capability)}`
      )
    seen.add(String(impl.capability))
    if (
      typeof impl.id !== 'string' ||
      !impl.id.trim() ||
      !contract ||
      typeof contract.id !== 'string' ||
      !contract.id.trim() ||
      !Number.isSafeInteger(contract.revision) ||
      Number(contract.revision) < 1
    )
      throw new PackRegistryError(
        'INVALID_MANIFEST',
        `implementation ${String(impl.capability)} has an invalid id or contract`
      )
    if (!support || !['implemented', 'unsupported'].includes(String(support.state)))
      throw new PackRegistryError(
        'INVALID_MANIFEST',
        `implementation ${String(impl.capability)} needs an explicit support declaration`
      )
    if (
      support.state === 'unsupported' &&
      (typeof support.reason !== 'string' || !support.reason.trim())
    )
      throw new PackRegistryError(
        'INVALID_MANIFEST',
        `unsupported ${String(impl.capability)} needs a reason`
      )
    if (
      support.state === 'implemented' &&
      (!entrypoint ||
        !['script', 'declarative'].includes(String(entrypoint.mode)) ||
        typeof entrypoint.resource !== 'string' ||
        !entrypoint.resource.trim() ||
        (entrypoint.mode === 'script' &&
          (typeof entrypoint.runtime !== 'string' || !entrypoint.runtime.trim())))
    )
      throw new PackRegistryError(
        'INVALID_MANIFEST',
        `implemented ${String(impl.capability)} needs a structured entrypoint`
      )
    if (support.state === 'unsupported' && entrypoint)
      throw new PackRegistryError(
        'INVALID_MANIFEST',
        `unsupported ${String(impl.capability)} cannot have an entrypoint`
      )
    if (
      !limits ||
      !Number.isSafeInteger(limits.timeoutMs) ||
      Number(limits.timeoutMs) < 1 ||
      !Number.isSafeInteger(limits.maxOutputBytes) ||
      Number(limits.maxOutputBytes) < 1 ||
      (limits.maxBatchRecords != null &&
        (!Number.isSafeInteger(limits.maxBatchRecords) || Number(limits.maxBatchRecords) < 1))
    )
      throw new PackRegistryError(
        'INVALID_MANIFEST',
        `implementation ${String(impl.capability)} needs positive integer limits`
      )
    if (!object(impl.supportDetails))
      throw new PackRegistryError(
        'INVALID_MANIFEST',
        `implementation ${String(impl.capability)} needs structured supportDetails`
      )
    return rawImpl as unknown as CapabilityImplementation
  })
  return {
    schemaVersion: 1,
    pack: {
      id: pack.id,
      name: pack.name,
      publisher: pack.publisher,
      description: typeof pack.description === 'string' ? pack.description : null,
      createdAt: Number(pack.createdAt),
      metadata: object(pack.metadata)!
    },
    revision: {
      packId: pack.id,
      revision: Number(revision.revision),
      contentDigest: typeof revision.contentDigest === 'string' ? revision.contentDigest : '',
      runnerProtocol: revision.runnerProtocol,
      subjectRefs: revision.subjectRefs as never,
      implementations,
      requirements: revision.requirements as never,
      createdAt: Number(revision.createdAt),
      releaseNotes: typeof revision.releaseNotes === 'string' ? revision.releaseNotes : null
    }
  }
}

interface SourceFile {
  path: string
  bytes: Uint8Array
}

function sourceFiles(root: string): SourceFile[] {
  const files: SourceFile[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink())
        throw new PackRegistryError(
          'INVALID_MANIFEST',
          `pack contains a symbolic link: ${relative(root, path)}`
        )
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile())
        files.push({ path: relative(root, path).split(sep).join('/'), bytes: readFileSync(path) })
    }
  }
  walk(root)
  return files
}

function digestFiles(files: readonly SourceFile[], manifest: PackManifestFile): string {
  const normalizedManifest: PackManifestFile = {
    ...manifest,
    revision: { ...manifest.revision, contentDigest: '' }
  }
  const material = files
    .map((file) => {
      const bytes =
        file.path === 'manifest.json' ? Buffer.from(canonicalJson(normalizedManifest)) : file.bytes
      return `${file.path}\0${bytes.byteLength}\0${sha256(bytes)}`
    })
    .join('\n')
  return sha256(material)
}

function safeJoin(root: string, child: string): string {
  const target = resolve(root, child)
  if (target !== root && !target.startsWith(`${root}${sep}`))
    throw new PackRegistryError('INVALID_MANIFEST', `path escapes pack root: ${child}`)
  return target
}

function snapshotFiles(contentRoot: string, digest: string, files: readonly SourceFile[]): string {
  const finalPath = resolve(contentRoot, digest)
  if (statExists(finalPath)) {
    if (!statSync(finalPath).isDirectory())
      throw new PackRegistryError('CONTENT_DRIFT', `snapshot target ${digest} is not a directory`)
    return finalPath
  }
  mkdirSync(contentRoot, { recursive: true })
  const staging = resolve(contentRoot, `.staging-${digest}-${randomUUID()}`)
  mkdirSync(staging)
  try {
    for (const file of files) {
      const target = safeJoin(staging, file.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.bytes, { mode: 0o600 })
    }
    renameSync(staging, finalPath)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    if (!statExists(finalPath)) throw error
  }
  return finalPath
}

function statExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

function rowRevision(row: Record<string, unknown>): RegisteredPackRevision {
  return {
    packId: String(row.pack_id),
    revision: Number(row.revision),
    contentDigest: String(row.content_digest),
    snapshotPath: String(row.snapshot_path),
    manifest: JSON.parse(String(row.manifest_json)) as PackManifestFile,
    registeredAt: Number(row.registered_at)
  }
}

export class PackRegistry {
  readonly db: DatabaseSync
  readonly contentRoot: string
  private readonly now: () => number

  constructor(options: PackRegistryOptions) {
    this.db = options.db
    this.contentRoot = resolve(options.contentRoot)
    this.now = options.now ?? Date.now
  }

  /**
   * The FILESYSTEM half of a registration: read + validate the manifest, hash
   * the content, materialize the immutable snapshot and verify it. Performs NO
   * DB write, so it is safe — and required — to run OUTSIDE a transaction:
   * this is what the deferred `integration.pack.register` operation executes
   * in its effect phase, with no BEGIN holding the single writer.
   */
  prepareRegistration(directory: string): PreparedPackRegistration {
    const root = resolve(directory)
    if (this.contentRoot === root || this.contentRoot.startsWith(`${root}${sep}`))
      throw new PackRegistryError(
        'INVALID_MANIFEST',
        'Pack snapshot storage cannot be inside the source directory'
      )
    // An unreadable source directory is a BUSINESS failure, not an
    // infrastructure fault: nothing was applied, and the caller may retry
    // ('same-operation') once the directory exists. Keep it a PackRegistryError
    // so the deferred admission releases its durable row instead of parking the
    // effect as 'unknown'.
    let rawManifest: unknown
    try {
      rawManifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
    } catch (error) {
      throw new PackRegistryError(
        'INVALID_MANIFEST',
        `cannot read manifest.json in ${root}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    const manifest = parseManifest(rawManifest)
    const files = sourceFiles(root)
    const digest = digestFiles(files, manifest)
    if (manifest.revision.contentDigest !== '' && manifest.revision.contentDigest !== digest)
      throw new PackRegistryError(
        'INVALID_MANIFEST',
        'declared contentDigest does not match pack content'
      )
    const existing = this.find(manifest.pack.id, manifest.revision.revision)
    if (existing) {
      if (existing.contentDigest !== digest)
        throw new PackRegistryError(
          'IMMUTABLE_REVISION',
          `pack revision ${manifest.pack.id}@${manifest.revision.revision} is already registered with different content`
        )
      return {
        manifest,
        storedManifest: existing.manifest,
        digest,
        snapshotPath: existing.snapshotPath,
        existing,
        registeredAt: existing.registeredAt
      }
    }
    const snapshotPath = snapshotFiles(this.contentRoot, digest, files)
    const storedManifest: PackManifestFile = {
      ...manifest,
      revision: { ...manifest.revision, contentDigest: digest }
    }
    if (digestFiles(sourceFiles(snapshotPath), storedManifest) !== digest)
      throw new PackRegistryError(
        'CONTENT_DRIFT',
        'existing Pack snapshot does not match the registered content digest'
      )
    return {
      manifest,
      storedManifest,
      digest,
      snapshotPath,
      existing: null,
      registeredAt: this.now()
    }
  }

  /**
   * The DB half: insert integration_packs / integration_pack_revisions /
   * integration_capability_implementations for a prepared registration. Pure
   * row writes — the deferred operation runs this in the completion
   * transaction, in the same COMMIT as its receipt.
   */
  commitRegistration(prepared: PreparedPackRegistration): RegisteredPackRevision {
    if (prepared.existing) return prepared.existing
    const { manifest, storedManifest, digest, snapshotPath, registeredAt } = prepared
    this.db.exec('SAVEPOINT integration_pack_register')
    try {
      this.db
        .prepare(
          'INSERT INTO integration_packs(id,label,subject_refs_json,requirements_json,created_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING'
        )
        .run(
          manifest.pack.id,
          manifest.pack.name,
          JSON.stringify(manifest.revision.subjectRefs),
          JSON.stringify(manifest.revision.requirements),
          registeredAt
        )
      this.db
        .prepare(
          'INSERT INTO integration_pack_revisions(pack_id,revision,content_digest,manifest_json,snapshot_path,registered_at) VALUES (?,?,?,?,?,?)'
        )
        .run(
          manifest.pack.id,
          manifest.revision.revision,
          digest,
          JSON.stringify(storedManifest),
          snapshotPath,
          registeredAt
        )
      const insert = this.db.prepare(
        "INSERT INTO integration_capability_implementations(pack_id,pack_revision,capability,contract_revision,mode,support_status,support_reason,implementation_json,check_status,semantics_verified,diagnostics_json) VALUES (?,?,?,?,?,?,?,?,'unchecked',0,'[]')"
      )
      for (const impl of manifest.revision.implementations)
        insert.run(
          manifest.pack.id,
          manifest.revision.revision,
          impl.capability,
          impl.contract.revision,
          impl.entrypoint?.mode ?? 'declarative',
          impl.support.state,
          impl.support.state === 'unsupported' ? impl.support.reason : null,
          JSON.stringify(impl)
        )
      this.db.exec('RELEASE integration_pack_register')
    } catch (error) {
      this.db.exec('ROLLBACK TO integration_pack_register')
      this.db.exec('RELEASE integration_pack_register')
      throw error
    }
    return {
      packId: manifest.pack.id,
      revision: manifest.revision.revision,
      contentDigest: digest,
      snapshotPath,
      manifest: storedManifest,
      registeredAt
    }
  }

  /**
   * prepare + commit in one call. The synchronous boot path uses this (the
   * runtime service is not serving yet, so there is no admission transaction
   * to share); interactive/runtime registration goes through the operation,
   * which admits durably first and commits afterwards.
   */
  registerDirectory(directory: string): RegisteredPackRevision {
    return this.commitRegistration(this.prepareRegistration(directory))
  }

  find(packId: string, revision: number): RegisteredPackRevision | null {
    const row = this.db
      .prepare('SELECT * FROM integration_pack_revisions WHERE pack_id=? AND revision=?')
      .get(packId, revision)
    return row ? rowRevision(row) : null
  }

  list(): RegisteredPackRevision[] {
    return this.db
      .prepare('SELECT * FROM integration_pack_revisions ORDER BY pack_id, revision')
      .all()
      .map(rowRevision)
  }

  resolve(packId: string, revision: number): RegisteredPackRevision {
    const found = this.find(packId, revision)
    if (!found)
      throw new PackRegistryError(
        'PACK_NOT_FOUND',
        `pack revision ${packId}@${revision} is not registered`
      )
    const files = sourceFiles(found.snapshotPath)
    if (digestFiles(files, found.manifest) !== found.contentDigest)
      throw new PackRegistryError(
        'CONTENT_DRIFT',
        `registered snapshot ${packId}@${revision} no longer matches its digest`
      )
    return found
  }

  implementation(
    packId: string,
    revision: number,
    capability: IntegrationCapability
  ): CapabilityImplementation | null {
    const row = this.db
      .prepare(
        'SELECT implementation_json FROM integration_capability_implementations WHERE pack_id=? AND pack_revision=? AND capability=?'
      )
      .get(packId, revision, capability)
    return row ? (JSON.parse(String(row.implementation_json)) as CapabilityImplementation) : null
  }

  capabilityState(
    packId: string,
    revision: number,
    capability: IntegrationCapability
  ): CapabilityState {
    const row = this.db
      .prepare(
        'SELECT * FROM integration_capability_implementations WHERE pack_id=? AND pack_revision=? AND capability=?'
      )
      .get(packId, revision, capability)
    if (!row)
      return {
        packId,
        packRevision: revision,
        capability,
        support: 'undeclared',
        check: 'unchecked',
        semanticsVerified: false,
        diagnostics: []
      }
    return {
      packId,
      packRevision: revision,
      capability,
      support: String(row.support_status) as CapabilityState['support'],
      ...(row.support_reason ? { supportReason: String(row.support_reason) } : {}),
      implementationId: String(
        (JSON.parse(String(row.implementation_json)) as CapabilityImplementation).id
      ),
      contractRevision: Number(row.contract_revision),
      check: String(row.check_status) as IntegrationCheckResult,
      ...(row.checked_at ? { checkedAt: Number(row.checked_at) } : {}),
      semanticsVerified: Number(row.semantics_verified) === 1,
      diagnostics: JSON.parse(String(row.diagnostics_json)) as IntegrationDiagnostic[]
    }
  }

  recordCheck(input: {
    packId: string
    packRevision: number
    implementationId: string
    capability: IntegrationCapability
    contractId: string
    contractRevision: number
    target: unknown
    result: Exclude<IntegrationCheckResult, 'unchecked'>
    semanticsVerified: boolean
    diagnostics: readonly IntegrationDiagnostic[]
    evidence?: unknown
  }): string {
    const id = randomUUID()
    const checkedAt = this.now()
    const diagnostics = redactValue(input.diagnostics) as IntegrationDiagnostic[]
    this.db.exec('SAVEPOINT integration_check_record')
    try {
      this.db
        .prepare(
          'INSERT INTO integration_checks(id,pack_id,pack_revision,implementation_id,capability,contract_id,contract_revision,target_json,checked_at,result,semantics_verified,evidence_json,diagnostics_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
        )
        .run(
          id,
          input.packId,
          input.packRevision,
          input.implementationId,
          input.capability,
          input.contractId,
          input.contractRevision,
          JSON.stringify(input.target),
          checkedAt,
          input.result,
          input.semanticsVerified ? 1 : 0,
          JSON.stringify(redactValue(input.evidence ?? [])),
          JSON.stringify(diagnostics)
        )
      this.db
        .prepare(
          'UPDATE integration_capability_implementations SET check_status=?,semantics_verified=?,checked_at=?,diagnostics_json=? WHERE pack_id=? AND pack_revision=? AND capability=?'
        )
        .run(
          input.result,
          input.semanticsVerified ? 1 : 0,
          checkedAt,
          JSON.stringify(diagnostics),
          input.packId,
          input.packRevision,
          input.capability
        )
      this.db.exec('RELEASE integration_check_record')
    } catch (error) {
      this.db.exec('ROLLBACK TO integration_check_record')
      this.db.exec('RELEASE integration_check_record')
      throw error
    }
    return id
  }

  openIssue(input: {
    packId: string
    packRevision: number
    capability: IntegrationCapability
    target: unknown
    reason: string
    evidence?: unknown
    diagnostics?: readonly IntegrationDiagnostic[]
  }): string {
    const id = randomUUID()
    this.db
      .prepare(
        "INSERT INTO integration_issues(id,pack_id,pack_revision,capability,target_json,reason,detected_at,status,evidence_json,diagnostics_json) VALUES (?,?,?,?,?,?,?,'open',?,?)"
      )
      .run(
        id,
        input.packId,
        input.packRevision,
        input.capability,
        JSON.stringify(input.target),
        input.reason,
        this.now(),
        JSON.stringify(redactValue(input.evidence ?? [])),
        JSON.stringify(redactValue(input.diagnostics ?? []))
      )
    return id
  }
}

export function packEntrypoint(revision: RegisteredPackRevision, entrypoint: string): string {
  const target = safeJoin(revision.snapshotPath, entrypoint)
  if (!statExists(target) || !statSync(target).isFile())
    throw new PackRegistryError(
      'INVALID_MANIFEST',
      `entrypoint does not exist: ${basename(entrypoint)}`
    )
  return target
}
