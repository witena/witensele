/**
 * The two arithmetic questions a committee-aware chat asks, as pure functions.
 *
 * Both are small enough to inline and both are wrong in a way nobody notices,
 * which is exactly why they are here with a test beside them rather than in a
 * component.
 *
 * `mergeMembers` is the renderer's copy of a rule the **backend** owns
 * (`initialMembers` in `src/main/handlers/chats.ts`): committee members in their
 * own order, then the extras, de-duplicated keeping the first occurrence. The
 * copy exists so the New chat dialog can say "4 members will join" *before* the
 * call, and so the agent list can tick the right rows. It is deliberately not
 * the authority — if the two ever disagreed the backend would win and the count
 * would have been a lie, which is why the rule is stated in one sentence in both
 * files and tested against the same examples.
 *
 * `missingCommitteeMembers` is the other half of the snapshot trade-off. A chat
 * keeps the members it was convened with, so a committee that has gained someone
 * since leaves a gap; this is what the member panel's "Sync committee members"
 * button offers to close. It only ever reports **additions**: a member the user
 * removed from the chat is a decision about that chat, and a sync that put them
 * back would be the automatic reconciliation `docs/features/committees` says
 * there will not be.
 */
import type { Committee } from '@shared/types'

/**
 * The member list a chat convened from `committeeIds` plus `extraIds` is born
 * with.
 *
 * Order matters twice over: the array index becomes `position`, which is the
 * speaking order. An agent named in both lists keeps its **committee** place
 * rather than being pushed to the end — the committee is what decided the order,
 * and ticking someone who is already in it must not silently move them.
 */
export function mergeMembers(
  committeeIds: readonly string[],
  extraIds: readonly string[]
): string[] {
  const merged: string[] = []
  for (const agentId of [...committeeIds, ...extraIds]) {
    if (!merged.includes(agentId)) merged.push(agentId)
  }
  return merged
}

/**
 * The committee's members this chat does not have, in committee order.
 *
 * `null` for the committee — a chat with no provenance, or one whose committee
 * has since been deleted — is not an error: it is the ordinary case, and the
 * answer is an empty list, which is what makes the Sync button disappear rather
 * than appear disabled.
 */
export function missingCommitteeMembers(
  committee: Committee | null | undefined,
  chatMemberIds: readonly string[]
): string[] {
  if (!committee) return []
  return committee.memberAgentIds.filter((agentId) => !chatMemberIds.includes(agentId))
}
