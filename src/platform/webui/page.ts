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

/** Fill in the configured title. Kept to one line so the document stays a top-level const. */
export function renderPage(title: string): string {
  return PAGE.replace(/__TITLE__/g, escapeHtml(title));
}

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
.topic-dot{width:7px;height:7px;border-radius:50%;flex:0 0 7px;background:#444}
.topic-dot.running{background:#38bdf8;box-shadow:0 0 6px rgba(56,189,248,.8);animation:pulse 1.5s infinite}
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
.topic-badge{background:#2563eb;color:#fff;border-radius:9px;padding:1px 6px;font-size:11px;font-weight:600;line-height:1.3;margin-left:4px;flex-shrink:0}
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
/* Both of the above are decoration over content that is arriving anyway, which is exactly what
   this query is for: without motion the skeleton is still a placeholder and a message still
   appears, they just do it instantly. */
@media(prefers-reduced-motion:reduce){.m,.sk i{animation:none}}
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
.b>:first-child{margin-top:0}
.b>:last-child{margin-bottom:0}
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
  #chat-header{padding:8px 12px}
  .chat-title{max-width:none}
  #log{padding:14px 12px 6px}
  #typing,#note{padding-left:12px;padding-right:12px}
  /* env() keeps the Send row clear of the home indicator rather than under it. */
  #bar{padding:8px 12px calc(10px + env(safe-area-inset-bottom,0px))}
  /* Safari zooms the whole page in when a field it focuses is under 16px, and it does not zoom
     back out afterwards — every tap on the composer would leave the page a little larger. */
  #input,#secret{font-size:16px}
  #input{max-height:30dvh}
}
`;

const SCRIPT = `
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var log=$('log'), app=$('app'), gate=$('login'), err=$('err'), input=$('input'),
      chips=$('chips'), hints=$('hints'), typing=$('typing'), note=$('note'), picker=$('picker'),
      bar=$('topics'), sidebar=$('sidebar'), collapseBtn=$('collapse-sidebar'),
      expandBtn=$('expand-sidebar'), newTopicBtn=$('new-topic'), backdrop=$('backdrop'),
      clearBtn=$('clear-topics'), chatTitle=$('topic-title'), chatStatus=$('topic-status');
  var data={}, els={}, files=[], commands=[], stream=null, done=false;
  // Last markup written per message, so a sync that re-sends an unchanged message touches no DOM.
  var sig={};
  // Whether #log currently holds placeholders rather than messages, and whether the next sync is
  // the one that opens a topic (which lands at the bottom no matter where the old one was read).
  var skeleton=false, entering=true;
  // What the last sync said about this topic being older than the daemon, and the notice element
  // that says so. Both are per topic, so both are reset on the way into one.
  var stale=false, emptyEl=null;
  var topic = new URLSearchParams(location.search).get('t') || '';
  var topics = [];
  var readCounts = {};
  try { readCounts = JSON.parse(localStorage.getItem('aa_reads') || '{}'); } catch(x){}

  function saveReads(){
    try { localStorage.setItem('aa_reads', JSON.stringify(readCounts)); } catch(x){}
  }

  var MAX_CACHE_TOPICS = 10;
  var MAX_CACHE_MSGS = 40;
  var topicCache = {};
  var cacheOrder = [];
  try {
    var saved = JSON.parse(sessionStorage.getItem('aa_cache') || '{}');
    if(saved && typeof saved === 'object'){
      topicCache = saved.data || {};
      cacheOrder = saved.order || [];
    }
  } catch(x){}

  function saveCache(){
    try {
      sessionStorage.setItem('aa_cache', JSON.stringify({ data: topicCache, order: cacheOrder }));
    } catch(x){}
  }

  function setCachedMsgs(tId, msgs){
    if(!tId || !msgs) return;
    var slice = msgs.length > MAX_CACHE_MSGS ? msgs.slice(-MAX_CACHE_MSGS) : msgs.slice();
    topicCache[tId] = slice;
    var idx = cacheOrder.indexOf(tId);
    if(idx >= 0) cacheOrder.splice(idx, 1);
    cacheOrder.push(tId);
    while(cacheOrder.length > MAX_CACHE_TOPICS){
      var evict = cacheOrder.shift();
      delete topicCache[evict];
    }
    saveCache();
  }

  function dropCachedTopic(tId){
    delete topicCache[tId];
    var idx = cacheOrder.indexOf(tId);
    if(idx >= 0) cacheOrder.splice(idx, 1);
    saveCache();
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

  function paint(id){
    var m=data[id]; if(!m) return;
    var el=els[id];
    if(!el){ clearSkeleton(); el=document.createElement('div'); log.appendChild(el); els[id]=el; }
    var cls = 'm' + (m.own ? ' own' : '');
    var h='';
    if(m.quote && m.quote.html) h += '<div class="q">'+m.quote.html+'</div>';
    h += '<div class="b">'+m.html+'</div>';
    if(m.file) h += '<div class="files"><a href="'+text(m.file.url)+'" download>'+text(m.file.name)+'</a></div>';
    if(m.buttons && m.buttons.length){
      h += '<div class="btns">';
      for(var i=0;i<m.buttons.length;i++){
        h += '<button type="button" data-msg="'+text(m.id)+'" data-btn="'+text(m.buttons[i].id)+'">'
           + text(m.buttons[i].label) + '</button>';
      }
      h += '</div>';
    }
    var meta = clock(m.at) + (m.reactions && m.reactions.length ? '  '+m.reactions.join(' ') : '');
    h += '<div class="t">'+text(meta)+'</div>';
    // Write nothing when nothing changed. A sync re-paints every message it carries, and most of
    // them are messages already on screen unchanged — rewriting innerHTML for those would drop
    // the caret out of a selection, restart any <img> decode, and undo the enabled state of a
    // button the click handler just disabled, all for identical markup.
    if(sig[id]===h && el.className===cls) return;
    el.className = cls;
    el.innerHTML = h;
    sig[id] = h;
  }

  function upsert(m){ var stick=atBottom(); data[m.id]=m; paint(m.id); syncEmptyNote(); if(stick) toBottom(); }

  function drop(id){
    if(els[id]) { els[id].remove(); delete els[id]; }
    delete data[id];
    delete sig[id];
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
   */
  function reconcile(list){
    clearSkeleton();
    var keep={};
    for(var i=0;i<list.length;i++){
      var m=list[i];
      keep[m.id]=1;
      data[m.id]=m;
      paint(m.id);
      log.appendChild(els[m.id]);
    }
    var gone=[];
    for(var id in els){ if(!keep[id]) gone.push(id); }
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
    // Emptying #log invalidates anything held by reference into it, and this is the only other
    // thing that lives in there.
    emptyEl = null;
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

  function paintTopics(){
    var h='';
    var cur=null;
    for(var i=0;i<topics.length;i++){
      var t=topics[i];
      var isCur=(t.id===topic);
      if(isCur) cur=t;
      var isRunning=Boolean(t.running);
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
      var cls='topic-item '+(isCur?'on ':'')+(isRunning?'running':'idle');
      var dotCls='topic-dot'+(isRunning?' running':'');
      var badge=unread>0?'<span class="topic-badge">'+(unread>99?'99+':unread)+'</span>':'';
      // The full path on the title attribute rather than in the row: two checkouts of one
      // project have the same last segment, and the column is 240px wide.
      var dir=t.dir?'<span class="topic-dir" title="'+text(t.dir.path)+'">'+text(t.dir.name)+'</span>':'';
      h += '<div class="'+cls+'" data-topic="'+text(t.id)+'" role="button" tabindex="0">'
         + '<span class="'+dotCls+'"></span>'
         + '<span class="topic-main">'
         + '<span class="topic-title">'+text(t.title || 'Untitled')+'</span>'
         + dir
         + '</span>'
         + badge
         + '<button type="button" class="btn-icon topic-del" data-del="'+text(t.id)+'" title="Delete topic">×</button>'
         + '</div>';
    }
    bar.innerHTML=h;
    if(cur){
      chatTitle.textContent=cur.title || 'Untitled';
      chatStatus.textContent=cur.running ? 'running' : '';
      chatStatus.className='chat-status'+(cur.running ? ' running' : '');
    } else {
      chatTitle.textContent='';
      chatStatus.textContent='';
    }
  }

  function switchTopic(id){
    if(!id || id===topic) return;
    topic = id;
    history.replaceState(null,'','?t='+encodeURIComponent(topic));
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
    // Both belong to the topic being left: the notice element is gone with #log's children, and
    // whether the NEXT topic predates the daemon is the incoming sync's answer to give.
    stale=false;
    emptyEl=null;
    entering=true;
    var cached = topicCache[id];
    if(cached && cached.length){
      for(var j=0;j<cached.length;j++){
        data[cached[j].id] = cached[j];
        paint(cached[j].id);
      }
      toBottom();
    } else {
      showSkeleton();
    }
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
      dropCachedTopic(delId);
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
      history.replaceState(null,'','?t='+encodeURIComponent(topic));
      // Where the reader was, decided BEFORE the transcript moves under them. Opening a topic goes
      // to the bottom; a resync after a dropped connection must not yank someone out of the
      // history they were reading, which is only a choice at all now that the reconcile leaves
      // their scroll position intact.
      var stick = entering || atBottom();
      entering = false;
      // What the server says about this room BEFORE the transcript is reconciled, so the drops
      // that reconcile performs already know whether an emptied log needs explaining.
      stale = Boolean(ev.stale);
      reconcile(ev.messages);
      syncEmptyNote();
      setCachedMsgs(topic, ev.messages);
      readCounts[topic] = ev.messages.length;
      saveReads();
      commands = ev.commands || [];
      topics = ev.topics || [];
      paintTopics();
      note.textContent=''; if(stick) toBottom();
    }
    else if(ev.t==='msg'){
      upsert(ev.msg);
      if(topicCache[topic]){
        topicCache[topic].push(ev.msg);
        if(topicCache[topic].length > MAX_CACHE_MSGS) topicCache[topic].shift();
        saveCache();
      }
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
      drop(ev.id);
      if(topicCache[topic]){
        topicCache[topic] = topicCache[topic].filter(function(m){ return m.id !== ev.id; });
        saveCache();
      }
    }
    else if(ev.t==='react'){
      var m=data[ev.id]; if(!m) return;
      var kept=(m.reactions||[]).filter(function(e){ return e!==ev.emoji; });
      m.reactions = ev.on ? kept.concat([ev.emoji]) : kept;
      paint(ev.id);
      if(topicCache[topic]){
        for(var k=0;k<topicCache[topic].length;k++){
          if(topicCache[topic][k].id === ev.id){
            topicCache[topic][k].reactions = m.reactions;
            saveCache();
            break;
          }
        }
      }
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

  clearBtn.addEventListener('click', function(){
    if(!confirm('Delete all ' + topics.length + ' topics? This cannot be undone.')) return;
    post('api/topics/clear',{},1).then(function(r){ return r.ok ? r.json() : null; }).then(function(d){
      if(!d || !d.topic) return;
      // Every local record of the old rooms goes with them. Leaving the caches would put
      // messages on screen for ids the daemon has forgotten, and leaving the read marks would
      // badge the replacement topic against a count from a room that no longer exists.
      topicCache={};
      cacheOrder=[];
      saveCache();
      readCounts={};
      saveReads();
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
    err.textContent='';
    post('api/login',{token:$('secret').value},0).then(function(r){
      if(r.ok){ $('secret').value=''; connect(); return; }
      err.textContent = r.status===429 ? 'Too many attempts. Wait a minute.' : 'That is not the right token.';
    }).catch(function(){ err.textContent='Could not reach the server.'; });
  });

  log.addEventListener('click', function(e){
    var b = e.target.closest ? e.target.closest('button[data-btn]') : null;
    if(!b) return;
    b.disabled = true;
    post('api/click',{topic:topic,messageId:b.getAttribute('data-msg'),buttonId:b.getAttribute('data-btn')},2)
      .catch(function(){ b.disabled=false; });
  });

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

  function send(){
    var body={topic:topic, text:input.value,
      nonce:Math.random().toString(36).slice(2)+Date.now().toString(36)};
    if(files.length) body.files=files;
    if(!body.text.trim() && !files.length) return;
    input.value=''; files=[]; renderChips(); suggest(); grow();
    post('api/send', body, 2).catch(function(){ note.textContent='That message did not reach the daemon.'; });
  }

  input.addEventListener('input', function(){ grow(); suggest(); });
  input.addEventListener('keydown', function(e){
    if(e.key==='Enter' && !e.shiftKey && !e.isComposing){ e.preventDefault(); send(); }
  });
  $('composer').addEventListener('submit', function(e){ e.preventDefault(); send(); });
  if(topic && topicCache[topic]){
    var initialCached = topicCache[topic];
    for(var j=0;j<initialCached.length;j++){
      data[initialCached[j].id] = initialCached[j];
      paint(initialCached[j].id);
    }
    toBottom();
  }

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
<link rel="icon" href="data:,">
<style>${STYLE}</style>
</head>
<body>
<form id="gate" autocomplete="off"><div id="login">
<input id="secret" type="password" placeholder="Token" autocomplete="current-password" autofocus>
<button type="submit">Enter</button>
<p id="err"></p>
</div></form>
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
  <section id="chat">
    <div id="chat-header">
      <button type="button" class="btn-icon" id="expand-sidebar" title="Show topics" hidden>☰</button>
      <span id="topic-title" class="chat-title"></span>
      <span id="topic-status" class="chat-status"></span>
    </div>
    <div id="log"></div>
    <div id="typing" hidden>...</div>
    <div id="note"></div>
    <div id="bar">
      <div id="hints" hidden></div>
      <div id="chips"></div>
      <form id="composer">
        <div id="row">
          <textarea id="input" rows="1" placeholder="Message" autocomplete="off"></textarea>
          <input id="picker" type="file" multiple hidden>
          <button type="button" id="attach" title="Attach a file">+</button>
          <button type="submit">Send</button>
        </div>
      </form>
    </div>
  </section>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
