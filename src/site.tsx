import React,{useEffect,useState} from 'react';
import {Archive as ArchiveIcon,ArrowRight,ArrowUpRight,Check,ChevronRight,CircleCheck,Copy,Download,Gamepad2,KeyRound,Layers,LayoutDashboard,Link2,Loader2,LogIn,Monitor,Palette,Radio,RefreshCw,ShieldCheck,SlidersHorizontal,Swords,Unplug,Users,Wifi,Zap} from 'lucide-react';
import {apiFetch,rememberToken} from './session';
import {DEFAULT_WIDGETS} from '../server/overlay';
import type {SceneId} from '../server/controls';
import {PANEL_SECTIONS,SCENE_LIST} from './panel-catalog';
import {HudStage} from './showcase';
import type {AccountView,BetaStatusView,InstallationView} from '../server/beta';
import type {LicenceView} from '../server/licensing';
import type {PanelSessionView} from '../server/auth';
// The public half of SCOUT: the landing page a tournament organiser finds, the application form for
// the closed beta, the sign-in page, and the dashboard where an approved account downloads the
// launcher and links it to their profile.
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
export const SITE_ROUTES=['/welcome','/login','/apply','/dashboard'] as const;
export type SiteRoute=typeof SITE_ROUTES[number];
export const isSiteRoute=(path:string):path is SiteRoute=>(SITE_ROUTES as readonly string[]).includes(path);
type BetaState={status:BetaStatusView|null;offline:boolean;loading:boolean;error:string};
function useBetaStatus(){
 const [state,setState]=useState<BetaState>({status:null,offline:false,loading:true,error:''});
 const load=React.useCallback(async()=>{
  try{
   const res=await fetch('/api/beta/status',{headers:{Accept:'application/json'}});
   if(!res.ok) throw Error(`The host answered ${res.status}`);
   setState({status:await res.json(),offline:false,loading:false,error:''});
  }catch(reason:any){
   // No host on this address (the marketing site served statically, or the launcher not running).
   // The pages stay readable and say so; they never pretend to be signed in.
   setState({status:null,offline:true,loading:false,error:reason?.message||'The SCOUT host could not be reached.'});
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
 useEffect(()=>{void (async()=>{try{const res=await apiFetch('/api/session');if(res.ok)setSession(await res.json())}catch{}})()},[]);
 return session;
}
const statusLabel=(status:string)=>status==='approved'?'APPROVED':status==='rejected'?'NOT APPROVED':'IN REVIEW';
const statusTone=(status:string)=>status==='approved'?'ok':status==='rejected'?'bad':'warn';
// ------------------------------------------------------------------ shared chrome
function SiteBrand(){return <a className="site-brand" href="/welcome"><span className="brand-symbol">✳</span> scout<span className="brand-dot">®</span></a>}
export function SiteNav({account,link,onHost=false,section=''}:{account:AccountView|null;link?:InstallationView|null;onHost?:boolean;section?:string}){
 return <header className="site-nav">
  <SiteBrand/>
  <nav className="site-nav-links">
   <a href="/welcome#product">Product</a>
   <a href="/welcome#scenes">Scenes</a>
   <a href="/welcome#maps">Maps</a>
   <a href="/welcome#beta">Closed beta</a>
   <a href="/welcome#how">Under the hood</a>
   <a href="/welcome#faq">FAQ</a>
  </nav>
  <div className="site-nav-actions">
   {onHost&&<a className="site-ghost-link" href="/" title="The operator panel served by this machine">Operator panel<ArrowUpRight size={13}/></a>}
   {account?<a className="button primary" href="/dashboard"><LayoutDashboard size={14}/>Dashboard</a>:<a className="site-ghost-link" href="/login"><LogIn size={13}/>Sign in</a>}
   {!account&&<a className="button primary" href="/apply">Apply for access<ArrowRight size={14}/></a>}
  </div>
  {section&&<span className="site-nav-section">{section}</span>}
 </header>;
}
export function SiteFooter(){
 return <footer className="site-footer">
  <div className="site-footer-brand"><SiteBrand/><p>Broadcast-ready CS2 overlays, built on Game State Integration alone. Nothing is injected into the game and nothing is read out of its memory.</p></div>
  <div className="site-footer-cols">
   <div><b>Product</b><a href="/welcome#product">What it does</a><a href="/welcome#scenes">Broadcast scenes</a><a href="/welcome#beta">Closed beta</a></div>
   <div><b>Operators</b><a href="/login">Sign in</a><a href="/dashboard">Dashboard</a><a href="/apply">Apply for access</a></div>
   <div><b>On this host</b><a href="/">Operator panel</a><a href="/obs" target="_blank" rel="noreferrer">Overlay output /obs</a><a href="/game" target="_blank" rel="noreferrer">Shared renderer /game</a></div>
  </div>
  <div className="site-footer-legal"><span>© {new Date().getFullYear()} SCOUT</span><span>GSI only<i/><span className="status-dot"/>No injection<i/>No memory reading</span></div>
 </footer>;
}
function OfflineBanner({children}:{children:React.ReactNode}){return <div className="site-offline"><Wifi size={14}/><span>{children}</span></div>}
function Notice({tone='bad',children}:{tone?:'bad'|'ok'|'warn';children:React.ReactNode}){return <p className={`site-notice ${tone}`}>{children}</p>}
// ------------------------------------------------------------------ landing page
// The product page's rules, in one place:
//   - it shows the product, not a drawing of it: every frame below is rendered by src/showcase,
//     which mounts the same `Hud` component the panel previews and the /obs output use;
//   - the words an operator needs before applying (Windows, CS2, OBS, no runtime to install) sit on
//     the hero call to action, in one line;
//   - the engineering detail lives further down, in "Under the hood", where the reader who wants it
//     finds it — and where it does not stand between a first-time visitor and what SCOUT looks like;
//   - the closed-beta flow is untouched: apply, a human reads it, an invite sets your password, the
//     dashboard holds the launcher.
const FEATURES=[
 {icon:Radio,title:'Reads the game, never touches it',body:'Counter-Strike 2 publishes its own match state through Game State Integration. SCOUT reads that feed and derives the score, the rounds, the kills and the economy from it.'},
 {icon:Monitor,title:'A live HUD that stays out of the way',body:'Scoreboard, tactical radar, killfeed, both rosters, the observed player and the footer sit over the game on a transparent browser source — nothing is covered that the cast needs.'},
 {icon:Layers,title:'Nine scenes, one panel',body:'The live HUD, plus eight full-canvas graphics: matchup, lineups, map series, tournament tree, winner, break, round recap and player stats. All nine are switched from the panel while the match runs.'},
 {icon:Palette,title:'Edit it while it is on air',body:'Teams, rosters, the bracket, the map order, the break wording and every layer of the overlay design are edited in the panel and reach all outputs immediately.'},
 {icon:Users,title:'Built for a crew, not a password',body:'Owner, producer, designer and viewer roles with their own tokens, so the observer, the graphics operator and the tournament admin each get exactly what they need.'},
 {icon:Gamepad2,title:'Installed on the observer PC',body:'A Windows launcher installs the host, the panel and the overlay pages, writes the CS2 config, and keeps team data and recordings in your own profile.'},
];
// Whatever is in public/thumbs/site/ is what the page shows: the same nine active-duty maps the
// broadcast scenes use, resized once for the web (see public/thumbs/README.txt).
const MAP_POOL=[
 {file:'de_ancient',label:'Ancient',role:'Active duty'},
 {file:'de_anubis',label:'Anubis',role:'Active duty'},
 {file:'de_dust2',label:'Dust II',role:'Active duty'},
 {file:'de_inferno',label:'Inferno',role:'Active duty'},
 {file:'de_mirage',label:'Mirage',role:'Active duty'},
 {file:'de_nuke',label:'Nuke',role:'Active duty'},
 {file:'de_overpass',label:'Overpass',role:'Active duty'},
 {file:'de_train',label:'Train',role:'Active duty'},
 {file:'de_vertigo',label:'Vertigo',role:'Active duty'},
];
const STEPS=[
 {title:'Apply',body:'Tell us who you are and what you broadcast. The application takes about a minute.'},
 {title:'We review it',body:'A human reads every application. Approved accounts get a one-time invite link that lets them set a password.'},
 {title:'Download the launcher',body:'Your dashboard holds the Windows installer: host, panel, overlay pages and the GSI config, with its own bundled runtime.'},
 {title:'Link it and go live',body:'The launcher shows an 8-character code. Approve it in your dashboard once, then paste its /obs address into OBS.'},
];
const FAQ=[
 ['Is SCOUT free during the beta?','Yes. The closed beta is free for the organisers we admit. Paid tiers, if they ever exist, will be about hosted services — the overlay itself runs on your machine.'],
 ['What does “GSI only” actually mean?','SCOUT never touches the game process. CS2 writes a text feed of the match to a local URL; SCOUT reads that, derives kills, rounds and economy, and renders the overlay. No injection, no memory reading, no game hooks, no chroma key.'],
 ['Do I need a second PC?','It helps, but it is not required. The launcher runs on the observer PC and OBS can be on the same machine. If you do have a broadcast PC, the panel and the overlay are reachable from it over your own network.'],
 ['Does it work on FACEIT, ESEA or workshop maps?','GSI is a game feature, so it works wherever CS2 runs with the config installed — including workshop maps. Radar calibration for a custom map is a config entry, not a code change.'],
 ['What happens to my data?','Match data, uploads and recordings never leave your machine. The website stores the account you applied with, and the launcher link — nothing about the matches you broadcast.'],
];
// The engineering, deliberately below the product story. Someone choosing an overlay for their cup
// needs to know it will not touch the game; someone wiring OBS at 2am needs the port and the rules.
const UNDER_THE_HOOD=[
 {icon:ShieldCheck,title:'GSI only, by architecture',body:'CS2 pushes its own game state to a local HTTP feed; SCOUT reads that and nothing else — no injection, no memory reading, no hooks, nothing for an anti-cheat to look at.'},
 {icon:Monitor,title:'Wired into OBS, not into the game',body:'One Browser Source on /obs at 1920 × 1080, no custom CSS, and the live scene is transparent. Optional two-way scene switching with OBS Studio over obs-websocket keeps your OBS scene and the broadcast scene together.'},
 {icon:SlidersHorizontal,title:'Radar calibration per map',body:'posX, posY and scale live per map in config/radars.json, measured once in Map radars. The nine active-duty maps ship pre-filled from the cs2-map-icons pack; a custom map is a drop-in file, not a code change.'},
 {icon:Users,title:'Several operators, one broadcast',body:'Per-operator tokens, a 45-second control lease that stops two people driving at once, and an audit trail of who switched what and when.'},
 {icon:ArchiveIcon,title:'Recording, archives and replay',body:'GSI recording, round-by-round archives and replay previews, stored on the observer machine. Nothing is uploaded to us.'},
];
export function LandingPage(){
 const {status,offline}=useBetaStatus();
 const onHost=!offline&&!!status?.host;
 // The scene the reader picked in the tour. The frame renders it with the product's own renderer,
 // so the page never has to be updated by hand when a scene changes.
 const [scene,setScene]=useState<SceneId>('live');
 const active=SCENE_LIST.find(item=>item.id===scene)??SCENE_LIST[0];
 const liveLayers=DEFAULT_WIDGETS.filter(widget=>widget.showOn.includes('live'));
 return <div className="site">
  <SiteNav account={status?.account??null} onHost={onHost}/>
  <main className="site-main">
   {offline&&<OfflineBanner>The SCOUT host is not reachable on this address, so account actions are unavailable. The product pages work anyway — start the launcher to sign in or apply.</OfflineBanner>}
   <section className="site-hero">
    <img className="site-hero-bg" src="/assets/cs2.png" alt="" aria-hidden="true"/>
    <div>
     <div className="site-eyebrow"><span className="site-eyebrow-dot"/>CLOSED BETA · CS2 BROADCAST OVERLAY</div>
     <h1 className="site-h1">A broadcast team for the tournaments that <em>cannot hire one</em>.</h1>
     <p className="site-lead">SCOUT turns one observer PC into a full CS2 production: a transparent live HUD and eight full-canvas scenes — the matchup, the map series, the bracket, the break, the trophy — all switched from one panel while the round is running.</p>
     <div className="site-cta">
      <a className="button primary" href="/apply"><Zap size={15}/>Apply for the closed beta</a>
      <a className="button" href="/login"><LogIn size={15}/>Sign in</a>
     </div>
     <p className="site-requirements"><span className="site-requirements-label">What you need</span>Windows 10 or 11 (x64)<i/>Counter-Strike 2 and OBS Studio on the observer PC<i/>nothing else — the installer bundles its own runtime</p>
    </div>
    <div className="site-hero-art">
     <HudStage scene="live" className="site-stage site-stage-hero"/>
     <div className="site-stage-caption">
      <span className="site-stage-badge"><span className="status-dot"/>THE PRODUCT, NOT A PICTURE OF IT</span>
      <span>The live scene, rendered by the overlay the broadcast output uses. Sample match data.</span>
     </div>
    </div>
   </section>
   <section className="site-armory" aria-hidden="true">
    <img className="armory-m4" src="/assets/m4a1-s.png" alt=""/>
    <img className="armory-ak" src="/assets/ak-47.png" alt=""/>
    <img className="armory-de" src="/assets/oceanic-deag.png" alt=""/>
   </section>
   <section className="site-strip">
    <span><ShieldCheck size={15}/>No injection, no memory reading</span>
    <span><Monitor size={15}/>Runs beside the game, never inside it</span>
    <span><Radio size={15}/>One output, nine scenes</span>
    <span><Wifi size={15}/>Your LAN, no cloud round-trip</span>
   </section>
   <section className="site-section" id="product">
    <div className="site-section-head"><span className="site-section-eyebrow">WHAT IT DOES</span><h2>Everything between the game and the stream</h2><p>One process on the observer machine, one transparent browser source in OBS, and an operator panel that never gets in the way of the round.</p></div>
    <div className="site-layers">
     <b>On the live HUD</b>
     <div className="site-layer-chips">{liveLayers.map(widget=><span key={widget.id}>{widget.name}</span>)}</div>
     <small>{liveLayers.length} layers, each one switched on or off from the panel while the round is running — four of them only appear when the game calls for them. The names are the Overlay Studio's own.</small>
    </div>
    <div className="site-grid">{FEATURES.map(({icon:Icon,title,body})=><article className="site-card" key={title}><span className="site-card-icon"><Icon size={17}/></span><h3>{title}</h3><p>{body}</p></article>)}</div>
   </section>
   <section className="site-section site-tour" id="scenes">
    <div className="site-section-head"><span className="site-section-eyebrow">BROADCAST SCENES</span><h2>One click. On air.</h2><p>Pick a scene and watch the real renderer change: this frame is the same component the panel previews and the output plays, driven by sample event data — not a screenshot that goes stale.</p></div>
    <div className="site-tour-grid">
     <div className="site-tour-frame">
      <HudStage scene={active.id} className="site-stage site-stage-tour"/>
      <div className="site-stage-caption">
       <span className="site-stage-badge"><span className="status-dot"/>ON AIR · {active.title.toUpperCase()}</span>
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
    <div className="site-section-head"><span className="site-section-eyebrow">THE MAP POOL</span><h2>Every active-duty map, ready on day one</h2><p>The matchup and map-series scenes use the same pictures the panel does. Nine maps ship pre-filled, and replacing one is a file drop, not a code change.</p></div>
    <div className="site-map-strip">{MAP_POOL.map(map=><figure className="site-map-chip" key={map.file}>
     <img src={`/thumbs/site/${map.file}.jpg`} alt={`${map.label} overview`} loading="lazy" decoding="async"/>
     <figcaption><b>{map.label}</b><small>{map.role}</small></figcaption>
    </figure>)}</div>
   </section>
   <section className="site-section" id="beta">
    <div className="site-section-head"><span className="site-section-eyebrow">CLOSED BETA</span><h2>How access works</h2><p>We are admitting a small number of organisers at a time so every deployment is supported properly. Applications are reviewed by hand.</p></div>
    <div className="site-steps">{STEPS.map((step,index)=><div className="site-step" key={step.title}><span className="site-step-index">{index+1}</span><b>{step.title}</b><p>{step.body}</p></div>)}</div>
    <div className="site-beta-cta">
     <div><b>Applications are open</b><p>Windows 10/11 (x64), Counter-Strike 2, and OBS Studio if you are streaming. The installer bundles its own runtime — no Node.js, no build tools.</p></div>
     <a className="button primary" href="/apply">Start your application<ArrowRight size={14}/></a>
    </div>
   </section>
   <section className="site-section site-how" id="how">
    <div className="site-section-head"><span className="site-section-eyebrow">UNDER THE HOOD</span><h2>How the overlay actually works</h2><p>The detail a technical lead asks about before anything gets installed on a tournament machine.</p></div>
    <div className="site-how-grid">{UNDER_THE_HOOD.map(({icon:Icon,title,body})=><article className="site-card" key={title}><span className="site-card-icon"><Icon size={17}/></span><h3>{title}</h3><p>{body}</p></article>)}</div>
    <div className="site-panel-map">
     <div><b>Inside the operator panel</b><p>{PANEL_SECTIONS.length} sections, one for every job a broadcast has — and the panels marked <em>owner</em> only open for the account that owns the installation.</p></div>
     <div className="site-panel-chips">{PANEL_SECTIONS.map(({name,icon:Icon,ownerOnly})=><span key={name}><Icon size={13}/>{name}{ownerOnly&&<em>owner</em>}</span>)}</div>
    </div>
   </section>
   {onHost&&<section className="site-section site-host-card">
    <div className="site-host-left"><span className="site-host-pill"><span className="status-dot"/>SERVED BY YOUR HOST</span><b>This page is being served by a SCOUT host on {status?.host}</b><p>The account service behind it is running {status?.mode==='hosted'?'on a hosted backend, with this host proxying the account calls.':'in local mode: applications, invites and launcher links are stored on this machine.'}</p></div>
    <div className="site-host-actions"><a className="button" href="/">Open the operator panel<ArrowUpRight size={14}/></a><a className="button" href="/obs" target="_blank" rel="noreferrer">Preview the overlay<ArrowUpRight size={14}/></a></div>
   </section>}
   <section className="site-section" id="faq">
    <div className="site-section-head"><span className="site-section-eyebrow">FAQ</span><h2>The questions organisers ask first</h2></div>
    <div className="site-faq">{FAQ.map(([question,answer])=><details key={question}><summary>{question}<ChevronRight size={15}/></summary><p>{answer}</p></details>)}</div>
   </section>
   <section className="site-final">
    <img className="site-agent agent-t" src="/assets/cs2-t.png" alt="" aria-hidden="true"/>
    <img className="site-agent agent-ct" src="/assets/cs2-ct.png" alt="" aria-hidden="true"/>
    <h2>Bring your next match to air</h2>
    <p>Apply for the closed beta, and we will send your invite link as soon as your account is approved.</p>
    <div className="site-cta center"><a className="button primary" href="/apply">Apply for the closed beta<ArrowRight size={14}/></a><a className="button" href="/login">I already have an account</a></div>
   </section>
  </main>
  <SiteFooter/>
 </div>;
}
// ------------------------------------------------------------------ apply
const EVENT_OPTIONS=['One-off event','Monthly','Every week','League season','Something else'];
export function ApplyPage(){
 const {status,offline,reload}=useBetaStatus();
 const [form,setForm]=useState({name:'',email:'',organisation:'',country:'',useCase:'',events:EVENT_OPTIONS[1]});
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [done,setDone]=useState<{email:string;inviteUrl:string|null}|null>(null);
 const set=(key:keyof typeof form)=>(event:React.ChangeEvent<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>)=>setForm(current=>({...current,[key]:event.target.value}));
 async function submit(event:React.FormEvent){
  event.preventDefault();
  setBusy(true);setError('');
  const result=await betaRequest('/api/beta/apply',form);
  setBusy(false);
  if(!result.ok){setError(result.body?.error||'The application could not be sent. Try again.');return}
  setDone({email:result.body.application.email,inviteUrl:result.body.inviteUrl??null});
 }
 const account=status?.account??null;
 return <div className="site">
  <SiteNav account={account} onHost={!offline&&!!status?.host}/>
  <main className="site-main site-narrow">
   {offline&&<OfflineBanner>The SCOUT host is not reachable on this address, so applications cannot be submitted right now.</OfflineBanner>}
   <div className="site-page-head">
    <span className="site-section-eyebrow">CLOSED BETA</span>
    <h1>Apply for access</h1>
    <p>Tell us who you are and what you broadcast. If it is a fit, you get a one-time invite link that creates your operator account — and the launcher download appears in your dashboard.</p>
   </div>
   {done?<section className="site-card site-done">
    <span className="site-done-mark"><CircleCheck size={22}/></span>
    <h2>Application received</h2>
    <p>We have <b>{done.email}</b> on the list. When it is approved you will get an invite link at that address; opening it lets you set a password. Until then, nothing else is needed from you.</p>
    {done.inviteUrl&&<p className="site-inline-invite">This host is in development mode, so your account was approved immediately: <a href={done.inviteUrl}>open your invite link</a>.</p>}
    <div className="site-cta"><a className="button" href="/welcome">Back to the overview</a><a className="button primary" href="/login">Go to sign in<ArrowRight size={14}/></a></div>
   </section>:account?<section className="site-card site-done">
    <h2>You already have an account</h2>
    <p>Signed in as <b>{account.email}</b> — {statusLabel(account.status).toLowerCase()}.</p>
    <div className="site-cta"><a className="button primary" href="/dashboard">Open your dashboard<ArrowRight size={14}/></a></div>
   </section>:<div className="site-apply-grid">
    <form className="site-card site-form" onSubmit={submit}>
     <label className="field"><span>YOUR NAME</span><input value={form.name} onChange={set('name')} placeholder="Who should we talk to?" autoComplete="name"/></label>
     <label className="field"><span>EMAIL</span><input type="email" value={form.email} onChange={set('email')} placeholder="you@organisation.gg" autoComplete="email"/></label>
     <div className="site-form-row">
      <label className="field"><span>TEAM OR ORGANISATION</span><input value={form.organisation} onChange={set('organisation')} placeholder="Optional"/></label>
      <label className="field"><span>COUNTRY</span><input value={form.country} onChange={set('country')} placeholder="Optional"/></label>
     </div>
     <label className="field"><span>HOW OFTEN DO YOU BROADCAST?</span><select value={form.events} onChange={set('events')}>{EVENT_OPTIONS.map(option=><option key={option} value={option}>{option}</option>)}</select></label>
     <label className="field"><span>WHAT WILL YOU BROADCAST?</span><textarea rows={4} value={form.useCase} onChange={set('useCase')} placeholder="Leagues, qualifiers, community cups, LANs…"/></label>
     <button className="button primary wide" type="submit" disabled={busy||offline}>{busy?<><Loader2 className="spin" size={15}/>Sending…</>:<>Send application<ArrowRight size={14}/></>}</button>
     {error&&<Notice>{error}</Notice>}
     <p className="site-fineprint">We only use this to review your application and to reach you about the beta. No newsletter, no resale.</p>
    </form>
    <aside className="site-apply-aside">
     <div className="site-card"><h3>What happens next</h3><ol className="site-ol"><li>A human reads the application.</li><li>Approved applicants get a one-time invite link.</li><li>The link sets your password and opens your dashboard.</li><li>The dashboard holds the Windows launcher and the launcher-link code.</li></ol></div>
     <div className="site-card"><h3>What you need</h3><ul className="site-ul"><li>Windows 10 or 11, 64-bit</li><li>Counter-Strike 2 on the same machine</li><li>OBS Studio (or the SCOUT shell) for the output</li><li>Nothing else — the installer bundles its own runtime</li></ul></div>
     <button className="site-reload" onClick={()=>void reload()}><RefreshCw size={13}/>Recheck this host</button>
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
export function LoginPage({linkCode,invite}:{linkCode?:string;invite?:string}){
 const {status,offline,reload}=useBetaStatus();
 const session=usePanelSession();
 const account=status?.account??null;
 const [email,setEmail]=useState('');const [password,setPassword]=useState('');
 const [invitePassword,setInvitePassword]=useState('');const [inviteConfirm,setInviteConfirm]=useState('');
 const [token,setToken]=useState('');
 const [busy,setBusy]=useState<string|null>(null);
 const [error,setError]=useState('');const [notice,setNotice]=useState('');
 const [code,setCode]=useState(linkCode??'');
 async function signIn(event:React.FormEvent){
  event.preventDefault();setBusy('account');setError('');
  const result=await betaRequest('/api/beta/login',{email,password});
  setBusy(null);
  if(!result.ok){setError(result.body?.error||'Sign-in failed.');return}
  if(code) location.assign(`/dashboard?link=${encodeURIComponent(code)}`);else location.assign('/dashboard');
 }
 async function activate(event:React.FormEvent){
  event.preventDefault();setError('');
  if(invitePassword!==inviteConfirm){setError('The two passwords do not match.');return}
  setBusy('invite');
  const result=await betaRequest('/api/beta/activate',{invite,password:invitePassword});
  setBusy(null);
  if(!result.ok){setError(result.body?.error||'That invite could not be used.');return}
  setNotice('Password set. Welcome aboard.');
  setTimeout(()=>location.assign('/dashboard'),600);
 }
 async function unlockWithToken(event:React.FormEvent){
  event.preventDefault();setBusy('token');setError('');
  try{
   const res=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token.trim()})});
   const body=await res.json().catch(()=>({}) as any);
   if(!res.ok) throw Error(body?.error||'The host refused that token.');
   // Keep the header fallback as well as the cookie: a panel in a frame, or a browser that drops
   // third-party storage, still has to be able to drive the broadcast.
   rememberToken(token.trim());
   location.assign('/');
  }catch(reason:any){setError(reason?.message||'The host refused that token.')}
  finally{setBusy(null)}
 }
 async function approveLauncher(next:boolean){
  setBusy('device');setError('');
  const result=await betaRequest(`/api/beta/device/${next?'approve':'deny'}`,{userCode:code});
  setBusy(null);
  if(!result.ok){setError(result.body?.error||'That code could not be used.');return}
  setNotice(next?'Launcher linked to your account.':'Launcher request refused.');
  setTimeout(()=>location.assign('/dashboard'),700);
 }
 const localSession=session?.local&&session.authenticated;
 return <div className="site">
  <SiteNav account={account} onHost={!offline&&!!status?.host}/>
  <main className="site-main site-narrow">
   {offline&&<OfflineBanner>The SCOUT host is not reachable on this address, so signing in is not possible. Start the launcher (or open the host address) and try again.</OfflineBanner>}
   <div className="site-page-head">
    <span className="site-section-eyebrow">{invite?'INVITE':linkCode?'LAUNCHER LINK':'SIGN IN'}</span>
    <h1>{invite?'Set your password':linkCode?'Approve a launcher':'Welcome back'}</h1>
    <p>{invite?'Your application was approved. Choose the password for your SCOUT account — the invite link stops working the moment it is used.'
      :linkCode?'A launcher is asking to be linked to your account. Confirm the code you see in the launcher window, then approve it.'
      :'Sign in to your SCOUT account to reach your dashboard and downloads — or unlock the operator panel on this machine with the token the host printed.'}</p>
   </div>
   <div className="site-login-grid">
    <div className="site-card site-form">
     {notice&&<Notice tone="ok">{notice}</Notice>}
     {error&&<Notice>{error}</Notice>}
     {invite?<form onSubmit={activate}>
      <label className="field"><span>NEW PASSWORD</span><input type="password" value={invitePassword} onChange={event=>setInvitePassword(event.target.value)} autoFocus autoComplete="new-password" placeholder="at least 10 characters"/></label>
      <label className="field"><span>REPEAT PASSWORD</span><input type="password" value={inviteConfirm} onChange={event=>setInviteConfirm(event.target.value)} autoComplete="new-password"/></label>
      <button className="button primary wide" type="submit" disabled={busy==='invite'}>{busy==='invite'?<><Loader2 className="spin" size={15}/>Saving…</>:<>Set password<ArrowRight size={14}/></>}</button>
     </form>:account?<div className="site-signed-in">
      <span className="site-done-mark"><CircleCheck size={20}/></span>
      <h3>Already signed in</h3>
      <p>{account.email} · {statusLabel(account.status)}</p>
      {code?<div className="site-device">
       <label className="field"><span>LAUNCHER CODE</span><input value={code} onChange={event=>setCode(event.target.value.toUpperCase())} placeholder="ABCD-EFGH"/></label>
       <div className="site-cta"><button className="button primary" onClick={()=>void approveLauncher(true)} disabled={busy==='device'}><Link2 size={14}/>Link this launcher</button><button className="button" onClick={()=>void approveLauncher(false)} disabled={busy==='device'}><Unplug size={14}/>Refuse</button></div>
      </div>:<div className="site-cta"><a className="button primary" href="/dashboard">Your dashboard<ArrowRight size={14}/></a></div>}
     </div>:<form onSubmit={signIn}>
      {code&&<div className="site-device-code"><small>LAUNCHER WAITING</small><b>{code}</b><span>Sign in to approve it.</span></div>}
      <label className="field"><span>EMAIL</span><input type="email" value={email} onChange={event=>setEmail(event.target.value)} autoFocus autoComplete="username" placeholder="you@organisation.gg"/></label>
      <label className="field"><span>PASSWORD</span><input type="password" value={password} onChange={event=>setPassword(event.target.value)} autoComplete="current-password"/></label>
      <button className="button primary wide" type="submit" disabled={busy==='account'||offline}>{busy==='account'?<><Loader2 className="spin" size={15}/>Signing in…</>:<><LogIn size={15}/>Sign in</>}</button>
      {code&&<button className="button wide" type="button" onClick={()=>void approveLauncher(true)} disabled={busy==='device'}><Link2 size={14}/>Link launcher {code}</button>}
      <p className="site-fineprint">No account yet? <a className="site-link" href="/apply">Apply for the closed beta</a>. Forgot your password? Ask the operator who approved you for a new invite link — the beta has no mail server yet.</p>
     </form>}
    </div>
    <aside className="site-login-aside">
     <div className="site-card">
      <h3><KeyRound size={15}/>This machine</h3>
      <p className="site-card-lead">The operator panel on the machine running the host unlocks with the panel token — the one the host prints when it starts.</p>
      {localSession?<div className="site-cta"><a className="button primary wide" href="/">You are on the operator machine — open the panel</a></div>
       :session?.authenticated?<div className="site-cta"><a className="button primary wide" href="/">Panel unlocked — open it</a></div>
       :<form onSubmit={unlockWithToken}>
        <label className="field"><span>PANEL TOKEN</span><input type="password" value={token} onChange={event=>setToken(event.target.value)} autoComplete="off" spellCheck={false} placeholder="paste the token from the host console"/></label>
        <button className="button wide" type="submit" disabled={busy==='token'||offline}>{busy==='token'?<><Loader2 className="spin" size={15}/>Checking…</>:<><KeyRound size={14}/>Unlock the panel</>}</button>
       </form>}
      <p className="site-fineprint">{session?.remoteEnabled===false?'Remote control is switched off on this host: the panel only opens on the observer machine.':'Requests from the observer machine itself are trusted without a token.'}</p>
     </div>
     <div className="site-card">
      <h3><Link2 size={15}/>Linking a launcher</h3>
      <p className="site-card-lead">Open the launcher, choose <b>Launcher link</b> in the panel sidebar, and it shows an 8-character code. Type that code here and approve it — the launcher turns green in a few seconds.</p>
      <button className="site-reload" onClick={()=>void reload()}><RefreshCw size={13}/>Recheck this host</button>
     </div>
    </aside>
   </div>
  </main>
  <SiteFooter/>
 </div>;
}
// ------------------------------------------------------------------ dashboard
export function DashboardPage({linkCode}:{linkCode?:string}){
 const {status,offline,reload,loading}=useBetaStatus();
 const account=status?.account??null;
 const [code,setCode]=useState(linkCode??'');
 const [busy,setBusy]=useState<string|null>(null);
 const [error,setError]=useState('');const [notice,setNotice]=useState('');
 useEffect(()=>{if(linkCode)setCode(linkCode)},[linkCode]);
 async function decide(next:boolean){
  if(!code.trim()){setError('Type the code the launcher is showing.');return}
  setBusy('device');setError('');setNotice('');
  const result=await betaRequest(`/api/beta/device/${next?'approve':'deny'}`,{userCode:code});
  setBusy(null);
  if(!result.ok){setError(result.body?.error||'That code could not be used.');return}
  setNotice(next?'Launcher linked. It will show as linked within a few seconds.':'Launcher request refused.');
  void reload();
 }
 async function revoke(deviceId:string,label:string){
  setBusy(deviceId);setError('');setNotice('');
  const result=await betaRequest('/api/beta/devices/revoke',{deviceId});
  setBusy(null);
  if(!result.ok){setError(result.body?.error||'That launcher could not be unlinked.');return}
  setNotice(`${label} was unlinked. Its token stops working immediately.`);
  void reload();
 }
 async function signOut(){await betaRequest('/api/beta/logout');location.assign('/login')}
 if(loading) return <div className="site"><SiteNav account={null}/><main className="site-main site-narrow"><p className="site-loading"><Loader2 className="spin" size={16}/>Loading your dashboard…</p></main><SiteFooter/></div>;
 return <div className="site">
  <SiteNav account={account} onHost={!offline&&!!status?.host}/>
  <main className="site-main site-narrow">
   {offline&&<OfflineBanner>The SCOUT host is not reachable on this address, so your dashboard cannot be loaded. Start the launcher, or open the host address, and reload.</OfflineBanner>}
   {!account?<section className="site-card site-done">
    <h2>Sign in to see your dashboard</h2>
    <p>The dashboard holds your beta status, the launcher download and the code that links a launcher to your account.</p>
    <div className="site-cta"><a className="button primary" href="/login">Sign in<ArrowRight size={14}/></a><a className="button" href="/apply">Apply for access</a></div>
   </section>:<>
    <div className="site-dash-head">
     <div>
      <span className="site-section-eyebrow">DASHBOARD</span>
      <h1>{account.displayName||account.email}</h1>
      <p>{account.email}{account.organisation?` · ${account.organisation}`:''}{account.country?` · ${account.country}`:''} · member since {new Date(account.createdAt).toLocaleDateString()}</p>
     </div>
     <div className="site-dash-head-right">
      <span className={`site-status ${statusTone(account.status)}`}><span className="status-dot"/>{statusLabel(account.status)}</span>
      <button className="site-ghost-link" onClick={()=>void signOut()}>Sign out</button>
     </div>
    </div>
    {notice&&<Notice tone="ok">{notice}</Notice>}
    {error&&<Notice>{error}</Notice>}
    <div className="site-dash-grid">
     <DownloadCard account={account} download={status?.download??null}/>
     <section className="site-card site-link">
      <span className="site-card-icon"><Link2 size={17}/></span>
      <h3>Link a launcher</h3>
      <ol className="site-ol compact"><li>Open the launcher on the observer machine.</li><li>In the panel sidebar, find <b>Launcher link</b> and press <b>Link this installation</b>.</li><li>Type the 8-character code it shows below.</li></ol>
      <label className="field"><span>LAUNCHER CODE</span><input value={code} onChange={event=>setCode(event.target.value.toUpperCase())} placeholder="ABCD-EFGH" spellCheck={false}/></label>
      <div className="site-cta"><button className="button primary" onClick={()=>void decide(true)} disabled={busy==='device'}>{busy==='device'?<Loader2 className="spin" size={14}/>:<Link2 size={14}/>}Link this launcher</button><button className="button" onClick={()=>void decide(false)} disabled={busy==='device'}><Unplug size={14}/>Refuse</button></div>
      <p className="site-fineprint">Approving a code is what tells the account service that a specific installation belongs to you. No password is ever typed into the launcher, and unlinking a device stops its token immediately.</p>
     </section>
     <section className="site-card site-devices">
      <span className="site-card-icon"><Monitor size={17}/></span>
      <h3>Linked launchers <span className="site-count">{account.devices.length}</span></h3>
      {account.devices.length?<ul className="site-device-list">{account.devices.map(device=><li key={device.id}>
       <div><b>{device.label}</b><small>{device.platform} · linked {new Date(device.createdAt).toLocaleDateString()} · last seen {new Date(device.lastSeenAt).toLocaleString()}</small></div>
       <button className="site-ghost-link danger" onClick={()=>void revoke(device.id,device.label)} disabled={busy===device.id}>{busy===device.id?<Loader2 className="spin" size={13}/>:<Unplug size={13}/>}Unlink</button>
      </li>)}</ul>:<p className="site-card-lead">No launcher is linked yet. Once you link one, it appears here — and you can revoke it at any time without reinstalling anything.</p>}
     </section>
     <section className="site-card site-next">
      <span className="site-card-icon"><Swords size={17}/></span>
      <h3>While you wait</h3>
      <p className="site-card-lead">The overlay output has no token and needs none, so once the launcher is running you can point OBS at it right away.</p>
      <ul className="site-ul">
       <li>Add a <b>Browser Source</b> in OBS: <code>{`http://localhost:8080/obs`}</code>, 1920 × 1080, no custom CSS.</li>
       <li>Set <b>SCOUT_REQUIRE_TOKEN=1</b> if the panel on the observer PC should ask for the token too.</li>
       <li>Issue per-operator tokens (producer, designer, viewer) instead of sharing yours.</li>
      </ul>
      <div className="site-cta">
       <button className="button" onClick={()=>navigator.clipboard?.writeText('http://localhost:8080/obs').then(()=>setNotice('OBS source URL copied')).catch(()=>setNotice('Copy manually: http://localhost:8080/obs'))}><Copy size={14}/>Copy the OBS source URL</button>
       <a className="button" href="/">Open the operator panel<ArrowUpRight size={14}/></a>
      </div>
     </section>
    </div>
    <p className="site-fineprint site-dash-foot">Account created {new Date(account.createdAt).toLocaleString()}{account.decidedAt?` · decision ${new Date(account.decidedAt).toLocaleString()}`:''}. This host is running the account service {status?.mode==='hosted'?'remotely (SCOUT_BETA_API_URL)':'locally (config/beta/store.json)'}.</p>
   </>}
  </main>
  <SiteFooter/>
 </div>;
}
// The download gate is the one thing the closed beta actually enforces, so it is its own component:
// what the dashboard shows depends only on the account's status, and a test can render both states.
export function DownloadCard({account,download}:{account:AccountView;download:BetaStatusView['download']}){
 return <section className={`site-card site-download ${account.status==='approved'?'':'locked'}`}>
  <span className="site-card-icon"><Download size={17}/></span>
  <h3>Download the launcher</h3>
  {account.status==='approved'?<>
   <p className="site-card-lead">Windows installer for the host, the operator panel, the overlay pages and the CS2 Game State Integration config. It bundles its own runtime — nothing else has to be installed.</p>
   <div className="site-download-meta">
    <span>WINDOWS 10/11 · x64</span><span>{download?.version||'SCOUT-Setup.exe'}</span><span>PER-USER INSTALL</span>
   </div>
   <a className="button primary wide" href={download?.url||'#'} target="_blank" rel="noreferrer"><Download size={15}/>Download for Windows</a>
   {download?.notes&&<p className="site-fineprint">{download.notes}</p>}
   <p className="site-fineprint">The installer writes the GSI config into the CS2 folder it detects, asks for the port and tokens, and keeps team data, uploads and recordings in your own user profile, so updating never touches match data.</p>
  </>:<>
   <p className="site-card-lead">{account.status==='rejected'?'The download opens for approved organisers. This application was not approved for the closed beta.':'The download opens the moment your application is approved — there is nothing to chase in the meantime.'}</p>
   <div className="site-download-meta locked"><span>STATUS: {statusLabel(account.status)}</span></div>
   <button className="button wide" disabled><Download size={15}/>Available after approval</button>
  </>}
 </section>;
}

// ------------------------------------------------------------------ the panel's own card
// The launcher side of the link, where the operator actually sees the code: a small card in the
// panel sidebar. It polls, so the moment the code is approved in the dashboard the card turns into
// the linked account without anyone refreshing anything.
export function LauncherLinkCard(){
 const [state,setState]=useState<{mode:string;link:InstallationView}|null>(null);
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
 const link=state?.link;
 if(!link) return null;
 if(link.linked) return <div className="launcher-link linked">
  <span className="launcher-link-head"><Link2 size={13}/>LAUNCHER LINKED</span>
  <b>{link.email}</b>
  <small>{link.displayName||'SCOUT account'} · {"device "}{link.deviceId?.slice(0,6)||'—'}</small>
  <button className="mini-button" onClick={()=>void unlink()} disabled={busy}>Unlink</button>
  <LicenceLine licence={licence}/>
  {error&&<span className="launcher-link-error">{error}</span>}
 </div>;
 if(link.pending) return <div className="launcher-link pending">
  <span className="launcher-link-head"><Loader2 className="spin" size={13}/>WAITING FOR APPROVAL</span>
  <b className="launcher-code">{link.pending.userCode}</b>
  <small>Sign in at <b>/dashboard</b> and approve this code. It expires {new Date(link.pending.expiresAt).toLocaleTimeString()}.</small>
  <button className="mini-button" onClick={()=>navigator.clipboard?.writeText(link.pending!.userCode).catch(()=>{})}><Copy size={11}/>Copy code</button>
  <LicenceLine licence={licence}/>
  {error&&<span className="launcher-link-error">{error}</span>}
 </div>;
 return <div className="launcher-link">
  <span className="launcher-link-head"><Link2 size={13}/>LAUNCHER NOT LINKED</span>
  <small>Link this installation to your SCOUT account so the website knows which launcher is yours.</small>
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
// ------------------------------------------------------------------ the owner's review desk
// Applications arrive from the landing page. This is where an owner decides: approve mints the
// one-time invite link and shows it once, ready to copy into whatever channel the organiser used to
// reach out. The link is never listed again, and rejecting says so plainly.
export function BetaApplicationsPanel(){
 const [state,setState]=useState<{mode:string;applications:AccountView[];link:InstallationView}|null>(null);
 const [busy,setBusy]=useState('');
 const [error,setError]=useState('');
 const [invite,setInvite]=useState<{email:string;url:string}|null>(null);
 const [notice,setNotice]=useState('');
 const load=React.useCallback(async()=>{
  const res=await apiFetch('/api/beta/applications');
  if(!res.ok){setError('Only an owner can review beta applications.');return}
  setState(await res.json());
 },[]);
 useEffect(()=>{void load()},[load]);
 async function decide(id:string,decision:'approve'|'reject'){
  setBusy(id);setError('');setNotice('');
  const res=await apiFetch(`/api/beta/applications/${id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision})});
  const body=await res.json().catch(()=>({}) as any);
  setBusy('');
  if(!res.ok){setError(body?.error||'That decision could not be saved.');return}
  if(decision==='approve') setInvite({email:body.application.email,url:body.inviteUrl||''});
  else setNotice(`${body.application.email} was rejected.`);
  void load();
 }
 const applications=state?.applications??[];
 const pending=applications.filter(entry=>entry.status==='pending').length;
 return <section className="panel detail-panel beta-applications">
  <div className="panel-heading"><h2>Beta applications <span className="subtle-pill">{pending} WAITING</span></h2><button className="text-button" onClick={()=>void load()}>Refresh<RefreshCw size={13}/></button></div>
  <p className="info-note">Applications are stored {state?.mode==='hosted'?'by the hosted account service':'on this machine, in config/beta/store.json'}. Approving mints a one-time invite link that lets the applicant set their own password — send it however you already talk to them; the link stops working once used.</p>
  {error&&<Notice>{error}</Notice>}
  {notice&&<Notice tone="ok">{notice}</Notice>}
  {invite&&<div className="invite-slip">
   <div><b>Invite link for {invite.email}</b><small>Shown once. The applicant sets their password through it, then signs in at /login.</small></div>
   <code>{invite.url}</code>
   <button className="mini-button" onClick={()=>navigator.clipboard?.writeText(invite.url).catch(()=>{})}><Copy size={11}/>Copy link</button>
  </div>}
  {applications.length?<div className="beta-list">{applications.map(entry=><article key={entry.id} className={'beta-row '+entry.status}>
   <div className="beta-who"><b>{entry.displayName}</b><small>{entry.email}{entry.organisation?` · ${entry.organisation}`:''}{entry.country?` · ${entry.country}`:''}</small></div>
   <p className="beta-use">{entry.useCase||'No note supplied.'}</p>
   <span className={`site-status ${statusTone(entry.status)}`}><span className="status-dot"/>{statusLabel(entry.status)}</span>
   <div className="beta-actions">
    {entry.status!=='approved'&&<button className="button primary" disabled={busy===entry.id} onClick={()=>void decide(entry.id,'approve')}>{busy===entry.id?<Loader2 className="spin" size={13}/>:<Check size={13}/>}Approve</button>}
    {entry.status!=='rejected'&&<button className="button danger-button" disabled={busy===entry.id} onClick={()=>void decide(entry.id,'reject')}>Reject</button>}
    {(entry.status==='approved')&&<button className="button" disabled={busy===entry.id} onClick={()=>void decide(entry.id,'approve')}>New invite link</button>}
   </div>
  </article>)}</div>:<p className="beta-empty">No applications yet. They appear here the moment somebody applies at <code>/apply</code>.</p>}
 </section>;
}
// ------------------------------------------------------------------ router
export function SiteRouter({route}:{route:SiteRoute}){
 const params=new URLSearchParams(location.search);
 const linkCode=params.get('link')||params.get('device')||undefined;
 const invite=params.get('invite')||undefined;
 if(route==='/welcome') return <LandingPage/>;
 if(route==='/apply') return <ApplyPage/>;
 if(route==='/dashboard') return <DashboardPage linkCode={linkCode}/>;
 return <LoginPage linkCode={linkCode} invite={invite}/>;
}
