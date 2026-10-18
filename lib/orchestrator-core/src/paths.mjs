// Installation / home path resolution. Pure Node; no DSH package imports.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Candidate desktop executable locations, most explicit first. */
const INSTALL_CANDIDATES = [
  process.env.DSH_DESKTOP_EXE,
  process.env.DSH_DESKTOP_NODE_EXECUTABLE,
  'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
  'D:\\Finish\\DeepSeek Harness\\DeepSeek Harness.exe',
]

/** Relative path from the desktop executable to the CLI entry inside the asar. */
const CLI_RELATIVE = join(
  'resources', 'app.asar', 'dsh', 'node_modules',
  '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js',
)

/**
 * Resolve the harness home directory.
 * Precedence mirrors DSH: explicit argument, then $DSH_HOME, then ~/.dsh.
 */
export function resolveDshHome(explicit) {
  if (explicit) return explicit
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/**
 * Best-effort discovery of the desktop executable from the Windows uninstall
 * registry, so the install may live anywhere without being hard-coded.
 * @returns {string|undefined}
 */
export function exeFromWindowsRegistry() {
  if (process.platform !== 'win32') return undefined
  const roots = [
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]
  for (const root of roots) {
    try {
      const out = execFileSync('reg', ['query', root, '/s', '/f', 'DeepSeek Harness'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      })
      for (const line of out.split(/\r?\n/)) {
        if (!/DisplayIcon/i.test(line) || !/REG_SZ/i.test(line)) continue
        const value = line.split(/REG_SZ/i)[1]?.trim().replace(/,\d+$/, '')
        if (value && existsSync(value)) return value
      }
    } catch {
      // Registry may be unavailable or the key missing; try the next root.
    }
  }
  return undefined
}

/**
 * Resolve the desktop executable and the CLI script it runs in Node mode.
 * Order: explicit arg → env → Windows registry → well-known locations.
 * @returns {{exe: string, cliJs: string}}
 */
export function resolveInstall({ dshExe } = {}) {
  const tried = []
  const fromRegistry = exeFromWindowsRegistry()
  if (fromRegistry) tried.push(`${fromRegistry}  (registry)`)
  const candidates = [dshExe, fromRegistry, ...INSTALL_CANDIDATES].filter(Boolean)
  for (const candidate of candidates) {
    if (!candidate || !candidate.trim()) continue
    tried.push(candidate)
    if (!existsSync(candidate)) continue
    const root = dirname(candidate)
    // Plain Node cannot stat inside app.asar, so validate the archive itself and
    // let Electron (the child process) resolve the CLI entry inside it.
    if (!existsSync(join(root, 'resources', 'app.asar'))) {
      tried.push(`${candidate}  (resources/app.asar missing beside it)`)
      continue
    }
    return { exe: candidate, cliJs: join(root, CLI_RELATIVE) }
  }
  const error = new Error(
    'Cannot locate the DSH desktop executable. Pass { dshExe } or set DSH_DESKTOP_EXE.\nTried:\n  '
    + tried.join('\n  '),
  )
  error.code = 'EDSH_INSTALL_NOT_FOUND'
  throw error
}

/**
 * Namespaced directory holding all orchestrator-owned data.
 *
 * Deliberately NOT `$DSH_HOME/orchestrator`: the published `dsh-orchestrator`
 * package uses exactly that path for its own harness state, so sharing it would
 * make two unrelated plugins write into one directory.
 */
export const DATA_DIR_NAME = 'workspace-orchestrator'

/** Root of orchestrator-owned data under the harness home. */
export function orchestratorRoot(home) {
  return join(home, DATA_DIR_NAME)
}

/** Per-instance data root (isolated sessions/storages for S2 isolation). */
export function instanceDataRoot(home, profileName) {
  return join(orchestratorRoot(home), profileName)
}

/** Profiles directory under the resolved home. */
export function profilesRoot(home) {
  return join(home, 'profiles')
}

/** Profile directory for a given profile name. */
export function profileDir(home, profileName) {
  return join(profilesRoot(home), profileName)
}
