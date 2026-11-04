import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import {
  projectWorkspaces,
  projectWorkspaceCopies,
  projectDeliverableDocuments,
  projectDeliverables,
  projectResources,
  projects,
  projectManagerAssignments,
  projectPersonGroupMembers,
} from '../database/schema';
import type { AppDatabase } from '../database/database.constants';
import {
  projectDeliverablesPath,
  projectSourcesPath,
} from './workspace-structure';

/** Resolve only DB-owned public projections, never arbitrary children of a system root. */
export function managedContentAccess(
  db: AppDatabase | undefined,
  input: string,
) {
  if (!db) return null;
  const canonical = (value: string) => {
    try {
      return realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  const target = canonical(input);
  const workspaces = db.select().from(projectWorkspaces).all();
  for (const copy of db.select().from(projectWorkspaceCopies).all()) {
    const primary = workspaces.find(
      (w) => w.projectId === copy.projectId && w.primary,
    );
    const workspace = workspaces.find(
      (w) => w.id === copy.localWorkspaceId && w.projectId === copy.projectId,
    );
    if (
      !primary ||
      !workspace ||
      workspace.path !==
        path.join(
          projectSourcesPath(primary.path),
          copy.sourceResourceId,
          'copies',
          copy.id,
        )
    )
      continue;
    const physical = canonical(workspace.path);
    const expected = path.join(
      projectSourcesPath(canonical(primary.path)),
      copy.sourceResourceId,
      'copies',
      copy.id,
    );
    if (physical !== expected) continue;
    if (target === physical || target.startsWith(physical + path.sep))
      return {
        kind: 'source' as const,
        root: physical,
        projectId: copy.projectId,
        copyId: copy.id,
      };
  }
  const allProjects = db.select().from(projects).all();
  const resources = db.select().from(projectResources).all();
  const deliverables = db.select().from(projectDeliverables).all();
  for (const item of deliverables) {
    const projectId = resources.find(
      (r) => r.id === item.resourceId,
    )?.projectId;
    const project = allProjects.find(
      (p) => p.id === projectId && p.workspaceLayoutVersion >= 4,
    );
    if (!project) continue;
    const root = path.join(
      projectDeliverablesPath(canonical(project.workspacePath)),
      item.id,
    );
    if (target === root)
      return {
        kind: 'deliverable' as const,
        root,
        projectId: project.id,
        deliverableId: item.id,
      };
  }
  for (const doc of db.select().from(projectDeliverableDocuments).all()) {
    if (doc.deletedAt !== null || canonical(doc.sourcePath) !== target)
      continue;
    const item = deliverables.find((d) => d.id === doc.deliverableId);
    const projectId = resources.find(
      (r) => r.id === item?.resourceId,
    )?.projectId;
    const project = allProjects.find(
      (p) => p.id === projectId && p.workspaceLayoutVersion >= 4,
    );
    if (
      project &&
      target.startsWith(
        projectDeliverablesPath(canonical(project.workspacePath)) + path.sep,
      )
    )
      return {
        kind: 'document' as const,
        root: path.dirname(target),
        projectId: project.id,
        documentId: doc.id,
      };
  }
  return null;
}

/** Same group/manager rule as the business inventory, also applied to direct file reads. */
export function managedDeliverableReadable(
  db: AppDatabase,
  scope: NonNullable<ReturnType<typeof managedContentAccess>>,
  identity: { role: string | null; personId: string | null },
) {
  if (scope.kind === 'source' || identity.role === 'administrator') return true;
  const document =
    scope.kind === 'document'
      ? db
          .select()
          .from(projectDeliverableDocuments)
          .all()
          .find((d) => d.id === scope.documentId)
      : null;
  const id =
    scope.kind === 'deliverable'
      ? scope.deliverableId
      : document?.deliverableId;
  const item = db
    .select()
    .from(projectDeliverables)
    .all()
    .find((d) => d.id === id);
  if (!item) return false;
  if (item.confidentiality !== 'restricted') return true;
  if (!identity.personId) return false;
  if (
    db
      .select()
      .from(projectManagerAssignments)
      .all()
      .some(
        (m) =>
          m.projectId === scope.projectId && m.personId === identity.personId,
      )
  )
    return true;
  return db
    .select()
    .from(projectPersonGroupMembers)
    .all()
    .some(
      (m) =>
        m.personId === identity.personId &&
        item.authorizedGroupIds.includes(m.groupId),
    );
}
