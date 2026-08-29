const { Router } = require('express');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');

const router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Em Docker: http://ocr-service:8081 · Local: http://localhost:8081
const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL || 'http://localhost:8081';

// processamento síncrono (mantido p/ compatibilidade) — lento, use /jobs
router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  try {
    const formData = new FormData();
    formData.append('file', req.file.buffer, { filename: req.file.originalname });

    const ocrRes = await axios.post(`${OCR_SERVICE_URL}/ocr`, formData, {
      headers: formData.getHeaders(),
      timeout: 300000, // EasyOCR em CPU pode demorar em fotos grandes
    });

    res.json(ocrRes.data);
  } catch (err) {
    console.error('OCR service error:', err.message);
    res.status(502).json({ error: 'Serviço de OCR indisponível.' });
  }
});

// fila: cria job — responde na hora, processa em background
router.post('/jobs', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  try {
    const formData = new FormData();
    formData.append('file', req.file.buffer, { filename: req.file.originalname || 'titulo.jpg' });
    formData.append('createdby', String(req.user.id));
    formData.append('createdbyname', req.user.name || '');

    const ocrRes = await axios.post(`${OCR_SERVICE_URL}/jobs`, formData, {
      headers: formData.getHeaders(),
      timeout: 30000,
    });

    res.json(ocrRes.data);
  } catch (err) {
    console.error('OCR jobs error:', err.message);
    res.status(502).json({ error: 'Serviço de OCR indisponível.' });
  }
});

// fila: status/resultado do job
router.get('/jobs/:id', async (req, res) => {
  try {
    const ocrRes = await axios.get(`${OCR_SERVICE_URL}/jobs/${Number(req.params.id)}`, { timeout: 15000 });
    res.json(ocrRes.data);
  } catch (err) {
    console.error('OCR job status error:', err.message);
    res.status(502).json({ error: 'Serviço de OCR indisponível.' });
  }
});

// fila: logs dos últimos jobs (admin)
router.get('/jobs', requireAdmin, async (req, res) => {
  try {
    const ocrRes = await axios.get(`${OCR_SERVICE_URL}/jobs?limit=50`, { timeout: 15000 });
    res.json(ocrRes.data);
  } catch (err) {
    console.error('OCR jobs list error:', err.message);
    res.status(502).json({ error: 'Serviço de OCR indisponível.' });
  }
});

async function requireAdmin(req, res, next) {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Somente administrador.' });
  }
  next();
}

module.exports = router;
