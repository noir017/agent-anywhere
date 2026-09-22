/**
 * The page, as one HTML document with its CSS and JS inline.
 *
 * ── Why this is a TypeScript string and not an .html file ────────────────────
 * `npm run build` is exactly `tsc -p tsconfig.build.json` — no bundler, no asset pipeline, no
 * copy step anywhere in the repo — and `package.json`'s `files` ships only `dist` and `skill`.
 * A `.html` under `src/` is silently ignored by tsc: it would not reach `dist/`, would not
 * reach the npm tarball, and the daemon would 500 in production while working perfectly from
 * `tsx src/cli.ts` in development. Shipping it as a module makes dev and prod the same code
 * path and costs no build change at all.
 *
 * ── What that costs, and how it is contained ─────────────────────────────────
 * The script below is the one part of this repo the toolchain cannot see: not typechecked,
 * not linted, not unit-tested. So it is kept deliberately stupid. Every decision that could
 * live in TypeScript does: markdown becomes HTML in `web-markdown.ts`, the message shape is
 * fixed in `protocol.ts`, button ids are formed in `core/button-id.ts`. What is left here is
 * upsert-by-id, paint, and three fetches. If a change to this file needs a new *decision*,
 * that decision belongs on the other side of the wire.
 *
 * Two mechanical traps, since neither is visible until it bites:
 *   - A literal backtick or `${` in the script or the CSS would be read by TypeScript as
 *     part of THIS template, not as client code. The script therefore uses string
 *     concatenation throughout and contains neither.
 *   - `title` comes from config and is interpolated into `<title>`. It is escaped, because
 *     otherwise a `title:` in config.yaml is stored XSS on the operator's own page.
 *
 * ── The look ─────────────────────────────────────────────────────────────────
 * Dark, and only dark — no toggle, no light palette, no `prefers-color-scheme`. One palette
 * is the smallest thing that satisfies "dark by default", and a theme switch is exactly the
 * kind of feature that makes a page memorable. Nothing is loaded from anywhere: no fonts, no
 * CDN, no favicon request. The whole document is what the daemon serves.
 */
import { escapeHtml } from '../web-markdown.js';

/**
 * Fill in the configured title, whether the terminal pane exists, and whether a session can be
 * ended from it.
 *
 * All three are baked into the document rather than announced over the event stream because
 * they are properties of the daemon, not of a conversation: none can change while the page is
 * open, and a control that appears one sync later is a control that flickers into existence.
 */
export function renderPage(title: string, terminal: boolean, password = true, terminalEnd = false): string {
  return PAGE.replace(/__TITLE__/g, escapeHtml(title))
    .replace(/__TERM__/g, terminal ? 'true' : 'false')
    .replace(/__TERM_END__/g, terminalEnd ? 'true' : 'false')
    .replace(/__PASSWORD__/g, password ? 'true' : 'false')
    .replace('__GATE__', password ? PASSWORD_GATE : SSO_GATE);
}

/**
 * The two doors, and only ever one of them in the delivered page.
 *
 * Both are `#gate` wrapping `#login`, so every style rule and every reference in the script
 * below is blind to which one it got — the only code that has to know is the submit handler.
 * Rendering both and hiding one in script was the other option, and it flashes a password box
 * at someone who has no password on every load.
 *
 * The SSO one has no field on purpose. When the proxy in front is the only way in there is no
 * secret that works, so a box asking for one turns "your session with the identity provider
 * expired" into "wrong token" — the two states a locked-out operator most needs to tell apart.
 * Reloading is what re-triggers the provider's sign-in, so that is the button.
 */
const PASSWORD_GATE = `<form id="gate" autocomplete="off"><div id="login">
<input id="secret" type="password" placeholder="Token" autocomplete="current-password" autofocus>
<button type="submit">Enter</button>
<p id="err"></p>
</div></form>`;

const SSO_GATE = `<form id="gate" autocomplete="off"><div id="login">
<p id="err">Not signed in. Your access session may have expired.</p>
<button type="submit">Reload</button>
</div></form>`;

