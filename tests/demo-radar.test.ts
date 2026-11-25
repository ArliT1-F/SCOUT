import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {demo} from '../src/demo';
import {calibrationFor,radarPoints} from '../src/radar';

// The sample match on the landing page and in the panel preview draws its players and utility on the
// shipped de_inferno radar. Being inside the overview's bounding box is not enough: a dot in the empty
// space around the playable area is the first thing a visitor notices. This decodes the overview PNG
// and checks the pixel under every sample marker is part of the map (opaque), using the same
// calibration and projection the HUD draws with.

const root=(file:string)=>fileURLToPath(new URL(`../${file}`,import.meta.url));

// A minimal decoder for the shipped overviews: 8-bit RGBA, non-interlaced.
function decodeRgba(buffer:Buffer){
 assert.equal(buffer.subarray(1,4).toString('latin1'),'PNG');
 let offset=8,width=0,height=0;const idat:Buffer[]=[];
 while(offset<buffer.length){
  const length=buffer.readUInt32BE(offset),type=buffer.subarray(offset+4,offset+8).toString('latin1'),data=buffer.subarray(offset+8,offset+8+length);
  if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);assert.equal(data[8],8,'8-bit');assert.equal(data[9],6,'RGBA');assert.equal(data[12],0,'not interlaced')}
  if(type==='IDAT') idat.push(data);
  if(type==='IEND') break;
  offset+=12+length;
 }
 const raw=inflateSync(Buffer.concat(idat)),stride=width*4,pixels=Buffer.alloc(stride*height);
 for(let y=0;y<height;y++){
  const filter=raw[y*(stride+1)],line=raw.subarray(y*(stride+1)+1,(y+1)*(stride+1));
  for(let x=0;x<stride;x++){
   const left=x>=4?pixels[y*stride+x-4]:0,up=y>0?pixels[(y-1)*stride+x]:0,corner=x>=4&&y>0?pixels[(y-1)*stride+x-4]:0;
   const paeth=()=>{const p=left+up-corner,pa=Math.abs(p-left),pb=Math.abs(p-up),pc=Math.abs(p-corner);return pa<=pb&&pa<=pc?left:pb<=pc?up:corner};
   const add=filter===0?0:filter===1?left:filter===2?up:filter===3?(left+up)>>1:paeth();
   pixels[y*stride+x]=(line[x]+add)&255;
  }
 }
 return {width,height,alpha:(x:number,y:number)=>pixels[(Math.min(height-1,Math.max(0,y))*width+Math.min(width-1,Math.max(0,x)))*4+3]};
}

test('every sample player and grenade sits on the de_inferno map, not beside it',()=>{
 const radars=JSON.parse(readFileSync(root('config/radars.json'),'utf8'));
 const cal=calibrationFor(radars,'de_inferno');
 assert.ok(cal,'the shipped calibration for de_inferno');
 const image=decodeRgba(readFileSync(root(`public/${cal.image}`)));
 const {dots,grenades}=radarPoints(demo,cal);
 assert.equal(dots.length,10,'all ten sample players are on the radar');
 assert.equal(grenades.length,3,'all three sample grenades are on the radar');
 for(const marker of [...dots.map(dot=>({label:dot.name,u:dot.u,v:dot.v})),...grenades.map(item=>({label:item.id,u:item.u,v:item.v}))]){
  const x=Math.round(marker.u*image.width),y=Math.round(marker.v*image.height);
  assert.ok(image.alpha(x,y)>200,`${marker.label} lands at ${x},${y}, which is outside the playable area`);
 }
});
