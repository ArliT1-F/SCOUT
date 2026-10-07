import {createHash,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {configSchema,normalizeConfig,type ScoutConfig} from './config.js';
import {layoutSchema,type LayoutConfig} from './layout.js';
import {radarsSchema} from './radars.js';
import {overlaySchema,type OverlayConfig} from './overlay.js';
import type {RadarsConfig} from './radars.js';

const assetPath=z.string().regex(/^uploads\/(?:logos|maps|players|radars|overlays)\/[\w.\- ]+$/i,'only SCOUT upload assets can be packaged');
const MIME_BY_EXT:Record<string,string>={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml'};
const IMAGE_MIMES=['image/png','image/jpeg','image/gif','image/webp','image/svg+xml'] as const;
const base64Pattern=/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
function detectedMime(buffer:Buffer):string|undefined {
 if(buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))return 'image/png';
 if(buffer.length>=3&&buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff)return 'image/jpeg';
 if(buffer.length>=6&&(buffer.toString('ascii',0,6)==='GIF87a'||buffer.toString('ascii',0,6)==='GIF89a'))return 'image/gif';
 if(buffer.length>=12&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP')return 'image/webp';
 const svg=buffer.toString('utf8',0,Math.min(buffer.length,4096)).replace(/^\uFEFF/,'').trimStart();
 const root=/^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+svg[^>]*>\s*)?<svg(?:\s|>)/i.test(svg);
 if(root&&!/<(?:script|foreignObject)\b|\son[a-z]+\s*=|(?:href|xlink:href)\s*=\s*["']\s*(?:javascript:|https?:|\/\/)|url\(\s*["']?\s*(?:https?:|\/\/)/i.test(svg))return 'image/svg+xml';
 return undefined;
}
const assetSchema=z.object({path:assetPath,mime:z.enum(IMAGE_MIMES),base64:z.string().max(7_000_000).regex(base64Pattern,'asset data must be valid base64')}).strip();
export const eventPackSchema=z.object({
 format:z.literal('scout-event-pack'),version:z.literal(1),exportedAt:z.number().int().nonnegative(),
 config:configSchema,radars:radarsSchema,layout:layoutSchema,overlay:overlaySchema,
 assets:z.array(assetSchema).max(100),
}).strip().superRefine((pack,ctx)=>{
 const paths=new Set<string>();let total=0;
 for(const [index,asset] of pack.assets.entries()){
  if(paths.has(asset.path))ctx.addIssue({code:z.ZodIssueCode.custom,path:['assets',index,'path'],message:'duplicate asset path'});
  paths.add(asset.path);
  const buffer=Buffer.from(asset.base64,'base64');total+=buffer.length;
  if(buffer.length<8||buffer.length>5*1024*1024)ctx.addIssue({code:z.ZodIssueCode.custom,path:['assets',index,'base64'],message:'each asset must be between 8 bytes and 5 MB'});
  if(detectedMime(buffer)!==asset.mime)ctx.addIssue({code:z.ZodIssueCode.custom,path:['assets',index,'mime'],message:'asset bytes do not match the declared image MIME type'});
  const ext=asset.path.split('.').pop()?.toLowerCase();if(MIME_BY_EXT[ext||'']!==asset.mime)ctx.addIssue({code:z.ZodIssueCode.custom,path:['assets',index,'mime'],message:'asset MIME does not match its file extension'});
 }
 if(total>50*1024*1024)ctx.addIssue({code:z.ZodIssueCode.custom,path:['assets'],message:'unpacked assets may not exceed 50 MB'});
});
export type EventPack=z.infer<typeof eventPackSchema>;
const PATH_PREFIX:Record<string,string>={logos:'uploads/logos/',maps:'uploads/maps/',players:'uploads/players/',radars:'uploads/radars/',overlays:'uploads/overlays/'};
function referencedPaths(config:ScoutConfig,radars:RadarsConfig,overlay:OverlayConfig):Set<string>{
 const refs=new Set<string>();const keep=(value?:string)=>{if(value?.startsWith('uploads/'))refs.add(value)};
 for(const team of config.teams){keep(team.logo);for(const player of team.players)keep(player.photo)}
 for(const map of config.maps)keep(map.image);
 for(const map of Object.values(radars.maps))keep(map.image);
 for(const widget of overlay.widgets)keep(widget.asset);
 return refs;
}
export async function createEventPack(config:ScoutConfig,radars:RadarsConfig,layout:LayoutConfig,overlay:OverlayConfig,uploadRoot='public/uploads'):Promise<EventPack>{
 const assets=[];let total=0;
 for(const relative of [...referencedPaths(config,radars,overlay)].sort()){
  const match=/^uploads\/(logos|maps|players|radars|overlays)\/([\w.\- ]+)$/i.exec(relative);
  if(!match)continue;
  const absolute=path.resolve(uploadRoot,match[1],match[2]);
  if(!absolute.startsWith(path.resolve(uploadRoot)+path.sep))throw new Error('Asset path escaped the upload directory');
  const buffer=await readFile(absolute);
  if(buffer.length>5*1024*1024)throw new Error(`Asset ${path.basename(absolute)} exceeds 5 MB`);
  total+=buffer.length;if(total>50*1024*1024)throw new Error('Event pack exceeds the 50 MB asset limit');
  const ext=path.extname(absolute).slice(1).toLowerCase(),mime=MIME_BY_EXT[ext];if(!mime)throw new Error(`Unsupported asset type: ${ext}`);
  if(detectedMime(buffer)!==mime)throw new Error(`Asset bytes do not match the declared image type: ${path.basename(absolute)}`);
  assets.push({path:relative,mime:mime as typeof IMAGE_MIMES[number],base64:buffer.toString('base64')});
 }
 return eventPackSchema.parse({format:'scout-event-pack',version:1,exportedAt:Date.now(),config,radars,layout,overlay,assets});
}
export interface RestoredPack {config:ScoutConfig;radars:RadarsConfig;layout:LayoutConfig;overlay:OverlayConfig;assets:number;assetBytes:number}
export async function restoreEventPack(raw:unknown,uploadRoot='public/uploads'):Promise<RestoredPack>{
 const parsed=eventPackSchema.parse(raw);
 const config=normalizeConfig(parsed.config),radars=radarsSchema.parse(parsed.radars),layout=layoutSchema.parse(parsed.layout),overlay=overlaySchema.parse(parsed.overlay);
 const remap=new Map<string,string>();let assetBytes=0;
 const writes:{path:string;buffer:Buffer}[]=[];
 for(const asset of parsed.assets){
  const buffer=Buffer.from(asset.base64,'base64');
  if(buffer.length<8||buffer.length>5*1024*1024)throw new Error(`Asset ${path.basename(asset.path)} has an invalid size`);
  const ext=path.extname(asset.path).slice(1).toLowerCase();if(MIME_BY_EXT[ext]!==asset.mime)throw new Error(`Asset MIME does not match ${asset.path}`);
  const match=/^uploads\/(logos|maps|players|radars|overlays)\/([\w.\- ]+)$/i.exec(asset.path);if(!match)throw new Error(`Unsafe asset path ${asset.path}`);
  const prefix=PATH_PREFIX[match[1].toLowerCase()];const filename=`${Date.now()}-pack-${randomBytes(5).toString('hex')}-${path.basename(match[2]).replace(/[^a-zA-Z0-9_. -]/g,'_')}`;
  const destination=path.resolve(uploadRoot,match[1],filename);if(!destination.startsWith(path.resolve(uploadRoot)+path.sep))throw new Error('Asset path escaped the upload directory');
  const relative=`${prefix}${filename}`;remap.set(asset.path,relative);writes.push({path:destination,buffer});assetBytes+=buffer.length;
 }
 const remapRef=(value:string)=>{if(!value.startsWith('uploads/'))return value;const replacement=remap.get(value);if(!replacement)throw new Error(`The event pack is missing referenced artwork: ${value}`);return replacement};
 for(const team of config.teams){team.logo=remapRef(team.logo);for(const player of team.players)player.photo=remapRef(player.photo)}
 for(const map of config.maps)map.image=remapRef(map.image);
 for(const map of Object.values(radars.maps))if(map.image)map.image=remapRef(map.image);
 for(const widget of overlay.widgets)widget.asset=remapRef(widget.asset);
 for(const item of writes){await mkdir(path.dirname(item.path),{recursive:true});await writeFile(item.path,item.buffer,{flag:'wx'})}
 // Schema-check all rewritten references before the caller commits their configuration files.
 return {config:normalizeConfig(config),radars:radarsSchema.parse(radars),layout:layoutSchema.parse(layout),overlay:overlaySchema.parse(overlay),assets:writes.length,assetBytes};
}
export function verifyPackDigest(pack:EventPack){const {assets,...manifest}=pack;return createHash('sha256').update(JSON.stringify(manifest)).update(assets.map(asset=>asset.path+asset.base64).join('|')).digest('hex')}
