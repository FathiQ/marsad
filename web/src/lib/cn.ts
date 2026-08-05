import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Merges class names, letting a caller's utility win over a component default
 * instead of both landing in the class list and the cascade deciding. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
