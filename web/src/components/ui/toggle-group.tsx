import * as TG from '@radix-ui/react-toggle-group'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/cn'

/** A segmented control. Used where the options are few and mutually exclusive,
 * so the choice and its alternatives are visible at once. */
export function ToggleGroup({ className, ...props }: ComponentProps<typeof TG.Root>) {
  return (
    <TG.Root
      className={cn('inline-flex gap-0.5 rounded-lg border border-line bg-surface p-0.5', className)}
      {...props}
    />
  )
}

export function ToggleGroupItem({ className, ...props }: ComponentProps<typeof TG.Item>) {
  return (
    <TG.Item
      className={cn(
        'inline-flex h-7 items-center justify-center gap-1.5 rounded-[7px] px-2.5',
        'text-[12.5px] font-medium text-muted transition-colors outline-none',
        'hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/70',
        'data-[state=on]:bg-accent data-[state=on]:text-accent-fg data-[state=on]:shadow-sm',
        '[&_svg]:size-3.5',
        className,
      )}
      {...props}
    />
  )
}
