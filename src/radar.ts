import type {MatchState} from '../server/state';
// Radar positioning. GSI reports world coordinates ("x, y, z" in Hammer units, +x east, +y north)
// and the game's own overviews map them with pos_x/pos_y/scale: the top-left corner of the radar
// image is (pos_x, pos_y) and one image pixel is `scale` world units. So u=(x-pos_x)/scale/size and
// v=(pos_y-y)/scale/size, with size the overview's pixel width (1024 for every official CS2 map).
export interface RadarCalibration {posX:number;posY:number;scale:number;size:number;image?:string}
export interface RadarConfig {overviewSize?:number;maps?:Record<string,Partial<RadarCalibration>>}
export interface RadarDot {steamid:string;name:string;side:'CT'|'T';u:number;v:number;yaw?:number;alive:boolean;observed:boolean;color?:string}
export interface RadarBomb {u:number;v:number;planted:boolean}
export type GrenadeKind='smoke'|'flash'|'he'|'decoy'|'unknown';
export interface RadarGrenade {id:string;kind:GrenadeKind;u:number;v:number;deployed:boolean}

export function grenadeKind(type?:string):GrenadeKind {
 const key=String(type||'').trim().toLowerCase().replace(/^weapon_/,'');
 switch(key){
  case 'smoke': case 'smokegrenade': return 'smoke';
  case 'flash': case 'flashbang': return 'flash';
  case 'frag': case 'he': case 'hegrenade': return 'he';
  case 'fire': case 'inferno': case 'molotov': case 'incendiary': case 'incgrenade': case 'firebomb': return 'fire';
  case 'decoy': return 'decoy';
  default: return 'unknown';
 }
}

const OVERVIEW_SIZE=1024;
export function calibrationFor(radars:any,map?:string):RadarCalibration|undefined {
 const raw=map?radars?.maps?.[map]:undefined;
 if(!raw) return undefined;
 const size=Number(radars?.overviewSize)>0?Number(radars.overviewSize):OVERVIEW_SIZE;
 const scale=Number(raw.scale), posX=Number(raw.posX), posY=Number(raw.posY);
 if(!(scale>0)||!Number.isFinite(posX)||!Number.isFinite(posY)) return undefined;
 return {posX,posY,scale,size:Number(raw.size)>0?Number(raw.size):size,image:raw.image||`radars/${map}.png`};
}
export function parsePoint(value?:string):{x:number;y:number}|undefined {
 if(typeof value!=='string') return undefined;
 const parts=value.split(',');
 const x=Number(parts[0]), y=Number(parts[1]);
 return parts.length>=2&&Number.isFinite(x)&&Number.isFinite(y)?{x,y}:undefined;
}
// A point outside the overview is a real case — nuke's lower level, a player in the air — and drawing
// it would put the dot somewhere it has never been. 2% of slack absorbs the border pixels.
export function projectPoint(point:{x:number;y:number},cal:RadarCalibration):{u:number;v:number}|undefined {
 const size=cal.size||OVERVIEW_SIZE;
 const u=(point.x-cal.posX)/cal.scale/size, v=(cal.posY-point.y)/cal.scale/size;
 if(!Number.isFinite(u)||!Number.isFinite(v)||u<-0.02||u>1.02||v<-0.02||v>1.02) return undefined;
 return {u:Math.min(1,Math.max(0,u)),v:Math.min(1,Math.max(0,v))};
}
// GSI's forward is the player's yaw in degrees (a vector on older builds), and yaw 0 faces +x, which
// is a radar heading of (cos, -sin) because the radar's v axis points north. 
export function yawOf(value?:string):number|undefined {
 if(typeof value!=='string'||!value.trim()) return undefined;
 const parts=value.split(',').map(Number);
 if(parts.some(part=>!Number.isFinite(part))) return undefined;
 if(parts.length>1) return (Math.atan2(parts[1],parts[0])*180/Math.PI+360)%360;
 return ((parts[0]%360)+360)%360;
}
export function radarPoints(state:MatchState,cal:RadarCalibration,opts:{playerSteamid?:string;colors?:Record<string,string|undefined>}={}){
 const dots:RadarDot[]=[];
 for(const [steamid,player] of Object.entries(state.allplayers||{})){
  const side=player.team, at=projectPoint(parsePoint(player.position)||{x:NaN,y:NaN},cal);
  if((side!=='CT'&&side!=='T')||!at) continue;
  dots.push({steamid,name:player.name||steamid,side,u:at.u,v:at.v,yaw:yawOf(player.forward),alive:(player.state?.health??0)>0,observed:steamid===(opts.playerSteamid??state.player?.steamid),color:opts.colors?.[side]});
 }
 dots.sort((a,b)=>a.side===b.side?a.name.localeCompare(b.name):a.side==='CT'?-1:1);
 const planted=state.bomb?.state==='planted';
 const bombAt=projectPoint(parsePoint(state.bomb?.position)||{x:NaN,y:NaN},cal);
 const grenades:RadarGrenade[]=[];
 for(const [id,grenade] of Object.entries(state.grenades||{})){
    const at=projectPoint(parsePoint(grenade?.position)||{x:NaN,y:NaN},cal);
    if(!at) continue;
    const kind=grenadeKind(grenade?.type);
    const effect=Number(grenade?.effecttime);
    grenades.push({id,kind,u:at.u,v:at.v,deployed:(kind==='smoke'||kind==='fire')&&Number.isFinite(effect)&&effect>0});
    grenades.sort((a,b)=>a.id.localeCompare(b.id));
    return {dots,bomb:bombAt?{...bombAt,planted}:undefined,grenades};
 }
}
