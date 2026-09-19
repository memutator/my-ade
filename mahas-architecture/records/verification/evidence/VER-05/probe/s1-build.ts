// VER-05 s1 — role implementation → mandatory bytes (spec/injection.md §1–3).
//
//   s1a  the REAL authored-impl path: implementation.prepare/publish rows as
//        they actually exist → real `context.build` op — expected to prove the
//        IMP-07 storage shape ↔ IMP-08 compiler contract break.
//   s1b  compiler-contract impls (seeded in the shape context.build itself
//        declares for implementation_components) → real `context.build` op →
//        compare mandatory bytes for the SAME source across the three roles;
//        reexpressed parent source must NOT be auto-injected.
//   s1c  negative cases — every one must be rejected before launch.
//   s1d  real `worker.prepare` — happy path + stale/denied/missing variants.
import { renameSync } from 'node:fs'
import { join } from 'node:path'
import {
  Recorder, wire, opCtx, memberCtx, loadState, sha256File, sha256Text, sha256Hex,
  REPO_ROOT, CHECKOUT_A, q1
} from './common.ts'
import { SHARED_SRC, CHARTER_SRC, TASK_ACTIONS } from './fixture.ts'
import { buildTaskEnvelope, buildCoordinationEnvelope } from 'file:///tmp/mahas-ver-05/src/packages/mahas-runtime/src/coordination/work-envelope.ts'

const rec = new Recorder('s1-build')
const w = await wire('s1')
const fx = loadState().fixture as Record<string, any>
const hostId = String(fx.hostId)
const sharedSha = String(fx.sourcePins[SHARED_SRC])
const charterSha = String(fx.sourcePins[CHARTER_SRC])
const ctx = opCtx()

// ---------- helpers ---------------------------------------------------------

/** command_surfaces row. `shape`:
 *  - 'compiler': {actions:[{name}…]} — the shape surfaceActionList can read
 *  - 'planner': {allowed:[…]} — the shape workerPrepare actually mints
 *    (planner.ts:453-461) — kept to document the cross-boundary break. */
function mintSurface(actions: string[], shape: 'compiler' | 'planner' = 'compiler'): string {
  const payload =
    shape === 'compiler'
      ? { actions: [...new Set(actions)].sort().map((name) => ({ name })) }
      : { allowed: [...new Set(actions)].sort() }
  const surfaceDoc = {
    actionsAndSchemas: payload,
    policyPins: { grantId: 'ver05-fixture', grantRevision: 1 }
  }
  const digest = sha256Hex(JSON.stringify(surfaceDoc))
  w.db
    .prepare(
      'INSERT OR IGNORE INTO command_surfaces(digest,actions_and_schemas_json,policy_pins_json) VALUES(?,?,?)'
    )
    .run(digest, JSON.stringify(surfaceDoc.actionsAndSchemas), JSON.stringify(surfaceDoc.policyPins))
  return digest
}
const surfaceDigest = mintSurface(TASK_ACTIONS)
const plannerShapeSurface = mintSurface(TASK_ACTIONS, 'planner')

interface SeedComponent {
  id: string
  kind: string
  activation: 'initial' | 'conditional'
  binding: Record<string, unknown>
  consumes?: string[]
  coverage: { clauseId: string; sectionKey?: string; realization: string; requiredLoadPhase: string }[]
}
/** implementation_components row in the shape compiler.ts:325-364 declares —
 *  activation bare string, binding.sections, coverage requiredLoadPhase in
 *  inline|preload|catalog. Documented fixture at the compiler's contract; the
 *  authoring op cannot emit this shape at 83a6d21 (see s1a evidence). */
function seedImpl(
  implId: string,
  roleId: string,
  components: SeedComponent[],
  profileId = 'hp-main',
  profileRev = Number(fx.profileRevision),
  ifaceDigest?: string
): { implId: string; revision: number } {
  w.db.prepare('DELETE FROM implementation_components WHERE implementation_id=?').run(implId)
  w.db
    .prepare(
      "INSERT OR REPLACE INTO role_implementations(id,revision,interface_digest,profile_id,profile_revision,status,maintainer_role_id,semantic_decision) VALUES(?,1,?,?,?,'published','r-lead',NULL)"
    )
    .run(implId, ifaceDigest ?? String(fx.ifaceDigest[roleId]), profileId, profileRev)
  for (const c of components) {
    w.db
      .prepare(
        'INSERT INTO implementation_components(implementation_id,implementation_revision,id,kind,activation,binding_json,consumes_json,coverage_json) VALUES(?,1,?,?,?,?,?,?)'
      )
      .run(
        implId,
        c.id,
        c.kind,
        c.activation,
        JSON.stringify(c.binding),
        JSON.stringify(c.consumes ?? []),
        JSON.stringify(c.coverage)
      )
  }
  return { implId, revision: 1 }
}