const STYLE = `
:root{--bg:#131313;--fg:#dcdcdc;--dim:#7d7d7d;--line:#272727;--own:#1c222b;--own-edge:#3a5f86;--field:#1a1a1a;color-scheme:dark}
*{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:#333 transparent}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:#303030;border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:#484848}
::-webkit-scrollbar-corner{background:transparent}
/* An id rule with display: wins over the browser's own [hidden]{display:none}, so #app and
   #hints would both ignore the attribute and show anyway — the chat pane before login, the
   command list with nothing in it. This is the standard fix and it has to stay. */
[hidden]{display:none!important}
html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif;display:flex;flex-direction:column}
#gate{flex:1;display:flex}
#login{margin:auto;padding:24px;width:100%;max-width:320px}
#login input{width:100%;padding:9px 11px;background:var(--field);color:var(--fg);border:1px solid var(--line);border-radius:4px;font:inherit}
#login button{margin-top:10px;width:100%}
#err{color:#c06a6a;min-height:1.6em;margin:8px 0 0;font-size:13px}

#app{display:flex;flex-direction:row;height:100%;width:100%;margin:0;overflow:hidden}

#sidebar{width:240px;flex:0 0 240px;background:#171717;border-right:1px solid var(--line);display:flex;flex-direction:column;height:100%;transition:margin-left .18s ease;z-index:10}
#sidebar.collapsed{margin-left:-240px}
/* Only ever on screen under the narrow-screen rules below, where the sidebar is an overlay
   rather than a column and there is otherwise nothing to tap to dismiss it. */
#backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:5}
#sidebar-header{display:flex;align-items:center;gap:6px;padding:10px 12px;border-bottom:1px solid var(--line);min-height:42px}
.sidebar-title{flex:1;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--dim)}
.btn-icon{background:none;border:0;padding:4px 7px;color:var(--dim);font:inherit;font-size:13px;cursor:pointer;border-radius:4px;line-height:1}
.btn-icon:hover{color:var(--fg);background:var(--field)}
#sidebar-header .add{font-size:15px;font-weight:600}

#topics{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:3px;padding:8px}
#topics .topic-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 9px;border:1px solid transparent;border-radius:5px;background:none;text-align:left;font:inherit;font-size:13px;cursor:pointer;transition:background .15s;position:relative}
#topics .topic-item:hover{background:#222}
#topics .topic-item.on{background:#252525;border-color:var(--line)}
/* Four states, and the dot is the only thing that carries all four. Read as one sentence: the
   colour says whether the agent is there, the pulse says whether it is busy.
     grey     — nothing resident. History, or a topic that will have to resume from a session id.
     dim blue — an agent child is up and idle. Same blue, not doing anything.
     blue     — a turn is executing.
     amber    — a question is on screen and nothing moves until it is answered. Wins over running,
                because during an ask the turn IS still open and would otherwise paint over it. */
.topic-dot{width:7px;height:7px;border-radius:50%;flex:0 0 7px;background:#444}
.topic-dot.live{background:#2b6a8f}
.topic-dot.running{background:#38bdf8;box-shadow:0 0 6px rgba(56,189,248,.8);animation:pulse 1.5s infinite}
.topic-dot.asking{background:#fbbf24;box-shadow:0 0 6px rgba(251,191,36,.8);animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
/* Two lines in one row, so the second can hold the directory. min-width:0 is what lets either
   line actually ellipsis — without it a flex item refuses to shrink below its content and a
   long title pushes the delete button out of the column instead of being cut. */
.topic-main{flex:1;min-width:0;display:flex;flex-direction:column}
.topic-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Which project this topic is in. Dimmer than an idle title on purpose: it is what you scan
   for when several topics are open, not what you read. */
.topic-dir{font-size:11px;line-height:1.35;color:#6b7683;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#topics .topic-item.on .topic-dir{color:#8b98a6}
#topics .topic-item.running .topic-title{color:var(--fg)}
#topics .topic-item.on.running .topic-title{color:#fff}
#topics .topic-item.idle .topic-title{color:var(--dim)}
#topics .topic-item.on.idle .topic-title{color:#a0a0a0}
/* Quiet but not finished: half a step back from a running title, half a step ahead of a topic
   with nothing behind it. The dot says which; this is so the eye finds the right row first. */
#topics .topic-item.idle.live .topic-title{color:#9a9a9a}
#topics .topic-item.on.idle.live .topic-title{color:#bcbcbc}
.topic-badge{background:#2563eb;color:#fff;border-radius:9px;padding:1px 6px;font-size:11px;font-weight:600;line-height:1.3;margin-left:4px;flex-shrink:0}
/* A terminal is attached to this topic. Deliberately not a fifth colour on .topic-dot: that dot
   is about the agent — whether one is resident, busy, or waiting on an answer — and a terminal is
   an unrelated state that can be true alongside any of them.
   A prompt-shaped glyph says which of the two it is without a legend. */
.topic-term{flex-shrink:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:9.5px;line-height:1;color:#4ade80;border:1px solid rgba(74,222,128,.35);border-radius:3px;padding:2px 3px;margin-left:4px}
.topic-del{opacity:0;background:none;border:0;color:var(--dim);font:inherit;font-size:16px;line-height:1;padding:2px 5px;cursor:pointer;border-radius:3px;margin-left:auto;flex-shrink:0;transition:opacity .15s,color .15s,background .15s}
#topics .topic-item:hover .topic-del,#topics .topic-item:focus-within .topic-del{opacity:1}
.topic-del:hover{color:#f87171;background:rgba(248,113,113,.15)}
@media(hover:none){.topic-del{opacity:.7}}
/* Pinned under the list rather than beside the + in the header, and that is the whole reason it
   is a footer: this throws away every room at once, and a one-character icon sitting next to
   "new topic" is a misclick away from it. Down here it is out of the way, has room for words
   that say what it does, and only turns red once the pointer is on it. */
#sidebar-footer{border-top:1px solid var(--line);padding:8px}
#clear-topics{display:block;width:100%;background:none;border:0;padding:7px 9px;border-radius:5px;color:var(--dim);font:inherit;font-size:12px;text-align:left;cursor:pointer;transition:color .15s,background .15s}
#clear-topics:hover{color:#f87171;background:rgba(248,113,113,.12)}

#chat{flex:1;display:flex;flex-direction:column;height:100%;min-width:0;position:relative}
#chat-header{display:flex;align-items:center;gap:10px;padding:9px 16px;border-bottom:1px solid var(--line);min-height:42px;font-size:13px}
.chat-title{font-weight:600;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50ch}
.chat-status{font-size:11.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.04em}
.chat-status.running{color:#38bdf8}
.chat-status.asking{color:#fbbf24}
/* The terminal takes the place of the transcript and the composer, not of the whole view: the
   header stays, so the sidebar button, the topic name and the way back out are all still
   where they were a moment ago. One class on #chat swaps the two.

   It is a window rather than a mode, which is what the title bar below is for. Minimizing only
   hides it — the iframe stays mounted and its WebSocket stays up, which is both what makes
   coming back instant and what keeps the switcher's marker lit. So visibility is a class, never
   a teardown. */
#term-toggle{margin-left:auto}
#term-toggle.on{color:#4ade80}
#term{display:none;flex:1;min-height:0;background:#000;flex-direction:column}
#chat.term #log,#chat.term #typing,#chat.term #note,#chat.term #bar{display:none}
#chat.term #term{display:flex}
#term-bar{display:flex;align-items:center;gap:4px;padding:4px 6px 4px 12px;background:#161616;border-bottom:1px solid var(--line);flex:0 0 auto}
.term-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dim);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
#term-end:hover{color:#f87171;background:rgba(248,113,113,.15)}
/* One host for every mounted terminal, of which exactly one is visible. Visibility is a class
   rather than the hidden attribute because the rule that sizes an iframe would have to fight
   it: display:block on the element beats hidden's user-agent display:none, and the loser of
   that fight is not obvious from reading either rule. */
#term-frames{flex:1;min-height:0}
#term-frames iframe{display:none;width:100%;height:100%;border:0}
#term-frames iframe.on{display:block}

#log{flex:1;overflow-y:auto;padding:20px 16px 8px;max-width:860px;width:100%;margin:0 auto}
.m{margin:0 0 18px;max-width:100%;overflow-wrap:anywhere;animation:fade .18s ease-out}
/* Only on the element's first appearance, which is the whole reason messages are now reconciled
   rather than rebuilt: an animation restarts every time a node is created, so under the old
   empty-and-repaint sync this would have flickered the entire transcript on every reconnect. */
@keyframes fade{from{opacity:0}to{opacity:1}}
/* Message-shaped placeholders, held in the transcript while a topic's first sync is in flight.
   Entering a topic was a blank panel followed by the whole conversation arriving in one frame;
   the point of these is that the panel already has the SHAPE of what is coming, so the real
   messages replace something instead of landing in an empty box. Widths are uneven on purpose —
   four identical bars read as a broken layout rather than as text that has not arrived. */
.sk{margin:0 0 18px}
.sk.own{background:var(--own);border-left:2px solid var(--own-edge);border-radius:0 6px 6px 0;padding:9px 12px}
.sk i{display:block;height:11px;margin-bottom:7px;border-radius:3px;background:#242424;animation:breathe 1.6s ease-in-out infinite}
/* Inside the tinted panel a neutral grey bar disappears, the same way --line borders do there. */
.sk.own i{background:#2b333e}
.sk i:last-child{margin-bottom:0}
/* Its own swing rather than the running-topic dot's pulse: that one fades to .3, which on a 6px
   dot reads as blinking and on an 11px bar over this background reads as gone. Half opacity is
   the point where the bar still breathes and never stops being a bar. */
@keyframes breathe{0%,100%{opacity:1}50%{opacity:.45}}
/* The other half of the same wait, for a topic that came back out of the local cache. There the
   transcript is already on screen, so there is nothing to hold a place in FRONT of — what is
   still unknown is whether anything was said while you were elsewhere, and that lands at the
   bottom. Sized and centred like .divider rather than like a message, for the ordinary case
   where nothing was missed: a message-shaped placeholder would have promised one. */
.syncing{display:flex;align-items:center;justify-content:center;gap:7px;margin:2px auto 18px;font-size:11.5px;color:var(--dim)}
.syncing .dots{display:inline-flex;gap:3px}
.syncing i{width:5px;height:5px;border-radius:50%;background:var(--dim);animation:blip 1.2s ease-in-out infinite}
.syncing i:nth-child(2){animation-delay:.2s}
.syncing i:nth-child(3){animation-delay:.4s}
/* Never all the way out, for the reason breathe does not either: three dots that vanish in turn
   read as a rendering fault on a 5px circle, where three that dim read as a wait. */
@keyframes blip{0%,100%{opacity:.3}50%{opacity:1}}
/* All three of the above are decoration over content that is arriving anyway, which is exactly
   what this query is for: without motion the skeleton is still a placeholder, the dots still say
   the page is waiting on something, and a message still appears — instantly. */
@media(prefers-reduced-motion:reduce){.m,.sk i,.syncing i{animation:none}}
/* Why an empty room is empty. A transcript lives in memory only while the topic LIST is
   persisted, so every restart leaves rows that open onto nothing — and an empty panel rendered
   faithfully is indistinguishable from a page that failed to load, which is how it was reported.
   Sized and centred like a system note rather than a message: it is about the room, not in it. */
.empty{margin:28px auto;max-width:46ch;text-align:center;font-size:12.5px;line-height:1.6;color:var(--dim)}
/* A rule and an indent were all that separated the two sides of the conversation, and at a
   glance down a long transcript that is not enough to find where your own question ended and
   the answer began. Own messages get a tinted panel instead — cool where the page is neutral,
   so it reads as "mine" without becoming a second theme. The agent's side stays flat on the
   background: one side marked is what makes the boundary visible, and marking both would just
   move the problem. */
.m.own{background:var(--own);border-left:2px solid var(--own-edge);border-radius:0 6px 6px 0;padding:9px 12px;color:#cdcdcd}
/* Inside the panel the neutral --line borders disappear into the tint, so the quote rail and
   any code block it carries are lifted a step. */
.m.own .q{border-left-color:#3d4a5a;color:#8b96a3}
.m.own .b pre,.m.own .b :not(pre)>code{background:#161b22;border-color:#2b3441}
/* A message that is on screen because it was typed here, not because the daemon sent it back.
   Dimmed while the request is in flight; edged red and given something to do about it once the
   request has failed, since the text in it is the only copy left. */
.m.pending{opacity:.6}
.m.failed{border-left-color:#a14a4a}
.m .warn{color:#e08a8a;font-size:12px;margin-top:7px}
.m .acts{margin-top:7px;display:flex;flex-wrap:wrap;gap:6px}
.m .acts button{font-size:12px;padding:4px 10px}
/* Cached from a daemon that is no longer running. Legible, just half a step back: it is real
   conversation, it is only no longer anything the process on the other end can be asked about. */
.m.hist{opacity:.9}
/* Says so, once, between the cached messages and the live ones. Sized like .empty rather than
   like a message, because it is about the room and not in it. */
.divider{margin:2px auto 20px;max-width:46ch;padding-top:10px;border-top:1px solid var(--line);text-align:center;font-size:11.5px;line-height:1.6;color:var(--dim)}
.b>:first-child{margin-top:0}
.b>:last-child{margin-bottom:0}
/* The operator's own message, which renderBody escapes and does not render (see room.ts).
   pre-wrap is what makes "not rendered" legible rather than a single run-on line: their
   newlines and indentation are the structure, since nothing turned them into tags. The break
   rules are for the other half of a pasted prompt — a URL or a path with no spaces in it,
   which would otherwise widen the bubble past the viewport. */
.b .raw{white-space:pre-wrap;overflow-wrap:break-word;word-break:break-word}
.b p{margin:0 0 .6em}
.b pre{background:var(--field);border:1px solid var(--line);border-radius:4px;padding:10px;overflow-x:auto;margin:.6em 0}
.b code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
.b pre code{font-size:12.5px}
.b :not(pre)>code{background:var(--field);padding:1px 4px;border-radius:3px}
.b h1,.b h2,.b h3,.b h4,.b h5,.b h6{font-size:1em;font-weight:600;margin:.9em 0 .4em}
.b blockquote{margin:.6em 0;padding-left:10px;border-left:2px solid var(--line);color:var(--dim)}
.b ul,.b ol{margin:.4em 0;padding-left:1.4em}
.b table{border-collapse:collapse;margin:.6em 0;font-size:13.5px;display:block;overflow-x:auto}
.b th,.b td{border:1px solid var(--line);padding:4px 8px;text-align:left}
.b hr{border:0;border-top:1px solid var(--line);margin:1em 0}
.b a{color:#8fa6c0}
.q{margin:0 0 6px;padding-left:10px;border-left:2px solid var(--line);color:var(--dim);font-size:13px;max-height:4.8em;overflow:hidden}
.t{color:var(--dim);font-size:11.5px;margin-top:4px}
.btns{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px}
button{background:var(--field);color:var(--fg);border:1px solid var(--line);border-radius:4px;padding:6px 11px;font:inherit;font-size:13px;cursor:pointer}
button:hover{border-color:#3a3a3a}
button:disabled{opacity:.5;cursor:default}
#typing{color:var(--dim);font-size:13px;padding:0 16px 6px;max-width:860px;width:100%;margin:0 auto}
#bar{border-top:1px solid var(--line);padding:10px 16px 14px;max-width:860px;width:100%;margin:0 auto}
#hints{margin-bottom:8px;display:flex;flex-wrap:wrap;gap:6px}
#hints button{font-size:12px}
#chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.chip{background:var(--field);border:1px solid var(--line);border-radius:3px;padding:1px 6px;font-size:12px;color:var(--dim)}
.files{margin-top:6px;display:flex;flex-wrap:wrap;gap:6px}
/* A picture the agent sent, drawn in the bubble. Capped in both directions: a screenshot of a
   4K display would otherwise push the timestamp and everything after it off the fold, and the
   point of showing it here is to recognise it, not to read it — that is what tapping is for. */
.shot{display:block;margin-top:6px;max-width:100%;max-height:340px;border:1px solid var(--line);border-radius:4px;cursor:zoom-in}
/* The tapped-open view. display:flex has to be restated under [hidden] or it beats the
   attribute's UA display:none and the overlay is never actually hidden. */
#lightbox{position:fixed;inset:0;z-index:20;background:rgba(0,0,0,.88);display:flex;align-items:center;justify-content:center;padding:12px;cursor:zoom-out}
#lightbox[hidden]{display:none}
#lightbox img{max-width:100%;max-height:100%;object-fit:contain}
#row{display:flex;gap:8px;align-items:flex-end}
#input{flex:1;resize:none;max-height:40vh;max-height:40dvh;padding:8px 10px;background:var(--field);color:var(--fg);border:1px solid var(--line);border-radius:4px;font:inherit;overflow-y:auto}
#input:focus,#login input:focus{outline:none;border-color:#3d3d3d}
#note{color:var(--dim);font-size:12px;padding:0 16px 8px;max-width:860px;width:100%;margin:0 auto}
/* Phones and tablets held upright. Everything here is about the parts of a handset a desktop
   layout has no concept of: a URL bar that eats viewport height, a home indicator under the
   composer, Safari's zoom-on-focus, and a finger instead of a pointer. */
@media(max-width:640px){
  /* height:100% resolves against a viewport that still counts the collapsing browser chrome,
     so the composer sits below the fold until the page is scrolled. dvh is the height actually
     on screen; the plain vh declaration above it stays as the fallback for older engines. */
  html,body{height:100vh;height:100dvh}
  /* A column 240px wide leaves nothing of the chat on a 360px screen, so it becomes a drawer
     over it, dismissed by tapping the backdrop. Fixed rather than absolute so it tracks the
     visible viewport as the URL bar collapses instead of the taller page box behind it, and
     the collapsed offset moves with the width — -240px would leave a strip of a 300px drawer
     still on screen. */
  #sidebar{position:fixed;top:0;bottom:0;left:0;height:auto;width:min(82vw,300px);flex-basis:min(82vw,300px);box-shadow:3px 0 12px rgba(0,0,0,.6)}
  #sidebar.collapsed{margin-left:-100%}
  #backdrop{display:block}
  #topics .topic-item{padding:10px 9px}
  /* The drawer runs to the bottom edge, so its last row needs the same home-indicator clearance
     the composer gets — without it "Clear all topics" sits under the indicator, which is both
     hard to hit and the wrong control to make hard to hit accurately. */
  #sidebar-footer{padding:8px 8px calc(8px + env(safe-area-inset-bottom,0px))}
  /* The drawer toggle is the only way back to the topic list on a phone, but it inherits
     .btn-icon's 13px glyph and 4px padding — a 26x21 target, well under the 44px every mobile
     HIG asks for. Pad it out to 44px square and grow the glyph to match; the header's own
     vertical padding gives way to it, so the title bar goes 42px -> 49px rather than 42 -> 56.
     The negative margin puts the glyph's ink back where .btn-icon had it, now that it sits in
     a box twice the width. Setting display here is only safe because of the global
     [hidden]{display:none!important} above — without it this rule would win over the UA's
     own [hidden] rule and strand the button on screen while the drawer is open. */
  #chat-header{padding:2px 12px}
  #expand-sidebar{display:inline-flex;align-items:center;justify-content:center;
    min-width:44px;height:44px;margin-left:-10px;font-size:20px;color:var(--fg)}
  .chat-title{max-width:none}
  #log{padding:14px 12px 6px}
  #typing,#note{padding-left:12px;padding-right:12px}
  /* env() keeps the Send row clear of the home indicator rather than under it. */
  #bar{padding:8px 12px calc(10px + env(safe-area-inset-bottom,0px))}
  /* Safari zooms the whole page in when a field it focuses is under 16px, and it does not zoom
     back out afterwards — every tap on the composer would leave the page a little larger. */
  #input,#secret{font-size:16px}
  #input{max-height:30dvh}
  /* The window's two controls, for a finger. Same 44px the drawer toggle gets, and for the
     same reason — but here it also matters WHICH of the two a near miss lands on: one hides the
     terminal and the other kills what is running in it. The gap is the separation. Setting
     display is safe against the close button's own hidden attribute for the reason given
     there: the global [hidden] rule at the top is !important. */
  #term-bar{padding:2px 4px 2px 12px;gap:8px}
  #term-min,#term-end{display:inline-flex;align-items:center;justify-content:center;
    min-width:44px;height:44px;font-size:18px}
}
`;

