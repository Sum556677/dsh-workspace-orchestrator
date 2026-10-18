/**
 * `debug_single_mode` — inspect the live loader state behind the workspace blacklist.
 *
 * Registered so a user can simply say "调用 debug_single_mode" in the chat and get a
 * definitive answer instead of hunting through host logs: for every plugin row it
 * reports whether the row exists, whether it is disabled, and — crucially — whether its
 * fiber is actually ACTIVE or was torn down.
 *
 * Zero DSH imports: the loader is reached through `ctx.get('loader')`.
 */

import { readMapping, defaultMappingPath, pathKey, isProtectedId } from '../single-mode.mjs'

/** Cordis fiber lifecycle states (cordis/lib/types/fiber.js). */
const FIBER_STATE = {
  0: 'PENDING',
  1: 'LOADING',
  2: 'ACTIVE',
  3: 'FAILED',
  4: 'DISPOSED',
  5: 'UNLOADING',
}

/** Best-effort description of a fiber, tolerating either a state number or a string. */
function describeFiber(entry) {
  const fiber = entry?.fiber
  if (!fiber) return { present: false, state: 'NONE', uid: null, text: '已卸载 (fiber = null)' }
  const raw = fiber.state
  const label = typeof raw === 'number' ? (FIBER_STATE[raw] ?? `UNKNOWN(${raw})`) : String(raw ?? 'UNKNOWN')
  const uid = fiber.uid ?? null
  return {
    present: true,
    state: label,
    uid,
    text: `fiber.state=${label}${uid !== null ? ` uid=${uid}` : ''}`,
  }
}

/** Numeric state when available, for the ACTIVE check. */
function fiberIsActive(entry) {
  const fiber = entry?.fiber
  if (!fiber) return false
  return fiber.state === 2 || fiber.state === 'ACTIVE'
}

/**
 * @param {any} ctx Cordis context
 * @param {{mappingPath?: string}} [options] the file single mode actually reads
 * @returns {object} tool definition
 */
