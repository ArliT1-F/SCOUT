import type {MatchState,PlayerState} from '../server/state';
// Weapon and utility facts come from `weapons` in allplayers, where each slot carries a name, a type
// and a state ("active"/"holstered"/"reloading"). Nothing here is guessed from the weapon's name: an
// unknown weapon keeps its raw name and lands in 'other'.
export type WeaponKind='rifle'|'sniper'|'smg'|'pistol'|'shotgun'|'mg'|'knife'|'grenade'|'taser'|'c4'|'other';
export interface WeaponInfo {name:string;label:string;kind:WeaponKind}
const GSI_TYPE:Record<string,WeaponKind>={Rifle:'rifle',SniperRifle:'sniper',SubmachineGun:'smg',Pistol:'pistol',Shotgun:'shotgun',MachineGun:'mg',Knife:'knife',Grenade:'grenade',Taser:'taser',C4:'c4'};
const CODES:Record<string,string>={weapon_ak47:'AK',weapon_m4a1:'M4',weapon_m4a1_silencer:'M4S',weapon_awp:'AWP',weapon_deagle:'DEA',weapon_usp_silencer:'USP',weapon_glock:'GLK',weapon_p250:'P250',weapon_elite:'DUL',weapon_fiveseven:'5-7',weapon_tec9:'TEC',weapon_cz75a:'CZ',weapon_revolver:'R8',weapon_ssg08:'SSG',weapon_aug:'AUG',weapon_sg556:'SG',weapon_famas:'FAM',weapon_galilar:'GAL',weapon_mp9:'MP9',weapon_mp7:'MP7',weapon_mp5sd:'MP5',weapon_ump45:'UMP',weapon_p90:'P90',weapon_mac10:'MAC',weapon_bizon:'BIZ',weapon_nova:'NOV',weapon_xm1014:'XM',weapon_mag7:'MAG',weapon_sawedoff:'SAW',weapon_m249:'M249',weapon_negev:'NEG',weapon_hegrenade:'HE',weapon_flashbang:'FLASH',weapon_smokegrenade:'SMOKE',weapon_molotov:'MOLLY',weapon_incgrenade:'INC',weapon_decoy:'DEC',weapon_knife:'KNIFE',weapon_taser:'ZEUS',weapon_c4:'C4'};
export function weaponInfo(name?:string,type?:string):WeaponInfo|undefined {
 if(!name) return undefined;
 const kind=GSI_TYPE[type||'']||(name.includes('grenade')||name==='weapon_molotov'?'grenade':'other');
 return {name,kind,label:CODES[name]||name.replace('weapon_','').replace(/_/g,' ').toUpperCase()};
}
// What a weapon is called on air. GSI reports weapon_ak47; a broadcast says AK-47. The killfeed, the
// roster strip and the round recap all read this one list, so a kill never has two spellings.
const ON_AIR:Record<string,string>={weapon_ak47:'AK-47',weapon_m4a1:'M4A4',weapon_m4a1_silencer:'M4A1-S',weapon_awp:'AWP',weapon_deagle:'DEAGLE',weapon_usp_silencer:'USP-S',weapon_glock:'GLOCK',weapon_knife:'KNIFE',weapon_hegrenade:'HE',weapon_flashbang:'FLASH',weapon_smokegrenade:'SMOKE',weapon_molotov:'MOLLY',weapon_incgrenade:'INCENDIARY',weapon_decoy:'DECOY',weapon_ssg08:'SSG 08',weapon_aug:'AUG',weapon_sg556:'SG 553',weapon_famas:'FAMAS',weapon_galilar:'GALIL',weapon_mp9:'MP9',weapon_mp7:'MP7',weapon_mp5sd:'MP5-SD',weapon_ump45:'UMP-45',weapon_p90:'P90',weapon_mac10:'MAC-10',weapon_bizon:'BIZON',weapon_nova:'NOVA',weapon_xm1014:'XM1014',weapon_mag7:'MAG-7',weapon_sawedoff:'SAWED-OFF',weapon_m249:'M249',weapon_negev:'NEGEV',weapon_tec9:'TEC-9',weapon_fiveseven:'FIVE-SEVEN',weapon_cz75a:'CZ75',weapon_p250:'P250',weapon_elite:'DUALIES',weapon_revolver:'R8',weapon_taser:'ZEUS'};
export const weaponLabel=(name?:string)=>ON_AIR[name||'']||weaponInfo(name)?.label||'';
// `state:'active'` is authoritative; `state:'reloading'` still means it is in the player's hands.
export function activeWeapon(player?:PlayerState):WeaponInfo|undefined {
 const weapons=Object.values(player?.weapons||{});
 const slot=weapons.find(weapon=>weapon.state==='active')||weapons.find(weapon=>weapon.state==='reloading');
 return weaponInfo(slot?.name,slot?.type);
}
export interface Utility {he:number;flash:number;smoke:number;fire:number;decoy:number;taser:number;defusekit:boolean;total:number}
const EMPTY:Utility={he:0,flash:0,smoke:0,fire:0,decoy:0,taser:0,defusekit:false,total:0};
export function utilityOf(player?:PlayerState):Utility {
 const utility={...EMPTY,defusekit:!!player?.state?.defusekit};
 for(const weapon of Object.values(player?.weapons||{})) switch(weapon.name){
  case 'weapon_hegrenade': utility.he++; break;
  case 'weapon_flashbang': utility.flash++; break;
  case 'weapon_smokegrenade': utility.smoke++; break;
  case 'weapon_molotov': case 'weapon_incgrenade': utility.fire++; break;
  case 'weapon_decoy': utility.decoy++; break;
  case 'weapon_taser': utility.taser++; break;
  default: continue;
 }
 utility.total=utility.he+utility.flash+utility.smoke+utility.fire+utility.decoy+utility.taser;
 return utility;
}
export function teamUtility(state:MatchState,side:'CT'|'T'):Utility {
 const players=Object.values(state.allplayers||{}).filter(player=>player.team===side);
 const sum=players.reduce((total,player)=>{const utility=utilityOf(player);for(const key of ['he','flash','smoke','fire','decoy','taser'] as const) total[key]+=utility[key];return total},{...EMPTY});
 sum.defusekit=players.some(player=>!!player.state?.defusekit);
 sum.total=sum.he+sum.flash+sum.smoke+sum.fire+sum.decoy+sum.taser;
 return sum;
}
