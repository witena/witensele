/**
 * A message body rendered as markdown.
 *
 * Models answer in markdown whether or not anyone asked them to — lists, fenced
 * code, tables — so rendering it is not a nicety, it is the difference between a
 * readable answer and a wall of asterisks. `remark-gfm` is included because the
 * tables and strikethrough models emit are GitHub-flavoured, not CommonMark.
 *
 * ## Why the styling is descendant selectors rather than a typography plugin
 *
 * The project has no `@tailwindcss/typography`, and adding one to style six
 * elements would drag in a whole prose theme that then has to be fought back to
 * the mockup's colours. The rules below are the mockup's `.msg-text` block
 * (14px / 1.6, 6px paragraph spacing) plus the few elements markdown adds, all
 * built from the semantic tokens in `index.css`.
 *
 * Long content — a table, a fenced line that does not wrap — scrolls **inside**
 * its own element rather than widening the column: the message list is a fixed
 * middle column and a horizontal scrollbar on the page would be a layout bug.
 * A table gets an explicit wrapper for that, because `display: block` on a
 * `<table>` (the only way to make the element itself scroll) also throws away
 * the column sizing that made the table worth rendering.
 *
 * ## Code
 *
 * Inline code keeps the descendant rules below — mono, on `bg-bg-muted`. A
 * fenced block is handed to `CodeBlock`, which owns the header, the Copy button
 * and shiki. The handover needs **both** overrides: `code` decides whether a
 * node is a block, and `pre` becomes a passthrough so the block is not wrapped
 * in a `<pre>` it would then have to fight.
 *
 * ## Links
 *
 * `target="_blank" rel="noreferrer"` on every link. In Electron a `_blank`
 * would open a second `BrowserWindow` with no chrome and full renderer
 * privileges, so `src/main/index.ts` installs a `setWindowOpenHandler` that
 * hands http(s) to `shell.openExternal` and denies everything else. Both halves
 * are needed: this one makes the link a navigation request, that one decides
 * where it goes.
 *
 * ## Mentions
 *
 * `@Name` tokens that name a member of this chat are painted in the accent
 * colour. It is done by decorating the *rendered* children of `p` and `li`
 * rather than by rewriting the markdown source, because a rewrite would change
 * the text inside code fences and links too. The rule itself is
 * `splitMentions` in `@shared/mentions`, the same function the backend resolves
 * a reply's mentions with, so a highlighted name and a scheduled speaker can
 * never disagree.
 *
 * ## File references (S5.7)
 *
 * The same decoration, one layer further in: inside each segment that is *not* a
 * mention, `findFileRefs` looks for tokens that resolve inside the chat's working
 * directory and each one becomes a `FileRefChip` that opens the file. Mentions
 * are split first because `@Ada` can never be a path and a path can never be a
 * mention, and running the cheaper, stricter rule first keeps each pass simple.
 *
 * **Inline code is a chip too, and only inline code.** `` `src/main.ts:42` `` is
 * how a model writes a path more often than not, so the `code` renderer checks
 * whether its whole content is one resolvable reference and renders the chip
 * instead of a mono span. A *fenced* block is left alone: a diff or a listing
 * mentioning forty paths would become forty buttons, and it is a `CodeBlock` with
 * its own copy button already.
 *
 * Nothing happens at all when the chat is not bound to a folder — `findFileRefs`
 * returns nothing without one — so an ordinary chat's prose is untouched.
 */
