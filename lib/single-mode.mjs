/**
 * 单开轻量模式（乙）
 *
 * 在一个长期运行的 DSH 进程内，按“当前会话的工作区”切换一组插件行的启用状态。
 * 它是**尽力而为的轻量档**：没有隔离保证，只做便利切换；并发工作区一旦出现就冻结。
 *
 * 三条安全防线（依据阶段二的源码考古）：
 *   1. 绝不写回磁盘 —— 只调用 `entry.update({ disabled })`。`Entry.update()` 自身不调用
 *      `tree.write()`；只有 `EntryTree.update/create/remove` 会写，本模块从不使用它们。
 *   2. 不碰 config —— 只翻 `disabled`。改 `config` 会经 `internal/update` 触发
 *      `parent.tree.write()`，把状态固化进 profile 的 cordis.patch.yml。
 *   3. 并发拦截 —— `sessions.list()` 出现多于一个 distinct cwd 时立刻冻结并告警。
 *
 * 该模块只依赖 Node 内置模块，不引用任何 @deepseek-ai 运行时包。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { orchestratorRoot } from './orchestrator-core/src/paths.mjs';

export const TAG = 'single-mode';

/** How long to wait for a fiber teardown/restart to land before reporting failure. */
const STATE_TIMEOUT_MS = 2000;
/** Polling granularity while waiting for that state change. */
const POLL_MS = 50;

/**
 * Loader entry ids this feature must never disable.
 *
 * Disabling our own row takes the host half down — including the settings API and this
 * very listener — which surfaces in the panel as "single mode is not running" while the
 * client bundle keeps rendering. A workspace must never be able to switch off the tool
 * that manages it.
 */
const PROTECTED_IDS = new Set([
  'dsh-workspace-orchestrator',
  'plugin-orchestrator',
]);

/**
 * Whether an id is ours and therefore immune to the blacklist.
 * @param {unknown} id
 * @returns {boolean}
 */
export function isProtectedId(id) {
  if (typeof id !== 'string' || id.length === 0) return false;
  if (PROTECTED_IDS.has(id)) return true;
  return /(^|[/-])workspace-orchestrator$/.test(id);
}

/** 默认映射文件：$DSH_HOME/orchestrator/single-mode.json */
export function defaultMappingPath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh');
  return join(orchestratorRoot(home), 'single-mode.json');
}

/**
 * 工作区路径的比较键。
 *
 * Windows 上同一个目录有很多种写法：盘符大小写（`d:` / `D:`）、正反斜杠、尾部斜杠、
 * 尾部的空格/点（Win32 会忽略）、以及 `\\?\` / UNC 前缀。其中任何一个不一致都会让
 * 黑名单"看起来配好了却不生效"，所以这里统一折叠成唯一形式。
 *
 * 非 Windows 上路径区分大小写，只折叠分隔符与尾部斜杠。
 */
export function pathKey(target) {
  if (typeof target !== 'string' || target.trim().length === 0) return '';
  let text = target.trim();
  if (process.platform !== 'win32') {
    // POSIX: keep case, only collapse duplicate slashes and a trailing slash.
    const absolute = resolve(text);
    return absolute.replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1');
  }
  // Long-path / device prefixes carry no identity meaning.
  text = text.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').replace(/^\\\\.\\/, '');
  let absolute;
  try {
    absolute = resolve(text);
  } catch {
    absolute = text;
  }
  let normalized = absolute.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  // Win32 silently drops trailing spaces and dots from path components. Strip them per
  // component (never from the root `/` or a drive root like `D:/`).
  normalized = normalized
    .split('/')
    .map((part, index) => (index === 0 || /^[A-Za-z]:$/.test(part) ? part : part.replace(/[. ]+$/, '')))
    .join('/');
  // Drop a trailing slash unless the whole thing is a root.
  if (normalized.length > 1 && !/^[A-Za-z]:\/$/.test(normalized)) normalized = normalized.replace(/\/+$/, '');
  return normalized.toLowerCase();
}

