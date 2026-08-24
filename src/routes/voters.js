const { Router } = require('express');
const prisma = require('../db/prisma');
const { logActivity } = require('../lib/helpers');
const secoesCE = require('../data/ce-secoes.json');

const router = Router();

// Índices em memória pra autofill de zona/seção <-> cidade/bairro (Ceará), montados
// uma vez a partir da tabela oficial do TRE-CE (api/src/data/ce-secoes.json).
function normLookup(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .trim();
}

const zonaSecaoToLocal = new Map(); // "zona-secao" -> { city, neighborhood }
const cityBairroToSecoes = new Map(); // "CITY|BAIRRO" (normalizado) -> [{ zone, section, local }]
for (const row of secoesCE) {
  zonaSecaoToLocal.set(`${row.z}-${row.s}`, { city: row.c, neighborhood: row.b });
  if (row.b) {
    const key = `${normLookup(row.c)}|${normLookup(row.b)}`;
    if (!cityBairroToSecoes.has(key)) cityBairroToSecoes.set(key, []);
    cityBairroToSecoes.get(key).push({ zone: row.z, section: row.s, local: row.l });
  }
}

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

// Telefone é único entre eleitores. A comparação usa apenas os dígitos,
// pois o campo é salvo com máscara ("(85) 99999-9999").
async function phoneInUse(phone, exceptId) {
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return false;
  const rows = await prisma.$queryRaw`
    SELECT id FROM voters
    WHERE regexp_replace(coalesce(phone, ''), '\\D', '', 'g') = ${digits}
    LIMIT 2`;
  return rows.some((r) => r.id !== exceptId);
}

