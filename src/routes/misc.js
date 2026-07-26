const { Router } = require('express');
const prisma = require('../db/prisma');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('../lib/helpers');

const router = Router();

// Histórico de atividades (somente administrador)
router.get('/activities', requireRole('ADMIN'), async (req, res) => {
  const activities = await prisma.activity.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { user: { select: { name: true, role: true } } },
  });
  res.json({ activities });
});

// Configurações gerais (somente administrador)
router.get('/settings', requireRole('ADMIN'), async (req, res) => {
  const settings = await prisma.setting.findMany();
  res.json({ settings: Object.fromEntries(settings.map((s) => [s.key, s.value])) });
});

router.patch('/settings', requireRole('ADMIN'), async (req, res) => {
  const entries = Object.entries(req.body || {});
  for (const [key, value] of entries) {
    await prisma.setting.upsert({
      where: { key },
      update: { value: String(value) },
      create: { key, value: String(value) },
    });
  }
  await logActivity(req.user.id, 'CONFIG_ALTERADA', `${req.user.name} alterou configurações gerais`);
  const settings = await prisma.setting.findMany();
  res.json({ settings: Object.fromEntries(settings.map((s) => [s.key, s.value])) });
});

module.exports = router;
