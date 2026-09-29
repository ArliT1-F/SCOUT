import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FeedMonitor,feedNextAction} from '../server/state';

// Work item 0: the host must be able to say *why* no data is showing. These tests pin the four
// failure modes the panel distinguishes (never sent / bad token / bad shape / playing not observing).

test('reports which GSI blocks the accepted packet carried, with sizes',()=>{
 const feed=new FeedMonitor('env',8080);
 const report=feed.accept({provider:{steamid:'76561198000000000'},map:{name:'de_inferno',team_ct:{},team_t:{}},round:{phase:'live'},player:{steamid:'1'},allplayers:{a:{},b:{},c:{}}});
 assert.equal(report.first,true);
 assert.equal(report.firstAllplayers,true);
 assert.deepEqual(feed.blocks,{provider:1,map:3,round:1,player:1,allplayers:3});
 assert.equal(feed.allplayers,3);
 assert.equal(feed.provider,'76561198000000000');
 assert.equal(feed.accepted,1);
});

test('warns once 100 packets arrive without an allplayers block (playing, not spectating)',()=>{
 const feed=new FeedMonitor('default',8080);
 let warning=false;
 for(let i=0;i<120;i++) warning=feed.accept({provider:{timestamp:i},map:{name:'de_inferno'},round:{phase:'live'}}).observerGap||warning;
 assert.equal(warning,true);
 assert.equal(feed.allplayersSeen,false);
 assert.equal(feed.snapshot().observerGap,true);
 assert.match(feedNextAction(feed.snapshot()),/playing, not spectating|observer\/GOTV/);
 // A single observer packet clears the gap and stops the warning.
 feed.accept({provider:{timestamp:121},allplayers:{a:{}}});
 assert.equal(feed.snapshot().observerGap,false);
 assert.equal(feed.allplayersSeen,true);
});

test('token rejections and shape rejections are counted separately and rate-limited',()=>{
 const feed=new FeedMonitor('default',8080);
 assert.equal(feed.reject('auth','invalid token',1000).log,true);
 assert.equal(feed.reject('auth','invalid token',1100).log,false);
 assert.equal(feed.reject('auth','invalid token',10999).log,false);
 assert.equal(feed.reject('auth','invalid token',11000).log,true);
 // One log per 10 s across *all* rejection kinds: at ~20 Hz a mixed feed must not flood either.
 assert.equal(feed.reject('shape','missing provider block',12000).log,false);
 assert.equal(feed.reject('shape','missing provider block',22000).log,true);
 assert.equal(feed.rejectedAuth,4);
 assert.equal(feed.rejectedShape,2);
 assert.equal(feed.accepted,0);
 assert.match(feedNextAction(feed.snapshot(12000)),/rejected on its token/);
 assert.match(feed.snapshot(12000).lastRejectedReason,/missing provider/);
});

test('diagnostics expose the token source but never the token value',()=>{
 process.env.GSI_TOKEN='s3cret-operator-token';
 const feed=new FeedMonitor(process.env.GSI_TOKEN?'env':'default',8080);
 feed.accept({provider:{steamid:'76561198000000000'}});
 feed.reject('auth','invalid token',1000);
 const json=JSON.stringify(feed.snapshot(2000));
 assert.equal(json.includes('s3cret-operator-token'),false);
 assert.equal(feed.snapshot(2000).tokenSource,'env');
 assert.equal(feed.snapshot(2000).uri,'http://127.0.0.1:8080/gsi');
 delete process.env.GSI_TOKEN;
 assert.equal(new FeedMonitor(process.env.GSI_TOKEN?'env':'default').tokenSource,'default');
});

test('late packets are counted separately and explained in the next action',()=>{
 const feed=new FeedMonitor('default',8080);
 feed.accept({provider:{timestamp:20},map:{name:'de_inferno'},allplayers:{a:{}}},1000);
 assert.equal(feed.late(1100).log,true);
 assert.equal(feed.late(1200).log,false);
 assert.equal(feed.late(11100).log,true);
 assert.equal(feed.snapshot(12000).rejectedLate,3);
 assert.match(feedNextAction(feed.snapshot(2000)),/already holds a newer provider timestamp/);
 assert.equal(feed.accepted,1,'a stale packet is not an accepted packet');
});

test('next action distinguishes never-sent from stale from healthy',()=>{
 const fresh=new FeedMonitor('default',8080);
 assert.match(feedNextAction(fresh.snapshot()),/Nothing has reached/);
 assert.match(feedNextAction(fresh.snapshot()),/8080/);
 fresh.accept({provider:{steamid:'76561198000000000'},map:{name:'de_mirage'},allplayers:{a:{}}},1000);
 assert.match(feedNextAction(fresh.snapshot(2000)),/Feed healthy/);
 assert.match(feedNextAction(fresh.snapshot(9000)),/Last packet was 8s ago/);
 assert.match(feedNextAction(undefined),/Host not reporting diagnostics/);
});
