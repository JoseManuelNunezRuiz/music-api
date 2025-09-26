const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const mercadopago = require('mercadopago');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configurar MercadoPago CORRECTAMENTE
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago'); // 👈 Agregar Payment

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
        // Solo guardar si audio_url está presente y no vacío
        if (audio_url && audio_url.trim() !== '') {
            const { error } = await supabase
                .from('songs')
                .upsert({
                    id,
                    status,
                    audio_url,
                    title,
                    expires_at: expiresAt.toISOString(),
                    created_at: new Date().toISOString(),
                    payment_status: 'pending' // 👈 Agregado aquí
                });

            if (error) {
                console.error('❌ Error guardando canción en Supabase:', error);
                return res.status(500).json({ error: 'Error guardando canción' });
            }

            console.log(`🎵 Canción ${id} guardada con estado: ${status}`);
        } else {
            console.warn(`⚠️ No se guardó la canción ${id} porque audio_url está vacío en status: ${status}`);
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

// CORREGIR el endpoint create_preference
app.post('/create_preference', async (req, res) => {
    try {
        console.log('Solicitud recibida para crear preferencia:', req.body);
        
        const price = 50; // 50 MXN
        const description = 'Generación de canción IA';

        const songId = `${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;

        // Validar que las URLs estén definidas
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        const baseUrl = process.env.BASE_URL || 'https://musicapi-6gjf.onrender.com';

        const preferenceData = {
            items: [
                {
                    title: description,
                    quantity: 1,
                    currency_id: 'MXN', // 👈 Agregar currency
                    unit_price: price
                }
            ],
            back_urls: {
                success: `${frontendUrl}/?payment=success&songId=${songId}`,
                failure: `${frontendUrl}/?payment=failure`,
                pending: `${frontendUrl}/?payment=pending`
            },
            auto_return: 'approved',
            external_reference: songId,
            notification_url: `${baseUrl}/mp-webhook`
        };

        console.log('Datos de preferencia:', preferenceData);

        const preference = await new Preference(mp).create({ body: preferenceData });

        console.log('Preferencia creada:', preference);

        res.json({
            init_point: preference.init_point,
            songId: songId
        });

    } catch (error) {
        console.error('❌ Error detallado creando preferencia MP:', error);
        
        // Log más detallado del error
        if (error.response) {
            console.error('Response error:', error.response.data);
            console.error('Status:', error.response.status);
        }
        
        res.status(500).json({ 
            error: 'Error al crear preferencia',
            details: error.message 
        });
    }
});

// Nuevo: webhook de MercadoPago para recibir notificaciones de pago
app.post('/mp-webhook', async (req, res) => {
    try {
        const topic = req.query.topic || req.body.type;
        const id = req.query.id || (req.body.data && req.body.data.id);
    
        if (!topic || !id) {
            return res.status(400).send('Faltan parámetros');
        }

        if (topic === 'payment') {
            const paymentInfo = await new Payment(mp).get({ id });
            const status = paymentInfo.status;
            const externalRef = paymentInfo.external_reference; // tu songId

            if (status === 'approved') {
                const { data: existingSong, error: fetchError } = await supabase
                    .from('songs')
                    .select('id')
                    .eq('id', externalRef)
                    .single();

                if (existingSong) {
                    const { error } = await supabase
                        .from('songs')
                        .update({ payment_status: 'approved' })
                        .eq('id', externalRef);

                    if (error) {
                        console.error('Error actualizando pago en Supabase:', error);
                    } else {
                        console.log(`✅ Pago aprobado para canción EXISTENTE ${externalRef}`);
                    }
                } else {
                    const now = new Date();
                    const expiresAt = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();

                    const { error } = await supabase
                        .from('songs')
                        .insert({
                            id: externalRef,
                            status: 'pending',
                            payment_status: 'approved',
                            created_at: now.toISOString(),
                            expires_at
                        });

                    if (error) {
                        console.error('Error insertando canción desde webhook MP:', error);
                    } else {
                        console.log(`✅ Pago aprobado y canción INSERTADA con ID: ${externalRef}`);
                    }
                }
            }
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('Error en webhook MP:', error);
        res.status(500).send('Error');
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

// Servir frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Servidor ejecutándose en puerto ${PORT}`);
    console.log(`Callback URL: https://musicapi-6gjf.onrender.com/callback`);
});
