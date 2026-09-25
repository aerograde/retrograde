#!/usr/bin/env node
/* Arcade server: static files + same-origin reverse proxy for game CDNs.
   Root-cause fix for black-screen engines (Construct 3 etc.): the CDN sends
   access-control-allow-origin:* ONLY on HTML/JSON — never on .js/.css/fonts —
   so a page-origin document cannot load ES modules or spawn cross-origin
   Workers. Serving each game same-origin at /cdn/<hash>/ gives engines their
   normal environment natively: location.href, <base>, modules and workers all
   just work. The ad shield (the same AD_SHIM the client-side loader injects)
   is injected server-side into HTML responses, so every game stays ad-free.
   Routes:
     /...                 static files from the project root (index.svg etc.)
     /cdn/<hash>/         game HTML — fetched from the CDN, shield-injected
     /cdn/<hash>/<path>   game assets — streamed straight from the CDN
     /cdn?path=...        legacy compat
*/
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8777;
const ROOT = path.resolve(__dirname, '..');
const CDN = 'https://html5.gamemonetize.co';
const HASH_RE = /^[a-z0-9]{16,64}$/i;
const MEMORY_CACHE = new Map(); // "path" -> {buf, ct} for shielded HTML
const MAX_MEM = 64;

/* ── shield ──────────────────────────────────────────────────────────────
   Injected into game HTML before its scripts run. Same protections as the
   in-page AD_SHIM, rewritten for server delivery: no tokens, no base64
   wrapper, config values inlined. LOCAL/LOCALCDN keep client shims inert
   when both paths are active. */
