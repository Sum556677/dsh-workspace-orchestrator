// Multi-instance verification:
//   3 up -> limit guard -> stop one -> hard-kill one -> reap -> orphan sweep -> killAll.
// Usage: node verify-multi.mjs [--keep]
import { existsSync } from 'node:fs'

import { Orchestrator, isAlive } from './index.mjs'

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

const WORKSPACES = [
  { name: 'orch-multi-a', path: 'D:\\Agent_workspaces\\DSH_plugin' },
  { name: 'orch-multi-b', path: 'D:\\Agent_workspaces\\DSH_plugin\\_research' },
  { name: 'orch-multi-c', path: 'D:\\Agent_workspaces\\DSH_plugin\\dsh-orchestrator-core' },
  { name: 'orch-multi-d', path: 'D:\\Agent_workspaces\\DSH_plugin\\your-plugin-orchestrator' },
]

const orchestrator = new Orchestrator({ maxInstances: 3 })
const prepared = new Map()
const started = new Map()
const result = { ok: false }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  step('orchestrator', `home=${orchestrator.home} maxInstances=${orchestrator.maxInstances}`)

  // ---- phase 1: bring up three instances --------------------------------
  for (const ws of WORKSPACES.slice(0, 3)) {
    const p = await orchestrator.prepare(ws.path, { name: ws.name, force: true })
    prepared.set(ws.name, p)
    const instance = orchestrator.launch(p)
    const url = await orchestrator.awaitReady(instance, { timeoutMs: 90_000 })
    started.set(ws.name, instance)
    step('up', `${ws.name} pid=${instance.pid} ${url}`)
  }
  let listed = await orchestrator.list()
  check('list shows 3 live instances', listed.count === 3 && listed.live === 3, { count: listed.count, live: listed.live })
  check('all report a reachable port', listed.instances.every((r) => r.portReachable === true), listed.instances.map((r) => `${r.profileName}:${r.port}:${r.portReachable}`))

  // ---- phase 2: concurrency guard ---------------------------------------
  const fourth = await orchestrator.prepare(WORKSPACES[3].path, { name: WORKSPACES[3].name, force: true })
  prepared.set(WORKSPACES[3].name, fourth)
  let limitError
  try {
    const extra = orchestrator.launch(fourth)
    orchestrator.stop(extra)
  } catch (error) {
    limitError = error
  }
  check('4th launch rejected by limit', limitError?.code === 'EDSH_CONCURRENCY_LIMIT', limitError ? { code: limitError.code, running: limitError.running } : 'no error')
  step('limit', limitError ? `${limitError.code} (${limitError.running}/${limitError.limit})` : 'NOT ENFORCED')

  // ---- phase 3: stop one by workspace path ------------------------------
  const stopA = await orchestrator.stop(WORKSPACES[0].path)
  step('stop by workspace', JSON.stringify(stopA))
  started.delete(WORKSPACES[0].name)
  listed = await orchestrator.list()
  check('after stop -> 2 registered', listed.count === 2, { count: listed.count, live: listed.live })
  check('stopped pid is gone', !isAlive(stopA.pid), stopA.pid)

  // ---- phase 4: hard-kill (simulated crash) -> reap ---------------------
  const crashPid = started.get(WORKSPACES[1].name).pid
  process.kill(crashPid)
  await sleep(600)
  step('hard-killed', `${WORKSPACES[1].name} pid=${crashPid} alive=${isAlive(crashPid)}`)
  const reap1 = await orchestrator.reap()
  step('reap #1', JSON.stringify(reap1))
  check('reap removed the dead record', reap1.staleRemoved.some((r) => r.pid === crashPid), reap1.staleRemoved)
  listed = await orchestrator.list()
  check('after reap -> 1 registered', listed.count === 1, { count: listed.count })
  started.delete(WORKSPACES[1].name)

  // ---- phase 5: orphan sweep (record lost, process alive) ---------------
  const orphanInstance = orchestrator.launch(fourth)
  await orchestrator.awaitReady(orphanInstance, { timeoutMs: 90_000 })
  started.set(WORKSPACES[3].name, orphanInstance)
  step('orphan candidate up', `pid=${orphanInstance.pid}`)
  orchestrator.registry.reload().removeInstance(WORKSPACES[3].name).save()
  const reap2 = await orchestrator.reap()
  step('reap #2', JSON.stringify(reap2))
  check('orphan process killed by reap', reap2.orphansKilled.some((r) => r.pid === orphanInstance.pid), reap2.orphansKilled)
  check('orphan pid is dead', !isAlive(orphanInstance.pid), orphanInstance.pid)
  started.delete(WORKSPACES[3].name)

  // ---- phase 6: killAll --------------------------------------------------
  const all = await orchestrator.killAll({ purge: true })
  step('killAll', JSON.stringify(all))
  listed = await orchestrator.list()
  check('registry empty after killAll', listed.count === 0, { count: listed.count })
  check('registry file purged', all.purged === true, all.purged)
  check('no instance process alive', [...started.values()].every((i) => !isAlive(i.pid)), [...started.values()].map((i) => i.pid))
} catch (error) {
  result.error = { message: error.message, code: error.code }
  console.error('FAILED:', error.message)
  try {
    const swept = await orchestrator.killAll({ purge: true })
    console.error('cleanup killAll:', JSON.stringify(swept))
  } catch (cleanupError) {
    console.error('cleanup killAll failed:', cleanupError.message)
  }
} finally {
  for (const instance of started.values()) {
    if (!isAlive(instance.pid)) continue
    try { await orchestrator.stop(instance) } catch {}
  }
  for (const [name, p] of prepared) {
    if (keep) {
      console.log(`keep: ${name} -> ${p.profileDir}`)
      continue
    }
    orchestrator.dispose(p)
  }
  result.checks = checks
  result.ok = !result.error && checks.every((c) => c.ok)
  result.elapsedMs = Date.now() - t0
  result.residue = {
    registryFile: existsSync(`${orchestrator.home}\\orchestrator\\registry.json`),
    profiles: ['orch-multi-a', 'orch-multi-b', 'orch-multi-c', 'orch-multi-d']
      .filter((n) => existsSync(`${orchestrator.home}\\profiles\\${n}`)),
  }
  console.log('---RESULT---')
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}
