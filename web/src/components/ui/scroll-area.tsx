import * as S from '@radix-ui/react-scroll-area'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/cn'

export function ScrollArea({ className, children, ...props }: ComponentProps<typeof S.Root>) {
  return (
    <S.Root className={cn('relative overflow-hidden', className)} {...props}>
      <S.Viewport className="size-full rounded-[inherit]">{children}</S.Viewport>
      <S.Scrollbar
        orientation="vertical"
        className="flex w-2 touch-none p-0.5 transition-colors select-none"
      >
        <S.Thumb className="relative flex-1 rounded-full bg-line-strong" />
      </S.Scrollbar>
      <S.Corner />
    </S.Root>
  )
}
