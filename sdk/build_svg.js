#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════════
   build_svg.js — builds a fully self-contained interactive index.svg

   What goes in:
     • retro.min.js (the obfuscated SDK) inlined as an SVG <script> block
     • THE ENCRYPTED CATALOG (games.enc.json rows [slug,name,categoryId,hash])
       — the single embedded data source. The former 20 MB metadata database
       (data/games/**) is gone: the shipped SDK only ever fetches
       data/games.enc.json, the catalog covers more games (36,683 vs 27,591),
       and its rows are the authoritative slug↔hash map. A light game list is
       synthesized from the rows at runtime for the info panel and
       window.RetrogradeMeta, so the file fits any CDN (jsDelivr's GitHub
       limit is 20 MB/file).
     • an embed runtime that hides network URLs from the DOM and devtools:
         - thumbnails painted onto <canvas> (images never carry a CDN src)
         - game iframes loaded via srcdoc/blob wrappers (src stays about:blank)
         - metadata videos fetched and re-served as blob: URLs
         - <link rel=preconnect> hints installed by the SDK are scrubbed
         - right-click / context menu, devtools shortcuts and view-source blocked
     • a game info panel inside the play modal (name, category) fed from the
       catalog rows, plus window.RetrogradeMeta for programmatic access.

   Usage: node build_svg.js            (run from sdk/ or project root)
   Reads: sdk/retro.min.js, sdk/data/games.enc.json
   Writes: index.svg
   ═══════════════════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

const SDK = __dirname;
const ROOT = path.join(SDK, '..');
const OUT = path.join(ROOT, 'index.svg');
const TEMPLATE = path.join(SDK, 'svg', 'template.svg');
const MIN_JS = path.join(SDK, 'retro.min.js');
const CATALOG = path.join(SDK, 'data', 'games.enc.json');
const DATA_DIR = path.join(ROOT, 'data');

const W = 1280, H = 800;

/* Same key as the SDK's DATA_KEY (sdk/build.js) — one cipher everywhere */
const DATA_KEY = process.env.DATA_KEY || 'Rg7x$Data#2024!CatalogEncKey';

/* GAS proxy: re-serves CDN paths with permissive CORS headers (and fetches
   game HTML when the direct CDN fails). Overridable via env for testing. */
const PROXY_URL = process.env.GAS_PROXY_URL ||
  'https://script.google.com/macros/s/AKfycbzqKRvuzC-106fZ6SsPsgYkO9gDyKkCHIPQP-2VUIXbqh4anR6oQ7r07p4GI9uDWMtv/exec';

/* ── Build-time game liveness probe ─────────────────────────────────────
   The game CDN hosts tens of thousands of titles; some are dead (404 on
   their HTML, which no client-side trick can fix). At build time we probe
   every catalog hash once (HEAD request, small concurrency, long cache)
   and remember the dead ones. The boot script then filters BOTH the
   embedded DB and the SDK's catalog cache (served through the same fetch
   shim) so dead games never reach the UI. Cache file:
   sdk/data/dead-games.json — re-probing happens when forced or when the
   cache is older than DEAD_TTL_DAYS. */
const DEAD_CACHE = path.join(SDK, 'data', 'dead-games.json');
const DEAD_TTL_DAYS = 30;
const PROBE_CONCURRENCY = Number(process.env.PROBE_CONCURRENCY || 24);

function loadDeadCache() {
  try {
    const j = JSON.parse(fs.readFileSync(DEAD_CACHE, 'utf8'));
    if (j && Array.isArray(j.dead)) return j;
  } catch (e) {}
  return { ts: 0, dead: [] };
}

function saveDeadCache(cache) {
  try { fs.mkdirSync(path.dirname(DEAD_CACHE), { recursive: true }); } catch (e) {}
  try { fs.writeFileSync(DEAD_CACHE, JSON.stringify(cache)); } catch (e) {}
}

/* Decrypt mirror of multiEncrypt — used to read the catalog envelope. */
function multiDecrypt(bytes, key) {
  const kb = []; for (let i = 0; i < key.length; i++) kb.push(key.charCodeAt(i));
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    let b = bytes[i];
    b = b ^ ((i * 13 + 37) & 255);
    const rot = (8 - ((i * 3 + kb[i % kb.length]) & 7)) & 7;
    b = ((b << rot) | (b >>> ((8 - rot) & 7))) & 255;
    b = b ^ kb[i % kb.length] ^ ((i * 7) & 255);
    out += String.fromCharCode(b);
  }
  return out;
}

/* Catalog rows are [slug, name, categoryId, hash] — hash is the CDN path
   segment every game is served under. */
function readCatalogRows(catalogText) {
  const env = JSON.parse(catalogText);
  const rows = JSON.parse(multiDecrypt(Buffer.from(env.g, 'base64'), DATA_KEY));
  return Array.isArray(rows) ? rows : [];
}

const HASH_RE = /^[a-z0-9]{16,64}$/;

async function probeLiveness(catalogRows, { force }) {
  const hashes = [];
  const seen = new Set();
  for (const r of catalogRows) {
    const h = r && r[3];
    if (h && HASH_RE.test(h) && !seen.has(h)) { seen.add(h); hashes.push(h); }
  }
  const cached = loadDeadCache();
  const fresh = cached.ts && (Date.now() - cached.ts) < DEAD_TTL_DAYS * 864e5;
  const dead = new Set(cached.dead.filter(h => seen.has(h)));
  if (force || !fresh) {
    console.log(`  probing ${hashes.length} game hashes for liveness...`);
    let idx = 0, probed = 0, deadCount = 0;
    async function worker() {
      while (idx < hashes.length) {
        const h = hashes[idx++];
        try {
          /* The CDN answers HEAD with 403 regardless of liveness — use a
             1-byte ranged GET with a browser UA (404 dead / 206 alive). */
          const res = await fetch('https://html5.gamemonetize.co/' + h + '/', {
            method: 'GET',
            headers: { 'Range': 'bytes=0-0', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
            redirect: 'follow'
          });
          if (res.status === 404 || res.status === 410) { dead.add(h); deadCount++; } else dead.delete(h);
        } catch (e) { /* network error: assume alive — never hide on flaky net */ }
        probed++;
        if (probed % 4000 === 0) console.log(`    probed ${probed}/${hashes.length} (${deadCount} dead)`);
      }
    }
    await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));
    saveDeadCache({ ts: Date.now(), dead: [...dead] });
  } else {
    console.log(`  using cached dead-list (${dead.size} dead of ${hashes.length} hashes, ${Math.round((Date.now() - cached.ts) / 864e5)}d old)`);
  }
  return dead;
}

function die(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

/* ── multi-layer byte cipher (mirror of sdk/build.js multiEncrypt) ─────────── */
/* (multiEncrypt retained for encodeRows + tests; gzip/encryptPayload removed
   with the full-DB embed — the embedded catalog is cipher-only, no gzip.) */
function multiEncrypt(str, key) {
  const keyBytes = [];
  for (let i = 0; i < key.length; i++) keyBytes.push(key.charCodeAt(i));
  const enc = [];
  for (let i = 0; i < str.length; i++) {
    let b = str.charCodeAt(i);
    b = b ^ keyBytes[i % keyBytes.length] ^ ((i * 7) & 255);
    const rot = (i * 3 + keyBytes[i % keyBytes.length]) & 7;
    b = ((b << rot) | (b >>> (8 - rot))) & 255;
    b = b ^ ((i * 13 + 37) & 255);
    enc.push(b);
  }
  return enc;
}

/* Encode the plaintext catalog rows for embedding: cipher only, NO gzip —
   inflating client-side would drag pako (~45 KB) back into the file. */
function encodeRows(rowsText) {
  return Buffer.from(multiEncrypt(rowsText, DATA_KEY), 'binary').toString('base64');
}

/* ── CDATA safety: "]]>" may not appear inside a CDATA section ──────────────── */
function cdataSafe(s) {
  return s.replace(/\]\]>/g, ']]]]><![CDATA[>');
}

/* ── XML escaping for inline (CDATA-free) scripts ────────────────────────────
   Chromium's XML parser is flaky with multi-megabyte CDATA sections inside
   SVG foreignObject (parsing silently stops partway), but handles large
   plain text nodes fine. All script blocks are therefore emitted as escaped
   inline content instead of CDATA. <script> content is CDATA-like per the
   XML spec (only "</" needs escaping, but escaping < & > is always safe). */
function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ── Template ──────────────────────────────────────────────────────────────────
   Optional: sdk/svg/template.svg with {{W}} {{H}} {{BOOT_JS}} {{SDK_JS}}
   {{RUNTIME_JS}} placeholders. */
function loadTemplate() {
  if (fs.existsSync(TEMPLATE)) {
    let tpl = fs.readFileSync(TEMPLATE, 'utf8');
    if (tpl.indexOf('{{BOOT_JS}}') === -1) die('Template missing {{BOOT_JS}} placeholder');
    return tpl;
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!-- retrograde — fully self-contained interactive SVG. -->',
    '<!-- Open directly in a browser (File > Open, or via http://). Scripts do NOT run when loaded as <img>. -->',
    '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" style="background:#000">',
    '<title>retrograde.</title>',
    '<rect x="0" y="0" width="100%" height="100%" fill="#000"/>',
    '<foreignObject x="0" y="0" width="100%" height="100%">',
    '<div xmlns="http://www.w3.org/1999/xhtml" class="svg-root" style="width:100%;height:100%;margin:0;padding:0;overflow:hidden;background:#000;">',
    '<style><![CDATA[',
    '  *{margin:0;padding:0;box-sizing:border-box}',
    '  html,body,svg{height:100%;width:100%;overflow:hidden;background:#000;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}',
    '  *{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}',
    '  .svg-root{position:fixed;inset:0;width:100%;height:100%;margin:0;padding:0;overflow:hidden;background:#000}',
    '  #retro-arcade{width:100%;height:100%;overflow:hidden;background:#000}',
    '  ::selection{background:rgba(255,255,255,.2);color:#fff}',
    ']]></style>',
    '<div id="retro-arcade"></div>',
    '<script>{{BOOT_JS}}</script>',
    '<script>{{SDK_JS}}</script>',
    '<script>{{RUNTIME_JS}}</script>',
    '<script>',
    '  new Retrograde({ target: "#retro-arcade" }).init();',
    '</script>',
    '</div>',
    '</foreignObject>',
    '</svg>',
    ''
  ].join('\n');
}

/* ═══════════════════════════════════════════════════════════════════════════════
   1) LIGHT GAME LIST — synthesized from the catalog rows (no data/games read)
   ═══════════════════════════════════════════════════════════════════════════════ */
/* Catalog rows ([slug, name, categoryId, hash]) expand into the light game
   objects the runtime UI reads — this is the whole embedded data surface. */
function buildSynthDb(catalogRows) {
  const catName = {
    1: 'Action Games', 2: 'Shooter Games', 3: 'Arcade Games',
    4: 'Puzzle Games', 5: 'Sport Games', 6: 'Racing Games',
    7: 'Girls Games', 8: '.IO Games', 9: 'Adventure Games',
    10: 'Multiplayer Games', 11: 'Hypercasual Games',
  };
  const games = [];
  for (const r of catalogRows) {
    if (!r || !r[0] || !r[3]) continue;
    games.push({
      slug: r[0],
      name: r[1] || r[0],
      category: r[2],
      categoryName: catName[r[2]] || '',
      gameUrl: 'https://html5.gamemonetize.co/' + r[3] + '/',
    });
  }
  const categories = [];
  const seenCat = {};
  for (const g of games) {
    if (!seenCat[g.category]) {
      seenCat[g.category] = 1;
      categories.push({ id: g.category, slug: 'cat-' + g.category, name: g.categoryName });
    }
  }
  return { games, categories, tags: [] };
}

/* ═══════════════════════════════════════════════════════════════════════════════
   2) BOOT SCRIPT — runs before the SDK:
      a. unscramble the embedded catalog and expand it into the light game list
      b. shim fetch() + XMLHttpRequest so the encrypted catalog envelope resolves
         locally (zero plaintext game JSON on the wire)
      c. SVG-document DOM shims (html head/body + createElement routing)
   ════   ═══════════════════════════════════════════════════════════════════════════ */
