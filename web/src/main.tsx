import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { queryClient } from './lib/query-client';
import { configureApiClient } from './api-client';
import { router } from './routes/router';
import { useThemeStore } from './stores/theme-store';
import { installMobileViewportFixes } from './lib/mobile-viewport';
import { i18nReady } from './i18n';
import { initializePwaInstall } from './lib/pwa-install';
import { installSessionRecovery } from './lib/session-recovery';
import './index.css';
import { finishApplicationReload } from './lib/reload-application';

finishApplicationReload();
installSessionRecovery();
configureApiClient();
installMobileViewportFixes();
initializePwaInstall();

// Install only the static-asset service worker. API responses, conversations,
// files and authentication pages deliberately remain network-only.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const serviceWorkerUrl = new URL('sw.js', document.baseURI);
    void navigator.serviceWorker
      .register(serviceWorkerUrl.pathname, { updateViaCache: 'none' })
      .catch(() => {
        // PWA support is progressive: a registration failure must not prevent
        // the authenticated application from starting.
      });
  });
}

// Apply persisted theme before first render to avoid flash
document.documentElement.classList.toggle(
  'dark',
  useThemeStore.getState().dark,
);

void i18nReady.then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
});
