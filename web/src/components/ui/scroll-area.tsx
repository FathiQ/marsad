import * as S from '@radix-ui/react-scroll-area'
import type { ComponentProps, Ref } from 'react'

import { cn } from '../../lib/cn'

type Props = ComponentProps<typeof S.Root> & {
  /** The scrolling element itself, for callers that need to scroll something
   * into view. Radix nests it inside the root, so a ref on the root scrolls
   * nothing. */
  viewportRef?: Ref<HTMLDivElement>
}

export function ScrollArea({ className, children, viewportRef, ...props }: Props) {
  return (
    <S.Root className={cn('relative overflow-hidden', className)} {...props}>
      <S.Viewport ref={viewportRef} className="size-full rounded-[inherit]">
        {children}
      </S.Viewport>
      <S.Scrollbar
        orientation="vertical"
        className="flex w-2 touch-none p-0.5 transition-colors select-none"
      >
        {/* line-faint, not line-strong: a scrollbar thumb is a control you have
            to be able to find, and line-strong is a 1.8:1 hairline. */}
        <S.Thumb className="relative flex-1 rounded-full bg-line-faint" />
      </S.Scrollbar>
      <S.Corner />
    </S.Root>
  )
}
