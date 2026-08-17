const { Router } = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../db/prisma');
const { requireRole } = require('../middleware/auth');
const { validPassword, requireStateCity, logActivity, publicUser } = require('../lib/helpers');

const router = Router();

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

// Garante que o alvo pode ser gerenciado por quem está autenticado:
// admin gerencia cabos e subcabos; cabo gerencia apenas os próprios subcabos.
async function getManagedTarget(req, res) {
  const target = await prisma.user.findUnique({ where: { id: Number(req.params.id) } });
  if (!target || target.deletedAt) {
    res.status(404).json({ error: 'Usuário não encontrado.' });
    return null;
  }
  if (req.user.role === 'ADMIN' && target.role !== 'ADMIN') return target;
  if (req.user.role === 'CABO' && target.role === 'SUBCABO' && target.parentId === req.user.id) return target;
  res.status(403).json({ error: 'Você não tem permissão sobre este usuário.' });
  return null;
}

// Lista da tela "Equipe" — escopo por perfil
router.get('/', async (req, res) => {
  if (req.user.role === 'SUBCABO') {
    return res.status(403).json({ error: 'Subcabos não acessam a gestão de equipe.' });
  }

  if (req.user.role === 'ADMIN') {
    const cabos = await prisma.user.findMany({
      where: { role: 'CABO', deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: {
        subcabos: { where: { deletedAt: null }, select: { id: true } },
        _count: { select: { voters: true } },
      },
    });
    const result = await Promise.all(
      cabos.map(async (c) => {
        const subIds = c.subcabos.map((s) => s.id);
        const teamVoters = await prisma.voter.count({ where: { createdById: { in: [c.id, ...subIds] } } });
        const { subcabos, _count, ...rest } = c;
        return { ...publicUser(rest), subcabosCount: subIds.length, ownVoters: _count.voters, teamVoters };
      })
    );
    return res.json({ users: result });
  }

  // CABO: apenas os próprios subcabos
  const subs = await prisma.user.findMany({
    where: { role: 'SUBCABO', parentId: req.user.id, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { voters: true } } },
  });
  const result = await Promise.all(
    subs.map(async (s) => {
      const today = await prisma.voter.count({
        where: { createdById: s.id, createdAt: { gte: startOfToday() } },
      });
      const { _count, ...rest } = s;
      return { ...publicUser(rest), votersCount: _count.voters, votersToday: today };
    })
  );
  res.json({ users: result });
});

// Todos os subcabos (visão do administrador, com o cabo responsável)
router.get('/subcabos', requireRole('ADMIN'), async (req, res) => {
  const subs = await prisma.user.findMany({
    where: { role: 'SUBCABO', deletedAt: null },
    orderBy: { createdAt: 'desc' },
    include: {
      parent: { select: { id: true, name: true } },
      _count: { select: { voters: true } },
    },
  });
  res.json({
    users: subs.map((s) => {
      const { _count, ...rest } = s;
      return { ...publicUser(rest), votersCount: _count.voters };
    }),
  });
});

// Detalhe de um usuário (admin: qualquer cabo/subcabo; cabo: seus subcabos)
router.get('/:id', async (req, res) => {
  const target = await getManagedTarget(req, res);
  if (!target) return;

  const subcabos = await prisma.user.findMany({
    where: { parentId: target.id, deletedAt: null },
    include: { _count: { select: { voters: true } } },
  });
  const subIds = subcabos.map((s) => s.id);
  const ownVoters = await prisma.voter.count({ where: { createdById: target.id } });
  const teamVoters = subIds.length
    ? await prisma.voter.count({ where: { createdById: { in: subIds } } })
    : 0;
  const recentVoters = await prisma.voter.findMany({
    where: { createdById: { in: [target.id, ...subIds] } },
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: { createdBy: { select: { name: true } } },
  });
  const parent = target.parentId
    ? await prisma.user.findUnique({ where: { id: target.parentId }, select: { id: true, name: true } })
    : null;

  res.json({
    user: publicUser(target),
    parent,
    subcabos: subcabos.map((s) => {
      const { _count, ...rest } = s;
      return { ...publicUser(rest), votersCount: _count.voters };
    }),
    ownVoters,
    teamVoters,
    recentVoters,
  });
});

