// mahas-runtime — initial join/accept directive generator (launch/access, IMP-20).
//
// Builds the bootstrap-protocol section of task/initial.txt and the full
// initial text composer (spec/injection.md §3, §7). Pure functions — no DB,
// no I/O — so IMP-19's initial-attachment can embed the output into the
// verified injection route, and IMP-24/25's native formatting can wrap it.
//
// Rules enforced here (instruction §4.2):
//   * the requirement's ACTUAL body text is embedded — never "go find it";
//   * join/accept are written as exact invocations with the real pins;
//   * the connection handle (bin/mahas + connection/worker) is named — the
//     raw secret is never placed in the text;
//   * coordination assignments get no task.accept step — the Run mandate is
//     accepted by joining (D-WORK §2).

// ---------- exact invocations ----------

export interface JoinInvocationInput {
  executionId: string
  generation: number
  bundleDigest: string
  surfaceDigest: string
  envelopeDigest: string
}

export interface AcceptInvocationInput {
  dispatchId: string
  taskRevision: number
  envelopeDigest: string
}

/** `mahas execution join` as the agent must invoke it (spec/injection.md §7) */
export function joinInvocation(i: JoinInvocationInput): string {
  return [
    'mahas execution join',
    `--execution-id ${i.executionId}`,
    `--generation ${i.generation}`,
    `--bundle-digest ${i.bundleDigest}`,
    `--surface-digest ${i.surfaceDigest}`,
    `--envelope-digest ${i.envelopeDigest}`
  ].join(' \\\n    ')
}

/** `mahas task accept` — only for task-kind assignments */
export function acceptInvocation(i: AcceptInvocationInput): string {
  return [
    'mahas task accept',
    `--dispatch-id ${i.dispatchId}`,
    `--task-revision ${i.taskRevision}`,
    `--envelope-digest ${i.envelopeDigest}`
  ].join(' \\\n    ')
}

export function heartbeatInvocation(i: { executionId: string; generation: number }): string {
  return [
    'mahas execution heartbeat',
    `--execution-id ${i.executionId}`,
    `--generation ${i.generation}`,
    '--activity-hint <working|idle|blocked|needs-input>'
  ].join(' \\\n    ')
}

// ---------- bootstrap protocol section ----------

export interface JoinAcceptDirectiveInput {
  assignmentKind: 'task' | 'coordination'
  join: JoinInvocationInput
  /** required when assignmentKind === 'task' */
  accept?: AcceptInvocationInput
  /** path of the scoped launcher relative to the execution root (default bin/mahas) */
  cliPath?: string
  /** path of the private connection file relative to the execution root (default connection/worker) */
  connectionPath?: string
}

/**
 * The protocol block embedded in initial text. States what join/accept are
 * AND what they are not: receipts bound to launch pins, not proof of
 * comprehension, and join is not task accept.
 */
export function buildJoinAcceptDirectives(input: JoinAcceptDirectiveInput): string {
  const cli = input.cliPath ?? 'bin/mahas'
  const conn = input.connectionPath ?? 'connection/worker'
  const lines: string[] = [
    '## mahas collaboration protocol — join and accept',
    '',
    `Use the scoped CLI at \`${cli}\`. It reads your private connection from`,
    `\`${conn}\`, which carries your credential. Never print, paste or forward`,
    'the connection file or any credential — there is no secret you need to type.',
    '',
    '### Step 1 — join (required, before anything else)',
    '',
    'Declare participation with the exact digests this execution was launched with:',
    '',
    '```sh',
    joinInvocation(input.join),
    '```',
    '',
    'Join binds your credential to this execution generation and these pinned',
    'bundle/surface/envelope digests. Returning digests is a receipt that the',
    'launch pins reached you — it does not prove understanding, and it is not',
    'task acceptance.'
  ]
  if (input.assignmentKind === 'task') {
    if (!input.accept) {
      throw new Error('task-kind assignment requires accept pins for the directive')
    }
    lines.push(
      '',
      '### Step 2 — accept this task',
      '',
      'After join succeeds, explicitly accept this exact task revision and envelope:',
      '',
      '```sh',
      acceptInvocation(input.accept),
      '```',
      '',
      'task.accept acknowledges your assignment delivery and marks the dispatch',
      'accepted. Accepting pins you to this TaskRevision and WorkEnvelopeDigest —',
      'a different revision or digest is rejected, not reinterpreted.'
    )
  } else {
    lines.push(
      '',
      '### Step 2 — coordination mandate',
      '',
      'This is a coordination assignment: there is no Task to accept. Joining',
      'accepts the Run mandate below; use `mahas assignment show` to re-read',
      'your standing responsibility at any time.'
    )
  }
  lines.push(
    '',
    '### Heartbeats',
    '',
    'Report liveness — never outcomes — while you work:',
    '',
    '```sh',
    heartbeatInvocation(input.join),
    '```',
    '',
    'A heartbeat is stored as an observation fact. It does not claim progress,',
    'success, or lease ownership.'
  )
  return lines.join('\n')
}

// ---------- full initial.txt composer ----------

export interface InitialTextInput {
  goalText: string
  /** the actual requirement body of this task/mandate — embedded verbatim */
  requirementText: string
  /** work scope and constraints for this assignment */
  scopeText?: string
  /** exact inputs the worker must use and when */
  inputs?: { name: string; ref: string; reason: string }[]
  /** direct collaborators and the relationship */
  peers?: { memberId: string; role: string; relation: string }[]
  /** required outputs and who settles them */
  outputs?: { name: string; settlement: string }[]
  /** output of buildJoinAcceptDirectives */
  protocolDirectives: string
}

/**
 * task/initial.txt per spec/injection.md §3: (goal) (this requirement's
 * actual body) (scope/constraints) (exact inputs and when to use them)
 * (direct collaborators) (required outputs/settler) (exact join/accept).
 */
export function buildInitialText(input: InitialTextInput): string {
  const sections: string[] = [
    '# Goal',
    '',
    input.goalText,
    '',
    '# This requirement',
    '',
    input.requirementText
  ]
  if (input.scopeText) {
    sections.push('', '# Scope and constraints', '', input.scopeText)
  }
  if (input.inputs && input.inputs.length > 0) {
    sections.push('', '# Inputs')
    for (const i of input.inputs) {
      sections.push('', `- \`${i.name}\` — ${i.ref}. ${i.reason}`)
    }
  }
  if (input.peers && input.peers.length > 0) {
    sections.push('', '# Collaborators')
    for (const p of input.peers) {
      sections.push('', `- \`${p.memberId}\` (${p.role}) — ${p.relation}`)
    }
  }
  if (input.outputs && input.outputs.length > 0) {
    sections.push('', '# Required outputs')
    for (const o of input.outputs) {
      sections.push('', `- \`${o.name}\` — settled by: ${o.settlement}`)
    }
  }
  sections.push('', input.protocolDirectives, '')
  return sections.join('\n')
}
