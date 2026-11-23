import { useEffect, useMemo, useState } from "react";
import { compose } from "./context-composer";
import { contextUsage, type ContextUsage } from "./context-usage";
import { primeQuery, subscribeEmbeddings } from "./embeddings";
import { activeSkills } from "./skills";
import { useStore } from "./store";

/*
 * Live estimate of what the next turn will cost. Debounced with the same
 * cadence as the composer preview so typing stays cheap.
 */

const DEBOUNCE_MS = 180;

export function useContextUsage(): {
  usage: ContextUsage | null;
  /** Provider-reported prompt tokens for the last completed turn, if any. */
  measured: number | null;
} {
  const draft = useStore((s) => s.composerDraft);
  const chatId = useStore((s) => s.chatId);
  const projectId = useStore((s) => s.projectId);
  const chats = useStore((s) => s.chats);
  const projects = useStore((s) => s.projects);
  const messages = useStore((s) => s.messages);
  const skillModes = useStore((s) => s.skills);
  const attachments = useStore((s) => s.composerAttachments);

  const chat = chats.find((c) => c.id === chatId);
  const project = projects.find((p) => p.id === projectId);
  const skills = useMemo(() => activeSkills(skillModes), [skillModes]);

  const history = useMemo(
    () => messages.filter((m) => m.chatId === chatId),
    [messages, chatId],
  );

  const measured = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.chatId === chatId && m.role === "assistant" && m.usage) {
        return m.usage.in;
      }
    }
    return null;
  }, [messages, chatId]);

  const [usage, setUsage] = useState<ContextUsage | null>(null);

  /*
   * Recomputed when a query vector lands, not only when the draft changes.
   *
   * `compose` reads the vector out of a cache to stay synchronous, so the first
   * pass after a keystroke is lexical-only by construction. Without this the
   * estimate would settle on that pass and stay there — the number under the
   * composer would describe a composition the send path is not going to make.
   */
  const [embedded, setEmbedded] = useState(0);
  useEffect(() => subscribeEmbeddings(() => setEmbedded((n) => n + 1)), []);

  useEffect(() => {
    if (!chat || !project) {
      setUsage(null);
      return;
    }

    const timer = setTimeout(() => {
      // Warmed on the debounce the preview already has, so the vector is
      // usually there by the time the user stops typing — and certainly by the
      // time they send, which is the composition that has to be right.
      primeQuery(draft);

      const context = compose(draft, projectId, chat.modelId, skills, history);
      setUsage(
        contextUsage({
          context,
          history,
          draft,
          modelId: chat.modelId,
          projectName: project.name,
          projectDescription: project.description,
          attachments,
        }),
      );
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [chat, project, draft, projectId, skills, history, embedded, attachments]);

  return { usage, measured };
}
