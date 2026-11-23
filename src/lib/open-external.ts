/**
 * Open a URL in the user's real browser.
 *
 * A plain anchor inside the Tauri webview would navigate the app window away
 * from itself, so the desktop build hands the URL to the OS instead.
 */
export async function openExternal(url: string) {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
