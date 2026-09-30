import { useEffect } from 'preact/hooks'

/**
 * The room a terminal takes from the conversation above it.
 *
 * The feed ends where the surfaces under it begin, and the composer already
 * publishes its own height that way — a panel that did not would cover the end
 * of the conversation it sits under, which is the part somebody was reading. A
 * maximized terminal owns the conversation instead of sitting under it, so it
 * takes no room from it.
 */
export function useTerminalHeight(height: number, maximized: boolean) {
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--terminal-height', maximized ? '0px' : `${Math.ceil(height)}px`)
    return () => { root.style.removeProperty('--terminal-height') }
  }, [height, maximized])
}
