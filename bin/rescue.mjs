#!/usr/bin/env node
// DSH 急救入口（独立工具，不依赖 DSH 进程）。
// 用法：node bin/rescue.mjs [profile] [--list] [--keep] [--exit-after N]
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import readline from 'node:readline'

import { Orchestrator, profilesRoot, resolveDshHome } from '../lib/orchestrator-core/index.mjs'

const argv = process.argv.slice(2)
const flags = {
  list: false, keep: false, exitAfter: 0, profile: '', help: false,
  disable: [], noLaunch: false, force: false, web: false, port: 0,
}

const pushDisable = (value) => {
  for (const id of String(value ?? '').split(',')) if (id.trim()) flags.disable.push(id.trim())
}

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--list' || arg === '-l') flags.list = true
  else if (arg === '--web' || arg === '-w') flags.web = true
  else if (arg === '--port') flags.port = Number(argv[++i]) || 0
  else if (arg.startsWith('--port=')) flags.port = Number(arg.split('=')[1]) || 0
  else if (arg === '--keep' || arg === '-k') flags.keep = true
  else if (arg === '--help' || arg === '-h') flags.help = true
  else if (arg === '--no-launch') flags.noLaunch = true
  else if (arg === '--force') flags.force = true
  else if (arg === '--disable' || arg === '-d') pushDisable(argv[++i])
  else if (arg.startsWith('--disable=')) pushDisable(arg.slice('--disable='.length))
  else if (arg === '--exit-after') flags.exitAfter = Number(argv[++i]) || 0
  else if (arg.startsWith('--exit-after=')) flags.exitAfter = Number(arg.split('=')[1]) || 0
  else if (!arg.startsWith('-') && !flags.profile) flags.profile = arg
  else console.warn(`[rescue] 忽略未知参数: ${arg}`)
}

const say = (msg = '') => console.log(msg)
const warn = (msg) => console.error(msg)

/** Is a DSH desktop app (other than us) running? Rescue assumes the host is down. */
function isHostRunning() {
  if (process.platform !== 'win32') return false
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
    })
    return [...out.matchAll(/"([^"]+)","(\d+)"/g)]
      .map((match) => Number(match[2]))
      .some((pid) => pid !== process.pid)
  } catch {
    return false
  }
}

/** Numbered menu over third-party plugins; empty answer skips disabling. */
async function choosePlugins(rows) {
  say('')
  say('检测到以下第三方插件（非 @deepseek-ai/*），禁用它们可以恢复启动：')
  rows.forEach((row, index) => {
    const state = row.disabled === 'true' ? '已禁用' : '启用中'
    say(`  [${index + 1}] ${row.id}  ${row.name}  (${state})`)
  })
  say('')
  const answer = await prompt('输入要禁用的编号（逗号分隔，直接回车跳过）: ')
  if (!answer) return []
  return answer
    .split(',')
    .map((part) => {
      const n = Number(part.trim())
      return Number.isInteger(n) && n >= 1 && n <= rows.length ? rows[n - 1].id : part.trim()
    })
    .filter(Boolean)
}

function usage() {
  say('DSH 急救工具')
  say('')
  say('  node bin/rescue.mjs <profile>      就地救援指定 profile（共享会话与存储）')
  say('  node bin/rescue.mjs desktop        救援 desktop（走 desktop-rescue 代理 profile）')
  say('  node bin/rescue.mjs --list         列出可用 profile')
  say('  node bin/rescue.mjs                交互式选择')
  say('  node bin/rescue.mjs --web [profile] 打开急救网页（127.0.0.1:8765，占用则随机端口）')
  say('')
  say('  --disable <id[,id]>  直接禁用目标 profile 里的第三方插件（自动备份）')
  say('  --no-launch          只改配置，不启动救援实例')
  say('  --force              宿主仍在运行时强制修改（默认拒绝）')
  say('  --keep               保留生成的 profile    --exit-after N  测试用')
  say('  --web                急救网页模式（与 DSH 进程完全解耦）')
  say('  --port <n>           急救网页端口（默认 8765，被占用则随机）')
}

function listProfiles(home) {
  const root = profilesRoot(home)
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((name) => {
      try { return statSync(join(root, name)).isDirectory() } catch { return false }
    })
    .map((name) => {
      const dir = join(root, name)
      let mtime = null
      try { mtime = statSync(join(dir, 'cordis.patch.yml')).mtime } catch {}
      return { name, dir, mtime }
    })
    .sort((a, b) => (b.mtime?.getTime() ?? 0) - (a.mtime?.getTime() ?? 0))
}

