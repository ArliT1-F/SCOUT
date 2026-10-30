import React,{useEffect,useMemo,useState} from 'react';
import {ArrowRight,CalendarDays,Check,Clock3,ExternalLink,Globe2,Radio,Sparkles,Trophy,Users} from 'lucide-react';
import {SiteFooter,SiteNav,useDocumentMeta,type SiteRoute} from './site';
import {formatPrice,FEATURE_LABELS,type Entitlements,type PublicPlanView} from '../server/plans';
import type {PublicTournament} from '../server/hub';

// ------------------------------------------------------------------ pricing
// §5 of docs/LAUNCH-FEATURES.md. The page shows what the server says the plans are — the same
// `publicPlanViews()` the checkout endpoint prices from — so the card and the invoice cannot drift.
// Nothing here is a promise about a feature the host does not gate: the list comes from PLANS.
const FEATURE_ORDER=Object.keys(FEATURE_LABELS) as Array<keyof typeof FEATURE_LABELS>;

export function PricingPage(){
 useDocumentMeta({title:'Pricing — SCOUT',description:'SCOUT pricing for community tournaments, venues and production crews. Start with a fourteen-day trial; every plan includes the overlay, nine scenes and the operator panel.',robots:'index, follow'});
 const [plans,setPlans]=useState<PublicPlanView[]|null>(null);
 const [entitlements,setEntitlements]=useState<Entitlements|null>(null);
 const [ready,setReady]=useState(false);
 const [account,setAccount]=useState(false);
 const [busy,setBusy]=useState('');
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 useEffect(()=>{
  let live=true;
  (async()=>{
   try{
    const response=await fetch('/api/billing/status');
    if(!response.ok) throw new Error('Pricing could not be loaded.');
    const body=await response.json();
    if(!live) return;
    setPlans(body.plans||null);setEntitlements(body.entitlements||null);setReady(Boolean(body.ready));setAccount(Boolean(body.billing!==undefined&&body.entitlements));
   }catch(failure:any){if(live)setError(failure?.message||'Pricing could not be loaded.')}
  })();
  return()=>{live=false};
 },[]);
 const checkout=async(plan:string)=>{
  setBusy(plan);setError('');
  try{
   const response=await fetch('/api/billing/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan})});
   const body=await response.json().catch(()=>({}));
   if(!response.ok) throw new Error(body?.error||'Checkout is not available right now.');
   location.href=body.url;
  }catch(failure:any){setError(failure?.message||'Checkout is not available right now.')}
  finally{setBusy('')}
 };
 const trial=async()=>{
  setBusy('trial');setError('');setNotice('');
  try{
   const response=await fetch('/api/beta/trial',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
   const body=await response.json().catch(()=>({}));
   if(!response.ok) throw new Error(body?.error||'A trial could not be started from here.');
   setNotice(body?.invite?.url?`Trial started. Open the invitation to set your password: ${body.invite.url}`:'Trial started — check your inbox for the invitation.');
  }catch(failure:any){setError(failure?.message||'Start the trial from the application form, where we ask for your details.')}
  finally{setBusy('')}
 };
 return <div className="site-shell">
  <SiteNav account={null}/>
  <main className="site-main">
   <section className="site-pricing-head">
    <div className="eyebrow">PRICING</div>
    <h1>Pay for the stream you are actually running.</h1>
    <p className="site-lead">Every plan is the same product: the overlays, the nine scenes, the operator panel, the run of show and the recap kit. Plans differ in how many tournaments and hosts you can run at once — never in whether the broadcast works.</p>
   </section>
   {error&&<p className="site-notice bad" role="alert">{error}</p>}
   {notice&&<p className="site-notice ok" role="status">{notice}</p>}
   <section className="site-price-grid">
    {(plans||[]).map(plan=><article key={plan.id} className={'site-price-card'+(plan.current?' current':'')}>
     {plan.current&&<span className="site-price-badge">YOUR PLAN</span>}
     <h2>{plan.name}</h2>
     <p className="site-price-tagline">{plan.tagline}</p>
     <p className="site-price"><b>{plan.priceCents===0?'Free':formatPrice(plan.priceCents,plan.currency)}</b>{plan.priceCents>0&&<small> / {plan.interval}</small>}</p>
     <ul className="site-price-list">
      <li><Check size={13}/>{plan.tournaments} tournament{plan.tournaments===1?'':'s'} at a time</li>
      <li><Check size={13}/>{plan.devices} linked host{plan.devices===1?'':'s'}</li>
      {plan.features.map(feature=><li key={feature}><Check size={13}/>{FEATURE_LABELS[feature]}</li>)}
     </ul>
     {account?<button type="button" className={'button '+(plan.current?'':'primary')} disabled={plan.current||Boolean(busy)||!ready} onClick={()=>void checkout(plan.id)}>{plan.current?'Current plan':plan.priceCents===0?'Included':busy===plan.id?'Opening checkout…':'Choose '+plan.name}</button>
      :<a className="button primary" href="/apply">Apply for the beta<ArrowRight size={14}/></a>}
     {!ready&&<small className="site-price-hint">Card payments open shortly; the beta is invitation-only until then.</small>}
    </article>)}
   </section>
   <section className="site-pricing-notes">
    <div><h3><Clock3 size={16}/>Fourteen-day trial</h3><p>A trial is a real account with real overlays for fourteen days, one tournament at a time. No card is taken up front; nothing is charged automatically when it ends.</p></div>
    <div><h3><Check size={16}/>What a lapsed payment never does</h3><p>It never stops a broadcast that is already running, and it never takes a licence away mid-series. A past-due account keeps its limits for seven days, then may not start a new tournament until it is settled.</p></div>
    <div><h3><Sparkles size={16}/>Founders keep their terms</h3><p>Every account from the closed beta stays on the Founder plan — all features at no cost — as a thank-you for testing the product when it had none of these features.</p></div>
   </section>
   <section className="site-pricing-faq">
    <h2>Questions an organiser actually asks</h2>
    <details><summary>Do I need a card to try it?</summary><p>No. The trial asks for an email address and sends an invitation; the card only appears when you choose a paid plan.</p></details>
    <details><summary>What counts as a linked host?</summary><p>A launcher installation approved on your account. Operators on the same machine do not need separate hosts; multi-host is for a production with more than one observer station.</p></details>
    <details><summary>What happens if I run more tournaments than my plan?</summary><p>The limit applies when you <em>start</em> a tournament. Existing tournaments keep running and stay editable; you will be asked to archive one or move up a plan.</p></details>
    <details><summary>Can I cancel?</summary><p>Yes, from your profile. The plan stays active until the end of the period you paid for, then the account returns to read-only above the free limits — archives included, because they are yours.</p></details>
   </section>
  </main>
  <SiteFooter/>
 </div>;
}

// ------------------------------------------------------------------ tournament hub
// The public page. Everything it renders came from /api/public/tournaments/:slug, which is the
// projection in server/hub.ts — so this component cannot leak what the projection refused to send.
// The crawler-facing copy of these tags is written into the shell by the host (injectHubMeta).
function useHub(slug:string){
 const [data,setData]=useState<PublicTournament|null>(null);
 const [state,setState]=useState<'loading'|'ready'|'missing'|'error'>('loading');
 useEffect(()=>{
  let live=true;
  (async()=>{
   try{
    const response=await fetch(`/api/public/tournaments/${encodeURIComponent(slug)}`);
    if(response.status===404){if(live)setState('missing');return}
    if(!response.ok) throw new Error('unavailable');
    const body=await response.json();
    if(!live) return;
    setData(body.tournament);setState('ready');
   }catch{if(live)setState('error')}
  })();
  return()=>{live=false};
 },[slug]);
 return {data,state};
}
const when=(at:number)=>new Date(at).toLocaleString([], {weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
export function TournamentPage({slug}:{slug:string}){
 const {data,state}=useHub(slug);
 useDocumentMeta({title:data?`${data.name} — SCOUT`:'Tournament — SCOUT',description:data?`${data.event||data.name}: bracket, results and fixtures.`:'A published SCOUT tournament.',robots:data&&data.visibility==='public'?'index, follow':'noindex, follow'});
 if(state==='loading') return <div className="site-shell hub-shell"><main className="site-main hub-main"><p className="hub-status">Loading the tournament…</p></main><SiteFooter/></div>;
 if(state!=='ready'||!data) return <div className="site-shell hub-shell"><main className="site-main hub-main">
  <div className="hub-missing"><Globe2 size={28}/><h1>{state==='missing'?'This tournament is not published':'The tournament could not be loaded'}</h1><p>{state==='missing'?'The organiser may have unpublished it, or the link has a typo. Ask them for the current link.':'The host did not answer. Try again in a moment — a live broadcast page reloads itself anyway.'}</p><a className="button primary" href="/welcome">What is SCOUT?<ArrowRight size={14}/></a></div>
 </main><SiteFooter/></div>;
 return <div className="site-shell hub-shell">
  <header className="hub-head">
   <a className="site-brand" href="/welcome"><Globe2 size={18}/> scout</a>
   <div className="hub-head-meta"><span>{data.event||data.name}</span>{data.live&&<span className="hub-live"><i/> LIVE</span>}{data.visibility==='unlisted'&&<span className="hub-unlisted">UNLISTED</span>}</div>
  </header>
  <main className="site-main hub-main">
   <section className="hub-hero">
    <div className="eyebrow">{data.stage||data.event||'TOURNAMENT'}</div>
    <h1>{data.name}</h1>
    <p className="hub-sub">{[data.format.toUpperCase(),`${data.totals.matches} match${data.totals.matches===1?'':'es'}`,data.totals.rounds?`${data.totals.rounds} rounds`:''].filter(Boolean).join(' · ')}</p>
    {data.links.stream&&<a className="button primary" href={data.links.stream} target="_blank" rel="noreferrer noopener"><Radio size={14}/>Watch live<ExternalLink size={13}/></a>}
   </section>
   <section className="hub-teams">
    {data.teams.map(team=><div className="hub-team" key={team.name+(team.tag||'')}>
     {team.logo?<img src={team.logo} alt="" loading="lazy"/>:<span className="hub-team-mark">{(team.tag||team.name).slice(0,3).toUpperCase()}</span>}
     <div><b>{team.name}</b>{team.tag&&<small>{team.tag}</small>}</div>
    </div>)}
   </section>
   {data.stages&&data.stages.length>0&&<section className="hub-block">
    <h2><Trophy size={16}/>Stages{data.stageHeadline?<span className="hub-stage-line">{data.stageHeadline}</span>:null}</h2>
    <div className="hub-stages">{data.stages.map(stage=><article className="hub-stage" key={stage.id}>
     <header><b>{stage.name}</b><small>{stage.kind==='group'?'GROUP STAGE':'KNOCKOUT'}</small></header>
     {stage.table.length>0?<table className="hub-table"><thead><tr><th>TEAM</th><th>P</th><th>W</th><th>L</th><th>MAPS</th><th>+/-</th><th>PTS</th></tr></thead><tbody>{stage.table.map(row=><tr key={row.team}>
      <td>{row.team}</td><td>{row.played}</td><td>{row.won}</td><td>{row.lost}</td><td>{row.mapsFor}:{row.mapsAgainst}</td><td>{row.diff>0?'+':''}{row.diff}</td><td><b>{row.points}</b></td>
     </tr>)}</tbody></table>:<div className="hub-stage-matches">{stage.matches.length?stage.matches.map((match,index)=><div className={'hub-match '+(match.status==='done'?'finished':'')} key={stage.id+index}>
      <div className={match.winner==='a'?'won':''}><span>{match.a}</span><b>{match.aScore}</b></div>
      <div className={match.winner==='b'?'won':''}><span>{match.b}</span><b>{match.bScore}</b></div>
     </div>):<p className="hub-empty">Bracket not published yet.</p>}</div>}
    </article>)}</div>
   </section>}
   {data.maps.length>0&&<section className="hub-block">
    <h2><Trophy size={16}/>Maps</h2>
    <div className="hub-maps">{data.maps.map((map,index)=><div className={'hub-map '+map.status} key={map.name+index}>
     <b>{map.name.replace(/^de_/,'')}</b>
     <span>{map.score?`${map.score[0]} : ${map.score[1]}`:map.status==='live'?'LIVE':'—'}</span>
     <small>{map.pick==='decider'?'Decider':`${map.pick} pick`}{map.status==='done'?' · final':''}</small>
    </div>)}</div>
   </section>}
   {data.schedule&&data.schedule.length>0&&<section className="hub-block">
    <h2><CalendarDays size={16}/>Fixtures</h2>
    <div className="hub-fixtures">{data.schedule.map(fixture=><div className="hub-fixture" key={fixture.id}>
     <div className="hub-fixture-time"><b>{new Date(fixture.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</b><small>{when(fixture.at).split(',')[0]}</small></div>
     <div className="hub-fixture-who"><b>{fixture.a} <em>vs</em> {fixture.b}</b><small>{[fixture.stage,fixture.format.toUpperCase()].filter(Boolean).join(' · ')}</small></div>
     {fixture.stream&&<a className="mini-button" href={fixture.stream} target="_blank" rel="noreferrer noopener">Watch</a>}
    </div>)}</div>
   </section>}
   {data.bracket&&<section className="hub-block">
    <h2><Trophy size={16}/>Bracket</h2>
    <div className="hub-bracket">{data.bracket.map(round=><div className="hub-round" key={round.name}>
     <span className="section-label">{round.name}</span>
     {round.matches.map((match,index)=><div className={'hub-match '+(match.status==='done'?'finished':'')} key={round.name+index}>
      <div className={match.winner==='a'?'won':''}><span>{match.a}</span><b>{match.aScore}</b></div>
      <div className={match.winner==='b'?'won':''}><span>{match.b}</span><b>{match.bScore}</b></div>
     </div>)}
    </div>)}</div>
   </section>}
   {data.teams.some(team=>team.players.length>0)&&<section className="hub-block">
    <h2><Users size={16}/>Players</h2>
    <div className="hub-players">{data.teams.flatMap(team=>team.players.map(player=><div className="hub-player" key={team.name+player.name}><b>{player.name}</b><small>{player.role||'player'}</small></div>))}</div>
   </section>}
   <footer className="hub-foot"><span>Bracket and results published by the organiser.</span><span>Overlay and page by <a href="/welcome">SCOUT</a> — GSI only, no injection.</span><span>Updated {new Date(data.updatedAt).toLocaleString()}</span></footer>
  </main>
 </div>;
}
// The embedded widget is the same data, cropped for an iframe: no navigation, no footer, nothing
// that competes with the stream it is layered over.
export function HubEmbedPage({slug}:{slug:string}){
 const {data,state}=useHub(slug);
 useDocumentMeta({title:data?`${data.name} — SCOUT`:'Tournament — SCOUT',description:'SCOUT tournament widget.',robots:'noindex, follow'});
 const next=useMemo(()=>data?.schedule?.filter(fixture=>fixture.at>Date.now()-30*60_000).slice(0,3)??[],[data]);
 if(state!=='ready'||!data) return <div className="hub-embed"><p>{state==='missing'?'This tournament is not published.':'Loading…'}</p></div>;
 return <div className="hub-embed">
  <header><b>{data.name}</b>{data.live&&<span className="hub-live"><i/>LIVE</span>}<span className="hub-embed-brand">SCOUT</span></header>
  <div className="hub-embed-teams">{data.teams.map(team=><span key={team.name}>{team.tag||team.name}</span>)}</div>
  {next.length>0&&<ul className="hub-embed-fixtures">{next.map(fixture=><li key={fixture.id}><b>{new Date(fixture.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</b><span>{fixture.a} vs {fixture.b}</span></li>)}</ul>}
  <footer>{data.stage||data.event||'Tournament'}{data.maps.length>0&&<span>{data.maps.filter(map=>map.status==='done').length}/{data.maps.length} maps</span>}</footer>
 </div>;
}
export const HUB_ROUTE_PREFIXES=['/t/','/embed/'] as const;
export function hubSlug(path:string):{kind:'page'|'embed';slug:string}|null{
 const match=/^\/(t|embed)\/([a-z0-9][a-z0-9-]{1,48})\/?$/i.exec(path);
 if(!match) return null;
 return {kind:match[1]==='t'?'page':'embed',slug:match[2].toLowerCase()};
}
export type {SiteRoute};
