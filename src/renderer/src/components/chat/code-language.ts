/**
 * Which fenced-code languages get highlighted, and how a fence's info string is
 * mapped onto one.
 *
 * ## Why a fixed list
 *
 * Shiki ships hundreds of TextMate grammars. Bundling all of them would add
 * megabytes to a renderer whose whole point is a chat window, and a model
 * writing into this app emits a narrow set of languages: the project's own
 * stack, the shells and config formats an agent quotes, and diffs. Fourteen
 * grammars, each loaded **lazily** the first time a block needs it, is the
 * trade: the first TypeScript block costs one dynamic import, and a chat with no
 * code costs nothing at all.
 *
 * ## Unknown languages
 *
 * An unrecognised (or absent) info string resolves to `null`, and the block is
 * rendered as plain monospaced text with the raw label in its header. That is
 * deliberate: guessing at a grammar would colour a Haskell block with Python's
 * rules, which is worse than not colouring it.
 */

/** The languages with a grammar. The ids are what the code-block header prints. */
export const CODE_LANGUAGES = [
  'ts',
  'js',
  'tsx',
  'json',
  'bash',
  'python',
  'go',
  'rust',
  'sql',
  'yaml',
  'markdown',
  'html',
  'css',
  'diff'
] as const

export type CodeLanguage = (typeof CODE_LANGUAGES)[number]

/**
 * The shiki grammar id each of ours loads.
 *
 * Ours are the short names a fence usually carries; shiki's are the canonical
 * grammar names. Keeping the two apart means the header can print `ts` while
 * the highlighter is handed `typescript`.
 */
export const SHIKI_LANGUAGE: Record<CodeLanguage, string> = {
  ts: 'typescript',
  js: 'javascript',
  tsx: 'tsx',
  json: 'json',
  bash: 'bash',
  python: 'python',
  go: 'go',
  rust: 'rust',
  sql: 'sql',
  yaml: 'yaml',
  markdown: 'markdown',
  html: 'html',
  css: 'css',
  diff: 'diff'
}

/**
 * Everything else a fence is written as, lower-cased, mapped onto one of ours.
 *
 * The list is the spellings models actually produce — `py`, `sh`, `shell`,
 * `jsonc`, `yml`, `md`, `golang`, `rs` — plus the two React dialects, which
 * both use the `tsx` grammar because it is a superset of `jsx`.
 */
export const LANGUAGE_ALIASES: Record<string, CodeLanguage> = {
  typescript: 'ts',
  mts: 'ts',
  cts: 'ts',
  javascript: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'tsx',
  json5: 'json',
  jsonc: 'json',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  py: 'python',
  python3: 'python',
  golang: 'go',
  rs: 'rust',
  postgres: 'sql',
  postgresql: 'sql',
  mysql: 'sql',
  sqlite: 'sql',
  yml: 'yaml',
  md: 'markdown',
  mdx: 'markdown',
  xml: 'html',
  svg: 'html',
  patch: 'diff'
}

const SUPPORTED = new Set<string>(CODE_LANGUAGES)

/**
 * The grammar for a fence's info string, or `null` for "render it plain".
 *
 * Only the first word is looked at: `ts title="a.ts"` and `python {1,3}` are
 * both common, and the attributes after the language are not ours to interpret.
 */
export function resolveCodeLanguage(raw: string | null | undefined): CodeLanguage | null {
  if (!raw) return null
  const first = raw.trim().split(/[\s:,{]/)[0]?.toLowerCase() ?? ''
  if (first.length === 0) return null
  if (SUPPORTED.has(first)) return first as CodeLanguage
  return LANGUAGE_ALIASES[first] ?? null
}

/**
 * What the code block's header prints.
 *
 * The resolved id when there is one, so `typescript` and `ts` look the same in a
 * transcript; otherwise the raw word the model wrote, trimmed and lower-cased,
 * so an unhighlighted Haskell block still says `haskell`. An empty string means
 * the header shows no language at all.
 */
export function codeLanguageLabel(raw: string | null | undefined): string {
  const resolved = resolveCodeLanguage(raw)
  if (resolved) return resolved
  return (raw ?? '').trim().split(/\s/)[0]?.toLowerCase() ?? ''
}
