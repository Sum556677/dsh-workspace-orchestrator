/**
 * A deliberately tiny reader for `cordis.patch.yml`.
 *
 * Why not a real YAML library: this plugin must stay free of third-party runtime
 * dependencies, and Node ships no YAML parser. The patch layer has a small, stable shape,
 * so this reader implements exactly that shape and reports anything it does not understand
 * instead of guessing.
 *
 * Supported:
 *   - a top-level sequence of patch entries (`- id: ...`)
 *   - a plain top-level mapping (one row, accumulated)
 *   - `- insert:` followed by a nested sequence of loader-entry rows
 *   - `id` / `name` / `disabled` / `group` / `inject` / `scope` scalars
 *   - `!!js` expressions, preserved verbatim and flagged `$js` (never evaluated)
 *
 * `config:` blocks are **skipped whole**, at any depth. This is deliberate and load-bearing:
 * a row's config is arbitrary deployment data — the desktop profile's `llm-pi-ai` row holds
 * a ~230-line nested provider map with its own `id`/`name` pairs — and nothing this plugin
 * needs lives inside one. Skipping keeps a `name:` buried in config from ever being read as
 * a loader entry's module specifier. Because the block is skipped, flow collections inside
 * it are never mis-parsed either.
 *
 * NOT supported elsewhere, reported as diagnostics rather than silently dropped: flow
 * collections (`[a, b]`, `{a: b}`), block scalars (`|`, `>`), anchors/aliases (`&`, `*`),
 * and multi-document markers (`---`).
 */

/** Keys whose scalar value this plugin cares about. */
const SHALLOW_KEYS = new Set(['id', 'name', 'disabled', 'group', 'inject', 'scope', 'insert']);

/** Strip a trailing `#` comment that is not inside quotes. */
function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i);
  }
  return text;
}

/**
 * Parse one scalar.
 * @param {string} raw
 * @returns {{value?: any, js?: string, conditional: boolean, unsupported?: string}}
 */
