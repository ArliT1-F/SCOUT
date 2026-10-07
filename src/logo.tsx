import React from 'react';
// The SCOUT mark: the hexagonal rosette from the shipped app icon (src-tauri/icons), redrawn as a
// vector so it stays crisp at a 14px favicon and at 1920 × 1080 on air. Eight rounded spokes and a
// hub — the four axial spokes and the hub in currentColor, the four fatter diagonals in
// --mark-bright (the accent's bright tone in the UI, the same pink pair as the icon) — with the
// small transparent hole the icon has, cut by a mask so whatever is behind the mark shows through.
//
// Geometry is measured from the 128px icon: hub radius 13.4, axial spokes 5.7 wide to 36, diagonal
// spokes 9.1 wide to 35.2, centre hole 4.7 — all in this 100-unit viewBox.
export function ScoutMark({size=24,title,className,style}:{size?:number;title?:string;className?:string;style?:React.CSSProperties}){
 // One mask per instance: React's useId is unique per render, and the colons it can contain are
 // stripped because they need escaping inside url(#…).
 const hole='scout-mark-hole-'+React.useId().replace(/:/g,'');
 return <svg className={className} style={style} width={size} height={size} viewBox="0 0 100 100" role={title?'img':'presentation'} aria-label={title} aria-hidden={title?undefined:true} focusable="false">
  {title&&<title>{title}</title>}
  <defs>
   {/* White keeps the shape, black punches the icon's centre hole back out. */}
   <mask id={hole} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
    <rect width="100" height="100" fill="#fff"/>
    <circle cx="50" cy="50" r="4.7" fill="#000"/>
   </mask>
  </defs>
  <g mask={`url(#${hole})`}>
   <g fill="var(--mark-bright,currentColor)">
    <rect x="45.45" y="14.8" width="9.1" height="35.2" rx="4.55" transform="rotate(45 50 50)"/>
    <rect x="45.45" y="14.8" width="9.1" height="35.2" rx="4.55" transform="rotate(135 50 50)"/>
    <rect x="45.45" y="14.8" width="9.1" height="35.2" rx="4.55" transform="rotate(225 50 50)"/>
    <rect x="45.45" y="14.8" width="9.1" height="35.2" rx="4.55" transform="rotate(315 50 50)"/>
   </g>
   <g fill="currentColor">
    <circle cx="50" cy="50" r="13.4"/>
    <rect x="47.15" y="14" width="5.7" height="36" rx="2.85" transform="rotate(90 50 50)"/>
    <rect x="47.15" y="14" width="5.7" height="36" rx="2.85" transform="rotate(270 50 50)"/>
    <rect x="47.15" y="14" width="5.7" height="36" rx="2.85"/>
    <rect x="47.15" y="14" width="5.7" height="36" rx="2.85" transform="rotate(180 50 50)"/>
   </g>
  </g>
 </svg>;
}
// The wordmark beside it: lowercase, tight, as the panel and the landing page have always drawn it.
export function ScoutBrand({size=24,className='',suffix=true}:{size?:number;className?:string;suffix?:boolean}){
 return <span className={'scout-brand '+className}><ScoutMark size={size}/> scout{suffix&&<span className="scout-brand-dot">®</span>}</span>;
}
