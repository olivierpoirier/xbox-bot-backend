// src/config.ts

export const APP_CONFIG = {
  PORT: parseInt(process.env.PORT || "4000", 10),
};

export const MPV_CONFIG = {
    
  bin: (process.env.MPV_BIN || "mpv").trim(),
  // --- SORTIE AUDIO (Récupérée de ton .env) ---
  audioDevice: (process.env.MPV_AUDIO_DEVICE || "").trim(),
  
  // Arguments optimisés pour la stabilité et la qualité
  baseArgs: [
    "--video=no",
    "--input-terminal=no",
    "--term-osd=no",
    "--load-scripts=no",
    "--volume=90",
    "--audio-samplerate=48000",
    "--audio-format=s16",
    "--audio-channels=stereo",
    
    // Buffer de 2s pour éviter les micro-coupures réseau
    "--audio-buffer=2.0", 
    "--cache=yes",
    "--demuxer-max-bytes=128MiB",
    "--audio-stream-silence=yes",
    "--idle=yes",
    "--keep-open=no",
  ],
  
  // Traitement sonore (Loudnorm léger pour équilibrer les morceaux)
  audioFilters: "loudnorm=I=-16:TP=-1.5:LRA=11",
  
  // Identité pour les requêtes
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  
  // Options transmises à yt-dlp via MPV
  ytdlRawOptions: [
    "force-ipv4=", 
    "extractor-args=youtube:player_client=android", 
    "no-check-certificate="
  ],
  
  // Timeouts de connexion IPC
  ipcConnectTimeoutMs: 5000,
  globalStartTimeoutMs: 20000,
};

export const YTDLP_CONFIG = {
  // --- EXÉCUTABLE (Chemin WinGet de ton .env) ---
  bin: (process.env.YTDLP_BIN || "yt-dlp.exe").trim(),
  
  // Arguments additionnels (Force IPv4 comme demandé)
  extraArgs: (process.env.YTDLP_EXTRA_ARGS || "--force-ipv4").split(" "),
  
  // Paramètres du cache interne
  cacheTTL: 600000, // 10 minutes
  cacheMax: 512,    // entrées
  
  // --- SECRETS SPOTIFY (Extraits de ton .env) ---
  spotify: {
    clientId: process.env.SPOTIFY_CLIENT_ID || "",
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || "",
    refreshToken: process.env.SPOTIFY_REFRESH_TOKEN || "",
  }
};