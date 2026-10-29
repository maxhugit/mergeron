/** Untrusted previews are sibling hosts. They must not plant parent-domain
 * cookies that can shadow a Mergeron login, OIDC flow or impersonation cookie.
 * Enabling previews intentionally requires one fresh login for legacy cookies.
 */
export function platformCookie(name: string) {
  return process.env.MERGERON_PREVIEWS_ENABLED === 'true'
    ? '__Host-' + name
    : name;
}
export function platformCookiePath(normal: string) {
  return process.env.MERGERON_PREVIEWS_ENABLED === 'true' ? '/' : normal;
}
