const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const prisma = require('../db/prisma');
const { requireRole } = require('../middleware/auth');
const { uploadCandidatePhoto, UPLOAD_DIR } = require('../middleware/upload');
const { logActivity } = require('../lib/helpers');

const router = Router();

function runUpload(req, res) {
  return new Promise((resolve, reject) => {
    uploadCandidatePhoto(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

function removePhotoFile(photoUrl) {
  if (!photoUrl) return;
  const filePath = path.join(UPLOAD_DIR, path.basename(photoUrl));
  fs.unlink(filePath, () => {});
}

// Lista simples de candidatos — acessível a todos os perfis autenticados,
// pois cabo/subcabo precisam selecionar o candidato ao cadastrar a intenção de voto do eleitor.
// Candidatos removidos (soft delete) não aparecem aqui.
router.get('/', async (req, res) => {
  const candidates = await prisma.candidate.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } });
  res.json({ candidates });
});

// Cadastro de candidato — somente o administrador
router.post('/', requireRole('ADMIN'), async (req, res) => {
  try {
    await runUpload(req, res);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Não foi possível processar a foto enviada.' });
  }

  const { name, party, active } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Informe o nome do candidato.' });
  if (!party || !String(party).trim()) return res.status(400).json({ error: 'Informe o partido do candidato.' });

  const candidate = await prisma.candidate.create({
    data: {
      name: String(name).trim(),
      party: String(party).trim(),
      photoUrl: req.file ? `/uploads/candidates/${req.file.filename}` : null,
      active: active !== 'false' && active !== false,
      createdById: req.user.id,
    },
  });

  await logActivity(req.user.id, 'CANDIDATO_CRIADO', `${req.user.name} cadastrou o candidato ${candidate.name} (${candidate.party})`);
  res.status(201).json({ candidate, message: 'Candidato cadastrado com sucesso.' });
});

// Edição — somente o administrador
router.patch('/:id', requireRole('ADMIN'), async (req, res) => {
  const candidate = await prisma.candidate.findUnique({ where: { id: Number(req.params.id) } });
  if (!candidate || candidate.deletedAt) return res.status(404).json({ error: 'Candidato não encontrado.' });

  try {
    await runUpload(req, res);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Não foi possível processar a foto enviada.' });
  }

  const { name, party, active } = req.body || {};
  const data = {};
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: 'O nome não pode ficar vazio.' });
    data.name = String(name).trim();
  }
  if (party !== undefined) {
    if (!String(party).trim()) return res.status(400).json({ error: 'O partido não pode ficar vazio.' });
    data.party = String(party).trim();
  }
  if (active !== undefined) data.active = active === 'true' || active === true;
  if (req.file) {
    data.photoUrl = `/uploads/candidates/${req.file.filename}`;
    removePhotoFile(candidate.photoUrl);
  }

  const updated = await prisma.candidate.update({ where: { id: candidate.id }, data });
  await logActivity(req.user.id, 'CANDIDATO_EDITADO', `${req.user.name} editou o candidato ${updated.name}`);
  res.json({ candidate: updated });
});

// Exclusão (soft delete) — somente o administrador. O registro não é apagado
// do banco: fica marcado como removido e some das listagens, mas eleitores que já
// apontavam este candidato mantêm o histórico da intenção de voto.
router.delete('/:id', requireRole('ADMIN'), async (req, res) => {
  const candidate = await prisma.candidate.findUnique({ where: { id: Number(req.params.id) } });
  if (!candidate || candidate.deletedAt) return res.status(404).json({ error: 'Candidato não encontrado.' });

  await prisma.candidate.update({ where: { id: candidate.id }, data: { deletedAt: new Date(), active: false } });

  await logActivity(req.user.id, 'CANDIDATO_EXCLUIDO', `${req.user.name} excluiu o candidato ${candidate.name}`);
  res.json({ ok: true, message: 'Candidato excluído.' });
});

module.exports = router;