function printProfiles(profiles) {
  if (profiles.length === 0) {
    say('（没有找到任何 profile）')
    return
  }
  say('可用 profile：')
  profiles.forEach((p, index) => {
    const mark = p.name.toLowerCase() === 'desktop' ? '  ← 当前桌面应用使用' : ''
    const when = p.mtime ? p.mtime.toLocaleString('zh-CN') : '未知时间'
    say(`  [${index + 1}] ${p.name}  (最后修改 ${when})${mark}`)
  })
  say('')
  say('提示：desktop 由 Electron 独占，CLI 不能用它直接启动；选择它时会自动使用 desktop-rescue。')
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

function resolveChoice(input, profiles) {
  if (!input) return ''
  const byIndex = Number(input)
  if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= profiles.length) {
    return profiles[byIndex - 1].name
  }
  return input
}

/** --web：启动独立的急救面板（不依赖 DSH 进程、不依赖任何前端资源）。 */
async function runWeb(home, profiles) {
  const target = flags.profile || (profiles.includes('desktop') ? 'desktop' : profiles[0])
  if (!target) {
    warn('[rescue] 没有可用的 profile，无法启动急救面板。')
    return 2
  }
  const { startRescueWeb, openBrowser } = await import('../lib/rescue-web.js')
  const panel = await startRescueWeb({ home, profileName: target, port: flags.port })

  say('')
  say(`[rescue] 急救面板已启动: ${panel.url}`)
  say(`[rescue] profile: ${target}`)
  say(`[rescue] DSH_HOME: ${home}`)
  say('[rescue] 在浏览器里操作；Ctrl+C 停止服务。')
  if (!process.env.DSH_RESCUE_NO_OPEN) openBrowser(panel.url)

  if (flags.exitAfter > 0) {
    setTimeout(async () => { await panel.close(); process.exit(0) }, flags.exitAfter * 1000)
    return await new Promise(() => {})
  }
  await new Promise((resolve) => process.once('SIGINT', resolve))
  await panel.close()
  say('[rescue] 已停止。')
  return 0
}