import { Children, Fragment, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { splitMentions, type MentionMember } from '@shared/mentions'
import { CodeBlock } from './code-block'
import { FileRefChip } from './file-ref-chip'
import { findFileRefs } from './file-refs'

/**
 * The prose rules, as descendant utilities on one wrapper.
 *
 * Written out as a single string rather than composed per element so the whole
 * type scale of a message body is readable in one place.
 */
const PROSE = [
  'text-sm leading-relaxed text-fg-secondary',
  // Block spacing: the mockup's 6px between paragraphs, nothing after the last.
  '[&>*]:my-0 [&>*+*]:mt-1.5',
  '[&_p]:my-0',
  '[&_strong]:font-semibold [&_strong]:text-fg',
  '[&_em]:italic',
  '[&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2',
  '[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_li]:my-0.5 [&_li]:marker:text-fg-faint',
  '[&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm',
  '[&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold',
  '[&_h1]:text-fg [&_h2]:text-fg [&_h3]:text-fg',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-border-strong [&_blockquote]:pl-3 [&_blockquote]:text-fg-dim',
  '[&_hr]:border-border',
  // Inline code. A fenced block never reaches these rules: it is a `CodeBlock`.
  '[&_code]:rounded [&_code]:bg-bg-muted [&_code]:px-1 [&_code]:py-0.5',
  '[&_code]:font-mono [&_code]:text-[12px] [&_code]:text-fg',
  '[&_table]:w-full [&_table]:border-collapse [&_table]:text-[13px]',
  '[&_th]:border [&_th]:border-border-strong [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:text-fg',
  '[&_td]:border [&_td]:border-border-strong [&_td]:px-2 [&_td]:py-1 [&_td]:whitespace-nowrap'
].join(' ')

/** Where the chips have to be resolved against; absent means "draw none". */
interface FileRefContext {
  workdir?: string | null | undefined
  chatId?: string | undefined
}

/**
 * One run of plain text, with its file references replaced by chips.
 *
 * Returns the string itself when there is nothing to do, so the overwhelmingly
 * common case adds no elements to the tree at all.
 */
function withFileRefs(text: string, context: FileRefContext, keyPrefix: string): ReactNode {
  const refs = findFileRefs(text, context.workdir)
  if (refs.length === 0) return text

  const nodes: ReactNode[] = []
  let cursor = 0
  refs.forEach((ref, index) => {
    if (ref.start > cursor) {
      nodes.push(<Fragment key={`${keyPrefix}-t${index}`}>{text.slice(cursor, ref.start)}</Fragment>)
    }
    nodes.push(
      <FileRefChip
        key={`${keyPrefix}-r${index}`}
        part={{ type: 'file-ref', path: ref.path, ...(ref.line === undefined ? {} : { line: ref.line }) }}
        absolute={ref.absolute}
        {...(context.chatId === undefined ? {} : { chatId: context.chatId })}
      />
    )
    cursor = ref.end
  })
  if (cursor < text.length) {
    nodes.push(<Fragment key={`${keyPrefix}-tail`}>{text.slice(cursor)}</Fragment>)
  }
  return nodes
}

/**
 * Wraps every `@Name` token of a text child in an accent-coloured span, and
 * every file reference in the rest of it in a chip.
 *
 * Only string children are touched; an element child (a link, a fenced block) is
 * returned untouched, which is what keeps `@Name` inside a code span plain.
 * Inline code is handled by the `code` renderer instead, which is the one place
 * that knows a span is inline.
 */
function decorate(
  children: ReactNode,
  members: readonly MentionMember[],
  context: FileRefContext
): ReactNode {
  return Children.map(children, (child, childIndex) => {
    if (typeof child !== 'string') return child
    const segments = splitMentions(child, members)
    return segments.map((segment, index) =>
      segment.agentIds ? (
        <span
          key={`${childIndex}-${index}`}
          data-testid="message-mention"
          className="font-medium text-accent"
        >
          {segment.text}
        </span>
      ) : (
        <Fragment key={`${childIndex}-${index}`}>
          {withFileRefs(segment.text, context, `${childIndex}-${index}`)}
        </Fragment>
      )
    )
  })
}

/** The text of a `code` node, which react-markdown hands over as children. */
function codeText(children: ReactNode): string {
  if (typeof children === 'string') return children
  return Children.toArray(children)
    .map((child) => (typeof child === 'string' ? child : ''))
    .join('')
}

export interface MarkdownProps {
  /** The raw markdown. May be a partial document while a reply is streaming. */
  children: string
  /** Members whose names are highlighted where they appear as `@Name`. */
  mentions?: readonly MentionMember[]
  /** The chat's working directory; without one no file chip is drawn (S5.7). */
  workdir?: string | null | undefined
  /** The chat the body belongs to, sent with every open-in-editor call. */
  chatId?: string | undefined
}

export function Markdown({
  children,
  mentions = [],
  workdir,
  chatId
}: MarkdownProps): React.JSX.Element {
  const refContext: FileRefContext = {
    workdir,
    ...(chatId === undefined ? {} : { chatId })
  }
  // `node` is react-markdown's AST node and is not a DOM attribute; it is
  // destructured away so the rest can be spread onto the element.
  const components: Components = {
    p: ({ node: _node, children: content, ...props }) => (
      <p {...props}>{decorate(content, mentions, refContext)}</p>
    ),
    li: ({ node: _node, children: content, ...props }) => (
      <li {...props}>{decorate(content, mentions, refContext)}</li>
    ),
    a: ({ node: _node, children: content, ...props }) => (
      // See the header: the handler in the main process decides where this goes.
      <a {...props} target="_blank" rel="noreferrer">
        {content}
      </a>
    ),
    // The fenced block is rendered by `code` below, so this is a passthrough
    // rather than a `<pre>` that would wrap the card in a second scroll box.
    pre: ({ node: _node, children: content }) => <>{content}</>,
    code: ({ node: _node, className, children: content, ...props }) => {
      const fence = /language-([\w+#-]+)/.exec(className ?? '')
      const text = codeText(content)
      // An indented block has no info string but does span lines; an inline span
      // has neither. Either is enough to make it a block.
      if (!fence && !text.includes('\n')) {
        // `src/main.ts:42` in backticks is the commonest way a model writes a
        // path. One reference and nothing else makes the span a chip; anything
        // longer stays the mono span it was.
        const inlineRefs = findFileRefs(text, refContext.workdir)
        const only = inlineRefs.length === 1 ? inlineRefs[0] : undefined
        if (only && only.start === 0 && only.end === text.trim().length) {
          return (
            <FileRefChip
              part={{
                type: 'file-ref',
                path: only.path,
                ...(only.line === undefined ? {} : { line: only.line })
              }}
              absolute={only.absolute}
              {...(refContext.chatId === undefined ? {} : { chatId: refContext.chatId })}
            />
          )
        }
        return (
          <code className={className} {...props}>
            {content}
          </code>
        )
      }
      return (
        <CodeBlock
          {...(fence?.[1] ? { language: fence[1] } : {})}
          code={text.replace(/\n$/, '')}
        />
      )
    },
    // The wrapper, not the table, is what scrolls: `display: block` on a table
    // would drop the column layout the markup exists for.
    table: ({ node: _node, children: content, ...props }) => (
      <div data-testid="message-table" className="max-w-full overflow-x-auto">
        <table {...props}>{content}</table>
      </div>
    )
  }

  return (
    <div className={PROSE}>
      {/* Partial markdown mid-stream (an unclosed fence, half a table) is normal:
          react-markdown renders what it can rather than throwing. */}
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
