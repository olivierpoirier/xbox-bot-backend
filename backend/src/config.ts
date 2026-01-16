export const APP_CONFIG = {
  PORT: parseInt(process.env.PORT || "4000", 10),
};

export const MPV_CONFIG = {
  bin: (process.env.MPV_BIN || "mpv").trim(),
  audioDevice: ("wasapi/{422c5f03-d063-4b65-b529-c54272b9bac9}").trim(),
  
  baseArgs: [
    "--video=no",
    "--input-terminal=no",
    "--term-osd=no",
    "--load-scripts=no",
    "--volume=100", 
    
    // --- QUALITÉ AUDIO ---
    "--audio-format=float", 
    "--audio-channels=stereo",
    "--audio-samplerate=48000", 
    "--audio-resample-filter-size=24", 
    "--audio-resample-cutoff=0",       
    "--audio-resample-linear=yes",     
    "--gapless-audio=yes", 
    "--audio-pitch-correction=yes", 
    
    // --- STABILITÉ YTDL (CORRECTION ICI) ---
    // On dit explicitement à MPV de ne chercher que de l'audio dès le départ
    "--ytdl-format=bestaudio/best",
    
    // --- FLUIDITÉ ---
    "--audio-buffer=5.0",      
    "--cache=yes",
    "--demuxer-max-bytes=512MiB", 
    "--demuxer-readahead-secs=20", 
    
    "--audio-stream-silence=yes",
    "--idle=yes",
    "--keep-open=no",
  ],
  
  audioFilters: "", 
  
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  
    ytdlRawOptions: [
    "force-ipv4=",
    "no-check-certificate=",
    // On met des guillemets autour de la valeur complexe ou on simplifie
    "extractor-args=youtube:player_client=android", 
  ],
  
  ipcConnectTimeoutMs: 5000,
  globalStartTimeoutMs: 20000,
};

export const YTDLP_CONFIG = {
  bin: (process.env.YTDLP_BIN || "yt-dlp.exe").trim(),
  
  extraArgs: [
    "--force-ipv4",
    // Priorité à la meilleure qualité audio, peu importe le conteneur
    "--format", "bestaudio/best", 
    // NE PAS utiliser --extract-audio ni --audio-format ici si c'est pour du streaming direct.
    // MPV lit le flux direct. La conversion fait perdre de la qualité.
    // Gardez ces options uniquement si vous téléchargez des fichiers sur le disque.
  ],
  
  cacheTTL: 600000,
  cacheMax: 512,
  
  spotify: {
    clientId: process.env.SPOTIFY_CLIENT_ID || "",
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || "",
    refreshToken: process.env.SPOTIFY_REFRESH_TOKEN || "",
  }
};