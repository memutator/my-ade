import { useEffect, useState } from 'react'
import { agentColor, agentIcon, agentLabel } from '../agents'

// Provider brand icon — fetched once via the vendor domain (Chrome favicon
// model, disk-cached in main). Falls back to a brand-colored letter monogram.
export default function AgentIcon({
  id,
  size = 12
}: {
  id: string
  size?: number
}): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let on = true
    agentIcon(id).then((s) => {
      if (on) setSrc(s)
    })
    return () => {
      on = false
    }
  }, [id])
  if (src) {
    return (
      <img className="agent-icon" src={src} width={size} height={size} alt="" draggable={false} />
    )
  }
  return (
    <span
      className="agent-icon agent-mono"
      style={{
        width: size,
        height: size,
        background: agentColor(id) ?? 'var(--border-strong)',
        fontSize: Math.round(size * 0.62)
      }}
    >
      {agentLabel(id)[0]}
    </span>
  )
}
