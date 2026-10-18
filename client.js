/**
 * dsh-workspace-orchestrator — client half (settings section).
 *
 * Loaded by the DSH web module table as a lazy factory. React comes from the host
 * module table (`require('react')`); no bundler, no JSX, no extra dependency.
 *
 * The panel is workspace-centred: pick a workspace path at the top, then tick the
 * plugins that should be enabled in it. Ticking a box writes one row id into that
 * workspace's list in single-mode.json.
 *
 * Read + write surface:
 *   GET  /state              plugins of the running profile + the workspace mapping
 *   GET  /instances          managed isolated instances
 *   POST /toggle             flip one entry's disabled flag — memory only, no disk write
 *   POST /scope/toggle       add/remove ONE row id in a workspace's list (mapping file)
 *   POST /scope              replace a workspace's binding through the shared tool
 *   POST /instances/launch   start an isolated instance for the selected workspace
 *   POST /instances/stop     stop a managed instance
 *
 * Every destructive action asks for a second click, and every result reports a toast.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workspace-orchestrator',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/workspace-orchestrator/api'

    async function request(path, init) {
      const response = await fetch(API + path, {
        credentials: 'same-origin',
        headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
        ...init,
      })
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`Host 返回了非 JSON 响应（HTTP ${response.status}）`)
      }
      if (!response.ok || body?.ok === false) {
        throw new Error(body?.error?.message ?? body?.message ?? `HTTP ${response.status}`)
      }
      return body.value ?? body
    }

    const get = (path) => request(path)
    const post = (path, payload) => request(path, { method: 'POST', body: JSON.stringify(payload) })

    /** Swallow render failures so a bad state can never blank the whole section. */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error: error?.message ?? String(error) }
      }

      render() {
        if (this.state.error) {
          return h('div', { style: styles.error }, `面板渲染失败：${this.state.error}`)
        }
        return this.props.children
      }
    }

    // --- theme tokens -----------------------------------------------------
    // Verified against the DSH web frontend bundle (0.2.1). DSH switches theme with
    // `body[data-ds-dark-theme]` and re-defines these alias tokens, so using them makes
    // every control readable in both themes with no JS theme detection.
    // NOTE: `--dsw-alias-border` does NOT exist — an earlier version used it, so every
    // border silently fell back. The real names end in `-l1..-l4`.
    const T = {
      labelPrimary: 'var(--dsw-alias-label-primary, currentColor)',
      labelSecondary: 'var(--dsw-alias-label-secondary, #75797e)',
      surface: 'var(--dsw-alias-bg-layer-2, #2b2b2b)',
      border: 'var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
      separator: 'var(--dsw-alias-separator-primary, rgba(127,127,127,.28))',
    }

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 0' },
      header: { display: 'flex', alignItems: 'center', gap: '8px' },
      title: { fontSize: '15px', fontWeight: 600, margin: 0 },
      subtitle: { fontSize: '12px', opacity: 0.68 },
      spacer: { flex: 1 },
      card: { border: `1px solid ${T.border}`, borderRadius: '8px', overflow: 'hidden' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
      th: { textAlign: 'left', fontWeight: 500, opacity: 0.65, padding: '7px 10px', borderBottom: `1px solid ${T.separator}` },
      td: { padding: '8px 10px', borderBottom: `1px solid ${T.separator}`, verticalAlign: 'middle' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' },
      badgeOn: { display: 'inline-block', padding: '1px 8px', borderRadius: '10px', fontSize: '11px', background: 'rgba(46,160,90,.16)', color: 'rgb(46,160,90)' },
      badgeOff: { display: 'inline-block', padding: '1px 8px', borderRadius: '10px', fontSize: '11px', background: 'rgba(140,140,140,.18)', opacity: 0.85 },
      button: { cursor: 'pointer', borderRadius: '6px', border: `1px solid ${T.border}`, background: 'transparent', color: 'inherit', padding: '4px 10px', fontSize: '12px' },
      buttonDanger: { cursor: 'pointer', borderRadius: '6px', border: '1px solid rgba(200,60,60,.5)', background: 'rgba(200,60,60,.08)', color: 'rgb(200,60,60)', padding: '4px 10px', fontSize: '12px' },
      buttonPrimary: { cursor: 'pointer', borderRadius: '6px', border: '1px solid rgba(46,120,200,.55)', background: 'rgba(46,120,200,.10)', color: 'rgb(46,120,200)', padding: '4px 10px', fontSize: '12px' },
      input: { flex: 1, minWidth: '220px', padding: '5px 8px', fontSize: '12px', borderRadius: '6px', border: `1px solid ${T.border}`, background: T.surface, color: T.labelPrimary },
      confirm: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', borderRadius: '8px', background: 'rgba(200,120,40,.10)', border: '1px solid rgba(200,120,40,.45)', fontSize: '12px' },
      toast: (kind) => ({ padding: '8px 10px', borderRadius: '8px', fontSize: '12px', background: kind === 'ok' ? 'rgba(46,160,90,.12)' : 'rgba(200,60,60,.12)', border: `1px solid ${kind === 'ok' ? 'rgba(46,160,90,.45)' : 'rgba(200,60,60,.45)'}`, color: kind === 'ok' ? 'rgb(46,160,90)' : 'rgb(200,60,60)' }),
      muted: { opacity: 0.65, fontSize: '12px' },
      error: { color: 'rgb(200,60,60)', fontSize: '13px', padding: '8px 0' },
      detail: { padding: '10px 12px', background: 'rgba(127,127,127,.07)' },
      row2: { display: 'inline-flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      workspaceBar: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 12px', border: `1px solid ${T.border}`, borderRadius: '8px', background: 'rgba(127,127,127,.06)' },
      // A native <select> paints its option list with the OS/browser default surface and
      // the page's inherited text colour — on dark that is white-on-light-grey, i.e. the
      // reported bug. The background/text must therefore be set explicitly, on BOTH the
      // closed control and its <option> rows; `color-scheme` additionally drives the
      // native popup chrome and the caret in Chromium/Electron.
      select: {
        minWidth: '260px',
        maxWidth: '100%',
        padding: '5px 8px',
        fontSize: '12px',
        borderRadius: '6px',
        border: `1px solid ${T.border}`,
        background: T.surface,
        color: T.labelPrimary,
        colorScheme: 'light dark',
      },
      option: { background: T.surface, color: T.labelPrimary },
      // Native checkbox in the DSH accent colour; the browser default is unreadable on dark.
      checkbox: { width: '15px', height: '15px', margin: 0, cursor: 'pointer', accentColor: 'rgb(46,120,200)' },
      pluginRowDisabled: { opacity: 0.55 },
      chip: { display: 'inline-block', padding: '1px 7px', borderRadius: '10px', fontSize: '11px', background: 'rgba(46,120,200,.14)', color: 'rgb(46,120,200)' },
      hint: { fontSize: '12px', opacity: 0.7, lineHeight: 1.5 },
      engineAlert: {
        padding: '10px 12px',
        borderRadius: '8px',
        fontSize: '12px',
        lineHeight: 1.6,
        background: 'rgba(200,60,60,.12)',
        border: '1px solid rgba(200,60,60,.5)',
        color: 'rgb(200,60,60)',
      },
      refreshHint: {
        padding: '10px 12px',
        borderRadius: '8px',
        fontSize: '12px',
        lineHeight: 1.6,
        background: 'rgba(46,120,200,.10)',
        border: '1px solid rgba(46,120,200,.45)',
        color: 'rgb(46,120,200)',
      },
    }

    /** Inline mark: the settings slot has no icon field, so the panel draws its own. */
    function Mark() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', 'aria-hidden': true, style: { flex: '0 0 auto' } },
        h('rect', { x: 3, y: 4, width: 7, height: 7, rx: 1.5, fill: 'currentColor', opacity: 0.85 }),
        h('rect', { x: 14, y: 4, width: 7, height: 7, rx: 1.5, fill: 'currentColor', opacity: 0.45 }),
        h('rect', { x: 3, y: 14, width: 7, height: 7, rx: 1.5, fill: 'currentColor', opacity: 0.45 }),
        h('rect', { x: 14, y: 14, width: 7, height: 7, rx: 1.5, fill: 'currentColor', opacity: 0.85 }))
    }

    function Toast({ toast }) {
      if (!toast) return null
      return h('div', { style: styles.toast(toast.kind), role: 'status' }, toast.text)
    }

    function ConfirmBar({ confirm: pending, busy, onCancel, onConfirm }) {
      if (!pending) return null
      const what = pending.kind === 'toggle'
        ? `${pending.next ? '启用' : '禁用'}插件「${pending.name}」`
        : `关闭实例「${pending.name}」`
      return h('div', { style: styles.confirm, role: 'alertdialog' },
        h('span', null, `确认${what}？${pending.kind === 'toggle' ? '（仅本次运行生效，重启后恢复）' : '（会终止该实例的进程）'}`),
        h('span', { style: styles.spacer }),
        h('button', { type: 'button', style: styles.buttonDanger, disabled: busy, onClick: onConfirm }, busy ? '执行中…' : '确认'),
        h('button', { type: 'button', style: styles.button, disabled: busy, onClick: onCancel }, '取消'))
    }

    function Instances({ data, busy, onAsk }) {
      const rows = data?.instances ?? []
      return h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
          h('strong', { style: { fontSize: '13px' } }, '隔离实例'),
          h('span', { style: styles.muted }, `${data?.count ?? 0} 个登记 / ${data?.live ?? 0} 个存活`)),
        rows.length === 0
          ? h('div', { style: styles.muted }, '当前没有由本管理器拉起的实例。')
          : h('div', { style: styles.card },
            h('table', { style: styles.table },
              h('thead', null, h('tr', null,
                h('th', { style: styles.th }, 'profile'),
                h('th', { style: styles.th }, 'pid'),
                h('th', { style: styles.th }, '工作区'),
                h('th', { style: styles.th }, '状态'),
                h('th', { style: styles.th }, '操作'))),
              h('tbody', null, rows.map((row) => h('tr', { key: row.profileName ?? row.pid },
                h('td', { style: { ...styles.td, ...styles.mono } }, row.profileName ?? '—'),
                h('td', { style: { ...styles.td, ...styles.mono } }, String(row.pid ?? '—')),
                h('td', { style: { ...styles.td, ...styles.mono } }, row.workspacePath ?? '—'),
                h('td', { style: styles.td },
                  h('span', { style: row.alive ? styles.badgeOn : styles.badgeOff }, row.alive ? '运行中' : '已停止')),
                h('td', { style: styles.td },
                  h('button', {
                    type: 'button',
                    style: styles.buttonDanger,
                    disabled: Boolean(busy) || !row.alive,
                    onClick: () => onAsk({ kind: 'stop', id: row.profileName, name: row.profileName }),
                  }, busy ? '处理中…' : '关闭'))))))))
    }

    /**
     * Workspace dropdown fed by the DSH sidebar list, with a manual-input escape hatch.
     * Workspaces that exist only in the mapping file are appended so a binding is never
     * hidden just because the directory is no longer in the sidebar.
     */
    function WorkspacePicker({ sidebar, bound, activePath, customPath, onPick, onCustom, onApplyCustom }) {
      const [manual, setManual] = React.useState(false)
      const sidebarList = Array.isArray(sidebar?.workspaces) ? sidebar.workspaces : []
      // Identity must match the host's pathKey: separators and case both ignored, or the
      // same workspace appears twice (sidebar "D:\x" vs mapping "D:/x").
      const keyOf = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

      // Sidebar first (it is the user's own list), then bindings the sidebar does not know.
      // `count` is the number of plugins that workspace blacklists.
      const countOf = (record) => (record?.disabledIds ?? record?.ids ?? []).length
      const options = []
      const seen = new Set()
      for (const row of sidebarList) {
        const key = keyOf(row.path)
        if (seen.has(key)) continue
        seen.add(key)
        const match = (bound ?? []).find((b) => keyOf(b.path) === key)
        options.push({ path: row.path, label: row.title || row.path, count: countOf(match), fromSidebar: true })
      }
      for (const row of bound ?? []) {
        const key = keyOf(row.path)
        if (seen.has(key)) continue
        seen.add(key)
        options.push({ path: row.path, label: row.path.split(/[\\/]/).filter(Boolean).pop() || row.path, count: countOf(row), fromSidebar: false })
      }

      const sidebarError = sidebar?.error
      const nothing = options.length === 0

      const select = h('select', {
        style: manual ? { ...styles.select, opacity: 0.6, cursor: 'not-allowed' } : styles.select,
        value: manual ? '' : activePath,
        disabled: manual,
        'aria-label': '选择工作区',
        onChange: (event) => {
          if (event.target.value) onPick(event.target.value)
        },
      },
        nothing && !manual
          ? h('option', { value: '', style: styles.option }, '（DSH 里还没有工作区）')
          : h('option', { value: '', style: styles.option }, '— 选择工作区 —'),
        options.map((row) => h('option', { key: row.path, value: row.path, style: styles.option },
          `${row.label}${row.fromSidebar ? '' : '（仅绑定，不在侧栏）'}${row.count > 0 ? ` · 已禁用 ${row.count}` : ''}`)))

      const manualRow = manual
        ? h('div', { style: styles.row2 },
            h('input', {
              style: styles.input,
              placeholder: '输入工作区路径，例如 D:\\workspace\\my-project',
              value: customPath,
              autoFocus: true,
              onChange: (event) => onCustom(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') onApplyCustom() },
            }),
            h('button', {
              type: 'button',
              style: styles.buttonPrimary,
              disabled: !customPath.trim(),
              onClick: onApplyCustom,
            }, '使用此路径'),
            h('button', {
              type: 'button',
              style: styles.button,
              onClick: () => { setManual(false); onCustom('') },
            }, '取消'))
        : null

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { style: styles.row2 },
          select,
          h('button', {
            type: 'button',
            style: styles.button,
            onClick: () => setManual((value) => !value),
            title: '添加一个还没在 DSH 里创建过的新目录',
          }, manual ? '用下拉框选择' : '手动输入'),
          sidebar?.available
            ? h('span', { style: styles.muted }, `来自 DSH 侧栏 ${sidebarList.length} 个工作区`)
            : h('span', { style: styles.muted }, '未读到 DSH 工作区列表，请用手动输入')),
        sidebarError ? h('div', { style: styles.muted }, `工作区列表读取失败：${sidebarError}`) : null,
        manualRow)
    }

    function Panel() {
      const [view, setView] = React.useState({ status: 'loading', data: null, error: null })
      const [instances, setInstances] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [pending, setPending] = React.useState(null)
      const [toast, setToast] = React.useState(null)
      // '' means "not chosen yet"; the panel opens on the first known workspace.
      const [selected, setSelected] = React.useState('')
      const [customPath, setCustomPath] = React.useState('')
      const [launching, setLaunching] = React.useState(false)

      const notify = (kind, text) => {
        setToast({ kind, text })
        setTimeout(() => setToast(null), 4000)
      }

      const refresh = () => {
        get('/state').then(
          (data) => setView({ status: 'ready', data, error: null }),
          (error) => setView({ status: 'error', data: null, error: error?.message ?? String(error) }),
        )
        get('/instances').then(setInstances, () => setInstances(null))
      }

      React.useEffect(() => { refresh() }, [])

      const runConfirmed = async () => {
        const action = pending
        if (!action) return
        setBusy(action.id)
        try {
          if (action.kind === 'toggle') {
            const result = await post('/toggle', { id: action.id, enabled: action.next })
            notify('ok', `${action.name} 已${result.enabled ? '启用' : '禁用'}（仅本次运行）`)
          } else {
            await post('/instances/stop', { target: action.id })
            notify('ok', `实例 ${action.name} 已关闭`)
          }
          setPending(null)
          refresh()
        } catch (error) {
          notify('err', `操作失败：${error?.message ?? error}`)
        } finally {
          setBusy(null)
        }
      }

      const data = view.data ?? {}
      const plugins = Array.isArray(data.plugins) ? data.plugins : []
      const scope = data.scope ?? {}
      const workspaces = Array.isArray(scope.workspaces) ? scope.workspaces : []
      const sidebar = data.sidebar ?? null
      // Health of the blacklist engine. Surfaced as a banner so a dead engine is visible
      // here instead of only as a one-line error toast after a click.
      const engine = data.singleMode ?? null
      const engineBroken = Boolean(engine) && engine.running === false

      // Default selection: the first sidebar workspace, else the first existing binding.
      const sidebarFirst = Array.isArray(sidebar?.workspaces) && sidebar.workspaces[0]
        ? sidebar.workspaces[0].path
        : ''
      const activePath = selected || customPath.trim() || sidebarFirst || workspaces[0]?.path || ''
      // Same identity rule as the host (pathKey): case- and separator-insensitive on Windows.
      const norm = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      const activeKey = norm(activePath)
      const activeEntry = workspaces.find((row) => norm(row.path) === activeKey)
      // BLACKLIST: the ids this workspace must NOT run. Everything else is on by default,
      // so a ticked box means "enabled here" simply because it is absent from the list.
      const blacklistIds = new Set(activeEntry?.disabledIds ?? activeEntry?.ids ?? [])
      const migrated = Array.isArray(scope.migrated) ? scope.migrated : []

      /**
       * Tick/untick one plugin for the selected workspace.
       * `next === false` (untick) adds to the blacklist; `next === true` removes it.
       */
      const togglePlugin = async (plugin, next) => {
        if (!plugin.id) {
          notify('err', `${plugin.name} 没有 loader 行 id，无法加入工作区黑名单`)
          return
        }
        if (!activePath) {
          notify('err', '请先选择一个工作区')
          return
        }
        setBusy(plugin.id)
        try {
          const result = await post('/scope/toggle', {
            workspacePath: activePath,
            id: plugin.id,
            enabled: next,
            ...(typeof scope.mappingPath === 'string' ? { mappingPath: scope.mappingPath } : {}),
          })
          // Report what the live loader actually did, not just what we wrote to disk.
          const failed = result?.applied?.failed ?? []
          if (failed.length > 0) {
            notify('err', `${plugin.name} 已写入黑名单，但运行时切换失败：`
              + failed.map((f) => `${f.id}（${f.error}）`).join('；'))
          } else if (result?.changed === false) {
            notify('ok', next
              ? `${plugin.name} 本就不在黑名单里（无改动）`
              : `${plugin.name} 已在该工作区的黑名单里（无改动）`)
          } else if (next) {
            notify('ok', `${plugin.name} 已从当前工作区的禁用黑名单移除，已恢复启用`)
          } else {
            notify('ok', `${plugin.name} 已加入当前工作区的禁用黑名单`)
          }
          refresh()
        } catch (error) {
          notify('err', `写入失败：${error?.message ?? error}`)
        } finally {
          setBusy(null)
        }
      }

      const launchHere = async () => {
        if (!activePath) { notify('err', '请先选择或输入一个工作区路径'); return }
        setLaunching(true)
        try {
          const result = await post('/instances/launch', { workspacePath: activePath })
          notify('ok', `已在 ${activePath} 启动隔离实例${result?.url ? `：${result.url}` : ''}`)
          refresh()
        } catch (error) {
          notify('err', `启动失败：${error?.message ?? error}`)
        } finally {
          setLaunching(false)
        }
      }

      if (view.status === 'loading') {
        return h('div', { style: styles.root }, 'Hello Workspace Orchestrator 加载中…')
      }
      if (view.status === 'error') {
        return h('div', { style: styles.root },
          h('div', { style: styles.header }, h(Mark), h('h3', { style: styles.title }, '工作区编排')),
          h('div', { style: styles.error }, `无法读取宿主数据：${view.error}`),
          h('div', { style: styles.muted }, '请确认插件已随 profile 重启，且运行在 web 界面上。'))
      }

      const enabled = plugins.filter((row) => row.enabled).length
      const checkedCount = plugins.filter((row) => row.id && !blacklistIds.has(row.id)).length

      // ---- workspace selector ------------------------------------------------
      // One dropdown fed by the DSH sidebar list; workspaces that only exist in the
      // mapping file are kept too, so a binding is never hidden by the sidebar.
      const picker = h(WorkspacePicker, {
        sidebar,
        bound: workspaces,
        activePath,
        customPath,
        onPick: (path) => { setSelected(path); setCustomPath('') },
        onCustom: (value) => { setCustomPath(value); setSelected('') },
        onApplyCustom: () => {
          if (!customPath.trim()) return
          notify('ok', `已切换到 ${customPath.trim()}，勾选插件即可写入`)
        },
      })

      const workspaceBar = h('div', { style: styles.workspaceBar },
        h('div', { style: styles.row2 },
          h('strong', { style: { fontSize: '13px' } }, '工作区')),
        picker,
        activePath
          ? h('div', { style: styles.hint },
              h('span', null, '当前工作区：'),
              h('code', { style: styles.mono }, activePath),
              activeEntry ? h('span', { style: styles.chip }, `禁用 ${activeEntry.disabledIds?.length ?? 0} 个`) : h('span', { style: styles.muted }, '（尚未写入，取消勾选插件后自动创建）'))
          : h('div', { style: styles.hint }, '从下拉框选择一个工作区，或用「手动输入」添加一个 DSH 里还没有的目录。'),
        h('div', { style: styles.row2 },
          h('button', {
            type: 'button',
            style: styles.buttonPrimary,
            disabled: launching || !activePath,
            onClick: launchHere,
          }, launching ? '启动中…' : '在此工作区开启隔离实例'),
          h('span', { style: styles.muted }, '多开模式：独立 profile、隔离会话与存储')))
      // ---- plugin checklist ---------------------------------------------------
      const rows = plugins.map((plugin) => {
        const key = plugin.id ?? plugin.name ?? String(Math.random())
        // Blacklist semantics: ticked = not in this workspace's blacklist = enabled here.
        const blacklisted = Boolean(plugin.id) && blacklistIds.has(plugin.id)
        const checked = Boolean(plugin.id) && !blacklisted
        const rowBusy = busy === plugin.id
        // An id-less row (bundle-contributed, unresolved package) cannot be blacklisted.
        const disabled = !plugin.id || rowBusy || !activePath
        return h('tr', { key, style: plugin.id ? undefined : styles.pluginRowDisabled },
          h('td', { style: styles.td },
            h('input', {
              type: 'checkbox',
              style: { ...styles.checkbox, cursor: disabled ? 'not-allowed' : 'pointer' },
              checked,
              disabled,
              title: blacklisted ? '已在此工作区禁用（取消勾选状态）' : '在此工作区启用',
              'aria-label': `在此工作区启用 ${plugin.name}`,
              onChange: (event) => togglePlugin(plugin, event.target.checked),
            })),
          h('td', { style: styles.td }, plugin.name ?? '(unknown)'),
          h('td', { style: { ...styles.td, ...styles.mono } }, plugin.version ?? '—'),
          h('td', { style: { ...styles.td, ...styles.mono } }, plugin.id ?? '—'),
          h('td', { style: styles.td },
            !plugin.id
              ? h('span', { style: styles.badgeOff, title: '没有 loader 行 id，无法加入黑名单' }, '无行 id')
              : blacklisted
                ? h('span', { style: styles.badgeOff, title: '进入该工作区时会被强制禁用' }, '已在本工作区禁用')
                : h('span', { style: plugin.enabled ? styles.badgeOn : styles.badgeOff },
                    plugin.enabled ? '运行时已启用' : '运行时已禁用')))
      })

      return h('div', { style: styles.root },
        h('div', { style: styles.header },
          h(Mark),
          h('h3', { style: styles.title }, '工作区编排'),
          h('span', { style: styles.subtitle }, `第三方插件 ${plugins.length} 个（运行时启用 ${enabled}）`),
          h('span', { style: styles.spacer }),
          h('button', { type: 'button', style: styles.button, onClick: refresh }, '刷新')),
        data.profileDir ? h('div', { style: styles.muted }, `profile: ${data.profileDir}`) : null,
        h(Toast, { toast }),
        engineBroken
          ? h('div', { style: styles.engineAlert, role: 'alert' },
              h('b', null, '⚠ 黑名单引擎未运行'),
              h('div', { style: { marginTop: '4px' } },
                `原因：${engine.error || engine.reason || '未知'}`),
              engine.reason && engine.error ? h('div', { style: { marginTop: '2px' } }, `状态：${engine.reason}`) : null,
              engine.mappingPath ? h('div', { style: { ...styles.mono, marginTop: '2px' } }, `映射文件：${engine.mappingPath}`) : null,
              h('div', { style: { marginTop: '4px' } },
                '勾选仍会写入 single-mode.json，但在引擎恢复前不会影响运行时。'
                + '请重启 DSH；若重启后仍报此错，把上面这段原因发给开发者。'))
          : null,
        // Backend disabling cannot unload a dual-end plugin's page UI: its client bundle
        // is already running in this browser tab. Say so, rather than letting the user
        // conclude the feature failed.
        Boolean(engine) && engine.running === true && blacklistIds.size > 0
          ? h('div', { style: styles.refreshHint },
              h('b', null, `后端已卸载本工作区禁用的 ${blacklistIds.size} 个插件`),
              h('div', { style: { marginTop: '4px' } },
                '带界面的双端插件（如 dsh-webds-bridge）其页面入口仍留在当前标签页里，'
                + '按 Ctrl+Shift+R 刷新后可见它消失。想核实后端状态，对我说「调用 debug_single_mode」。'))
          : null,
        h(ConfirmBar, {
          confirm: pending,
          busy: Boolean(busy),
          onCancel: () => setPending(null),
          onConfirm: runConfirmed,
        }),
        workspaceBar,
        !activePath
          ? h('div', { style: styles.muted }, '选好工作区后，这里会列出可以勾选的插件。')
          : plugins.length === 0
            ? h('div', { style: styles.muted }, '当前 profile 没有第三方插件。')
            : h('div', null,
              h('div', { style: { ...styles.hint, marginBottom: '6px' } },
                `勾选 = 在此工作区启用；取消勾选 = 加入该工作区的禁用黑名单。`
                + `当前已启用 ${checkedCount} / ${plugins.length}，黑名单 ${blacklistIds.size} 个。`
                + `写入 single-mode.json（会落盘），与 Agent 调用 manage_workspace_scope 等价。`),
              migrated.length > 0
                ? h('div', { style: { ...styles.hint, color: 'rgb(200,140,40)' } },
                    `注意：检测到旧版白名单格式的工作区（${migrated.join('、')}），已按“全部启用”处理。`
                    + `如需限制，请在本面板重新取消勾选要禁用的插件。`)
                : null,
              h('div', { style: styles.card },
                h('table', { style: styles.table },
                  h('thead', null, h('tr', null,
                    h('th', { style: styles.th }, '在此工作区启用'),
                    h('th', { style: styles.th }, '插件'),
                    h('th', { style: styles.th }, '版本'),
                    h('th', { style: styles.th }, '行 id'),
                    h('th', { style: styles.th }, '运行状态'))),
                  h('tbody', null, rows)))),
        h(Instances, { data: instances, busy, onAsk: setPending }),
        scope.error ? h('div', { style: styles.muted }, `映射文件读取失败：${scope.error}`) : null,
        data.diagnostics && data.diagnostics.length > 0
          ? h('div', { style: styles.muted }, `诊断：${data.diagnostics.join('；')}`)
          : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'workspace-orchestrator',
          order: 46,
          label: () => '工作区编排',
        }, () => h(Boundary, null, h(Panel)))), 'workspace-orchestrator: settings section')
      },
    }
  },
})
