import React,{useMemo,useState} from 'react';
import {ArrowDown,ArrowUp,Eye,EyeOff,Layers3,Palette,Plus,Save,Trash2} from 'lucide-react';
import {createWidget,DEFAULT_WIDGETS,OVERLAY_WIDGET_KINDS,THEME_PRESETS,type OverlayConfig,type OverlayTheme,type OverlayWidget,type OverlayWidgetKind} from '../server/overlay';
import {SCENE_IDS,SCENE_TITLES} from '../server/controls';
import {ImageUpload} from './admin';

const clone=<T,>(value:T):T=>JSON.parse(JSON.stringify(value));
const BUILT_INS=new Set<OverlayWidgetKind>(['event','scoreboard','radar','killfeed','rosterLeft','rosterRight','lowerThird','economy','footer','signal','phaseBanner','roundResult','phaseCard']);
const COLOR_FIELDS:[keyof OverlayTheme,string][]=[['accent','Signal accent'],['accentBright','Accent highlight'],['accentDeep','Accent shadow'],['gold','Secondary / win'],['text','Primary type'],['muted','Secondary type'],['panel','Panel surface'],['panelAlt','Raised surface'],['line','Borders']];
const kindLabel=(kind:OverlayWidgetKind)=>kind.replace(/([A-Z])/g,' $1').replace(/^./,value=>value.toUpperCase());

function ColorField({label,value,onChange}:{label:string;value:string;onChange:(value:string)=>void}){
 return <label className="studio-color-field"><span>{label}</span><input type="color" value={value} onChange={event=>onChange(event.target.value)}/><code>{value}</code></label>;
}
function NumericField({label,value,min,max,onChange}:{label:string;value:number|null;min:number;max:number;onChange:(value:number|null)=>void}){
 return <label className="studio-field"><span>{label}</span><input type="number" value={value??''} min={min} max={max} placeholder="Auto" onChange={event=>onChange(event.target.value===''?null:Math.max(min,Math.min(max,Number(event.target.value)||0)))}/></label>;
}