const SHIELD = `<script>
(function(){
if(window.__rgAdShield)return;window.__rgAdShield=1;
/* this document is served same-origin from /cdn/<hash>/ — H is location */
var H=location.pathname.replace(/^\\/cdn\\//,"").replace(/\\/?$/,"/"),P="";
/* reload-loop guard: a game document that re-loads itself >=4 times in 30s
   is bombard-pinning the parent (portal) main thread. sessionStorage survives
   same-origin reloads (unlike window.name, which the frame's name attribute
   clobbers) and is keyed per hash; past the threshold it reports __rgHang to
   the portal, which removes the game. */
try{
var HK=location.pathname;
if(HK.indexOf("/cdn/")===0)HK=HK.slice(5);
if(HK.charAt(HK.length-1)==="/")HK=HK.slice(0,-1);
if(HK===""||HK==="cdn"){var _qi=location.search.indexOf("path=");if(_qi>-1){try{HK=decodeURIComponent(location.search.slice(_qi+5).split("&")[0]);}catch(e){}}}
var _sk="rg_hang_"+HK;
var _st=String(sessionStorage.getItem(_sk)||"").split("|");
var _n=parseInt(_st[0],10)||0,_t=parseInt(_st[1],10)||0,_now=Date.now();
if(!_t||_now-_t>30000){_t=_now;_n=0;}
_n++;
try{sessionStorage.setItem(_sk,_n+"|"+_t);}catch(e){}
if(_n>=4&&_n%4===0){try{parent.parent.postMessage({__rgHang:1,__rgHash:HK},"*");}catch(e){}}
}catch(e){}
var BL=["googlesyndication","adsbygoogle","doubleclick","googleadservices","adsystem","adnxs","taboola","outbrain","criteo","smartadserver","pubmatic","rubiconproject","openx","indexww","casalemedia","teads.tv","spotxchange","sharethrough","33across","amazon-adsystem","imasdk","adservice","scorecardresearch","quantserve","chartbeat","google-analytics","googletagmanager","connect.facebook","facebook.net","pagead2","bidswitch","yieldmo","gumgum","sovrn","undertone","media.net","servenobid","mobfox","adcolony","vungle","applovin","unityads","inmobi","mopub","h5gamessdk.yyggames.com","sdk__advertisement","imaContainer"];
function bad(u){u=String(u||"").toLowerCase();if(!u)return false;if(u.indexOf("api.gamemonetize.com/sdk")>-1)return true;if(u.indexOf("gamemonetize")>-1)return false;for(var i=0;i<BL.length;i++)if(u.indexOf(BL[i])>-1)return true;return /\\/(ads?|pagead|adframe|adrequest)(\\/|\\?|#|$)/.test(u)||/\\/ads?\\//.test(u);}
function isLocal(u){u=String(u||"");return u.indexOf("/")===0||u.indexOf(location.origin)===0;}
function abs(u){try{return new URL(String(u),document.baseURI).href;}catch(e){return String(u||"");}}
/* 1. GDSDK stub — every method resolves as an instantly-finished ad */
function mkStub(){return new Proxy({},{get:function(t,k){return function(){for(var i=0;i<arguments.length;i++){(function(o){if(o&&typeof o==="object"){setTimeout(function(){try{o.adStarted&&o.adStarted();o.onGameStart&&o.onGameStart();}catch(e){}},0);setTimeout(function(){try{o.adFinished&&o.adFinished();o.adComplete&&o.adComplete();}catch(e){}},30);}})(arguments[i]);}try{return Promise.resolve()}catch(e){}};}});}
try{window.GDSDK=mkStub();}catch(e){}
window.addEventListener("message",function(ev){try{var d=ev.data;if(d&&d.type==="gdsdk"&&ev.source)ev.source.postMessage({type:"gdsdk",action:"adFinished"},"*");}catch(e){}});
/* 2. fetch: block ads; game/CDN fetches pass through untouched */
var _f=null;try{if(window.fetch)_f=window.fetch.bind(window);}catch(e){}
window.fetch=function(u,o){var s=abs((u&&u.url)||u||"");
if(bad(s))return Promise.resolve(new Response("{}",{status:200}));
if(String(s).indexOf("about:/")===0)return Promise.resolve(new Response("{}",{status:200,headers:{"Content-Type":"application/json"}}));
if(/\\.(ttf|otf|woff2?|eot)([?#]|$)/i.test(s))return Promise.resolve(new Response("",{status:200}));
return _f?_f(u,o):Promise.reject(new Error("no fetch"));};
/* 3. XHR: ads get a fake 200; everything else passes through */
var XO=XMLHttpRequest.prototype.open,XS=XMLHttpRequest.prototype.send;
function fakeOpen(x){try{XO.call(x,"GET","data:text/plain,",true);}catch(e){}}
XMLHttpRequest.prototype.open=function(m,u){this.__rgu=abs(u);if(String(this.__rgu).indexOf("about:/")===0){this.__rgfake=true;this.__rgfakeBody="{}";fakeOpen(this);return;}if(/\\.(ttf|otf|woff2?|eot)([?#]|$)/i.test(this.__rgu)){this.__rgfake=true;this.__rgfakeBody="";fakeOpen(this);return;}if(bad(this.__rgu)){this.__rgfake=true;this.__rgfakeBody="{}";try{XO.call(this,"GET","data:text/plain,",true);}catch(e){}return;}try{return XO.apply(this,arguments);}catch(e){}};
XMLHttpRequest.prototype.send=function(){if(this.__rgfake){var x=this;setTimeout(function(){try{Object.defineProperty(x,"status",{value:200,configurable:true});Object.defineProperty(x,"responseText",{value:x.__rgfakeBody||"",configurable:true});Object.defineProperty(x,"response",{value:x.__rgfakeBody||"",configurable:true});Object.defineProperty(x,"readyState",{value:4,configurable:true});}catch(e){}try{x.onreadystatechange&&x.onreadystatechange()}catch(e){}try{x.onload&&x.onload()}catch(e){}},0);return;}return XS.apply(this,arguments);};
/* 4. Element-level blocking for script/iframe/img/link src */
var TINY="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
function guard(el,proto){try{var d=Object.getOwnPropertyDescriptor(proto.prototype,"src");if(!d||!d.set)return;
Object.defineProperty(el,"src",{set:function(v){var s=String(v||"");if(bad(s)){if(el.tagName==="IMG"){d.set.call(el,TINY);el.style&&el.style.setProperty("display","none","important");}else{d.set.call(el,"data:text/plain,");}return;}d.set.call(el,s);},get:function(){return d.get.call(el);},configurable:true});}catch(e){}}
var _c=document.createElement.bind(document);
document.createElement=function(t){var el=_c(t);var lc=String(t).toLowerCase();
if(lc==="script")guard(el,HTMLScriptElement);
else if(lc==="iframe")guard(el,HTMLIFrameElement);
else if(lc==="img")guard(el,HTMLImageElement);
else if(lc==="source"||lc==="video")guard(el,HTMLSourceElement);
if(lc==="script"||lc==="iframe"||lc==="link"){try{var sa=el.setAttribute;el.setAttribute=function(n,v){var nv=String(v||"");if((n==="src"||n==="href"||n==="data-src")&&bad(nv))return "";return sa.call(this,n,nv);};}catch(e){}}
return el;};
/* sensor permission queries (accelerometer etc.) throw "Permissions check failed" on non-secure origins and spam the console: resolve denied instead */
try{if(navigator.permissions&&navigator.permissions.query){var _pq=navigator.permissions.query.bind(navigator.permissions);navigator.permissions.query=function(d){try{var n=d&&d.name||"";if(/accelerometer|gyroscope|magnetometer|ambient-light-sensor/i.test(n))return Promise.resolve({state:"denied",name:n,onchange:null});}catch(e){}return _pq(d);};}}catch(e){}
/* service workers cannot run here: stub so register-sw never aborts boot */
try{if(navigator.serviceWorker){navigator.serviceWorker.register=function(){return Promise.resolve({unregister:function(){return Promise.resolve(true);},update:function(){},addEventListener:function(){},scope:"/"});};}}catch(e){}
/* 4b. Fonts: third-party font fetches get fake 200s above; prototype hooks
   keep any engine (Laya) from awaiting a never-loading FontFace. Skipped
   entirely when this page ALSO carries the client-side shim (LOCAL). */
if(!window.__rgAdShieldClient){
try{var FFP=window.FontFace&&window.FontFace.prototype;if(FFP){var _ld=Object.getOwnPropertyDescriptor(FFP,"loaded");if(_ld&&_ld.get){Object.defineProperty(FFP,"loaded",{configurable:true,get:function(){var t=this;if(t.__rgsk)return Promise.resolve(t);return _ld.get.call(t).catch(function(){try{Object.defineProperty(t,"status",{value:"loaded",configurable:true});}catch(e){}});}});}}}catch(e){}
try{if(FFP&&FFP.load){var _fl=FFP.load;FFP.load=function(){var t=this,s=String(t.source||""),h=s.replace(/^\\s+/,"");if(/^url/i.test(h)){var head=h.replace(/^url\\s*\\(/i,"").replace(/\\s*\\)\\s*$/,"").replace(/^\\s+/,"").replace(/^[^a-z]+/i,"");if(!/^(data:|blob:|about:)/i.test(head)){t.__rgsk=1;try{Object.defineProperty(t,"status",{value:"loaded",configurable:true});}catch(e){}return Promise.resolve(t);}}var r;try{r=_fl.apply(this,arguments);}catch(e){return Promise.resolve(t);}return r?r.catch(function(){try{Object.defineProperty(t,"status",{value:"loaded",configurable:true});}catch(e){}return t;}):Promise.resolve(t);};}}catch(e){}
try{if(window.FontFaceSet&&window.FontFaceSet.prototype.add&&window.FontFaceSet.prototype.delete){var _fa=window.FontFaceSet.prototype.add,_fd=window.FontFaceSet.prototype.delete;window.FontFaceSet.prototype.add=function(f){try{if(f&&typeof f.addEventListener==="function"){f.addEventListener("error",function(){try{_fd.call(document.fonts,f);}catch(e){}});}}catch(e){}return _fa.call(this,f);};}}catch(e){}
try{if(document.fonts&&document.fonts.load){document.fonts.load=function(){return Promise.resolve([]);};}}catch(e){}
/* runtime-injected <style> @font-face stripping (bypasses fetch/XHR hooks) */
function fontStrip(root){try{var l=root&&root.tagName==="STYLE"?[root]:(root||document).querySelectorAll("style");for(var i=0;i<l.length;i++){var t=l[i].textContent||"";if(/@font-face/i.test(t)){var nt=t.replace(/@font-face\\s*{[^{}]*}/gi,"");if(nt!==t){l[i].textContent=nt;}}}}catch(e){}}
if(window.MutationObserver){new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var m=ms[i];if(m.type==="childList"){for(var j=0;j<m.addedNodes.length;j++)fontStrip(m.addedNodes[j]);}else if(m.target)fontStrip(m.target);}}).observe(document.documentElement,{childList:true,subtree:true});}
function fontSweep(){fontStrip(document);try{var ss=document.styleSheets;for(var i=0;i<ss.length;i++){try{var r=ss[i].cssRules;for(var j=r.length-1;j>=0;j--){if(r[j].type===5){var rr="";try{rr=r[j].cssText;}catch(e){}if(/\\burl\\s*\\(/i.test(rr))ss[i].deleteRule(j);}}}catch(e){}}}catch(e){}}
if(document.readyState!=="loading"){fontSweep();}else{document.addEventListener("DOMContentLoaded",fontSweep);}
setInterval(fontSweep,2500);
}
/* 5. CSS: hide common ad containers */
try{var st=document.createElement("style");st.textContent="#preroll,[id^=promo-],[id^=preroll_],[class^=promo-],[class*=promo-container],[id^=ad-],[id^=ads-],[id^=gdsdk],[id*=interstitial],[id*=preroll],[id*=advertisement],[id*=banner],[id*=loading-modal],[class^=ad-],[class^=ads-],[class*=interstitial],[class*=preroll],[class*=banner-ad],[class*=loading-overlay],[class*=advertisement]{display:none!important;visibility:hidden!important;pointer-events:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;filter:none!important;opacity:1}";(document.head||document.documentElement).appendChild(st);}catch(e){}
/* 6. Universal ad-platform stubs */
window.google=window.google||{};
if(!window.google.ima){
function _Evt(t){this.type=t;}
function _Mgr(){var L={};this.addEventListener=function(t,f){(L[t]=L[t]||[]).push(f);};this.getRemainingTime=function(){return 0};this.destroy=function(){};this.resize=function(){};this.pause=function(){};this.resume=function(){};this.expand=function(){};this.collapse=function(){};this.getAdSkippableState=function(){return true};this.skip=function(){};
this.start=function(){setTimeout(function(){["start","complete","contentResumeRequested","all_ads_completed"].forEach(function(t){(L[t]||[]).forEach(function(f){try{f(new _Evt(t));}catch(e){}});});},30);};}
function _Ldr(){var L={};this.addEventListener=function(t,f){(L[t]=L[t]||[]).push(f);};this.destroy=function(){};this.getSettings=function(){return {setLocale:function(){},setPlayerType:function(){},setPlayerVersion:function(){}}};this.requestAds=function(){setTimeout(function(){(L["adsManagerLoaded"]||[]).forEach(function(f){try{f({getAdsManager:function(){return new _Mgr();}});}catch(e){}});},0);};}
window.google.ima={AdDisplayContainer:function(){this.initialize=function(){};},AdsLoader:_Ldr,AdsRequest:function(){},AdsRenderingSettings:function(){},AdEvent:{Type:{STARTED:"start",COMPLETE:"complete",ALL_ADS_COMPLETED:"all_ads_completed",CONTENT_PAUSE_REQUESTED:"contentPauseRequested",CONTENT_RESUME_REQUESTED:"contentResumeRequested",LOADED:"loaded",SKIPPED:"skip"}},AdErrorEvent:{Type:{AD_ERROR:"adError"}},AdsManagerLoadedEvent:{Type:{ADS_MANAGER_LOADED:"adsManagerLoaded"}},ViewMode:{NORMAL:"normal",FULLSCREEN:"fullscreen"},settings:{setLocale:function(){},setPlayerType:function(){},setPlayerVersion:function(){}}};
}
if(typeof window.adBreak!=="function"){window.adBreak=function(o){try{o&&o.adBreakDone&&setTimeout(function(){o.adBreakDone({breakStatus:"noAd"});},0);}catch(e){}};}
if(typeof window.adConfig!=="function"){window.adConfig=function(o){try{o&&o.adBreakDone&&setTimeout(function(){o.adBreakDone({breakStatus:"notReady"});},0);}catch(e){}};}
/* ═══ Virtual SDKs — GM C3 plugin (SDK_OPTIONS) + YYGGames platform.js ═══ */
(function(){var booted=false,ON_EVENT=function(){};function fire(n){try{ON_EVENT({name:n});}catch(e){}}function boot(o){if(booted)return;booted=true;o=o||{};ON_EVENT=typeof o.onEvent==="function"?o.onEvent:ON_EVENT;var oi=typeof o.onInit==="function"?o.onInit:null;setTimeout(function(){try{oi&&oi({name:"SDK_READY",gameId:o.gameId||""});}catch(e){}fire("SDK_READY");},0);}function completeAd(){setTimeout(function(){fire("SDK_GAME_PAUSE");setTimeout(function(){fire("COMPLETE");fire("SDK_GAME_START");},60);},30);}try{var _so;Object.defineProperty(window,"SDK_OPTIONS",{configurable:true,get:function(){return _so;},set:function(v){_so=v;boot(v);}});}catch(e){}function stub(){return completeAd();}window.sdk=window.sdk||{showBanner:stub,showBannerAD:stub,showRewardAD:function(cb){stub();try{cb&&cb();}catch(e){}},showInterstitial:function(cb){stub();try{cb&&cb();}catch(e){}},preloadAD:function(cb){try{cb&&cb();}catch(e){}},gameplayStart:function(){},gameplayStop:function(){},happytime:function(){}};window.SDK=window.SDK||{showBanner:stub,showBannerAD:stub,showRewardAD:function(cb){stub();try{cb&&cb();}catch(e){}},showInterstitial:function(cb){stub();try{cb&&cb();}catch(e){}},preloadAD:function(cb){try{cb&&cb();}catch(e){}},gameplayStart:function(){},gameplayStop:function(){},happytime:function(){}};window.YYGGames=window.YYGGames||{showBanner:function(o){o=o||{};var f=function(n){try{typeof o[n]==="function"&&o[n]();}catch(e){}};f("onShow");setTimeout(function(){f("onComplete");},40);},hideBanner:function(){},showSplash:function(o){o=o||{};var f=function(n){try{typeof o[n]==="function"&&o[n]();}catch(e){}};setTimeout(function(){f("onComplete");},40);},hideSplash:function(){},showReward:function(o){o=o||{};var f=function(n){try{typeof o[n]==="function"&&o[n]();}catch(e){}};f("onShow");f("beforeShowAd");setTimeout(function(){f("rewardComplete");f("onComplete");f("onFinished");f("rewardDismissed");f("afterShowAd");},40);},showInterstitial:function(o){o=o||{};var f=function(n){try{typeof o[n]==="function"&&o[n]();}catch(e){}};f("onShow");f("beforeShowAd");setTimeout(function(){f("afterShowAd");f("onComplete");},40);},startup:function(o){o=o||{};setTimeout(function(){try{o.complete&&o.complete();}catch(e){}},50);},navigate:function(){},canShowReward:function(){return false;},getForgames:function(){return [];},getAdPlatform:function(){return "None";},getAdPlatformType:function(){return "None";},getAdPlatformTypeAsync:function(){return Promise.resolve("None");},isAdBlocked:function(){return false;},checkAdBlock:function(cb){try{cb&&cb(false);}catch(e){}},GameplayStart:function(){},GameplayStop:function(){},happytime:function(){},loadingComplete:function(){},init:function(o){boot(o);},on:function(){},off:function(){}};})();
/* liveness canary (full port): instrument WebGL draw calls, watch mutations
   and pixels; a game that never paints for ~40s is dead at the CDN - report
   through the runtime's __rgDead channel so it is removed everywhere
   (never a fallback to the ad-bearing direct frame). */
try{window.__rgMutC=0;new MutationObserver(function(){window.__rgMutC++;}).observe(document.documentElement,{childList:true,subtree:true,attributes:true});}catch(e){}
try{var _gc=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(){var c=_gc.apply(this,arguments);try{if(c&&(typeof WebGLRenderingContext!=="undefined"&&c instanceof WebGLRenderingContext||typeof WebGL2RenderingContext!=="undefined"&&c instanceof WebGL2RenderingContext)){var el=this;["drawArrays","drawElements","drawArraysInstanced","drawElementsInstanced","clear"].forEach(function(m){var f=c[m];if(typeof f==="function"&&!c.__rgW){c[m]=function(){el.__rgDraw=(el.__rgDraw||0)+1;return f.apply(c,arguments);};}});c.__rgW=1;}}catch(e){}return c;};}catch(e){}
setTimeout(function(){try{var lastMut=0,tries=0,hadCanvas=false;function mcount(){try{return (window.__rgMutC||0);}catch(e){return 999999;}}function dead(){try{parent.parent.postMessage({__rgDead:1},"*");}catch(e){}}function waitForCanvas(){var c=null;try{c=document.querySelector("canvas");}catch(e){}if(c){hadCanvas=true;begin(c);return;}var elc=0;try{elc=document.querySelectorAll("*").length;}catch(e){}var nifr=0;try{nifr=document.querySelectorAll("iframe").length;}catch(e){}if(mcount()===0&&nifr===0&&((elc>=40&&tries>=15)||(elc>=25&&tries>=15))){dead();return;}if(tries>=25&&mcount()===0){dead();return;}setTimeout(waitForCanvas,2000);}function begin(c){var done=false,hits=0,samples=0,lastDraw=0,mut=0;try{new MutationObserver(function(){mut++;}).observe(document.body||document.documentElement,{childList:true,subtree:true,attributes:true});}catch(e){}function sample(){if(done)return;samples++;var draws=0;try{draws=c.__rgDraw||0;}catch(e){}var grewDraw=draws>lastDraw;lastDraw=draws;if(grewDraw){done=true;return;}var uni=true;try{var t=document.createElement("canvas");t.width=24;t.height=24;var tx=t.getContext("2d");tx.drawImage(c,0,0,24,24);var px=tx.getImageData(0,0,24,24).data;var r=px[0],g=px[1],b=px[2],a=px[3];for(var i=4;i<px.length;i+=4){if(Math.abs(px[i]-r)>8||Math.abs(px[i+1]-g)>8||Math.abs(px[i+2]-b)>8||Math.abs(px[i+3]-a)>8){uni=false;break;}}}catch(e){uni=false;}if(!uni){done=true;return;}var gmut=mut>lastMut;lastMut=mut;if(gmut){hits=0;}else{hits++;}if(samples>=3&&hits>=3){dead();return;}setTimeout(sample,6000);}setTimeout(sample,3000);}waitForCanvas();}catch(e){}},10000);
/* popup ads: window.open from game code gets a dead stub; _blank anchors to foreign hosts are dead too */
try{window.open=function(){try{return {closed:true,close:function(){},focus:function(){},postMessage:function(){},addEventListener:function(){}};}catch(e){}return null;};}catch(e){}
try{document.addEventListener("click",function(ev){try{var a=ev.target&&ev.target.closest?ev.target.closest("a[target=_blank]"):null;if(a){var h=String(a.getAttribute("href")||"");if(/^https?:/i.test(h)&&h.indexOf(location.origin)!==0)ev.preventDefault();}}catch(e){}},true);}catch(e){}
})();
<\/script>`;

