// Knex é usado para as consultas de agregação (relatórios e indicadores),
// enquanto o Prisma cuida do CRUD. Ambos apontam para o mesmo banco.
require('dotenv').config();
const knex = require('knex');

const db = knex({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: { min: 0, max: 10 },
});

module.exports = db;