async function main() {
  if (flags.help) { usage(); return 0 }

  const home = resolveDshHome()
  const orchestrator = new Orchestrator({ maxInstances: 3 })
  const profiles = listProfiles(home)

  if (flags.list) { printProfiles(profiles); return 0 }

  if (flags.web) return await runWeb(home, profiles)

  if (!flags.profile) {
    printProfiles(profiles)
    if (!process.stdin.isTTY) {
      warn('[rescue] 未指定 profile，且当前不是交互终端。请用 `node bin/rescue.mjs <profile>`。')
      return 2
    }
    flags.profile = resolveChoice(await prompt('请输入编号或 profile 名称: '), profiles)
  }

  if (!flags.profile) { warn('[rescue] 没有选择 profile，已取消。'); return 2 }

  const target = flags.profile.toLowerCase() === 'desktop' ? 'desktop' : flags.profile
  say('')
  say(`[rescue] 目标: ${target}`)
  say(`[rescue] DSH_HOME: ${home}`)

  // ---- disable stage: the part that actually fixes a crashed profile ----
  const skipLaunch = flags.noLaunch || flags.disable.length > 0
  const inspected = orchestrator.inspect(target)
  const wantsDisable = flags.disable.length > 0
    || (!skipLaunch && process.stdin.isTTY && inspected.thirdParty.length > 0)

  if (wantsDisable && isHostRunning() && !flags.force) {
    warn('[rescue] 检测到 DeepSeek Harness 仍在运行。')
    warn('[rescue] 急救工具假定宿主已崩溃；若确定要修改配置，请加 --force 重试。')
    return 2
  }

  let toDisable = [...flags.disable]
  if (!wantsDisable && inspected.thirdParty.length > 0 && !skipLaunch) {
    say(`[rescue] 该 profile 有 ${inspected.thirdParty.length} 个第三方插件，可用 --disable 指定禁用。`)
  }
  if (toDisable.length === 0 && !skipLaunch && process.stdin.isTTY && inspected.thirdParty.length > 0) {
    toDisable = await choosePlugins(inspected.thirdParty)
  }

  if (toDisable.length > 0) {
    const known = new Set(inspected.rows.map((row) => row.id))
    const unknown = toDisable.filter((id) => !known.has(id))
    if (unknown.length > 0) {
      warn(`[rescue] 目标 profile 里找不到这些 id: ${unknown.join(', ')}`)
      warn(`[rescue] 可用 id: ${[...known].join(', ') || '(空)'}`)
      return 2
    }
    const applied = orchestrator.disable(target, toDisable)
    say('')
    say(`[rescue] 已修改: ${applied.file}`)
    say(`[rescue] 已备份: ${applied.backup}`)
    say(`[rescue] 已禁用: ${applied.ids.join(', ')}`)
    if (applied.notDisabled.length > 0) warn(`[rescue] 未生效: ${applied.notDisabled.join(', ')}`)
    say('[rescue] 坏插件已禁用，你可以关闭此窗口并重新启动 DSH 桌面端了。')
  } else if (flags.disable.length === 0 && inspected.thirdParty.length === 0) {
    say('[rescue] 该 profile 未发现第三方插件，无需禁用。')
  }

  if (skipLaunch) {
    say('[rescue] 不启动救援实例，退出。')
    return 0
  }

  let rescued
  if (target === 'desktop') {
    say('[rescue] desktop 由 Electron 独占，CLI 无法直接启动。')
    say('[rescue] 将创建代理 profile "desktop-rescue"（web 核心），并共享 $DSH_HOME 的会话与存储。')
    rescued = await orchestrator.rescue(process.cwd(), {
      name: 'desktop-rescue',
      baseProfile: 'web',
      shareData: true,
      timeoutMs: 90_000,
    })
  } else {
    say('[rescue] 就地救援：直接在该 profile 上叠加救援覆盖层，不改动原有数据。')
    rescued = await orchestrator.rescue(target, { shareData: true, timeoutMs: 90_000 })
  }

  const { prepared, instance, url } = rescued
  const thirdParty = prepared.rescue.thirdParty

  say('')
  say(`PROFILE: ${prepared.profileName}`)
  say(`SHARE_DATA: ${prepared.shareData === true}`)
  say(`PATCH_FILES: ${prepared.patchFiles.length}`)
  say(`THIRD_PARTY_DISABLED: ${thirdParty.length}`)
  if (thirdParty.length > 0) {
    for (const row of thirdParty) say(`  - ${row.id}  ${row.name}`)
  } else {
    say('  （没有第三方插件，救援实例是纯官方核心）')
  }
  say(`VERIFIED: ${prepared.rescue.verified === true}`)
  say('')
  say(`URL: ${url}`)
  say('')
  say('救援实例已就绪。请在浏览器打开上面的地址，处理完问题后回到本窗口按 Ctrl+C 退出。')
  if (prepared.shareData) say('（本实例共享 $DSH_HOME 的会话与存储，因此你能看到原来的历史会话。）')

  let closing = false
  const shutdown = async (reason) => {
    if (closing) return
    closing = true
    say('')
    say(`[rescue] ${reason}，正在收尾…`)
    try {
      const info = await orchestrator.stop(instance)
      say(`[rescue] 实例已停止 (pid=${info.pid}, forced=${info.forced}, dead=${info.dead})`)
    } catch (error) {
      warn(`[rescue] 停止实例失败: ${error?.message ?? error}`)
    }
    if (flags.keep) {
      say(`[rescue] 已保留 profile: ${prepared.profileDir}`)
    } else {
      try {
        const removed = orchestrator.dispose(prepared)
        say(`[rescue] 已清理: ${JSON.stringify(removed)}`)
      } catch (error) {
        warn(`[rescue] 清理失败: ${error?.message ?? error}`)
      }
    }
    say('[rescue] 完成。')
  }

  const finish = (code) => { shutdown('退出').then(() => process.exit(code)) }

  process.on('SIGINT', () => finish(0))
  process.on('SIGTERM', () => finish(0))
  process.on('uncaughtException', (error) => {
    warn(`[rescue] 意外错误: ${error?.stack ?? error}`)
    finish(1)
  })
  process.on('unhandledRejection', (error) => {
    warn(`[rescue] 未处理的异常: ${error?.stack ?? error}`)
    finish(1)
  })

  instance.child?.on('exit', (code) => {
    if (closing) return
    warn(`[rescue] 救援实例意外退出 (code=${code})。`)
    finish(1)
  })

  if (flags.exitAfter > 0) {
    setTimeout(() => finish(0), flags.exitAfter * 1000)
  }
  return undefined // 保持进程常驻，等待信号
}

main()
  .then((code) => { if (typeof code === 'number') process.exit(code) })
  .catch((error) => {
    warn('')
    warn('[rescue] 启动失败。')
    warn(`原因: ${error?.message ?? error}`)
    const hints = {
      EDSH_INSTALL_NOT_FOUND: '找不到 DeepSeek Harness，请设置环境变量 DSH_DESKTOP_EXE 指向 "DeepSeek Harness.exe"。',
      EDSH_NO_PROFILE: '指定的 profile 不存在，可先运行 --list 查看。',
      EDSH_RESERVED_PROFILE: 'desktop profile 不能由 CLI 启动，请直接运行不带参数的 rescue.bat 使用交互模式。',
      EDSH_READY_TIMEOUT: '实例在规定时间内没有输出地址，可能启动失败；可加 --keep 后手工排查。',
      EDSH_PROFILE_INIT_FAILED: 'profile 初始化失败，检查磁盘空间与 DSH 安装完整性。',
      EDSH_CONCURRENCY_LIMIT: '实例数已达上限，请先关闭其他救援实例。',
    }
    if (error?.code && hints[error.code]) warn(`建议: ${hints[error.code]}`)
    warn('')
    process.exit(1)
  })