/* (the wrapper tags are part of SHIELD; nothing to unescape — the template's
   <\/script> evaluates to the literal closing tag) */

const TRANSFORMS = `
<script>
/* client-shield coexistence guards: the client AD_SHIM sets these markers
   when it runs, so its font/module rewrites stay OFF for this same-origin
   document and its bad() ignores relative /cdn URLs */
window.__rgAdShieldClient=1;window.LOCAL=1;
try{window.__rgAdShieldLocation=location.href;}catch(e){}
<\/script>
`;

/* Ad-host kill list: parser-inserted <script>/<iframe> tags execute before
   ANY client-side DOM hook can see them, so the server HTML scrubber is the
   only timely layer. Remove every tag whose src points at an ad network. */
const AD_HOSTS = ['googlesyndication', 'adsbygoogle', 'doubleclick', 'googleadservices', 'adsystem', 'adnxs', 'taboola', 'outbrain', 'criteo', 'smartadserver', 'pubmatic', 'rubiconproject', 'openx', 'indexww', 'casalemedia', 'teads', 'spotxchange', 'sharethrough', '33across', 'amazon-adsystem', 'imasdk', 'adservice', 'scorecardresearch', 'quantserve', 'chartbeat', 'google-analytics', 'googletagmanager', 'connect.facebook', 'facebook.net', 'pagead2', 'bidswitch', 'yieldmo', 'gumgum', 'sovrn', 'undertone', 'media.net', 'servenobid', 'mobfox', 'adcolony', 'vungle', 'applovin', 'unityads', 'inmobi', 'mopub', 'h5gamessdk.yyggames.com', 'api.gamemonetize.com/sdk'];
const AD_HOST_RE = new RegExp('(?:' + AD_HOSTS.join('|') + ')', 'i');
const GM_AD_RE = new RegExp('<script[^>]*(?:' + AD_HOSTS.join('|') + ')[^>]*>[\\s\\S]*?<\\/script>', 'gi');
const AD_IFRAME_RE = new RegExp('<iframe[^>]*>[\\s\\S]*?<\\/iframe>', 'gi');
const AD_IFRAME_OPEN_RE = /<iframe[^>]*>/gi;
const CROSSORIGIN_RE = /\s+crossorigin(?:="[^"]*"|='[^']*'|=[^\s>]+)?/gi;
const INTEGRITY_RE = /\s+integrity(?:="[^"]*"|='[^']*'|=[^\s>]+)?/gi;
const MODULE_DQ_RE = /<script([^>]*?)\stype="module"([^>]*)>/gi;
const MODULE_SQ_RE = /<script([^>]*?)\stype='module'([^>]*)>/gi;

