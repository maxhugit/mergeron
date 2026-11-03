/** One stable media element, independently of subtitle loading and processing jobs. */
import {
  memo,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FileTranscriptionPanel } from '../../transcriptions/file-transcription-panel';
import {
  activeCue,
  cueAtOrBefore,
  MAX_SRT_BYTES,
  parseSrt,
  subtitleTime,
  type SubtitleCue,
} from '@/lib/srt';
import { cn } from '@/lib/utils';
import { buildPreviewUrl, type PreviewSource } from './preview-source';
import { SubtitlePicker } from './subtitle-picker';
import { readSiblingSrt, readSrtSource } from './video-subtitles';

function subtitleErrorCode(cause: unknown) {
  return cause instanceof Error &&
    ['tooLarge', 'invalid'].includes(cause.message)
    ? cause.message
    : 'loadFailed';
}

export function VideoViewer({ source }: { source: PreviewSource }) {
  const key = JSON.stringify(
    source.kind === 'file'
      ? ['file', source.filePath]
      : ['archive', source.archivePath, source.entryPath],
  );
  return <VideoSession key={key} source={source} />;
}
const MediaPlayer = memo(function MediaPlayer({
  source,
  mediaRef,
  onTime,
  onError,
}: {
  source: PreviewSource;
  mediaRef: React.RefObject<HTMLVideoElement | null>;
  onTime: (time: number) => void;
  onError: () => void;
}) {
  return (
    <div className="h-[min(40vh,24rem)] min-h-32 w-full shrink-0 overflow-hidden bg-black">
      <video
        ref={mediaRef}
        src={buildPreviewUrl(source)}
        controls
        playsInline
        className="block h-full w-full object-contain"
        onTimeUpdate={(event) => onTime(event.currentTarget.currentTime)}
        onSeeked={(event) => onTime(event.currentTarget.currentTime)}
        onError={onError}
      />
    </div>
  );
});
function VideoSession({ source }: { source: PreviewSource }) {
  const { t } = useTranslation('transcription');
  const [initialSource] = useState(source);
  const video = useRef<HTMLVideoElement>(null),
    picker = useRef<HTMLInputElement>(null),
    activeRow = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const [controllers] = useState(() => new Set<AbortController>());
  const [pickerOpen, setPickerOpen] = useState(false);
  const request = useRef(0),
    automatic = useRef<AbortController | null>(null);
  const [error, setError] = useState(false),
    [cues, setCues] = useState<SubtitleCue[]>([]),
    [subtitleError, setSubtitleError] = useState(''),
    [loading, setLoading] = useState(true),
    [name, setName] = useState('');
  const [time, setTime] = useState(0),
    [tab, setTab] = useState<'subtitles' | 'processing'>('subtitles'),
    [processingOpened, setProcessingOpened] = useState(false),
    [page, setPage] = useState(0),
    [follow, setFollow] = useState(true);
  const handleVideoError = useCallback(() => setError(true), []);
  const index = activeCue(cues, time),
    currentPage = follow
      ? Math.floor(
          Math.max(0, index >= 0 ? index : cueAtOrBefore(cues, time)) / 200,
        )
      : page;
  const filePath =
    initialSource.kind === 'file'
      ? initialSource.filePath
      : initialSource.entryPath;
  useEffect(() => {
    const controller = new AbortController(),
      id = ++request.current;
    alive.current = true;
    controllers.add(controller);
    automatic.current = controller;
    void readSiblingSrt(initialSource, controller.signal)
      .then((text) => {
        if (controller.signal.aborted || request.current !== id) return;
        if (text !== null) {
          setCues(parseSrt(text));
          setName(
            filePath
              .split('/')
              .pop()
              ?.replace(/\.[^.]+$/, '.srt') ?? '',
          );
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted && request.current === id)
          setSubtitleError(subtitleErrorCode(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted && request.current === id)
          setLoading(false);
      });
    return () => {
      alive.current = false;
      for (const pending of controllers) pending.abort();
    };
  }, [initialSource, filePath, controllers]);
  useEffect(() => {
    if (follow && index >= 0) {
      if (tab === 'subtitles')
        activeRow.current?.scrollIntoView({
          block: 'nearest',
          behavior: 'instant',
        });
    }
  }, [index, follow, tab]);
  const load = async (file: File) => {
    automatic.current?.abort();
    const id = ++request.current;
    setLoading(true);
    setSubtitleError('');
    try {
      if (file.size > MAX_SRT_BYTES) throw new Error('tooLarge');
      if (!/\.srt$/i.test(file.name)) throw new Error('invalid');
      const parsed = parseSrt(await file.text());
      if (!alive.current || request.current !== id) return;
      setCues(parsed);
      setName(file.name);
      setPage(0);
      setFollow(true);
      setTab('subtitles');
    } catch (cause) {
      if (alive.current && request.current === id)
        setSubtitleError(subtitleErrorCode(cause));
    } finally {
      if (alive.current && request.current === id) setLoading(false);
    }
  };
  const loadWorkspace = async (chosen: PreviewSource, label: string) => {
    automatic.current?.abort();
    const controller = new AbortController();
    controllers.add(controller);
    automatic.current = controller;
    const id = ++request.current;
    setLoading(true);
    setSubtitleError('');
    try {
      const text = await readSrtSource(chosen, controller.signal);
      if (text === null) throw new Error('loadFailed');
      const parsed = parseSrt(text);
      if (!alive.current || request.current !== id) return;
      setCues(parsed);
      setName(label);
      setPage(0);
      setFollow(true);
      setTab('subtitles');
    } catch (cause) {
      if (alive.current && request.current === id && !controller.signal.aborted)
        setSubtitleError(subtitleErrorCode(cause));
    } finally {
      controllers.delete(controller);
      if (alive.current && request.current === id) setLoading(false);
    }
  };
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-hidden p-3">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t('subtitles.videoError')}
        </p>
      )}
      <MediaPlayer
        source={initialSource}
        mediaRef={video}
        onTime={setTime}
        onError={handleVideoError}
      />
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={tab === 'subtitles' ? 'default' : 'outline'}
          aria-pressed={tab === 'subtitles'}
          onClick={() => setTab('subtitles')}
        >
          {t('subtitles.title')}
        </Button>
        <Button
          size="sm"
          variant={tab === 'processing' ? 'default' : 'outline'}
          aria-pressed={tab === 'processing'}
          onClick={() => {
            setProcessingOpened(true);
            setTab('processing');
          }}
        >
          {t('title')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
          {t('subtitles.load')}
        </Button>
        <input
          ref={picker}
          type="file"
          accept=".srt,application/x-subrip"
          className="hidden"
          aria-label={t('subtitles.localFile')}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void load(file);
          }}
        />
      </div>
      <SubtitlePicker
        source={initialSource}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onLocal={() => {
          setPickerOpen(false);
          picker.current?.click();
        }}
        onChoose={(chosen, label) => {
          setPickerOpen(false);
          void loadWorkspace(chosen, label);
        }}
      />
      <section
        hidden={tab !== 'subtitles'}
        aria-label={t('subtitles.title')}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-lg border p-3"
      >
        {loading && (
          <p role="status" className="text-sm">
            {t('subtitles.loading')}
          </p>
        )}
        {subtitleError && (
          <p role="alert" className="text-sm text-destructive">
            {subtitleError === 'tooLarge'
              ? t('subtitles.tooLarge')
              : subtitleError === 'invalid'
                ? t('subtitles.invalid')
                : t('subtitles.loadFailed')}
          </p>
        )}
        {!loading && !cues.length && !subtitleError && (
          <p className="text-sm text-muted-foreground">
            {t('subtitles.empty')}
          </p>
        )}
        {!!cues.length && (
          <>
            <div className="sticky top-0 z-10 mb-2 flex flex-wrap items-center gap-2 bg-background py-1 text-xs">
              <span className="min-w-0 break-words">{name}</span>
              <Button
                size="sm"
                variant="outline"
                aria-pressed={follow}
                onClick={() => {
                  setPage(Math.max(0, Math.floor(index / 200)));
                  setFollow((value) => !value);
                }}
              >
                {t('subtitles.follow')}
              </Button>
              {cues.length > 200 && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!currentPage}
                    onClick={() => {
                      setFollow(false);
                      setPage(currentPage - 1);
                    }}
                  >
                    {t('previous')}
                  </Button>
                  <span>
                    {currentPage + 1} / {Math.ceil(cues.length / 200)}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={(currentPage + 1) * 200 >= cues.length}
                    onClick={() => {
                      setFollow(false);
                      setPage(currentPage + 1);
                    }}
                  >
                    {t('next')}
                  </Button>
                </>
              )}
            </div>
            <ol className="space-y-1">
              {cues
                .slice(currentPage * 200, (currentPage + 1) * 200)
                .map((cue, offset) => {
                  const selected = currentPage * 200 + offset === index;
                  return (
                    <li key={currentPage * 200 + offset}>
                      <button
                        ref={selected ? activeRow : undefined}
                        type="button"
                        aria-current={selected ? 'true' : undefined}
                        className={cn(
                          'w-full rounded-md border border-transparent p-2 text-left text-sm hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring',
                          selected && 'border-primary bg-accent font-medium',
                        )}
                        onClick={() => {
                          if (video.current) {
                            video.current.currentTime = cue.start;
                            setTime(cue.start);
                          }
                        }}
                      >
                        <span className="mr-2 text-xs text-muted-foreground">
                          {subtitleTime(cue.start)}{' '}
                        </span>
                        <span className="whitespace-pre-wrap break-words">
                          {cue.text}
                        </span>
                      </button>
                    </li>
                  );
                })}
            </ol>
          </>
        )}
      </section>
      {processingOpened && (
        <div
          hidden={tab !== 'processing'}
          className="min-h-0 flex-1 overflow-hidden"
        >
          <Suspense fallback={<p role="status">{t('subtitles.loading')}</p>}>
            <FileTranscriptionPanel source={source} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
