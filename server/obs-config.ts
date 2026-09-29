import {z} from 'zod';
import {SCENE_IDS,type SceneId} from './controls.js';
// Optional OBS Studio integration (obs-websocket 5.x). Everything here is browser-safe — the schema, the
// status shape the panel renders, and the two pure decisions the bridge makes — so the panel and the host
// share it. The connection itself lives in server/obs.ts.
//
// The OBS password is deliberately NOT part of this configuration. Like the GSI token it comes from the
// environment (OBS_WS_PASSWORD) and is never stored, returned by the API, or broadcast in a snapshot.
export const OBS_DEFAULT_URL='ws://127.0.0.1:4455';

// The host connects out to whatever address is saved here, so only a plain ws:// or wss:// address is
// accepted, and one that embeds credentials is refused so a password can never end up in a saved file.
export function isObsUrl(value:string):boolean {
 try{
  const url=new URL(value);
  return (url.protocol==='ws:'||url.protocol==='wss:')&&!!url.hostname&&!url.username&&!url.password;
 }catch{return false}
}
// off   — connect and report status, never touch OBS's scene
// scout — switching a SCOUT scene switches the mapped OBS scene
// both  — and switching to a mapped OBS scene in OBS switches SCOUT too
export const OBS_SYNC_MODES=['off','scout','both'] as const;
const sceneName=z.string().trim().max(200).optional().default('');
const sceneMapShape=Object.fromEntries(SCENE_IDS.map(id=>[id,sceneName])) as Record<SceneId,typeof sceneName>;
const emptyMap=():Record<SceneId,string>=>Object.fromEntries(SCENE_IDS.map(id=>[id,''])) as Record<SceneId,string>;
export const obsConfigSchema=z.object({
 enabled:z.boolean().optional().default(false),
 url:z.string().trim().max(200).refine(isObsUrl,'must be a ws:// or wss:// address without credentials').optional().default(OBS_DEFAULT_URL),
 sync:z.enum(OBS_SYNC_MODES).optional().default('scout'),
 sceneMap:z.object(sceneMapShape).strip().optional().default(emptyMap()),
 // The name of the OBS browser source that shows /obs or /game, for "refresh overlay". Empty = find it.
 browserSource:z.string().trim().max(200).optional().default(''),
}).strip();
export type ObsConfig=z.infer<typeof obsConfigSchema>;
export const defaultObsConfig=(env:Record<string,string|undefined>=process.env):ObsConfig=>obsConfigSchema.parse({
 // Setting OBS_WS_URL is an explicit request for the integration; otherwise it stays off until enabled.
 enabled:!!env.OBS_WS_URL,
 url:env.OBS_WS_URL&&isObsUrl(env.OBS_WS_URL)?env.OBS_WS_URL:OBS_DEFAULT_URL,
});

export type ObsState='disabled'|'connecting'|'authenticating'|'connected'|'error';
export interface ObsSwitchResult {scene:string;at:number;ok:boolean;error?:string}
export interface ObsStatus {
 state:ObsState;message:string;url:string;passwordSet:boolean;
 obsVersion?:string;wsVersion?:string;
 scenes:string[];currentScene?:string;streaming?:boolean;recording?:boolean;
 lastSwitch?:ObsSwitchResult;
}
export const idleObsStatus=(url=OBS_DEFAULT_URL):ObsStatus=>({state:'disabled',message:'OBS integration is off',url,passwordSet:false,scenes:[]});

// The OBS scene mapped to a SCOUT scene, if any.
export const obsSceneFor=(config:Pick<ObsConfig,'sceneMap'>,scene:SceneId):string|undefined=>config.sceneMap?.[scene]?.trim()||undefined;

export type SkipReason='sync-off'|'unmapped'|'unknown-scene'|'already-there';
export interface ScoutToObs {switchTo?:string;skip?:SkipReason}
// A SCOUT scene changed: does OBS need switching? Never invents a scene — an unmapped scene, a name OBS
// does not have, or a scene OBS is already on all mean "leave OBS alone".
export function planScoutToObs(config:Pick<ObsConfig,'sync'|'sceneMap'>,scene:SceneId,obs:{scenes:string[];currentScene?:string}):ScoutToObs {
 if(config.sync==='off') return {skip:'sync-off'};
 const target=obsSceneFor(config,scene);
 if(!target) return {skip:'unmapped'};
 if(obs.scenes.length&&!obs.scenes.includes(target)) return {skip:'unknown-scene'};
 if(obs.currentScene===target) return {skip:'already-there'};
 return {switchTo:target};
}
// OBS switched scene by itself (a hotkey, a Stream Deck, the OBS UI): should SCOUT follow? Only when the
// operator chose two-way sync, only for a mapped scene, and never when SCOUT is already on a scene that
// maps there — that is the echo of SCOUT's own switch, and following it would loop.
export function planObsToScout(config:Pick<ObsConfig,'sync'|'sceneMap'>,obsScene:string,current:SceneId):SceneId|undefined {
 if(config.sync!=='both') return undefined;
 const matches=SCENE_IDS.filter(id=>obsSceneFor(config,id)===obsScene);
 return !matches.length||matches.includes(current)?undefined:matches[0];
}

// A browser source is "ours" when it loads the overlay route from a host: /obs or /game (optionally with a
// query such as ?checker=1).
export const isOverlayUrl=(value?:string):boolean=>typeof value==='string'&&/^https?:\/\/[^/?#]+\/(obs|game)(\/|\?|#|$)/i.test(value.trim());
