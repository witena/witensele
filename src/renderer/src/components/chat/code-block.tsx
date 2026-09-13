/**
 * A fenced code block: a header naming the language with a Copy button, and the
 * code itself, syntax-highlighted when the language has a grammar.
 *
 * ## Highlighting is an enhancement, never a gate
 *
 * The plain text is rendered on the first frame and replaced by shiki's markup
 * when the grammar finishes loading. That ordering is not an optimisation, it is
 * the correctness requirement: a block arrives **while a reply is streaming**,
 * its content changes a dozen times a second, and a component that waited for a
 * highlighter before showing anything would blink for the whole answer. An
 * unknown language, a failed import and a mid-stream unclosed fence all land in
 * the same place — readable monospaced text.
 *
 * Every highlight pass is guarded by a `cancelled` flag: by the time a grammar
 * has loaded, the code it was asked about may have grown by three tokens, and
 * writing the stale HTML would make the block flicker backwards.
 *
 * ## Copy
 *
 * `navigator.clipboard.writeText` with a 1.5 s "Copied" confirmation and no
 * error state: the clipboard is either available or it is not, and a red
 * message on a copy button is noise. The timer is cleared on unmount, because a
 * reply that scrolls out of a virtualized list unmounts mid-confirmation.
 */
import clsx from 'clsx'
import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { highlightCode } from '../../lib/highlighter'
import { codeLanguageLabel, resolveCodeLanguage } from './code-language'

/** How long the Copy button stays in its confirmed state. */
export const COPIED_FEEDBACK_MS = 1_500

export interface CodeBlockProps {
  /** The fence's info string, e.g. `ts`. Absent for an unlabelled block. */
  language?: string | undefined
  /** The block's text, without the trailing newline the fence adds. */
  code: string
}

export function CodeBlock({ language, code }: CodeBlockProps): React.JSX.Element {
  const { t } = useTranslation()
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const resolved = resolveCodeLanguage(language)
  const label = codeLanguageLabel(language)

  useEffect(() => {
    if (!resolved) {
      setHtml(null)
      return undefined
    }
    let cancelled = false
    void highlightCode(code, resolved).then((markup) => {
      if (!cancelled) setHtml(markup)
    })
    return () => {
      cancelled = true
    }
  }, [code, resolved])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const copy = (): void => {
    void navigator.clipboard?.writeText(code).catch(() => undefined)
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
  }

  return (
    <div
      data-testid="code-block"
      data-language={resolved ?? ''}
      className="my-1.5 overflow-hidden rounded-lg border border-border-strong bg-bg-elevated"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border-strong px-2.5 py-1">
        <span data-testid="code-block-language" className="font-mono text-[10px] text-fg-faint">
          {label}
        </span>
        <button
          type="button"
          data-testid="code-block-copy"
          onClick={copy}
          aria-label={t('chat.copyCode')}
          className={clsx(
            'inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] transition-colors',
            'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
            copied ? 'text-accent' : 'text-fg-faint hover:text-fg'
          )}
        >
          {copied ? (
            <Check aria-hidden="true" className="h-3 w-3" />
          ) : (
            <Copy aria-hidden="true" className="h-3 w-3" />
          )}
          {copied ? t('chat.copied') : t('chat.copy')}
        </button>
      </div>

      {html ? (
        <div
          data-testid="code-block-body"
          // Shiki escapes every character of the source, so the only markup here
          // is its own `<span style="color:…">` wrapping. The theme's background
          // is overridden by the block's own token so it matches the shell.
          dangerouslySetInnerHTML={{ __html: html }}
          className="overflow-x-auto p-3 text-[12px] leading-relaxed [&_pre]:!bg-transparent [&_pre]:m-0 [&_code]:!bg-transparent [&_code]:!p-0 [&_code]:font-mono"
        />
      ) : (
        <pre
          data-testid="code-block-body"
          className="overflow-x-auto p-3 font-mono text-[12px] leading-relaxed text-fg-secondary"
        >
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}
