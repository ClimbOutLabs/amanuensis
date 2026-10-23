import { cn } from './cn.js';

export type AuiButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type AuiButtonSize = 'large' | 'small' | 'icon';

const variantClasses: Record<AuiButtonVariant, string> = {
  primary: 'bg-primary-button-bg text-primary-button-text shadow hover:bg-primary-button-hover',
  secondary:
    'border border-input-border bg-secondary-button-bg text-secondary-button-text hover:bg-secondary-button-hover',
  ghost: 'bg-ghost-button-bg text-ghost-button-text hover:bg-ghost-button-hover',
  destructive: 'bg-failure-bg text-failure-text shadow-sm hover:bg-failure-bg/90',
};

/** Glyph sizes match the shared design-system Button (`iconSizeMap`: large 0.875rem, small 0.75rem). */
const sizeClasses: Record<AuiButtonSize, string> = {
  large: 'h-8 gap-2 px-2.5 text-sm [&_svg]:size-3.5',
  small: 'h-6 gap-1 px-1.5 text-xs [&_svg]:size-3',
  icon: 'h-8 w-8 shrink-0 gap-0 p-0 [&_svg]:size-3.5',
};

const baseClasses =
  'inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50';

/** Sidebar / rail nav control corner radius: 12px. */
export const sidebarButtonRadiusClassName = 'rounded-[0.75rem]';

/** Rail and Chats-column corner radius: the composer's 20px, so the left column reads as one family with it. */
export const sidebarQuietRadiusClassName = 'rounded-[1.25rem]';

/** One row in the rail's More menu: icon and label on one line, with the composer's quiet corners and no border. */
export const railMenuRowClassName = cn(
  sidebarQuietRadiusClassName,
  'flex h-8 w-full shrink-0 flex-row items-center justify-start gap-2 border-0 bg-transparent px-2.5 text-[0.875rem] font-normal whitespace-nowrap text-text-primary shadow-none hover:bg-ghost-button-hover',
);

/**
 * Compact sidebar rail control: 4rem × 3.375rem, icon over a 0.75rem secondary label. No box at rest;
 * hover and the selected item use the soft fill tokens, not a heavy primary fill.
 */
export const sidebarRailButtonClassName = cn(
  sidebarQuietRadiusClassName,
  'h-[3.375rem] w-[4rem] shrink-0 flex-col gap-1 border border-transparent whitespace-normal px-0.5 text-[0.75rem] font-normal leading-tight text-text-secondary !justify-center shadow-none hover:bg-ghost-button-hover hover:text-text-primary [&_svg]:size-3.5',
);

/** Shared Button / native `<button>` className helper (SDK utilities are layered). */
export function auiButtonClass({
  variant = 'primary',
  size = 'large',
  className,
}: {
  variant?: AuiButtonVariant;
  size?: AuiButtonSize;
  className?: string;
} = {}): string {
  return cn(baseClasses, variantClasses[variant], sizeClasses[size], className);
}
