// Local verification: prepare -> patch preflight -> launch -> awaitReady -> HTTP probe
//                       -> stop -> dispose.
// Usage: node verify.mjs [--keep] [--workspace <path>]
import { existsSync } from 'node:fs'
import { Orchestrator, runCli } from './index.mjs'

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const wsIndex = argv.indexOf('--workspace')
const workspace = wsIndex >= 0 ? argv[wsIndex + 1] : process.cwd()
const PROFILE = 'orch-verify'

const t0 = Date.now()
const step = (name, extra = '') => {
  const ms = Date.now() - t0
  console.log(`[${String(ms).padStart(5)}ms] ${name}${extra ? ' — ' + extra : ''}`)
}
const result = { ok: false }

async function httpProbe(url, timeoutMs = 10_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' })
    return { status: res.status, contentType: res.headers.get('content-type') }
  } finally {
    clearTimeout(timer)
  }
}

let orchestrator
let prepared
let instance

try {
  orchestrator = new Orchestrator()
  step('orchestrator', `home=${orchestrator.home}`)
  step('install', `exe=${orchestrator.install.exe}`)

  prepared = await orchestrator.prepare(workspace, { name: PROFILE, force: true })
  step('prepare', `profile=${prepared.profileName} created=${prepared.created}`)
  step('overlay', prepared.overlayPath)
  step('dataRoot', prepared.dataRoot)

  // Preflight: proves the by-id config overrides actually matched something.
  // A missed patch id is only a warning at boot, so silence would hide a broken isolation.
  const dump = await runCli({
    exe: orchestrator.install.exe,
    cliJs: orchestrator.install.cliJs,
    args: [prepared.profileName, '--patch', prepared.overlayPath, '--dump-config'],
    cwd: prepared.workspacePath,
    env: { DSH_HOME: prepared.home },
    timeoutMs: 60_000,
  })
  const expectedRoots = [prepared.dataRoot.replace(/\\/g, '/') + '/sessions', prepared.dataRoot.replace(/\\/g, '/') + '/storages']
  const appliedRoots = expectedRoots.filter((root) => dump.stdout.includes(root))
  const patchWarnings = `${dump.stdout}\n${dump.stderr}`
    .split('\n')
    .filter((line) => /patch:.*(not found|required|is not a group)/.test(line))
  result.patchPreflight = {
    exitCode: dump.code,
    expected: expectedRoots.length,
    applied: appliedRoots.length,
    roots: appliedRoots,
    warnings: patchWarnings.slice(0, 5),
  }
  step('patchPreflight', `applied ${appliedRoots.length}/${expectedRoots.length} roots, warnings=${patchWarnings.length}`)
  if (appliedRoots.length !== expectedRoots.length) {
    throw Object.assign(new Error(`patch overlay did not apply cleanly: ${JSON.stringify(result.patchPreflight)}`), { code: 'EDSH_PATCH_MISS' })
  }

  instance = orchestrator.launch(prepared)
  result.pid = instance.pid
  step('launch', `pid=${instance.pid}`)
  step('args', instance.args.slice(2).join(' '))

  const url = await orchestrator.awaitReady(instance, { timeoutMs: 90_000 })
  result.url = url
  step('awaitReady', url)

  const stderrLines = instance.stderr.trimEnd().split('\n')
  result.bootWarnings = stderrLines.filter((line) => /warning|error/i.test(line)).slice(0, 8)
  if (result.bootWarnings.length) step('bootWarnings', String(result.bootWarnings.length))

  let probe
  try {
    probe = await httpProbe(url)
    result.http = probe
    step('httpProbe', `status=${probe.status} type=${probe.contentType}`)
  } catch (error) {
    result.http = { error: error.message }
    step('httpProbe FAILED', error.message)
  }

  const stopInfo = await orchestrator.stop(instance)
  result.stop = stopInfo
  step('stop', `code=${stopInfo.code} signal=${stopInfo.signal} forced=${stopInfo.forced}`)
  instance = undefined
} catch (error) {
  result.error = { message: error.message, code: error.code }
  console.error('FAILED:', error.message)
  if (instance) {
    try {
      const info = await orchestrator.stop(instance)
      console.error('cleanup stop:', JSON.stringify(info))
      instance = undefined
    } catch (cleanupError) {
      console.error('cleanup stop failed:', cleanupError.message)
    }
  }
} finally {
  if (prepared) {
    if (keep) {
      console.log(`keep: profile left at ${prepared.profileDir}`)
    } else {
      const removed = orchestrator.dispose(prepared)
      result.dispose = { ...removed, profileStillExists: existsSync(prepared.profileDir) }
      step('dispose', `profile=${removed.removedProfile} data=${removed.removedData} gone=${!existsSync(prepared.profileDir)}`)
    }
  }
  result.ok = !result.error
    && Boolean(result.url)
    && Boolean(result.stop)
    && result.patchPreflight?.applied === result.patchPreflight?.expected
  result.elapsedMs = Date.now() - t0
  console.log('---RESULT---')
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}
