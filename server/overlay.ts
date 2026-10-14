import {z} from 'zod';
import {SCENE_IDS} from './controls.js';

// Public-facing overlay design data. All styling values are strictly typed and colour/path fields
// are allow-listed; an operator can personalize a broadcast without allowing saved JSON to inject CSS.
export const FONT_FAMILIES=['Barlow Condensed','DM Sans','Arial','Oswald','Roboto','Inter'] as const;
export const OVERLAY_WIDGET_KINDS=['event','scoreboard','radar','killfeed','rosterLeft','rosterRight','lowerThird','economy','footer','signal','phaseBanner','roundResult','phaseCard','text','image','shape','clock'] as const;
export type OverlayWidgetKind=typeof OVERLAY_WIDGET_KINDS[number];
const hex=z.string().regex(/^#[0-9a-fA-F]{6}$/,'use a six-digit hex colour');
const scene=z.enum(SCENE_IDS);
const optionalNumber=(min:number,max:number)=>z.number().finite().min(min).max(max).nullable().optional().default(null);
const themeFields={
 name:z.string().trim().min(1).max(48).optional().default('SCOUT Broadcast'),
 preset:z.string().trim().max(48).optional().default('scout-broadcast'),
 accent:hex.optional().default('#d970c2'),
 accentBright:hex.optional().default('#f0a9e2'),
 accentDeep:hex.optional().default('#a84d95'),
 gold:hex.optional().default('#e8c97e'),
 text:hex.optional().default('#f2eef5'),
 muted:hex.optional().default('#c6b7d2'),
 panel:hex.optional().default('#120e18'),
 panelAlt:hex.optional().default('#171021'),
 line:hex.optional().default('#2b2233'),
 fontDisplay:z.enum(FONT_FAMILIES).optional().default('Barlow Condensed'),
 fontUi:z.enum(FONT_FAMILIES).optional().default('DM Sans'),
 panelOpacity:z.number().finite().min(0.55).max(1).optional().default(0.94),
 cornerRadius:z.number().int().min(0).max(24).optional().default(2),
 borderWidth:z.number().int().min(0).max(8).optional().default(2),
 treatment:z.enum(['broadcast','glass','minimal']).optional().default('broadcast'),
 density:z.enum(['comfortable','compact']).optional().default('comfortable'),
 glow:z.boolean().optional().default(true),
 grid:z.boolean().optional().default(true),
 motion:z.enum(['cinematic','subtle','off']).optional().default('cinematic'),
};
export const overlayThemeSchema=z.object(themeFields).strip();
export type OverlayTheme=z.infer<typeof overlayThemeSchema>;
export const DEFAULT_THEME:OverlayTheme=overlayThemeSchema.parse({});
export const THEME_PRESETS:OverlayTheme[]=[
 DEFAULT_THEME,
 overlayThemeSchema.parse({name:'Graphite · Broadcast',preset:'graphite-broadcast',accent:'#50d2c2',accentBright:'#a0fff0',accentDeep:'#168b7f',gold:'#e5c56c',text:'#f2f5f6',muted:'#b7c4c9',panel:'#0d151a',panelAlt:'#142027',line:'#27404a',panelOpacity:.96,cornerRadius:3,borderWidth:2,treatment:'broadcast',glow:false}),
 overlayThemeSchema.parse({name:'Arena · Cobalt',preset:'arena-cobalt',accent:'#63a5ff',accentBright:'#b9d6ff',accentDeep:'#2865bd',gold:'#ffce72',text:'#f2f6ff',muted:'#bbc9e0',panel:'#101726',panelAlt:'#19243a',line:'#293a5c',panelOpacity:.95,cornerRadius:6,borderWidth:1,treatment:'glass',glow:true}),
 overlayThemeSchema.parse({name:'Crimson · Finals',preset:'crimson-finals',accent:'#ff5b65',accentBright:'#ffb0b4',accentDeep:'#b82135',gold:'#ffd16d',text:'#fff4f3',muted:'#e2c4c5',panel:'#1d1015',panelAlt:'#291319',line:'#49202a',panelOpacity:.96,cornerRadius:1,borderWidth:3,treatment:'broadcast',glow:false}),
 overlayThemeSchema.parse({name:'Clean · Minimal',preset:'clean-minimal',accent:'#ffffff',accentBright:'#ffffff',accentDeep:'#9aa2aa',gold:'#ffe28a',text:'#ffffff',muted:'#e5e8ec',panel:'#090d11',panelAlt:'#11171d',line:'#52606b',panelOpacity:.86,cornerRadius:0,borderWidth:1,treatment:'minimal',density:'compact',glow:false,grid:false,motion:'subtle'}),
];

// The values a layer used to be created with; see the transform below.
const LEGACY_WIDGET_COLOR='#f2eef5',LEGACY_WIDGET_FONT='Barlow Condensed';

export const overlayWidgetSchema=z.object({
 id:z.string().trim().regex(/^[a-zA-Z0-9_-]{1,48}$/,'use letters, numbers, dash or underscore'),
 kind:z.enum(OVERLAY_WIDGET_KINDS),
 name:z.string().trim().min(1).max(64),
 enabled:z.boolean().optional().default(true),
 showOn:z.array(scene).max(SCENE_IDS.length).optional().default(['live']),
 x:optionalNumber(-300,2220),
 y:optionalNumber(-300,1380),
 width:optionalNumber(24,1920),
 height:optionalNumber(18,1080),
 zIndex:z.number().int().min(-100).max(1000).optional().default(0),
 opacity:z.number().finite().min(0).max(1).optional().default(1),
 scale:z.number().finite().min(.5).max(2).optional().default(1),
 fontSize:z.number().int().min(8).max(160).nullable().optional().default(null),
 // null = follow the broadcast theme. A pinned hex (or face) still wins, which is what the
 // studio's colour fields and event packs rely on.
 color:hex.nullable().optional().default(null),
 fill:hex.nullable().optional().default(null),
 borderColor:hex.nullable().optional().default(null),
 text:z.string().max(500).optional().default(''),
 asset:z.string().max(260).optional().default('').refine(value=>!value||/^(uploads\/overlays\/[\w.\- ]+|radars\/[\w.\-]+\.(?:png|jpg|jpeg|webp)|thumbs\/[\w.\-]+\.(?:png|jpg|jpeg|webp))$/i.test(value),'asset must be a local SCOUT upload'),
 font:z.enum(FONT_FAMILIES).nullable().optional().default(null),
 fit:z.enum(['contain','cover']).optional().default('contain'),
}).strip().transform(widget=>({
 ...widget,
 // Layers used to be born with the shipped palette pinned: #f2eef5 type and the Barlow face. Those
 // two defaults are exactly what a theme change could not move once saved, so they are read as
 // “follow the theme”: a config written before the fix starts tracking the operator's palette.
 color:widget.color===LEGACY_WIDGET_COLOR?null:widget.color,
 font:widget.font===LEGACY_WIDGET_FONT?null:widget.font,
}));
export type OverlayWidget=z.infer<typeof overlayWidgetSchema>;

const widget=(id:string,kind:OverlayWidgetKind,name:string,zIndex:number,showOn:typeof SCENE_IDS[number][]=['live']):OverlayWidget=>overlayWidgetSchema.parse({id,kind,name,zIndex,showOn});
export const DEFAULT_WIDGETS:OverlayWidget[]=[
 widget('event','event','Event header',20),
 widget('scoreboard','scoreboard','Scoreboard',30),
 widget('radar','radar','Tactical radar',10),
 widget('killfeed','killfeed','Killfeed',50),
 widget('rosterLeft','rosterLeft','Left roster',20),
 widget('rosterRight','rosterRight','Right roster',20),
 widget('lowerThird','lowerThird','Player lower third',60),
 widget('economy','economy','Economy bar',25),
 widget('footer','footer','Broadcast footer',10),
 widget('signal','signal','Signal-lost banner',100),
 widget('phaseBanner','phaseBanner','Phase banner',90),
 widget('roundResult','roundResult','Round result',91),
 widget('phaseCard','phaseCard','Phase cards',95),
];
export const themePresetSchema=z.object({id:z.string().trim().regex(/^[a-zA-Z0-9_-]{1,48}$/),theme:overlayThemeSchema}).strip();
export const overlaySchema=z.object({
 version:z.literal(1).optional().default(1),
 theme:overlayThemeSchema.optional().default(DEFAULT_THEME),
 presets:z.array(themePresetSchema).max(20).optional().default([]),
 widgets:z.array(overlayWidgetSchema).max(60).optional().default(DEFAULT_WIDGETS),
}).strip().superRefine((value,ctx)=>{
 const ids=new Set<string>();
 for(const [index,item] of value.widgets.entries()){
  if(ids.has(item.id)) ctx.addIssue({code:z.ZodIssueCode.custom,path:['widgets',index,'id'],message:`duplicate layer id “${item.id}”`});
  ids.add(item.id);
 }
 const presetIds=new Set<string>();
 for(const [index,item] of value.presets.entries()){
  if(presetIds.has(item.id)) ctx.addIssue({code:z.ZodIssueCode.custom,path:['presets',index,'id'],message:`duplicate preset id “${item.id}”`});
  presetIds.add(item.id);
 }
});
export type OverlayConfig=z.infer<typeof overlaySchema>;
export const defaultOverlay=():OverlayConfig=>overlaySchema.parse({});

export function createWidget(kind:OverlayWidgetKind,id?:string):OverlayWidget {
 const nameByKind:Record<OverlayWidgetKind,string>={event:'Event header',scoreboard:'Scoreboard',radar:'Tactical radar',killfeed:'Killfeed',rosterLeft:'Left roster',rosterRight:'Right roster',lowerThird:'Player lower third',economy:'Economy bar',footer:'Broadcast footer',signal:'Signal-lost banner',phaseBanner:'Phase banner',roundResult:'Round result',phaseCard:'Phase cards',text:'Text overlay',image:'Image overlay',shape:'Shape overlay',clock:'Live clock'};
 const idBase=id||kind;
 return overlayWidgetSchema.parse({id:idBase,kind,name:nameByKind[kind],zIndex:kind==='text'||kind==='image'||kind==='shape'||kind==='clock'?80:20,showOn:['live'],...(kind==='text'?{text:'YOUR TEXT HERE',x:700,y:180,width:520,height:100,fontSize:48}:{}),...(kind==='image'?{x:800,y:120,width:320,height:180,fit:'contain'}:{}),...(kind==='shape'?{x:800,y:500,width:320,height:12}:{}),...(kind==='clock'?{x:850,y:180,width:220,height:90,fontSize:54}:{})});
}
export function widgetStyle(widget:OverlayWidget,legacy?:Record<string,string|number>):Record<string,string|number> {
 const style:Record<string,string|number>={...(legacy||{}),opacity:widget.opacity,zIndex:widget.zIndex,scale:widget.scale};
 if(widget.x!==null&&widget.y!==null){style.left=widget.x;style.top=widget.y;style.right='auto';style.bottom='auto';style.transform='none'}
 if(widget.width!==null) style.width=widget.width;
 if(widget.height!==null) style.height=widget.height;
 if(widget.fontSize!==null) style.fontSize=widget.fontSize;
 // The colour and the face reach the layer only when the operator chose them. Writing the shipped
 // default inline beat the .hud rule that reads the theme, which is how a saved layer could ignore
 // every later theme change; an unpinned layer now inherits --text and the display face instead.
 if(widget.color){style['--widget-color']=widget.color;style.color=widget.color}
 if(widget.font) style.fontFamily=`'${widget.font}', sans-serif`;
 if(widget.fill){style['--widget-fill']=widget.fill;style.background=widget.fill}
 if(widget.borderColor){style['--widget-border']=widget.borderColor;style.borderColor=widget.borderColor}
 return style;
}
export function widgetShown(widget:OverlayWidget|undefined,scene:string):boolean {
 return !!widget?.enabled&&widget.showOn.includes(scene as typeof SCENE_IDS[number]);
}
export function getWidget(config:OverlayConfig|undefined,id:string):OverlayWidget|undefined {
 return config?.widgets?.find(widget=>widget.id===id);
}
type Channels=[number,number,number];
const channels=(hex:string):Channels=>[parseInt(hex.slice(1,3),16),parseInt(hex.slice(3,5),16),parseInt(hex.slice(5,7),16)];
const BLACK:Channels=[0,0,0],WHITE:Channels=[255,255,255];
const blend=(from:Channels,to:Channels,amount:number):Channels=>from.map((value,index)=>Math.round(value+(to[index]-value)*amount)) as Channels;
const solid=(value:Channels)=>`rgb(${value.join(',')})`;
const soft=(value:Channels,opacity:number)=>`rgba(${value.join(',')},${opacity})`;
// The theme as CSS custom properties on the 1920 × 1080 canvas. The nine palette tokens are the
// operator's; everything below them is derived, so one colour change carries through the whole
// broadcast instead of stopping at the first surface that happens to have its own rule.
//
// The derived tokens exist because a full-canvas scene and a HUD panel need different things from
// the same palette. A HUD panel floats over the game and is deliberately translucent
// (panelOpacity); a scene *replaces* the game for its duration, so its backdrop, cards and scrims
// must be opaque — they are mixed from the solid panel colour and never carry the operator's
// opacity. Blending happens here rather than in color-mix() so the value is a plain rgb()/rgba()
// string: an unsupported function would leave a scene transparent, and a scene that lets the
// gameplay through is worse than a scene in the wrong shade.
export function overlayThemeStyle(theme?:OverlayTheme):Record<string,string|number> {
 const value=overlayThemeSchema.parse(theme||DEFAULT_THEME);
 const panel=channels(value.panel),panelAlt=channels(value.panelAlt);
 const accent=channels(value.accent),accentBright=channels(value.accentBright),accentDeep=channels(value.accentDeep);
 const panelDeep=blend(panel,BLACK,.28),panelDeeper=blend(panel,BLACK,.55);
 return {
  '--accent':value.accent,'--accent-bright':value.accentBright,'--accent-deep':value.accentDeep,'--gold':value.gold,
  '--text':value.text,'--text-dim':value.muted,
  // A third, genuinely fainter level for labels that must not compete with the data: the muted token
  // mixed back towards the panel, which keeps it derived from the operator's palette instead of a
  // hard-coded grey that only matches the default theme.
  '--text-faint':solid(blend(channels(value.muted),panel,.45)),'--line':value.line,'--line-soft':value.line,
  '--theme-panel':soft(panel,value.panelOpacity),'--theme-panel-alt':soft(panelAlt,value.panelOpacity),'--theme-border':value.line,
  '--display-font':`'${value.fontDisplay}', sans-serif`,'--ui-font':`'${value.fontUi}', sans-serif`,
  '--theme-radius':`${value.cornerRadius}px`,'--theme-border-width':`${value.borderWidth}px`,
  '--theme-glow':value.glow?'0 0 22px color-mix(in srgb, var(--accent) 22%, transparent)':'none',
  // Scene surfaces (opaque by design — see the note above).
  '--theme-panel-solid':solid(panel),
  '--theme-panel-deep':solid(panelDeep),
  '--theme-panel-deeper':solid(panelDeeper),
  '--theme-stage-glow':solid(blend(panelDeep,accentDeep,.3)),
  '--theme-map-tile-a':solid(blend(panelDeep,accentDeep,.22)),
  '--theme-map-tile-b':solid(blend(panelDeep,accentDeep,.38)),
  '--theme-card':solid(blend(panelDeep,WHITE,.06)),
  '--theme-raised':solid(blend(panel,WHITE,.05)),
  // The border a scene card draws against its own card surface: the operator's line colour lifted
  // towards white, so a matchup chip or a stats panel is outlined by the palette instead of by a
  // fixed translucent white — which composites to the same grey over every theme's backdrop and
  // is exactly how the full-canvas scenes came to ignore a palette change while the HUD moved.
  '--theme-card-line':soft(blend(channels(value.line),WHITE,.22),.6),
  '--theme-won':solid(blend(panelDeep,accentDeep,.32)),
  '--theme-ink':solid(panelDeeper),
  '--theme-scrim':soft(panelDeeper,.8),
  '--theme-scrim-strong':soft(panelDeeper,.93),
  // Accent tints for chips, live borders and glows, at the opacities the scene rules use.
  '--theme-accent-soft':soft(accentBright,.08),
  '--theme-accent-line':soft(accentBright,.38),
  '--theme-accent-wash':soft(accent,.1),
  '--theme-accent-haze':soft(accent,.2),
  '--theme-accent-haze-strong':soft(accent,.25),
  '--theme-accent-glow':soft(accent,.5),
 };
}
export function interpolateWidgetText(text:string,context:Record<string,string|number|undefined>):string {
 return text.replace(/\{([a-zA-Z0-9_.-]{1,40})\}/g,(_match,key:string)=>{
  const value=context[key];return value===undefined||value===null?'':String(value).slice(0,120);
 });
}