async function build(
  implId: string,
  ifaceDigest: string,
  opts: {
    pins?: unknown
    sourceRoot?: string
    surface?: string
    ctx?: Record<string, unknown>
  } = {}
): Promise<{ receipt: unknown; error?: { code: string; message: string } }> {
  const r = await w.dispatch(opts.ctx ?? ctx, 'context.build', {
    interfaceDigest: ifaceDigest,
    implementationId: implId,
    implementationRevision: 1,
    surfaceDigest: opts.surface ?? surfaceDigest,
    ...(opts.pins !== undefined ? { sourceSnapshotPins: opts.pins } : {}),
    ...(opts.sourceRoot !== undefined ? { sourceRoot: opts.sourceRoot } : {})
  })
  return { receipt: r, error: r.error }
}

const code = (e: { code?: string } | undefined) => e?.code ?? '(none)'

// ---------- s1a: authored impls through the REAL context.build op ------------
for (const roleId of ['r-lead', 'r-asm', 'r-tool']) {
  const impl = fx.impls[roleId]
  const { receipt, error } = await build(impl.implId, String(fx.ifaceDigest[roleId]), {
    pins: [
      { path: SHARED_SRC, digest: sharedSha },
      { path: CHARTER_SRC, digest: charterSha }
    ],
    sourceRoot: REPO_ROOT
  })
  const r = receipt as { status: string; error?: { code: string; message: string } }
  rec.check(
    `s1a.authored.${roleId}`,
    r.status !== 'committed',
    'rejected (authored storage shape ≠ compiler contract)',
    `${r.status} ${code(error)}`
  )
  rec.artifact(`s1a.authored.${roleId}`, { implId: impl.implId, status: r.status, error })
}
// what did the authoring op actually store? — the storage/compiler seam evidence
rec.artifact(
  's1a.storedRows',
  w.db
    .prepare('SELECT id,kind,activation,binding_json,coverage_json FROM implementation_components ORDER BY implementation_id,id')
    .all()
)

// ---------- s1b: compiler-contract impls — same source, three roles ----------
const CLAUSES = { shared: 'context:ctx-shared', charter: 'context:ctx-charter', crit: 'criterion:crit-root-1' }
const REX = 'VER-05 authored reexpression — the charter restated in role words (no original bytes).'

const implLead = seedImpl('impl-v5-lead', 'r-lead', [
  {
    id: 'ctx-verbatim',
    kind: 'instruction',
    activation: 'initial',
    binding: {
      sections: [
        { key: 'shared', source: { path: SHARED_SRC } },
        { key: 'charter-rex', text: REX },
        { key: 'crit', text: 'VER-05 criterion coverage — authored.' }
      ]
    },
    coverage: [
      { clauseId: CLAUSES.shared, sectionKey: 'shared', realization: 'verbatim', requiredLoadPhase: 'inline' },
      { clauseId: CLAUSES.charter, sectionKey: 'charter-rex', realization: 'reexpressed', requiredLoadPhase: 'inline' },
      { clauseId: CLAUSES.crit, sectionKey: 'crit', realization: 'reexpressed', requiredLoadPhase: 'inline' }
    ]
  }
])

const implAsm = seedImpl('impl-v5-asm', 'r-asm', [
  {
    id: 'ctx-verbatim',
    kind: 'instruction',
    activation: 'initial',
    binding: {
      sections: [
        { key: 'shared', source: { path: SHARED_SRC } },
        { key: 'crit', text: 'VER-05 criterion coverage — authored.' }
      ]
    },
    coverage: [
      { clauseId: CLAUSES.shared, sectionKey: 'shared', realization: 'verbatim', requiredLoadPhase: 'inline' },
      { clauseId: CLAUSES.crit, sectionKey: 'crit', realization: 'reexpressed', requiredLoadPhase: 'inline' }
    ]
  },
  {
    id: 'asm-skill',
    kind: 'skill',
    activation: 'initial',
    binding: {
      name: 'assembly-runbook',
      sections: [{ key: 'charter-rex', text: REX }]
    },
    coverage: [
      { clauseId: CLAUSES.charter, sectionKey: 'charter-rex', realization: 'reexpressed', requiredLoadPhase: 'preload' }
    ]
  }
])