// Criação de usuário: o ADMIN cria cabos e subcabos (escolhendo o cabo responsável);
// um CABO pode criar subcabos, sempre vinculados a ele mesmo.
router.post('/', requireRole('ADMIN', 'CABO'), async (req, res) => {
  const { name, username, password, confirmPassword, phone, state, city, neighborhood, zone, section, active, role, parentId } =
    req.body || {};

  const newRole = role === 'SUBCABO' ? 'SUBCABO' : 'CABO';
  let parent = null;
  if (req.user.role === 'CABO') {
    if (newRole !== 'SUBCABO') {
      return res.status(403).json({ error: 'Cabos eleitorais só podem criar subcabos.' });
    }
    parent = await prisma.user.findUnique({ where: { id: req.user.id } });
  } else if (newRole === 'SUBCABO') {
    parent = await prisma.user.findUnique({ where: { id: Number(parentId) || 0 } });
    if (!parent || parent.role !== 'CABO') {
      return res.status(400).json({ error: 'Selecione o cabo responsável pelo subcabo.' });
    }
  }

  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Informe o nome completo.' });
  if (!username || !String(username).trim()) return res.status(400).json({ error: 'Informe o usuário.' });

  const locError = requireStateCity(req.body || {});
  if (locError) return res.status(400).json({ error: locError });

  if (!validPassword(password)) {
    return res.status(400).json({ error: 'A senha deve conter ao menos um número.' });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'A confirmação de senha não confere.' });
  }

  const uname = String(username).toLowerCase().trim();
  const exists = await prisma.user.findUnique({ where: { username: uname } });
  if (exists) return res.status(409).json({ error: 'Este nome de usuário já está em uso.' });

  const created = await prisma.user.create({
    data: {
      name: String(name).trim(),
      username: uname,
      passwordHash: await bcrypt.hash(password, 10),
      phone: phone ? String(phone).trim() : null,
      role: newRole,
      state: String(state).trim(),
      city: String(city).trim(),
      neighborhood: neighborhood ? String(neighborhood).trim() : null,
      zone: zone ? String(zone).trim() : null,
      section: section ? String(section).trim() : null,
      active: active !== false,
      mustChangePassword: true,
      parentId: parent ? parent.id : null,
      createdById: req.user.id,
    },
  });

  const label = newRole === 'CABO' ? 'Cabo eleitoral' : 'Subcabo eleitoral';
  await logActivity(req.user.id, 'USUARIO_CRIADO', `${req.user.name} criou o ${label.toLowerCase()} ${created.name} (${created.username})`);

  res.status(201).json({
    user: publicUser(created),
    initialPassword: password,
    message: `${label} criado com sucesso.`,
  });
});

// Edição — nunca permite alterar perfil (role) nem o vínculo do subcabo
router.patch('/:id', async (req, res) => {
  const target = await getManagedTarget(req, res);
  if (!target) return;

  const { name, phone, state, city, neighborhood, zone, section, active } = req.body || {};
  const data = {};
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: 'O nome não pode ficar vazio.' });
    data.name = String(name).trim();
  }
  if (phone !== undefined) data.phone = phone ? String(phone).trim() : null;
  if (state !== undefined || city !== undefined) {
    const st = state !== undefined ? state : target.state;
    const ct = city !== undefined ? city : target.city;
    const locError = requireStateCity({ state: st, city: ct });
    if (locError) return res.status(400).json({ error: locError });
    data.state = String(st).trim();
    data.city = String(ct).trim();
  }
  if (neighborhood !== undefined) data.neighborhood = neighborhood ? String(neighborhood).trim() : null;
  if (zone !== undefined) data.zone = zone ? String(zone).trim() : null;
  if (section !== undefined) data.section = section ? String(section).trim() : null;
  if (active !== undefined) data.active = Boolean(active);

  const updated = await prisma.user.update({ where: { id: target.id }, data });
  await logActivity(req.user.id, 'USUARIO_EDITADO', `${req.user.name} editou os dados de ${updated.name}`);
  res.json({ user: publicUser(updated) });
});

// Ativar / desativar conta
router.patch('/:id/status', async (req, res) => {
  const target = await getManagedTarget(req, res);
  if (!target) return;

  const active = Boolean(req.body?.active);
  const updated = await prisma.user.update({ where: { id: target.id }, data: { active } });
  await logActivity(
    req.user.id,
    active ? 'CONTA_ATIVADA' : 'CONTA_DESATIVADA',
    `${req.user.name} ${active ? 'ativou' : 'desativou'} a conta de ${target.name}`
  );
  res.json({ user: publicUser(updated) });
});

// Redefinição de senha — força troca no próximo acesso
router.post('/:id/reset-password', async (req, res) => {
  const target = await getManagedTarget(req, res);
  if (!target) return;

  const { newPassword } = req.body || {};
  if (!validPassword(newPassword)) {
    return res.status(400).json({ error: 'A senha deve conter ao menos um número.' });
  }
  await prisma.user.update({
    where: { id: target.id },
    data: { passwordHash: await bcrypt.hash(newPassword, 10), mustChangePassword: true },
  });
  await logActivity(req.user.id, 'SENHA_REDEFINIDA', `${req.user.name} redefiniu a senha de ${target.name}`);
  res.json({ ok: true, initialPassword: newPassword, message: 'Senha redefinida. O usuário deverá trocá-la no próximo acesso.' });
});

// Exclusão (soft delete) — mesmo escopo de gestão do PATCH: admin exclui cabos/subcabos,
// cabo exclui apenas os próprios subcabos. O registro não é apagado do banco: fica marcado
// como removido e some das listagens, mas o histórico de atividades e os eleitores já
// cadastrados por essa pessoa continuam intactos. O usuário libera o nome de usuário
// (renomeado internamente) para que possa ser reaproveitado em um novo cadastro.
router.delete('/:id', async (req, res) => {
  const target = await getManagedTarget(req, res);
  if (!target) return;

  await prisma.user.update({
    where: { id: target.id },
    data: {
      deletedAt: new Date(),
      active: false,
      username: `${target.username}__excluido_${Date.now()}`,
    },
  });

  const label = target.role === 'CABO' ? 'o cabo eleitoral' : 'o subcabo';
  await logActivity(req.user.id, 'USUARIO_EXCLUIDO', `${req.user.name} excluiu ${label} ${target.name}`);
  res.json({ ok: true, message: `${target.role === 'CABO' ? 'Cabo eleitoral' : 'Subcabo'} excluído.` });
});

module.exports = router;
