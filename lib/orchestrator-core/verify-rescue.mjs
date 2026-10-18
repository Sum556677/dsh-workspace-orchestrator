// Rescue-mode verification:
//   1. plant a third-party plugin that takes the host down when loaded
//   2. prove the normal launch really loads it (marker file + process death)
//   3. prove rescue() never loads it, and still serves a URL
//   4. prove a forced process-tree kill cleans up (taskkill fallback path)
// Usage: node verify-rescue.mjs [--keep]
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { Orchestrator, isAlive, killTree, parsePatchRows, waitUntilDead } from './index.mjs'

const keep = process.argv.includes('--keep')
const t0 = Date.now()
const step = (name, extra = '') => {
  console.log(`[${String(Date.now() - t0).padStart(5)}ms] ${name}${extra ? ' — ' + extra : ''}`)
}
const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' — ' + JSON.stringify(detail)}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const WORKSPACE = 'D:\\Agent_workspaces\\DSH_plugin'
const PROFILE = 'orch-rescue-bad'
const MARKER = join('C:\\Users\\MYJ\\AppData\\Local\\Temp', 'dsh-rescue-marker.txt')

const orchestrator = new Orchestrator({ maxInstances: 3 })
const result = { ok: false }
let badPrepared
let rescuePrepared
let baseline
let instance

