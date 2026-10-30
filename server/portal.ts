// Team portal (follow-up §3): a signed link a captain can open without an account.
//
// The link *is* the credential, so the security model is deliberately small and loud:
//   · 24 random bytes, base64url, stored on the operator's machine in a 0600 file;
//   · it expires (14 days), it can be revoked, and it is scoped to one team in one event;
//   · submitting is rate-limited per link (one per 30 s, five per hour) so a leaked link cannot be
//     used to flood the organiser's approval queue;
//   · nothing a captain types reaches the broadcast until an operator approves it.
//
// No accounts, no passwords, no cookies: a captain who loses the link asks the organiser for a new one.
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {chmod,mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {z} from 'zod';

export const PORTAL_TTL_MS=14*24*60*60_000;
export const PORTAL_MIN_GAP_MS=30_000;
export const PORTAL_WINDOW_MS=60*60_000;
export const PORTAL_MAX_PER_WINDOW=5;
export const PORTAL_MAX_LINKS=200;
export const PORTAL_MAX_SUBMISSIONS=20;
export const PORTAL_PATH='/portal/';

const social=z.string().trim().max(200).optional().default('');
export const portalPlayerSchema=z.object({
 nickname:z.string().trim().min(1).max(32),
 role:z.string().trim().max(24).optional().default(''),
 steamid:z.string().trim().max(64).optional().default(''),
}).strip();
export const portalSubmissionSchema=z.object({
 teamName:z.string().trim().min(2).max(40),
 tag:z.string().trim().max(8).optional().default(''),
 logo:z.string().trim().max(300).optional().default(''),
 socials:z.object({x:social,twitch:social,website:social,discord:social}).strip().optional().default({x:'',twitch:'',website:'',discord:''}),
 players:z.array(portalPlayerSchema).min(1).max(10),
 note:z.string().trim().max(400).optional().default(''),
}).strip();
export type PortalSubmission=z.infer<typeof portalSubmissionSchema>;
export type PortalDecision='approved'|'rejected';
export type PortalStatus='pending'|'approved'|'rejected';
export interface PortalSubmissionRecord {
 id:string;at:number;status:PortalStatus;payload:PortalSubmission;
 reviewedAt:number|null;reviewedBy:string;reviewNote:string;
}
export interface PortalLink {
 id:string;teamId:string;eventId:string;label:string;token:string;
 createdAt:number;expiresAt:number;revokedAt:number|null;lastSubmitAt:number|null;
 submissions:PortalSubmissionRecord[];
}
export interface PortalLinkView {
 id:string;teamId:string;eventId:string;label:string;path:string;
 createdAt:number;expiresAt:number;revokedAt:number|null;lastSubmitAt:number|null;
 pending:number;total:number;
}
export interface PortalQueueItem {
 linkId:string;submissionId:string;teamId:string;label:string;
 at:number;payload:PortalSubmission;
}
// A social handle is shown as a link on a page an operator reviews, so only http(s) survives. A bare
// "@handle" is kept as text — it is not a URL and must not become one.
export function safeSocial(value:string):string {
 const raw=String(value??'').trim();
 if(!raw||raw.length>200) return '';
 if(/^@[\w.]{1,40}$/.test(raw)) return raw;
 try{const url=new URL(raw);return url.protocol==='https:'||url.protocol==='http:'?url.toString():''}catch{return ''}
}
export function normalizeSubmission(input:unknown):PortalSubmission|null {
 const parsed=portalSubmissionSchema.safeParse(input);
 if(!parsed.success) return null;
 const socials=parsed.data.socials;
 return {...parsed.data,logo:safeSocial(parsed.data.logo),socials:{x:safeSocial(socials.x),twitch:safeSocial(socials.twitch),website:safeSocial(socials.website),discord:safeSocial(socials.discord)}};
}
// Rate limiting answers "why" rather than just refusing: the captain sees the same reason the operator
// would see in the log, which stops the "it just doesn't work" support thread.
export type PortalRejection='expired'|'revoked'|'missing'|'rate-limited'|'too-soon'|'invalid';
export type PortalSubmitResult=
 |{ok:true;submission:PortalSubmissionRecord}
 |{ok:false;reason:PortalRejection;retryAfterMs?:number};
export class PortalStore {
 private links:PortalLink[]=[];
 private loaded=false;
 constructor(private readonly file:string){}
 async load(){
  if(this.loaded) return this;
  try{const raw=await readFile(this.file,'utf8');const parsed=JSON.parse(raw);if(Array.isArray(parsed?.links))this.links=parsed.links}catch{}
  this.loaded=true;return this;
 }
 private async save(){
  await mkdir(dirname(this.file),{recursive:true});
  const tmp=`${this.file}.${process.pid}.tmp`;
  await writeFile(tmp,JSON.stringify({version:1,links:this.links}),{mode:0o600});
  await chmod(tmp,0o600).catch(()=>{});
  await rename(tmp,this.file);
  await chmod(this.file,0o600).catch(()=>{});
 }
 private findById(id:string){return this.links.find(link=>link.id===id)??null}
 // Constant-time comparison of the presented token against every stored one. The list is small
 // (≤200 links) and the cost is per request, not per byte of user data.
 private findByToken(token:string){
  const presented=Buffer.from(String(token??''),'utf8');
  let match:PortalLink|null=null;
  for(const link of this.links){
   const stored=Buffer.from(link.token,'utf8');
   if(stored.length===presented.length&&timingSafeEqual(stored,presented)) match=link;
  }
  return match;
 }
 view(link:PortalLink,now=Date.now()):PortalLinkView {
  return {id:link.id,teamId:link.teamId,eventId:link.eventId,label:link.label,path:`${PORTAL_PATH}${link.token}`,
   createdAt:link.createdAt,expiresAt:link.expiresAt,revokedAt:link.revokedAt,lastSubmitAt:link.lastSubmitAt,
   pending:link.submissions.filter(item=>item.status==='pending').length,total:link.submissions.length};
 }
 list(now=Date.now()):PortalLinkView[] {
  return [...this.links].sort((first,second)=>second.createdAt-first.createdAt).map(link=>this.view(link,now));
 }
 async create(input:{teamId:string;eventId:string;label:string},now=Date.now()){
  const token=randomBytes(24).toString('base64url');
  const link:PortalLink={id:`link_${now.toString(36)}${randomBytes(3).toString('hex')}`,teamId:input.teamId.slice(0,80),eventId:input.eventId.slice(0,80),label:input.label.trim().slice(0,60)||'Team submission',token,createdAt:now,expiresAt:now+PORTAL_TTL_MS,revokedAt:null,lastSubmitAt:null,submissions:[]};
  this.links.push(link);
  // Old links are pruned by age, never by "which one looks unused": an expired link should still show
  // in the panel until the operator deletes it, but the file must not grow without bound.
  if(this.links.length>PORTAL_MAX_LINKS) this.links=[...this.links].sort((first,second)=>second.createdAt-first.createdAt).slice(0,PORTAL_MAX_LINKS);
  await this.save();
  return {link:this.view(link,now),token,url:`${PORTAL_PATH}${token}`};
 }
 // Looking a submission up by id is what makes "approve, then apply" two separate steps.
 submission(linkId:string,submissionId:string){return this.findById(linkId)?.submissions.find(item=>item.id===submissionId)??null}
 async revoke(id:string,now=Date.now()){
  const link=this.findById(id);
  if(!link) return null;
  link.revokedAt=now;
  await this.save();
  return this.view(link,now);
 }
 // Rotating keeps the team and the event, replaces the credential: the old link stops working the
 // moment the new one exists, which is what "I sent it to the wrong person" needs.
 async rotate(id:string,now=Date.now()){
  const link=this.findById(id);
  if(!link) return null;
  link.token=randomBytes(24).toString('base64url');
  link.expiresAt=now+PORTAL_TTL_MS;link.revokedAt=null;link.createdAt=now;
  await this.save();
  return {link:this.view(link,now),token:link.token,url:`${PORTAL_PATH}${link.token}`};
 }
 async remove(id:string){
  const before=this.links.length;
  this.links=this.links.filter(link=>link.id!==id);
  if(this.links.length===before) return false;
  await this.save();return true;
 }
 resolve(token:string,now=Date.now()):{link:PortalLinkView;status:'active'|'expired'|'revoked';teamId:string;lastSubmission:PortalSubmissionRecord|null}|null {
  const link=this.findByToken(token);
  if(!link) return null;
  const status=link.revokedAt!==null?'revoked':now>link.expiresAt?'expired':'active';
  const latest=link.submissions.at(-1)??null;
  return {link:this.view(link,now),status,teamId:link.teamId,lastSubmission:latest};
 }
 async submit(token:string,input:unknown,now=Date.now()):Promise<PortalSubmitResult> {
  const link=this.findByToken(token);
  if(!link) return {ok:false,reason:'missing'};
  if(link.revokedAt!==null) return {ok:false,reason:'revoked'};
  if(now>link.expiresAt) return {ok:false,reason:'expired'};
  const recent=link.submissions.filter(item=>now-item.at<PORTAL_WINDOW_MS);
  if(link.lastSubmitAt!==null&&now-link.lastSubmitAt<PORTAL_MIN_GAP_MS) return {ok:false,reason:'too-soon',retryAfterMs:PORTAL_MIN_GAP_MS-(now-link.lastSubmitAt)};
  if(recent.length>=PORTAL_MAX_PER_WINDOW) return {ok:false,reason:'rate-limited',retryAfterMs:PORTAL_WINDOW_MS-(now-recent[0].at)};
  const payload=normalizeSubmission(input);
  if(!payload) return {ok:false,reason:'invalid'};
  // A resubmission replaces the previous pending one — a captain who fixes a typo should not leave two
  // copies in the queue for the operator to compare line by line.
  for(const item of link.submissions) if(item.status==='pending'){item.status='rejected';item.reviewNote='Replaced by a newer submission'}
  const record:PortalSubmissionRecord={id:`sub_${now.toString(36)}${randomBytes(3).toString('hex')}`,at:now,status:'pending',payload,reviewedAt:null,reviewedBy:'',reviewNote:''};
  link.submissions.push(record);
  if(link.submissions.length>PORTAL_MAX_SUBMISSIONS) link.submissions=link.submissions.slice(-PORTAL_MAX_SUBMISSIONS);
  link.lastSubmitAt=now;
  await this.save();
  return {ok:true,submission:record};
 }
 queue():PortalQueueItem[] {
  const items:PortalQueueItem[]=[];
  for(const link of this.links) for(const submission of link.submissions){
   if(submission.status==='pending') items.push({linkId:link.id,submissionId:submission.id,teamId:link.teamId,label:link.label,at:submission.at,payload:submission.payload});
  }
  return items.sort((first,second)=>first.at-second.at);
 }
 // Approving is a decision on a record; applying it to the tournament config is the caller's job, so
 // this class never touches the broadcast. An approval still leaves the config untouched until the
 // operator presses "Apply to team".
 async review(linkId:string,submissionId:string,decision:PortalDecision,actor:string,now=Date.now(),note=''){
  const link=this.findById(linkId);
  if(!link) return null;
  const submission=link.submissions.find(item=>item.id===submissionId);
  if(!submission) return null;
  submission.status=decision;
  submission.reviewedAt=now;submission.reviewedBy=actor.slice(0,80);submission.reviewNote=note.slice(0,200);
  if(decision==='approved') for(const other of link.submissions){if(other!==submission&&other.status==='pending'){other.status='rejected';other.reviewNote='Another version was approved'}}
  await this.save();
  return submission;
 }
}
