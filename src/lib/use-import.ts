import { useCallback, useState } from "react";
import {
  ImportError,
  planImport,
  readImportFile,
  type ImportOutcome,
  type ImportPlan,
} from "./import";
import { useStore } from "./store";

/*
 * The restore gesture, as a state machine two surfaces share.
 *
 * They look nothing alike — a strip inside the account menu, and a card on the
 * first-run screen — but they ask the same three questions in the same order:
 * which file, is this really the one, and what happened. Writing that twice is
 * how the two would end up disagreeing about whether a file with no projects in
 * it counts as an error, which is the sort of difference nobody notices until a
 * user hits the wrong one.
 *
 * The step in the middle is the reason this is a machine rather than a click
 * handler. A restore is the only gesture in the app pointed at a file the user
 * may not have opened in months, and picking the wrong export is the mistake
 * worth catching — so reading a file and applying it are deliberately separate,
 * with what it holds shown in between.
 */

export type ImportPhase =
  | { state: "idle" }
  | { state: "reading" }
  /** Read and validated. Nothing has been written; this is the confirm step. */
  | { state: "ready"; plan: ImportPlan }
  | { state: "running"; plan: ImportPlan }
  | { state: "done"; plan: ImportPlan; outcome: ImportOutcome }
  | { state: "error"; message: string };

export interface Import {
  phase: ImportPhase;
  /** Hand it whatever the file input produced. */
  choose: (file: File | null | undefined) => void;
  /**
   * Apply the file that was read. No-op unless the phase is `ready`.
   *
   * Resolves with the outcome, or null if it did not apply, because one caller
   * has something to do afterwards and cannot read it off the phase: on the
   * first-run screen a successful restore completes onboarding, which unmounts
   * the component in the same tick — before any effect watching the phase runs.
   */
  confirm: () => Promise<ImportOutcome | null>;
  /** Back to idle, for a menu that is about to close or reopen. */
  reset: () => void;
}

export function useImport(): Import {
  const importWorkspace = useStore((s) => s.importWorkspace);
  const [phase, setPhase] = useState<ImportPhase>({ state: "idle" });

  const choose = useCallback((file: File | null | undefined) => {
    if (!file) return;
    setPhase({ state: "reading" });

    void (async () => {
      try {
        const doc = await readImportFile(file);
        /*
         * Read here rather than subscribed to at the top: the project list is
         * only wanted to count how many of the file's projects are already
         * present, and subscribing would re-render this panel on every keystroke
         * of a streaming turn to compute a number nothing is looking at.
         */
        const plan = planImport(doc, { projects: useStore.getState().projects });

        setPhase(
          plan.empty
            ? {
                state: "error",
                message:
                  "This export holds no projects, so there is nothing in it to restore.",
              }
            : { state: "ready", plan },
        );
      } catch (error) {
        setPhase({ state: "error", message: reason(error) });
      }
    })();
  }, []);

  const confirm = useCallback(async () => {
    if (phase.state !== "ready") return null;
    const { plan } = phase;
    setPhase({ state: "running", plan });

    try {
      const outcome = await importWorkspace(plan.doc);
      setPhase({ state: "done", plan, outcome });
      return outcome;
    } catch (error) {
      setPhase({ state: "error", message: reason(error) });
      return null;
    }
  }, [phase, importWorkspace]);

  const reset = useCallback(() => setPhase({ state: "idle" }), []);

  return { phase, choose, confirm, reset };
}

/**
 * A failure in the user's terms.
 *
 * `ImportError` is already written for them — it names the file's problem and
 * what to do about it. Anything else came from the database or the filesystem
 * and needs the context an unlabelled `disk I/O error` does not carry.
 */
function reason(error: unknown): string {
  if (error instanceof ImportError) return error.message;
  const detail = error instanceof Error ? error.message : String(error);
  return `The file was read, but restoring it failed — ${detail}`;
}
