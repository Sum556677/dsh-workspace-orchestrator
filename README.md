# dsh-workspace-orchestrator

**按工作区隔离插件、诊断冲突、并在 DSH 崩溃时自救。**

DSH 插件编排与工作区隔离管理器：插件清单、冲突扫描、按工作区禁用插件（黑名单）、
独立的多开隔离实例，以及一个完全不依赖 DSH 进程的急救工具。

## 安装

```powershell
dsh plugin --profile desktop add dsh-workspace-orchestrator
```

装完**托盘彻底退出 DSH 再启动**（不是关窗口）。

## 三个核心能力

### 1. 工作区插件黑名单（设置 → 工作区编排）

插件默认全开——原生面板怎么开就怎么来。这个面板只负责**局部禁用**：

- 顶部下拉框自动读取 DSH 左侧栏的工作区列表
- 下方列出所有第三方插件，**默认全部打勾**
- **取消勾选 = 在这个工作区禁用该插件**
- 切换工作区，勾选状态随之切换

写入 `$DSH_HOME/workspace-orchestrator/single-mode.json`：

```json
{ "version": 2, "workspaces": { "D:/my-project": { "disabledPlugins": ["dsh-novel-writer"] } } }
```

真正生效在**新建会话**时：进入某工作区，黑名单里的插件被卸载，其余恢复。
离开该工作区会自动还原。

> 带界面的双端插件（如 `dsh-webds-bridge`）后端被卸载后，**页面上的入口要刷新
> （`Ctrl+Shift+R`）才消失**——client 代码已经加载进浏览器了，后端管不到。

### 2. 隔离实例（多开）

面板里的「在此工作区开启隔离实例」，或对 Agent 说「在 `D:\code` 开一个隔离实例」。
独立 profile、独立会话与存储、OS 分配的端口。同样遵守该工作区的黑名单。

### 3. 急救工具

DSH 起不来时**不依赖 DSH**：

```bat
bin\rescue.bat --web        :: 打开独立急救网页面板（127.0.0.1:8765）
bin\rescue.bat desktop --disable <插件id>   :: 命令行禁用坏插件
```

急救面板可以列出插件、把插件**可逆地**移出 `node_modules` 并写入 `disabled: true`，
也支持 bundle 插件（无文件夹可移时改为改配置）。所有改动先备份，可一键恢复。

## Agent 工具

| 工具 | 用途 |
|---|---|
| `scan_plugins` | 列出当前 profile 的第三方插件 |
| `scan_conflicts` | 静态冲突扫描（重复 id / 重复包 / 重复 service / 循环依赖 / 缺依赖） |
| `manage_workspace_scope` | 读写工作区黑名单 |
| `launch/list/stop_workspace_instance` | 隔离实例的生死管理 |
| `debug_single_mode` | 诊断黑名单：报告每行的 `fiber` 是 ACTIVE 还是已卸载 |

直接说「调用 debug_single_mode」即可，它会给出结论，例如
「dsh-webds-bridge：已禁用，fiber 已卸载 —— 单开模式工作正常」。

## 排障

**插件禁用了还在跑？** 调用 `debug_single_mode` 看 `fiber` 列：

- `NONE` = 后端已卸载，你看到的是前端残留 → 刷新页面
- `ACTIVE` = 没禁用成功 → 看下面的调试日志

**开调试日志**（默认关闭）：

```powershell
# 方式一：环境变量后重启
setx DSH_ORCH_DEBUG 1

# 方式二：运行时开启（立即生效）
curl.exe -X POST -H "content-type: application/json" -d "{\"enabled\":true}" `
  "http://127.0.0.1:<端口>/workspace-orchestrator/api/scope/debug"
