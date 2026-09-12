import { ListTodo } from 'lucide-react'
import type { TodoPaneState } from '../types'
import { useStore } from '../store'
import PaneFrame from './PaneFrame'
import TodoList from './TodoList'

export default function TodoPane({
  pane,
  wsId
}: {
  pane: TodoPaneState
  wsId: string
}): React.JSX.Element {
  const projectId = useStore((s) => s.workspaces.find((w) => w.id === wsId)?.projectId)
  return (
    <PaneFrame pane={pane} wsId={wsId} icon={<ListTodo className="picon" />}>
      <div className="todo-host">{projectId && <TodoList projectId={projectId} />}</div>
    </PaneFrame>
  )
}
