import {z} from 'zod';
// Overlay layout (config/layout.json): where each movable HUD element sits on the 1920×1080
// output canvas. Positions are top-left coordinates in canvas pixels, edited by dragging in the
// admin preview ("Arrange" mode) and broadcast with every snapshot so /obs and /game follow.
// An element with no entry keeps its CSS default position, which is what Reset writes back.
export const LAYOUT_KEYS=['event','scoreboard','radar','killfeed','rosterLeft','rosterRight','lowerThird','economy','footer'] as const;
export type LayoutKey=typeof LAYOUT_KEYS[number];
// Bounds are generous so a hand-edited file can nudge an element slightly off-canvas; the drag
// handler clamps much tighter so nothing can ever be dragged fully out of reach.
const layoutElementSchema=z.object({
 x:z.number().finite().min(-300).max(2220),
 y:z.number().finite().min(-300).max(1380),
 // Width is only applied to the two elements whose CSS stretches them with left+right; it is
 // measured from the rendered element at drag time so the box never changes size when moved.
 w:z.number().finite().min(40).max(1920).optional(),
}).strip();
export const layoutSchema=z.object({
 elements:z.record(z.enum(LAYOUT_KEYS),layoutElementSchema).optional().default({}),
}).strip().default({elements:{}});
export type LayoutConfig=z.infer<typeof layoutSchema>;
export type LayoutElement=z.infer<typeof layoutElementSchema>;
export const emptyLayout=():LayoutConfig=>({elements:{}});
// Elements positioned by CSS with left+right (stretched full width) need an explicit width the
// moment they are moved to a `left` coordinate, or they would collapse to their content.
const STRETCHED:Partial<Record<LayoutKey,number>>={scoreboard:1864,footer:1864};
// Inline style for a positioned element: undefined while it sits at its CSS default, otherwise the
// override that re-anchors it (neutralising right/bottom/transform anchors it no longer uses).
export function elementStyle(layout:LayoutConfig|undefined,key:LayoutKey):Record<string,string|number>|undefined{
 const element=layout?.elements?.[key];
 if(!element) return undefined;
 const style:Record<string,string|number>={left:element.x,top:element.y,right:'auto',bottom:'auto',transform:'none'};
 if(key in STRETCHED) style.width=element.w??STRETCHED[key]!;
 return style;
}
