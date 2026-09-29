import type {ScoutConfig} from './config.js';
// Operator uploads (team logos, map pictures, radar images, player portraits) are plain files under
// public/uploads/<dir>/ referenced by path from config/teams.json or config/radars.json. Anything no
// longer referenced is pruned so the folder cannot grow without bound across a long tournament.
export const UPLOAD_DIRS=['logos','maps','radars','players'] as const;
export type UploadDir=typeof UPLOAD_DIRS[number];

// Every uploads/... path the saved configuration still points at.
export function referencedUploads(config:Pick<ScoutConfig,'teams'|'maps'>,radars?:{maps?:Record<string,{image?:string}|undefined>}|null):Set<string> {
 const referenced=new Set<string>();
 const keep=(value?:string)=>{if(value&&value.startsWith('uploads/')) referenced.add(value)};
 for(const team of config.teams){
  keep(team.logo);
  for(const player of team.players||[]) keep(player.photo);
 }
 for(const map of config.maps) keep(map.image);
 for(const entry of Object.values(radars?.maps||{})) keep(entry?.image);
 return referenced;
}

// An upload is answered with its path immediately, but it only becomes "referenced" when the operator
// saves the form it belongs to. Pruning on someone else's save (radars, config from another tab) would
// delete a photo that is merely waiting for its Save click, so recent uploads get a grace window. The
// upload name starts with the creation time (`<epoch-ms>-<slug>.<ext>`); a file without one has no
// claim to protection.
export const UPLOAD_GRACE_MS=15*60*1000;
export function isPrunable(file:string,referenced:Set<string>,dir:string,now=Date.now(),graceMs=UPLOAD_GRACE_MS):boolean {
 if(file==='.gitkeep'||referenced.has(`uploads/${dir}/${file}`)) return false;
 const stamp=/^(\d{10,16})-/.exec(file);
 return !(stamp&&now-Number(stamp[1])<graceMs);
}
