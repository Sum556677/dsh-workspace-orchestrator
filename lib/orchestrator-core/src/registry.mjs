// Persistent instance registry (JSON, atomic replace).
// Two sections:
//   instances — declared live instances (removed on a confirmed stop)
//   ledger    — every PID this manager spawned and has not confirmed dead,
//               used to find orphans that lost their registry entry.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { orchestratorRoot } from './paths.mjs'

const VERSION = 1

function emptyState() {
  return { version: VERSION, instances: {}, ledger: {} }
}

export class Registry {
  constructor(home) {
    this.dir = orchestratorRoot(home)
    this.file = join(this.dir, 'registry.json')
    this.state = this.#read()
  }

  #read() {
    try {
      if (!existsSync(this.file)) return emptyState()
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!parsed || parsed.version !== VERSION) return emptyState()
      return {
        version: VERSION,
        instances: parsed.instances ?? {},
        ledger: parsed.ledger ?? {},
      }
    } catch {
      return emptyState()
    }
  }

  /** Re-read from disk (other processes or a crashed writer may have changed it). */
  reload() {
    this.state = this.#read()
    return this
  }

  save() {
    mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
    renameSync(tmp, this.file)
    return this
  }

  /**
   * Persist, or delete the file outright when nothing is registered.
   * Keeps "no active instances" from leaving an empty registry behind.
   */
  saveOrPurge() {
    return this.isEmpty ? this.purge() : this.save()
  }

  get instances() {
    return Object.values(this.state.instances)
  }

  get instanceIds() {
    return new Set(Object.keys(this.state.instances))
  }

  get(instanceId) {
    return this.state.instances[instanceId]
  }

  find(predicate) {
    return this.instances.find(predicate)
  }

  addInstance(record) {
    this.state.instances[record.id] = record
    return this
  }

  updateInstance(instanceId, patch) {
    const current = this.state.instances[instanceId]
    if (!current) return this
    this.state.instances[instanceId] = { ...current, ...patch, updatedAt: new Date().toISOString() }
    return this
  }

  removeInstance(instanceId) {
    delete this.state.instances[instanceId]
    return this
  }

  trackSpawn(pid, { id, profileName }) {
    if (!pid) return this
    this.state.ledger[String(pid)] = {
      id,
      profileName,
      pid,
      spawnedAt: new Date().toISOString(),
    }
    return this
  }

  untrackSpawn(pid) {
    delete this.state.ledger[String(pid)]
    return this
  }

  get ledger() {
    return Object.values(this.state.ledger)
  }

  /** Remove the registry file entirely and prune the directory when empty. */
  purge() {
    rmSync(this.file, { recursive: true, force: true })
    rmSync(`${this.file}.tmp`, { force: true })
    try { rmdirSync(this.dir) } catch {}
    this.state = emptyState()
    return this
  }

  get isEmpty() {
    return this.instances.length === 0 && this.ledger.length === 0
  }
}
