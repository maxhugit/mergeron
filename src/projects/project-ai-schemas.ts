/** Strict structured-output schemas used by project task-manager Codex turns. */
export const PROJECT_TASKS_SCHEMA = {
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
          dependsOnTitles: { type: 'array', items: { type: 'string' } },
          executionMode: { type: 'string', enum: ['manual', 'agent'] },
          assignmentReason: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } },
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
} as const;

/** Project planning creates only top-level tasks; decomposition is a separate action. */
export const PROJECT_PLAN_SCHEMA = {
  ...PROJECT_TASKS_SCHEMA,
  properties: {
    tasks: {
      ...PROJECT_TASKS_SCHEMA.properties.tasks,
      items: {
        ...PROJECT_TASKS_SCHEMA.properties.tasks.items,
        properties: {
          ...PROJECT_TASKS_SCHEMA.properties.tasks.items.properties,
          parentTitle: { type: 'string', enum: [''] },
          executionMode: { type: 'string', enum: ['manual'] },
        },
      },
    },
  },
} as const;

export const PROJECT_REPLAN_SCHEMA = {
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
          dependencyIds: { type: 'array', items: { type: 'string' } },
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
} as const;

export const TASK_ADVICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    health: { type: 'string', enum: ['good', 'watch', 'at_risk'] },
    advice: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: {
            type: 'string',
            enum: ['alert', 'recommendation', 'opportunity', 'info'],
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
} as const;
