import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SponsorLedger,SPONSOR_ASSET,activeSponsor,emptySponsor,rotationBucket,rotationCycle,sponsorCsv} from '../server/sponsors.js';
import {createWidget,overlaySchema} from '../server/overlay.js';

// Sponsors (the follow-up to docs/LAUNCH-FEATURES.md §1). Two guarantees: the rotation is the same
// calculation on the host and in every output, and proof of play counts what went to air once.
const slot=(id:string,weight=1,asset='uploads/overlays/sponsor-a.png',enabled=true)=>({id,name:id.toUpperCase(),asset,weight,enabled});

test('a weighted rotation repeats each sponsor in proportion to its weight',()=>{
 const slots=[slot('a',1),slot('b',3)];
 const cycle=rotationCycle(slots);
 assert.deepEqual(cycle.map(entry=>entry.id),['a','b','b','b']);
});

test('the rotation is a pure function of the clock, so every output agrees',()=>{
 const slots=[slot('a',1),slot('b',1)];
 const at=1_000_000;
 assert.equal(activeSponsor(slots,at,10_000)?.id,'a');
 assert.equal(activeSponsor(slots,at+10_000,10_000)?.id,'b');
 assert.equal(activeSponsor(slots,at+20_000,10_000)?.id,'a');
 // Same instant, same answer: this is what lets /obs, /game and the studio preview switch together
 // without a socket message.
 assert.equal(activeSponsor(slots,at+50_000,10_000)?.id,activeSponsor(slots,at+50_000,10_000)?.id);
 assert.equal(rotationBucket(at+50_000,10_000),105);
});

test('disabled, empty and non-image slots never reach air',()=>{
 assert.equal(activeSponsor([],0),null);
 assert.equal(activeSponsor([slot('a',1,'',true)],0),null);
 assert.equal(activeSponsor([slot('a',1,'uploads/overlays/a.svg',true)],0),null,'SVG is not an overlay graphic');
 assert.equal(activeSponsor([slot('a',1,'uploads/overlays/a.png',false)],0),null);
 assert.equal(activeSponsor([slot('a',1,'uploads/logos/a.png',true)],0),null,'a sponsor must be an overlay upload');
});

test('only the four raster formats are accepted for a sponsor graphic',()=>{
 for(const ext of ['png','jpg','jpeg','webp','gif']) assert.match(`uploads/overlays/x.${ext}`,SPONSOR_ASSET,ext);
 for(const bad of ['uploads/overlays/x.svg','uploads/overlays/x.html','https://example.com/x.png','uploads/overlays/../x.png','uploads/logos/x.png']) assert.equal(SPONSOR_ASSET.test(bad),false,bad);
});

test('sponsors are part of the overlay document, validated and bounded',()=>{
 const parsed=overlaySchema.parse({sponsors:[{id:'a',name:'Acme',asset:'uploads/overlays/acme.png',weight:2}]});
 assert.equal(parsed.sponsors[0].weight,2);
 assert.equal(parsed.sponsors[0].enabled,true);
 assert.throws(()=>overlaySchema.parse({sponsors:[{id:'a',name:'Acme',asset:'uploads/overlays/acme.svg'}]}),/PNG/);
 assert.throws(()=>overlaySchema.parse({sponsors:[{id:'a',name:'Acme',asset:'uploads/overlays/acme.png',weight:0}]}));
 const tooMany=Array.from({length:17},(_,index)=>({id:`s${index}`,name:`S${index}`,asset:'uploads/overlays/x.png'}));
 assert.throws(()=>overlaySchema.parse({sponsors:tooMany}));
});

test('a sponsor layer is visible in every scene by default',()=>{
 // The studio creates a sponsor layer through createWidget, which is where the all-scenes default and
 // the rotation speed live. Adding a layer never changes air by itself: nothing is published until the
 // operator presses Publish to outputs.
 const widget=createWidget('sponsor','sponsor_1');
 assert.equal(widget.showOn.length,9,'nine scenes, nine chances for a sponsorship to be seen');
 assert.equal(widget.rotateMs,20_000);
 assert.equal(widget.kind,'sponsor');
 assert.equal(overlaySchema.parse({widgets:[widget]}).widgets[0].showOn.length,9,'the choice survives the schema');
});

test('proof of play counts one impression per sponsor per scene per rotation step',async()=>{
 const ledger=new SponsorLedger(path.join(await mkdtemp(path.join(tmpdir(),'scout-sponsors-')),'impressions.json'));
 const entry={at:1_000,sponsorId:'a',sponsorName:'Acme',scene:'live',bucket:1};
 assert.equal(ledger.record(entry),true);
 assert.equal(ledger.record({...entry,at:1_100}),false,'a second sample inside the same step is the same impression');
 assert.equal(ledger.record({...entry,bucket:2,at:21_000}),true);
 assert.equal(ledger.record({...entry,scene:'bracket',bucket:2}),true,'another scene is another appearance');
 assert.equal(ledger.size,3);
 await ledger.flush();
});

test('the report aggregates by sponsor and by scene, and the CSV is spreadsheet-safe',async()=>{
 const ledger=new SponsorLedger(path.join(await mkdtemp(path.join(tmpdir(),'scout-sponsors-')),'impressions.json'));
 ledger.record({at:1_000,sponsorId:'a',sponsorName:'Acme',scene:'live',bucket:1});
 ledger.record({at:2_000,sponsorId:'a',sponsorName:'Acme',scene:'recap',bucket:1});
 ledger.record({at:3_000,sponsorId:'b',sponsorName:'=Budget',scene:'live',bucket:1});
 const report=ledger.report({from:0,to:10_000,now:10_000});
 assert.equal(report.total,3);
 assert.equal(report.rows[0].id,'a');
 assert.equal(report.rows[0].impressions,2);
 assert.equal(report.rows[0].share,66.7);
 assert.deepEqual(report.rows[0].scenes,{live:1,recap:1});
 const csv=sponsorCsv(report);
 assert.match(csv,/^sponsor,impressions,share_percent,scenes,from,to/m);
 assert.match(csv,/'=Budget/,'a sponsor name that looks like a formula is neutralized');
 const windowed=ledger.report({from:2_500,to:10_000,now:10_000});
 assert.equal(windowed.total,1,'the window is honoured');
});

test('emptySponsor produces a schema-valid slot',()=>{
 const slot=emptySponsor(0,'uploads/overlays/test.png');
 const parsed=overlaySchema.parse({sponsors:[slot]});
 assert.equal(parsed.sponsors[0].name,'Sponsor 1');
 assert.equal(parsed.sponsors[0].asset,'uploads/overlays/test.png');
});
