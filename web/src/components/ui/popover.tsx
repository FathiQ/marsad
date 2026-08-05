import * as P from '@radix-ui/react-popover'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/cn'

export const Popover = P.Root
export const PopoverTrigger = P.Trigger

export function PopoverContent({
  className,
  align = 'start',
  sideOffset = 6,
  ...props
}: ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 w-72 rounded-xl border border-line bg-elevated p-1 shadow-2xl outline-none',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          className,
        )}
        {...props}
      />
    </P.Portal>
  )
}
