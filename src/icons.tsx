import type {WeaponKind} from './weapons';
// Hand-drawn monochrome glyphs, 24×24, currentColor — no borrowed artwork ships with SCOUT. They are
// silhouettes for recognition, not portraits: the weapon's code text stays next to the icon.
export type UtilityKind='he'|'flash'|'smoke'|'fire'|'decoy'|'taser'|'defusekit';
const paths:Record<WeaponKind|UtilityKind,React.ReactNode>={
 rifle:<><path d="M2 12h18v4H8l-2 4H3l2-5H2z"/><path d="M15 12v-3h4v3z"/></>,
 sniper:<><path d="M1 13h21v3H9l-2 4H4l2-5H1z"/><path d="M11 13V9h6v4z"/></>,
 smg:<><path d="M5 12h13v4h-6l-2 4H7l2-5H5z"/><path d="M12 12V9h4v3z"/></>,
 pistol:<><path d="M8 10h11v4h-4l-3 6H9l2-7H8z"/></>,
 shotgun:<><path d="M1 12h19v4H7l-2 4H3l2-5H1z"/><path d="M18 12v3h4v-3z"/></>,
 mg:<><path d="M3 12h16v4H9l-2 4H5l2-5H3z"/><path d="M17 12v-2h4v6h-2v-4z"/><path d="M6 16v5M12 16v5"/></>,
 knife:<><path d="M3 17l9-11 5 5-9 9H5z"/><path d="M15 5l3-2 3 3-2 3z"/></>,
 grenade:<><circle cx="11" cy="14" r="6"/><path d="M13 6h4v3h-2v3h-3V8h1z"/></>,
 c4:<><path d="M3 10h15v9H3z"/><path d="M18 12h3v5h-3z"/><path d="M6 13h3v2H6z"/></>,
 other:<circle cx="12" cy="12" r="4"/>,
 he:<><circle cx="12" cy="13" r="7"/><path d="M12 6v14M5.5 9.5l13 7M5.5 16.5l13-7"/></>,
 flash:<><circle cx="12" cy="12" r="4"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M19.1 4.9l-2.8 2.8M7.7 16.3l-2.8 2.8"/></>,
 smoke:<><circle cx="9" cy="14" r="5"/><circle cx="15" cy="11" r="5"/><circle cx="17" cy="16" r="4"/></>,
 fire:<><path d="M12 2l4 7 3 3-2 8H9l-3-6 3-4z"/><path d="M12 12l2 3-1 4h-3l1-4z"/></>,
 decoy:<><circle cx="10" cy="15" r="5"/><path d="M14 9l3-3 4 0-2 2 2 2-4 0-1 2"/></>,
 taser:<><path d="M13 2L5 14h6l-2 8 8-12h-6z"/></>,
 defusekit:<><path d="M3 9h16v10H3z"/><path d="M8 9V6h6v3"/><path d="M8 14h8"/></>
};
export function WeaponIcon({kind,size=16}:{kind?:WeaponKind;size?:number}){const shape=kind&&paths[kind]?paths[kind]:paths.other;return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={kind==='mg'?1.6:1.2} strokeLinejoin="round" aria-hidden="true"><g fill="currentColor" stroke="none">{shape}</g></svg>}
export function UtilityIcon({kind,size=12}:{kind:UtilityKind;size?:number}){return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">{paths[kind]}</svg>}