```

日志写入 `$DSH_HOME/workspace-orchestrator/debug.log`，含实际 cwd、`pathKey`、
匹配到的黑名单、每行的 `fiber` 前后状态。

## 离线自测

```powershell
node lib/orchestrator-core/verify-context-access.mjs
node lib/orchestrator-core/verify-rescue-web.mjs  --home D:\tmp\dsh-test
node lib/orchestrator-core/verify-scope-rpc.mjs   --home D:\tmp\dsh-test
node lib/orchestrator-core/verify-blacklist.mjs   --home D:\tmp\dsh-test
```

共 158 项检查，**拒绝在真实 `~/.dsh` 上运行**。

## 兼容性

| 项 | 值 |
|---|---|
| DSH 运行时 | `0.2.1-rc.2`（本版本实测） |
| Node | `>= 22.19.0` |
| 前端 | DSH Web / 桌面端共用同一套设置面板 |
| 平台 | Windows 优先（路径规范化、急救 `.bat`）；其余平台未实测 |

## 设计约束

- **零第三方依赖，零 `@deepseek-ai/*` import**——框架能力只通过 `ctx` 获取
- **`apply()` 永不抛错**：任何失败都记录并降级，插件不会是 profile 启动失败的原因
- **绝不写回 profile patch**（除急救工具的显式动作）：黑名单只改内存与自己的映射文件

## What exists today

| Piece | State |
|---|---|
| Bundle patch `cordis.patch.yml` inserting loader row `dsh-workspace-orchestrator` | done |
| `apply(ctx)` — registers seven tools, zero throwing IO, never fails a boot | done |
| `scan_plugins` — third-party plugin inventory **+ live isolated-instance summary** | done |
| `launch_workspace_instance` — one-shot profile, isolated sessions/storages, OS-assigned port | done |
| `list_workspace_instances` — registry + process/port liveness | done |
| `stop_workspace_instance` — by pid / profile name / workspace path | done |
| `lib/orchestrator-core/` — profile & patch orchestration, instance registry, rescue mode | done |
| `bin/rescue.mjs` + `bin/rescue.bat` — standalone rescue (no DSH process needed) | done |
| `bin/rescue.mjs --web` — standalone rescue **web panel** with reversible disable/restore | done |
| Bundle-level rescue (`dsh.profile.bundles`): 仅禁用 / 彻底移除 / 恢复 | done |
| Workspace blacklist (settings panel + `manage_workspace_scope`) | done |
| Conflict scan (`lib/conflict-scan.mjs`, `scan_conflicts` tool + settings panel) | done |
| `debug_single_mode` — live fiber state diagnosis | done |
| Version rollback | **not yet** |

Everything instance-related lives in `lib/orchestrator-core/`; the tools are thin bridges that
translate arguments and render results, so there is exactly one implementation of the behaviour.

## Compatibility

| Item | Value |
|---|---|
| DSH runtime verified against | `0.2.0-rc.2` (desktop app build `04f392c9ddd144fa426da2045178797da6db6c11`) |
| Electron / Node host | Electron `44.0.0`, Node `24.18.1` |
| `@deepseek-ai/cordis` | `4.0.4` |
| Declared in `package.json` | `dsh.compatibleRuntime: "0.2.0-rc.2"` |

## Engineering contract

- **No `@deepseek-ai/*` import.** Framework capabilities are reached through `ctx`
  (`ctx.tools`, `ctx.logger`). The tool is registered as a plain definition object, so
  `defineTool` is not needed; `lib/patch-yaml.js` and `lib/profile.js` are dependency-free
  and import only `node:` builtins.
- **`apply(ctx)` never throws and performs no IO.** It registers one tool and returns. Every
  failure path logs and degrades. Scanning happens inside `execute`.
- **No HTTP routes.** When one is added it will use the `/plugin-orchestrator/` prefix and
  degrade on conflict.
- **Unique entry id.** `dsh-workspace-orchestrator`; the tool name `scan_plugins` is
  likewise unique (the registry rejects duplicates, which is verified).
- **Read-only.** Stage 1 writes nothing anywhere.

## `scan_plugins`

Reads, in order:

1. `<profile>/package.json` → `dsh.profile.bundles` (the ordered bundle selection) and
   `dependencies` (what is actually installed).
2. `<profile>/cordis.patch.yml` → the user's patch layer: `insert` rows add loader entries,
   id-targeted rows override or disable them.
3. `ctx.get('pluginManager')` → optional. When the official manager service is mounted it
   supplies the runtime version and per-bundle load state. Its absence degrades fields to
   `null`; it never errors.

Returns, per third-party plugin: loader-entry `id`, package `name`, `version`, effective
`enabled`, and the `source` row that produced it (`bundle` / `patch-insert` / `dependency` /
`patch-override`). Bundles under `@deepseek-ai/*` are filtered out and only counted.

### The profile directory

Finding the *active* profile from inside the host process is the subtle part. `DSH_PROFILE_DIR`
and `DSH_PROFILE` are injected into **tool subprocess** environments and may be absent in the
host, so they are only the first guess. Candidates are tried in order
(`env:DSH_PROFILE_DIR` → the launcher's own `--profile` / positional argv → `hmr.baseDir` →`env:DSH_PROFILE` → walk-up from this module) and each is **validated structurally**: a real
profile directory has a `package.json` with a `dsh.profile` field. An unresolved profile is
reported as such rather than guessed.

## Installing

The Desktop profile is owned by the Electron application, so the CLI refuses to boot or
`--dump-config` it; plugin installation, however, is supported:

```
dsh plugin --profile <name> add dsh-workspace-orchestrator
```

For any other profile, list the package in `dsh.profile.bundles` (or load
`cordis.patch.yml` as a `--patch` overlay):

```
dsh --profile <name> --patch <this-dir>/cordis.patch.yml
```

## Layout

```
index.js              apply(ctx), the scan_plugins definition, and its renderer
lib/profile.js        profile-directory discovery and structural validation
lib/patch-yaml.js     dependency-free reader for cordis.patch.yml
lib/scan.js           the inventory: sources, resolution, merge, report
cordis.patch.yml      bundle patch inserting the loader row
```

## Known limitation

`lib/patch-yaml.js` is not a general YAML parser. It reads exactly the patch layer's shape and
skips `config:` blocks wholesale (a row's config is arbitrary deployment data — the desktop
profile's `llm-pi-ai` row holds a ~230-line nested provider map). Flow collections, block
scalars, anchors/aliases and multi-document files are reported as diagnostics rather than
silently misread.

## 六个工具与极简用法

| Tool | 一句话 | 自然语言示例 |
|---|---|---|
| `scan_plugins` | 列出当前 profile 的第三方插件 + 已开实例 | 「看看我现在装了哪些第三方插件？」 |
| `scan_conflicts` | 静态冲突扫描（重复 id / 重复包 / 重复 service / 环 / 缺依赖） | 「扫一下当前 profile 有没有插件冲突。」 |
| `manage_workspace_scope` | 读写「工作区 → 禁用黑名单」 | 「在 `D:\novels` 禁用 `dsh-novel-writer`。」 |
| `launch_workspace_instance` | 为工作区拉起隔离实例，返回 URL | 「在 `D:\code` 开一个隔离实例。」 |
| `list_workspace_instances` | 列出本管理器拉起的实例并探活 | 「现在开着几个隔离实例？」 |
| `stop_workspace_instance` | 按 pid / profile / 工作区关闭实例 | 「把刚才那个实例关掉。」 |
| `debug_single_mode` | 诊断黑名单：每行 fiber 是 ACTIVE 还是已卸载 | 「调用 debug_single_mode」 |

**三条典型用法**

1. **多开隔离**：说「在 `D:\code` 开一个隔离实例」→ Agent 调 `launch_workspace_instance`，返回带 token 的 URL；用完说「关掉」→ `stop_workspace_instance`。
2. **单开黑名单**：在面板取消勾选，或说「在 `D:\novels` 禁用 X」→ `manage_workspace_scope`（包名自动反查行 id；有歧义会停下来问你）。
3. **急救**：DSH 起不来时**不依赖 DSH**，直接双击 `bin/rescue.bat`（或 `node bin/rescue.mjs`）→ 进救援实例看历史 → `rescue.bat desktop --disable <插件id>` 一键禁用坏插件并自动备份。
   完全不想开实例时用 `bin/rescue.bat --web`（或 `node bin/rescue.mjs --web`）：起一个独立于 DSH 的网页面板（`127.0.0.1:8765`，占用则随机端口），
   看冲突告警、第三方插件清单，并对插件做**可逆隔离/恢复**——见下节。

### 急救网页（`--web`，P3）

```bat
bin\rescue.bat --web                 :: 自动选 profile（优先 desktop），默认 127.0.0.1:8765
bin\rescue.bat --web web --port 9000 :: 指定 profile 和端口
bin\rescue.bat --web --no-open       :: 不自动打开浏览器
node bin\rescue.mjs --web            :: 有 node 时等价
```

- **`rescue.bat` 怎么选运行时**：优先用 DSH 自带的 Electron（`ELECTRON_RUN_AS_NODE=1`，无需装 Node）→ 其次 `$DSH_HOME/dsh-runtimes/*/dependencies/node/bin/node.exe` → 最后 PATH 里的 `node`。找不到运行时会在窗口里**停留并提示**（不会一闪而过）。
- **`rescue.bat` 交互**：不带参数双击 → 列出 profile 让输入编号或名字；指定了 `--web` → 不起救援实例，只开网页；出错时窗口会 `pause` 保留报错，成功退出不打扰。
- **通信**：纯 `node:http` + 内联 HTML/CSS/JS，无外链 CDN。不启动 DSH、不碰会话数据，只读写 `$DSH_HOME/profiles/<profile>` 与 `$DSH_HOME/workspace-orchestrator/disabled/`。接口需页面内嵌的随机 token（`x-rescue-token`），无 token 一律 403。

**页面三块**

| 区块 | 内容 |
|---|---|
| 冲突告警 | 静态扫描结果，红色 = error，黄色 = warning / 降级说明 |
| 插件列表 | 第三方插件（含 **bundle**），状态 + 位置 + 操作按钮 |
| 已隔离备份 | 每次禁用都会留记录，可一键恢复 |

**两种插件的禁用方式不同（关键）**

| 类型 | 识别方式 | 禁用动作 | 恢复 |
|---|---|---|---|
| **package** | 装在 `node_modules` | 文件夹移动到 `workspace-orchestrator/disabled/<pkg>@<ver>/payload`，并追加 `disabled: true` 行 | 文件夹移回 + 摘除追加行 |
| **bundle** | profile `package.json` → `dsh.profile.bundles` | 没有文件夹可移，只改配置：按该 bundle 自己 `cordis.patch.yml` 里的**真实入口 id**（不是包名）逐个追加 `disabled: true` | 摘除追加行；若当时「彻底移除」过，再从备份还原 manifest 条目 |

- **bundle 两个按钮**：「仅禁用」只写 patch；「彻底移除」额外把包名从 `dsh.profile.bundles` **和** `dependencies` 一并删掉（防止下次 pnpm install 又装回来），两个文件都先备份。
- **为什么禁用行能生效**：补丁按顺序应用，后置的同 id 行覆盖前置行（`dsh-app-boot` 的 `applyEntryPatches` 语义），所以文件末尾追加的 `- id: <入口 id>` + `disabled: true` 一定会盖掉 bundle 自己的 `- insert:` 行。
- **id 是猜的会明说**：如果 bundle 没有安装目录或没声明 `dsh.bundle.patch`，读不到真实入口 id，页面会标黄提示「暂用包名」，不会假装成功。
- 所有写文件动作都先备份（`cordis.patch.yml.bak-<ts>` / `package.json.bak-<ts>`），同一毫秒多次改也不会互相覆盖。
- 安全边界：包名与隔离目录名做路径校验；`quarantine.json` 里的原路径必须仍在本 home 的 `profiles/` 内，否则拒绝移动。
- 离线自测：`node lib/orchestrator-core/verify-rescue-web.mjs --home D:\tmp\dsh-test`（68 项检查，覆盖两种插件的完整闭环；**拒绝**在真实 `~/.dsh` 上运行）。

**其他已知边界**

- 静态扫描只看 profile `node_modules`：官方 bundle 在 `app.asar` 内读不到源码；覆盖率 <50% 时**不报**"缺失依赖"，只留 `low-coverage` 提示。
- 双模安全防线：单开模式只翻内存里的 `disabled`（不写盘），并发工作区出现即**冻结并告警**；真正要隔离请用多开模式。多开实例在 Windows 上随宿主进程退出而终止。

## Release 0.1.0 — release notes

首次发布。包含：插件清单与冲突扫描、按工作区隔离的多开实例、单开轻量切换、以及**完全独立于 DSH 进程的急救 CLI + 急救网页**。

**新增**
- 急救网页 `rescue --web`：冲突告警 / 第三方插件清单 / 可逆隔离恢复，全部离线、无 CDN、带 token 鉴权。
- bundle 级急救：`dsh.profile.bundles` 加载的插件现在也能被列出并禁用（「仅禁用」写 patch 行；「彻底移除」同时清 manifest 的 bundles 与 dependencies），两者都可恢复。
- `bin/rescue.mjs --web` 自动选 profile、端口被占用自动换随机端口、`DSH_RESCUE_NO_OPEN` 可禁止自动开浏览器。

**修复（本轮）**
- 急救面板此前对 **bundle 插件完全不可见**——`dsh.profile.bundles` 加载的坏插件无法处理，等于急救失败。
- 嵌套 `- insert:`（含双层）里的插件行此前识别不到，隔离时会把文件夹移走却**不写禁用行**，插件实际仍会加载。
- 隔离期间用户改过 patch 后，恢复会静默失败留下孤儿禁用行；现在会按记录精确清理，清理不了就明确扣警。
- 同一毫秒多次改 patch 会覆盖彼此的备份；现已去重。
- 「彻底移除」的校验改到写文件之前，失败时不再留下半改状态。

**已知限制**
- bundle 若既无安装目录又无 `dsh.bundle.patch`，真实入口 id 读不到，只能用包名兜底（页面会标黄）。
- 官方 `@deepseek-ai/*` 插件一律不列出、不可禁用。
- 版本回滚尚未实现。

## 设置面板：以工作区为中心的插件黑名单（0.3.0）

设置 → **工作区编排**。视角是「**先选工作区，再勾插件**」，而勾选的含义是**黑名单**：
插件默认全开（原生 profile 怎么说就怎么来），**取消勾选 = 在这个工作区禁用**。

> 0.2.0 是白名单语义（勾选=启用）。原生面板一旦"全开"，白名单就完全失效——这正是 0.3.0 反转的原因。

1. **工作区下拉框**：自动读取 DSH 左侧栏的工作区列表，选项显示标题（如 `DSH_web`、`DSH_plugin`）并附带已禁用数量。
   数据源是 `$DSH_HOME/storages/workspace.json`（DSH 的 workspace 存储单元，domain `workspace` v2）：
   `global.workspaceIds` 决定**显示顺序**，`tables.workspaces[<id>]` 提供 `path` / `title`。只读，不写这个文件。
2. **手动输入**：点「手动输入」可填一个 DSH 里还没建过的目录。
   下拉框里也会出现「仅绑定，不在侧栏」的条目——映射文件里有、但侧栏已删掉的工作区，保证旧条目不被藏起来。
3. **插件勾选**：列出当前 profile 的第三方插件。**默认全部打勾**（= 全启用）；
   取消勾选会把该插件加入当前工作区的禁用黑名单，提示「xxx 已加入当前工作区的禁用黑名单」。
   每次只增删**一个** row id（`POST /scope/toggle`），不会整体覆盖，避免和 Agent 并发改同一条时互相吃掉。
4. **在此工作区开启隔离实例**：多开模式按钮。拉起的子 profile 会把黑名单写成 `disabled: true` 覆盖层。

写入 `$DSH_HOME/workspace-orchestrator/single-mode.json`（v2）：

```json
{
  "version": 2,
  "workspaces": {
    "D:/Agent_workspaces/DSH_plugin": { "disabledPlugins": ["dsh-novel-writer"] }
  }
}
```

没有条目的工作区 = 什么都没禁用 = 全部启用。

**运行时怎么执行黑名单**

进入工作区（`session/created`）时，对「**任一工作区**黑名单里出现过的 id ∪ 当前工作区黑名单」逐行执行：

- 在**当前**工作区黑名单里 → `entry.update({ disabled: true })`
- 不在 → `entry.update({ disabled: false })`（**恢复**）

"恢复非黑名单行"是关键：即使你在原生面板把某插件打开了，只要进入禁止它的工作区，它照样被卸掉；
离开该工作区又会自动恢复。本进程曾经关掉过的行（`blacklistedNow`）即便映射文件之后被清空，切换工作区时也会被还原。
从没被任何工作区列入黑名单的行，单开模式**完全不碰**，保持原生状态。

**多开隔离实例**

`prepare()` 接受 `blacklist`，写进 `orchestrator.overlay.yml`：

```yaml
# workspace blacklist (from single-mode.json)
- id: dsh-novel-writer
  disabled: true
```

补丁后置覆盖前置，所以黑名单在子进程里同样生效。id 里若含 YAML 特殊字符会被加引号，无法借 id 注入额外行。
`shareData: true`（急救）时忽略黑名单——救援必须拿到原始状态。

**Agent 语义对齐**

`manage_workspace_scope` 的描述已改为黑名单口径：「在 D:\novels 禁用插件 X」= `action="set"` + `workspacePath` + `pluginRowIds`，
这些 id 表示**该工作区禁用的行**。`action="remove"` 删除整个工作区条目 = 恢复全启用。

**边界（必须知道）**

- 黑名单只记录**意图**，不改磁盘上的 `disabled`。真正的启停在**新会话建立时**执行；当前已开着的会话不会立即改变。
- 面板「运行状态」列显示当前进程里的真实启停，和勾选状态不同步是正常的。
- 没有 loader 行 id 的插件（部分 bundle 加载的行）勾选框是灰的，无法加入黑名单。
- **旧版（v1 白名单）文件**：白名单无法无损转成黑名单（不知道哪些是"用户没勾"），所以按**空黑名单**处理
  并在面板顶部提示「检测到旧版白名单格式」。需要限制的话重新取消勾选即可——绝不静默猜一个可能是错的禁用集合。
- `workspace.json` 损坏或不存在时，面板照常渲染，下拉框为空并提示原因，可改用「手动输入」。

## Tool registration contract (learned the hard way)

- **`inject: ['tools']` is mandatory.** Cordis 4 gates service access: reading `ctx.tools` in
  `apply()` without declaring it throws `cannot get property "tools" without inject`. A direct
  `execute()` harness never goes through `apply()`, so this only shows up in a real session.
- **`register()` validates only `output`, never `parameters`.** A malformed parameter schema
  fails at model-call time, not at registration — validate it in the harness.
- **Long-lived instances must be detached** after readiness (`detachInstance`): piped stdio is
  what lets us read the URL, but those pipes keep the *host* event loop alive, so the host would
  never exit. On Windows the instance still dies with the host process (job-object semantics);
  keeping instances alive therefore requires a long-running host (the GUI or `bin/rescue.mjs`).

## 单开轻量模式（乙）与自然语言配置

在一个 DSH 进程内，按**当前会话的工作区**动态启停插件行，不重启、不写盘。
它是"尽力而为"的便利档，**不提供隔离保证**；并行多工作区请用多开模式。

### 用自然语言配置

插件行 id 来自 `scan_plugins`，绑定关系由 `manage_workspace_scope` 写入。
所以直接对 Agent 说：

> 「先 scan_plugins 看看有哪些第三方插件，然后把网文那几个插件绑定到 `D:\novels`，把代码插件绑定到 `D:\code`。」

Agent 会依次调用 `scan_plugins` → `manage_workspace_scope`，写入：

```json
{
  "version": 1,
  "workspaces": {
    "D:/novels": ["novel-writer"],
    "D:/code": ["webds-bridge-client"]
  }
}
```

保存在 `$DSH_HOME/workspace-orchestrator/single-mode.json`。也可以直接问
「现在的工作区绑定是怎样的？」（`action: "list"`），或
「把 `D:\novels` 的绑定删掉」（`action: "remove"`）。

**没写进这张表的行永远不会被单开模式碰。** 这是刻意的：不猜测"哪个插件属于哪个工作区"。

绑定既可以用行 id，也可以直接给**包名**（`pluginNames`）——工具会用 live loader 树把包名反查成行 id。
包名找不到或不唯一时**不写入**，返回 `UNKNOWN names` / `AMBIGUOUS`，让 Agent 去问用户确认。

### 静态冲突扫描（`scan_conflicts`）

对当前 profile（或 `profile` 参数指定的）做纯静态检查，**不执行任何插件代码**：

| 级别 | 检查项 |
|---|---|
| error | `duplicate-entry-id` 同一 loader 行 id 出现多次 |
| error | `duplicate-plugin-name` 同一个**第三方**包被插入成多条行（官方包多实例是常态，不报） |
| error | `duplicate-service` 两个插件 `provide` 同名 service |
| error | `dependency-cycle` service 依赖成环 |
| warning | `missing-dependency` inject 的 service 无人提供 |

数据来源：`dsh <profile> --dump-config`（`desktop` 被 CLI 拒绝，退化为只扫它自己的 patch 层，并给出 `patch-only` 提示）。
依赖边来自插件源码文本里的 `static inject = [...]`、`super(ctx, "svc")`、`provide("svc")`。

**已知边界（会写进 `notes`，不猜）**：
- 重复 **tool 名**无法静态得知（注册调用是运行时实参）→ 永远给 `tool-names-unknown` 提示。
- 只有装在 profile `node_modules` 里的插件能读到源码；官方 bundle 在 `app.asar` 内。
  覆盖率 < 50% 时**不报告**"缺失依赖"（无法区分真缺与读不到），改给 `low-coverage` 提示。

### 三条安全防线

| 防线 | 做法 |
|---|---|
| 绝不写回磁盘 | 只调 `entry.update({ disabled })`；从不调用 `loader.write/create/remove/update` |
| 不碰 config | 只翻 `disabled`；改 config 会经 `internal/update` 触发 `tree.write()` |
| 并发冻结 | `sessions.list()` 出现 >1 个 distinct cwd 时立即冻结并告警，之后不再切换 |

发生产生切换时，日志里能看到 `[single-mode] 检测到并发工作区（N 个）…`。

### 实测（真实 DSH 进程）

`_research/verify-single-e2e.mjs` 用一次性 profile + 两个探针插件跑两次：

```
run A (cwd=D:/ws/e2e-a):  probe-a mounted  probe-b mounted  →  probe-b unmounted
run B (cwd=D:/ws/e2e-b):  probe-a mounted  probe-b mounted  →  probe-a unmounted
```

映射文件哈希前后一致（零写回），未误触发冻结。
`ctx.get('loader')` 与 `ctx.get('sessions')` 在真实进程里**不需要 inject**（二者是运行时查找，不是服务属性访问）。
