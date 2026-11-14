Mergeron — Next.js Webpack development diagnostics

Tested with Next.js 16.4.6 and React 19.3.1. Plain CSS only; CSS modules,
preprocessors and Turbopack are not confirmed by this adapter. This is an
explicit development integration, not a production or standalone server.

Keep the five preview-next-* files together in the project. No dependency
is added to the application. Next.js must already be installed.

1. In next.config.mjs, preserve the existing settings and wrap the configuration:

   import { withMergeronPreview } from './preview-next-config.mjs';
   export default withMergeronPreview({
     // Keep the project's existing settings here.
   });

   In this development recipe, the adapter adds only the exact public hostname
   supplied by Mergeron Manager to allowedDevOrigins. Existing origins and
   webpack configuration are preserved. No wildcard or global CORS change.

2. Add the compilation marker to app/layout.js (inside <head>), or the equivalent
   Pages Router document:

   <meta name="mergeron-preview-generation"
     content={process.env.MERGERON_PREVIEW_BUILD_GENERATION} />

3. In Mergeron's approved development recipe, use:

   node preview-next-server.mjs

   Mergeron supplies NODE_ENV=development, PORT and the receipt path. The helper
   refuses a production mode and explicitly selects Webpack. It does not change
   privileges, quotas, dependencies or the application's authentication.
   Adjust the working directory if the application lives in a subdirectory.

4. Open the authorized preview verification page from Mergeron. Choose a visible
   selector, a CSS property and its expected value. Start observation, modify
   plain CSS and synchronize. Check detection, the actual Next HMR socket through
   the proxy and the computed style. A transfer receipt or HTTP 200 alone is not
   compilation evidence. Other bundlers/versions/protocols remain unverified
   unless the observed evidence matches. The adapter does not apply code updates
   itself: Next's own client continues to handle them.
