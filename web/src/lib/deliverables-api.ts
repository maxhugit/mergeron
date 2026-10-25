import type {
  ActiveFolderSummary,
  ProjectResourceSummary,
  ProjectActivitySummary,
} from './projects-api';
export interface DeliverableFile {
  name: string;
  sourcePath: string;
  snapshotPath: string;
  size: number;
  sha256: string;
}
export interface DeliverableVersion {
  id: string;
  number: number;
  note: string;
  files: DeliverableFile[];
  status: 'proposed' | 'validated' | 'rejected';
  reviewer: string | null;
  reviewedAt: number | null;
  createdAt: number;
}
export interface DeliverableDocumentVersion {
  id: string;
  documentId: string;
  number: number;
  fileName: string;
  sourcePath: string;
  snapshotPath: string;
  size: number;
  sha256: string;
  authorPersonId: string | null;
  authorName: string;
  comment: string;
  restoredFromVersionId: string | null;
  createdAt: number;
}
export interface DeliverableDocument {
  id: string;
  deliverableId: string;
  name: string;
  format: string;
  sourcePath: string;
  currentVersionNumber: number;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
  versions: DeliverableDocumentVersion[];
}
export interface Deliverable {
  activityEvents?: ProjectActivitySummary[];
  id: string;
  title: string;
  description: string;
  criteria: string;
  confidentiality: 'standard' | 'restricted';
  authorizedGroupIds: string[];
  assigneeId: string | null;
  dueAt: number | null;
  status: 'planned' | 'in_progress' | 'review' | 'validated';
  lifecycleStatus: 'draft' | 'in_constitution' | 'finalized' | 'archived';
  currentSnapshotId: string | null;
  lastApprovedSnapshotId: string | null;
  validationRequired: boolean;
  validationStatus:
    | 'not_required'
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'outdated';
  finalizedAt: number | null;
  finalizedByPersonId: string | null;
  finalizedByName: string | null;
  taskIds: string[];
  primaryTaskId: string | null;
  conversations: Array<{ type: 'agent' | 'simple'; id: string }>;
  version: number;
  validatedVersionId: string | null;
  directory: string;
  activeFolder: ActiveFolderSummary | null;
  createdByName?: string | null;
  updatedByName?: string | null;
  createdAt: number;
  updatedAt: number;
  versions: DeliverableVersion[];
  documents: DeliverableDocument[];
  snapshots: Array<{
    id: string;
    deliverableId: string;
    documents: Array<{
      documentId: string;
      documentVersionId: string;
      versionNumber: number;
      sha256: string;
    }>;
    createdByPersonId: string | null;
    createdByName: string;
    createdAt: number;
  }>;
  lifecycleEvents: Array<{
    id: string;
    deliverableId: string;
    fromStatus: Deliverable['lifecycleStatus'] | null;
    toStatus: Deliverable['lifecycleStatus'];
    snapshotId: string | null;
    actorPersonId: string | null;
    actorName: string;
    createdAt: number;
  }>;
  validations: Array<{
    id: string;
    deliverableId: string;
    snapshotId: string;
    taskId: string | null;
    status: 'pending' | 'approved' | 'rejected' | 'cancelled';
    effectiveStatus:
      | 'pending'
      | 'approved'
      | 'rejected'
      | 'cancelled'
      | 'outdated';
    requestedByPersonId: string | null;
    requestedByName: string;
    requestedAt: number;
    decidedByPersonId: string | null;
    decidedByName: string | null;
    decisionComment: string | null;
    decidedAt: number | null;
  }>;
  validationEvents: Array<{
    id: string;
    deliverableId: string;
    action: 'enabled' | 'disabled' | 'cancelled';
    validationId: string | null;
    reason: string | null;
    actorPersonId: string | null;
    actorName: string;
    createdAt: number;
  }>;
}
export interface DeliverablesBoard {
  resource: ProjectResourceSummary;
  deliverables: Deliverable[];
  assignees: Array<{ id: string; name: string }>;
  taskManagers: Array<{ id: string; name: string }>;
  personGroups: Array<{ id: string; name: string }>;
  tasks: Array<{
    id: string;
    title: string;
    resourceId: string;
    parentTaskId: string | null;
    status: string;
    progress: number;
    dueAt: number | null;
    assigneeId: string | null;
    assigneeName: string | null;
    linkedThreadId?: string | null;
  }>;
  conversations: Array<{ type: 'agent' | 'simple'; id: string; title: string }>;
}
