import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/cn'

const badge = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-5',
  {
    variants: {
      tone: {
        neutral: 'border-line bg-surface text-muted',
        ok: 'border-allowed/40 bg-allowed/10 text-allowed',
        danger: 'border-danger/40 bg-danger/10 text-danger',
        warn: 'border-warn/40 bg-warn/10 text-warn',
        accent: 'border-accent/40 bg-accent/10 text-accent',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badge>

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badge({ tone }), className)} {...props} />
}
