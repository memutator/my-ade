import { useEffect, useRef, useState } from 'react'
import {
  Check,
  CheckCircle2,
  Circle,
  CircleDot,
  IndentDecrease,
  IndentIncrease,
  Link2,
  Plus,
  Trash2
} from 'lucide-react'
import type { TodoItem, TodoStatus } from '../types'
import { useStore } from '../store'
import { useT } from '../i18n'
import Tooltip from './Tooltip'

const EMPTY: TodoItem[] = []
const DND_TYPE = 'application/x-ade-todo'

interface Row {
  item: TodoItem
  depth: number
  canIndent: boolean
}

// flatten the parentId tree into DFS order; orphans surface as roots
function buildRows(list: TodoItem[]): Row[] {
  const byParent = new Map<string | undefined, TodoItem[]>()
  for (const t of list) byParent.set(t.parentId, [...(byParent.get(t.parentId) ?? []), t])
  for (const sibs of byParent.values()) sibs.sort((a, b) => a.order - b.order)
  const rows: Row[] = []
  const seen = new Set<string>()
  const walk = (parentId: string | undefined, depth: number): void => {
    const sibs = byParent.get(parentId) ?? []
    sibs.forEach((t, i) => {
      seen.add(t.id)
      rows.push({ item: t, depth, canIndent: i > 0 })
      walk(t.id, depth + 1)
    })
  }
  walk(undefined, 0)
  for (const t of list) if (!seen.has(t.id)) rows.push({ item: t, depth: 0, canIndent: false })
  return rows
}

function descendantIds(list: TodoItem[], id: string): Set<string> {
  const out = new Set<string>()
  const queue = [id]
  while (queue.length) {
    const cur = queue.pop()!
    for (const t of list)
      if (t.parentId === cur && !out.has(t.id)) {
        out.add(t.id)
        queue.push(t.id)
      }
  }
  return out
}

function statusIcon(status: TodoStatus): React.JSX.Element {
  if (status === 'done') return <CheckCircle2 />
  if (status === 'doing') return <CircleDot />
  return <Circle />
}

