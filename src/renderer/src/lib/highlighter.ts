/**
 * The shiki highlighter, built once and grown one grammar at a time.
 *
 * ## Why the core build and the JavaScript engine
 *
 * `shiki`'s default entry point bundles every grammar and theme it has; the
 * `core` build bundles none, and takes the theme and the grammars it is given.
 * The regex engine matters just as much: shiki's default is Oniguruma compiled
 * to WebAssembly, which means shipping (and fetching) a `.wasm` file inside an
 * Electron renderer loaded from `file://`. `createJavaScriptRegexEngine` uses
 * the platform's own RegExp instead — no wasm, no extra asset, and the fourteen
 * grammars in `code-language.ts` are all in the set it handles.
 *
 * ## Lifetime
 *
 * One highlighter for the whole renderer, created on the first code block and
 * kept for the life of the window; a grammar is loaded the first time a block
 * asks for it and then stays. Both promises are memoised, so ten TypeScript
 * blocks rendering at once trigger one import, not ten.
 *
 * Nothing here throws at the call site: `highlightCode` returns `null` when
 * anything fails, and `CodeBlock` then renders the plain text it was already
 * showing. A syntax theme is not worth a blank message.
 */
import type { HighlighterCore } from 'shiki/core'
import { SHIKI_LANGUAGE, type CodeLanguage } from '../components/chat/code-language'

/**
 * The theme.
 *
 * `vitesse-dark` over `github-dark-default`: its background (`#121212`) and its
 * warm, low-saturation palette sit on the app's `--color-bg-elevated` without
 * the blue cast GitHub's dark theme brings into an otherwise warm-grey UI. The
 * block paints its own background from the token anyway; only the token colours
 * come from here.
 */
const THEME = 'vitesse-dark'

/**
 * One static import per grammar, so the bundler can split them.
 *
 * A computed specifier (`import('shiki/langs/' + id + '.mjs')`) would make Vite
 * emit every grammar in the directory as a chunk — hundreds of them — because it
 * cannot tell which ones are reachable.
 */
const LANGUAGE_LOADERS: Record<CodeLanguage, () => Promise<unknown>> = {
  ts: () => import('shiki/langs/typescript.mjs'),
  js: () => import('shiki/langs/javascript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  diff: () => import('shiki/langs/diff.mjs')
}

let highlighter: Promise<HighlighterCore> | null = null
const loaded = new Map<CodeLanguage, Promise<void>>()

async function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, theme] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/themes/vitesse-dark.mjs')
    ])
    return createHighlighterCore({
      themes: [theme.default],
      langs: [],
      engine: createJavaScriptRegexEngine()
    })
  })()
  return highlighter
}

async function ensureLanguage(core: HighlighterCore, language: CodeLanguage): Promise<void> {
  let pending = loaded.get(language)
  if (!pending) {
    pending = LANGUAGE_LOADERS[language]().then(async (module) => {
      await core.loadLanguage((module as { default: never }).default)
    })
    loaded.set(language, pending)
  }
  await pending
}

/**
 * `code` as highlighted HTML, or `null` when it could not be highlighted.
 *
 * The returned markup is shiki's own `<pre class="shiki">…</pre>`, in which
 * every character of the source has been escaped — which is what makes it safe
 * to hand to `dangerouslySetInnerHTML`. The caller styles the wrapper; the
 * inline colours on the spans come from the theme.
 */
export async function highlightCode(code: string, language: CodeLanguage): Promise<string | null> {
  try {
    const core = await getHighlighter()
    await ensureLanguage(core, language)
    return core.codeToHtml(code, { lang: SHIKI_LANGUAGE[language], theme: THEME })
  } catch {
    // A grammar that fails to load is a missing colour, never a missing message.
    return null
  }
}
