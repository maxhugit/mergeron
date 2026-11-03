import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { filesReadTreeOptions } from '@/generated/api/@tanstack/react-query.gen';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { PreviewSource } from './preview-source';
export function SubtitlePicker({
  source,
  open,
  onOpenChange,
  onChoose,
  onLocal,
}: {
  source: PreviewSource;
  open: boolean;
  onOpenChange: (value: boolean) => void;
  onChoose: (source: PreviewSource, label: string) => void;
  onLocal: () => void;
}) {
  const { t } = useTranslation('transcription');
  const directory =
    source.kind === 'file'
      ? source.filePath.slice(0, source.filePath.lastIndexOf('/')) || '/'
      : '';
  const listing = useQuery({
    ...filesReadTreeOptions({ query: { root: directory } }),
    enabled: open && source.kind === 'file',
    retry: false,
  });
  const files = listing.isError
    ? []
    : (listing.data?.filter(
        (file) => file.type === 'file' && /\.srt$/i.test(file.name),
      ) ?? []);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('subtitles.load')}</DialogTitle>
          <DialogDescription>
            {t('subtitles.chooseDescription')}
          </DialogDescription>
        </DialogHeader>
        {source.kind === 'file' && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">{t('subtitles.inFolder')}</h3>
            {listing.isPending && <p role="status">{t('subtitles.loading')}</p>}
            {listing.isError && (
              <p role="alert" className="text-sm text-destructive">
                {t('subtitles.listFailed')}
              </p>
            )}
            {!listing.isPending && !listing.isError && !files.length && (
              <p className="text-sm text-muted-foreground">
                {t('subtitles.noOtherFile')}
              </p>
            )}
            {files.map((file) => (
              <Button
                key={file.path}
                className="h-auto w-full justify-start whitespace-normal break-all text-left"
                variant="outline"
                onClick={() =>
                  onChoose({ kind: 'file', filePath: file.path }, file.name)
                }
              >
                {file.name}
              </Button>
            ))}
          </div>
        )}
        <Button variant="outline" onClick={onLocal}>
          {t('subtitles.localFile')}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
