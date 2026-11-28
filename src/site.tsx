import React,{useEffect,useState} from 'react';
import {ScoutMark} from './logo';
import {Archive as ArchiveIcon,ArrowRight,ArrowUpRight,Check,ChevronRight,CircleCheck,Copy,Download,Gamepad2,KeyRound,Layers,LayoutDashboard,Link2,Loader2,LogIn,Monitor,Menu,X,Play,ChevronDown,Palette,Radio,RefreshCw,ShieldCheck,SlidersHorizontal,Unplug,Users,Wifi,Zap} from 'lucide-react';
import {apiFetch,rememberToken} from './session';
import {DEFAULT_WIDGETS} from '../server/overlay';
import type {SceneId} from '../server/controls';
import {PANEL_SECTIONS,SCENE_LIST} from './panel-catalog';
import {HudStage} from './showcase';
import type {AccountView,BetaStatusView,InstallationView} from '../server/beta';
import {TournamentsCard,PublicStats} from './platform-admin';
import type {LicenceView} from '../server/licensing';
import type {PlatformSyncView} from '../server/platform-sync';
import {LauncherSyncStatus} from './operator-tools';
import type {PanelSessionView} from '../server/auth';
// The public half of SCOUT — the only pages the website serves: the landing page a tournament
// organiser finds, the application form for the closed beta, sign-in, and the download page that
// gets an approved account into the app. The owner's admin desk lives in src/platform-admin.tsx.
//
// The dashboard and the broadcast panel are deliberately NOT here. Tournaments, linked launchers,
// the launcher-code approval and every overlay setting live in the desktop app, which the Tauri
// shell opens from the local host (`/app` and `/`). The website is access, not operation.
//
// Three rules the pages keep:
//   1. Every request goes to this origin's own /api/beta/* — never to a hard-coded cloud host. The
//      host decides where accounts really live (server/beta.ts): its own JSON store, or a hosted
//      account service it proxies to. The pages cannot tell the difference, which is the point.
//   2. Nothing is faked. When there is no host behind the page (a static preview, an unreachable
//      launcher) the pages say so instead of inventing a session; the preview state is only ever
//      shown with a banner that says what it is.
//   3. The launcher download is behind the account: a pending applicant sees what they are waiting
//      for, an approved one sees the button.
export const SITE_ROUTES=['/welcome','/login','/apply','/download','/profile','/privacy','/terms'] as const;
export type SiteRoute=typeof SITE_ROUTES[number];
export const isSiteRoute=(path:string):path is SiteRoute=>(SITE_ROUTES as readonly string[]).includes(path);
// Per-page document metadata (title, description, canonical, robots). The website is an SPA, so the
// shell in index.html carries public defaults and this map updates the head per route. Private pages
// (sign-in, download, profile) are noindex: they hold account state and have nothing for a crawler.
// Tested by tests/site-public.test.ts — every site route must have an entry, and only genuinely
// public pages may say index.
export const PAGE_META:Record<SiteRoute,{title:string;description:string;robots:'index, follow'|'noindex, follow'}>={
 '/welcome':{title:'SCOUT: CS2 broadcast overlays for community tournaments',description:'Live HUD, scoreboards and between-round scenes for CS2, driven by the game and added to OBS as a browser source. Free during the closed beta.',robots:'index, follow'},
 '/apply':{title:'Apply for the closed beta — SCOUT',description:'Apply for SCOUT closed-beta access. A human reads every application; approved organisers receive a single-use email invitation.',robots:'index, follow'},
 '/login':{title:'Sign in — SCOUT',description:'Sign in to your SCOUT account, set a password from an invite, or approve a launcher link.',robots:'noindex, follow'},
 '/download':{title:'Download SCOUT — SCOUT',description:'The Windows installer for approved closed-beta accounts.',robots:'noindex, follow'},
 '/profile':{title:'Your profile — SCOUT',description:'Your SCOUT account, beta status and linked installations.',robots:'noindex, follow'},
 '/privacy':{title:'Privacy — SCOUT',description:'What SCOUT collects, what never leaves your machine, and how to get your data deleted.',robots:'index, follow'},
 '/terms':{title:'Terms — SCOUT',description:'The terms for using SCOUT and its closed beta.',robots:'index, follow'},
};
export function useDocumentMeta(meta:{title:string;description:string;robots:string}){
 useEffect(()=>{
  document.title=meta.title;
  const head=document.head;
  const setMeta=(name:string,content:string)=>{let tag=head.querySelector(`meta[name="${name}"]`);if(!tag){tag=document.createElement('meta');tag.setAttribute('name',name);head.append(tag)}tag.setAttribute('content',content)};
  setMeta('description',meta.description);setMeta('robots',meta.robots);
  let canonical=head.querySelector('link[rel="canonical"]');
  if(!canonical){canonical=document.createElement('link');canonical.setAttribute('rel','canonical');head.append(canonical)}
  canonical.setAttribute('href',location.origin+location.pathname);
 },[meta.title,meta.description,meta.robots]);
}
// Which server is answering: the venue's broadcast host, or the central website. The pages ask
// /api/surface (not the hostname in the account status — that is a machine name on both surfaces),
// so a host-only card or an /app button is never shown on the public website, where it would 404.
export function useSurface(){const [surface,setSurface]=useState<'host'|'site'|null>(null);useEffect(()=>{void fetch('/api/surface').then(r=>r.json()).then(body=>{if(body?.surface==='host'||body?.surface==='site')setSurface(body.surface)}).catch(()=>{})},[]);return surface}
// Why the account calls are not answering, when they are not. The website deployment reports its own
// reason and the applicant can only act on the one that is theirs.
export type AccountFailure='unreachable'|'network';
// Which failure the host reported: the site surface proxies /api/beta/* to the account service and
// answers `upstream-unreachable` when it cannot be dialled (a bare 502 from any gateway in between
// means the same). Anything else here is a network failure on the visitor's side (offline, DNS, a
// blocked request).
export function classifyAccountFailure(status:number,code?:string):AccountFailure{
 if(status===502||code==='upstream-unreachable') return 'unreachable';
 return 'network';
}
type BetaState={status:BetaStatusView|null;offline:boolean;loading:boolean;error:string;failure:AccountFailure|null};
function useBetaStatus(){
 const [state,setState]=useState<BetaState>({status:null,offline:false,loading:true,error:'',failure:null});
 const load=React.useCallback(async()=>{
  try{
   const res=await fetch('/api/beta/status',{headers:{Accept:'application/json'}});
   if(!res.ok){
    // The host names the cause in the body: `upstream-unreachable` means the account service is
    // down or unreachable from the site surface — try later, not something the visitor can fix.
    const body=await res.json().catch(()=>null) as {code?:string;error?:string}|null;
    setState({
     status:null,offline:true,loading:false,
     failure:classifyAccountFailure(res.status,body?.code),
     error:body?.error||`The host answered ${res.status}`,
    });
    return;
   }
   setState({status:await res.json(),offline:false,loading:false,error:'',failure:null});
  }catch(reason:any){
   // No host on this address (the marketing site served statically, or the launcher not running).
   // The pages stay readable and say so; they never pretend to be signed in.
   setState({status:null,offline:true,loading:false,failure:'network',error:reason?.message||'The SCOUT host could not be reached.'});
  }
 },[]);
 useEffect(()=>{void load()},[load]);
 return {...state,reload:load};
}
async function betaRequest(path:string,body?:unknown,method='POST'){
 const res=await fetch(path,{method,credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const payload=await res.json().catch(()=>({}) as any);
 return {ok:res.ok,status:res.status,body:payload as any};
}
function usePanelSession(){
 const [session,setSession]=useState<PanelSessionView|null>(null);
 useEffect(()=>{void (async()=>{try{const surface=await fetch('/api/surface').then(r=>r.json());if(surface.surface!=='host')return;const res=await apiFetch('/api/session');if(res.ok)setSession(await res.json())}catch{}})()},[]);
 return session;
}
const statusLabel=(status:string)=>status==='approved'?'APPROVED':status==='rejected'?'NOT APPROVED':status==='revoked'?'REVOKED':'IN REVIEW';
const statusTone=(status:string)=>status==='approved'?'ok':status==='rejected'||status==='revoked'?'bad':'warn';
// ------------------------------------------------------------------ shared chrome
function SiteBrand(){return <a className="site-brand" href="/welcome"><ScoutMark className="brand-symbol" size={26}/> scout<span className="brand-dot">®</span></a>}
export function SiteNav({account,link,onHost=false,section=''}:{account:AccountView|null;link?:InstallationView|null;onHost?:boolean;section?:string}){
 const [menuOpen,setMenuOpen]=useState(false);
 const menuId=React.useId();
 const menuRef=React.useRef<HTMLElement>(null);
 useEffect(()=>{
  if(!menuOpen)return;
  const close=(event:KeyboardEvent)=>{if(event.key==='Escape'){setMenuOpen(false);menuRef.current?.querySelector<HTMLButtonElement>('.site-menu-toggle')?.focus()}};
  const outside=(event:PointerEvent)=>{if(!menuRef.current?.contains(event.target as Node))setMenuOpen(false)};
  document.addEventListener('keydown',close);document.addEventListener('pointerdown',outside);
  return()=>{document.removeEventListener('keydown',close);document.removeEventListener('pointerdown',outside)};
 },[menuOpen]);
 return <header className="site-nav" ref={menuRef}>
  <SiteBrand/>
  <nav id={menuId} aria-label="Main navigation" className={`site-nav-links${menuOpen?' is-open':''}`} onClick={()=>setMenuOpen(false)}>
   <a href="/welcome#product">Product</a>
   <a href="/welcome#scenes">Scenes</a>
   <a href="/welcome#maps">Maps</a>
   <a href="/welcome#pricing">Pricing</a>
   <a href="/welcome#how">Setup</a>
   <a href="/welcome#faq">FAQ</a>
  </nav>
  <div className="site-nav-actions">
   {/* Phone-width labels: a nav that does not fit is a nav nobody reads. The long label is the
       desktop one; CSS swaps in the short one under 560px (see "Small screens"). */}
   {account&&<a className="site-ghost-link" href="/profile">Profile</a>}
   {account?<a className="button primary" href="/download"><Download size={14}/><span className="site-label-long">Get SCOUT</span><span className="site-label-short">Download</span></a>:<a className="site-ghost-link" href="/login"><LogIn size={13}/>Sign in</a>}
   {!account&&<a className="button primary" href="/apply"><span className="site-label-long">Join the Closed Beta</span><span className="site-label-short">Apply</span><ArrowRight size={14}/></a>}
  </div>
  <button type="button" className="site-menu-toggle" aria-expanded={menuOpen} aria-controls={menuId} aria-label={menuOpen?'Close navigation':'Open navigation'} onClick={()=>setMenuOpen(!menuOpen)}>{menuOpen?<X size={20}/>:<Menu size={20}/>}</button>
  {section&&<span className="site-nav-section">{section}</span>}
 </header>;
}
export function SiteFooter(){
 return <footer className="site-footer">
  <div className="site-footer-brand"><SiteBrand/><p>CS2 broadcast overlays for community tournaments and league nights.</p></div>
  <div className="site-footer-cols">
   <div><b>Product</b><a href="/welcome#product">What it does</a><a href="/welcome#scenes">Broadcast scenes</a><a href="/welcome#beta">Closed beta</a></div>
   <div><b>Operators</b><a href="/login">Sign in</a><a href="/download">Download</a><a href="/apply">Apply for access</a></div>
   <div><b>Account</b><a href="/profile">Your profile</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></div>
  </div>
  <div className="site-footer-legal"><span>© {new Date().getFullYear()} SCOUT</span></div>
 </footer>;
}
function OfflineBanner({children}:{children:React.ReactNode}){return <div className="site-offline"><Wifi size={14}/><span>{children}</span></div>}
// The offline message, said in terms of what the visitor can do. On the website deployment the
// account service is reached through the host's `/api/beta` proxy, so `failure` distinguishes "it
// is down" (try later) from "there is no host on this address at all" (start the launcher).
export function accountOfflineText(failure:AccountFailure|null,what:AccountNeed){
 if(failure==='unreachable') return what==='apply'
  ? 'The SCOUT account service is not answering right now, so applications cannot be submitted. Try again in a few minutes.'
  : 'The SCOUT account service is not answering right now, so signing in is not possible. Try again in a few minutes.';
 return what==='apply'
  ? 'The SCOUT host is not reachable on this address, so applications cannot be submitted right now. Start the launcher to apply, or open the host address.'
  : 'The SCOUT host is not reachable on this address, so signing in is not possible. Start the launcher (or open the host address) and try again.';
}
type AccountNeed='apply'|'signin';
function Notice({tone='bad',children}:{tone?:'bad'|'ok'|'warn';children:React.ReactNode}){return <p className={`site-notice ${tone}`} role="alert">{children}</p>}
// ------------------------------------------------------------------ landing page
// The product page's rules, in one place:
//   - it shows the product, not a drawing of it: every frame below is rendered by src/showcase,
//     which mounts the same `Hud` component the panel previews and the /obs output use;
//   - the words an operator needs before applying (Windows, CS2, OBS, no runtime to install) sit on
//     the hero call to action, in one line;
//   - the engineering detail lives further down, in "Under the hood", where the reader who wants it
//     finds it — and where it does not stand between a first-time visitor and what SCOUT looks like;
//   - the closed-beta flow is untouched: apply, a human reads it, an invite sets your password, the
//     download page hands over the installer, and the app itself is the dashboard.
const FEATURES=[
 {icon:Radio,title:'Driven by the game',body:'Scores, economy, kills and round state come straight from CS2. Nobody has to update the scoreboard by hand between rounds.'},
 {icon:Monitor,title:'A HUD that leaves room for the game',body:'Scoreboard, radar, rosters and the observed player, laid out around the action instead of on top of it.'},
 {icon:Layers,title:'Scenes for the whole show',body:'Matchup, lineups, map series, bracket, break screen, round recap, player stats and the series winner, alongside the live HUD.'},
 {icon:Palette,title:'Your colours and logos',body:'Change team names, colours, rosters and individual layers in Overlay Studio. Every output picks up the change straight away.'},
 {icon:Users,title:'Logins for the whole crew',body:'Owner, producer, designer and viewer roles, each with their own account. No more passing one admin password around the group chat.'},
 {icon:Gamepad2,title:'One installer',body:'The Windows launcher sets up the host, the panel, the overlay and the CS2 config file. You don’t need Node or any build tools.'},
];
// Whatever is in public/thumbs/site/ is what the page shows: the same nine included maps the
// broadcast scenes use, resized once for the web (see public/thumbs/README.txt). The showcase is a
// focused selection first — four tiles and a reveal — so the strip reads as a sample of the pool
// instead of a wall of nine (exported for tests/site-preview.test.ts).
export const MAP_POOL=[
 {file:'de_ancient',label:'Ancient'},
 {file:'de_anubis',label:'Anubis'},
 {file:'de_dust2',label:'Dust II'},
 {file:'de_inferno',label:'Inferno'},
 {file:'de_mirage',label:'Mirage'},
 {file:'de_nuke',label:'Nuke'},
 {file:'de_overpass',label:'Overpass'},
 {file:'de_train',label:'Train'},
 {file:'de_vertigo',label:'Vertigo'},
];
const STEPS=[
 {title:'Apply',body:'Tell us who you are and what you broadcast. The application takes about a minute.'},
 {title:'We read it',body:'Someone on the team reads every application. If it’s a fit, you get an email invite to set your password.'},
 {title:'Install SCOUT',body:'Your download page has the Windows installer. It includes the host, the dashboard, the overlay and the CS2 config file.'},
 {title:'Add it to OBS',body:'The launcher shows an 8-character code. Approve it once, then add the /obs address to OBS as a browser source.'},
];
const FAQ=[
 ['Is SCOUT free during the beta?','Yes. If we ever charge for something it will be hosted extras. The overlay itself runs on your own PC.'],
 ['Where does the match data come from?','CS2 has a built-in feature called Game State Integration that sends match data to a local address. SCOUT listens there and works out kills, rounds and economy from it.'],
 ['Do I need a second PC?','No, but it helps. The launcher runs on the observer PC and OBS can run there too. If you have a separate streaming PC, it can open the panel and the overlay over your local network.'],
 ['Does it work on FACEIT, ESEA or workshop maps?','It works anywhere CS2 runs with the config file installed, workshop maps included. A custom map needs one radar entry in the config.'],
 ['What happens to my data?','Match data, uploads and recordings stay on your PC. The website only keeps your account and the launchers you’ve linked. The privacy page has the details.'],
];
// The engineering, deliberately below the product story. Someone choosing an overlay for their cup
// needs to know it will not touch the game; someone wiring OBS at 2am needs the port and the rules.
const UNDER_THE_HOOD=[
 {icon:Radio,title:'Uses CS2’s own match feed',body:'CS2 has a built-in way to share live match data with other apps. The installer switches it on for you, and SCOUT builds every scene from it.'},
 {icon:Monitor,title:'One browser source in OBS',body:'Add SCOUT to OBS as a single 1920 × 1080 browser source. The live HUD has a transparent background, and SCOUT can switch your OBS scenes for you if you connect the two.'},
 {icon:SlidersHorizontal,title:'Radars that line up',body:'The nine included maps come with radars already lined up. For a workshop map, you set it up once in the Map radars section of the panel.'},
 {icon:Users,title:'Several people at once',body:'Everyone on the crew signs in separately. Only one person can switch scenes at a time, and you can always see who changed what.'},
 {icon:ArchiveIcon,title:'Recording and replays',body:'Record the game feed, keep round-by-round archives and preview replays. All of it is saved on the observer PC.'},
];
export function LandingPage(){
 const {status,offline,failure}=useBetaStatus();
 const surface=useSurface();
 const account=status?.account??null;
 // Host-only extras (the "served by your host" card) belong to the venue's own host, never to the
 // central website — there / and /obs are not the operator's machine and the card would mislead.
 const onHost=surface==='host'&&!offline&&!!status?.host;
 // The scene the reader picked in the tour. The frame renders it with the product's own renderer,
 // so the page never has to be updated by hand when a scene changes.
 const [scene,setScene]=useState<SceneId>('live');
 // The map showcase opens as a focused selection; the rest of the pool is one click away.
 const [showAllMaps,setShowAllMaps]=useState(false);
 const active=SCENE_LIST.find(item=>item.id===scene)??SCENE_LIST[0];
 const liveLayers=DEFAULT_WIDGETS.filter(widget=>widget.showOn.includes('live'));
 const landingRef=React.useRef<HTMLDivElement>(null);
 useEffect(()=>{
  const root=landingRef.current;
  if(!root||typeof IntersectionObserver==='undefined'||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){entry.target.classList.add('is-visible');observer.unobserve(entry.target)}},{threshold:.08});
  root.querySelectorAll('.site-section-head,.site-card,.site-step,.site-map-chip,.landing-benefit,.landing-price,.site-final').forEach((node,index)=>{
   (node as HTMLElement).style.setProperty('--reveal-delay',`${index%3*65}ms`);
   node.classList.add('reveal-ready');observer.observe(node);
  });
  return()=>observer.disconnect();
 },[]);
 // A soft light that follows the pointer across cards. Mouse only, and off for reduced motion.
 useEffect(()=>{
  const root=landingRef.current;
  if(!root||!window.matchMedia('(pointer: fine)').matches||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const move=(event:PointerEvent)=>{
   const card=(event.target as HTMLElement).closest?.('.site-card,.landing-price,.site-map-chip') as HTMLElement|null;
   if(!card)return;
   const box=card.getBoundingClientRect();
   card.style.setProperty('--mx',`${event.clientX-box.left}px`);card.style.setProperty('--my',`${event.clientY-box.top}px`);
  };
  root.addEventListener('pointermove',move,{passive:true});
  return()=>root.removeEventListener('pointermove',move);
 },[]);
 return <div className="site landing" ref={landingRef}>
  <a className="landing-skip" href="#main-content">Skip to content</a>
  <SiteNav account={status?.account??null} onHost={onHost}/>
  <main className="site-main" id="main-content" tabIndex={-1}>
   {offline&&<OfflineBanner>Account actions are unavailable: {accountOfflineText(failure,'signin')} The product pages work anyway.</OfflineBanner>}
   <section className="site-hero" aria-labelledby="hero-heading">
    <div className="landing-hero-aura" aria-hidden="true"/>
    <img className="site-hero-bg" src="/assets/cs2.png" alt="" aria-hidden="true"/>
    <div className="landing-hero-copy">
     <a className="site-eyebrow" href="/apply"><span className="site-eyebrow-dot"/>CLOSED BETA<span className="eyebrow-divider"/><span>Applications open</span><ArrowUpRight size={13}/></a>
     <h1 className="site-h1" id="hero-heading">A proper CS2 broadcast, <em>run from one PC.</em></h1>
     <p className="site-lead">SCOUT reads the match straight from CS2 and turns it into a live HUD, scoreboards and between-round scenes that you add to OBS as a browser source. We built it for community cups and league nights, where the production crew is often two people.</p>
     <div className="site-cta">
      {account?.status==='approved'
       ?<a className="button primary" href="/download">Get SCOUT<ArrowUpRight size={17}/></a>
       :account
        ?<a className="button primary" href="/download">Your download page<ArrowUpRight size={17}/></a>
        :<a className="button primary" href="/apply">Join the Closed Beta<ArrowUpRight size={17}/></a>}
      <a className="button landing-demo-link" href="#scenes"><span className="landing-play"><Play size={12} fill="currentColor"/></span>Explore the live demo</a>
     </div>
     <p className="site-requirements"><span className="site-requirements-label">YOU’LL NEED</span>Windows 10 or 11 (x64)<i/>Counter-Strike 2<i/>OBS Studio<br/>The installer bundles its own runtime. Free during the beta.</p>
    </div>
    <div className="site-hero-art">
     <div className="landing-preview-bar"><span className="landing-window-dots"><i/><i/><i/></span><span><ScoutMark size={12}/>SCOUT BROADCAST</span><span className="landing-live"><span/>SAMPLE MATCH</span></div>
     <HudStage scene="live" className="site-stage site-stage-hero"/>
     <div className="landing-preview-bottom"><span><span className="status-dot"/>OBS browser source</span><span>1920 × 1080 <span className="landing-preview-separator">/</span> Sample match <Check size={12}/></span></div>
     <p className="site-stage-caption">The actual overlay, playing a sample match.</p>
    </div>
   </section>
   <section className="landing-proof" aria-label="Works with">
    <p>WORKS WITH</p>
    <div className="landing-integrations"><span><i className="landing-brand-icon landing-cs2-icon" aria-hidden="true"/>Counter-Strike 2</span><span><i className="landing-brand-icon landing-obs-icon" aria-hidden="true"/>OBS Studio</span><span><i className="landing-brand-icon landing-streamlabs-icon" aria-hidden="true"/>Streamlabs</span><span><svg width="23" height="23" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M2 3l9-1v9H2zm11-1l9-1v10h-9zM2 13h9v9l-9-1zm11 0h9v10l-9-1z"/></svg>Windows</span><span><Radio size={25}/>Game State Integration</span></div>
    <PublicStats/>
   </section>
   <section className="site-section" id="product">
    <img loading="lazy" decoding="async" className="site-scatter scatter-ak" src="/assets/ak-47.png" alt="" aria-hidden="true"/>
    <div className="site-section-head"><h2>What you get</h2><p>The overlay, the scenes between rounds and a panel to run it all from. It’s one app instead of five browser tabs and a spreadsheet.</p></div>
    <div className="site-grid">{FEATURES.map(({icon:Icon,title,body})=><article className="site-card" key={title}><span className="site-card-icon"><Icon size={17}/></span><h3>{title}</h3><p>{body}</p></article>)}</div>
    <div className="site-layers">
     <b>On the live HUD</b>
     <div className="site-layer-chips">{liveLayers.map(widget=><span key={widget.id}>{widget.name}</span>)}</div>
     <small>{liveLayers.length} layers. Each one can be switched on or off from the panel mid-round, and four of them only show up when the game needs them.</small>
    </div>
   </section>
   <section className="site-section site-tour" id="scenes">
    <img loading="lazy" decoding="async" className="site-scatter scatter-t" src="/assets/cs2-t.png" alt="" aria-hidden="true"/>
    <div className="site-section-head"><h2>The scenes</h2><p>Click through them below. This is the real renderer running on sample data, so it’s exactly what goes out on stream.</p></div>
    <div className="site-tour-grid">
     <div className="site-tour-frame" aria-label={`${active.title} scene preview`}>
      <HudStage scene={active.id} className="site-stage site-stage-tour"/>
      <div className="site-stage-caption">
       <span className="site-stage-badge" role="status" aria-live="polite" aria-atomic="true"><span className="status-dot"/>ON AIR · {active.title.toUpperCase()}</span>
       <span>{active.desc}. {active.id==='live'?'Sample match data.':'Sample event configuration.'}</span>
      </div>
     </div>
     <div className="site-scene-picker" role="group" aria-label="Broadcast scenes">
      {SCENE_LIST.map(({id,title,desc,icon:Icon})=><button key={id} type="button" aria-pressed={id===active.id} className={id===active.id?'chosen':''} onClick={()=>setScene(id)}>
       <span className="site-scene-pick-icon"><Icon size={15}/></span>
       <span className="site-scene-pick-text"><b>{title}</b><small>{desc}</small></span>
       <ChevronRight size={14}/>
      </button>)}
     </div>
    </div>
   </section>
   <section className="site-section site-maps" id="maps">
    <img loading="lazy" decoding="async" className="site-scatter scatter-m4" src="/assets/m4a1-s.png" alt="" aria-hidden="true"/>
    <div className="site-section-head"><h2>Nine maps included</h2><p>Each one comes with artwork for the map scenes and a calibrated radar. Adding a workshop map takes one config entry.</p></div>
    <div className={`site-map-strip${showAllMaps?' expanded':''}`}>{MAP_POOL.slice(0,showAllMaps?MAP_POOL.length:4).map(map=><figure className="site-map-chip" key={map.file}>
     <img src={`/thumbs/site/${map.file}.jpg`} alt={`${map.label} overview`} width={640} height={360} loading="lazy" decoding="async"/>
     <figcaption><span><small>{map.file.replace('de_','DE / ').toUpperCase()}</small><b>{map.label}</b></span><ArrowUpRight size={17}/></figcaption>
    </figure>)}</div>
    <button type="button" className="site-maps-more" aria-expanded={showAllMaps} onClick={()=>setShowAllMaps(value=>!value)}>
     {showAllMaps?'Show fewer maps':`Show all ${MAP_POOL.length===9?'nine':MAP_POOL.length} maps`}<ChevronDown size={14} className={showAllMaps?'flipped':''}/>
    </button>
   </section>
   <section className="site-section landing-benefits" id="benefits">
    <div className="site-section-head"><h2>Who it’s for</h2><p>Mostly people running community events, usually with fewer hands than they’d like.</p></div>
    <div className="landing-benefit-grid">
     <article className="landing-benefit"><div className="landing-benefit-art"><img src="/assets/cs2-t.png" alt="" loading="lazy" decoding="async"/><span>01 / ORGANISERS</span></div><h3>Make it look like your event</h3><p>Your team names, colours and bracket on every scene, from the first matchup to the trophy.</p><a href="/apply">Apply for the beta<ArrowUpRight size={15}/></a></article>
     <article className="landing-benefit"><div className="landing-benefit-art"><img src="/assets/cs2-ct.png" alt="" loading="lazy" decoding="async"/><span>02 / OBSERVERS</span></div><h3>Watch the game, not the overlay</h3><p>The HUD updates from the game on its own, so the observer can stay on the action.</p><a href="#scenes">See the scenes<ArrowUpRight size={15}/></a></article>
     <article className="landing-benefit"><div className="landing-benefit-art"><img src="/assets/oceanic-deag.png" alt="" loading="lazy" decoding="async"/><span>03 / BROADCAST CREWS</span></div><h3>Split the work</h3><p>One shared panel with separate roles, so the producer and the designer can work at the same time without getting in each other’s way.</p><a href="#how">How it works<ArrowUpRight size={15}/></a></article>
    </div>
   </section>
   <section className="site-section" id="beta">
    <div className="site-section-head"><h2>How to get in</h2><p>We’re letting people in a few at a time, so we can actually help each of them get set up.</p></div>
    <div className="site-steps">{STEPS.map((step,index)=><div className="site-step" key={step.title}><span className="site-step-index">{index+1}</span><b>{step.title}</b><p>{step.body}</p></div>)}</div>
    <div className="site-beta-cta">
     <div><b>Applications are open</b><p>You’ll need Windows 10 or 11 (64-bit), CS2, and OBS if you’re streaming.</p></div>
     <a className="button primary" href="/apply">Start your application<ArrowRight size={14}/></a>
    </div>
   </section>
   <section className="site-section site-how" id="how">
    <img loading="lazy" decoding="async" className="site-scatter scatter-ct" src="/assets/cs2-ct.png" alt="" aria-hidden="true"/>
    <div className="site-section-head"><h2>Setting it up</h2><p>What to expect when you install SCOUT on the observer PC.</p></div>
    <div className="site-how-grid">{UNDER_THE_HOOD.map(({icon:Icon,title,body})=><article className="site-card" key={title}><span className="site-card-icon"><Icon size={17}/></span><h3>{title}</h3><p>{body}</p></article>)}</div>
    <div className="site-panel-map">
     <div><b>Inside the operator panel</b><p>Everything you need on match day is in one place.</p></div>
     <div className="site-panel-chips">{PANEL_SECTIONS.filter(section=>!section.ownerOnly).map(({name,icon:Icon})=><span key={name}><Icon size={13}/>{name}</span>)}</div>
    </div>
   </section>
   {onHost&&<section className="site-section site-host-card">
    <div className="site-host-left"><span className="site-host-pill"><span className="status-dot"/>SCOUT IS RUNNING</span><b>You’re viewing this from your own SCOUT install</b><p>Jump straight into the panel, or open the overlay to check how it looks.</p></div>
    <div className="site-host-actions"><a className="button" href="/">Open the operator panel<ArrowUpRight size={14}/></a><a className="button" href="/obs" target="_blank" rel="noreferrer">Preview the overlay<ArrowUpRight size={14}/></a></div>
   </section>}
   <section className="site-section landing-pricing" id="pricing">
    <div className="site-section-head"><h2>Free during the beta</h2><p>We’re not charging anything while SCOUT is in closed beta. In return, we’d like to hear what breaks and what’s missing after your events.</p></div>
    <article className="landing-price"><div className="landing-price-top"><span>SCOUT CLOSED BETA</span><span className="landing-price-badge">EARLY ACCESS</span></div><div className="landing-price-value">€0<span>/ during closed beta</span></div><p>Everything that’s built so far.</p><ul>{['Live HUD + eight full-canvas scenes','Overlay Studio & team customisation','Nine included maps & calibrated radars','Multi-operator roles & local recording','Windows launcher with bundled runtime'].map(item=><li key={item}><Check size={16}/>{item}</li>)}</ul><a className="button primary" href="/apply">Apply for free access<ArrowUpRight size={16}/></a><small>Human-reviewed applications. Access by invitation.<br/>No paid plans are currently offered.</small></article>
   </section>
   <section className="site-section" id="faq">
    <div className="site-section-head"><h2>FAQ</h2><p>Something we didn’t cover? Ask in your application and we’ll answer it.</p></div>
    <div className="site-faq">{FAQ.map(([question,answer])=><details key={question}><summary>{question}<ChevronRight size={15}/></summary><p>{answer}</p></details>)}</div>
   </section>
   <section className="site-final">
    <img loading="lazy" decoding="async" className="site-scatter scatter-de" src="/assets/oceanic-deag.png" alt="" aria-hidden="true"/>
    <h2>Running a tournament <em>soon?</em></h2>
    <p>Send us an application and tell us a bit about your event.</p>
    <div className="site-cta center"><a className="button primary" href="/apply">Apply for the closed beta<ArrowRight size={14}/></a><a className="button" href="/login">I already have an account</a></div>
   </section>
  </main>
  <SiteFooter/>
 </div>;
}
// ------------------------------------------------------------------ apply
const EVENT_OPTIONS=['One-off event','Monthly','Every week','League season','Something else'];
export type ApplicationForm={name:string;email:string;organisation:string;country:string;useCase:string;events:string};
// Client-side twin of the server's hard checks (server/beta.ts apply(): name ≥ 2, email shaped).
// The server stays authoritative; this only keeps an empty form from bouncing with a round trip.
// Unit-tested in tests/site-public.test.ts so the two cannot drift on the fields that matter.
export function validateApplication(form:ApplicationForm):Partial<Record<keyof ApplicationForm,string>>{
 const errors:Partial<Record<keyof ApplicationForm,string>>={};
 if(form.name.trim().length<2) errors.name='Enter the name we should put on the application.';
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) errors.email='Enter a valid email address — the invite link goes there.';
 return errors;
}
export function ApplyPage(){
 const {status,offline,failure,reload}=useBetaStatus();
 const [form,setForm]=useState<ApplicationForm>({name:'',email:'',organisation:'',country:'',useCase:'',events:EVENT_OPTIONS[1]});
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [fieldErrors,setFieldErrors]=useState<Partial<Record<keyof ApplicationForm,string>>>({});
 const [done,setDone]=useState<{email:string}|null>(null);
 const set=(key:keyof typeof form)=>(event:React.ChangeEvent<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>)=>{setForm(current=>({...current,[key]:event.target.value}));if(fieldErrors[key])setFieldErrors(current=>({...current,[key]:undefined}))};
 async function submit(event:React.FormEvent){
  event.preventDefault();
  const errors=validateApplication(form);
  setFieldErrors(errors);
  if(Object.keys(errors).length){setError('Check the highlighted fields and try again.');return}
  setBusy(true);setError('');
  const result=await betaRequest('/api/beta/apply',form);
  setBusy(false);
  if(!result.ok){
   // Rate limiting, a dead service and a rejected form are three different things and each gets
   // its own words — one generic "failed" leaves the applicant with nothing to do next.
   setError(result.status===429
    ? 'Too many applications from this connection. Wait about an hour and try again.'
    : result.status>=500
     ? 'The account service had a problem, so your application was not sent. Try again shortly.'
     : result.body?.error||'The application could not be sent. Try again.');
   return;
  }
  setDone({email:result.body.application.email});
 }
 const account=status?.account??null;
 const errorId=(key:keyof ApplicationForm)=>fieldErrors[key]?`apply-${key}-error`:undefined;
 return <div className="site landing site-inner">
  <SiteNav account={account} onHost={!offline&&!!status?.host}/>
  <main className="site-main site-narrow">
   {offline&&<OfflineBanner>{accountOfflineText(failure,'apply')}</OfflineBanner>}
   <div className="site-page-head">
    <span className="site-section-eyebrow">CLOSED BETA</span>
    <h1>Apply for access</h1>
    <p>Tell us who you are and what you broadcast. A reviewer reads every application. If approved, you will receive a single-use invitation by email to create your account.</p>
   </div>
   {done?<section className="site-card site-done">
    <span className="site-done-mark"><CircleCheck size={22}/></span>
    <h2>Application received</h2>
    <p>We have <b>{done.email}</b> on the list. If your application is approved, a single-use invitation will be emailed to that address. Until then, nothing else is needed from you.</p>
    <div className="site-cta"><a className="button" href="/welcome">Back to the overview</a><a className="button primary" href="/login">Go to sign in<ArrowRight size={14}/></a></div>
   </section>:account?<section className="site-card site-done">
    <h2>You already have an account</h2>
    <p>Signed in as <b>{account.email}</b> — {statusLabel(account.status).toLowerCase()}.</p>
    <div className="site-cta"><a className="button primary" href="/download">Get SCOUT<ArrowRight size={14}/></a></div>
   </section>:<div className="site-apply-grid">
    <form className="site-card site-form" onSubmit={submit} noValidate>
     <label className="field"><span>YOUR NAME</span><input value={form.name} onChange={set('name')} placeholder="Who should we talk to?" autoComplete="name" required minLength={2} aria-invalid={fieldErrors.name?true:undefined} aria-describedby={errorId('name')}/>{fieldErrors.name&&<small className="field-error" id="apply-name-error">{fieldErrors.name}</small>}</label>
     <label className="field"><span>EMAIL</span><input type="email" value={form.email} onChange={set('email')} placeholder="you@organisation.gg" autoComplete="email" required aria-invalid={fieldErrors.email?true:undefined} aria-describedby={errorId('email')}/>{fieldErrors.email&&<small className="field-error" id="apply-email-error">{fieldErrors.email}</small>}</label>
     <div className="site-form-row">
      <label className="field"><span>TEAM OR ORGANISATION</span><input value={form.organisation} onChange={set('organisation')} placeholder="Optional"/></label>
      <label className="field"><span>COUNTRY</span><input value={form.country} onChange={set('country')} placeholder="Optional"/></label>
     </div>
     <label className="field"><span>HOW OFTEN DO YOU BROADCAST?</span><select value={form.events} onChange={set('events')}>{EVENT_OPTIONS.map(option=><option key={option} value={option}>{option}</option>)}</select></label>
     <label className="field"><span>WHAT WILL YOU BROADCAST?</span><textarea rows={4} value={form.useCase} onChange={set('useCase')} placeholder="Leagues, qualifiers, community cups, LANs…" aria-describedby="apply-usecase-hint"/><small className="field-hint" id="apply-usecase-hint">Optional, but a sentence about your events helps us review faster.</small></label>
     <button className="button primary wide" type="submit" disabled={busy||offline} aria-busy={busy||undefined}>{busy?<><Loader2 className="spin" size={15}/>Sending…</>:<>Send application<ArrowRight size={14}/></>}</button>
     {error&&<Notice>{error}</Notice>}
     <p className="site-fineprint">By sending, you agree to the <a href="/terms">Terms</a> and the <a href="/privacy">Privacy policy</a>. We only use this to review your application and to reach you about the beta. No newsletter, no resale.</p>
    </form>
    <aside className="site-apply-aside">
     <div className="site-card"><h3>What happens next</h3><ol className="site-ol"><li>Someone on the team reads it.</li><li>Approved applicants get a one-time invite link.</li><li>The link sets your password and opens your download page.</li><li>Install SCOUT and you’re ready for your first match.</li></ol></div>
     <div className="site-card"><h3>What you need</h3><ul className="site-ul"><li>Windows 10 or 11, 64-bit</li><li>Counter-Strike 2 on the same machine</li><li>OBS Studio, if you’re streaming</li><li>Nothing else. The installer brings everything it needs.</li></ul></div>
     {offline&&<button className="site-reload" onClick={()=>void reload()}><RefreshCw size={13}/>Try again</button>}
    </aside>
   </div>}
  </main>
  <SiteFooter/>
 </div>;
}
// ------------------------------------------------------------------ login
// Two doors, one page: the SCOUT account (the website) and the panel token (this machine's host).
// The device-approval flow lands here too — an invite link, or a launcher code — so an operator who
// is not signed in yet meets one screen instead of three.
export function LoginPage({linkCode,invite,reset,next='/profile'}:{linkCode?:string;invite?:string;reset?:string;next?:string}){
 const {status,offline,failure,reload}=useBetaStatus();
 const session=usePanelSession();
 const account=status?.account??null;
 const [email,setEmail]=useState('');const [password,setPassword]=useState('');
 const [invitePassword,setInvitePassword]=useState('');const [inviteConfirm,setInviteConfirm]=useState('');
 const [recoveryPassword,setRecoveryPassword]=useState('');const [recoveryConfirm,setRecoveryConfirm]=useState('');
 const [recover,setRecover]=useState(false);
 const [token,setToken]=useState('');
 const [busy,setBusy]=useState<string|null>(null);
 const [error,setError]=useState('');const [notice,setNotice]=useState('');
 const [code,setCode]=useState(linkCode??'');
 async function signIn(event:React.FormEvent){
  event.preventDefault();setBusy('account');setError('');
  const result=await betaRequest('/api/beta/login',{email,password});
  setBusy(null);
  if(!result.ok){setError(result.body?.error||'Sign-in failed.');return}
  // A launcher code in the URL is approved with the session that sign-in just created, so the
  // operator does not have to reload and type it twice. The website and the app's login both work.
  if(code){
   const approval=await betaRequest('/api/beta/device/approve',{userCode:code});
   if(!approval.ok){setError(approval.body?.error||'Signed in, but that launcher code could not be approved.');return}
   setNotice('Launcher linked to your account.');
   setTimeout(()=>location.assign(next),600);
   return;
  }
  location.assign(next);
 }
 async function activate(event:React.FormEvent){
  event.preventDefault();setError('');
  if(invitePassword!==inviteConfirm){setError('The two passwords do not match.');return}
  setBusy('invite');
  const result=await betaRequest('/api/beta/activate',{invite,password:invitePassword});
  setBusy(null);
  if(!result.ok){setError(result.body?.error||'That invite could not be used.');return}
  setNotice('Password set. Welcome aboard.');
  setTimeout(()=>location.assign(next),600);
 }
 async function requestRecovery(event:React.FormEvent){
  event.preventDefault();setBusy('recovery');setError('');
  const result=await betaRequest('/api/beta/password-recovery',{email});setBusy(null);
  if(!result.ok){setError(result.body?.error||'Password recovery is temporarily unavailable.');return}
  setNotice(result.body?.message||'If that address belongs to an activated account, a reset email will be sent.');setRecover(false);
 }
 async function completeRecovery(event:React.FormEvent){
  event.preventDefault();setError('');
  if(recoveryPassword!==recoveryConfirm){setError('The two passwords do not match.');return}
  setBusy('reset');
  const result=await betaRequest('/api/beta/password-recovery/complete',{token:reset,password:recoveryPassword});setBusy(null);
  if(!result.ok){setError(result.body?.error||'That reset link could not be used.');return}
  setNotice('Your password has been reset. Sign in with your new password.');
  setTimeout(()=>location.assign('/login'),800);
 }
 async function unlockWithToken(event:React.FormEvent){
  event.preventDefault();setBusy('token');setError('');
  try{
   const res=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token.trim()})});
   const body=await res.json().catch(()=>({}) as any);
   if(!res.ok) throw Error(body?.error||'That token didn’t work. Check it and try again.');
   // Keep the header fallback as well as the cookie: a panel in a frame, or a browser that drops
   // third-party storage, still has to be able to drive the broadcast.
   rememberToken(token.trim());
   location.assign('/');
  }catch(reason:any){setError(reason?.message||'That token didn’t work. Check it and try again.')}
  finally{setBusy(null)}
 }
 async function approveLauncher(allow:boolean){
  setBusy('device');setError('');
  const result=await betaRequest(`/api/beta/device/${allow?'approve':'deny'}`,{userCode:code});
  setBusy(null);
  if(!result.ok){setError(result.body?.error||'That code could not be used.');return}
  setNotice(allow?'Launcher linked to your account.':'Launcher request refused.');
  setTimeout(()=>location.assign(next),700);
 }
 const localSession=session?.local&&session.authenticated;
 return <div className="site landing site-inner">
  <SiteNav account={account} onHost={!offline&&!!status?.host}/>
  <main className="site-main site-narrow">
   {offline&&<OfflineBanner>{accountOfflineText(failure,'signin')}</OfflineBanner>}
   <div className="site-page-head">
    <span className="site-section-eyebrow">{invite?'INVITE':reset?'PASSWORD RESET':linkCode?'LAUNCHER LINK':'SIGN IN'}</span>
    <h1>{invite?'Set your password':reset?'Reset your password':linkCode?'Approve a launcher':'Welcome back'}</h1>
    <p>{invite?'Your application was approved. Choose a password for your SCOUT account. This invite link only works once and expires soon.'
      :reset?'Choose a new password. This single-use reset link expires soon.'
      :linkCode?'A launcher is asking to be linked to your account. Confirm the code you see in the launcher window, then approve it.'
      :'Sign in to manage your profile, download SCOUT and approve a launcher. Broadcast controls live in the desktop app.'}</p>
   </div>
   <div className="site-login-grid">
    <div className="site-card site-form">
     {notice&&<Notice tone="ok">{notice}</Notice>}
     {error&&<Notice>{error}</Notice>}
     {reset?<form onSubmit={completeRecovery}>
      <label className="field"><span>NEW PASSWORD</span><input type="password" value={recoveryPassword} onChange={event=>setRecoveryPassword(event.target.value)} autoFocus autoComplete="new-password" placeholder="at least 10 characters"/></label>
      <label className="field"><span>REPEAT PASSWORD</span><input type="password" value={recoveryConfirm} onChange={event=>setRecoveryConfirm(event.target.value)} autoComplete="new-password"/></label>
      <button className="button primary wide" type="submit" disabled={busy==='reset'}>{busy==='reset'?<><Loader2 className="spin" size={15}/>Resetting…</>:<>Reset password<ArrowRight size={14}/></>}</button>
     </form>:invite?<form onSubmit={activate}>
      <label className="field"><span>NEW PASSWORD</span><input type="password" value={invitePassword} onChange={event=>setInvitePassword(event.target.value)} autoFocus autoComplete="new-password" placeholder="at least 10 characters"/></label>
      <label className="field"><span>REPEAT PASSWORD</span><input type="password" value={inviteConfirm} onChange={event=>setInviteConfirm(event.target.value)} autoComplete="new-password"/></label>
      <button className="button primary wide" type="submit" disabled={busy==='invite'}>{busy==='invite'?<><Loader2 className="spin" size={15}/>Saving…</>:<>Set password<ArrowRight size={14}/></>}</button>
     </form>:recover?<form onSubmit={requestRecovery}>
      <p className="site-fineprint">Enter the email on your SCOUT account. If it is eligible, we will send a single-use reset link.</p>
      <label className="field"><span>EMAIL</span><input type="email" value={email} onChange={event=>setEmail(event.target.value)} autoFocus autoComplete="email" placeholder="you@organisation.gg"/></label>
      <button className="button primary wide" type="submit" disabled={busy==='recovery'||offline}>{busy==='recovery'?<><Loader2 className="spin" size={15}/>Sending…</>:<>Send reset email<ArrowRight size={14}/></>}</button>
      <button className="button wide" type="button" onClick={()=>setRecover(false)}>Back to sign in</button>
     </form>:account?<div className="site-signed-in">
      <span className="site-done-mark"><CircleCheck size={20}/></span>
      <h3>Already signed in</h3>
      <p>{account.email} · {statusLabel(account.status)}</p>
      {code?<div className="site-device">
       <label className="field"><span>LAUNCHER CODE</span><input value={code} onChange={event=>setCode(event.target.value.toUpperCase())} placeholder="ABCD-EFGH"/></label>
       <div className="site-cta"><button className="button primary" onClick={()=>void approveLauncher(true)} disabled={busy==='device'}><Link2 size={14}/>Link this launcher</button><button className="button" onClick={()=>void approveLauncher(false)} disabled={busy==='device'}><Unplug size={14}/>Refuse</button></div>
      </div>:<div className="site-cta"><a className="button primary" href={next}>Get SCOUT<ArrowRight size={14}/></a></div>}
     </div>:<form onSubmit={signIn}>
      {code&&<div className="site-device-code"><small>LAUNCHER WAITING</small><b>{code}</b><span>Sign in to approve it.</span></div>}
      <label className="field"><span>EMAIL</span><input type="email" value={email} onChange={event=>setEmail(event.target.value)} autoFocus autoComplete="username" placeholder="you@organisation.gg"/></label>
      <label className="field"><span>PASSWORD</span><input type="password" value={password} onChange={event=>setPassword(event.target.value)} autoComplete="current-password"/></label>
      <button className="button primary wide" type="submit" disabled={busy==='account'||offline}>{busy==='account'?<><Loader2 className="spin" size={15}/>Signing in…</>:<><LogIn size={15}/>Sign in</>}</button>
      {code&&<button className="button wide" type="button" onClick={()=>void approveLauncher(true)} disabled={busy==='device'}><Link2 size={14}/>Link launcher {code}</button>}
      <p className="site-fineprint">No account yet? <a className="site-link" href="/apply">Apply for the closed beta</a>.{' '}<button type="button" className="site-link-button" onClick={()=>{setRecover(true);setError('');setNotice('')}}>Forgot your password?</button></p>
     </form>}
    </div>
    <aside className="site-login-aside">
     {session&&<div className="site-card">
      <h3><KeyRound size={15}/>This machine</h3>
      <p className="site-card-lead">To open the panel from another computer, enter the panel token SCOUT shows when it starts.</p>
      {localSession?<div className="site-cta"><a className="button primary wide" href="/">You are on the operator machine — open the panel</a></div>
       :session?.authenticated?<div className="site-cta"><a className="button primary wide" href="/">Panel unlocked — open it</a></div>
       :<form onSubmit={unlockWithToken}>
        <label className="field"><span>PANEL TOKEN</span><input type="password" value={token} onChange={event=>setToken(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Paste your panel token"/></label>
        <button className="button wide" type="submit" disabled={busy==='token'||offline}>{busy==='token'?<><Loader2 className="spin" size={15}/>Checking…</>:<><KeyRound size={14}/>Unlock the panel</>}</button>
       </form>}
      <p className="site-fineprint">{session?.remoteEnabled===false?'Remote access is turned off, so the panel only opens on the observer PC.':'On the observer PC itself, you don’t need a token.'}</p>
     </div>}
     <div className="site-card">
      <h3><Link2 size={15}/>Linking a launcher</h3>
      <p className="site-card-lead">Open SCOUT and choose <b>Launcher link</b> in the panel sidebar to get an 8-character code. Sign in here and approve that code. The launcher turns green a few seconds later.</p>
      {offline&&<button className="site-reload" onClick={()=>void reload()}><RefreshCw size={13}/>Try again</button>}
     </div>
    </aside>
   </div>
  </main>
  <SiteFooter/>
 </div>;
}
// ------------------------------------------------------------------ dashboard
// ------------------------------------------------------------------ download
// The website's last account page. It exists for one reason: a freshly approved operator has no app
// yet, so the installer has to be reachable somewhere. Everything after the install — tournaments,
// linked launchers, the launcher code, every overlay setting — lives in the app, not here.
export function DownloadPage(){
 const {status,offline,loading,failure}=useBetaStatus();
 const surface=useSurface();
 const account=status?.account??null;
 return <div className="site landing site-inner">
  <SiteNav account={account} onHost={!offline&&!!status?.host}/>
  <main className="site-main site-narrow">
   {offline&&<OfflineBanner>{accountOfflineText(failure,'signin')}</OfflineBanner>}
   <div className="site-page-head">
    <span className="site-section-eyebrow">GET SCOUT</span>
    <h1>Download the app</h1>
    <p>One installer for Windows with everything included. Once it’s installed, your panel, overlays and settings all live in the app.</p>
   </div>
   {loading?<p className="site-loading"><Loader2 className="spin" size={16}/>Checking your account…</p>
    :!account?<section className="site-card site-done">
      <span className="site-card-icon"><Download size={17}/></span>
      <h2>Sign in to download</h2>
      <p>Downloads are open to approved beta accounts. Sign in, or apply if you haven’t yet.</p>
      <div className="site-cta"><a className="button primary" href="/login">Sign in<ArrowRight size={14}/></a><a className="button" href="/apply">Apply for access</a></div>
     </section>
    :<div className="site-dash-grid">
      <DownloadCard account={account} download={status?.download??null}/>
      <section className="site-card site-next">
       <span className="site-card-icon"><LayoutDashboard size={17}/></span>
       <h3>What happens after the install</h3>
       <ul className="site-ul">
        <li>SCOUT opens on its dashboard, with your account and tournaments.</li>
        <li>Teams, maps, scenes, OBS and Overlay Studio are all in the app.</li>
        <li>Come back to this website for updates and to manage your account.</li>
       </ul>
       {/* /app only exists on the venue host; on the public website it would 404, so the link is
           shown only when this page is served by a host. */}
       {surface==='host'&&<div className="site-cta"><a className="button primary" href="/app">Open the app dashboard<ArrowUpRight size={14}/></a></div>}
      </section>
      {account.status!=='approved'&&<section className="site-card">
       <h3>Your account is {statusLabel(account.status).toLowerCase()}</h3>
       <p className="site-card-lead">{account.status==='pending'?'The download opens the moment your application is approved. Nothing else is needed from you.':account.status==='revoked'?'This account’s access was removed. Get in touch with us if you think that’s a mistake.':'This account was not approved for the closed beta.'}</p>
      </section>}
      <p className="site-fineprint site-dash-foot">Signed in as {account.email}.</p>
     </div>}
  </main>
  <SiteFooter/>
 </div>;
}
// Old bookmarks and the launcher's pre-refactor verification links still point at /dashboard. The
// page explains where the desk went instead of quietly showing the operator panel.
export function MovedDashboardPage(){
 useDocumentMeta({title:'Your dashboard is in the app · SCOUT',description:'The dashboard now lives in the installed SCOUT app.',robots:'noindex, follow'});
 return <div className="site landing site-inner">
  <SiteNav account={null}/>
  <main className="site-main site-narrow">
   <div className="site-page-head">
    <span className="site-section-eyebrow">DASHBOARD</span>
    <h1>Your dashboard lives in the app</h1>
    <p>Tournaments and broadcast settings now live in the SCOUT app. Your account and downloads are still here on the website.</p>
   </div>
   <section className="site-card site-done">
    <span className="site-card-icon"><Monitor size={17}/></span>
    <h2>Open SCOUT on the observer machine</h2>
    <p>SCOUT opens straight to your dashboard. Haven’t installed it yet? Grab it from your download page.</p>
    <div className="site-cta"><a className="button primary" href="/download">Download the app<Download size={14}/></a><a className="button" href="/profile">My profile</a></div>
   </section>
  </main>
  <SiteFooter/>
 </div>;
}
// The download gate is the one thing the closed beta actually enforces, so it is its own component:
// what the download page shows depends only on the account's status, and a test can render both states.
export function DownloadCard({account,download}:{account:AccountView;download:BetaStatusView['download']}){
 return <section className={`site-card site-download ${account.status==='approved'?'':'locked'}`}>
  <span className="site-card-icon"><Download size={17}/></span>
  <h3>Download the launcher</h3>
  {account.status==='approved'?<>
   <p className="site-card-lead">The panel, the overlays and the CS2 setup in a single Windows installer. Nothing else to install.</p>
   <div className="site-download-meta">
    <span>WINDOWS 10/11 · x64</span><span>{download?.version||'SCOUT-Setup.exe'}</span><span>INSTALLS PER USER</span>
   </div>
   <a className="button primary wide" href={download?.url||'#'} target="_blank" rel="noreferrer"><Download size={15}/>Download for Windows</a>
   {download?.notes&&<p className="site-fineprint">{download.notes}</p>}
   <p className="site-fineprint">The installer finds your CS2 folder and sets it up for you. Your teams, uploads and recordings are kept separately, so updates never touch them.</p>
  </>:<>
   <p className="site-card-lead">{account.status==='rejected'?'The download opens for approved organisers. This application was not approved for the closed beta.':'The download unlocks as soon as your application is approved.'}</p>
   <div className="site-download-meta locked"><span>STATUS: {statusLabel(account.status)}</span></div>
   <button className="button wide" disabled><Download size={15}/>Available after approval</button>
  </>}
 </section>;
}

// ------------------------------------------------------------------ the panel's own card
// The launcher side of the link, where the operator actually sees the code: a small card in the
// panel sidebar. It polls, so the moment the code is approved in the app (or on /login) the card
// turns into the linked account without anyone refreshing anything.
export function LauncherLinkCard(){
 const [state,setState]=useState<{mode:string;link:InstallationView;sync?:PlatformSyncView}|null>(null);
 const [licence,setLicence]=useState<LicenceView|null>(null);
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 const load=React.useCallback(async()=>{
  try{
   const res=await apiFetch('/api/beta/link');if(res.ok)setState(await res.json());
   // The licence answer rides along: this card is where an operator looks when a launcher will not
   // start, so "not entitled" has to be visible here and not only in the Operations tab.
   const licenceRes=await apiFetch('/api/beta/license');if(licenceRes.ok)setLicence(await licenceRes.json());
  }catch{}
 },[]);
 useEffect(()=>{void load();const timer=setInterval(()=>void load(),8000);return()=>clearInterval(timer)},[load]);
 async function start(){
  setBusy(true);setError('');
  const res=await apiFetch('/api/beta/link/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
  const body=await res.json().catch(()=>({}) as any);
  setBusy(false);
  if(!res.ok){setError(body?.error||'Could not start a link.');return}
  void load();
 }
 async function unlink(){
  setBusy(true);setError('');
  const res=await apiFetch('/api/beta/link/unlink',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
  setBusy(false);
  if(!res.ok){setError('Could not unlink this installation.');return}
  void load();
 }
 async function applyPlatformConfig(){
  if(!window.confirm('Replace the live match config with the latest platform version? Local roster/map/bracket edits will be replaced. Radar, layout and overlay are unchanged.'))return;
  setBusy(true);setError('');
  try{
   const res=await apiFetch('/api/beta/link/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
   const body=await res.json().catch(()=>({}));
   if(!res.ok)setError(body.error||'Could not apply the platform config.');
   await load();
  }catch{setError('The host could not be reached. Your local config is unchanged.')}
  finally{setBusy(false)}
 }
 const link=state?.link;
 if(!link) return null;
 if(link.linked) return <div className="launcher-link linked">
  <span className="launcher-link-head"><Link2 size={13}/>LAUNCHER LINKED</span>
  <b>{link.email}</b>
  <small>{link.displayName||'SCOUT account'} · {"device "}{link.deviceId?.slice(0,6)||'—'}</small>
  <button className="mini-button" onClick={()=>void unlink()} disabled={busy}>Unlink</button>
  <LicenceLine licence={licence}/>
  <LauncherSyncStatus sync={state?.sync} busy={busy} onApply={()=>void applyPlatformConfig()}/>
  {error&&<span className="launcher-link-error">{error}</span>}
 </div>;
 if(link.pending) return <div className="launcher-link pending">
  <span className="launcher-link-head"><Loader2 className="spin" size={13}/>WAITING FOR APPROVAL</span>
  <b className="launcher-code">{link.pending.userCode}</b>
  <small>Sign in to the SCOUT app (or at <b>/login</b>) and approve this code. It expires {new Date(link.pending.expiresAt).toLocaleTimeString()}.</small>
  <button className="mini-button" onClick={()=>navigator.clipboard?.writeText(link.pending!.userCode).catch(()=>{})}><Copy size={11}/>Copy code</button>
  <LicenceLine licence={licence}/>
  {error&&<span className="launcher-link-error">{error}</span>}
 </div>;
 return <div className="launcher-link">
  <span className="launcher-link-head"><Link2 size={13}/>LAUNCHER NOT LINKED</span>
  <small>Link this installation to your SCOUT account so the platform knows which launcher is yours.</small>
  <button className="mini-button" onClick={()=>void start()} disabled={busy}>{busy?<Loader2 className="spin" size={11}/>:<Link2 size={11}/>}Link this installation</button>
  <LicenceLine licence={licence}/>
  {error&&<span className="launcher-link-error">{error}</span>}
 </div>;
}
// One line about entitlement, in the card an operator already looks at. `active`/`unknown`/`offline`
// may run, so they are stated quietly; anything else is a refusal to start the launcher and is
// coloured like one.
function LicenceLine({licence}:{licence:LicenceView|null}){
 if(!licence) return null;
 const runnable=['active','unknown','offline'].includes(licence.state);
 return <span className={'launcher-licence '+(runnable?'ok':'bad')} title={licence.message}>
  {runnable?<Check size={11}/>:<ShieldCheck size={11}/>}LICENCE {licence.state.toUpperCase()}{licence.enforced?' · ENFORCED':' · REPORTED'}
 </span>;
}
// ------------------------------------------------------------------ the review desk
// Authorized beta reviewers decide applications; invitation links are delivered to applicants by
// email and are never displayed or copied into the reviewer browser.
export function BetaApplicationsPanel(){
 const [state,setState]=useState<{mode:string;applications:AccountView[];invitations:Record<string,any>;link:InstallationView}|null>(null);
 const [busy,setBusy]=useState('');const [error,setError]=useState('');const [notice,setNotice]=useState('');
 const load=React.useCallback(async()=>{
  const res=await apiFetch('/api/beta/applications');
  if(!res.ok){setError('Sign in with an authorized SCOUT beta reviewer account to review applications.');return}
  setState(await res.json());setError('');
 },[]);
 useEffect(()=>{void load()},[load]);
 async function action(id:string,path:string,body:unknown){
  setBusy(id);setError('');setNotice('');
  const res=await apiFetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const response=await res.json().catch(()=>({}) as any);setBusy('');
  if(!res.ok){setError(response?.error||'That action could not be saved.');return}
  if(path.endsWith('/resend-invitation'))setNotice(response.invitationDelivery?.status==='pending'?'Invitation is queued for delivery; the service will retry automatically.':'A replacement invitation was sent by email.');
  else if(body&&typeof body==='object'&&(body as any).decision==='approve')setNotice(response.invitationDelivery?.status==='pending'?'Application approved. Invitation queued; delivery will retry automatically.':'Application approved. A single-use invitation was emailed to the applicant.');
  else if(body&&typeof body==='object'&&(body as any).decision==='revoke')setNotice(`Access revoked for ${response.application?.email||'the account'}.`);
  else setNotice(`${response.application?.email||'Application'} was rejected.`);
  await load();
 }
 const applications=state?.applications??[],invitations=state?.invitations??{};
 const pending=applications.filter(entry=>entry.status==='pending').length;
 return <section className="panel detail-panel beta-applications">
  <div className="panel-heading"><h2>Beta applications <span className="subtle-pill">{pending} WAITING</span></h2><button className="text-button" onClick={()=>void load()}>Refresh<RefreshCw size={13}/></button></div>
  <p className="info-note">Approving an application sends a single-use invitation to its email address. If delivery is temporarily unavailable, the encrypted outbox retries automatically. Never ask applicants to send you their password.</p>
  {error&&<Notice>{error}</Notice>}{notice&&<Notice tone="ok">{notice}</Notice>}
  {applications.length?<div className="beta-list">{applications.map(entry=>{
   const invitation=invitations[entry.id];
   const delivery=entry.status==='revoked'?'Access revoked':invitation?.activated?'Account activated':invitation?.status==='sent'?'Invitation emailed':invitation?.status==='pending'?'Email queued for retry':null;
   const revoke=()=>{
    if(!window.confirm(`Revoke access for ${entry.displayName} (${entry.email})? They will be signed out everywhere, their launchers will lose entitlement, and they will not be able to sign in again.`))return;
    const answer=window.prompt('Why is this account being revoked? (optional — recorded with the decision)','');
    if(answer===null)return;
    void action(entry.id,`/api/beta/applications/${entry.id}`,{decision:'revoke',...(answer.trim()?{reason:answer.trim()}:{})});
   };
   return <article key={entry.id} className={'beta-row '+entry.status}>
    <div className="beta-who"><b>{entry.displayName}</b><small>{entry.email}{entry.organisation?` · ${entry.organisation}`:''}{entry.country?` · ${entry.country}`:''}</small></div>
    <p className="beta-use">{entry.useCase||'No note supplied.'}{delivery&&<small className="beta-delivery">{delivery}{invitation?.expiresAt&&!invitation.activated?` · expires ${new Date(invitation.expiresAt).toLocaleString()}`:''}</small>}{entry.status==='revoked'&&entry.revokedReason&&<small className="beta-delivery">Reason: {entry.revokedReason}</small>}{invitation?.guidance&&<small className="beta-delivery">{invitation.guidance}</small>}</p>
    <span className={`site-status ${statusTone(entry.status)}`}><span className="status-dot"/>{statusLabel(entry.status)}</span>
    <div className="beta-actions">
     {entry.status==='pending'&&<><button className="button primary" disabled={busy===entry.id} onClick={()=>void action(entry.id,`/api/beta/applications/${entry.id}`,{decision:'approve'})}>{busy===entry.id?<Loader2 className="spin" size={13}/>:<Check size={13}/>}Approve</button><button className="button danger-button" disabled={busy===entry.id} onClick={()=>void action(entry.id,`/api/beta/applications/${entry.id}`,{decision:'reject'})}>Reject</button></>}
     {entry.status==='approved'&&!invitation?.activated&&<button className="button" disabled={busy===entry.id} onClick={()=>void action(entry.id,`/api/beta/applications/${entry.id}/resend-invitation`,{})}>{busy===entry.id?<Loader2 className="spin" size={13}/>:<RefreshCw size={13}/>}Resend invitation</button>}
     {entry.status==='approved'&&<button className="button danger-button" disabled={busy===entry.id} onClick={revoke}>Revoke access</button>}
    </div>
   </article>;
  })}</div>:<p className="beta-empty">No applications yet. They appear here the moment somebody applies at <code>/apply</code>.</p>}
 </section>;
}
// The website owns identity and launcher approvals, not any live broadcast controls.
export function ProfilePage(){
 const {status,offline,loading,failure,reload}=useBetaStatus();
 const account=status?.account??null;
 const [error,setError]=useState('');const [busy,setBusy]=useState('');
 const [isOwner,setIsOwner]=useState(false);
 useEffect(()=>{void fetch('/api/platform/status').then(r=>r.json()).then(body=>setIsOwner(body.isOwner===true)).catch(()=>{})},[]);
 async function revoke(deviceId:string){
  setBusy(deviceId);setError('');
  try{const result=await betaRequest('/api/beta/devices/revoke',{deviceId});if(!result.ok)setError(result.body?.error||'Could not unlink this launcher.');else await reload()}catch{setError('The service could not be reached.')}finally{setBusy('')}
 }
 async function logout(){await betaRequest('/api/beta/logout');location.assign('/login')}
 return <div className="site landing site-inner"><SiteNav account={account}/><main className="site-main site-narrow">
  <div className="site-page-head"><span className="site-section-eyebrow">YOUR ACCOUNT</span><h1>User profile</h1><p>Your beta access and the computers you’ve linked to your account.</p></div>
  {loading?<p className="site-loading">Checking your account…</p>:offline?<OfflineBanner>{accountOfflineText(failure,'signin')}</OfflineBanner>:!account?<section className="site-card"><h2>Sign in to see your profile</h2><a className="button primary" href="/login">Sign in</a></section>:<>
   <section className="site-card"><h2>{account.displayName}</h2><p>{account.email}</p><p>{account.organisation}</p><span className={'site-status '+statusTone(account.status)}>{statusLabel(account.status)}</span><div className="site-cta"><a className="button primary" href="/download">Download SCOUT</a>{isOwner&&<a className="button" href="/admin">Owner dashboard</a>}<button className="button" onClick={()=>void logout()}>Sign out</button></div></section>
   <section className="site-card site-devices"><h3>Linked launchers</h3>{error&&<Notice>{error}</Notice>}{account.devices?.length?<ul className="site-device-list">{account.devices.map(device=><li key={device.id}><div><b>{device.label}</b><small>{device.platform} · last seen {new Date(device.lastSeenAt).toLocaleDateString()}</small></div><button className="button" disabled={busy===device.id} onClick={()=>void revoke(device.id)}>Unlink</button></li>)}</ul>:<p>Nothing linked yet. Open SCOUT, then enter the code it shows on the <a href="/login">sign-in page</a>.</p>}</section>
  </>}
 </main><SiteFooter/></div>;
}
// ------------------------------------------------------------------ privacy
// The one legal page the beta needs: what is collected, why, for how long, and how to get it
// deleted. It doubles as the analytics policy (INSTRUCTIONS 3.6): no third-party trackers exist,
// and the first-party event allowlist below is the contract any future telemetry must obey —
// entries marked "not collected" are promises, not features. tests/site-public.test.ts pins this.
export const ANALYTICS_EVENT_ALLOWLIST:ReadonlyArray<{event:string;label:string;why:string;collected:boolean}>=[
 {event:'page-visit',label:'Page visits',why:'How many people visit the homepage, as a total only.',collected:false},
 {event:'beta-application-submitted',label:'Applications sent',why:'How many applications come in, and to block spam.',collected:false},
 {event:'invitation-accepted',label:'Invites accepted',why:'How many approved applicants set up their account.',collected:false},
 {event:'desktop-linked',label:'Launchers linked',why:'How many installs get linked to an account.',collected:false},
 {event:'update-success / update-failure',label:'Update results',why:'Whether updates install cleanly.',collected:false},
];
// The legal pages are a plain-language draft until a professional reviews them; LEGAL holds the facts
// they share (contact, date, status) so the reviewed text can replace the words without hunting.
export const LEGAL={contact:'privacy@scoutcs2.xyz',updated:'28 November 2026',draft:true};
function LegalDraftNotice(){
 return LEGAL.draft?<p className="site-notice warn" role="note"><b>Draft.</b> This page is our plain-language draft while a legal professional reviews it. It describes how SCOUT works today; the reviewed version may change the wording.</p>:null;
}
const ContactLink=()=><a href={`mailto:${LEGAL.contact}`}>{LEGAL.contact}</a>;
export function PrivacyPage(){
 return <div className="site landing site-inner">
  <SiteNav account={null}/>
  <main className="site-main site-narrow">
   <div className="site-page-head">
    <span className="site-section-eyebrow">PRIVACY</span>
    <h1>What we collect, and what stays on your PC</h1>
    <p>SCOUT runs on your own computer, and your match data stays there. This page covers this website, your SCOUT account, and what the SCOUT app sends to us. Last updated {LEGAL.updated}.</p>
   </div>
   <LegalDraftNotice/>
   <section className="site-card"><h2>The short version</h2>
    <ul className="site-ul">
     <li>Match data, recordings, uploads and overlay designs <b>never leave the PC you broadcast from</b>.</li>
     <li>We store your application and account so we can run the closed beta, and what the app needs to check its licence and sync your tournaments.</li>
     <li><b>No third-party trackers, no ads, no social media pixels.</b> We don’t sell or share your details for marketing.</li>
    </ul>
   </section>
   <section className="site-card"><h2>Who we are</h2>
    <p className="site-card-lead">SCOUT is run by the SCOUT team, who decide how this data is used. For anything on this page, including deleting your data, email <ContactLink/>.</p>
   </section>
   <section className="site-card"><h2>How SCOUT reads the game</h2>
    <ul className="site-ul">
     <li>SCOUT only uses Game State Integration, the match feed CS2 provides for broadcast tools.</li>
     <li><b>It doesn’t inject anything into the game, read the game’s memory or hook into its process.</b> There’s nothing for anti-cheat software to look at.</li>
     <li><b>Connect CS2</b> writes one connection file into CS2’s cfg folder on your PC. Nothing about it is sent to us.</li>
    </ul>
   </section>
   <section className="site-card"><h2>What we store about you</h2>
    <ul className="site-ul">
     <li><b>Your application:</b> name, email, organisation, country and what you broadcast. We use it to review your application and to contact you about the beta.</li>
     <li><b>Your account:</b> email, display name and a securely hashed password. We never store the password itself.</li>
     <li><b>Sign-in sessions:</b> when you sign in, the session records your IP address and browser name, so we can spot sessions that aren’t yours. Sessions end when you sign out or after 30 days.</li>
     <li><b>Linked apps:</b> a name, platform and when it was last seen, for each install you link, so you can see and unlink them on your profile.</li>
     <li><b>Review decisions:</b> who approved, declined or revoked an application, when, and any reason given.</li>
     <li><b>Emails we send you</b> (invitations and password resets): whether delivery worked. The address in our delivery queue is kept encrypted.</li>
    </ul>
   </section>
   <section className="site-card"><h2>What the SCOUT app sends us</h2>
    <ul className="site-ul">
     <li><b>Licence checks:</b> a linked app regularly confirms it is still allowed to run, using its own installation code. This updates when the app was last seen.</li>
     <li><b>Your website tournaments:</b> if you create a tournament on the website and run it on a linked app, the app downloads its teams, rosters and maps, and sends back match totals for it (kills, headshots, grenades, rounds, maps and matches). Never chat, voice or video.</li>
     <li><b>Diagnostics:</b> none today. If we add them, the app will ask you first, show exactly what is sent, and let you turn it off.</li>
    </ul>
   </section>
   <section className="site-card"><h2>What never leaves your PC</h2>
    <ul className="site-ul">
     <li>The live match feed, recordings, replays and match archives.</li>
     <li>Logos, player photos, sponsor logos, overlay designs and radar settings. They only leave if you export an event package yourself.</li>
     <li>Your start.gg token, your CS2 connection token and your panel passwords. When you import from start.gg, your own PC talks to start.gg directly, and start.gg’s privacy policy applies to that.</li>
    </ul>
   </section>
   <section className="site-card"><h2>Why we use it</h2>
    <ul className="site-ul">
     <li><b>To provide the service you asked for:</b> reviewing your application, your account, licence checks and tournament sync.</li>
     <li><b>To keep it secure and working</b> (our legitimate interest): sessions, security events and request stats.</li>
     <li><b>With your consent:</b> any optional diagnostics in future. You can withdraw consent at any time.</li>
    </ul>
   </section>
   <section className="site-card"><h2>Who helps us run it</h2>
    <p className="site-card-lead">These companies process data for us and only as we instruct:</p>
    <ul className="site-ul">
     <li><b>Render</b> hosts this website and the account service (in the United States).</li>
     <li><b>Supabase</b> hosts the database with accounts, sessions and tournaments.</li>
     <li><b>Resend</b> sends our emails (in the EU, Ireland).</li>
     <li><b>GitHub</b> hosts installer downloads, so it sees your IP address when you download.</li>
     <li><b>Vercel</b> runs our domain’s DNS. It does not receive your account data.</li>
    </ul>
    <p className="site-fineprint">Some of this data is stored outside your country, including in the United States. Where the law requires it, these transfers are covered by the providers’ standard data protection terms.</p>
   </section>
   <section className="site-card"><h2>What our servers log</h2>
    <ul className="site-ul">
     <li><b>Basic request stats</b> for the last 15 minutes, so we can spot problems. They aren’t saved to disk.</li>
     <li><b>Security events</b> like failed sign-ins and rate limits, so we can stop abuse. Passwords and sign-in links are never logged.</li>
    </ul>
   </section>
   <section className="site-card"><h2>Analytics and cookies</h2>
    <p className="site-card-lead">There are no analytics on this website. If we ever add basic visit counts, they will be limited to the list below, won’t include names, emails or match details, and this page will say they’re switched on.</p>
    <table className="site-allowlist"><thead><tr><th>Event</th><th>Why we’d count it</th><th>Status</th></tr></thead><tbody>
     {ANALYTICS_EVENT_ALLOWLIST.map(row=><tr key={row.event}><td>{row.label}</td><td>{row.why}</td><td>{row.collected?'collected':'not collected'}</td></tr>)}
    </tbody></table>
    <p className="site-fineprint"><b>Cookies:</b> one cookie to keep you signed in, and one when a panel is unlocked. Both are needed for the service to work. No cross-site tracking and no fingerprinting.</p>
   </section>
   <section className="site-card"><h2>Retention and deletion</h2>
    <ul className="site-ul">
     <li>Your application, account and linked apps: while your account exists.</li>
     <li>Sessions: until you sign out, or 30 days. Password reset links expire and can only be used once.</li>
     <li>Security records: only as long as needed to keep the service secure.</li>
     <li>When you ask us to delete your account, we delete your application, account, sessions and linked apps.</li>
    </ul>
   </section>
   <section className="site-card"><h2>Your rights</h2>
    <ul className="site-ul">
     <li>See the data we hold about you, and get a copy.</li>
     <li>Correct it, or have it deleted.</li>
     <li>Object to how we use it, or withdraw consent you gave.</li>
     <li>Complain to your data protection authority if you think we got something wrong.</li>
    </ul>
    <p className="site-fineprint">Email <ContactLink/> and we’ll answer within 30 days. You can also sign out and unlink apps yourself on your profile; an unlinked app loses access straight away.</p>
   </section>
   <section className="site-card"><h2>Children</h2>
    <p className="site-card-lead">SCOUT is for event organisers and broadcast crews. It isn’t meant for anyone under 16, and we don’t knowingly accept applications from them.</p>
   </section>
   <section className="site-card"><h2>Changes</h2>
    <p className="site-card-lead">When this page changes, we update the date at the top. If a change affects how we use data you already gave us, we’ll email you first.</p>
   </section>
  </main>
  <SiteFooter/>
 </div>;
}
// ------------------------------------------------------------------ terms
export function TermsPage(){
 return <div className="site landing site-inner">
  <SiteNav account={null}/>
  <main className="site-main site-narrow">
   <div className="site-page-head">
    <span className="site-section-eyebrow">TERMS</span>
    <h1>Terms for using SCOUT</h1>
    <p>These terms cover the SCOUT app, this website and your SCOUT account. By applying for or using SCOUT, you agree to them. Last updated {LEGAL.updated}.</p>
   </div>
   <LegalDraftNotice/>
   <section className="site-card"><h2>1. The closed beta</h2>
    <ul className="site-ul">
     <li>SCOUT is in a closed beta. We review applications and decide who gets access.</li>
     <li>We can revoke access, for example if these terms are broken, and we can restore it.</li>
     <li>The beta is free. If we introduce paid plans, we’ll tell you in advance and never charge you without your agreement.</li>
    </ul>
   </section>
   <section className="site-card"><h2>2. Your account</h2>
    <ul className="site-ul">
     <li>Give accurate details when you apply, and keep your password and links to your account private.</li>
     <li>You are responsible for what happens under your account and on the apps you link to it. Unlink an app you no longer control.</li>
     <li>You must be at least 16 to use SCOUT.</li>
    </ul>
   </section>
   <section className="site-card"><h2>3. Using the software</h2>
    <ul className="site-ul">
     <li>While your account is active, you may install SCOUT and use it to produce broadcasts of your events.</li>
     <li>Don’t resell, redistribute or sublicense SCOUT, and don’t try to get around its licence checks.</li>
     <li>Don’t attack, overload or probe the website or the account service, or access other people’s accounts.</li>
    </ul>
   </section>
   <section className="site-card"><h2>4. Your content</h2>
    <ul className="site-ul">
     <li>Team names, logos, player photos, sponsor logos and overlay designs you add stay yours.</li>
     <li>Only add material you have the right to use. That includes having players’ permission to show their photos, and sponsors’ permission to show their logos.</li>
     <li>You let us store and process your content only as needed to run SCOUT for you, for example to sync a tournament you created on the website to your linked apps.</li>
    </ul>
   </section>
   <section className="site-card"><h2>5. Fair play and other services</h2>
    <ul className="site-ul">
     <li>SCOUT is a broadcast tool. Don’t use it to give a player or team an unfair advantage during a match.</li>
     <li>SCOUT isn’t affiliated with or endorsed by Valve. Counter-Strike and its trademarks belong to Valve, and Valve’s terms still apply when you play or broadcast it.</li>
     <li>When you import from start.gg, start.gg’s terms apply to your use of their service and your API token.</li>
    </ul>
   </section>
   <section className="site-card"><h2>6. Beta software</h2>
    <ul className="site-ul">
     <li>SCOUT is provided “as is” while it’s in beta. It may have bugs, and features may change or be removed.</li>
     <li>Test your setup before an event. We aren’t responsible for a broadcast that fails, or for lost revenue or sponsorship, as far as the law allows.</li>
     <li>Nothing in these terms limits rights you have under consumer law that can’t be limited.</li>
    </ul>
   </section>
   <section className="site-card"><h2>7. Ending your use</h2>
    <ul className="site-ul">
     <li>You can stop using SCOUT at any time and ask us to delete your account.</li>
     <li>We can suspend or close an account that breaks these terms, and we may end the beta. If we end it, we’ll tell you in advance where we can.</li>
    </ul>
   </section>
   <section className="site-card"><h2>8. Changes and contact</h2>
    <p className="site-card-lead">When these terms change, we update the date at the top and email you about important changes. Questions: <ContactLink/>.</p>
   </section>
  </main>
  <SiteFooter/>
 </div>;
}
// ------------------------------------------------------------------ router
export function SiteRouter({route}:{route:SiteRoute}){
 useDocumentMeta(PAGE_META[route]);
 const params=new URLSearchParams(location.search);
 const linkCode=params.get('link')||params.get('device')||undefined;
 const invite=params.get('invite')||undefined;
 const reset=params.get('reset')||undefined;
 // Only known same-origin account/app destinations are accepted.
 const next=params.get('next')==='/app'?'/app':params.get('next')==='/admin'?'/admin':'/profile';
 if(route==='/welcome') return <LandingPage/>;
 if(route==='/apply') return <ApplyPage/>;
 if(route==='/download') return <DownloadPage/>;
 if(route==='/profile') return <ProfilePage/>;
 if(route==='/privacy') return <PrivacyPage/>;
 if(route==='/terms') return <TermsPage/>;
 return <LoginPage linkCode={linkCode} invite={invite} reset={reset} next={next}/>;
}
