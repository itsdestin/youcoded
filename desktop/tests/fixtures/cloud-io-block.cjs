// Private Node-only fixture; no project files or network. The parent owns stdin.
// WHY: a blocking pipe read lasts until the parent proves its heartbeat and other
// work ran, unlike a fixed Atomics.wait window that races scheduler load.
const fs = require('node:fs')
process.stdin._handle?.setBlocking(true)
process.once('message', () => {
  process.send('blocking', () => {
    const data = Buffer.alloc(16)
    const count = fs.readSync(0, data, 0, data.length, null)
    if (data.subarray(0, count).toString() !== 'release') process.exit(1)
    process.send('released', () => process.send('finished', () => process.disconnect()))
  })
})
// Parent test cleanup closes/kills this private child if its handshake fails.
setTimeout(() => process.exit(1), 5000).unref()
