import React from 'react';
// The SCOUT mark: a stencil S drawn like a top-down map. One 14-unit stroke, every corner cut at the
// same 45° (corridor corners), and two gaps in the top and bottom bars that read as doorways. The
// shape is point-symmetric: turned 180° it is the same S. It is drawn in --mark-bright, the brand's
// bright pink, falling back to currentColor, so a one-colour mark is just an unset variable.
//
// The geometry lives in one path so the component, public/logo/scout-mark.svg and public/favicon.svg
// can be held to the same drawing (tests/logo.test.ts). The gaps are 14 units wide: narrower ones
// close up at a 16px favicon.
export const SCOUT_MARK_PATH='M78 22 H61 M47 22 H34 L24 32 V40 L34 50 H66 L76 60 V68 L66 78 H53 M39 78 H22';
export function ScoutMark({size=24,title,className,style}:{size?:number;title?:string;className?:string;style?:React.CSSProperties}){
 return <svg className={className} style={style} width={size} height={size} viewBox="0 0 100 100" role={title?'img':'presentation'} aria-label={title} aria-hidden={title?undefined:true} focusable="false">
  {title&&<title>{title}</title>}
  <path d={SCOUT_MARK_PATH} fill="none" stroke="var(--mark-bright,currentColor)" strokeWidth={14} strokeLinejoin="miter" strokeLinecap="butt"/>
 </svg>;
}
// The wordmark beside it: lowercase, tight, as the panel and the landing page have always drawn it.
export function ScoutBrand({size=24,className='',suffix=true}:{size?:number;className?:string;suffix?:boolean}){
 return <span className={'scout-brand '+className}><ScoutMark size={size}/> scout{suffix&&<span className="scout-brand-dot">®</span>}</span>;
}
