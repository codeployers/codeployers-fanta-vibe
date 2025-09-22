const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const app = express();
const PORT = 3000;

// Middleware per gestire JSON e CORS
app.use(express.json());
app.use(cors());

// Servi i file statici dalla directory corrente
app.use(express.static(__dirname));

// API per salvare lo stato
app.post('/api/save', (req, res) => {
    try {
        const data = req.body;
        fs.writeFileSync(path.join(__dirname, 'data/fanta_state.json'), JSON.stringify(data, null, 2));
        res.json({ success: true, message: 'Stato salvato con successo' });
    } catch (error) {
        console.error('Errore nel salvataggio dello stato:', error);
        res.status(500).json({ success: false, message: 'Errore nel salvataggio dello stato' });
    }
});

// API per caricare lo stato
app.get('/api/load', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'data/fanta_state.json');
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            res.json({ success: true, data: JSON.parse(data) });
        } else {
            res.status(404).json({ success: false, message: 'File di stato non trovato' });
        }
    } catch (error) {
        console.error('Errore nel caricamento dello stato:', error);
        res.status(500).json({ success: false, message: 'Errore nel caricamento dello stato' });
    }
});

// API per ottenere il file CSV di esempio
app.get('/api/sample-csv', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'data/giocatori.csv');
        if (fs.existsSync(filePath)) {
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=giocatori.csv');
            const fileStream = fs.createReadStream(filePath);
            fileStream.pipe(res);
        } else {
            res.status(404).json({ success: false, message: 'File CSV di esempio non trovato' });
        }
    } catch (error) {
        console.error('Errore nel caricamento del file CSV di esempio:', error);
        res.status(500).json({ success: false, message: 'Errore nel caricamento del file CSV di esempio' });
    }
});

// Avvia il server
app.listen(PORT, () => {
    console.log(`Server avviato su http://localhost:${PORT}`);
    console.log(`API disponibili:`);
    console.log(`- POST /api/save: Salva lo stato su disco`);
    console.log(`- GET /api/load: Carica lo stato da disco`);
});
