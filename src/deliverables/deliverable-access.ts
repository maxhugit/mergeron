import { and, eq, inArray } from 'drizzle-orm';
import { currentAccess } from '../auth/access-context';
import type { AppDatabase } from '../database/database.constants';
import {
  projectManagerAssignments,
  projectPersonGroupMembers,
  type projectDeliverables,
} from '../database/schema';
export function canAccessDeliverable(
  db: AppDatabase,
  projectId: string,
  item: Pick<
    typeof projectDeliverables.$inferSelect,
    'confidentiality' | 'authorizedGroupIds'
  >,
) {
  if (item.confidentiality !== 'restricted') return true;
  const access = currentAccess();
  if (!access || access.identity.role === 'administrator') return true;
  const personId = access.identity.personId;
  if (!personId) return false;
  const manager = db
    .select({ personId: projectManagerAssignments.personId })
    .from(projectManagerAssignments)
    .where(eq(projectManagerAssignments.projectId, projectId))
    .get();
  if (manager?.personId === personId) return true;
  if (!item.authorizedGroupIds.length) return false;
  return Boolean(
    db
      .select({ groupId: projectPersonGroupMembers.groupId })
      .from(projectPersonGroupMembers)
      .where(
        and(
          inArray(projectPersonGroupMembers.groupId, item.authorizedGroupIds),
          eq(projectPersonGroupMembers.personId, personId),
        ),
      )
      .get(),
  );
}
