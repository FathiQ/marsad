import * as C from '@radix-ui/react-checkbox'
import { Check, Minus } from 'lucide-react'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/cn'

export function Checkbox({ className, checked, ...props }: ComponentProps<typeof C.Root>) {
  return (
    <C.Root
      checked={checked}
      className={cn(
        'peer size-4 shrink-0 rounded-[5px] border border-line-strong bg-surface',
        'transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/70',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent',
        'data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent',
        className,
      )}
      {...props}
    >
      <C.Indicator className="flex items-center justify-center text-accent-fg">
        {checked === 'indeterminate' ? <Minus className="size-3" /> : <Check className="size-3" />}
      </C.Indicator>
    </C.Root>
  )
}
