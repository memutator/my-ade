// Token composition for the mix bars.
//
// The bar plots ONLY components whose relation to each other is stated by the
// data it has: the top-level input and output counts. It deliberately does NOT
// subtract cache reads from input or reasoning from output to "nest" them —
// inferring containment from `cacheRead <= input` would be a numeric guess about
// semantics the aggregate rows do not carry (`UsageSemantics.componentRelations`
// is a reading-level fact and is not part of these rows). Cache/reasoning are
// therefore shown as their own labels, each of which can be unknown.
//
// A component the store did not report is `unknown`, never 0, and the bar says so
// through `unknown`, so an empty bar never reads as "nothing was used".

import type { UsageValues } from '../../../../../packages/mahas-contracts/src/index.ts'

export interface MixSegment {
  key: string
  className: string
  value: number
}

export function mixSegments(values: UsageValues): { segments: MixSegment[]; unknown: boolean } {
  const segments: MixSegment[] = []
  const { inputTotal, outputTotal, total } = values
  if (inputTotal !== null && inputTotal > 0) {
    segments.push({ key: 'in', className: 'in', value: inputTotal })
  }
  if (outputTotal !== null && outputTotal > 0) {
    segments.push({ key: 'out', className: 'out', value: outputTotal })
  }
  // neither component known but the reading reported a total: plot that alone
  // rather than inventing a split
  if (segments.length === 0 && total !== null && total > 0) {
    segments.push({ key: 'total', className: 'sum', value: total })
  }
  return { segments, unknown: inputTotal === null || outputTotal === null }
}
