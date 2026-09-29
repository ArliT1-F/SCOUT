import type {WeaponKind} from './weapons';

// Valve's CS2 Panorama equipment silhouettes, mirrored locally so overlays work offline and in OBS.
const EQUIPMENT_ROOT='/icons/equipment';
export const EQUIPMENT_ICON_STEMS=[
 'ak47','aug','awp','bayonet','bizon','c4','cz75a','deagle','decoy','defuser','elite','famas','firebomb','fiveseven','flashbang','g3sg1','galilar','glock','hegrenade','hkp2000','incgrenade',
 'knife','knife_bowie','knife_butterfly','knife_canis','knife_cord','knife_css','knife_falchion','knife_flip','knife_gut','knife_gypsy_jackknife','knife_karambit','knife_kukri','knife_m9_bayonet','knife_outdoor','knife_push','knife_skeleton','knife_stiletto','knife_survival_bowie','knife_t','knife_tactical','knife_twinblade','knife_ursus','knife_widowmaker','knifegg',
 'm249','m4a1','m4a1_silencer','m4a1_silencer_off','mac10','mag7','molotov','mp5sd','mp7','mp9','negev','nova','p2000','p250','p90','revolver','sawedoff','scar20','sg556','smokegrenade','ssg08','taser','tec9','ump45','usp_silencer','usp_silencer_off','xm1014',
] as const;
const EQUIPMENT_STEMS:ReadonlySet<string>=new Set(EQUIPMENT_ICON_STEMS);

// Names the GSI can report that differ from the corresponding Panorama filename.
const WEAPON_ALIASES:Record<string,string>={
 'knife_bayonet':'bayonet',
 'knife_ct':'knife',
 'knife_gg':'knifegg',
};
const KIND_FALLBACK:Partial<Record<WeaponKind,string>>={
 rifle:'m4a1',sniper:'awp',smg:'mp9',pistol:'glock',shotgun:'nova',mg:'m249',
 knife:'knife',grenade:'hegrenade',taser:'taser',c4:'c4',
};

export function weaponIconFile(name?:string,kind?:WeaponKind):string|undefined {
 const stem=name?.toLowerCase().replace(/^weapon_/,'');
 const file=stem?(WEAPON_ALIASES[stem]||stem):undefined;
 if(file&&EQUIPMENT_STEMS.has(file)) return file;
 return kind?KIND_FALLBACK[kind]:undefined;
}
export function weaponIconPath(name?:string,kind?:WeaponKind):string|undefined {
 const file=weaponIconFile(name,kind);
 return file?`${EQUIPMENT_ROOT}/${file}.svg`:undefined;
}

export type UtilityKind='he'|'flash'|'smoke'|'fire'|'decoy'|'taser'|'defusekit';
const UTILITY_FILES:Record<UtilityKind,string>={
 he:'hegrenade',flash:'flashbang',smoke:'smokegrenade',fire:'molotov',decoy:'decoy',taser:'taser',defusekit:'defuser',
};
export function utilityIconPath(kind:UtilityKind):string {
 return `${EQUIPMENT_ROOT}/${UTILITY_FILES[kind]}.svg`;
}

function EquipmentIcon({file,size}:{file:string;size:number}) {
 return <img className="equipment-icon" src={`${EQUIPMENT_ROOT}/${file}.svg`} alt="" aria-hidden="true" draggable={false} style={{height:size,width:'auto'}}/>;
}
export function WeaponIcon({name,kind,size=16}:{name?:string;kind?:WeaponKind;size?:number}) {
 const file=weaponIconFile(name,kind);
 return file?<EquipmentIcon file={file} size={size}/>:null;
}
export function UtilityIcon({kind,size=12}:{kind:UtilityKind;size?:number}) {
 return <EquipmentIcon file={UTILITY_FILES[kind]} size={size}/>;
}
