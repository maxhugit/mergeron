import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  canReadThread,
  currentAccess,
  requireProjectAccess,
  requireThreadAccess,
  requireExecutionAccess,
} from '../auth/access-context';
import { ProjectKnowledgeService } from '../project-knowledge/project-knowledge.service';
import { KnowledgeProposalsService } from '../project-knowledge/knowledge-proposals.service';
import { DeliverablesService } from '../deliverables/deliverables.service';
import { and, asc, desc, eq } from 'drizzle-orm';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  projects,
  projectWorkspaces,
  settings,
  simpleChatMessages,
  simpleChatThreads,
} from '../database/schema';
import { ThreadsService } from '../threads/threads.service';
import { CodexAudioService } from './codex-audio.service';
import { ActiveFoldersService } from '../active-folders/active-folders.service';

const DEFAULT_MODEL = 'gpt-5-mini';
const MAX_MESSAGE_LENGTH = 6_000;
const MAX_CONTEXT_MESSAGES = 30;
const REQUEST_TIMEOUT_MS = 120_000;
const MODEL_CACHE_MS = 10 * 60_000;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';
const BACKEND_SETTING_KEY = 'simple-chat:backend';

interface OpenAiUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface OpenAiAnnotation {
  type?: string;
  url?: string;
  title?: string;
  url_citation?: { url?: string; title?: string };
}

interface OpenAiResponse {
  id?: string;
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string };
  output?: Array<{
    type?: string;
    action?: {
      sources?: Array<{ url?: string; title?: string }>;
    };
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: OpenAiAnnotation[];
    }>;
  }>;
  usage?: OpenAiUsage;
}

interface OpenAiModelList {
  data?: Array<{ id?: string }>;
}

export interface SimpleChatSource {
  title: string;
  url: string;
}

