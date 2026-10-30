// Tournament Hub (docs/LAUNCH-FEATURES.md §1): a public page per event, built as a *projection* of
// the platform store rather than a second source of truth.
//
// The projection is the security boundary. Rosters hold real names, aliases, photos and SteamIDs;
// the store holds emails, logs and operator data. None of that is copied here — the types below have
// no field for it, and a test asserts the serialised result cannot contain those keys. Public means
// public: what an organiser published, and nothing else.
import type {Tournament} from './platform.js';
import type {BracketConfig,ScoutConfig,ScheduleSlot} from './config.js';
import {resolveSlotLabel} from './config.js';
import {buildStages,stageHeadline,type PublicStage} from './stages.js';

const escapeXml=(value:string)=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
export type HubVisibility='public'|'unlisted'|'private';
export const HUB_PATH='/t/';
export const EMBED_PATH='/embed/';
export interface Publication {
 slug:string;
 visibility:HubVisibility;
 showRoster:boolean;
 showSchedule:boolean;
 stream:string;
 updatedAt:number;
}
export const PUBLIC_SLUG=/^[a-z0-9](?:[a-z0-9-]{0,46})[a-z0-9]$/;
// A slug is derived from the tournament name once and then left alone: links get pasted into Discord,
// printed on posters and embedded in stream overlays, so changing a slug silently breaks them.
export function slugify(value:string):string {
 const slug=String(value??'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
  .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,48).replace(/-+$/,'');
 return slug.length>=2?slug:`event-${slug||'page'}`.slice(0,48);
}
export function defaultPublication(name:string,now=Date.now()):Publication {
 return {slug:slugify(name),visibility:'unlisted',showRoster:false,showSchedule:true,stream:'',updatedAt:now};
}
export interface PublicationInput {
 published?:boolean;
 slug?:string;
 visibility?:HubVisibility;
 showRoster?:boolean;
 showSchedule?:boolean;
 stream?:string;
}
// `null` means "unpublish". Anything malformed falls back to the previous value rather than throwing:
// a publication is not worth failing a whole request over, and every field has a safe answer.
export function normalizePublication(input:PublicationInput|undefined,previous:Publication|null,now=Date.now()):Publication|null {
 if(!input) return previous;
 if(input.published===false) return null;
 // A typed slug with nothing alphanumeric in it is not an instruction to rename the page — it is a
 // mistake in a form, so the page keeps the address its links were already printed with.
 const requested=typeof input.slug==='string'?input.slug.trim():'';
 const candidate=requested&&/[a-z0-9]/i.test(requested)?slugify(requested):previous?.slug??slugify('event');
 const visibility=input.visibility==='public'||input.visibility==='unlisted'||input.visibility==='private'?input.visibility:previous?.visibility??'unlisted';
 return {
  slug:PUBLIC_SLUG.test(candidate)?candidate:previous?.slug??slugify('event'),
  visibility,
  // Rosters are opt-in and stay opt-in: a publication created by an older build does not suddenly
  // start naming players because a default changed.
  showRoster:typeof input.showRoster==='boolean'?input.showRoster:previous?.showRoster??false,
  showSchedule:typeof input.showSchedule==='boolean'?input.showSchedule:previous?.showSchedule??true,
  stream:safeStreamUrl(input.stream??previous?.stream??''),
  updatedAt:now,
 };
}
// A stream link is shown as an anchor on a public page, so only schemes a browser can safely follow
// survive. Anything else (javascript:, data:, an overlong string) becomes "no link".
export function safeStreamUrl(value:string):string {
 const raw=String(value??'').trim();
 if(!raw||raw.length>300) return '';
 try{const url=new URL(raw);return url.protocol==='https:'||url.protocol==='http:'?url.toString():''}catch{return ''}
}
// A logo path is only ever a shipped asset: uploads live on the venue's own machine and are not
// reachable from the website, and an absolute URL would turn a public page into an open redirect.
function publicLogo(value:string):string|null {
 const raw=String(value??'').trim().replace(/^\/+/,'');
 if(!raw||raw.length>200||raw.includes('..')) return null;
 if(/^uploads\//.test(raw)) return null;
 return /^(?:assets|thumbs|icons|radars)\/[\w./-]+\.(?:png|jpe?g|webp|svg|gif)$/i.test(raw)?`/${raw}`:null;
}
export interface PublicTeam {name:string;tag:string;logo:string|null;players:Array<{name:string;role:string}>}
export interface PublicMatch {
 a:string;b:string;aScore:number;bScore:number;
 winner:'a'|'b'|null;status:'upcoming'|'live'|'done';round:string;
}
export interface PublicMapResult {name:string;score:[number,number]|null;status:string;pick:string}
export interface PublicRound {name:string;matches:PublicMatch[]}
export interface PublicFixture {id:string;a:string;b:string;stage:string;format:string;at:number;stream:string}
export interface PublicTournament {
 slug:string;
 visibility:HubVisibility;
 name:string;
 event:string;
 stage:string;
 format:string;
 live:boolean;
 updatedAt:number;
 teams:PublicTeam[];
 maps:PublicMapResult[];
 bracket:PublicRound[];
 schedule:PublicFixture[];
 stages:PublicStage[];
 stageHeadline:string;
 totals:{kills:number;headshots:number;rounds:number;maps:number;matches:number};
 links:{stream:string|null};
}
const LIVE_WINDOW_MS=10*60_000;
const publicTeam=(team:ScoutConfig['teams'][number],showRoster:boolean):PublicTeam=>({
 name:team.name,tag:team.tag,logo:publicLogo(team.logo),
 // The gamer name and the role, never the real name, the alias or the SteamID.
 players:showRoster?team.players.map(player=>({name:player.nickname||player.alias||player.name,role:player.role})):[],
});
const publicRounds=(bracket:BracketConfig|undefined,teams:ScoutConfig['teams']):PublicRound[]=>{
 if(!bracket?.rounds?.length) return [];
 return bracket.rounds.map(round=>({
  name:round.name,
  matches:round.matches.map(match=>({
   a:resolveSlotLabel(match.a,teams),b:resolveSlotLabel(match.b,teams),
   aScore:match.aScore,bScore:match.bScore,winner:match.winner,status:match.status,round:round.name,
  })),
 }));
};
const fixtures=(schedule:ScheduleSlot[]|undefined,teams:ScoutConfig['teams']):PublicFixture[]=>{
 if(!schedule?.length) return [];
 return [...schedule].sort((first,second)=>first.at-second.at).map(slot=>({
  id:slot.id,
  a:slot.a.label||resolveSlotLabel({label:slot.a.label,team:slot.a.team},teams),
  b:slot.b.label||resolveSlotLabel({label:slot.b.label,team:slot.b.team},teams),
  stage:slot.stage,format:slot.format,at:slot.at,stream:safeStreamUrl(slot.stream),
 }));
};
// The one function every public read goes through. A private (or missing) publication is `null`, and
// every caller turns that into a 404 — never a page with the data removed from it.
export function projectTournament(tournament:Tournament,now=Date.now()):PublicTournament|null {
 const publication=tournament.publication;
 if(!publication||publication.visibility==='private') return null;
 const config=(tournament.config??null) as ScoutConfig|null;
 const teams=config?.teams??[];
 const stages=buildStages(teams.map(team=>team.name),publicRounds(config?.bracket,teams).map(round=>({name:round.name,matches:round.matches})));
 return {
  slug:publication.slug,
  visibility:publication.visibility,
  name:tournament.name,
  event:config?.event?.name||'',
  stage:config?.event?.stage||'',
  format:config?.format||'bo3',
  live:Boolean(tournament.lastActiveAt&&now-tournament.lastActiveAt<LIVE_WINDOW_MS),
  updatedAt:tournament.updatedAt,
  teams:teams.map(team=>publicTeam(team,publication.showRoster)),
  maps:(config?.maps??[]).map(map=>({name:map.name,score:map.score?[map.score[0],map.score[1]]:null,status:map.status,pick:map.pick})),
  bracket:publicRounds(config?.bracket,teams),
  schedule:publication.showSchedule?fixtures(config?.schedule,teams):[],
  // Multi-stage hubs: a tournament is "Group stage → Playoffs" when the bracket says so, and one table
  // per group stage. Both are projections of the same bracket — see server/stages.ts.
  stages:stages,
  stageHeadline:stageHeadline(stages),
  totals:tournament.totals,
  links:{stream:publication.stream||null},
 };
}
export interface HubSummary {slug:string;name:string;event:string;stage:string;live:boolean;updatedAt:number;visibility:HubVisibility}
export function summarizeHub(tournament:Tournament,now=Date.now()):HubSummary|null {
 const projected=projectTournament(tournament,now);
 if(!projected) return null;
 return {slug:projected.slug,name:projected.name,event:projected.event,stage:projected.stage,live:projected.live,updatedAt:projected.updatedAt,visibility:projected.visibility};
}
// What a crawler, a chat client and a stream overlay are told about the page. Kept here so the server
// shell, the sitemap and the tests all describe a tournament the same way.
export interface HubMeta {title:string;description:string;robots:'index, follow'|'noindex, follow'}
export function hubMeta(tournament:PublicTournament):HubMeta {
 const title=`${tournament.name}${tournament.stage?` — ${tournament.stage}`:''} · SCOUT`;
 const scoreline=tournament.maps.filter(map=>map.score).map(map=>`${map.name.replace(/^de_/,'')} ${map.score![0]}:${map.score![1]}`).join(', ');
 const description=[tournament.event||tournament.name,scoreline,tournament.teams.map(team=>team.name).join(' vs '),'bracket, results and fixtures.']
  .filter(Boolean).join(' · ').slice(0,300);
 return {title,description,robots:tournament.visibility==='public'?'index, follow':'noindex, follow'};
}
export function hubUrl(baseUrl:string,slug:string):string{return `${baseUrl.replace(/\/+$/,'')}${HUB_PATH}${slug}`}
export function embedUrl(baseUrl:string,slug:string):string{return `${baseUrl.replace(/\/+$/,'')}${EMBED_PATH}${slug}`}
// The website is an SPA, so the document a crawler receives is the shell. This rewrites only the tags
// that matter, escaping every value, and leaves the rest of the shell alone: no templating engine, no
// second renderer, no new dependency. A tag the shell does not have is appended to <head>.
export interface HubDocumentMeta {title:string;description:string;robots:string;url:string;image?:string}
const replaceOrAppend=(html:string,pattern:RegExp,replacement:string)=>pattern.test(html)?html.replace(pattern,replacement):html.replace('</head>',`${replacement}</head>`);
export function injectHubMeta(html:string,meta:HubDocumentMeta):string {
 const title=escapeXml(meta.title),description=escapeXml(meta.description),url=escapeXml(meta.url);
 let out=html;
 out=replaceOrAppend(out,/<title>[\s\S]*?<\/title>/,`<title>${title}</title>`);
 out=replaceOrAppend(out,/<meta name="description" content="[^"]*"\s*\/?>/,`<meta name="description" content="${description}"/>`);
 out=replaceOrAppend(out,/<meta name="robots" content="[^"]*"\s*\/?>/,`<meta name="robots" content="${escapeXml(meta.robots)}"/>`);
 out=replaceOrAppend(out,/<meta property="og:title" content="[^"]*"\s*\/?>/,`<meta property="og:title" content="${title}"/>`);
 out=replaceOrAppend(out,/<meta property="og:description" content="[^"]*"\s*\/?>/,`<meta property="og:description" content="${description}"/>`);
 out=replaceOrAppend(out,/<meta name="twitter:title" content="[^"]*"\s*\/?>/,`<meta name="twitter:title" content="${title}"/>`);
 out=replaceOrAppend(out,/<meta name="twitter:description" content="[^"]*"\s*\/?>/,`<meta name="twitter:description" content="${description}"/>`);
 out=replaceOrAppend(out,/<link rel="canonical" href="[^"]*"\s*\/?>/,`<link rel="canonical" href="${url}"/>`);
 const extras=`<meta property="og:url" content="${url}"/>${meta.image?`<meta property="og:image" content="${escapeXml(meta.image)}"/>`:''}`;
 return out.replace('</head>',`${extras}</head>`);
}
export {escapeXml};
