import { createContext, useContext } from 'react'

/** Opens the quick actions menu for a person (right-click or the hover button on any name). Provided by quick.tsx. */
export type OpenQuick = (personId: string, at: { x: number; y: number }) => void
export const QuickCtx = createContext<OpenQuick | null>(null)
export const useQuick = () => useContext(QuickCtx)

/** Props that make an element open the menu on right-click. */
export function quickProps(open: OpenQuick | null, personId: string | null | undefined) {
  if (!open || !personId) return {}
  return { onContextMenu: (e: { preventDefault: () => void; stopPropagation: () => void; clientX: number; clientY: number }) => { e.preventDefault(); e.stopPropagation(); open(personId, { x: e.clientX, y: e.clientY }) } }
}
