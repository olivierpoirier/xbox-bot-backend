import play from 'play-dl';
import 'dotenv/config';

async function getSpotifyAuth() {
    // 1. On configure avec ce qu'on a
    await play.setToken({
        spotify: {
            client_id: process.env.SPOTIFY_CLIENT_ID,
            client_secret: process.env.SPOTIFY_CLIENT_SECRET,
            market: 'FR'
        }
    });

    console.log("--- Initialisation de l'authentification ---");
    // 2. On demande à play-dl de générer les instructions
    // Note: Dans les versions récentes, cela peut ouvrir le navigateur ou donner un lien
    try {
        const auth = await play.authorization();
        console.log("Bravo ! Voici vos credentials à copier dans le .env :");
        console.log("");
        console.log(auth); 
    } catch (e) {
        console.error("Erreur lors de l'auth:", e);
    }
}

getSpotifyAuth();