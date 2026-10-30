import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { TurnItem } from '@/types/timeline';
import {
  resolveFileReferencePath,
  type FileReference,
} from '@/lib/file-references';
import { requestOpenFile } from '@/lib/open-file-request';
import { showSnackbar } from '@/stores/snackbar-store';
import { useComposerDraftStore } from '@/stores/composer-draft-store';
import { Button } from '@/components/ui/button';
import { useTimelineStore } from '@/stores/timeline-store';
import { MarkdownRenderer } from '../markdown-renderer';

interface Props {
  item: Extract<TurnItem, { type: 'agentMessage' }>;
  threadId?: string | null;
}

export function AgentMessageItem({ item, threadId: ownerThreadId }: Props) {
  const { t } = useTranslation();
  // Resolution is bound here rather than inside the renderer: this component is
  // the lowest one that already belongs to a specific conversation, so the
  // renderer stays free of stores, routing and working directories, and no
  // callback has to be threaded down through the turn-rendering chain.
  const selectedThreadId = useTimelineStore((s) => s.threadId);
  const threadId = ownerThreadId ?? selectedThreadId;
  const threadCwd = useTimelineStore((s) => s.threadCwd);

  const handleOpenFileReference = useCallback(
    (reference: FileReference) => {
      const absolutePath = resolveFileReferencePath(reference.path, threadCwd);
      if (!absolutePath) {
        // A relative path with no conversation directory has no honest
        // resolution; guessing one would open some unrelated file.
        showSnackbar(
          t('cannotResolveThisPathTheConversationHasNoDirectory'),
          'error',
        );
        return;
      }
      requestOpenFile({
        path: absolutePath,
        line: reference.line,
        sourceThreadId: threadId,
      });
    },
    [threadCwd, threadId, t],
  );

  return (
    <div>
      <MarkdownRenderer
        copyResponse
        content={item.content}
        completed={item.completed}
        onOpenFileReference={handleOpenFileReference}
      />
      {item.questions.length > 0 && (
        <div
          data-agent-questions
          className="mt-3 space-y-3 rounded-lg border border-border p-3 text-sm"
        >
          <p className="text-xs text-muted-foreground">
            {t('questionReplyHint')}
          </p>
          {item.questions.map((question, questionIndex) => (
            <div key={`${question.title}-${questionIndex}`}>
              <div className="font-medium">{question.title}</div>
              {question.options && question.options.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {question.options.map((option, optionIndex) => (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto min-h-10 max-w-full justify-start whitespace-normal break-words px-3 py-2 text-left"
                      disabled={!threadId}
                      key={`${option}-${optionIndex}`}
                      onClick={() => {
                        if (!threadId) return;
                        const reply = `${question.title}\n${option}`;
                        useComposerDraftStore
                          .getState()
                          .setText(threadId, (text) =>
                            text === reply || text.endsWith(`\n\n${reply}`)
                              ? text
                              : text
                                ? `${text}\n\n${reply}`
                                : reply,
                          );
                      }}
                    >
                      {option}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
