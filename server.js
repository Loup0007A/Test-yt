const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const API_BASE = 'https://www.googleapis.com/youtube/v3';

// ---------- Base de données (Supabase / Postgres) ----------
// DATABASE_URL doit être la connection string du "Session pooler" de Supabase.
// Si elle n'est pas définie, l'app continue de fonctionner normalement mais sans personnalisation.
let pool = null;
if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    pool.on('error', (err) => console.error('Erreur inattendue du pool Postgres:', err.message));
} else {
    console.warn("DATABASE_URL non défini : la personnalisation des Shorts est désactivée.");
}

async function initDb() {
    if (!pool) return;
    try {
        // Un "viewer" = un visiteur identifié par empreinte (fingerprint) + IP la plus récente + pays détecté
        await pool.query(`
            CREATE TABLE IF NOT EXISTS viewers (
                id SERIAL PRIMARY KEY,
                fingerprint TEXT UNIQUE NOT NULL,
                ip TEXT,
                country_code TEXT,
                first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
                last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        `);
        // Compatible avec les bases déjà déployées avant l'ajout du géociblage
        await pool.query(`ALTER TABLE viewers ADD COLUMN IF NOT EXISTS country_code TEXT;`);
        // Chaque ligne = une vidéo Short visionnée par un viewer, avec le temps réel passé dessus
        await pool.query(`
            CREATE TABLE IF NOT EXISTS short_views (
                id SERIAL PRIMARY KEY,
                viewer_id INTEGER NOT NULL REFERENCES viewers(id) ON DELETE CASCADE,
                video_id TEXT NOT NULL,
                channel_id TEXT,
                channel_title TEXT,
                category_id TEXT,
                tags TEXT[] DEFAULT '{}',
                watch_seconds NUMERIC NOT NULL,
                total_duration NUMERIC,
                watch_ratio NUMERIC,
                completed BOOLEAN DEFAULT false,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_short_views_viewer ON short_views(viewer_id);`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_short_views_video ON short_views(viewer_id, video_id);`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_viewers_fingerprint_ip ON viewers(fingerprint, ip);`);
        console.log('Base de données prête (tables viewers / short_views).');
    } catch (error) {
        console.error('Erreur lors de l\'initialisation de la base de données:', error.message);
    }
}

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress || '';
}

// ---------- Géolocalisation IP ----------
// Sert à restreindre le flux de Shorts au pays du visiteur. Résultat mis en cache en mémoire
// (12h) pour éviter de spammer le service de géolocalisation à chaque requête.
const geoCache = new Map(); // ip -> { countryCode, country, expiresAt }
const GEO_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

function isPrivateIp(ip) {
    if (!ip) return true;
    return ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.16.');
}

