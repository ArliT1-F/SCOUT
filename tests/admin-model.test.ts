import test from 'node:test';
import assert from 'node:assert/strict';
import {csvDocument,invitationState,matchesSearch} from '../src/admin-model';

test('owner search matches all terms across fields, case-insensitively',()=>{
 assert.equal(matchesSearch('  ADA  esports ', 'Ada Lovelace','ada@example.test','Esports club'),true);
 assert.equal(matchesSearch('ada missing','Ada','Esports'),false);
 assert.equal(matchesSearch('',undefined,null),true);
});
test('CSV quotes commas, newlines and quotes; spreadsheet formulas are inert',()=>{
 const csv=csvDocument(['Name','Notes'],[['Ada, "A"','line 1\nline 2'],['=HYPERLINK("bad")',' +SUM(A1)'],['@danger','-12'],['\tformula','safe']]);
 assert.ok(csv.startsWith('\uFEFF"Name","Notes"\r\n'));
 assert.ok(csv.includes('"Ada, ""A""","line 1\nline 2"'));
 for(const literal of ['\'=HYPERLINK','\' +SUM','\'@danger',"'-12","'\tformula"])assert.ok(csv.includes(literal));
});
test('invitation states distinguish review, activation, expiry and retry delivery',()=>{
 assert.equal(invitationState({status:'pending'}),'Awaiting review');
 assert.equal(invitationState({status:'rejected'}),'Not invited');
 assert.equal(invitationState({status:'approved'},{status:'sent',expiresAt:100},101),'Expired');
 assert.equal(invitationState({status:'approved'},{status:'sent',expiresAt:100},99),'Invitation sent');
 assert.equal(invitationState({status:'approved'},{status:'pending'}),'Email queued');
 assert.equal(invitationState({status:'approved'},{status:'pending',errorCode:'provider-error'}),'Retry queued');
 assert.equal(invitationState({status:'approved'},{status:'sent',activated:true,expiresAt:100},101),'Activated');
 assert.equal(invitationState({status:'approved'}),'Not activated');
});
