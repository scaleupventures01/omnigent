import { beforeEach, describe, expect, it, vi } from "vitest";

// Controllable "unseen" set the mock reads; each case declares which ids count
// as unseen instead of touching localStorage or the tracker's module state.
const unseenIds = new Set<string>();

vi.mock("@/hooks/useUnseenConversations", () => ({
  // Replicates the real status gate (useUnseenConversations.ts): a running or
  // status-less conversation is never unseen, so a mock that ignored status
  // would assert on a state the real code cannot produce.
  isConversationUnseen: (id: string, _updatedAt: number, status: string | undefined) =>
    status === "running" || status === undefined ? false : unseenIds.has(id),
}));

import { isConversationUnseen } from "@/hooks/useUnseenConversations";
import { projectMarkerState, type MarkerConversation } from "@/shell/projectMarkerState";

let nextUpdatedAt = 1000;

function conv({
  id,
  status = "idle",
  unseen = false,
  pending = 0,
}: {
  id: string;
  status?: MarkerConversation["status"];
  unseen?: boolean;
  pending?: number;
}): MarkerConversation {
  if (unseen) unseenIds.add(id);
  return { id, status, updated_at: nextUpdatedAt++, pending_elicitations_count: pending };
}

beforeEach(() => {
  unseenIds.clear();
});

describe("projectMarkerState — collapsed project header precedence", () => {
  it("MOCK CONTROL: a running conversation is never unseen, even if listed unseen", () => {
    const running = conv({ id: "r1", status: "running", unseen: true });
    expect(unseenIds.has("r1")).toBe(true);
    expect(isConversationUnseen(running.id, running.updated_at, "running")).toBe(false);
  });

  it("reports running when one chat is done-unread and another is still running", () => {
    // RED AT COMMIT 1 BY DESIGN: the extracted code still ranks `unseen` above
    // `running` (the bug under test); commit 2 swaps the precedence and turns
    // this case green.
    const state = projectMarkerState([
      conv({ id: "done-unread", unseen: true }),
      conv({ id: "still-running", status: "running" }),
    ]);
    expect(state).toEqual({ kind: "running" });
  });

  it("reports unseen only when nothing in the project is still running", () => {
    const state = projectMarkerState([
      conv({ id: "done-unread", unseen: true }),
      conv({ id: "done-read" }),
    ]);
    expect(state).toEqual({ kind: "unseen" });
  });

  it("an approval prompt outranks both running and unseen", () => {
    const state = projectMarkerState([
      conv({ id: "awaiting", pending: 2 }),
      conv({ id: "still-running", status: "running" }),
      conv({ id: "done-unread", unseen: true }),
    ]);
    expect(state).toEqual({ kind: "awaiting", count: 2 });

    // The count sums across conversations.
    const summed = projectMarkerState([conv({ id: "a1", pending: 1 }), conv({ id: "a2", pending: 2 })]);
    expect(summed).toEqual({ kind: "awaiting", count: 3 });

    // NEGATIVE CONTROL: awaiting must not collapse to the running marker.
    expect(state).not.toEqual({ kind: "running" });
  });

  it("no marker when every chat is idle and read", () => {
    const state = projectMarkerState([conv({ id: "c1" }), conv({ id: "c2" })]);
    expect(state).toBeNull();
  });

  it("NEGATIVE CONTROL: an empty project has no marker", () => {
    expect(projectMarkerState([])).toBeNull();
  });
});