async function getCountryForIp(ip) {
    if (isPrivateIp(ip)) return null;
    const cached = geoCache.get(ip);
    if (cached && cached.expiresAt > Date.now()) return cached;

    try {
        const response = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,countryCode,country`);
        const data = await response.json();
        if (data.status !== 'success' || !data.countryCode) return null;
        const geo = { countryCode: data.countryCode, country: data.country, expiresAt: Date.now() + GEO_CACHE_TTL_MS };
        geoCache.set(ip, geo);
        return geo;
    } catch (error) {
        console.error('Erreur de géolocalisation IP:', error.message);
        return null;
    }
}

// Récupère (ou crée) l'identité d'un viewer à partir de son fingerprint, en notant son IP et son pays actuels.
// L'identité "primaire" est le fingerprint (stable sur un même appareil/navigateur) ; l'IP et le pays sont
// conservés en complément, comme demandé, pour affiner le suivi et le géociblage du flux.
async function getOrCreateViewerId(fingerprint, ip, countryCode) {
    const { rows } = await pool.query(
        `INSERT INTO viewers (fingerprint, ip, country_code, first_seen, last_seen)
         VALUES ($1, $2, $3, now(), now())
         ON CONFLICT (fingerprint) DO UPDATE
           SET ip = EXCLUDED.ip,
               country_code = COALESCE(EXCLUDED.country_code, viewers.country_code),
               last_seen = now()
         RETURNING id`,
        [fingerprint, ip, countryCode || null]
    );
    return rows[0].id;
}

// Construit le profil d'affinité d'un viewer à partir de son historique de visionnage :
// - les vidéos déjà vues récemment (pour éviter les répétitions)
// - les chaînes qu'il regarde le plus longtemps / le plus souvent (score = ratio moyen de visionnage x volume)
// - les mots-clés (tags) associés aux vidéos qu'il regarde le plus
async function getViewerProfile(fingerprint, ip) {
    if (!pool || !fingerprint) return null;
    try {
        const viewerRes = await pool.query(`SELECT id FROM viewers WHERE fingerprint = $1 LIMIT 1`, [fingerprint]);
        if (viewerRes.rows.length === 0) return null;
        const viewerId = viewerRes.rows[0].id;

        const seenRes = await pool.query(
            `SELECT video_id FROM short_views WHERE viewer_id = $1 ORDER BY created_at DESC LIMIT 200`,
            [viewerId]
        );
        const seenVideoIds = new Set(seenRes.rows.map(r => r.video_id));

        const channelRes = await pool.query(
            `SELECT channel_id, channel_title, AVG(watch_ratio) AS avg_ratio, COUNT(*) AS n
             FROM short_views
             WHERE viewer_id = $1 AND channel_id IS NOT NULL
             GROUP BY channel_id, channel_title
             ORDER BY (AVG(watch_ratio) * LN(1 + COUNT(*))) DESC
             LIMIT 6`,
            [viewerId]
        );

        const keywordRes = await pool.query(
            `SELECT tag, AVG(watch_ratio) AS avg_ratio, COUNT(*) AS n
             FROM short_views, LATERAL unnest(tags) AS tag
             WHERE viewer_id = $1
             GROUP BY tag
             ORDER BY (AVG(watch_ratio) * LN(1 + COUNT(*))) DESC
             LIMIT 8`,
            [viewerId]
        );

        return {
            viewerId,
            seenVideoIds,
            topChannels: channelRes.rows,
            topKeywords: keywordRes.rows.map(r => r.tag)
        };
    } catch (error) {
        console.error('Erreur lors de la récupération du profil viewer:', error.message);
        return null;
    }
}

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
 * Query params: q, type (video|channel|playlist), order, videoDuration, uploadDate, pageToken, music (true|false)
 */
app.get('/api/search', async (req, res) => {
    const apiKey = getApiKey(res);
    if (!apiKey) return;

    const { q, pageToken } = req.query;
    const validTypes = ['video', 'channel', 'playlist'];
    const type = validTypes.includes(req.query.type) ? req.query.type : 'video';
    const order = req.query.order || 'relevance';
    const videoDuration = req.query.videoDuration || 'any';
    const uploadDate = req.query.uploadDate || 'any';
    const musicOnly = req.query.music === 'true';

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

        // Le filtre "Musique" ne s'applique qu'aux vidéos : videoCategoryId=10 = catégorie "Musique" de YouTube
        if (type === 'video' && musicOnly) {
            params.set('videoCategoryId', '10');
        }

        const publishedAfter = publishedAfterFromFilter(uploadDate);
        if (publishedAfter) {
            params.set('publishedAfter', publishedAfter);
        }

        if (pageToken) {
            params.set('pageToken', pageToken);
        }

        const data = await fetchJSON(`${API_BASE}/search?${params.toString()}`);

        // Enrichissement : on va chercher les stats (vues/likes/durée, abonnés, ou nb de vidéos) en un seul appel groupé
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
        } else if (type === 'channel') {
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
        } else if (type === 'playlist') {
            const playlistIds = data.items.map(item => item.id.playlistId).filter(Boolean);
            if (playlistIds.length > 0) {
                const statsData = await fetchJSON(
                    `${API_BASE}/playlists?part=contentDetails&id=${playlistIds.join(',')}&key=${apiKey}`
                );
                const statsMap = {};
                statsData.items.forEach(p => { statsMap[p.id] = p; });
                data.items.forEach(item => {
                    const extra = statsMap[item.id.playlistId];
                    if (extra) {
                        item.contentDetails = extra.contentDetails;
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
 * GET /api/playlist?id=PLAYLIST_ID&pageToken=...
 * Retourne les infos de la playlist (titre, chaîne, nb de vidéos) + ses pistes paginées.
 */
app.get('/api/playlist', async (req, res) => {
    const apiKey = getApiKey(res);
    if (!apiKey) return;

    const { id, pageToken } = req.query;
    if (!id) return res.status(400).json({ error: "Le paramètre 'id' est manquant." });

    try {
        // 1. Infos générales de la playlist
        const playlistInfoData = await fetchJSON(
            `${API_BASE}/playlists?part=snippet,contentDetails&id=${encodeURIComponent(id)}&key=${apiKey}`
        );
        const playlistInfo = playlistInfoData.items && playlistInfoData.items[0];
        if (!playlistInfo) {
            return res.status(404).json({ error: 'Playlist introuvable.' });
        }

        // 2. Pistes de la playlist
        const params = new URLSearchParams({
            part: 'snippet',
            playlistId: id,
            maxResults: '25',
            key: apiKey
        });
        if (pageToken) params.set('pageToken', pageToken);

        const itemsData = await fetchJSON(`${API_BASE}/playlistItems?${params.toString()}`);

        const items = itemsData.items.filter(item => item.snippet.resourceId && item.snippet.resourceId.videoId);

        // 3. Durée + stats de chaque piste
        const videoIds = items.map(item => item.snippet.resourceId.videoId);
        if (videoIds.length > 0) {
            const statsData = await fetchJSON(
                `${API_BASE}/videos?part=statistics,contentDetails&id=${videoIds.join(',')}&key=${apiKey}`
            );
            const statsMap = {};
            statsData.items.forEach(v => { statsMap[v.id] = v; });
            items.forEach(item => {
                const extra = statsMap[item.snippet.resourceId.videoId];
                if (extra) {
                    item.statistics = extra.statistics;
                    item.contentDetails = extra.contentDetails;
                }
            });
        }

        res.json({
            playlist: {
                id,
                title: playlistInfo.snippet.title,
                description: playlistInfo.snippet.description,
                channelTitle: playlistInfo.snippet.channelTitle,
                channelId: playlistInfo.snippet.channelId,
                thumbnail: playlistInfo.snippet.thumbnails.medium
                    ? playlistInfo.snippet.thumbnails.medium.url
                    : playlistInfo.snippet.thumbnails.default.url,
                itemCount: playlistInfo.contentDetails.itemCount
            },
            items,
            nextPageToken: itemsData.nextPageToken || null
        });
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la récupération de la playlist.", details: error.message });
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

/**
 * GET /api/shorts?q=&pageToken=&fp=FINGERPRINT
 * Flux de vidéos courtes (Shorts). YouTube n'a pas d'endpoint officiel "shorts.list",
 * on cible donc les vidéos courtes (<= ~60s) via videoDuration=short puis on filtre
 * localement sur la durée réelle pour ne garder que les vrais Shorts.
 *
 * Si un fingerprint (fp) est fourni et qu'un historique existe en base, le flux est
 * personnalisé : requête de recherche orientée vers les centres d'intérêt appris
 * (chaînes/mots-clés les mieux "regardés"), puis reclassement des résultats en
 * favorisant les chaînes appréciées et en dépriorisant les vidéos déjà vues.
 */
app.get('/api/shorts', async (req, res) => {
    const apiKey = getApiKey(res);
    if (!apiKey) return;

    const userQuery = (req.query.q || '').trim();
    const pageToken = req.query.pageToken;
    const fingerprint = req.query.fp || null;
    const ip = getClientIp(req);

    try {
        const [profile, geo] = await Promise.all([
            fingerprint ? getViewerProfile(fingerprint, ip) : Promise.resolve(null),
            getCountryForIp(ip)
        ]);

        // Requête effective : une recherche explicite de l'utilisateur est toujours respectée telle quelle.
        // En l'absence de recherche, on pioche (70% du temps) dans les mots-clés les mieux "regardés"
        // du profil pour biaiser le flux par défaut, tout en gardant un peu de flux générique pour la diversité.
        let effectiveQuery = userQuery;
        let order = userQuery ? 'relevance' : 'viewCount';
        if (!userQuery && profile && profile.topKeywords.length > 0 && Math.random() < 0.7) {
            const pool3 = profile.topKeywords.slice(0, 3);
            effectiveQuery = pool3[Math.floor(Math.random() * pool3.length)];
            order = 'relevance';
        }
        if (!effectiveQuery) effectiveQuery = 'shorts';

        const params = new URLSearchParams({
            part: 'snippet',
            q: effectiveQuery,
            type: 'video',
            videoDuration: 'short',
            order,
            maxResults: '20',
            key: apiKey
        });
        if (pageToken) params.set('pageToken', pageToken);
        // Restreint la recherche à la localisation détectée du visiteur
        if (geo) params.set('regionCode', geo.countryCode);

        const data = await fetchJSON(`${API_BASE}/search?${params.toString()}`);

        const videoIds = data.items.map(item => item.id.videoId).filter(Boolean);
        let items = data.items;

        if (videoIds.length > 0) {
            const statsData = await fetchJSON(
                `${API_BASE}/videos?part=statistics,contentDetails,snippet&id=${videoIds.join(',')}&key=${apiKey}`
            );
            const statsMap = {};
            statsData.items.forEach(v => { statsMap[v.id] = v; });
            items.forEach(item => {
                const extra = statsMap[item.id.videoId];
                if (extra) {
                    item.statistics = extra.statistics;
                    item.contentDetails = extra.contentDetails;
                    item.tags = extra.snippet.tags || [];
                    item.categoryId = extra.snippet.categoryId || null;
                }
            });

            // Ne garde que les vidéos réellement courtes (<= 61s). Si le filtre élimine
            // tout (résultats atypiques), on retombe sur la liste non filtrée.
            const parseSeconds = (iso) => {
                if (!iso) return Infinity;
                const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
                if (!m) return Infinity;
                const h = parseInt(m[1] || '0', 10);
                const mi = parseInt(m[2] || '0', 10);
                const s = parseInt(m[3] || '0', 10);
                return h * 3600 + mi * 60 + s;
            };
            const filtered = items.filter(item => item.contentDetails && parseSeconds(item.contentDetails.duration) <= 61);
            if (filtered.length > 0) items = filtered;

            // ---- Filtrage strict par localisation : ne garde que les vidéos dont la chaîne est basée
            // dans le pays détecté du visiteur. YouTube ne fournit pas de filtre "pays d'origine" direct
            // sur search.list ; on va donc chercher le pays déclaré de chaque chaîne (channels.list) et on
            // filtre dessus. Si trop peu de chaînes déclarent un pays (fréquent), on retombe sur la liste
            // biaisée par regionCode plutôt que de renvoyer un flux vide.
            if (geo) {
                try {
                    const uniqueChannelIds = [...new Set(items.map(item => item.snippet.channelId))];
                    const channelsData = await fetchJSON(
                        `${API_BASE}/channels?part=snippet&id=${uniqueChannelIds.join(',')}&key=${apiKey}`
                    );
                    const countryMap = {};
                    channelsData.items.forEach(c => { countryMap[c.id] = c.snippet.country || null; });

                    const localOnly = items.filter(item => countryMap[item.snippet.channelId] === geo.countryCode);
                    if (localOnly.length > 0) items = localOnly;
                } catch (error) {
                    console.error('Erreur lors du filtrage par pays de la chaîne:', error.message);
                }
            }
        }

        // ---- Reclassement personnalisé ----
        if (profile) {
            const channelBoost = new Map(
                profile.topChannels.map(c => [c.channel_id, parseFloat(c.avg_ratio) * Math.log(1 + parseInt(c.n, 10))])
            );
            items.forEach((item, idx) => {
                let score = items.length - idx; // pertinence de base = ordre renvoyé par YouTube
                const chId = item.snippet.channelId;
                if (channelBoost.has(chId)) {
                    score += channelBoost.get(chId) * 20; // forte préférence pour les chaînes appréciées
                }
                if (profile.seenVideoIds.has(item.id.videoId)) {
                    score -= 1000; // fortement dépriorisé (pas exclu) si déjà vu récemment
                }
                item._score = score;
            });
            items.sort((a, b) => b._score - a._score);
        }

        res.json({
            items,
            nextPageToken: data.nextPageToken || null,
            personalized: !!profile,
            region: geo ? geo.countryCode : null
        });
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la récupération des Shorts.", details: error.message });
    }
});

/**
 * POST /api/shorts/view
 * Enregistre le temps réellement passé par un viewer sur un Short.
 * Body attendu : { fingerprint, videoId, channelId, channelTitle, categoryId, tags, watchSeconds, totalDuration }
 */
app.post('/api/shorts/view', async (req, res) => {
    if (!pool) return res.json({ ok: false, reason: 'db_disabled' });

    const { fingerprint, videoId, channelId, channelTitle, categoryId, tags, watchSeconds, totalDuration } = req.body || {};
    if (!fingerprint || !videoId || typeof watchSeconds !== 'number') {
        return res.status(400).json({ error: 'Paramètres manquants ou invalides.' });
    }

    try {
        const ip = getClientIp(req);
        const geo = await getCountryForIp(ip);
        const viewerId = await getOrCreateViewerId(fingerprint, ip, geo ? geo.countryCode : null);

        const duration = typeof totalDuration === 'number' && totalDuration > 0 ? totalDuration : null;
        const watchRatio = duration ? Math.min(1, watchSeconds / duration) : null;
        const completed = watchRatio !== null && watchRatio >= 0.9;

        await pool.query(
            `INSERT INTO short_views (viewer_id, video_id, channel_id, channel_title, category_id, tags, watch_seconds, total_duration, watch_ratio, completed)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
                viewerId,
                videoId,
                channelId || null,
                channelTitle || null,
                categoryId || null,
                Array.isArray(tags) ? tags.slice(0, 20) : [],
                watchSeconds,
                duration,
                watchRatio,
                completed
            ]
        );
        res.json({ ok: true });
    } catch (error) {
        console.error('Erreur lors de l\'enregistrement de la vue Short:', error.message);
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

initDb().finally(() => {
    app.listen(PORT, () => {
        console.log(`Serveur démarré sur le port ${PORT}`);
    });
});
