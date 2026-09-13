/**
 * Multi-line text input: the composer and, from S2.1, the system prompt editor.
 *
 * Resizing is disabled because both call sites size the box themselves — the
 * composer grows with its content, the prompt editor fills its column — and a
 * user-dragged handle would fight the layout.
 */
import clsx from 'clsx'
import type { ComponentPropsWithRef } from 'react'

/**
 * `ComponentPropsWithRef`, not `TextareaHTMLAttributes`: the composer holds a
 * ref to the element so it can place the caret after an autocomplete insertion.
 * React 19 passes `ref` through as a normal prop, so no `forwardRef` is needed —
 * only a prop type that admits it.
 */
export type TextAreaProps = ComponentPropsWithRef<'textarea'>

export function TextArea({ className, ...rest }: TextAreaProps): React.JSX.Element {
  return (
    <textarea
      className={clsx(
        'w-full resize-none bg-transparent text-sm leading-relaxed text-fg',
        'placeholder:text-fg-faint focus:outline-none disabled:cursor-not-allowed',
        className
      )}
      {...rest}
    />
  )
}
