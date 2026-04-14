/**
 * ``cn`` — class-name composer.
 *
 * ``clsx`` handles conditionals; ``tailwind-merge`` strips conflicting
 * Tailwind utilities so the last-declared rule wins. Use it everywhere
 * instead of string concatenation.
 */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
