// Read / back up / edit a profile's `cordis.patch.yml` safely.
// Pure text manipulation: the file is YAML, but we only touch `disabled` on rows
// we can identify, and we always back up first.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ID_LINE = /^(\s*)- id:\s*(.+?)\s*$/
const FIELD_LINE = /^(\s+)(name|disabled):\s*(.*)$/

function unquote(value) {
  const text = String(value).trim()
  if (text.length >= 2 && ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"')))) {
    return text.slice(1, -1)
  }
  return text
}

/**
 * Every plugin row in the file: top-level overrides (`- id:` at column 0) and
 * rows nested one level under `- insert:` or a group `config:` (column 4).
 * Deeper `- id:` lists are plugin *configuration* (e.g. model catalogs) — those
 * are data, not rows, and must not be mistaken for plugins.
 * @returns {{id: string, name: string|null, disabled: string|null, indent: number}[]}
 */
export function parsePatchRows(text) {
  const rows = []
  let current = null
  for (const raw of String(text).split(/\r?\n/)) {
    const idMatch = ID_LINE.exec(raw)
    if (idMatch && idMatch[1].length <= 4) {
      current = { id: unquote(idMatch[2]), name: null, disabled: null, indent: idMatch[1].length }
      rows.push(current)
      continue
    }
    if (idMatch) { current = null; continue }
    if (!current) continue
    const field = FIELD_LINE.exec(raw)
    if (!field) continue
    if (field[1].length !== current.indent + 2) continue
    if (field[2] === 'name') current.name = unquote(field[3])
    else current.disabled = field[3].trim()
  }
  return rows
}

/** Rows whose plugin is not shipped by DSH. */
export function thirdPartyRows(text) {
  return parsePatchRows(text)
    .filter((row) => row.name && !row.name.startsWith('@deepseek-ai/') && !row.name.startsWith('cordis:'))
}

/** Copy the file beside itself with a timestamped name; never overwrite a backup. */
export function backupFile(file) {
  const stamp = Date.now()
  let target = `${file}.bak-${stamp}`
  let suffix = 1
  while (existsSync(target)) {
    target = `${file}.bak-${stamp}-${suffix}`
    suffix += 1
  }
  copyFileSync(file, target)
  return target
}

/**
 * Ensure a top-level `- id: <id>` + `disabled: true` exists.
 * Appending is enough: patches apply in order, so a later entry wins over an
 * earlier `- insert:` row with the same id. An existing top-level row is edited
 * in place instead of duplicated.
 */
function upsertDisable(lines, id) {
  const isTarget = (line) => {
    const match = ID_LINE.exec(line)
    return Boolean(match) && match[1].length === 0 && unquote(match[2]) === id
  }
  const start = lines.findIndex(isTarget)
  if (start >= 0) {
    let end = lines.length
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^- /.test(lines[i])) { end = i; break }
    }
    const disabledIndex = lines.findIndex((line, i) => i > start && i < end && /^ {2}disabled:/.test(line))
    if (disabledIndex >= 0) {
      lines[disabledIndex] = '  disabled: true'
      return lines
    }
    const nameIndex = lines.findIndex((line, i) => i > start && i < end && /^ {2}name:/.test(line))
    lines.splice(nameIndex >= 0 ? nameIndex + 1 : start + 1, 0, '  disabled: true')
    return lines
  }
  // A fresh profile's patch file is a single flow array `[]`; drop it so the
  // document becomes a block sequence (appending after `[]` is invalid YAML).
  const markerIndex = lines.findIndex((line) => line.trim() === '[]')
  if (markerIndex >= 0) lines.splice(markerIndex, 1)
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  lines.push(`- id: ${id}`, '  disabled: true', '')
  return lines
}

/**
 * Disable plugins by id in `<profileDir>/cordis.patch.yml`.
 * Always backs up first, then verifies the result by re-parsing.
 * @returns {{file: string, backup: string, ids: string[], notDisabled: string[]}}
 */
export function disablePlugins(profileDir, ids) {
  const file = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(file)) {
    throw Object.assign(new Error(`No cordis.patch.yml found in ${profileDir}`), { code: 'EDSH_NO_PATCH_FILE' })
  }
  const backup = backupFile(file)
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const unique = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))]
  for (const id of unique) upsertDisable(lines, id)
  writeFileSync(file, lines.join('\n'), 'utf8')

  const rows = parsePatchRows(readFileSync(file, 'utf8'))
  const notDisabled = unique.filter((id) => {
    const row = [...rows].reverse().find((candidate) => candidate.id === id)
    return !row || row.disabled !== 'true'
  })
  return { file, backup, ids: unique, notDisabled }
}

export { unquote }
