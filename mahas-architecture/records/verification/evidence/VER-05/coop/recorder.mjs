// VER-05 cooperative executable — records the REAL spawn evidence a harness
// would see: exact argv, cwd, allowlisted env, initial stdin bytes, and the
// digest of every file it was asked to read. Exits 0 after writing a JSON
// report; never prints or persists secret material.
//
//   node recorder.mjs --record-out <path> [--file <path>]... [--echo-stdin]
//
// --file records {path, sha256, byteLength, firstBytesHex(64)} per read.
// stdin is drained fully; its sha256 is recorded (and echoed when asked).
import { createHash } from 'node:crypto'
import { writeFileSync, readFileSync, realpathSync } from 'node:fs'

const argv = process.argv.slice(2)
const out = { argv, cwd: process.cwd(), pid: process.pid, ppid: process.ppid, at: Date.now() }

const files = []
let recordOut = null
let echoStdin = false
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--record-out') recordOut = argv[++i]
  else if (argv[i] === '--file') files.push(argv[++i])
  else if (argv[i] === '--echo-stdin') echoStdin = true
}

// non-secret environment: mahas bookkeeping + the marker this probe stamped
out.env = {}
for (const k of Object.keys(process.env).sort()) {
  if (k.startsWith('MAHAS_') || k === 'VER05_MARKER' || k === 'PWD') out.env[k] = process.env[k]
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex')

const stdinChunks = []
process.stdin.on('data', (c) => stdinChunks.push(c))
process.stdin.on('end', finish)
process.stdin.on('error', () => finish())
// a spawned stdin may stay open — finish after 3s of no 'end' either way
const stdinTimer = setTimeout(finish, 3000)
stdinTimer.unref()
// a stdin that is never written still ends; guard double-finish
let done = false
function finish() {
  if (done) return
  done = true
  const stdin = Buffer.concat(stdinChunks)
  out.stdin = { byteLength: stdin.byteLength, sha256: sha256(stdin) }
  if (echoStdin && stdin.byteLength) out.stdin.text = stdin.toString('utf8')

  out.files = files.map((p) => {
    try {
      const bytes = readFileSync(p)
      return {
        path: p,
        realPath: realpathSync(p),
        sha256: sha256(bytes),
        byteLength: bytes.byteLength,
        headHex: bytes.subarray(0, 48).toString('hex')
      }
    } catch (e) {
      return { path: p, error: String(e.code ?? e.message ?? e) }
    }
  })

  if (recordOut) writeFileSync(recordOut, JSON.stringify(out, null, 2))
  process.stdout.write(`VER05-COOP ${JSON.stringify({ argv: argv.length, stdin: out.stdin.sha256 })}\n`)
  process.exit(0)
}
