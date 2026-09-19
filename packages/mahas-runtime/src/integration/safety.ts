import { createHash } from 'node:crypto'

const SECRET_KEY = /(?:secret|token|password|credential|authorization|api[_-]?key|cookie)/i
const SECRET_TEXT =
  /(?:bearer\s+[a-z0-9._~+/-]+|(?:token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+)/gi

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

export function redactText(value: unknown, maxBytes = 2_048): string {
  const raw = String(value ?? '').replace(SECRET_TEXT, '[REDACTED]')
  const bytes = Buffer.from(raw)
  if (bytes.byteLength <= maxBytes) return raw
  return `${bytes.subarray(0, maxBytes).toString('utf8')}…[truncated]`
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      out[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactValue(item, depth + 1)
    }
    return out
  }
  return typeof value === 'string' ? redactText(value) : value
}
