import { beforeEach, describe, expect, test } from "bun:test";
import { useStore } from "../lib/store";
import { diff } from "../lib/sync";
import type { Snapshot } from "../lib/persistence";
import type { Message } from "../lib/types";

/*
 * Re-running the last answer.
 *
 * Two properties carry the feature, and both fail quietly rather than loudly if
 * they break.
 *
 * The answer streams back into the *same message row*. The persistence diff has
 * no concept of a deleted message — one only leaves when its chat does — so a
 * retry that dropped the old row and appended a new one would look perfect on
 * screen and leave the failed turn in SQLite, to reappear on the next launch.
 *
 * And only the last turn can be re-run. Re-running an earlier one would have to
 * discard everything that replied to it, which is not what anyone clicking
 * "Regenerate" is asking for.
 *
 * Nothing here connects a provider, so every case stops at the guard — which is
 * exactly the reducer half these tests are about.
 */

const ASSISTANT: Message = {
  id: "m-answer",
  chatId: "c-1",
  role: "assistant",
  modelId: "claude-opus-5",
  content: "the first answer",
  createdAt: "2026-07-01T00:00:02.000Z",
  usage: { in: 100, out: 40, latencyMs: 900 },
  costUsd: 0.002,
  stopped: true,
  candidates: [
    {
      id: "k-1",
      projectId: "p-1",
      chatId: "c-1",
      modelId: "claude-opus-5",
      type: "memory",
      kind: "architecture",
      source: "response",
      confidence: 0.8,
      title: "distilled from the old answer",
      body: "…",
      alternatives: [],
    },
  ],
};

const SNAPSHOT: Snapshot = {
  workspaces: [{ id: "ws-inserium", name: "Inserium" }],
  projects: [
    {
      id: "p-1",
      workspaceId: "ws-inserium",
      name: "Test",
      description: "",
      instructions: "",
      memoryTokens: 0,
    },
  ],
  chats: [
    {
      id: "c-1",
      projectId: "p-1",
      title: "Chat",
      modelId: "claude-opus-5",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    },
  ],
  messages: [
    {
      id: "m-ask",
      chatId: "c-1",
      role: "user",
      content: "the original prompt",
      createdAt: "2026-07-01T00:00:01.000Z",
    },
    ASSISTANT,
  ],
  memory: [],
  decisions: [],
  timeline: [],
  documents: [],
};

const watched = (): Snapshot => {
  const s = useStore.getState();
  return {
    workspaces: s.workspaces,
    projects: s.projects,
    chats: s.chats,
    messages: s.messages,
    memory: s.memory,
    decisions: s.decisions,
    timeline: s.timeline,
    documents: s.documents,
  };
};

const find = (id: string) =>
  useStore.getState().messages.find((m) => m.id === id);

beforeEach(() => {
  useStore.getState().hydrate(SNAPSHOT);
  useStore.setState({ sending: false });
});

describe("retry", () => {
  test("re-runs into the same row rather than appending a new one", async () => {
    const before = watched();
    await useStore.getState().retry("m-answer");

    const messages = useStore.getState().messages;
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id)).toEqual(["m-ask", "m-answer"]);

    // The diff must see one changed row and nothing removed — a message the
    // store dropped would stay in the database forever.
    const patch = diff(before, watched())!;
    expect(patch.messages.map((m) => m.id)).toEqual(["m-answer"]);
    expect(patch.deletedChats).toEqual([]);
  });

  test("clears everything the previous attempt produced", async () => {
    await useStore.getState().retry("m-answer");

    const answer = find("m-answer")!;
    expect(answer.content).toBe("");
    expect(answer.stopped).toBeUndefined();
    // Kept, these would price the new answer at the old one's token count and
    // offer project knowledge distilled from text no longer on screen.
    expect(answer.usage).toBeUndefined();
    expect(answer.costUsd).toBeUndefined();
    expect(answer.candidates).toBeUndefined();
  });

  test("leaves the prompt it is answering untouched", async () => {
    const before = find("m-ask");
    await useStore.getState().retry("m-answer");

    // Reference identity, not equality: a copied-but-equal row would still be
    // written back on every retry.
    expect(find("m-ask")).toBe(before);
  });

  test("an earlier answer is not re-runnable", async () => {
    useStore.setState({
      messages: [
        ...SNAPSHOT.messages,
        {
          id: "m-ask-2",
          chatId: "c-1",
          role: "user",
          content: "and then?",
          createdAt: "2026-07-01T00:00:03.000Z",
        },
      ],
    });

    const before = watched();
    await useStore.getState().retry("m-answer");

    // Untouched: discarding the turn that followed is not what "Regenerate"
    // asks for, and silently keeping it would answer a stale prompt.
    expect(diff(before, watched())).toBeNull();
  });

  test("a user message is not re-runnable", async () => {
    const before = watched();
    await useStore.getState().retry("m-ask");
    expect(diff(before, watched())).toBeNull();
  });

  test("does nothing while another turn is streaming", async () => {
    useStore.setState({ sending: true });

    const before = watched();
    await useStore.getState().retry("m-answer");
    expect(diff(before, watched())).toBeNull();
  });

  test("an unknown id is a no-op rather than a throw", async () => {
    const before = watched();
    await useStore.getState().retry("m-nope");
    expect(diff(before, watched())).toBeNull();
  });

  test("with no provider connected it fails the turn in place", async () => {
    await useStore.getState().retry("m-answer");

    const answer = find("m-answer")!;
    expect(answer.error).toContain("Nenhum provedor conectado");
    expect(answer.pending).toBe(false);
    // The guard is not a stream, so nothing is left in flight.
    expect(useStore.getState().sending).toBe(false);
  });
});

