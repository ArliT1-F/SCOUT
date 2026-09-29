import type {WeaponKind} from './weapons';
// Hand-drawn monochrome weapon silhouettes for the HUD, killfeed and lower-third. Every glyph is
// original artwork drawn as filled SVG on a per-weapon canvas (guns on 96×32, side profile with the
// muzzle to the right; grenades and devices on 32×32) so each weapon is recognisable at a glance
// instead of landing on one shared "gun" shape. currentColor keeps them themeable; nothing is
// borrowed or downloaded. A weapon without a dedicated glyph falls back to its class silhouette.
export type UtilityKind='he'|'flash'|'smoke'|'fire'|'decoy'|'taser'|'defusekit';
type Glyph={vb:string;shape:React.ReactNode};
const G=(vb:string,shape:React.ReactNode):Glyph=>({vb,shape});
const GUN='0 0 96 32', DEV='0 0 32 32';
const GLYPHS:Record<string,Glyph>={
 weapon_ak47:G(GUN,<><path d="M3 12 L15 11 L19 13 V21 L15 22 L6 21 L2 18 Z"/><path d="M19 11 H53 V22 H19 Z"/><path d="M53 11 H72 V21 H53 Z"/><path d="M56 8 H78 V11 H56 Z"/><path d="M72 14 H88 V17 H72 Z"/><path d="M86 13 H95 V18 H86 Z"/><path d="M76 5 H80 V11 H76 Z"/><path d="M50 8 H56 V11 H50 Z"/><path d="M36 22 C36 27 39 30 44 31 L52 30 C46 28 43 26 43 22 Z"/><path d="M21 22 L28 22 L26 30 L20 30 Z"/><path d="M28 22 H36 V24 H31 V27 H28 Z"/></>),
 weapon_m4a1:G(GUN,<><path d="M2 11 H5 V23 H2 Z"/><path d="M2 13 H12 V15 H2 Z"/><path d="M2 19 H12 V21 H2 Z"/><path d="M12 11 H50 V22 H12 Z"/><path d="M18 8 H22 V11 H18 Z"/><path d="M40 8 H44 V11 H40 Z"/><path d="M22 7 H40 V9 H22 Z"/><path d="M50 11 H74 V21 H50 Z"/><path d="M74 14 H88 V17 H74 Z"/><path d="M86 13 H95 V18 H86 Z"/><path d="M72 6 H75 V11 H72 Z"/><path d="M32 22 H40 V30 H32 Z"/><path d="M16 22 L23 22 L21 30 L15 30 Z"/><path d="M23 22 H32 V24 H26 V27 H23 Z"/></>),
 weapon_m4a1_silencer:G(GUN,<><path d="M2 11 H5 V23 H2 Z"/><path d="M2 13 H12 V15 H2 Z"/><path d="M2 19 H12 V21 H2 Z"/><path d="M12 11 H50 V22 H12 Z"/><path d="M18 8 H22 V11 H18 Z"/><path d="M40 8 H44 V11 H40 Z"/><path d="M22 7 H40 V9 H22 Z"/><path d="M50 11 H72 V21 H50 Z"/><path d="M72 12 H95 V19 H72 Z"/><path d="M72 6 H75 V12 H72 Z"/><path d="M32 22 H40 V30 H32 Z"/><path d="M16 22 L23 22 L21 30 L15 30 Z"/><path d="M23 22 H32 V24 H26 V27 H23 Z"/></>),
 weapon_awp:G(GUN,<><path d="M2 12 L12 11 H24 V22 H12 L4 21 L2 17 Z"/><path d="M22 12 H62 V22 H22 Z"/><path d="M28 4 H64 V9 H28 Z"/><path d="M32 9 H36 V12 H32 Z"/><path d="M56 9 H60 V12 H56 Z"/><path d="M62 13 H90 V18 H62 Z"/><path d="M88 12 H95 V19 H88 Z"/><path d="M58 9 H64 V12 H58 Z"/><path d="M38 22 H46 V28 H38 Z"/><path d="M24 22 L30 22 L28 30 L23 30 Z"/><path d="M30 22 H38 V24 H33 V26 H30 Z"/></>),
 weapon_ssg08:G(GUN,<><path d="M4 13 L12 12 H22 V21 H12 L5 20 Z"/><path d="M20 12 H58 V21 H20 Z"/><path d="M28 6 H56 V10 H28 Z"/><path d="M31 10 H34 V12 H31 Z"/><path d="M50 10 H53 V12 H50 Z"/><path d="M58 13 H92 V16 H58 Z"/><path d="M90 12 H95 V17 H90 Z"/><path d="M34 21 H41 V27 H34 Z"/><path d="M22 21 L28 21 L26 29 L21 29 Z"/></>),
 weapon_aug:G(GUN,<><path d="M4 11 H70 V22 H4 Z"/><path d="M40 6 H62 V10 H40 Z"/><path d="M44 10 H47 V12 H44 Z"/><path d="M58 10 H61 V12 H58 Z"/><path d="M70 14 H90 V17 H70 Z"/><path d="M88 13 H95 V18 H88 Z"/><path d="M12 22 H23 V31 H12 Z"/><path d="M34 22 L41 22 L39 30 L33 30 Z"/><path d="M56 22 H61 V28 H56 Z"/><path d="M4 14 H8 V22 H4 Z"/></>),
 weapon_sg556:G(GUN,<><path d="M2 13 H14 V21 H2 Z"/><path d="M14 11 H52 V22 H14 Z"/><path d="M20 8 H52 V11 H20 Z"/><path d="M30 4 H48 V8 H30 Z"/><path d="M52 11 H76 V20 H52 Z"/><path d="M76 14 H88 V17 H76 Z"/><path d="M86 13 H95 V18 H86 Z"/><path d="M36 22 C36 26 38 29 42 30 L50 29 C45 28 43 25 43 22 Z"/><path d="M18 22 L25 22 L23 30 L17 30 Z"/><path d="M25 22 H36 V24 H29 V27 H25 Z"/></>),
 weapon_famas:G(GUN,<><path d="M6 11 H66 V22 H6 Z"/><path d="M2 15 H6 V20 H2 Z"/><path d="M14 5 H58 V9 H14 Z"/><path d="M16 9 H21 V11 H16 Z"/><path d="M51 9 H56 V11 H51 Z"/><path d="M66 14 H90 V17 H66 Z"/><path d="M88 13 H95 V18 H88 Z"/><path d="M20 22 H29 V31 H20 Z"/><path d="M38 22 L45 22 L43 30 L37 30 Z"/></>),
 weapon_galilar:G(GUN,<><path d="M2 13 H12 V21 H2 Z"/><path d="M12 11 H50 V22 H12 Z"/><path d="M18 8 H46 V11 H18 Z"/><path d="M50 11 H74 V20 H50 Z"/><path d="M74 14 H88 V17 H74 Z"/><path d="M86 13 H95 V18 H86 Z"/><path d="M70 6 H74 V11 H70 Z"/><path d="M33 22 C33 26 35 29 39 30 L47 29 C42 28 40 25 40 22 Z"/><path d="M16 22 L23 22 L21 30 L15 30 Z"/></>),
 weapon_mp9:G(GUN,<><path d="M4 12 H14 V15 H4 Z"/><path d="M4 19 H14 V22 H4 Z"/><path d="M14 11 H62 V22 H14 Z"/><path d="M22 8 H56 V11 H22 Z"/><path d="M62 13 H82 V17 H62 Z"/><path d="M80 12 H88 V18 H80 Z"/><path d="M32 22 H39 V31 H32 Z"/><path d="M20 22 L27 22 L25 30 L19 30 Z"/></>),
 weapon_mp7:G(GUN,<><path d="M6 13 H16 V16 H6 Z"/><path d="M6 19 H16 V22 H6 Z"/><path d="M16 12 H58 V22 H16 Z"/><path d="M22 9 H52 V12 H22 Z"/><path d="M58 14 H74 V17 H58 Z"/><path d="M72 13 H80 V18 H72 Z"/><path d="M30 22 H37 V30 H30 Z"/><path d="M20 22 L26 22 L24 29 L18 29 Z"/><path d="M50 22 H55 V29 H50 Z"/></>),
 weapon_mp5sd:G(GUN,<><path d="M2 13 H10 V16 H2 Z"/><path d="M2 19 H10 V22 H2 Z"/><path d="M10 11 H52 V22 H10 Z"/><path d="M18 8 H48 V11 H18 Z"/><path d="M52 12 H88 V19 H52 Z"/><path d="M28 22 C28 26 30 29 34 30 L42 29 C37 28 35 25 35 22 Z"/><path d="M14 22 L21 22 L19 30 L13 30 Z"/></>),
 weapon_ump45:G(GUN,<><path d="M2 13 H12 V16 H2 Z"/><path d="M12 11 H58 V22 H12 Z"/><path d="M20 8 H52 V11 H20 Z"/><path d="M58 13 H82 V17 H58 Z"/><path d="M80 12 H88 V18 H80 Z"/><path d="M32 22 H40 V31 H32 Z"/><path d="M18 22 L25 22 L23 30 L17 30 Z"/></>),
 weapon_p90:G(GUN,<><path d="M10 10 H78 V18 H10 Z"/><path d="M18 6 H72 V10 H18 Z"/><path d="M78 12 H92 V16 H78 Z"/><path d="M90 11 H95 V17 H90 Z"/><path d="M10 18 H30 V27 H10 Z"/><path d="M22 18 H30 V22 H22 Z"/><path d="M40 18 L47 18 L45 28 L39 28 Z"/><path d="M47 18 H56 V21 H51 V24 H47 Z"/></>),
 weapon_mac10:G(GUN,<><path d="M4 13 H14 V16 H4 Z"/><path d="M14 12 H52 V22 H14 Z"/><path d="M28 9 H48 V12 H28 Z"/><path d="M52 14 H68 V17 H52 Z"/><path d="M66 13 H74 V18 H66 Z"/><path d="M28 22 H36 V32 H28 Z"/><path d="M18 22 L25 22 L23 30 L17 30 Z"/></>),
 weapon_bizon:G(GUN,<><path d="M2 13 H12 V21 H2 Z"/><path d="M12 11 H56 V22 H12 Z"/><path d="M18 8 H50 V11 H18 Z"/><path d="M56 13 H86 V17 H56 Z"/><path d="M84 12 H92 V18 H84 Z"/><path d="M40 22 H80 V28 H40 Z"/><path d="M40 22 C40 25 43 28 46 28 L74 28 C77 28 80 25 80 22 Z"/><path d="M18 22 L25 22 L23 30 L17 30 Z"/></>),
 weapon_nova:G(GUN,<><path d="M2 13 L10 12 V22 L4 21 Z"/><path d="M10 11 H36 V22 H10 Z"/><path d="M20 12 H92 V16 H20 Z"/><path d="M36 18 H88 V21 H36 Z"/><path d="M90 11 H95 V17 H90 Z"/><path d="M52 17 H66 V25 H52 Z"/><path d="M14 22 L21 22 L19 30 L13 30 Z"/></>),
 weapon_xm1014:G(GUN,<><path d="M2 14 H8 V21 H2 Z"/><path d="M8 11 H42 V22 H8 Z"/><path d="M42 12 H92 V16 H42 Z"/><path d="M42 18 H90 V21 H42 Z"/><path d="M90 11 H95 V17 H90 Z"/><path d="M12 22 L19 22 L17 30 L11 30 Z"/><path d="M26 11 H42 V14 H26 Z"/></>),
 weapon_mag7:G(GUN,<><path d="M2 14 H10 V21 H2 Z"/><path d="M10 11 H60 V22 H10 Z"/><path d="M60 13 H90 V17 H60 Z"/><path d="M88 12 H95 V18 H88 Z"/><path d="M44 22 H86 V26 H44 Z"/><path d="M18 22 L25 22 L23 30 L17 30 Z"/></>),
 weapon_sawedoff:G(GUN,<><path d="M12 11 H30 V22 H12 Z"/><path d="M30 12 H86 V16 H30 Z"/><path d="M30 17 H86 V21 H30 Z"/><path d="M84 11 H92 V22 H84 Z"/><path d="M14 22 L24 22 L21 31 L11 31 Z"/></>),
 weapon_m249:G(GUN,<><path d="M2 13 H12 V21 H2 Z"/><path d="M12 11 H62 V22 H12 Z"/><path d="M30 6 H48 V10 H30 Z"/><path d="M33 10 H36 V12 H33 Z"/><path d="M62 13 H92 V17 H62 Z"/><path d="M90 12 H95 V18 H90 Z"/><path d="M24 22 H50 V32 H24 Z"/><path d="M16 22 L23 22 L21 30 L15 30 Z"/><path d="M74 22 L71 30 L73 30 L77 22 Z"/><path d="M78 22 L83 30 L85 30 L80 22 Z"/></>),
 weapon_negev:G(GUN,<><path d="M2 13 H10 V21 H2 Z"/><path d="M10 11 H60 V22 H10 Z"/><path d="M24 7 H52 V10 H24 Z"/><path d="M60 13 H92 V17 H60 Z"/><path d="M90 12 H95 V18 H90 Z"/><path d="M20 22 H46 V33 H20 Z"/><path d="M14 22 L21 22 L19 30 L13 30 Z"/><path d="M72 22 L69 30 L71 30 L75 22 Z"/><path d="M76 22 L81 30 L83 30 L78 22 Z"/></>),
 weapon_deagle:G(GUN,<><path d="M22 8 H88 V18 H22 Z"/><path d="M78 8 H94 V13 H78 Z"/><path d="M22 6 H29 V8 H22 Z"/><path d="M30 18 L48 18 L44 31 L32 31 Z"/><path d="M48 18 H62 V21 H53 V25 H48 Z"/></>),
 weapon_usp_silencer:G(GUN,<><path d="M28 10 H78 V19 H28 Z"/><path d="M78 10 H95 V18 H78 Z"/><path d="M28 8 H34 V10 H28 Z"/><path d="M34 19 L50 19 L47 31 L35 31 Z"/><path d="M50 19 H63 V22 H55 V25 H50 Z"/></>),
 weapon_glock:G(GUN,<><path d="M30 10 H82 V19 H30 Z"/><path d="M82 11 H89 V17 H82 Z"/><path d="M30 8 H36 V10 H30 Z"/><path d="M36 19 L52 19 L49 31 L37 31 Z"/><path d="M52 19 H65 V22 H57 V25 H52 Z"/></>),
 weapon_p250:G(GUN,<><path d="M32 10 H78 V19 H32 Z"/><path d="M78 11 H85 V17 H78 Z"/><path d="M38 19 L53 19 L50 31 L39 31 Z"/><path d="M53 19 H65 V22 H57 V25 H53 Z"/></>),
 weapon_fiveseven:G(GUN,<><path d="M28 9 H84 V17 H28 Z"/><path d="M84 10 H90 V16 H84 Z"/><path d="M34 17 L50 17 L47 30 L35 30 Z"/><path d="M50 17 H64 V20 H56 V24 H50 Z"/></>),
 weapon_tec9:G(GUN,<><path d="M32 9 H62 V19 H32 Z"/><path d="M62 10 H92 V17 H62 Z"/><path d="M90 9 H95 V18 H90 Z"/><path d="M68 12 H71 V15 H68 Z"/><path d="M76 12 H79 V15 H76 Z"/><path d="M44 19 H53 V33 H44 Z"/><path d="M36 19 L44 19 L42 31 L34 31 Z"/></>),
 weapon_cz75a:G(GUN,<><path d="M34 10 H80 V19 H34 Z"/><path d="M80 11 H86 V17 H80 Z"/><path d="M40 19 L54 19 L51 31 L41 31 Z"/><path d="M54 19 H65 V22 H57 V25 H54 Z"/></>),
 weapon_elite:G(GUN,<><path d="M12 6 H50 V15 H12 Z"/><path d="M50 7 H56 V13 H50 Z"/><path d="M18 15 L32 15 L29 27 L16 27 Z"/><path d="M32 15 H43 V18 H36 V21 H32 Z"/><path d="M46 13 H84 V22 H46 Z"/><path d="M84 14 H90 V20 H84 Z"/><path d="M52 22 L66 22 L63 32 L50 32 Z"/></>),
 weapon_revolver:G(GUN,<><path d="M52 10 H92 V15 H52 Z"/><path d="M90 9 H95 V16 H90 Z"/><path d="M34 8 H56 V22 H34 Z"/><path d="M18 8 H36 V21 H18 Z"/><path d="M14 5 H21 V8 H14 Z"/><path d="M20 21 L36 21 L31 32 L15 32 Z"/></>),
 weapon_knife:G(GUN,<><path d="M40 9 L88 13 L94 15 L88 18 L40 23 Z"/><path d="M36 8 H41 V25 H36 Z"/><path d="M12 12 H36 V21 H12 Z"/><path d="M8 13 H12 V20 H8 Z"/></>),
 weapon_hegrenade:G(DEV,<><circle cx="15" cy="20" r="9"/><path d="M12 9 H18 V13 H12 Z"/><path d="M18 8 H23 V22 H21 V12 H18 Z"/><circle cx="25" cy="6" r="3"/><path d="M22 6 H25 V8 H22 Z"/></>),
 weapon_flashbang:G(DEV,<><path d="M9 13 H23 V28 H9 Z"/><path d="M11 9 H21 V13 H11 Z"/><path d="M21 8 H25 V20 H23 V11 H21 Z"/><circle cx="26" cy="6" r="3"/><path d="M12 16 H20 V18 H12 Z"/><path d="M12 20 H20 V22 H12 Z"/></>),
 weapon_smokegrenade:G(DEV,<><path d="M8 11 H24 V29 H8 Z"/><path d="M11 7 H21 V11 H11 Z"/><path d="M14 3 H18 V7 H14 Z"/><path d="M21 6 H25 V18 H23 V9 H21 Z"/><path d="M8 14 H24 V16 H8 Z"/></>),
 weapon_molotov:G(DEV,<><path d="M12 15 C12 13 14 13 14 11 H18 C18 13 20 13 20 15 V27 C20 30 12 30 12 27 Z"/><path d="M13 8 H19 V11 H13 Z"/><path d="M15 1 C18 5 17 7 16 9 C14 7 13 5 15 1 Z"/><path d="M18 2 C21 5 20 8 18 9 C17 7 17 4 18 2 Z"/></>),
 weapon_incgrenade:G(DEV,<><circle cx="15" cy="20" r="9"/><path d="M12 9 H18 V13 H12 Z"/><path d="M18 8 H23 V22 H21 V12 H18 Z"/><path d="M13 1 C16 5 15 7 14 9 C12 7 11 4 13 1 Z"/><path d="M17 2 C20 5 19 8 17 9 C16 7 16 4 17 2 Z"/></>),
 weapon_decoy:G(DEV,<><path d="M7 15 H25 V28 H7 Z"/><path d="M10 11 H22 V15 H10 Z"/><path d="M20 4 H23 V11 H20 Z"/><circle cx="22" cy="3" r="2"/><path d="M11 19 H21 V22 H11 Z"/></>),
 weapon_taser:G(DEV,<><path d="M6 10 H22 V22 H6 Z"/><path d="M22 12 H30 V15 H22 Z"/><path d="M22 18 H30 V21 H22 Z"/><path d="M11 22 L19 22 L17 30 L10 30 Z"/><path d="M9 13 H19 V16 H9 Z"/></>),
 weapon_c4:G(DEV,<><path d="M3 7 H29 V27 H3 Z"/><path d="M6 11 H17 V18 H6 Z"/><path d="M20 11 H23 V13 H20 Z"/><path d="M24 11 H27 V13 H24 Z"/><path d="M20 15 H23 V17 H20 Z"/><path d="M24 15 H27 V17 H24 Z"/><path d="M20 19 H23 V21 H20 Z"/><path d="M24 19 H27 V21 H24 Z"/><path d="M6 21 H17 V24 H6 Z"/></>),
};
// Class fallbacks — a weapon that ships without its own silhouette still reads as its category.
const KIND_GLYPHS:Record<WeaponKind,Glyph>={
 rifle:G(GUN,GLYPHS.weapon_m4a1.shape),
 sniper:G(GUN,GLYPHS.weapon_awp.shape),
 smg:G(GUN,GLYPHS.weapon_mp9.shape),
 pistol:G(GUN,GLYPHS.weapon_glock.shape),
 shotgun:G(GUN,GLYPHS.weapon_nova.shape),
 mg:G(GUN,GLYPHS.weapon_m249.shape),
 knife:G(GUN,GLYPHS.weapon_knife.shape),
 grenade:G(DEV,GLYPHS.weapon_hegrenade.shape),
 taser:G(DEV,GLYPHS.weapon_taser.shape),
 c4:G(DEV,GLYPHS.weapon_c4.shape),
 other:G(GUN,<><path d="M28 12 H84 V18 H28 Z"/><path d="M36 18 L52 18 L49 29 L37 29 Z"/></>),
};
const UTILITY_GLYPHS:Record<UtilityKind,Glyph>={
 he:G(DEV,GLYPHS.weapon_hegrenade.shape),
 flash:G(DEV,GLYPHS.weapon_flashbang.shape),
 smoke:G(DEV,GLYPHS.weapon_smokegrenade.shape),
 fire:G(DEV,GLYPHS.weapon_molotov.shape),
 decoy:G(DEV,GLYPHS.weapon_decoy.shape),
 taser:G(DEV,GLYPHS.weapon_taser.shape),
 defusekit:G(DEV,<><path d="M3 9 H29 V26 H3 Z"/><path d="M9 5 H23 V9 H9 Z"/><path d="M8 14 H24 V17 H8 Z"/><path d="M8 19 H16 V22 H8 Z"/><circle cx="22" cy="20" r="2"/></>),
};
// Family lookups cover the many near-identical GSI names (weapon_knife_t, weapon_knife_flip, …).
function glyphFor(name?:string,kind?:WeaponKind):Glyph {
 if(name){
  if(GLYPHS[name]) return GLYPHS[name];
  if(name.startsWith('weapon_knife')||name.startsWith('weapon_bayonet')) return GLYPHS.weapon_knife;
  if(name.startsWith('weapon_knife')) return GLYPHS.weapon_knife;
  if(name.includes('grenade')&&name.includes('he')) return GLYPHS.weapon_hegrenade;
 }
 return (kind&&KIND_GLYPHS[kind])||KIND_GLYPHS.other;
}
export function WeaponIcon({name,kind,size=16}:{name?:string;kind?:WeaponKind;size?:number}){
 const {vb,shape}=glyphFor(name,kind);
 const [, ,w,h]=vb.split(' ').map(Number);
 return <svg width={Math.round(size*(w/h))} height={size} viewBox={vb} fill="currentColor" stroke="none" aria-hidden="true">{shape}</svg>;
}
export function UtilityIcon({kind,size=12}:{kind:UtilityKind;size?:number}){
 const {vb,shape}=UTILITY_GLYPHS[kind];
 return <svg width={size} height={size} viewBox={vb} fill="currentColor" stroke="none" aria-hidden="true">{shape}</svg>;
}
