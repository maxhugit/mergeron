import { FileTranscriptionPanel } from '../../transcriptions/file-transcription-panel';
/** Native audio preview using the authenticated preview URL. */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buildPreviewUrl, type PreviewSource } from './preview-source';

interface Props {
  source: PreviewSource;
}

/** Stable key for render-phase state reset when source changes. */
function sourceKey(source: PreviewSource): string {
  return source.kind === 'file'
    ? source.filePath
    : `${source.archivePath}:${source.entryPath}`;
}

export function AudioViewer({ source }: Props) {
  const { t } = useTranslation();
  const [error, setError] = useState(false);
  const key = sourceKey(source);

  // Reset error when source changes (adjusting state during render)
  const [prevKey, setPrevKey] = useState(key);
  if (key !== prevKey) {
    setPrevKey(key);
    setError(false);
  }

  return (
    <div className="flex h-full min-h-0 flex-col items-center gap-3 p-3">
      {error && (
        <p role="alert" className="text-sm text-muted-foreground">
          {t('failedToLoadAudio')}
        </p>
      )}
      <audio
        key={key}
        src={buildPreviewUrl(source)}
        controls
        className="w-full max-w-xl"
        onError={() => setError(true)}
      />
      <FileTranscriptionPanel key={key} source={source} />
    </div>
  );
}
