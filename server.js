const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Inicializa cliente Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

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

        // Insertar o actualizar canción en Supabase
        const { error } = await supabase
            .from('songs')
            .upsert({
                id,
                status,
                audio_url,
                title,
                expires_at: expiresAt.toISOString(),
                created_at: new Date().toISOString()
            });

        if (error) {
            console.error('Error guardando canción en Supabase:', error);
            return res.status(500).json({ error: 'Error guardando canción' });
        }

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
        const { data: song, error } = await supabase
            .from('songs')
            .select('*')
            .eq('id', id)
            .single();

        if (error) {
            return res.status(404).json({ error: 'Canción no encontrada' });
        }

        if (new Date(song.expires_at) < new Date()) {
            await supabase.from('songs').delete().eq('id', id);
            return res.status(404).json({ error: 'La canción ha expirado' });
        }

        res.json(song);
    } catch (error) {
        console.error('Error obteniendo canción:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Endpoint para listar todas las canciones (debug)
app.get('/songs', async (req, res) => {
    try {
        const { data: songs, error } = await supabase.from('songs').select('*');
        if (error) {
            return res.status(500).json({ error: 'Error listando canciones' });
        }
        res.json({
            count: songs.length,
            songs: songs
        });
    } catch (error) {
        console.error('Error listando canciones:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Servir frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Limpiar canciones expiradas periódicamente
setInterval(async () => {
    try {
        const now = new Date().toISOString();
        const { error } = await supabase
            .from('songs')
            .delete()
            .lt('expires_at', now);

        if (!error) {
            console.log('🧹 Canciones expiradas eliminadas');
        } else {
            console.error('Error eliminando canciones expiradas:', error);
        }
    } catch (e) {
        console.error('Error en limpieza periódica:', e);
    }
}, 60 * 60 * 1000); // Cada hora

app.listen(PORT, () => {
    console.log(`Servidor ejecutándose en puerto ${PORT}`);
    console.log(`Callback URL: https://musicapi-6gjf.onrender.com/callback`);
});
