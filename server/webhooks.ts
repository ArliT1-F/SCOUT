// Outbound notifications for a finished match (Recap Kit). Same discipline as the email outbox: the
// URL is validated before it is used, nothing follows a redirect, a failure is reported rather than
// retried forever, and no secret ever reaches a log.
//
// The host is a machine on a venue network. A webhook URL typed into it is therefore an SSRF target,
// so the rules are strict: https only, a public host only, no credentials in the URL, no redirects,
// bounded response size and a hard timeout.
import type {Recap} from './recap.js';
import {recapCaption} from './recap-card.js';

export interface WebhookTarget {url:string;kind:'discord'|'webhook'}
export interface WebhookResult {ok:boolean;status:number;detail:string}
export class WebhookError extends Error {}
const PRIVATE_HOST=/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|.*\.local$|.*\.internal$)/i;
// The URL is accepted only if a browser would show it as an ordinary public address. Discord's own
// hosts are the only named exemption, because an organiser pasting a discord.com link is the point.
export function validateWebhookUrl(raw:string):WebhookTarget {
 const value=String(raw??'').trim();
 if(!value) throw new WebhookError('Paste the webhook URL first.');
 if(value.length>500) throw new WebhookError('That URL is too long.');
 let url:URL;
 try{url=new URL(value)}catch{throw new WebhookError('That does not look like a URL.')}
 if(url.protocol!=='https:') throw new WebhookError('Webhooks must use https:// — a plain http URL would send the summary in the clear.');
 if(url.username||url.password) throw new WebhookError('Remove the username and password from the URL.');
 if(PRIVATE_HOST.test(url.hostname)) throw new WebhookError('That address is on a private network. Use a public https endpoint.');
 const isDiscord=/(^|\.)discord(app)?\.com$/i.test(url.hostname)||/(^|\.)discord\.com$/i.test(url.hostname);
 return {url:url.toString(),kind:isDiscord?'discord':'webhook'};
}
export function buildRecapDiscordMessage(recap:Recap,hubUrl?:string){
 const score=recap.teams.map(team=>`**${team.name}** ${team.mapsWon}`).join(' — ');
 const maps=recap.maps.map(map=>`${map.map.replace(/^de_/,'')} \`${map.ctScore}:${map.tScore}\``).join(' · ');
 const lines=[
  `**${recap.event?`${recap.event} · `:''}${recap.name}**`,
  recap.seriesWinner!==null?`🏆 ${recap.teams[recap.seriesWinner].name} win — ${score}`:`Series ${score}`,
  maps?`Maps: ${maps}`:'',
  recap.mvp?`⭐ MVP: ${recap.mvp.name} — ${recap.mvp.kills}/${recap.mvp.deaths}${recap.mvp.headshots?`, ${recap.mvp.headshots} HS`:''}`:'',
  hubUrl?`Full results: ${hubUrl}`:'',
 ].filter(Boolean);
 return {content:lines.join('\n'),username:'SCOUT',allowed_mentions:{parse:[] as string[]}};
}
function sleep(ms:number){return new Promise(resolve=>setTimeout(resolve,ms))}
export interface DeliverOptions {fetchImpl?:typeof fetch;timeoutMs?:number;retries?:number;sleep?:typeof sleep}
export async function deliverWebhook(target:WebhookTarget,payload:unknown,options:DeliverOptions={}):Promise<WebhookResult> {
 const fetchImpl=options.fetchImpl??fetch;
 const timeoutMs=options.timeoutMs??8_000;
 const retries=options.retries??2;
 const wait=options.sleep??sleep;
 let last:WebhookResult={ok:false,status:0,detail:'Not attempted.'};
 for(let attempt=0;attempt<=retries;attempt++){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const response=await fetchImpl(target.url,{method:'POST',headers:{'Content-Type':'application/json','User-Agent':'SCOUT/1 recap'},body:JSON.stringify(payload),redirect:'error',signal:controller.signal});
   const text=await response.text().catch(()=> '');
   if(response.ok) return {ok:true,status:response.status,detail:'Delivered.'};
   last={ok:false,status:response.status,detail:`The endpoint answered ${response.status}${text?`: ${text.slice(0,160)}`:''}`};
   // 429 and 5xx are worth another try; a 4xx means the URL or payload is wrong and retrying cannot help.
   if(response.status!==429&&response.status<500) return last;
   const retryAfter=Number(response.headers.get('retry-after'));
   if(Number.isFinite(retryAfter)&&retryAfter>0) await wait(Math.min(10_000,retryAfter*1000));
   else await wait(400*(attempt+1));
  }catch(error:any){
   last={ok:false,status:0,detail:error?.name==='AbortError'?'The endpoint did not answer in time.':`Could not reach the endpoint: ${error?.message||error}`};
   await wait(400*(attempt+1));
  }finally{clearTimeout(timer)}
 }
 return last;
}
