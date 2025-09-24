const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Base de datos en memoria (en producción usarías una base de datos real)
let songsDatabase = new Map();

// Endpoint para recibir callbacks de Suno API
app.post('/callback', async (req, res) => {
    try {
        console.log('Callback recibido:', req.body);
        
        const { id, status, audio_url, title, video_url, image_url, model_name, metadata } = req.body;
        
        if (!id) {
            return res.status(400).json({ error: 'ID requerido' });
        }
        
        // Calcular fecha de expiración (48 horas desde ahora)
        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
        
        // Guardar canción en la base de datos
        songsDatabase.set(id, {
            id,
            status,
            audio_url,
            title: title || 'Mi Canción',
            video_url,
            image_url,
            model_name,
            metadata,
            expires_at: expiresAt.toISOString(),
            created_at: new Date().toISOString()
        });
        
        console.log(`Canción ${id} guardada con estado: ${status}`);
        
        res.status(200).json({ success: true, message: 'Callback procesado' });
    } catch (error) {
        console.error('Error procesando callback:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Endpoint para consultar estado de una canción
app.get('/song/:id', (req, res) => {
    try {
        const { id } = req.params;
        const song = songsDatabase.get(id);
        
        if (!song) {
            return res.status(404).json({ error: 'Canción no encontrada' });
        }
        
        // Verificar si ha expirado
        if (new Date(song.expires_at) < new Date()) {
            songsDatabase.delete(id);
            return res.status(404).json({ error: 'La canción ha expirado' });
        }
        
        res.json(song);
    } catch (error) {
        console.error('Error obteniendo canción:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Endpoint para listar todas las canciones (útil para debugging)
app.get('/songs', (req, res) => {
    try {
        const songs = Array.from(songsDatabase.values());
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
setInterval(() => {
    const now = new Date();
    let expiredCount = 0;
    
    for (const [id, song] of songsDatabase.entries()) {
        if (new Date(song.expires_at) < now) {
            songsDatabase.delete(id);
            expiredCount++;
        }
    }
    
    if (expiredCount > 0) {
        console.log(`Eliminadas ${expiredCount} canciones expiradas`);
    }
}, 60 * 60 * 1000); // Ejecutar cada hora

app.listen(PORT, () => {
    console.log(`Servidor ejecutándose en puerto ${PORT}`);
    console.log(`Callback URL: https://musicapi-6gjf.onrender.com/callback`);
});