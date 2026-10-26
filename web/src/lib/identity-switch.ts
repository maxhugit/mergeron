import { resetSocket } from '@/socket';
import { withBasePath } from '@/base-path';

/** Discard cached data and reconnect under the server-authenticated identity. */
export function reloadIdentity() {
  resetSocket();
  try {
    localStorage.setItem('mergeron.identity-switch', String(Date.now()));
  } catch {
    /* private browsing */
  }
  window.location.assign(withBasePath('/'));
}