/**
 * 读取工作区 → **禁用黑名单** 的分配表。
 *
 * 语义：原生 profile 里的插件默认是"开"的，本模块只负责**局部禁用**。
 * 所以每个工作区记录的是「在这个工作区里**不该跑**的插件 id」，而不是白名单。
 * 好处：用户没操作过的插件默认启用，符合直觉，也不会被原生开启的插件穿透。
 *
 * 形如 `{ "version": 2, "workspaces": { "D:/ws/a": { "disabledPlugins": ["id-a"] } } }`
 *
 * 兼容 v1（白名单）：v1 里存的是"该工作区启用的 id"。白名单无法无损转换成黑名单
 * （不知道哪些是"用户没勾"），因此 v1 条目按空黑名单处理并在 `migrated` 里报告，
 * 由调用方提示用户重新设置——绝不静默猜一个可能是错的禁用集合。
 */
export function readMapping(file) {
  try {
    if (!existsSync(file)) return { workspaces: new Map(), raw: {}, file, error: null, migrated: [], ignored: [] };
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const raw = parsed && typeof parsed === 'object' ? parsed.workspaces : undefined;
    if (!raw || typeof raw !== 'object') {
      return { workspaces: new Map(), raw: {}, file, error: 'workspaces must be an object', migrated: [], ignored: [] };
    }
    const workspaces = new Map();
    const migrated = [];
    /** Protected ids found in the file; kept so the caller can tell the user. */
    const ignored = [];
    for (const [workspace, record] of Object.entries(raw)) {
      // v2: { disabledPlugins: [...] }   v1 (legacy allowlist): [...]
      const isLegacy = Array.isArray(record);
      const ids = isLegacy
        ? []
        : Array.isArray(record?.disabledPlugins) ? record.disabledPlugins : [];
      if (isLegacy) migrated.push(workspace);
      // A protection violation stored by an older build must not arm itself on boot.
      const filtered = ids
        .filter((id) => typeof id === 'string' && id.length > 0)
        .filter((id) => {
          if (!isProtectedId(id)) return true;
          ignored.push({ workspace, id });
          return false;
        });
      workspaces.set(pathKey(workspace), filtered);
    }
    return { workspaces, raw, file, error: null, migrated, ignored };
  } catch (error) {
    return { workspaces: new Map(), raw: {}, file, error: String(error?.message ?? error), migrated: [], ignored: [] };
  }
}

/**
 * 原子写入映射表（先写临时文件再 rename），并在该目录是新建时创建它。
 * 只写 `single-mode.json`，永远不触碰任何 profile 的 cordis.patch.yml。
 *
 * `workspaces` 形如 `{ "<path>": { disabledPlugins: string[] } }`；裸数组也接受，
 * 会被规范化成 v2 记录，调用方不必写样板。
 */
export function writeMapping(file, workspaces) {
  mkdirSync(dirname(file), { recursive: true });
  const normalized = {};
  /** Protected ids the caller tried to save; dropped rather than persisted. */
  const rejected = [];
  for (const [workspace, record] of Object.entries(workspaces ?? {})) {
    const list = Array.isArray(record) ? record : Array.isArray(record?.disabledPlugins) ? record.disabledPlugins : [];
    const clean = [...new Set(list.map((id) => String(id).trim()).filter((id) => id.length > 0))]
      .filter((id) => {
        if (!isProtectedId(id)) return true;
        rejected.push({ workspace, id });
        return false;
      });
    normalized[workspace] = { disabledPlugins: clean };
  }
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  const body = JSON.stringify({ version: 2, workspaces: normalized }, null, 2) + '\n';
  writeFileSync(temporary, body, 'utf8');
  try {
    renameSync(temporary, file);
  } catch {
    rmSync(file, { force: true });
    renameSync(temporary, file);
  }
  return { file, workspaces: normalized, rejected };
}

/**
 * 黑名单里出现过的全部 id。
 *
 * 注意语义变化：v1 白名单里"出现过的 id"就是有权管理的集合；黑名单里**不在**任何
 * 列表中的 id 才是默认状态，因此这里只用于"该行是否需要被显式恢复"的判断。
 */
function blacklistIds(mapping) {
  const ids = new Set();
  for (const list of mapping.workspaces.values()) for (const id of list) ids.add(id);
  return ids;
}

/**
 * @param {object} options
 * @param {any} options.ctx                 Cordis 上下文
 * @param {string} [options.mappingPath]    覆盖默认映射文件
 * @param {(entry: any, enabled: boolean) => boolean|Promise<boolean>} [options.applyRow]
 *        测试注入点；可以同步返回 true/false，也可以返回 Promise
 * @param {(message: string) => void} [options.log] 日志出口（默认 ctx.logger.warn）
 */
