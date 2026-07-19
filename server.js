const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const API_BASE = 'https://www.googleapis.com/youtube/v3';

function getApiKey(res) {
    const apiKey = process.env.API_V3_YT;
    if (!apiKey) {
        res.status(500).json({ error: "La clé API_V3_YT n'est pas configurée sur le serveur." });
        return null;
    }
    return apiKey;
}

async function fetchJSON(url) {
    const response = await fetch(url);
    const data = await response.json();
    if (data.error) {
        const err = new Error(data.error.message || 'Erreur API YouTube');
        err.details = data.error;
        throw err;
    }
    return data;
}

// Convertit le filtre "uploadDate" (today/week/month/year) en date ISO pour publishedAfter
function publishedAfterFromFilter(filter) {
    if (!filter || filter === 'any') return null;
    const now = new Date();
    const d = new Date(now);
    switch (filter) {
        case 'today':
            d.setDate(now.getDate() - 1);
            break;
        case 'week':
            d.setDate(now.getDate() - 7);
            break;
        case 'month':
            d.setMonth(now.getMonth() - 1);
            break;
        case 'year':
            d.setFullYear(now.getFullYear() - 1);
            break;
        default:
            return null;
    }
    return d.toISOString();
}

/**
 * GET /api/search
 * Query params: q, type (video|channel), order, videoDuration, uploadDate, pageToken
 */
app.get('/api/search', async (req, res) => {
    const apiKey = getApiKey(res);
    if (!apiKey) return;

    const { q, pageToken } = req.query;
    const type = req.query.type === 'channel' ? 'channel' : 'video';
    const order = req.query.order || 'relevance';
    const videoDuration = req.query.videoDuration || 'any';
    const uploadDate = req.query.uploadDate || 'any';

    if (!q) {
        return res.status(400).json({ error: "Le paramètre de recherche 'q' est manquant." });
    }

    try {
        const params = new URLSearchParams({
            part: 'snippet',
            q,
            type,
            order,
            maxResults: '12',
            key: apiKey
        });

        if (type === 'video' && videoDuration !== 'any') {
            params.set('videoDuration', videoDuration);
        }

        const publishedAfter = publishedAfterFromFilter(uploadDate);
        if (publishedAfter) {
            params.set('publishedAfter', publishedAfter);
        }

        if (pageToken) {
            params.set('pageToken', pageToken);
        }

        const data = await fetchJSON(`${API_BASE}/search?${params.toString()}`);

        // Enrichissement : on va chercher les stats (vues/likes/durée ou abonnés) en un seul appel groupé
        if (type === 'video') {
            const videoIds = data.items.map(item => item.id.videoId).filter(Boolean);
            if (videoIds.length > 0) {
                const statsData = await fetchJSON(
                    `${API_BASE}/videos?part=statistics,contentDetails&id=${videoIds.join(',')}&key=${apiKey}`
                );
                const statsMap = {};
                statsData.items.forEach(v => { statsMap[v.id] = v; });
                data.items.forEach(item => {
                    const extra = statsMap[item.id.videoId];
                    if (extra) {
                        item.statistics = extra.statistics;
                        item.contentDetails = extra.contentDetails;
                    }
                });
            }
        } else {
            const channelIds = data.items.map(item => item.id.channelId).filter(Boolean);
            if (channelIds.length > 0) {
                const statsData = await fetchJSON(
                    `${API_BASE}/channels?part=statistics&id=${channelIds.join(',')}&key=${apiKey}`
                );
                const statsMap = {};
                statsData.items.forEach(c => { statsMap[c.id] = c; });
                data.items.forEach(item => {
                    const extra = statsMap[item.id.channelId];
                    if (extra) {
                        item.statistics = extra.statistics;
                    }
                });
            }
        }

        res.json(data);
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la communication avec l'API YouTube.", details: error.message });
    }
});

/**
 * GET /api/video?id=VIDEO_ID
 * Détails complets d'une vidéo : snippet, statistics, contentDetails
 */
app.get('/api/video', async (req, res) => {
    const apiKey = getApiKey(res);
    if (!apiKey) return;

    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Le paramètre 'id' est manquant." });

    try {
        const data = await fetchJSON(
            `${API_BASE}/videos?part=snippet,statistics,contentDetails&id=${encodeURIComponent(id)}&key=${apiKey}`
        );
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la récupération de la vidéo.", details: error.message });
    }
});

/**
 * GET /api/channel?id=CHANNEL_ID
 * Profil complet d'une chaîne : snippet, statistics, brandingSettings (bannière)
 */
app.get('/api/channel', async (req, res) => {
    const apiKey = getApiKey(res);
    if (!apiKey) return;

    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Le paramètre 'id' est manquant." });

    try {
        const data = await fetchJSON(
            `${API_BASE}/channels?part=snippet,statistics,brandingSettings&id=${encodeURIComponent(id)}&key=${apiKey}`
        );
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la récupération de la chaîne.", details: error.message });
    }
});

/**
 * GET /api/channel-videos?id=CHANNEL_ID&pageToken=...
 * Liste des vidéos d'une chaîne, triées par date d'ajout.
 * On utilise la playlist "uploads" de la chaîne (via playlistItems.list) plutôt que
 * search.list?channelId=..., car ce dernier est connu pour être peu fiable
 * (retard d'indexation, résultats partiels/incomplets).
 */
