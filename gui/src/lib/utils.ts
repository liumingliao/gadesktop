import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind class names safely (later classes win on conflicts).
 *
 * Re-exported from shadcn convention so component code can `import { cn }
 * from "@/lib/utils"`.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