function shieldHtml(html) {
  let out = html;
  /* whole <script> blocks from ad hosts; iframes pointing at ad hosts;
     meta-refresh (a reload-loop vector in hang-loop games) */
  out = out.replace(GM_AD_RE, '');
  out = out.replace(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*>/gi, '');
  out = out.replace(AD_IFRAME_RE, (m) => AD_HOST_RE.test(m) ? '' : m);
  out = out.replace(AD_IFRAME_OPEN_RE, (m) => AD_HOST_RE.test(m) ? '' : m);
  out = out.replace(CROSSORIGIN_RE, '');
  out = out.replace(INTEGRITY_RE, '');
  /* keep module scripts as modules — same-origin now, CORS-free */
  out = out.replace(MODULE_DQ_RE, '<script$1$2>');
  out = out.replace(MODULE_SQ_RE, "<script$1$2>");
  out = out.replace(/@font-face\s*{[^{}]*}/gi, '');
  const inject = TRANSFORMS + SHIELD;
  /* marker the client loader checks so it never re-transforms this doc */
  out = out.replace(/<html([^>]*)>/i, '<html$1 data-rglocal="1">');
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (m) => m + inject);
  } else if (/<html[^>]*>/i.test(out)) {
    out = out.replace(/<html[^>]*>/i, (m) => m + '<head>' + inject + '</head>');
  } else {
    out = inject + out;
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.atlas': 'text/plain; charset=utf-8', '.fnt': 'text/plain; charset=utf-8',
};

