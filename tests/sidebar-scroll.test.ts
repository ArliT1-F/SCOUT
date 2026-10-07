import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const css=await readFile(fileURLToPath(new URL('../src/style.css',import.meta.url)),'utf8');

test('the fixed operator sidebar has an independent vertical scroller',()=>{
 const sidebar=css.match(/\.sidebar\{([^}]+)\}/)?.[1];
 assert.ok(sidebar,'the sidebar base rule should exist');
 assert.match(sidebar,/position:fixed/,'the sidebar remains anchored beside the main panel');
 assert.match(sidebar,/overflow-y:auto/,'long navigation can be scrolled inside the sidebar');
 assert.match(sidebar,/overscroll-behavior-y:contain/,'scrolling at its edge does not chain into the main panel');
});
