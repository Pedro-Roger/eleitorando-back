const { Router } = require('express');
const prisma = require('../db/prisma');
const { requireStateCity, logActivity } = require('../lib/helpers');

const router = Router();

// Escopo de visualização por perfil:
// SUBCABO → apenas os próprios registros
// CABO → os próprios + os dos seus subcabos
// ADMIN → todos
async function scopeIds(user) {
  if (user.role === 'SUBCABO') return [user.id];
  if (user.role === 'CABO') {
    const subs = await prisma.user.findMany({ where: { parentId: user.id }, select: { id: true } });
    return [user.id, ...subs.map((s) => s.id)];
  }
  return null; // admin: sem filtro
}

router.get('/', async (req, res) => {
  const ids = await scopeIds(req.user);
  const { state, city, search, createdById } = req.query;

  const where = {};
  if (ids) where.createdById = { in: ids };
  if (createdById) {
    const cid = Number(createdById);
    if (ids && !ids.includes(cid)) return res.status(403).json({ error: 'Sem permissão para este filtro.' });
    where.createdById = cid;
  }
  if (state) where.state = state;
  if (city) where.city = city;
  if (search) where.name = { contains: String(search), mode: 'insensitive' };

  const voters = await prisma.voter.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: {
      createdBy: { select: { id: true, name: true, role: true } },
      candidate: { select: { id: true, name: true, party: true, photoUrl: true } },
    },
  });
  const total = await prisma.voter.count({ where });
  res.json({ voters, total });
});

router.post('/', async (req, res) => {
  const { name, phone, state, city, neighborhood, gender, age, zone, section, candidateId, notes } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Informe o nome do eleitor.' });

  const locError = requireStateCity(req.body || {});
  if (locError) return res.status(400).json({ error: locError });

  const bairroSetting = await prisma.setting.findUnique({ where: { key: 'bairroObrigatorioEleitor' } });
  if (bairroSetting?.value === 'true' && (!neighborhood || !String(neighborhood).trim())) {
    return res.status(400).json({ error: 'O campo Bairro é obrigatório no cadastro de eleitor.' });
  }

  let candidate = null;
  if (candidateId !== undefined && candidateId !== null && candidateId !== '') {
    candidate = await prisma.candidate.findUnique({ where: { id: Number(candidateId) } });
    if (!candidate) return res.status(400).json({ error: 'Candidato selecionado não encontrado.' });
  }

  const voter = await prisma.voter.create({
    data: {
      name: String(name).trim(),
      phone: phone ? String(phone).trim() : null,
      state: String(state).trim(),
      city: String(city).trim(),
      neighborhood: neighborhood ? String(neighborhood).trim() : null,
      gender: gender ? String(gender).trim() : null,
      age: age !== undefined && age !== null && age !== '' ? Number(age) : null,
      zone: zone ? String(zone).trim() : null,
      section: section ? String(section).trim() : null,
      candidateId: candidate ? candidate.id : null,
      notes: notes ? String(notes).trim() : null,
      createdById: req.user.id,
    },
  });

  await logActivity(req.user.id, 'ELEITOR_CADASTRADO', `${req.user.name} cadastrou o eleitor ${voter.name} (${voter.city}/${voter.state})`);
  res.status(201).json({ voter, message: 'Eleitor cadastrado com sucesso.' });
});

// Edição de eleitor — permitida dentro do escopo de cada perfil:
// subcabo edita os próprios registros; cabo edita os dele e os da equipe; admin edita qualquer um
router.patch('/:id', async (req, res) => {
  const voter = await prisma.voter.findUnique({ where: { id: Number(req.params.id) } });
  if (!voter) return res.status(404).json({ error: 'Eleitor não encontrado.' });

  const ids = await scopeIds(req.user);
  if (ids && !ids.includes(voter.createdById)) {
    return res.status(403).json({ error: 'Você não pode editar este registro.' });
  }

  const { name, phone, state, city, neighborhood, gender, age, zone, section, candidateId, notes } = req.body || {};
  if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: 'Informe o nome do eleitor.' });

  const locError = requireStateCity({
    state: state !== undefined ? state : voter.state,
    city: city !== undefined ? city : voter.city,
  });
  if (locError) return res.status(400).json({ error: locError });

  const bairroSetting = await prisma.setting.findUnique({ where: { key: 'bairroObrigatorioEleitor' } });
  const effectiveNeighborhood = neighborhood !== undefined ? neighborhood : voter.neighborhood;
  if (bairroSetting?.value === 'true' && (!effectiveNeighborhood || !String(effectiveNeighborhood).trim())) {
    return res.status(400).json({ error: 'O campo Bairro é obrigatório no cadastro de eleitor.' });
  }

  let candidateIdValue = voter.candidateId;
  if (candidateId !== undefined) {
    if (candidateId === null || candidateId === '') {
      candidateIdValue = null;
    } else {
      const candidate = await prisma.candidate.findUnique({ where: { id: Number(candidateId) } });
      if (!candidate) return res.status(400).json({ error: 'Candidato selecionado não encontrado.' });
      candidateIdValue = candidate.id;
    }
  }

  const data = { candidateId: candidateIdValue };
  if (name !== undefined) data.name = String(name).trim();
  if (phone !== undefined) data.phone = phone ? String(phone).trim() : null;
  if (state !== undefined) data.state = String(state).trim();
  if (city !== undefined) data.city = String(city).trim();
  if (neighborhood !== undefined) data.neighborhood = neighborhood ? String(neighborhood).trim() : null;
  if (gender !== undefined) data.gender = gender ? String(gender).trim() : null;
  if (age !== undefined) data.age = age !== null && age !== '' ? Number(age) : null;
  if (zone !== undefined) data.zone = zone ? String(zone).trim() : null;
  if (section !== undefined) data.section = section ? String(section).trim() : null;
  if (notes !== undefined) data.notes = notes ? String(notes).trim() : null;

  const updated = await prisma.voter.update({
    where: { id: voter.id },
    data,
    include: {
      createdBy: { select: { id: true, name: true, role: true } },
      candidate: { select: { id: true, name: true, party: true, photoUrl: true } },
    },
  });

  await logActivity(req.user.id, 'ELEITOR_EDITADO', `${req.user.name} editou o eleitor ${updated.name}`);
  res.json({ voter: updated, message: 'Eleitor atualizado com sucesso.' });
});

// Exclusão de eleitor — cabo e subcabo só podem excluir os registros que eles mesmos
// cadastraram; o administrador pode excluir qualquer um.
router.delete('/:id', async (req, res) => {
  const voter = await prisma.voter.findUnique({ where: { id: Number(req.params.id) } });
  if (!voter) return res.status(404).json({ error: 'Eleitor não encontrado.' });

  if (req.user.role !== 'ADMIN' && voter.createdById !== req.user.id) {
    return res.status(403).json({ error: 'Você só pode excluir os eleitores que você mesmo cadastrou.' });
  }

  await prisma.voter.delete({ where: { id: voter.id } });
  await logActivity(req.user.id, 'ELEITOR_EXCLUIDO', `${req.user.name} excluiu o eleitor ${voter.name} (${voter.city}/${voter.state})`);
  res.json({ ok: true, message: 'Eleitor excluído.' });
});

module.exports = router;