export function createDebugSingleModeTool(ctx, options = {}) {
  /** The host's own mapping file, so the tool inspects what the engine reads. */
  const hostMappingPath = typeof options.mappingPath === 'string' && options.mappingPath.trim()
    ? options.mappingPath.trim()
    : ''
  return {
    name: 'debug_single_mode',
    description:
      'Diagnose the workspace plugin blacklist. Reads the live loader tree and reports, per plugin row: '
      + 'whether the row exists, its id/name, whether it is disabled, and whether its fiber is ACTIVE or '
      + 'DISPOSED (i.e. whether the plugin actually stopped). Also shows the workspace→blacklist mapping and '
      + 'the workspace currently in effect. Use this when "disabled in this workspace" does not seem to work.',
    parameters: {
      type: 'object',
      properties: {
        pluginId: {
          type: 'string',
          description: 'Optional loader-entry id to inspect in detail (e.g. "dsh-webds-bridge"). Omit for all rows.',
        },
        workspacePath: {
          type: 'string',
          description: 'Optional workspace path; reports which blacklist entry it maps to (default: the active one).',
        },
        mappingPath: {
          type: 'string',
          description: 'Optional override for the mapping file to inspect (advanced/testing).',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          mappingPath: { type: 'string' },
          activeWorkspace: { type: 'string' },
          queriedWorkspace: { type: 'string' },
          matchedWorkspace: { type: 'string' },
          blacklist: { type: 'array', items: { type: 'string' } },
          loaderAvailable: { type: 'boolean' },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                blacklisted: { type: 'boolean' },
                disabled: { type: 'boolean' },
                fiberState: { type: 'string' },
                fiberActive: { type: 'boolean' },
                protected: { type: 'boolean' },
              },
            },
          },
          findings: { type: 'array', items: { type: 'string' } },
          logFile: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: render(value) }],
    },
    async execute(args = {}) {
      // Priority: explicit arg > the host's own mapping > the env-derived default.
      const mappingPath = typeof args.mappingPath === 'string' && args.mappingPath.trim()
        ? args.mappingPath.trim()
        : (hostMappingPath || defaultMappingPath())
      const mapping = readMapping(mappingPath)

      // Which blacklist does this session correspond to?
      let activeWorkspace = ''
      try {
        const sessions = ctx?.get?.('sessions')
        if (sessions && typeof sessions.list === 'function') {
          const keys = [...new Set(sessions.list().map((s) => pathKey(s?.header?.cwd)).filter(Boolean))]
          activeWorkspace = keys.length === 1 ? keys[0] : keys.join(', ')
        }
      } catch { /* best effort */ }

      const wanted = typeof args.workspacePath === 'string' && args.workspacePath.trim()
        ? pathKey(args.workspacePath)
        : activeWorkspace

      const workspaces = [...mapping.workspaces.entries()]
      const match = workspaces.find(([key]) => wanted && (key === wanted || key === activeWorkspace))
      const blacklist = (match?.[1] ?? []).filter((id) => !isProtectedId(id))

      let loaderAvailable = false
      const rows = []
      const findings = []

      try {
        const loader = ctx?.get?.('loader')
        if (loader && typeof loader.entries === 'function') {
          loaderAvailable = true
          const only = typeof args.pluginId === 'string' && args.pluginId.trim() ? args.pluginId.trim() : ''
          for (const entry of loader.entries()) {
            const id = entry?.options?.id
            if (!id) continue
            if (only && id !== only) continue
            const fiber = describeFiber(entry)
            rows.push({
              id,
              name: entry?.options?.name ?? '',
              blacklisted: blacklist.includes(id),
              disabled: entry?.disabled === true,
              fiberState: fiber.state,
              fiberActive: fiberIsActive(entry),
              protected: isProtectedId(id),
            })
          }
        } else {
          findings.push('loader 服务不可用（ctx.get("loader") 返回空），无法读取运行时状态。')
        }
      } catch (error) {
        findings.push(`读取 loader 失败：${String(error?.message ?? error)}`)
      }

      // Turn the raw data into the one conclusion the user actually cares about.
      if (!mapping.workspaces.size) {
        findings.push('映射文件里没有任何工作区黑名单。先在面板里取消勾选插件。')
      } else if (!match) {
        findings.push(
          `当前生效工作区是 "${activeWorkspace || '(未知)'}"，但映射里没有对应的条目。`
          + `映射里有：${workspaces.map(([k]) => k).join(' | ')}。`
          + '这通常意味着面板里选的工作区和会话的 cwd 不是同一个目录。',
        )
      } else if (blacklist.length === 0) {
        findings.push(`工作区 "${match[0]}" 的黑名单为空，所以不会禁用任何插件。`)
      }

      for (const row of rows) {
        if (!row.blacklisted) continue
        if (row.disabled && !row.fiberActive) {
          findings.push(`${row.id}：已禁用，fiber 已卸载 —— 单开模式工作正常。`)
        } else if (row.disabled && row.fiberActive) {
          findings.push(`${row.id}：options 标记为 disabled，但 fiber 仍在 ACTIVE —— 卸载未生效。`)
        } else {
          findings.push(`${row.id}：在黑名单里，但当前没有被禁用（黑名单尚未应用，新建会话后才会生效）。`)
        }
      }

      // A disabled row is only half the story for dual-end plugins: the browser keeps the
      // already-loaded client UI until the page is refreshed.
      const blacklistedLive = rows.filter((row) => row.blacklisted && row.fiberActive === false && row.disabled)
      if (blacklistedLive.length > 0) {
        findings.push(
          '提示：后端已卸载，但双端插件（带 dsh.client）的页面部分已经加载进浏览器，'
          + '刷新页面（Ctrl+Shift+R）后它的界面入口才会消失。',
        )
      }

      return {
        mappingPath,
        activeWorkspace,
        queriedWorkspace: wanted || '',
        matchedWorkspace: match?.[0] ?? '',
        blacklist,
        loaderAvailable,
        rows,
        findings,
        logFile: mappingPath.replace(/single-mode\.json$/, 'debug.log'),
      }
    },
  }
}

function render(value) {
  const lines = []
  lines.push('=== debug_single_mode ===')
  lines.push(`映射文件   : ${value?.mappingPath ?? '(unknown)'}`)
  lines.push(`当前工作区 : ${value?.activeWorkspace || '(无法判定)'}`)
  if (value?.queriedWorkspace) lines.push(`查询工作区 : ${value.queriedWorkspace}`)
  lines.push(`匹配到条目 : ${value?.matchedWorkspace || '(没有匹配)'}`)
  lines.push(`黑名单     : ${value?.blacklist?.length ? value.blacklist.join(', ') : '(空)'}`)
  lines.push(`loader     : ${value?.loaderAvailable ? '可用' : '不可用'}`)
  lines.push('')
  if (value?.rows?.length) {
    lines.push('id'.padEnd(30) + 'disabled'.padEnd(10) + '黑名单'.padEnd(8) + 'fiber')
    for (const row of value.rows) {
      lines.push(
        String(row.id).padEnd(30)
        + String(row.disabled).padEnd(10)
        + (row.blacklisted ? 'YES' : '-').padEnd(8)
        + `${row.fiberState}${row.protected ? '  (保护行)' : ''}`,
      )
    }
    lines.push('')
  }
  if (value?.findings?.length) {
    lines.push('结论：')
    for (const f of value.findings) lines.push(`  • ${f}`)
    lines.push('')
  }
  if (value?.logFile) lines.push(`详细日志：${value.logFile}`)
  return lines.join('\n')
}
