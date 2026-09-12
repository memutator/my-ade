import { useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import Tooltip from './Tooltip'

export interface TabItem {
  id: string
  label: string
  sub?: string
  icon?: ReactNode
  dirty?: boolean
}

export default function TabStrip({
  tabs,
  activeId,
  onActivate,
  onClose,
  onRename,
  onReorder,
  addControl
}: {
  tabs: TabItem[]
  activeId?: string | null
  onActivate: (id: string) => void
  onClose?: (id: string) => void
  onRename?: (id: string, name: string) => void
  onReorder?: (from: number, to: number) => void
  addControl?: ReactNode
}): React.JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const dragIdx = useRef(-1)

  const commit = (id: string): void => {
    onRename?.(id, editValue)
    setEditingId(null)
  }

  return (
    <div className="tstrip" onPointerDown={(e) => e.stopPropagation()}>
      {tabs.map((t, i) => (
        <Tooltip key={t.id} label={t.sub ? `${t.label} — ${t.sub}` : t.label}>
          <div
            className={`ctab${t.id === activeId ? ' active' : ''}`}
            draggable={!!onReorder && editingId !== t.id}
            onDragStart={() => (dragIdx.current = i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (onReorder && dragIdx.current >= 0 && dragIdx.current !== i)
                onReorder(dragIdx.current, i)
              dragIdx.current = -1
            }}
            onClick={() => onActivate(t.id)}
            onDoubleClick={() => {
              if (!onRename) return
              setEditingId(t.id)
              setEditValue(t.label)
            }}
          >
            {t.icon}
            {editingId === t.id ? (
              <input
                className="ctab-rename"
                autoFocus
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={() => commit(t.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit(t.id)
                  if (e.key === 'Escape') setEditingId(null)
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="ctab-label">{t.label}</span>
            )}
            {t.sub && <span className="ctab-sub">{t.sub}</span>}
            {t.dirty && <span className="ctab-dot" title="unsaved changes" />}
            {onClose && (
              <button
                className="ctab-close"
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(t.id)
                }}
              >
                <X size={11} />
              </button>
            )}
          </div>
        </Tooltip>
      ))}
      {addControl}
    </div>
  )
}
