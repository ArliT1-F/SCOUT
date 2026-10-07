import React,{useEffect,useState} from 'react';
import {Activity,Check,CircleAlert,Download,Loader2,PackagePlus,RefreshCw,Trash2,Wifi} from 'lucide-react';
import {apiFetch} from './session';
import type {InstallationView} from '../server/beta';
import type {LicenceView} from '../server/licensing';
import type {HealthSnapshot,ReleaseInfo,RequestSummary} from '../server/operations';
// The deployment's own desk: is this host healthy, what installer are approved accounts being given,
// and did anything fail lately. Everything here answers to the owner, comes from the host's own
// counters (server/operations.ts), and is deliberately small — a wall of green ticks is not a
// health check. The one state an operator must not miss (a licence that is not active) is announced,
// not buried.
interface OpsPayload {
 health:HealthSnapshot;
 releases:ReleaseInfo[];
 licence:LicenceView;
 link:InstallationView;
 download:{folder:string;defaultUrl:string;defaultVersion:string};
}
const bytes=(value:number|null)=>value===null?'—':value>1024*1024?`${(value/1024/1024).toFixed(1)} MB`:`${Math.max(1,Math.round(value/1024))} KB`;
const duration=(ms:number)=>{const minutes=Math.floor(ms/60000);if(minutes<60)return `${minutes} min`;const hours=Math.floor(minutes/60);return `${hours} h ${minutes%60} min`};
const levelIcon=(level:string)=>level==='bad'?<CircleAlert size={14}/>:level==='warn'?<CircleAlert size={14}/>:<Check size={14}/>;
export function OperationsPanel(){
 const [data,setData]=useState<OpsPayload|null>(null);
 const [error,setError]=useState('');
 const [busy,setBusy]=useState('');
 const [form,setForm]=useState({version:'',file:'',url:'',notes:''});
 const [notice,setNotice]=useState('');
 const load=React.useCallback(async()=>{
  const res=await apiFetch('/api/ops/health');
  if(!res.ok){setError('Only an owner can read the operations desk.');return}
  setError('');setData(await res.json());
 },[]);
 useEffect(()=>{void load();const timer=setInterval(()=>void load(),15000);return()=>clearInterval(timer)},[load]);
 async function publish(event:React.FormEvent){
  event.preventDefault();
  setBusy('publish');setError('');setNotice('');
  const res=await apiFetch('/api/ops/releases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:form.version,file:form.file||undefined,url:form.url||undefined,notes:form.notes||undefined})});
  const body=await res.json().catch(()=>({}) as any);
  setBusy('');
  if(!res.ok){setError(body?.error||'That release could not be published.');return}
  setNotice(`Launcher ${body.release.version} published. Approved dashboards now point at ${body.release.file||body.release.url}.`);
  setForm({version:'',file:'',url:'',notes:''});
  void load();
 }
 async function retire(version:string){
  setBusy(version);setNotice('');
  const res=await apiFetch(`/api/ops/releases/${encodeURIComponent(version)}`,{method:'DELETE'});
  setBusy('');
  if(!res.ok){setError('That release could not be retired.');return}
  setNotice(`Release ${version} retired; the dashboard falls back to the default download.`);
  void load();
 }
 const health=data?.health;
 const requests:RequestSummary|undefined=health?.requests;
 return <section className="panel detail-panel ops-panel">
  <div className="panel-heading"><h2>Operations <span className="subtle-pill">{health?`UP ${duration(health.uptimeMs)}`:'LOADING'}</span></h2><button className="text-button" onClick={()=>void load()}>Refresh<RefreshCw size={13}/></button></div>
  <p className="info-note">This host's own counters: uptime, the CS2 feed, output connections, the beta accounts, the launcher release being handed out, and the requests it has answered in the last 15 minutes. Nothing here is sent anywhere — it exists so the person running the deployment can see the state of it.</p>
  {error&&<p className="ops-error">{error}</p>}
  {notice&&<p className="ops-notice">{notice}</p>}
  {health&&<>
   <div className="ops-metrics">
    {[{label:'HOST',value:`v${health.version}`,hint:`pid ${health.pid} · ${health.beta.mode} accounts`},
      {label:'CS2 FEED',value:health.output.gsiPackets>0?(health.output.gsiAgeMs!==null&&health.output.gsiAgeMs<5000?'LIVE':'STALE'):'WAITING',hint:health.output.gsiAgeMs!==null?`last packet ${Math.round(health.output.gsiAgeMs/1000)}s ago`:'no packet yet'},
      {label:'OUTPUTS',value:String(health.output.clients),hint:'connected /obs or /game clients'},
      {label:'BETA',value:`${health.beta.applications.approved}/${health.beta.applications.pending}`,hint:`approved / waiting · ${health.beta.devices} launcher(s) linked`},
      {label:'LICENCE',value:health.licence?health.licence.state.toUpperCase():'—',hint:health.licence?.enforced?'enforced by SCOUT_REQUIRE_LICENCE':'reported, not enforced'},
      {label:'LAUNCHER',value:health.releases.latest||'default',hint:`${health.releases.downloads} download(s) counted`}].map(metric=><div className="ops-metric" key={metric.label}><small>{metric.label}</small><b>{metric.value}</b><span>{metric.hint}</span></div>)}
   </div>
   <div className="ops-grid">
    <div className="ops-block">
     <h3><Activity size={14}/>Needs attention</h3>
     {health.attention.length?<ul className="ops-attention">{health.attention.map(item=><li className={item.level} key={item.title}>{levelIcon(item.level)}<div><b>{item.title}</b><small>{item.detail}</small></div></li>)}</ul>
      :<p className="ops-quiet">Nothing needs attention: the feed is live, no server errors, and a launcher release is published.</p>}
    </div>
    <div className="ops-block">
     <h3><Wifi size={14}/>Requests · last {Math.round((requests?.windowMs||0)/60000)} min</h3>
     {requests?<>
      <div className="ops-counts">
       <span className="ok"><b>{requests.byClass.ok}</b>ok</span>
       <span><b>{requests.byClass.redirect}</b>redirect</span>
       <span className={requests.byClass.clientError?'warn':''}><b>{requests.byClass.clientError}</b>4xx</span>
       <span className={requests.byClass.serverError?'bad':''}><b>{requests.byClass.serverError}</b>5xx</span>
      </div>
      <ul className="ops-routes">{requests.top.map(route=><li key={route.path}><code>{route.path}</code><span>{route.count}</span></li>)}</ul>
      <details className="ops-recent"><summary>Recent requests ({requests.recent.length})</summary>
       <ul>{requests.recent.slice(0,24).map((entry,index)=><li key={index} className={entry.status>=400?'bad':''}><code>{entry.method} {entry.path}</code><span>{entry.status} · {entry.ms} ms</span></li>)}</ul>
      </details>
     </>:<p className="ops-quiet">No requests counted yet.</p>}
    </div>
    <div className="ops-block">
     <h3><PackagePlus size={14}/>Launcher releases</h3>
     <form className="ops-release-form" onSubmit={publish}>
      <label className="field"><span>VERSION</span><input value={form.version} onChange={event=>setForm({...form,version:event.target.value})} placeholder="0.4.1" spellCheck={false}/></label>
      <label className="field"><span>FILE IN {data.download.folder.toUpperCase()}</span><input value={form.file} onChange={event=>setForm({...form,file:event.target.value})} placeholder="SCOUT-Setup-0.4.1.exe" spellCheck={false}/></label>
      <label className="field"><span>OR EXTERNAL URL</span><input value={form.url} onChange={event=>setForm({...form,url:event.target.value})} placeholder="https://… (optional)" spellCheck={false}/></label>
      <label className="field"><span>NOTES FOR OPERATORS</span><input value={form.notes} onChange={event=>setForm({...form,notes:event.target.value})} placeholder="What changed in this build" maxLength={400}/></label>
      <button className="button primary" type="submit" disabled={busy==='publish'||!form.version.trim()}>{busy==='publish'?<Loader2 className="spin" size={14}/>:<PackagePlus size={14}/>}Publish release</button>
     </form>
     <p className="ops-hint">Build with <code>npm run package:windows</code>, copy <code>SCOUT-Setup-&lt;version&gt;.exe</code> into <code>{data.download.folder}</code>, then publish it here. With nothing published, approved dashboards use <code>{data.download.defaultUrl}</code>.</p>
     {data.releases.length?<ul className="ops-releases">{data.releases.map(release=><li key={release.version}>
      <div><b>{release.version}</b><small>{release.file||release.url} · {bytes(release.sizeBytes)} · {new Date(release.publishedAt).toLocaleString()} · {release.downloads} download(s){release.notes?` · ${release.notes}`:''}</small></div>
      <button className="mini-button" onClick={()=>void retire(release.version)} disabled={busy===release.version}><Trash2 size={11}/>Retire</button>
     </li>)}</ul>:<p className="ops-quiet">No release published yet — the dashboard is pointing at the default download.</p>}
     <a className="text-button" href={data.download.defaultUrl} target="_blank" rel="noreferrer">Open the current default download<Download size={13}/></a>
    </div>
    <div className="ops-block">
     <h3><Check size={14}/>This installation's link</h3>
     <dl className="ops-facts">
      <div><dt>LAUNCHER</dt><dd>{data.link.linked?`linked to ${data.link.email}`:data.link.pending?'waiting for approval':'not linked'}</dd></div>
      <div><dt>DEVICE</dt><dd>{data.link.deviceId||'—'}</dd></div>
      <div><dt>LICENCE</dt><dd>{data.licence.state}{data.licence.email?` · ${data.licence.email}`:''}</dd></div>
      <div><dt>ENFORCED</dt><dd>{data.licence.enforced?'yes (SCOUT_REQUIRE_LICENCE=1)':'no'}</dd></div>
      <div><dt>CHECKED</dt><dd>{data.licence.checkedAt?new Date(data.licence.checkedAt).toLocaleTimeString():'this host is its own authority'}</dd></div>
     </dl>
     <p className="ops-hint">{data.licence.message}</p>
    </div>
   </div>
  </>}
 </section>;
}
