// VER-02 1i follow-up — precise behavior of openControlDb on an unwritable file.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, rmSync, chmodSync } from 'node:fs'
import { Recorder, storage } from './common.ts'

const DIR = '/tmp/mahas-ver-02/s1i'
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
const rec = new Recorder('s1i-readonly')

const roPath = `${DIR}/ro.sqlite`
{
  const db = storage.openControlDb(roPath)
  db.prepare("INSERT INTO principals(id,kind,status) VALUES('pr_ro','member','active')").run()
  db.close()
}
chmodSync(roPath, 0o444)
for (const suf of ['-wal', '-shm']) {
  try { chmodSync(`${roPath}${suf}`, 0o444) } catch { /* may not exist */ }
}
chmodSync(DIR, 0o555)

let openErr = ''
let db: DatabaseSync | null = null
try {
  db = storage.openControlDb(roPath)
} catch (e) {
  openErr = String(e)
}
if (db === null) {
  rec.check('1i openControlDb fails on unwritable db', true, 'open error', openErr.slice(0, 160))
} else {
  // open succeeded (SQLite fell back to read-only) — the write boundary must refuse
  let writeErr = ''
  try {
    storage.withTx(db, (tx) => {
      tx.prepare("INSERT INTO principals(id,kind,status) VALUES('pr_ro2','member','active')").run()
    })
  } catch (e) {
    writeErr = String(e)
  }
  const n = db.prepare('SELECT count(*) AS n FROM principals').get() as { n: number }
  rec.check(
    '1i open succeeds read-only but write tx refuses (no silent degrade)',
    writeErr.length > 0 && Number(n.n) === 1,
    'write error + 1 principal',
    `writeErr=${writeErr.slice(0, 120)} n=${n.n}`
  )
  try { db.close() } catch { /* ignore */ }
}
chmodSync(DIR, 0o755)
rec.flush()