const implTool = seedImpl('impl-v5-tool', 'r-tool', [
  {
    id: 'ctx-verbatim',
    kind: 'instruction',
    activation: 'initial',
    binding: {
      sections: [
        { key: 'shared', source: { path: SHARED_SRC } },
        { key: 'charter-rex', text: REX },
        { key: 'crit', text: 'VER-05 criterion coverage — authored.' }
      ]
    },
    coverage: [
      { clauseId: CLAUSES.shared, sectionKey: 'shared', realization: 'verbatim', requiredLoadPhase: 'inline' },
      { clauseId: CLAUSES.charter, sectionKey: 'charter-rex', realization: 'reexpressed', requiredLoadPhase: 'inline' },
      { clauseId: CLAUSES.crit, sectionKey: 'crit', realization: 'reexpressed', requiredLoadPhase: 'inline' }
    ]
  },
  {
    id: 'toolbelt',
    kind: 'tool-config',
    activation: 'initial',
    binding: { name: 'ver05-toolbelt', requiredActions: ['artifact.read'], tools: { list: ['fs.read'] } },
    coverage: []
  }
])

const built: Record<string, { bundleDigest: string; requiredTextDigest: string; manifest: any; text?: string }> = {}
for (const [roleId, impl] of [
  ['r-lead', implLead],
  ['r-asm', implAsm],
  ['r-tool', implTool]
] as const) {
  const { receipt, error } = await build(impl.implId, String(fx.ifaceDigest[roleId]), {
    pins: [
      { path: SHARED_SRC, digest: sharedSha },
      { path: CHARTER_SRC, digest: charterSha }
    ],
    sourceRoot: REPO_ROOT
  })
  const r = receipt as { status: string; result?: any; error?: { code: string } }
  rec.check(`s1b.build.${roleId}`, r.status === 'committed', 'context.build committed', `${r.status} ${code(error)}`)
  if (r.status === 'committed') {
    const res = r.result as { bundleDigest: string; requiredTextDigest: string; manifest: any }
    built[roleId] = res
    const blob = q1(w.db, 'SELECT body FROM content_blobs WHERE digest=?', res.requiredTextDigest)
    built[roleId].text = blob ? Buffer.from(blob.body as Uint8Array).toString('utf8') : undefined
    rec.artifact(`s1b.manifest.${roleId}`, res.manifest)
  }
}

const sharedText = (await import('node:fs')).readFileSync(join(REPO_ROOT, SHARED_SRC), 'utf8')
const charterText = (await import('node:fs')).readFileSync(join(REPO_ROOT, CHARTER_SRC), 'utf8')
for (const roleId of ['r-lead', 'r-asm', 'r-tool']) {
  const text = built[roleId]?.text ?? ''
  rec.check(
    `s1b.mandatory.hasSource.${roleId}`,
    text.includes('SHARED-MARKER-7f3a91') && text.includes(sharedText.trim()),
    'verbatim source bytes inside mandatory text',
    text.includes('SHARED-MARKER-7f3a91') ? 'marker+bytes present' : 'absent'
  )
  rec.check(
    `s1b.mandatory.noCharterAuto.${roleId}`,
    !text.includes('CHARTER-MARKER-4c2e08') && !text.includes(charterText.trim()),
    'parent long-form NOT auto-injected (reexpressed binding)',
    text.includes('CHARTER-MARKER-4c2e08') ? 'LEAKED parent bytes' : 'absent'
  )
}
// the three mandatory texts share the identical verbatim source block
const texts = ['r-lead', 'r-asm', 'r-tool'].map((r) => built[r]?.text ?? '')
rec.check(
  's1b.sameBytesAcrossRoles',
  texts.every((t) => t.includes(sharedText.trim())),
  'identical source bytes in all 3 roles',
  `${texts.filter((t) => t.includes(sharedText.trim())).length}/3 carry bytes`
)
rec.artifact('s1b.mandatoryDigests', Object.fromEntries(
  Object.entries(built).map(([r, b]) => [r, { bundleDigest: b.bundleDigest, requiredTextDigest: b.requiredTextDigest, textDigest: b.text ? sha256Text(b.text) : null }])
))

