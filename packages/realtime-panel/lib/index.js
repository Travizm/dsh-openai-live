/**
 * Host half. Deliberately empty: this package exists for its client face, which is discovered by scanning
 * installed packages for `dsh.client`. Named exports, and no default export — a default export makes the
 * Loader discard the namespace, so the plugin loads and contributes nothing.
 */
export const name = 'realtime-panel'

export function apply() {
  // The panel is entirely client-side; the audio face owns the socket, the device and the graph.
}
