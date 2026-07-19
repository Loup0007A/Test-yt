const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Autorise ton site frontend à interroger ce serveur
app.use(cors());

// Sert les fichiers statiques (le dossier où sera ton index.html)
app.use(express.static(path.join(__dirname, 'public')));

// Route API "Pont" : Ton frontend appellera /api/search?q=...
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    const apiKey = process.env.API_V3_YT; // Ta variable d'environnement sur Render

    if (!apiKey) {
        return res.status(500).json({ error: "La clé API_V3_YT n'est pas configurée sur le serveur." });
    }

    if (!query) {
        return res.status(400).json({ error: "Le paramètre de recherche 'q' est manquant." });
    }

    try {
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=8&key=${apiKey}`;
        const response = await fetch(url);
        const data = await response.json();
        
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la communication avec l'API YouTube." });
    }
});

app.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});