// ---------- s1c: negative cases — rejected before launch ---------------------
const PIN_OK = [{ path: SHARED_SRC, digest: sharedSha }, { path: CHARTER_SRC, digest: charterSha }]

async function neg(
  name: string,
  expectedCode: string,
  fn: () => Promise<{ receipt: any; error?: { code: string; message: string } }>
): Promise<void> {
  const { receipt, error } = await fn()
  const r = receipt as { status: string }
  rec.check(
    `s1c.${name}`,
    r.status !== 'committed' && code(error) === expectedCode,
    `rejected ${expectedCode}`,
    `${r.status} ${code(error)}`,
    error?.message?.slice(0, 200)
  )
  rec.artifact(`s1c.${name}`, { status: r.status, error })
}

// conditional-only required skill → MANDATORY_COMPONENT_MISSING
const implCondSkill = seedImpl('impl-v5-condskill', 'r-asm', [
  {
    id: 'core', kind: 'instruction', activation: 'initial',
    binding: { sections: [{ key: 'crit', text: 'x' }, { key: 'c', text: 'y' }] },
    coverage: [
      { clauseId: CLAUSES.crit, sectionKey: 'crit', realization: 'reexpressed', requiredLoadPhase: 'inline' },
      { clauseId: CLAUSES.charter, sectionKey: 'c', realization: 'reexpressed', requiredLoadPhase: 'inline' }
    ]
  },
  {
    id: 'lazy-skill', kind: 'skill', activation: 'conditional',
    binding: { sections: [{ key: 's', text: 'skill body' }] },
    coverage: [
      { clauseId: CLAUSES.shared, sectionKey: 's', realization: 'reexpressed', requiredLoadPhase: 'catalog' }
    ]
  }
])
await neg('conditionalOnlySkill', 'MANDATORY_COMPONENT_MISSING', () =>
  build(implCondSkill.implId, String(fx.ifaceDigest['r-asm']), { pins: PIN_OK, sourceRoot: REPO_ROOT })
)

// component file removed → SNAPSHOT_REQUIRED
renameSync(join(REPO_ROOT, SHARED_SRC), join(REPO_ROOT, SHARED_SRC + '.gone'))
await neg('componentFileRemoved', 'SNAPSHOT_REQUIRED', () =>
  build(implLead.implId, String(fx.ifaceDigest['r-lead']), { pins: PIN_OK, sourceRoot: REPO_ROOT })
)
renameSync(join(REPO_ROOT, SHARED_SRC + '.gone'), join(REPO_ROOT, SHARED_SRC))

// stale source pin → INTERFACE_STALE
await neg('staleSourcePin', 'INTERFACE_STALE', () =>
  build(implLead.implId, String(fx.ifaceDigest['r-lead']), {
    pins: [
      { path: SHARED_SRC, digest: '0'.repeat(64) },
      { path: CHARTER_SRC, digest: charterSha }
    ],
    sourceRoot: REPO_ROOT
  })
)

// stale interface digest → INTERFACE_STALE
await neg('staleInterface', 'INTERFACE_STALE', () =>
  build(implLead.implId, String(fx.ifaceDigest['r-tool']), { pins: PIN_OK, sourceRoot: REPO_ROOT })
)

// out-of-scope required action → REQUIRED_ACTION_DENIED
const implBadTool = seedImpl('impl-v5-badtool', 'r-tool', [
  {
    id: 'ctx', kind: 'instruction', activation: 'initial',
    binding: { sections: [{ key: 'a', text: 'x' }, { key: 'b', text: 'y' }, { key: 'c', text: 'z' }] },
    coverage: [
      { clauseId: CLAUSES.shared, sectionKey: 'a', realization: 'reexpressed', requiredLoadPhase: 'inline' },
      { clauseId: CLAUSES.charter, sectionKey: 'b', realization: 'reexpressed', requiredLoadPhase: 'inline' },
      { clauseId: CLAUSES.crit, sectionKey: 'c', realization: 'reexpressed', requiredLoadPhase: 'inline' }
    ]
  },
  {
    id: 'evil-tool', kind: 'tool-config', activation: 'initial',
    binding: { name: 'evil', requiredActions: ['admin.nuke'], tools: {} },
    coverage: []
  }
])
await neg('outOfScopeAction', 'REQUIRED_ACTION_DENIED', () =>
  build(implBadTool.implId, String(fx.ifaceDigest['r-tool']), { pins: PIN_OK, sourceRoot: REPO_ROOT })
)

