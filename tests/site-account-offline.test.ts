import test from 'node:test';
import assert from 'node:assert/strict';

import {accountOfflineText, classifyAccountFailure} from '../src/site';

// On the website deployment the account API is reached through the host's `/api/beta` proxy, so
// "offline" covers two different situations. The banner used to say "The SCOUT host is not
// reachable on this address" for both, which told an applicant on the public website to start a
// launcher that does not exist there. The copy now follows the failure the host names.

test('the host error codes map to the two account failures', () => {
  // The proxy could not dial the account service.
  assert.equal(classifyAccountFailure(502, 'upstream-unreachable'), 'unreachable');
  assert.equal(classifyAccountFailure(503, 'upstream-unreachable'), 'unreachable');
  assert.equal(classifyAccountFailure(502), 'unreachable', 'a bare gateway failure means the same');
  assert.equal(classifyAccountFailure(200), 'network');
  assert.equal(classifyAccountFailure(429, 'throttled'), 'network');
});

test('a down account service asks for a retry, and a missing host for the launcher', () => {
  assert.match(accountOfflineText('unreachable', 'apply'), /not answering right now.*Try again in a few minutes/);
  assert.match(accountOfflineText('unreachable', 'signin'), /not answering right now/);
  assert.match(accountOfflineText('network', 'apply'), /Start the launcher/);
  assert.match(accountOfflineText('network', 'signin'), /Start the launcher/);
});

test('every failure says something different, and every one of them is actionable', () => {
  const failures = ['unreachable', 'network'] as const;
  for (const need of ['apply', 'signin'] as const) {
    const texts = failures.map(failure => accountOfflineText(failure, need));
    assert.equal(new Set(texts).size, texts.length, `${need}: two causes, two messages`);
    for (const text of texts) assert.ok(text.length > 40, `${need}: a banner that explains itself`);
    assert.notEqual(accountOfflineText(failures[0], need), accountOfflineText(failures[0], need === 'apply' ? 'signin' : 'apply'), 'applying and signing in are not the same action');
  }
});
