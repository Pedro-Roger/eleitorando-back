require('dotenv').config();
const path = require('path');
const express = require('express');
require('express-async-errors'); // encaminha erros de rotas async pro middleware de erro, em vez de derrubar o processo
const cors = require('cors');

const { auth, blockIfMustChangePassword } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const voterRoutes = require('./routes/voters');
const dashboardRoutes = require('./routes/dashboard');
const candidateRoutes = require('./routes/candidates');
const exportRoutes = require('./routes/export');
const miscRoutes = require('./routes/misc');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/auth', authRoutes);
app.use('/users', auth, blockIfMustChangePassword, userRoutes);
app.use('/voters', auth, blockIfMustChangePassword, voterRoutes);
app.use('/dashboard', auth, blockIfMustChangePassword, dashboardRoutes);
app.use('/candidates', auth, blockIfMustChangePassword, candidateRoutes);
app.use('/export', auth, blockIfMustChangePassword, exportRoutes);
app.use('/', auth, blockIfMustChangePassword, miscRoutes);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

const port = process.env.PORT || 3333;
app.listen(port, () => console.log(`API rodando em http://localhost:${port}`));