function parseScalar(raw) {
  const text = raw.trim();

  if (text.startsWith('!!js')) {
    let expr = text.slice(4).trim();
    if ((expr.startsWith("'") && expr.endsWith("'")) || (expr.startsWith('"') && expr.endsWith('"'))) {
      expr = expr.slice(1, -1).replace(/''/g, "'");
    }
    return { js: expr, conditional: true };
  }

  if (text === '' || text === '~' || text === 'null') return { value: null, conditional: false };
  if (text === 'true') return { value: true, conditional: false };
  if (text === 'false') return { value: false, conditional: false };
  if (/^-?\d+$/.test(text)) return { value: Number(text), conditional: false };
  if (text.startsWith("'")) {
    return { value: text.replace(/^'/, '').replace(/'$/, '').replace(/''/g, "'"), conditional: false };
  }
  if (text.startsWith('"')) {
    return { value: text.replace(/^"/, '').replace(/"$/, '').replace(/\\"/g, '"'), conditional: false };
  }
  if (text.startsWith('[') || text.startsWith('{') || text.startsWith('|') || text.startsWith('>')) {
    return { value: text, conditional: false, unsupported: 'flow/block collection' };
  }
  if (text.startsWith('&') || text.startsWith('*')) {
    return { value: text, conditional: false, unsupported: 'anchor/alias' };
  }

  return { value: text, conditional: false };
}

/** Assign a parsed scalar onto a target object, tagging `!!js` expressions. */
function assign(target, key, parsed, diagnostics, lineNo) {
  if (parsed.unsupported) diagnostics.push(`line ${lineNo}: ${parsed.unsupported} is not supported`);
  if (parsed.js !== undefined) {
    target[key] = { $js: parsed.js };
    target.$conditional = true;
  } else {
    target[key] = parsed.value;
  }
}

/**
 * Parse a patch document into a flat list of patch entries.
 *
 * Each returned entry is the shallow mapping of one patch row. `insert` rows are expanded:
 * a row carrying `insert` lists each child loader entry as its own returned object with
 * `$fromInsert: true`.
 *
 * @param {string} text raw YAML
 * @returns {{entries: Array<Record<string, any>>, diagnostics: string[]}}
 */
export function parsePatchYaml(text) {
  const diagnostics = [];
  const topEntries = [];
  const lines = String(text ?? '').split(/\r?\n/);

  /** @type {Array<{kind: string, indent: number, obj?: any, key?: string, closed?: boolean}>} */
  let frames = [];

  const popTo = (indent) => {
    while (frames.length > 0 && frames[frames.length - 1].indent >= indent) frames.pop();
  };

  /**
   * The nearest open object that can receive a mapping key.
   *
   * Containers keyed by something this plugin does not read (`config:`, `providers:`,
   * `scope:`) are *opaque*: nothing nested inside them may overwrite a row-level field.
   * Without that rule a `name:` buried in an LLM provider map would be read as the loader
   * entry's module specifier.
   */
  const currentTarget = () => {
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const f = frames[i];
      // Opaque containers keep their contents out of row-level fields; `insertKey` frames
      // hold no object of their own, and a non-opaque `nesting` frame defers to its owner.
      if (f.opaque || f.kind === 'insertKey' || f.kind === 'nesting') continue;
      return f.obj ?? null;
    }
    return null;
  };

  /** Push the containers a `key:` with an empty value opens. */
  const openBlock = (key, indent, owner) => {
    if (key === 'config') {
      frames.push({ kind: 'configBlock', indent: indent + 1, line: 0 });
      return;
    }
    if (key === 'insert') frames.push({ kind: 'insertKey', indent: indent + 1, line: 0 });
    else frames.push({ kind: 'nesting', indent: indent + 1, key, obj: owner, opaque: !SHALLOW_KEYS.has(key) });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const lineNo = i + 1;
    if (rawLine.trim() === '' || /^\s*#/.test(rawLine)) continue;
    if (/^\s*(---|\.\.\.)\s*$/.test(rawLine)) {
      diagnostics.push(`line ${lineNo}: multi-document markers are not supported`);
      continue;
    }

    const indent = rawLine.length - rawLine.replace(/^\s*/, '').length;
    const body = stripComment(rawLine.trim()).trim();
    if (body === '') continue;

    // A `config:` block is deployment data this plugin never reads. While one is open, every
    // deeper line is skipped outright — no frame bookkeeping, no diagnostics — which keeps a
    // `name:` buried in config from ever reaching a loader row. A line back at row level ends
    // the block and is processed normally.
    const openConfig = frames.find((f) => f.kind === 'configBlock');
    if (openConfig && indent >= openConfig.indent) continue;

    popTo(indent);
    const topLevel = frames.length === 0;

    // ---- list item ----------------------------------------------------------
    if (body.startsWith('- ') || body === '-') {
      const itemText = body === '-' ? '' : body.slice(2).trim();
      const parent = frames.length > 0 ? frames[frames.length - 1] : null;

      if (!topLevel && !(parent && parent.kind === 'insertKey')) {
        // A list nested inside a block. The patch layer has no list-valued interesting key
        // other than `insert`, so this is ordinary config (a model list, a trust list, an
        // `inject` block list) and carries no loader-entry meaning.
        continue;
      }

      const fromInsert = !topLevel;
      const entry = {};
      if (fromInsert) entry.$fromInsert = true;
      topEntries.push(entry);
      frames.push({ kind: 'entry', indent, obj: entry, line: lineNo });

      if (itemText !== '') {
        const m = /^([A-Za-z_][\w.-]*):\s*(.*)$/.exec(itemText);
        if (!m) {
          if (fromInsert) {
            diagnostics.push(`line ${lineNo}: insert row has no mapping body`);
          } else {
            diagnostics.push(`line ${lineNo}: unparsed list item ${JSON.stringify(itemText.slice(0, 50))}`);
          }
        } else {
          const key = m[1];
          const rest = m[2].trim();
          if (rest === '') openBlock(key, indent, entry);
          else assign(entry, key, parseScalar(rest), diagnostics, lineNo);
        }
      }
      continue;
    }

    // ---- mapping entry ------------------------------------------------------
    const m = /^([A-Za-z_][\w$.-]*):\s*(.*)$/.exec(body);
    if (!m) {
      diagnostics.push(`line ${lineNo}: unparsed content ${JSON.stringify(body.slice(0, 60))}`);
      continue;
    }
    const key = m[1];
    const rest = m[2].trim();

    if (topLevel) {
      // A top-level mapping is either a new targeted override row or a continuation of the
      // previous top-level row (`- id: x` followed by `name: y` at the same indentation).
      const last = frames[frames.length - 1];
      const continuesRow = Boolean(last && last.kind === 'entry' && last.indent === indent && !last.closed);
      if (continuesRow) {
        if (rest === '') openBlock(key, indent, last.obj);
        else assign(last.obj, key, parseScalar(rest), diagnostics, lineNo);
        continue;
      }
      // Every mapping at indent 0 belongs to the *current* top-level row, so a document
      // that never opens a new sequence (a plain mapping with no leading `-`) accumulates
      // into one row instead of fabricating a row per line.
      const anchor = frames.length === 0 || frames[0].indent !== 0 ? null : frames[0];
      const entry = anchor && anchor.obj ? anchor.obj : {};
      if (!anchor) {
        topEntries.push(entry);
        frames.push({ kind: 'entry', indent, obj: entry, line: lineNo, closed: true });
      }
      if (rest === '') openBlock(key, indent, entry);
      else assign(entry, key, parseScalar(rest), diagnostics, lineNo);
      continue;
    }

    // A mapping nested inside an open block.
    const owner = currentTarget();
    if (rest === '') {
      openBlock(key, indent, owner);
    } else if (owner) {
      assign(owner, key, parseScalar(rest), diagnostics, lineNo);
    }
    // With no owner the value belongs to a block nobody reads; dropping it is intended.
  }

  return { entries: topEntries, diagnostics };
}

/**
 * Project parsed patch entries into the two things the scanner needs: inserted
 * loader-entry rows and named override rows.
 *
 * An override row is only interesting when it carries a `name`. A row like
 * `- id: llm-pi-ai` with nothing but a `config:` block is the user reconfiguring a row that
 * already exists in some bundle layer — it names a *target*, not a plugin, and emitting it
 * would report an official runtime row as a third-party plugin. Insert rows always declare
 * the module they load, so they are kept even without a package name.
 *
 * @param {Array<Record<string, any>>} entries
 * @returns {{inserts: Array<object>, overrides: Array<object>}}
 */
export function projectPatchEntries(entries) {
  const inserts = [];
  const overrides = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const hasId = typeof e.id === 'string' && e.id.trim() !== '';
    const hasName = typeof e.name === 'string' && e.name.trim() !== '';
    const fromInsert = e.$fromInsert === true;
    if (!fromInsert && !hasName) continue;
    if (fromInsert && !hasId && !hasName) continue;
    const row = {
      id: hasId ? e.id.trim() : null,
      name: hasName ? e.name.trim() : null,
      disabled: e.disabled === true,
      $conditional: e.$conditional === true,
      hasScope: e.scope !== undefined,
    };
    if (fromInsert) inserts.push(row);
    else overrides.push(row);
  }
  return { inserts, overrides };
}
