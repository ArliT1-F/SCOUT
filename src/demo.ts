import type {MatchState,PlayerState} from '../server/state';
import type {RoundEvent} from '../server/events';
const names=['nova','kairo','s1lent','frost','mika','EXO','ryze','orbit','blitz','zen'];
// Sample world coordinates for the dashboard preview's radar, on de_inferno's overview bounds.
const positions=[[-1500,2600],[-1200,2900],[-800,3100],[-400,2800],[100,3200],[2200,800],[2500,400],[2600,1000],[1900,300],[2400,-500]];
const forwards=[200,180,90,270,20,140,60,0,300,320];
export const demo:MatchState={provider:{timestamp:0},map:{name:'de_inferno',phase:'live',round:14,team_ct:{name:'Vertex',score:8},team_t:{name:'Parallax',score:6}},round:{phase:'live'},phase_countdowns:{phase:'live',phase_ends_in:84},allplayers:Object.fromEntries(names.map((name,i)=>[String(i),{steamid:String(i),name,observer_slot:(i+1)%10,team:i<5?'CT':'T',position:positions[i].join(', ')+', 0',forward:String(forwards[i]),state:{health:[100,100,72,0,100,100,48,100,0,100][i],armor:100,helmet:true,money:[3450,2100,1650,800,4200,2900,1200,3600,550,2800][i],round_kills:0,defusekit:i<3},weapons:demoLoadout(i),match_stats:{kills:[18,14,12,9,11,16,13,10,8,12][i],deaths:8+i%5,assists:2+i%4,mvp:[4,3,2,1,2,3,2,1,0,2][i]}} as PlayerState])),player:{steamid:'0'} as PlayerState,
// Sample utility so the preview radar shows the markers: a bloomed smoke, a burning molly and a
// flash still in the air, all inside de_inferno's overview bounds.
grenades:{demo_smoke:{type:'smoke',owner:'2',lifetime:'3.1',effecttime:'15.2',position:'-200, 1500, 0',velocity:'0, 0, 0'},demo_fire:{type:'fire',owner:'7',lifetime:'1.2',effecttime:'5.8',position:'600, 800, 0',velocity:'0, 0, 0'},demo_flash:{type:'flashbang',owner:'1',lifetime:'0.6',position:'-800, 2200, 60',velocity:'100, -50, 0'}}};
// Varied sample loadouts so the operator preview exercises the real weapon glyphs — rifle, sniper,
// pistol and the utility set — instead of handing everyone the same gun.
function demoLoadout(index:number):Record<string,{name:string;type:string;state:string;ammo_clip?:number;ammo_reserve?:number}>{
 const primaries:[{name:string;type:string},number,number][]=[
  [{name:'weapon_ak47',type:'Rifle'},30,90],[{name:'weapon_m4a1_silencer',type:'Rifle'},20,80],[{name:'weapon_awp',type:'SniperRifle'},5,30],
  [{name:'weapon_m4a1',type:'Rifle'},30,90],[{name:'weapon_deagle',type:'Pistol'},7,35],[{name:'weapon_ak47',type:'Rifle'},30,90],
  [{name:'weapon_ssg08',type:'SniperRifle'},10,90],[{name:'weapon_mac10',type:'SubmachineGun'},30,100],[{name:'weapon_awp',type:'SniperRifle'},5,30],
  [{name:'weapon_glock',type:'Pistol'},20,120]];
 const [primary,clip,reserve]=primaries[index];
 return {
  weapon_0:{...primary,state:'active',ammo_clip:clip,ammo_reserve:reserve},
  weapon_1:{name:'weapon_glock',type:'Pistol',state:'holstered',ammo_clip:20,ammo_reserve:120},
  weapon_2:{name:'weapon_hegrenade',type:'Grenade',state:'holstered'},
  weapon_3:{name:'weapon_flashbang',type:'Grenade',state:'holstered'},
  weapon_4:{name:'weapon_smokegrenade',type:'Grenade',state:'holstered'},
 };
}
// One finished round, so the Round recap scene has something true to show in the panel preview and on
// the product page: the kills above happened in round 14 and the score is the one the demo map reports.
// `endedAt` is 0 on purpose — an old round, never the "just ended" state a live host would announce.
const demoRound:RoundEvent={round:14,map:'de_inferno',winner:'CT',reason:'elimination',ctScore:8,tScore:6,startedAt:0,endedAt:0};
export const demoEvents={kills:[{id:3,at:0,round:14,map:'de_inferno',killer:'5',killerName:'mika',killerSide:'CT',victim:'8',victimName:'blitz',victimSide:'T',weapon:'weapon_awp',headshot:true},{id:2,at:0,round:14,map:'de_inferno',killer:'7',killerName:'ryze',killerSide:'T',victim:'2',victimName:'kairo',victimSide:'CT',weapon:'weapon_ak47',headshot:false},{id:1,at:0,round:13,map:'de_inferno',killer:'1',killerName:'nova',killerSide:'CT',victim:'4',victimName:'frost',victimSide:'T',weapon:'weapon_m4a1_silencer',headshot:false}],rounds:[demoRound]};