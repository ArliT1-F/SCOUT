import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PanelAuth,capabilitiesFor,hasCapability} from '../server/auth';
import {ControlLease} from '../server/lease';
import {OperatorDirectory} from '../server/operators';
import {AuditTrail} from '../server/audit';
import {buildPreflight} from '../server/preflight';
import {configSchema,normalizeConfig} from '../server/config';
import {radarsSchema} from '../server/radars';
import {emptyLayout} from '../server/layout';
import {createEventPack,restoreEventPack,eventPackSchema} from '../server/packs';
import {createWidget,defaultOverlay,overlayThemeStyle,widgetShown} from '../server/overlay';

const principal=(id:string,name:string,role:'owner'|'producer'|'designer'|'viewer')=>({id,name,role});

test('operator tokens are one-time secrets, role-scoped, and revoked immediately',()=>{
 const directory=new OperatorDirectory();
 const issued=directory.issue({label:'Main desk',role:'producer',now:1_700_000_000_000});
 assert.equal(issued.operator.role,'producer');
 assert.match(issued.token,/^[A-Za-z0-9_-]{32}$/,'the one-time token has 192 bits of random entropy');
 assert.equal(directory.verify(issued.token)?.id,issued.operator.id);
 assert.equal(directory.verify('not-the-token'),undefined);
 assert.equal(directory.serialize().includes(issued.token),false,'only the salted digest is persisted');
 assert.deepEqual(capabilitiesFor('producer'),['control','match-edit']);
 assert.equal(hasCapability('designer','design'),true);
 assert.equal(hasCapability('designer','control'),false);
 assert.deepEqual(capabilitiesFor('viewer'),[]);
 const auth=new PanelAuth({token:'a-long-primary-owner-token',operatorTokens:directory.credentials});
 const access=auth.authorize({address:'192.168.1.40',host:'192.168.1.40:8080',headers:{'x-scout-token':issued.token}});
 assert.equal(access.ok,true);
 if(access.ok)assert.deepEqual([access.principal.name,access.principal.role],['Main desk','producer']);
 assert.equal(auth.view({address:'192.168.1.40',host:'192.168.1.40:8080',headers:{'x-scout-token':issued.token}}).capabilities.includes('control'),true);
 assert.equal(directory.revoke(issued.operator.id,1_700_000_000_001),true);
 assert.equal(directory.verify(issued.token),undefined);
 assert.equal(directory.revoke(issued.operator.id),false);
});

test('control leases serialize producers, support explicit owner takeover, and expire after inactivity',()=>{
 let now=10_000;const lease=new ControlLease(()=>now,45_000);
 const producer=principal('p1','Producer One','producer'),second=principal('p2','Producer Two','producer'),designer=principal('d1','Designer','designer'),owner=principal('o1','Owner','owner');
 assert.equal(lease.claim(designer).ok,false,'design-only operators cannot acquire on-air control');
 const claim=lease.claim(producer);assert.equal(claim.ok,true);
 assert.equal(lease.view('p1').mine,true);
 const conflict=lease.claim(second);assert.equal(conflict.ok,false);
 if(!conflict.ok){assert.equal(conflict.code,'control-lease-held');assert.match(conflict.error,/Producer One/)}
 const renewed=lease.renew(producer);assert.equal(renewed.ok,true);now+=44_999;
 assert.equal(lease.view('p1').holder,'Producer One','activity renews the 45-second lease');
 const takeover=lease.claim(owner,true);assert.equal(takeover.ok,true);assert.equal(lease.view('o1').mine,true);assert.equal(lease.view('p1').mine,false);
 assert.equal(lease.release(producer).ok,false,'a displaced producer cannot release the owner lease');
 now+=45_001;assert.equal(lease.view().holder,null,'idle leases expire instead of surviving a restart');
});

test('the durable audit trail is bounded, newline-safe, and reloadable',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'scout-audit-'));
 try{
  const trail=new AuditTrail(directory);await trail.load();trail.record(principal('p','Producer','producer'),'controls.update','live\nforge\tdetail');
  await new Promise(resolve=>setTimeout(resolve,30));
  const disk=await readFile(path.join(directory,'audit.jsonl'),'utf8');assert.equal(disk.includes('forge\tdetail'),false);
  const restored=new AuditTrail(directory);await restored.load();assert.deepEqual(restored.list(1).map(entry=>[entry.actor,entry.role,entry.action,entry.detail]),[['Producer','producer','controls.update','live forge detail']]);
 }finally{await rm(directory,{recursive:true,force:true})}
});