export function OverlayStudio({value,onChange,onSave,onDiscard,dirty,busy,onNotice}:{value:OverlayConfig;onChange:(next:OverlayConfig)=>void;onSave:()=>void;onDiscard:()=>void;dirty:boolean;busy?:boolean;onNotice?:(message:string)=>void}){
 const [view,setView]=useState<'layers'|'theme'>('layers');
 const [selected,setSelected]=useState(value.widgets[0]?.id||'');
 const [addKind,setAddKind]=useState<OverlayWidgetKind>('text');
 const [presetName,setPresetName]=useState('');
 const active=value.widgets.find(widget=>widget.id===selected)||value.widgets[0];
 const layers=useMemo(()=>[...value.widgets].sort((a,b)=>b.zIndex-a.zIndex||a.name.localeCompare(b.name)),[value.widgets]);
 const exists=(kind:OverlayWidgetKind)=>value.widgets.some(widget=>widget.kind===kind);
 const availableKinds=OVERLAY_WIDGET_KINDS.filter(kind=>!BUILT_INS.has(kind)||!exists(kind));
 function patchWidget(id:string,patch:Partial<OverlayWidget>){onChange({...value,widgets:value.widgets.map(widget=>widget.id===id?{...widget,...patch}:widget)})}
 function patchTheme(patch:Partial<OverlayTheme>){onChange({...value,theme:{...value.theme,...patch}})}
 function addLayer(){
  if(BUILT_INS.has(addKind)&&exists(addKind)){onNotice?.(`${kindLabel(addKind)} is already in the layer stack.`);return}
  const id=BUILT_INS.has(addKind)?addKind:`${addKind}_${Date.now().toString(36)}`;
  const created=BUILT_INS.has(addKind)?clone(DEFAULT_WIDGETS.find(widget=>widget.kind===addKind)||createWidget(addKind,id)):createWidget(addKind,id);
  const next={...created,id,zIndex:Math.max(0,...value.widgets.map(widget=>widget.zIndex))+10};
  onChange({...value,widgets:[...value.widgets,next]});setSelected(id);setView('layers');
 }
 function removeLayer(id:string){const next=value.widgets.filter(widget=>widget.id!==id);onChange({...value,widgets:next});if(selected===id)setSelected(next[0]?.id||'')}
 function moveLayer(id:string,delta:number){const target=value.widgets.find(widget=>widget.id===id);if(!target)return;patchWidget(id,{zIndex:Math.max(-100,Math.min(1000,target.zIndex+delta*5))})}
 function setScene(id:string,sceneId:typeof SCENE_IDS[number],checked:boolean){const target=value.widgets.find(widget=>widget.id===id);if(!target)return;const set=new Set(target.showOn);checked?set.add(sceneId):set.delete(sceneId);patchWidget(id,{showOn:[...set]})}
 function applyTheme(theme:OverlayTheme){patchTheme({...theme});}
 function savePreset(){
  const name=presetName.trim()||window.prompt('Name this broadcast theme')?.trim();if(!name)return;
  const id=`theme_${name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,32)}_${Date.now().toString(36)}`;
  const nextPreset={id,theme:{...value.theme,name,preset:id}};
  if(value.presets.length>=20){onNotice?.('Remove a saved theme before adding another (maximum 20).');return}
  onChange({...value,theme:nextPreset.theme,presets:[...value.presets,nextPreset]});setPresetName('');onNotice?.(`Saved “${name}” as a reusable theme.`);
 }
 function applySaved(id:string){const preset=value.presets.find(item=>item.id===id);if(preset)patchTheme({...preset.theme})}
 return <section className="panel overlay-studio">
  <div className="overlay-studio-head">
   <div><div className="section-label">BROADCAST DESIGN SYSTEM · VERSION {value.version}</div><h2>Overlay Studio</h2><p>Build a deliberate on-air package: tune the visual identity, manage every live HUD layer, and add your own branded graphics. Changes stay in preview until saved.</p></div>
   <div className="studio-save-actions">{dirty&&<span className="unsaved-pill">UNSAVED</span>}<button className="button" disabled={!dirty||busy} onClick={onDiscard}>Discard</button><button className="button primary" disabled={!dirty||busy} onClick={onSave}><Save size={14}/>{busy?'Publishing…':'Publish to outputs'}</button></div>
  </div>
  <div className="studio-subnav" role="tablist" aria-label="Overlay Studio sections">
   <button role="tab" aria-selected={view==='layers'} className={view==='layers'?'active':''} onClick={()=>setView('layers')}><Layers3 size={15}/>LAYERS <b>{value.widgets.length}</b></button>
   <button role="tab" aria-selected={view==='theme'} className={view==='theme'?'active':''} onClick={()=>setView('theme')}><Palette size={15}/>THEME & STYLE</button>
   <span className="studio-live-note"><i/> Preview is the same renderer used by /obs</span>
  </div>
  {view==='layers'?<div className="studio-layer-workspace">
   <aside className="studio-layer-rail">
    <div className="studio-rail-head"><div><small>CANVAS LAYERS</small><b>{value.widgets.filter(widget=>widget.enabled).length} ACTIVE</b></div><span>1920 × 1080</span></div>
    <div className="studio-layer-list">{layers.map(widget=><div key={widget.id} className={'studio-layer-row'+(active?.id===widget.id?' selected':'')+(widget.enabled?'':' disabled')}>
     <button className="studio-layer-select" onClick={()=>setSelected(widget.id)}><span className="layer-ordinal">{String(widget.zIndex).padStart(2,'0')}</span><span className="layer-copy"><b>{widget.name}</b><small>{kindLabel(widget.kind)} · {widget.showOn.length?widget.showOn.length+' scene'+(widget.showOn.length===1?'':'s'):'hidden everywhere'}</small></span></button>
     <button className="layer-icon-action" title={widget.enabled?'Hide layer':'Show layer'} aria-label={widget.enabled?'Hide '+widget.name:'Show '+widget.name} onClick={()=>patchWidget(widget.id,{enabled:!widget.enabled})}>{widget.enabled?<Eye size={14}/>:<EyeOff size={14}/>}</button>
     <button className="layer-icon-action danger" title="Remove layer" aria-label={'Remove '+widget.name} onClick={()=>removeLayer(widget.id)}><Trash2 size={14}/></button>
    </div>)}{!layers.length&&<div className="studio-empty-layers"><Layers3 size={22}/><b>Start with a layer</b><small>Add a live HUD component or a custom graphic below.</small></div>}</div>
    <div className="studio-add-row"><select value={availableKinds.includes(addKind)?addKind:(availableKinds[0]||'text')} onChange={event=>setAddKind(event.target.value as OverlayWidgetKind)} aria-label="Choose a layer to add">{availableKinds.map(kind=><option value={kind} key={kind}>{kindLabel(kind)}{BUILT_INS.has(kind)?' · built-in':' · custom'}</option>)}</select><button className="button primary" onClick={addLayer} disabled={!availableKinds.length}><Plus size={14}/>Add layer</button></div>
    {active&&<div className="studio-order-actions"><span>STACK ORDER</span><button className="mini-button" aria-label="Raise layer" onClick={()=>moveLayer(active.id,1)}><ArrowUp size={13}/>Bring forward</button><button className="mini-button" aria-label="Lower layer" onClick={()=>moveLayer(active.id,-1)}><ArrowDown size={13}/>Send back</button></div>}
   </aside>
   <div className="studio-inspector">
    {active?<>
     <div className="inspector-title"><div><small>SELECTED LAYER</small><h3>{active.name}</h3></div><span className={'layer-status'+(active.enabled?'':' off')}>{active.enabled?'ON AIR':'HIDDEN'}</span></div>
     <div className="inspector-section"><h4>Layer identity</h4><div className="studio-form-grid"><label className="studio-field field-wide"><span>DISPLAY NAME</span><input maxLength={64} value={active.name} onChange={event=>patchWidget(active.id,{name:event.target.value})}/></label><label className="studio-field"><span>LAYER TYPE</span><input value={kindLabel(active.kind)} readOnly/></label><label className="studio-field"><span>STATE</span><select value={active.enabled?'visible':'hidden'} onChange={event=>patchWidget(active.id,{enabled:event.target.value==='visible'})}><option value="visible">Visible</option><option value="hidden">Hidden</option></select></label></div></div>
     <div className="inspector-section"><h4>Canvas geometry <small>1920 × 1080 design pixels</small></h4><div className="studio-geometry-grid"><NumericField label="X" value={active.x} min={-300} max={2220} onChange={x=>patchWidget(active.id,{x})}/><NumericField label="Y" value={active.y} min={-300} max={1380} onChange={y=>patchWidget(active.id,{y})}/><NumericField label="WIDTH" value={active.width} min={24} max={1920} onChange={width=>patchWidget(active.id,{width})}/><NumericField label="HEIGHT" value={active.height} min={18} max={1080} onChange={height=>patchWidget(active.id,{height})}/></div><p className="studio-hint">Auto keeps the carefully art-directed default anchor. You can also drag a layer in the live preview while Arrange is enabled.</p></div>
     <div className="inspector-section"><h4>Layer treatment</h4><div className="studio-geometry-grid"><NumericField label="STACK LEVEL" value={active.zIndex} min={-100} max={1000} onChange={zIndex=>patchWidget(active.id,{zIndex:zIndex??0})}/><label className="studio-field"><span>OPACITY · {Math.round(active.opacity*100)}%</span><input type="range" min="0" max="1" step=".01" value={active.opacity} onChange={event=>patchWidget(active.id,{opacity:Number(event.target.value)})}/></label><label className="studio-field"><span>SCALE · {active.scale.toFixed(2)}×</span><input type="range" min=".5" max="2" step=".01" value={active.scale} onChange={event=>patchWidget(active.id,{scale:Number(event.target.value)})}/></label><NumericField label="TYPE SIZE" value={active.fontSize} min={8} max={160} onChange={fontSize=>patchWidget(active.id,{fontSize})}/></div><div className="studio-inline-colors"><ColorField label="Foreground" value={active.color} onChange={color=>patchWidget(active.id,{color})}/><ColorField label="Fill" value={active.fill||'#111820'} onChange={fill=>patchWidget(active.id,{fill})}/><button className="text-button" onClick={()=>patchWidget(active.id,{fill:null})}>Clear fill</button></div></div>
     {active.kind==='text'&&<div className="inspector-section"><h4>Graphic copy</h4><label className="studio-field"><span>TEXT · DYNAMIC TAGS SUPPORTED</span><textarea maxLength={500} rows={4} value={active.text} onChange={event=>patchWidget(active.id,{text:event.target.value})}/></label><p className="studio-hint">Use {'{event}'}, {'{stage}'}, {'{map}'}, {'{phase}'}, {'{round}'}, {'{score.ct}'}, {'{score.t}'}, {'{team.ct}'}, {'{team.t}'}, {'{clock}'} or {'{series.ct}'} for live data.</p></div>}
     {active.kind==='image'&&<div className="inspector-section"><h4>Graphic asset</h4><ImageUpload kind="overlay" value={active.asset} title={active.name} onChange={asset=>patchWidget(active.id,{asset})}/><div className="studio-form-grid"><label className="studio-field"><span>IMAGE FIT</span><select value={active.fit} onChange={event=>patchWidget(active.id,{fit:event.target.value as OverlayWidget['fit']})}><option value="contain">Contain</option><option value="cover">Cover</option></select></label></div></div>}
     {active.kind==='clock'&&<div className="inspector-section"><h4>Live data</h4><p className="studio-hint">The value comes from the interpolated CS2 round or bomb countdown and freezes safely when the feed is stale.</p></div>}
     <div className="inspector-section"><h4>Scene visibility <small>Choose exactly where this layer can appear</small></h4><div className="scene-visibility-grid">{SCENE_IDS.map(sceneId=><label key={sceneId}><input type="checkbox" checked={active.showOn.includes(sceneId)} onChange={event=>setScene(active.id,sceneId,event.target.checked)}/><span>{SCENE_TITLES[sceneId]}</span></label>)}</div></div>
    </>:<div className="studio-inspector-empty"><Palette size={24}/><b>Select a layer to edit</b><span>Add elements and customize the complete 1920 × 1080 canvas.</span></div>}
   </div>
  </div>:<div className="studio-theme-workspace">
   <div className="theme-topline"><div><small>ACTIVE BROADCAST IDENTITY</small><b>{value.theme.name}</b><span>Theme tokens update the real HUD and every full-screen broadcast scene.</span></div><label className="studio-field theme-name"><span>PACKAGE NAME</span><input maxLength={48} value={value.theme.name} onChange={event=>patchTheme({name:event.target.value,preset:'custom'})}/></label></div>
   <h3 className="studio-section-title">Art-directed starting points <small>Choose a full system, then refine every token below</small></h3>
   <div className="theme-preset-grid">{[...THEME_PRESETS,...value.presets.map(item=>item.theme)].map(theme=><button key={theme.preset} className={'theme-preset-card'+(theme.preset===value.theme.preset?' active':'')} onClick={()=>theme.preset.startsWith('theme_')?applySaved(theme.preset):applyTheme(theme)}>
    <span className="theme-swatch" style={{background:theme.panel,borderColor:theme.line}}><i style={{background:theme.accent}}/><i style={{background:theme.accentBright}}/><i style={{background:theme.gold}}/><b style={{background:theme.panelAlt,borderColor:theme.line}}/></span><span><b>{theme.name}</b><small>{theme.treatment.toUpperCase()} · {theme.density.toUpperCase()}</small></span>{value.presets.some(item=>item.id===theme.preset)&&<i className="theme-saved-mark">SAVED</i>}</button>)}</div>
   {value.presets.length>0&&<div className="saved-theme-management">{value.presets.map(item=><button key={item.id} onClick={()=>onChange({...value,presets:value.presets.filter(preset=>preset.id!==item.id)})} title={`Delete ${item.theme.name}`}><Trash2 size={12}/>{item.theme.name}<span>Remove preset</span></button>)}</div>}
   <div className="theme-editor-grid">
    <section className="theme-editor-card"><div className="theme-card-head"><div><small>01 · COLOUR SYSTEM</small><h3>Broadcast palette</h3></div><span>HEX · sRGB</span></div><div className="theme-color-grid">{COLOR_FIELDS.map(([key,label])=><ColorField key={key} label={label} value={String(value.theme[key])} onChange={color=>patchTheme({[key]:color} as Partial<OverlayTheme>)}/>)}</div></section>
    <section className="theme-editor-card"><div className="theme-card-head"><div><small>02 · MATERIAL & TYPE</small><h3>Surface language</h3></div></div><div className="studio-form-grid">
     <label className="studio-field"><span>DISPLAY FACE</span><select value={value.theme.fontDisplay} onChange={event=>patchTheme({fontDisplay:event.target.value as OverlayTheme['fontDisplay']})}>{['Barlow Condensed','DM Sans','Arial','Oswald','Roboto','Inter'].map(font=><option key={font}>{font}</option>)}</select></label>
     <label className="studio-field"><span>UI FACE</span><select value={value.theme.fontUi} onChange={event=>patchTheme({fontUi:event.target.value as OverlayTheme['fontUi']})}>{['DM Sans','Barlow Condensed','Arial','Oswald','Roboto','Inter'].map(font=><option key={font}>{font}</option>)}</select></label>
     <label className="studio-field"><span>PANEL TREATMENT</span><select value={value.theme.treatment} onChange={event=>patchTheme({treatment:event.target.value as OverlayTheme['treatment']})}><option value="broadcast">Broadcast · hard edges</option><option value="glass">Glass · softened</option><option value="minimal">Minimal · reduced chrome</option></select></label>
     <label className="studio-field"><span>INFORMATION DENSITY</span><select value={value.theme.density} onChange={event=>patchTheme({density:event.target.value as OverlayTheme['density']})}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
     <label className="studio-field"><span>PANEL OPACITY · {Math.round(value.theme.panelOpacity*100)}%</span><input type="range" min=".55" max="1" step=".01" value={value.theme.panelOpacity} onChange={event=>patchTheme({panelOpacity:Number(event.target.value)})}/></label>
     <label className="studio-field"><span>CORNER RADIUS · {value.theme.cornerRadius}px</span><input type="range" min="0" max="24" step="1" value={value.theme.cornerRadius} onChange={event=>patchTheme({cornerRadius:Number(event.target.value)})}/></label>
     <label className="studio-field"><span>BORDER WEIGHT · {value.theme.borderWidth}px</span><input type="range" min="0" max="8" step="1" value={value.theme.borderWidth} onChange={event=>patchTheme({borderWidth:Number(event.target.value)})}/></label>
     <label className="studio-field"><span>MOTION PROFILE</span><select value={value.theme.motion} onChange={event=>patchTheme({motion:event.target.value as OverlayTheme['motion']})}><option value="cinematic">Cinematic entrances</option><option value="subtle">Subtle</option><option value="off">Reduced motion</option></select></label>
     <label className="studio-toggle-card"><input type="checkbox" checked={value.theme.glow} onChange={event=>patchTheme({glow:event.target.checked})}/><span><b>Accent glow</b><small>Subtle highlight on borders and keylines</small></span></label>
     <label className="studio-toggle-card"><input type="checkbox" checked={value.theme.grid} onChange={event=>patchTheme({grid:event.target.checked})}/><span><b>Scene texture</b><small>Grid and ambient colour wash on full-screen graphics</small></span></label>
    </div></section>
   </div>
   <div className="theme-save-row"><div><b>Save a reusable theme</b><small>Saved themes travel with event packs and stay local to this host.</small></div><input className="preset-name-input" maxLength={48} value={presetName} placeholder="e.g. Spring Invitational" onChange={event=>setPresetName(event.target.value)}/><button className="button" disabled={!presetName.trim()||value.presets.length>=20} onClick={savePreset}><Plus size={14}/>Save preset</button></div>
  </div>}
 </section>;
}
