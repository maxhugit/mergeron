import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  readPresentation,
  writePresentation,
  presentationKey,
  type PresentationState,
} from '@/lib/mockup-presentation';
import type { MockupReference } from '@/lib/mockups';
import { MockupFrame } from './mockup-frame';
export function RememberedMockupFrame({
  reference,
  html,
  owner,
}: {
  reference: MockupReference;
  html: string;
  owner: string | null;
}) {
  const { t } = useTranslation('mockups');
  const key = owner
    ? presentationKey(
        owner,
        reference.projectId,
        reference.threadId,
        reference.id,
        reference.revision,
      )
    : null;
  const [saved] = useState(() =>
    key ? readPresentation(key) : { enabled: false, state: null },
  );
  const [remember, setRemember] = useState(saved.enabled);
  const [initial, setInitial] = useState(saved.state);
  const [epoch, setEpoch] = useState(0);
  const [failure, setFailure] = useState(false);
  const latest = useRef(saved.state);
  const receive = useCallback(
    (state: PresentationState) => {
      latest.current = state;
      if (remember && key && !writePresentation(key, state, true))
        setFailure(true);
    },
    [remember, key],
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      {key && (
        <label
          className="mb-2 flex shrink-0 items-center gap-2 text-xs text-muted-foreground"
          title={t('rememberHint')}
        >
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => {
              const enabled = event.target.checked;
              if (
                !writePresentation(
                  key,
                  enabled ? latest.current : null,
                  enabled,
                )
              ) {
                setFailure(true);
                return;
              }
              setFailure(false);
              if (!enabled) latest.current = null;
              setRemember(enabled);
              setInitial(enabled ? latest.current : null);
              setEpoch((n) => n + 1);
            }}
          />
          {t('remember')}
        </label>
      )}
      {failure && (
        <p role="status" className="mb-2 text-xs text-destructive">
          {t('storageError')}
        </p>
      )}
      <div className="min-h-0 flex-1">
        <MockupFrame
          key={epoch}
          html={html}
          title={reference.title}
          initialState={initial}
          onPresentation={receive}
        />
      </div>
    </div>
  );
}