function buildBootJs(catalogText, deadSet) {
  const keyArr = DATA_KEY.split('').map(c => c.charCodeAt(0)).join(',');
  const deadArr = deadSet ? [...deadSet] : [];
  const parts = [];
  parts.push('/* Embedded encrypted game database + catalog — no plaintext game data, no network setup */');
  parts.push('window.__RG_DATA_KEY__=[' + keyArr + '];');
  parts.push('window.__RG_EMBEDDED_CATALOG__=' + JSON.stringify(catalogText) + ';');
  /* Dead games (404 at the CDN, probed at build time) never reach the UI. */
  parts.push('window.__RG_DEAD_HASHES__=' + JSON.stringify(deadArr) + ';');
  parts.push('(function(){');
  parts.push('"use strict";');
  parts.push('var EMB=window.__RG_EMBEDDED_CATALOG__;');
  parts.push('var DK=window.__RG_DATA_KEY__,DB_GAMES=[],DB_CATS=[],DB_TAGS=[];');

  /* ── unscramble (mirror of the SDK's _0dc) ── */
  parts.push('function _uns(b64){var s=atob(b64),n=s.length,bytes=new Uint8Array(n),i,b,k=DK;');
  parts.push('for(i=0;i<n;i++){b=s.charCodeAt(i);b=b^((i*13+37)&255);var rot=(8-((i*3+k[i%k.length])&7))&7;b=((b<<rot)|(b>>>((8-rot)&7)))&255;b=b^k[i%k.length]^((i*7)&255);bytes[i]=b;}');
  parts.push('return bytes;}');
  parts.push('function _utf8(u8){try{return new TextDecoder("utf-8").decode(u8);}catch(e){var out="",i=0,c,CH=String.fromCharCode;for(i=0;i<u8.length;i++){c=u8[i];if(c<128){out+=CH(c);}else if(c<224){out+=CH(((c&31)<<6)|(u8[i+1]&63));i+=1;}else if(c<240){out+=CH(((c&15)<<12)|((u8[i+1]&63)<<6)|(u8[i+2]&63));i+=2;}else{var cp=((c&7)<<18)|((u8[i+1]&63)<<12)|((u8[i+2]&63)<<6)|(u8[i+3]&63);cp-=65536;out+=CH(55296+(cp>>10),56320+(cp&1023));i+=3;}}return out;}}');

  /* ── light DB: expand catalog rows [slug,name,catId,hash] into game objects.
     Runs synchronously (no gzip, no pako) and also builds the only slug↔hash
     map the runtime uses. Dead hashes/slugs never enter the list. */
  parts.push('function _loadDB(){if(DB_GAMES.length)return Promise.resolve();return new Promise(function(resolve){');
  parts.push('try{var env=JSON.parse(EMB);var rows=JSON.parse(_utf8(_uns(env.g)));');
  parts.push('var CN={1:"Action Games",2:"Shooter Games",3:"Arcade Games",4:"Puzzle Games",5:"Sport Games",6:"Racing Games",7:"Girls Games",8:".IO Games",9:"Adventure Games",10:"Multiplayer Games",11:"Hypercasual Games"};var seen={};');
  parts.push('if(!window.__RG_SLUG_BY_HASH__)window.__RG_SLUG_BY_HASH__={};');
  parts.push('for(var i=0;i<rows.length;i++){var r=rows[i];if(!r||!r[0]||!r[3])continue;');
  parts.push('window.__RG_SLUG_BY_HASH__[r[3]]=r[0];');
  parts.push('if(DSET[r[3]]||RSET[r[0]])continue;');
  parts.push('DB_GAMES.push({slug:r[0],name:r[1]||r[0],category:r[2],categoryName:CN[r[2]]||"",gameUrl:"https://html5.gamemonetize.co/"+r[3]+"/"});');
  parts.push('if(!seen[r[2]]){seen[r[2]]=1;DB_CATS.push({id:r[2],slug:"cat-"+r[2],name:CN[r[2]]||""});}}');
  parts.push('}catch(e){}resolve();});}');
  /* ── dead-game filtering ──
     DEAD = hashes probed dead at build time; REMOVED = slugs found dead at
     runtime (persisted). A game hidden on either list never renders. */
  parts.push('var DEAD=window.__RG_DEAD_HASHES__||[];');
  parts.push('var DSET={};for(var di=0;di<DEAD.length;di++)DSET[DEAD[di]]=1;');
  parts.push('var RSET={};try{var RL=JSON.parse(localStorage.getItem("rg_dead_slugs")||"[]");for(var ri=0;ri<RL.length;ri++)RSET[RL[ri]]=1;}catch(e){}');
  parts.push('function filterRows(rows){var out=[];for(var i=0;i<rows.length;i++){var r=rows[i];if(r&&r[3]&&DSET[r[3]])continue;if(r&&RSET[r[0]])continue;out.push(r);}return out;}');
  parts.push('window.__RG_DB_READY__=_loadDB();');
  parts.push('window.__RG_DB__=function(){return{games:DB_GAMES||[],categories:DB_CATS,tags:DB_TAGS};};');
  parts.push('var IDX=null;window.__RG_META_BY_SLUG__=function(slug){if(DB_GAMES&&!IDX){IDX={};for(var i=0;i<DB_GAMES.length;i++)IDX[DB_GAMES[i].slug]=DB_GAMES[i];}return IDX?IDX[slug]||null:null;};');
  /* Filtered-catalog provider: the SDK reads its list from games.enc.json
     (envelope {g,c}, rows [slug,name,catId,hash]). We re-encode it once with
     dead rows removed, so the SDK renders only working games even from its
     own localStorage cache — which flows through this same shim. */
  parts.push('var CAT_FILT=null;');
  parts.push('function filteredCatalog(){if(CAT_FILT)return Promise.resolve(CAT_FILT);return window.__RG_DB_READY__.then(function(){');
  parts.push('try{var env=JSON.parse(EMB);var rows=JSON.parse(_utf8(_uns(env.g)));');
  parts.push('var s2=JSON.stringify(filterRows(rows));var kb=DK;var outChars=[];');
  parts.push('for(var i=0;i<s2.length;i++){var b=s2.charCodeAt(i);b=b^kb[i%kb.length]^((i*7)&255);var rot=(i*3+kb[i%kb.length])&7;b=((b<<rot)|(b>>>((8-rot)&7)))&255;b=b^((i*13+37)&255);outChars.push(String.fromCharCode(b));}');
  parts.push('var catBody=JSON.stringify({g:btoa(outChars.join("")),c:env.c});CAT_FILT=catBody;return catBody;}catch(e){return EMB;}});}');
  /* Runtime removal: mark a slug dead, persist, refilter everything live. */
  parts.push('window.__rgRemoveGame=function(slug){try{var L=JSON.parse(localStorage.getItem("rg_dead_slugs")||"[]");if(L.indexOf(slug)===-1){L.push(slug);localStorage.setItem("rg_dead_slugs",JSON.stringify(L));}}catch(e){}RSET[slug]=1;');
  parts.push('if(DB_GAMES){DB_GAMES=DB_GAMES.filter(function(g){return !RSET[g.slug];});}');
  parts.push('try{var c=JSON.parse(localStorage.getItem("_rg7x_catalog_cache")||"null");if(c&&Array.isArray(c.games)){c.games=c.games.filter(function(r){return !(r&&RSET[r[0]]);});localStorage.setItem("_rg7x_catalog_cache",JSON.stringify(c));}}catch(e){}');
  parts.push('CAT_FILT=null;IDX=null;};');

  /* ── SVG-document DOM shims ── */
  parts.push('var IS_SVG=(typeof document!=="undefined")&&document.documentElement&&document.documentElement.namespaceURI==="http://www.w3.org/2000/svg";');
  parts.push('if(IS_SVG){');
  parts.push('  var X="http://www.w3.org/1999/xhtml";');
  parts.push('  var rootEl=document.querySelector("div.svg-root");');
  parts.push('  if(!rootEl){rootEl=document.createElementNS(X,"div");document.documentElement.appendChild(rootEl);}');
  parts.push('  var headEl=document.createElementNS(X,"div");headEl.id="svg-head";headEl.style.display="none";');
  parts.push('  var bodyEl=document.createElementNS(X,"div");bodyEl.id="svg-body";');
  parts.push('  rootEl.appendChild(headEl);');
  parts.push('  rootEl.appendChild(bodyEl);');
  parts.push('  try{Object.defineProperty(document,"head",{value:headEl,configurable:true});}catch(e){}');
  parts.push('  try{Object.defineProperty(document,"body",{value:bodyEl,configurable:true});}catch(e){}');
  parts.push('  document.createElement=function(tag){return document.createElementNS(X,tag);};');
  parts.push('}');

  /* ── fetch shim ── */
  parts.push('function mkResp(url,body){var T=new TextEncoder().encode(body);return{ok:true,status:200,statusText:"OK",type:"basic",url:url,redirected:false,headers:new Headers({"content-type":"application/json"}),json:function(){return Promise.resolve(JSON.parse(body));},text:function(){return Promise.resolve(body);},arrayBuffer:function(){return Promise.resolve(T.buffer);},blob:function(){return Promise.resolve(new Blob([body],{type:"application/json"}));}};}');
  parts.push('function dbResp(url){var cat=null,cm=url.match(/cat\\/([a-z0-9-]+)/);if(cm){for(var i=0;i<DB_CATS.length;i++)if(DB_CATS[i].slug===cm[1]){cat=DB_CATS[i].id;break;}}var pm=url.match(/pages\\/(\\d+)\\.json/);var arr=cat!=null?DB_GAMES.filter(function(g){return g.category===cat;}):DB_GAMES;var pg=pm?+pm[1]:1;');
  parts.push('return Promise.resolve(mkResp(url,JSON.stringify({page:pg,total:arr.length,pages:1,games:arr})));}');
  parts.push('var RE_DB=/\\bdata\\/games\\b|\\/pages\\/|\\/cat\\//;');
  parts.push('var NATIVE_FETCH=window.fetch?window.fetch.bind(window):null;');
  parts.push('window.fetch=function(input,init){');
  parts.push('  var url=(typeof input==="string")?input:(input&&input.url)?input.url:String(input||"");');
  parts.push('  if(url&&url.indexOf("games.enc.json")!==-1)return filteredCatalog().then(function(b){return mkResp(url,b);});');
  parts.push('  if(url&&RE_DB.test(url))return dbResp(url);');
  parts.push('  if(NATIVE_FETCH)return NATIVE_FETCH(input,init);');
  parts.push('  return Promise.reject(new Error("fetch unavailable"));');
  parts.push('};');

  /* ── XHR shim for the same local paths ── */
  parts.push('if(typeof XMLHttpRequest==="function"&&XMLHttpRequest.prototype){');
  parts.push('var XO=XMLHttpRequest.prototype.open,XS=XMLHttpRequest.prototype.send;');
  parts.push('XMLHttpRequest.prototype.open=function(m,u){this.__rgUrl=String(u);return XO.apply(this,arguments);};');
  parts.push('XMLHttpRequest.prototype.send=function(){var xhr=this,u=xhr.__rgUrl||"";');
  parts.push('if(u.indexOf("games.enc.json")===-1&&!RE_DB.test(u))return XS.apply(this,arguments);');
  parts.push('(u.indexOf("games.enc.json")!==-1?filteredCatalog():dbResp(u).then(function(r){return r.text();})).then(function(body){');
  parts.push('try{Object.defineProperty(xhr,"responseText",{value:body,configurable:true});Object.defineProperty(xhr,"response",{value:body,configurable:true});Object.defineProperty(xhr,"status",{value:200,configurable:true});Object.defineProperty(xhr,"readyState",{value:4,configurable:true});}catch(e){}');
  parts.push('try{if(xhr.onreadystatechange)xhr.onreadystatechange();if(xhr.onload)xhr.onload();}catch(e){}});};');
  parts.push('}');

  parts.push('})();');
  return parts.join('\n');
}

/* ═══════════════════════════════════════════════════════════════════════════════
   3) EMBED RUNTIME — runs after the SDK, before init. Hides network URLs for
   media and blocks casual inspection. No "</" sequences (CDATA/XHTML safe).
   ═══════════════════════════════════════════════════════════════════════════════ */
