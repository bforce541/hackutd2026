/** Class name helper (clsx + tailwind-merge), as shadcn/ui expects. Owned by: dash-shell. */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
