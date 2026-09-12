import { useCallback } from 'react'
import { useStore } from './store'
import type { Language } from './types'

export type Lang = 'en' | 'ko'

const en = {
  // pane types
  terminal: 'terminal',
  browser: 'browser',
  editor: 'editor',
  todos: 'todos',

  // top bar
  filesPeek: 'Files — hover to peek, click to pin',
  newTerminal: 'New terminal (Alt+T)',
  newBrowser: 'New browser (Alt+B)',
  newEditor: 'New editor (Alt+E)',
  newTodo: 'New todo list (Alt+L)',
  settingsTooltip: 'Settings',
  toggleTheme: 'Toggle theme (Alt+M)',
  minimize: 'Minimize',
  maximize: 'Maximize',
  close: 'Close',

  // workspaces / projects
  newWorkspace: 'New workspace',
  addProjectItem: '+ add project…',
  addProject: 'add project',
  chooseDir: 'choose dir…',
  workspace: 'workspace',

  // pane frame
  splitRight: 'Split right (Alt+D)',
  splitDown: 'Split down (Alt+S)',
  minimizePane: 'Minimize pane (Alt+H)',
  restorePane: 'Restore pane',
  closePane: 'Close (Alt+W)',
  dragToMove: 'Drag to move pane',

  // terminal pane
  restartShell: 'Restart shell',
  processExited: 'process exited — click to restart',
  shellExited: 'process exited',
  newTerminalTab: 'New terminal tab',
  agentFinished: '{agent} finished',
  ptyError: 'pty error',

  // editor pane
  openFileTooltip: 'Open file…',
  noFileOpen: 'no file open',
  openFile: 'open file…',
  saveFailed: 'save failed: {name}',
  unsavedChanges: 'unsaved changes',

  // browser pane
  back: 'Back',
  forward: 'Forward',
  reload: 'Reload',
  stop: 'Stop',
  homeUrl: 'Home page',
  tabs: 'Tabs',
  bookmarks: 'Bookmarks',
  urlOrSearch: 'url or search…',
  newTab: 'new tab',
  saveTo: 'save to {name}',
  removeBookmark: 'remove bookmark',
  global: 'global',
  project: 'project',
  noBookmarks: 'no bookmarks',
  pageFailed: 'page failed to load',
  pageCrashed: 'page crashed',
  retry: 'retry',

  // todo list
  todoCycle: 'todo → doing → done',
  blockedBy: 'blocked by: {list}',
  blocked: 'blocked',
  indent: 'Indent',
  outdent: 'Outdent',
  dependencies: 'Dependencies',
  noOtherTodos: 'no other todos',
  unnamedTodo: '(empty)',
  deleteTodo: 'Delete',
  noTodosYet: 'no todos yet',
  addTodoItem: 'add a todo…',

  // notification center
  notificationsTooltip: 'Notifications',
  notifications: 'notifications',
  markAllRead: 'Mark all read',
  clearAll: 'Clear all',
  noNotifications: 'no notifications',
  agentNeedsInput: '{agent} needs input',

  // settings modal
  settings: 'settings',
  appearance: 'appearance',
  theme: 'theme',
  dark: 'dark',
  light: 'light',
  system: 'system',
  accent: 'accent',
  uiFont: 'ui font',
  terminalFont: 'terminal font',
  terminalFontSize: 'terminal font size',
  language: 'language',
  osNotifications: 'os notifications',
  agentProviders: 'agent providers',
  noProviders: 'no providers found',
  agentHooks: 'agent hooks',
  noHookableProviders: 'no hookable providers',
  hookInstalled: 'installed',
  hookNotInstalled: 'not installed',
  hookCliNotFound: 'cli not found',
  install: 'install',
  test: 'test',

  // file tree / file view
  loading: 'loading…',
  empty: 'empty',
  open: 'Open',
  newFile: 'New File',
  newFolder: 'New Folder',
  rename: 'Rename',
  delete: 'Delete',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  duplicate: 'Duplicate',
  copyPath: 'Copy Path',
  copyRelPath: 'Copy Relative Path',
  reveal: 'Reveal in File Manager',
  refresh: 'Refresh',
  collapseAll: 'Collapse All',

  // worktrees
  worktrees: 'worktrees',
  newWorktree: 'New worktree workspace',
  createWorktree: 'create worktree',
  branch: 'branch',
  baseRef: 'base',
  worktreeAt: 'location',
  notARepo: 'not a git repository',
  noWorktrees: 'no worktrees',
  openWorkspaceHere: 'open workspace',
  removeWorktree: 'remove worktree',
  forceRemove: 'force remove (dirty)',
  binaryFile: 'binary file',
  fileChangedOnDisk: 'changed on disk',
  fileDeletedOnDisk: 'deleted on disk',
  fileChangedConfirm: 'changed on disk since you opened it — overwrite?',
  fileDeletedConfirm: 'deleted on disk — save anyway to recreate it?',
  keepMine: 'keep mine',
  overwrite: 'overwrite',
  saveAnyway: 'save anyway',
  cancel: 'cancel',
  reloadedFromDisk: 'reloaded from disk'
} as const

export type TKey = keyof typeof en

