/**
 * The web app manifest and the app icon, so a phone can install the web UI to its home screen.
 *
 * ── Why this lives in a .ts file as strings and base64 ────────────────────────
 * Same reason `page.ts` does: there is no asset-copy step anywhere in the build, and
 * `package.json`'s `files` ships only `dist` and `skill`. An `icon.png` beside the source
 * would typecheck, pass tests, and 404 in the published package. Anything the daemon serves
 * has to survive `tsc`, which means it has to be a module.
 *
 * ── What is actually required ────────────────────────────────────────────────
 * Less than most guides claim. Chrome dropped the service-worker-with-a-fetch-handler
 * requirement — the check was a proxy for "has an offline story" and sites defeated it with
 * empty handlers, so it was removed rather than tightened
 * (https://developer.chrome.com/blog/update-install-criteria, read 2026-09-20). What remains
 * is HTTPS and a manifest. So there is no service worker here, and there should not be one
 * added for installability alone: it would also mean caching the app shell, and the shell is
 * deliberately served `no-store` because a stale copy after an upgrade is a support question.
 */

/**
 * The icon, as the vector it was drawn as: a `>_` prompt, which is what is on the other end.
 *
 * No `width`/`height` — the manifest entry declares `sizes: "any"` and the consumer rasterises
 * at whatever size it needs. Chromium parses this entry without complaint (verified against
 * `Page.getAppManifest`, Chromium 1148), and Firefox takes SVG icons too.
 *
 * The glyph sits inside the middle 60% of the canvas rather than filling it, because the entry
 * is also declared `maskable`: Android crops the icon to whatever shape the launcher uses, and
 * only a circle of 80% diameter is guaranteed to survive. A glyph drawn to the edges loses its
 * ends on a round launcher.
 */
export const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
  '<rect width="512" height="512" fill="#1c222b"/>' +
  '<g fill="none" stroke-width="34" stroke-linecap="round" stroke-linejoin="round">' +
  '<polyline points="196,186 268,256 196,326" stroke="#dcdcdc"/>' +
  '<line x1="296" y1="326" x2="366" y2="326" stroke="#5f8ec4"/>' +
  "</g></svg>";

/**
 * The same icon rasterised to 192x192, because two consumers will not take the SVG.
 *
 * iOS has no manifest-icon support worth relying on and reads `<link rel="apple-touch-icon">`,
 * which has never accepted SVG; and an Android launcher that declines to rasterise SVG falls
 * back to a generated letter tile rather than to nothing, which looks like a bug. 1760 bytes
 * is a cheap way to not have to know which builds those are.
 *
 * Regenerate from ICON_SVG above — they are meant to be the same drawing:
 *
 *   printf '<body style="margin:0">%s</body>' "<the svg, with width=\"192\" height=\"192\">" > /tmp/i.html
 *   chrome --headless=new --window-size=192,192 --screenshot=/tmp/i.png file:///tmp/i.html
 *   base64 -w96 /tmp/i.png
 */
const ICON_PNG_BASE64 =
  "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";

/** Decoded once, at module load: the bytes are constant and every request wants the same ones. */
export const ICON_PNG = Buffer.from(ICON_PNG_BASE64, "base64");

/**
 * The manifest, as JSON text.
 *
 * Every URL in it is RELATIVE, resolved by the browser against the manifest's own URL. That is
 * the same rule the page follows for `api/events` and for the same reason: the daemon may be
 * mounted under a sub-path by a reverse proxy, and an absolute `/` would walk out of it. It is
 * also what makes `scope` correct without the daemon having to be told where it lives.
 *
 * `display: standalone` rather than `fullscreen`: the status bar carries the clock and the
 * battery, and a chat client is not worth losing them for. `theme_color` matches the page
 * background so the system draws that bar in the app's colour instead of framing it in white.
 */
export function renderManifest(title: string): string {
  return JSON.stringify(
    {
      name: title,
      short_name: title,
      description: "A coding agent, reachable from a browser.",
      start_url: ".",
      scope: "./",
      display: "standalone",
      // --bg and --own from page.ts. background_color is what fills the splash screen before
      // the page paints, so it matching the page is the difference between a launch and a flash.
      background_color: "#131313",
      theme_color: "#131313",
      icons: [
        {
          src: "icon.svg",
          sizes: "any",
          type: "image/svg+xml",
          purpose: "any maskable",
        },
        {
          src: "icon.png",
          sizes: "192x192",
          type: "image/png",
          purpose: "any maskable",
        },
      ],
    },
    null,
    2,
  );
}
