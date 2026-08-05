import * as T from '@radix-ui/react-tooltip'
import type { ReactNode } from 'react'

import { cn } from '../../lib/cn'

export const TooltipProvider = T.Provider

/** A tooltip that explains rather than repeats: used for the reason behind a
 * badge or count, never to restate a visible label. */
export function Tooltip({
  content,
  children,
  side = 'bottom',
  className,
}: {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  className?: string
}) {
  if (!content) return <>{children}</>
  return (
    <T.Root delayDuration={200}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          className={cn(
            'z-50 max-w-xs rounded-lg border border-line bg-elevated px-2.5 py-1.5',
            'text-[12px] leading-relaxed text-muted shadow-lg',
            'data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0',
            className,
          )}
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  )
}
