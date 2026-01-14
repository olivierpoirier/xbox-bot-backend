export const APP_CONFIG = {
  PORT: parseInt(process.env.PORT || "4000", 10),
};

export const MPV_CONFIG = {
  bin: (process.env.MPV_BIN || "mpv").trim(),
  audioDevice: (process.env.MPV_AUDIO_DEVICE || "").trim(),
  
  baseArgs: [
    "--video=no",
    "--input-terminal=no",
    "--term-osd=no",
    "--load-scripts=no",
    "--volume=100", 
    
    // --- QUALITÉ AUDIO ---
    // On ne spécifie pas samplerate pour laisser MPV gérer le natif
    "--audio-format=s32",
    "--audio-channels=stereo",
    "--gapless-audio=yes",     
    
    // --- RÉSEAU & CACHE ---
    "--audio-buffer=3.0",      
    "--cache=yes",
    "--demuxer-max-bytes=256MiB", 
    
    "--audio-stream-silence=yes",
    "--idle=yes",
    "--keep-open=no",
  ],
  
  audioFilters: "loudnorm=I=-16:TP=-1.5:LRA=11", 
  
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  
  // SYNTAXE CORRIGÉE POUR MPV 0.40.0
  // On ajoute '=' à la fin des options qui n'ont pas de valeur explicite
  ytdlRawOptions: [
    "force-ipv4=",
    "extractor-args=youtube:player_client=android",
    "no-check-certificate="
  ],
  
  ipcConnectTimeoutMs: 5000,
  globalStartTimeoutMs: 20000,
};

export const YTDLP_CONFIG = {
  bin: (process.env.YTDLP_BIN || "yt-dlp.exe").trim(),
  
  extraArgs: [
    "--force-ipv4",
    "--format", "bestaudio/best",
    "--extract-audio",
    "--audio-quality", "0", 
    "--audio-format", "best"
  ],
  
  cacheTTL: 600000,
  cacheMax: 512,
  
  spotify: {
    clientId: process.env.SPOTIFY_CLIENT_ID || "",
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || "",
    refreshToken: process.env.SPOTIFY_REFRESH_TOKEN || "",
  }
};