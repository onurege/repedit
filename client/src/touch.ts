// Single source of truth for "is this a touch device". Do NOT gate on viewport
// width — a narrow desktop window is not a phone, and a hybrid laptop with a
// touchscreen must keep BOTH input paths. We detect touch capability instead.
export const IS_TOUCH: boolean =
  typeof window !== 'undefined' &&
  (('ontouchstart' in window) || ((navigator as any).maxTouchPoints ?? 0) > 0);

/** Tag <html> so CSS can adapt (e.g. hide desktop control hints on touch). */
export function markTouchClass(): void {
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('touch', IS_TOUCH);
  }
}
