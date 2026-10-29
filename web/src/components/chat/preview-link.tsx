import { useContext, type ComponentProps } from 'react';
import { projectsApi } from '@/lib/projects-api';
import { showSnackbar } from '@/stores/snackbar-store';
import { useTranslation } from 'react-i18next';
import {
  PreviewLinkContext,
  couldBePreviewLink,
} from '@/lib/preview-link-context';

export function PreviewLink({ href, children, ...props }: ComponentProps<'a'>) {
  const context = useContext(PreviewLinkContext);
  const { t } = useTranslation('previews');
  return (
    <a
      {...props}
      href={href}
      onClick={
        context && href && couldBePreviewLink(href)
          ? (event) => {
              event.preventDefault();
              // Reserve the native tab synchronously; Safari blocks popups after await.
              const tab = window.open('about:blank', '_blank');
              if (!tab) {
                showSnackbar(t('popupBlocked'), 'error');
                return;
              }
              tab.opener = null;
              const prefix = `/${context.projectId}/agents/${context.threadId}/preview`;
              void (async () => {
                try {
                  const current = await projectsApi<{
                    preview: { ready: boolean; url: string | null } | null;
                  }>(prefix);
                  if (!current.preview?.ready || current.preview.url !== href) {
                    // Unrelated UUID-host link: ordinary navigation, never a capability.
                    tab.location.replace(href);
                    return;
                  }
                  const result = await projectsApi<{ url: string }>(
                    prefix + '/open',
                    { method: 'POST' },
                  );
                  const granted = new URL(result.url),
                    expected = new URL(href);
                  if (
                    granted.origin !== expected.origin ||
                    granted.pathname !== '/.__mergeron_preview/open' ||
                    granted.username ||
                    granted.password
                  )
                    throw Error(t('unavailable'));
                  tab.location.replace(granted.href);
                } catch {
                  tab.close();
                  showSnackbar(t('unavailable'), 'error');
                }
              })();
            }
          : undefined
      }
    >
      {children}
    </a>
  );
}
