// Sponsor *rotation* (docs/LAUNCH-FEATURES.md follow-up §1) is shared by the host and the browser:
// the overlay computes the same picture from the clock and the weights, with no socket message and no
// server round-trip. That means this file must stay free of Node built-ins — the proof-of-play ledger
// and its filesystem live in server/sponsors.ts.
//
// Rotation is *deterministic*: the host, /obs, /game and the studio all compute the same slot from the
// clock and the weights alone, so they cannot disagree.
export const SPONSOR_ROTATION_MS=20_000;
export const MAX_SPONSORS=16;
// Only formats a browser can draw in an <img> and an operator can make from a brand kit. SVG is
// deliberately absent: an uploaded SVG is a document, not a picture, and a sponsor graphic has no
// reason to carry script.
export const SPONSOR_ASSET=/^uploads\/overlays\/[\w.\- ]+\.(?:png|jpe?g|webp|gif)$/i;
export interface SponsorSlot {
 id:string;
 name:string;
 asset:string;
 // Weight is relative airtime, not priority: a weight-3 sponsor gets three turns for every one a
 // weight-1 sponsor gets. 1..100 keeps a long cycle bounded.
 weight:number;
 enabled:boolean;
}
export const emptySponsor=(index:number,asset=''):SponsorSlot=>({
 id:`sponsor_${Date.now().toString(36)}_${index}`,
 name:`Sponsor ${index+1}`,
 asset,
 weight:1,
 enabled:true,
});
// The cycle is the weighted list, repeated: [A,B,B,C,C,C] for weights 1/2/3. Small and stable, which
// is what makes the rotation reproducible in a test and on two different machines.
export function rotationCycle(slots:SponsorSlot[]):SponsorSlot[] {
 const cycle:SponsorSlot[]=[];
 for(const slot of slots){
  if(!slot.enabled||!slot.asset||!SPONSOR_ASSET.test(slot.asset)) continue;
  const turns=Math.max(1,Math.min(100,Math.round(slot.weight||1)));
  for(let turn=0;turn<turns;turn++) cycle.push(slot);
 }
 return cycle;
}
export const rotationBucket=(now:number,rotateMs=SPONSOR_ROTATION_MS)=>Math.floor(Math.max(0,now)/Math.max(1,rotateMs));
export function activeSponsor(slots:SponsorSlot[]|undefined,now:number,rotateMs=SPONSOR_ROTATION_MS):SponsorSlot|null {
 const cycle=rotationCycle(slots??[]);
 if(!cycle.length) return null;
 return cycle[((rotationBucket(now,rotateMs)%cycle.length)+cycle.length)%cycle.length];
}
// What the layer prints when the operator is still building: the name of the slot that would be on
// air, so the studio can be laid out before the artwork exists.
export function sponsorLabel(slots:SponsorSlot[]|undefined,now:number,rotateMs=SPONSOR_ROTATION_MS):string {
 return activeSponsor(slots,now,rotateMs)?.name??'';
}
