# dsh-orchestrator-core

DSH 的 **profile / patch 编排 + 实例治理**层：为工作区生成一次性 profile、拼装覆盖层、隔离会话存储、拉起 / 探活 / 回收实例。

它是两档模式的公共地基：多开隔离模式（每工作区一个进程）与桌面急救工具 G（同一套启动逻辑，换一份参数）。

本阶段只做后端生命周期与实例治理，**不含 UI、不含 Web 路由、不含业务逻辑**。

---

## 约束

- 纯 Node（`>=20`），**零第三方依赖**。
- **不 import 任何 `@deepseek-ai/*`**，只调用官方 CLI。
- 不修改 `~/.dsh/cordis.patch.yml`、不碰 `desktop` profile。

---

## API

```js
import { Orchestrator } from './index.mjs'

const orchestrator = new Orchestrator({ maxInstances: 5 })

const prepared = await orchestrator.prepare(workspacePath, {
  name: 'ws-myproject',      // 可选，默认由路径派生
  baseProfile: 'web',        // 模板
  force: false,              // true = 重建
})

const instance = orchestrator.launch(prepared)      // 也可传 profile 名
const url      = await orchestrator.awaitReady(instance, { timeoutMs: 90_000 })

await orchestrator.list()        // 注册表 + 探活
await orchestrator.stop('ws-myproject')   // pid / profile 名 / 工作区路径 / 句柄
await orchestrator.reap()        // 清残留记录 + 杀孤儿进程
await orchestrator.killAll({ purge: true })
orchestrator.dispose(prepared)   // 删除生成的 profile 与隔离数据
```

| 方法 | 作用 |
|---|---|
| `prepare(workspacePath, options)` | 幂等：确保 profile 存在、生成覆盖层、创建隔离存储目录、写 manifest |
| `launch(preparedOrName)` | 拉起 CLI，强制 `--port 0 --no-open`，`cwd = workspacePath`；注册到注册表并检查并发上限 |
| `awaitReady(instance)` | 从 stdout 解析 `dsh web: <url>`，回填 url/port 到注册表 |
| `list({ probe })` | 全部实例 + `alive`（进程探活）+ `portReachable`（TCP 探测） |
| `stop(target)` | 支持 **pid / profile 名 / 工作区路径 / 实例句柄** 四种定位 |
| `reap()` | 丢弃进程已死的记录；强制杀掉"台账里有、注册表里没有"的孤儿 |
| `killAll({ purge })` | 关闭全部 + 清扫台账；`purge` 时连注册表文件一起删 |
| `rescue(target, options)` | **救援模式**：剥离所有非官方行后拉起，返回 `{ prepared, instance, url }` |
| `dispose(preparedOrName)` | 只删除本层拥有的路径（越界拒绝） |

`rescue(target)` 的 `target` 可以是**工作区路径**（新建 `*-rescue` profile），也可以是**已存在的 profile 名**（就地救援，适用于"某个 profile 已经起不来"）。

错误码：`EDSH_CONCURRENCY_LIMIT`、`EDSH_ALREADY_RUNNING`、`EDSH_INSTANCE_NOT_FOUND`、`EDSH_BAD_TARGET`、`EDSH_PROFILE_INIT_FAILED`、`EDSH_PATCH_MISS`、`EDSH_READY_TIMEOUT`。

---

## 实例治理设计

注册表是**两段式**的（`<home>/orchestrator/registry.json`）：

```jsonc
{
  "instances": { "ws-a": { "pid": 123, "workspacePath": "...", "url": "...", "port": 52918 } },
  "ledger":    { "123": { "id": "ws-a", "spawnedAt": "..." } }
}
```

- `instances`：**声明**一个实例活着。正常 stop 后条目被移除。
- `ledger`：**台账**，记录本管理器拉起过的每个 PID，直到确认它真的死了。

为什么需要台账：Node 无法枚举"哪些进程是我拉起的"，没有台账就只能全机扫描。`reap()` 的孤儿判定因此是
**「台账里存在 + 注册表里没有 + 进程还活着」**。

窗口规则：
- 空注册表**不写文件，直接删文件**（`saveOrPurge`）。否则"关闭一个已死实例"这类调用会把空注册表重新写回磁盘，留下垃圾。

---

## 实现要点

**1. 工作区即 `process.cwd()`**
`launch` 把子进程 `cwd` 设为工作区。DSH 里 `workspaceRoot: !!js process.cwd()`、`profileContext.cwd` 随之正确，**不需要覆盖那一行**（覆盖 `sandbox-policy` 会因 config 整体替换而丢掉 `mode`）。