function buildRuntimeJs() {
  /* Bootstrap page executed inside the wrapped game iframe. The wrapper doc
     installed via srcdoc carries the game HTML ONLY as an escaped JS string
     (all "<" chars become \u003c escapes) — a CDN URL never appears in any
     top-level DOM attribute. Tokens are substituted at runtime; neither this
     source nor the runtime contains a literal "</scr" + "ipt" sequence. */
  const WRAP_TOP =
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000}</style>' +
    '</head><body>';

  /* ── Ad shield — injected into the game document before its scripts run.
     1. window.GDSDK stub: GameMonetize ad-SDK calls resolve instantly
        (adFinished fires immediately, so games skip their ad breaks).
     2. Network blocklist: known ad/telemetry hosts get fake 200 responses
        (fetch) or empty data: resources (script/iframe/img/link).
     3. CSS: common ad/banner/preroll containers are display:none.
     4. Game-asset XHRs are routed through the GAS proxy (some CDN assets
        lack CORS headers and fail from a blob: document otherwise).
     Tokens: __RG_H__ (game hash, per-load), __RG_PROXY__ (build time). */
  const AD_SHIM = [
    '(function(){',
    'if(window.__rgAdShield)return;window.__rgAdShield=1;',
    /* values come from the top page (set by the loader + runtime message
       handler before this shim executes) */
    '/* config is injected into THIS document by the loader right before this shim runs; fall back to top-window globals for any other entry path */',
    'var T=window.top||window,H=window.__RG_H||T.__RG_H||"",P=window.__RG_PSTR||T.__RG_PSTR||"",BASE=window.__RG_BASE||T.__RG_BASE||"",LOCAL=false;try{LOCAL=/^\\/cdn\\//.test(location.pathname);}catch(e){}',
    /* base for relative game-asset URLs, set before any game resource parses
       (unconditional: a stale/mis-scoped base left by an export template
       would resolve engine assets against the page origin instead) */
    'try{var b=document.createElement("base");b.href=BASE+H+"/";var _h=document.head||document.documentElement;_h.insertBefore(b,_h.firstChild);}catch(e){}',
    'var BL=["googlesyndication","adsbygoogle","doubleclick","googleadservices","adsystem","adnxs","taboola","outbrain","criteo","smartadserver","pubmatic","rubiconproject","openx","indexww","casalemedia","teads.tv","spotxchange","sharethrough","33across","amazon-adsystem","imasdk","adservice","scorecardresearch","quantserve","chartbeat","google-analytics","googletagmanager","connect.facebook","facebook.net","pagead2","bidswitch","yieldmo","gumgum","sovrn","undertone","media.net","servenobid","mobfox","adcolony","vungle","applovin","unityads","inmobi","mopub","h5gamessdk.yyggames.com","sdk__advertisement","imaContainer","imasdk.googleapis.com",];',
    'function bad(u){u=String(u||"").toLowerCase();if(!u)return false;if(u.indexOf("api.gamemonetize.com/sdk")>-1)return true;if(u.indexOf("gamemonetize")>-1)return false;if(u.charAt(0)==="/"||u.indexOf("127.0.0.1")>-1||u.indexOf("localhost")>-1)return false;if(P&&u.indexOf(P)>-1)return false;for(var i=0;i<BL.length;i++)if(u.indexOf(BL[i])>-1)return true;return /\\/(ads?|pagead|adframe|adrequest)(\\/|\\?|#|$)/.test(u)||/\\/ads?\\//.test(u);}',
    '/* When the game is served same-origin by the local /cdn proxy, ES modules and workers work natively - the proxy-shunt and module->classic rewrites must stay OFF (they would break the healthy path) */',
'var PX=/^https?:\\/\\/[^/]*gamemonetize\\.[a-z]+\\//i;',
'if(!LOCAL){',
    'function abs(u){try{return new URL(String(u),document.baseURI).href;}catch(e){return String(u||"");}}',
    'function purl(u){return P+"?action=cdn&path="+encodeURIComponent(String(u).replace(/^https?:\\/\\//i,"").replace(/^[^/]+\\//,""));}',
    '/* 1. GDSDK stub — every method resolves as an instantly-finished ad */',
    'function mkStub(){return new Proxy({},{get:function(t,k){return function(){for(var i=0;i<arguments.length;i++){(function(o){if(o&&typeof o==="object"){setTimeout(function(){try{o.adStarted&&o.adStarted();o.onGameStart&&o.onGameStart();}catch(e){}},0);setTimeout(function(){try{o.adFinished&&o.adFinished();o.adComplete&&o.adComplete();}catch(e){}},30);}})(arguments[i]);}try{return Promise.resolve()}catch(e){}};}});}',
    'try{window.GDSDK=mkStub();}catch(e){}',
    'window.addEventListener("message",function(ev){try{var d=ev.data;if(d&&d.type==="gdsdk"&&ev.source)ev.source.postMessage({type:"gdsdk",action:"adFinished"},"*");}catch(e){}});',
    '/* 2. fetch: block ads; CDN fetches go direct-first, proxy on failure */',
    'var _f=null;try{if(window.fetch)_f=window.fetch.bind(window);}catch(e){}',
    'window.fetch=function(u,o){var s=abs((u&&u.url)||u||"");',
    'if(bad(s))return Promise.resolve(new Response("{}",{status:200}));',
    'if(String(s).indexOf("about:/")===0)return Promise.resolve(new Response("{}",{status:200,headers:{"Content-Type":"application/json"}}));',
    'if(/\\.(ttf|otf|woff2?|eot)([?#]|$)/i.test(s))return Promise.resolve(new Response("",{status:200}));',
    'if(P&&PX.test(s)&&_f){return _f(s,o).catch(function(){return _f(purl(s),{redirect:"follow"});});}',
    'return _f?_f(u,o):Promise.reject(new Error("no fetch"));};',
    '/* 3. XHR: ads get a fake 200; CDN paths are routed via proxy (CORS) */',
    'var XO=XMLHttpRequest.prototype.open,XS=XMLHttpRequest.prototype.send;',
    'function fakeOpen(x){try{XO.call(x,"GET","data:text/plain,",true);}catch(e){}}',
    'XMLHttpRequest.prototype.open=function(m,u){this.__rgu=abs(u);if(String(this.__rgu).indexOf("about:/")===0){this.__rgfake=true;this.__rgfakeBody="{}";fakeOpen(this);return;}if(/\.(ttf|otf|woff2?|eot)([?#]|$)/i.test(this.__rgu)){this.__rgfake=true;this.__rgfakeBody="";fakeOpen(this);return;}if(bad(this.__rgu)){this.__rgfake=true;this.__rgfakeBody="{}";try{XO.call(this,"GET","data:text/plain,",true);}catch(e){}return;}if(P&&PX.test(this.__rgu)){this.__rgu=purl(this.__rgu);try{return XO.call(this,m,this.__rgu,arguments[2]!==false,arguments[3],arguments[4]);}catch(e){fakeOpen(this);return;}}try{return XO.apply(this,arguments);}catch(e){if(P&&PX.test(String(arguments[1]||"")))fakeOpen(this);}};',
    'XMLHttpRequest.prototype.send=function(){if(this.__rgfake){var x=this;setTimeout(function(){try{Object.defineProperty(x,"status",{value:200,configurable:true});Object.defineProperty(x,"responseText",{value:x.__rgfakeBody||"",configurable:true});Object.defineProperty(x,"response",{value:x.__rgfakeBody||"",configurable:true});Object.defineProperty(x,"readyState",{value:4,configurable:true});}catch(e){}try{x.onreadystatechange&&x.onreadystatechange()}catch(e){}try{x.onload&&x.onload()}catch(e){}},0);return;}return XS.apply(this,arguments);};',
    '/* 4. Element-level blocking for script/iframe/img/link src */',
    'var TINY="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";',
    '/* resolve game-relative URLs against the CDN game dir: engines read their own script src and resolve runtimes against document location (page origin) instead of <base>, so every relative src must already be absolute */',
    'function absu(u){try{return BASE+H+"/"+String(u).replace(/^\\//,"");}catch(e){return u;}}',
    'function guard(el,proto){try{var d=Object.getOwnPropertyDescriptor(proto.prototype,"src");if(!d||!d.set)return;',
    'Object.defineProperty(el,"src",{set:function(v){var s=String(v||"");if(bad(s)){if(el.tagName==="IMG"){d.set.call(el,TINY);el.style&&el.style.setProperty("display","none","important");}else{d.set.call(el,"data:text/plain,");}return;}if(!/^(https?:|data:|blob:|about:|#|\\/\\/)/i.test(s)&&s.charAt(0)!=="/"){try{s=absu(s);}catch(e){}}d.set.call(el,s);},get:function(){return d.get.call(el);},configurable:true});}catch(e){}}',
    'var _c=document.createElement.bind(document);',
    'document.createElement=function(t){var el=_c(t);var lc=String(t).toLowerCase();',
    'if(lc==="script"){guard(el,HTMLScriptElement);',
    '/* engines like Construct 3 inject <script type=module> at runtime: module fetches are CORS-mode and fail cross-origin, while the same code runs as a classic script via the base tag - so rewrite the type */',
    'try{var _ty=Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype,"type");if(_ty&&_ty.set){Object.defineProperty(el,"type",{set:function(v){_ty.set.call(el,String(v).toLowerCase()==="module"?"text/javascript":v);},get:function(){return _ty.get.call(el);},configurable:true});el.type="text/javascript";}}catch(e){}',
    '}',
    'else if(lc==="iframe")guard(el,HTMLIFrameElement);',
    'else if(lc==="img")guard(el,HTMLImageElement);',
    'else if(lc==="source"||lc==="video")guard(el,HTMLSourceElement);',
    'if(lc==="script"||lc==="iframe"||lc==="link"){try{var sa=el.setAttribute;el.setAttribute=function(n,v){var nv=String(v||"");if((n==="src"||n==="href"||n==="data-src")&&bad(nv))return "";if((n==="src"||n==="data-src")&&!/^(https?:|data:|blob:|about:|#|\\/\\/)/i.test(nv)&&nv.charAt(0)!=="/"){try{nv=absu(nv);}catch(e){}}return sa.call(this,n,nv);};}catch(e){}}',
    'return el;};',
    '/* engines like Construct 3 spawn Workers with game-relative URLs: from a page-origin doc they resolve to file:/// and the engine dies — absolutize them against the CDN game dir */',
    'function absWrap(Cn){if(!Cn)return Cn;var F=function(u,o){try{var s=String(u||"");if(s&&!/^(https?:|data:|blob:|about:|#|\\/\\/)/i.test(s))u=absu(s);}catch(e){}return new Cn(u,o);};try{F.prototype=Cn.prototype;}catch(e){}return F;}',
    'try{if(window.Worker)window.Worker=absWrap(window.Worker);}catch(e){}',
    'try{if(window.SharedWorker)window.SharedWorker=absWrap(window.SharedWorker);}catch(e){}',
    '/* Some engines build URLs with no explicit base (new URL(rel)) or use location.href inside srcdoc (about:srcdoc), which throws. Falling back to the injected <base> keeps them pointed at the game dir. */',
    'try{var _U=window.URL;var UF=function(u,b){try{return new _U(u,b);}catch(e){if(b===undefined||b===null){try{return new _U(u,document.baseURI);}catch(e2){try{return new _U(u,location.href);}catch(e3){}}}}throw e;};try{UF.createObjectURL=_U.createObjectURL?_U.createObjectURL.bind(_U):undefined;UF.revokeObjectURL=_U.revokeObjectURL?_U.revokeObjectURL.bind(_U):undefined;}catch(e){}try{window.URL=UF;}catch(e){}}catch(e2){}',
    '/* service workers cannot register cross-origin from this document: stub so offline-support scripts do not abort engine boot */',
    'try{if(navigator.serviceWorker){navigator.serviceWorker.register=function(){return Promise.resolve({unregister:function(){return Promise.resolve(true);},update:function(){},addEventListener:function(){},scope:"/"});};}}catch(e){}',
    '/* 2b. Fonts: CDN fonts lack CORS headers for this origin, so any real font fetch rejects - and engines (Laya) await FontFace.loaded, a browser-internal promise. Chrome brand-checks FontFaceSet.add on an internal slot, so proxies/subclasses CANNOT be added (verified headless) - the only safe hook is the PROTOTYPE: load() on url() faces resolves instantly with zero network (no ERR_FAILED, no unhandled NetworkError), the loaded getter swallows real failures, and add() attaches an error-evictor so a failed face cannot leave the document in loading-blocked state. */',
    'try{if(LOCAL)throw 0;var FFP=window.FontFace&&window.FontFace.prototype;if(FFP){var _ld=Object.getOwnPropertyDescriptor(FFP,"loaded");if(_ld&&_ld.get){Object.defineProperty(FFP,"loaded",{configurable:true,get:function(){var t=this;if(t.__rgsk)return Promise.resolve(t);return _ld.get.call(t).catch(function(){try{Object.defineProperty(t,"status",{value:"loaded",configurable:true});}catch(e){}});}});}}}catch(e){}',
    'try{if(FFP&&FFP.load){var _fl=FFP.load;FFP.load=function(){var t=this,s=String(t.source||""),h=s.replace(/^\\s+/,"");if(/^url/i.test(h)){var head=h.replace(/^url\\s*\\(/i,"").replace(/\\s*\\)\\s*$/,"").replace(/^\\s+/,"").replace(/^[^a-z]+/i,"");if(!/^(data:|blob:|about:)/i.test(head)){t.__rgsk=1;try{Object.defineProperty(t,"status",{value:"loaded",configurable:true});}catch(e){}return Promise.resolve(t);}}var r;try{r=_fl.apply(this,arguments);}catch(e){return Promise.resolve(t);}return r?r.catch(function(){try{Object.defineProperty(t,"status",{value:"loaded",configurable:true});}catch(e){}return t;}):Promise.resolve(t);};}}catch(e){}',
    'try{if(window.FontFaceSet&&window.FontFaceSet.prototype.add&&window.FontFaceSet.prototype.delete){var _fa=window.FontFaceSet.prototype.add,_fd=window.FontFaceSet.prototype.delete;window.FontFaceSet.prototype.add=function(f){try{if(f&&typeof f.addEventListener==="function"){f.addEventListener("error",function(){try{_fd.call(document.fonts,f);}catch(e){}});}}catch(e){}return _fa.call(this,f);};}}catch(e){}',
    'try{if(document.fonts&&document.fonts.load){document.fonts.load=function(){return Promise.resolve([]);};}}catch(e){}',
    '/* runtime-injected <style> elements fetch fonts natively (bypasses fetch/XHR hooks): strip @font-face on insertion and periodically */',
    'function fontStrip(root){try{var l=root&&root.tagName==="STYLE"?[root]:(root||document).querySelectorAll("style");for(var i=0;i<l.length;i++){var t=l[i].textContent||"";if(/@font-face/i.test(t)){var nt=t.replace(/@font-face\\s*{[^{}]*}/gi,"");if(nt!==t){l[i].textContent=nt;}}}}catch(e){}}',
    'if(window.MutationObserver){new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var m=ms[i];if(m.type==="childList"){for(var j=0;j<m.addedNodes.length;j++)fontStrip(m.addedNodes[j]);}else if(m.target)fontStrip(m.target);}}).observe(document.documentElement,{childList:true,subtree:true});}',
    'function fontSweep(){fontStrip(document);try{var ss=document.styleSheets;for(var i=0;i<ss.length;i++){try{var r=ss[i].cssRules;for(var j=r.length-1;j>=0;j--){if(r[j].type===5){var rr="";try{rr=r[j].cssText;}catch(e){}if(/\\burl\\s*\\(/i.test(rr))ss[i].deleteRule(j);}}}catch(e){}}}catch(e){}}',
    'if(document.readyState!=="loading"){fontSweep();}else{document.addEventListener("DOMContentLoaded",fontSweep);}',
    'setInterval(fontSweep,2500);',
    '/* already-parsed elements + future insertions */',
    'function sweep(root){try{var l=(root||document).querySelectorAll("script[src],iframe[src],iframe[srcdoc],img[src],link[href]");for(var i=0;i<l.length;i++){var e=l[i];if(e.tagName==="SCRIPT"&&String(e.getAttribute("type")||"").toLowerCase()==="module"){e.setAttribute("type","text/javascript");}var s=e.getAttribute("srcdoc")||"";if(s&&bad(s)){e.parentNode&&e.parentNode.removeChild(e);continue;}var u=e.getAttribute("src")||e.getAttribute("href")||"";if(bad(u)){e.tagName==="IMG"?e.setAttribute("src",TINY):e.setAttribute(e.hasAttribute("href")?"href":"src","data:text/plain,");}}}catch(e){}}',
    'if(window.MutationObserver){new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var m=ms[i];if(m.type==="childList"){for(var j=0;j<m.addedNodes.length;j++)sweep(m.addedNodes[j]);}else if(m.target)sweep(m.target);}}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["src","href","srcdoc"]});}',
    'if(document.readyState!="loading"){sweep(document);}else{document.addEventListener("DOMContentLoaded",function(){sweep(document);});}',
    /* 6. Module-script canary: ES modules always fetch in CORS mode, which
       the CDN cannot serve to a page-origin document. If any module fails to
       load — or no canvas appears — tell the wrapper to fall back to the
       direct CDN frame (game always runs; only ad-blocking is lost). */
    /* module scripts ALWAYS fetch in CORS mode — a page-origin document can
       never run them from this CDN. Detect instantly (no 9s black gap) and
       let the runtime fall back to the direct CDN-origin frame. */
    /* NOTE: no module-script fallback here — ES modules are the NORMAL case
       for healthy games (they run in the direct nested frame via the page's
       wrapper). A module tag alone is not a failure; the liveness canary
       below is the only thing that may trigger the direct-CDN fallback. */
    /* Liveness canary (multi-signal): a game is "running" only if something
       actually renders. From 10s, wait up to 30s more for the canvas. Then,
       every 6s: WebGL draw-call growth, non-uniform pixels, DOM mutations,
       or a cross-origin engine frame (C3 moves rendering into one) each
       prove life. ONLY three consecutive fully-static samples (~18s of no
       draws + uniform pixels + no mutations) trigger the direct-CDN
       fallback. This never exiles slow loaders or WebGL games. */
    'try{window.__rgMutC=0;new MutationObserver(function(){window.__rgMutC++;}).observe(document.documentElement,{childList:true,subtree:true,attributes:true});}catch(e){}',
    'setTimeout(function(){try{var lastMut=0,tries=0,hadCanvas=false;function mcount(){try{return (window.__rgMutC||0);}catch(e){return 999999;}}function fail(){var still=(!hadCanvas&&mcount()===0)?1:0;try{parent.postMessage({__rgModFail:1,__rgStill:still},"*");}catch(e){}}function waitForCanvas(){var c=null;try{c=document.querySelector("canvas");}catch(e){}if(c){hadCanvas=true;begin(c);return;}var elc=0;try{elc=document.querySelectorAll("*").length;}catch(e){}var nifr=0;try{nifr=document.querySelectorAll("iframe").length;}catch(e){}if(mcount()===0&&((elc>=40&&tries>=15)||(elc>=25&&tries>=15&&nifr===0))){fail();return;}if(tries>=25&&mcount()===0){fail();return;}setTimeout(waitForCanvas,2000);}function begin(c){var done=false,hits=0,samples=0,lastDraw=0;var mut=0;try{new MutationObserver(function(){mut++;}).observe(document.body||document.documentElement,{childList:true,subtree:true,attributes:true});}catch(e){}function ok(){done=true;}function nestedEngine(){try{var l=document.querySelectorAll("iframe");for(var i=0;i<l.length;i++){try{l[i].contentDocument&&l[i].contentDocument.documentElement;}catch(e){return true;}}}catch(e){}return false;}function sample(){if(done)return;samples++;var draws=0;try{draws=c.__rgDraw||0;}catch(e){}var grewDraw=draws>lastDraw;lastDraw=draws;if(grewDraw){ok();return;}var uni=true;try{var t=document.createElement("canvas");t.width=24;t.height=24;var tx=t.getContext("2d");tx.drawImage(c,0,0,24,24);var px=tx.getImageData(0,0,24,24).data;var r=px[0],g=px[1],b=px[2],a=px[3];for(var i=4;i<px.length;i+=4){if(Math.abs(px[i]-r)>8||Math.abs(px[i+1]-g)>8||Math.abs(px[i+2]-b)>8||Math.abs(px[i+3]-a)>8){uni=false;break;}}}catch(e){uni=false;}if(!uni){ok();return;}var gmut=mut>lastMut;lastMut=mut;if(gmut){hits=0;}else{hits++;}if(nestedEngine()){ok();return;}if(samples>=3&&hits>=3){fail();return;}setTimeout(sample,6000);}setTimeout(sample,3000);}waitForCanvas();}catch(e){}},10000);',
    '/* instrument WebGL contexts: count real GPU draw calls so the canary can tell "engine actually rendering" from "engine merely ticking" */',
    'try{var _gc=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(){var c=_gc.apply(this,arguments);try{if(c&&(typeof WebGLRenderingContext!=="undefined"&&c instanceof WebGLRenderingContext||typeof WebGL2RenderingContext!=="undefined"&&c instanceof WebGL2RenderingContext)){var el=this;["drawArrays","drawElements","drawArraysInstanced","drawElementsInstanced","clear"].forEach(function(m){var f=c[m];if(typeof f==="function"&&!c.__rgW){c[m]=function(){el.__rgDraw=(el.__rgDraw||0)+1;return f.apply(c,arguments);};}});c.__rgW=1;}}catch(e){}return c;};}catch(e){}',
    /* ═══ Virtual SDKs — the root-cause fix for black SDK games ═══
       GM C3-plugin games: the plugin assigns window.SDK_OPTIONS then waits
       for onEvent SDK_READY / SDK_GAME_START. The real sdk.js breaks
       off-CDN (it builds config URLs from location), so we answer the
       assignment instantly with a no-ad, no-network boot.
       YYG games: platform.js expects a window.YYGGames global (the real one
       is stripped with the ad-SDK script tag) — provide the full surface,
       every ad method completing immediately. */
    '(function(){var booted=false,ON_EVENT=function(){};function fire(n){try{ON_EVENT({name:n});}catch(e){}}function boot(o){if(booted)return;booted=true;o=o||{};ON_EVENT=typeof o.onEvent===\"function\"?o.onEvent:ON_EVENT;var oi=typeof o.onInit===\"function\"?o.onInit:null;setTimeout(function(){try{oi&&oi({name:\"SDK_READY\",gameId:o.gameId||\"\"});}catch(e){}fire(\"SDK_READY\");},0);}function completeAd(){setTimeout(function(){fire(\"SDK_GAME_PAUSE\");setTimeout(function(){fire(\"COMPLETE\");fire(\"SDK_GAME_START\");},60);},30);}try{var _so;Object.defineProperty(window,\"SDK_OPTIONS\",{configurable:true,get:function(){return _so;},set:function(v){_so=v;boot(v);}});}catch(e){}function stub(){return completeAd();}window.sdk=window.sdk||{showBanner:stub,showBannerAD:stub,showRewardAD:function(cb){stub();try{cb&&cb();}catch(e){}},showInterstitial:function(cb){stub();try{cb&&cb();}catch(e){}},preloadAD:function(cb){try{cb&&cb();}catch(e){}},gameplayStart:function(){},gameplayStop:function(){},happytime:function(){}};window.SDK=window.SDK||{showBanner:stub,showBannerAD:stub,showRewardAD:function(cb){stub();try{cb&&cb();}catch(e){}},showInterstitial:function(cb){stub();try{cb&&cb();}catch(e){}},preloadAD:function(cb){try{cb&&cb();}catch(e){}},gameplayStart:function(){},gameplayStop:function(){},happytime:function(){}};window.YYGGames=window.YYGGames||{showBanner:function(o){o=o||{};var f=function(n){try{typeof o[n]==\"function\"&&o[n]();}catch(e){}};f(\"onShow\");setTimeout(function(){f(\"onComplete\");},40);},hideBanner:function(){},showSplash:function(o){o=o||{};var f=function(n){try{typeof o[n]==\"function\"&&o[n]();}catch(e){}};setTimeout(function(){f(\"onComplete\");},40);},hideSplash:function(){},showReward:function(o){o=o||{};var f=function(n){try{typeof o[n]==\"function\"&&o[n]();}catch(e){}};f(\"onShow\");f(\"beforeShowAd\");setTimeout(function(){f(\"rewardComplete\");f(\"onComplete\");f(\"onFinished\");f(\"rewardDismissed\");f(\"afterShowAd\");},40);},showInterstitial:function(o){o=o||{};var f=function(n){try{typeof o[n]==\"function\"&&o[n]();}catch(e){}};f(\"onShow\");f(\"beforeShowAd\");setTimeout(function(){f(\"afterShowAd\");f(\"onComplete\");},40);},startup:function(o){o=o||{};setTimeout(function(){try{o.complete&&o.complete();}catch(e){}},50);},navigate:function(){},canShowReward:function(){return false;},getForgames:function(){return [];},getAdPlatform:function(){return \"None\";},getAdPlatformType:function(){return \"None\";},getAdPlatformTypeAsync:function(){return Promise.resolve(\"None\");},isAdBlocked:function(){return false;},checkAdBlock:function(cb){try{cb&&cb(false);}catch(e){}},GameplayStart:function(){},GameplayStop:function(){},happytime:function(){},loadingComplete:function(){},init:function(o){boot(o);},on:function(){},off:function(){}};})();',
    'try{var _JP=JSON.parse;JSON.parse=function(t){if(t===null||t===\"\"||t===undefined){return {};}return _JP.apply(JSON,arguments);};}catch(e){}',
    '/* 5. CSS: hide common ad containers */',
    'try{var st=document.createElement("style");st.textContent="#preroll,[id^=promo-],[id^=preroll_],[class^=promo-],[class*=promo-container],[id^=ad-],[id^=ads-],[id^=gdsdk],[id*=interstitial],[id*=preroll],[id*=advertisement],[id*=banner],[id*=loading-modal],[class^=ad-],[class^=ads-],[class*=interstitial],[class*=preroll],[class*=banner-ad],[class*=loading-overlay],[class*=advertisement]{display:none!important;visibility:hidden!important;pointer-events:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;filter:none!important;opacity:1}";(document.head||document.documentElement).appendChild(st);}catch(e){}',
    '}if(!window.__rgAdShieldLocal){try{window.__rgAdShieldLocal=1;}catch(e){}}})();',
    /* 1b. Universal ad-platform stubs — installed BEFORE any game script so
       SDKs that block on an ad callback (Google IMA, H5 adBreak, YYGGames
       etc.) resolve instantly with "no ad" instead of hanging forever. */
    'window.google=window.google||{};',
    'if(!window.google.ima){',
    'function _Evt(t){this.type=t;}',
    'function _Mgr(){var L={};this.addEventListener=function(t,f){(L[t]=L[t]||[]).push(f);};this.getRemainingTime=function(){return 0};this.destroy=function(){};this.resize=function(){};this.pause=function(){};this.resume=function(){};this.expand=function(){};this.collapse=function(){};this.getAdSkippableState=function(){return true};this.skip=function(){};',
    'this.start=function(){setTimeout(function(){["start","complete","contentResumeRequested","all_ads_completed"].forEach(function(t){(L[t]||[]).forEach(function(f){try{f(new _Evt(t));}catch(e){}});});},30);};}',
    'function _Ldr(){var L={};this.addEventListener=function(t,f){(L[t]=L[t]||[]).push(f);};this.destroy=function(){};this.getSettings=function(){return {setLocale:function(){},setPlayerType:function(){},setPlayerVersion:function(){}}};this.requestAds=function(){setTimeout(function(){(L["adsManagerLoaded"]||[]).forEach(function(f){try{f({getAdsManager:function(){return new _Mgr();}});}catch(e){}});},0);};}',
    'window.google.ima={AdDisplayContainer:function(){this.initialize=function(){};},AdsLoader:_Ldr,AdsRequest:function(){},AdsRenderingSettings:function(){},AdEvent:{Type:{STARTED:"start",COMPLETE:"complete",ALL_ADS_COMPLETED:"all_ads_completed",CONTENT_PAUSE_REQUESTED:"contentPauseRequested",CONTENT_RESUME_REQUESTED:"contentResumeRequested",LOADED:"loaded",SKIPPED:"skip"}},AdErrorEvent:{Type:{AD_ERROR:"adError"}},AdsManagerLoadedEvent:{Type:{ADS_MANAGER_LOADED:"adsManagerLoaded"}},ViewMode:{NORMAL:"normal",FULLSCREEN:"fullscreen"},settings:{setLocale:function(){},setPlayerType:function(){},setPlayerVersion:function(){}}};',
    '}',
    'if(typeof window.adBreak!=="function"){window.adBreak=function(o){try{o&&o.adBreakDone&&setTimeout(function(){o.adBreakDone({breakStatus:"noAd"});},0);}catch(e){}};}',
    'if(typeof window.adConfig!=="function"){window.adConfig=function(o){try{o&&o.adBreakDone&&setTimeout(function(){o.adBreakDone({breakStatus:"notReady"});},0);}catch(e){}};}',
  ].join('\n');

  /* Loader installed inside the wrapped game iframe. It receives ONLY the
     bare game id (H) — the CDN hosts are XOR-scrambled charcode arrays that
     get decoded at runtime inside the nested document. Preferred path: fetch
     the raw game HTML (direct CDN, GAS proxy as fallback), inject the ad
     shield, and play it from a blob: URL — ads never load at all. If both
     fetches fail, fall back to a direct CDN iframe (no ad blocking). */
  const INNER_FETCH_LOADER = [
    'function _un(a,k){var s="";for(var i=0;i<a.length;i++)s+=String.fromCharCode(a[i]^((k+i)&127));return s;}',
    '(function(){',
    'var D=document;D.__rgWrapped=1;var H=__RG_HASH__,USED=false,A=_un(__RG_HA__,41),B=_un(__RG_HB__,42),P=_un(__RG_PARR__,44);',
    /* base64 embed: immune to ANY number of JSON/template escaping layers
       (plain JSON-in-JSON got double-escaped to \" and broke the shim). */
    'var SHIM_B64=' + JSON.stringify(Buffer.from(AD_SHIM, 'utf8').toString('base64')) + ';',
    'window.addEventListener("message",function(ev){try{if(ev.data&&ev.data.__rgModFail&&!USED){USED=true;direct();}}catch(e){}});',
    'function frame(u){var f=D.createElement("iframe");',
    'f.setAttribute("allowfullscreen","true");',
    'f.setAttribute("allow","autoplay; fullscreen; gamepad; microphone; clipboard-write");',
    'f.setAttribute("scrolling","no");',
    'f.style.cssText="position:fixed;inset:0;width:100%;height:100%;border:0;display:block;background:#000";',
    'f.onerror=function(){if(!USED&&u!==A+H+"/"){USED=true;direct();}};',
    /* the inner frame must not smuggle ads in either: block src/srcdoc writes */
    'try{var _sa=f.setAttribute;f.setAttribute=function(n,v){if(String(n).toLowerCase()==="src"&&bad(v))return "";return _sa.apply(this,arguments);};}catch(e){}',
    'try{var _sd=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,"srcdoc");if(_sd&&_sd.set){Object.defineProperty(f,"srcdoc",{set:function(){return "";},get:function(){return "";},configurable:true});}}catch(e){}',
    'f.src=u;D.body.appendChild(f);return f;}',
    'function direct(){frame(A+H+"/");}',
    'function play(html){',
    /* hand the shim its config via the TOP window (set by the runtime's
       message handler before it swaps in the blob) — no token substitution
       ever touches the SHIM string (JSON literal must stay intact) */
    'if(window.top&&window.top.__RG_LOCAL===1){try{parent.postMessage({__rgLocalPlay:1,__rgHash:H},"*");}catch(e){}return;}',
    'try{window.parent.__RG_H=H;window.parent.__RG_BASE=A;window.parent.__RG_PSTR=P;}catch(e){}',
    'function b64d(s){try{return new TextDecoder().decode(Uint8Array.from(atob(s),function(c){return c.charCodeAt(0);}));}catch(e){try{return decodeURIComponent(escape(atob(s)));}catch(e2){return "";}}}',
    'var shim=b64d(SHIM_B64);',
    'if(/data-rglocal="1"/.test(html)){try{parent.postMessage({__rgLocalPlay:1,__rgHash:H},"*");}catch(e){}return;}',
    'var done=false;function go(){if(done)return;',
    /* script tags carrying crossorigin force CORS-mode fetches the CDN
       cannot answer from a page-origin document — strip them so the tags
       load no-cors via the injected <base>, exactly like on the real site */
    'html=html.replace(/\\s+crossorigin(?:="[^"]*"|=\x27[^\x27]*\x27|=[^\\s>]+)?/gi,"");',
    'html=html.replace(/\\s+integrity(?:="[^"]*"|=\x27[^\x27]*\x27|=[^\\s>]+)?/gi,"");',
    /* Construct/C3 exports tag plain scripts type="module" even though the
       code contains no import/export (verified). Inside our shielded doc
       they can't load as modules (no CORS on the CDN), but they run fine as
       classic scripts — swap type="module" for defer so execution timing
       (after parse, in order) still matches what the engine expects. */
    'html=html.replace(/<script([^>]*?)\\stype="module"([^>]*)>/gi,"<script$1$2 defer>");',
    'html=html.replace(/<script([^>]*?)\\stype=\x27module\x27([^>]*)>/gi,"<script$1$2 defer>");',
    'html=html.replace(/@font-face\\s*{[^{}]*}/gi,"");',
    /* absolutize static relative srcs against the CDN game dir so runtime URL
       resolution (script self-inspection, engine asset fetches) targets the
       CDN even though this document lives on the page origin */
    'html=html.replace(/\\s(src|data-src)=("(?!https?:|data:|blob:|\\/\\/|[#])[^"]*"|\x27(?!https?:|data:|blob:|\\/\\/|[#])[^\x27]*\x27)/gi,function(_,a,u){var v=u.slice(1,-1);return " "+a+"=\\""+A+H+"/"+v.replace(/^\\//,"")+"\\"";});',
    /* remove third-party ad-SDK script tags outright — with GDSDK/IMA stubs
       in place most games run completely ad-free; games that hard-require
       their SDK are caught by the pixel canary and routed to the direct
       frame instead of hanging on a blurred ad overlay */
    'html=html.replace(/<script[^>]*h5gamessdk[.]yyggames[.]com[^>]*>[\\s\\S]*?<[/]script>/gi,"");',
    'html=html.replace(/<script[^>]*imasdk[.]googleapis[.]com[^>]*>[\\s\\S]*?<[/]script>/gi,"");',
    'html=html.replace(/<script[^>]*api[.]gamemonetize[.]com[/]sdk[.]js[^>]*>[\\s\\S]*?<[/]script>/gi,"");',
    'var S="<"+"script>window.__RG_H="+JSON.stringify(H)+";window.__RG_BASE="+JSON.stringify(A)+";window.__RG_PSTR="+JSON.stringify(P)+";"+shim+"<"+"/script>";',
    'if(/<head[^>]*>/i.test(html)){html=html.replace(/<head[^>]*>/i,function(m){return m+S;});}',
    'else if(/<html[^>]*>/i.test(html)){html=html.replace(/<html[^>]*>/i,function(m){return m+"<head>"+S+"</head>";});}',
    'else{html=S+html;}',
    /* opaque-origin wrapper docs can't create usable blob URLs — hand the
       finished document UP to the runtime, which writes it into the frame
       directly (page origin, shim already inside). */
    'done=true;try{parent.postMessage({__rgWrite:html,__rgHash:H},"*");}catch(e){direct();}}',
    'try{go();}catch(e){setTimeout(function(){try{go();}catch(e2){direct();}},50);}}',
    'function playInner(){USED=true;frame(A+H+"/");}',
    /* viaProxy remembers the direct-CDN status: 404 there AND from the proxy
       means the game is gone for good — tell the runtime so it removes the
       game everywhere instead of leaving the user on a black screen. */
    'var S404=false;',
    'function dead(){try{parent.postMessage({__rgDead:1,__rgHash:H},"*");}catch(e){try{parent.postMessage({__rgDead:1},"*");}catch(e2){}}}',
    'function viaProxy(){try{fetch(P+"?action=game&path="+encodeURIComponent(H),{redirect:"follow"}).then(function(r){if(r.status===404||r.status===410){if(S404){dead();return;}S404=true;playInner();return;}return r.text();}).then(function(t){if(!t||t.length<80){if(S404){dead();return;}S404=true;playInner();return;}play(t);}).catch(function(){if(S404){dead();return;}S404=true;playInner();});}catch(e){if(S404){dead();return;}S404=true;playInner();}}',
    'function start(){try{if(window.top&&window.top.LOCALCDN===1){fetch("/cdn/"+H+"/",{cache:"no-store"}).then(function(r){if(r.status===404||r.status===410){dead();return;}if(!r.ok){S404=true;viaProxy();return;}USED=true;frame("/cdn/"+H+"/");}).catch(function(){S404=true;viaProxy();});return;}}catch(e){}try{fetch("/cdn/"+H+"/",{redirect:"follow"}).then(function(r){if(r.ok)return r.text();throw 0;}).then(function(t){if(!t||t.length<80)throw 0;try{window.parent.__RG_LOCAL=1;window.top.__RG_LOCAL=1;}catch(e){}play(t);}).catch(function(){try{fetch(A+H+"/",{redirect:"follow"}).then(function(r){if(r.status===404||r.status===410){S404=true;viaProxy();return;}if(!r.ok)throw 0;return r.text();}).then(function(t){if(!t||t.length<80){S404=true;viaProxy();return;}play(t);}).catch(function(){S404=true;viaProxy();});}catch(e){S404=true;viaProxy();}});}catch(e){S404=true;viaProxy();}}',
    'if(D.readyState==="loading"){D.addEventListener("DOMContentLoaded",start);}else{start();}',
    '})();',
  ].join('\n');

  const RT = String.raw`
(function(){
"use strict";
if(window.__RG_EMBED_RUNTIME__)return;

var IS_SVG=document.documentElement&&document.documentElement.namespaceURI==="http://www.w3.org/2000/svg";
var X="http://www.w3.org/1999/xhtml";
function C(tag){return IS_SVG?document.createElementNS(X,tag):document.createElement(tag);}
function nativeCall(fn,ctx,args){try{return fn.apply(ctx,args);}catch(e){}}
var GM=_un(__RG_GM_ARR__,43);
var GAME_SRC_RE=new RegExp("^https?:\\/\\/[^\\/]*"+GM+"\\.[a-z]+\\/([a-z0-9]{16,64})\\/?$","i");
var GAME_HOST_RE=new RegExp(GM+"\\.co|"+GM+"\\.com|"+GM+"\\.video|html5\\."+GM,"i");
var IMG_SRC_RE=new RegExp("^https?:\\/\\/[^\\/]*"+GM+"\\.[a-z]+\\/([a-z0-9]{16,64})\\/(\\d+x\\d+)\\.(?:jpe?g|png|webp)","i");
var HINT_RE=new RegExp(GM+"|script\\.google","i");

/* ═════════════════════════════════════════════════════════════════════════
   1. Game iframes — src NEVER carries the game URL.
      The SDK sets iframe.src = CDN + hash + "/" . We intercept that setter,
      fetch the game HTML (the CDN sends access-control-allow-origin: *),
      and load it through a local bootstrap document installed via srcdoc,
      falling back to a blob: URL. The iframe's src stays about:blank.
   ═════════════════════════════════════════════════════════════════════════ */
var WRAP_TOP=__RG_WRAP_TOP__,INNER_FETCH=__RG_INNER_FETCH__;
/* Local-arcade probe: when this page is served by the arcade server (not
   file://), that same server proxies game CDNs same-origin at /cdn/<hash>/
   with the ad shield injected server-side. Prefer that path - engines get
   native modules/workers/CORS. Silent no-op when /cdn is unavailable. */
try{fetch("/cdn/probe",{cache:"no-store"}).then(function(r){if(r.ok)window.LOCALCDN=1;}).catch(function(){});}catch(e){}
var NATIVE_FETCH=window.fetch?window.fetch.bind(window):null;

function q(s){return JSON.stringify(String(s)).replace(/</g,"\\u003c");}
function install(iframe,hash){
  /* Wrapper doc carries ONLY the bare game id; hosts are decoded inside the
     nested document from scrambled arrays, so no URL ever appears in a DOM
     attribute — a viewer sees an opaque hash like H="w8c3jeks…". */
  var inner=INNER_FETCH.split("__RG_HASH__").join(q(hash))
    .split("__RG_HA__").join(JSON.stringify(HA))
    .split("__RG_HB__").join(JSON.stringify(HB))
    .split("__RG_PARR__").join(JSON.stringify(PA));
  var doc=WRAP_TOP+"<"+"script data-r.g.w>"+inner+"<"+"/script>"
    /* Hidden filler so the SDK's contentDocument body-length readiness probe
       doesn't mistake this minimal bootstrap for a CDN error page. */
    + "<"+"div style=\"display:none\" aria-hidden=\"true\">" + ("retrograde integrity filler. ").repeat(8) + "<"+"/div>"
    + "</body></html>";
  /* Same-origin mode: the local arcade server proxies this game at
     /cdn/<hash>/ with the ad shield already injected server-side - load it
     as a normal same-origin frame (modules, workers and CORS all work
     natively, and no engine shims are needed). Gated on window.LOCALCDN,
     set by the boot probe. */
  try{
    if(window.LOCALCDN){
      iframe.__rgw=true;
      nativeCall(IFRAME_SRC_DESC.set,iframe,["/cdn/"+hash+"/"]);
      return;
    }
  }catch(e){}
  try{iframe.removeAttribute("src");}catch(e){}
  /* native srcdoc descriptor (captured before patching) — our own write must
     bypass the __rgw guard in the patched property */
  try{IFRAME_SRCDOC_DESC.set.call(iframe,doc);}catch(e){iframe.srcdoc=doc;}
}
function setBlobSrc(iframe,html){
  try{
    var blob=new Blob([html],{type:"text/html"});
    var u=URL.createObjectURL(blob);
    try{iframe.removeAttribute("srcdoc");}catch(e){}
    nativeCall(IFRAME_SRC_DESC.set,iframe,[u]);
  }catch(e){}
}
function loadHidden(iframe,hash){
  iframe.__rgw=true;
  install(iframe,hash);
}
var GAME_DOC_RE=new RegExp(GM+"|script\\.google","i");
var HASH_IN_DOC_RE=new RegExp("(?:"+GM+"\\.[a-z]+\\/|path=)([a-z0-9]{16,64})","i");
/* The wrapper's loader fetches the game HTML, injects the ad shield, and
   hands the finished document up here. We create the blob in the page realm
   (blob URLs made by opaque-origin srcdoc docs won't commit in child frames)
   and swap it into the wrapper iframe — the game then runs with the page's
   real origin (localStorage etc. work) and the shim still runs first. */
window.addEventListener("message",function(ev){
  try{
    var d=ev.data;
    if(!d||typeof d.__rgPlay!=="string"||!d.__rgPlay.length)return;
    var f=ev.source&&ev.source.frameElement?ev.source.frameElement:null;
    if(!f)return;
    var hash=String(d.__rgHash||f.__rgHash||"");
    if(hash){
      window.__RG_H=hash;
      window.__RG_BASE=CDN_A;
      window.__RG_PSTR=PA;
      f.__rgHash=hash;f.__rgw=true;
    }
    setBlobSrc(f,d.__rgPlay);
  }catch(e){}
});
/* Local-arcade mode: the boot probe confirmed the local server can serve
   games same-origin at /cdn/<hash>/ - play straight from there (no fetch
   chain, no engine shims; the server injects the ad shield itself). */
window.addEventListener("message",function(ev){
  try{
    var d=ev.data;
    if(!d||d.__rgLocalPlay!==1)return;
    var f=ev.source&&ev.source.frameElement?ev.source.frameElement:null;
    if(!f)return;
    var h=String(d.__rgHash||f.__rgHash||"");
    if(!h)return;
    f.__rgHash=h;f.__rgw=true;
    window.__RG_H=h;window.__RG_BASE="/cdn/";window.__RG_PSTR="";
    try{f.removeAttribute("srcdoc");}catch(e){}
    nativeCall(IFRAME_SRC_DESC.set,f,["/cdn/"+h+"/"]);
  }catch(e){}
});
/* blob: navigation refuses to commit inside an XML (SVG) document, so the
   primary path writes the shimmed game document straight into the frame:
   same-origin (page origin — localStorage etc. work), scripts execute, and
   no game URL or blob URL ever appears in the DOM. */
window.addEventListener("message",function(ev){
  try{
    var d=ev.data;
    /* Game doc reports module-script failure (ES modules always fetch in
       CORS mode, which the CDN can't serve to a page-origin doc): rebuild
       the frame as a static bootstrap that nests a direct CDN-origin iframe
       — the proven layout every game runs in, minus ad blocking. */
    if(d&&d.__rgModFail){
      var ff=ev.source&&ev.source.frameElement?ev.source.frameElement:null;
      if(d.__rgStill&&ff&&ff.__rgHash&&!ff.__rgFB){
        /* Engine never started in the shielded doc (no canvas, zero DOM
           mutations for ~40s): this game is dead at the CDN — the direct
           fallback frame would show the identical black screen. Remove the
           game everywhere and close the modal, like the __rgDead path. */
        ff.__rgFB=true;
        var h2s=ff.__rgHash;
        var slug2=h2s&&window.__RG_SLUG_BY_HASH__?window.__RG_SLUG_BY_HASH__[h2s]:null;
        try{if(window.__rgRemoveGame&&slug2)window.__rgRemoveGame(slug2);}catch(e5){}
        try{
          var bk2=document.querySelector("button.ra-modal-back");
          if(bk2)bk2.click();
        }catch(e5){}
        try{rgToast("This game is no longer available and was removed.");}catch(e5){}
        return;
      }
      if(ff&&ff.__rgHash&&!ff.__rgFB){
        ff.__rgFB=true;
        var fb='<'+"!doctype html><html><head><meta charset=\"utf-8\"><style>html,body{margin:0;height:100%;overflow:hidden;background:#000}iframe{position:fixed;inset:0;width:100%;height:100%;border:0}</style></head><body><"+"script>"
          +"var D=document;D.__rgWrapped=1;var A="+JSON.stringify(HA)+";function _u(a,k){var s=\"\";for(var i=0;i<a.length;i++)s+=String.fromCharCode(a[i]^((k+i)&127));return s;}var h="+q(ff.__rgHash)+";"
          +"var f2=document.createElement(\"iframe\");f2.setAttribute(\"allowfullscreen\",\"true\");f2.setAttribute(\"allow\",\"autoplay; fullscreen; gamepad; microphone; clipboard-write\");f2.style.cssText=\"position:fixed;inset:0;width:100%;height:100%;border:0;background:#000\";f2.src=_u(A,41)+h+\"/\";document.body.appendChild(f2);"
          +"<"+"/script></body></html>";
        try{ff.removeAttribute("src");}catch(e4){}
        try{IFRAME_SRCDOC_DESC.set.call(ff,fb);}catch(e4){}
      }
      return;
    }
    /* Loader report: the game itself is unreachable (404/network). Mark it
       dead everywhere, close the modal, tell the user — never again shown. */
    if(d&&d.__rgDead&&ev.source){
      var fd=ev.source.frameElement?ev.source.frameElement:null;
      var h2=d.__rgHash||(fd&&fd.__rgHash)||"";
      var slug=h2&&window.__RG_SLUG_BY_HASH__?window.__RG_SLUG_BY_HASH__[h2]:null;
      try{if(window.__rgRemoveGame&&slug)window.__rgRemoveGame(slug);}catch(e5){}
      try{
        var bk=document.querySelector("button.ra-modal-back");
        if(bk)bk.click();
      }catch(e5){}
      try{rgToast("This game is no longer available and was removed.");}catch(e5){}
      return;
    }
    if(!d||typeof d.__rgWrite!=="string"||!d.__rgWrite.length)return;
    var f=ev.source&&ev.source.frameElement?ev.source.frameElement:null;
    if(!f)return;
    var hash=String(d.__rgHash||f.__rgHash||"");
    if(hash){
      window.__RG_H=hash;
      window.__RG_BASE=CDN_A;
      window.__RG_PSTR=PA;
      f.__rgHash=hash;f.__rgw=true;
    }
    var doc=f.contentDocument;
    /* document.write can't run scripts in XML-initialized frames and blob:
       won't commit inside an SVG page — srcdoc does both (proven), and the
       frame keeps the page origin so localStorage etc. work. */
    try{f.removeAttribute("src");}catch(e2){}
    try{IFRAME_SRCDOC_DESC.set.call(f,d.__rgWrite);}
    catch(e2){
      try{if(doc&&doc.open){doc.open();doc.write(d.__rgWrite);doc.close();}else{setBlobSrc(f,d.__rgWrite);}}catch(e3){setBlobSrc(f,d.__rgWrite);}
    }
  }catch(e){}
});
/* Iframes that enter the DOM already carrying a srcdoc (SDK prefetch/proxy
   fallback path) get adopted here: if we can recover the game id from the
   document text we rebuild our hash-only wrapper; otherwise we at least move
   the document off the visible attribute into a blob: URL. */
function adoptIframe(f){
  if(!f||f.__rgw)return; /* never hijack frames the runtime already owns */
  var d="";
  try{d=f.getAttribute("srcdoc")||"";}catch(e){return;}
  if(d.length<200||d.indexOf("data-r.g.w")!==-1)return;
  if(f.__rgAdopt===d)return;
  f.__rgAdopt=d;f.__rgw=true;
  var m=d.match(HASH_IN_DOC_RE);
  if(m&&m[1]){loadHidden(f,m[1]);return;}
  /* URL-bearing doc we can't rebuild (unknown game): strip ad URLs and move
     it off the visible attribute into a blob: URL. */
  try{f.removeAttribute("src");}catch(e){}
  try{d=d.replace(/https?:\/\/[^\"'\s<>]*(?:googlesyndication|doubleclick|adservice|pagead2|amazon-adsystem|imasdk)[^\"'\s<>]*/gi,"data:text/plain,");}catch(e){}
  setBlobSrc(f,d);
}

var IFRAME_SRC_DESC=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,"src");
if(IFRAME_SRC_DESC&&IFRAME_SRC_DESC.set){
  Object.defineProperty(HTMLIFrameElement.prototype,"src",{
    set:function(v){
      var s=String(v==null?"":v);
      /* frames inside our wrapper docs (the real game frame) are trusted */
      if(this.ownerDocument&&this.ownerDocument.__rgWrapped){nativeCall(IFRAME_SRC_DESC.set,this,[s]);return;}
      /* never let cleanup writes destroy a playing wrapped frame */
      if(this.__rgw&&(s==="about:blank"||s===""))return;
      var mm=s.match(GAME_SRC_RE);
      if(mm){
        this.__rgHash=mm[1];
        var self=this;
        setTimeout(function(){loadHidden(self,mm[1]);},0);
        return;
      }
      nativeCall(IFRAME_SRC_DESC.set,this,[s]);
    },
    get:function(){return nativeCall(IFRAME_SRC_DESC.get,this,[]);},
    configurable:true
  });
}
/* Protect wrapped frames: the SDK's slow-CDN race can overwrite our wrapper
   srcdoc with URL-bearing proxy HTML after the fact. Once a frame is ours
   (__rgw), foreign srcdoc writes are ignored. setAttribute must be guarded
   too — it bypasses the property setters entirely. */
var SET_ATTR=Element.prototype.setAttribute;
try{
  Element.prototype.setAttribute=function(n,v){
    var ln=String(n).toLowerCase();
    if(this.__rgw&&(ln==="srcdoc"||ln==="src"))return "";
    return SET_ATTR.call(this,n,v);
  };
}catch(e){}
var IFRAME_SRCDOC_DESC=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,"srcdoc");
if(IFRAME_SRCDOC_DESC&&IFRAME_SRCDOC_DESC.set){
  Object.defineProperty(HTMLIFrameElement.prototype,"srcdoc",{
    set:function(v){
      if(this.__rgw)return;
      nativeCall(IFRAME_SRCDOC_DESC.set,this,[v]);
    },
    get:function(){return nativeCall(IFRAME_SRCDOC_DESC.get,this,[]);},
    configurable:true
  });
}

/* ═════════════════════════════════════════════════════════════════════════
   2. Thumbnails — painted to <canvas>; <img> never exposes the CDN URL.
      The SDK assigns img.src, then attaches onload/onerror, so we defer the
      native assignment by one microtask and let the handlers install first.
      The detached img still drives circuit-breaker logic invisibly.
   ═════════════════════════════════════════════════════════════════════════ */
function drawImage(img,cv){
  var w=img.naturalWidth||0,h=img.naturalHeight||0;
  if(!w||!h){w=512;h=384;}
  try{
    cv.width=w;cv.height=h;
    var g2=cv.getContext("2d");
    if(!g2)return false;
    g2.drawImage(img,0,0,w,h);
    return true;
  }catch(e){return false;}
}
function paintPlaceholder(cv,label){
  try{
    cv.width=512;cv.height=384;
    var g2=cv.getContext("2d");
    if(!g2)return;
    var gr=g2.createLinearGradient(0,0,512,384);
    gr.addColorStop(0,"#101014");gr.addColorStop(1,"#05050a");
    g2.fillStyle=gr;g2.fillRect(0,0,512,384);
    g2.fillStyle="rgba(255,255,255,.16)";
    g2.font="600 44px Inter,system-ui,sans-serif";
    g2.textAlign="center";g2.textBaseline="middle";
    g2.fillText((label||"?").charAt(0).toUpperCase(),256,192);
  }catch(e){}
}
function adopt(img){
  if(img.__rgc)return;
  var src=img.getAttribute("src")||"";
  var m=src.match(IMG_SRC_RE);
  if(!m||!GAME_HOST_RE.test(src))return;
  img.__rgc=true;
  var cv=C("canvas");
  cv.className=img.className||"";
  cv.style.cssText=img.style.cssText;
  var attrs=["width","height","alt","title","aria-label","role","draggable","loading"];
  for(var i=0;i<attrs.length;i++){
    var v=img.getAttribute(attrs[i]);
    if(v!=null)cv.setAttribute(attrs[i],v);
  }
  var label=cv.getAttribute("alt")||"";
  var parent=img.parentNode;
  if(parent)parent.replaceChild(cv,img);
  paintPlaceholder(cv,label);

  function onReady(){
    if(drawImage(img,cv))return true;
    return false;
  }
  img.addEventListener("load",function(){onReady();});
  img.addEventListener("error",function(){paintPlaceholder(cv,label);});
  /* if the image already finished loading before adoption */
  if(img.complete&&img.naturalWidth>0)onReady();
}
function scanMedia(root){
  var list=(root||document).querySelectorAll("img");
  for(var i=0;i<list.length;i++)adopt(list[i]);
  var vids=(root||document).querySelectorAll("video[src]");
  for(var j=0;j<vids.length;j++)adoptVideo(vids[j]);
}
function adoptVideo(el){
  if(el.__rgv)return;
  var src=el.getAttribute("src")||"";
  if(!GAME_HOST_RE.test(src))return;
  el.__rgv=true;
  el.removeAttribute("src");
  if(typeof NATIVE_FETCH!=="function")return;
  NATIVE_FETCH(src,{mode:"cors"}).then(function(r){
    if(!r.ok)throw 0;return r.blob();
  }).then(function(b){
    if(el.isConnected)el.src=URL.createObjectURL(b);
  }).catch(function(){});
}

/* ═════════════════════════════════════════════════════════════════════
   3. Hint + attribute scrubbing — remove URL-bearing preconnect links and
      data-* / title attributes the SDK installs.
   ═════════════════════════════════════════════════════════════════════ */
function purgeHints(){
  var links=document.querySelectorAll('link[rel="preconnect"],link[rel="dns-prefetch"]');
  for(var i=0;i<links.length;i++){
    var h=links[i].getAttribute("href")||"";
    if(HINT_RE.test(h)){var p=links[i].parentNode;if(p)p.removeChild(links[i]);}
  }
}
function scrubAttrs(root){
  var list=(root||document).querySelectorAll("*");
  for(var i=0;i<list.length;i++){
    var e=list[i];
    if(!e.getAttribute)continue;
    for(var a=0;a<e.attributes.length;a++){
      var at=e.attributes[a];
      if((at.name.indexOf("data-")===0||at.name==="title")&&HINT_RE.test(at.value)){
        e.removeAttribute(at.name);a--;
      }
    }
  }
}
function sweepAll(root){
  try{purgeHints();}catch(e){}
  try{scrubAttrs(root);}catch(e){}
  try{scanMedia(root);}catch(e){}
  try{
    var fr=(root||document).querySelectorAll("iframe");
    for(var k=0;k<fr.length;k++)adoptIframe(fr[k]);
  }catch(e){}
}
sweepAll(document);
var MO=window.MutationObserver?new MutationObserver(function(muts){
  for(var i=0;i<muts.length;i++){
    var m=muts[i];
    if(m.type==="attributes"){
      var t=m.target;
      if(t&&t.tagName==="IMG")adopt(t);
      else if(t&&t.tagName==="VIDEO")adoptVideo(t);
      else if(t&&t.tagName==="IFRAME")adoptIframe(t);
      continue;
    }
    for(var j=0;j<m.addedNodes.length;j++){
      var n=m.addedNodes[j];
      if(n.nodeType!==1)continue;
      if(n.tagName==="IMG")adopt(n);
      else if(n.tagName==="VIDEO")adoptVideo(n);
      else if(n.tagName==="IFRAME")adoptIframe(n);
      else if(n.querySelectorAll)sweepAll(n);
    }
  }
}):null;
if(MO){
  try{
    MO.observe(document.documentElement||document,{
      childList:true,subtree:true,attributes:true,attributeFilter:["src","srcdoc"]
    });
  }catch(e){}
}
setInterval(function(){sweepAll(document);},3000);

/* ═════════════════════════════════════════════════════════════════════════
   4. Game info panel — description/instructions/tags/rating from the
      embedded database, rendered above the game viewport.
   ═════════════════════════════════════════════════════════════════════════ */
function esc(s){
  return String(s).replace(/[&<>"']/g,function(c){
    return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
  });
}
function stripHtml(h){
  return String(h||"")
    .split(String.fromCharCode(92)+"n").join(" ")
    .replace(/<[^>]*>/g," ")
    .replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&lt;/g,"<")
    .replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/\s+/g," ").trim();
}
/* Transient toast for user-facing notices (dark pill, bottom-center). */
function rgToast(msg){
  try{
    var t=C("div");
    t.setAttribute("style","position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:rgba(18,18,24,.96);color:#e8e8f0;padding:10px 18px;border:1px solid rgba(255,255,255,.14);border-radius:10px;font:500 13px Inter,system-ui,sans-serif;z-index:2147483647;box-shadow:0 8px 30px rgba(0,0,0,.6);pointer-events:none;opacity:0;transition:opacity .25s");
    t.textContent=String(msg||"");
    (document.body||document.documentElement).appendChild(t);
    setTimeout(function(){t.style.opacity="1";},10);
    setTimeout(function(){t.style.opacity="0";setTimeout(function(){try{t.remove();}catch(e1){}},400);},3400);
  }catch(e){}
}
var infoEl=null,infoSlug=null;
function findTitleEl(){
  return document.getElementById("x34")||document.getElementById("ra-game-title");
}
function currentGame(){
  var t=findTitleEl();
  var nm=t&&t.textContent?t.textContent.trim():"";
  if(!nm)return null;
  var db=window.__RG_DB__?window.__RG_DB__():{games:[]};
  var low=nm.toLowerCase();
  for(var i=0;i<db.games.length;i++){
    var g=db.games[i];
    if((g.name||g.slug||"").toLowerCase()===low)return g;
  }
  for(var j=0;j<db.games.length;j++){
    if((db.games[j].name||"").toLowerCase().indexOf(low)!==-1)return db.games[j];
  }
  return null;
}
function findGameBox(){
  var f=document.querySelector("iframe[srcdoc]");
  var p=f?f.parentElement:null;
  return p&&p.id?p:null;
}
function renderInfo(){
  var box=findGameBox();
  if(!box){
    if(infoEl&&infoEl.parentNode){infoEl.parentNode.removeChild(infoEl);}
    infoEl=null;infoSlug=null;
    return;
  }
  var g=currentGame();
  if(!g){
    if(infoEl&&infoEl.parentNode){infoEl.parentNode.removeChild(infoEl);}
    infoEl=null;infoSlug=null;
    return;
  }
  if(infoSlug===g.slug&&infoEl&&infoEl.parentNode===box.parentNode)return;
  infoSlug=g.slug;
  if(!infoEl){
    infoEl=C("div");
    infoEl.className="ra-meta-panel";
    infoEl.setAttribute("style","flex:0 0 auto;margin:0;padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.07);background:rgba(10,10,10,.72);color:rgba(255,255,255,.8);font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;font-size:12px;line-height:1.5;max-height:118px;overflow:auto;-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)");
  }
  if(!infoEl.parentNode||infoEl.parentNode!==box.parentNode)box.parentNode.insertBefore(infoEl,box);

  var bits=[];
  if(g.categoryName)bits.push(esc(g.categoryName));
  if(g.tagNames&&g.tagNames.length){
    var seen={},uniq=[];
    for(var k=0;k<g.tagNames.length&&uniq.length<5;k++){
      var tn=String(g.tagNames[k]);
      if(!seen[tn.toLowerCase()]){seen[tn.toLowerCase()]=1;uniq.push(tn);}
    }
    if(uniq.length)bits.push(esc(uniq.join(" · ")));
  }
  if(g.rating&&g.rating!=="0")bits.push("★ "+esc(g.rating));
  if(g.plays)bits.push(Number(g.plays).toLocaleString()+" plays");
  if(g.width&&g.height)bits.push(g.width+"×"+g.height+(g.mobile?" · mobile":""));
  var h='<div style="font-weight:600;font-size:12px;color:#fff;margin:0 0 3px">'+esc(g.name||g.slug)+"</div>";
  if(bits.length)h+='<div style="color:rgba(255,255,255,.42);font-size:10px;letter-spacing:.6px;text-transform:uppercase;margin:0 0 6px">'+bits.join("  •  ")+"</div>";
  var desc=stripHtml(g.description);
  if(desc)h+='<div style="margin:0 0 5px;color:rgba(255,255,255,.78)">'+esc(desc)+"</div>";
  if(g.instructions)h+='<div style="color:rgba(255,255,255,.55)"><b style="color:rgba(255,255,255,.75);font-weight:600">How to play:</b> '+esc(g.instructions)+"</div>";
  infoEl.innerHTML=h;
}
function bindPanelWatcher(){
  if(bindPanelWatcher._mo||!window.MutationObserver)return;
  bindPanelWatcher._mo=new MutationObserver(function(){renderInfo();});
  try{bindPanelWatcher._mo.observe(document.body||document.documentElement,{childList:true,subtree:true});}catch(e){}
}
bindPanelWatcher();
setInterval(function(){renderInfo();},800);

/* ═════════════════════════════════════════════════════════════════════════
   5. RetrogradeMeta — programmatic access to the embedded database
   ═════════════════════════════════════════════════════════════════════════ */
function whenDb(fn){
  if(window.__RG_DB_READY__&&window.__RG_DB_READY__.then){
    return window.__RG_DB_READY__.then(fn);
  }
  return Promise.resolve(fn());
}
window.RetrogradeMeta={
  ready:function(){return whenDb(function(){});},
  count:function(){return whenDb(function(){return (window.__RG_DB__().games||[]).length;});},
  get:function(slug){return whenDb(function(){return window.__RG_META_BY_SLUG__?window.__RG_META_BY_SLUG__(slug):null;});},
  search:function(q,limit){
    limit=limit||20;
    return whenDb(function(){
      var db=window.__RG_DB__().games||[],out=[],low=String(q||"").toLowerCase();
      for(var i=0;i<db.length&&out.length<limit;i++){
        var g=db[i];
        if((g.name||"").toLowerCase().indexOf(low)!==-1||(g.description||"").toLowerCase().indexOf(low)!==-1)out.push(g);
      }
      return out;
    });
  },
  random:function(n){
    n=n||5;
    return whenDb(function(){
      var db=window.__RG_DB__().games||[],out=[];
      for(var i=0;i<n&&db.length;i++)out.push(db[Math.floor(Math.random()*db.length)]);
      return out;
    });
  },
  tags:function(){return whenDb(function(){return window.__RG_DB__().tags||[];});},
  categories:function(){return whenDb(function(){return window.__RG_DB__().categories||[];});}
};

/* ═════════════════════════════════════════════════════════════════════════
   6. Inspection deterrents
   ═════════════════════════════════════════════════════════════════════════ */
document.addEventListener("contextmenu",function(e){e.preventDefault();return false;},true);
document.addEventListener("dragstart",function(e){
  var t=e.target;
  if(t&&(t.tagName==="IMG"||t.tagName==="VIDEO"||t.tagName==="A"||t.tagName==="CANVAS")){e.preventDefault();return false;}
},true);
document.addEventListener("keydown",function(e){
  var k=(e.key||"").toLowerCase();
  if(k==="f12"){e.preventDefault();return false;}
  if((e.ctrlKey||e.metaKey)&&e.shiftKey&&(k==="i"||k==="j"||k==="c"||k==="k")){e.preventDefault();return false;}
  if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&(k==="u"||k==="s")){e.preventDefault();return false;}
},true);

/* best-effort devtools size heuristic — taxes casual inspectors only */
var DT_OPEN=false,TH=190;
try{console.clear&&console.clear();}catch(e){}
var noop=function(){};
["log","info","warn","debug","table","dir"].forEach(function(m){
  try{
    var orig=console[m].bind(console);
    console[m]=function(){if(DT_OPEN)return noop();return orig.apply(null,arguments);};
  }catch(e){}
});
setInterval(function(){
  try{
    var ow=window.outerWidth||0,oh=window.outerHeight||0,iw=window.innerWidth||0,ih=window.innerHeight||0;
    var open=(ow>0&&iw>0&&ow-iw>TH)||(oh>0&&ih>0&&oh-ih>TH);
    if(open!==DT_OPEN){DT_OPEN=open;}
  }catch(e){}
},1000);

window.__RG_EMBED_RUNTIME__=true;
window.__RG_SCAN_MEDIA__=sweepAll;
})();
`.trim()
    /* inject the wrapper template + inner loaders + CDN bases (XOR-scrambled
       so no plain game-CDN URL appears anywhere in the file source) */
    const scr = (s, k) => { const o = []; for (let i = 0; i < s.length; i++) o.push(s.charCodeAt(i) ^ ((k + i) & 127)); return o; };
    const unFn = 'function _un(a,k){var s="";for(var i=0;i<a.length;i++)s+=String.fromCharCode(a[i]^((k+i)&127));return s;}';
    const cdnDefs =
      unFn +
      'var CDN_A=_un(' + JSON.stringify(scr("https://html5.gamemonetize.co/", 41)) + ',41);' +
      'var CDN_B=_un(' + JSON.stringify(scr("https://html5.gamemonetize.com/", 42)) + ',42);' +
      'var HA=' + JSON.stringify(scr("https://html5.gamemonetize.co/", 41)) + ';' +
      'var HB=' + JSON.stringify(scr("https://html5.gamemonetize.com/", 42)) + ';' +
      'var GM=_un(' + JSON.stringify(scr("gamemonetize", 43)) + ',43);' +
      /* CORS proxy retired: P stays empty so every P&&... branch is inert
         and the loader/shim go straight to the CDN (its game HTML carries
         access-control-allow-origin: *, which is all we need). */
      'var PA="";';
    return stripComments(RT
    /* inject the wrapper template + inner loader + scrambled hosts */
    .replace("__RG_WRAP_TOP__", JSON.stringify(WRAP_TOP))
    .replace("__RG_INNER_FETCH__", JSON.stringify(INNER_FETCH_LOADER))
    .replace("__RG_GM_ARR__", JSON.stringify(scr("gamemonetize", 43)))
    /* NOTE: no outer __RG_PROXY__ / __RG_PARR__ substitution here — those
       tokens live inside the embedded shim/loader strings and are filled
       per-load by install() (globals would corrupt the JSON string). */
    .replace("(function(){\n\"use strict\";", cdnDefs + "\n(function(){\n\"use strict\";"));
}

