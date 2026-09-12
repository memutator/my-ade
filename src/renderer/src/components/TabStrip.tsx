import { useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useT } from '../i18n'
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
  const t = useT()

  const commit = (id: string): void => {
    onRename?.(id, editValue)
    setEditingId(null)
  }

  return (
    <div className="tstrip" onPointerDown={(e) => e.stopPropagation()}>
      {tabs.map((tab, i) => (
        <Tooltip key={tab.id} label={tab.sub ? `${tab.label} — ${tab.sub}` : tab.label}>
          <div
            className={`ctab${tab.id === activeId ? ' active' : ''}`}
            draggable={!!onReorder && editingId !== tab.id}
            onDragStart={() => (dragIdx.current = i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (onReorder && dragIdx.current >= 0 && dragIdx.current !== i)
                onReorder(dragIdx.current, i)
              dragIdx.current = -1
            }}
            onClick={() => onActivate(tab.id)}
            onDoubleClick={() => {
              if (!onRename) return
              setEditingId(tab.id)
              setEditValue(tab.label)
            }}
          >
            {tab.icon}
            {editingId === tab.id ? (
              <input
                className="ctab-rename"
                autoFocus
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={() => commit(tab.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit(tab.id)
                  if (e.key === 'Escape') setEditingId(null)
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="ctab-label">{tab.label}</span>
            )}
            {tab.sub && <span className="ctab-sub">{tab.sub}</span>}
            {tab.dirty && (
              <Tooltip label={t('unsavedChanges')}>
                <span className="ctab-dot" />
              </Tooltip>
            )}
            {onClose && (
              <button
                className="ctab-close"
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(tab.id)
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
