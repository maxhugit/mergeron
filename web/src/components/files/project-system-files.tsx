import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { usePlatformSession } from '@/lib/platform-session';

/** A display preference, never an authorization rule or an extra filesystem permission. */
export function ProjectSystemFiles({ children }: { children: ReactNode }) {
  const { t } = useTranslation('workspaces');
  const session = usePlatformSession();
  const [show, setShow] = useState(false);
  const visible = session.isAdministrator && show;
  return (
    <section className="mx-2 my-2 rounded-lg border border-dashed p-2 text-xs">
      <p className="text-muted-foreground">
        {t(visible ? 'systemFilesVisible' : 'systemFilesHidden')}
      </p>
      {session.isAdministrator && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="mt-1 h-auto whitespace-normal px-1 py-1 text-xs"
          aria-expanded={visible}
          onClick={() => setShow((value) => !value)}
        >
          {t(visible ? 'hideSystemFiles' : 'showSystemFiles')}
        </Button>
      )}
      {visible && (
        <>
          <p className="my-2 text-muted-foreground">
            {t('systemFilesTechnicalHelp')}
          </p>
          {children}
        </>
      )}
    </section>
  );
}
