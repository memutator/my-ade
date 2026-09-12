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
    .map((d) => list.find((t) => t.id === d))
    .filter((t): t is TodoItem => !!t && t.status !== 'done')
  const blocked = blockers.length > 0
  // dep picker: exclude self and descendants (a todo can't depend on its own subtree)
  const depRows = depsOpen
    ? buildRows(list.filter((t) => t.id !== item.id && !descendantIds(list, item.id).has(t.id)))
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
      <button
        className="todo-check"
        title={
          blocked ? `blocked by: ${blockers.map((t) => t.text).join(', ')}` : 'todo → doing → done'
        }
        onClick={() => cycleTodo(projectId, item.id)}
      >
        {statusIcon(item.status)}
      </button>
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
      {blocked && <span className="todo-badge">blocked</span>}
      <div className="todo-actions">
        <button
          className="pbtn"
          title="Indent"
          disabled={!canIndent}
          onClick={() => indentTodo(projectId, item.id)}
        >
          <IndentIncrease />
        </button>
        <button
          className="pbtn"
          title="Outdent"
          disabled={!item.parentId}
          onClick={() => outdentTodo(projectId, item.id)}
        >
          <IndentDecrease />
        </button>
        <div className="todo-dep-wrap" ref={depWrapRef}>
          <button
            className={`pbtn${item.dependsOn.length ? ' has-deps' : ''}`}
            title="Dependencies"
            onClick={() => setDepsOpen(!depsOpen)}
          >
            <Link2 />
          </button>
          {depsOpen && (
            <div className="todo-deps">
              {depRows.length === 0 && <div className="todo-deps-empty">no other todos</div>}
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
                  <span className="tname">{r.item.text || '(empty)'}</span>
                  {item.dependsOn.includes(r.item.id) && <Check className="dep-check" />}
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="pbtn" title="Delete" onClick={() => removeTodo(projectId, item.id)}>
          <Trash2 />
        </button>
      </div>
    </div>
  )
}

export default function TodoList({ projectId }: { projectId: string }): React.JSX.Element {
  const list = useStore((s) => s.todos[projectId] ?? EMPTY)
  const addTodo = useStore((s) => s.addTodo)
  const [text, setText] = useState('')
  const rows = buildRows(list)

  const add = (): void => {
    const t = text.trim()
    if (!t) return
    addTodo(projectId, t)
    setText('')
  }

  return (
    <div className="todo-list">
      <div className="todo-scroll">
        {rows.length === 0 && <div className="todo-empty">no todos yet</div>}
        {rows.map((r) => (
          <TodoRow key={r.item.id} projectId={projectId} row={r} list={list} />
        ))}
      </div>
      <div className="todo-add">
        <Plus />
        <input
          value={text}
          placeholder="add a todo…"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
      </div>
    </div>
  )
}
