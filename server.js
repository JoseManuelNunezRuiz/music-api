const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const mercadopago = require('mercadopago');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configurar MercadoPago
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const mp = new MercadoPagoConfig({ 
    accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN 
});

// Inicializa cliente Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Callback SunoAPI endpoint
app.post('/callback', async (req, res) => {
    try {
        console.log('🔔 Callback Suno recibido');

        const { code, data, msg } = req.body;

        if (!data || !data.task_id) {
            return res.status(400).json({ error: 'task_id es requerido en callback' });
        }

        const id = data.task_id || data.taskId;
        const status = data.status || data.callbackType || 'unknown';

        console.log('📊 Estado del callback:', status);

        let audio_url = null;
        let title = 'Mi Canción';

        if (Array.isArray(data.data) && data.data.length > 0) {
            // Buscar el primer elemento que tenga audio_url
            for (const item of data.data) {
                if (item.audio_url && item.audio_url.trim() !== '') {
                    audio_url = item.audio_url;
                    title = item.title || title;
                    break;
                }
            }
        }

        // ✅ SOLO guardar si audio_url está presente y no vacío
        if (audio_url && audio_url.trim() !== '') {
            const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
            
            const songData = {
                id,
                status: 'complete', // Siempre 'complete' cuando hay audio
                audio_url,
                title,
                expires_at: expiresAt.toISOString(),
                created_at: new Date().toISOString()
            };

            console.log('💾 Guardando canción COMPLETA en Supabase:', {
                id: id,
                title: title,
                audio_url: audio_url.substring(0, 50) + '...' // Log parcial por seguridad
            });

            // Usar la service role key que bypass RLS
            const { error } = await supabase
                .from('songs')
                .upsert(songData);

            if (error) {
                console.error('❌ Error guardando canción en Supabase:', error);
                return res.status(500).json({ error: 'Error guardando canción' });
            }

            console.log(`🎵 Canción ${id} guardada EXITOSAMENTE en Supabase`);
        } else {
            console.log(`⏳ Callback recibido pero sin audio_url aún (status: ${status}). Esperando...`);
        }

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

// Endpoint para generar canción con Suno API (llamado desde el frontend después del pago)
app.post('/generate-song', async (req, res) => {
    try {
        const { songData } = req.body;
        
        console.log('🎵 Solicitando generación a Suno API:', songData);

        if (!songData) {
            return res.status(400).json({ error: 'Datos de canción requeridos' });
        }

        const sunoApiUrl = process.env.BASE_URL;
        const sunoApiKey = process.env.API_KEY;

        if (!sunoApiKey) {
            return res.status(500).json({ error: 'API_KEY de Suno no configurada' });
        }

        // Preparar payload para Suno API según el modo
        let sunoPayload = {};
        
        if (songData.customMode) {
            // Modo personalizado
            sunoPayload = {
                prompt: songData.styleDescription || "Canción personalizada",
                title: songData.title || "Mi Canción",
                tags: songData.style || "Various",
                instrumental: songData.instrumental || false,
                make_instrumental: songData.instrumental || false,
                model: "suno-v3.5",
                wait_audio: false,
                lyrics: songData.lyrics || ""
            };
        } else {
            // Modo simple
            sunoPayload = {
                prompt: songData.prompt || "Canción generada",
                title: songData.title || "Mi Canción",
                tags: "Various",
                instrumental: songData.instrumental || false,
                make_instrumental: songData.instrumental || false,
                model: "suno-v3.5",
                wait_audio: false
            };
        }

        console.log('📤 Enviando a Suno API:', sunoPayload);

        const response = await fetch(`${sunoApiUrl}/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sunoApiKey}`
            },
            body: JSON.stringify(sunoPayload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Error Suno API: ${response.status} - ${errorText}`);
        }

        const result = await response.json();
        console.log('✅ Respuesta de Suno API:', result);

        const taskId = result?.task_id || result?.data?.taskId || result?.id;

        if (taskId) {
            // Guardar en Supabase con estado "generating"
            const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
            
            const { error } = await supabase
                .from('songs')
                .upsert({
                    id: taskId, // Usar el taskId de Suno como ID
                    status: 'generating',
                    payment_status: 'approved',
                    title: songData.title || 'Canción en generación',
                    created_at: new Date().toISOString(),
                    expires_at: expiresAt.toISOString(),
                    metadata: {
                        song_data: songData,
                        generated_at: new Date().toISOString()
                    }
                });

            if (error) {
                console.error('❌ Error guardando en Supabase:', error);
            }

            res.json({
                success: true,
                taskId: taskId,
                message: 'Canción en proceso de generación'
            });
        } else {
            throw new Error('No se recibió task_id de Suno API');
        }

    } catch (error) {
        console.error('❌ Error generando canción:', error);
        res.status(500).json({ 
            error: 'Error al generar canción',
            details: error.message 
        });
    }
});

// Endpoint para crear preferencia de pago
app.post('/create_preference', async (req, res) => {
    try {
        const price = 50;
        const description = 'Generación de canción IA';
        const songId = `${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;

        const frontendUrl = (process.env.FRONTEND_URL || 'https://musicapi-6gjf.onrender.com').replace(/\/+$/, '');
        const baseUrl = (process.env.BASE_URL || 'https://musicapi-6gjf.onrender.com').replace(/\/+$/, '');

        const preferenceData = {
            items: [
                {
                    title: description,
                    quantity: 1,
                    currency_id: 'MXN',
                    unit_price: price
                }
            ],
            back_urls: {
                success: `${frontendUrl}/?payment=success&songId=${songId}`,
                failure: `${frontendUrl}/?payment=failure`,
                pending: `${frontendUrl}/?payment=pending`
            },
            auto_return: 'approved',
            external_reference: songId
        };

        console.log('✅ Creando preferencia para canción:', songId);

        const preference = await new Preference(mp).create({ body: preferenceData });
        
        res.json({
            init_point: preference.init_point,
            songId: songId
        });

    } catch (error) {
        console.error('❌ Error creando preferencia MP:', error);
        res.status(500).json({ 
            error: 'Error al crear preferencia',
            details: error.message 
        });
    }
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

app.get('/config.js', (req, res) => {
    const config = {
        baseUrl: process.env.BASE_URL,
        apiKey: process.env.API_KEY,
        callbackUrl: process.env.CALLBACK_URL
    };

    res.setHeader('Content-Type', 'application/javascript');
    res.send(`const API_CONFIG = ${JSON.stringify(config)};`);
});

// Servir frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor ejecutándose en puerto ${PORT}`);
    console.log(`🔔 Callback URL: https://musicapi-6gjf.onrender.com/callback`);
    console.log(`🎵 Suno API: ${process.env.BASE_URL}`);
});