export function createSingleMode(options = {}) {
  const ctx = options.ctx;
  const mappingPath = options.mappingPath ?? defaultMappingPath();
  /**
   * Where the trace goes. Host logs are hard to find — and on the desktop build the
   * console is blocked — so every line is ALSO appended to a file beside the mapping.
   * Writing never throws: a full disk must not break session handling.
   */
  const debugFile = options.debugFile ?? join(dirname(mappingPath), 'debug.log');
  const appendDebug = (line) => {
    try {
      mkdirSync(dirname(debugFile), { recursive: true });
      appendFileSync(debugFile, `${new Date().toISOString()} ${line}\n`, 'utf8');
    } catch { /* ignore */ }
  };
  /**
   * All diagnostics go through here: the host logger AND the file, exactly once.
   * A custom `log` (tests, host) is honoured in addition to the file.
   */
  const log = (message) => {
    try { ctx?.logger?.warn?.(`[${TAG}] ${message}`); } catch { /* logging must not escape */ }
    if (options.log) { try { options.log(message); } catch { /* ignore */ } }
  };
  /**
   * Verbose trace, OPT-IN (off unless asked for). Enable with any of:
   *   - `DSH_ORCH_DEBUG=1` in the environment,
   *   - `singleMode: { debug: true }` in plugin config,
   *   - `POST /workspace-orchestrator/api/scope/debug {"enabled":true}` at runtime.
   * When on, every line carries the `[single-mode DEBUG]` prefix and is appended to
   * `$DSH_HOME/workspace-orchestrator/debug.log` for easy collection.
   */
  const debugEnabled = options.debug
    ?? (typeof process !== 'undefined' && process.env?.DSH_ORCH_DEBUG === '1');
  /** Mutable so the panel can turn tracing on/off for a live host. */
  let debug = debugEnabled === true;
  const trace = (message) => {
    if (!debug) return;
    const line = `[single-mode DEBUG] ${message}`;
    try { log(line); } catch { /* ignore */ }
    // Only the trace channel writes the file; normal operation stays silent on disk.
    appendDebug(line);
  };
  /** Snapshot of an entry as the debug log reports it. */
  const describeEntry = (entry) => {
    if (!entry) return 'entry=<none>';
    const id = entry?.options?.id;
    const name = entry?.options?.name;
    const raw = entry?.options?.disabled;
    const eff = entry?.disabled;
    const uid = entry?.fiber?.uid;
    const st = entry?.fiber?.state;
    return `id=${id} name=${name} options.disabled=${JSON.stringify(raw)} `
      + `effective.disabled=${Boolean(eff)} fiber.uid=${uid ?? 'none'} fiber.state=${st ?? 'none'}`;
  };
  const applyRow = options.applyRow ?? ((entry, enabled) => defaultApplyRow(entry, enabled, trace, describeEntry));

  let status = 'idle';           // idle | active | frozen | no-mapping
  let reason = '';
  let frozen = false;
  let activeWorkspace = '';
  let switches = 0;
  let lastError = null;
  /** Rows currently disabled *because of us*, so a later workspace can restore them. */
  let blacklistedNow = new Set();
  /** The in-flight reconcile pass, so callers/tests can await what actually happened. */
  let lastRun = Promise.resolve({ changed: [], failed: [] });

  /** 找到 loader 服务。缺失时返回 undefined，绝不抛。 */
  function getLoader() {
    try { return ctx?.get?.('loader'); } catch { return undefined; }
  }

  /** 当前打开的会话工作区集合。服务缺失时返回 null（表示“无法判定”）。 */
  function openWorkspaceKeys() {
    try {
      const sessions = ctx?.get?.('sessions');
      if (!sessions || typeof sessions.list !== 'function') return null;
      const keys = new Set();
      for (const session of sessions.list()) {
        const cwd = session?.header?.cwd;
        const key = pathKey(cwd);
        if (key) keys.add(key);
      }
      return keys;
    } catch {
      return null;
    }
  }

  function entryMap(loader) {
    const map = new Map();
    try {
      for (const entry of loader.entries()) {
        const id = entry?.options?.id;
        if (typeof id === 'string') map.set(id, entry);
      }
    } catch { /* a broken tree must not escape */ }
    return map;
  }

  /**
   * 处理一次会话建立。
   * @param {any} session
   * @returns {{status: string, workspace: string, changed: string[], frozen: boolean, reason: string}}
   */
  function handleSessionCreated(session) {
    const result = { status, workspace: '', changed: [], frozen, reason: '' };
    try {
      if (frozen) {
        result.reason = 'frozen';
        return result;
      }

      const workspace = pathKey(session?.header?.cwd);
      if (!workspace) {
        status = 'idle';
        reason = 'session has no cwd';
        // Missing cwd: leave every row exactly as it is.
        return { ...result, status, reason };
      }
      result.workspace = workspace;

      // Defense 3: concurrency freeze.
      const open = openWorkspaceKeys();
      if (open && open.size > 1) {
        frozen = true;
        status = 'frozen';
        reason = `detected ${open.size} concurrent workspaces: ${[...open].join(', ')}`;
        log(`检测到并发工作区（${open.size} 个），单开模式已冻结，请使用多开隔离模式。后续切换将被忽略。`);
        return { ...result, status, frozen: true, reason };
      }

      const mapping = readMapping(mappingPath);
      if (mapping.error) {
        status = 'no-mapping';
        reason = `mapping unreadable: ${mapping.error}`;
        return { ...result, status, reason };
      }
      if (mapping.workspaces.size === 0) {
        status = 'no-mapping';
        reason = `no workspace assignment in ${mappingPath}`;
        return { ...result, status, reason };
      }

      const loader = getLoader();
      if (!loader || typeof loader.entries !== 'function') {
        status = 'no-mapping';
        reason = 'loader service unavailable';
        return { ...result, status, reason };
      }

      // Blacklisted ids for this workspace, plus whatever is still off because of us.
      const blacklistedHere = new Set(mapping.workspaces.get(workspace) ?? []);
      const managed = blacklistIds(mapping);
      // Ids we already turned off here and must put back when this workspace is done.
      for (const id of blacklistedNow) managed.add(id);

      trace(`--- session/created ---`);
      trace(`raw cwd      : ${JSON.stringify(session?.header?.cwd)}`);
      trace(`pathKey(cwd) : ${JSON.stringify(workspace)}`);
      trace(`mapping keys : ${JSON.stringify([...mapping.workspaces.keys()])}`);
      trace(`blacklist    : ${JSON.stringify([...blacklistedHere])}`);
      trace(`managed      : ${JSON.stringify([...managed])}`);
      try {
        const known = [...loader.entries()].map((e) => e?.options?.id).filter(Boolean);
        trace(`loader rows  : ${JSON.stringify(known)}`);
      } catch (error) {
        trace(`loader.entries() threw: ${String(error?.message ?? error)}`);
      }

      // Loader access is async (see reconcile): record the intent now so a synchronous
      // caller still gets an immediate answer, and let the async pass do the real work.
      activeWorkspace = workspace;
      status = 'active';
      const planned = [...managed].filter((id) => blacklistedHere.has(id));
      reason = `applying blacklist for ${workspace} (${planned.length} to disable)`;

      const pending = reconcile({ workspace, blacklistedHere, managed });
      lastRun = pending;
      return { ...result, status, reason, disabledIds: [...blacklistedHere], pending: true };
    } catch (error) {
      lastError = String(error?.message ?? error);
      return { ...result, status, reason: `error: ${lastError}` };
    }
  }

  /**
   * Apply one workspace's blacklist to the live loader.
   *
   * Why this is async and why it verifies afterwards: `Entry.update()` mutates
   * `entry.options` synchronously but the actual fiber teardown goes through
   * `loader/patch-context` and the fiber lifecycle, which settle on later ticks. Reading
   * `entry.disabled` right after the call reports the *new option*, not whether the
   * plugin's fiber actually stopped. So we await the update, then poll the entry until
   * the observed state agrees (or a deadline passes) and report the truth either way.
   *
   * @returns {Promise<{changed: string[], failed: Array<{id: string, error: string}>}>}
   */
  async function reconcile({ workspace, blacklistedHere, managed }) {
    const changed = [];
    const failed = [];
    const loader = getLoader();
    if (!loader || typeof loader.entries !== 'function') {
      try { log(`无法执行黑名单：loader 服务不可用（工作区 ${workspace}）`); } catch { /* ignore */ }
      return { changed, failed: [{ id: '(loader)', error: 'loader service unavailable' }] };
    }
    const entries = entryMap(loader);

    // Sanity: the blacklisted ids must exist in the tree at all.
    const missing = [...blacklistedHere].filter((id) => !entries.has(id));
    if (missing.length > 0) {
      try {
        log(`黑名单里有 ${missing.length} 个 id 在 loader 树中找不到：${missing.join(', ')}。`
          + `当前可用的行 id：${[...entries.keys()].join(', ') || '(空)'}`);
      } catch { /* ignore */ }
    }

    for (const id of managed) {
      const entry = entries.get(id);
      if (!entry) continue;
      // Never switch off our own row: that would take the host half (and this listener)
      // down, leaving the panel with a dead engine it cannot restart.
      if (isProtectedId(id)) {
        try { log(`跳过保护行 ${id}：禁用它会停掉编排器自身`); } catch { /* ignore */ }
        continue;
      }
      const shouldEnable = !blacklistedHere.has(id);
      const wantDisabled = !shouldEnable;
      const before = readDisabled(entry);
      trace(`[row ${id}] want=${wantDisabled ? 'DISABLED' : 'ENABLED'} BEFORE ${describeEntry(entry)}`);
      try {
        const flipped = await applyRow(entry, shouldEnable);
        trace(`[row ${id}] update() returned flipped=${flipped} AFTER-CALL ${describeEntry(entry)}`);
        // Always allow the fiber to settle before judging: `update()` resolves before the
        // teardown lands, so an immediate read reports the new *option*, not the plugin's
        // actual state. Even a "no change needed" call may be masking a real mismatch.
        // NOTE: settle() returns the observed DISABLED state, so compare against
        // wantDisabled — comparing it to shouldEnable silently inverts every verdict.
        const observedDisabled = await settle(entry, shouldEnable, STATE_TIMEOUT_MS);
        trace(`[row ${id}] settled=${observedDisabled ? 'DISABLED' : 'ENABLED'} FINAL ${describeEntry(entry)}`);
        if (flipped) changed.push(id);
        if (observedDisabled !== wantDisabled) {
          failed.push({ id, error: `state stayed ${observedDisabled ? 'disabled' : 'enabled'} (wanted ${wantDisabled ? 'disabled' : 'enabled'})` });
          try {
            log(`切换 ${id} 未生效：期望 ${wantDisabled ? '禁用' : '启用'}，`
              + `实际 ${observedDisabled ? '已禁用' : '未禁用'}（调用前 ${before ? '已禁用' : '未禁用'}）`);
          } catch { /* ignore */ }
        } else if (flipped) {
          try { log(`已${shouldEnable ? '启用' : '禁用'} ${id}（工作区 ${workspace}）`); } catch { /* ignore */ }
        }
      } catch (error) {
        // A row that cannot flip must never take the process down — but never silently.
        const message = String(error?.message ?? error);
        lastError = `${id}: ${message}`;
        failed.push({ id, error: message });
        try {
          log(`切换 ${id} 抛错：${message}（调用前状态：${before ? '已禁用' : '未禁用'}）`);
        } catch { /* ignore */ }
      }
    }

    // Remember what is off because of us, so a later workspace can restore it even if
    // the mapping file changed in between (e.g. the blacklist was emptied).
    blacklistedNow = new Set(blacklistedHere);
    if (changed.length > 0) switches += 1;
    const disabledCount = [...blacklistedHere].filter((id) => entries.has(id)).length;
    reason = failed.length > 0
      ? `blacklist for ${workspace}: ${changed.length} switched, ${failed.length} FAILED (${failed.map((f) => f.id).join(', ')})`
      : `applied blacklist for ${workspace} (${changed.length} row(s) switched, ${disabledCount} disabled)`;
    try {
      log(`工作区 ${workspace} 黑名单执行完毕：切换 ${changed.length} 行，失败 ${failed.length} 行，`
        + `应禁用 ${disabledCount} 个${failed.length ? '；' + reason : ''}`);
    } catch { /* ignore */ }
    return { changed, failed };
  }

  /** Register the `session/created` listener. Never throws, performs no IO. */
  function start() {
    try {
      if (typeof ctx?.on !== 'function') {
        status = 'idle';
        reason = 'ctx.on unavailable';
        return () => {};
      }
      ctx.on('session/created', handleSessionCreated);
      return () => {
        try { ctx?.off?.('session/created', handleSessionCreated); } catch { /* ignore */ }
      };
    } catch (error) {
      lastError = String(error?.message ?? error);
      return () => {};
    }
  }

  return {
    start,
    handleSessionCreated,
    /**
     * Re-apply the blacklist for the last seen workspace, or for an explicit path.
     * Useful after the user edits the panel mid-session: the panel can ask the host to
     * reconcile without waiting for a new session.
     * @param {string} [workspacePath]
     */
    async reconcileNow(workspacePath) {
      const mapping = readMapping(mappingPath);
      if (mapping.error) {
        trace(`reconcileNow: mapping unreadable — ${mapping.error}`);
        return { changed: [], failed: [{ id: '(mapping)', error: mapping.error }] };
      }
      const target = workspacePath ? pathKey(workspacePath) : activeWorkspace;
      trace(`--- reconcileNow ---`);
      trace(`raw cwd      : ${JSON.stringify(workspacePath ?? activeWorkspace)}`);
      trace(`pathKey(cwd) : ${JSON.stringify(target)}`);
      trace(`mapping keys : ${JSON.stringify([...mapping.workspaces.keys()])}`);
      if (!target) {
        trace(`reconcileNow: no workspace known yet`);
        return { changed: [], failed: [{ id: '(workspace)', error: 'no workspace known yet' }] };
      }
      const blacklistedHere = new Set(mapping.workspaces.get(target) ?? []);
      trace(`blacklist    : ${JSON.stringify([...blacklistedHere])}`);
      const managed = blacklistIds(mapping);
      for (const id of blacklistedNow) managed.add(id);
      activeWorkspace = target;
      status = 'active';
      lastRun = reconcile({ workspace: target, blacklistedHere, managed });
      return lastRun;
    },
    /** Await the most recent reconcile pass (tests / the API surface). */
    get lastRun() { return lastRun; },
    /** Turn the verbose `[single-mode DEBUG]` trace on or off at runtime. */
    setDebug(on) {
      debug = on === true;
      trace(`debug ${debug ? 'enabled' : 'disabled'} (mapping=${mappingPath})`);
      return debug;
    },
    get debug() { return debug; },
    get status() { return status; },
    get reason() { return reason; },
    get frozen() { return frozen; },
    get activeWorkspace() { return activeWorkspace; },
    get switches() { return switches; },
    get lastError() { return lastError; },
    get mappingPath() { return mappingPath; },
  };
}

