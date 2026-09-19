// mahas opencode plugin entry — opencode loads every file in its plugins dir,
// so this is the module it imports; the event bridge it re-exports lives in
// ./opencode-runtime.js. Both files are installed together by the opencode
// installer (installers.json → files[]) because a lone entry would fail to
// resolve its sibling at import time.
export { MahasEventsPlugin } from './opencode-runtime.js'