**2. 会话隔离（S2）**
覆盖层按 id 覆盖两行的 `config`（DSH 的 patch 语义是 **config 整体替换**）：

```yaml
- id: session-persistence-jsonl
  config: { root: '<home>/orchestrator/<profile>/sessions' }
- id: storage-json
  config: { root: '<home>/orchestrator/<profile>/storages' }
```

凭据仍读共享的 `$DSH_HOME/.credentials.yaml`。

**3. 端口**：统一 `--port 0`，OS 分配后从 `dsh web: <url>` 读回，无预分配竞态。URL 自带 `?token=`，HTTP 返回 303（不是 200）——**就绪判定以打印出 URL 为准**。

**4. profile 初始化 ≠ 启动**：`<profile> --from-default-profile <tpl> --dump-config` 建完即退。web 模板可能因无关 schema 告警返回非 0，**以 profile 目录是否生成**判定成功。

**5. Windows 进程树**：先 `process.kill(pid)`，8s 内未退再 `taskkill /T /F`。

---

## 救援模式（rescue）

目标：**DSH 崩坏时，用一个只含官方插件的实例把系统救回来。**

实现分三步，全部围绕"组合后的真实行列表"：

1. **枚举**：先只带 storage 覆盖层跑一次 `--dump-config`，解析出全部顶层行（id / name / disabled）。
   `--dump-config` **不 mount**，所以即使 profile 里有个"加载即崩"的插件，枚举依然能完成——这是救援成立的前提。
2. **判定**：第三方 = `name` 不以 `@deepseek-ai/` 开头 **且** 不以 `cordis:` 开头。
   注意 dump 会把相对插件名规范化成 `file:///...`，所以不能按 `./` 判断。
3. **禁用 + 复验**：为每个第三方行写一条 `- id: <id>\n  disabled: true`，再跑一次带**两层覆盖层**的 `--dump-config`，
   确认这些行确实变成 `disabled: true`。命中失败会记在 `prepared.rescue.notDisabled` 里（否则只会是启动期一句警告）。

产出：`prepared.rescue = { thirdParty, disabledIds, verified, notDisabled, totalRows }`。
官方行**从不触碰**；`disableIds` 可额外指定要禁用（或强制保留）的 id。

**数据共享（急救场景的硬要求）**：救援实例默认 `shareData: true` —— **不写 storage 覆盖层**，
因此会话与存储仍指向 `$DSH_HOME/sessions`、`$DSH_HOME/storages`，用户打开急救就能看到原来的历史会话。
需要隔离时显式传 `shareData: false`。

**关于 `desktop`**：CLI 在 `bin.js:36` 按名字硬拒 `desktop`（"managed exclusively by the Electron application"），
且内置模板只有 `acp / web / headless / sdk / sdk-minimal`（**没有 desktop 模板**）。
所以 `desktop` 无法就地救援；`bin/rescue.mjs` 会用 `web` 模板派生一个 `desktop-rescue` 代理 profile，
并保持 `shareData: true`，从而共享同一份会话与存储。

崩溃的判定不依赖"进程起不来"这种模糊现象：验证脚本让坏插件在加载时**先写标记文件再退出进程**，
于是"基线写了标记 / 救援没写标记"就是**坏插件是否真的被加载**的直接因果证据。

---

## 独立急救入口

```bash
node bin/rescue.mjs                # 交互选择 profile
node bin/rescue.mjs desktop        # 救援桌面环境（走 desktop-rescue 代理）
node bin/rescue.mjs web            # 就地救援 web profile
node bin/rescue.mjs --list         # 列出 profile
node bin/rescue.mjs desktop --keep # 保留生成的 profile 便于排查

# 真正的"修好它"：
node bin/rescue.mjs desktop --disable dsh-webds-bridge-client --no-launch
node bin/rescue.mjs desktop -d a,b --force      # 多个 id；宿主仍在运行时需 --force
```

### 禁用流程（急救闭环）

1. 读取目标 profile 的 `cordis.patch.yml`（**不走 `--dump-config`**：CLI 拒绝任何名为 `desktop` 的 profile，
   而用户装的第三方插件本来就写在这个文件里）。
2. **先备份**：`cordis.patch.yml.bak-<epochMs>`，重名追加 `-1`、`-2`，绝不覆盖旧备份。
3. 写入 `- id: <id>` + `disabled: true`：已有顶层行就在块内改/插；只有 `- insert:` 行就在末尾追加同 id 覆盖
   （patch 按序应用，后者生效）；文件是 `[]` 空数组形式时**先删 `[]` 再追加**（踩坑 #1）。
