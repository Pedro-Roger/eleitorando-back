const { Router } = require('express');
const prisma = require('../db/prisma');
const knex = require('../db/knex');
const { requireRole } = require('../middleware/auth');

const router = Router();

const todayStart = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

// Indicadores da tela inicial, por perfil (agregações via Knex)
router.get('/', async (req, res) => {
  const u = req.user;

  if (u.role === 'ADMIN') {
    const [{ count: totalVoters }] = await knex('voters').count();
    const [{ count: totalCabos }] = await knex('users').where({ role: 'CABO' }).count();
    const [{ count: totalSubcabos }] = await knex('users').where({ role: 'SUBCABO' }).count();
    const [{ count: votersToday }] = await knex('voters').where('createdAt', '>=', todayStart()).count();
    const byState = await knex('voters')
      .select('state')
      .count('* as total')
      .groupBy('state')
      .orderBy('total', 'desc');
    const byCity = await knex('voters')
      .select('state', 'city')
      .count('* as total')
      .groupBy('state', 'city')
      .orderBy('total', 'desc')
      .limit(10);
    return res.json({
      role: u.role,
      totalVoters: Number(totalVoters),
      totalCabos: Number(totalCabos),
      totalSubcabos: Number(totalSubcabos),
      votersToday: Number(votersToday),
      byState: byState.map((r) => ({ ...r, total: Number(r.total) })),
      byCity: byCity.map((r) => ({ ...r, total: Number(r.total) })),
    });
  }

  if (u.role === 'CABO') {
    const subs = await prisma.user.findMany({ where: { parentId: u.id }, select: { id: true, name: true } });
    const subIds = subs.map((s) => s.id);
    const teamIds = [u.id, ...subIds];

    const [{ count: teamVoters }] = await knex('voters').whereIn('createdById', teamIds).count();
    const [{ count: ownVoters }] = await knex('voters').where({ createdById: u.id }).count();
    const [{ count: votersToday }] = await knex('voters')
      .whereIn('createdById', teamIds)
      .where('createdAt', '>=', todayStart())
      .count();
    const bySub = subIds.length
      ? await knex('voters')
          .whereIn('createdById', subIds)
          .select('createdById')
          .count('* as total')
          .groupBy('createdById')
      : [];
    const bySubMap = Object.fromEntries(bySub.map((r) => [r.createdById, Number(r.total)]));

    return res.json({
      role: u.role,
      teamVoters: Number(teamVoters),
      ownVoters: Number(ownVoters),
      votersToday: Number(votersToday),
      subcabosCount: subIds.length,
      bySubcabo: subs.map((s) => ({ id: s.id, name: s.name, total: bySubMap[s.id] || 0 })),
    });
  }

  // SUBCABO
  const [{ count: ownVoters }] = await knex('voters').where({ createdById: u.id }).count();
  const [{ count: votersToday }] = await knex('voters')
    .where({ createdById: u.id })
    .where('createdAt', '>=', todayStart())
    .count();
  const parent = u.parentId
    ? await prisma.user.findUnique({ where: { id: u.parentId }, select: { name: true } })
    : null;
  res.json({
    role: u.role,
    ownVoters: Number(ownVoters),
    votersToday: Number(votersToday),
    parentName: parent?.name || null,
  });
});

