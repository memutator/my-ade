// ade pty-host — runs under system Node (not Electron) so node-pty ABI always matches.
// Protocol: newline-delimited JSON over stdio.
//   in : {t:'spawn',id,cols,rows,cwd,command,args} | {t:'write',id,d(base64)} |
//        {t:'resize',id,cols,rows} | {t:'kill',id} |
//        {t:'config',agents:{id:[patterns]}}
//   out: {t:'ready'} | {t:'spawned',id,pid} | {t:'data',id,d(base64)} |
//        {t:'exit',id,code} | {t:'cwd',id,cwd} | {t:'agent',id,agent} | {t:'error',id,msg}

const readline = require('readline')
const fs = require('fs')
const path = require('path')
const pty = require('@homebridge/node-pty-prebuilt-multiarch')

const procs = new Map() // id -> { pty, cwdTimer, lastCwd, lastAgent }

// fallback patterns; overridden by {t:'config'} from the app
let AGENTS = {
  claude: ['claude'],
  codex: ['codex'],
  gemini: ['gemini'],
  grok: ['grok'],
  devin: ['devin'],
  cursor: ['cursor-agent', 'cursor'],
  copilot: ['copilot'],
  aider: ['aider'],
  opencode: ['opencode'],
  amp: ['amp'],
  crush: ['crush'],
  goose: ['goose']
}

function send(msg) {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n')
  } catch {
    /* stdout closed */
  }
}

function cleanup(id) {
  const entry = procs.get(id)
  if (!entry) return
  if (entry.timer) clearInterval(entry.timer)
  procs.delete(id)
}

function readCwd(pid) {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    return null
  }
}

function childrenOf(pid) {
  try {
    return fs
      .readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
  } catch {
    return []
  }
}

function procSignature(pid) {
  try {
    const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
    let argvBase = ''
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
      // basenames only: catches `node .../bin/claude` without matching random args
      argvBase = argv.map((a) => path.basename(a).toLowerCase()).join(' ')
    } catch {
      /* gone */
    }
    return `${comm.toLowerCase()} ${argvBase}`
  } catch {
    return ''
  }
}

// breadth-first walk of the process tree under the shell, looking for a known agent
function detectAgent(shellPid) {
  const seen = new Set()
  let queue = [shellPid]
  for (let depth = 0; depth < 6 && queue.length; depth++) {
    const next = []
    for (const pid of queue) {
      if (seen.has(pid)) continue
      seen.add(pid)
      const sig = procSignature(pid)
      if (sig) {
        for (const [agent, patterns] of Object.entries(AGENTS)) {
          if (patterns.some((p) => sig.includes(p.toLowerCase()))) return agent
        }
      }
      for (const c of childrenOf(pid)) next.push(c)
    }
    queue = next
  }
  return null
}

function handleSpawn(m) {
  const command = m.command || process.env.SHELL || '/bin/bash'
  const args = Array.isArray(m.args) ? m.args : []
  let proc
  try {
    proc = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: m.cols || 80,
      rows: m.rows || 24,
      cwd: m.cwd || process.env.HOME || '/',
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    })
  } catch (e) {
    send({ t: 'error', id: m.id, msg: String(e && e.message ? e.message : e) })
    return
  }

  const entry = { pty: proc, lastCwd: null, lastAgent: null, timer: null }
  procs.set(m.id, entry)

  proc.onData((d) => {
    send({ t: 'data', id: m.id, d: Buffer.from(d, 'utf8').toString('base64') })
  })
  proc.onExit((e) => {
    send({ t: 'exit', id: m.id, code: e.exitCode })
    cleanup(m.id)
  })

  const poll = () => {
    const cwd = readCwd(proc.pid)
    if (cwd && cwd !== entry.lastCwd) {
      entry.lastCwd = cwd
      send({ t: 'cwd', id: m.id, cwd })
    }
    const agent = detectAgent(proc.pid)
    if (agent !== entry.lastAgent) {
      entry.lastAgent = agent
      send({ t: 'agent', id: m.id, agent })
    }
  }
  poll()
  entry.timer = setInterval(poll, 1200)

  send({ t: 'spawned', id: m.id, pid: proc.pid, shell: path.basename(command) })
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  switch (m.t) {
    case 'spawn':
      handleSpawn(m)
      break
    case 'write': {
      const entry = procs.get(m.id)
      if (entry) entry.pty.write(Buffer.from(m.d, 'base64').toString('utf8'))
      break
    }
    case 'resize': {
      const entry = procs.get(m.id)
      if (entry) {
        try {
          entry.pty.resize(m.cols, m.rows)
        } catch {
          /* process gone */
        }
      }
      break
    }
    case 'kill': {
      const entry = procs.get(m.id)
      if (entry) {
        try {
          entry.pty.kill()
        } catch {
          /* already dead */
        }
        cleanup(m.id)
      }
      break
    }
    case 'config':
      if (m.agents && typeof m.agents === 'object') AGENTS = m.agents
      break
  }
})

rl.on('close', () => {
  for (const { pty: p } of procs.values()) {
    try {
      p.kill()
    } catch {
      /* noop */
    }
  }
  process.exit(0)
})

send({ t: 'ready' })
