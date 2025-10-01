const express = require('express');
const cookieParser = require('cookie-parser');
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

const crypto = require('crypto');

// Inicializa cliente Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ====================================================
// 🔧 MIDDLEWARE EN EL ORDEN CORRECTO
// ====================================================

// 1. CORS primero - con configuración para cookies
app.use(cors({
    origin: process.env.FRONTEND_URL || 'https://musicapi-6gjf.onrender.com',
    credentials: true, // ⬅️ CRÍTICO para cookies
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// 2. Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 3. Cookie parser ANTES del middleware de sesión
app.use(cookieParser());

// 4. Archivos estáticos
app.use(express.static('public'));

// ====================================================
// 🔑 MIDDLEWARE DE SESIÓN CORREGIDO
// ====================================================
app.use((req, res, next) => {
    // Leer cookie existente
    let sessionId = req.cookies.sessionId;
    
    if (!sessionId) {
        // Solo crear nueva sesión si NO existe
        sessionId = crypto.randomBytes(16).toString('hex');
        
        // Configurar cookie con opciones apropiadas para Render
        res.cookie('sessionId', sessionId, {
            maxAge: 48 * 60 * 60 * 1000, // 48 horas
            httpOnly: true,
            secure: true, // ⬅️ HTTPS en producción
            sameSite: 'none', // ⬅️ CRÍTICO para Render
            path: '/'
        });
        
        console.log('🆕 Nueva sesión creada:', sessionId);
    } else {
        console.log('♻️ Sesión existente:', sessionId);
    }
    
    req.sessionId = sessionId;
    next();
});

// ====================================================
// RUTAS
// ====================================================

app.post('/callback', async (req, res) => {
    try {
        console.log('🔔 Callback Suno recibido');
        
        const { code, msg, data } = req.body;
        
        if (!data || !data.task_id) {
            console.error('❌ Callback inválido: falta task_id');
            return res.status(400).json({ error: 'task_id es requerido' });
        }

        const taskId = data.task_id;
        const callbackType = data.callbackType || 'unknown';
        
        console.log(`📊 Callback: task=${taskId}, type=${callbackType}, code=${code}`);

        const { data: existingSong, error: fetchError } = await supabase
            .from('songs')
            .select('*')
            .eq('id', taskId)
            .single();

        if (fetchError || !existingSong) {
            console.error(`❌ Canción ${taskId} no encontrada en Supabase`);
            
            const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
            const newSong = {
                id: taskId,
                status: callbackType === 'complete' ? 'complete' : callbackType,
                title: 'Canción Generada',
                created_at: new Date().toISOString(),
                expires_at: expiresAt.toISOString(),
                session_id: 'unknown-from-callback',
                metadata: {
                    created_from_callback: true,
                    callback_data: data
                }
            };

            if (data.data && data.data.length > 0 && data.data[0].audio_url) {
                newSong.audio_url = data.data[0].audio_url;
                newSong.title = data.data[0].title || 'Canción Generada';
            }

            const { error: createError } = await supabase
                .from('songs')
                .upsert(newSong);
                
            if (createError) {
                console.error('❌ Error creando canción desde callback:', createError);
            } else {
                console.log('✅ Canción creada desde callback:', taskId);
            }
            
            return res.status(200).json({ success: true });
        }

        let updateData = {
            status: callbackType === 'complete' ? 'complete' : callbackType,
            metadata: {
                ...(existingSong.metadata || {}),
                last_callback: new Date().toISOString(),
                callback_type: callbackType,
                callback_code: code,
                callback_message: msg
            }
        };

        if (data.data && data.data.length > 0 && data.data[0].audio_url) {
            updateData.audio_url = data.data[0].audio_url;
            updateData.title = data.data[0].title || existingSong.title;
            updateData.status = 'complete';
            console.log(`🎵 Audio URL guardada para ${taskId}`);
        }

        const { error: updateError } = await supabase
            .from('songs')
            .update(updateData)
            .eq('id', taskId);

        if (updateError) {
            console.error('❌ Error actualizando canción:', updateError);
            return res.status(500).json({ error: 'Error actualizando canción' });
        }

        console.log(`✅ Callback procesado para ${taskId}, sesión: ${existingSong.session_id}`);
        res.status(200).json({ success: true });

    } catch (error) {
        console.error('❌ Error en callback:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.get('/song/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const sessionId = req.sessionId;
        
        console.log(`🔍 Buscando canción ${id} para sesión ${sessionId}`);

        const { data: song, error } = await supabase
            .from('songs')
            .select('*')
            .eq('id', id)
            .eq('session_id', sessionId)
            .single();

        if (error || !song) {
            console.log(`❌ Canción ${id} no encontrada para sesión ${sessionId}`);
            return res.status(404).json({ error: 'Canción no encontrada' });
        }

        if (new Date(song.expires_at) < new Date()) {
            await supabase.from('songs').delete().eq('id', id);
            return res.status(404).json({ error: 'La canción ha expirado' });
        }

        console.log(`✅ Canción ${id} encontrada para sesión ${sessionId}`);
        res.json(song);
        
    } catch (error) {
        console.error('Error obteniendo canción:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.post('/generate-song', async (req, res) => {
    try {
        const { songData } = req.body;
        const sessionId = req.sessionId;
        
        console.log('🎵 Iniciando generación para sesión:', sessionId);

        if (!songData) {
            return res.status(400).json({ error: 'Datos de canción requeridos' });
        }

        const sunoApiUrl = process.env.BASE_URL;
        const sunoApiKey = process.env.API_KEY;

        if (!sunoApiKey) {
            return res.status(500).json({ error: 'API_KEY de Suno no configurada' });
        }

        let sunoPayload = {};
        
        if (songData.customMode) {
            sunoPayload = {
                prompt: songData.styleDescription || "Canción personalizada",
                title: songData.title || "Mi Canción",
                tags: songData.style || "Various",
                instrumental: songData.instrumental || false,
                make_instrumental: songData.instrumental || false,
                model: "suno-v3.5",
                wait_audio: false,
                lyrics: songData.lyrics || "",
                callBackUrl: process.env.CALLBACK_URL
            };
        } else {
            sunoPayload = {
                prompt: songData.prompt || "Canción generada",
                title: songData.title || "Mi Canción",
                tags: "Various",
                instrumental: songData.instrumental || false,
                make_instrumental: songData.instrumental || false,
                model: "suno-v3.5",
                wait_audio: false,
                callBackUrl: process.env.CALLBACK_URL
            };
        }

        console.log('📤 Enviando a Suno API...');

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

        const sunoTaskId = result?.task_id || result?.data?.taskId || result?.id;

        if (sunoTaskId) {
            const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
            
            const songRecord = {
                id: sunoTaskId,
                status: 'generating',
                payment_status: 'approved',
                title: songData.title || 'Canción en generación',
                created_at: new Date().toISOString(),
                expires_at: expiresAt.toISOString(),
                session_id: sessionId,
                metadata: {
                    song_data: songData,
                    submitted_at: new Date().toISOString(),
                    session_id: sessionId,
                    suno_response: result
                }
            };

            console.log('💾 Guardando en Supabase:', {
                taskId: sunoTaskId,
                sessionId: sessionId,
                title: songRecord.title
            });

            const { error: saveError } = await supabase
                .from('songs')
                .upsert(songRecord);

            if (saveError) {
                console.error('❌ Error guardando en Supabase:', saveError);
                throw new Error(`Error guardando en base de datos: ${saveError.message}`);
            }

            console.log(`✅ Canción ${sunoTaskId} guardada para sesión ${sessionId}`);

            res.json({
                success: true,
                taskId: sunoTaskId,
                sessionId: sessionId,
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

app.post('/create_preference', async (req, res) => {
    try {
        const price = 50;
        const description = 'Generación de canción IA';
        const songId = `${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;

        const frontendUrl = (process.env.FRONTEND_URL || 'https://musicapi-6gjf.onrender.com').replace(/\/+$/, '');

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

app.get('/recent-songs', async (req, res) => {
    try {
        const sessionId = req.sessionId;
        
        console.log('📋 Obteniendo canciones para sesión:', sessionId);
        
        const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
        
        const { data: songs, error } = await supabase
            .from('songs')
            .select('*')
            .eq('session_id', sessionId)
            .gte('created_at', fortyEightHoursAgo)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error obteniendo canciones recientes:', error);
            return res.status(500).json({ error: 'Error obteniendo canciones recientes' });
        }

        const completeSongs = songs.filter(song => 
            song.status === 'complete' && song.audio_url
        );

        console.log(`🎵 Encontradas ${completeSongs.length} canciones para sesión ${sessionId}`);

        res.json({
            success: true,
            songs: completeSongs,
            count: completeSongs.length,
            sessionId: sessionId
        });
    } catch (error) {
        console.error('Error en endpoint recent-songs:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.get('/debug-songs', async (req, res) => {
    try {
        const sessionId = req.sessionId;
        
        const { data: songs, error } = await supabase
            .from('songs')
            .select('*')
            .eq('session_id', sessionId)
            .order('created_at', { ascending: false });

        if (error) {
            return res.status(500).json({ error: 'Error obteniendo canciones' });
        }

        res.json({
            sessionId: sessionId,
            total: songs.length,
            songs: songs.map(song => ({
                id: song.id,
                status: song.status,
                title: song.title,
                audio_url: song.audio_url ? 'PRESENTE' : 'AUSENTE',
                created_at: song.created_at,
                session_id: song.session_id,
                expires_at: song.expires_at
            }))
        });
    } catch (error) {
        console.error('Error en debug:', error);
        res.status(500).json({ error: 'Error interno' });
    }
});

app.get('/config.js', (req, res) => {
    const config = {
        baseUrl: process.env.BASE_URL,
        apiKey: process.env.API_KEY,
        callbackUrl: process.env.CALLBACK_URL
    };

    res.setHeader('Content-Type', 'application/javascript');
    res.send(`const API_CONFIG = ${JSON.stringify(config)};`);
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Limpiar canciones expiradas
setInterval(async () => {
    try {
        const now = new Date().toISOString();
        const { error } = await supabase
            .from('songs')
            .delete()
            .lt('expires_at', now);

        if (!error) {
            console.log('🧹 Canciones expiradas eliminadas');
        }
    } catch (e) {
        console.error('Error en limpieza periódica:', e);
    }
}, 60 * 60 * 1000);

app.listen(PORT, () => {
    console.log(`🚀 Servidor ejecutándose en puerto ${PORT}`);
    console.log(`🔔 Callback URL: https://musicapi-6gjf.onrender.com/callback`);
    console.log(`🎵 Suno API: ${process.env.BASE_URL}`);
});