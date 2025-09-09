'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type Control = { paused?: boolean; volume?: number; skipSeq?: number };
type Now = { url?: string; title?: string; addedBy?: string; startedAt?: unknown };
type QueueItem = {
  id: string;
  url: string;
  addedBy?: string;
  status: 'queued' | 'playing' | 'done' | 'error';
  createdAt?: unknown;
};

type QueueResponse = {
  ok: boolean;
  now: Now | null;
  queue: QueueItem[];
  control: Control | null;
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '';

export default function Home() {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [adminPass, setAdminPass] = useState('');
  const [state, setState] = useState<QueueResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // 'play' | 'pause' | 'resume' | 'skip' | 'clear' | 'volume'
  const [toast, setToast] = useState<string>('');

  // load persisted fields
  useEffect(() => {
    try {
      const n = localStorage.getItem('xmb_name'); if (n) setName(n);
      const p = localStorage.getItem('xmb_admin_pass'); if (p) setAdminPass(p);
    } catch {}
  }, []);
  useEffect(() => { try { localStorage.setItem('xmb_name', name || ''); } catch {} }, [name]);
  useEffect(() => { try { localStorage.setItem('xmb_admin_pass', adminPass || ''); } catch {} }, [adminPass]);

  const headers = useMemo(() => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPass) h['x-admin-pass'] = adminPass;
    return h;
  }, [adminPass]);

  // refresh loop
  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/queue`, { cache: 'no-store' });
      const data = (await r.json()) as QueueResponse;
      setState(data);
    } catch {
      setToast('Erreur de rafraîchissement');
    }
  }, []);
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  // helpers
  const volume = state?.control?.volume ?? 80;
  const paused = state?.control?.paused ?? false;

  // actions
  const addToQueue = useCallback(async () => {
    if (!/^https?:\/\//i.test(url.trim())) { setToast('URL invalide'); return; }
    setBusy('play');
    try {
      const r = await fetch(`${API_BASE}/api/play`, {
        method: 'POST', headers, body: JSON.stringify({ url: url.trim(), addedBy: name || 'anon' }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) setToast(data?.error || 'Échec de l’ajout');
      else { setToast('Ajouté à la file ✅'); setUrl(''); refresh(); }
    } catch { setToast('Erreur réseau'); }
    finally { setBusy(null); }
  }, [url, name, headers, refresh]);

  const sendCommand = useCallback(async (cmd: 'pause' | 'resume' | 'skip' | 'volume', arg?: number) => {
    setBusy(cmd);
    setToast('');
    try {
      const r = await fetch(`${API_BASE}/api/command`, {
        method: 'POST', headers,
        body: JSON.stringify(arg === undefined ? { cmd } : { cmd, arg }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) setToast(data?.error || `Commande "${cmd}" refusée`);
      else refresh();
    } catch { setToast('Erreur réseau'); }
    finally { setBusy(null); }
  }, [headers, refresh]);

  const clearQueue = useCallback(async () => {
    setBusy('clear');
    try {
      const r = await fetch(`${API_BASE}/api/clear`, { method: 'POST', headers });
      const data = await r.json();
      if (!r.ok || !data.ok) setToast(data?.error || 'Échec du vidage');
      else { setToast(`File vidée (${data.cleared})`); refresh(); }
    } catch { setToast('Erreur réseau'); }
    finally { setBusy(null); }
  }, [headers, refresh]);

  const onVolume = useCallback((v: number) => { sendCommand('volume', v); }, [sendCommand]);

  return (
    <main style={sx.page}>
      <div style={sx.header}>
        <h1 style={sx.title}>🎮 Xbox Music Bot</h1>
        <p style={sx.subtitle}>Ajoute des liens (YouTube, MP3, radio…). Le bot joue sur ton PC (Voicemeeter → Xbox).</p>
      </div>

      <div style={sx.formRow}>
        <input
          style={sx.input}
          placeholder="https://youtube.com/watch?v=..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <input
          style={sx.input}
          placeholder="Ton pseudo (optionnel)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          style={sx.input}
          placeholder="Mot de passe admin (si requis)"
          type="password"
          value={adminPass}
          onChange={(e) => setAdminPass(e.target.value)}
        />
        <button style={{ ...sx.btn, ...(busy ? sx.btnDisabled : sx.btnPrimary) }} disabled={!!busy} onClick={addToQueue}>
          {busy === 'play' ? 'Ajout…' : 'Ajouter'}
        </button>
      </div>

      <div style={sx.grid}>
        {/* Col gauche : now + controls */}
        <section style={sx.card}>
          <h2 style={sx.h2}>Lecture en cours</h2>
          {state?.now?.url ? (
            <div style={sx.nowBox}>
              <div style={sx.nowTitle}>
                <a href={state.now.url} target="_blank" rel="noreferrer" style={{ color: '#93c5fd', textDecoration: 'none' }}>
                  {state.now.title || state.now.url}
                </a>
              </div>
              {state.now.addedBy ? <div style={sx.mutedSmall}>par {state.now.addedBy}</div> : null}
              <div style={sx.mutedSmall}>Volume : <b>{volume}%</b></div>
              {paused && <div style={sx.badgePaused}>⏸ En pause</div>}
            </div>
          ) : (
            <div style={sx.muted}>Aucune piste en cours.</div>
          )}
          <div style={{ height: 12 }} />
          <div style={sx.row}>
            <button
              style={{ ...sx.btn, ...(busy ? sx.btnDisabled : sx.btn) }}
              disabled={!!busy}
              onClick={() => sendCommand(paused ? 'resume' : 'pause')}
              title={paused ? 'Reprendre' : 'Mettre en pause'}
            >
              {busy === 'pause' || busy === 'resume' ? '…' : paused ? '▶ Reprendre' : '⏸ Pause'}
            </button>
            <button
              style={{ ...sx.btn, ...(busy ? sx.btnDisabled : sx.btn) }}
              disabled={!!busy}
              onClick={() => sendCommand('skip')}
              title="Passer à la suivante"
            >
              {busy === 'skip' ? '…' : '⏭ Skip'}
            </button>
            <button
              style={{ ...sx.btn, ...(busy ? sx.btnDisabled : sx.btnDanger) }}
              disabled={!!busy}
              onClick={clearQueue}
              title="Vider la file"
            >
              {busy === 'clear' ? '…' : '🗑 Vider'}
            </button>
          </div>

          <div style={{ marginTop: 16 }}>
            <label style={sx.label}>Volume : <b>{volume}%</b></label>
            <input
              type="range"
              min={0} max={100}
              value={volume}
              onChange={(e) => onVolume(parseInt(e.target.value, 10))}
              style={sx.slider}
            />
          </div>
        </section>

        {/* Col droite : queue */}
        <section style={sx.card}>
          <h2 style={sx.h2}>File d’attente</h2>
          {state?.queue?.length ? (
            <div style={{ display: 'grid', gap: 8 }}>
              {state.queue.map((it, i) => (
                <div key={it.id} style={sx.queueItem}>
                  <div style={sx.queueTitle}>
                    <span style={sx.idx}>{i + 1}.</span> {it.url}
                  </div>
                  <div style={sx.mutedSmall}>
                    {it.addedBy ? `ajouté par ${it.addedBy}` : 'ajout anonyme'} · <b>{it.status}</b>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={sx.muted}>La file est vide.</div>
          )}
        </section>
      </div>

      {toast ? <div style={sx.toast} onAnimationEnd={() => setToast('')}>{toast}</div> : null}

      <footer style={sx.footer}>
        <span style={sx.mutedSmall}>
          Astuce : rends <code>/api/play</code> public en retournant <code>true</code> dans <code>checkAuth</code> de cette route.
        </span>
      </footer>
    </main>
  );
}

const sx: Record<string, React.CSSProperties> = {
  page: { maxWidth: 1100, margin: '0 auto', padding: 20, fontFamily: 'ui-sans-serif,system-ui,Segoe UI,Roboto', color: '#0f172a' },
  header: { marginBottom: 14 },
  title: { margin: 0, fontSize: 28, lineHeight: 1.2 },
  subtitle: { margin: '6px 0 0', color: '#475569' },

  formRow: { display: 'grid', gridTemplateColumns: '2fr 1.2fr 1.2fr auto', gap: 10, marginBottom: 14 },
  input: { border: '1px solid #cbd5e1', borderRadius: 12, padding: '10px 12px', background: '#0b1220', color: '#e2e8f0' },

  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 },
  card: { background: '#0b1220', border: '1px solid #1f2937', borderRadius: 14, padding: 16, boxShadow: '0 1px 2px rgba(0,0,0,.3)', color: '#e5e7eb' },
  h2: { margin: 0, marginBottom: 10, fontSize: 18 },

  row: { display: 'flex', gap: 10, alignItems: 'center' },
  label: { color: '#cbd5e1', display: 'block', marginBottom: 6 },

  btn: { background: '#1f2937', border: '1px solid #374151', borderRadius: 10, padding: '10px 14px', cursor: 'pointer', fontWeight: 600, color: '#e5e7eb' },
  btnPrimary: { background: '#2563eb', border: '1px solid #1e40af', color: 'white' },
  btnDanger: { background: '#ef4444', border: '1px solid #991b1b', color: 'white' },
  btnDisabled: { opacity: .6, cursor: 'not-allowed' },

  nowBox: { padding: 12, border: '1px solid #334155', borderRadius: 12, background: '#0f172a' },
  nowTitle: { fontWeight: 700, marginBottom: 4 },
  badgePaused: { display: 'inline-block', marginTop: 6, padding: '3px 8px', background: '#7c3aed', color: 'white', borderRadius: 999 },

  queueItem: { background: '#0f172a', border: '1px solid #334155', borderRadius: 12, padding: 10 },
  queueTitle: { fontWeight: 600 },
  idx: { color: '#94a3b8', marginRight: 6 },
  muted: { color: '#94a3b8' },
  mutedSmall: { color: '#94a3b8', fontSize: 12 },

  slider: { width: '100%' },

  toast: {
    position: 'fixed', left: '50%', bottom: 18, transform: 'translateX(-50%)',
    background: '#10b981', color: '#052e1b', border: '1px solid #065f46',
    padding: '10px 14px', borderRadius: 12, boxShadow: '0 8px 30px rgba(0,0,0,.25)',
    animation: 'fadeOut 2.8s forwards'
  },
  footer: { textAlign: 'center', marginTop: 16 }
};
