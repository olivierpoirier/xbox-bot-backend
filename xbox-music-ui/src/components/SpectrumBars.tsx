import { useEffect, useMemo, useRef, useState } from "react";

interface Props {
  bars?: number;
  playing: boolean;
  colorFrom?: string;
  colorTo?: string;
}

export default function SpectrumBars({
  bars = 20,
  playing,
  colorFrom = "#22d3ee",
  colorTo = "#f472b6",
}: Props) {
  const [tick, setTick] = useState(0);
  const rafRef = useRef<number | null>(null);

  // --- RAF (mouvement continu; un peu plus lent si pause) ---
  useEffect(() => {
    const loop = () => {
      setTick((n) => (n + 1) % 1_000_000);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, []);

  // --- Dégradé de couleur par barre ---
  const colors = useMemo(() => {
    const list: string[] = [];
    const c1 = hexToRgb(colorFrom);
    const c2 = hexToRgb(colorTo);
    const mix = (a: number, b: number, p: number) => Math.round(a + (b - a) * p);
    for (let i = 0; i < bars; i++) {
      const k = i / Math.max(1, bars - 1);
      const r = mix(c1.r, c2.r, k);
      const g = mix(c1.g, c2.g, k);
      const b_ = mix(c1.b, c2.b, k);
      list.push(`rgb(${r}, ${g}, ${b_})`);
    }
    return list;
  }, [bars, colorFrom, colorTo]);

  // --- Phases/semences par barre pour casser la synchro ---
  const phases = useMemo(() => {
    const TAU = Math.PI * 2;
    const arr: Array<[number, number, number, number]> = [];
    for (let i = 0; i < bars; i++) {
      const rnd = mulberry32(0x9e3779b9 ^ i); // graine stable par barre
      arr.push([rnd() * TAU, rnd() * TAU, rnd() * TAU, rnd()]); // φ1, φ2, φ3, seed extra
    }
    return arr;
  }, [bars]);

  // --- Lissage : on garde les dernières hauteurs ---
  const lastRef = useRef<Float32Array | null>(null);
  if (!lastRef.current || lastRef.current.length !== bars) {
    lastRef.current = new Float32Array(bars).fill(0.1);
  }

  // --- Calcul des hauteurs (anti-saturation + anti-sync) ---
  const heights = useMemo(() => {
    // vitesse de défilement ; un peu plus lente quand en pause
    const t = tick / (playing ? 14 : 24);

    // 1) Première passe : on calcule une valeur “brute” décorrélée par barre
    const prelim = new Array(bars);
    for (let i = 0; i < bars; i++) {
      const [p1, p2, p3, s] = phases[i];

      // Fréquences légèrement différentes pour éviter les battements synchrones
      const w1 = 1.10 + 0.07 * s;
      const w2 = 0.55 + 0.33 * s;
      const w3 = 0.78 + 0.12 * s;

      // Trois sinusoïdes + une ondulation le long de l’axe (effet de vague)
      const v1 = Math.sin(t * w1 + p1);
      const v2 = Math.sin(t * w2 + p2);
      const v3 = Math.sin(t * w3 + p3);
      const lane = Math.sin((t * 0.35) + i * (0.22 + 0.03 * s)); // vague spatiale

      // Base + mix d’ondes (dans ~[0..1])
      let v = 0.34 + 0.23 * v1 + 0.19 * v2 + 0.15 * v3 + 0.07 * lane;
      // Remet dans [0..1]
      v = 0.5 + 0.5 * v;

      // Légère emphase des “basses” (début de barre)
      const bassBias = 1 - i / Math.max(1, bars - 1);
      v = v * (0.86 + 0.18 * bassBias);

      prelim[i] = v;
    }

    // 2) Compression “de bus” : si la moyenne est trop haute, on rabaisse tout
    const avg = prelim.reduce((a, b) => a + b, 0) / Math.max(1, bars);
    const over = Math.max(0, avg - 0.62); // seuil à partir duquel on compresse
    const comp = 0.65 * over;             // intensité de compression

    // 3) Applique plafond, plancher et lissage
    const MIN = 0.06;
    const MAX = 0.90; // plafond < 100% pour éviter les colonnes “bloquées”
    const rise = playing ? 0.55 : 0.35; // montée plus rapide quand ça joue
    const fall = 0.25;                  // descente plus douce (aspect organique)

    const out = new Array(bars);
    for (let i = 0; i < bars; i++) {
      // compression de groupe
      let target = prelim[i] - comp;

      // clamp + gain sur pause
      target = clamp(target, MIN, MAX);
      if (!playing) target *= 0.25;

      // lissage exponentiel
      const prev = lastRef.current![i];
      const a = target > prev ? rise : fall;
      const next = prev + (target - prev) * a;
      out[i] = next;
      lastRef.current![i] = next;
    }
    return out;
  }, [tick, bars, playing, phases]);

    return (
        <div className="flex items-end gap-[3px] h-16 w-full">
            {heights.map((h, i) => (
            <div
                key={i}
                style={{
                height: "100%",
                transform: `translateZ(0) scaleY(${h})`,
                background: colors[i],
                boxShadow: `0 0 3px ${colors[i]}`,
                }}
                className="flex-1 h-full rounded-sm will-change-transform origin-bottom transition-transform duration-100 ease-linear"
            />
            ))}
        </div>
    );
}

/* utils */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const s = hex.replace("#", "");
  const n = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return { r, g, b };
}
function clamp(x: number, a: number, b: number) {
  return Math.max(a, Math.min(b, x));
}
function mulberry32(seed: number) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
