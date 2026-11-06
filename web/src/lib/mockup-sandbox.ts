import {
  MAX_PRESENTATION_BYTES,
  presentationState,
  type PresentationState,
} from './mockup-presentation';
export const MOCKUP_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'";
export type MockupMessage =
  | { kind: 'error' }
  | { kind: 'presentation'; state: PresentationState };
/** Data only: no received message can authorize an action or call a server/agent tool. */
export function readMockupMessage(
  event: MessageEvent,
  source: Window | null,
  session: string,
): MockupMessage | undefined {
  if (!source || event.source !== source || event.origin !== 'null') return;
  const d: unknown = event.data;
  if (
    !d ||
    typeof d !== 'object' ||
    Array.isArray(d) ||
    Object.keys(d).length !== 3
  )
    return;
  const data = d as Record<string, unknown>;
  if (data.session !== session) return;
  if (data.type === 'mergeron.mockup.error' && data.message === 'scriptError')
    return { kind: 'error' };
  if (
    data.type !== 'mergeron.mockup.presentation' ||
    typeof data.value !== 'string' ||
    data.value.length > MAX_PRESENTATION_BYTES ||
    new TextEncoder().encode(data.value).byteLength > MAX_PRESENTATION_BYTES
  )
    return;
  try {
    const state = presentationState(JSON.parse(data.value));
    return state ? { kind: 'presentation', state } : undefined;
  } catch {
    return;
  }
}
export function validMockupMessage(
  event: MessageEvent,
  source: Window | null,
  session: string,
): boolean {
  return readMockupMessage(event, source, session)?.kind === 'error';
}
const inlineJson = (value: unknown) =>
  JSON.stringify(value).replaceAll('<', '\\u003c');
export function mockupSource(
  html: string,
  session: string,
  initialState: PresentationState | null = null,
): string {
  const channel = inlineJson(session),
    state = inlineJson(
      initialState && presentationState(initialState) ? initialState : null,
    );
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${MOCKUP_CSP}"><meta name="referrer" content="no-referrer"><script>(function(){let state=${state};const session=${channel};const report=()=>parent.postMessage({type:'mergeron.mockup.error',session,message:'scriptError'},'*');Object.defineProperty(window,'mergeronMockup',{value:Object.freeze({getState:()=>state===null?null:JSON.parse(JSON.stringify(state)),setState:value=>{try{if(!value||typeof value!=='object'||Array.isArray(value))return false;const raw=JSON.stringify(value);if(new TextEncoder().encode(raw).byteLength>${MAX_PRESENTATION_BYTES})return false;state=JSON.parse(raw);parent.postMessage({type:'mergeron.mockup.presentation',session,value:raw},'*');return true}catch{return false}}})});addEventListener('error',report);addEventListener('unhandledrejection',report);addEventListener('click',e=>{const a=e.target.closest?.('a');if(a&&a.getAttribute('href')&&!a.getAttribute('href').startsWith('#'))e.preventDefault()},true)})();</script></head><body>${html}</body></html>`;
}
