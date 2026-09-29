import {test} from 'node:test';
import assert from 'node:assert/strict';
import {weaponInfo,activeWeapon,utilityOf,teamUtility} from '../src/weapons';
import type {MatchState,PlayerState} from '../server/state';

const player=(weapons:Record<string,any>,state:any={}):PlayerState=>({name:'x',team:'CT',weapons,state} as unknown as PlayerState);
const weapon=(name:string,type:string,state='holstered')=>({name,type,state});

test('weapons are classified from the GSI type, not from their name',()=>{
 assert.deepEqual(weaponInfo('weapon_ak47','Rifle'),{name:'weapon_ak47',kind:'rifle',label:'AK'});
 assert.equal(weaponInfo('weapon_awp','SniperRifle')!.kind,'sniper');
 assert.equal(weaponInfo('weapon_awp','SniperRifle')!.label,'AWP');
 assert.equal(weaponInfo('weapon_mp9','SubmachineGun')!.kind,'smg');
 assert.equal(weaponInfo('weapon_nova','Shotgun')!.kind,'shotgun');
 assert.equal(weaponInfo('weapon_m249','MachineGun')!.kind,'mg');
 assert.equal(weaponInfo('weapon_knife','Knife')!.kind,'knife');
 assert.equal(weaponInfo('weapon_flashbang','Grenade')!.kind,'grenade');
 assert.equal(weaponInfo('weapon_c4','C4')!.label,'C4');
 assert.equal(weaponInfo('weapon_unknown_future_gun','Rifle')!.label,'UNKNOWN FUTURE GUN','an unknown label still reads as words');
 assert.equal(weaponInfo(undefined,'Rifle'),undefined);
 assert.equal(weaponInfo('weapon_hegrenade','')!.kind,'grenade','a missing type is repaired from the name');
});

test('the active weapon is the one the player holds, reloading included',()=>{
 const rifles=player({weapon_0:weapon('weapon_ak47','Rifle'),weapon_1:weapon('weapon_glock','Pistol')});
 assert.equal(activeWeapon(rifles),undefined,'holstered only: nothing is in hand');
 assert.deepEqual(activeWeapon(player({...rifles.weapons,weapon_0:weapon('weapon_ak47','Rifle','active')})),{name:'weapon_ak47',kind:'rifle',label:'AK'});
 assert.equal(activeWeapon(player({weapon_2:weapon('weapon_awp','SniperRifle','reloading')}))!.label,'AWP');
 assert.equal(activeWeapon(undefined),undefined);
});

test('utility counts come from the weapon slots, flashbangs included twice',()=>{
 const utility=utilityOf(player({
  weapon_1:weapon('weapon_hegrenade','Grenade'),weapon_2:weapon('weapon_flashbang','Grenade'),weapon_3:weapon('weapon_flashbang','Grenade'),
  weapon_4:weapon('weapon_smokegrenade','Grenade'),weapon_5:weapon('weapon_incgrenade','Grenade'),weapon_6:weapon('weapon_decoy','Grenade'),weapon_7:weapon('weapon_taser','Taser')
 },{defusekit:true}));
 assert.deepEqual(utility,{he:1,flash:2,smoke:1,fire:1,decoy:1,taser:1,defusekit:true,total:7});
 assert.equal(utilityOf(player({weapon_0:weapon('weapon_ak47','Rifle')})).total,0);
 assert.equal(utilityOf(undefined).defusekit,false);
 assert.equal(utilityOf(player({weapon_0:weapon('weapon_molotov','Grenade')})).fire,1,'molotov and incendiary are the same slot count');
});

test('team utility sums the side and reports whether it carries a kit',()=>{
 const state={allplayers:{
  a:player({weapon_1:weapon('weapon_hegrenade','Grenade'),weapon_2:weapon('weapon_flashbang','Grenade')},{defusekit:true}),
  b:{...player({weapon_2:weapon('weapon_flashbang','Grenade')}),team:'CT'},
  c:{...player({weapon_1:weapon('weapon_hegrenade','Grenade'),weapon_2:weapon('weapon_smokegrenade','Grenade')}),team:'T'}
 }} as unknown as MatchState;
 const ct=teamUtility(state,'CT');
 assert.equal(ct.he,1);
 assert.equal(ct.flash,2);
 assert.equal(ct.total,3);
 assert.equal(ct.defusekit,true);
 const t=teamUtility(state,'T');
 assert.equal(t.total,2);
 assert.equal(t.defusekit,false);
 assert.equal(teamUtility({} as MatchState,'CT').total,0);
});
