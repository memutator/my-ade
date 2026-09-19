// Token composition bar (see `mix.ts` for the containment rules it applies).

import type { UsageValues } from '../../../../../packages/mahas-contracts/src/index.ts'
import { mixSegments } from './mix'

export interface MixBarProps {
  values: UsageValues
  height?: number
}

export function MixBar({ values, height = 8 }: MixBarProps): React.JSX.Element {
  const { segments, unknown } = mixSegments(values)
  const sum = segments.reduce((total, segment) => total + segment.value, 0)
  if (!segments.length || sum <= 0) {
    return (
      <div
        className="dash-mix empty"
        style={{ height }}
        data-unknown={unknown ? 'true' : undefined}
      />
    )
  }
  return (
    <div className="dash-mix" style={{ height }}>
      {segments.map((segment) => (
        <span
          key={segment.key}
          className={`dash-mix-seg ${segment.className}`}
          style={{ width: `${(segment.value / sum) * 100}%` }}
        />
      ))}
    </div>
  )
}

/** compact "≈" marker for a total that includes unknown components */
export function UnknownMark({ values }: { values: UsageValues }): React.JSX.Element | null {
  const unknown = values.inputTotal === null || values.outputTotal === null || values.total === null
  if (!unknown) return null
  return (
    <em className="cov-unknown" title="some token components are unknown">
      ≈
    </em>
  )
}
