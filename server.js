const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Inicializa cliente Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ====================================================
// MIDDLEWARE EN EL ORDEN CORRECTO
// ====================================================

// 1. CORS primero
app.use(cors({
    origin: process.env.FRONTEND_URL || 'https://musicapi-6gjf.onrender.com',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// 2. Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 3. Cookie parser
app.use(cookieParser());

// 4. Archivos estáticos
app.use(express.static('public'));

// ====================================================
// MIDDLEWARE DE SESIÓN
// ====================================================
app.use((req, res, next) => {
    let sessionId = req.cookies.sessionId;
    
    if (!sessionId) {
        sessionId = crypto.randomBytes(32).toString('hex') + '-' + Date.now().toString(36);
        
        res.cookie('sessionId', sessionId, {
            maxAge: 48 * 60 * 60 * 1000,
            httpOnly: true,
            secure: true,
            sameSite: 'strict',
            path: '/'
        });
        
        console.log('Nueva sesión creada:', sessionId);
    }
    
    req.sessionId = sessionId;
    next();
});

// ====================================================
// FUNCIÓN PARA CALCULAR HASH DE PROPIEDAD
// ====================================================
function calculateUserHash(sessionId, taskId) {
    return crypto
        .createHash('sha256')
        .update(sessionId + taskId)
        .digest('hex');
}

// ====================================================
// CALLBACK CORREGIDO - PRESERVA DATOS ORIGINALES
// ====================================================
app.post('/callback', async (req, res) => {
    try {
        console.log('Callback Suno recibido');
        
        const { code, msg, data } = req.body;
        
        if (!data || !data.task_id) {
            console.error('Callback inválido: falta task_id');
            return res.status(400).json({ error: 'task_id es requerido' });
        }

        const taskId = data.task_id;
        const callbackType = data.callbackType || 'unknown';
        
        console.log(`Callback: task=${taskId}, type=${callbackType}, code=${code}`);

        // BUSCAR CANCIÓN EXISTENTE
        const { data: existingSong, error: fetchError } = await supabase
            .from('songs')
            .select('*')
            .eq('id', taskId)
            .single();

        if (fetchError || !existingSong) {
            console.error(`Callback recibido para canción inexistente: ${taskId}`);
            return res.status(404).json({ 
                error: 'Canción no encontrada',
                message: 'El registro debe ser creado por /generate-song primero'
            });
        }

        // ACTUALIZAR SOLO LOS CAMPOS DEL CALLBACK
        // PRESERVAR session_id y user_hash originales
        const updateData = {
            id: taskId,
            status: callbackType === 'complete' ? 'complete' : callbackType,
            session_id: existingSong.session_id,
            user_hash: existingSong.user_hash,
            created_at: existingSong.created_at,
            expires_at: existingSong.expires_at,
            title: existingSong.title,
            metadata: {
                ...(existingSong.metadata || {}),
                last_callback: new Date().toISOString(),
                callback_type: callbackType,
                callback_code: code,
                callback_message: msg,
                callback_data: data
            }
        };

        // Agregar información de audio si está disponible
        if (data.data && data.data.length > 0) {
            const sunoData = data.data[0];
            
            if (sunoData.audio_url) {
                updateData.audio_url = sunoData.audio_url;
                updateData.status = 'complete';
                console.log(`Audio URL guardada para ${taskId}`);
            }
            
            if (sunoData.title && !existingSong.title) {
                updateData.title = sunoData.title;
            }
        }

        console.log(`Actualizando ${taskId} - Preservando session: ${existingSong.session_id}`);

        const { error: upsertError } = await supabase
            .from('songs')
            .upsert(updateData);

        if (upsertError) {
            console.error('Error en upsert:', upsertError);
            return res.status(500).json({ error: 'Error guardando canción' });
        }

        console.log(`Callback procesado para ${taskId}`);
        res.status(200).json({ success: true });

    } catch (error) {
        console.error('Error en callback:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ====================================================
// OBTENER CANCIÓN CON VERIFICACIÓN DE PROPIEDAD
// ====================================================
app.get('/song/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const sessionId = req.sessionId;
        
        console.log(`Buscando canción ${id} para sesión ${sessionId}`);

        const expectedUserHash = calculateUserHash(sessionId, id);
        
        const { data: song, error } = await supabase
            .from('songs')
            .select('*')
            .eq('id', id)
            .eq('user_hash', expectedUserHash)
            .single();

        if (error || !song) {
            console.log(`Acceso denegado: ${id} no pertenece a sesión ${sessionId}`);
            
            const { data: diagnosticSong } = await supabase
                .from('songs')
                .select('id, session_id, user_hash')
                .eq('id', id)
                .single();
                
            if (diagnosticSong) {
                console.log(`Diagnóstico:`, {
                    session_id_en_db: diagnosticSong.session_id,
                    session_id_actual: sessionId,
                    user_hash_en_db: diagnosticSong.user_hash?.substring(0, 16),
                    user_hash_esperado: expectedUserHash.substring(0, 16)
                });
            }
            
            return res.status(404).json({ error: 'Canción no encontrada' });
        }

        if (new Date(song.expires_at) < new Date()) {
            console.log(`Canción ${id} expirada, eliminando...`);
            await supabase.from('songs').delete().eq('id', id);
            return res.status(404).json({ error: 'La canción ha expirado' });
        }

        console.log(`Acceso permitido: ${id} pertenece a ${sessionId}`);
        res.json(song);
        
    } catch (error) {
        console.error('Error obteniendo canción:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ====================================================
// GENERAR CANCIÓN
// ====================================================
app.post('/generate-song', async (req, res) => {
    try {
        const { songData } = req.body;
        const sessionId = req.sessionId;
        
        console.log('Iniciando generación para sesión:', sessionId);

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
                model: "V5",
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
                model: "V5",
                wait_audio: false,
                callBackUrl: process.env.CALLBACK_URL
            };
        }

        console.log('Enviando a Suno API...');

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
        console.log('Respuesta de Suno API:', result);

        const sunoTaskId = result?.task_id || result?.data?.taskId || result?.id;

        if (sunoTaskId) {
            const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
            const userHash = calculateUserHash(sessionId, sunoTaskId);
            
            const songRecord = {
                id: sunoTaskId,
                status: 'generating',
                payment_status: 'approved',
                title: songData.title || 'Canción en generación',
                created_at: new Date().toISOString(),
                expires_at: expiresAt.toISOString(),
                session_id: sessionId,
                user_hash: userHash,
                metadata: {
                    song_data: songData,
                    submitted_at: new Date().toISOString(),
                    session_id: sessionId,
                    user_hash: userHash,
                    suno_response: result
                }
            };

            console.log('Guardando en Supabase:', {
                taskId: sunoTaskId,
                sessionId: sessionId,
                userHash: userHash.substring(0, 16) + '...',
                title: songRecord.title
            });

            const { error: saveError } = await supabase
                .from('songs')
                .upsert(songRecord);

            if (saveError) {
                console.error('Error guardando en Supabase:', saveError);
                throw new Error(`Error guardando en base de datos: ${saveError.message}`);
            }

            console.log(`Canción ${sunoTaskId} guardada para sesión ${sessionId}`);

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
        console.error('Error generando canción:', error);
        res.status(500).json({ 
            error: 'Error al generar canción',
            details: error.message 
        });
    }
});

// ====================================================
// CREAR PREFERENCIA DE PAGO
// ====================================================
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

        console.log('Creando preferencia para canción:', songId);

        const { MercadoPagoConfig, Preference } = require('mercadopago');
        const mp = new MercadoPagoConfig({ 
            accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN 
        });

        const preference = await new Preference(mp).create({ body: preferenceData });
        
        res.json({
            init_point: preference.init_point,
            songId: songId
        });

    } catch (error) {
        console.error('Error creando preferencia MP:', error);
        res.status(500).json({ 
            error: 'Error al crear preferencia',
            details: error.message 
        });
    }
});

// ====================================================
// OBTENER CANCIONES RECIENTES
// ====================================================
app.get('/recent-songs', async (req, res) => {
    try {
        const sessionId = req.sessionId;
        
        console.log('Obteniendo canciones para sesión:', sessionId);
        
        const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
        
        const { data: songs, error } = await supabase
            .from('songs')
            .select('*')
            .gte('created_at', fortyEightHoursAgo)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error obteniendo canciones recientes:', error);
            return res.status(500).json({ error: 'Error obteniendo canciones recientes' });
        }

        const userSongs = songs.filter(song => {
            const songUserHash = calculateUserHash(sessionId, song.id);
            return song.user_hash === songUserHash;
        });

        const completeSongs = userSongs.filter(song => 
            song.status === 'complete' && song.audio_url
        );

        console.log(`Encontradas ${completeSongs.length} canciones para sesión ${sessionId}`);

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

// ====================================================
// ENDPOINT DE DIAGNÓSTICO
// ====================================================
app.get('/debug-songs', async (req, res) => {
    try {
        const sessionId = req.sessionId;
        
        const { data: songs, error } = await supabase
            .from('songs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(10);

        if (error) {
            return res.status(500).json({ error: 'Error obteniendo canciones' });
        }

        const songsWithOwnership = songs.map(song => {
            const expectedHash = calculateUserHash(sessionId, song.id);
            return {
                id: song.id,
                status: song.status,
                title: song.title,
                audio_url: song.audio_url ? 'PRESENTE' : 'AUSENTE',
                created_at: song.created_at,
                session_id: song.session_id,
                user_hash: song.user_hash?.substring(0, 16) + '...',
                expected_hash: expectedHash.substring(0, 16) + '...',
                belongs_to_user: song.user_hash === expectedHash,
                expires_at: song.expires_at
            };
        });

        res.json({
            sessionId: sessionId,
            total: songs.length,
            user_session: sessionId,
            songs: songsWithOwnership
        });
    } catch (error) {
        console.error('Error en debug:', error);
        res.status(500).json({ error: 'Error interno' });
    }
});

// ====================================================
// CONFIGURACIÓN
// ====================================================
app.get('/config.js', (req, res) => {
    const config = {
        baseUrl: process.env.BASE_URL,
        apiKey: process.env.API_KEY,
        callbackUrl: process.env.CALLBACK_URL
    };

    res.setHeader('Content-Type', 'application/javascript');
    res.send(`const API_CONFIG = ${JSON.stringify(config)};`);
});

// ====================================================
// RUTA PRINCIPAL
// ====================================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ====================================================
// LIMPIAR CANCIONES EXPIRADAS
// ====================================================
setInterval(async () => {
    try {
        const now = new Date().toISOString();
        const { error } = await supabase
            .from('songs')
            .delete()
            .lt('expires_at', now);

        if (!error) {
            console.log('Canciones expiradas eliminadas');
        }
    } catch (e) {
        console.error('Error en limpieza periódica:', e);
    }
}, 60 * 60 * 1000);

// ====================================================
// INICIAR SERVIDOR
// ====================================================
app.listen(PORT, () => {
    console.log(`Servidor ejecutándose en puerto ${PORT}`);
    console.log(`Callback URL: https://musicapi-6gjf.onrender.com/callback`);
    console.log(`Suno API: ${process.env.BASE_URL}`);
});