const SCRIPT = `
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var log=$('log'), app=$('app'), gate=$('login'), err=$('err'), input=$('input'),
      chips=$('chips'), hints=$('hints'), typing=$('typing'), note=$('note'), picker=$('picker'),
      bar=$('topics'), sidebar=$('sidebar'), collapseBtn=$('collapse-sidebar'),
      expandBtn=$('expand-sidebar'), newTopicBtn=$('new-topic'), backdrop=$('backdrop'),
      clearBtn=$('clear-topics'), chatTitle=$('topic-title'), chatStatus=$('topic-status'),
      chat=$('chat'), termBtn=$('term-toggle'), termHost=$('term-frames'),
      termName=$('term-name'), termMinBtn=$('term-min'), termEndBtn=$('term-end'),
      lightbox=$('lightbox'), lightboxImg=$('lightbox-img');
  var data={}, els={}, files=[], commands=[], stream=null, done=false;
  // Last markup written per message, so a sync that re-sends an unchanged message touches no DOM.
  var sig={};
  // Whether #log currently holds placeholders rather than messages, and whether the next sync is
  // the one that opens a topic (which lands at the bottom no matter where the old one was read).
  var skeleton=false, entering=true;
  // What the last sync said about this topic being older than the daemon, and the notice element
  // that says so. Both are per topic, so both are reset on the way into one.
  var stale=false, emptyEl=null;
  // Which run of the daemon the live stream belongs to, and whether this topic's first sync has
  // landed. 0 until one has: every message below is qualified by the generation it came from,
  // and before the first sync the only generations known are the ones out of the cache.
  var epoch=0, synced=false;
  var topic = new URLSearchParams(location.search).get('t') || '';
  // Whether this daemon serves a terminal at all, and whether it was given a way to END one (a
  // configured terminal.endCommand). Without that, the window has no close button rather than a
  // close button that cannot work.
  var TERM_OK = __TERM__;
  var TERM_END = __TERM_END__;
  // Whether the shared secret is still a way in. False means the gate above has no field and
  // the only thing that can sign anyone in is the proxy in front (sso.password: false).
  var PASSWORD_LOGIN = __PASSWORD__;
  // A terminal window belongs to a TOPIC, not to the page: 'open' is shown, 'min' is hidden and
  // still connected, absent is no window at all. Keyed this way because the alternative — one
  // window that follows whichever topic is on screen — would tear down the connection to the
  // topic being left, which is both a surprise (the pane you minimized is gone) and the end of
  // the switcher's marker ever meaning anything: at most one topic could ever be lit.
  var termState = {};
  var termFrames = {};
  // A reload asked for the pane, before any topic is known. "Asked for" is separate from
  // "shown": there is nothing to point a terminal at until the first sync names a topic, so
  // this is spent there rather than here.
  var termBoot = TERM_OK && new URLSearchParams(location.search).get('v')==='term';
  var topics = [];
  var readCounts = {};
  try { readCounts = JSON.parse(localStorage.getItem('aa_reads') || '{}'); } catch(x){}

  function saveReads(){
    try { localStorage.setItem('aa_reads', JSON.stringify(readCounts)); } catch(x){}
  }

  /**
   * How a message is identified ON THIS PAGE, which is deliberately not its server id.
   *
   * Server ids are 'w1', 'w2'..., counted per PROCESS — so a restarted daemon hands the same
   * ones out again, and this page keeps transcripts across restarts. Keyed by id alone, the
   * first reply after a restart silently overwrites a cached message from before it. The
   * generation — a sync's epoch field — is what tells the two apart. A message typed here and
   * not yet acknowledged has no server id at all and travels under its nonce instead, behind a
   * prefix no server id can collide with.
   */
  function keyOf(m){ return m._local ? m.id : m._g + ':' + m.id; }

  /** A cached message from a daemon that is no longer the one on the other end of the stream. */
  function isHistory(m){ return Boolean(m) && !m._local && epoch !== 0 && m._g !== epoch; }

  // ── The local transcript cache ─────────────────────────────────────────────
  // What lets a topic paint before the stream has answered, and what makes a daemon restart cost
  // the conversation its liveness rather than its contents. IndexedDB rather than localStorage:
  // one transcript with code blocks in it runs to hundreds of kilobytes, and localStorage's ~5MB
  // is shared with everything else this origin keeps.
  //
  // One record per topic, holding the message list as a STRING rather than an object graph. The
  // byte budget below is then something that can actually be measured, and nothing rests on how
  // a structured clone treats these objects.
  var DB_NAME='aa_cache', DB_VER=1, STORE='topics';
  // Rotation, because a cache that only grows is just a slower version of the bug being fixed:
  // the TAIL of a topic is kept, and the least recently written topics go first.
  var MAX_CACHE_TOPICS=24, MAX_CACHE_MSGS=200, MAX_CACHE_BYTES=512*1024;
  // How long writes are held together. A streamed reply upserts the same message every second or
  // so, and each one would otherwise re-serialise the whole topic.
  var SAVE_MS=400;
  var db=null, dbOff=false, saveTimer=null;

  function cacheOff(why){
    if(dbOff) return;
    dbOff=true; db=null;
    // Once, and only once. The page works without the cache, and a line per attempted write
    // would be the loudest thing in the console for a feature nobody can see failing.
    try { console.warn('[webui] local transcript cache disabled:', (why && why.message) || why || 'unavailable'); } catch(x){}
  }

  function idb(){
    if(db) return Promise.resolve(db);
    if(dbOff || !window.indexedDB) return Promise.resolve(null);
    return new Promise(function(res){
      var rq;
      try { rq = window.indexedDB.open(DB_NAME, DB_VER); } catch(x){ cacheOff(x); return res(null); }
      rq.onupgradeneeded = function(){
        var d = rq.result;
        if(d.objectStoreNames.contains(STORE)) return;
        // The at field is indexed so eviction can walk oldest-first over KEYS alone — a cursor
        // over the records would read every cached transcript into memory to delete one of them.
        d.createObjectStore(STORE, {keyPath:'topic'}).createIndex('at','at');
      };
      rq.onsuccess = function(){ db = rq.result; res(db); };
      rq.onerror = function(){ cacheOff(rq.error); res(null); };
      rq.onblocked = function(){ cacheOff('another tab holds an older version'); res(null); };
    });
  }

  /** One transaction. Resolves {ok:true, value} with whatever body asked for, or {ok:false}. */
  function cacheTx(mode, body){
    return idb().then(function(d){
      if(!d) return {ok:false};
      return new Promise(function(res){
        var t, out=null;
        try { t = d.transaction(STORE, mode); } catch(x){ cacheOff(x); return res({ok:false}); }
        var rq = body(t.objectStore(STORE));
        if(rq) rq.onsuccess = function(){ out = rq.result; };
        t.oncomplete = function(){ res({ok:true, value:out}); };
        t.onabort = function(){ res({ok:false, error:t.error}); };
        t.onerror = function(){ res({ok:false, error:t.error}); };
      });
    });
  }

  /** The slice of a topic worth keeping: its tail, trimmed to the byte budget. */
  function cacheBody(msgs){
    var out = msgs.length > MAX_CACHE_MSGS ? msgs.slice(-MAX_CACHE_MSGS) : msgs;
    var json = JSON.stringify(out);
    // A quarter at a time rather than one message at a time: a topic of long answers would
    // otherwise re-serialise itself dozens of times on the way under the budget.
    while(json.length > MAX_CACHE_BYTES && out.length > 1){
      out = out.slice(Math.max(1, Math.round(out.length/4)));
      json = JSON.stringify(out);
    }
    return json;
  }

  function cacheWrite(tId, msgs, retried){
    var rec = { topic: tId, at: Date.now(), json: cacheBody(msgs) };
    return cacheTx('readwrite', function(store){ store.put(rec); evict(store, tId, false); return null; })
      .then(function(r){
        if(r.ok || dbOff) return;
        if(retried) return cacheOff(r.error || 'the write was refused twice');
        // Out of room, most likely. Everything except the topic being read goes, and the write
        // is tried once more before the cache is written off for this session.
        return cacheTx('readwrite', function(store){ evict(store, tId, true); return null; })
          .then(function(){ return cacheWrite(tId, msgs, true); });
      });
  }

  /** Drop the least recently written topics. all throws away everything except keep. */
  function evict(store, keep, all){
    var count = store.count();
    count.onsuccess = function(){
      var over = all ? count.result : count.result - MAX_CACHE_TOPICS;
      if(over <= 0) return;
      var cur = store.index('at').openKeyCursor();
      cur.onsuccess = function(){
        var at = cur.result;
        if(!at || over <= 0) return;
        if(at.primaryKey !== keep){ store.delete(at.primaryKey); over--; }
        at.continue();
      };
    };
  }

  function cacheRead(tId){
    return cacheTx('readonly', function(store){ return store.get(tId); }).then(function(r){
      if(!r.ok || !r.value || !r.value.json) return null;
      try { var list = JSON.parse(r.value.json); return (list && list.length) ? list : null; } catch(x){ return null; }
    });
  }

  function cacheDrop(tId){ cacheTx('readwrite', function(store){ store.delete(tId); return null; }); }
  function cacheClear(){ cacheTx('readwrite', function(store){ store.clear(); return null; }); }

  /**
   * What is on screen, in the order it is on screen, as the cache should hold it.
   *
   * Read off #log rather than from a list of our own, because here the DOM IS the order — and
   * what it holds is already the union of cached history and what the daemon has since sent,
   * which is exactly what the next reload should get back.
   *
   * A local message is included only once it has FAILED. One still in flight is a question this
   * tab alone can answer, and restoring it after a reload would either duplicate a message the
   * daemon did receive or claim one was lost that was not.
   */
  function cacheable(){
    var out=[];
    for(var n=log.firstChild; n; n=n.nextSibling){
      var k = n.getAttribute ? n.getAttribute('data-k') : null;
      var m = k ? data[k] : null;
      if(!m) continue;
      if(m._local && m._state !== 'failed') continue;
      out.push(m);
    }
    return out;
  }

  /** Remember the current topic, at most once every SAVE_MS. */
  function cacheSave(){
    if(!topic || dbOff || saveTimer) return;
    saveTimer = setTimeout(function(){
      saveTimer = null;
      if(topic) cacheWrite(topic, cacheable(), false);
    }, SAVE_MS);
  }

  /** Write now rather than at the end of the window — for the way out of a topic. */
  function cacheFlush(){
    if(!saveTimer) return;
    clearTimeout(saveTimer); saveTimer = null;
    if(topic) cacheWrite(topic, cacheable(), false);
  }

  // The one place the narrow-screen breakpoint lives on this side of the wire. It has to stay
  // the same number as the @media rule above: the CSS turns the sidebar into an overlay, and
  // this decides whether opening a topic should then get it back out of the way.
  var NARROW = 640;
  function narrow(){ return window.innerWidth <= NARROW; }

  var sidebarOpen = localStorage.getItem('aa_sb_open');
  if(sidebarOpen === null){ sidebarOpen = narrow() ? '0' : '1'; }
  function applySidebar(){
    var open = sidebarOpen !== '0';
    sidebar.className = open ? '' : 'collapsed';
    expandBtn.hidden = open;
    // Hidden wins over the media query's display:block, so on a wide screen this stays off
    // regardless of the drawer's state.
    backdrop.hidden = !open;
  }
  function setSidebar(open){
    sidebarOpen = open ? '1' : '0';
    try { localStorage.setItem('aa_sb_open', sidebarOpen); } catch(x){}
    applySidebar();
  }
  collapseBtn.addEventListener('click', function(){ setSidebar(false); });
  expandBtn.addEventListener('click', function(){ setSidebar(true); });
  backdrop.addEventListener('click', function(){ setSidebar(false); });
  applySidebar();

  // Escapes for BOTH uses this page makes of it: element content, and the inside of a
  // double-quoted attribute. textContent alone covers the first and leaves the quote, which is
  // what the second needs — a directory whose name contains a double quote would end the title
  // attribute early and put the rest of the path in the tag. Everything interpolated here is the
  // (their paths, their command list), so this is a rendering bug rather than a way in; the
  // load-bearing escaping is web-markdown.ts, which never lets agent output near a tag at all.
  function text(s){
    var d=document.createElement('div');
    d.textContent=s==null?'':String(s);
    return d.innerHTML.replace(/"/g,'&quot;');
  }
  function wait(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

  // Retried, which is only safe because every send carries a nonce the server remembers: on a
  // bad link a request can be accepted and still time out, and without the nonce a retry would
  // post the same message twice.
  function post(path, body, tries){
    return fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body),credentials:'same-origin'}).then(function(r){
        if(!r.ok && r.status>=500 && tries>0) return wait(700).then(function(){ return post(path, body, tries-1); });
        return r;
      }, function(e){
        if(tries>0) return wait(700).then(function(){ return post(path, body, tries-1); });
        throw e;
      });
  }

  function atBottom(){ return log.scrollHeight - log.scrollTop - log.clientHeight < 80; }
  function toBottom(){ log.scrollTop = log.scrollHeight; }

  function clock(ms){
    var d=new Date(ms), p=function(n){ return (n<10?'0':'')+n; };
    return p(d.getHours())+':'+p(d.getMinutes());
  }

  /**
   * Draw one message, creating its element if this is the first sight of it.
   *
   * before is how cached history gets ABOVE a transcript the daemon has already sent: the node
   * is inserted in front of the first live message instead of appended after the last one.
   */
  function paint(key, before){
    var m=data[key]; if(!m) return;
    var el=els[key];
    if(!el){
      clearSkeleton();
      el=document.createElement('div');
      // The page's own key, on the node, so the order on screen can be read back off #log —
      // which is what the cache writes and what places the history divider.
      el.setAttribute('data-k', key);
      // before is where cached history goes; the waiting line, when one is up, is the last thing
      // in the log and has to stay there, so anything painted under it goes above it instead.
      var at = (before && before.parentNode === log) ? before : syncingEl;
      if(at) log.insertBefore(el, at); else log.appendChild(el);
      els[key]=el;
    }
    var hist = isHistory(m);
    var cls = 'm' + (m.own ? ' own' : '') + (hist ? ' hist' : '')
      + (m._local && m._state === 'sending' ? ' pending' : '')
      + (m._local && m._state === 'failed' ? ' failed' : '');
    var h='';
    if(m.quote && m.quote.html) h += '<div class="q">'+m.quote.html+'</div>';
    h += '<div class="b">'+m.html+'</div>';
    if(m.file){
      // An image is drawn, not just named — a screenshot the agent took is about to be looked
      // at, and a round trip through the downloads folder to do that is the friction this
      // exists to remove. The link stays underneath either way: it is still the only way to
      // get the bytes onto disk, and it is what a picture that fails to load degrades to.
      if(m.file.image) h += '<img class="shot" src="'+text(m.file.url)+'" alt="'+text(m.file.name)+'" loading="lazy">';
      h += '<div class="files"><a href="'+text(m.file.url)+'" download>'+text(m.file.name)+'</a></div>';
    }
    // Buttons are dropped from a message that came out of the cache: the process that would
    // answer them is gone, and the id they name now means a different message or nothing at
    // all. A control that cannot act is worse than no control.
    if(!hist && m.buttons && m.buttons.length){
      h += '<div class="btns">';
      for(var i=0;i<m.buttons.length;i++){
        h += '<button type="button" data-msg="'+text(m.id)+'" data-btn="'+text(m.buttons[i].id)+'">'
           + text(m.buttons[i].label) + '</button>';
      }
      h += '</div>';
    }
    if(m._local && m._state === 'failed') h += failedActions(m);
    var meta = clock(m.at) + (m.reactions && m.reactions.length ? '  '+m.reactions.join(' ') : '');
    h += '<div class="t">'+text(meta)+'</div>';
    // Write nothing when nothing changed. A sync re-paints every message it carries, and most of
    // them are messages already on screen unchanged — rewriting innerHTML for those would drop
    // the caret out of a selection, restart any <img> decode, and undo the enabled state of a
    // button the click handler just disabled, all for identical markup.
    if(sig[key]===h && el.className===cls) return;
    el.className = cls;
    el.innerHTML = h;
    sig[key] = h;
  }

  /**
   * What a message that never reached the daemon offers instead of silence.
   *
   * Retry is only there while this tab still holds the body it would re-send — the attachments
   * in it are base64 and deliberately never written to the cache, so a failed message restored
   * after a reload offers Copy and Discard alone. Re-sending the text without the files it was
   * written about would be a different message.
   */
  function failedActions(m){
    var h = '<div class="warn">Not delivered — the agent never saw this.</div><div class="acts">';
    if(outbox[m._nonce]) h += '<button type="button" data-retry="'+text(m._nonce)+'">Retry</button>';
    return h + '<button type="button" data-copy="'+text(m._nonce)+'">Copy</button>'
      + '<button type="button" data-discard="'+text(m._nonce)+'">Discard</button></div>';
  }

  function upsert(m){
    m._g = epoch;
    var stick=atBottom();
    var key = keyOf(m);
    data[key]=m; paint(key); syncEmptyNote(); if(stick) toBottom();
  }

  function drop(key){
    if(els[key]) { els[key].remove(); delete els[key]; }
    delete data[key];
    delete sig[key];
    syncEmptyNote();
  }

  /**
   * Bring the transcript to exactly the list given, reusing what is already on screen.
   *
   * The predecessor emptied #log and rebuilt every message from the sync. That is what made
   * entering a topic jarring: the scroll container was destroyed along with its scrollTop, then
   * refilled and snapped, so a topic whose messages were ALREADY painted from cache still flashed
   * through blank. Here an unchanged message is left untouched (paint writes nothing when the
   * markup matches), and appendChild MOVES a node that already exists rather than cloning it — so
   * ordering costs no re-creation either, and nothing re-runs the fade-in animation.
   *
   * Only messages of the CURRENT generation are the sync's to remove. Cached history belongs to
   * a daemon that is not on the other end of this stream, and a local message still waiting on
   * its POST was never the server's to know about; both would otherwise vanish the moment the
   * connection blipped.
   */
  function reconcile(list){
    clearSkeleton();
    // The sync this was waiting for. Cleared before anything is painted, so the messages it
    // carries are appended to a log whose last child is a message again.
    clearSyncing();
    var keep={};
    for(var i=0;i<list.length;i++){
      var m=list[i];
      m._g = epoch;
      var key=keyOf(m);
      keep[key]=1;
      data[key]=m;
      paint(key);
      log.appendChild(els[key]);
    }
    var gone=[];
    for(var k in els){
      if(keep[k]) continue;
      var held=data[k];
      if(!held || held._local || held._g !== epoch) continue;
      gone.push(k);
    }
    for(var j=0;j<gone.length;j++) drop(gone[j]);
  }

  /**
   * Hold the shape of a transcript that has not arrived yet.
   *
   * Only ever shown into an EMPTY log: a topic painted from cache has real content to look at,
   * and stacking placeholders under it would claim messages are still coming when the next event
   * is going to replace what is there rather than extend it.
   */
  var SKELETON = '<div class="sk own"><i style="width:34%"></i></div>'
    + '<div class="sk"><i style="width:86%"></i><i style="width:73%"></i><i style="width:41%"></i></div>'
    + '<div class="sk own"><i style="width:52%"></i><i style="width:28%"></i></div>'
    + '<div class="sk"><i style="width:79%"></i><i style="width:62%"></i></div>';

  function showSkeleton(){
    if(log.firstChild) return;
    log.innerHTML = SKELETON;
    skeleton = true;
  }

  function clearSkeleton(){
    if(!skeleton) return;
    skeleton = false;
    log.innerHTML = '';
    // Emptying #log invalidates anything held by reference into it, and these are the only
    // things in there that are not messages.
    emptyEl = null;
    dividerEl = null;
    syncingEl = null;
  }

  /**
   * Say why an empty room is empty, when the server said this topic predates the daemon.
   *
   * A transcript lives in the daemon's memory while the topic LIST lives on disk, so every
   * restart leaves rows that open onto nothing. Rendered faithfully that is a blank panel, which
   * is indistinguishable from a page that failed to load — and is exactly how it was reported.
   */
  var EMPTY_NOTE = 'This topic is older than the running daemon. Transcripts are kept in memory only,'
    + ' so anything said in it is no longer here. The agent still has its context, so you can carry'
    + ' on where you left off.';

  function hasMessages(){
    for(var k in els) if(els.hasOwnProperty(k)) return true;
    return false;
  }

  function syncEmptyNote(){
    var want = stale && !hasMessages();
    if(want === Boolean(emptyEl)) return;
    if(want){
      clearSkeleton();
      emptyEl = document.createElement('div');
      emptyEl.className = 'empty';
      emptyEl.textContent = EMPTY_NOTE;
      log.appendChild(emptyEl);
    } else {
      if(emptyEl.parentNode) emptyEl.parentNode.removeChild(emptyEl);
      emptyEl = null;
    }
  }

  /**
   * The line between what this browser remembers and what the daemon is actually serving.
   *
   * A transcript lives in the daemon's memory, so a restart takes it — but it does not take the
   * conversation, which the agent still has, and it no longer takes what this page saw of it
   * either. The messages above this line came back out of the local cache: they are real, they
   * are just no longer anything the daemon can be asked about, which is why nothing up there has
   * a button on it.
   */
  var DIVIDER_NOTE = 'Everything above came from this browser, kept from before the daemon restarted.'
    + ' The agent still has its context, so you can carry on below.';
  var dividerEl=null;

  /** Keep the divider immediately after the last cached message, or gone when there are none. */
  function placeDivider(){
    var last=null;
    for(var n=log.firstChild; n; n=n.nextSibling){
      var k = n.getAttribute ? n.getAttribute('data-k') : null;
      if(k && isHistory(data[k])) last=n;
    }
    if(!last){
      if(dividerEl && dividerEl.parentNode) dividerEl.parentNode.removeChild(dividerEl);
      dividerEl=null;
      return;
    }
    if(!dividerEl){
      dividerEl=document.createElement('div');
      dividerEl.className='divider';
      dividerEl.textContent=DIVIDER_NOTE;
    }
    if(last.nextSibling !== dividerEl) log.insertBefore(dividerEl, last.nextSibling);
  }

  /**
   * That a transcript painted out of the local cache is not the whole story yet.
   *
   * Entering a topic with the cache warm is instantaneous — and then, a second or two later,
   * everything said in it while you were elsewhere appears in one frame, with nothing in between
   * having suggested more was coming. The skeleton cannot answer that: it only ever goes into an
   * EMPTY log, and this log is full. So the wait is marked where the missing messages are going
   * to land, at the bottom, and it says what it is waiting FOR rather than impersonating one of
   * them — most syncs add nothing and the line just goes away again.
   */
  var SYNC_NOTE = 'Checking for anything said while you were away';
  var syncingEl=null;

  function showSyncing(){
    // Not over an empty log: the skeleton is already standing in for the whole transcript there,
    // and two answers to one wait is one too many.
    if(syncingEl || synced || skeleton || !log.firstChild) return;
    syncingEl=document.createElement('div');
    syncingEl.className='syncing';
    syncingEl.innerHTML='<span class="dots"><i></i><i></i><i></i></span><span>'+SYNC_NOTE+'</span>';
    log.appendChild(syncingEl);
  }

  function clearSyncing(){
    if(syncingEl && syncingEl.parentNode) syncingEl.parentNode.removeChild(syncingEl);
    syncingEl=null;
  }

  /**
   * Re-draw whatever the cache handed us once a sync has said which generation is live.
   *
   * Before the first sync a cached message is painted as an ordinary message, because there is
   * nothing yet to say it is not one. The sync answers that: if the daemon has been restarted
   * since, every one of them is history, which changes how it is drawn (no buttons) and puts a
   * line under the lot. paint writes nothing for the messages whose markup did not change, so on
   * the ordinary path — same daemon, cache matching the ring — this costs one loop and no DOM.
   */
  function repaintHistory(){
    for(var k in els){ if(isHistory(data[k])) paint(k); }
    placeDivider();
  }

  // Guards a cache read that comes back after the reader has moved on, and keeps one topic from
  // being read twice (the page asks on the way in, and again when a sync names a topic it was
  // never told about).
  var restoreToken = 0, restoreFor = null;

  function restore(tId){
    if(!tId || restoreFor === tId) return;
    restoreFor = tId;
    var mine = ++restoreToken;
    cacheRead(tId).then(function(list){
      if(list && mine === restoreToken && tId === topic) adopt(list);
    });
  }

  /**
   * Put cached messages on screen around whatever is already there.
   *
   * Both orders happen and both are normal. Usually the cache wins the race against the first
   * sync, and is then simply the transcript, painted early — its keys are the ones the sync is
   * about to produce, so the sync reuses the nodes and writes nothing. When the sync gets there
   * first the only cached messages still worth showing are the ones the daemon does NOT have,
   * and those belong above what it sent.
   */
  function adopt(list){
    clearSkeleton();
    var stick = entering || atBottom();
    // Captured once: every history node goes in front of the same first live message, which is
    // what keeps them in the order they were said rather than reversing them.
    var anchor = synced ? log.firstChild : null;
    for(var i=0;i<list.length;i++){
      var m=list[i];
      if(!m || !m.id) continue;
      // A cached local message is a message that failed to send; nothing else is written. The
      // body it would be retried with is not on this side of a reload, so it offers Copy alone.
      if(m._local) m._state = 'failed';
      var key = keyOf(m);
      if(data[key] || els[key]) continue;
      if(synced && !m._local && !isHistory(m)) continue;
      data[key]=m;
      paint(key, (synced && !m._local) ? anchor : null);
    }
    placeDivider();
    syncEmptyNote();
    // Last, so it is last in the log: what the sync may still add goes under what the cache had.
    showSyncing();
    if(stick) toBottom();
  }

  function paintTopics(){
    var h='';
    var cur=null;
    for(var i=0;i<topics.length;i++){
      var t=topics[i];
      var isCur=(t.id===topic);
      if(isCur) cur=t;
      var isRunning=Boolean(t.running);
      // A question on screen holds its turn open, so t.running is true at the same time. Asked
      // first everywhere below: "waiting for you" is the state you can act on, and the one the
      // running blue would otherwise hide.
      var isAsking=Boolean(t.asking);
      var isLive=Boolean(t.live);
      var count=t.msgCount||0;
      if(isCur){
        readCounts[t.id]=count;
        saveReads();
      }
      if(readCounts[t.id]===undefined){
        readCounts[t.id]=count;
        saveReads();
      }
      var unread=isCur?0:Math.max(0, count - readCounts[t.id]);
      var cls='topic-item '+(isCur?'on ':'')+(isRunning?'running':'idle')+(isLive?' live':'');
      var dotCls='topic-dot'+(isAsking?' asking':(isRunning?' running':(isLive?' live':'')));
      var badge=unread>0?'<span class="topic-badge">'+(unread>99?'99+':unread)+'</span>':'';
      // Not "a shell is alive over there" — the daemon only sees the connection, so this says a
      // page has that topic's terminal open (shown or minimized). See terminal-sessions.ts.
      var term=t.term?'<span class="topic-term" title="A terminal is attached to this topic">&gt;_</span>':'';
      // The full path on the title attribute rather than in the row: two checkouts of one
      // project have the same last segment, and the column is 240px wide.
      var dir=t.dir?'<span class="topic-dir" title="'+text(t.dir.path)+'">'+text(t.dir.name)+'</span>':'';
      h += '<div class="'+cls+'" data-topic="'+text(t.id)+'" role="button" tabindex="0">'
         + '<span class="'+dotCls+'"></span>'
         + '<span class="topic-main">'
         + '<span class="topic-title">'+text(t.title || 'Untitled')+'</span>'
         + dir
         + '</span>'
         + term
         + badge
         + '<button type="button" class="btn-icon topic-del" data-del="'+text(t.id)+'" title="Delete topic">×</button>'
         + '</div>';
    }
    bar.innerHTML=h;
    if(cur){
      chatTitle.textContent=cur.title || 'Untitled';
      // Same order as the dot, and the same reason: during an ask the turn is still open, so
      // "running" is true and is the less useful of the two things to say.
      var state=cur.asking?'awaiting you':(cur.running?'running':'');
      chatStatus.textContent=state;
      chatStatus.className='chat-status'+(cur.asking?' asking':(cur.running?' running':''));
    } else {
      chatTitle.textContent='';
      chatStatus.textContent='';
    }
    // The window's title bar names the same topic this row does, so a rename lands on both in
    // the same frame rather than leaving the bar holding the old name until the next switch.
    if(TERM_OK) paintFrames();
  }

  // ── Terminal ───────────────────────────────────────────────────────────────
  // A window over the transcript, one per topic. The iframe holds ttyd's own terminal, which is
  // why this is a hundred lines instead of a terminal emulator. Nothing here speaks to the agent
  // — the two share a topic id and nothing else.

  // What the address bar should say now. The topic and the pane are both worth surviving a
  // reload, and both are written the same way so neither can silently drop the other.
  function urlNow(){
    return '?t='+encodeURIComponent(topic) + (termState[topic]==='open' ? '&v=term' : '');
  }

  // Mounted on first use, so a page that never opens a terminal never connects to ttyd, and
  // dropped only when the window is CLOSED — never when it is minimized and never when the
  // topic changes. What survives a drop is the session itself, on the far side, which is the
  // operator's arrangement (ttyd hangs up its child; their wrapper holds the session open) and
  // the reason closing needs a server round trip while minimizing does not.
  function applyTerm(){
    if(!TERM_OK) return;
    if(termBoot && topic){
      termBoot = false;
      if(!termState[topic]) termState[topic]='open';
    }
    var state = topic ? termState[topic] : undefined;
    var on = state === 'open';
    chat.classList.toggle('term', on);
    termBtn.classList.toggle('on', Boolean(state));
    termBtn.title = on ? 'Minimize the terminal' : (state ? 'Show the terminal (still running)' : 'Terminal');
    // Only ever rendered where a session can actually be ended; see TERM_END.
    termEndBtn.hidden = !TERM_END;
    if(state && topic) mountTerm(topic);
    paintFrames();
  }

  function mountTerm(id){
    if(termFrames[id]) return;
    var frame = document.createElement('iframe');
    frame.setAttribute('title','Terminal');
    // Relative, for the same reason every fetch here is: a reverse proxy may mount the daemon
    // under a sub-path, and an absolute "/" walks out of it.
    frame.setAttribute('src','term/?arg='+encodeURIComponent(id));
    termFrames[id] = frame;
    termHost.appendChild(frame);
  }

  /** Exactly one mounted terminal is visible: the current topic's, and only while it is open. */
  function paintFrames(){
    var on = topic && termState[topic]==='open';
    for(var id in termFrames){
      if(!Object.prototype.hasOwnProperty.call(termFrames, id)) continue;
      termFrames[id].classList.toggle('on', Boolean(on) && id===topic);
    }
    var cur = null;
    for(var i=0;i<topics.length;i++){ if(topics[i].id===topic){ cur=topics[i]; break; } }
    termName.textContent = cur && cur.title ? cur.title : 'Untitled';
  }

  /** Unmount one topic's terminal. Ends a connection, never a session — see endTerm. */
  function dropTerm(id){
    var frame = termFrames[id];
    if(frame){
      if(frame.parentNode) frame.parentNode.removeChild(frame);
      delete termFrames[id];
    }
    delete termState[id];
  }

  function showTerm(){
    if(!TERM_OK || !topic) return;
    termState[topic] = 'open';
    history.replaceState(null,'',urlNow());
    applyTerm();
  }

  // Hidden, not unmounted: the point of minimizing is that whatever is running in there keeps
  // running AND stays connected, so coming back is a repaint rather than a reconnect and a
  // redraw.
  function minTerm(){
    if(!TERM_OK || !topic || !termState[topic]) return;
    termState[topic] = 'min';
    history.replaceState(null,'',urlNow());
    applyTerm();
  }

  /**
   * End the session, which is a different act from closing the window and is why it asks first.
   *
   * Dropping the iframe would only hang up on a shell that carries on without us. What actually
   * ends it is a command the operator configured, so this is a request; the window is taken down
   * only once the server says it worked, because a window closed over a session that is still
   * alive is the one outcome nobody could explain from the screen.
   */
  function endTerm(){
    if(!TERM_OK || !TERM_END || !topic || !termState[topic]) return;
    var cur = null;
    for(var i=0;i<topics.length;i++){ if(topics[i].id===topic){ cur=topics[i]; break; } }
    var title = (cur && cur.title) ? cur.title : 'Untitled';
    if(!confirm('End the terminal session in "'+title+'"?\\n\\nAnything still running in it is killed. Minimize instead to leave it running.')) return;
    var id = topic;
    // Not retried, unlike a send. A 500 here means the operator's command ran and failed, and
    // running it again 700ms later answers the same way while spawning a second process; the
    // retry in post() is for a link that dropped a request, which is not this.
    post('api/terminal/end',{topic:id},0).then(function(r){
      return r.ok ? {ok:true} : r.json().then(function(d){ return {ok:false, error:(d&&d.error)||'could not end the terminal session'}; }, function(){ return {ok:false, error:'could not end the terminal session'}; });
    }).then(function(d){
      if(!d.ok){ alert(d.error); return; }
      dropTerm(id);
      if(id===topic){ history.replaceState(null,'',urlNow()); applyTerm(); }
    }, function(){
      alert('could not reach the daemon to end the terminal session');
    });
  }

  function switchTopic(id){
    if(!id || id===topic) return;
    // The topic being left, written now rather than at the end of its window — in a moment
    // nothing on screen belongs to it any more and there is nothing left to write.
    cacheFlush();
    topic = id;
    history.replaceState(null,'',urlNow());
    // Before the transcript work below, so the terminal follows the topic in the same frame
    // the title does rather than a repaint later.
    applyTerm();
    for(var i=0;i<topics.length;i++){
      if(topics[i].id===id){
        readCounts[id]=topics[i].msgCount || 0;
        saveReads();
        break;
      }
    }
    paintTopics();
    log.innerHTML='';
    data={};
    els={};
    sig={};
    skeleton=false;
    // All of these belong to the topic being left: the notice and divider elements are gone with
    // #log's children, whether the NEXT topic predates the daemon is the incoming sync's answer
    // to give, and its transcript has not been read back yet. epoch is NOT reset — it is a
    // property of the daemon on the other end, not of the room being entered.
    stale=false;
    emptyEl=null;
    dividerEl=null;
    syncingEl=null;
    entering=true;
    synced=false;
    // The shape of a transcript while both the cache read and the stream are outstanding. The
    // cache normally answers first and replaces it; nothing about that is guaranteed, which is
    // why the placeholders go in regardless.
    showSkeleton();
    restore(id);
    connect();
  }

  function deleteTopic(delId){
    var target = null;
    for(var i=0;i<topics.length;i++){
      if(topics[i].id===delId){ target=topics[i]; break; }
    }
    var title = (target && target.title) ? target.title : 'Untitled';
    if(!confirm('Delete topic "' + title + '"?')) return;
    post('api/topics/delete',{topic:delId},1).then(function(r){
      return r.ok ? r.json() : null;
    }).then(function(d){
      if(!d) return;
      cacheDrop(delId);
      // The row is gone, so its terminal window has nothing left to belong to. Only the window
      // — the session on the far side outlives this exactly as it outlives a closed tab, which
      // is why deleting a topic is not offered as a way to end one.
      dropTerm(delId);
      delete readCounts[delId];
      saveReads();
      if(topic === delId){
        var remaining = topics.filter(function(t){ return t.id !== delId; });
        if(remaining.length > 0){
          switchTopic(remaining[0].id);
        } else {
          createTopic();
        }
      }
    });
  }

  function handle(ev){
    if(ev.t==='sync'){
      // Only a sync for a topic we have since left is stale enough to drop. A first visit has
      // no topic at all — nothing put ?t= in the URL yet — and the server answers by picking
      // one for us, so testing ev.topic against an empty string threw away the only sync that
      // visit was ever going to get and left the page an empty shell.
      if(topic && ev.topic !== topic) return;
      topic = ev.topic;
      history.replaceState(null,'',urlNow());
      // The other half of "asked for is not shown": a reload straight into terminal mode, or a
      // first visit with no ?t= at all, only learns which topic to point at here.
      applyTerm();
      // Where the reader was, decided BEFORE the transcript moves under them. Opening a topic goes
      // to the bottom; a resync after a dropped connection must not yank someone out of the
      // history they were reading, which is only a choice at all now that the reconcile leaves
      // their scroll position intact.
      var stick = entering || atBottom();
      entering = false;
      // Which run of the daemon everything in this sync belongs to. Anything already on screen
      // from another one is cached history from here on, whatever it was painted as.
      epoch = ev.epoch || 0;
      synced = true;
      // What the server says about this room BEFORE the transcript is reconciled, so the drops
      // that reconcile performs already know whether an emptied log needs explaining.
      stale = Boolean(ev.stale);
      repaintHistory();
      reconcile(ev.messages);
      placeDivider();
      syncEmptyNote();
      cacheSave();
      // A visit that named no topic is only told which room it is in here, so this is also where
      // that room's cached transcript is asked for. Reading one twice is a no-op.
      restore(topic);
      readCounts[topic] = ev.messages.length;
      saveReads();
      commands = ev.commands || [];
      topics = ev.topics || [];
      paintTopics();
      note.textContent=''; if(stick) toBottom();
    }
    else if(ev.t==='msg'){
      // Before the upsert: if this is the echo of something typed here, it takes over the node
      // that local message is already occupying rather than appearing underneath it.
      claim(ev.msg);
      upsert(ev.msg);
      cacheSave();
      readCounts[topic] = (readCounts[topic] || 0) + 1;
      saveReads();
      for(var i=0;i<topics.length;i++){
        if(topics[i].id===topic){
          topics[i].msgCount = (topics[i].msgCount || 0) + 1;
          break;
        }
      }
      paintTopics();
    }
    else if(ev.t==='del'){
      drop(epoch+':'+ev.id);
      cacheSave();
    }
    else if(ev.t==='react'){
      var rk = epoch+':'+ev.id;
      var m=data[rk]; if(!m) return;
      var kept=(m.reactions||[]).filter(function(e){ return e!==ev.emoji; });
      m.reactions = ev.on ? kept.concat([ev.emoji]) : kept;
      paint(rk);
      cacheSave();
    }
    else if(ev.t==='typing'){
      typing.hidden = !ev.on;
      for(var i=0;i<topics.length;i++){
        if(topics[i].id===topic){
          topics[i].running = ev.on;
          break;
        }
      }
      paintTopics();
    }
    else if(ev.t==='commands'){ commands = ev.commands || []; }
    else if(ev.t==='topics'){
      topics = ev.topics || [];
      paintTopics();
      if(topic && !topics.some(function(t){ return t.id===topic; })){
        if(topics.length > 0){
          switchTopic(topics[0].id);
        } else {
          createTopic();
        }
      }
    }
    else if(ev.t==='bye'){ done=true; if(stream) stream.close(); note.textContent='Disconnected. Reload when it is back.'; }
  }

  function connect(){
    if(stream) stream.close();
    // Placeholders for the wait that is about to start. Guarded on an empty log inside, so a
    // reconnect after a blip — where the conversation is still on screen and only the stream went
    // away — is not answered by replacing it with skeletons.
    showSkeleton();
    // EventSource resends the last id it saw on its own, so a blip is answered with the few
    // events that were missed rather than the whole conversation.
    stream = new EventSource('api/events' + (topic ? '?t='+encodeURIComponent(topic) : ''));
    stream.onmessage = function(e){ try{ handle(JSON.parse(e.data)); }catch(x){} };
    // Not focused on a phone: the keyboard would come up before a word has been read, and on
    // a portrait screen that is half the viewport gone to reach a field nobody asked for yet.
    stream.onopen = function(){ gate.hidden=true; app.hidden=false; note.textContent=''; if(!narrow()) input.focus(); };
    stream.onerror = function(){
      if(done) return;
      if(stream.readyState === 2){
        // Closed for good rather than retrying: the server refused it, which here means the
        // session is gone. Anything else leaves EventSource to reconnect on its own.
        app.hidden=true; gate.hidden=false;
      } else {
        note.textContent='Reconnecting...';
      }
    };
  }

  bar.addEventListener('click', function(e){
    var del = e.target.closest ? e.target.closest('[data-del]') : null;
    if(del){
      e.stopPropagation();
      var delId = del.getAttribute('data-del');
      if(delId) deleteTopic(delId);
      return;
    }
    var b = e.target.closest ? e.target.closest('[data-topic]') : null;
    if(!b) return;
    var id = b.getAttribute('data-topic');
    if(!id || id===topic) return;
    switchTopic(id);
    if(narrow()) setSidebar(false);
  });

  bar.addEventListener('keydown', function(e){
    if(e.key==='Enter' || e.key===' '){
      if(e.target.closest && e.target.closest('[data-del]')) return;
      var b = e.target.closest ? e.target.closest('[data-topic]') : null;
      if(!b) return;
      e.preventDefault();
      var id = b.getAttribute('data-topic');
      if(!id || id===topic) return;
      switchTopic(id);
    }
  });

  function createTopic(){
    post('api/topics',{},1).then(function(r){ return r.ok ? r.json() : null; }).then(function(d){
      if(!d || !d.topic) return;
      switchTopic(d.topic.id);
      if(narrow()) setSidebar(false);
    });
  }

  newTopicBtn.addEventListener('click', createTopic);

  // Revealed only where there is something behind it. When the daemon serves no terminal the
  // button stays hidden and these listeners never have anything to toggle.
  if(TERM_OK){
    termBtn.hidden = false;
    // One button, three states: no window opens one, a shown window is minimized, a minimized
    // one comes back. Minimizing from here as well as from the title bar because the header
    // button is where the hand already is on a phone, and because it is what this button did
    // before there was a window to minimize.
    termBtn.addEventListener('click', function(){
      if(termState[topic]==='open') minTerm(); else showTerm();
    });
    termMinBtn.addEventListener('click', minTerm);
    termEndBtn.addEventListener('click', endTerm);
  }

  clearBtn.addEventListener('click', function(){
    if(!confirm('Delete all ' + topics.length + ' topics? This cannot be undone.')) return;
    post('api/topics/clear',{},1).then(function(r){ return r.ok ? r.json() : null; }).then(function(d){
      if(!d || !d.topic) return;
      // Every local record of the old rooms goes with them. Leaving the caches would put
      // messages on screen for ids the daemon has forgotten, and leaving the read marks would
      // badge the replacement topic against a count from a room that no longer exists.
      cacheClear();
      readCounts={};
      saveReads();
      // Same as deleting one, for every row at once: the windows belonged to topics that no
      // longer exist, so they are unmounted here rather than left pointing at ids the daemon
      // has forgotten.
      for(var id in termFrames){
        if(Object.prototype.hasOwnProperty.call(termFrames, id)) dropTerm(id);
      }
      // The list is replaced with what the server just told us rather than left to the broadcast
      // that is also on its way: paintTopics re-seeds a read mark for every topic it renders, so
      // painting the OLD list once more would write the ids we are here to forget straight back
      // into storage.
      topics=[d.topic];
      // Cleared rather than handed straight to switchTopic, which answers an unchanged id by
      // doing nothing: the replacement id is four random bytes and may repeat the one being
      // read, and that one-in-4-billion case would leave a wiped transcript on screen.
      topic='';
      switchTopic(d.topic.id);
      if(narrow()) setSidebar(false);
    });
  });

  $('gate').addEventListener('submit', function(e){
    e.preventDefault();
    // No password to send: this gate's only control is a reload, which is what sends the
    // browser back through the identity provider.
    if(!PASSWORD_LOGIN){ location.reload(); return; }
    err.textContent='';
    post('api/login',{token:$('secret').value},0).then(function(r){
      if(r.ok){ $('secret').value=''; connect(); return; }
      err.textContent = r.status===429 ? 'Too many attempts. Wait a minute.' : 'That is not the right token.';
    }).catch(function(){ err.textContent='Could not reach the server.'; });
  });

  log.addEventListener('click', function(e){
    // A picture, filling the screen. Not a new tab: installed as an app this page has no tab
    // bar to come back from, and leaving the app to look at a screenshot is the same friction
    // as downloading it. Checked first — a picture carries none of the attributes below.
    var shot = e.target.closest ? e.target.closest('img.shot') : null;
    if(shot) return openShot(shot);
    // What a message that failed to send offers. Checked before the ordinary buttons: these are
    // answered here, locally, and never posted as a click on a message the daemon has no idea
    // about.
    var act = e.target.closest ? e.target.closest('[data-retry],[data-copy],[data-discard]') : null;
    if(act){
      var retry = act.getAttribute('data-retry');
      if(retry) return deliver(retry);
      var copy = act.getAttribute('data-copy');
      if(copy) return copyLocal(copy, act);
      var discard = act.getAttribute('data-discard');
      if(discard) return discardLocal(discard);
      return;
    }
    var b = e.target.closest ? e.target.closest('button[data-btn]') : null;
    if(!b) return;
    b.disabled = true;
    post('api/click',{topic:topic,messageId:b.getAttribute('data-msg'),buttonId:b.getAttribute('data-btn')},2)
      .catch(function(){ b.disabled=false; });
  });

  /**
   * A file the download table has since evicted, or one deleted off disk, answers 404 — and an
   * <img> says so with a broken frame that reads like a bug in the page. Hide it and the link
   * underneath is left, which is what a non-image shows anyway.
   *
   * Capture phase, because 'error' on an <img> does not bubble and so never reaches #log on its
   * own. The hiding survives a repaint for free: identical markup is not rewritten, and markup
   * that IS rewritten builds an image that 404s again.
   */
  log.addEventListener('error', function(e){
    var t = e.target;
    if(t && t.classList && t.classList.contains('shot')) t.style.display='none';
  }, true);

  function openShot(img){
    lightboxImg.src = img.src;
    lightboxImg.alt = img.alt;
    lightbox.hidden = false;
  }
  function closeShot(){
    if(lightbox.hidden) return;
    lightbox.hidden = true;
    // Dropped rather than left behind: a full-resolution screenshot held decoded by an overlay
    // nobody is looking at is the kind of thing a daemon running for weeks pays for.
    lightboxImg.removeAttribute('src');
  }
  lightbox.addEventListener('click', closeShot);
  document.addEventListener('keydown', function(e){ if(e.key === 'Escape') closeShot(); });

  // Grow to fit, and let the max-height in the stylesheet decide where to stop — it is stated
  // in dvh there, which on a phone with the keyboard up is the viewport that is actually left.
  // Clamping here as well would mean two numbers for one cap, and the JS one cannot see which
  // media query won.
  function grow(){ input.style.height='auto'; input.style.height=input.scrollHeight+'px'; }

  function renderChips(){
    var h='';
    for(var i=0;i<files.length;i++) h += '<span class="chip">'+text(files[i].name)+'</span>';
    chips.innerHTML=h;
  }

  // The rename argument exists for the clipboard, which is the one source that hands over files
  // the browser has already named badly — see the paste handler below. Everything else passes
  // the name through, and this stays the single place a file becomes a chip.
  function take(list, rename){
    for(var i=0;i<list.length;i++){
      (function(f){
        var r=new FileReader();
        r.onload=function(){
          var s=String(r.result), c=s.indexOf(',');
          files.push({name:(rename ? rename(f) : f.name) || 'file', mime:f.type||'', data:c<0?'':s.slice(c+1)});
          renderChips();
        };
        r.readAsDataURL(f);
      })(list[i]);
    }
  }

  // Every engine calls a pasted screenshot 'image.png', so two of them in one message would
  // arrive as two attachments neither the chips nor the agent can tell apart. A counter is
  // enough: the name only has to be distinct within the message being composed.
  var pastes = 0;
  function pastedName(f){
    var type = f.type || 'image/png';
    var slash = type.indexOf('/');
    var ext = slash > 0 ? type.slice(slash+1).split(';')[0].split('+')[0] : 'png';
    pastes++;
    return 'pasted-' + pastes + '.' + ext;
  }

  picker.addEventListener('change', function(){ take(picker.files); picker.value=''; });
  $('attach').addEventListener('click', function(){ picker.click(); });
  document.addEventListener('dragover', function(e){ e.preventDefault(); });
  document.addEventListener('drop', function(e){
    e.preventDefault();
    if(e.dataTransfer && e.dataTransfer.files) take(e.dataTransfer.files);
  });
  // Ctrl-V of a screenshot, which is the thing most worth showing an agent and the slowest to
  // get to it any other way. On the document rather than the textarea: the composer is not
  // necessarily focused after clicking a topic or a button, and a paste that reaches nothing is
  // indistinguishable from a broken feature. The login field is the only other paste target on
  // the page and a file is not a token, so nothing is taken away from it.
  //
  // preventDefault only once a file has actually been picked up. A clipboard carrying an image
  // usually carries an img tag in text/html beside it — swallowing that is the point — but a
  // plain text paste must still land in the textarea the ordinary way.
  document.addEventListener('paste', function(e){
    var items = e.clipboardData && e.clipboardData.items;
    if(!items) return;
    var found = [];
    for(var i=0;i<items.length;i++){
      if(items[i].kind !== 'file') continue;
      var f = items[i].getAsFile();
      if(f) found.push(f);
    }
    if(!found.length) return;
    e.preventDefault();
    take(found, pastedName);
  });

  function suggest(){
    var v=input.value;
    if(v.charAt(0)!=='/' || v.indexOf(' ')>=0 || v.indexOf('\\n')>=0){ hints.hidden=true; hints.innerHTML=''; return; }
    var q=v.slice(1).toLowerCase();
    var hit=commands.filter(function(c){ return c.name.indexOf(q)===0; }).slice(0,8);
    if(!hit.length){ hints.hidden=true; hints.innerHTML=''; return; }
    var h='';
    for(var i=0;i<hit.length;i++) h += '<button type="button" data-cmd="'+text(hit[i].name)+'" title="'+text(hit[i].description)+'">/'+text(hit[i].name)+'</button>';
    hints.innerHTML=h; hints.hidden=false;
  }

  hints.addEventListener('click', function(e){
    var b = e.target.closest ? e.target.closest('button[data-cmd]') : null;
    if(!b) return;
    input.value='/'+b.getAttribute('data-cmd')+' ';
    suggest(); input.focus(); grow();
  });

  /**
   * Sends that have not been acknowledged, by nonce.
   *
   * In memory only, and that is the whole reason Retry disappears across a reload: the body in
   * here carries the attachments as base64, which is not something to write into a cache meant
   * to hold a transcript. Re-sending the text without the files it was written about would be a
   * different message, so a restored failure offers Copy instead of pretending otherwise.
   */
  var outbox = {};

  /** The same shape renderBody builds server-side, so the echo can replace it invisibly. */
  function localBody(typed, names){
    var h = '<div class="raw">'+text(typed)+'</div>';
    if(!names.length) return h;
    var chips='';
    for(var i=0;i<names.length;i++) chips += '<span class="chip">'+text(names[i])+'</span>';
    return h + '<div class="files">'+chips+'</div>';
  }

  /**
   * Show the message, then send it — in that order, and independently.
   *
   * Waiting for the daemon's echo to draw it meant a visibly empty transcript for as long as the
   * round trip took, and on a request that failed after its retries it meant the text was gone:
   * out of the composer, never into the conversation, nowhere to copy it back from. The local
   * bubble is the message until the echo claims it, and if nothing ever claims it, it stays and
   * says so.
   */
  function send(){
    var typed = input.value;
    if(!typed.trim() && !files.length) return;
    var nonce = Math.random().toString(36).slice(2)+Date.now().toString(36);
    var body = {topic:topic, text:typed, nonce:nonce};
    var names = [];
    for(var i=0;i<files.length;i++) names.push(files[i].name);
    if(files.length) body.files = files;
    input.value=''; files=[]; renderChips(); suggest(); grow();
    outbox[nonce] = body;
    data['p:'+nonce] = { id:'p:'+nonce, _local:1, _nonce:nonce, _state:'sending', _text:typed,
      own:true, html:localBody(typed, names), at:Date.now(), buttons:[], reactions:[] };
    paint('p:'+nonce);
    syncEmptyNote();
    // Unconditionally, unlike an arriving message: you have just written this one, so wherever
    // you were in the history is not where you want to be now.
    toBottom();
    deliver(nonce);
  }

  /**
   * Post one queued message, for the first time or on a Retry.
   *
   * The same nonce goes out every time on purpose: the server remembers the last 64 and answers
   * a repeat as if it were the original, so a Retry after a request that actually landed cannot
   * duplicate the message — and the echo of the first attempt retires this bubble either way.
   */
  function deliver(nonce){
    var body = outbox[nonce];
    if(!body) return;
    setLocal(nonce, 'sending');
    post('api/send', body, 2).then(function(r){
      setLocal(nonce, (r && r.ok) ? 'sent' : 'failed');
    }, function(){
      setLocal(nonce, 'failed');
    });
  }

  function setLocal(nonce, state){
    var key='p:'+nonce, m=data[key];
    if(!m) return;
    // Measured before the repaint: a failure grows the bubble by a warning line and three
    // buttons, and a reader sitting at the bottom would otherwise have the new controls pushed
    // off the screen they were just looking at.
    var stick = atBottom();
    m._state = state;
    paint(key);
    if(stick) toBottom();
    // Only a failure is worth writing down. One still in flight is a question this tab alone can
    // answer, and one that got through comes back as the daemon's own echo.
    if(state === 'failed') cacheSave();
  }

  /**
   * Put the text of a failed message on the clipboard.
   *
   * With a fallback, because navigator.clipboard does not exist on an insecure origin and
   * plain http is exactly how this page is expected to be reached on a LAN. The button says
   * which way it went rather than reporting success it did not have.
   */
  function copyLocal(nonce, btn){
    var m=data['p:'+nonce]; if(!m) return;
    var said=function(ok){ btn.textContent = ok ? 'Copied' : 'Select it above'; };
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(m._text).then(function(){ said(true); }, function(){ said(fallbackCopy(m._text)); });
      return;
    }
    said(fallbackCopy(m._text));
  }

  function fallbackCopy(s){
    try {
      var ta=document.createElement('textarea');
      ta.value=s;
      ta.setAttribute('readonly','');
      ta.style.position='fixed';
      ta.style.top='-1000px';
      document.body.appendChild(ta);
      ta.select();
      var ok=document.execCommand('copy');
      document.body.removeChild(ta);
      return Boolean(ok);
    } catch(x){ return false; }
  }

  function discardLocal(nonce){
    delete outbox[nonce];
    drop('p:'+nonce);
    cacheSave();
  }

  input.addEventListener('input', function(){ grow(); suggest(); });
  /**
   * Enter sends and Shift-Enter writes a newline — except under the narrow-screen layout, where
   * the two are the other way round.
   *
   * 1.22.0 made Enter a newline on every width, and the half of that which was right is the
   * phone: held upright there is no Shift key to hold down, so Enter-to-send makes a multi-line
   * prompt impossible to type rather than merely awkward, and a stray Enter costs a half-written
   * one. Neither is true of a keyboard, where Shift-Enter is right there and every other chat
   * app on that screen sends on Enter — paying the cost of the phone's problem on a desktop buys
   * nothing. Ctrl/Cmd-Enter sends on both, so what 1.22.0 taught still works.
   *
   * narrow() is read per keypress rather than once: rotating a phone and dragging a window both
   * change the answer, and it is the same breakpoint the CSS uses to decide the layout — where
   * the phone layout applies, the phone's Enter applies.
   */
  input.addEventListener('keydown', function(e){
    // isComposing is an IME candidate being chosen, on either shortcut. It is a keystroke the
    // composer never sees the end of, and sending on it truncates the word being typed.
    if(e.key!=='Enter' || e.isComposing) return;
    if(e.ctrlKey || e.metaKey){ e.preventDefault(); send(); return; }
    if(e.shiftKey || e.altKey || narrow()) return;
    e.preventDefault(); send();
  });
  $('composer').addEventListener('submit', function(e){ e.preventDefault(); send(); });

  /**
   * Retire the local bubble this message is the echo of.
   *
   * The node is REUSED rather than replaced: creating another element with the same content
   * would re-run the fade-in and move the scroll under whoever is reading, for a message that
   * has been on screen since it was typed.
   */
  function claim(m){
    if(!m.nonce) return;
    var pk = 'p:' + m.nonce;
    delete outbox[m.nonce];
    if(!els[pk]) return;
    var key = epoch + ':' + m.id;
    if(els[key]){ els[pk].remove(); }
    else {
      els[key]=els[pk];
      sig[key]=sig[pk];
      els[key].setAttribute('data-k', key);
    }
    delete els[pk];
    delete sig[pk];
    delete data[pk];
  }

  // The transcript this browser already has, asked for before anything has been heard from the
  // daemon — which is the point: on a slow link the conversation is on screen long before the
  // stream has said anything, and after a restart it is on screen even though the daemon can no
  // longer produce it. A visit with no ?t= has no topic to ask about yet and is restored from
  // the sync instead.
  restore(topic);

  // Reopens the pane a reload arrived in, when ?t= already named a topic. Without one this
  // does nothing and the sync handler picks it up instead.
  applyTerm();

  connect();
})();
`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>__TITLE__</title>
<!-- Installable as an app. Every href is relative for the same reason the fetches are: a
     reverse proxy may mount the daemon under a sub-path, and an absolute "/" walks out of it.
     No viewport-fit=cover, deliberately — it would extend the page under the status bar and
     the gesture bar, which is work the browser is already doing correctly, and the composer's
     env(safe-area-inset-bottom) padding is there for the browsers that inset nothing. -->