function send(res, code, body, headers) {
  res.writeHead(code, headers || {});
  res.end(body);
}

function fetchUpstream(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : require('https');
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 'Accept': '*/*' } }, (r) => {
      if (r.statusCode && r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        return resolve(fetchUpstream(new URL(r.headers.location, url).href));
      }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode || 0, ct: r.headers['content-type'] || '', buf: Buffer.concat(chunks) }));
      r.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('upstream timeout')); });
  });
}

function serveStatic(req, res, pathname) {
  let p = decodeURIComponent(pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found');
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    if (ext === '.svg') headers['Content-Type'] = 'image/svg+xml';
    send(res, 200, buf, headers);
  });
}

function serveCdn(res, hash, rest) {
  const up = CDN + '/' + hash + '/' + rest;
  const key = 'cdn:' + up;
  /* only HTML is transformed; cache just those */
  if (MEMORY_CACHE.has(key)) {
    const c = MEMORY_CACHE.get(key);
    return send(res, 200, c.buf, { 'Content-Type': c.ct, 'Cache-Control': 'no-cache' });
  }
  fetchUpstream(up).then((r) => {
    if (r.status === 404 || r.status === 410) return send(res, r.status, 'gone');
    if (r.status !== 200) return send(res, 502, 'upstream ' + r.status);
    const ct = (r.ct || '').toLowerCase();
    let buf = r.buf, outCt = r.ct || 'application/octet-stream';
    if (ct.includes('text/html') && r.buf.length > 80) {
      buf = Buffer.from(shieldHtml(r.buf.toString('utf8')), 'utf8');
      outCt = 'text/html; charset=utf-8';
      if (MEMORY_CACHE.size > MAX_MEM) MEMORY_CACHE.clear();
      MEMORY_CACHE.set(key, { buf, ct: outCt });
    }
    send(res, 200, buf, { 'Content-Type': outCt, 'Cache-Control': 'no-cache' });
  }).catch((e) => send(res, 502, 'upstream error: ' + e.message));
}

const server = http.createServer((req, res) => {
  if (process.env.RG_LOG) console.log('[req]', req.url, (req.headers.referer || '').slice(0, 90));
  try {
    const u = new URL(req.url, 'http://x');
    const pn = u.pathname;
    let m;
    if (pn === '/cdn/probe') return send(res, 200, 'ok');
    if ((m = pn.match(/^\/cdn\/([a-z0-9]{16,64})(\/.*)?$/i))) {
      const hash = m[1].toLowerCase();
      const rest = (m[2] || '/').replace(/^\/+/, '');
      return serveCdn(res, hash, rest);
    }
    if (pn === '/cdn') {
      const p = u.searchParams.get('path') || '';
      const hm = p.match(/^([a-z0-9]{16,64})(?:\/(.*))?$/i);
      if (hm) return serveCdn(res, hm[1].toLowerCase(), hm[2] || '');
      return send(res, 400, 'bad path');
    }
    if (pn === '/healthz') return send(res, 200, 'ok');
    return serveStatic(req, res, pn);
  } catch (e) {
    return send(res, 500, 'server error: ' + e.message);
  }
});
server.listen(PORT, '127.0.0.1', () => console.log('arcade server on http://127.0.0.1:' + PORT));
