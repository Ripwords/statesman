import type { ProjectRole } from '~~/shared/schemas/project-role'

/**
 * Whether changing a member from `current` to `next` leaves the project with no
 * owner. The server allows it (an admin can always recover the project); the
 * dashboard asks first, because a sole owner demoting themselves is one click
 * on a select.
 */
export function leavesNoOwner(
  current: ProjectRole,
  next: ProjectRole,
  ownerCount: number
): boolean {
  return current === 'owner' && next !== 'owner' && ownerCount === 1
}
