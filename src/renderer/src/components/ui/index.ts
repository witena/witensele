/**
 * Barrel for the shell's primitives, so a page imports one line instead of ten.
 *
 * Types are re-exported with `export type` because `verbatimModuleSyntax` is on:
 * a value re-export of a type would survive into the emitted module and fail at
 * runtime.
 */
export { Avatar, DEFAULT_AVATAR_COLOR, DEFAULT_AVATAR_TEXT_COLOR } from './avatar'
export type { AvatarProps, AvatarSize } from './avatar'
export {
  BrandMark,
  BRAND_MARK_BLADES,
  BRAND_MARK_HEXAGON,
  BRAND_MARK_POINT,
  BRAND_MARK_STROKE_WIDTH,
  BRAND_MARK_VIEWBOX
} from './brand-mark'
export type { BrandMarkBlade, BrandMarkProps } from './brand-mark'
export { Badge } from './badge'
export type { BadgeProps, BadgeTone } from './badge'
export { Button } from './button'
export type { ButtonProps, ButtonSize, ButtonVariant } from './button'
export { Chip } from './chip'
export type { ChipProps, ChipTone } from './chip'
export { EmptyState } from './empty-state'
export type { EmptyStateProps, EmptyStateSize } from './empty-state'
export { Field } from './field'
export type { FieldProps } from './field'
export { IconButton } from './icon-button'
export type { IconButtonProps, IconButtonSize } from './icon-button'
export { Input } from './input'
export type { InputProps } from './input'
export { PresenceDot, presenceColorClass } from './presence-dot'
export type { PresenceDotProps } from './presence-dot'
export { SectionTitle } from './section-title'
export type { SectionTitleProps } from './section-title'
export { SegmentedControl } from './segmented-control'
export type { SegmentedControlProps, SegmentedOption } from './segmented-control'
export { Select } from './select'
export type { SelectOption, SelectProps } from './select'
export { Spinner } from './spinner'
export type { SpinnerProps, SpinnerSize } from './spinner'
export { StatusPill, statusDotClass, statusToneClass } from './status-pill'
export type { StatusPillProps, StatusTone } from './status-pill'
export { TextArea } from './text-area'
export type { TextAreaProps } from './text-area'
export { Toggle } from './toggle'
export type { ToggleProps } from './toggle'
