#!/usr/bin/env node
// builtin.harness-runtime — the daemon-side implementation of identify,
// launch, resume, wake, events and maintenance.
//
// All vendor knowledge used here comes from the Pack's own data files
// (harnesses.json, installers.json); the entrypoint contains no per-harness
// branch. The desktop reads the same files through
// packages/mahas-harness-config/src/runtime-pack.ts, so a harness is added or
// changed by editing Pack data — never core switches.
//
// Event identity contract: the NDJSON transport (hooks/mahas-hook.cjs) writes
// the native identity of every event (sessionId, parentSessionId, child,
// internalRun, external, nativeEvent, pane/tab) plus the notification policy it
// recommends (policy.demote / policy.stripSession). This implementation keeps
// that identity in the collection result — child and foreign sessions become
// real session rows with their parent link — and reports the policy as data;
// it never deletes identity to express an exclusion.
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const catalog = JSON.parse(readFileSync(join(root, 'harnesses.json'), 'utf8'))
const installersFile = JSON.parse(readFileSync(join(root, 'installers.json'), 'utf8'))
const installers = installersFile.installers || {}
const harnesses = catalog.harnesses || {}

const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const first = (...xs) => {
  for (const x of xs) if (typeof x === 'string' && x.trim()) return x.trim()
  return ''
}
const clip = (s, n = 300) => {
  s = String(s || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
const harnessOf = (payload) =>
  first(payload.harnessId, payload.inputs?.harnessId, payload.sessionHandle?.harnessId, payload.target?.harnessId)
const base = (req, payload, status = 'success', diagnostics = []) => ({
  protocolVersion: req.protocolVersion,
  operationId: req.operationId,
  ...('action' in req
    ? { action: req.action }
    : { capability: req.capability, target: req.target, contract: req.contract, pack: req.pack }),
  status,
  ...(payload === undefined ? {} : { payload }),
  diagnostics
})
const diag = (code, severity, message) => ({ code, severity, message })

/* ------------------------------------------------------------------ pinning */

/**
 * The Pack revision a LaunchPlan must pin. contentDigest is the digest of the
 * revision actually invoked — the profile data only declares intent, so a
 * mismatch between the declared pin and the invoked revision is reported
 * instead of being silently rewritten.
 */
function packPin(req, profile, prefix) {
  const declared = record(profile?.pack)
  const pin = {
    packId: req.pack.packId,
    revision: req.pack.revision,
    contentDigest: req.pack.contentDigest,
    capability: req.capability,
    implementationId: declared.implementationId
  }
  const diagnostics = []
  if (declared.packId && declared.packId !== req.pack.packId) {
    diagnostics.push(diag(prefix + '.pack-id-mismatch', 'warning', 'profile declares a different Pack id'))
  } else if (declared.revision && declared.revision !== req.pack.revision) {
    diagnostics.push(diag(prefix + '.pack-revision-drift', 'warning', `profile declares revision ${declared.revision}; the invoked revision is ${req.pack.revision}`))
  }
  return { pin, diagnostics }
}

/* --------------------------------------------------------------- identify */

function identify(req) {
  const p = req.payload
  const env = record(p.environment)
  const candidates = Array.isArray(p.candidateLocators) ? p.candidateLocators : []
  const installations = Object.entries(harnesses)
    .filter(([, h]) => !h.testOnly)
    .map(([id, h]) => {
      const matches = Array.isArray(h.match) ? h.match : []
      const locator = candidates.find((x) =>
        matches.some((m) => basename(String(x)) === m || String(x).includes(m))
      )
      return {
        harnessId: id,
        ...(locator ? { executableLocator: locator } : {}),
        configNamespace: id,
        dataNamespace: id,
        presence: locator
          ? 'present'
          : env[`MAHAS_${id.toUpperCase()}_PRESENT`] === true
            ? 'present'
            : 'unknown',
        executableIdentity: { match: matches, ...(h.envSignals ? { envSignals: h.envSignals } : {}) },
        evidence: locator
          ? [{ description: 'candidate executable locator matched pack signature', data: { locator } }]
          : []
      }
    })
  // the response schema is strict: installations only, and a candidate locator
  // is reported as the matched path — never as an installation claim
  return base(req, { installations })
}

/* ----------------------------------------------------------------- launch */

function launch(req) {
  const p = req.payload
  const inputs = record(p.inputs)
  const profileId = first(inputs.profileId, inputs.harnessProfileId)
  const profile = catalog.profiles[profileId]
  if (!profile) {
    return base(req, undefined, 'failed', [
      diag('profile.unknown', 'error', `unknown pinned profile ${profileId || '<missing>'}`)
    ])
  }
  const process = record(record(profile.recipe).process)
  const locator = record(process.executableLocator)
  const executable = first(inputs.executablePath, locator.commands?.[0])
  const args = Array.isArray(inputs.args) ? inputs.args : []
  const { pin, diagnostics } = packPin(req, profile, 'launch')
  // the launch response schema is strict: recipe + support. The revision pin
  // travels in support (and redundantly in the recipe preconditions) so a
  // LaunchPlan can record which Pack revision the recipe was built from.
  return base(
    req,
    {
      recipe: {
        executable,
        args,
        env: record(inputs.env),
        cwd: p.workingDirectory,
        preconditions: [
          `profile:${profileId}@${profile.revision}`,
          precondition(pin),
          'verified installation route'
        ]
      },
      support: {
        profileId,
        profileRevision: profile.revision,
        supportedComponents: profile.supportedComponents || [],
        executableLocator: locator,
        declaredProfile: profile.pack || null,
        pin
      }
    },
    'success',
    diagnostics
  )
}

/** pack:<id>@<revision>#<digest> (impl <id>) — the pin as a precondition string. */
function precondition(probePin) {
  const digest = probePin.contentDigest ? '#' + probePin.contentDigest : ''
  const impl = probePin.implementationId ? ' (impl ' + probePin.implementationId + ')' : ''
  return 'pack:' + probePin.packId + '@' + probePin.revision + digest + impl
}

/* ----------------------------------------------------------------- resume */

function resume(req) {
  const p = req.payload
  const handle = record(p.sessionHandle)
  const id = harnessOf({ ...p, sessionHandle: handle })
  const h = harnesses[id]
  const nativeId = first(handle.nativeId, handle.nativeSessionId, handle.sessionId)
  const policy = record(p.policy ?? handle.policy)
  if (policy.stripSession === true || policy.demote === true) {
    return base(req, {
      support: 'unsupported',
      reason: 'the recorded policy excludes this run from resume (subagent or internal thread)'
    })
  }
  if (!h?.resume) {
    return base(req, {
      support: 'unsupported',
      reason: 'pack declares no native resume recipe for this harness'
    })
  }
  if (!nativeId) {
    return base(req, {
      support: 'unknown',
      reason: 'session handle has no native id — resume is not claimed'
    })
  }
  const args = (h.resume.args || []).map((x) => (x === '${sessionId}' ? nativeId : x))
  return base(req, {
    support: 'supported',
    recipe: {
      executable: h.resume.executable,
      args,
      env: {},
      ...(p.workingDirectory ? { cwd: p.workingDirectory } : {}),
      preconditions: [
        'same pinned role implementation and context bundle',
        'verified installation route',
        precondition(req.pack)
      ]
    }
  })
}

/* ------------------------------------------------------------------- wake */

function wake(req) {
  const declarations = Object.entries(harnesses).filter(([, h]) => h.wake && h.wake.automatic === true)
  return base(req, {
    support: 'unsupported',
    reason:
      'no harness in this Pack revision declares a verified automatic wake route; durable delivery remains queued for manual resume',
    effect: {
      automatic: false,
      declaredAutomatic: declarations.map(([id]) => id),
      pin: {
        packId: req.pack.packId,
        revision: req.pack.revision,
        contentDigest: req.pack.contentDigest,
        capability: req.capability
      }
    }
  })
}

/* ------------------------------------------------------------- maintenance */

function maintenance(req) {
  const p = req.payload
  const t = record(p.target)
  const id = first(t.harnessId, t.providerId, p.harnessId)
  const installer = installers[id]
  const declarations = Array.isArray(harnesses[id]?.maintenance) ? harnesses[id].maintenance : []
  const safety = installersFile.legacy || {}
  const dryRun = p.dryRun === true
  const propose = (effect) => ({ ...effect, harnessId: id, dryRun, neverAutoInstalls: true })
  if (p.action === 'hook-status') {
    return base(req, {
      applicable: Boolean(installer),
      effects: installer ? [propose({ kind: 'inspect-hook', installer })] : [],
      evidence: []
    })
  }
  if (p.action === 'install-hook') {
    if (!installer) {
      return base(req, {
        applicable: false,
        effects: [],
        evidence: [{ description: 'no installer is declared for this harness' }]
      })
    }
    return base(req, {
      applicable: true,
      effects: [
        propose({
          kind: 'install-hook',
          installer,
          explicit: true,
          preserves: ['existing user hook groups', 'displaced commands', 'legacy backup files'],
          legacyMarkers: safety.legacyMarkers || []
        })
      ],
      evidence: [{ description: 'explicit user action required', data: { harnessId: id } }]
    })
  }
  if (p.action === 'refresh-installed-hooks') {
    if (!installer) {
      return base(req, {
        applicable: false,
        effects: [],
        evidence: [{ description: 'no installer is declared for this harness' }]
      })
    }
    return base(req, {
      applicable: true,
      effects: [
        propose({
          kind: 'refresh-installed-hook',
          installer,
          onlyWhenInstalledOrLegacy: true,
          refresh: installer.refresh || 'legacy',
          legacyArtifacts: safety.artifacts || [],
          legacyMarkers: safety.legacyMarkers || [],
          ownedArtifacts: installer.files || undefined
        })
      ],
      evidence: [
        {
          description:
            'owned artifacts track the shipped revision; user-owned configs are not claimed from scratch',
          data: { refresh: installer.refresh || 'legacy' }
        }
      ]
    })
  }
  if (p.action === 'sweep-session-locks') {
    const declared = declarations.includes('sweep-session-locks')
    return base(req, {
      applicable: declared,
      effects: declared
        ? [
            propose({
              kind: 'sweep-stale-locks',
              lockDir: harnesses[id].lockDir,
              lockPattern: harnesses[id].lockPattern || '*.lock',
              safety: ['flock-absent', 'recorded-pid-dead-or-not-harness']
            })
          ]
        : [],
      evidence: declared
        ? []
        : [{ description: 'this harness declares no session-lock maintenance' }]
    })
  }
  return base(req, {
    applicable: false,
    effects: [],
    evidence: [{ description: 'unknown maintenance action ' + String(p.action) }]
  })
}

/* ----------------------------------------------------------------- events */

function emptyCollection(extra) {
  return {
    observations: [],
    sessions: [],
    handles: [],
    attachments: [],
    events: [],
    usageReadings: [],
    usageAttributionHints: [],
    quotaReadings: [],
    exhausted: true,
    coverage: { completeness: 'complete' },
    diagnostics: [],
    ...extra
  }
}

const KNOWN_KINDS = new Set([
  'session-start', 'session-end', 'turn-start', 'turn-complete', 'turn-cancelled',
  'needs-input', 'idle', 'error', 'other', 'session-rename'
])

function kindOf(raw) {
  const value = String(raw || '').trim().toLowerCase().replace(/[\s_]/g, '-')
  return KNOWN_KINDS.has(value) ? value : 'other'
}

/** Normalize one NDJSON line, preserving native identity and the recorded policy. */
export function normalizeNativeEvent(raw, sourceKey = 'hook') {
  const line = record(raw)
  const payload = record(line.payload)
  const provider = first(line.provider, payload.provider, payload.harnessId, 'unknown')
  const nativeEvent = first(line.nativeEvent, line.nativeKind, payload.nativeEvent, payload.hook_event_name, line.event, 'unknown')
  const sessionNativeKey = first(line.sessionId, payload.sessionId, payload.session_id)
  const parentNativeSessionId = first(line.parentSessionId, payload.parentSessionId, payload.parent_agent_id)
  const child = line.child === true || payload.child === true
  const internalRun = line.internalRun === true
  const external = line.external === true || (!line.mahasSession && line.ours !== true)
  const policy = record(line.policy)
  const at = Number.isFinite(Number(line.ts)) ? Number(line.ts) : Date.now()
  const sourceRecordKey = first(line.sourceRecordKey, `${sourceKey}:${line.offset ?? at}:${sessionNativeKey || 'anonymous'}`)
  const demotedFrom = first(line.demotedFrom)
  return {
    sourceRecordKey,
    ...(sessionNativeKey ? { sessionNativeKey } : {}),
    kind: kindOf(line.event),
    nativeKind: nativeEvent,
    occurredAt: at,
    observedAt: Date.now(),
    origin: first(line.origin, 'hook'),
    payload: {
      harnessId: provider,
      cwd: first(line.cwd, payload.cwd, payload.workingDirectory, payload.workspace_root),
      nativeSessionId: sessionNativeKey || undefined,
      parentNativeSessionId: parentNativeSessionId || undefined,
      child,
      internalRun,
      externalRun: external,
      ...(demotedFrom ? { demotedFrom } : {}),
      ...(Object.keys(policy).length ? { policy } : {}),
      mahasSession: line.mahasSession,
      paneId: line.paneId,
      tabId: line.tabId,
      namespace: first(line.namespace, 'hook'),
      installationId: first(line.installationId) || undefined,
      machineId: first(line.machineId) || undefined,
      message: clip(first(line.message, payload.message))
    },
    evidence: [
      {
        sourceRecordKey,
        description: 'native harness event preserved before the notification policy is applied'
      }
    ]
  }
}


function collectEvents(req) {
  const p = req.payload
  const source = record(p.source)
  const locator = record(source.locator)
  const path = first(locator.path, process.env.MAHAS_EVENTS_FILE)
  const harnessId = first(locator.harnessId)
  const cursor = record(p.cursor)
  const start = Number(cursor.offset || 0)
  const maxRecords = Number(p.maxRecords || 0)
  const maxBytes = Number(p.maxBytes || 0)
  const diagnostics = []
  if (!path) {
    return base(req, emptyCollection({ nextCursor: { offset: start }, diagnostics: [diag('events.locator-missing', 'warning', 'event source has no path')] }), 'partial', [
      diag('events.locator-missing', 'warning', 'event source has no path')
    ])
  }
  let bytes
  try {
    bytes = readFileSync(path)
  } catch {
    return base(req, emptyCollection({ exhausted: false, nextCursor: { offset: start }, diagnostics: [diag('events.source-unavailable', 'warning', 'the hook stream is not present')] }), 'partial', [
      diag('events.source-unavailable', 'warning', 'the hook stream is not present')
    ])
  }
  const end = Math.min(bytes.length, start + maxBytes)
  const window = bytes.subarray(start, end).toString('utf8')
  // A record is complete only at a newline. A trailing segment without one may
  // still be written by a live hook, so the cursor stops before it and the
  // coverage reports why.
  const lastNewline = window.lastIndexOf('\n')
  const slice = lastNewline === -1 ? '' : window.slice(0, lastNewline + 1)
  const incompleteTail = slice.length !== window.length
  if (!slice && start < bytes.length && bytes.length - start > maxBytes) {
    // a single record longer than the collection window: advance past it with
    // explicit evidence instead of stalling the cursor forever
    const nl = bytes.indexOf(0x0a, start)
    const advanced = nl === -1 ? bytes.length - start : nl - start + 1
    diagnostics.push(diag('events.record-exceeds-window', 'warning', `skipped ${advanced} bytes that exceed maxBytes`))
    return base(
      req,
      emptyCollection({
        exhausted: start + advanced >= bytes.length,
        nextCursor: { offset: start + advanced, generation: source.generation, harnessId: harnessId || undefined },
        coverage: { completeness: 'partial', watermark: String(start + advanced) },
        diagnostics
      }),
      'partial',
      diagnostics
    )
  }
  const events = []
  const sessions = new Map()
  let consumed = 0
  let skippedForeign = 0
  // the slice always ends at a newline, so the final split element is empty and
  // must not be counted as a consumed byte
  const completeLines = slice ? slice.slice(0, -1).split('\n') : []
  for (const line of completeLines) {
    if (!line) {
      consumed += 1
      continue
    }
    if (events.length >= maxRecords) break
    let raw
    try {
      raw = JSON.parse(line)
    } catch {
      consumed += Buffer.byteLength(line) + 1
      diagnostics.push(diag('events.malformed-line', 'warning', 'a hook record could not be parsed and was skipped'))
      continue
    }
    const provider = first(raw.provider)
    if (harnessId && provider && provider !== harnessId) {
      skippedForeign += 1
      consumed += Buffer.byteLength(line) + 1
      continue
    }
    const event = normalizeNativeEvent({ ...record(raw), offset: start + consumed }, source.sourceKey)
    consumed += Buffer.byteLength(line) + 1
    const key = event.sessionNativeKey
    if (key) {
      const previous = sessions.get(key)
      const row = previous || {
        first: event.occurredAt,
        last: event.observedAt,
        child: false,
        internal: false,
        external: false,
        parent: '',
        paneId: '',
        tabId: '',
        installationId: '',
        machineId: '',
        policy: {}
      }
      row.first = Math.min(row.first, event.occurredAt ?? row.first)
      row.last = Math.max(row.last, event.observedAt)
      row.child = row.child || event.payload.child === true
      row.internal = row.internal || event.payload.internalRun === true
      row.external = row.external || event.payload.externalRun === true
      row.parent = row.parent || first(event.payload.parentNativeSessionId)
      row.paneId = row.paneId || first(event.payload.paneId)
      row.tabId = row.tabId || first(event.payload.tabId)
      row.installationId = row.installationId || first(event.payload.installationId)
      row.machineId = row.machineId || first(event.payload.machineId)
      const policy = record(event.payload.policy)
      row.policy = { demote: row.policy.demote === true || policy.demote === true, stripSession: row.policy.stripSession === true || policy.stripSession === true }
      sessions.set(key, row)
      if (row.parent && !sessions.has(row.parent)) {
        sessions.set(row.parent, {
          first: event.occurredAt,
          last: event.observedAt,
          child: false,
          internal: false,
          external: row.external,
          parent: '',
          paneId: row.paneId,
          tabId: row.tabId,
          installationId: row.installationId,
          machineId: row.machineId,
          policy: {},
          derivedFrom: 'child-event'
        })
      }
    }
    events.push(event)
  }
  const harness = harnesses[events[0]?.payload?.harnessId] || harnesses[harnessId]
  const sessionRows = []
  const handleRows = []
  for (const [nativeKey, row] of sessions) {
    sessionRows.push({
      sourceRecordKey: `session:${nativeKey}`,
      harnessId: first(events[0]?.payload?.harnessId, harnessId, 'unknown'),
      namespace: first(events[0]?.payload?.namespace, 'hook'),
      nativeSessionKey: nativeKey,
      ...(row.parent ? { parentNativeSessionKey: row.parent } : {}),
      firstObservedAt: row.first,
      lastObservedAt: row.last,
      metadata: {
        child: row.child,
        internalRun: row.internal,
        externalRun: row.external,
        ...(row.derivedFrom ? { derivedFrom: row.derivedFrom } : {}),
        ...(row.paneId ? { paneId: row.paneId } : {}),
        ...(row.tabId ? { tabId: row.tabId } : {}),
        ...(row.installationId ? { installationId: row.installationId } : {}),
        ...(row.machineId ? { machineId: row.machineId } : {}),
        ...(row.policy.demote || row.policy.stripSession ? { policy: row.policy } : {})
      }
    })
    const excluded = row.child || row.internal
    const resumeSupport = excluded || !harness?.resume ? 'unsupported' : row.external ? 'unknown' : 'supported'
    handleRows.push({
      sourceRecordKey: `handle:${nativeKey}`,
      sessionNativeKey: nativeKey,
      nativeId: nativeKey,
      resumeSupport,
      observedAt: row.last,
      locator: {
        namespace: 'hook',
        harnessId: first(harnessId, events[0]?.payload?.harnessId, 'unknown'),
        child: row.child,
        internalRun: row.internal,
        externalRun: row.external,
        ...(row.parent ? { parentNativeSessionId: row.parent } : {}),
        ...(row.policy.demote || row.policy.stripSession ? { policy: row.policy } : {})
      },
      evidence: [{ sourceRecordKey: `session:${nativeKey}`, description: 'native session identity observed on the hook stream' }]
    })
  }
  const next = start + consumed
  const exhausted = !incompleteTail && next >= bytes.length
  if (skippedForeign) {
    diagnostics.push(diag('events.foreign-harness-skipped', 'info', `${skippedForeign} line(s) belonged to another harness and were skipped`))
  }
  return base(
    req,
    emptyCollection({
      events,
      sessions: sessionRows,
      handles: handleRows,
      nextCursor: { offset: next, generation: source.generation, harnessId: harnessId || undefined },
      exhausted,
      coverage: {
        completeness: exhausted ? 'complete' : 'partial',
        ...(exhausted
          ? {}
          : { gapReason: incompleteTail ? 'incomplete-trailing-record' : 'collection-window-limit' }),
        watermark: String(next)
      },
      diagnostics
    }),
    diagnostics.some((d) => d.severity !== 'info') ? 'partial' : 'success',
    diagnostics
  )
}

function discoverEventSources(req) {
  const p = req.payload
  const harnessId = first(p.configNamespace)
  const configured = process.env.MAHAS_EVENTS_FILE
  const path = configured || join(p.dataNamespace || '.', 'agent-events.log')
  return base(req, {
    sources: [
      {
        sourceKey: `hook:${p.installationId}${harnessId ? ':' + harnessId : ''}`,
        kind: 'hook-stream',
        locator: { path, ...(harnessId ? { harnessId } : {}) },
        generation: catalog.hookStream?.generation || 'ndjson-v2',
        identityEvidence: {
          contract: catalog.hookStream?.transport || 'hooks/mahas-hook.cjs',
          identityFields: catalog.hookStream?.identityFields || [],
          policyFields: catalog.hookStream?.policyFields || []
        }
      }
    ]
  })
}

function directEvents(req) {
  const source = record(req.payload.source)
  const raws = Array.isArray(source.events) ? source.events : source.event ? [source.event] : []
  const max = Number(req.payload.maxRecords || raws.length)
  const slice = raws.slice(0, max)
  const events = slice.map((x, i) => normalizeNativeEvent({ ...record(x), offset: i }, 'inline'))
  return base(req, {
    events,
    nextCursor: { offset: slice.length },
    exhausted: slice.length >= raws.length
  })
}

export function handle(req) {
  if ('action' in req) {
    if (req.capability === 'events') {
      return req.action === 'discover-sources' ? discoverEventSources(req) : collectEvents(req)
    }
    return base(req, undefined, 'failed', [
      diag('capability.unsupported', 'error', `${req.capability} does not implement action ${String(req.action)}`)
    ])
  }
  if (req.capability === 'identify') return identify(req)
  if (req.capability === 'launch') return launch(req)
  if (req.capability === 'resume') return resume(req)
  if (req.capability === 'wake') return wake(req)
  if (req.capability === 'maintenance') return maintenance(req)
  if (req.capability === 'events') return directEvents(req)
  return base(req, undefined, 'failed', [
    diag('capability.unsupported', 'error', 'capability is not implemented by this entrypoint')
  ])
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    input += chunk
  })
  process.stdin.on('end', () => {
    try {
      process.stdout.write(JSON.stringify(handle(JSON.parse(input))))
    } catch (error) {
      process.stderr.write(String(error?.message || error))
      process.exitCode = 1
    }
  })
}
