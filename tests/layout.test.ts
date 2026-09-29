import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {layoutSchema,elementStyle,LAYOUT_KEYS,emptyLayout} from '../server/layout';
import {radarsSchema} from '../server/radars';
import {calibrationFor} from '../src/radar';

// The overlay layout is operator data edited by dragging in the admin preview: an empty elements
// map is the shipped CSS default, anything else must round-trip through PUT /api/layout without
// smuggling unknown elements or impossible coordinates into the output views.

test('an empty layout is valid and leaves every element at its CSS default',()=>{
 assert.deepEqual(layoutSchema.parse(undefined),emptyLayout());
 assert.deepEqual(layoutSchema.parse({}),emptyLayout());
 assert.equal(elementStyle(emptyLayout(),'radar'),undefined,'no stored position means no inline override');
 assert.equal(elementStyle(undefined,'scoreboard'),undefined);
});

test('stored positions become inline styles, neutralising the anchors they replace',()=>{
 const layout=layoutSchema.parse({elements:{radar:{x:1500,y:80},economy:{x:600,y:950,w:700}}});
 assert.deepEqual(elementStyle(layout,'radar'),{left:1500,top:80,right:'auto',bottom:'auto',transform:'none'});
 // The economy bar is centred with left:50% + translateX(-50%) + bottom until it is moved.
 assert.deepEqual(elementStyle(layout,'economy'),{left:600,top:950,right:'auto',bottom:'auto',transform:'none'},'a stored width is ignored for auto-width elements');
});

test('left+right stretched elements get an explicit width so they cannot collapse',()=>{
 const withWidth=layoutSchema.parse({elements:{scoreboard:{x:40,y:40,w:1800}}});
 assert.equal(elementStyle(withWidth,'scoreboard')!.width,1800,'the dragged width is honoured');
 const noWidth=layoutSchema.parse({elements:{footer:{x:10,y:10},killfeed:{x:1400,y:200}}});
 assert.equal(elementStyle(noWidth,'footer')!.width,1864,'a missing width falls back to the full-width default');
 assert.equal(elementStyle(noWidth,'killfeed')!.width,undefined,'fixed-width elements keep their CSS width');
});

test('unknown elements and impossible coordinates are refused',()=>{
 for(const bad of [
  {elements:{signalLost:{x:0,y:0}}},
  {elements:{radar:{x:NaN}}},
  {elements:{radar:{x:99999}}},
  {elements:{radar:'left: 28px'}},
 ]){
  assert.equal(layoutSchema.safeParse(bad).success,false,`must refuse ${JSON.stringify(bad)}`);
 }
});

test('every declared key is draggable and no key leaked in',()=>{
 assert.deepEqual([...LAYOUT_KEYS].sort(),['event','scoreboard','radar','killfeed','rosterLeft','rosterRight','lowerThird','economy','footer'].sort());
});

// Radar calibration through PUT /api/radars: the shipped file must keep parsing, and the fields
// the projection maths divides by must be sane before they are ever saved.

test('the shipped config/radars.json survives the admin schema',async()=>{
 const shipped=JSON.parse(await readFile(fileURLToPath(new URL('../config/radars.json',import.meta.url)),'utf8'));
 const parsed=radarsSchema.parse(shipped);
 assert.equal(parsed.overviewSize,1024);
 assert.ok(parsed.maps.de_mirage&&parsed.maps.de_vertigo);
 assert.equal(calibrationFor(parsed,'de_mirage')!.posX,-3230);
});

test('calibration entries refuse a zero scale and stray paths',()=>{
 assert.equal(radarsSchema.safeParse({maps:{de_mirage:{posX:0,posY:0,scale:0}}}).success,false,'scale 0 would divide the projection to infinity');
 assert.equal(radarsSchema.safeParse({maps:{de_mirage:{posX:0,posY:0,scale:5,image:'../../etc/passwd'}}}).success,false,'only radars/ and uploads/radars/ images are served');
 assert.equal(radarsSchema.safeParse({maps:{de_mirage:{posX:-3230,posY:1713,scale:5,image:'uploads/radars/123-de_mirage.png'}}}).success,true);
 assert.equal(radarsSchema.safeParse({maps:{de_mirage:{posX:-3230,posY:1713,scale:5,image:''}}}).success,true,'empty means "fall back to radars/<map>.png"');
});

test('a custom image path wins over the radars/<map>.png default',()=>{
 const withImage=radarsSchema.parse({maps:{de_mirage:{posX:0,posY:0,scale:5,image:'uploads/radars/1-x.png'}}});
 assert.equal(calibrationFor(withImage,'de_mirage')!.image,'uploads/radars/1-x.png');
 const withoutImage=radarsSchema.parse({maps:{de_mirage:{posX:0,posY:0,scale:5}}});
 assert.equal(calibrationFor(withoutImage,'de_mirage')!.image,'radars/de_mirage.png','the drop-in default is unchanged');
});
