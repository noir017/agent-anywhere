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
:root{--bg:#131313;--fg:#dcdcdc;--dim:#7d7d7d;--line:#272727;--own:#1c1c1c;--field:#1a1a1a}
*{box-sizing:border-box}
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
#app{display:flex;flex-direction:column;height:100%;max-width:820px;width:100%;margin:0 auto}
#log{flex:1;overflow-y:auto;padding:20px 16px 8px}
.m{margin:0 0 18px;max-width:100%;overflow-wrap:anywhere}
.m.own{border-left:2px solid var(--line);padding-left:10px;color:#bdbdbd}
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
#typing{color:var(--dim);font-size:13px;padding:0 16px 6px}
#bar{border-top:1px solid var(--line);padding:10px 16px 14px}
#hints{margin-bottom:8px;display:flex;flex-wrap:wrap;gap:6px}
#hints button{font-size:12px}
#chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.chip{background:var(--field);border:1px solid var(--line);border-radius:3px;padding:1px 6px;font-size:12px;color:var(--dim)}
.files{margin-top:6px;display:flex;flex-wrap:wrap;gap:6px}
#row{display:flex;gap:8px;align-items:flex-end}
#input{flex:1;resize:none;max-height:40vh;padding:8px 10px;background:var(--field);color:var(--fg);border:1px solid var(--line);border-radius:4px;font:inherit}
#input:focus,#login input:focus{outline:none;border-color:#3d3d3d}
#note{color:var(--dim);font-size:12px;padding:0 16px 8px}
`;

const SCRIPT = `
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var log=$('log'), app=$('app'), gate=$('login'), err=$('err'), input=$('input'),
      chips=$('chips'), hints=$('hints'), typing=$('typing'), note=$('note'), picker=$('picker');
  var data={}, els={}, files=[], commands=[], stream=null, done=false;

  function text(s){ var d=document.createElement('div'); d.textContent=s==null?'':String(s); return d.innerHTML; }
  function post(path, body){
    return fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body),credentials:'same-origin'});
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
    if(!el){ el=document.createElement('div'); log.appendChild(el); els[id]=el; }
    el.className = 'm' + (m.own ? ' own' : '');
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
    el.innerHTML = h;
  }

  function upsert(m){ var stick=atBottom(); data[m.id]=m; paint(m.id); if(stick) toBottom(); }

  function drop(id){
    if(els[id]) { els[id].remove(); delete els[id]; }
    delete data[id];
  }

  function setCommands(list){
    commands = list || [];
  }

  function handle(ev){
    if(ev.t==='sync'){
      log.innerHTML=''; data={}; els={};
      for(var i=0;i<ev.messages.length;i++){ data[ev.messages[i].id]=ev.messages[i]; paint(ev.messages[i].id); }
      setCommands(ev.commands); note.textContent=''; toBottom();
    } else if(ev.t==='msg'){ upsert(ev.msg); }
    else if(ev.t==='del'){ drop(ev.id); }
    else if(ev.t==='react'){
      var m=data[ev.id]; if(!m) return;
      var kept=(m.reactions||[]).filter(function(e){ return e!==ev.emoji; });
      m.reactions = ev.on ? kept.concat([ev.emoji]) : kept;
      paint(ev.id);
    }
    else if(ev.t==='typing'){ typing.hidden = !ev.on; }
    else if(ev.t==='commands'){ setCommands(ev.commands); }
    else if(ev.t==='bye'){ done=true; if(stream) stream.close(); note.textContent='Disconnected. Reload when it is back.'; }
  }

  function connect(){
    stream = new EventSource('api/events');
    stream.onmessage = function(e){ try{ handle(JSON.parse(e.data)); }catch(x){} };
    stream.onopen = function(){ gate.hidden=true; app.hidden=false; note.textContent=''; input.focus(); };
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

  $('gate').addEventListener('submit', function(e){
    e.preventDefault();
    err.textContent='';
    post('api/login',{token:$('secret').value}).then(function(r){
      if(r.ok){ $('secret').value=''; connect(); return; }
      err.textContent = r.status===429 ? 'Too many attempts. Wait a minute.' : 'That is not the right token.';
    }).catch(function(){ err.textContent='Could not reach the server.'; });
  });

  log.addEventListener('click', function(e){
    var b = e.target.closest ? e.target.closest('button[data-btn]') : null;
    if(!b) return;
    b.disabled = true;
    post('api/click',{messageId:b.getAttribute('data-msg'),buttonId:b.getAttribute('data-btn')})
      .catch(function(){ b.disabled=false; });
  });

  function grow(){ input.style.height='auto'; input.style.height=Math.min(input.scrollHeight, window.innerHeight*0.4)+'px'; }

  function renderChips(){
    var h='';
    for(var i=0;i<files.length;i++) h += '<span class="chip">'+text(files[i].name)+'</span>';
    chips.innerHTML=h;
  }

  function take(list){
    for(var i=0;i<list.length;i++){
      (function(f){
        var r=new FileReader();
        r.onload=function(){
          var s=String(r.result), c=s.indexOf(',');
          files.push({name:f.name, mime:f.type||'', data:c<0?'':s.slice(c+1)});
          renderChips();
        };
        r.readAsDataURL(f);
      })(list[i]);
    }
  }

  picker.addEventListener('change', function(){ take(picker.files); picker.value=''; });
  $('attach').addEventListener('click', function(){ picker.click(); });
  document.addEventListener('dragover', function(e){ e.preventDefault(); });
  document.addEventListener('drop', function(e){
    e.preventDefault();
    if(e.dataTransfer && e.dataTransfer.files) take(e.dataTransfer.files);
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
    var body={text:input.value};
    if(files.length) body.files=files;
    if(!body.text.trim() && !files.length) return;
    input.value=''; files=[]; renderChips(); suggest(); grow();
    post('api/send', body).catch(function(){ note.textContent='That message did not reach the daemon.'; });
  }

  input.addEventListener('input', function(){ grow(); suggest(); });
  input.addEventListener('keydown', function(e){
    if(e.key==='Enter' && !e.shiftKey && !e.isComposing){ e.preventDefault(); send(); }
  });
  $('composer').addEventListener('submit', function(e){ e.preventDefault(); send(); });

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
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
