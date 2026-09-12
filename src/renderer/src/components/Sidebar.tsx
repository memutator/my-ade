import { useState } from 'react'
import { ChevronRight, ListTodo } from 'lucide-react'
import type { TodoItem } from '../types'
import { useStore } from '../store'
import FileTree from './FileTree'
import TodoList from './TodoList'

const EMPTY_TODOS: TodoItem[] = []

export default function Sidebar(): React.JSX.Element | null {
  const open = useStore((s) => s.sidebarOpen)
  const activeWs = useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId))
  const project = useStore((s) => s.projects.find((p) => p.id === activeWs?.projectId))
  const todos = useStore((s) => (project ? (s.todos[project.id] ?? EMPTY_TODOS) : EMPTY_TODOS))
  const [todosOpen, setTodosOpen] = useState(true)

  if (!open || !project) return null
  const done = todos.filter((t) => t.status === 'done').length
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-title">{project.name}</span>
        <span className="sidebar-path">{project.path}</span>
      </div>
      <FileTree rootPath={project.path} />
      <div className="sidebar-todos">
        <button className="sidebar-todos-head" onClick={() => setTodosOpen(!todosOpen)}>
          <ChevronRight size={11} className={`tchev${todosOpen ? ' open' : ''}`} />
          <ListTodo size={12} className="ticon" />
          todos
          <span className="todo-count">
            {done}/{todos.length}
          </span>
        </button>
        {todosOpen && <TodoList projectId={project.id} />}
      </div>
    </aside>
  )
}
