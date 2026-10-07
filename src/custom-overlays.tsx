import React from 'react';
import {assetUrl} from './assets';
import {getWidget,interpolateWidgetText,widgetShown,widgetStyle,type OverlayConfig} from '../server/overlay';
import type {SceneId} from '../server/controls';

export function CustomOverlays({config,scene,context,arranging=false,onMove}:{config?:OverlayConfig;scene:SceneId;context:Record<string,string|number|undefined>;arranging?:boolean;onMove?:(id:string,x:number,y:number)=>void}){
 const widgets=(config?.widgets||[]).filter(widget=>['text','image','shape','clock'].includes(widget.kind)&&widgetShown(widget,scene));
 const startDrag=(id:string,event:React.PointerEvent<HTMLDivElement>)=>{
  if(!arranging||!onMove)return;event.preventDefault();event.stopPropagation();
  const hud=event.currentTarget.closest('.hud');if(!hud)return;
  const frame=hud.getBoundingClientRect(),scale=frame.width/1920||1,rect=event.currentTarget.getBoundingClientRect();
  const start={x:(rect.left-frame.left)/scale,y:(rect.top-frame.top)/scale,mx:event.clientX,my:event.clientY};
  const move=(pointer:PointerEvent)=>onMove(id,Math.round(Math.max(-280,Math.min(2200,start.x+(pointer.clientX-start.mx)/scale))),Math.round(Math.max(-280,Math.min(1360,start.y+(pointer.clientY-start.my)/scale))));
  const stop=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',stop);window.removeEventListener('pointercancel',stop)};
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',stop);window.addEventListener('pointercancel',stop);
 };
 if(!widgets.length)return null;
 return <div className="custom-overlay-layer" aria-hidden="true">{widgets.sort((a,b)=>a.zIndex-b.zIndex).map(widget=>{
  const base=widgetStyle(widget,{position:'absolute',left:widget.x??0,top:widget.y??0,width:widget.width??320,height:widget.height??90});
  const decorated:React.CSSProperties={...base as React.CSSProperties,fontSize:widget.fontSize??38,color:widget.color,fontFamily:`'${widget.font}',sans-serif`,textShadow:config?.theme.glow?'0 2px 14px rgba(0,0,0,.55)':'none',border:widget.borderColor?`1px solid ${widget.borderColor}`:undefined,pointerEvents:arranging?'auto':'none',touchAction:'none',cursor:arranging?'move':'default'};
  if(widget.kind==='image')return <div className="custom-overlay custom-image" style={decorated} key={widget.id} onPointerDown={event=>startDrag(widget.id,event)}>{widget.asset?<img src={assetUrl(widget.asset)} alt="" style={{objectFit:widget.fit,width:'100%',height:'100%'}}/>:<span>ADD GRAPHIC</span>}</div>;
  if(widget.kind==='shape')return <div className="custom-overlay custom-shape" style={{...decorated,background:widget.fill||widget.color,borderRadius:config?.theme.cornerRadius||0}} key={widget.id} onPointerDown={event=>startDrag(widget.id,event)}/>;
  const template=widget.kind==='clock'?(widget.text||'{clock}'):widget.text;
  const text=interpolateWidgetText(template,context);
  return <div className={'custom-overlay '+(widget.kind==='clock'?'custom-clock':'custom-text')} style={{...decorated,background:widget.fill?`${widget.fill}e8`:'transparent',borderBottom:widget.borderColor?`2px solid ${widget.borderColor}`:undefined,borderRadius:config?.theme.cornerRadius||0}} key={widget.id} onPointerDown={event=>startDrag(widget.id,event)}>{text||' '}</div>;
 })}</div>;
}

export function widgetVisible(config:OverlayConfig|undefined,id:string,scene:SceneId):boolean {
 return widgetShown(getWidget(config,id),scene);
}
