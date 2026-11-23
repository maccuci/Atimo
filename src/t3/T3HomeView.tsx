import { useRef, useState } from "react";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  Folder01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { Icon } from "@/components/ui/Icon";
import { useStore } from "@/lib/store";
import { getModel } from "@/lib/models";
import { cn } from "@/lib/utils";
import {
  projectTileStyle,
  projectTileText,
  relativeTime,
} from "./primitives";

/**
 * T3's hero, translated for Atimo: the wordmark owns the canvas, and the
 * composer — not a button — is the call to action. Submitting starts a chat
 * on the spot, in the active project.
 */
export function T3HomeView() {
  const workspaces = useStore((s) => s.workspaces);
  const workspaceId = useStore((s) => s.workspaceId);
  const projects = useStore((s) => s.projects);
  const chats = useStore((s) => s.chats);
  const messages = useStore((s) => s.messages);
  const projectId = useStore((s) => s.projectId);
  const selectChat = useStore((s) => s.selectChat);
  const selectProject = useStore((s) => s.selectProject);
  const newChat = useStore((s) => s.newChat);
  const send = useStore((s) => s.send);
  const setProjectSheet = useStore((s) => s.setProjectSheet);

  const [draft, setDraft] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const projectButton = useRef<HTMLButtonElement>(null);

  const workspace = workspaces.find((w) => w.id === workspaceId);
  const visibleProjects = projects.filter((p) => p.workspaceId === workspaceId);
  const projectById = new Map(visibleProjects.map((p) => [p.id, p]));

  const used = new Set(messages.map((m) => m.chatId));
  const recents = [...chats]
    .filter((c) => projectById.has(c.projectId) && used.has(c.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5);

  const activeProject =
    visibleProjects.find((p) => p.id === projectId) ?? visibleProjects[0];

  const startChat = () => {
    if (!activeProject) {
      setProjectSheet("new");
      return;
    }
    if (activeProject.id !== projectId) selectProject(activeProject.id);
    newChat();
  };

  const submitHero = () => {
    const text = draft.trim();
    if (!text) {
      startChat();
      return;
    }
    if (!activeProject) {
      setProjectSheet("new");
      return;
    }
    if (activeProject.id !== projectId) selectProject(activeProject.id);
    newChat();
    void send(text);
  };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-bg">
      {/* The graphene lattice, faded toward the center so the words own it */}
      <div aria-hidden className="bg-graph pointer-events-none absolute inset-0" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 90% 70% at 50% 30%, transparent 20%, var(--glass-fade, var(--bg)) 100%)",
        }}
      />

      <div className="scroll-thin relative flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[640px] flex-col px-6 pt-16 pb-[max(2rem,var(--safe-bottom))] sm:pt-24">
          <div className="stagger-in flex items-center gap-3">
            <img src="/logo.png" alt="" className="size-9 select-none rounded-[10px]" />
            <div className="min-w-0">
              <h1 className="text-[22px] leading-tight font-semibold tracking-[-0.03em] text-fg">
                Em que vamos trabalhar?
              </h1>
              <p className="mt-0.5 truncate text-[12.5px] text-fg-dim">
                {workspace?.name ?? "Workspace"} · o contexto do projeto vai junto, em qualquer modelo
              </p>
            </div>
          </div>

          <div
            className="t3-composer-shell stagger-in mt-7 w-full text-left"
            style={{ animationDelay: "60ms" }}
          >
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitHero();
                }
              }}
              rows={2}
              placeholder="Pergunte qualquer coisa — @ para citar o conhecimento do projeto…"
              aria-label="Começar um chat"
              className="max-h-40 min-h-[52px] w-full resize-none bg-transparent px-4 pt-4 text-[14px] leading-relaxed tracking-[-0.008em] text-fg outline-none placeholder:text-fg-faint"
            />
            <div className="flex items-center gap-2 px-3 pb-3">
              {activeProject ? (
                <>
                  <button
                    ref={projectButton}
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={pickerOpen}
                    aria-label={`Projeto: ${activeProject.name}`}
                    title="O chat começa neste projeto"
                    onClick={() => setPickerOpen((v) => !v)}
                    className={cn(
                      "pressable flex h-7 min-w-0 items-center gap-1.5 rounded-full border border-border bg-bg-surface pr-2 pl-1 text-[11.5px] font-medium tracking-[-0.01em] text-fg-dim",
                      "transition-[border-color,color] duration-150 ease-out hover:border-border-strong hover:text-fg",
                      pickerOpen && "border-border-strong text-fg",
                    )}
                  >
                    <span
                      className="t3-project-tile !h-5 !w-5 !rounded-full !text-[8.5px]"
                      style={projectTileStyle(activeProject.name)}
                    >
                      {projectTileText(activeProject.name)}
                    </span>
                    <span className="max-w-[200px] truncate">{activeProject.name}</span>
                    <Icon icon={ArrowDown01Icon} size={11} strokeWidth={2} className="text-fg-faint" />
                  </button>
                  <Menu
                    open={pickerOpen}
                    anchor={projectButton}
                    onClose={() => setPickerOpen(false)}
                    label="Projeto"
                    width={260}
                  >
                    {visibleProjects.map((p) => (
                      <MenuItem
                        key={p.id}
                        icon={Folder01Icon}
                        label={p.name}
                        active={p.id === activeProject.id}
                        trailing={
                          <Icon
                            icon={Tick02Icon}
                            size={13}
                            strokeWidth={2}
                            className={p.id === activeProject.id ? "text-fg" : "invisible"}
                          />
                        }
                        onSelect={() => {
                          selectProject(p.id);
                          setPickerOpen(false);
                        }}
                      />
                    ))}
                    <MenuSeparator />
                    <MenuItem
                      icon={Add01Icon}
                      label="Novo projeto"
                      onSelect={() => {
                        setPickerOpen(false);
                        setProjectSheet("new");
                      }}
                    />
                  </Menu>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setProjectSheet("new")}
                  className="pressable h-7 rounded-full border border-border bg-bg-surface px-2.5 text-[11.5px] font-medium text-fg-dim transition-[border-color,color] duration-150 ease-out hover:border-border-strong hover:text-fg"
                >
                  Criar o primeiro projeto
                </button>
              )}
              <div className="flex-1" />
              <button
                type="button"
                onClick={submitHero}
                aria-label="Começar chat"
                title="Começar chat (Enter)"
                className={cn(
                  "pressable flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-[background-color,color,opacity] duration-150 ease-out",
                  draft.trim()
                    ? "bg-fg text-bg hover:opacity-90"
                    : "bg-bg-active text-fg-faint",
                )}
              >
                <Icon icon={ArrowUp01Icon} size={16} strokeWidth={2.25} />
              </button>
            </div>
          </div>

          {recents.length > 0 ? (
            <section className="stagger-in mt-8" style={{ animationDelay: "120ms" }} aria-label="Continuar de onde parou">
              <h2 className="px-1 pb-2 text-[11.5px] font-medium text-fg-dim">
                Continuar de onde parou
              </h2>
              <div className="t3-card overflow-hidden p-1">
                {recents.map((chat) => {
                  const owner = projectById.get(chat.projectId)!;
                  return (
                    <button
                      key={chat.id}
                      type="button"
                      onClick={() => selectChat(chat.id)}
                      className="pressable group flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-colors duration-150 ease-out hover:bg-bg-hover"
                    >
                      <span
                        className="t3-project-tile !h-7 !w-7 !rounded-[7px] !text-[10.5px]"
                        style={projectTileStyle(owner.name)}
                      >
                        {projectTileText(owner.name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium tracking-[-0.008em] text-fg">
                          {chat.title}
                        </span>
                        <span className="block truncate text-[11.5px] text-fg-dim">
                          {owner.name} · {getModel(chat.modelId).label}
                        </span>
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-fg-dim">
                        {relativeTime(chat.updatedAt)}
                      </span>
                      <Icon
                        icon={ArrowRight01Icon}
                        size={14}
                        strokeWidth={1.75}
                        className="shrink-0 text-fg-faint transition-transform duration-200 ease-[var(--ease-out)] group-hover:translate-x-0.5 group-hover:text-fg"
                      />
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