/*
 * Retrying one member of a panel.
 *
 * A panel exists so that one model failing does not cost the turn. Re-running
 * the whole group to recover a single rate-limited member spends exactly the
 * thing the panel bought: the answers that did arrive are deleted, and paid for
 * again, to repair the one that did not.
 *
 * The two gestures are already distinct in the UI — a failure carries its retry
 * inside its own error box, and "Regenerate" appears only on the answer that is
 * the conversation. This is the store agreeing with that.
 */
describe("retry inside a panel", () => {
  const answer = (over: Partial<Message>): Message => ({
    id: "x",
    chatId: "c-panel",
    role: "assistant",
    turnId: "t-1",
    createdAt: "2026-07-01T00:00:02.000Z",
    content: "",
    ...over,
  });

  const PRIMARY = answer({
    id: "m-primary",
    modelId: "claude-opus-5",
    content: "the primary answer",
    canonical: true,
    usage: { in: 100, out: 40, latencyMs: 900 },
    costUsd: 0.002,
  });

  const FAILED = answer({
    id: "m-failed",
    modelId: "gpt-5.6-sol",
    canonical: false,
    error: "Rate limited. Try again in 30s.",
  });

  const THIRD = answer({
    id: "m-third",
    modelId: "claude-sonnet-5",
    content: "the third answer",
    canonical: false,
    usage: { in: 100, out: 55, latencyMs: 1_400 },
    costUsd: 0.003,
  });

  const PANEL: Snapshot = {
    ...SNAPSHOT,
    chats: [
      {
        id: "c-panel",
        projectId: "p-1",
        title: "Panel",
        modelId: "claude-opus-5",
        panel: ["gpt-5.6-sol", "claude-sonnet-5"],
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ],
    messages: [
      {
        id: "m-ask",
        chatId: "c-panel",
        role: "user",
        content: "the original prompt",
        createdAt: "2026-07-01T00:00:01.000Z",
      },
      PRIMARY,
      FAILED,
      THIRD,
    ],
  };

  beforeEach(() => {
    useStore.getState().hydrate(PANEL);
    useStore.setState({ sending: false });
  });

  test("repairs the failed answer and leaves its siblings alone", async () => {
    const before = watched();
    const primary = find("m-primary");
    const third = find("m-third");

    await useStore.getState().retry("m-failed");

    // Reference identity: the two answers that worked are not rewritten, not
    // re-billed, and not cleared off the screen the user is looking at.
    expect(find("m-primary")).toBe(primary);
    expect(find("m-third")).toBe(third);
    expect(find("m-primary")!.content).toBe("the primary answer");
    expect(find("m-third")!.usage).toEqual({ in: 100, out: 55, latencyMs: 1_400 });

    // And the repaired row is the only thing the database hears about.
    const patch = diff(before, watched())!;
    expect(patch.messages.map((m) => m.id)).toEqual(["m-failed"]);
  });

  test("regenerating the canonical answer still re-runs the whole turn", async () => {
    await useStore.getState().retry("m-primary");

    // Re-rolling one member would leave a comparison between a fresh answer and
    // two older ones, composed against a project that may have learned
    // something in between. That is not a comparison of models.
    for (const id of ["m-primary", "m-failed", "m-third"]) {
      expect(find(id)!.content).toBe("");
      expect(find(id)!.usage).toBeUndefined();
    }
  });

  test("a repair keeps the group's turn membership intact", async () => {
    await useStore.getState().retry("m-failed");

    // `turnId` and `canonical` describe the row's place in the turn, not the
    // attempt it holds. Clearing them mid-repair would dissolve the group into
    // three answers that no longer know they answer one prompt — and a history
    // that carries all three.
    const repaired = find("m-failed")!;
    expect(repaired.turnId).toBe("t-1");
    expect(repaired.canonical).toBe(false);
    expect(find("m-primary")!.canonical).toBe(true);
  });
});
