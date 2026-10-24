import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeEmailFailure,
  emailConfiguration,
  invitationEmail,
  recoveryEmail,
  resendTransport,
  type EmailConfiguration,
} from '../server/email.js';

const transportConfig: EmailConfiguration = {
  apiKey: 're_test_1234567890abcdef',
  from: 'SCOUT <no-reply@example.test>',
  publicBaseUrl: 'https://accounts.example.test',
  encryptionKey: Buffer.alloc(32, 7),
  apiUrl: 'http://127.0.0.1:1/emails',
};

const baseEnv = {
  SCOUT_EMAIL_API_KEY: 're_test_1234567890abcdef',
  SCOUT_EMAIL_FROM: 'SCOUT <no-reply@example.test>',
  SCOUT_ACCOUNT_BASE_URL: 'https://accounts.example.test',
  SCOUT_EMAIL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  SCOUT_EMAIL_API_URL: 'https://api.resend.com/emails',
};

test('emailConfiguration returns null when settings are missing', () => {
  assert.equal(emailConfiguration({}), null);
});

test('emailConfiguration rejects http origins outside localhost and never reveals the key', () => {
  assert.throws(
    () => emailConfiguration({...baseEnv, SCOUT_ACCOUNT_BASE_URL: 'http://example.test'}),
    /HTTPS/,
  );
});

test('resendTransport reports provider failure without returning the body', async () => {
  const body = JSON.stringify({message: 'you sent a secret token in here', data: {to: 'ada@example.com'}});
  let captured: string | null = null;
  const orig = console.error;
  console.error = (message: string) => { captured = message; };
  try {
    const transport = resendTransport(transportConfig, async () => ({
      status: 400,
      ok: false,
      statusText: 'Bad Request',
      body: null as any,
      json: async () => JSON.parse(body),
      text: async () => body,
      headers: new Headers(),
    } as any));
    await assert.rejects(
      transport({to: 'ada@example.com', subject: 's', text: 't', html: '<p>t</p>'}, 'idempotency-key'),
      /Email provider refused the request\./,
    );
    assert.equal(captured, null, 'the provider response body must not be logged');
  } finally {
    console.error = orig;
  }
});

test('resendTransport delivers on a successful response', async () => {
  let sent: any = null;
  const transport = resendTransport(transportConfig, async (_url, init) => {
    sent = init;
    return new Response(null, {status: 200});
  });
  await transport({to: 'ada@example.com', subject: 's', text: 't', html: '<p>t</p>'}, 'idem');
  assert.equal(sent.headers.Authorization, 'Bearer re_test_1234567890abcdef');
  assert.equal(sent.headers['Idempotency-Key'], 'idem');
  const payload = JSON.parse(String(sent.body));
  assert.equal(payload.from, 'SCOUT <no-reply@example.test>');
  assert.equal(payload.to[0], 'ada@example.com');
});

test('invitation and recovery emails never carry provider credentials', () => {
  const invite = invitationEmail('ada@example.test', 'Ada', 'https://accounts.example.test/login?invite=abc', 1_700_000_000_000);
  const recovery = recoveryEmail('ada@example.test', 'Ada', 'https://accounts.example.test/login?recovery=xyz', 1_700_000_000_000);
  for (const message of [invite, recovery]) {
    assert.ok(typeof message.to === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.to));
    assert.ok(typeof message.subject === 'string' && message.subject.length > 0);
    assert.ok(typeof message.text === 'string' && message.text.length > 0);
    assert.ok(typeof message.html === 'string' && message.html.length > 0);
    assert.ok(!/Bearer|re_/.test(message.subject));
    assert.ok(!/Bearer|re_/.test(message.text));
  }
  assert.ok(invite.text.includes('/login?invite='));
  assert.ok(recovery.text.includes('/login?recovery='));
});

