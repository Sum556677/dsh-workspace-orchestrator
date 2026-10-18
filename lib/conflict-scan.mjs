/**
 * 冲突静态扫描（子插件 A）
 *
 * 纯静态：只读配置与插件包源码文本，**从不执行插件代码**。
 * 能确定的就报，不能确定的进 `notes`，绝不猜。
 *
 * 检测项：
 *   error   duplicate-entry-id     同一 loader entry id 出现多次
 *   error   duplicate-plugin-name  同一个包被插入成多条行（不同 id）
 *   error   duplicate-service      两个插件 provide 同名 service
 *   error   dependency-cycle       service 依赖成环
 *   warning missing-dependency     inject 的服务无人提供
 *
 * 依赖图：节点是 loader 行；边是「行 A inject 服务 S → 提供 S 的行 B」。
 * 服务提供关系来自插件包源码的静态特征（`super(ctx, "svc")` / `provide("svc")`），
 * inject 来自 `static inject = [...]`。读不到源码的包只记 note，不参与判定。
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const INJECT_ARRAY = /(?:\bstatic\s+)?\binject\s*(?::\s*[^=]+)?=\s*\[([^\]]*)\]/g;
const INJECT_SINGLE = /(?:\bstatic\s+)?\binject\s*(?::\s*[^=]+)?=\s*['"]([A-Za-z0-9_.:-]+)['"]/g;
const PROVIDE_SUPER = /\bsuper\s*\(\s*ctx\s*,\s*['"]([A-Za-z0-9_.:-]+)['"]/g;
const PROVIDE_CALL = /\bprovide\s*\(\s*['"]([A-Za-z0-9_.:-]+)['"]/g;
const STRING_LITERAL = /['"]([A-Za-z0-9_.:-]+)['"]/g;

/**
 * Framework services provided by DSH itself (not by a row in the profile).
 * Injecting one of these is normal and must never be reported as missing.
 */
export const CORE_SERVICES = new Set([
  'loader', 'config', 'tools', 'sessions', 'systemPrompt', 'connection', 'credentials', 'agent', 'typert',
  'hmr', 'profileContext', 'configEditor', 'settings', 'storage', 'llm', 'jobs', 'permission',
  'approval', 'sandbox', 'attachments', 'agentPresets', 'logger', 'reflect', 'registry', 'events',
]);

/** 从源码文本里抽出 inject / provide 名单（纯文本，不执行）。 */
export function extractFacts(source) {
  const inject = new Set();
  const provides = new Set();
  const text = String(source ?? '');

  for (const match of text.matchAll(INJECT_ARRAY)) {
    for (const literal of match[1].matchAll(STRING_LITERAL)) inject.add(literal[1]);
  }
  for (const match of text.matchAll(INJECT_SINGLE)) inject.add(match[1]);
  for (const match of text.matchAll(PROVIDE_SUPER)) provides.add(match[1]);
  for (const match of text.matchAll(PROVIDE_CALL)) provides.add(match[1]);

  return { inject: [...inject], provides: [...provides] };
}

/** 定位一个包在 profile 里的入口文件，读文本。失败返回 undefined（不抛）。 */
function readPackageSource(profileDir, packageName) {
  if (!packageName || packageName.startsWith('.') || packageName.startsWith('file:')) return undefined;
  try {
    const dir = join(profileDir, 'node_modules', ...packageName.split('/'));
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) return undefined;
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    const main = typeof parsed.main === 'string' ? parsed.main : 'index.js';
    const entry = join(dir, main);
    if (!existsSync(entry)) return undefined;
    return { source: readFileSync(entry, 'utf8'), dir };
  } catch {
    // Fall through to module resolution: official packages live in the install's
    // node_modules (inside app.asar), which Electron's fs can read but plain Node cannot.
  }
  try {
    const require = createRequire(join(profileDir || process.cwd(), 'package.json'));
    const entry = require.resolve(packageName);
    return { source: readFileSync(entry, 'utf8'), dir: dirname(entry) };
  } catch {
    return undefined;
  }
}