// reexpressed clause still pulling original source → MODEL_INVALID
const implRexLeak = seedImpl('impl-v5-rexleak', 'r-asm', [
  {
    id: 'ctx', kind: 'instruction', activation: 'initial',
    binding: {
      sections: [
        { key: 'orig', source: { path: SHARED_SRC } },
        { key: 'rex', text: REX },
        { key: 'b', text: 'y' },
        { key: 'c', text: 'z' }
      ]
    },
    coverage: [
      { clauseId: CLAUSES.shared, sectionKey: 'orig', realization: 'verbatim', requiredLoadPhase: 'inline' },
      { clauseId: CLAUSES.shared, sectionKey: 'rex', realization: 'reexpressed', requiredLoadPhase: 'inline' },
      { clauseId: CLAUSES.charter, sectionKey: 'b', realization: 'reexpressed', requiredLoadPhase: 'inline' },
      { clauseId: CLAUSES.crit, sectionKey: 'c', realization: 'reexpressed', requiredLoadPhase: 'inline' }
    ]
  }
])
await neg('reexpressedOriginalLeak', 'MODEL_INVALID', () =>
  build(implRexLeak.implId, String(fx.ifaceDigest['r-asm']), { pins: PIN_OK, sourceRoot: REPO_ROOT })
)

// conflicting sourceSnapshotPins → MODEL_INVALID
await neg('conflictingPins', 'MODEL_INVALID', () =>
  build(implLead.implId, String(fx.ifaceDigest['r-lead']), {
    pins: [
      { path: SHARED_SRC, digest: sharedSha },
      { path: SHARED_SRC, digest: '1'.repeat(64) },
      { path: CHARTER_SRC, digest: charterSha }
    ],
    sourceRoot: REPO_ROOT
  })
)

// verbatim section, source not pinned → SNAPSHOT_REQUIRED
await neg('unpinnedSource', 'SNAPSHOT_REQUIRED', () =>
  build(implLead.implId, String(fx.ifaceDigest['r-lead']), {
    pins: [{ path: CHARTER_SRC, digest: charterSha }],
    sourceRoot: REPO_ROOT
  })
)

// duplicate installPath inside one impl → MODEL_INVALID
const implDupPath = seedImpl('impl-v5-duppath', 'r-asm', [
  {
    id: 'a', kind: 'instruction', activation: 'initial',
    binding: { installPath: 'role/components/instructions/same.md', sections: [{ key: 'a', text: 'x' }, { key: 'b', text: 'y' }, { key: 'c', text: 'z' }] },
    coverage: [
      { clauseId: CLAUSES.shared, sectionKey: 'a', realization: 'reexpressed', requiredLoadPhase: 'inline' },
      { clauseId: CLAUSES.charter, sectionKey: 'b', realization: 'reexpressed', requiredLoadPhase: 'inline' },
      { clauseId: CLAUSES.crit, sectionKey: 'c', realization: 'reexpressed', requiredLoadPhase: 'inline' }
    ]
  },
  {
    id: 'b', kind: 'instruction', activation: 'conditional',
    binding: { installPath: 'role/components/instructions/same.md', sections: [{ key: 'd', text: 'w' }] },
    coverage: []
  }
])
await neg('duplicateInstallPath', 'MODEL_INVALID', () =>
  build(implDupPath.implId, String(fx.ifaceDigest['r-asm']), { pins: PIN_OK, sourceRoot: REPO_ROOT })
)

// secret-shaped field in binding → MODEL_INVALID
const implSecret = seedImpl('impl-v5-secret', 'r-tool', [
  {
    id: 'ctx', kind: 'instruction', activation: 'initial',
    binding: { sections: [{ key: 'a', text: 'x' }, { key: 'b', text: 'y' }, { key: 'c', text: 'z' }] },
    coverage: [
      { clauseId: CLAUSES.shared, sectionKey: 'a', realization: 'reexpressed', requiredLoadPhase: 'inline' },
      { clauseId: CLAUSES.charter, sectionKey: 'b', realization: 'reexpressed', requiredLoadPhase: 'inline' },
      { clauseId: CLAUSES.crit, sectionKey: 'c', realization: 'reexpressed', requiredLoadPhase: 'inline' }
    ]
  },
  { id: 't', kind: 'tool-config', activation: 'initial', binding: { name: 't', tools: { auth: { apiKey: 's3cr3t' } } }, coverage: [] }
])
await neg('secretInBinding', 'MODEL_INVALID', () =>
  build(implSecret.implId, String(fx.ifaceDigest['r-tool']), { pins: PIN_OK, sourceRoot: REPO_ROOT })
)

