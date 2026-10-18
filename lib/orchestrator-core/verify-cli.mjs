// CLI verification for the rescue entry point.
//  1. --list works
//  2. `bin/rescue.mjs desktop` boots a desktop-rescue instance sharing $DSH_HOME data
//  3. Ctrl+C equivalent (--exit-after) shuts it down with zero residue
// Usage: node verify-cli.mjs
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveDshHome, exeFromWindowsRegistry } from './index.mjs'

const t0 = Date.now()
const step = (name, extra = '') => {
  console.log(`[${String(Date.now() - t0).padStart(5)}ms] ${name}${extra ? ' — ' + extra : ''}`)
}
const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' — ' + JSON.stringify(detail)}`)
}

const home = resolveDshHome()
const result = { ok: false }

function run(args, { onData, timeoutMs = 30_000 } = {}) {
  const root = join(import.meta.dirname, '..', '..')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'bin', 'rescue.mjs'), ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      reject(new Error(`timeout after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, timeoutMs)
    child.stdout.on('data', (buf) => {
      const chunk = buf.toString('utf8')
      stdout += chunk
      onData?.(stdout, chunk)
    })
    child.stderr.on('data', (buf) => { stderr += buf.toString('utf8') })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

async function httpProbe(url, timeoutMs = 10_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' })
    return res.status
  } finally {
    clearTimeout(timer)
  }
}

try {
  // ---- 0. install discovery (no hard-coded install path) ----------------
  const fromRegistry = exeFromWindowsRegistry()
  check('install discoverable without hard-coded path', Boolean(fromRegistry) && existsSync(fromRegistry), fromRegistry ?? null)
  step('registry', fromRegistry ?? '(none)')

  // ---- 1. list mode ----------------------------------------------------
  const listed = await run(['--list'], { timeoutMs: 20_000 })
  const hasDesktop = /\bdesktop\b/.test(listed.stdout)
  check('--list exits 0', listed.code === 0, listed.code)
  check('--list shows the desktop profile', hasDesktop, hasDesktop)
  step('list', listed.stdout.split('\n').filter((l) => l.trim()).slice(0, 3).join(' | '))

  // ---- 2. desktop rescue ----------------------------------------------
  const profileDir = join(home, 'profiles', 'desktop-rescue')
  const manifestPath = join(profileDir, 'orchestrator.json')
  let url
  let manifest
  let onUrl
  const urlReady = new Promise((resolve) => { onUrl = resolve })
  const runPromise = run(['desktop', '--exit-after', '8'], {
    timeoutMs: 180_000,
    onData: (all) => {
      if (url) return
      const match = /^URL: (\S+)$/m.exec(all)
      if (match) {
        url = match[1]
        try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch {}
        onUrl(url)
      }
    },
  })

  // Probe while the instance is still serving, not after --exit-after tears it down.
  const detected = await Promise.race([urlReady, new Promise((r) => setTimeout(() => r(null), 120_000))])
  if (detected) {
    try {
      const status = await httpProbe(detected)
      check('served URL answers HTTP', status >= 200 && status < 500, status)
      step('http', String(status))
    } catch (error) {
      check('served URL answers HTTP', false, error.message)
    }
  }

  const outcome = await runPromise

  check('rescue produced a URL', Boolean(url), url)
  step('url', url ?? '(none)')

  if (manifest) {
    check('shareData is enabled (host sessions/storages reused)', manifest.shareData === true, manifest.shareData)
    check('no isolated data root', manifest.dataRoot === null, manifest.dataRoot)
    check('only the rescue overlay is passed', Array.isArray(manifest.patchFiles) && manifest.patchFiles.length === 1, manifest.patchFiles)
    check('rescue composition verified', manifest.rescue?.verified === true, manifest.rescue?.verified)
    step('manifest', `shareData=${manifest.shareData} patchFiles=${manifest.patchFiles?.length} thirdParty=${manifest.rescue?.thirdParty?.length}`)
  } else {
    check('manifest readable while running', false, 'not found')
  }

  check('CLI exited 0 after --exit-after', outcome.code === 0, outcome.code)
  check('CLI printed a clean shutdown line', /实例已停止/.test(outcome.stdout), /实例已停止/.test(outcome.stdout))

  // ---- 3. residue ------------------------------------------------------
  check('proxy profile removed', !existsSync(profileDir), existsSync(profileDir))
  check('registry purged', !existsSync(join(home, 'workspace-orchestrator', 'registry.json')), existsSync(join(home, 'workspace-orchestrator', 'registry.json')))
  const sessionsDir = join(home, 'sessions')
  check('shared sessions dir still present (host data untouched)', existsSync(sessionsDir), existsSync(sessionsDir))
  result.stdoutTail = outcome.stdout.split('\n').filter((l) => l.trim()).slice(-12)
} catch (error) {
  result.error = { message: error.message }
  console.error('FAILED:', error.message)
}

result.checks = checks
result.ok = !result.error && checks.every((c) => c.ok)
result.elapsedMs = Date.now() - t0
console.log('---RESULT---')
console.log(JSON.stringify({ ok: result.ok, elapsedMs: result.elapsedMs, checks, error: result.error, stdoutTail: result.stdoutTail }, null, 2))
process.exit(result.ok ? 0 : 1)

