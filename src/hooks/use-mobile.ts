import * as React from "react"

const MOBILE_BREAKPOINT = 768
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(MOBILE_QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

/** Read the live value, so a resize that does not cross the breakpoint still doesn't matter. */
function getSnapshot() {
  return window.innerWidth < MOBILE_BREAKPOINT
}

/**
 * Is the viewport below the mobile breakpoint?
 *
 * `matchMedia` *is* an external store, so `useSyncExternalStore` is the honest
 * way to read it: the subscription is the source of truth, there is no
 * `setState` inside an effect (which would render twice on every mount), and the
 * server snapshot (false) is stable across SSR and hydration.
 */
export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, getSnapshot, () => false)
}
