// Share cards for a finished match, rendered as SVG so no image library is needed on the host and
// the browser can turn the same document into a PNG with a canvas. Every value is escaped: a team
// name is operator input, and this string ends up in an <svg> served to a browser.
import type {Recap,RecapPlayer} from './recap.js';
import {formatDuration} from './recap.js';

export type CardSize='feed'|'story';
export const CARD_SIZES:Record<CardSize,{width:number;height:number}>={
 feed:{width:1200,height:630},
 story:{width:1080,height:1350},
};
export const escapeXml=(value:string)=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const clip=(value:string,max:number)=>{const text=String(value??'');return text.length<=max?text:`${text.slice(0,max-1)}…`};
const dateLabel=(at:number)=>{
 try{return new Intl.DateTimeFormat('en-GB',{day:'2-digit',month:'short',year:'numeric',timeZone:'UTC'}).format(at)}catch{return new Date(at).toISOString().slice(0,10)}
};
const statLine=(player:RecapPlayer)=>[
 `${player.kills} K`,
 `${player.deaths} D`,
 player.assists===null?'':'A',
].filter(Boolean).join(' · ');
const mvpDetail=(player:RecapPlayer)=>[
 `${player.kills}/${player.deaths}`,
 player.hsPct===null?'':`${player.hsPct}% HS`,
 player.adr===null?'':`${player.adr} ADR`,
].filter(Boolean).join('  ·  ');
// A short, honest caption the operator can paste with the image.
export function recapCaption(recap:Recap,url?:string):string {
 const score=recap.teams.map(team=>`${team.name} ${team.mapsWon}`).join(' — ');
 const maps=recap.maps.map(map=>`${map.map.replace('de_','')} ${map.ctScore}:${map.tScore}`).join(', ');
 const winner=recap.seriesWinner!==null?`${recap.teams[recap.seriesWinner].name} win ${score}`:`Series ${score}`;
 const lines=[`${recap.event?recap.event+' · ':''}${recap.name}`,winner,maps?`Maps: ${maps}`:'',recap.mvp?`MVP: ${recap.mvp.name} (${mvpDetail(recap.mvp)})`:'',url||''];
 return lines.filter(Boolean).join('\n');
}
export function recapCardSvg(recap:Recap,size:CardSize='feed'):string {
 const {width,height}=CARD_SIZES[size];
 const story=size==='story';
 const pad=story?64:56;
 const teams=recap.teams;
 const winnerName=recap.seriesWinner!==null?teams[recap.seriesWinner]?.name:'';
 const mapRows=recap.maps.slice(0,story?6:5).map((map,index)=>{
  const won=map.winnerTeamIndex;
  return {index,label:(map.map||`map ${index+1}`).replace(/^de_/,''),score:`${map.ctScore}:${map.tScore}`,won:won!==null?teams[won]?.name||'':'—'};
 });
 const top=recap.players.slice(0,story?8:5);
 const headerY=pad+18;
 const scoreY=story?pad+280:pad+150;
 const mvpY=scoreY+(story?380:210);
 const footerY=height-pad;
 // The story format has room for a five-row table under the MVP; the feed card stays a headline.
 const tableTop=mvpY+(story?190:0);
 const svg:string[]=[];
 svg.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(clip(`${recap.name}: ${teams.map(team=>`${team.name} ${team.mapsWon}`).join(' - ')}`,160))}">`);
 svg.push('<defs>');
 svg.push('<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#121017"/><stop offset="1" stop-color="#08070b"/></linearGradient>');
 svg.push('<linearGradient id="accent" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#f2609e"/><stop offset="1" stop-color="#8f7bff"/></linearGradient>');
 svg.push('</defs>');
 svg.push(`<rect width="${width}" height="${height}" fill="url(#bg)"/>`);
 svg.push(`<rect x="0" y="0" width="${width}" height="6" fill="url(#accent)"/>`);
 svg.push(`<text x="${pad}" y="${headerY}" font-family="Barlow Condensed, Arial Narrow, sans-serif" font-size="${story?30:26}" letter-spacing="6" fill="#efeaf2">SCOUT</text>`);
 svg.push(`<text x="${width-pad}" y="${headerY}" text-anchor="end" font-family="DM Sans, system-ui, sans-serif" font-size="${story?18:16}" fill="#ab9fb5">${escapeXml(clip(dateLabel(recap.endedAt??recap.startedAt),32))}</text>`);
 svg.push(`<text x="${pad}" y="${headerY+(story?44:36)}" font-family="DM Sans, system-ui, sans-serif" font-size="${story?22:19}" fill="#ab9fb5">${escapeXml(clip([recap.event,recap.stage].filter(Boolean).join(' · ')||'SCOUT broadcast',story?46:60))}</text>`);
 svg.push(`<text x="${pad}" y="${scoreY}" font-family="Barlow Condensed, Arial Narrow, sans-serif" font-size="${story?82:64}" fill="#efeaf2">${escapeXml(clip(teams[0]?.name||recap.name,story?18:22))}</text>`);
 svg.push(`<text x="${width/2}" y="${scoreY}" text-anchor="middle" font-family="Barlow Condensed, Arial Narrow, sans-serif" font-size="${story?46:38}" fill="#7e7289">VS</text>`);
 svg.push(`<text x="${width-pad}" y="${scoreY}" text-anchor="end" font-family="Barlow Condensed, Arial Narrow, sans-serif" font-size="${story?82:64}" fill="#efeaf2">${escapeXml(clip(teams[1]?.name||'—',story?18:22))}</text>`);
 svg.push(`<text x="${width/2}" y="${scoreY+72}" text-anchor="middle" font-family="Barlow Condensed, Arial Narrow, sans-serif" font-size="${story?120:92}" fill="url(#accent)">${teams[0]?.mapsWon??0} : ${teams[1]?.mapsWon??0}</text>`);
 svg.push(`<text x="${width/2}" y="${scoreY+112}" text-anchor="middle" font-family="DM Sans, system-ui, sans-serif" font-size="${story?20:17}" fill="#ab9fb5">${escapeXml(recap.format.toUpperCase())}${winnerName?` · ${escapeXml(clip(winnerName,28))} WIN`:''}</text>`);
 let rowY=scoreY+(story?200:118);
 const rowGap=story?44:34;
 for(const row of mapRows.slice(0,story?6:4)){
  svg.push(`<text x="${pad}" y="${rowY}" font-family="DM Sans, system-ui, sans-serif" font-size="${story?22:18}" fill="#efeaf2">${escapeXml(clip(row.label,18))}</text>`);
  svg.push(`<text x="${width*0.52}" y="${rowY}" text-anchor="end" font-family="DM Sans, system-ui, sans-serif" font-size="${story?22:18}" fill="#efeaf2">${escapeXml(row.score)}</text>`);
  svg.push(`<text x="${width-pad}" y="${rowY}" text-anchor="end" font-family="DM Sans, system-ui, sans-serif" font-size="${story?20:17}" fill="#7e7289">${escapeXml(clip(row.won,22))}</text>`);
  rowY+=rowGap;
 }
 svg.push(`<rect x="${pad}" y="${mvpY}" width="${width-pad*2}" height="${story?150:104}" rx="18" fill="#15121b" stroke="#241f2e"/>`);
 svg.push(`<text x="${pad+28}" y="${mvpY+(story?44:32)}" font-family="DM Sans, system-ui, sans-serif" font-size="14" letter-spacing="3" fill="#f2609e">MVP</text>`);
 svg.push(`<text x="${pad+28}" y="${mvpY+(story?86:64)}" font-family="Barlow Condensed, Arial Narrow, sans-serif" font-size="${story?44:34}" fill="#efeaf2">${escapeXml(clip(recap.mvp?.name||'No kills recorded',story?22:26))}</text>`);
 if(recap.mvp) svg.push(`<text x="${pad+28}" y="${mvpY+(story?122:90)}" font-family="DM Sans, system-ui, sans-serif" font-size="${story?18:16}" fill="#ab9fb5">${escapeXml(mvpDetail(recap.mvp))}</text>`);
 if(story&&top.length>1){
  let tableY=tableTop;
  for(const player of top.slice(1)){
   svg.push(`<text x="${pad}" y="${tableY}" font-family="DM Sans, system-ui, sans-serif" font-size="20" fill="#efeaf2">${escapeXml(clip(player.name,20))}</text>`);
   svg.push(`<text x="${width*0.62}" y="${tableY}" text-anchor="end" font-family="DM Sans, system-ui, sans-serif" font-size="20" fill="#efeaf2">${escapeXml(statLine(player))}</text>`);
   svg.push(`<text x="${width-pad}" y="${tableY}" text-anchor="end" font-family="DM Sans, system-ui, sans-serif" font-size="18" fill="#7e7289">${escapeXml(recap.teams[player.teamIndex]?.name||'')}</text>`);
   tableY+=46;
  }
 }
 const footer=[`${recap.totals.kills} kills`,`${recap.totals.rounds} rounds`,formatDuration(recap.durationMs)].filter(Boolean).join('  ·  ');
 svg.push(`<text x="${pad}" y="${footerY}" font-family="DM Sans, system-ui, sans-serif" font-size="16" fill="#7e7289">${escapeXml(footer)}</text>`);
 svg.push(`<text x="${width-pad}" y="${footerY}" text-anchor="end" font-family="DM Sans, system-ui, sans-serif" font-size="16" fill="#7e7289">Broadcast with SCOUT</text>`);
 // "Not captured" is stated, never faked: an archive from before snapshots has no assists or damage.
 if(!recap.captured.assists||!recap.captured.damage)
  svg.push(`<text x="${pad}" y="${footerY-(story?34:26)}" font-family="DM Sans, system-ui, sans-serif" font-size="14" fill="#7e7289">Assists and damage were not captured for this archive.</text>`);
 svg.push('</svg>');
 return svg.join('');
}
