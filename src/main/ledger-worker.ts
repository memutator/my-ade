import { parentPort } from 'node:worker_threads'
import { scanStores } from './ledger'

if (!parentPort) throw new Error('ledger-worker must run as a worker thread')

parentPort.on('message', () => {
  void scanStores()
    .then((stores) => parentPort!.postMessage({ ok: true, stores }))
    .catch((e) => parentPort!.postMessage({ ok: false, error: String(e) }))
})
