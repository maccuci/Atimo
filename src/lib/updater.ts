/*
 * Self-update.
 *
 * The app ships unsigned — a paid Apple Developer ID is what buys notarisation,
 * and there isn't one — so a tester's first install costs them a Gatekeeper
 * warning and a right-click → Open. That is a one-time toll, and this file is
 * what keeps it one-time: every build after the first arrives through here
 * instead of through another download and another warning.
 *
 * Update signing is unrelated to code signing. Tauri verifies the downloaded
 * bundle against a minisign public key compiled into `tauri.conf.json`, which
 * Apple has no part in. Unsigned by macOS and signed by us are both true at
 * once, and it is the second that decides whether a tester can be handed a fix
 * on a Tuesday afternoon.
 *
 * Same seam shape as `adapter/` and `persistence/`: the plugin is imported
 * lazily behind a desktop check, so `bun run dev` in a browser gets a quiet
 * "no update" rather than a module that cannot load.
 */

/** How much of the download has arrived, 0..1, or null when the size is unknown. */
export type UpdateProgress = (fraction: number | null) => void;

export interface AvailableUpdate {
  version: string;
  /** Release notes, when the feed carries them. */
  notes: string | null;
  date: string | null;
  /** Download, verify, install. Resolves when the app is ready to restart. */
  install: (onProgress?: UpdateProgress) => Promise<void>;
}

/** Tauri injects this before any app code runs. */
function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Ask the release feed whether there is something newer. Null when there isn't.
 *
 * Never throws: an update check is a background courtesy, and a network blip on
 * launch must not become an error the user has to dismiss before working. The
 * caller decides whether a failure is worth showing, and mostly it is not.
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (!isDesktop()) return null;

  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return null;

    return {
      version: update.version,
      notes: update.body ?? null,
      date: update.date ?? null,
      install: async (onProgress) => {
        /*
         * The event stream reports a total once and then deltas, so the running
         * sum has to be kept here. `contentLength` is optional — a server
         * without a length header still downloads fine, and reporting null is
         * more honest than a bar that invents a denominator.
         */
        let total = 0;
        let received = 0;

        await update.downloadAndInstall((event) => {
          switch (event.event) {
            case "Started":
              total = event.data.contentLength ?? 0;
              received = 0;
              onProgress?.(total > 0 ? 0 : null);
              break;
            case "Progress":
              received += event.data.chunkLength;
              onProgress?.(total > 0 ? Math.min(received / total, 1) : null);
              break;
            case "Finished":
              onProgress?.(1);
              break;
          }
        });
      },
    };
  } catch (error) {
    console.error("could not check for updates", error);
    return null;
  }
}

/**
 * Quit and come back on the new build.
 *
 * Separate from `install` because they fail differently and the user should be
 * told differently: an install that fails leaves them on a working old version,
 * whereas a relaunch that fails leaves them staring at an app that has already
 * been replaced on disk and needs opening by hand.
 */
export async function restart(): Promise<void> {
  if (!isDesktop()) {
    window.location.reload();
    return;
  }
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