// launch-config carrying an executable recipe key → MODEL_INVALID
const implExecCfg = seedImpl('impl-v5-execcfg', 'r-tool', [
  {
    id: 'ctx', kind: 'instruction', activation: 'initial',
    binding: { sections: [{ key: 'a', text: 'x' }, { key: 'b', text: 'y' }, { key: 'c', text: 'z' }] },
    coverage: [
      { clauseId: CLAUSES.shared, sectionKey: 'a', realization: 'reexpressed', requiredLoadPhase: 'inline' },
      { clauseId: CLAUSES.charter, sectionKey: 'b', realization: 'reexpressed', requiredLoadPhase: 'inline' },
      { clauseId: CLAUSES.crit, sectionKey: 'c', realization: 'reexpressed', requiredLoadPhase: 'inline' }
    ]
  },
  { id: 'lc', kind: 'launch-config', activation: 'initial', binding: { name: 'lc', launch: { argv: ['/bin/sh'] } }, coverage: [] }
])
await neg('launchConfigExecKey', 'MODEL_INVALID', () =>
  build(implExecCfg.implId, String(fx.ifaceDigest['r-tool']), { pins: PIN_OK, sourceRoot: REPO_ROOT })
)

// catalog binding on an initial component → MODEL_INVALID
const implCatalogInit = seedImpl('impl-v5-cataloginit', 'r-asm', [
  {
    id: 'ctx', kind: 'instruction', activation: 'initial',
    binding: { sections: [{ key: 'a', text: 'x' }, { key: 'b', text: 'y' }, { key: 'c', text: 'z' }] },
    coverage: [
      { clauseId: CLAUSES.shared, sectionKey: 'a', realization: 'reexpressed', requiredLoadPhase: 'inline' },
      { clauseId: CLAUSES.charter, sectionKey: 'b', realization: 'reexpressed', requiredLoadPhase: 'inline' },
      { clauseId: CLAUSES.crit, sectionKey: 'c', realization: 'reexpressed', requiredLoadPhase: 'catalog' }
    ]
  }
])
await neg('catalogOnInitial', 'MODEL_INVALID', () =>
  build(implCatalogInit.implId, String(fx.ifaceDigest['r-asm']), { pins: PIN_OK, sourceRoot: REPO_ROOT })
)

// preload route not declared by profile → INJECTION_UNSUPPORTED
w.db
  .prepare(
    "INSERT OR REPLACE INTO harness_profiles(id,revision,state,recipe_json,capabilities_json,executable_identity_json) VALUES('hp-nopreload',1,'verified',?,?,?)"
  )
  .run(
    JSON.stringify({ recipeVersion: 1, injection: { routes: ['instruction-file'] }, resume: null, wake: null, settingsPolicy: null }),
    JSON.stringify({ supportedComponents: ['instruction', 'skill'], injectionRoutes: ['instruction-file'], resume: false, wake: false }),
    JSON.stringify({ locator: '/usr/bin/mahas-ver05-harness', versionRange: '>=1.0.0 <2.0.0' })
  )
const implNoPreload = seedImpl('impl-v5-nopreload', 'r-asm', [
  {
    id: 'ctx', kind: 'instruction', activation: 'initial',
    binding: { sections: [{ key: 'a', text: 'x' }, { key: 'b', text: 'y' }] },
    coverage: [
      { clauseId: CLAUSES.shared, sectionKey: 'a', realization: 'reexpressed', requiredLoadPhase: 'inline' },
      { clauseId: CLAUSES.charter, sectionKey: 'b', realization: 'reexpressed', requiredLoadPhase: 'inline' }
    ]
  },
  {
    id: 'sk', kind: 'skill', activation: 'initial',
    binding: { name: 'sk', sections: [{ key: 'c', text: 'crit' }] },
    coverage: [{ clauseId: CLAUSES.crit, sectionKey: 'c', realization: 'reexpressed', requiredLoadPhase: 'preload' }]
  }
], 'hp-nopreload', 1)
await neg('preloadRouteMissing', 'INJECTION_UNSUPPORTED', () =>
  build(implNoPreload.implId, String(fx.ifaceDigest['r-asm']), { pins: PIN_OK, sourceRoot: REPO_ROOT })
)

