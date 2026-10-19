import React, { useEffect, useState } from 'react';

// Friendly first-run launcher at / — the GUI non-tech users see.
// Keeps the full operator panel at /admin for power users.
export function LauncherHome() {
  const hostUrl = location.origin;
  const [hostOk, setHostOk] = useState<boolean | null>(null);
  const [gsi, setGsi] = useState<any>(null);
  const [licence, setLicence] = useState<any>(null);
  const [link, setLink] = useState<any>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    async function tick() {
      try {
        const h = await fetch(hostUrl + '/healthz', { cache: 'no-store' }).then(r => r.json());
        if (!stop) setHostOk(!!h.ok);
        const st = await fetch(hostUrl + '/api/status').then(r => r.ok ? r.json() : null).catch(() => null);
        if (!stop && st) setGsi(st.gsi || null);
        const lic = await fetch(hostUrl + '/api/beta/license').then(r => r.ok ? r.json() : null).catch(() => null);
        if (!stop) setLicence(lic);
        const lk = await fetch(hostUrl + '/api/beta/link').then(r => r.ok ? r.json() : null).catch(() => null);
        if (!stop) setLink(lk?.link || lk);
      } catch {}
    }
    tick();
    const t = setInterval(tick, 3000);
    return () => { stop = true; clearInterval(t); };
  }, [hostUrl]);

  const receiving = !!(gsi?.accepted && gsi?.lastPacketAt && Date.now() - gsi.lastPacketAt < 5000);
  const licenceState = licence?.state || 'unknown';
  const licenceEnforced = !!licence?.enforced;
  const pill = (text: string, cls: string) => <span className={`pill ${cls}`}>{text}</span>;

  async function copy(text: string, key: string) {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(null), 1200); } catch {}
  }
  async function startLink() {
    try { await fetch(hostUrl + '/api/beta/link/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: navigator.platform }) }); } catch {}
  }

  return (
    <div className="launcher-home">
      <style>{`
        .launcher-home{min-height:100vh;background:#0b0a0d;color:#f3eef8;font:14px/1.5 system-ui,Segoe UI,sans-serif}
        .launcher-home header{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:14px;padding:14px 18px;border-bottom:1px solid #2a2632;background:#0f0e12}
        .launcher-home .pill{padding:5px 10px;border-radius:20px;border:1px solid #2a2632;font-size:11px;font-weight:700;letter-spacing:.04em}
        .launcher-home .pill.ok{color:#052e1c;background:#0e2a1f;border-color:#1b4a33} .pill.warn{color:#3a2400;background:#2f2110;border-color:#5a3a11} .pill.bad{color:#3b0a14;background:#2a0f18;border-color:#5a1a2a} .pill.live{color:#fff;background:#d970c2;border-color:#d970c2}
        .lh-body{padding:18px;max-width:1100px;margin:0 auto;display:grid;grid-template-columns:1fr 360px;gap:16px;background:radial-gradient(1200px 600px at 20% -10%, #20172a 0%, transparent 60%)}
        .lh-card{background:#17141c;border:1px solid #2a2632;border-radius:14px;padding:16px}
        .lh-card h2{margin:0 0 6px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#f0a9e2}
        .lh-hero{grid-column:1/-1;background:linear-gradient(135deg,#1c1228,#2a1838);border:1px solid #3a2852}
        .lh-hero p{color:#c9b8dc;font-size:13px;margin:6px 0 0}
        .lh-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:12px}
        .lh-step{background:#1e1b24;border:1px solid #2a2632;border-radius:10px;padding:12px;display:flex;gap:10px;align-items:center}
        .lh-step b{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:#2a2632;font-size:12px}
        .lh-step.done b{background:#3dd68c;color:#052e1c}
        .lh-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}
        .lh-btn{appearance:none;border:1px solid #2a2632;background:#1e1b24;color:#f3eef8;border-radius:10px;padding:14px;text-align:left;cursor:pointer;display:flex;gap:12px;align-items:center}
        .lh-btn.primary{background:linear-gradient(135deg,#d970c2,#9b4fc0);border-color:transparent;color:#fff}
        .lh-btn i{width:36px;height:36px;border-radius:8px;display:grid;place-items:center;background:rgba(255,255,255,.08)}
        .lh-kv{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #1a1920;font-size:12px}
        .lh-code{font:700 18px/1 monospace;letter-spacing:.1em;background:#0f0e12;border:1px dashed #3d3560;border-radius:8px;padding:10px;text-align:center;margin:8px 0}
        @media(max-width:860px){.lh-body{grid-template-columns:1fr} .lh-steps{grid-template-columns:1fr} .lh-actions{grid-template-columns:1fr}}
      `}</style>

      <header>
        <img src="/logo/scout-mark.svg" alt="SCOUT" width={36} height={36} style={{ flex: '0 0 auto' }} />
        <div>
          <div style={{ fontWeight: 800, letterSpacing: '.02em' }}>scout<span style={{ color: '#f0a9e2' }}>®</span> — Launcher</div>
          <div style={{ color: '#9a8eac', fontSize: 12 }}>No console. No port to remember. Just press Start.</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {hostOk === null ? pill('HOST …', '') : hostOk ? pill('HOST ONLINE', 'ok') : pill('HOST OFFLINE', 'bad')}
          {receiving ? pill('CS2 LIVE', 'live') : pill('CS2 WAITING', 'warn')}
          {licence ? pill((licenceState || '…').toUpperCase() + (licenceEnforced ? ' · enforced' : ''), licenceState === 'active' ? 'ok' : licenceState === 'revoked' ? 'bad' : 'warn') : pill('ACCOUNT …', '')}
        </div>
      </header>

      <div className="lh-body">
        <div className="lh-card lh-hero" style={{ gridColumn: '1 / -1' }}>
          <h2 style={{ color: '#fff', fontSize: 15, textTransform: 'none', letterSpacing: 0 }}>Welcome, operator 👋</h2>
          <p>Install finishes → click <b>Start SCOUT</b> on your desktop (F8 overlay, F9 panel). The transparent <code>/obs</code> overlay keeps working even when this window is closed. For the full broadcast desk, open <b>Advanced</b>.</p>
          <div className="lh-steps">
            <div className={`lh-step ${licence?.state === 'active' ? 'done' : ''}`}><b>1</b><div><div style={{ fontWeight: 700, fontSize: 12 }}>{licence?.state === 'active' ? '✓ Account linked' : 'Link account'}</div><div style={{ color: '#9a8eac', fontSize: 11 }}>{licence?.state === 'active' ? licence?.email : licence?.state === 'pending' ? 'Approve in dashboard' : 'Whitelisted only'}</div></div></div>
            <div className={`lh-step ${hostOk ? 'done' : ''}`}><b>2</b><div><div style={{ fontWeight: 700, fontSize: 12 }}>Host running</div><div style={{ color: '#9a8eac', fontSize: 11 }}>{hostOk ? 'Online' : 'Starting…'}</div></div></div>
            <div className={`lh-step ${receiving ? 'done' : ''}`}><b>3</b><div><div style={{ fontWeight: 700, fontSize: 12 }}>CS2 feed</div><div style={{ color: '#9a8eac', fontSize: 11 }}>{receiving ? 'Receiving' : 'Waiting for /gsi push'}</div></div></div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="lh-card">
            <h2>What do you want to do?</h2>
            <div className="lh-actions">
              <a className="lh-btn primary" href="/admin" style={{ textDecoration: 'none' }}><i>◧</i><div><b>Open Control Panel</b><div style={{ color: '#fff', opacity: .85, fontSize: 11 }}>Teams, maps, scenes, preview</div></div></a>
              <a className="lh-btn" href="/obs?checker=1" target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}><i>◎</i><div><b>Test overlay</b><div style={{ color: '#9a8eac', fontSize: 11 }}>Checker proves transparency</div></div></a>
              <button className="lh-btn" onClick={() => copy(hostUrl + '/obs', 'obs')}><i>⧉</i><div><b>{copied === 'obs' ? 'Copied!' : 'Copy OBS URL'}</b><div style={{ color: '#9a8eac', fontSize: 11 }}>1920×1080 Browser Source</div></div></button>
              <a className="lh-btn" href="/admin" style={{ textDecoration: 'none' }}><i>⚙</i><div><b>Setup guide</b><div style={{ color: '#9a8eac', fontSize: 11 }}>CS2 cfg + OBS steps</div></div></a>
            </div>
            <p style={{ color: '#9a8eac', fontSize: 11, margin: '10px 0 0' }}>Shortcuts: <b>F9</b> panel · <b>F8</b> overlay · <b>Ctrl+Shift+F8</b> quit</p>
          </div>

          <div className="lh-card">
            <h2>Need help? (3 steps)</h2>
            <ol style={{ margin: '6px 0 0 18px', padding: 0, fontSize: 12, color: '#c9b8dc' }}>
              <li>CS2 → <b>Fullscreen Windowed</b>, join as Observer/GOTV.</li>
              <li>OBS → Game Capture (cs2.exe) + Browser Source <code>{hostUrl}/obs</code> 1920×1080.</li>
              <li>Press <b>F8</b> over CS2 — overlay appears.</li>
            </ol>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="lh-card">
            <h2>🔒 Whitelisted access</h2>
            <p style={{ color: '#9a8eac', fontSize: 12, margin: '6px 0' }}>{licence?.message || 'Checking your SCOUT account…'}</p>
            {licence?.state === 'active' ? (
              <div style={{ background: '#0f0e12', border: '1px solid #1b4a33', borderRadius: 10, padding: 12 }}>
                <div style={{ fontWeight: 700 }}>✓ Linked to {licence.email}</div>
                <div style={{ color: '#9a8eac', fontSize: 11, marginTop: 4 }}>Works offline for 7 days after last check. Revoking in the dashboard hides the overlay within ~15 min when enforcement is on.</div>
              </div>
            ) : (
              <div>
                <div className="lh-code">{link?.pending?.userCode || '—'}</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="lh-btn" style={{ flex: 1, justifyContent: 'center' }} onClick={startLink}>Start link</button>
                  <button className="lh-btn primary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => copy(link?.pending?.userCode || '', 'code')}>{copied === 'code' ? 'Copied!' : 'Copy code'}</button>
                </div>
                <div style={{ color: '#9a8eac', fontSize: 11, marginTop: 8 }}>Approve at <b>{hostUrl}/dashboard?link=CODE</b>. Public downloads are safe to share — unlinked copies stay gated{licenceEnforced ? ' and hidden' : ' with a warning'}.</div>
              </div>
            )}
          </div>

          <div className="lh-card">
            <h2>Live status</h2>
            <div className="lh-kv"><span style={{ color: '#9a8eac' }}>Host</span><b>{hostOk ? 'Online' : 'Offline'}</b></div>
            <div className="lh-kv"><span style={{ color: '#9a8eac' }}>Panel</span><b><a href="/admin">{hostUrl}/admin</a></b></div>
            <div className="lh-kv"><span style={{ color: '#9a8eac' }}>OBS</span><b><a href="/obs" target="_blank" rel="noreferrer">{hostUrl}/obs</a></b></div>
            <div className="lh-kv"><span style={{ color: '#9a8eac' }}>CS2</span><b>{receiving ? 'Receiving' : 'Waiting'}</b></div>
            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
              <a className="lh-btn" href="/admin" style={{ flex: 1, justifyContent: 'center', textDecoration: 'none' }}>Advanced →</a>
            </div>
          </div>
        </div>
      </div>

      <footer style={{ padding: '10px 18px', borderTop: '1px solid #2a2632', display: 'flex', justifyContent: 'space-between', color: '#9a8eac', fontSize: 11 }}>
        <span>GSI only · No injection · External overlay</span>
        <span><a href="/admin" style={{ color: '#f0a9e2' }}>Advanced</a> · v0.1.0</span>
      </footer>
    </div>
  );
}
