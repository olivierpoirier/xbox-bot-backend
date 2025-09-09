'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ClipboardEvent, DragEvent, KeyboardEvent } from 'react';

type Control = { paused?: boolean; volume?: number; skipSeq?: number };
type Now = { url?: string; title?: string; addedBy?: string; startedAt?: unknown };
type QueueItem = {
  id: string;
  url: string;
  addedBy?: string;
  status: 'queued' | 'playing' | 'done' | 'error';
  createdAt?: unknown;
};
type QueueResponse = { ok: boolean; now: Now | null; queue: QueueItem[]; control: Control | null };

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '';

/** Util: extrait la première URL plausible d’un bloc de texte, sinon renvoie le premier mot trim */
const pickUrlLike = (raw: string): string => {
  const t = (raw || '').trim();
  const m = t.match(/https?:\/\/[^\s<>"']+/i);
  if (m) return m[0];
  const first = t.split(/\s+/)[0] ?? '';
  if (/^(www\.|youtube\.com|youtu\.be|soundcloud\.com|open\.spotify\.com)\//i.test(first)) {
    return `https://${first}`;
  }
  return first;
};

export default function Home() {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [adminPass, setAdminPass] = useState('');
  const [state, setState] = useState<QueueResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string>('');

  // Persistance locale
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

  // Rafraîchissement
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

  // Aides
  const volume = state?.control?.volume ?? 80;
  const paused = state?.control?.paused ?? false;

  // Coller programmatique
  const pasteInto = useCallback(async (setter: (s: string) => void, transform?: (s: string) => string) => {
    try {
      const text = await navigator.clipboard.readText();
      let v = text ?? '';
      if (transform) v = transform(v);
      setter(v);
      setToast('Collé depuis le presse-papier ✅');
    } catch {
      setToast('Impossible de lire le presse-papier. Autorise l’accès ou colle manuellement.');
    }
  }, []);

  // Drag & drop d’URL
  const onDropUrl = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const data = e.dataTransfer.getData('text') || '';
    if (data) setUrl(pickUrlLike(data));
  }, []);
  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  // Actions
  const addToQueue = useCallback(async () => {
    const u = pickUrlLike(url);
    if (!/^https?:\/\//i.test(u)) { setToast('URL invalide'); return; }
    setBusy('play');
    try {
      const r = await fetch(`${API_BASE}/api/play`, {
        method: 'POST', headers, body: JSON.stringify({ url: u, addedBy: name || 'anon' }),
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
        method: 'POST', headers, body: JSON.stringify(arg === undefined ? { cmd } : { cmd, arg }),
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

  // Raccourcis & collage natif
  const onEnterAdd = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') addToQueue();
  }, [addToQueue]);

  const handlePasteUrl = useCallback((e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData?.getData('text') || '';
    if (text) {
      e.preventDefault();
      setUrl(pickUrlLike(text));
    }
  }, []);
  const handlePasteText = useCallback(
    (setter: (s: string) => void) => (e: ClipboardEvent<HTMLInputElement>) => {
      const text = e.clipboardData?.getData('text') || '';
      if (text) {
        e.preventDefault();
        setter(text.trim());
      }
    },
    []
  );

  return (
    <main style={sx.page} className="xmb" onDrop={onDropUrl} onDragOver={onDragOver}>
      <style>{responsiveCss}</style>

      <div style={sx.header}>
        <h1 style={sx.title}>🎮 Xbox Music Bot</h1>
        <p style={sx.subtitle}>Colle un lien YouTube/MP3/radio. Lecture locale (Voicemeeter → Xbox).</p>
      </div>

      <div className="xmb-form" style={sx.formRow}>
        <div style={{ display: 'grid', gap: 8 }}>
          <input
            style={sx.input}
            className="xmb-input"
            placeholder="https://youtube.com/watch?v=..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={onEnterAdd}
            onPaste={handlePasteUrl}
            inputMode="url"
            aria-label="URL à jouer"
            autoCorrect="off"
            autoCapitalize="none"
          />
          <button
            type="button"
            style={{ ...sx.btn, ...sx.btnSmall }}
            onClick={() => pasteInto(setUrl, pickUrlLike)}
            aria-label="Coller une URL"
          >
            📋 Coller l’URL
          </button>
        </div>

        <div style={{ display: 'grid', gap: 8 }}>
          <input
            style={sx.input}
            className="xmb-input"
            placeholder="Ton pseudo (optionnel)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onPaste={handlePasteText(setName)}
            aria-label="Ton pseudo"
            autoCapitalize="words"
          />
          <button
            type="button"
            style={{ ...sx.btn, ...sx.btnSmall }}
            onClick={() => pasteInto(setName)}
            aria-label="Coller le pseudo"
          >
            📋 Coller le pseudo
          </button>
        </div>

        <div style={{ display: 'grid', gap: 8 }}>
          <input
            style={sx.input}
            className="xmb-input"
            placeholder="Mot de passe admin (si requis)"
            type="password"
            value={adminPass}
            onChange={(e) => setAdminPass(e.target.value)}
            onPaste={handlePasteText(setAdminPass)}
            aria-label="Mot de passe administrateur"
            autoComplete="current-password"
          />
          <button
            type="button"
            style={{ ...sx.btn, ...sx.btnSmall }}
            onClick={() => pasteInto(setAdminPass)}
            aria-label="Coller le mot de passe admin"
          >
            📋 Coller le mot de passe
          </button>
        </div>

        <button
          className="xmb-btn-add"
          style={{ ...sx.btn, ...(busy ? sx.btnDisabled : sx.btnPrimary) }}
          disabled={!!busy}
          onClick={addToQueue}
          aria-label="Ajouter à la file"
        >
          {busy === 'play' ? 'Ajout…' : 'Ajouter'}
        </button>
      </div>

      <div className="xmb-grid" style={sx.grid}>
        <section style={sx.card}>
          <h2 style={sx.h2}>Lecture en cours</h2>
          {state?.now?.url ? (
            <div style={sx.nowBox}>
              <div style={sx.nowTitle}>
                <a
                  href={state.now.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: '#93c5fd', textDecoration: 'none', wordBreak: 'break-word' }}
                >
                  {state.now.title || state.now.url}
                </a>
              </div>
              {state.now.addedBy ? <div style={sx.mutedSmall}>par {state.now.addedBy}</div> : null}
              <div style={sx.mutedSmall}>
                Volume : <b>{volume}%</b>
              </div>
              {paused && <div style={sx.badgePaused}>⏸ En pause</div>}
            </div>
          ) : (
            <div style={sx.muted}>Aucune piste en cours.</div>
          )}
          <div style={{ height: 12 }} />
          <div style={sx.row} className="xmb-controls-row">
            <button
              className="xmb-ctrl"
              style={{ ...sx.btn }}
              disabled={!!busy}
              onClick={() => sendCommand(paused ? 'resume' : 'pause')}
              title={paused ? 'Reprendre' : 'Mettre en pause'}
              aria-label={paused ? 'Reprendre' : 'Mettre en pause'}
            >
              {busy === 'pause' || busy === 'resume' ? '…' : paused ? '▶ Reprendre' : '⏸ Pause'}
            </button>
            <button
              className="xmb-ctrl"
              style={{ ...sx.btn }}
              disabled={!!busy}
              onClick={() => sendCommand('skip')}
              title="Passer à la suivante"
              aria-label="Passer à la suivante"
            >
              {busy === 'skip' ? '…' : '⏭ Skip'}
            </button>
            <button
              className="xmb-ctrl"
              style={{ ...sx.btn, ...sx.btnDanger }}
              disabled={!!busy}
              onClick={clearQueue}
              title="Vider la file"
              aria-label="Vider la file"
            >
              {busy === 'clear' ? '…' : '🗑 Vider'}
            </button>
          </div>

          <div style={{ marginTop: 16 }}>
            <label style={sx.label}>
              Volume : <b>{volume}%</b>
            </label>
            <input
              type="range"
              min={0}
              max={100}
              value={volume}
              onChange={(e) => onVolume(parseInt(e.target.value, 10))}
              style={sx.slider}
              className="xmb-slider"
              aria-label="Régler le volume"
            />
          </div>
        </section>

        <section style={sx.card}>
          <h2 style={sx.h2}>File d’attente</h2>
          {state?.queue?.length ? (
            <div style={{ display: 'grid', gap: 8 }}>
              {state.queue.map((it, i) => (
                <div key={it.id} style={sx.queueItem}>
                  <div style={sx.queueTitle}>
                    <span style={sx.idx}>{i + 1}.</span>{' '}
                    <a
                      href={it.url}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: '#c7d2fe', textDecoration: 'none', wordBreak: 'break-word' }}
                    >
                      {it.url}
                    </a>
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

      {/* Barre rapide mobile */}
      <div className="xmb-sticky-controls">
        <button
          disabled={!!busy}
          onClick={() => sendCommand(paused ? 'resume' : 'pause')}
          className="xmb-sticky-btn"
          aria-label={paused ? 'Reprendre' : 'Mettre en pause'}
        >
          {paused ? '▶' : '⏸'}
        </button>
        <button disabled={!!busy} onClick={() => sendCommand('skip')} className="xmb-sticky-btn" aria-label="Suivante">
          ⏭
        </button>
        <button
          disabled={!!busy}
          onClick={clearQueue}
          className="xmb-sticky-btn xmb-sticky-danger"
          aria-label="Vider la file"
        >
          🗑
        </button>
      </div>

      {toast ? (
        <div style={sx.toast} onAnimationEnd={() => setToast('')}>
          {toast}
        </div>
      ) : null}

      <footer style={sx.footer}>
        <span style={sx.mutedSmall}>
          Astuce : rends <code>/api/play</code> public en retournant <code>true</code> dans <code>checkAuth</code> de cette route.
        </span>
      </footer>
    </main>
  );
}

/* ---------- Typage strict des styles ---------- */
type StyleMap = {
  page: CSSProperties;
  header: CSSProperties;
  title: CSSProperties;
  subtitle: CSSProperties;

  formRow: CSSProperties;
  input: CSSProperties;

  grid: CSSProperties;
  card: CSSProperties;
  h2: CSSProperties;

  row: CSSProperties;
  label: CSSProperties;

  btn: CSSProperties;
  btnSmall: CSSProperties;
  btnPrimary: CSSProperties;
  btnDanger: CSSProperties;
  btnDisabled: CSSProperties;

  nowBox: CSSProperties;
  nowTitle: CSSProperties;
  badgePaused: CSSProperties;

  queueItem: CSSProperties;
  queueTitle: CSSProperties;
  idx: CSSProperties;
  muted: CSSProperties;
  mutedSmall: CSSProperties;

  slider: CSSProperties;

  toast: CSSProperties;
  footer: CSSProperties;
};

const sx: StyleMap = {
  page: { maxWidth: 1100, margin: '0 auto', padding: 20, fontFamily: 'ui-sans-serif,system-ui,Segoe UI,Roboto', color: '#e5e7eb', background: '#0b1220' },
  header: { marginBottom: 14 },
  title: { margin: 0, fontSize: 28, lineHeight: 1.2, color: '#e5e7eb' },
  subtitle: { margin: '6px 0 0', color: '#94a3b8' },

  formRow: { display: 'grid', gridTemplateColumns: '2fr 1.2fr 1.2fr auto', gap: 10, marginBottom: 14 },
  input: { border: '1px solid #334155', borderRadius: 12, padding: '12px 14px', background: '#0f172a', color: '#e2e8f0', fontSize: 16, outline: 'none' },

  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 },
  card: { background: '#0b1220', border: '1px solid #1f2937', borderRadius: 14, padding: 16, boxShadow: '0 1px 2px rgba(0,0,0,.3)', color: '#e5e7eb' },
  h2: { margin: 0, marginBottom: 10, fontSize: 18 },

  row: { display: 'flex', gap: 10, alignItems: 'center' },
  label: { color: '#cbd5e1', display: 'block', marginBottom: 6 },

  btn: { background: '#1f2937', border: '1px solid #374151', borderRadius: 12, padding: '12px 16px', cursor: 'pointer', fontWeight: 700, color: '#e5e7eb' },
  btnSmall: { padding: '8px 10px', fontSize: 14 },
  btnPrimary: { background: '#2563eb', border: '1px solid #1e40af', color: 'white' },
  btnDanger: { background: '#ef4444', border: '1px solid #991b1b', color: 'white' },
  btnDisabled: { opacity: 0.6, cursor: 'not-allowed' },

  nowBox: { padding: 12, border: '1px solid #334155', borderRadius: 12, background: '#0f172a' },
  nowTitle: { fontWeight: 700, marginBottom: 4, lineHeight: 1.25 },
  badgePaused: { display: 'inline-block', marginTop: 6, padding: '3px 8px', background: '#7c3aed', color: 'white', borderRadius: 999 },

  queueItem: { background: '#0f172a', border: '1px solid #334155', borderRadius: 12, padding: 10 },
  queueTitle: { fontWeight: 600, wordBreak: 'break-word' },
  idx: { color: '#94a3b8', marginRight: 6 },
  muted: { color: '#94a3b8' },
  mutedSmall: { color: '#94a3b8', fontSize: 12 },

  slider: { width: '100%', height: 36 },

  toast: {
    position: 'fixed', left: '50%', bottom: 18, transform: 'translateX(-50%)',
    background: '#10b981', color: '#052e1b', border: '1px solid #065f46',
    padding: '10px 14px', borderRadius: 12, boxShadow: '0 8px 30px rgba(0,0,0,.25)', animation: 'fadeOut 2.8s forwards', zIndex: 50
  },
  footer: { textAlign: 'center', marginTop: 16 }
};

const responsiveCss = `
/* Base */
.xmb .xmb-input { width: 100%; }
.xmb .xmb-grid { grid-template-columns: 1fr 1fr; }
.xmb .xmb-form { grid-template-columns: 2fr 1.2fr 1.2fr auto; }
.xmb .xmb-btn-add { width: auto; }
.xmb .xmb-sticky-controls { display: none; }

/* Slider: plus confortable au doigt */
.xmb .xmb-slider {
  -webkit-appearance: none; appearance: none; height: 6px; background: #334155; border-radius: 999px;
}
.xmb .xmb-slider::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none; width: 22px; height: 22px; border-radius: 50%;
  background: #2563eb; border: 2px solid #1e40af;
}
.xmb .xmb-slider::-moz-range-thumb {
  width: 22px; height: 22px; border-radius: 50%; background: #2563eb; border: 2px solid #1e40af;
}

/* ≤ 720px */
@media (max-width: 720px) {
  .xmb { padding-bottom: 64px; }

  .xmb .xmb-grid { grid-template-columns: 1fr; gap: 12px; }

  .xmb .xmb-form {
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .xmb .xmb-btn-add {
    grid-column: 1 / -1;
    width: 100%;
    padding: 14px 16px;
    font-size: 16px;
  }

  .xmb .xmb-controls-row { gap: 8px; }
  .xmb .xmb-ctrl { flex: 1 1 auto; padding: 12px 10px; }

  .xmb .xmb-sticky-controls {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
    position: fixed; left: 0; right: 0; bottom: 0;
    padding: 8px 12px;
    background: rgba(11, 18, 32, 0.95);
    border-top: 1px solid #1f2937;
    backdrop-filter: blur(6px);
    z-index: 40;
  }
  .xmb .xmb-sticky-btn {
    font-weight: 800; font-size: 18px; padding: 12px 0;
    border-radius: 12px; border: 1px solid #374151;
    background: #1f2937; color: #e5e7eb;
  }
  .xmb .xmb-sticky-btn:disabled { opacity: 0.6; }
  .xmb .xmb-sticky-danger { background: #ef4444; border-color: #991b1b; color: white; }
}

/* ≤ 520px */
@media (max-width: 520px) {
  .xmb h1 { font-size: 22px !important; }
  .xmb h2 { font-size: 16px !important; }
  .xmb .xmb-slider { height: 8px; }
}

/* Toast */
@keyframes fadeOut { 0%{opacity:1} 75%{opacity:1} 100%{opacity:0; pointer-events:none} }
`;
