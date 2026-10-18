// Child-process lifecycle for one DSH instance. Pure Node; no DSH package imports.
import { spawn, execFile } from 'node:child_process'

const ANSI = /\u001b\[[0-9;]*m/g
const READY_LINE = /dsh web:\s*(https?:\/\/\S+)/
const MAX_BUFFER = 256 * 1024

function append(buffer, chunk) {
  const next = buffer + chunk
  return next.length > MAX_BUFFER ? next.slice(next.length - MAX_BUFFER) : next
}

/**
 * Spawn a DSH profile instance.
 * Always forces `--port 0 --no-open` so the caller never collides with a running GUI.
 *
 * @param {object} options
 * @param {string} options.exe        desktop executable
 * @param {string} options.cliJs      CLI entry inside the asar
 * @param {string} options.profileName
 * @param {string[]} [options.patchFiles]
 * @param {string} options.cwd        child working directory (becomes process.cwd())
 * @param {Record<string,string>} [options.env]
 * @param {string[]} [options.extraArgs]  app args appended after `--port 0`
 * @param {boolean} [options.manageReady] internal: attach readiness tracking
 * @returns {object} instance handle
 */
export function spawnInstance({
  exe, cliJs, profileName, patchFiles = [], cwd, env = {}, extraArgs = [], manageReady = true,
}) {
  const args = ['--expose-internals', cliJs, profileName]
  for (const file of patchFiles) args.push('--patch', file)
  args.push('--no-open', '--port', '0', ...extraArgs)

  const child = spawn(exe, args, {
    cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const instance = {
    id: `${profileName}:${child.pid ?? 'pending'}`,
    profileName,
    exe,
    args,
    cwd,
    child,
    pid: child.pid,
    stdout: '',
    stderr: '',
    url: undefined,
    exit: undefined,
    startedAt: Date.now(),
    ready: undefined,
  }

  let settleReady
  let rejectReady
  instance.ready = new Promise((resolve, reject) => {
    settleReady = resolve
    rejectReady = reject
  })
  // Avoid unhandled rejection when callers only use awaitReady().
  instance.ready.catch(() => {})

  const scan = (chunk) => {
    if (instance.url) return
    const text = chunk.replace(ANSI, '')
    const match = READY_LINE.exec(text)
    if (match) {
      instance.url = match[1]
      settleReady(instance.url)
    }
  }

  child.stdout?.on('data', (buf) => {
    const chunk = buf.toString('utf8')
    instance.stdout = append(instance.stdout, chunk)
    scan(chunk)
  })
  child.stderr?.on('data', (buf) => {
    instance.stderr = append(instance.stderr, buf.toString('utf8'))
  })
  child.on('error', (error) => {
    instance.exit = { code: null, signal: null, error }
    rejectReady(error)
  })
  child.on('exit', (code, signal) => {
    instance.exit = { code, signal }
    instance.exitedAt = Date.now()
    if (!instance.url) {
      const error = new Error(
        `DSH instance ${profileName} exited before reporting a URL (code=${code}).\n`
        + `stderr tail:\n${tail(instance.stderr)}`,
      )
      error.code = 'EDSH_EXITED_EARLY'
      rejectReady(error)
    }
  })

  if (!manageReady) instance.ready.catch(() => {})
  return instance
}

/**
 * Run a short-lived CLI command to completion and collect its output.
 * Used for profile initialization and `--dump-config` preflight.
 */
export function runCli({ exe, cliJs, args, cwd, env, timeoutMs = 120_000 }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(exe, ['--expose-internals', cliJs, ...args], {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const cap = (prev, buf) => append(prev, buf.toString('utf8'))
    child.stdout?.on('data', (b) => { stdout = cap(stdout, b) })
    child.stderr?.on('data', (b) => { stderr = cap(stderr, b) })
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      reject(Object.assign(
        new Error(`CLI command timed out after ${timeoutMs}ms: ${args.join(' ')}`),
        { code: 'ETIMEDOUT' },
      ))
    }, timeoutMs)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolvePromise({ code, signal, stdout, stderr })
    })
  })
}

function tail(text, lines = 20) {
  return text.trimEnd().split('\n').slice(-lines).join('\n')
}

/** Wait for the instance to print its URL. */
export async function awaitReady(instance, { timeoutMs = 60_000 } = {}) {
  if (instance.url) return instance.url
  if (instance.exit) {
    const error = new Error(
      `DSH instance ${instance.profileName} already exited (code=${instance.exit.code}).\n`
      + `stderr tail:\n${tail(instance.stderr)}`,
    )
    error.code = 'EDSH_EXITED_EARLY'
    throw error
  }
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        `Timed out after ${timeoutMs}ms waiting for "dsh web: <url>" from ${instance.profileName}.\n`
        + `stdout tail:\n${tail(instance.stdout)}\nstderr tail:\n${tail(instance.stderr)}`,
      )
      error.code = 'EDSH_READY_TIMEOUT'
      reject(error)
    }, timeoutMs)
  })
  try {
    return await Promise.race([instance.ready, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Resolve once the child exits, or null on timeout. */
/**
 * Let the host process exit while the instance keeps running.
 *
 * The instance is spawned with piped stdio so `awaitReady` can read its URL. Those
 * pipes (and the child handle) keep the *parent's* event loop alive, which is fatal
 * for a tool that launches an instance and returns: the host would never exit.
 * Call this once readiness is settled.
 */
export function detachInstance(instance) {
  const child = instance?.child
  if (!child) return instance
  try { child.stdout?.removeAllListeners('data'); child.stdout?.destroy() } catch {}
  try { child.stderr?.removeAllListeners('data'); child.stderr?.destroy() } catch {}
  try { child.removeAllListeners('exit'); child.removeAllListeners('error') } catch {}
  try { child.unref() } catch {}
  instance.detached = true
  return instance
}

export function waitExit(instance, timeoutMs) {
  if (instance.exit) return Promise.resolve(instance.exit)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    instance.child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

function taskkillTree(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
  })
}

/**
 * Stop the instance: terminate, then force-kill the whole tree if it lingers.
 * @returns {Promise<{code: number|null, signal: string|null, forced: boolean}>}
 */
export async function stop(instance, { timeoutMs = 8_000 } = {}) {
  if (!instance?.child) return { code: null, signal: null, forced: false }
  if (instance.exit) return { ...instance.exit, forced: false }

  try {
    instance.child.kill()
  } catch {
    // Already gone; fall through to the exit wait.
  }

  let exit = await waitExit(instance, timeoutMs)
  let forced = false
  if (!exit && instance.pid) {
    forced = true
    await taskkillTree(instance.pid)
    exit = await waitExit(instance, 5_000)
  }
  return { code: exit?.code ?? null, signal: exit?.signal ?? null, forced }
}
