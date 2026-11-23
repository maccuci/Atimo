/// <reference types="vite/client" />

/**
 * The version from `package.json`, injected at build time.
 *
 * It exists for the crash report: a tester's "it broke" is only actionable
 * alongside the build it broke on, and asking someone to find the version in an
 * About box they never opened is asking them not to report it.
 */
declare const __APP_VERSION__: string;