/**
 * 为每一行收集静态事实。
 * @returns {{facts: Map<string, {inject: string[], provides: string[]}>, unread: string[]}}
 */
export function collectFacts(profileDir, rows) {
  const facts = new Map();
  const unread = [];
  for (const row of rows) {
    if (row.disabled === true) continue;
    const found = readPackageSource(profileDir, row.name);
    if (!found) {
      unread.push(row.name ?? row.id ?? '(unknown)');
      continue;
    }
    facts.set(row.id, extractFacts(found.source));
  }
  return { facts, unread };
}

/**
 * 分析冲突。
 * @param {object} input
 * @param {{id: string, name: string|null, disabled?: boolean, inject?: string[]}[]} input.rows
 * @param {Map<string, {inject: string[], provides: string[]}>} [input.facts]
 * @param {string[]} [input.unread] 读不到源码的包（只记 note）
 */
export function analyzeConflicts({ rows = [], facts = new Map(), unread = [], profileDir = '' } = {}) {
  const errors = [];
  const warnings = [];
  const notes = [];

  // Only enabled rows participate; a disabled row cannot conflict at runtime.
  const active = rows.filter((row) => row.disabled !== true);

  // --- duplicate entry id -------------------------------------------------
  const byId = new Map();
  for (const row of active) {
    if (typeof row.id !== 'string' || row.id.length === 0) continue;
    if (!byId.has(row.id)) byId.set(row.id, []);
    byId.get(row.id).push(row);
  }
  for (const [id, group] of byId) {
    if (group.length > 1) {
      errors.push({ code: 'duplicate-entry-id', severity: 'error', id, count: group.length, message: `loader entry id "${id}" 出现 ${group.length} 次` });
    }
  }

  // --- duplicate plugin name ---------------------------------------------
  // Official packages are legitimately mounted several times (one agent-preset
  // instance per preset, for example), so only third-party repeats are suspicious.
  const byName = new Map();
  for (const row of active) {
    if (typeof row.name !== 'string' || row.name.length === 0) continue;
    if (row.name.startsWith('@deepseek-ai/') || row.name.startsWith('cordis:')) continue;
    if (!byName.has(row.name)) byName.set(row.name, []);
    byName.get(row.name).push(row);
  }
  for (const [name, group] of byName) {
    const ids = [...new Set(group.map((row) => row.id).filter(Boolean))];
    if (ids.length > 1) {
      errors.push({ code: 'duplicate-plugin-name', severity: 'error', name, ids, message: `插件 "${name}" 被插入成 ${ids.length} 条行，很可能是重复注册` });
    }
  }

  // --- providers ----------------------------------------------------------
  const providers = new Map();   // service -> [rowId]
  const injects = new Map();     // rowId -> services
  for (const row of active) {
    const fact = facts.get(row.id);
    if (!fact) continue;
    for (const service of fact.provides) {
      if (!providers.has(service)) providers.set(service, []);
      providers.get(service).push(row.id);
    }
    injects.set(row.id, fact.inject);
  }
  // Config-declared inject contributes too (a row may declare deps without readable source).
  for (const row of active) {
    if (Array.isArray(row.inject) && row.inject.length > 0) {
      const existing = new Set(injects.get(row.id) ?? []);
      for (const service of row.inject) existing.add(service);
      injects.set(row.id, [...existing]);
    }
  }

  for (const [service, owners] of providers) {
    const distinct = [...new Set(owners)];
    if (distinct.length > 1) {
      errors.push({ code: 'duplicate-service', severity: 'error', service, providers: distinct, message: `service "${service}" 被 ${distinct.length} 个插件同时提供` });
    }
  }

  // --- missing dependency -------------------------------------------------
  // Only meaningful with decent coverage: with no facts we cannot tell "missing"
  // from "the provider simply was not readable".
  const coverage = active.length === 0 ? 0 : facts.size / active.length;
  if (coverage >= 0.5) {
    for (const [rowId, services] of injects) {
      for (const service of services) {
        if (providers.has(service) || CORE_SERVICES.has(service)) continue;
        warnings.push({ code: 'missing-dependency', severity: 'warning', id: rowId, service, message: `插件 "${rowId}" inject 了 service "${service}"，但没有任何可读的插件提供它` });
      }
    }
  } else if (injects.size > 0) {
    notes.push({
      code: 'low-coverage',
      coverage: Number(coverage.toFixed(2)),
      message: `只有 ${Math.round(coverage * 100)}% 的插件能读到源码，本次不报告"缺失依赖"（无法区分"真的缺"与"提供者读不到"）。`,
    });
  }

  // --- cycles -------------------------------------------------------------
  const edges = new Map();  // rowId -> Set<rowId>
  for (const [rowId, services] of injects) {
    const targets = new Set();
    for (const service of services) for (const owner of providers.get(service) ?? []) targets.add(owner);
    edges.set(rowId, targets);
  }
  const cycles = [];
  const state = new Map(); // 0 unvisited, 1 visiting, 2 done
  const stack = [];
  const visit = (node) => {
    state.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (state.get(next) === 1) {
        const at = stack.indexOf(next);
        cycles.push([...stack.slice(at), next]);
      } else if (!state.get(next)) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const node of edges.keys()) if (!state.get(node)) visit(node);
  for (const cycle of cycles) {
    errors.push({ code: 'dependency-cycle', severity: 'error', cycle, message: `service 依赖成环：${cycle.join(' -> ')}` });
  }

  // --- what we cannot know statically -------------------------------------
  notes.push({
    code: 'tool-names-unknown',
    message: '工具名只能在插件加载后得知（静态无法读取注册调用的实参），重复 tool 名留给运行时检查。',
  });
  if (unread.length > 0) {
    notes.push({
      code: 'facts-unreadable',
      count: unread.length,
      packages: unread.slice(0, 20),
      message: `${unread.length} 个插件包读不到源码（未安装在 ${profileDir || 'profile'} 或位于 asar 内），它们的 inject/provide 未纳入判定。`,
    });
  }
  if (facts.size === 0) {
    notes.push({
      code: 'no-facts',
      message: '没有任何插件的源码事实可用，本次只能检查重复 id / 重复包名。',
    });
  }

  return {
    profileDir,
    rowsScanned: active.length,
    errors,
    warnings,
    notes,
    ok: errors.length === 0,
  };
}