const ko: Record<TKey, string> = {
  terminal: '터미널',
  browser: '브라우저',
  editor: '에디터',
  todos: '할 일',

  filesPeek: '파일 — 호버로 미리보기, 클릭으로 고정',
  newTerminal: '새 터미널 (Alt+T)',
  newBrowser: '새 브라우저 (Alt+B)',
  newEditor: '새 에디터 (Alt+E)',
  newTodo: '새 할 일 목록 (Alt+L)',
  settingsTooltip: '설정',
  toggleTheme: '테마 전환 (Alt+M)',
  minimize: '최소화',
  maximize: '최대화',
  close: '닫기',

  newWorkspace: '새 워크스페이스',
  addProjectItem: '+ 프로젝트 추가…',
  addProject: '프로젝트 추가',
  chooseDir: '폴더 선택…',
  workspace: '워크스페이스',

  splitRight: '오른쪽으로 분할 (Alt+D)',
  splitDown: '아래로 분할 (Alt+S)',
  minimizePane: '패널 최소화 (Alt+H)',
  restorePane: '패널 복원',
  closePane: '닫기 (Alt+W)',
  dragToMove: '드래그하여 패널 이동',

  restartShell: '셸 다시 시작',
  processExited: '프로세스가 종료됨 — 클릭하여 다시 시작',
  shellExited: '프로세스가 종료됨',
  newTerminalTab: '새 터미널 탭',
  agentFinished: '{agent} 완료',
  ptyError: 'pty 오류',

  openFileTooltip: '파일 열기…',
  noFileOpen: '열린 파일 없음',
  openFile: '파일 열기…',
  saveFailed: '저장 실패: {name}',
  unsavedChanges: '저장되지 않은 변경 사항',

  back: '뒤로',
  forward: '앞으로',
  reload: '새로고침',
  stop: '정지',
  homeUrl: '홈페이지',
  tabs: '탭',
  bookmarks: '북마크',
  urlOrSearch: 'URL 또는 검색어…',
  newTab: '새 탭',
  saveTo: '{name}에 저장',
  removeBookmark: '북마크 삭제',
  global: '전역',
  project: '프로젝트',
  noBookmarks: '북마크 없음',
  pageFailed: '페이지 로드 실패',
  pageCrashed: '페이지 충돌',
  retry: '다시 시도',

  todoCycle: '할 일 → 진행 중 → 완료',
  blockedBy: '차단됨: {list}',
  blocked: '차단됨',
  indent: '들여쓰기',
  outdent: '내어쓰기',
  dependencies: '의존성',
  noOtherTodos: '다른 할 일 없음',
  unnamedTodo: '(내용 없음)',
  deleteTodo: '삭제',
  noTodosYet: '아직 할 일 없음',
  addTodoItem: '할 일 추가…',

  notificationsTooltip: '알림',
  notifications: '알림',
  markAllRead: '모두 읽음 표시',
  clearAll: '모두 지우기',
  noNotifications: '알림 없음',
  agentNeedsInput: '{agent} 입력 필요',

  settings: '설정',
  appearance: '모양',
  theme: '테마',
  dark: '다크',
  light: '라이트',
  system: '시스템',
  accent: '강조색',
  uiFont: 'UI 글꼴',
  terminalFont: '터미널 글꼴',
  terminalFontSize: '터미널 글꼴 크기',
  language: '언어',
  osNotifications: 'OS 알림',
  agentProviders: '에이전트 제공자',
  noProviders: '제공자를 찾을 수 없음',
  agentHooks: '에이전트 훅',
  noHookableProviders: '훅 가능한 제공자 없음',
  hookInstalled: '설치됨',
  hookNotInstalled: '설치되지 않음',
  hookCliNotFound: 'CLI를 찾을 수 없음',
  install: '설치',
  test: '테스트',

  loading: '로딩…',
  empty: '비어 있음',
  open: '열기',
  newFile: '새 파일',
  newFolder: '새 폴더',
  rename: '이름 바꾸기',
  delete: '삭제',
  cut: '잘라내기',
  copy: '복사',
  paste: '붙여넣기',
  duplicate: '복제',
  copyPath: '경로 복사',
  copyRelPath: '상대 경로 복사',
  reveal: '파일 관리자에서 보기',
  refresh: '새로고침',
  collapseAll: '모두 접기',

  worktrees: '워크트리',
  newWorktree: '새 워크트리 워크스페이스',
  createWorktree: '워크트리 생성',
  branch: '브랜치',
  baseRef: '기준',
  worktreeAt: '생성 위치',
  notARepo: 'git 저장소가 아님',
  noWorktrees: '워크트리 없음',
  openWorkspaceHere: '워크스페이스 열기',
  removeWorktree: '워크트리 제거',
  forceRemove: '강제 제거 (변경 사항 있음)',
  binaryFile: '바이너리 파일',
  fileChangedOnDisk: '디스크에서 변경됨',
  fileDeletedOnDisk: '디스크에서 삭제됨',
  fileChangedConfirm: '열린 뒤 디스크에서 변경됨 — 덮어쓸까요?',
  fileDeletedConfirm: '디스크에서 삭제됨 — 저장하면 다시 생성됩니다',
  keepMine: '내 버전 유지',
  overwrite: '덮어쓰기',
  saveAnyway: '그래도 저장',
  cancel: '취소',
  reloadedFromDisk: '디스크에서 다시 불러옴'
}

const dicts: Record<Lang, Record<TKey, string>> = { en, ko }

export function resolveLang(language: Language): Lang {
  if (language === 'ko' || language === 'en') return language
  return (navigator.language || 'en').toLowerCase().startsWith('ko') ? 'ko' : 'en'
}

export function translate(language: Language, key: TKey, vars?: Record<string, string>): string {
  let s = dicts[resolveLang(language)][key] ?? en[key]
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v)
  }
  return s
}

/** Hook: translate a UI string using the language from settings. */
export function useT(): (key: TKey, vars?: Record<string, string>) => string {
  const language = useStore((s) => s.settings.language)
  // stable across renders — components put `t` in effect deps (FileView's
  // file-read loop spun 12k× on a pane remount before this was memoized)
  return useCallback((key, vars) => translate(language, key, vars), [language])
}
