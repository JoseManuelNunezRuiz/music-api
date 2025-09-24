const express = require('express');
const cors = require('cors');
const path = require('path');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// MongoDB setup
const { MongoClient } = require('mongodb');

const mongoUri = process.env.MONGODB_URI;

const client = new MongoClient(mongoUri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    tls: true,
    tlsAllowInvalidCertificates: false
});

let songsCollection;

async function connectToMongo() {
    try {
        await client.connect();
        const db = client.db('musicapp'); // o el nombre que tengas en el URI
        songsCollection = db.collection('songs');
        console.log('🟢 Conectado a MongoDB');
    } catch (err) {
        console.error('❌ Error conectando a MongoDB:', err);
    }
}

connectToMongo();

// Endpoint para recibir callbacks de Suno API
app.post('/callback', async (req, res) => {
    try {
        console.log('Callback recibido:', req.body);

        const { code, data, msg } = req.body;

        if (!data || !data.task_id) {
            return res.status(400).json({ error: 'task_id es requerido en callback' });
        }

        const id = data.task_id || data.taskId;
        const status = data.status || data.callbackType || 'unknown';

        console.log('Contenido data.data:', data.data);

        let audio_url = null;
        let title = 'Mi Canción';

        if (Array.isArray(data.data) && data.data.length > 0) {
            audio_url = data.data[0].audio_url || null;
            title = data.data[0].title || title;
        }

        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

        const songData = {
            id,
            status,
            audio_url,
            title,
            expires_at: expiresAt.toISOString(),
            created_at: new Date().toISOString()
        };

        await songsCollection.updateOne(
            { id },
            { $set: songData },
            { upsert: true }
        );

        console.log(`🎵 Canción ${id} guardada con estado: ${status}`);

        res.status(200).json({ success: true, message: 'Callback procesado' });
    } catch (error) {
        console.error('Error procesando callback:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Endpoint para consultar estado de una canción
app.get('/song/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const song = await songsCollection.findOne({ id });

        if (!song) {
            return res.status(404).json({ error: 'Canción no encontrada' });
        }

        if (new Date(song.expires_at) < new Date()) {
            await songsCollection.deleteOne({ id });
            return res.status(404).json({ error: 'La canción ha expirado' });
        }

        res.json(song);
    } catch (error) {
        console.error('Error obteniendo canción:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Endpoint para listar todas las canciones (útil para debugging)
app.get('/songs', async (req, res) => {
    try {
        const songs = await songsCollection.find().toArray();
        res.json({
            count: songs.length,
            songs: songs
        });
    } catch (error) {
        console.error('Error listando canciones:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Endpoint para servir el frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Limpiar canciones expiradas periódicamente
setInterval(async () => {
    const now = new Date().toISOString();
    const result = await songsCollection.deleteMany({
        expires_at: { $lt: now }
    });

    if (result.deletedCount > 0) {
        console.log(`🧹 Eliminadas ${result.deletedCount} canciones expiradas`);
    }
}, 60 * 60 * 1000); // Ejecutar cada hora

app.listen(PORT, () => {
    console.log(`Servidor ejecutándose en puerto ${PORT}`);
    console.log(`Callback URL: https://musicapi-6gjf.onrender.com/callback`);
});
