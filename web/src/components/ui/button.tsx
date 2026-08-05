import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/cn'

const button = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium ' +
    'transition-[background-color,color,box-shadow,border-color] duration-150 ' +
    'outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 ' +
    'focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-50 ' +
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-accent text-accent-fg hover:brightness-110 shadow-sm',
        outline: 'border border-line bg-surface text-muted hover:text-fg hover:bg-elevated rim',
        ghost: 'text-muted hover:text-fg hover:bg-elevated',
        subtle: 'bg-elevated text-muted hover:text-fg',
      },
      size: {
        sm: 'h-7 px-2.5 text-[12.5px] [&_svg]:size-3.5',
        md: 'h-8 px-3 [&_svg]:size-4',
        icon: 'size-8 [&_svg]:size-4',
        'icon-sm': 'size-7 [&_svg]:size-3.5',
      },
    },
    defaultVariants: { variant: 'ghost', size: 'md' },
  },
)

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof button> & { asChild?: boolean }

export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button'
  return <Comp className={cn(button({ variant, size }), className)} {...props} />
}
