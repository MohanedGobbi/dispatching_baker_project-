import { useEffect, useState } from 'react'
import type { RefObject } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Keyboard focus for dialogs and side panels: move focus inside when it opens (unless a field already took it
 * with autoFocus), keep Tab and Shift+Tab inside while it is open, and give focus back to whatever opened it.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, key?: unknown) {
  // Read during the first render, before any autoFocus field inside the dialog takes focus.
  const [opener] = useState(() => document.activeElement as HTMLElement | null)
  useEffect(() => {
    const box = ref.current
    if (!box) return
    const items = () => [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.offsetParent !== null || el === document.activeElement)
    if (!box.contains(document.activeElement)) {
      const first = box.querySelector<HTMLElement>('[autofocus]') ?? items().find(el => el.getAttribute('aria-label') !== 'Close') ?? box
      if (first === box && !box.hasAttribute('tabindex')) box.setAttribute('tabindex', '-1')
      first.focus({ preventScroll: true })
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const list = items()
      if (!list.length) { e.preventDefault(); return }
      const first = list[0], last = list[list.length - 1]
      if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true })
    }
  }, [ref, key, opener])
}