// unsupported component kind → INJECTION_UNSUPPORTED
const implBadKind = seedImpl('impl-v5-badkind', 'r-asm', [
  {
    id: 'ctx', kind: 'instruction', activation: 'initial',
    binding: { sections: [{ key: 'a', text: 'x' }, { key: 'b', text: 'y' }] },
    coverage: [
      { clauseId: CLAUSES.shared, sectionKey: 'a', realization: 'reexpressed', requiredLoadPhase: 'inline' },
      { clauseId: CLAUSES.charter, sectionKey: 'b', realization: 'reexpressed', requiredLoadPhase: 'inline' }
    ]
  },
  {
    id: 'sk', kind: 'subagent', activation: 'initial',
    binding: { sections: [{ key: 'c', text: 'crit' }] },
    coverage: [{ clauseId: CLAUSES.crit, sectionKey: 'c', realization: 'reexpressed', requiredLoadPhase: 'inline' }]
  }
], 'hp-nopreload', 1)
await neg('unsupportedKind', 'INJECTION_UNSUPPORTED', () =>
  build(implBadKind.implId, String(fx.ifaceDigest['r-asm']), { pins: PIN_OK, sourceRoot: REPO_ROOT })
)

// surface snapshot absent → SNAPSHOT_REQUIRED
await neg('surfaceMissing', 'SNAPSHOT_REQUIRED', () =>
  build(implLead.implId, String(fx.ifaceDigest['r-lead']), {
    pins: PIN_OK,
    sourceRoot: REPO_ROOT,
    surface: 'f'.repeat(64)
  })
)

// the planner's own call shape — sourceSnapshotPins as object → MODEL_INVALID
await neg('pinsAsObject', 'MODEL_INVALID', () =>
  build(implLead.implId, String(fx.ifaceDigest['r-lead']), {
    pins: { assignmentId: 'asg-x', assignmentRevision: 1 },
    sourceRoot: REPO_ROOT
  })
)

// planner-shape surface ({allowed:[…]}) — the shape workerPrepare itself
// mints at planner.ts:453-461. context.build reads it as ONE pseudo-action
// named 'allowed' → the mandatory text's permitted-commands block is wrong.
const { receipt: plannerSurfR } = await build(implLead.implId, String(fx.ifaceDigest['r-lead']), {
  pins: PIN_OK,
  sourceRoot: REPO_ROOT,
  surface: plannerShapeSurface
})
const psRes = (plannerSurfR as { status: string; result?: { requiredTextDigest: string } })
let psText = ''
if (psRes.status === 'committed' && psRes.result) {
  const b = q1(w.db, 'SELECT body FROM content_blobs WHERE digest=?', psRes.result.requiredTextDigest)
  psText = b ? Buffer.from(b.body as Uint8Array).toString('utf8') : ''
}
rec.check(
  's1b.plannerSurfaceShape',
  psRes.status === 'committed' && psText.includes('`allowed`') && !psText.includes('`artifact.read`'),
  "planner's {allowed:[…]} surface reads as a pseudo-action 'allowed'",
  `${psRes.status} commandsHasArtifactRead=${psText.includes('`artifact.read`')} hasPseudo=${psText.includes('`allowed`')}`
)

// ---------- s1d: real worker.prepare ----------------------------------------
// pre-seed real WorkEnvelopes — composition.ts:397-411 passes snake_case rows
// as camelCase (assignment.taskId/member.roleId), so the ensureEnvelope port
// would throw INVALID_TRANSITION and mask every later stage. Seeding the row
// the port would have produced lets the REAL downstream blockers surface.
buildTaskEnvelope(w.db, {
  assignmentId: fx.members.asm.assignmentId,
  assignmentRevision: 1,
  taskId: 't-asm',
  taskRevision: 1
})
buildTaskEnvelope(w.db, {
  assignmentId: fx.members.tool.assignmentId,
  assignmentRevision: 1,
  taskId: 't-tool',
  taskRevision: 1
})
const leadImpl = fx.impls['r-lead']
buildCoordinationEnvelope(w.db, {
  assignmentId: fx.members.lead.assignmentId,
  assignmentRevision: 1,
  roleContext: { roleId: 'r-lead', implementationId: leadImpl.implId, implementationRevision: leadImpl.revision }
})