@Injectable()
export class SimpleChatService {
  readonly maxAudioBytes = MAX_AUDIO_BYTES;
  private readonly defaultModel =
    process.env.OPENAI_CHAT_MODEL?.trim() || DEFAULT_MODEL;
  private readonly externalKeyFile = process.env.OPENAI_API_KEY_FILE?.trim();
  private readonly managedKeyFile =
    process.env.OPENAI_API_KEY_MANAGED_FILE?.trim() ||
    join(
      process.env.CODEX_HOME?.trim() || '/home/codex/.codex',
      'secrets',
      'openai-api-key',
    );
  private modelCache?: { expiresAt: number; models: string[] };

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly threads: ThreadsService,
    private readonly activeFolders: ActiveFoldersService,
    @Optional() private readonly knowledge?: ProjectKnowledgeService,
    @Optional() private readonly proposals?: KnowledgeProposalsService,
    @Optional() private readonly deliverables?: DeliverablesService,
    @Optional() private readonly audio?: CodexAudioService,
  ) {}

  getBackend(): 'openai' | 'codex' {
    return this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, BACKEND_SETTING_KEY))
      .get()?.value === 'codex'
      ? 'codex'
      : 'openai';
  }

  setBackend(value: unknown) {
    if (value !== 'openai' && value !== 'codex')
      throw BusinessException.badRequest(
        ErrorCode.simpleChat.invalidResponse,
        'Invalid Simple Chat backend',
      );
    const now = Date.now();
    this.db
      .insert(settings)
      .values({
        key: BACKEND_SETTING_KEY,
        value,
        type: 'string',
        category: 'simple-chat',
        description: 'Execution backend used by Simple Chat',
        defaultValue: 'openai',
        constraints: JSON.stringify({ enum: ['openai', 'codex'] }),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: now },
      })
      .run();
    return this.getStatus();
  }

  getStatus() {
    const backend = this.getBackend();
    return {
      configured: backend === 'codex' || this.hasApiKey(),
      model: backend === 'codex' ? 'project' : this.defaultModel,
      webSearch: true,
      backend,
      audioBackend: this.getAudioBackend(),
      audioExperimental: this.getAudioBackend() === 'codex',
    };
  }

  getAudioBackend(): 'openai' | 'codex' {
    const value = this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'simple-chat:audio-backend'))
      .get()?.value;
    return value === 'openai' || value === 'codex' ? value : this.getBackend();
  }

  setAudioBackend(value: unknown) {
    requireExecutionAccess();
    if (value !== 'openai' && value !== 'codex')
      throw BusinessException.badRequest(
        ErrorCode.simpleChat.audioInvalid,
        'Invalid audio backend',
      );
    const now = Date.now();
    this.db
      .insert(settings)
      .values({
        key: 'simple-chat:audio-backend',
        value,
        type: 'string',
        category: 'simple-chat',
        description: 'Dictation backend; Codex CLI is experimental',
        defaultValue: 'openai',
        constraints: JSON.stringify({ enum: ['openai', 'codex'] }),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: now },
      })
      .run();
    return this.getStatus();
  }

  getKeyStatus() {
    return {
      configured: this.hasApiKey(),
      managed: Boolean(this.readKeyFile(this.managedKeyFile)),
    };
  }

  async runProjectAutomation(prompt: string): Promise<string> {
    const response = await this.createResponse(this.defaultModel, [
      {
        role: 'user',
        content: prompt.slice(0, 30_000),
      },
    ]);
    const text = this.extractText(response).trim();
    if (!text) throw new Error('OpenAI returned an empty automation result');
    return text;
  }

  async suggestProjectTasks(prompt: string): Promise<
    Array<{
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
    }>
  > {
    const response = await this.openAiRequest('/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: this.defaultModel,
        input: prompt,
        instructions:
          'Tu es un chef de projet. Construis un plan concret en français. Utilise parentTitle pour créer des sous-tâches et dependsOnTitles pour les dépendances fin-vers-début. Les titres référencés doivent correspondre exactement à un autre titre de la liste. Pour chaque proposition, décide si elle peut être exécutée de façon fiable par un agent IA (agent) ou si elle nécessite une intervention humaine (manual), et explique brièvement ce choix dans assignmentReason. Une tâche principale doit toujours rester manuelle. Dans labels, utilise exclusivement les labels disponibles explicitement fournis dans la demande ; sinon retourne une liste vide.',
        text: {
          format: {
            type: 'json_schema',
            name: 'project_tasks',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                tasks: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 12,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      title: { type: 'string' },
                      description: { type: 'string' },
                      priority: {
                        type: 'string',
                        enum: ['low', 'normal', 'high', 'urgent'],
                      },
                      estimateHours: { type: 'number', minimum: 0 },
                      validationCriteria: { type: 'string' },
                      parentTitle: { type: 'string' },
                      dependsOnTitles: {
                        type: 'array',
                        items: { type: 'string' },
                      },
                      executionMode: {
                        type: 'string',
                        enum: ['manual', 'agent'],
                      },
                      assignmentReason: { type: 'string' },
                      labels: {
                        type: 'array',
                        items: { type: 'string' },
                      },
                    },
                    required: [
                      'title',
                      'description',
                      'priority',
                      'estimateHours',
                      'validationCriteria',
                      'parentTitle',
                      'dependsOnTitles',
                      'executionMode',
                      'assignmentReason',
                      'labels',
                    ],
                  },
                },
              },
              required: ['tasks'],
            },
          },
        },
        store: false,
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as OpenAiResponse;
    if (!response.ok)
      throw BusinessException.internal(
        ErrorCode.simpleChat.upstreamFailed,
        payload.error?.message || `OpenAI API returned HTTP ${response.status}`,
      );
    const parsed = JSON.parse(this.extractText(payload) || '{}') as {
      tasks?: Array<{
        title?: string;
        description?: string;
        priority?: string;
        estimateHours?: number;
        validationCriteria?: string;
        parentTitle?: string;
        dependsOnTitles?: string[];
        executionMode?: string;
        assignmentReason?: string;
        labels?: string[];
      }>;
    };
    return (parsed.tasks ?? []).map((task) => ({
      title: task.title?.trim() || 'Nouvelle tâche',
      description: task.description?.trim() || '',
      priority: ['low', 'normal', 'high', 'urgent'].includes(
        task.priority ?? '',
      )
        ? task.priority!
        : 'normal',
      estimateHours: Math.max(0, Number(task.estimateHours) || 0),
      validationCriteria: task.validationCriteria?.trim() || '',
      parentTitle: task.parentTitle?.trim() || '',
      dependsOnTitles: (task.dependsOnTitles ?? [])
        .map((title) => title.trim())
        .filter(Boolean),
      executionMode: task.executionMode === 'agent' ? 'agent' : 'manual',
      assignmentReason: task.assignmentReason?.trim() || '',
      labels: (task.labels ?? []).map((label) => label.trim()).filter(Boolean),
    }));
  }

  async suggestProjectReplan(prompt: string): Promise<
    Array<{
      taskId: string;
      priority: string;
      estimateHours: number;
      startDate: string;
      dueDate: string;
      dependencyIds: string[];
      reason: string;
    }>
  > {
    const response = await this.openAiRequest('/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: this.defaultModel,
        input: prompt,
        instructions:
          'Tu es un chef de projet prudent. Replanifie uniquement les tâches principales fournies. Conserve exactement leurs identifiants. Propose des dates au format YYYY-MM-DD, une charge réaliste et des dépendances fin-vers-début cohérentes. Ne crée ni ne supprime aucune tâche. Retourne toutes les tâches, y compris celles que tu proposes de laisser inchangées, et justifie brièvement chaque choix.',
        text: {
          format: {
            type: 'json_schema',
            name: 'project_replan',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                tasks: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      taskId: { type: 'string' },
                      priority: {
                        type: 'string',
                        enum: ['low', 'normal', 'high', 'urgent'],
                      },
                      estimateHours: { type: 'number', minimum: 0 },
                      startDate: { type: 'string' },
                      dueDate: { type: 'string' },
                      dependencyIds: {
                        type: 'array',
                        items: { type: 'string' },
                      },
                      reason: { type: 'string' },
                    },
                    required: [
                      'taskId',
                      'priority',
                      'estimateHours',
                      'startDate',
                      'dueDate',
                      'dependencyIds',
                      'reason',
                    ],
                  },
                },
              },
              required: ['tasks'],
            },
          },
        },
        store: false,
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as OpenAiResponse;
    if (!response.ok)
      throw BusinessException.internal(
        ErrorCode.simpleChat.upstreamFailed,
        payload.error?.message || `OpenAI API returned HTTP ${response.status}`,
      );
    const parsed = JSON.parse(this.extractText(payload) || '{}') as {
      tasks?: Array<{
        taskId?: string;
        priority?: string;
        estimateHours?: number;
        startDate?: string;
        dueDate?: string;
        dependencyIds?: string[];
        reason?: string;
      }>;
    };
    return (parsed.tasks ?? []).map((task) => ({
      taskId: task.taskId?.trim() || '',
      priority: ['low', 'normal', 'high', 'urgent'].includes(
        task.priority ?? '',
      )
        ? task.priority!
        : 'normal',
      estimateHours: Math.max(0, Number(task.estimateHours) || 0),
      startDate: task.startDate?.trim() || '',
      dueDate: task.dueDate?.trim() || '',
      dependencyIds: (task.dependencyIds ?? [])
        .map((id) => id.trim())
        .filter(Boolean),
      reason: task.reason?.trim() || '',
    }));
  }

  async suggestTaskAdvice(input: {
    mode: 'analysis' | 'work';
    availableHours: number | null;
    today: string;
    tasks: unknown[];
  }): Promise<{
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
  }> {
    const response = await this.openAiRequest('/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: this.defaultModel,
        input: JSON.stringify(input),
        instructions:
          input.mode === 'analysis'
            ? 'Tu es un conseiller de gestion de projet prudent. Analyse exclusivement les données fournies. Signale les retards, échéances proches, blocages, incohérences, surcharges et améliorations concrètes. Ne prétends jamais modifier le planning. Classe les conseils par importance et cite les identifiants exacts des tâches concernées.'
            : `Tu es un conseiller de travail. Propose un programme réaliste qui tient dans ${input.availableHours} heures. Privilégie les urgences, échéances, dépendances débloquées et travaux déjà commencés. Ne recommande aucune tâche terminée ou bloquée par une dépendance non terminée. Les durées proposées doivent totaliser au maximum le temps disponible.`,
        text: {
          format: {
            type: 'json_schema',
            name: 'task_advice',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                summary: { type: 'string' },
                health: {
                  type: 'string',
                  enum: ['good', 'watch', 'at_risk'],
                },
                advice: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      severity: {
                        type: 'string',
                        enum: [
                          'alert',
                          'recommendation',
                          'opportunity',
                          'info',
                        ],
                      },
                      title: { type: 'string' },
                      description: { type: 'string' },
                      taskIds: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['severity', 'title', 'description', 'taskIds'],
                  },
                },
                work: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      taskId: { type: 'string' },
                      recommendedMinutes: { type: 'number', minimum: 1 },
                      reason: { type: 'string' },
                    },
                    required: ['taskId', 'recommendedMinutes', 'reason'],
                  },
                },
              },
              required: ['summary', 'health', 'advice', 'work'],
            },
          },
        },
        store: false,
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as OpenAiResponse;
    if (!response.ok)
      throw BusinessException.internal(
        ErrorCode.simpleChat.upstreamFailed,
        payload.error?.message || `OpenAI API returned HTTP ${response.status}`,
      );
    const parsed = JSON.parse(this.extractText(payload) || '{}') as {
      summary?: string;
      health?: 'good' | 'watch' | 'at_risk';
      advice?: Array<{
        severity: 'alert' | 'recommendation' | 'opportunity' | 'info';
        title: string;
        description: string;
        taskIds: string[];
      }>;
      work?: Array<{
        taskId: string;
        recommendedMinutes: number;
        reason: string;
      }>;
    };
    const ids = new Set(
      input.tasks
        .map((task) =>
          task && typeof task === 'object' && 'id' in task
            ? String(task.id)
            : '',
        )
        .filter(Boolean),
    );
    return {
      summary: String(parsed.summary ?? '').trim(),
      health: ['good', 'watch', 'at_risk'].includes(parsed.health ?? '')
        ? parsed.health!
        : 'watch',
      advice: (parsed.advice ?? []).map((item) => ({
        ...item,
        taskIds: item.taskIds.filter((id) => ids.has(id)),
      })),
      work: (parsed.work ?? []).filter((item) => ids.has(item.taskId)),
    };
  }

  saveApiKey(value: unknown) {
    const key = typeof value === 'string' ? value.trim() : '';
    if (!key || key.length < 20 || /\s/.test(key)) {
      throw BusinessException.badRequest(
        ErrorCode.simpleChat.apiKeyInvalid,
        'The OpenAI API key is invalid',
      );
    }
    mkdirSync(dirname(this.managedKeyFile), { recursive: true, mode: 0o700 });
    const temporaryFile = `${this.managedKeyFile}.${process.pid}.tmp`;
    writeFileSync(temporaryFile, key, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporaryFile, 0o600);
    renameSync(temporaryFile, this.managedKeyFile);
    return this.getKeyStatus();
  }

  startAudioSession(sdp: unknown) {
    requireExecutionAccess();
    if (this.getAudioBackend() !== 'codex' || !this.audio)
      throw BusinessException.badRequest(
        ErrorCode.simpleChat.audioInvalid,
        'Le moteur de dictée CLI n’est pas sélectionné ou disponible.',
      );
    return this.audio.start(sdp);
  }

  finishAudioSession(id: string) {
    requireExecutionAccess();
    if (!this.audio)
      throw BusinessException.badRequest(
        ErrorCode.simpleChat.audioInvalid,
        'Session vocale indisponible.',
      );
    return this.audio.finish(id);
  }

  cancelAudioSession(id: string) {
    requireExecutionAccess();
    if (!this.audio)
      throw BusinessException.badRequest(
        ErrorCode.simpleChat.audioInvalid,
        'Session vocale indisponible.',
      );
    return this.audio.cancel(id);
  }

  async transcribeAudio(input: {
    bytes: Buffer;
    filename: string;
    mimeType?: string;
  }): Promise<{ text: string }> {
    if (!input.bytes.length) {
      throw BusinessException.badRequest(
        ErrorCode.simpleChat.audioRequired,
        'Voice recording is empty',
      );
    }
    if (input.bytes.length > MAX_AUDIO_BYTES) {
      throw BusinessException.payloadTooLarge(
        ErrorCode.simpleChat.audioTooLarge,
        'Voice recording is too large',
      );
    }
    const mimeType = input.mimeType?.split(';', 1)[0] || 'audio/webm';
    if (
      !/^(audio\/(webm|mp4|mpeg|mp3|wav|ogg|m4a|x-m4a)|video\/(webm|mp4))$/i.test(
        mimeType,
      )
    ) {
      throw BusinessException.badRequest(
        ErrorCode.simpleChat.audioInvalid,
        'Unsupported audio format',
      );
    }
    const form = new FormData();
    if (this.getAudioBackend() === 'codex') {
      if (!this.audio)
        throw BusinessException.badRequest(
          ErrorCode.simpleChat.upstreamFailed,
          'Experimental CLI dictation is unavailable; no API fallback.',
        );
      return this.audio.transcribe(input.bytes);
    }
    form.append('model', TRANSCRIPTION_MODEL);
    form.append('language', 'fr');
    form.append(
      'file',
      new Blob([new Uint8Array(input.bytes)], { type: mimeType }),
      input.filename || 'dictation.webm',
    );
    const response = await this.openAiRequest('/v1/audio/transcriptions', {
      method: 'POST',
      body: form,
    });
    const payload = (await response.json().catch(() => ({}))) as {
      text?: string;
      error?: { message?: string };
    };
    if (!response.ok) {
      throw BusinessException.internal(
        ErrorCode.simpleChat.upstreamFailed,
        payload.error?.message || `OpenAI API returned HTTP ${response.status}`,
      );
    }
    const text = payload.text?.trim();
    if (!text) {
      throw BusinessException.internal(
        ErrorCode.simpleChat.invalidResponse,
        'OpenAI returned an empty transcription',
      );
    }
    return { text };
  }

  async listModels(): Promise<{ models: string[]; defaultModel: string }> {
    if (this.getBackend() === 'codex')
      return { models: [], defaultModel: 'project' };
    if (this.modelCache && this.modelCache.expiresAt > Date.now()) {
      return {
        models: this.modelCache.models,
        defaultModel: this.defaultModel,
      };
    }
    const response = await this.openAiRequest('/v1/models', { method: 'GET' });
    const payload = (await response
      .json()
      .catch(() => ({}))) as OpenAiModelList;
    if (!response.ok) {
      throw BusinessException.internal(
        ErrorCode.simpleChat.upstreamFailed,
        `Unable to list OpenAI models (HTTP ${response.status})`,
      );
    }
    const models = [
      ...new Set(
        (payload.data ?? [])
          .map((item) => item.id)
          .filter((id): id is string => Boolean(id) && this.isChatModel(id!)),
      ),
    ].sort(
      (a, b) => this.modelRank(a) - this.modelRank(b) || a.localeCompare(b),
    );
    if (!models.includes(this.defaultModel)) models.unshift(this.defaultModel);
    this.modelCache = { expiresAt: Date.now() + MODEL_CACHE_MS, models };
    return { models, defaultModel: this.defaultModel };
  }

  listThreads() {
    return {
      threads: this.db
        .select()
        .from(simpleChatThreads)
        .orderBy(desc(simpleChatThreads.updatedAt))
        .all()
        .filter((t) => canReadThread(t.id, 'simple')),
    };
  }

  createThread(input: { model?: unknown; projectId?: unknown }) {
    const project = this.resolveProject(input.projectId);
    const now = Date.now();
    const thread = {
      id: randomUUID(),
      title: 'Nouvelle conversation',
      model: this.parseModel(input.model) || this.defaultModel,
      projectId: project.id,
      // Kept as an internal compatibility value for the existing schema.
      // Simple conversations are project-scoped and never grouped by cwd.
      cwd: project.workspacePath,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(simpleChatThreads).values(thread).run();
    const primary = this.db
      .select()
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.projectId, project.id),
          eq(projectWorkspaces.primary, true),
        ),
      )
      .get();
    if (!primary)
      throw BusinessException.conflict(
        ErrorCode.simpleChat.projectInvalid,
        'Primary project resource is missing',
      );
    this.activeFolders.set(project.id, 'simple_chat', thread.id, {
      resourceId: primary.id,
      relativePath: '',
    });
    const access = currentAccess();
    if (access)
      access.identities.recordConversationOwner(
        access.identity,
        thread.id,
        'simple',
      );
    return { thread, messages: [] };
  }

  readThread(threadId: string) {
    const thread = this.requireThread(threadId);
    const messages = this.db
      .select()
      .from(simpleChatMessages)
      .where(eq(simpleChatMessages.threadId, threadId))
      .orderBy(asc(simpleChatMessages.createdAt))
      .all();
    return {
      thread,
      messages,
      activeFolder: thread.projectId
        ? this.activeFolders.get('simple_chat', thread.id)
        : null,
    };
  }

  updateThread(
    threadId: string,
    input: {
      title?: unknown;
      model?: unknown;
      projectId?: unknown;
    },
  ) {
    const current = this.requireThread(threadId);
    const updates: {
      title?: string;
      model?: string;
      cwd?: string;
      projectId?: string | null;
      updatedAt: number;
    } = {
      updatedAt: Date.now(),
    };
    if (typeof input.title === 'string') {
      const title = input.title.trim();
      if (!title || title.length > 120) {
        throw BusinessException.badRequest(
          ErrorCode.simpleChat.titleInvalid,
          'The title must contain between 1 and 120 characters',
        );
      }
      updates.title = title;
    }
    if (input.model !== undefined) {
      const model = this.parseModel(input.model);
      if (!model) {
        throw BusinessException.badRequest(
          ErrorCode.simpleChat.modelInvalid,
          'The model is invalid',
        );
      }
      updates.model = model;
    }
    if (input.projectId !== undefined) {
      const project = this.resolveProject(input.projectId);
      if (current.projectId && current.projectId !== project.id)
        throw BusinessException.conflict(
          ErrorCode.simpleChat.projectInvalid,
          'Conversations cannot be moved between projects',
        );
      updates.projectId = project.id;
      updates.cwd = project.workspacePath;
    }
    this.db
      .update(simpleChatThreads)
      .set(updates)
      .where(eq(simpleChatThreads.id, threadId))
      .run();
    return this.readThread(threadId);
  }

  private resolveProject(value: unknown) {
    if (typeof value !== 'string' || !value.trim()) {
      throw BusinessException.badRequest(
        ErrorCode.files.pathRequired,
        'A project is required',
      );
    }
    requireProjectAccess(value.trim());
    const project = this.db
      .select()
      .from(projects)
      .where(eq(projects.id, value.trim()))
      .get();
    if (!project) {
      throw BusinessException.badRequest(
        ErrorCode.files.pathRequired,
        'Project not found',
      );
    }
    return project;
  }

  deleteThread(threadId: string) {
    this.requireThread(threadId);
    this.db
      .delete(simpleChatThreads)
      .where(eq(simpleChatThreads.id, threadId))
      .run();
    this.activeFolders.removeContext('simple_chat', threadId);
    return { deleted: true };
  }

  async respond(threadId: string, input: { message?: unknown }) {
    const message =
      typeof input?.message === 'string' ? input.message.trim() : '';
    if (!message) {
      throw BusinessException.badRequest(
        ErrorCode.simpleChat.messageRequired,
        'message is required',
      );
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw BusinessException.badRequest(
        ErrorCode.simpleChat.messageTooLong,
        `message must be at most ${MAX_MESSAGE_LENGTH} characters`,
      );
    }

    const thread = this.requireThread(threadId);
    const previousMessages = this.db
      .select({
        role: simpleChatMessages.role,
        content: simpleChatMessages.content,
      })
      .from(simpleChatMessages)
      .where(eq(simpleChatMessages.threadId, threadId))
      .orderBy(desc(simpleChatMessages.createdAt))
      .limit(MAX_CONTEXT_MESSAGES)
      .all()
      .reverse();
    const backend = this.getBackend();
    const sharedKnowledge =
      backend === 'openai' && thread.projectId
        ? await this.knowledge?.contextForProject(thread.projectId)
        : null;
    const deliverableContext =
      backend === 'openai'
        ? this.deliverables?.contextForConversation(thread.id, 'simple')
        : null;
    const response =
      backend === 'openai'
        ? await this.createResponse(thread.model, [
            ...(sharedKnowledge || deliverableContext
              ? [
                  {
                    role: 'user',
                    content: [sharedKnowledge, deliverableContext]
                      .filter(Boolean)
                      .join('\n\n'),
                  },
                ]
              : []),
            ...previousMessages,
            { role: 'user', content: message },
          ])
        : null;
    const text = response
      ? this.extractText(response)
      : await this.respondWithCodex(thread, previousMessages, message);
    if (!text) {
      const detail = response?.incomplete_details?.reason
        ? `OpenAI stopped before producing text (${response.incomplete_details.reason})`
        : 'OpenAI returned an empty response';
      throw BusinessException.internal(
        ErrorCode.simpleChat.invalidResponse,
        detail,
      );
    }

    const now = Date.now();
    const sources = response ? this.extractSources(response) : [];
    const userMessage = {
      id: randomUUID(),
      threadId,
      role: 'user',
      content: message,
      model: null,
      sources: [] as SimpleChatSource[],
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      createdAt: now,
    };
    const assistantMessage = {
      id: randomUUID(),
      threadId,
      role: 'assistant',
      content: text,
      model:
        response?.model ||
        (backend === 'codex'
          ? this.resolveProject(thread.projectId).agentModel || 'codex'
          : thread.model),
      sources,
      inputTokens: response?.usage?.input_tokens ?? 0,
      outputTokens: response?.usage?.output_tokens ?? 0,
      totalTokens: response?.usage?.total_tokens ?? 0,
      createdAt: now + 1,
    };
    const isFirstMessage = previousMessages.length === 0;
    this.db.transaction((tx) => {
      tx.insert(simpleChatMessages)
        .values([userMessage, assistantMessage])
        .run();
      tx.update(simpleChatThreads)
        .set({
          title: isFirstMessage ? this.makeTitle(message) : thread.title,
          updatedAt: now,
        })
        .where(eq(simpleChatThreads.id, threadId))
        .run();
    });
    if (thread.projectId && this.proposals) {
      try {
        this.proposals.capture(
          thread.projectId,
          { sourceType: 'simple', threadId, sourceId: assistantMessage.id },
          text,
        );
      } catch {
        /* A proposal must not prevent delivery of the successful response. */
      }
    }
    return { message: assistantMessage, thread: this.requireThread(threadId) };
  }

  private async respondWithCodex(
    thread: typeof simpleChatThreads.$inferSelect,
    previousMessages: Array<{ role: string; content: string }>,
    message: string,
  ): Promise<string> {
    requireExecutionAccess();
    const project = this.resolveProject(thread.projectId);
    const transcript = [...previousMessages, { role: 'user', content: message }]
      .map(
        (item) =>
          `${item.role === 'assistant' ? 'Assistant' : 'Utilisateur'} : ${item.content}`,
      )
      .join('\n\n')
      .slice(-30_000);
    return this.threads.runProjectStructuredPrompt({
      cwd: thread.projectId
        ? this.activeFolders.resolve('simple_chat', thread.id)
        : thread.cwd || project.workspacePath,
      prompt: [
        this.deliverables?.contextForConversation(thread.id, 'simple'),
        transcript,
      ]
        .filter(Boolean)
        .join('\n\n'),
      instructions:
        "Tu es un assistant généraliste concis et utile. Réponds dans la langue de l'utilisateur. Utilise la recherche Web pour les informations actuelles ou sensibles au temps et cite tes sources avec des liens. Cette conversation est simple : ne modifie aucun fichier et n'exécute aucune commande.",
    });
  }

  private async createResponse(
    model: string,
    messages: Array<{ role: string; content: string }>,
  ): Promise<OpenAiResponse> {
    const response = await this.openAiRequest('/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model,
        input: messages.map((item) => ({
          role: item.role,
          content: item.content,
        })),
        instructions:
          'You are a concise, helpful general-purpose assistant. Answer in the language used by the user. Use web search for current or time-sensitive information and cite sources. Do not claim access to files, terminals, Home Assistant, SSH, or external tools other than web search.',
        tools: [{ type: 'web_search', search_context_size: 'low' }],
        tool_choice: 'auto',
        include: ['web_search_call.action.sources'],
        ...(/^(gpt-[56]|o[1-9](?:-|$))/.test(model)
          ? { reasoning: { effort: 'low' } }
          : {}),
        store: false,
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as OpenAiResponse;
    if (!response.ok) {
      throw BusinessException.internal(
        ErrorCode.simpleChat.upstreamFailed,
        payload.error?.message || `OpenAI API returned HTTP ${response.status}`,
      );
    }
    return payload;
  }

  private async openAiRequest(
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(`https://api.openai.com${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.readApiKey()}`,
          ...(init.body && !(init.body instanceof FormData)
            ? { 'Content-Type': 'application/json' }
            : {}),
          ...init.headers,
        },
        signal: controller.signal,
      });
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'AbortError'
          ? 'OpenAI API request timed out'
          : 'Unable to contact the OpenAI API';
      throw BusinessException.internal(
        ErrorCode.simpleChat.upstreamFailed,
        message,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private requireThread(threadId: string) {
    requireThreadAccess(threadId, 'simple');
    const thread = this.db
      .select()
      .from(simpleChatThreads)
      .where(eq(simpleChatThreads.id, threadId))
      .get();
    if (!thread) {
      throw BusinessException.notFound(
        ErrorCode.simpleChat.threadNotFound,
        'Simple Chat conversation not found',
      );
    }
    return thread;
  }

  private readApiKey(): string {
    const key =
      this.readKeyFile(this.managedKeyFile) ||
      (this.externalKeyFile
        ? this.readKeyFile(this.externalKeyFile)
        : undefined);
    if (!key) {
      throw BusinessException.internal(
        ErrorCode.simpleChat.notConfigured,
        'Simple Chat API key is unavailable',
      );
    }
    return key;
  }

  private hasApiKey(): boolean {
    return Boolean(
      this.readKeyFile(this.managedKeyFile) ||
      (this.externalKeyFile
        ? this.readKeyFile(this.externalKeyFile)
        : undefined),
    );
  }

  private readKeyFile(path: string): string | undefined {
    try {
      return readFileSync(path, 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private extractText(payload: OpenAiResponse): string {
    return (payload.output ?? [])
      .flatMap((item) => item.content ?? [])
      .filter(
        (part) => part.type === 'output_text' && typeof part.text === 'string',
      )
      .map((part) => part.text!.trim())
      .filter(Boolean)
      .join('\n\n');
  }

  private extractSources(payload: OpenAiResponse): SimpleChatSource[] {
    const seen = new Set<string>();
    const sources: SimpleChatSource[] = [];
    for (const annotation of (payload.output ?? [])
      .flatMap((item) => item.content ?? [])
      .flatMap((part) => part.annotations ?? [])) {
      const url = annotation.url || annotation.url_citation?.url;
      const title = annotation.title || annotation.url_citation?.title || url;
      if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      sources.push({ title: title || url, url });
    }
    for (const source of (payload.output ?? []).flatMap(
      (item) => item.action?.sources ?? [],
    )) {
      const url = source.url;
      if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      sources.push({ title: source.title || url, url });
    }
    return sources;
  }

  private parseModel(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const model = value.trim();
    return /^[a-zA-Z0-9._:-]{2,100}$/.test(model) ? model : undefined;
  }

  private isChatModel(id: string): boolean {
    return (
      /^(gpt-|o[1-9](?:-|$))/.test(id) &&
      !/^gpt-3\.5/i.test(id) &&
      !/(audio|realtime|transcribe|tts|image|search|codex|instruct|embedding|moderation)/i.test(
        id,
      )
    );
  }

  private modelRank(id: string): number {
    const preferred = [
      this.defaultModel,
      'gpt-5-mini',
      'gpt-5-nano',
      'gpt-4.1-mini',
      'gpt-4.1',
    ];
    const index = preferred.indexOf(id);
    return index === -1 ? 100 : index;
  }

  private makeTitle(message: string): string {
    const oneLine = message.replace(/\s+/g, ' ').trim();
    return oneLine.length <= 60 ? oneLine : `${oneLine.slice(0, 57)}…`;
  }
}