router.get('/', async (req, res) => {
  const ids = await scopeIds(req.user);
  const { state, city, neighborhood, search, createdById, createdByIds, today } = req.query;

  const where = {};
  if (today === '1') {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    where.createdAt = { gte: start };
  }
  if (ids) where.createdById = { in: ids };
  if (createdById) {
    const cid = Number(createdById);
    if (ids && !ids.includes(cid)) return res.status(403).json({ error: 'Sem permissão para este filtro.' });
    where.createdById = cid;
  }
  // Filtro por vários cadastradores (ex.: um cabo + seus subcabos), respeitando o escopo do perfil
  if (createdByIds) {
    const list = String(createdByIds)
      .split(',')
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (list.length) {
      if (ids && list.some((id) => !ids.includes(id))) {
        return res.status(403).json({ error: 'Sem permissão para este filtro.' });
      }
      where.createdById = { in: list };
    }
  }
  if (state) where.state = state;
  if (city) where.city = city;
  if (neighborhood) where.neighborhood = { equals: String(neighborhood).trim(), mode: 'insensitive' };
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

// Opções para os filtros de cidade e bairro: apenas valores que existem
// entre os eleitores visíveis para o perfil (mesmo escopo da listagem)
router.get('/filter-options', async (req, res) => {
  const ids = await scopeIds(req.user);
  const rows = await prisma.voter.findMany({
    where: ids ? { createdById: { in: ids } } : {},
    select: { state: true, city: true, neighborhood: true },
    distinct: ['state', 'city', 'neighborhood'],
  });

  const byCity = new Map();
  for (const r of rows) {
    const key = `${r.state}|${r.city}`;
    if (!byCity.has(key)) byCity.set(key, { state: r.state, city: r.city, neighborhoods: new Set() });
    const n = (r.neighborhood || '').trim();
    if (n) byCity.get(key).neighborhoods.add(n);
  }
  const cities = [...byCity.values()]
    .map((c) => ({ ...c, neighborhoods: [...c.neighborhoods].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => (a.city || '').localeCompare(b.city || ''));
  res.json({ cities });
});

// Autocompleta cidade/bairro a partir de zona+seção eleitoral, usando a tabela oficial
// do TRE-CE (locais de votação por zona/seção). Só cobre o Ceará por enquanto.
router.get('/lookup-zona-secao', (req, res) => {
  const zone = String(req.query.zone || '').replace(/\D/g, '');
  const section = String(req.query.section || '').replace(/\D/g, '');
  if (!zone || !section) return res.json({ match: null });

  const key = `${Number(zone)}-${Number(section)}`;
  const match = zonaSecaoToLocal.get(key) || null;
  res.json({ match });
});

// Sentido inverso: a partir de cidade+bairro, lista as zonas/seções possíveis (um
// bairro cai em várias seções — não é 1 pra 1 como zona+seção -> cidade/bairro).
router.get('/lookup-city-bairro', (req, res) => {
  const city = String(req.query.city || '');
  const neighborhood = String(req.query.neighborhood || '');
  if (!city || !neighborhood) return res.json({ matches: [] });

  const key = `${normLookup(city)}|${normLookup(neighborhood)}`;
  const matches = cityBairroToSecoes.get(key) || [];
  res.json({ matches });
});

router.post('/', async (req, res) => {
  const { name, phone, state, city, neighborhood, gender, age, zone, section, candidateId, notes } = req.body || {};

  const bairroSetting = await prisma.setting.findUnique({ where: { key: 'bairroObrigatorioEleitor' } });
  if (bairroSetting?.value === 'true' && (!neighborhood || !String(neighborhood).trim())) {
    return res.status(400).json({ error: 'O campo Bairro é obrigatório no cadastro de eleitor.' });
  }

  if (phone && (await phoneInUse(phone))) {
    return res.status(409).json({ error: 'Número de telefone já cadastrado.' });
  }

  let candidate = null;
  if (candidateId !== undefined && candidateId !== null && candidateId !== '') {
    candidate = await prisma.candidate.findUnique({ where: { id: Number(candidateId) } });
    if (!candidate) return res.status(400).json({ error: 'Candidato selecionado não encontrado.' });
  }

  const voter = await prisma.voter.create({
    data: {
      name: name ? String(name).trim() : null,
      phone: phone ? String(phone).trim() : null,
      state: state ? String(state).trim() : null,
      city: city ? String(city).trim() : null,
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

  const voterLabel = voter.name || 'sem nome';
  const voterLocation = voter.city || voter.state ? ` (${voter.city || '?'}/${voter.state || '?'})` : '';
  await logActivity(req.user.id, 'ELEITOR_CADASTRADO', `${req.user.name} cadastrou o eleitor ${voterLabel}${voterLocation}`);
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

  const bairroSetting = await prisma.setting.findUnique({ where: { key: 'bairroObrigatorioEleitor' } });
  const effectiveNeighborhood = neighborhood !== undefined ? neighborhood : voter.neighborhood;
  if (bairroSetting?.value === 'true' && (!effectiveNeighborhood || !String(effectiveNeighborhood).trim())) {
    return res.status(400).json({ error: 'O campo Bairro é obrigatório no cadastro de eleitor.' });
  }

  if (phone !== undefined && phone && (await phoneInUse(phone, voter.id))) {
    return res.status(409).json({ error: 'Número de telefone já cadastrado.' });
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
  if (name !== undefined) data.name = name ? String(name).trim() : null;
  if (phone !== undefined) data.phone = phone ? String(phone).trim() : null;
  if (state !== undefined) data.state = state ? String(state).trim() : null;
  if (city !== undefined) data.city = city ? String(city).trim() : null;
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

  await logActivity(req.user.id, 'ELEITOR_EDITADO', `${req.user.name} editou o eleitor ${updated.name || 'sem nome'}`);
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
  const deletedLabel = voter.name || 'sem nome';
  const deletedLocation = voter.city || voter.state ? ` (${voter.city || '?'}/${voter.state || '?'})` : '';
  await logActivity(req.user.id, 'ELEITOR_EXCLUIDO', `${req.user.name} excluiu o eleitor ${deletedLabel}${deletedLocation}`);
  res.json({ ok: true, message: 'Eleitor excluído.' });
});

module.exports = router;
