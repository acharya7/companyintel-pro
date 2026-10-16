import { useSyncExternalStore } from "react";

/** Never notifies: hydration state changes exactly once, when React takes over. */
const subscribe = () => () => {};

/**
 * True once the client has hydrated, false during SSR and the hydration render.
 *
 * Replaces the `useEffect(() => setMounted(true), [])` idiom, which renders
 * twice on every mount and is flagged by `react-hooks/set-state-in-effect`.
 * Components use it to avoid rendering theme/`window`-dependent markup before
 * hydration, where a server/client mismatch would otherwise be possible.
 */
export function useHydrated() {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