const leadCtx = memberCtx(fx.members.lead.memberId, { [fx.members.lead.grantId]: fx.members.lead.grantRevision })
const asmImpl = fx.impls['r-asm']
async function prepare(name: string, payload: Record<string, unknown>, expectBlocker: string): Promise<void> {
  const r = await w.dispatch(leadCtx, 'worker.prepare', payload)
  const blockers = ((r.error?.details as { blockers?: { code: string; detail: string }[] })?.blockers ?? [])
  const first = r.error?.code ?? '(none)'
  const all = [first, ...blockers.map((b) => b.code)]
  rec.check(
    `s1d.prepare.${name}`,
    r.status !== 'committed' && all.includes(expectBlocker),
    `rejected ${expectBlocker}`,
    `${r.status} ${first} blockers=${all.join(',')}`,
    { error: r.error, blockers }
  )
  rec.artifact(`s1d.prepare.${name}`, { status: r.status, error: r.error, blockers })
}

const happyPayload = {
  assignmentId: fx.members.asm.assignmentId,
  assignmentRevision: 1,
  implementationRevision: asmImpl.revision,
  taskRevision: 1,
  placementIntent: { hostId, kind: 'folder', projectId: fx.projectId, targetPath: join(CHECKOUT_A, 'p-happy') },
  harnessProfileRevision: fx.profileRevision,
  purpose: 'work'
}
// planner.ts:482 dispatches context.build with txn.ctx (the MEMBER ctx) — the
// op is 'service' visibility → UNAVAILABLE_OPERATION for every member-initiated
// prepare. The pins-shape bug (planner.ts:487) is shadowed behind it.
await prepare('happyPath', happyPayload, 'INPUT_NOT_READY') // blocked: context.build unreachable via member ctx
await prepare('staleImplRevision', { ...happyPayload, implementationRevision: 99 }, 'INTERFACE_STALE')
await prepare('staleTaskRevision', { ...happyPayload, taskRevision: 77 }, 'INTERFACE_STALE')
await prepare('missingHost', { ...happyPayload, placementIntent: { ...happyPayload.placementIntent, hostId: 'host-nope' } }, 'INPUT_NOT_READY')
await prepare('missingAssignment', { ...happyPayload, assignmentId: 'asg-nope' }, 'INPUT_NOT_READY')

// expired grant → REQUIRED_ACTION_DENIED blocker (grant row expires_at in past)
w.db.prepare('UPDATE grants SET expires_at=? WHERE id=?').run(Date.now() - 1000, fx.members.tool.grantId)
await prepare('expiredGrant', { ...happyPayload, assignmentId: fx.members.tool.assignmentId, implementationRevision: fx.impls['r-tool'].revision }, 'REQUIRED_ACTION_DENIED')
w.db.prepare('UPDATE grants SET expires_at=NULL WHERE id=?').run(fx.members.tool.grantId)

// a member pinned to an impl whose profile is only 'documented' → purpose=work
// requires verified → REQUIRED_ACTION_DENIED
w.db.prepare("UPDATE harness_profiles SET state='documented' WHERE id='hp-nopreload' AND revision=1").run()
const memberNp = `mem-ver05-nopreload-${Math.random().toString(36).slice(2, 8)}`
const asgNp = `asg-ver05-nopreload-${Math.random().toString(36).slice(2, 8)}`
w.db.prepare("INSERT INTO principals(id,kind,status) VALUES(?,'member','active')").run(memberNp)
w.db.prepare(
  "INSERT INTO members(id,run_id,model_version,role_id,implementation_id,implementation_revision,generation,current_execution_id,state,revision) VALUES(?,?,?,?,?,?,1,NULL,'assigned',1)"
).run(memberNp, fx.runId, fx.mv1, 'r-asm', implNoPreload.implId, 1)
w.db.prepare(
  'INSERT INTO assignments(id,revision,member_id,kind,mandate_text,grant_id,task_id,task_revision,scope_json) VALUES(?,1,?,?,?,?,?,?,?)'
).run(asgNp, memberNp, 'task', 'nopreload mandate', fx.members.asm.grantId, 't-asm', 1, '{}')
buildTaskEnvelope(w.db, { assignmentId: asgNp, assignmentRevision: 1, taskId: 't-asm', taskRevision: 1 })
await prepare('unverifiedProfile', {
  ...happyPayload,
  assignmentId: asgNp,
  implementationRevision: 1
}, 'REQUIRED_ACTION_DENIED')

w.runtime.close()
rec.flush()
