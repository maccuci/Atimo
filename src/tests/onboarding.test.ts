import { beforeEach, describe, expect, test } from "bun:test";
import { initializeWorkspace } from "../lib/sync";
import { store } from "../lib/persistence";
import { EMPTY_PATCH } from "../lib/persistence";
import { useStore } from "../lib/store";
import { MESSAGES, PROJECTS } from "../lib/mock-data";

/*
 * First run.
 *
 * The interesting property is not which fixtures land — it is that *something*
 * lands. Both stores treat `seed` as the marker that a workspace exists, and
 * refuse to apply a patch to one that has never been written; an install that
 * got past setup without seeding would therefore look completely normal and
 * persist nothing at all, and would only be discovered on the next launch, by
 * the tester, as their afternoon's work missing.
 *
 * So the cases below check the choice *and* the write-through that has to work
 * afterwards.
 */

/** `bun test` has no DOM. The browser store only touches this at call time. */
class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

beforeEach(() => {
  globalThis.localStorage = new MemoryStorage() as unknown as Storage;
  useStore.setState({
    workspaces: [],
    projects: [],
    chats: [],
    messages: [],
    memory: [],
    decisions: [],
    timeline: [],
    hydrated: false,
    onboarding: true,
  });
});

describe("initializeWorkspace", () => {
  test("a clean start is one project, named by the user", async () => {
    await initializeWorkspace("clean", "Acme rewrite");

    const state = useStore.getState();
    expect(state.workspaces).toHaveLength(1);
    expect(state.projects[0]!.workspaceId).toBe(state.workspaces[0]!.id);
    expect(state.projects).toHaveLength(1);
    expect(state.projects[0]!.name).toBe("Acme rewrite");
    // Nothing else: the point of this path is that nothing in the app is
    // someone else's content.
    expect(state.chats).toEqual([]);
    expect(state.messages).toEqual([]);
    expect(state.memory).toEqual([]);
    expect(state.decisions).toEqual([]);
  });

  test("the project is selected, so the first send has somewhere to go", async () => {
    await initializeWorkspace("clean", "Acme");

    const state = useStore.getState();
    expect(state.projectId).toBe(state.projects[0]!.id);
    expect(state.workspaceId).toBe(state.projects[0]!.workspaceId);
  });

  test("a blank name falls back rather than creating an unnamed project", async () => {
    await initializeWorkspace("clean", "   ");
    expect(useStore.getState().projects[0]!.name).toBe("Meu projeto");
  });

  test("no name at all falls back too", async () => {
    await initializeWorkspace("clean");
    expect(useStore.getState().projects[0]!.name).toBe("Meu projeto");
  });

  test("the demo start is the fixtures, in full", async () => {
    await initializeWorkspace("demo");

    const state = useStore.getState();
    expect(state.projects.map((p) => p.id)).toEqual(PROJECTS.map((p) => p.id));
    expect(state.messages).toHaveLength(MESSAGES.length);
  });

  test("either way, setup leaves the app hydrated and out of onboarding", async () => {
    await initializeWorkspace("clean", "Acme");
    expect(useStore.getState().hydrated).toBe(true);
    expect(useStore.getState().onboarding).toBe(false);
  });

  test("what setup wrote is what a later launch reads back", async () => {
    await initializeWorkspace("clean", "Acme");

    const restored = await store.load();
    expect(restored).not.toBeNull();
    expect(restored!.projects).toHaveLength(1);
    expect(restored!.projects[0]!.name).toBe("Acme");
  });

  /*
   * The regression this file exists for. Before setup runs, `apply` is a no-op
   * on both stores — there is nothing to apply a diff to. If a path ever gets
   * the user past onboarding without seeding, every patch after it is silently
   * dropped and the app looks fine until it is restarted.
   */
  test("patches land once setup has run", async () => {
    const before = await store.load();
    expect(before).toBeNull();

    // A patch written to a workspace that was never seeded goes nowhere.
    await store.apply({ ...EMPTY_PATCH, projects: [PROJECTS[0]!] });
    expect(await store.load()).toBeNull();

    await initializeWorkspace("clean", "Acme");
    await store.apply({ ...EMPTY_PATCH, projects: [PROJECTS[0]!] });

    const restored = await store.load();
    expect(restored!.projects.map((p) => p.id)).toContain(PROJECTS[0]!.id);
  });
});