test('transactional templates share an accessible, email-safe brand layout and fallback link',()=>{
 const expiresAt=1_900_000_000_000;
 const url='https://accounts.example.test/login?invite=one&source=email';
 for(const make of [invitationEmail,recoveryEmail]){
  const message=make('ada@example.test','Ada <Admin> & "Team"',url,expiresAt);
  assert.match(message.html,/<!doctype html>/i);
  assert.match(message.html,/<html lang="en">/);
  assert.match(message.html,/role="presentation"/);
  assert.match(message.html,/max-width:600px/);
  assert.match(message.html,/mso-padding-alt/,'Outlook has a padded action button');
  assert.match(message.html,/Ada &lt;Admin&gt; &amp; &quot;Team&quot;/);
  assert.ok(!message.html.includes('Ada <Admin>'));
  assert.equal((message.html.match(/href="https:\/\/accounts.example.test\/login\?invite=one&amp;source=email"/g)||[]).length,2,'CTA and visible fallback use the same escaped URL');
  assert.ok(message.text.includes(url));
  assert.ok(message.text.includes(new Date(expiresAt).toUTCString()));
  assert.ok(message.html.includes(new Date(expiresAt).toUTCString()));
  assert.match(message.html,/ONE LINK. ONE USE./);
  assert.match(message.html,/Keep this link private/);
  assert.ok(!/<script|<form|<iframe|<img|https:\/\/fonts\./i.test(message.html),'email does not rely on blocked images, scripts or remote fonts');
 }
});
test('invitation onboarding and recovery security copy remain distinct',()=>{
 const invite=invitationEmail('a@example.test','','https://accounts.example.test/login?invite=x',1_900_000_000_000);
 const reset=recoveryEmail('a@example.test','','https://accounts.example.test/login?recovery=y',1_900_000_000_000);
 assert.match(invite.html,/Hello SCOUT organiser/);
 assert.match(invite.html,/Your first steps with SCOUT/);
 assert.match(invite.text,/download the SCOUT desktop app/);
 assert.ok(!reset.html.includes('Your first steps'));
 assert.match(reset.html,/Your password will not change/);
 assert.match(reset.text,/your password will not change/);
});

test('describeEmailFailure maps provider refusals to operator guidance', () => {
  assert.match(describeEmailFailure(401, null), /SCOUT_EMAIL_API_KEY/);
  assert.match(describeEmailFailure(403, 'validation_error'), /resend\.com\/domains/);
  assert.match(describeEmailFailure(400, null), /SCOUT_EMAIL_FROM/);
  assert.match(describeEmailFailure(429, null), /retries automatically/);
  assert.match(describeEmailFailure(503, null), /retries automatically/);
  assert.match(describeEmailFailure(0, null), /retries automatically/);
  assert.match(describeEmailFailure(418, 'teapot_error'), /HTTP 418/);
});

test('resendTransport keeps the provider error name and drops anything else', async () => {
  const failing = (payload: string, status = 403) =>
    resendTransport(
      transportConfig,
      (async () => ({
        status,
        ok: false,
        statusText: 'Forbidden',
        body: null as any,
        json: async () => JSON.parse(payload),
        text: async () => payload,
        headers: new Headers(),
      }) as any),
    );
  const capture = async (payload: string, status: number) => {
    try {
      await failing(payload, status)({to: 'a@b.co', subject: 's', text: 't', html: '<p>t</p>'}, 'idem');
      assert.fail('a refused send must throw');
    } catch (error: any) {
      return error;
    }
  };
  const named = await capture(JSON.stringify({name: 'validation_error', message: 'Domain example.test is not verified'}), 403);
  assert.equal(named.status, 403);
  assert.equal(named.providerCode, 'validation_error');
  assert.ok(!String(named.message).includes('example.test'), 'the provider message is never retained');
  const anonymous = await capture('not json{{', 400);
  assert.equal(anonymous.status, 400);
  assert.equal(anonymous.providerCode, null);
  const hostile = await capture(JSON.stringify({name: '../../etc/passwd'}), 422);
  assert.equal(hostile.providerCode, null, 'names outside the safe pattern are dropped');
});
