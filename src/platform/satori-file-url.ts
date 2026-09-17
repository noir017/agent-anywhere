/**
 * Make `http.file()` accept the relative paths adapters actually pass it.
 *
 * ── The bug this exists to kill ───────────────────────────────────────────────────────────────────
 * Every inbound Telegram photo, document, voice note and avatar failed to download, with this in the
 * log and no image reaching the agent (observed here 6 times before it was chased down, 2026-09-17):
 *
 *   [W] telegram get file error TypeError: Invalid URL
 *       at new URL (node:internal/url)
 *       at Proxy.<anonymous> (@satorijs/core/lib/index.mjs:794:19)
 *       at Proxy.file (@cordisjs/plugin-http/lib/index.js:367:33)
 *       { code: 'ERR_INVALID_URL', input: '/photos/file_10.jpg' }
 *
 * It is a collision between two upstream packages, each reasonable alone:
 *
 * 1. `adapter-telegram` fetches a file by its API-relative path against an `endpoint` that carries
 *    the bot token — `this.file.file('/' + filePath)` (adapter-telegram 4.5.11, src/bot.ts:150).
 *    Passing a relative path is supported: `HTTP.resolveURL` joins it onto `config.endpoint`
 *    (plugin-http 0.6.3, lib/index.js:216-222).
 * 2. `@satorijs/core` registers an `http/file` listener to serve its own `internal:` URLs, and the
 *    first thing it does is `new URL(_url)` (core 4.6.0, lib/index.mjs:794) — unguarded.
 *
 * `HTTP.file()` emits that listener BEFORE it resolves the URL (`serial('http/file', url, options)`
 * at lib/index.js:366, `resolveURL` only later), so satori's listener is handed the raw relative
 * path and throws on it. The download never happens; adapter-telegram catches the throw, logs it,
 * and returns undefined, so `h('img', undefined)` reaches the gateway as an image element with no
 * `src` at all — which is why the attachment silently never arrives rather than failing loudly.
 *
 * Not fixable by upgrading: 4.6.0 and 4.5.11 are the current releases of both packages (checked
 * 2026-09-17), and the combination is broken in them.
 *
 * ── The fix ──────────────────────────────────────────────────────────────────────────────────────
 * Prepend our own `http/file` listener. `serial` walks listeners in order and stops at the first one
 * returning a value, so running first means satori's listener only ever sees absolute URLs — the
 * only kind it was written for. A relative path is resolved with the very functions `HTTP` would
 * have used a few lines later, then re-entered through `file()`, which this time takes the normal
 * path. Anything already absolute (including `internal:` and `data:`) is passed straight through.
 *
 * ⚠️ HYRUM'S LAW: `resolveConfig` and `resolveURL` are internal methods of `@cordisjs/plugin-http`,
 * not part of its documented surface, and `this` being the HTTP instance inside an `http/file`
 * listener is an implementation detail of how `serial` is called. If an upgrade changes either, the
 * contract test in satori-file-url.test.ts fails — it reproduces the upstream bug directly, so it
 * also starts failing (and this file can be deleted) once upstream fixes it. Every failure mode
 * degrades to "return undefined", which is exactly today's behaviour without this file.
 */

/** The half of `@cordisjs/plugin-http`'s HTTP instance this listener leans on. */
interface HttpInternals {
  resolveConfig(init: unknown): unknown;
  resolveURL(url: string, config: unknown): URL;
  file(url: string, options: unknown): unknown;
}

/** Whether a string is already a complete URL, and so none of our business. */
function isAbsolute(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Install the listener on a satori context. Call once, before any adapter can fetch a file.
 *
 * Typed structurally rather than against `Context`: `http/file` is a plugin-http event and is not in
 * satori's event table, the same widening `installProxy` does for `http/websocket-init`.
 */
export function installRelativeFileUrlFix(ctx: unknown): void {
  (
    ctx as {
      on: (
        name: string,
        listener: (this: HttpInternals, url: string, options: unknown) => unknown,
        options: { prepend: boolean }
      ) => void;
    }
  ).on(
    'http/file',
    function (url, options) {
      if (typeof url !== 'string' || isAbsolute(url)) return undefined;
      try {
        const absolute = this.resolveURL(url, this.resolveConfig(options)).href;
        // Guaranteed to differ (it is absolute and `url` was not), so re-entering cannot loop.
        return this.file(absolute, options);
      } catch {
        // No endpoint to resolve against, or an internal that moved: hand it back unchanged and let
        // the original path produce the original error rather than inventing a new one.
        return undefined;
      }
    },
    { prepend: true }
  );
}
