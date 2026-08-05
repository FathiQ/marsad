import type { ComponentProps } from 'react'

import { cn } from '../../lib/cn'

export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line-strong',
        'border-b-2 bg-surface px-1 font-mono text-[10px] text-muted',
        className,
      )}
      {...props}
    />
  )
}
