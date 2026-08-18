import type { Conversation } from "@/hooks/useConversations";
import type { SessionState } from "@/hooks/useSessionState";
import { isConversationUnseen } from "@/hooks/useUnseenConversations";

/** The fields {@link projectMarkerState} reads, so tests can build fixtures
 * without a full {@link Conversation}. */
export type MarkerConversation = Pick<
  Conversation,
  "id" | "status" | "updated_at" | "pending_elicitations_count"
>;

/**
 * Aggregate the sidebar marker for a project from its conversations, using
 * the same precedence a row uses (awaiting > unseen > running). Returned as a
 * {@link SessionState} so a collapsed project header can render the exact
 * same {@link SessionStateBadge} the rows do. ``null`` = no marker.
 */
export function projectMarkerState(conversations: MarkerConversation[]): SessionState | null {
  let awaiting = 0;
  let unseen = false;
  let running = false;
  for (const c of conversations) {
    const pending = c.pending_elicitations_count ?? 0;
    if (pending > 0) {
      awaiting += pending;
    } else if (isConversationUnseen(c.id, c.updated_at, c.status)) {
      unseen = true;
    } else if (c.status === "running") {
      running = true;
    }
  }
  if (awaiting > 0) return { kind: "awaiting", count: awaiting };
  if (unseen) return { kind: "unseen" };
  if (running) return { kind: "running" };
  return null;
}
