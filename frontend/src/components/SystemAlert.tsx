

interface Props {
  isOpen: boolean;
  rainbow?: boolean;
}

export default function SystemAlert({ isOpen, rainbow }: Props) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center px-4 bg-black/80 backdrop-blur-sm">
      <div className={`
        max-w-md w-full p-8 rounded-2xl border-4 text-center shadow-2xl
        ${rainbow 
          ? "bg-black text-white border-pink-500 shadow-pink-500/20" 
          : "bg-bg text-ink border-primary shadow-primary/20"}
      `}>
        <div className="text-4xl mb-4">⚠️</div>
        <h2 className="text-xl font-black uppercase tracking-tighter mb-2">
          Configuration Requise
        </h2>
        <p className="text-sm opacity-80 font-mono mb-6">
          Le bot ne détecte pas <strong>VoiceMeeter Banana</strong> sur l'ordinateur qui host l'application. 
          Cette application est nécessaire pour router le flux audio sur le serveur.
        </p>

        <a
          href="https://vb-audio.com/Voicemeeter/banana.htm"
          target="_blank"
          rel="noopener noreferrer"
          className={`
            inline-block w-full py-3 px-6 rounded-xl font-bold uppercase tracking-widest transition-transform active:scale-95
            ${rainbow ? "bg-pink-500 text-white" : "bg-primary text-white"}
          `}
        >
          Télécharger VoiceMeeter
        </a>
        
        <p className="mt-4 text-[10px] uppercase opacity-50 italic">
          Relancez le serveur après l'installation
        </p>
      </div>
    </div>
  );
}