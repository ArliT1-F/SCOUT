import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {EQUIPMENT_ICON_STEMS,utilityIconPath,weaponIconFile,weaponIconPath} from '../src/icons';

const iconDirectory=fileURLToPath(new URL('../public/icons/equipment/',import.meta.url));

test('every referenced equipment SVG is bundled with the app',()=>{
 for(const stem of EQUIPMENT_ICON_STEMS) assert.ok(existsSync(join(iconDirectory,`${stem}.svg`)),`${stem}.svg is missing`);
});

test('weapon icons resolve by GSI name, with aliases and class fallbacks',()=>{
 assert.equal(weaponIconPath('weapon_ak47','rifle'),'/icons/equipment/ak47.svg');
 assert.equal(weaponIconPath('weapon_m4a1_silencer','rifle'),'/icons/equipment/m4a1_silencer.svg');
 assert.equal(weaponIconPath('weapon_scar20','sniper'),'/icons/equipment/scar20.svg');
 assert.equal(weaponIconPath('weapon_knife_butterfly','knife'),'/icons/equipment/knife_butterfly.svg');
 assert.equal(weaponIconPath('weapon_knife_bayonet','knife'),'/icons/equipment/bayonet.svg');
 assert.equal(weaponIconPath('weapon_knife_ct','knife'),'/icons/equipment/knife.svg');
 assert.equal(weaponIconPath('weapon_knife_gg','knife'),'/icons/equipment/knifegg.svg');
 assert.equal(weaponIconPath('weapon_future_rifle','rifle'),'/icons/equipment/m4a1.svg');
 assert.equal(weaponIconFile('../not-an-asset.svg','other'),undefined);
 assert.equal(weaponIconPath('weapon_future_item','other'),undefined);
});

test('utility indicators resolve to local Panorama SVGs',()=>{
 assert.equal(utilityIconPath('he'),'/icons/equipment/hegrenade.svg');
 assert.equal(utilityIconPath('flash'),'/icons/equipment/flashbang.svg');
 assert.equal(utilityIconPath('smoke'),'/icons/equipment/smokegrenade.svg');
 assert.equal(utilityIconPath('fire'),'/icons/equipment/molotov.svg');
 assert.equal(utilityIconPath('defusekit'),'/icons/equipment/defuser.svg');
 assert.equal(utilityIconPath('taser'),'/icons/equipment/taser.svg');
});
