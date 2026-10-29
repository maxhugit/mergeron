import { publicProxy } from '../../deployment/browser/public-proxy.mjs';
const allowedDomains = (
  process.env.MERGERON_PREVIEW_ALLOWED_DOMAINS ?? ''
).split(',');
if (
  !allowedDomains.length ||
  allowedDomains.length > 32 ||
  allowedDomains.some((d) => !/^[a-z0-9][a-z0-9.-]{1,250}\.[a-z]{2,}$/.test(d))
)
  throw Error('Invalid preview domain allowlist');
const proxy = publicProxy({ allowedDomains });
proxy.listen(3129, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => proxy.close(() => process.exit(0)));
