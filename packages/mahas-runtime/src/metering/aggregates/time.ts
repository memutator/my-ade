export type TimeGrain = 'alltime' | 'hour' | 'day' | 'week'

export interface TimeBucket {
  grain: TimeGrain
  startUtc: number | null
  endUtc: number | null
  timeZone: string
  weekStart: number
}

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone)
  if (!value) {
    value = new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    })
    // Force eager validation of the IANA zone.
    value.format(0)
    formatters.set(timeZone, value)
  }
  return value
}

export function localParts(at: number, timeZone: string): LocalParts {
  const out: Record<string, number> = {}
  for (const p of formatter(timeZone).formatToParts(new Date(at))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  }
  return { year: out['year']!, month: out['month']!, day: out['day']!, hour: out['hour']!, minute: out['minute']!, second: out['second']! }
}

function sameLocal(a: LocalParts, b: LocalParts): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day &&
    a.hour === b.hour && a.minute === b.minute && a.second === b.second
}

/** Resolve a civil time to all matching instants. A fold has two results, a
 * skipped civil time has none. Searching possible offsets avoids assuming a
 * locale's current offset applies to historical/future dates. */
export function instantsForLocal(parts: LocalParts, timeZone: string): number[] {
  const nominal = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  const found: number[] = []
  for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
    const candidate = nominal - offsetMinutes * 60_000
    if (sameLocal(localParts(candidate, timeZone), parts)) found.push(candidate)
  }
  return [...new Set(found)].sort((a, b) => a - b)
}

function localMidnight(parts: Pick<LocalParts, 'year' | 'month' | 'day'>, timeZone: string): number {
  const exact = instantsForLocal({ ...parts, hour: 0, minute: 0, second: 0 }, timeZone)
  if (exact.length) return exact[0]!
  // Midnight can be skipped when a jurisdiction changes offset. The first
  // instant displaying the requested date is its honest boundary.
  const nominal = Date.UTC(parts.year, parts.month - 1, parts.day)
  for (let at = nominal - 14 * 3_600_000; at <= nominal + 38 * 3_600_000; at += 60_000) {
    const p = localParts(at, timeZone)
    if (p.year === parts.year && p.month === parts.month && p.day === parts.day) return at
  }
  throw new RangeError(`cannot resolve local date in ${timeZone}`)
}

function addCivilDays(parts: Pick<LocalParts, 'year' | 'month' | 'day'>, days: number): Pick<LocalParts, 'year' | 'month' | 'day'> {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

function isoWeekday(parts: Pick<LocalParts, 'year' | 'month' | 'day'>): number {
  const n = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
  return n === 0 ? 7 : n
}

export function bucketForPoint(at: number, grain: Exclude<TimeGrain, 'alltime'>, timeZone: string, weekStart = 1): TimeBucket {
  const p = localParts(at, timeZone)
  if (grain === 'hour') {
    // Removing the displayed minute/second from this instant preserves which
    // occurrence of a repeated DST hour was observed.
    const start = at - p.minute * 60_000 - p.second * 1_000 - (at % 1_000)
    return { grain, startUtc: start, endUtc: start + 3_600_000, timeZone, weekStart }
  }
  let date = { year: p.year, month: p.month, day: p.day }
  let days = 1
  if (grain === 'week') {
    const back = (isoWeekday(date) - weekStart + 7) % 7
    date = addCivilDays(date, -back)
    days = 7
  }
  return {
    grain,
    startUtc: localMidnight(date, timeZone),
    endUtc: localMidnight(addCivilDays(date, days), timeZone),
    timeZone,
    weekStart
  }
}

export function bucketForInterval(startExclusive: number, endInclusive: number, grain: Exclude<TimeGrain, 'alltime'>, timeZone: string, weekStart = 1): TimeBucket | null {
  if (endInclusive <= startExclusive) return null
  const first = bucketForPoint(startExclusive + 1, grain, timeZone, weekStart)
  const last = bucketForPoint(endInclusive, grain, timeZone, weekStart)
  return first.startUtc === last.startUtc ? first : null
}

export function completedWeekBuckets(asOf: number, count: number, timeZone: string, weekStart = 1): TimeBucket[] {
  const current = bucketForPoint(asOf, 'week', timeZone, weekStart)
  const startLocal = localParts(current.startUtc!, timeZone)
  const result: TimeBucket[] = []
  for (let i = count; i >= 1; i--) {
    const date = addCivilDays(startLocal, -7 * i)
    result.push({ grain: 'week', startUtc: localMidnight(date, timeZone), endUtc: localMidnight(addCivilDays(date, 7), timeZone), timeZone, weekStart })
  }
  return result
}
