const jwt = require('jsonwebtoken');
const prisma = require('../db/prisma');

async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Não autenticado.' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: payload.id } });
    if (!user || !user.active) {
      return res.status(401).json({ error: 'Conta inativa ou inexistente.' });
    }
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Você não tem permissão para esta ação.' });
    }
    next();
  };
}

// Bloqueia tudo (exceto troca de senha) enquanto a senha inicial não for alterada
function blockIfMustChangePassword(req, res, next) {
  if (req.user.mustChangePassword && !req.path.startsWith('/auth/change-password')) {
    return res.status(423).json({ error: 'Troque sua senha inicial antes de continuar.', mustChangePassword: true });
  }
  next();
}

module.exports = { auth, requireRole, blockIfMustChangePassword };
