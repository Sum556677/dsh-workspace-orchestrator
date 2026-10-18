#!/usr/bin/env node
// Guard against Cordis "cannot get property X without inject" crashes.
//
//   node lib/orchestrator-core/verify-context-access.mjs
//
// Cordis wraps every context in a Proxy whose `get` trap throws for any property that is
// neither a mixin nor a declared service. Reading `ctx.config` (or any undeclared name)
// therefore throws at runtime, and because our code catches such failures to keep the
// boot alive, it surfaces only as a silently dead engine.
//
// This test scans the shipped sources for direct context property access and asserts the
// allow-list is exactly what Cordis guarantees.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

/**
 * Properties Cordis exposes directly on the context (safe to read).
 * Source: cordis/lib/index.js — `this.mixin(...)` installs these on every context, and
 * `logger` is injected by the runtime. Everything else must go through `ctx.get(name)`.
 */
const SAFE = new Set([
  // mixin("reflect"): get, set, provide, accessor, mixin
  'get', 'set', 'provide', 'accessor', 'mixin',
  // mixin("fiber"): runtime, effect
  'runtime', 'effect',
  // mixin("registry"): inject, plugin
  'inject', 'plugin',
  // mixin("events"): on, once, parallel, emit, serial, bail, waterfall
  'on', 'once', 'parallel', 'emit', 'serial', 'bail', 'waterfall',
  // installed by the runtime on every context
  'logger', 'fiber', 'registry', 'reflect', 'events', 'scope',
  // our own plugin-declared service
  'tools',
  // cordis internals exposed for introspection
  'baseUrl', 'root', 'name',
])

/** Files that run against a Cordis context. */
const TARGETS = ['index.js', 'lib/single-mode.mjs', 'lib/rpc.js', 'lib/scan.js', 'lib/tools']

function walk(target) {
  const full = join(ROOT, target)
  try {
    if (!statSync(full).isDirectory()) return [full]
  } catch {
    return []
  }
  const out = []
  for (const entry of readdirSync(full)) {
    const child = join(full, entry)
    if (statSync(child).isDirectory()) out.push(...walk(relative(ROOT, child)))
    else if (/\.(js|mjs)$/.test(entry) && !/^verify/.test(entry)) out.push(child)
  }
  return out
}

const files = TARGETS.flatMap(walk)
check('found the sources to scan', files.length > 0, `${files.length} files`)

/** `ctx.foo` / `ctx?.foo` without a call — a property READ through the proxy. */
const READ = /ctx\s*\??\.\s*([A-Za-z_$][\w$]*)/g

const violations = []
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    // Ignore comments: a doc comment mentioning ctx.config is not a read.
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')
    if (/^\s*\*/.test(line)) return
    for (const match of code.matchAll(READ)) {
      const prop = match[1]
      // A method call (`ctx.inject(...)`, `ctx.off(...)`) is a mixin, not a gated read.
      const after = code.slice(match.index + match[0].length)
      if (/^\s*(\(|\?\.\s*\()/.test(after)) continue
      if (SAFE.has(prop)) continue
      violations.push(`${relative(ROOT, file)}:${index + 1}  ctx.${prop}`)
    }
  })
}

check('no undeclared context property is read directly', violations.length === 0,
  violations.length > 0 ? `\n      ${violations.join('\n      ')}` : '')

// The specific regression that took the engine down: ctx.config is NOT readable.
check('startSingleMode never reads ctx.config', (() => {
  const text = readFileSync(join(ROOT, 'index.js'), 'utf8')
  const fn = text.slice(text.indexOf('export function startSingleMode'))
  // Strip comments: the explanatory comment legitimately mentions ctx.config.
  const code = fn
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  return !/ctx\s*\??\.\s*config\b/.test(code)
})(), 'a comment mentioning it is fine; a real read is not')

check('single-mode gets services through ctx.get()', (() => {
  const text = readFileSync(join(ROOT, 'lib', 'single-mode.mjs'), 'utf8')
  const usesGet = /ctx\?\.\.get\?\.|ctx\.get\(|ctx\?\.get\?\./.test(text) || /ctx\.get\(/.test(text)
  const directLoader = /ctx\s*\??\.\s*loader\b(?!\s*\()/.test(text)
  const directSessions = /ctx\s*\??\.\s*sessions\b/.test(text)
  return usesGet && !directLoader && !directSessions
})())

// A guard against the inverse mistake: wrapping ctx access in a bare try/catch hides the
// throw but leaves a silently dead feature, which is how this bug survived a release.
check('startSingleMode is called where failures are surfaced, not swallowed', (() => {
  const text = readFileSync(join(ROOT, 'index.js'), 'utf8')
  return /singleModeState\.error\s*=/.test(text) && /logger\?\.error/.test(text)
})())

// startSingleMode unwraps `config.singleMode` itself; handing that already-unwrapped
// object to resolveMappingPath() would unwrap a second time and drop a user mappingPath.
check('startSingleMode reads mappingPath without double-unwrapping', (() => {
  const text = readFileSync(join(ROOT, 'index.js'), 'utf8')
  const start = text.indexOf('export function startSingleMode')
  const body = text.slice(start, text.indexOf('\n}', start))
  return !/resolveMappingPath\(\s*settings\s*\)/.test(body) && /settings\.mappingPath/.test(body)
})())

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`)
if (failed.length > 0) process.exitCode = 1
