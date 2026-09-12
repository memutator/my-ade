import { useStore } from './store'
import type { Language } from './types'

export type Lang = 'en' | 'ko'

const en = {
  // pane types
  terminal: 'terminal',
  browser: 'browser',
  editor: 'editor',

  // top bar
  filesPeek: 'Files — hover to peek, click to pin',
  newTerminal: 'New terminal (Alt+T)',
  newBrowser: 'New browser (Alt+B)',
  newEditor: 'New editor (Alt+E)',
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
  closePane: 'Close (Alt+W)',

  // terminal pane
  restartShell: 'Restart shell',
  processExited: 'process exited — click to restart',
  agentFinished: '{agent} finished',
  ptyError: 'pty error',

  // editor pane
  openFileTooltip: 'Open file…',
  noFileOpen: 'no file open',
  openFile: 'open file…',

  // browser pane
  back: 'Back',
  forward: 'Forward',
  reload: 'Reload',
  urlOrSearch: 'url or search…',

  // notification center
  notificationsTooltip: 'Notifications',
  notifications: 'notifications',
  markAllRead: 'Mark all read',
  clearAll: 'Clear all',
  noNotifications: 'no notifications',

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

  // file tree / file view
  loading: 'loading…',
  empty: 'empty',
  binaryFile: 'binary file'
} as const

export type TKey = keyof typeof en

const ko: Record<TKey, string> = {
  terminal: '터미널',
  browser: '브라우저',
  editor: '에디터',

  filesPeek: '파일 — 호버로 미리보기, 클릭으로 고정',
  newTerminal: '새 터미널 (Alt+T)',
  newBrowser: '새 브라우저 (Alt+B)',
  newEditor: '새 에디터 (Alt+E)',
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
  closePane: '닫기 (Alt+W)',

  restartShell: '셸 다시 시작',
  processExited: '프로세스가 종료됨 — 클릭하여 다시 시작',
  agentFinished: '{agent} 완료',
  ptyError: 'pty 오류',

  openFileTooltip: '파일 열기…',
  noFileOpen: '열린 파일 없음',
  openFile: '파일 열기…',

  back: '뒤로',
  forward: '앞으로',
  reload: '새로고침',
  urlOrSearch: 'URL 또는 검색어…',

  notificationsTooltip: '알림',
  notifications: '알림',
  markAllRead: '모두 읽음 표시',
  clearAll: '모두 지우기',
  noNotifications: '알림 없음',

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

  loading: '로딩…',
  empty: '비어 있음',
  binaryFile: '바이너리 파일'
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
  return (key, vars) => translate(language, key, vars)
}