/* Strip comments via terser (safe for multi-line banners). The runtime is
   injected into a single-line <script> payload in the SVG, so any surviving
   // comment would swallow the rest of the script. */
async function stripComments(code) {
  let r;
  try {
    r = await minify(code, {
      compress: false,
      mangle: false,
      format: { comments: false, keep_quoted_props: true },
    });
  } catch (e) {
    try { fs.writeFileSync('/tmp/rt_bad.js', code); } catch (_) {}
    die('Runtime comment-strip threw: ' + e.message);
  }
  if (r.error) {
    try { fs.writeFileSync('/tmp/rt_bad.js', code); } catch (e) {}
    die('Runtime comment-strip failed: ' + r.error.message);
  }
  return r.code;
}

/* ── Assemble ─────────────────────────────────────────────────────────── */
module.exports = { buildSynthDb, buildBootJs, buildRuntimeJs, encodeRows, multiEncrypt, DATA_KEY, readCatalogRows, probeLiveness, loadDeadCache };

async function main() {
  const FORCE_PROBE = process.env.FORCE_PROBE === '1';
  console.log('[1/5] Reading SDK + encrypted catalog...');
  const sdkJs = fs.readFileSync(MIN_JS, 'utf8');
  const catalogText = fs.readFileSync(CATALOG, 'utf8');
  if (catalogText.indexOf('"g"') === -1 || catalogText.indexOf('"c"') === -1) {
    die('games.enc.json does not look like the encrypted envelope {g,c}');
  }
  console.log('  retro.min.js: ' + (sdkJs.length / 1024).toFixed(1) + ' KB');
  console.log('  games.enc.json: ' + (catalogText.length / 1048576).toFixed(2) + ' MB');

  console.log('[2/5] Synthesizing light game list from catalog rows...');
  const synth = buildSynthDb(readCatalogRows(catalogText));
  console.log('  ' + synth.games.length.toLocaleString() + ' games (catalog-derived), ' +
    synth.categories.length + ' categories — no data/games/** embedded');

  console.log('[3/5] Probing game liveness (hides dead games at build time)...');
  let deadSet;
  try {
    const rows = readCatalogRows(catalogText);
    deadSet = await probeLiveness(rows, { force: FORCE_PROBE });
    console.log('  ' + deadSet.size + ' dead hashes hidden (probe ' + (FORCE_PROBE ? 'forced' : 'cached/TTL') + ')');
  } catch (e) {
    deadSet = new Set();
    console.log('  probe failed (' + e.message + ') — building without dead-list');
  }

  console.log('[4/5] Building boot script (catalog embed + fetch/XHR shims + SVG DOM shims)...');
  const bootJs = buildBootJs(catalogText, deadSet);

  console.log('[5/5] Building URL-hiding embed runtime...');
  const runtimeJs = await buildRuntimeJs();

  console.log('[5/5] Assembling SVG document...');
  let svg = loadTemplate();
  svg = svg.split('{{W}}').join(String(W)).split('{{H}}').join(String(H));
  svg = svg.split('{{BOOT_JS}}').join(xmlEscape(bootJs));
  svg = svg.split('{{SDK_JS}}').join(xmlEscape(sdkJs));
  svg = svg.split('{{RUNTIME_JS}}').join(xmlEscape(runtimeJs));

  fs.writeFileSync(OUT, svg, 'utf8');
  const size = fs.statSync(OUT).size;
  console.log('  ✓ index.svg written: ' + (size / 1048576).toFixed(2) + ' MB');

  /* Validate XML well-formedness with the platform's XML parser */
  try {
    const { execFileSync } = require('child_process');
    execFileSync('xmllint', ['--noout', OUT], { stdio: 'pipe' });
    console.log('  ✓ xmllint: XML well-formed');
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log('  (xmllint not found — skipping XML validation)');
    } else {
      die('XML validation failed: ' + (e.stderr ? e.stderr.toString() : e.message));
    }
  }

  /* Syntax-check every embedded <script> block EXACTLY as the browser will
     decode it (single-pass XML entity unescape), so a build can never ship
     with a broken boot/runtime script again. */
  const { minify: checkMinify } = require('terser');
  const raw = fs.readFileSync(OUT, 'utf8');
  const blocks = raw.match(/<script[^>]*>[\s\S]*?<\/script>/g) || [];
  const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", '#39': "'" };
  let bad = 0;
  for (let bi = 0; bi < blocks.length; bi++) {
    const inner = blocks[bi].replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    if (!inner.trim()) continue;
    const dec = inner.replace(/&(#[0-9]+|[a-zA-Z]+);/g, (m, n) => (n in ENT ? ENT[n] : m));
    try {
      const r = await checkMinify(dec, { compress: false, mangle: false });
      if (r.error) throw r.error;
    } catch (e) {
      bad++;
      console.error('  ✗ script block ' + bi + ' has a syntax error: ' + e.message);
      const nl = dec.slice(0, 400).replace(/\n/g, ' ');
      console.error('    starts with: ' + nl);
    }
  }
  if (bad) die(bad + ' script block(s) failed the post-build syntax check');
  console.log('  ✓ all ' + blocks.length + ' script blocks parse cleanly');
}

if (require.main === module) main();