function TodoRow({
  projectId,
  row,
  list
}: {
  projectId: string
  row: Row
  list: TodoItem[]
}): React.JSX.Element {
  const { item, depth, canIndent } = row
  const t = useT()
  const cycleTodo = useStore((s) => s.cycleTodo)
  const updateTodo = useStore((s) => s.updateTodo)
  const removeTodo = useStore((s) => s.removeTodo)
  const indentTodo = useStore((s) => s.indentTodo)
  const outdentTodo = useStore((s) => s.outdentTodo)
  const reorderTodo = useStore((s) => s.reorderTodo)
  const [draft, setDraft] = useState<string | null>(null)
  const [depsOpen, setDepsOpen] = useState(false)
  const [drop, setDrop] = useState<'before' | 'after' | null>(null)
  const depWrapRef = useRef<HTMLDivElement>(null)

  const blockers = item.dependsOn
    .map((d) => list.find((x) => x.id === d))
    .filter((x): x is TodoItem => !!x && x.status !== 'done')
  const blocked = blockers.length > 0
  // dep picker: exclude self and descendants (a todo can't depend on its own subtree)
  const depRows = depsOpen
    ? buildRows(list.filter((x) => x.id !== item.id && !descendantIds(list, item.id).has(x.id)))
    : []

  useEffect(() => {
    if (!depsOpen) return
    const onDown = (e: PointerEvent): void => {
      if (!depWrapRef.current?.contains(e.target as Node)) setDepsOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDepsOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [depsOpen])

  const commit = (): void => {
    const text = (draft ?? '').trim()
    if (!text) removeTodo(projectId, item.id)
    else if (text !== item.text) updateTodo(projectId, item.id, { text })
    setDraft(null)
  }

  const toggleDep = (depId: string): void => {
    const dependsOn = item.dependsOn.includes(depId)
      ? item.dependsOn.filter((d) => d !== depId)
      : [...item.dependsOn, depId]
    updateTodo(projectId, item.id, { dependsOn })
  }

  const dropPlace = (e: React.DragEvent): 'before' | 'after' => {
    const r = e.currentTarget.getBoundingClientRect()
    return e.clientY < r.top + r.height / 2 ? 'before' : 'after'
  }

  return (
    <div
      className={`todo-row st-${item.status}${drop ? ` drop-${drop}` : ''}${depsOpen ? ' picking' : ''}`}
      style={{ paddingLeft: 4 + depth * 14 }}
      draggable={draft === null}
      onDragStart={(e) => {
        e.dataTransfer.setData(DND_TYPE, item.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DND_TYPE)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDrop(dropPlace(e))
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null)
      }}
      onDrop={(e) => {
        e.preventDefault()
        const id = e.dataTransfer.getData(DND_TYPE)
        if (id) reorderTodo(projectId, id, item.id, dropPlace(e))
        setDrop(null)
      }}
      onDragEnd={() => setDrop(null)}
    >
      <Tooltip
        label={
          blocked
            ? t('blockedBy', { list: blockers.map((x) => x.text).join(', ') })
            : t('todoCycle')
        }
      >
        <button className="todo-check" onClick={() => cycleTodo(projectId, item.id)}>
          {statusIcon(item.status)}
        </button>
      </Tooltip>
      {draft === null ? (
        <span className="todo-text" onClick={() => setDraft(item.text)}>
          {item.text || ' '}
        </span>
      ) : (
        <input
          className="todo-edit"
          autoFocus
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') setDraft(null)
            else if (e.key === 'Tab') {
              e.preventDefault()
              if (e.shiftKey) outdentTodo(projectId, item.id)
              else indentTodo(projectId, item.id)
            }
          }}
        />
      )}
      {blocked && <span className="todo-badge">{t('blocked')}</span>}
      <div className="todo-actions">
        <Tooltip label={t('indent')}>
          <button
            className="pbtn"
            disabled={!canIndent}
            onClick={() => indentTodo(projectId, item.id)}
          >
            <IndentIncrease />
          </button>
        </Tooltip>
        <Tooltip label={t('outdent')}>
          <button
            className="pbtn"
            disabled={!item.parentId}
            onClick={() => outdentTodo(projectId, item.id)}
          >
            <IndentDecrease />
          </button>
        </Tooltip>
        <div className="todo-dep-wrap" ref={depWrapRef}>
          <Tooltip label={t('dependencies')}>
            <button
              className={`pbtn${item.dependsOn.length ? ' has-deps' : ''}`}
              onClick={() => setDepsOpen(!depsOpen)}
            >
              <Link2 />
            </button>
          </Tooltip>
          {depsOpen && (
            <div className="todo-deps">
              {depRows.length === 0 && <div className="todo-deps-empty">{t('noOtherTodos')}</div>}
              {depRows.map((r) => (
                <button
                  key={r.item.id}
                  className="todo-dep-item"
                  style={{ paddingLeft: 8 + r.depth * 12 }}
                  onClick={() => toggleDep(r.item.id)}
                >
                  <span className={`todo-dep-ic st-${r.item.status}`}>
                    {statusIcon(r.item.status)}
                  </span>
                  <span className="tname">{r.item.text || t('unnamedTodo')}</span>
                  {item.dependsOn.includes(r.item.id) && <Check className="dep-check" />}
                </button>
              ))}
            </div>
          )}
        </div>
        <Tooltip label={t('deleteTodo')}>
          <button className="pbtn" onClick={() => removeTodo(projectId, item.id)}>
            <Trash2 />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

export default function TodoList({ projectId }: { projectId: string }): React.JSX.Element {
  const list = useStore((s) => s.todos[projectId] ?? EMPTY)
  const addTodo = useStore((s) => s.addTodo)
  const t = useT()
  const [text, setText] = useState('')
  const rows = buildRows(list)

  const add = (): void => {
    const txt = text.trim()
    if (!txt) return
    addTodo(projectId, txt)
    setText('')
  }

  return (
    <div className="todo-list">
      <div className="todo-scroll">
        {rows.length === 0 && <div className="todo-empty">{t('noTodosYet')}</div>}
        {rows.map((r) => (
          <TodoRow key={r.item.id} projectId={projectId} row={r} list={list} />
        ))}
      </div>
      <div className="todo-add">
        <Plus />
        <input
          value={text}
          placeholder={t('addTodoItem')}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
      </div>
    </div>
  )
}
