/*
 * Putting an export where the user can find it.
 *
 * The one seam in this feature that knows which build it is running in, kept
 * apart from `export.ts` for the same reason `open-external.ts` is its own
 * file: everything above it is pure, testable, and identical on both.
 *
 * `@tauri-apps/api` is imported lazily so a browser build never pulls it in.
 */

export type ExportFormat = "json" | "md";
type FileFormat = ExportFormat | "svg";

export interface Saved {
  /** File name, which is what a confirmation should say. */
  name: string;
  /** True when the file manager was opened on it. */
  revealed: boolean;
}

const MIME: Record<FileFormat, string> = {
  json: "application/json",
  md: "text/markdown",
  svg: "image/svg+xml",
};

function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Write the file, and then show it.
 *
 * There is no save dialog. It would be the more familiar gesture, but it costs
 * another plugin and another permission, and the thing that actually matters
 * here is that the user ends up looking at their file — so the desktop build
 * writes to the downloads folder and opens the file manager on it, which the
 * `opener` plugin already installed for external links can do.
 *
 * Revealing is best-effort. A file that was written but not shown is still a
 * successful export, and failing the whole operation because a file manager did
 * not open would be reporting the wrong thing.
 */
export async function saveExport(
  stem: string,
  format: FileFormat,
  contents: string,
): Promise<Saved> {
  if (isDesktop()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const written = await invoke<{ path: string; name: string }>("export_write", {
      stem,
      format,
      contents,
    });

    let revealed = false;
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(written.path);
      revealed = true;
    } catch {
      // Left false; the caller names the folder instead of pointing at it.
    }

    return { name: written.name, revealed };
  }

  // Browser build. The download goes wherever the browser puts downloads, and
  // nothing here can find out where that was — hence `revealed: false`, which
  // is the honest answer rather than a convenient one.
  const name = `${stem}.${format}`;
  const url = URL.createObjectURL(new Blob([contents], { type: MIME[format] }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on a turn of the event loop rather than immediately: Safari has
  // been known to cancel a download whose blob URL was released in the same
  // tick as the click.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);

  return { name, revealed: false };
}
