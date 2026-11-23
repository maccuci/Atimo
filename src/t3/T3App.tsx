import { useEffect } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useStore } from "@/lib/store";
import { startSync } from "@/lib/sync";
import { useIsMobile } from "@/lib/use-media-query";
import { T3TitleBar } from "./T3TitleBar";
import { T3Sidebar } from "./T3Sidebar";
import { CommandPalette } from "@/components/CommandPalette";
import { Onboarding } from "@/components/Onboarding";
import { UpdateBanner } from "@/components/UpdateBanner";
import { ConnectSheet } from "@/components/settings/ConnectSheet";
import { ProjectSheet } from "@/components/projects/ProjectSheet";
import { T3ChatView } from "./T3ChatView";
import { T3HomeView } from "./T3HomeView";
import { WorkspaceSheet } from "@/components/workspaces/WorkspaceSheet";
import { AppsView } from "./views/AppsView";
import { ProjectsView } from "./views/ProjectsView";
import { SkillsView } from "./views/SkillsView";
import { PanelReviewView } from "@/components/views/PanelReviewView";
import { SettingsView } from "./views/SettingsView";
import { applyTheme } from "@/lib/theme";
import "@/styles/t3.css";

/**
 * The T3 interface for Atimo — same store, same services, new chrome.
 * The legacy App composition remains in `src/App.tsx` untouched; this root is
 * what `main.tsx` renders.
 */
export default function T3App() {
  const view = useStore((s) => s.view);
  const theme = useStore((s) => s.theme);
  const hydrated = useStore((s) => s.hydrated);
  const onboarding = useStore((s) => s.onboarding);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const newChat = useStore((s) => s.newChat);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const setView = useStore((s) => s.setView);
  const bootstrapProvider = useStore((s) => s.bootstrapProvider);
  const mobileNavOpen = useStore((s) => s.mobileNavOpen);
  const sidebarPeek = useStore((s) => s.sidebarPeek && !s.sidebarExpanded);
  const setMobileNavOpen = useStore((s) => s.setMobileNavOpen);
  const isMobile = useIsMobile();
  const reduceMotion = useReducedMotion();


  useEffect(() => applyTheme(theme), [theme]);

  /*
   * Once per app load, in order — unchanged from the legacy composition:
   * workspace first (hydration repoints fixture model ids through the store),
   * then the provider catalog so the picker is real even without a key.
   */
  useEffect(() => {
    let sync: Awaited<ReturnType<typeof startSync>> | null = null;
    let cancelled = false;

    void (async () => {
      sync = await startSync();
      if (cancelled) {
        void sync.stop();
        return;
      }
      void bootstrapProvider();
    })();

    return () => {
      cancelled = true;
      void sync?.stop();
    };
  }, [bootstrapProvider]);

  // Narrow viewports cannot afford the dual-rail desktop layout.
  useEffect(() => {
    if (!isMobile) setMobileNavOpen(false);
  }, [isMobile, setMobileNavOpen]);

  useEffect(() => {
    if (isMobile) setMobileNavOpen(false);
  }, [view, isMobile, setMobileNavOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) {
        if (e.key === "Escape" && mobileNavOpen) {
          e.preventDefault();
          setMobileNavOpen(false);
        }
        return;
      }

      if (e.key === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (e.key === "n") {
        e.preventDefault();
        newChat();
      } else if (e.key === "b" || e.key === "s") {
        e.preventDefault();
        if (isMobile) setMobileNavOpen(!mobileNavOpen);
        else toggleSidebar();
      } else if (e.key === "1") {
        e.preventDefault();
        setView("chat");
      } else if (e.key === "6") {
        e.preventDefault();
        setView("apps");
      } else if (e.key === "7") {
        e.preventDefault();
        setView("skills");
      } else if (e.key === ",") {
        e.preventDefault();
        setView("settings");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    setPaletteOpen,
    newChat,
    toggleSidebar,
    setView,
    isMobile,
    mobileNavOpen,
    setMobileNavOpen,
  ]);

  return (
    <div className="t3-shell flex h-full flex-col overflow-hidden bg-bg safe-pt">
      {/* t3code shell: the sidebar runs the full window height (it owns the
          traffic-light inset); the header belongs to the content column. */}
      <div className="relative flex min-h-0 flex-1">
        {isMobile ? (
          <AnimatePresence>
            {mobileNavOpen ? (
              <>
                <motion.button
                  type="button"
                  aria-label="Fechar navegação"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reduceMotion ? 0.1 : 0.18 }}
                  onClick={() => setMobileNavOpen(false)}
                  className="absolute inset-0 z-40 bg-bg/60 backdrop-blur-[2px]"
                />
                <motion.div
                  initial={reduceMotion ? { opacity: 0 } : { x: "-100%" }}
                  animate={reduceMotion ? { opacity: 1 } : { x: 0 }}
                  exit={reduceMotion ? { opacity: 0 } : { x: "-100%" }}
                  transition={
                    reduceMotion
                      ? { duration: 0.12 }
                      : { type: "spring", bounce: 0, duration: 0.34 }
                  }
                  className="absolute inset-y-0 left-0 z-50 flex"
                  style={{
                    width: "min(288px, 86vw)",
                    paddingLeft: "var(--safe-left)",
                  }}
                >
                  <T3Sidebar variant="drawer" onNavigate={() => setMobileNavOpen(false)} />
                </motion.div>
              </>
            ) : null}
          </AnimatePresence>
        ) : (
          <>
            <T3Sidebar />
            <AnimatePresence>
              {sidebarPeek ? (
                <motion.div
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -16 }}
                  animate={reduceMotion ? { opacity: 1 } : { opacity: 1, x: 0 }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -16 }}
                  transition={{ duration: reduceMotion ? 0.1 : 0.16, ease: "easeOut" }}
                  className="absolute inset-y-0 left-0 z-50 flex"
                >
                  <T3Sidebar variant="peek" onNavigate={() => useStore.getState().setSidebarPeek(false)} />
                </motion.div>
              ) : null}
            </AnimatePresence>
          </>
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <T3TitleBar />
        <div className="flex min-h-0 min-w-0 flex-1">
        <main className="flex min-h-0 min-w-0 flex-1">
          {hydrated ? (
            <>
              {view === "home" && <T3HomeView />}
              {view === "projects" && <ProjectsView />}
              {/*
                Stay mounted while other views are open. Unmounting threw away
                the open transcript's UI state and made Projects → back feel
                like the conversation had been wiped, even when the store still
                held it. Hidden, not conditional — same tree, same scroll.
              */}
              <div
                className={
                  view === "chat" ? "flex min-h-0 min-w-0 flex-1" : "hidden"
                }
                aria-hidden={view !== "chat"}
              >
                <T3ChatView />
              </div>
              {view === "apps" && <AppsView />}
              {view === "skills" && <SkillsView />}
              {view === "settings" && <SettingsView />}
            </>
          ) : null}
        </main>

        </div>
        </div>
      </div>

      <CommandPalette />
      <ConnectSheet />
      <WorkspaceSheet />
      <ProjectSheet />
      <PanelReviewView />
      {/* Below the sheets on purpose: a background courtesy must not sit on top
          of something the user opened. */}
      <UpdateBanner />

      {onboarding && <Onboarding />}
    </div>
  );
}
