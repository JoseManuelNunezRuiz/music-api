const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());

// Sirve tu HTML desde /public
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint para recibir callback
app.post('/callback', (req, res) => {
    console.log('Datos recibidos:', req.body);
    // Aquí podrías guardar el archivo temporalmente, etc.
    res.sendStatus(200);
});

// Puerto para Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});
