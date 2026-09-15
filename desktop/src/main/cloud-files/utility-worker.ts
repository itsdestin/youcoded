import { utilityProcess } from 'electron'
import * as path from 'node:path'
import type { CloudWorkerEvents, CloudWorkerHandle } from './supervisor'

/** Owned lifecycle follows voice-handlers' utilityProcess.fork pattern. Existing
 * tsc dist layout and dist/** packaging include this sibling worker unchanged.
 * No paths/owner tokens in argv; no shell, global process discovery or live attach.
 */
export function spawnCloudIoWorker(events: CloudWorkerEvents): CloudWorkerHandle {
  const child = utilityProcess.fork(path.join(__dirname, 'io-worker.js'), [], {
    serviceName: 'youcoded-cloud-io',
    // WHY: this worker has no useful textual diagnostics. Discarding at source
    // bounds stderr/stdout retention at zero and avoids exposing provider paths.
    stdio: 'ignore',
  })
  child.on('message', (wire: unknown) => events.message(wire))
  child.on('exit', () => events.exit())
  child.on('error', () => events.error())
  return { send: wire => child.postMessage(wire), kill: () => { child.kill() } }
}
