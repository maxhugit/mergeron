export const MOCKUP_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'";
/** The receiver authorizes no action: this protocol can only show a local error. */
export function validMockupMessage(
  event: MessageEvent,
  source: Window | null,
  session: string,
): boolean {
  if (!source || event.source !== source || event.origin !== 'null')
    return false;
  const d = event.data;
  return (
    d !== null &&
    typeof d === 'object' &&
    !Array.isArray(d) &&
    Object.keys(d).length === 3 &&
    d.type === 'mergeron.mockup.error' &&
    d.session === session &&
    d.message === 'scriptError'
  );
}
export function mockupSource(html: string, session: string): string {
  const channel = JSON.stringify(session).replaceAll('<', '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${MOCKUP_CSP}"><meta name="referrer" content="no-referrer"><script>const report=()=>parent.postMessage({type:'mergeron.mockup.error',session:${channel},message:'scriptError'},'*');addEventListener('error',report);addEventListener('unhandledrejection',report);addEventListener('click',e=>{const a=e.target.closest?.('a');if(a&&a.getAttribute('href')&&!a.getAttribute('href').startsWith('#'))e.preventDefault()},true);</script></head><body>${html}</body></html>`;
}
