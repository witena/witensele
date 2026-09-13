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
 *
 * ## Mentions
 *
 * `@Name` tokens that name a member of this chat are painted in the accent
 * colour. It is done by decorating the *rendered* children of `p` and `li`
 * rather than by rewriting the markdown source, because a rewrite would change
 * the text inside code fences and links too. The rule itself is
 * `splitMentions` in `@shared/mentions`, the same function the backend resolves
 * a reply's mentions with, so a highlighted name and a scheduled speaker can
 * never disagree. S2.5 refines the styling and adds the composer's autocomplete.
 *
 * S2.5 adds syntax highlighting (shiki) on top of the same component.
 */
import { Children, Fragment, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { splitMentions, type MentionMember } from '@shared/mentions'

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
  // Inline code; the `pre code` reset below undoes this inside a block.
  '[&_code]:rounded [&_code]:bg-bg-muted [&_code]:px-1 [&_code]:py-0.5',
  '[&_code]:font-mono [&_code]:text-[12px] [&_code]:text-fg',
  '[&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border-strong',
  '[&_pre]:bg-bg-elevated [&_pre]:p-3 [&_pre]:text-[12px] [&_pre]:leading-relaxed',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
  // Tables scroll inside their own wrapper rather than widening the column.
  '[&_table]:block [&_table]:w-max [&_table]:max-w-full [&_table]:overflow-x-auto',
  '[&_table]:border-collapse [&_table]:text-[13px]',
  '[&_th]:border [&_th]:border-border-strong [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:text-fg',
  '[&_td]:border [&_td]:border-border-strong [&_td]:px-2 [&_td]:py-1'
].join(' ')

/**
 * Wraps every `@Name` token of a text child in an accent-coloured span.
 *
 * Only string children are touched; an element child (a link, inline code) is
 * returned untouched, which is what keeps `@Name` inside a code span plain.
 */
function highlightMentions(children: ReactNode, members: readonly MentionMember[]): ReactNode {
  if (members.length === 0) return children
  return Children.map(children, (child, childIndex) => {
    if (typeof child !== 'string') return child
    const segments = splitMentions(child, members)
    if (!segments.some((segment) => segment.agentIds)) return child
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
        <Fragment key={`${childIndex}-${index}`}>{segment.text}</Fragment>
      )
    )
  })
}

export interface MarkdownProps {
  /** The raw markdown. May be a partial document while a reply is streaming. */
  children: string
  /** Members whose names are highlighted where they appear as `@Name`. */
  mentions?: readonly MentionMember[]
}

export function Markdown({ children, mentions = [] }: MarkdownProps): React.JSX.Element {
  // `node` is react-markdown's AST node and is not a DOM attribute; it is
  // destructured away so the rest can be spread onto the element.
  const components: Components = {
    p: ({ node: _node, children: content, ...props }) => (
      <p {...props}>{highlightMentions(content, mentions)}</p>
    ),
    li: ({ node: _node, children: content, ...props }) => (
      <li {...props}>{highlightMentions(content, mentions)}</li>
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
