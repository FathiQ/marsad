import { Command as CommandPrimitive } from 'cmdk'
import * as Dialog from '@radix-ui/react-dialog'
import type { ComponentProps, ReactNode } from 'react'

import { cn } from '../../lib/cn'

/** Command palette. The fastest way across a cluster with hundreds of
 * namespaces is typing its name, not scrolling a list to find it. */
export function CommandDialog({
  open,
  onOpenChange,
  children,
  label,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
  label: string
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-label={label}
          className={cn(
            'fixed top-[18%] left-1/2 z-50 w-[min(38rem,92vw)] -translate-x-1/2',
            'overflow-hidden rounded-xl border border-line bg-elevated shadow-2xl outline-none',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          )}
        >
          <Dialog.Title className="sr-only">{label}</Dialog.Title>
          <CommandPrimitive
            loop
            className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-[0.07em] [&_[cmdk-group-heading]]:text-faint [&_[cmdk-group-heading]]:uppercase"
          >
            {children}
          </CommandPrimitive>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function CommandInput({ className, ...props }: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center gap-2.5 border-b border-line px-3.5">
      <CommandPrimitive.Input
        className={cn(
          'h-12 w-full bg-transparent text-[14px] text-fg outline-none placeholder:text-faint',
          className,
        )}
        {...props}
      />
    </div>
  )
}

export const CommandList = ({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) => (
  <CommandPrimitive.List
    className={cn('max-h-[22rem] overflow-y-auto overflow-x-hidden p-1.5', className)}
    {...props}
  />
)

export const CommandEmpty = (props: ComponentProps<typeof CommandPrimitive.Empty>) => (
  <CommandPrimitive.Empty className="py-8 text-center text-[13px] text-faint" {...props} />
)

export const CommandGroup = CommandPrimitive.Group

export function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        'flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-muted',
        'outline-none select-none data-[selected=true]:bg-accent/15 data-[selected=true]:text-fg',
        '[&_svg]:size-4 [&_svg]:shrink-0',
        className,
      )}
      {...props}
    />
  )
}
