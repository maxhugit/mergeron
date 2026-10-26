/** Full document reload (not just React queries), preserving route and session.
 * Navigation is never intercepted by our service worker. New HTML references
 * content-hashed assets, so no cache, local storage or authentication is erased.
 */
export function reloadApplication() {
  window.location.reload();
}
