import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ECDH } from 'node:crypto';
import type { PlatformIdentity } from '../auth/identity.service';

export function pushPerson(identity?: PlatformIdentity) {
  if (
    !identity?.active ||
    identity.kind !== 'person' ||
    !identity.personId ||
    !identity.role ||
    identity.impersonation
  )
    throw new ForbiddenException('pushPersonalAccountRequired');
  return identity.personId;
}

/** Browser-supplied URLs must never turn the server into an arbitrary HTTP client. */
export function validatePushEndpoint(value: unknown): string {
  try {
    if (typeof value !== 'string' || value.length > 4096) throw Error();
    const url = new URL(value);
    const host = url.hostname;
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port && url.port !== '443')
    )
      throw Error();
    if (
      !(
        host === 'fcm.googleapis.com' ||
        [
          'push.apple.com',
          'push.services.mozilla.com',
          'notify.windows.com',
        ].some((domain) => host === domain || host.endsWith('.' + domain))
      )
    )
      throw Error();
    return url.href;
  } catch {
    throw new BadRequestException('pushInvalidSubscription');
  }
}

export function validateSubscription(body: unknown) {
  const input = body as {
    subscription?: {
      endpoint?: unknown;
      keys?: { p256dh?: unknown; auth?: unknown };
    };
    label?: unknown;
    language?: unknown;
  } | null;
  const endpoint = validatePushEndpoint(input?.subscription?.endpoint);
  const key = (value: unknown, bytes: number) => {
    if (
      typeof value !== 'string' ||
      !/^[\w-]+$/.test(value) ||
      Buffer.from(value, 'base64url').length !== bytes ||
      Buffer.from(value, 'base64url').toString('base64url') !== value
    )
      throw new BadRequestException('pushInvalidSubscription');
    return value;
  };
  const p256dh = key(input?.subscription?.keys?.p256dh, 65);
  const auth = key(input?.subscription?.keys?.auth, 16);
  try {
    ECDH.convertKey(Buffer.from(p256dh, 'base64url'), 'prime256v1');
  } catch {
    throw new BadRequestException('pushInvalidSubscription');
  }
  if (
    typeof input?.label !== 'string' ||
    !input.label.trim() ||
    input.label.length > 80 ||
    [...input.label].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new BadRequestException('pushInvalidDevice');
  return {
    endpoint,
    p256dh,
    auth,
    label: input.label.trim(),
    language: input.language === 'fr' ? 'fr' : 'en',
  };
}

export function validatePushPreferences(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new BadRequestException('pushInvalidPreferences');
  const input = body as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !['completed', 'approvals', 'questions'].includes(key),
    ) ||
    Object.values(input).some((value) => typeof value !== 'boolean')
  )
    throw new BadRequestException('pushInvalidPreferences');
  return input as Partial<
    Record<'completed' | 'approvals' | 'questions', boolean>
  >;
}
