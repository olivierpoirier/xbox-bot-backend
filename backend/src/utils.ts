import { Voicemeeter } from "voicemeeter-connector";
import { execSync, spawn } from "child_process";
import fs from "fs";

const VM_PATH = "C:\\Program Files (x86)\\VB\\Voicemeeter\\voicemeeterpro.exe";

/**
 * Configure les sorties A1 et B2 dans VoiceMeeter
 */
async function configureVoicemeeterSettings() {
    try {
        const vm = await Voicemeeter.init();
        vm.connect();

        // On laisse le temps au moteur audio de stabiliser la connexion
        await new Promise(resolve => setTimeout(resolve, 2000));

        /**
         * Strip 3 = Voicemeeter Input (VAIO)
         * Strip 4 = Voicemeeter AUX Input
         */
        const virtualInputs = [3, 4];

        virtualInputs.forEach(index => {
            // Activation du renvoi vers le Bus Physique A1
            vm.setStripParameter(index, "A1" as any, 1);
            // Activation du renvoi vers le Bus Virtuel B2
            vm.setStripParameter(index, "B2" as any, 1);
            
            // On peut aussi s'assurer que le gain est à 0dB
            vm.setStripParameter(index, "Gain" as any, 0);
        });

        console.log("✅ VoiceMeeter : A1 et B2 configurés avec succès.");

        // Petite pause de sécurité avant de libérer l'API
        await new Promise(resolve => setTimeout(resolve, 500));
        vm.disconnect();
    } catch (e) {
        console.error("❌ Erreur lors de la configuration VoiceMeeter:", e);
    }
}

/**
 * Lance VoiceMeeter et applique les paramètres
 */
export async function ensureVoicemeeterReady() {
    if (!fs.existsSync(VM_PATH)) return false;

    if (!isVoiceMeeterRunning()) {
        const child = spawn(VM_PATH, [], { detached: true, stdio: "ignore" });
        child.unref();
        // Laisser le temps au logiciel de s'ouvrir avant de configurer
        await new Promise(resolve => setTimeout(resolve, 5000));
    }

    await configureVoicemeeterSettings();
    return true;
}

function isVoiceMeeterRunning(): boolean {
    try {
        const stdout = execSync('tasklist /FI "IMAGENAME eq voicemeeterpro.exe" /NH').toString();
        return stdout.includes("voicemeeterpro.exe");
    } catch { return false; }
}