try {
  step('orchestrator', `home=${orchestrator.home}`)

  // ---- plant the bad plugin --------------------------------------------
  badPrepared = await orchestrator.prepare(WORKSPACE, { name: PROFILE, force: true })
  const profileDir = badPrepared.profileDir
  const badModule = join(profileDir, 'bad-plugin.mjs')
  writeFileSync(badModule, [
    '// Simulates a third-party plugin that crashes the host at load time',
    '// (native addon abort, OOM, uncaught throw during init).',
    "import { appendFileSync } from 'node:fs'",
    `appendFileSync(${JSON.stringify(MARKER)}, 'loaded\\n')`,
    `process.stderr.write('bad-plugin: taking the host down\\n')`,
    'process.exit(1)',
    '',
  ].join('\n'), 'utf8')

  const profilePatch = join(profileDir, 'cordis.patch.yml')
  // A fresh profile's patch file is a single flow array `[]` with comments;
  // appending a block sequence after it is invalid YAML. Replace it instead.
  const before = existsSync(profilePatch) ? readFileSync(profilePatch, 'utf8') : ''
  const stripped = before.split(/\r?\n/).filter((line) => line.trim() !== '[]').join('\n').trimEnd()
  const next = [
    stripped,
    stripped ? '' : '',
    '- insert:',
    '    - id: bad-third-party',
    '      name: ./bad-plugin.mjs',
    '',
  ].join('\n')
  writeFileSync(profilePatch, next, 'utf8')
  step('planted', `bad-plugin.mjs + row bad-third-party in ${profilePatch}`)

  // ---- baseline: the normal launch must really load it ------------------
  rmSync(MARKER, { force: true })
  baseline = orchestrator.launch(badPrepared)
  let baselineError
  try {
    await orchestrator.awaitReady(baseline, { timeoutMs: 20_000 })
  } catch (error) {
    baselineError = error
  }
  await sleep(1_200)
  const markerAfterBaseline = existsSync(MARKER)
  const baselineDead = !isAlive(baseline.pid)
  result.baseline = {
    errorCode: baselineError?.code ?? null,
    markerWritten: markerAfterBaseline,
    processDead: baselineDead,
  }
  step('baseline', `marker=${markerAfterBaseline} dead=${baselineDead} err=${baselineError?.code ?? 'none'}`)
  check('baseline really loaded the bad plugin', markerAfterBaseline, markerAfterBaseline)
  check('baseline host process died', baselineDead, baseline.pid)
  await orchestrator.stop(baseline)
  baseline = undefined

  // ---- rescue: never loads it, still serves ----------------------------
  rmSync(MARKER, { force: true })
  const rescued = await orchestrator.rescue(PROFILE, { workspacePath: WORKSPACE, timeoutMs: 90_000 })
  rescuePrepared = rescued.prepared
  instance = rescued.instance
  result.rescue = {
    url: rescued.url,
    thirdParty: rescuePrepared.rescue.thirdParty,
    disabledIds: rescuePrepared.rescue.disabledIds,
    verified: rescuePrepared.rescue.verified,
    totalRows: rescuePrepared.rescue.totalRows,
  }
  step('rescue', `url=${rescued.url}`)
  step('rescue rows', `third-party=${JSON.stringify(rescuePrepared.rescue.thirdParty)} verified=${rescuePrepared.rescue.verified}`)

  check('rescue reports the third-party row', rescuePrepared.rescue.thirdParty.some((r) => r.id === 'bad-third-party'), rescuePrepared.rescue.thirdParty)
  check('rescue disabled it in the composed config', rescuePrepared.rescue.disabledIds.includes('bad-third-party'), rescuePrepared.rescue.disabledIds)
  check('rescue composition verified', rescuePrepared.rescue.verified === true)
  check('rescue produced a URL', Boolean(rescued.url), rescued.url)

  await sleep(1_500)
  const markerAfterRescue = existsSync(MARKER)
  check('bad plugin never loaded under rescue', markerAfterRescue === false, markerAfterRescue)
  check('rescue process still alive', isAlive(instance.pid), instance.pid)
  check('exactly one instance registered', (await orchestrator.list()).count === 1)

  // ---- forced tree kill covers the taskkill fallback --------------------
  const tree = spawn(process.execPath, ['-e', [
    "const { spawn } = require('node:child_process')",
    "const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })",
    "process.stdout.write(String(c.pid) + '\\n')",
    'setInterval(()=>{},1000)',
  ].join('\n')], { stdio: ['ignore', 'pipe', 'ignore'] })
  const grandchildPid = await new Promise((resolve) => {
    tree.stdout.once('data', (buf) => resolve(Number(String(buf).trim())))
  })
  await sleep(300)
  check('tree fixture up', isAlive(tree.pid) && isAlive(grandchildPid), { parent: tree.pid, child: grandchildPid })
  await killTree(tree.pid)
  const parentDead = await waitUntilDead(tree.pid, 5_000)
  const childDead = await waitUntilDead(grandchildPid, 5_000)
  check('killTree reaped parent and child', parentDead && childDead, { parentDead, childDead })
  result.forcedTreeKill = { parentDead, childDead }

  // ---- shutdown ---------------------------------------------------------
  const stopped = await orchestrator.stop(instance)
  instance = undefined
  step('stop rescue', JSON.stringify(stopped))
  check('rescue stopped cleanly', stopped.dead === true, stopped)

  // ---- CLI --disable: actually fix the broken profile --------------------
  const patchFile = join(badPrepared.profileDir, 'cordis.patch.yml')
  const cliArgs = (extra) => ['bin/rescue.mjs', PROFILE, '--disable', 'bad-third-party', '--no-launch', ...extra]
  const cwd = join(import.meta.dirname, '..', '..')

  const guarded = spawnSync(process.execPath, cliArgs([]), { cwd, encoding: 'utf8' })
  check('host-running guard refuses without --force', guarded.status === 2, guarded.status)
  step('guard', (guarded.stderr || '').trim().split('\n')[0] ?? '')

  const applied = spawnSync(process.execPath, cliArgs(['--force']), { cwd, encoding: 'utf8' })
  check('CLI --disable exits 0 with --force', applied.status === 0, applied.status)
  step('disable out', (applied.stdout || '').trim().split('\n').filter((l) => l.includes('[rescue]')).slice(-3).join(' | '))

  const backups = readdirSync(badPrepared.profileDir).filter((name) => name.startsWith('cordis.patch.yml.bak-'))
  check('backup file created', backups.length > 0, backups)
  const afterPatch = readFileSync(patchFile, 'utf8')
  const disabledRow = parsePatchRows(afterPatch).filter((row) => row.id === 'bad-third-party').pop()
  check('patch now carries disabled: true', disabledRow?.disabled === 'true', disabledRow)
  check('original row preserved', afterPatch.includes('name: ./bad-plugin.mjs'), true)
  result.disable = { status: applied.status, backups, disabled: disabledRow?.disabled }

  // The original profile must now boot on its own, without loading the plugin.
  // Launch with NO overlays at all: this proves the profile itself is fixed.
  rmSync(MARKER, { force: true })
  const fixed = orchestrator.launch({
    profileName: PROFILE,
    workspacePath: WORKSPACE,
    home: orchestrator.home,
    patchFiles: [],
  })
  const fixedUrl = await orchestrator.awaitReady(fixed, { timeoutMs: 90_000 })
  await sleep(1_200)
  const markerAfterFix = existsSync(MARKER)
  check('profile boots after disabling the bad plugin', Boolean(fixedUrl), fixedUrl)
  check('bad plugin still not loaded', markerAfterFix === false, markerAfterFix)
  const fixedStop = await orchestrator.stop(fixed)
  check('fixed instance stopped', fixedStop.dead === true, fixedStop)
  result.afterFix = { url: fixedUrl, marker: markerAfterFix }

  const all = await orchestrator.killAll({ purge: true })
  check('registry empty', (await orchestrator.list()).count === 0 && all.remaining === 0, all)
} catch (error) {
  result.error = { message: error.message, code: error.code }
  console.error('FAILED:', error.message)
  try { await orchestrator.killAll({ purge: true }) } catch {}
} finally {
  if (instance) { try { await orchestrator.stop(instance) } catch {} }
  if (baseline) { try { await orchestrator.stop(baseline) } catch {} }
  rmSync(MARKER, { force: true })
  for (const p of [badPrepared, rescuePrepared]) {
    if (!p) continue
    if (keep) { console.log(`keep: ${p.profileDir}`); continue }
    try { orchestrator.dispose(p) } catch {}
  }
  result.checks = checks
  result.ok = !result.error && checks.every((c) => c.ok)
  result.elapsedMs = Date.now() - t0
  result.residue = {
    orchestratorDir: existsSync('C:\\Users\\MYJ\\.dsh\\orchestrator'),
    profile: existsSync(`C:\\Users\\MYJ\\.dsh\\profiles\\${PROFILE}`),
    marker: existsSync(MARKER),
  }
  console.log('---RESULT---')
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}
