import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Tooltip, Willow, WillowDark, type IApi } from '@svar-ui/react-gantt';
import { Locale } from '@svar-ui/react-core';
import { usePeople, useParticipants, personLabel } from '@/lib/people-api';
import { ResponsiblePerson } from './people-manager';
import { StableProjectGantt } from './stable-project-gantt';
import { TaskManagerToolbar } from './task-manager-toolbar';
import '@svar-ui/react-gantt/all.css';
import {
  Bot,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock3,
  FolderOpen,
  Maximize2,
  GripVertical,
  Hand,
  ListFilter,
  Loader2,
  PackageOpen,
  Pencil,
  Play,
  Plus,
  Sparkles,
  TriangleAlert,
  Trash2,
} from 'lucide-react';
import {
  type DragEvent as ReactDragEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { VoiceDictationButton } from '@/components/chat/voice-dictation-button';
import { DirectorySelectionTree } from '@/components/files/directory-selection-tree';
import { threadsStartThread, threadsStartTurn } from '@/generated/api/sdk.gen';
import { useThemeStore } from '@/stores/theme-store';
import { englishGanttLocale, frenchGanttLocale } from '@/lib/gantt-locales';
import {
  projectsApi,
  projectsQueryKey,
  type ProjectSummary,
  type ProjectTaskBoard,
  type ProjectTaskStatusSummary,
  type ProjectTaskSummary,
} from '@/lib/projects-api';
import type { DeliverablesBoard } from '@/lib/deliverables-api';

type Draft = {
  assigneeId: string;
  title: string;
  description: string;
  priority: ProjectTaskSummary['priority'];
  startAt: string;
  dueAt: string;
  labels: string;
  statusId: string;
  workspacePath: string;
  executionMode: 'manual' | 'agent';
  estimateHours: string;
  progress: string;
  validationCriteria: string;
  linkedFilePath: string;
  parentTaskId: string;
  subtaskStatus: ProjectTaskSummary['subtaskStatus'];
  dependencyIds: string[];
};
type Suggestion = {
  title: string;
  description: string;
  priority: string;
  estimateHours: number;
  validationCriteria: string;
  parentTitle: string;
  dependsOnTitles: string[];
  executionMode: 'manual' | 'agent';
  assignmentReason: string;
  labels: string[];
};
type AdviceResult = {
  summary: string;
  health: 'good' | 'watch' | 'at_risk';
  advice: Array<{
    severity: 'alert' | 'recommendation' | 'opportunity' | 'info';
    title: string;
    description: string;
    taskIds: string[];
  }>;
  work: Array<{
    taskId: string;
    recommendedMinutes: number;
    reason: string;
  }>;
};
type ReplanSuggestion = {
  taskId: string;
  priority: ProjectTaskSummary['priority'];
  estimateHours: number;
  startAt: number | null;
  dueAt: number | null;
  dependencyIds: string[];
  reason: string;
};
type GanttView = 'years' | 'months' | 'weeks' | 'fit';
type GanttDisplay = {
  scales: Array<{ unit: string; step: number; format: string }>;
  cellWidth: number;
};
const emptyDraft: Draft = {
  assigneeId: '',
  title: '',
  description: '',
  priority: 'normal',
  startAt: '',
  dueAt: '',
  labels: '',
  statusId: '',
  workspacePath: '',
  executionMode: 'manual',
  estimateHours: '',
  progress: '0',
  validationCriteria: '',
  linkedFilePath: '',
  parentTaskId: '',
  subtaskStatus: 'todo',
  dependencyIds: [],
};
const subtaskLabels: Record<ProjectTaskSummary['subtaskStatus'], string> = {
  todo: 'À faire',
  started: 'Commencée',
  review: 'À valider',
  done: 'Terminée',
  cancelled: 'Annulée',
};
const palette = {
  slate: '#64748b',
  blue: '#3b82f6',
  amber: '#f59e0b',
  red: '#ef4444',
  green: '#22c55e',
  purple: '#a855f7',
  teal: '#14b8a6',
  pink: '#ec4899',
} as const;
type PaletteColor = keyof typeof palette;
type TaskBoardSettings = {
  priorityOptions: Array<{ id: string; name: string; color: PaletteColor }>;
  subtaskColors: Record<ProjectTaskSummary['subtaskStatus'], PaletteColor>;
  defaultStatusId: string;
  defaultPriority: string;
  confirmDelete: boolean;
  hiddenEmptyStatusIds: string[];
  terminalStatusIds: string[] | null;
  terminalSubtaskStatuses: ProjectTaskSummary['subtaskStatus'][];
  labels: Array<{ id: string; name: string; color: PaletteColor }>;
};
const defaultTaskBoardSettings: TaskBoardSettings = {
  priorityOptions: [
    { id: 'low', name: 'Basse', color: 'green' },
    { id: 'normal', name: 'Normale', color: 'blue' },
    { id: 'high', name: 'Haute', color: 'amber' },
    { id: 'urgent', name: 'Urgente', color: 'red' },
  ],
  subtaskColors: {
    todo: 'slate',
    started: 'blue',
    review: 'purple',
    done: 'green',
    cancelled: 'slate',
  },
  defaultStatusId: '',
  defaultPriority: 'normal',
  confirmDelete: true,
  hiddenEmptyStatusIds: [],
  terminalStatusIds: null,
  terminalSubtaskStatuses: ['done', 'cancelled'],
  labels: [],
};
const paletteColor = (value: unknown, fallback: PaletteColor): PaletteColor =>
  typeof value === 'string' && value in palette
    ? (value as PaletteColor)
    : fallback;
function readTaskBoardSettings(
  config: Record<string, unknown>,
): TaskBoardSettings {
  const raw =
    config.taskBoardSettings &&
    typeof config.taskBoardSettings === 'object' &&
    !Array.isArray(config.taskBoardSettings)
      ? (config.taskBoardSettings as Partial<TaskBoardSettings>)
      : {};
  const legacyPriorityColors = (
    raw as { priorityColors?: Record<string, unknown> }
  ).priorityColors;
  const priorityOptions = Array.isArray(raw.priorityOptions)
    ? raw.priorityOptions
        .filter(
          (
            option,
          ): option is { id: string; name: string; color: PaletteColor } =>
            Boolean(
              option &&
              typeof option.id === 'string' &&
              option.id.trim() &&
              typeof option.name === 'string' &&
              option.name.trim() &&
              typeof option.color === 'string' &&
              option.color in palette,
            ),
        )
        .map((option) => ({ ...option, name: option.name.trim() }))
    : defaultTaskBoardSettings.priorityOptions.map((option) => ({
        ...option,
        color: paletteColor(legacyPriorityColors?.[option.id], option.color),
      }));
  const subtaskColors = (raw.subtaskColors ?? {}) as Partial<
    TaskBoardSettings['subtaskColors']
  >;
  return {
    ...defaultTaskBoardSettings,
    ...raw,
    priorityOptions,
    subtaskColors: Object.fromEntries(
      Object.entries(defaultTaskBoardSettings.subtaskColors).map(
        ([key, fallback]) => [
          key,
          paletteColor(
            subtaskColors[key as ProjectTaskSummary['subtaskStatus']],
            fallback,
          ),
        ],
      ),
    ) as TaskBoardSettings['subtaskColors'],
    terminalStatusIds: Array.isArray(raw.terminalStatusIds)
      ? raw.terminalStatusIds.filter(
          (id): id is string => typeof id === 'string',
        )
      : null,
    terminalSubtaskStatuses: [
      'done',
      'cancelled',
    ] as ProjectTaskSummary['subtaskStatus'][],
    defaultPriority:
      raw.defaultPriority &&
      priorityOptions.some((p) => p.id === raw.defaultPriority)
        ? raw.defaultPriority
        : (priorityOptions[0]?.id ?? 'normal'),
    defaultStatusId:
      typeof raw.defaultStatusId === 'string' ? raw.defaultStatusId : '',
    confirmDelete: raw.confirmDelete !== false,
    hiddenEmptyStatusIds: Array.isArray(raw.hiddenEmptyStatusIds)
      ? raw.hiddenEmptyStatusIds.filter(
          (id): id is string => typeof id === 'string',
        )
      : [],
    labels: Array.isArray(raw.labels)
      ? raw.labels
          .filter(
            (
              label,
            ): label is { id: string; name: string; color: PaletteColor } =>
              Boolean(
                label &&
                typeof label.id === 'string' &&
                typeof label.name === 'string' &&
                label.name.trim() &&
                typeof label.color === 'string' &&
                label.color in palette,
              ),
          )
          .map((label) => ({ ...label, name: label.name.trim() }))
      : [],
  } satisfies TaskBoardSettings;
}
const dateValue = (value: number | null) =>
  value ? new Date(value).toISOString().slice(0, 10) : '';

export function ProjectTaskManager({
  projectId,
  resourceId,
  initialTaskId,
  modalOnly = false,
  onModalClose,
}: {
  projectId: string;
  resourceId: string;
  initialTaskId?: string;
  modalOnly?: boolean;
  onModalClose?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const people = usePeople();
  const participants = useParticipants(projectId);
  const client = useQueryClient();
  const navigate = useNavigate();
  const dark = useThemeStore((state) => state.dark);
  const GanttTheme = dark ? WillowDark : Willow;
  const ganttFrench = i18n.language.startsWith('fr');
  const ganttLocale = ganttFrench ? frenchGanttLocale : englishGanttLocale;
  const key = ['project-resource', projectId, resourceId];
  const query = useQuery({
    queryKey: key,
    queryFn: () =>
      projectsApi<ProjectTaskBoard>(`/${projectId}/resources/${resourceId}`),
    refetchInterval: 5000,
  });
  const projects = useQuery({
    queryKey: projectsQueryKey,
    queryFn: () => projectsApi<{ projects: ProjectSummary[] }>(),
  });
  const deliverableResource = projects.data?.projects
    .find((project) => project.id === projectId)
    ?.resources.find((resource) => resource.type === 'deliverable_board');
  const deliverables = useQuery({
    queryKey: ['project-deliverables', projectId, deliverableResource?.id],
    queryFn: () =>
      projectsApi<DeliverablesBoard>(
        `/${projectId}/resources/${deliverableResource!.id}/deliverables`,
      ),
    enabled: Boolean(deliverableResource),
  });
  const refresh = () => client.invalidateQueries({ queryKey: key });
  const request = useMutation({
    mutationFn: ({
      path,
      method,
      body,
    }: {
      path: string;
      method: string;
      body?: unknown;
    }) =>
      projectsApi(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    onSuccess: refresh,
  });
  const [view, setView] = useState<'advice' | 'board' | 'planning' | 'journal'>(
    'board',
  );
  const [search, setSearch] = useState('');
  const [priority, setPriority] = useState('all');
  const [dragged, setDragged] = useState<string | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<string | null>(null);
  const [taskOpen, setTaskOpen] = useState(false);
  const [taskError, setTaskError] = useState('');
  const [savingTask, setSavingTask] = useState(false);
  const [editing, setEditing] = useState<ProjectTaskSummary | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderSelection, setFolderSelection] = useState<string | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [editingStatus, setEditingStatus] =
    useState<ProjectTaskStatusSummary | null>(null);
  const [statusName, setStatusName] = useState('');
  const [statusColor, setStatusColor] = useState('blue');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<TaskBoardSettings>(
    defaultTaskBoardSettings,
  );
  const [aiOpen, setAiOpen] = useState(false);
  const [aiMode, setAiMode] = useState<'create' | 'replan'>('create');
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiSuggestions, setAiSuggestions] = useState<Suggestion[]>([]);
  const [replanSuggestions, setReplanSuggestions] = useState<
    ReplanSuggestion[]
  >([]);
  const [selectedReplanTasks, setSelectedReplanTasks] = useState<Set<string>>(
    new Set(),
  );
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');
  const [adviceResult, setAdviceResult] = useState<AdviceResult | null>(null);
  const [workResult, setWorkResult] = useState<AdviceResult | null>(null);
  const [availableHours, setAvailableHours] = useState('2');
  const [adviceLoading, setAdviceLoading] = useState<
    'analysis' | 'work' | null
  >(null);
  const [adviceError, setAdviceError] = useState('');
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [breakdownSuggestions, setBreakdownSuggestions] = useState<
    Suggestion[]
  >([]);
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  const [breakdownError, setBreakdownError] = useState('');
  const [agentBusy, setAgentBusy] = useState(false);
  const [ganttApi, setGanttApi] = useState<IApi | null>(null);
  const [ganttView, setGanttView] = useState<GanttView>('months');
  const [ganttWidth, setGanttWidth] = useState(900);
  const [fittedGanttDisplay, setFittedGanttDisplay] =
    useState<GanttDisplay | null>(null);
  const ganttShellRef = useRef<HTMLElement | null>(null);
  const [taskTab, setTaskTab] = useState<string>('new');
  const [rootTaskId, setRootTaskId] = useState<string | null>(null);
  const [parentToComplete, setParentToComplete] = useState<string | null>(null);
  const [completionStatusOpen, setCompletionStatusOpen] = useState(false);
  const openedInitialTask = useRef<string | null>(null);
  useEffect(() => {
    if (view !== 'planning') return;
    const element = ganttShellRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setGanttWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [view]);
  useEffect(() => {
    if (
      !initialTaskId ||
      !query.data ||
      openedInitialTask.current === initialTaskId
    )
      return;
    const task = query.data.tasks.find((item) => item.id === initialTaskId);
    if (!task) return;
    const parent = task.parentTaskId
      ? query.data.tasks.find((item) => item.id === task.parentTaskId)
      : null;
    openedInitialTask.current = initialTaskId;
    const dependencyIds = query.data.dependencies
      .filter((dependency) => dependency.taskId === task.id)
      .map((dependency) => dependency.dependsOnTaskId);
    const storedWorkspace =
      parent?.workspacePath ??
      task.workspacePath ??
      query.data.project.workspacePath;
    queueMicrotask(() => {
      setEditing(task);
      setRootTaskId(task.parentTaskId ?? task.id);
      setDraft({
        assigneeId: task.assigneeId ?? '',
        title: task.title,
        description: task.description,
        priority: parent?.priority ?? task.priority,
        startAt: dateValue(task.startAt),
        dueAt: dateValue(task.dueAt),
        labels: task.labels.join(', '),
        statusId: task.statusId,
        workspacePath: storedWorkspace,
        executionMode: task.parentTaskId ? task.executionMode : 'manual',
        estimateHours: task.estimateMinutes
          ? String(task.estimateMinutes / 60)
          : '',
        progress: String(task.progress),
        validationCriteria: task.validationCriteria,
        linkedFilePath: task.parentTaskId ? '' : (task.linkedFilePath ?? ''),
        parentTaskId: task.parentTaskId ?? '',
        subtaskStatus: task.subtaskStatus,
        dependencyIds,
      });
      setTaskTab(task.id);
      setTaskOpen(true);
    });
  }, [initialTaskId, query.data]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (query.data?.tasks ?? []).filter(
      (task) =>
        !task.parentTaskId &&
        (priority === 'all' || task.priority === priority) &&
        (!needle ||
          `${task.title} ${task.description} ${task.labels.join(' ')}`
            .toLowerCase()
            .includes(needle)),
    );
  }, [query.data?.tasks, search, priority]);
  const ganttZoom = useMemo(() => {
    const dayFormat = (date: Date) =>
      new Intl.DateTimeFormat(ganttFrench ? 'fr-FR' : 'en-US', {
        weekday: 'short',
        day: 'numeric',
      }).format(date);
    const dayClass = (date: Date) =>
      date.getDay() === 0 || date.getDay() === 6 ? 'project-gantt-weekend' : '';
    return {
      level: ganttView === 'years' ? 0 : ganttView === 'months' ? 1 : 2,
      minCellWidth: 30,
      maxCellWidth: 180,
      levels: [
        {
          minCellWidth: 70,
          maxCellWidth: 160,
          scales: [
            { unit: 'year', step: 1, format: '%Y' },
            {
              unit: 'quarter',
              step: 1,
              format: ganttFrench ? "'T'%Q" : "'Q'%Q",
            },
          ],
        },
        {
          minCellWidth: 70,
          maxCellWidth: 150,
          scales: [
            { unit: 'year', step: 1, format: '%Y' },
            { unit: 'month', step: 1, format: '%F' },
          ],
        },
        {
          minCellWidth: 55,
          maxCellWidth: 130,
          scales: [
            { unit: 'month', step: 1, format: '%F %Y' },
            {
              unit: 'week',
              step: 1,
              format: ganttFrench ? "'Sem.' %W" : "'Week' %W",
            },
          ],
        },
        {
          minCellWidth: 72,
          maxCellWidth: 140,
          scales: [
            { unit: 'month', step: 1, format: '%F %Y' },
            {
              unit: 'day',
              step: 1,
              format: dayFormat,
              css: dayClass,
            },
          ],
        },
      ],
    };
  }, [ganttFrench, ganttView]);
  if (query.isLoading)
    return <div className="p-6 text-sm text-muted-foreground">Chargement…</div>;
  if (!query.data)
    return (
      <div className="p-6 text-sm text-destructive">
        Impossible de charger le gestionnaire de tâches.
      </div>
    );
  const board = query.data;
  const settings = readTaskBoardSettings(board.resource.config);
  const priorityName = (id: string) =>
    settings.priorityOptions.find((option) => option.id === id)?.name ?? id;
  const unassigned =
    board.statuses.find((s) => s.kind === 'unassigned') ?? board.statuses[0];
  const statusByKind = (kind: string) =>
    board.statuses.find((s) => s.kind === kind);
  const inferredTerminalStatusIds = board.statuses
    .filter((status) => status.kind === 'done')
    .map((status) => status.id);
  const terminalStatusIds =
    settings.terminalStatusIds ?? inferredTerminalStatusIds;
  const draftTerminalStatusIds =
    settingsDraft.terminalStatusIds ?? inferredTerminalStatusIds;
  const isTerminalStatus = (statusId: string) =>
    terminalStatusIds.includes(statusId);
  const isTerminalSubtask = (status: ProjectTaskSummary['subtaskStatus']) =>
    settings.terminalSubtaskStatuses.includes(status);
  const dependencyIdsFor = (id: string) =>
    board.dependencies
      .filter((d) => d.taskId === id)
      .map((d) => d.dependsOnTaskId);
  const childrenFor = (id: string) =>
    board.tasks.filter((t) => t.parentTaskId === id);
  const linkedDeliverable = editing
    ? deliverables.data?.deliverables.find(
        (deliverable) => deliverable.primaryTaskId === editing.id,
      )
    : undefined;
  const rootTask = rootTaskId
    ? (board.tasks.find((task) => task.id === rootTaskId) ?? null)
    : null;
  const dateParent = draft.parentTaskId
    ? (board.tasks.find((task) => task.id === draft.parentTaskId) ?? null)
    : null;
  const blocked = (task: ProjectTaskSummary) =>
    dependencyIdsFor(task.id).some(
      (id) =>
        !isTerminalStatus(
          board.tasks.find((item) => item.id === id)?.statusId ?? '',
        ),
    );
  const openNew = (parentTaskId = '') => {
    const parent = parentTaskId
      ? board.tasks.find((task) => task.id === parentTaskId)
      : null;
    setEditing(null);
    setTaskError('');
    setRootTaskId(parentTaskId || null);
    setDraft({
      ...emptyDraft,
      statusId:
        (!parent &&
          board.statuses.some(
            (status) => status.id === settings.defaultStatusId,
          ) &&
          settings.defaultStatusId) ||
        unassigned?.id ||
        '',
      priority: parent?.priority ?? settings.defaultPriority,
      workspacePath: parent?.workspacePath ?? board.project.workspacePath,
      parentTaskId,
      subtaskStatus: 'todo',
    });
    setTaskTab('new');
    setTaskOpen(true);
  };
  const openEdit = (task: ProjectTaskSummary, rootId?: string) => {
    const parent = task.parentTaskId
      ? board.tasks.find((candidate) => candidate.id === task.parentTaskId)
      : null;
    const storedWorkspace =
      parent?.workspacePath ??
      task.workspacePath ??
      board.project.workspacePath;
    setEditing(task);
    setTaskError('');
    setRootTaskId(rootId ?? task.parentTaskId ?? task.id);
    setDraft({
      assigneeId: task.assigneeId ?? '',
      title: task.title,
      description: task.description,
      priority: parent?.priority ?? task.priority,
      startAt: dateValue(task.startAt),
      dueAt: dateValue(task.dueAt),
      labels: task.labels.join(', '),
      statusId: task.statusId,
      workspacePath: storedWorkspace,
      executionMode: task.parentTaskId ? task.executionMode : 'manual',
      estimateHours: task.estimateMinutes
        ? String(task.estimateMinutes / 60)
        : '',
      progress: String(task.progress),
      validationCriteria: task.validationCriteria,
      linkedFilePath: task.parentTaskId ? '' : (task.linkedFilePath ?? ''),
      parentTaskId: task.parentTaskId ?? '',
      subtaskStatus: task.subtaskStatus,
      dependencyIds: dependencyIdsFor(task.id),
    });
    setTaskTab(task.id);
    setTaskOpen(true);
  };
  const payload = () => ({
    assigneeId: draft.assigneeId || null,
    title: draft.title.trim(),
    description: draft.description.trim(),
    priority: draft.priority,
    startAt: draft.startAt
      ? new Date(`${draft.startAt}T12:00:00`).getTime()
      : null,
    dueAt: draft.dueAt ? new Date(`${draft.dueAt}T12:00:00`).getTime() : null,
    labels: draft.labels
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
    statusId: draft.statusId,
    workspacePath: draft.parentTaskId
      ? (rootTask?.workspacePath ?? board.project.workspacePath)
      : draft.workspacePath || board.project.workspacePath,
    executionMode: draft.parentTaskId ? draft.executionMode : 'manual',
    estimateMinutes: Math.round((Number(draft.estimateHours) || 0) * 60),
    progress: Math.min(100, Math.max(0, Number(draft.progress) || 0)),
    validationCriteria: draft.validationCriteria.trim(),
    linkedFilePath: draft.parentTaskId
      ? null
      : draft.linkedFilePath.trim() || null,
    parentTaskId: draft.parentTaskId || null,
    ...(draft.parentTaskId ? { subtaskStatus: draft.subtaskStatus } : {}),
    dependencyIds: draft.parentTaskId ? [] : draft.dependencyIds,
  });
  const completeParent = async (parentId: string, statusId: string) => {
    await projectsApi(
      `/${projectId}/resources/${resourceId}/tasks/${parentId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ statusId }),
      },
    );
    setCompletionStatusOpen(false);
    setParentToComplete(null);
    await refresh();
  };
  const saveTask = async () => {
    if (!draft.title.trim()) return;
    setTaskError('');
    setSavingTask(true);
    try {
      const result = await projectsApi<{ task: ProjectTaskSummary }>(
        editing
          ? `/${projectId}/resources/${resourceId}/tasks/${editing.id}`
          : `/${projectId}/resources/${resourceId}/tasks`,
        {
          method: editing ? 'PATCH' : 'POST',
          body: JSON.stringify(payload()),
        },
      );
      client.setQueryData<ProjectTaskBoard>(key, (current) => {
        if (!current) return current;
        const exists = current.tasks.some((task) => task.id === result.task.id);
        return {
          ...current,
          tasks: exists
            ? current.tasks.map((task) =>
                task.id === result.task.id ? result.task : task,
              )
            : [...current.tasks, result.task],
        };
      });
      setTaskOpen(false);
      const parentId = result.task.parentTaskId;
      const becameTerminal =
        parentId &&
        isTerminalSubtask(result.task.subtaskStatus) &&
        (!editing || !isTerminalSubtask(editing.subtaskStatus));
      if (parentId && becameTerminal) {
        const parent = board.tasks.find((task) => task.id === parentId);
        const allChildrenTerminal = board.tasks
          .filter((task) => task.parentTaskId === parentId)
          .map((task) => (task.id === result.task.id ? result.task : task))
          .every((task) => isTerminalSubtask(task.subtaskStatus));
        if (
          parent &&
          !isTerminalStatus(parent.statusId) &&
          allChildrenTerminal
        ) {
          if (terminalStatusIds.length === 1) {
            await completeParent(parentId, terminalStatusIds[0]);
          } else if (terminalStatusIds.length > 1) {
            setParentToComplete(parentId);
            setCompletionStatusOpen(true);
          }
        }
      }
      void refresh();
    } catch (error) {
      setTaskError(
        error instanceof Error
          ? error.message
          : "Impossible d'enregistrer la tâche.",
      );
    } finally {
      setSavingTask(false);
    }
  };
  const removeTask = async () => {
    if (!editing) return;
    const children = childrenFor(editing.id);
    const linkedAgentCount = [editing, ...children].filter(
      (task) => task.linkedThreadId,
    ).length;
    const details = [
      children.length
        ? `Ses ${children.length} sous-tâche${children.length > 1 ? 's' : ''} seront également supprimées.`
        : '',
      linkedAgentCount
        ? `${linkedAgentCount > 1 ? `Les ${linkedAgentCount} agents associés seront supprimés` : 'L’agent associé sera supprimé'}. Le workspace et ses fichiers seront conservés.`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
    if (
      (settings.confirmDelete || linkedAgentCount > 0) &&
      !window.confirm(
        `Supprimer « ${editing.title} » ?${details ? `\n\n${details}` : ''}`,
      )
    )
      return;
    await request.mutateAsync({
      path: `/${projectId}/resources/${resourceId}/tasks/${editing.id}`,
      method: 'DELETE',
    });
    setTaskOpen(false);
  };
  const dropTask = async (statusId: string) => {
    const task = board.tasks.find((t) => t.id === dragged);
    setDragOverStatus(null);
    if (!task || task.parentTaskId || task.statusId === statusId) {
      setDragged(null);
      return;
    }
    const target = board.statuses.find((status) => status.id === statusId);
    if (
      target &&
      isTerminalStatus(target.id) &&
      childrenFor(task.id).some(
        (child) => !isTerminalSubtask(child.subtaskStatus),
      )
    ) {
      window.alert(
        'Toutes les sous-tâches doivent être terminées ou annulées.',
      );
      setDragged(null);
      return;
    }
    await request.mutateAsync({
      path: `/${projectId}/resources/${resourceId}/tasks/${task.id}`,
      method: 'PATCH',
      body: {
        statusId,
        position: board.tasks.filter((t) => t.statusId === statusId).length,
      },
    });
    setDragged(null);
  };
  const saveStatus = async () => {
    if (!statusName.trim()) return;
    await request.mutateAsync({
      path: editingStatus
        ? `/${projectId}/resources/${resourceId}/statuses/${editingStatus.id}`
        : `/${projectId}/resources/${resourceId}/statuses`,
      method: editingStatus ? 'PATCH' : 'POST',
      body: { name: statusName.trim(), color: statusColor },
    });
    setStatusOpen(false);
  };
  const saveSettings = async () => {
    const previousById = new Map(
      settings.labels.map((label) => [label.id, label]),
    );
    const nextIds = new Set(settingsDraft.labels.map((label) => label.id));
    const labelRenames = settingsDraft.labels
      .map((label) => ({
        from: previousById.get(label.id)?.name ?? label.name,
        to: label.name.trim(),
      }))
      .filter((change) => change.from !== change.to);
    const removedLabels = settings.labels
      .filter((label) => !nextIds.has(label.id))
      .map((label) => label.name);
    await request.mutateAsync({
      path: `/${projectId}/resources/${resourceId}`,
      method: 'PATCH',
      body: {
        config: {
          ...board.resource.config,
          taskBoardSettings: settingsDraft,
        },
        labelRenames,
        removedLabels,
      },
    });
    setSettingsOpen(false);
  };
  const removeStatus = async (status: ProjectTaskStatusSummary) => {
    if (
      status.system ||
      !window.confirm(
        `Supprimer « ${status.name} » ? Les tâches seront replacées dans Actions non assignées.`,
      )
    )
      return;
    await request.mutateAsync({
      path: `/${projectId}/resources/${resourceId}/statuses/${status.id}`,
      method: 'DELETE',
    });
  };
  const moveStatus = async (index: number, offset: -1 | 1) => {
    const targetIndex = index + offset;
    const current = board.statuses[index];
    const target = board.statuses[targetIndex];
    if (!current || !target) return;
    await Promise.all([
      projectsApi(
        `/${projectId}/resources/${resourceId}/statuses/${current.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ position: targetIndex }),
        },
      ),
      projectsApi(
        `/${projectId}/resources/${resourceId}/statuses/${target.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ position: index }),
        },
      ),
    ]);
    await refresh();
  };
  const generatePlan = async () => {
    setAiLoading(true);
    setAiError('');
    setAiSuggestions([]);
    try {
      const result = await projectsApi<{ tasks: Suggestion[] }>(
        `/${projectId}/resources/${resourceId}/ai-plan`,
        { method: 'POST', body: JSON.stringify({ prompt: aiPrompt }) },
      );
      if (result.tasks.some((task) => task.parentTitle?.trim()))
        throw new Error(
          'Le plan doit contenir uniquement des tâches principales. Relancez la génération ; vous pourrez ensuite découper chaque tâche en sous-tâches.',
        );
      setAiSuggestions(result.tasks);
      if (!result.tasks.length) setAiError('L’IA n’a proposé aucune tâche.');
    } catch (error) {
      setAiError(
        error instanceof Error ? error.message : 'La planification a échoué.',
      );
    } finally {
      setAiLoading(false);
    }
  };
  const generateAdvice = async (mode: 'analysis' | 'work') => {
    setAdviceLoading(mode);
    setAdviceError('');
    try {
      const result = await projectsApi<AdviceResult>(
        `/${projectId}/resources/${resourceId}/ai-advice`,
        {
          method: 'POST',
          body: JSON.stringify({
            mode,
            ...(mode === 'work'
              ? { availableHours: Number(availableHours) }
              : {}),
          }),
        },
      );
      if (mode === 'analysis') setAdviceResult(result);
      else setWorkResult(result);
    } catch (error) {
      setAdviceError(
        error instanceof Error ? error.message : 'L’analyse par l’IA a échoué.',
      );
    } finally {
      setAdviceLoading(null);
    }
  };
  const generateReplan = async () => {
    setAiLoading(true);
    setAiError('');
    try {
      const result = await projectsApi<{ tasks: ReplanSuggestion[] }>(
        `/${projectId}/resources/${resourceId}/ai-replan`,
        { method: 'POST', body: JSON.stringify({ prompt: aiPrompt }) },
      );
      const changed = result.tasks.filter((suggestion) => {
        const task = board.tasks.find((item) => item.id === suggestion.taskId);
        if (!task) return false;
        const currentDependencies = board.dependencies
          .filter((dependency) => dependency.taskId === task.id)
          .map((dependency) => dependency.dependsOnTaskId)
          .sort();
        return (
          task.priority !== suggestion.priority ||
          task.estimateMinutes !== Math.round(suggestion.estimateHours * 60) ||
          dateValue(task.startAt) !== dateValue(suggestion.startAt) ||
          dateValue(task.dueAt) !== dateValue(suggestion.dueAt) ||
          currentDependencies.join('|') !==
            [...suggestion.dependencyIds].sort().join('|')
        );
      });
      setReplanSuggestions(changed);
      setSelectedReplanTasks(new Set(changed.map((item) => item.taskId)));
      if (!changed.length)
        setAiError('L’IA ne propose aucune modification du planning actuel.');
    } catch (error) {
      setAiError(
        error instanceof Error ? error.message : 'La replanification a échoué.',
      );
    } finally {
      setAiLoading(false);
    }
  };
  const applyReplan = async () => {
    setAiLoading(true);
    setAiError('');
    try {
      for (const suggestion of replanSuggestions) {
        if (!selectedReplanTasks.has(suggestion.taskId)) continue;
        await projectsApi(
          `/${projectId}/resources/${resourceId}/tasks/${suggestion.taskId}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              priority: suggestion.priority,
              estimateMinutes: Math.round(suggestion.estimateHours * 60),
              startAt: suggestion.startAt,
              dueAt: suggestion.dueAt,
              dependencyIds: suggestion.dependencyIds,
            }),
          },
        );
      }
      await refresh();
      setAiOpen(false);
      setReplanSuggestions([]);
      setAiPrompt('');
    } catch (error) {
      setAiError(
        error instanceof Error ? error.message : 'Application impossible.',
      );
    } finally {
      setAiLoading(false);
    }
  };
  const addSuggestions = async () => {
    setAiLoading(true);
    try {
      if (aiSuggestions.some((task) => task.parentTitle?.trim()))
        throw new Error(
          'Seules les tâches principales peuvent être créées par la planification.',
        );
      const created = new Map<string, string>();
      const plannedDates = new Map<
        string,
        { startAt: number; dueAt: number }
      >();
      const day = 86_400_000;
      const today = new Date();
      today.setHours(12, 0, 0, 0);
      const schedule = (
        item: Suggestion,
        visiting = new Set<string>(),
      ): { startAt: number; dueAt: number } => {
        const known = plannedDates.get(item.title);
        if (known) return known;
        if (visiting.has(item.title))
          return { startAt: today.getTime(), dueAt: today.getTime() };
        visiting.add(item.title);
        const predecessors = item.dependsOnTitles
          .map((title) =>
            aiSuggestions.find((candidate) => candidate.title === title),
          )
          .filter((candidate): candidate is Suggestion => Boolean(candidate))
          .map((candidate) => schedule(candidate, visiting));
        const startAt = predecessors.length
          ? Math.max(...predecessors.map((date) => date.dueAt + day))
          : today.getTime();
        const durationDays = Math.max(
          1,
          Math.ceil((item.estimateHours || 8) / 8),
        );
        const result = {
          startAt,
          dueAt: startAt + (durationDays - 1) * day,
        };
        plannedDates.set(item.title, result);
        visiting.delete(item.title);
        return result;
      };
      // Planning schedules main tasks only. Subtasks are proposed later from a task.
      for (const suggestion of aiSuggestions) schedule(suggestion);
      for (const suggestion of aiSuggestions) {
        const dates = plannedDates.get(suggestion.title)!;
        const result = await projectsApi<{ task: ProjectTaskSummary }>(
          `/${projectId}/resources/${resourceId}/tasks`,
          {
            method: 'POST',
            body: JSON.stringify({
              ...suggestion,
              executionMode: 'manual',
              estimateMinutes: Math.round(suggestion.estimateHours * 60),
              workspacePath: board.project.workspacePath,
              ...dates,
            }),
          },
        );
        created.set(suggestion.title, result.task.id);
      }
      for (const suggestion of aiSuggestions) {
        const id = created.get(suggestion.title);
        if (!id) continue;
        await projectsApi(`/${projectId}/resources/${resourceId}/tasks/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            parentTaskId: null,
            executionMode: 'manual',
            dependencyIds: suggestion.dependsOnTitles
              .map((title) => created.get(title))
              .filter(Boolean),
          }),
        });
      }
      await refresh();
      setAiOpen(false);
      setAiSuggestions([]);
      setAiPrompt('');
    } catch (error) {
      setAiError(
        error instanceof Error ? error.message : 'Création impossible.',
      );
    } finally {
      setAiLoading(false);
    }
  };
  const proposeSubtasks = async () => {
    if (
      !draft.title.trim() ||
      draft.parentTaskId ||
      (editing && childrenFor(editing.id).length > 0)
    )
      return;
    setBreakdownLoading(true);
    setBreakdownError('');
    try {
      let parent = editing;
      if (parent) {
        const result = await projectsApi<{ task: ProjectTaskSummary }>(
          `/${projectId}/resources/${resourceId}/tasks/${parent.id}`,
          { method: 'PATCH', body: JSON.stringify(payload()) },
        );
        parent = result.task;
      } else {
        const result = await projectsApi<{ task: ProjectTaskSummary }>(
          `/${projectId}/resources/${resourceId}/tasks`,
          { method: 'POST', body: JSON.stringify(payload()) },
        );
        parent = result.task;
        setEditing(parent);
        setRootTaskId(parent.id);
        setTaskTab(parent.id);
      }
      const result = await projectsApi<{ tasks: Suggestion[] }>(
        `/${projectId}/resources/${resourceId}/tasks/${parent.id}/ai-subtasks`,
        {
          method: 'POST',
          body: JSON.stringify({
            title: draft.title,
            description: draft.description,
            validationCriteria: draft.validationCriteria,
          }),
        },
      );
      setBreakdownSuggestions(result.tasks);
      if (!result.tasks.length)
        setBreakdownError('L’IA n’a proposé aucune sous-tâche.');
      await refresh();
      setBreakdownOpen(true);
    } catch (error) {
      setBreakdownError(
        error instanceof Error ? error.message : 'Découpage impossible.',
      );
      setBreakdownOpen(true);
    } finally {
      setBreakdownLoading(false);
    }
  };
  const createProposedSubtasks = async () => {
    const parentId = rootTaskId ?? editing?.id;
    if (!parentId || !breakdownSuggestions.length) return;
    setBreakdownLoading(true);
    setBreakdownError('');
    try {
      for (const suggestion of breakdownSuggestions) {
        if (!suggestion.title.trim()) continue;
        await projectsApi(`/${projectId}/resources/${resourceId}/tasks`, {
          method: 'POST',
          body: JSON.stringify({
            title: suggestion.title,
            description: suggestion.description,
            priority: suggestion.priority,
            estimateMinutes: Math.round(suggestion.estimateHours * 60),
            validationCriteria: suggestion.validationCriteria,
            parentTaskId: parentId,
            workspacePath: draft.workspacePath || board.project.workspacePath,
            executionMode: suggestion.executionMode,
            labels: suggestion.labels,
            dependencyIds: [],
          }),
        });
      }
      await refresh();
      setBreakdownOpen(false);
      setBreakdownSuggestions([]);
    } catch (error) {
      setBreakdownError(
        error instanceof Error ? error.message : 'Création impossible.',
      );
    } finally {
      setBreakdownLoading(false);
    }
  };
  const runAgent = async () => {
    if (!editing || blocked(editing)) return;
    setAgentBusy(true);
    try {
      await projectsApi(
        `/${projectId}/resources/${resourceId}/tasks/${editing.id}`,
        { method: 'PATCH', body: JSON.stringify(payload()) },
      );
      const cwd = draft.workspacePath || board.project.workspacePath;
      const started = await threadsStartThread({
        body: { cwd },
        throwOnError: true,
      });
      const thread = started.data?.thread;
      if (!thread) throw new Error('Impossible de créer l’agent');
      await projectsApi(`/${projectId}/agents/${thread.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          workspacePath: cwd,
          alreadyAtWorkspace: true,
        }),
      });
      const inProgress = statusByKind('in_progress');
      await projectsApi(
        `/${projectId}/resources/${resourceId}/tasks/${editing.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            linkedThreadId: thread.id,
            executionMode: 'agent',
            agentState: 'running',
            ...(editing.parentTaskId
              ? { subtaskStatus: 'started' }
              : inProgress
                ? { statusId: inProgress.id }
                : {}),
          }),
        },
      );
      const instructions = `Exécute cette tâche de projet.\n\nTitre : ${draft.title}\nDescription : ${draft.description || 'Non précisée'}\nCharge estimée : ${draft.estimateHours || 'non estimée'} heure(s)\nConditions de validation : ${draft.validationCriteria || 'Non précisées'}\n\nTravaille uniquement dans ${cwd}. Lorsque le résultat est prêt, résume ce qui a été réalisé et les vérifications effectuées. Ne déclare pas toi-même la tâche définitivement validée.`;
      await threadsStartTurn({
        path: { threadId: thread.id },
        body: {
          input: [{ type: 'text', text: instructions, text_elements: [] }],
        },
        throwOnError: true,
      });
      await refresh();
      setTaskOpen(false);
      void navigate({ to: '/t/$threadId', params: { threadId: thread.id } });
    } catch (error) {
      await projectsApi(
        `/${projectId}/resources/${resourceId}/tasks/${editing.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            executionMode: 'agent',
            agentState: 'error',
          }),
        },
      ).catch(() => undefined);
      window.alert(
        error instanceof Error
          ? error.message
          : 'Le lancement de l’agent a échoué.',
      );
    } finally {
      setAgentBusy(false);
    }
  };
  const validateTask = async () => {
    if (!editing) return;
    const done = statusByKind('done');
    await request.mutateAsync({
      path: `/${projectId}/resources/${resourceId}/tasks/${editing.id}`,
      method: 'PATCH',
      body: editing.parentTaskId
        ? { agentState: 'validated', subtaskStatus: 'done' }
        : { agentState: 'validated', ...(done ? { statusId: done.id } : {}) },
    });
    setTaskOpen(false);
  };
  const ganttTasks = board.tasks
    .filter((task) => !task.parentTaskId)
    .flatMap((task) => {
      const children = board.tasks.filter(
        (candidate) => candidate.parentTaskId === task.id,
      );
      const datedChildren = children.filter(
        (child) => child.startAt || child.dueAt,
      );
      const childStarts = datedChildren.map(
        (child) => child.startAt ?? child.dueAt!,
      );
      const childEnds = datedChildren.map(
        (child) => child.dueAt ?? child.startAt!,
      );
      const parentStart =
        task.startAt ??
        task.dueAt ??
        (childStarts.length ? Math.min(...childStarts) : null);
      const parentEnd =
        task.dueAt ??
        task.startAt ??
        (childEnds.length ? Math.max(...childEnds) : null);
      if (parentStart === null || parentEnd === null) return [];
      const priorityIndex = Math.max(
        0,
        settings.priorityOptions.findIndex(
          (option) => option.id === task.priority,
        ),
      );
      const toGanttTask = (
        current: ProjectTaskSummary,
        startValue: number,
        endValue: number,
        parent: string | number,
        parentType = false,
      ) => ({
        id: current.id,
        text: current.title,
        start: new Date(startValue),
        duration: Math.max(
          1,
          Math.ceil((endValue - startValue) / 86400000) + 1,
        ),
        progress: current.progress,
        parent,
        type: `priority-${priorityIndex}${parentType ? '-parent' : ''}`,
        open: false,
      });
      return [
        toGanttTask(task, parentStart, parentEnd, 0, children.length > 0),
        ...children.map((child) =>
          toGanttTask(
            child,
            child.startAt ?? child.dueAt ?? parentStart,
            child.dueAt ?? child.startAt ?? parentEnd,
            task.id,
          ),
        ),
      ];
    });
  const ganttTaskTypes = settings.priorityOptions.flatMap((option, index) => [
    { id: `priority-${index}`, label: option.name },
    { id: `priority-${index}-parent`, label: option.name },
  ]);
  const ganttPriorityStyles = settings.priorityOptions
    .map((option, index) => {
      const color = palette[option.color ?? 'slate'];
      return `.project-gantt-shell .wx-bar.wx-task.priority-${index},.project-gantt-shell .wx-bar.wx-task.priority-${index}-parent{background-color:color-mix(in srgb, ${color} 68%, white);border-color:${color}}.project-gantt-shell .wx-bar.wx-task.priority-${index} .wx-progress-percent,.project-gantt-shell .wx-bar.wx-task.priority-${index}-parent .wx-progress-percent{background-color:${color}}.project-gantt-shell .wx-bar.wx-task.priority-${index}-parent .wx-progress-marker{display:none}`;
    })
    .join('');
  const ganttRange = (() => {
    if (!ganttTasks.length)
      return { start: new Date(), end: new Date(), days: 1 };
    const starts = ganttTasks.map((task) => task.start.getTime());
    const ends = ganttTasks.map(
      (task) => task.start.getTime() + Math.max(1, task.duration) * 86400000,
    );
    const start = new Date(Math.min(...starts));
    const end = new Date(Math.max(...ends));
    const days = Math.max(
      1,
      Math.ceil((end.getTime() - start.getTime()) / 86400000),
    );
    return { start, end, days };
  })();
  const calculatedFitDisplay: GanttDisplay = (() => {
    const chartWidth = Math.max(260, ganttWidth - 395);
    if (ganttRange.days > 730) {
      return {
        scales: [{ unit: 'year', step: 1, format: '%Y' }],
        cellWidth: Math.max(
          55,
          Math.floor(chartWidth / Math.ceil(ganttRange.days / 365)),
        ),
      };
    }
    if (ganttRange.days > 120) {
      return {
        scales: [
          { unit: 'year', step: 1, format: '%Y' },
          { unit: 'month', step: 1, format: '%M' },
        ],
        cellWidth: Math.max(
          28,
          Math.floor(chartWidth / Math.ceil(ganttRange.days / 30.44)),
        ),
      };
    }
    return {
      scales: [
        { unit: 'month', step: 1, format: '%F %Y' },
        {
          unit: 'week',
          step: 1,
          format: ganttFrench ? "'Sem.' %W" : "'Week' %W",
        },
      ],
      cellWidth: Math.max(
        34,
        Math.floor(chartWidth / Math.ceil(ganttRange.days / 7)),
      ),
    };
  })();
  const ganttDisplay: GanttDisplay = (() => {
    if (ganttView === 'years') {
      return {
        scales: [
          { unit: 'year', step: 1, format: '%Y' },
          { unit: 'quarter', step: 1, format: ganttFrench ? "'T'%Q" : "'Q'%Q" },
        ],
        cellWidth: 90,
      };
    }
    if (ganttView === 'weeks') {
      return {
        scales: [
          { unit: 'month', step: 1, format: '%F %Y' },
          {
            unit: 'week',
            step: 1,
            format: ganttFrench ? "'Sem.' %W" : "'Week' %W",
          },
        ],
        cellWidth: 90,
      };
    }
    if (ganttView === 'fit') {
      return fittedGanttDisplay ?? calculatedFitDisplay;
    }
    return {
      scales: [
        { unit: 'year', step: 1, format: '%Y' },
        { unit: 'month', step: 1, format: '%F' },
      ],
      cellWidth: 110,
    };
  })();
  const ganttLinks = board.dependencies.map((d) => ({
    id: `${d.dependsOnTaskId}:${d.taskId}`,
    source: d.dependsOnTaskId,
    target: d.taskId,
    type: 'e2s',
  }));
  const ganttColumns = [
    {
      id: 'text',
      header: ganttFrench ? 'Tâche' : 'Task',
      flexgrow: 1,
      minWidth: 190,
      resize: true,
      sort: true,
      cell: (({ row }: { row: { id: string; text?: string } }) => (
        <button
          type="button"
          className="project-gantt-task-title"
          onClick={(event) => {
            event.stopPropagation();
            const task = board.tasks.find(
              (candidate) => candidate.id === String(row.id),
            );
            if (task) openEdit(task);
          }}
        >
          {row.text}
        </button>
      )) as never,
    },
    {
      id: 'start',
      header: ganttFrench ? 'Début' : 'Start',
      width: 115,
      align: 'center' as const,
      resize: true,
      sort: true,
    },
    {
      id: 'duration',
      header: ganttFrench ? 'Durée' : 'Duration',
      width: 90,
      align: 'center' as const,
      resize: true,
      sort: true,
    },
  ];

  const persistGanttDates = async (event: {
    id: string | number;
    task: { start?: Date; duration?: number; progress?: number };
    inProgress?: boolean;
  }) => {
    if (event.inProgress) return;
    const current = board.tasks.find((task) => task.id === String(event.id));
    if (!current) return;
    const patch: { startAt?: number; dueAt?: number; progress?: number } = {};
    if (event.task.start) {
      const start = new Date(event.task.start);
      start.setHours(12, 0, 0, 0);
      const duration = Math.max(1, Math.round(event.task.duration ?? 1));
      const due = new Date(start);
      due.setDate(due.getDate() + duration - 1);
      patch.startAt = start.getTime();
      patch.dueAt = due.getTime();
    }
    if (event.task.progress !== undefined) {
      const hasChildren = board.tasks.some(
        (task) => task.parentTaskId === current.id,
      );
      if (!hasChildren)
        patch.progress = Math.min(
          100,
          Math.max(0, Math.round(event.task.progress)),
        );
    }
    if (!Object.keys(patch).length) {
      await refresh();
      return;
    }
    try {
      await projectsApi(
        `/${projectId}/resources/${resourceId}/tasks/${current.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify(patch),
        },
      );
      await refresh();
    } catch (error) {
      await refresh();
      window.alert(
        error instanceof Error
          ? error.message
          : ganttFrench
            ? 'Impossible de modifier les dates.'
            : 'Unable to update dates.',
      );
    }
  };

  const persistGanttLink = async (event: {
    link: { source?: string | number; target?: string | number };
  }) => {
    const source = String(event.link.source ?? '');
    const target = String(event.link.target ?? '');
    const targetTask = board.tasks.find(
      (task) => task.id === target && !task.parentTaskId,
    );
    if (!source || !targetTask || source === target) return;
    const dependencyIds = Array.from(
      new Set([...dependencyIdsFor(target), source]),
    );
    try {
      await projectsApi(
        `/${projectId}/resources/${resourceId}/tasks/${target}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ dependencyIds }),
        },
      );
      await refresh();
    } catch (error) {
      await refresh();
      window.alert(
        error instanceof Error
          ? error.message
          : ganttFrench
            ? 'Impossible de créer cette dépendance.'
            : 'Unable to create this dependency.',
      );
    }
  };

  const deleteGanttLink = async (event: { id: string | number }) => {
    const link = ganttLinks.find(
      (candidate) => candidate.id === String(event.id),
    );
    if (!link) return;
    const dependencyIds = dependencyIdsFor(link.target).filter(
      (id) => id !== link.source,
    );
    try {
      await projectsApi(
        `/${projectId}/resources/${resourceId}/tasks/${link.target}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ dependencyIds }),
        },
      );
      await refresh();
    } catch (error) {
      await refresh();
      window.alert(
        error instanceof Error
          ? error.message
          : ganttFrench
            ? 'Impossible de supprimer cette dépendance.'
            : 'Unable to remove this dependency.',
      );
    }
  };

  return (
    <main
      className={
        modalOnly ? 'contents' : 'flex min-h-0 flex-1 flex-col overflow-hidden'
      }
    >
      <div className={modalOnly ? 'hidden' : 'contents'}>
      <TaskManagerToolbar
        view={view}
        onViewChange={setView}
        panelId={`task-board-view-${resourceId}`}
        onPlan={() => {
          setAiError('');
          setAiSuggestions([]);
          setReplanSuggestions([]);
          setAiMode('create');
          setAiOpen(true);
        }}
        onNewTask={() => openNew()}
        onSettings={() => {
          setSettingsDraft(settings);
          setSettingsOpen(true);
        }}
      />
      <div
        id={`task-board-view-${resourceId}`}
        role="tabpanel"
        aria-labelledby={`task-board-view-${resourceId}-${view}`}
        tabIndex={0}
        className="flex min-h-0 flex-1 flex-col overflow-hidden p-4 md:p-6"
      >
        {view === 'advice' ? (
          <div className="grid min-h-0 gap-4 overflow-auto pb-4 xl:grid-cols-2">
            <section className="space-y-4 rounded-xl border bg-card p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 font-semibold">
                    <Sparkles className="h-4 w-4 text-primary" />
                    Analyse générale du projet
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Détecte les alertes, les blocages et les pistes
                    d’amélioration sans modifier le planning.
                  </p>
                </div>
                <Button
                  onClick={() => void generateAdvice('analysis')}
                  disabled={adviceLoading !== null}
                >
                  {adviceLoading === 'analysis' ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Sparkles />
                  )}
                  Analyser le projet
                </Button>
              </div>
              {adviceResult && (
                <>
                  <div className="rounded-lg border bg-muted/35 p-4">
                    <div className="mb-1 flex items-center gap-2 text-sm font-medium">
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${
                          adviceResult.health === 'good'
                            ? 'bg-green-500'
                            : adviceResult.health === 'at_risk'
                              ? 'bg-red-500'
                              : 'bg-amber-500'
                        }`}
                      />
                      Synthèse
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {adviceResult.summary}
                    </p>
                  </div>
                  <div className="space-y-3">
                    {adviceResult.advice.map((item, index) => (
                      <article
                        key={`${item.title}:${index}`}
                        className={`rounded-lg border-l-4 bg-muted/20 p-4 ${
                          item.severity === 'alert'
                            ? 'border-l-red-500'
                            : item.severity === 'opportunity'
                              ? 'border-l-green-500'
                              : item.severity === 'recommendation'
                                ? 'border-l-blue-500'
                                : 'border-l-slate-400'
                        }`}
                      >
                        <h3 className="font-medium">{item.title}</h3>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {item.description}
                        </p>
                        {item.taskIds.length > 0 && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {item.taskIds.map((id) => {
                              const task = board.tasks.find(
                                (candidate) => candidate.id === id,
                              );
                              return task ? (
                                <Button
                                  key={id}
                                  size="sm"
                                  variant="outline"
                                  onClick={() => openEdit(task)}
                                >
                                  {task.title}
                                </Button>
                              ) : null;
                            })}
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                </>
              )}
            </section>

            <section className="space-y-4 rounded-xl border bg-card p-5">
              <div>
                <h2 className="flex items-center gap-2 font-semibold">
                  <Clock3 className="h-4 w-4 text-primary" />
                  Que puis-je faire maintenant ?
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Indiquez votre temps disponible pour obtenir un programme de
                  travail réaliste et priorisé.
                </p>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <label className="min-w-44 flex-1 space-y-1 text-sm">
                  <span className="font-medium">Temps disponible (heures)</span>
                  <Input
                    type="number"
                    min="0.25"
                    max="168"
                    step="0.25"
                    value={availableHours}
                    onChange={(event) => setAvailableHours(event.target.value)}
                  />
                </label>
                <Button
                  onClick={() => void generateAdvice('work')}
                  disabled={
                    adviceLoading !== null ||
                    !Number.isFinite(Number(availableHours)) ||
                    Number(availableHours) <= 0
                  }
                >
                  {adviceLoading === 'work' ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Sparkles />
                  )}
                  Me proposer un programme
                </Button>
              </div>
              {workResult && (
                <>
                  <p className="rounded-lg border bg-muted/35 p-4 text-sm text-muted-foreground">
                    {workResult.summary}
                  </p>
                  <ol className="space-y-3">
                    {workResult.work.map((item, index) => {
                      const task = board.tasks.find(
                        (candidate) => candidate.id === item.taskId,
                      );
                      if (!task) return null;
                      return (
                        <li
                          key={`${item.taskId}:${index}`}
                          className="flex gap-3 rounded-lg border p-4"
                        >
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                            {index + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <button
                              type="button"
                              className="font-medium hover:text-primary hover:underline"
                              onClick={() => openEdit(task)}
                            >
                              {task.title}
                            </button>
                            <p className="mt-1 text-sm text-muted-foreground">
                              {item.reason}
                            </p>
                            <span className="mt-2 inline-flex rounded-full bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                              {item.recommendedMinutes >= 60
                                ? `${Math.floor(item.recommendedMinutes / 60)} h ${item.recommendedMinutes % 60 ? `${item.recommendedMinutes % 60} min` : ''}`
                                : `${item.recommendedMinutes} min`}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </>
              )}
            </section>
            {adviceError && (
              <div className="xl:col-span-2 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                <TriangleAlert className="h-4 w-4" />
                {adviceError}
              </div>
            )}
          </div>
        ) : view === 'board' ? (
          <>
            <div className="mb-4 flex shrink-0 flex-wrap items-center gap-2 rounded-xl border bg-card/50 p-2">
              <ListFilter className="ml-1 h-4 w-4 text-muted-foreground" />
              <Input
                className="min-w-48 flex-1"
                placeholder="Rechercher une tâche ou une étiquette…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select
                className="h-8 rounded-lg border bg-background px-2 text-sm"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                <option value="all">Toutes les priorités</option>
                {settings.priorityOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex min-h-0 w-full flex-1 items-start gap-3 overflow-auto pb-4">
              {board.statuses
                .filter(
                  (status) =>
                    !settings.hiddenEmptyStatusIds.includes(status.id) ||
                    filtered.some((task) => task.statusId === status.id),
                )
                .map((status) => {
                  const tasks = filtered
                    .filter((t) => t.statusId === status.id)
                    .sort((a, b) => {
                      const aDue = a.dueAt
                        ? new Date(a.dueAt).getTime()
                        : Number.POSITIVE_INFINITY;
                      const bDue = b.dueAt
                        ? new Date(b.dueAt).getTime()
                        : Number.POSITIVE_INFINITY;
                      return aDue - bDue || a.position - b.position;
                    });
                  return (
                    <section
                      key={status.id}
                      className={`min-h-full min-w-[310px] flex-1 rounded-xl border p-3 transition-all duration-150 ${
                        dragOverStatus === status.id
                          ? 'border-primary/70 bg-primary/10 shadow-[inset_0_0_0_2px_hsl(var(--primary)/0.3),0_8px_24px_hsl(var(--primary)/0.12)]'
                          : 'bg-card/60'
                      }`}
                      onDragEnter={() => {
                        if (dragged) setDragOverStatus(status.id);
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        if (dragged && dragOverStatus !== status.id) {
                          setDragOverStatus(status.id);
                        }
                      }}
                      onDragLeave={(e) => {
                        if (
                          !e.currentTarget.contains(e.relatedTarget as Node)
                        ) {
                          setDragOverStatus(null);
                        }
                      }}
                      onDrop={() => dropTask(status.id)}
                    >
                      <div className="sticky top-0 z-10 -mx-1 mb-3 flex items-center gap-2 rounded-lg border-b bg-card/95 px-1 py-2 backdrop-blur">
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          style={{
                            backgroundColor:
                              palette[paletteColor(status.color, 'slate')],
                          }}
                        />
                        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
                          {status.name}
                        </h2>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                          {tasks.length}
                        </span>
                      </div>
                      <div className="space-y-2">
                        {tasks.map((task) => (
                          <TaskCard
                            key={task.id}
                            task={task}
                            subtasks={childrenFor(task.id)}
                            blocked={blocked(task)}
                            overdue={
                              (Boolean(task.dueAt) &&
                                dateValue(task.dueAt) < dateValue(Date.now()) &&
                                !isTerminalStatus(task.statusId)) ||
                              childrenFor(task.id).some(
                                (child) =>
                                  Boolean(child.dueAt) &&
                                  dateValue(child.dueAt) <
                                    dateValue(Date.now()) &&
                                  !isTerminalSubtask(child.subtaskStatus),
                              )
                            }
                            settings={settings}
                            dragging={dragged === task.id}
                            onDrag={() => setDragged(task.id)}
                            onDragEnd={() => {
                              setDragged(null);
                              setDragOverStatus(null);
                            }}
                            onClick={() => openEdit(task)}
                            onSubtaskClick={openEdit}
                          />
                        ))}
                        {(!tasks.length || dragOverStatus === status.id) && (
                          <div
                            className={`rounded-lg border border-dashed p-4 text-center text-xs transition-all ${
                              dragOverStatus === status.id
                                ? 'border-primary bg-primary/15 font-medium text-primary'
                                : 'text-muted-foreground'
                            }`}
                          >
                            {dragOverStatus === status.id
                              ? 'Relâchez pour déplacer la tâche'
                              : 'Déposez une tâche ici'}
                          </div>
                        )}
                      </div>
                    </section>
                  );
                })}
            </div>
          </>
        ) : view === 'planning' ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-center justify-end gap-1 rounded-lg border bg-card p-1">
              {(
                [
                  ['years', ganttFrench ? 'Années' : 'Years'],
                  ['months', ganttFrench ? 'Mois' : 'Months'],
                  ['weeks', ganttFrench ? 'Semaines' : 'Weeks'],
                ] as const
              ).map(([mode, label]) => (
                <Button
                  key={mode}
                  type="button"
                  size="sm"
                  variant={ganttView === mode ? 'default' : 'ghost'}
                  onClick={() => {
                    setGanttView(mode);
                  }}
                  aria-pressed={ganttView === mode}
                >
                  {label}
                </Button>
              ))}
              <Button
                type="button"
                size="sm"
                variant={ganttView === 'fit' ? 'default' : 'ghost'}
                onClick={() => {
                  setFittedGanttDisplay(calculatedFitDisplay);
                  setGanttView('fit');
                }}
                aria-pressed={ganttView === 'fit'}
              >
                <Maximize2 className="size-4" />
                {ganttFrench ? 'Tout afficher' : 'Fit all'}
              </Button>
            </div>
            <section
              ref={ganttShellRef}
              className="project-gantt-shell min-h-0 flex-1 overflow-hidden rounded-xl border bg-card"
            >
              <style>{ganttPriorityStyles}</style>
              <GanttTheme>
                <Locale words={ganttLocale}>
                  <Tooltip
                    api={ganttApi ?? undefined}
                    content={({ data }) => {
                      if (!('task' in data)) return null;
                      const task = board.tasks.find(
                        (item) => item.id === String(data.task.id),
                      );
                      if (!task) return null;
                      const status = board.statuses.find(
                        (item) => item.id === task.statusId,
                      );
                      const statusColor =
                        palette[paletteColor(status?.color, 'slate')];
                      const subtasks = childrenFor(task.id);
                      const dependencies = dependencyIdsFor(task.id)
                        .map((id) => board.tasks.find((item) => item.id === id))
                        .filter((item): item is ProjectTaskSummary =>
                          Boolean(item),
                        );
                      const formatDate = (value: number | null) =>
                        value
                          ? new Intl.DateTimeFormat(undefined, {
                              dateStyle: 'medium',
                            }).format(value)
                          : ganttFrench
                            ? 'Non définie'
                            : 'Not set';
                      return (
                        <div className="project-gantt-tooltip-content w-80 space-y-3 rounded-xl bg-popover p-3 text-sm text-popover-foreground">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 font-semibold leading-snug">
                              {task.title}
                            </div>
                            <span
                              className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium"
                              style={{
                                backgroundColor: `${statusColor}22`,
                                color: statusColor,
                              }}
                            >
                              {status?.name ??
                                (ganttFrench ? 'Non défini' : 'Not set')}
                            </span>
                          </div>
                          <div className="space-y-1">
                            <div className="flex justify-between text-xs">
                              <span className="text-muted-foreground">
                                {ganttFrench
                                  ? 'Avancement global'
                                  : 'Overall progress'}
                              </span>
                              <span className="font-medium">
                                {task.progress} %
                              </span>
                            </div>
                            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-primary"
                                style={{ width: `${task.progress}%` }}
                              />
                            </div>
                          </div>
                          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                            <span className="text-muted-foreground">
                              {ganttFrench ? 'Priorité' : 'Priority'}
                            </span>
                            <span>{priorityName(task.priority)}</span>
                            <span className="text-muted-foreground">
                              {ganttFrench ? 'Début' : 'Start'}
                            </span>
                            <span>{formatDate(task.startAt)}</span>
                            <span className="text-muted-foreground">
                              {ganttFrench ? 'Fin' : 'End'}
                            </span>
                            <span>{formatDate(task.dueAt)}</span>
                            <span className="text-muted-foreground">
                              {ganttFrench ? 'Charge' : 'Workload'}
                            </span>
                            <span>{task.estimateMinutes / 60} h</span>
                          </div>
                          {subtasks.length > 0 && (
                            <div className="space-y-1.5 border-t pt-2">
                              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                {ganttFrench ? 'Sous-tâches' : 'Subtasks'} (
                                {subtasks.length})
                              </div>
                              <div className="space-y-1">
                                {subtasks.slice(0, 5).map((subtask) => (
                                  <div
                                    key={subtask.id}
                                    className="flex items-center justify-between gap-2 text-xs"
                                  >
                                    <span className="truncate">
                                      {subtask.title}
                                    </span>
                                    <span className="shrink-0 text-muted-foreground">
                                      {subtaskLabels[subtask.subtaskStatus]}
                                    </span>
                                  </div>
                                ))}
                                {subtasks.length > 5 && (
                                  <div className="text-xs text-muted-foreground">
                                    +{subtasks.length - 5}{' '}
                                    {ganttFrench ? 'autres' : 'more'}
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                          {dependencies.length > 0 && (
                            <div className="border-t pt-2 text-xs">
                              <span className="font-medium text-muted-foreground">
                                {ganttFrench
                                  ? 'Dépend de :'
                                  : 'Depends on:'}{' '}
                              </span>
                              <span>
                                {dependencies
                                  .map((item) => item.title)
                                  .join(', ')}
                              </span>
                            </div>
                          )}
                          {task.labels.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {task.labels.map((label) => (
                                <span
                                  key={label}
                                  className="rounded bg-muted px-2 py-0.5 text-xs"
                                >
                                  {label}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    }}
                  >
                    <StableProjectGantt
                      key={`${resourceId}:${dark ? 'dark' : 'light'}:${i18n.language}:${ganttView}:${ganttView === 'fit' ? JSON.stringify(fittedGanttDisplay) : ''}`}
                      tasks={ganttTasks as never}
                      links={ganttLinks as never}
                      columns={ganttColumns}
                      taskTypes={ganttTaskTypes}
                      scales={ganttDisplay.scales as never}
                      cellWidth={ganttDisplay.cellWidth}
                      autoScale={false}
                      highlightTime={(date, unit) => {
                        if (unit !== 'day' && unit !== 'hour') return '';
                        const today = new Date();
                        const classes: string[] = [];
                        if (date.getDay() === 0 || date.getDay() === 6) {
                          classes.push('project-gantt-weekend');
                        }
                        if (
                          date.getFullYear() === today.getFullYear() &&
                          date.getMonth() === today.getMonth() &&
                          date.getDate() === today.getDate()
                        ) {
                          classes.push('project-gantt-today-cell');
                        }
                        return classes.join(' ');
                      }}
                      zoom={ganttZoom as never}
                      init={setGanttApi}
                      onUpdateTask={(event) => void persistGanttDates(event)}
                      onAddLink={(event) => void persistGanttLink(event)}
                      onDeleteLink={(event) => void deleteGanttLink(event)}
                    />
                  </Tooltip>
                </Locale>
              </GanttTheme>
              {!ganttTasks.length && (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  Ajoutez des dates pour afficher les tâches dans le planning.
                </div>
              )}
            </section>
          </div>
        ) : (
          <TaskActivityJournal board={board} statuses={board.statuses} />
        )}
      </div>
      </div>
      <Dialog
        open={taskOpen}
        onOpenChange={(open) => {
          setTaskOpen(open);
          if (!open) onModalClose?.();
        }}
      >
        <DialogContent className="flex max-h-[92vh] flex-col overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="px-6 pt-6">
              {editing
                ? editing.parentTaskId
                  ? 'Modifier la sous-tâche'
                  : 'Modifier la tâche'
                : draft.parentTaskId
                  ? 'Nouvelle sous-tâche'
                  : 'Nouvelle tâche'}
            </DialogTitle>
          </DialogHeader>
          {rootTask && (
            <div className="flex shrink-0 gap-1 overflow-x-auto border-b px-6">
              <button
                type="button"
                className={`shrink-0 border-b-2 px-3 py-2 text-sm ${taskTab === rootTask.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground'}`}
                onClick={() => openEdit(rootTask, rootTask.id)}
              >
                Tâche principale
              </button>
              {childrenFor(rootTask.id).map((child) => (
                <button
                  key={child.id}
                  type="button"
                  title={child.title}
                  className={`max-w-52 shrink-0 truncate border-b-2 px-3 py-2 text-sm ${taskTab === child.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground'}`}
                  onClick={() => openEdit(child, rootTask.id)}
                >
                  {child.title}
                </button>
              ))}
              <button
                type="button"
                className={`flex shrink-0 items-center gap-1 border-b-2 px-3 py-2 text-sm ${taskTab === 'new' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground'}`}
                onClick={() => openNew(rootTask.id)}
              >
                <Plus className="h-3.5 w-3.5" /> Ajouter
              </button>
            </div>
          )}
          <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto px-6 py-3">
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t('taskTitle')}
              <Input
                autoFocus
                placeholder={t('taskTitle')}
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t('responsiblePerson')}
              <select
                className="h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground"
                value={draft.assigneeId}
                disabled={
                  people.isPending ||
                  participants.isPending ||
                  people.isError ||
                  participants.isError
                }
                onChange={(e) =>
                  setDraft({ ...draft, assigneeId: e.target.value })
                }
              >
                <option value="">{t('unassignedPerson')}</option>
                {(people.data?.people ?? [])
                  .filter(
                    (person) =>
                      person.id === draft.assigneeId ||
                      (person.active &&
                        participants.data?.participants.some(
                          (member) => member.personId === person.id,
                        )),
                  )
                  .map((person) => {
                    const eligible =
                      person.active &&
                      participants.data?.participants.some(
                        (member) => member.personId === person.id,
                      );
                    return (
                      <option key={person.id} value={person.id}>
                        {personLabel(person)}
                        {!eligible
                          ? ` · ${t('inactiveOrOutsideThisProject')}`
                          : ''}
                      </option>
                    );
                  })}
              </select>
              {draft.assigneeId &&
                !people.data?.people.some(
                  (person) => person.id === draft.assigneeId,
                ) && <span>{t('loadingResponsiblePerson')}</span>}
              {(people.isError || participants.isError) && (
                <span role="alert" className="text-destructive">
                  {t('unableToLoadPeople')}
                </span>
              )}
              <span>
                {t('addEligiblePeopleUsingTheProjectSManageParticipantsMenu')}
              </span>
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t('description')}
              <DictatedTextarea
                placeholder={t('detailedDescription')}
                value={draft.description}
                onChange={(description) => setDraft({ ...draft, description })}
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              {draft.parentTaskId ? (
                <label className="grid gap-1 text-xs text-muted-foreground">
                  {t('executionMode')}
                  <select
                    className="h-8 rounded-lg border bg-background px-2 text-sm text-foreground"
                    value={draft.executionMode}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        executionMode: e.target.value as Draft['executionMode'],
                      })
                    }
                  >
                    <option value="manual">{t('manualSubtask')}</option>
                    <option value="agent">{t('aiAgent')}</option>
                  </select>
                </label>
              ) : (
                <label className="grid gap-1 text-xs text-muted-foreground">
                  {t('executionMode')}
                  <div className="flex h-8 items-center rounded-lg border bg-muted/40 px-3 text-sm text-muted-foreground">
                    {t('manualMainTask')}
                  </div>
                </label>
              )}
              <label className="grid gap-1 text-xs text-muted-foreground">
                {editing &&
                !editing.parentTaskId &&
                childrenFor(editing.id).length > 0
                  ? t('calculatedWorkloadSumOfSubtasks')
                  : t('estimatedWorkloadHours')}
                <Input
                  type="number"
                  min="0"
                  step="0.5"
                  placeholder="Charge estimée (heures)"
                  value={draft.estimateHours}
                  disabled={Boolean(
                    editing &&
                    !editing.parentTaskId &&
                    childrenFor(editing.id).length > 0,
                  )}
                  onChange={(e) =>
                    setDraft({ ...draft, estimateHours: e.target.value })
                  }
                />
              </label>
            </div>
            <label className="grid gap-1 text-xs text-muted-foreground">
              {editing &&
              !editing.parentTaskId &&
              childrenFor(editing.id).length > 0
                ? t('progressCalculatedFromSubtasks')
                : t('progress')}
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  className="min-w-0 flex-1 accent-primary"
                  value={draft.progress}
                  disabled={Boolean(
                    editing &&
                    !editing.parentTaskId &&
                    childrenFor(editing.id).length > 0,
                  )}
                  onChange={(event) =>
                    setDraft({ ...draft, progress: event.target.value })
                  }
                />
                <Input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  className="w-20"
                  value={draft.progress}
                  disabled={Boolean(
                    editing &&
                    !editing.parentTaskId &&
                    childrenFor(editing.id).length > 0,
                  )}
                  onChange={(event) =>
                    setDraft({ ...draft, progress: event.target.value })
                  }
                />
                <span className="w-4 text-sm">%</span>
              </div>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-muted-foreground">
                {t('startDate')}
                <Input
                  type="date"
                  min={dateValue(dateParent?.startAt ?? null) || undefined}
                  max={dateValue(dateParent?.dueAt ?? null) || undefined}
                  value={draft.startAt}
                  onChange={(e) =>
                    setDraft({ ...draft, startAt: e.target.value })
                  }
                />
              </label>
              <label className="text-xs text-muted-foreground">
                {t('plannedEnd')}
                <Input
                  type="date"
                  min={dateValue(dateParent?.startAt ?? null) || undefined}
                  max={dateValue(dateParent?.dueAt ?? null) || undefined}
                  value={draft.dueAt}
                  onChange={(e) =>
                    setDraft({ ...draft, dueAt: e.target.value })
                  }
                />
              </label>
            </div>
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t('acceptanceCriteria')}
              <DictatedTextarea
                placeholder={t('acceptanceCriteria')}
                value={draft.validationCriteria}
                onChange={(validationCriteria) =>
                  setDraft({ ...draft, validationCriteria })
                }
              />
            </label>
            {!draft.parentTaskId && (
              <label className="grid gap-1 text-xs text-muted-foreground">
                {t('workingFolder')}
                <button
                  type="button"
                  className="flex h-9 items-center gap-2 rounded-lg border px-3 text-left text-sm text-foreground"
                  onClick={() => {
                    setFolderSelection(
                      draft.workspacePath || board.project.workspacePath,
                    );
                    setFolderOpen(true);
                  }}
                >
                  <FolderOpen className="h-4 w-4" />
                  <span className="min-w-0 flex-1 truncate">
                    {draft.workspacePath || t('chooseAFolder')}
                  </span>
                  <ChevronRight className="h-4 w-4" />
                </button>
                {editing?.activeFolder &&
                  editing.activeFolder.state !== 'ready' && (
                    <span className="text-xs font-medium text-destructive">
                      {t('activeFolderNeedsResolution')}
                    </span>
                  )}
              </label>
            )}
            <div
              className={`grid gap-2 ${draft.parentTaskId ? 'grid-cols-1' : 'grid-cols-2'}`}
            >
              {!draft.parentTaskId && (
                <label className="grid gap-1 text-xs text-muted-foreground">
                  {t('priority')}
                  <select
                    className="h-8 rounded-lg border bg-background px-2 text-sm text-foreground"
                    value={draft.priority}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        priority: e.target.value as Draft['priority'],
                      })
                    }
                  >
                    {settings.priorityOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {editing && !editing.parentTaskId && (
                <label className="grid gap-1 text-xs text-muted-foreground">
                  {t('status')}
                  <select
                    className="h-8 rounded-lg border bg-background px-2 text-sm text-foreground"
                    value={draft.statusId}
                    onChange={(e) =>
                      setDraft({ ...draft, statusId: e.target.value })
                    }
                  >
                    {board.statuses.map((s) => (
                      <option
                        key={s.id}
                        value={s.id}
                        disabled={
                          isTerminalStatus(s.id) &&
                          childrenFor(editing.id).some(
                            (child) => !isTerminalSubtask(child.subtaskStatus),
                          )
                        }
                      >
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {draft.parentTaskId && (
                <label className="grid gap-1 text-xs text-muted-foreground">
                  {t('subtaskStatus')}
                  <select
                    className="h-8 rounded-lg border bg-background px-2 text-sm text-foreground"
                    value={draft.subtaskStatus}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        subtaskStatus: e.target
                          .value as ProjectTaskSummary['subtaskStatus'],
                      })
                    }
                  >
                    {Object.entries(subtaskLabels)
                      .filter(
                        ([value]) =>
                          value !== 'review' || draft.executionMode === 'agent',
                      )
                      .map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                  </select>
                </label>
              )}
            </div>
            <fieldset className="rounded-lg border p-3">
              <legend className="px-1 text-xs text-muted-foreground">
                {t('labels')}
              </legend>
              <div className="flex flex-wrap gap-2">
                {[
                  ...settings.labels,
                  ...draft.labels
                    .split(',')
                    .map((name) => name.trim())
                    .filter(
                      (name) =>
                        name &&
                        !settings.labels.some((label) => label.name === name),
                    )
                    .map((name) => ({
                      id: `legacy:${name}`,
                      name,
                      color: 'slate' as PaletteColor,
                    })),
                ].map((label) => {
                  const selected = draft.labels
                    .split(',')
                    .map((name) => name.trim())
                    .filter(Boolean);
                  const checked = selected.includes(label.name);
                  return (
                    <label
                      key={label.id}
                      className="flex cursor-pointer items-center gap-2 rounded-full border px-2.5 py-1 text-xs"
                      style={
                        checked
                          ? {
                              borderColor: `${palette[label.color]}88`,
                              backgroundColor: `${palette[label.color]}20`,
                            }
                          : undefined
                      }
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => {
                          const next = event.target.checked
                            ? [...selected, label.name]
                            : selected.filter((name) => name !== label.name);
                          setDraft({ ...draft, labels: next.join(', ') });
                        }}
                      />
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: palette[label.color] }}
                      />
                      {label.name}
                    </label>
                  );
                })}
                {!settings.labels.length && !draft.labels.trim() && (
                  <span className="text-xs text-muted-foreground">
                    Ajoutez des labels depuis les paramètres du tableau.
                  </span>
                )}
              </div>
            </fieldset>
            {!draft.parentTaskId && deliverableResource && (
              <div className="grid gap-1 text-xs text-muted-foreground">
                <span>{t('linkedDeliverable')}</span>
                {linkedDeliverable ? (
                  <button
                    type="button"
                    className="flex h-10 items-center gap-2 rounded-lg border px-3 text-left text-sm text-foreground hover:bg-muted"
                    onClick={() => {
                      setTaskOpen(false);
                      void navigate({
                        to: '/projects/$projectId/resources/$resourceId',
                        params: {
                          projectId,
                          resourceId: deliverableResource.id,
                        },
                        search: { task: undefined },
                      });
                    }}
                  >
                    <PackageOpen className="h-4 w-4 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 truncate">{linkedDeliverable.title}</span>
                    <ChevronRight className="h-4 w-4 shrink-0" />
                  </button>
                ) : (
                  <div className="flex h-10 items-center gap-2 rounded-lg border bg-muted/30 px-3 text-sm text-muted-foreground">
                    <PackageOpen className="h-4 w-4" />
                    {t('noLinkedDeliverable')}
                  </div>
                )}
              </div>
            )}
            {!draft.parentTaskId && (
              <fieldset className="rounded-lg border p-3">
                <legend className="px-1 text-xs text-muted-foreground">
                  {t('dependsOn')}
                </legend>
                <div className="max-h-28 space-y-1 overflow-auto">
                  {board.tasks
                    .filter((t) => !t.parentTaskId && t.id !== editing?.id)
                    .map((task) => (
                      <label
                        key={task.id}
                        className="flex items-center gap-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={draft.dependencyIds.includes(task.id)}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              dependencyIds: e.target.checked
                                ? [...draft.dependencyIds, task.id]
                                : draft.dependencyIds.filter(
                                    (id) => id !== task.id,
                                  ),
                            })
                          }
                        />
                        {task.title}
                      </label>
                    ))}
                </div>
              </fieldset>
            )}
            {editing && blocked(editing) && (
              <p className="text-xs text-amber-500">
                Cette tâche est bloquée par une dépendance non terminée.
              </p>
            )}
            {editing && (
              <fieldset className="rounded-lg border bg-muted/20 p-3">
                <legend className="px-1 text-xs text-muted-foreground">
                  {t('systemInformation')}
                </legend>
                <dl className="grid gap-3 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">{t('createdOn')}</dt>
                    <dd className="mt-1 font-medium">
                      {new Date(editing.createdAt).toLocaleString(
                        i18n.language,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {t('lastModified')}
                    </dt>
                    <dd className="mt-1 font-medium">
                      {new Date(editing.updatedAt).toLocaleString(
                        i18n.language,
                      )}
                    </dd>
                  </div>
                </dl>
              </fieldset>
            )}
            {taskError && (
              <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {taskError}
              </p>
            )}
          </div>
          <div className="task-form-actions flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-b-2xl border-t bg-background/95 px-6 py-4 backdrop-blur">
            <div>
              {editing && (
                <Button variant="destructive" onClick={removeTask}>
                  <Trash2 />
                  Supprimer
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {editing?.parentTaskId && editing.linkedThreadId && (
                <Button
                  variant="outline"
                  onClick={() =>
                    navigate({
                      to: '/t/$threadId',
                      params: { threadId: editing.linkedThreadId! },
                    })
                  }
                >
                  <Bot />
                  Ouvrir l’agent
                </Button>
              )}
              {editing?.parentTaskId && editing.agentState === 'review' && (
                <Button variant="secondary" onClick={validateTask}>
                  <Check />
                  Valider et terminer
                </Button>
              )}
              {!draft.parentTaskId && (
                <Button
                  type="button"
                  variant="outline"
                  title={
                    editing && childrenFor(editing.id).length > 0
                      ? 'Cette tâche possède déjà des sous-tâches'
                      : 'Proposer un découpage en sous-tâches'
                  }
                  disabled={
                    !draft.title.trim() ||
                    breakdownLoading ||
                    Boolean(editing && childrenFor(editing.id).length > 0)
                  }
                  onClick={proposeSubtasks}
                >
                  {breakdownLoading ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Sparkles />
                  )}
                  Découper avec l’IA
                </Button>
              )}
              {editing &&
                draft.executionMode === 'agent' &&
                editing.agentState !== 'running' &&
                editing.agentState !== 'review' && (
                  <Button
                    variant="secondary"
                    disabled={agentBusy || blocked(editing)}
                    onClick={runAgent}
                  >
                    {agentBusy ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Play />
                    )}
                    Exécuter avec un agent
                  </Button>
                )}
              <Button
                onClick={saveTask}
                disabled={!draft.title.trim() || savingTask}
              >
                {savingTask && <Loader2 className="animate-spin" />}
                Enregistrer
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={breakdownOpen} onOpenChange={setBreakdownOpen}>
        <DialogContent className="flex max-h-[90vh] flex-col overflow-hidden p-0 sm:max-w-3xl">
          <DialogHeader className="shrink-0 px-6 pt-6">
            <DialogTitle>Proposition de sous-tâches</DialogTitle>
            <p className="text-sm text-muted-foreground">
              Ajustez les propositions et leur mode d’exécution avant de les
              créer.
            </p>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-3">
            {breakdownError && (
              <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                {breakdownError}
              </div>
            )}
            {breakdownSuggestions.map((suggestion, index) => {
              const update = (values: Partial<Suggestion>) =>
                setBreakdownSuggestions((items) =>
                  items.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, ...values } : item,
                  ),
                );
              return (
                <section
                  key={index}
                  className="space-y-2 rounded-xl border p-4"
                >
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-muted px-2 py-1 text-xs">
                      Sous-tâche {index + 1}
                    </span>
                    <div className="flex-1" />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      title="Retirer cette proposition"
                      onClick={() =>
                        setBreakdownSuggestions((items) =>
                          items.filter((_, itemIndex) => itemIndex !== index),
                        )
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  <Input
                    value={suggestion.title}
                    placeholder="Titre de la sous-tâche"
                    onChange={(event) => update({ title: event.target.value })}
                  />
                  <Textarea
                    value={suggestion.description}
                    placeholder="Description"
                    onChange={(event) =>
                      update({ description: event.target.value })
                    }
                  />
                  <div className="grid gap-2 sm:grid-cols-2">
                    <select
                      className="h-8 rounded-lg border bg-background px-2 text-sm"
                      value={suggestion.executionMode}
                      onChange={(event) =>
                        update({
                          executionMode: event.target
                            .value as Suggestion['executionMode'],
                        })
                      }
                    >
                      <option value="manual">Manuelle</option>
                      <option value="agent">Agent IA</option>
                    </select>
                    <Input
                      type="number"
                      min="0"
                      step="0.5"
                      value={suggestion.estimateHours}
                      placeholder="Charge (heures)"
                      onChange={(event) =>
                        update({
                          estimateHours: Math.max(
                            0,
                            Number(event.target.value) || 0,
                          ),
                        })
                      }
                    />
                  </div>
                  <Textarea
                    value={suggestion.validationCriteria}
                    placeholder="Conditions de validation"
                    onChange={(event) =>
                      update({ validationCriteria: event.target.value })
                    }
                  />
                  {settings.labels.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-sm font-medium">Labels</div>
                      <div className="flex flex-wrap gap-2">
                        {settings.labels.map((label) => {
                          const selected = suggestion.labels.includes(
                            label.name,
                          );
                          return (
                            <label
                              key={label.id}
                              className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm"
                            >
                              <input
                                type="checkbox"
                                checked={selected}
                                onChange={(event) =>
                                  update({
                                    labels: event.target.checked
                                      ? [...suggestion.labels, label.name]
                                      : suggestion.labels.filter(
                                          (name) => name !== label.name,
                                        ),
                                  })
                                }
                              />
                              <span
                                className="size-2.5 rounded-full"
                                style={{
                                  backgroundColor: palette[label.color],
                                }}
                              />
                              {label.name}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {suggestion.assignmentReason && (
                    <p className="text-xs text-muted-foreground">
                      Recommandation IA : {suggestion.assignmentReason}
                    </p>
                  )}
                </section>
              );
            })}
            <Button
              variant="outline"
              className="w-full"
              onClick={() =>
                setBreakdownSuggestions((items) => [
                  ...items,
                  {
                    title: '',
                    description: '',
                    priority: 'normal',
                    estimateHours: 0,
                    validationCriteria: '',
                    parentTitle: draft.title,
                    dependsOnTitles: [],
                    executionMode: 'manual',
                    assignmentReason: '',
                    labels: [],
                  },
                ])
              }
            >
              <Plus /> Ajouter une sous-tâche
            </Button>
          </div>
          <div className="flex shrink-0 justify-end gap-2 rounded-b-2xl border-t bg-background/95 px-6 py-4">
            <Button variant="outline" onClick={() => setBreakdownOpen(false)}>
              Annuler
            </Button>
            <Button
              disabled={
                breakdownLoading ||
                !breakdownSuggestions.some((item) => item.title.trim())
              }
              onClick={createProposedSubtasks}
            >
              {breakdownLoading && <Loader2 className="animate-spin" />}
              Créer les sous-tâches
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={completionStatusOpen}
        onOpenChange={(open) => {
          setCompletionStatusOpen(open);
          if (!open) setParentToComplete(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Terminer la tâche</DialogTitle>
            <p className="text-sm text-muted-foreground">
              Toutes les sous-tâches sont terminées. Choisissez le statut de fin
              à appliquer à la tâche parente.
            </p>
          </DialogHeader>
          <div className="grid gap-2">
            {board.statuses
              .filter((status) => terminalStatusIds.includes(status.id))
              .map((status) => (
                <Button
                  key={status.id}
                  variant="outline"
                  className="justify-start"
                  onClick={() => {
                    if (parentToComplete)
                      void completeParent(parentToComplete, status.id);
                  }}
                >
                  <span
                    className="h-3 w-3 rounded-full"
                    style={{
                      backgroundColor:
                        palette[paletteColor(status.color, 'slate')],
                    }}
                  />
                  {status.name}
                </Button>
              ))}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={folderOpen} onOpenChange={setFolderOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Dossier de travail</DialogTitle>
          </DialogHeader>
          <DirectorySelectionTree
            selectedPath={folderSelection}
            onSelectedPathChange={setFolderSelection}
            allowedRoots={board.workspaces.map((w) => w.path)}
            showCreateButton
            showSelectedPath
          />
          <DialogFooter>
            <Button
              disabled={!folderSelection}
              onClick={() => {
                if (folderSelection)
                  setDraft({ ...draft, workspacePath: folderSelection });
                setFolderOpen(false);
              }}
            >
              Choisir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="shrink-0 px-6 pb-4 pt-6">
            <DialogTitle>Paramètres du tableau des tâches</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 pb-6">
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium">Statuts et colonnes</h3>
                  <p className="text-xs text-muted-foreground">
                    Ajoutez, renommez, recolorez ou supprimez les colonnes.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditingStatus(null);
                    setStatusName('');
                    setStatusColor('blue');
                    setStatusOpen(true);
                  }}
                >
                  <Plus /> Ajouter
                </Button>
              </div>
              <div className="divide-y rounded-lg border">
                {board.statuses.map((status, statusIndex) => (
                  <div
                    key={status.id}
                    className="grid grid-cols-[minmax(0,1fr)_5rem_7rem_9rem_4rem_2rem_2rem] items-center gap-2 px-3 py-2"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span
                        className="h-3 w-3 shrink-0 rounded-full"
                        style={{
                          backgroundColor:
                            palette[paletteColor(status.color, 'slate')],
                        }}
                      />
                      <span className="min-w-0 truncate text-sm">
                        {status.name}
                      </span>
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {status.system ? 'Système' : ''}
                    </span>
                    <label className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={draftTerminalStatusIds.includes(status.id)}
                        onChange={(event) =>
                          setSettingsDraft((current) => ({
                            ...current,
                            terminalStatusIds: event.target.checked
                              ? [...draftTerminalStatusIds, status.id]
                              : draftTerminalStatusIds.filter(
                                  (id) => id !== status.id,
                                ),
                          }))
                        }
                      />
                      Statut de fin
                    </label>
                    <label className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={settingsDraft.hiddenEmptyStatusIds.includes(
                          status.id,
                        )}
                        onChange={(event) =>
                          setSettingsDraft((current) => ({
                            ...current,
                            hiddenEmptyStatusIds: event.target.checked
                              ? [...current.hiddenEmptyStatusIds, status.id]
                              : current.hiddenEmptyStatusIds.filter(
                                  (id) => id !== status.id,
                                ),
                          }))
                        }
                      />
                      Masquer si vide
                    </label>
                    <span className="flex justify-center">
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        disabled={statusIndex === 0}
                        title="Monter la colonne"
                        onClick={() => moveStatus(statusIndex, -1)}
                      >
                        <ChevronUp />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        disabled={statusIndex === board.statuses.length - 1}
                        title="Descendre la colonne"
                        onClick={() => moveStatus(statusIndex, 1)}
                      >
                        <ChevronDown />
                      </Button>
                    </span>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      title="Modifier"
                      onClick={() => {
                        setEditingStatus(status);
                        setStatusName(status.name);
                        setStatusColor(status.color);
                        setStatusOpen(true);
                      }}
                    >
                      <Pencil />
                    </Button>
                    {!status.system && (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        title="Supprimer"
                        onClick={() => removeStatus(status)}
                      >
                        <Trash2 className="text-destructive" />
                      </Button>
                    )}
                    {status.system && <span aria-hidden="true" />}
                  </div>
                ))}
              </div>
            </section>

            <PrioritySettingsSection
              values={settingsDraft.priorityOptions}
              usedValues={new Set(board.tasks.map((task) => task.priority))}
              onChange={(priorityOptions) =>
                setSettingsDraft((current) => ({
                  ...current,
                  priorityOptions,
                  defaultPriority: priorityOptions.some(
                    (option) => option.id === current.defaultPriority,
                  )
                    ? current.defaultPriority
                    : (priorityOptions[0]?.id ?? ''),
                }))
              }
            />
            <SubtaskStatusSettingsSection
              labels={subtaskLabels}
              values={settingsDraft.subtaskColors}
              terminalValues={settingsDraft.terminalSubtaskStatuses}
              onChange={(key, color) =>
                setSettingsDraft((current) => ({
                  ...current,
                  subtaskColors: {
                    ...current.subtaskColors,
                    [key]: color,
                  },
                }))
              }
            />

            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium">Labels</h3>
                  <p className="text-xs text-muted-foreground">
                    Ces labels seront proposés sous forme de cases à cocher.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setSettingsDraft((current) => ({
                      ...current,
                      labels: [
                        ...current.labels,
                        {
                          id: crypto.randomUUID(),
                          name: 'Nouveau label',
                          color: 'blue',
                        },
                      ],
                    }))
                  }
                >
                  <Plus /> Ajouter
                </Button>
              </div>
              {settingsDraft.labels.length ? (
                <div className="space-y-2">
                  {settingsDraft.labels.map((label) => (
                    <div
                      key={label.id}
                      className="flex items-center gap-2 rounded-lg border p-2"
                    >
                      <span
                        className="h-4 w-4 shrink-0 rounded-full"
                        style={{ backgroundColor: palette[label.color] }}
                      />
                      <Input
                        value={label.name}
                        maxLength={50}
                        aria-label="Nom du label"
                        onChange={(event) =>
                          setSettingsDraft((current) => ({
                            ...current,
                            labels: current.labels.map((item) =>
                              item.id === label.id
                                ? { ...item, name: event.target.value }
                                : item,
                            ),
                          }))
                        }
                      />
                      <select
                        className="h-9 rounded-md border bg-background px-2 text-xs"
                        value={label.color}
                        aria-label="Couleur du label"
                        onChange={(event) =>
                          setSettingsDraft((current) => ({
                            ...current,
                            labels: current.labels.map((item) =>
                              item.id === label.id
                                ? {
                                    ...item,
                                    color: event.target.value as PaletteColor,
                                  }
                                : item,
                            ),
                          }))
                        }
                      >
                        {Object.keys(palette).map((color) => (
                          <option key={color} value={color}>
                            {color}
                          </option>
                        ))}
                      </select>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        title="Supprimer le label"
                        onClick={() =>
                          setSettingsDraft((current) => ({
                            ...current,
                            labels: current.labels.filter(
                              (item) => item.id !== label.id,
                            ),
                          }))
                        }
                      >
                        <Trash2 className="text-destructive" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
                  Aucun label configuré.
                </p>
              )}
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-medium">Comportement par défaut</h3>
              <label className="grid gap-1 text-xs text-muted-foreground">
                Statut des nouvelles tâches
                <select
                  className="h-9 rounded-lg border bg-background px-2 text-sm text-foreground"
                  value={settingsDraft.defaultStatusId}
                  onChange={(event) =>
                    setSettingsDraft((current) => ({
                      ...current,
                      defaultStatusId: event.target.value,
                    }))
                  }
                >
                  <option value="">Actions non assignées</option>
                  {board.statuses.map((status) => (
                    <option key={status.id} value={status.id}>
                      {status.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                Priorité des nouvelles tâches
                <select
                  className="h-9 rounded-lg border bg-background px-2 text-sm text-foreground"
                  value={settingsDraft.defaultPriority}
                  onChange={(event) =>
                    setSettingsDraft((current) => ({
                      ...current,
                      defaultPriority: event.target
                        .value as ProjectTaskSummary['priority'],
                    }))
                  }
                >
                  {settingsDraft.priorityOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={settingsDraft.confirmDelete}
                  onChange={(event) =>
                    setSettingsDraft((current) => ({
                      ...current,
                      confirmDelete: event.target.checked,
                    }))
                  }
                />
                Demander confirmation avant de supprimer une tâche
              </label>
            </section>
          </div>
          <DialogFooter className="shrink-0 border-t bg-background/95 px-6 py-4">
            <Button variant="outline" onClick={() => setSettingsOpen(false)}>
              Annuler
            </Button>
            <Button
              disabled={
                request.isPending ||
                settingsDraft.labels.some((label) => !label.name.trim()) ||
                new Set(
                  settingsDraft.labels.map((label) =>
                    label.name.trim().toLocaleLowerCase(),
                  ),
                ).size !== settingsDraft.labels.length
              }
              onClick={saveSettings}
            >
              Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={statusOpen} onOpenChange={setStatusOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingStatus ? 'Modifier le statut' : 'Ajouter un statut'}
            </DialogTitle>
          </DialogHeader>
          <Input
            value={statusName}
            onChange={(e) => setStatusName(e.target.value)}
            placeholder="Nom de la colonne"
          />
          <select
            className="h-8 rounded-lg border bg-background px-2"
            value={statusColor}
            onChange={(e) => setStatusColor(e.target.value)}
          >
            {Object.keys(palette).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <DialogFooter>
            <Button onClick={saveStatus}>Enregistrer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={aiOpen} onOpenChange={setAiOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Planification assistée par IA</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 rounded-lg border bg-muted/40 p-1">
            <Button
              variant={aiMode === 'create' ? 'default' : 'ghost'}
              onClick={() => {
                setAiMode('create');
                setAiError('');
                setReplanSuggestions([]);
              }}
            >
              Créer un plan
            </Button>
            <Button
              variant={aiMode === 'replan' ? 'default' : 'ghost'}
              onClick={() => {
                setAiMode('replan');
                setAiError('');
                setAiSuggestions([]);
              }}
            >
              Replanifier le projet
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            {aiMode === 'create'
              ? 'Le plan définit d’abord les tâches principales et leurs dépendances. Vous pourrez ensuite découper chaque tâche en sous-tâches depuis sa fiche.'
              : 'La replanification ajuste uniquement les tâches principales existantes. Leurs sous-tâches sont conservées.'}
          </p>
          <DictatedTextarea
            rows={5}
            placeholder={
              aiMode === 'create'
                ? 'Décrivez l’objectif, les contraintes et le résultat attendu…'
                : 'Ajoutez éventuellement de nouvelles contraintes : échéance, disponibilité, ordre de priorité…'
            }
            value={aiPrompt}
            onChange={setAiPrompt}
          />
          {aiLoading && (
            <div className="flex items-center gap-2 rounded-lg border p-3 text-sm">
              <Loader2 className="animate-spin" />
              L’IA construit le plan. Cela peut prendre quelques secondes…
            </div>
          )}
          {aiError && (
            <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {aiError}
            </div>
          )}
          {aiMode === 'create' && aiSuggestions.length > 0 && (
            <div className="max-h-72 space-y-2 overflow-auto">
              {aiSuggestions.map((s, i) => (
                <div key={`${s.title}-${i}`} className="rounded-lg border p-3">
                  <div className="font-medium">{s.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {s.description}
                  </div>
                  <div className="mt-1 text-xs">
                    {s.estimateHours} h · {priorityName(s.priority)}
                    {s.parentTitle ? ` · sous-tâche de ${s.parentTitle}` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
          {aiMode === 'replan' && replanSuggestions.length > 0 && (
            <div className="max-h-[55vh] space-y-3 overflow-auto pr-1">
              <p className="text-sm text-muted-foreground">
                Vérifiez les changements proposés. Seules les tâches cochées
                seront modifiées.
              </p>
              {replanSuggestions.map((suggestion) => {
                const task = board.tasks.find(
                  (item) => item.id === suggestion.taskId,
                );
                if (!task) return null;
                const oldDependencies =
                  board.dependencies
                    .filter((dependency) => dependency.taskId === task.id)
                    .map((dependency) =>
                      board.tasks.find(
                        (item) => item.id === dependency.dependsOnTaskId,
                      ),
                    )
                    .filter(Boolean)
                    .map((item) => item!.title)
                    .join(', ') || 'Aucune';
                const newDependencies =
                  suggestion.dependencyIds
                    .map((id) => board.tasks.find((item) => item.id === id))
                    .filter(Boolean)
                    .map((item) => item!.title)
                    .join(', ') || 'Aucune';
                const rows = [
                  task.priority !== suggestion.priority && [
                    'Priorité',
                    priorityName(task.priority),
                    priorityName(suggestion.priority),
                  ],
                  task.estimateMinutes !==
                    Math.round(suggestion.estimateHours * 60) && [
                    'Charge',
                    `${task.estimateMinutes / 60} h`,
                    `${suggestion.estimateHours} h`,
                  ],
                  dateValue(task.startAt) !== dateValue(suggestion.startAt) && [
                    'Début',
                    dateValue(task.startAt) || 'Non défini',
                    dateValue(suggestion.startAt) || 'Non défini',
                  ],
                  dateValue(task.dueAt) !== dateValue(suggestion.dueAt) && [
                    'Fin',
                    dateValue(task.dueAt) || 'Non définie',
                    dateValue(suggestion.dueAt) || 'Non définie',
                  ],
                  oldDependencies !== newDependencies && [
                    'Dépendances',
                    oldDependencies,
                    newDependencies,
                  ],
                ].filter(Boolean) as string[][];
                return (
                  <label
                    key={task.id}
                    className="block cursor-pointer rounded-lg border p-3"
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={selectedReplanTasks.has(task.id)}
                        onChange={(event) =>
                          setSelectedReplanTasks((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(task.id);
                            else next.delete(task.id);
                            return next;
                          })
                        }
                      />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{task.title}</div>
                        <div className="mt-2 grid gap-1 text-xs">
                          {rows.map(([name, before, after]) => (
                            <div
                              key={name}
                              className="grid grid-cols-[7rem_1fr_auto_1fr] gap-2"
                            >
                              <span className="text-muted-foreground">
                                {name}
                              </span>
                              <span>{before}</span>
                              <span>→</span>
                              <span className="font-medium">{after}</span>
                            </div>
                          ))}
                        </div>
                        {suggestion.reason && (
                          <p className="mt-2 text-xs text-muted-foreground">
                            {suggestion.reason}
                          </p>
                        )}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
          <DialogFooter>
            {aiMode === 'create' && aiSuggestions.length ? (
              <Button disabled={aiLoading} onClick={addSuggestions}>
                Créer les {aiSuggestions.length} tâches
              </Button>
            ) : aiMode === 'replan' && replanSuggestions.length ? (
              <Button
                disabled={aiLoading || selectedReplanTasks.size === 0}
                onClick={applyReplan}
              >
                Appliquer {selectedReplanTasks.size} modification
                {selectedReplanTasks.size > 1 ? 's' : ''}
              </Button>
            ) : (
              <Button
                disabled={
                  (aiMode === 'create' && !aiPrompt.trim()) || aiLoading
                }
                onClick={aiMode === 'create' ? generatePlan : generateReplan}
              >
                {aiLoading ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Sparkles />
                )}
                {aiMode === 'create'
                  ? 'Générer le plan'
                  : 'Analyser le planning'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function DictatedTextarea({
  value,
  placeholder,
  rows,
  onChange,
}: {
  value: string;
  placeholder: string;
  rows?: number;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative">
      <Textarea
        className="pr-10"
        rows={rows}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="absolute bottom-1.5 right-1.5 rounded-md border bg-background/90 shadow-sm backdrop-blur">
        <VoiceDictationButton
          onTranscript={(text) =>
            onChange(`${value}${value.trim() ? ' ' : ''}${text}`)
          }
        />
      </div>
    </div>
  );
}

function TaskActivityJournal({
  board,
  statuses,
}: {
  board: ProjectTaskBoard;
  statuses: ProjectTaskStatusSummary[];
}) {
  const { t, i18n } = useTranslation();
  const [actorFilter, setActorFilter] = useState('all');
  const actorOptions = Array.from(
    new Map(
      board.activity.map((entry) => [
        taskActivityActorKey(entry.actorPersonId, entry.actorName),
        entry.actorName || t('system'),
      ]),
    ),
  );
  const filteredActivity =
    actorFilter === 'all'
      ? board.activity
      : board.activity.filter(
          (entry) =>
            taskActivityActorKey(entry.actorPersonId, entry.actorName) ===
            actorFilter,
        );
  const fieldLabels: Record<string, string> = {
    title: 'Titre',
    description: 'Description',
    priority: 'Priorité',
    statusId: 'Statut',
    subtaskStatus: 'Statut de sous-tâche',
    workspacePath: 'Workspace',
    executionMode: 'Mode d’exécution',
    agentState: 'État de l’agent',
    estimateMinutes: 'Charge estimée',
    progress: 'Avancement',
    startAt: 'Date de début',
    dueAt: 'Date de fin',
    validationCriteria: 'Conditions de validation',
    labels: 'Labels',
    linkedFilePath: 'Fichier lié',
    parentTaskId: 'Tâche parente',
    position: 'Position',
    assigneeId: t('responsiblePerson'),
  };
  const formatValue = (field: string, value: unknown) => {
    if (value === null || value === undefined || value === '') return '—';
    if (field === 'statusId')
      return (
        statuses.find((status) => status.id === value)?.name ?? String(value)
      );
    if (field === 'subtaskStatus')
      return (
        subtaskLabels[value as ProjectTaskSummary['subtaskStatus']] ??
        String(value)
      );
    if (field === 'startAt' || field === 'dueAt')
      return new Date(Number(value)).toLocaleDateString(i18n.language);
    if (field === 'estimateMinutes') return `${Number(value) / 60} h`;
    if (field === 'progress') return `${value} %`;
    if (field === 'priority') return String(value);
    if (Array.isArray(value)) return value.join(', ') || '—';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
      <div className="flex shrink-0 flex-col gap-3 border-b bg-card px-5 py-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="font-semibold">Journal des modifications</h2>
          <p className="text-sm text-muted-foreground">
            Historique chronologique des tâches et des sous-tâches.
          </p>
        </div>
        {!!board.activity.length && (
          <label className="shrink-0">
            <span className="sr-only">{t('filterByPerson')}</span>
            <select
              value={actorFilter}
              onChange={(event) => setActorFilter(event.target.value)}
              className="h-9 min-w-48 cursor-pointer rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            >
              <option value="all">{t('allPeople')}</option>
              {actorOptions.map(([key, name]) => (
                <option key={key} value={key}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {!board.activity.length ? (
        <div className="p-10 text-center text-sm text-muted-foreground">
          Aucune modification enregistrée pour le moment.
        </div>
      ) : !filteredActivity.length ? (
        <div className="p-10 text-center text-sm text-muted-foreground">
          {t('noActivityForThisPerson')}
        </div>
      ) : (
        <div className="min-h-0 flex-1 divide-y overflow-y-auto">
          {filteredActivity.map((entry) => {
            const changes = Object.entries(entry.changes);
            return (
              <article
                key={entry.id}
                className="grid gap-3 px-5 py-4 md:grid-cols-[11rem_minmax(12rem,1fr)_2fr]"
              >
                <time className="text-xs text-muted-foreground">
                  {new Date(entry.createdAt).toLocaleString(i18n.language)}
                  <span className="mt-1 block">
                    {t('byName', {
                      name: entry.actorName || t('system'),
                    })}
                  </span>
                </time>
                <div className="min-w-0">
                  <div
                    className="truncate text-sm font-medium"
                    title={entry.taskTitle}
                  >
                    {entry.taskTitle}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{entry.parentTaskId ? 'Sous-tâche' : 'Tâche'}</span>
                    <span>·</span>
                    <span>
                      {entry.action === 'created'
                        ? 'Créée'
                        : entry.action === 'deleted'
                          ? 'Supprimée'
                          : 'Modifiée'}
                    </span>
                  </div>
                </div>
                <div className="space-y-1.5 text-xs">
                  {entry.action === 'created' && (
                    <span className="text-muted-foreground">
                      Création de l’élément
                    </span>
                  )}
                  {entry.action === 'deleted' && (
                    <span className="text-muted-foreground">
                      Suppression de l’élément
                    </span>
                  )}
                  {changes.map(([field, change]) => (
                    <div
                      key={field}
                      className="grid gap-1 sm:grid-cols-[10rem_1fr]"
                    >
                      <span className="font-medium">
                        {fieldLabels[field] ?? field}
                      </span>
                      <span className="min-w-0 break-words text-muted-foreground">
                        <span className="line-through opacity-70">
                          {formatValue(field, change.before)}
                        </span>{' '}
                        →{' '}
                        <span className="text-foreground">
                          {formatValue(field, change.after)}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function taskActivityActorKey(actorPersonId: string | null, actorName: string) {
  return actorPersonId ? `person:${actorPersonId}` : `system:${actorName}`;
}

function PrioritySettingsSection({
  values,
  usedValues,
  onChange,
}: {
  values: Array<{ id: string; name: string; color: PaletteColor }>;
  usedValues: Set<string>;
  onChange: (
    values: Array<{ id: string; name: string; color: PaletteColor }>,
  ) => void;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Priorités</h3>
          <p className="text-xs text-muted-foreground">
            Ajoutez ou renommez les priorités et choisissez leur couleur.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            onChange([
              ...values,
              {
                id: `priority-${Date.now()}`,
                name: 'Nouvelle priorité',
                color: 'slate',
              },
            ])
          }
        >
          <Plus /> Ajouter
        </Button>
      </div>
      <div className="overflow-hidden rounded-xl border">
        {values.map((value) => (
          <div
            key={value.id}
            className="grid gap-3 border-b px-4 py-3 last:border-b-0 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto] sm:items-center"
          >
            <span
              className="h-4 w-4 rounded-full"
              style={{ backgroundColor: palette[value.color] }}
            />
            <Input
              value={value.name}
              aria-label="Nom de la priorité"
              onChange={(event) =>
                onChange(
                  values.map((item) =>
                    item.id === value.id
                      ? { ...item, name: event.target.value }
                      : item,
                  ),
                )
              }
            />
            <select
              className="h-8 rounded-md border bg-background px-2 text-xs"
              value={value.color}
              onChange={(event) =>
                onChange(
                  values.map((item) =>
                    item.id === value.id
                      ? {
                          ...item,
                          color: event.target.value as PaletteColor,
                        }
                      : item,
                  ),
                )
              }
            >
              {Object.entries(palette).map(([color, hex]) => (
                <option key={color} value={color}>
                  {color} · {hex}
                </option>
              ))}
            </select>
            <span className="text-[10px] text-muted-foreground">
              {usedValues.has(value.id) ? 'Utilisée' : ''}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function SubtaskStatusSettingsSection<K extends string>({
  labels,
  values,
  terminalValues,
  onChange,
}: {
  labels: Record<K, string>;
  values: Record<K, PaletteColor>;
  terminalValues: K[];
  onChange: (key: K, color: PaletteColor) => void;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">Statuts des sous-tâches</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Les statuts et leur état final sont fixes. Seule leur couleur peut
          être personnalisée.
        </p>
      </div>
      <div className="overflow-hidden rounded-xl border">
        <div className="hidden grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-5 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground sm:grid">
          <span>Statut</span>
          <span>Couleur</span>
          <span>État final</span>
        </div>
        {(Object.keys(labels) as K[]).map((key) => (
          <div
            key={key}
            className="grid gap-3 border-b px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:gap-5"
          >
            <div className="flex min-w-0 items-center gap-3">
              <span
                className="h-4 w-4 shrink-0 rounded-full"
                style={{ backgroundColor: palette[values[key]] }}
              />
              <span className="truncate text-sm font-medium">
                {labels[key]}
              </span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                Fixe
              </span>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="sm:hidden">Couleur</span>
              <select
                className="h-8 rounded-md border bg-background px-2 text-xs text-foreground"
                value={values[key]}
                onChange={(event) =>
                  onChange(key, event.target.value as PaletteColor)
                }
              >
                {Object.entries(palette).map(([color, hex]) => (
                  <option key={color} value={color}>
                    {color} · {hex}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 whitespace-nowrap text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={terminalValues.includes(key)}
                disabled
                readOnly
              />
              Statut de fin
            </label>
          </div>
        ))}
      </div>
    </section>
  );
}

function TaskCard({
  task,
  subtasks,
  blocked,
  overdue,
  settings,
  dragging,
  onDrag,
  onDragEnd,
  onClick,
  onSubtaskClick,
}: {
  task: ProjectTaskSummary;
  subtasks: ProjectTaskSummary[];
  blocked: boolean;
  overdue: boolean;
  settings: TaskBoardSettings;
  dragging: boolean;
  onDrag: (event: ReactDragEvent<HTMLSpanElement>) => void;
  onDragEnd: () => void;
  onClick: () => void;
  onSubtaskClick: (task: ProjectTaskSummary) => void;
}) {
  const priority = settings.priorityOptions.find(
    (option) => option.id === task.priority,
  );
  const priorityColor = palette[priority?.color ?? 'slate'];
  const startDrag = (event: ReactDragEvent<HTMLSpanElement>) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', task.id);
    const card = event.currentTarget.closest<HTMLElement>('[data-task-card]');
    if (card) {
      const preview = card.cloneNode(true) as HTMLElement;
      const bounds = card.getBoundingClientRect();
      Object.assign(preview.style, {
        position: 'fixed',
        top: '-10000px',
        left: '-10000px',
        width: `${bounds.width}px`,
        opacity: '0.94',
        transform: 'rotate(1deg)',
        boxShadow: '0 18px 45px rgba(0, 0, 0, 0.38)',
        pointerEvents: 'none',
        zIndex: '9999',
      });
      preview.classList.add('ring-2', 'ring-primary/50');
      document.body.appendChild(preview);
      event.dataTransfer.setDragImage(preview, 24, 20);
      window.setTimeout(() => preview.remove(), 0);
    }
    onDrag(event);
  };

  return (
    <div
      data-task-card
      className={`rounded-lg border shadow-sm transition-all ${
        overdue ? 'border-2 ring-1 ring-red-500/30' : ''
      } ${dragging ? 'scale-[0.98] opacity-40' : ''}`}
      style={{
        borderColor: overdue ? '#ef4444' : `${priorityColor}66`,
        backgroundColor: `${priorityColor}18`,
      }}
    >
      <div className="w-full p-3 text-left">
        <div className="flex gap-2">
          <span
            draggable
            onDragStart={startDrag}
            onDragEnd={onDragEnd}
            onClick={(event) => event.stopPropagation()}
            title="Déplacer la tâche"
            className="mt-0.5 flex h-5 w-5 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground active:cursor-grabbing"
          >
            <GripVertical className="h-4 w-4" />
          </span>
          <button
            type="button"
            onClick={onClick}
            className="min-w-0 flex-1 cursor-pointer truncate whitespace-nowrap text-left text-sm font-medium hover:underline"
            title={task.title}
          >
            {task.title}
          </button>
          <span
            className="shrink-0 rounded-full bg-background/70 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground"
            title="Avancement"
          >
            {task.progress}%
          </span>
        </div>
        {task.description && (
          <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
            {task.description}
          </p>
        )}
        {task.labels.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {task.labels.map((name) => {
              const configured = settings.labels.find(
                (label) => label.name === name,
              );
              const color = palette[configured?.color ?? 'slate'];
              return (
                <span
                  key={name}
                  className="rounded-full px-1.5 py-0.5 text-[9px]"
                  style={{ backgroundColor: `${color}20`, color }}
                >
                  {name}
                </span>
              );
            })}
          </div>
        )}
        <div className="mt-2">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${task.progress}%` }}
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <span
            className="rounded px-1.5 py-0.5 text-[10px]"
            style={{
              backgroundColor: `${priorityColor}24`,
              color: priorityColor,
            }}
          >
            {priority?.name ?? task.priority}
          </span>
          {task.estimateMinutes > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Clock3 className="h-3 w-3" />
              {task.estimateMinutes / 60} h
            </span>
          )}
          <ResponsiblePerson id={task.assigneeId} />
          {task.dueAt && (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <CalendarDays className="h-3 w-3" />
              {new Date(task.dueAt).toLocaleDateString()}
            </span>
          )}
          {blocked && (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-500">
              Dépendance bloquante
            </span>
          )}
        </div>
      </div>
      {subtasks.length > 0 && (
        <div className="border-t px-3 py-2">
          <div className="relative space-y-1 border-l border-muted-foreground/30 pl-3">
            {subtasks.map((subtask) => (
              <div
                key={subtask.id}
                className="relative flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs"
              >
                <span className="absolute -left-3.5 top-1/2 w-3 border-t border-muted-foreground/30" />
                {subtask.executionMode === 'agent' ? (
                  <Bot
                    className="h-3.5 w-3.5 shrink-0 text-primary"
                    aria-label="Sous-tâche réalisée par un agent"
                  />
                ) : (
                  <Hand
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    aria-label="Sous-tâche manuelle"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => onSubtaskClick(subtask)}
                    className="block w-full cursor-pointer truncate whitespace-nowrap text-left hover:underline"
                    title={subtask.title}
                  >
                    {subtask.title}
                  </button>
                  <ResponsiblePerson id={subtask.assigneeId} />
                </div>
                <span className="flex w-14 shrink-0 items-center gap-1 text-[9px] text-muted-foreground">
                  <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full bg-primary"
                      style={{ width: `${subtask.progress}%` }}
                    />
                  </span>
                  {subtask.progress}%
                </span>
                <span
                  className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium"
                  style={{
                    backgroundColor: `${
                      palette[settings.subtaskColors[subtask.subtaskStatus]]
                    }24`,
                    color:
                      palette[settings.subtaskColors[subtask.subtaskStatus]],
                  }}
                >
                  {subtaskLabels[subtask.subtaskStatus]}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
