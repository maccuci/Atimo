import { Component, type ErrorInfo, type ReactNode } from "react";

/*
 * The last thing between a render error and a white window.
 *
 * React unmounts the whole tree when a render throws and nothing catches it, so
 * without this the failure mode of any bug in any component is an empty window
 * with no text in it. That is survivable while the only user is the person who
 * wrote it and has the console open; it is not survivable in someone else's
 * hands, because "it went blank" is the least actionable bug report there is.
 *
 * So the screen this renders has one job beyond apologising: turn a crash into
 * something the tester can paste back. The message, the component stack, the
 * build and the platform go on the clipboard in one click, because a report
 * that requires opening devtools is a report that does not get sent.
 */

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
  /** Bumped by "Try again", to remount the subtree rather than reload. */
  attempt: number;
}

/** The build, tolerating the test runner, where Vite's define never ran. */
const VERSION =
  typeof __APP_VERSION__ === "undefined" ? "dev" : __APP_VERSION__;

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept as well as shown: the console is where it is useful during
    // development, and the screen is where it is useful everywhere else.
    console.error("render failed", error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  /**
   * Remount the tree without reloading.
   *
   * Worth trying first because a good share of render errors are about the
   * state of one view rather than the workspace — a re-render after the user has
   * navigated elsewhere simply succeeds, and a reload would have cost them
   * whatever they had typed.
   */
  private retry = () => {
    this.setState((s) => ({
      error: null,
      componentStack: null,
      attempt: s.attempt + 1,
    }));
  };

  private report(): string {
    const { error, componentStack } = this.state;
    return [
      `Atimo ${VERSION}`,
      `platform: ${navigator.userAgent}`,
      `when: ${new Date().toISOString()}`,
      "",
      `${error?.name ?? "Error"}: ${error?.message ?? "unknown"}`,
      "",
      error?.stack ?? "(no stack)",
      "",
      "component stack:",
      componentStack ?? "(none)",
    ].join("\n");
  }

  render() {
    const { error, componentStack } = this.state;
    if (!error) {
      // Keyed on the attempt so retrying rebuilds the subtree from scratch. A
      // plain re-render would reuse the component instances whose state is the
      // most likely cause of the throw in the first place.
      return <div key={this.state.attempt} className="contents">{this.props.children}</div>;
    }

    return (
      <div className="flex h-full flex-col items-center justify-center gap-5 overflow-auto bg-bg px-6 py-10 text-center">
        <div className="flex w-full max-w-lg flex-col items-center gap-5">
          <div>
            <h1 className="text-[16px] font-semibold tracking-[-0.02em] text-fg">
              O Atimo encontrou um erro e parou de desenhar a tela
            </h1>
            <p className="mt-2 text-[13px] leading-relaxed text-fg-dim">
              Seu workspace está salvo — o problema é a interface, não seus dados.
              Tente de novo primeiro; se continuar, copie o relatório e envie
              para nós.
            </p>
          </div>

          <div className="w-full rounded-[12px] border border-red/30 bg-red-dim/25 px-3.5 py-3 text-left">
            <div className="font-mono text-[12px] leading-relaxed break-words text-red">
              {error.name}: {error.message}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={this.retry}
              className="pressable inline-flex h-8 items-center rounded-lg border border-cyan/40 bg-cyan/10 px-3 text-[12.5px] tracking-[-0.01em] text-cyan transition-[background-color] duration-150 ease-out hover:bg-cyan/20"
            >
              Tentar de novo
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="pressable inline-flex h-8 items-center rounded-lg border border-border px-3 text-[12.5px] tracking-[-0.01em] text-fg-dim transition-[border-color,color] duration-150 ease-out hover:border-border-strong hover:text-fg"
            >
              Recarregar
            </button>
            <CopyReport text={() => this.report()} />
          </div>

          {componentStack ? (
            <details className="w-full text-left">
              <summary className="cursor-pointer text-[11.5px] tracking-[-0.01em] text-fg-faint transition-colors hover:text-fg-dim">
                Detalhes técnicos
              </summary>
              <pre className="scroll-thin mt-2 max-h-64 overflow-auto rounded-[10px] border border-border bg-bg-inset p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-dim">
                {this.report()}
              </pre>
            </details>
          ) : null}

          <p className="text-[11px] text-fg-faint">Atimo {VERSION}</p>
        </div>
      </div>
    );
  }
}

/**
 * Copy, with the confirmation on the button itself.
 *
 * Separate component only so the boundary does not need state for it: the
 * boundary's own state is the crash, and mixing a transient "Copied" flag into
 * it would mean a copy re-runs the error render path.
 */
function CopyReport({ text }: { text: () => string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        const button = e.currentTarget;
        void navigator.clipboard.writeText(text()).then(
          () => {
            button.textContent = "Copiado";
            setTimeout(() => {
              button.textContent = "Copiar relatório";
            }, 1600);
          },
          () => {
            button.textContent = "Não foi possível copiar";
          },
        );
      }}
      className="pressable inline-flex h-8 items-center rounded-lg border border-border px-3 text-[12.5px] tracking-[-0.01em] text-fg-dim transition-[border-color,color] duration-150 ease-out hover:border-border-strong hover:text-fg"
    >
      Copiar relatório
    </button>
  );
}