/**
 * 默认的行切换实现：只翻 `disabled`，不碰 config，不调用任何会写盘的树级 API。
 *
 * `Entry.update()` 是 async 的（见 cordis-plugin-loader 源码）：它同步改 `options`，但
 * fiber 的卸载/重建走 `loader/patch-context` + 生命周期，要在后续 tick 才落地。
 * 这里 `await` 它，调用方再轮询真实状态。
 *
 * @returns {Promise<boolean>} 是否真的发起了切换
 */
async function defaultApplyRow(entry, enabled, trace = () => {}, describe = () => 'entry') {
  const disabledNow = entry?.disabled === true;
  const target = !enabled;
  if (disabledNow === target) {
    trace(`[applyRow] already ${target ? 'disabled' : 'enabled'}, skipping update() — ${describe(entry)}`);
    return false;
  }
  trace(`[applyRow] calling entry.update({ disabled: ${target} }) — ${describe(entry)}`);
  const started = Date.now();
  try {
    const returned = await entry.update({ disabled: target });
    trace(`[applyRow] update() resolved in ${Date.now() - started}ms (returned ${JSON.stringify(returned)}) — ${describe(entry)}`);
    return true;
  } catch (error) {
    trace(`[applyRow] update() THREW after ${Date.now() - started}ms: ${error?.message ?? error} — ${describe(entry)}`);
    throw error;
  }
}

/** 观察一个 entry 真实是否被禁用（兼容不同 loader 版本的字段形状）。 */
function readDisabled(entry) {
  if (!entry) return true;
  // `disabled` is a getter that walks parents; `options.disabled` is the raw field.
  if (typeof entry.disabled === 'boolean') return entry.disabled;
  return entry.options?.disabled === true;
}

/**
 * 轮询直到 entry 的真实状态与期望一致，或超时。
 * 卸载/重建是异步的（阶段二实测约 100–200ms），所以在返回前必须确认，不能只看 options。
 * @returns {Promise<boolean>} 最终观察到的 disabled 状态
 */
async function settle(entry, enabled, timeoutMs = 0) {
  const wantDisabled = !enabled;
  const deadline = Date.now() + timeoutMs;
  let observed = readDisabled(entry);
  while (observed !== wantDisabled && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(POLL_MS);
    observed = readDisabled(entry);
  }
  return observed;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