4. **写完复验**：重新解析确认 `disabled` 真的为 `true`，否则报 `notDisabled`。
5. 提示"坏插件已禁用，可以关闭此窗口并重新启动 DSH 桌面端了"。

**宿主防护**：修改前用 `tasklist` 看是否还有 `DeepSeek Harness.exe`（排除自身 pid）。有则默认**拒绝**（退出码 2），
必须显式 `--force`——急救工具假定宿主已崩溃，不做热修改。

交互式菜单：启动救援实例前若检测到第三方插件，会列表并提示输入编号（逗号分隔，回车跳过）。

Windows 双击 `rescue.bat` 即可。它按以下顺序找运行时，**不需要全局 node、也不写死安装路径**：

1. `%DSH_DESKTOP_EXE%` / `%DSH_DESKTOP_NODE_EXECUTABLE%`
2. 常见安装位置（Program Files / LocalAppData）
3. **`%DSH_HOME%\dsh-runtimes\*\dependencies\node\bin\node.exe`**（DSH 自己下载的 runtime）
4. PATH 上的 `node`

exe 路径本身由 `resolveInstall()` 推导：显式参数 → 环境变量 → **Windows 卸载注册表的 `DisplayIcon`** → 常见位置。
因此 DSH 装在任意盘符都能自动找到。

CLI 行为：打印 `URL` 后**阻塞等待 Ctrl+C**，收到信号则停止实例并清理（`--keep` 可保留），全程 try/catch，
任何异常都落到人类可读的提示 + 退出码，不会抛栈给用户。

---

## 验证

```bash
node verify.mjs          # 单实例：prepare → 覆盖层预检 → launch → URL → HTTP → stop → dispose
node verify-multi.mjs    # 多实例：3 开 → 限额 → 关 1 → 硬杀 → reap → 孤儿清扫 → killAll
node verify-rescue.mjs   # 救援：植入"加载即崩"插件 → 基线崩 → rescue 绕过并起服务 → killTree 验证
node verify-cli.mjs      # 急救 CLI：注册表发现安装 → --list → desktop 救援 → 共享数据 → 零残留
```

`verify-multi.mjs` 的 12 项断言（v1 实测全过，`elapsedMs≈9.4s`，`residue.registryFile=false`）：

```
up ×3                         → list 3/3 live，端口均可达
第 4 个 launch                → EDSH_CONCURRENCY_LIMIT (3/3)
stop(工作区路径)               → 剩 2，pid 已消失
process.kill(崩溃) + reap     → staleRemoved=[崩溃实例]
删掉注册表记录 + reap          → orphansKilled=[孤儿 pid]，进程死亡
killAll({purge:true})         → remaining=0，注册表文件已删
```

---

## 已知边界

- **覆盖层的行 id 取自 `dsh-base`**（`session-persistence-jsonl`、`storage-json`）。上游改名会让 patch 静默跳过——`verify` 用 `--dump-config` 做了强断言，产品侧也应保留该预检。
- 普通 Node **无法 stat `app.asar` 内部**，安装探测只校验 exe 旁的 `resources/app.asar` 是否存在。
- **`taskkill /T /F` 兜底路径已实测覆盖**（`verify-rescue.mjs` 用父子进程树验证：父、子均被回收）。
  但真实的 DSH 实例目前都是 `SIGTERM` 干净退出（`forced=false`），强制路径只在夹具上验证过。
- **空注册表必须删文件而不是写空文件**：否则"关闭一个已死实例"会把空注册表重新写回磁盘。
- **GUI 会整体重写 `profiles/<name>/cordis.patch.yml`**：用户在界面改设置（权限预设、默认模型等）时，
  DSH 会把该文件整体重写，甚至做格式迁移（实测旧的 `!!js` trustedHosts 被改写成静态 `web-runtime.trustedHosts`）。
  任何"往 profile patch 里写东西"的功能都必须假设该文件随时可能被宿主覆盖，不能作为唯一事实来源。
- **CLI 按名字硬拒 `desktop`**（`dsh/lib/bin.js:36`），且**没有 desktop 模板**；桌面救急只能走 `desktop-rescue` 代理。
  救援实例本身用官方 web 核心启动（能回到环境、看到历史），**禁用坏插件则直接改目标 profile 的 patch 文件**（`--disable`）。
- **解析 `- id:` 必须按缩进过滤**：`config.providers.*.models[]` 里也有 `- id:` / `name:`，误收会让"第三方插件"从 1 个变成 113 个。
  当前只接受列 0（顶层覆盖）与列 4（`- insert:` / group config 的子项）。
- 未做：排队（超限直接抛错）、UI、跨实例会话汇总、插件健康检查。