test('preflight distinguishes a live observer feed from a disconnected or incomplete setup',()=>{
 const config=normalizeConfig(configSchema.parse({event:{name:'Finals'},teams:[{id:'a',name:'Alpha'},{id:'b',name:'Bravo'}],maps:[{name:'de_mirage'}]}));
 const overlay=defaultOverlay();
 const now=100_000;
 const report=buildPreflight({hostConnected:true,lastSeen:now-250,gsi:{accepted:100,rejectedAuth:0,rejectedShape:0,rejectedLate:0,subtreeIssues:0,lastPacketAt:now-250,lastPacketAge:250,lastRejectedAt:0,lastRejectedReason:'',blocks:{allplayers:10,map:1},allplayers:10,allplayersSeen:true,observerGap:false,provider:'observer',tokenSource:'env',port:8080,uri:'http://127.0.0.1:8080/gsi'},state:{map:{name:'de_mirage',phase:'live',round:1,team_ct:{name:'Alpha',score:0},team_t:{name:'Bravo',score:0}}},sides:{CT:{id:'a',name:'Alpha',source:'names'},T:{id:'b',name:'Bravo',source:'names'},source:'names',confidence:'engaged'},radars:radarsSchema.parse({maps:{de_mirage:{posX:0,posY:0,scale:1}}}),config,overlay,now});
 assert.equal(report.ready,true);assert.equal(report.blockers,0);assert.ok(report.score>=85);
 const blocked=buildPreflight({hostConnected:false,lastSeen:0,now,config,overlay});
 assert.equal(blocked.ready,false);assert.ok(blocked.checks.some(check=>check.id==='host'&&check.state==='blocked'));assert.ok(blocked.checks.some(check=>check.id==='observer'&&check.state==='blocked'));
 const empty={...overlay,widgets:overlay.widgets.map(widget=>({...widget,enabled:false}))};
 assert.ok(buildPreflight({hostConnected:true,lastSeen:now,now,config,overlay:empty}).checks.some(check=>check.id==='layers'&&check.state==='blocked'));
});

const tinyPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nWQAAAAASUVORK5CYII=','base64');
test('versioned event packs validate image bytes, remap referenced art, and restore it safely',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'scout-event-pack-'));
 try{
  const source=path.join(root,'source'),destination=path.join(root,'destination');
  const references={logo:'uploads/logos/1-alpha.png',portrait:'uploads/players/1-player.png',map:'uploads/maps/1-map.png',radar:'uploads/radars/1-radar.png',overlay:'uploads/overlays/1-sponsor.png'};
  for(const relative of Object.values(references)){const file=path.join(source,...relative.split('/').slice(1));await mkdir(path.dirname(file),{recursive:true});await writeFile(file,tinyPng)}
  const config=normalizeConfig(configSchema.parse({event:{name:'Cup Final',stage:'Grand final'},teams:[{id:'a',name:'Alpha',logo:references.logo,players:[{name:'Player',photo:references.portrait}]},{id:'b',name:'Bravo'}],maps:[{name:'de_mirage',image:references.map}]}));
  const radars=radarsSchema.parse({maps:{de_mirage:{posX:0,posY:0,scale:1,image:references.radar}}});
  const overlay=defaultOverlay();const sponsor=createWidget('image','sponsor');sponsor.asset=references.overlay;overlay.widgets.push(sponsor);
  const pack=await createEventPack(config,radars,emptyLayout(),overlay,source);
  assert.equal(pack.format,'scout-event-pack');assert.equal(pack.version,1);assert.equal(pack.assets.length,5);
  assert.equal(JSON.stringify(pack).includes('SCOUT_PANEL_TOKEN'),false,'event packs contain no host credential');
  const restored=await restoreEventPack(pack,destination);
  assert.equal(restored.assets,5);assert.equal(restored.assetBytes,tinyPng.length*5);
  const newLogo=restored.config.teams[0].logo;assert.notEqual(newLogo,references.logo);assert.match(newLogo,/^uploads\/logos\/\d+-pack-/);
  const restoredFile=path.join(destination,...newLogo.split('/').slice(1));assert.deepEqual(await readFile(restoredFile),tinyPng);
  assert.equal(restored.config.teams[0].players[0].photo.startsWith('uploads/players/'),true);
  assert.equal(restored.overlay.widgets.find(widget=>widget.id==='sponsor')?.asset.startsWith('uploads/overlays/'),true);
  const tampered=structuredClone(pack);tampered.assets[0].base64=Buffer.from('not an image').toString('base64');
  assert.equal(eventPackSchema.safeParse(tampered).success,false,'MIME is checked against file bytes, not just a label');
  const incomplete=structuredClone(pack);incomplete.assets=incomplete.assets.slice(1);
  await assert.rejects(()=>restoreEventPack(incomplete,path.join(root,'missing')),/missing referenced artwork/i);
  const activeSvg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
  const unsafeSvg={...pack,assets:[{path:'uploads/overlays/unsafe.svg',mime:'image/svg+xml',base64:activeSvg}]};
  assert.equal(eventPackSchema.safeParse(unsafeSvg).success,false,'active SVG content is refused by the pack validator');
 }finally{await rm(root,{recursive:true,force:true})}
});

test('theme presets turn into scoped HUD tokens and layer visibility is scene-specific',()=>{
 const overlay=defaultOverlay();
 const style=overlayThemeStyle({...overlay.theme,accent:'#32ccff',panel:'#101820',panelOpacity:.75,cornerRadius:9});
 assert.equal(style['--accent'],'#32ccff');assert.match(String(style['--theme-panel']),/rgba\(16,24,32,0\.75\)/);assert.equal(style['--theme-radius'],'9px');
 const recap=overlay.widgets.find(widget=>widget.id==='event')!;
 assert.equal(widgetShown(recap,'live'),true);assert.equal(widgetShown(recap,'recap'),false);
 recap.showOn.push('recap');assert.equal(widgetShown(recap,'recap'),true);
});
