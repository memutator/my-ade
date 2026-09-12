import { useRef, useState } from 'react'
import {
  ChevronRight,
  FilePlus2,
  FolderPlus,
  ListCollapse,
  ListTodo,
  RefreshCw
} from 'lucide-react'
import type { TodoItem } from '../types'
import { useStore } from '../store'
import { useT } from '../i18n'
import Tooltip from './Tooltip'
import FileTree, { type FileTreeApi } from './FileTree'
import TodoList from './TodoList'

const EMPTY_TODOS: TodoItem[] = []

export default function Sidebar(): React.JSX.Element | null {
  const open = useStore((s) => s.sidebarOpen)
  const activeWs = useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId))
  const project = useStore((s) => s.projects.find((p) => p.id === activeWs?.projectId))
  const todos = useStore((s) => (project ? (s.todos[project.id] ?? EMPTY_TODOS) : EMPTY_TODOS))
  const [todosOpen, setTodosOpen] = useState(true)
  const treeApi = useRef<FileTreeApi | null>(null)
  const t = useT()

  if (!open || !project) return null
  const done = todos.filter((x) => x.status === 'done').length
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="sidebar-title-row">
          <span className="sidebar-title">{project.name}</span>
          <span className="side-actions">
            <Tooltip label={t('newFile')}>
              <button className="side-btn" onClick={() => treeApi.current?.newFile()}>
                <FilePlus2 size={13} />
              </button>
            </Tooltip>
            <Tooltip label={t('newFolder')}>
              <button className="side-btn" onClick={() => treeApi.current?.newFolder()}>
                <FolderPlus size={13} />
              </button>
            </Tooltip>
            <Tooltip label={t('refresh')}>
              <button className="side-btn" onClick={() => treeApi.current?.refresh()}>
                <RefreshCw size={12} />
              </button>
            </Tooltip>
            <Tooltip label={t('collapseAll')}>
              <button className="side-btn" onClick={() => treeApi.current?.collapseAll()}>
                <ListCollapse size={13} />
              </button>
            </Tooltip>
          </span>
        </div>
        <span className="sidebar-path">{project.path}</span>
      </div>
      <FileTree key={project.path} rootPath={project.path} apiRef={treeApi} />
      <div className="sidebar-todos">
        <button className="sidebar-todos-head" onClick={() => setTodosOpen(!todosOpen)}>
          <ChevronRight size={11} className={`tchev${todosOpen ? ' open' : ''}`} />
          <ListTodo size={12} className="ticon" />
          {t('todos')}
          <span className="todo-count">
            {done}/{todos.length}
          </span>
        </button>
        {todosOpen && <TodoList projectId={project.id} />}
      </div>
    </aside>
  )
}
