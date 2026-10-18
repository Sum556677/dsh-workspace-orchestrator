// Process / port liveness helpers. Pure Node.
import { execFile } from 'node:child_process'
import { connect } from 'node:net'

/**
 * Whether a PID currently exists.
 * `EPERM` means the process exists but is not ours — still alive.
 */
export function isAlive(pid) {
  if (!pid || typeof pid !== 'number') return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** TCP-connect probe: is something listening on this port? */
export function probePort(port, { host = '127.0.0.1', timeoutMs = 1_500 } = {}) {
  if (!port) return Promise.resolve(false)
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** Force-kill a whole process tree (Windows uses taskkill /T /F). */
export function killTree(pid) {
  if (!pid) return Promise.resolve(false)
  if (process.platform !== 'win32') {
    try { process.kill(pid, 'SIGKILL') } catch {}
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve(true))
  })
}

/** Poll until the PID disappears or the timeout elapses. */
export async function waitUntilDead(pid, timeoutMs = 8_000, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return !isAlive(pid)
}