// Painel demográfico geral — escopo por perfil:
// admin vê toda a campanha; cabo vê a equipe dele; subcabo vê os próprios registros
router.get('/demographics', async (req, res) => {
  const u = req.user;
  let ids = null;
  if (u.role === 'SUBCABO') ids = [u.id];
  if (u.role === 'CABO') {
    const subs = await prisma.user.findMany({ where: { parentId: u.id }, select: { id: true } });
    ids = [u.id, ...subs.map((s) => s.id)];
  }
  const base = () => (ids ? knex('voters').whereIn('createdById', ids) : knex('voters'));

  const [{ count: total }] = await base().count();
  const byGender = await base()
    .select(knex.raw(`COALESCE(gender, 'Não informado') as gender`))
    .count('* as total')
    .groupBy('gender')
    .orderBy('total', 'desc');
  const byAge = await base()
    .select(
      knex.raw(`CASE
        WHEN age IS NULL THEN 'Não informada'
        WHEN age < 25 THEN '16 a 24'
        WHEN age < 35 THEN '25 a 34'
        WHEN age < 45 THEN '35 a 44'
        WHEN age < 60 THEN '45 a 59'
        ELSE '60+'
      END as range`)
    )
    .count('* as total')
    .groupBy('range')
    .orderBy('range');
  const byZone = await base()
    .whereNotNull('zone')
    .select('zone')
    .count('* as total')
    .groupBy('zone')
    .orderBy('total', 'desc')
    .limit(10);
  const byCity = await base()
    .select('state', 'city')
    .count('* as total')
    .groupBy('state', 'city')
    .orderBy('total', 'desc')
    .limit(10);

  // Intenção de voto por candidato — join com a tabela de candidatos
  const byCandidate = await base()
    .whereNotNull('voters.candidateId')
    .join('candidates', 'candidates.id', 'voters.candidateId')
    .select(
      'candidates.id as candidateId',
      'candidates.name as name',
      'candidates.party as party',
      'candidates.photoUrl as photoUrl'
    )
    .count('voters.id as total')
    .groupBy('candidates.id', 'candidates.name', 'candidates.party', 'candidates.photoUrl')
    .orderBy('total', 'desc');
  const [{ count: withoutCandidate }] = await base().whereNull('candidateId').count();

  res.json({
    total: Number(total),
    byGender: byGender.map((r) => ({ ...r, total: Number(r.total) })),
    byAge: byAge.map((r) => ({ ...r, total: Number(r.total) })),
    byZone: byZone.map((r) => ({ ...r, total: Number(r.total) })),
    byCity: byCity.map((r) => ({ ...r, total: Number(r.total) })),
    byCandidate: byCandidate.map((r) => ({ ...r, total: Number(r.total) })),
    withoutCandidate: Number(withoutCandidate),
  });
});

// Resultados consolidados (admin): por estado, cidade, cabo e subcabo
router.get('/reports', requireRole('ADMIN'), async (req, res) => {
  const byState = await knex('voters').select('state').count('* as total').groupBy('state').orderBy('total', 'desc');
  const byCity = await knex('voters')
    .select('state', 'city')
    .count('* as total')
    .groupBy('state', 'city')
    .orderBy('total', 'desc');

  // Consolidado por cabo: registros do cabo + dos seus subcabos
  const cabos = await knex('users as c')
    .where('c.role', 'CABO')
    .leftJoin('users as s', 's.parentId', 'c.id')
    .leftJoin('voters as v', function () {
      this.on('v.createdById', 'c.id').orOn('v.createdById', 's.id');
    })
    .select('c.id', 'c.name', 'c.state', 'c.city')
    .countDistinct('v.id as total')
    .groupBy('c.id', 'c.name', 'c.state', 'c.city')
    .orderBy('total', 'desc');

  const subcabos = await knex('users as s')
    .where('s.role', 'SUBCABO')
    .leftJoin('users as c', 'c.id', 's.parentId')
    .leftJoin('voters as v', 'v.createdById', 's.id')
    .select('s.id', 's.name', 's.state', 's.city', 'c.name as caboName')
    .count('v.id as total')
    .groupBy('s.id', 's.name', 's.state', 's.city', 'c.name')
    .orderBy('total', 'desc');

  const [{ count: campaignTotal }] = await knex('voters').count();

  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const [{ count: weeklyNew }] = await knex('voters').where('createdAt', '>=', weekAgo).count();

  const metaSetting = await prisma.setting.findUnique({ where: { key: 'metaCampanha' } });
  const meta = metaSetting?.value ? Number(metaSetting.value) : null;

  res.json({
    campaignTotal: Number(campaignTotal),
    weeklyNew: Number(weeklyNew),
    meta,
    byState: byState.map((r) => ({ ...r, total: Number(r.total) })),
    byCity: byCity.map((r) => ({ ...r, total: Number(r.total) })),
    byCabo: cabos.map((r) => ({ ...r, total: Number(r.total) })),
    bySubcabo: subcabos.map((r) => ({ ...r, total: Number(r.total) })),
  });
});

module.exports = router;
