// VER-02 s1 crash child — openControlDb, commit a baseline row, begin a write
// tx, insert uncommitted rows, then signal READY and sleep; parent kills -9.
import { DatabaseSync } from 'node:sqlite'
import { storage } from './common.ts'

const dbPath = process.argv[2]!
const db = storage.openControlDb(dbPath)
db.prepare(
  "INSERT INTO projects(id,name,goal,repository_root,active_model_version,revision) VALUES('pbase','baseline','g','/tmp/x',NULL,1)"
).run()
console.log('BASELINE-COMMITTED')
db.exec('BEGIN IMMEDIATE')
db.prepare(
  "INSERT INTO principals(id,kind,status) VALUES('pr_unc','member','active')"
).run()
db.prepare(
  "INSERT INTO principals(id,kind,status) VALUES('pr_unc2','member','active')"
).run()
console.log('UNCOMMITTED-READY')
// never commit; parent will SIGKILL
setTimeout(() => {}, 60000)
