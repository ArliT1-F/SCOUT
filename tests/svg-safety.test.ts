import {test} from 'node:test';
import assert from 'node:assert/strict';
import {detectImageMime,svgIsInert} from '../server/packs';

// An uploaded SVG is served from the panel's own origin, so it must not be able to run anything when
// opened directly. These pin the content rule shared by /api/upload and event packs.
const svg=(body:string,attributes='')=>Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"${attributes}>${body}</svg>`);

test('plain artwork, internal references and embedded rasters are accepted',()=>{
 assert.equal(detectImageMime(svg('<circle cx="5" cy="5" r="4" fill="#d970c2"/>')),'image/svg+xml');
 assert.equal(detectImageMime(svg('<defs><linearGradient id="g"/></defs><use href="#g"/><rect fill="url(#g)"/>')),'image/svg+xml');
 assert.equal(detectImageMime(svg('<image xlink:href="data:image/png;base64,iVBORw0KGgo="/>')),'image/svg+xml');
 assert.equal(detectImageMime(svg('<image href="logo.png"/>')),'image/svg+xml','a relative reference cannot run anything');
 assert.equal(detectImageMime(svg('<animate attributeName="opacity" values="0;1" dur="1s"/>')),'image/svg+xml','animation itself is fine');
 assert.equal(detectImageMime(Buffer.from('﻿<?xml version="1.0"?>\n<!-- logo -->\n<svg viewBox="0 0 1 1"></svg>')),'image/svg+xml');
});

test('script hidden after the first 4 KB is found',()=>{
 const padded=svg('<!--'+'x'.repeat(5000)+'--><script>alert(1)</script>');
 assert.equal(padded.length>4096,true);
 assert.equal(detectImageMime(padded),undefined);
});

test('everything that can run code or load from elsewhere is refused',()=>{
 const refused:Record<string,string>={
  'script element':'<script>alert(1)</script>',
  'prefixed script':'<svg:script>alert(1)</svg:script>',
  'event handler':'<rect onload="alert(1)"/>',
  'foreignObject':'<foreignObject><div/></foreignObject>',
  'javascript link':'<a href="javascript:alert(1)"><rect/></a>',
  'javascript link split by whitespace':'<a href="java\tscript:alert(1)"><rect/></a>',
  'character-reference link':'<a href="&#106;avascript:alert(1)"><rect/></a>',
  'html data URL':'<a href="data:text/html,&lt;script&gt;"><rect/></a>',
  'svg data URL':'<use href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="/>',
  'external image':'<image href="https://tracker.example/pixel.png"/>',
  'protocol-relative image':'<image xlink:href="//tracker.example/pixel.png"/>',
  'external stylesheet':'<style>@import url("https://example.com/x.css");</style>',
  'animated href':'<a><set attributeName="href" to="javascript:alert(1)"/><rect/></a>',
  'iframe':'<iframe src="/admin"/>',
 };
 for(const [name,body] of Object.entries(refused)) assert.equal(svgIsInert(svg(body).toString()),false,name);
 assert.equal(detectImageMime(Buffer.from('<!DOCTYPE svg [<!ENTITY x "javascript:">]><svg/>')),undefined,'entity declarations');
});

test('raster formats are identified by their bytes, not by a label',()=>{
 assert.equal(detectImageMime(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0])),'image/png');
 assert.equal(detectImageMime(Buffer.from([0xff,0xd8,0xff,0xe0])),'image/jpeg');
 assert.equal(detectImageMime(Buffer.from('<html><script>alert(1)</script></html>')),undefined);
});