<link rel="manifest" href="manifest.webmanifest">
<!-- Android paints the status bar this colour in standalone, so the app starts at its own
     background instead of being framed in white. -->
<meta name="theme-color" content="#131313">
<!-- iOS ignores the manifest for both of these. "black" is the closest opaque bar to #131313;
     "black-translucent" would put the clock on top of the chat header. -->
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<link rel="apple-touch-icon" href="icon.png">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="icon" href="icon.png" sizes="192x192" type="image/png">
<style>${STYLE}</style>
</head>
<body>
__GATE__
<main id="app" hidden>
  <aside id="sidebar">
    <div id="sidebar-header">
      <span class="sidebar-title">Topics</span>
      <button type="button" class="btn-icon add" id="new-topic" data-new="1" title="New topic">+</button>
      <button type="button" class="btn-icon" id="collapse-sidebar" title="Collapse sidebar">◀</button>
    </div>
    <div id="topics"></div>
    <div id="sidebar-footer">
      <button type="button" id="clear-topics" title="Forget every topic and start a new one">Clear all topics</button>
    </div>
  </aside>
  <div id="backdrop" hidden></div>
  <!-- Filled in and revealed when a picture in the log is tapped. One node reused for every
       image, rather than one per message: the transcript holds hundreds. -->
  <div id="lightbox" hidden><img id="lightbox-img" alt=""></div>
  <section id="chat">
    <div id="chat-header">
      <button type="button" class="btn-icon" id="expand-sidebar" title="Show topics" hidden>☰</button>
      <span id="topic-title" class="chat-title"></span>
      <span id="topic-status" class="chat-status"></span>
      <!-- Present in the markup but hidden unless the daemon serves a terminal, so the script
           has one thing to reveal rather than one thing to build. -->
      <button type="button" class="btn-icon" id="term-toggle" title="Terminal" hidden>&gt;_</button>
    </div>
    <div id="log"></div>
    <div id="typing" hidden>...</div>
    <div id="note"></div>
    <!-- A window, not a mode: the bar is what makes minimize and close two different things.
         The dash hides it and leaves the session connected; the cross ends the session, and is
         rendered only where the daemon was given a way to do that. -->
    <div id="term">
      <div id="term-bar">
        <span id="term-name" class="term-name"></span>
        <button type="button" class="btn-icon" id="term-min" title="Minimize — the terminal keeps running">&#8211;</button>
        <button type="button" class="btn-icon" id="term-end" title="End this terminal session" hidden>&times;</button>
      </div>
      <div id="term-frames"></div>
    </div>
    <div id="bar">
      <div id="hints" hidden></div>
      <div id="chips"></div>
      <form id="composer">
        <div id="row">
          <textarea id="input" rows="1" placeholder="Message" autocomplete="off"></textarea>
          <input id="picker" type="file" multiple hidden>
          <button type="button" id="attach" title="Attach a file">+</button>
          <!-- A tooltip is a pointer's affordance, so it names the pointer's shortcut: under the
               narrow-screen layout Enter writes a newline, but nothing there can hover to read
               this. Ctrl-Enter sends on both and is what that layout's users are left with. -->
          <button type="submit" title="Send (Enter)">Send</button>
        </div>
      </form>
    </div>
  </section>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
