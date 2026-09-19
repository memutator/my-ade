// VER-10 — generate the codex launch spec via the REAL WIP recipe path.
// buildCodexLaunchSpec is the shipped code; this probe only supplies inputs.
import { writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'

const WIP = '/tmp/mahas-ver-10/wip'
const ROOT = '/tmp/mahas-ver-10'
const EXEC = `${ROOT}/exec/exec-ver10-1`
const { buildCodexLaunchSpec } = await import(`file://${WIP}/packages/mahas-harness-config/src/codex/recipe.ts`)

const mandatoryText = [
  '# VER-10 mandatory instruction (role/mandatory.md)',
  '',
  'You are a codex verification worker inside mahas.',
  'Scope: verification-only run under provisioning grant grt_ef804c80.',
  'Answer briefly. Do not modify files outside this checkout.',
  '한글 지시 포함 — 개행과 UTF-8이 TOML basic-string을 통해 온전히 전달되어야 한다.',
  ''
].join('\n')

const skillDoc = [
  '---',
  'name: ver10-probe',
  'description: VER-10 probe skill — reports a fixed token when asked',
  '---',
  '',
  '# ver10-probe',
  'When the user asks for the probe token, reply with exactly: VER10-SKILL-TOKEN-7f3a',
  ''
].join('\n')

const initialTextR1 = 'Reply with exactly: VER10-R1-OK'
const initialTextR2 = [
  'Two steps then stop:',
  '1. Run these shell commands and report their first line of output verbatim: `command -v mahas`, `mahas surface describe | head -3`.',
  '2. A skill named ver10-probe may be available — if so, ask yourself for its probe token and report it.',
  'End with the line: VER10-R2-OK'
].join('\n')

const input = {
  executablePath: '/home/pyosechang/.nvm/versions/node/v24.20.0/bin/codex',
  checkoutDir: EXEC,
  components: [
    {
      implementationId: 'impl-codex-1', implementationRevision: 1,
      id: 'comp-mandatory', kind: 'instruction', activation: 'required',
      binding: {}, consumes: [], coverage: []
    },
    {
      implementationId: 'impl-codex-1', implementationRevision: 1,
      id: 'comp-skill-ver10', kind: 'skill', activation: 'optional',
      binding: { skillName: 'ver10-probe' }, consumes: [], coverage: []
    },
    {
      implementationId: 'impl-codex-1', implementationRevision: 1,
      id: 'comp-toolcfg', kind: 'tool-config', activation: 'optional',
      binding: {}, consumes: [], coverage: []
    },
    {
      implementationId: 'impl-codex-1', implementationRevision: 1,
      id: 'comp-launchcfg', kind: 'launch-config', activation: 'optional',
      binding: {}, consumes: [], coverage: []
    }
  ],
  content: {
    'comp-mandatory': { body: mandatoryText },
    'comp-skill-ver10': { body: skillDoc, binding: { skillName: 'ver10-probe' } },
    'comp-toolcfg': { body: 'scoped mahas CLI access port' },
    'comp-launchcfg': { body: 'stdio=pipes for non-interactive verification legs', binding: { launch: { stdio: 'pipes' } } }
  },
  initialText: initialTextR1,
  cliAccess: {
    binDir: `${EXEC}/bin`,
    cliPath: `${EXEC}/bin/mahas`
  },
  stdio: 'pipes'
}

const r = buildCodexLaunchSpec(input)
if (!r.ok) {
  console.log('REFUSED:', JSON.stringify(r.error, null, 2))
  process.exit(1)
}
const spec = r.value
mkdirSync(`${ROOT}/out`, { recursive: true })
writeFileSync(`${ROOT}/out/launch-spec.json`, JSON.stringify(spec, null, 2))
writeFileSync(`${ROOT}/out/initial-r1.txt`, initialTextR1)
writeFileSync(`${ROOT}/out/initial-r2.txt`, initialTextR2)

// materialize the planned files (skill catalog) — fail-on-conflict per recipe
for (const f of spec.materialize) {
  const p = `${EXEC}/${f.relativePath}`
  mkdirSync(p.slice(0, p.lastIndexOf('/')), { recursive: true })
  writeFileSync(p, f.content, { flag: 'wx' })
  console.log('materialized', f.relativePath, f.byteDigest.slice(0, 12))
}

console.log('\n=== processSpec ===')
console.log('executable:', spec.processSpec.executable)
console.log('argv:')
spec.processSpec.argv.forEach((a, i) => console.log(`  [${i}] ${a.length > 120 ? a.slice(0, 120) + `…(${a.length}B)` : a}`))
console.log('cwd:', spec.processSpec.cwd)
console.log('env:', JSON.stringify(spec.processSpec.env))
console.log('envPrepend:', JSON.stringify(spec.processSpec.envPrepend))
console.log('stdio:', spec.processSpec.stdio)
console.log('mandatoryTextDigest:', spec.mandatoryTextDigest)
console.log('argBytes:', JSON.stringify(spec.argBytes))
console.log('routes:', spec.routes.map(r => `${r.componentId}:${r.route}`).join(', '))
console.log('plan errors:', JSON.stringify(spec.plan.errors))
console.log('plan warnings:', JSON.stringify(spec.plan.warnings))
