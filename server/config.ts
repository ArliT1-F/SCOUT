import {z} from 'zod';
// Operator-owned broadcast configuration (config/teams.json): teams, rosters, the map series and the
// tournament tree. Everything here is data the admin edits in the panel — GSI never touches it — so
// the schema is strict, defaulted and normalized before it is stored or broadcast.
export const playerSchema=z.object({
 steamid:z.string().trim().max(40).optional().default(''),
 name:z.string().trim().min(1).max(64),
 nickname:z.string().trim().max(64).optional().default(''),
 role:z.string().trim().max(64).optional().default(''),
}).strip();
export const teamSchema=z.object({
 id:z.string().trim().min(1).max(32),
 name:z.string().trim().min(1).max(64),
 tag:z.string().trim().max(12).optional().default(''),
 color:z.string().trim().max(32).optional().default(''),
 logo:z.string().trim().max(260).optional().default(''),
 players:z.array(playerSchema).max(10).optional().default([]),
}).strip();
export const mapSchema=z.object({
 name:z.string().trim().min(1).max(64),
 pick:z.enum(['A','B','decider']).optional().default('decider'),
 score:z.tuple([z.number().int().min(0).max(99),z.number().int().min(0).max(99)]).optional(),
 status:z.enum(['upcoming','live','done']).optional().default('upcoming'),
 image:z.string().trim().max(260).optional().default(''),
}).strip();
export const slotSchema=z.object({
 label:z.string().trim().max(64).optional().default(''),
 team:z.string().trim().max(32).optional().default(''),
}).strip();
export const bracketMatchSchema=z.object({
 id:z.string().trim().min(1).max(32),
 a:slotSchema.optional().default({label:'',team:''}),
 b:slotSchema.optional().default({label:'',team:''}),
 aScore:z.number().int().min(0).max(99).optional().default(0),
 bScore:z.number().int().min(0).max(99).optional().default(0),
 winner:z.enum(['a','b']).nullable().optional().default(null),
 status:z.enum(['upcoming','live','done']).optional().default('upcoming'),
}).strip();
export const bracketRoundSchema=z.object({
 name:z.string().trim().min(1).max(64),
 matches:z.array(bracketMatchSchema).min(1).max(16),
}).strip();
export const bracketSchema=z.object({
 title:z.string().trim().max(120).optional().default(''),
 rounds:z.array(bracketRoundSchema).min(1).max(8),
}).strip();
// zod returns object defaults unparsed, so every default below carries the complete output shape.
const SLOT_DEFAULT={label:'',team:''};
export const configSchema=z.object({
 event:z.object({name:z.string().trim().max(120).optional().default(''),stage:z.string().trim().max(120).optional().default('')}).strip().optional().default({name:'',stage:''}),
 format:z.enum(['bo1','bo3','bo5']).optional().default('bo3'),
 mr:z.number().int().min(1).max(30).optional().default(12),
 otMr:z.number().int().min(1).max(15).optional().default(3),
 teams:z.array(teamSchema).min(2).max(2),
 maps:z.array(mapSchema).min(1).max(9),
 bracket:bracketSchema.optional().default({title:'',rounds:[
  {name:'Semifinals',matches:[
   {id:'m1',a:SLOT_DEFAULT,b:SLOT_DEFAULT,aScore:0,bScore:0,winner:null,status:'upcoming'},
   {id:'m2',a:SLOT_DEFAULT,b:SLOT_DEFAULT,aScore:0,bScore:0,winner:null,status:'upcoming'},
  ]},
  {name:'Final',matches:[{id:'m3',a:SLOT_DEFAULT,b:SLOT_DEFAULT,aScore:0,bScore:0,winner:null,status:'upcoming'}]},
 ]}),
}).strip();
export type PlayerConfig=z.infer<typeof playerSchema>;
export type TeamConfig=z.infer<typeof teamSchema>;
export type MapConfig=z.infer<typeof mapSchema>;
export type BracketSlot=z.infer<typeof slotSchema>;
export type BracketMatch=z.infer<typeof bracketMatchSchema>;
export type BracketRound=z.infer<typeof bracketRoundSchema>;
export type BracketConfig=z.infer<typeof bracketSchema>;
export type ScoutConfig=z.infer<typeof configSchema>;

// The tournament tree is a single-elimination bracket laid out positionally: match i of round r
// feeds match floor(i/2) of round r+1 (even i into slot a, odd i into slot b). The winner's label
// and team binding are written forward whenever a winner is set, so the tree can never disagree
// with its own results — and an unset winner leaves the next slot as the admin wrote it.
export function propagateBracket(bracket:BracketConfig):BracketConfig {
 const rounds=bracket.rounds.map(round=>({name:round.name,matches:round.matches.map(match=>({ ...match,a:{...match.a},b:{...match.b} }))}));
 for(let r=0;r<rounds.length-1;r++){
  for(let i=0;i<rounds[r].matches.length;i++){
   const match=rounds[r].matches[i];
   if(!match.winner) continue;
   const next=rounds[r+1].matches[Math.floor(i/2)];
   if(!next) continue;
   const from=match.winner==='a'?match.a:match.b;
   // Position decides the fed slot: an even-indexed match feeds slot a, an odd-indexed one slot b.
   const slot=i%2===0?'a':'b';
   // An unlabeled winner still propagates its team binding; a labelled one shows what advanced.
   next[slot]={label:from.label||from.team||'TBD',team:from.team||''};
  }
 }
 return {...bracket,rounds};
}
// The free-text slot label is how the panel displays a bracket; when a team is bound the team's own
// name is the truth. resolveSlotLabel is the single place that decides which one is shown.
export function resolveSlotLabel(slot:BracketSlot|undefined,teams:TeamConfig[]):string {
 if(!slot) return 'TBD';
 if(slot.team){const team=teams.find(candidate=>candidate.id===slot.team);if(team) return team.name}
 return slot.label||'TBD';
}
export function normalizeConfig(raw:unknown):ScoutConfig {
 const parsed=configSchema.parse(raw);
 // Duplicate team/match ids would make the bracket editor target the wrong node.
 const seen=new Set<string>();
 for(const team of parsed.teams){while(seen.has(team.id)) team.id=`${team.id}-2`;seen.add(team.id)}
 const matchIds=new Set<string>();
 for(const round of parsed.bracket.rounds) for(const match of round.matches){while(matchIds.has(match.id)) match.id=`${match.id}-2`;matchIds.add(match.id)}
 // A match with a winner is finished by definition; anything else keeps the status the admin set.
 for(const round of parsed.bracket.rounds) for(const match of round.matches) if(match.winner) match.status='done';
 return {...parsed,bracket:propagateBracket(parsed.bracket)};
}
export const emptyPlayer=():PlayerConfig=>({steamid:'',name:'',nickname:'',role:''});
export const emptyTeam=(index:number):TeamConfig=>({id:`t${index+1}`,name:'New team',tag:'',color:'',logo:'',players:[]});
export const emptyMap=():MapConfig=>({name:'de_mirage',pick:'decider',score:undefined,status:'upcoming',image:''});
export const emptyMatch=(id:string):BracketMatch=>({id,a:{label:'',team:''},b:{label:'',team:''},aScore:0,bScore:0,winner:null,status:'upcoming'});
