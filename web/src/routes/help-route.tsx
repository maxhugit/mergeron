import { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Bot,
  ClipboardCheck,
  FolderCog,
  LayoutDashboard,
  ListChecks,
  Settings,
  TimerReset,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { translationKey } from '@/locales/translation-key';
import { cn } from '@/lib/utils';
import { useTimelineStore } from '@/stores/timeline-store';
import { withBasePath } from '@/base-path';

const generalTopics = [
  {
    id: 'projects',
    titleKey: 'guideProjectsTitle',
    paragraphs: ['guideProjectsOverview', 'guideProjectsResources'],
  },
  {
    id: 'documents',
    titleKey: 'guideDocumentsTitle',
    paragraphs: ['guideDocumentsPreview', 'guideDocumentsSafety'],
  },
  {
    id: 'good-practices',
    titleKey: 'guideGoodPracticesTitle',
    paragraphs: ['guideGoodPracticesReview', 'guideGoodPracticesPersistence'],
  },
] as const;

const guideTabs = [
  {
    id: 'general',
    titleKey: 'generalInformation',
    icon: LayoutDashboard,
    topics: generalTopics,
  },
  {
    id: 'conversations',
    titleKey: 'guideConversationsTitle',
    icon: Bot,
    topics: [
      {
        id: 'conversations-module',
        titleKey: 'guideConversationsTitle',
        paragraphs: [
          'guideConversationsTypes',
          'guideConversationsControls',
          'guideConversationsBranches',
        ],
      },
    ],
  },
  {
    id: 'tasks',
    titleKey: 'taskManagers',
    icon: ListChecks,
    topics: [
      {
        id: 'tasks-module',
        titleKey: 'taskManagers',
        paragraphs: [
          'guideTasksStructure',
          'guideTasksViews',
          'guideTasksAgents',
        ],
      },
    ],
  },
  {
    id: 'deliverables',
    titleKey: 'guideDeliverablesTitle',
    icon: ClipboardCheck,
    topics: [
      {
        id: 'deliverables-module',
        titleKey: 'guideDeliverablesTitle',
        paragraphs: [
          'guideDeliverablesStructure',
          'guideDeliverablesDocuments',
          'guideDeliverablesLifecycle',
        ],
      },
    ],
  },
  {
    id: 'automations',
    titleKey: 'automations',
    icon: TimerReset,
    topics: [
      {
        id: 'automations-module',
        titleKey: 'automations',
        paragraphs: ['guideAutomationsManager', 'guideAutomationsRuns'],
      },
    ],
  },
  {
    id: 'project-administration',
    titleKey: 'projectAdministration',
    icon: FolderCog,
    topics: [
      {
        id: 'project-administration-overview',
        titleKey: 'projectAdministration',
        paragraphs: ['guideProjectAdministrationOverview'],
      },
      {
        id: 'people-and-access',
        titleKey: 'guidePeopleAndAccessTitle',
        paragraphs: [
          'guidePeopleAndAccessScope',
          'guidePeopleAndAccessOrganization',
        ],
      },
      {
        id: 'workspaces',
        titleKey: 'guideWorkspacesTitle',
        paragraphs: ['guideWorkspacesStructure', 'guideWorkspacesViews'],
      },
      {
        id: 'knowledge',
        titleKey: 'guideKnowledgeTitle',
        paragraphs: ['guideKnowledgeDocuments', 'guideKnowledgeProposals'],
      },
      {
        id: 'integrations',
        titleKey: 'guideIntegrationsTitle',
        paragraphs: [
          'guideIntegrationsSelection',
          'guideIntegrationsAuthentication',
        ],
      },
    ],
  },
  {
    id: 'administration',
    titleKey: 'guideAdministrationTitle',
    icon: Settings,
    topics: [
      {
        id: 'administration-module',
        titleKey: 'guideAdministrationTitle',
        paragraphs: [
          'guideAdministrationAccount',
          'guideAdministrationSettings',
          'guideAdministrationOperations',
        ],
      },
    ],
  },
] as const;

type GuideTabId = (typeof guideTabs)[number]['id'];

export function HelpRoute() {
  const { t, i18n } = useTranslation();
  const { t: guideT } = useTranslation('guide');
  const [activeTab, setActiveTab] = useState<GuideTabId>('general');
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (panelRef.current) panelRef.current.scrollTop = 0;
  }, [activeTab]);
  const topicPrefix =
    activeTab === 'project-administration'
      ? 'projectAdministration'
      : activeTab;
  const selectThread = useTimelineStore((state) => state.selectThread);
  useEffect(() => {
    selectThread(null);
  }, [selectThread]);
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <article className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="contents">
          <div
            role="tablist"
            aria-label={t('guideSections')}
            className="flex h-10 min-w-0 shrink-0 items-center overflow-x-auto border-b bg-background"
            onKeyDown={(event) => {
              if (
                !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
              )
                return;
              const tabs = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]',
                ),
              ];
              const current = tabs.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const index =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : (current +
                        (event.key === 'ArrowRight' ? 1 : -1) +
                        tabs.length) %
                      tabs.length;
              event.preventDefault();
              tabs[index]?.focus();
              tabs[index]?.click();
            }}
          >
            {guideTabs.map(({ id, titleKey, icon: Icon }) => (
              <button
                key={id}
                id={`guide-tab-${id}`}
                type="button"
                role="tab"
                aria-selected={activeTab === id}
                aria-controls="guide-panel"
                aria-label={t(translationKey(titleKey))}
                title={t(translationKey(titleKey))}
                tabIndex={activeTab === id ? 0 : -1}
                onClick={() => setActiveTab(id)}
                className={cn(
                  'flex h-10 shrink-0 cursor-pointer items-center gap-2 border-b-2 px-3 text-xs transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-[-2px]',
                  activeTab === id
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon aria-hidden="true" className="h-4 w-4" />
                <span className="hidden sm:inline">
                  {t(translationKey(titleKey))}
                </span>
              </button>
            ))}
          </div>

          <div
            id="guide-panel"
            ref={panelRef}
            role="tabpanel"
            aria-labelledby={`guide-tab-${activeTab}`}
            tabIndex={0}
            className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"
          >
            <div className="mx-auto w-full max-w-5xl space-y-4 pb-8">
              <header className="space-y-3 pb-2">
                <BookOpen aria-hidden="true" className="h-7 w-7 text-primary" />
                <h1 className="text-2xl font-semibold tracking-tight">
                  {t('howThePlatformWorks')}
                </h1>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {t('platformGuideIntroduction')}
                </p>
              </header>
              {activeTab === 'general' && (
                <section
                  aria-labelledby="getting-started"
                  className="rounded-xl border bg-card p-4 sm:p-6"
                >
                  <h2 id="getting-started" className="text-lg font-semibold">
                    {t('gettingStarted')}
                  </h2>
                  <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-relaxed">
                    <li>{t('guideGettingStartedCreate')}</li>
                    <li>{t('guideGettingStartedOrganize')}</li>
                    <li>{t('guideGettingStartedConfigure')}</li>
                    <li>{t('guideGettingStartedWork')}</li>
                    <li>{t('guideGettingStartedReview')}</li>
                  </ol>
                </section>
              )}
              <section className="rounded-xl border bg-card p-4 sm:p-6">
                <h2 className="text-lg font-semibold">
                  {guideT('walkthrough')}
                </h2>
                <ol className="mt-3 list-decimal space-y-3 pl-5 text-sm leading-relaxed">
                  {[1, 2, 3].map((number) => (
                    <li key={number}>
                      {guideT(translationKey(`${topicPrefix}Step${number}`))}
                    </li>
                  ))}
                </ol>
                <h3 className="mt-6 font-semibold">{guideT('buttons')}</h3>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b">
                      <tr>
                        <th scope="col" className="min-w-40 py-2 pr-4">
                          {guideT('button')}
                        </th>
                        <th scope="col" className="py-2">
                          {guideT('effect')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {[1, 2, 3].map((number) => (
                        <tr key={number} className="border-b last:border-0">
                          <th
                            scope="row"
                            className="py-3 pr-4 align-top font-medium"
                          >
                            {guideT(
                              translationKey(`${topicPrefix}Button${number}`),
                            )}
                          </th>
                          <td className="py-3 leading-relaxed text-muted-foreground">
                            {guideT(
                              translationKey(`${topicPrefix}Effect${number}`),
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              {(activeTab === 'tasks' || activeTab === 'deliverables') && (
                <section className="space-y-3 rounded-xl border bg-card p-4 sm:p-6">
                  <h2 className="text-lg font-semibold">
                    {guideT('screenshots')}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {guideT('captureNotice')}
                  </p>
                  <figure className="space-y-3">
                    <img
                      className="h-auto w-full rounded-lg border"
                      loading="lazy"
                      src={withBasePath(
                        `/guide/${activeTab}-${i18n.language.startsWith('fr') ? 'fr' : 'en'}.png`,
                      )}
                      alt={guideT(
                        activeTab === 'tasks'
                          ? 'tasksCaption'
                          : 'lifecycleCaption',
                      )}
                    />
                    <figcaption className="text-sm leading-relaxed text-muted-foreground">
                      {guideT(
                        activeTab === 'tasks'
                          ? 'tasksCaption'
                          : 'lifecycleCaption',
                      )}
                    </figcaption>
                  </figure>
                </section>
              )}
              {guideTabs
                .find((tab) => tab.id === activeTab)
                ?.topics.map((topic) => (
                  <section
                    key={topic.id}
                    aria-labelledby={topic.id}
                    className="rounded-xl border bg-card p-4 sm:p-6"
                  >
                    <h2 id={topic.id} className="text-lg font-semibold">
                      {t(translationKey(topic.titleKey))}
                    </h2>
                    {topic.paragraphs.map((paragraphKey) => (
                      <p
                        key={paragraphKey}
                        className="mt-3 text-sm leading-relaxed text-muted-foreground"
                      >
                        {t(translationKey(paragraphKey))}
                      </p>
                    ))}
                  </section>
                ))}
            </div>
          </div>
        </div>
      </article>
    </main>
  );
}
