require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// ─── CORS ───────────────────────────────────────────────────
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5500';
app.use(cors({
    origin: [
        FRONTEND_URL,
        'https://sistema-jurados.onrender.com',
        'http://127.0.0.1:5500',
        'http://localhost:3000',
        'http://localhost:3001'
    ],
    credentials: true
}));

// ─── Body Parsers ────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Servir frontend estático ────────────────────────────────
const frontendPath = path.join(__dirname, '../../frontend');
app.use(express.static(frontendPath));

// ─── Rutas API ───────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin/index'));
app.use('/api/usuario', require('./routes/usuario/index'));

// ─── Health check ────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Fallback para rutas API no encontradas ──────────────────
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Ruta API no encontrada' });
});

// ─── Fallback SPA: rutas del frontend sin extensión ──────────
// express.static ya sirve los .html directamente; este fallback
// solo aplica si alguien accede a una ruta sin extensión.
app.get('*', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
});

// ─── Error handler global ─────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('[ERROR]', err);
    res.status(500).json({ error: 'Error interno del servidor' });
});

// ─── Inicio del servidor ──────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 Servidor corriendo en http://localhost:${PORT}`);
    console.log(`📁 Frontend servido desde: ${frontendPath}`);
    console.log(`🔑 Entorno: ${process.env.NODE_ENV || 'development'}\n`);
});

module.exports = app;