/**
 * 解析 `--dump-config` 输出的顶层行，额外保留 inject。
 * 只认列 0 的行与它的 2 空格字段；更深的缩进是插件配置（如模型清单）。
 */
export function parseRows(text) {
  const rows = [];
  let current = undefined;
  let inInject = false;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const idMatch = /^- id:\s*(.+)$/.exec(raw);
    if (idMatch) {
      current = { id: unquote(idMatch[1]), name: null, disabled: false, inject: [] };
      rows.push(current);
      inInject = false;
      continue;
    }
    if (!current) continue;
    const field = /^ {2}(name|disabled|inject):\s*(.*)$/.exec(raw);
    if (field) {
      inInject = false;
      if (field[1] === 'name') current.name = unquote(field[2]);
      else if (field[1] === 'disabled') current.disabled = field[2].trim() === 'true';
      else if (field[1] === 'inject') {
        const inline = field[2].trim();
        if (inline.startsWith('[')) {
          current.inject = [...inline.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
        } else {
          inInject = true;
        }
      }
      continue;
    }
    if (inInject) {
      const item = /^ {4}- (?:name:\s*)?(.+)$/.exec(raw);
      if (item) current.inject.push(unquote(item[1]));
      else inInject = false;
    }
  }
  return rows;
}

function unquote(value) {
  const text = String(value).trim();
  if (text.length >= 2 && ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"')))) {
    return text.slice(1, -1);
  }
  return text;
}