app.get('/api/channel-videos', async (req, res) => {
    const apiKey = getApiKey(res);
    if (!apiKey) return;

    const { id, pageToken } = req.query;
    if (!id) return res.status(400).json({ error: "Le paramètre 'id' est manquant." });

    try {
        // 1. Récupère l'ID de la playlist "uploads" de la chaîne
        const channelData = await fetchJSON(
            `${API_BASE}/channels?part=contentDetails&id=${encodeURIComponent(id)}&key=${apiKey}`
        );
        const channel = channelData.items && channelData.items[0];
        if (!channel) {
            return res.json({ items: [] });
        }
        const uploadsPlaylistId = channel.contentDetails.relatedPlaylists.uploads;

        // 2. Liste les vidéos de cette playlist (fiable et paginée correctement)
        const params = new URLSearchParams({
            part: 'snippet',
            playlistId: uploadsPlaylistId,
            maxResults: '12',
            key: apiKey
        });
        if (pageToken) params.set('pageToken', pageToken);

        const playlistData = await fetchJSON(`${API_BASE}/playlistItems?${params.toString()}`);

        // Reformate chaque item au même format que search.list pour que le frontend n'ait rien à changer
        const items = playlistData.items
            .filter(item => item.snippet.resourceId && item.snippet.resourceId.videoId)
            .map(item => ({
                id: { videoId: item.snippet.resourceId.videoId },
                snippet: item.snippet
            }));

        // 3. Récupère les stats/durée pour chaque vidéo
        const videoIds = items.map(item => item.id.videoId);
        if (videoIds.length > 0) {
            const statsData = await fetchJSON(
                `${API_BASE}/videos?part=statistics,contentDetails&id=${videoIds.join(',')}&key=${apiKey}`
            );
            const statsMap = {};
            statsData.items.forEach(v => { statsMap[v.id] = v; });
            items.forEach(item => {
                const extra = statsMap[item.id.videoId];
                if (extra) {
                    item.statistics = extra.statistics;
                    item.contentDetails = extra.contentDetails;
                }
            });
        }

        res.json({
            items,
            nextPageToken: playlistData.nextPageToken || null,
            prevPageToken: playlistData.prevPageToken || null
        });
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la récupération des vidéos de la chaîne.", details: error.message });
    }
});

/**
 * GET /api/comments?videoId=VIDEO_ID&pageToken=...
 */
app.get('/api/comments', async (req, res) => {
    const apiKey = getApiKey(res);
    if (!apiKey) return;

    const { videoId, pageToken } = req.query;
    if (!videoId) return res.status(400).json({ error: "Le paramètre 'videoId' est manquant." });

    try {
        const params = new URLSearchParams({
            part: 'snippet',
            videoId,
            order: 'relevance',
            maxResults: '20',
            textFormat: 'plainText',
            key: apiKey
        });
        if (pageToken) params.set('pageToken', pageToken);

        const data = await fetchJSON(`${API_BASE}/commentThreads?${params.toString()}`);
        res.json(data);
    } catch (error) {
        // Les commentaires peuvent être désactivés sur certaines vidéos -> on renvoie une liste vide plutôt qu'une erreur bloquante
        if (error.details && error.details.errors && error.details.errors[0] && error.details.errors[0].reason === 'commentsDisabled') {
            return res.json({ items: [], commentsDisabled: true });
        }
        res.status(500).json({ error: "Erreur lors de la récupération des commentaires.", details: error.message });
    }
});

/**
 * GET /api/related?videoId=VIDEO_ID
 * L'endpoint officiel "relatedToVideoId" ayant été retiré de l'API v3,
 * on reconstruit des suggestions pertinentes à partir du titre/des tags de la vidéo.
 */
app.get('/api/related', async (req, res) => {
    const apiKey = getApiKey(res);
    if (!apiKey) return;

    const { videoId } = req.query;
    if (!videoId) return res.status(400).json({ error: "Le paramètre 'videoId' est manquant." });

    try {
        const videoData = await fetchJSON(
            `${API_BASE}/videos?part=snippet&id=${encodeURIComponent(videoId)}&key=${apiKey}`
        );
        const video = videoData.items[0];
        if (!video) return res.json({ items: [] });

        const tags = video.snippet.tags || [];
        const query = tags.length > 0 ? tags.slice(0, 3).join(' ') : video.snippet.title;

        const params = new URLSearchParams({
            part: 'snippet',
            q: query,
            type: 'video',
            maxResults: '12',
            key: apiKey
        });

        const data = await fetchJSON(`${API_BASE}/search?${params.toString()}`);
        data.items = data.items.filter(item => item.id.videoId && item.id.videoId !== videoId);

        const videoIds = data.items.map(item => item.id.videoId);
        if (videoIds.length > 0) {
            const statsData = await fetchJSON(
                `${API_BASE}/videos?part=statistics,contentDetails&id=${videoIds.join(',')}&key=${apiKey}`
            );
            const statsMap = {};
            statsData.items.forEach(v => { statsMap[v.id] = v; });
            data.items.forEach(item => {
                const extra = statsMap[item.id.videoId];
                if (extra) {
                    item.statistics = extra.statistics;
                    item.contentDetails = extra.contentDetails;
                }
            });
        }

        res.json(data);
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la récupération des vidéos associées.", details: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});
