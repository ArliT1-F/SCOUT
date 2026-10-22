import test from 'node:test';
import assert from 'node:assert/strict';

import {accountOfflineText, classifyAccountFailure} from '../src/site';

// On the website deployment the account API is reached through the Worker's `/api/beta` proxy, so
// "offline" covers three different situations. The banner used to say "The SCOUT host is not
// reachable on this address" for all of them, which told an applicant on scout.*.workers.dev to
// start a launcher that does not exist there. The copy now follows the failure the edge names.

test('the edge error codes map to the three account failures', () => {
  // functions/api/beta/[[path]].ts: no SCOUT_ACCOUNT_SERVICE_URL on the Worker.
  assert.equal(classifyAccountFailure(503, 'service-unavailable'), 'not-configured');
  // The proxy could not dial the account service.
  assert.equal(classifyAccountFailure(502, 'upstream-unreachable'), 'unreachable');
  assert.equal(classifyAccountFailure(200), 'network');
  assert.equal(classifyAccountFailure(429, 'throttled'), 'network');
});

test('an unconnected deployment does not blame the visitor’s address', () => {
  for (const need of ['apply', 'signin'] as const) {
    const text = accountOfflineText('not-configured', need);
    assert.match(text, /not connected|not configured/, 'the reason is the deployment, not the visitor');
    assert.equal(/not reachable on this address/.test(text), false, 'no launcher exists on the website');
    assert.equal(/try again in a few minutes/.test(text), false, 'a retry will not fix a missing secret');
  }
});

test('a down account service asks for a retry, and a missing host for the launcher', () => {
  assert.match(accountOfflineText('unreachable', 'apply'), /not answering right now.*Try again in a few minutes/);
  assert.match(accountOfflineText('unreachable', 'signin'), /not answering right now/);
  assert.match(accountOfflineText('network', 'apply'), /Start the launcher/);
  assert.match(accountOfflineText('network', 'signin'), /Start the launcher/);
});

test('every failure says something different, and every one of them is actionable', () => {
  const failures = ['not-configured', 'unreachable', 'network'] as const;
  for (const need of ['apply', 'signin'] as const) {
    const texts = failures.map(failure => accountOfflineText(failure, need));
    assert.equal(new Set(texts).size, texts.length, `${need}: three causes, three messages`);
    for (const text of texts) assert.ok(text.length > 40, `${need}: a banner that explains itself`);
    assert.notEqual(accountOfflineText(failures[0], need), accountOfflineText(failures[0], need === 'apply' ? 'signin' : 'apply'), 'applying and signing in are not the same action');
  }
});
