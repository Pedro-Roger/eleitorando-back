const prisma = require('../db/prisma');

function validPassword(pw) {
  // critérios mínimos: 8+ caracteres, ao menos uma letra e um número
  return typeof pw === 'string' && pw.length >= 8 && /[a-zA-Z]/.test(pw) && /\d/.test(pw);
}

function requireStateCity(body) {
  if (!body.state || !String(body.state).trim()) return 'O campo Estado é obrigatório.';
  if (!body.city || !String(body.city).trim()) return 'O campo Cidade é obrigatório.';
  return null;
}

async function logActivity(userId, action, detail) {
  await prisma.activity.create({ data: { userId, action, detail } });
}

function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

module.exports = { validPassword, requireStateCity, logActivity, publicUser };
