const { Router } = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../db/prisma');
const { auth } = require('../middleware/auth');
const { validPassword, logActivity, publicUser } = require('../lib/helpers');

const router = Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Informe usuário e senha.' });

  const user = await prisma.user.findUnique({ where: { username: String(username).toLowerCase().trim() } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
  }
  if (!user.active) return res.status(403).json({ error: 'Conta desativada. Fale com seu responsável.' });

  const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '12h' });
  await logActivity(user.id, 'LOGIN', `${user.name} entrou no sistema`);

  res.json({ token, user: publicUser(user), mustChangePassword: user.mustChangePassword });
});

router.post('/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!(await bcrypt.compare(currentPassword || '', req.user.passwordHash))) {
    return res.status(400).json({ error: 'Senha atual incorreta.' });
  }
  if (!validPassword(newPassword)) {
    return res.status(400).json({ error: 'A nova senha deve ter no mínimo 8 caracteres, com letras e números.' });
  }
  await prisma.user.update({
    where: { id: req.user.id },
    data: { passwordHash: await bcrypt.hash(newPassword, 10), mustChangePassword: false },
  });
  await logActivity(req.user.id, 'SENHA_ALTERADA', `${req.user.name} alterou a própria senha`);
  res.json({ ok: true });
});

router.get('/me', auth, async (req, res) => {
  const me = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { parent: { select: { id: true, name: true, username: true } } },
  });
  const votersCount = await prisma.voter.count({ where: { createdById: req.user.id } });
  res.json({ user: publicUser(me), votersCount });
});

// Atualização de dados básicos do próprio perfil (nome, telefone e e-mail apenas —
// perfil de acesso, estado, cidade e cabo responsável não podem ser alterados aqui)
router.patch('/me', auth, async (req, res) => {
  const { name, phone, email } = req.body || {};
  const data = {};
  if (name && String(name).trim()) data.name = String(name).trim();
  if (phone !== undefined) data.phone = phone ? String(phone).trim() : null;
  if (email !== undefined) data.email = email ? String(email).trim() : null;
  const updated = await prisma.user.update({ where: { id: req.user.id }, data });
  res.json({ user: publicUser(updated) });
});

module.exports = router;
