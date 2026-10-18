const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const router = require('../../routes/elections');

const report = {
  candidateName: 'Candidato Exemplo', office: 'GOVERNADOR', year: 2026, turn: 1, filters: {},
  subcabos: [{ cabo: 'Cabo Amostra', subcabo: 'Subcabo Amostra', prometidos: 2, prometidosExclusivos: 1, prometidosCompartilhados: 1, entregue: 0, faltante: 1, secoes: 2, secoesCompartilhadas: 1 }],
  hierarchy: [{ cabo: 'Cabo Amostra', subcabos: [{ subcabo: 'Subcabo Amostra', cidades: [{ city: 'Fortaleza', bairros: [{ bairro: 'Centro', secoes: [
    { zona: '01', secao: '0159', prometidos: 1, apurado: 0, entregue: 0, faltante: 1, status: 'com-falta', compartilhada: false, eleitores: ['Ana Exemplo'] },
    { zona: '01', secao: '0160', prometidos: 1, apurado: 987, entregue: null, faltante: null, status: 'compartilhada', compartilhada: true, eleitores: ['Bia Exemplo'] },
  ] }] }] }] }],
};

function response() {
  const chunks = [];
  const res = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  res.setHeader = () => {};
  res.buffer = () => Buffer.concat(chunks);
  return res;
}

function textFromPdf(buffer) {
  const code = 'import sys; from pypdf import PdfReader; import io; print("\\n".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(sys.stdin.buffer.read())).pages))';
  const parsed = spawnSync('python3', ['-c', code], { input: buffer, encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  return parsed.stdout;
}

test('PDF por subcabo mostra o total TSE da secao compartilhada, sem atribuir ao subcabo', async () => {
  const res = response();
  router.pdfBuilders.sendSubcaboReportPdf(res, report, 18);
  await new Promise((resolve, reject) => { res.on('finish', resolve); res.on('error', reject); });
  const text = textFromPdf(res.buffer());
  assert.match(text, /Votos apurados na seção/i);
  assert.doesNotMatch(text, /compartilhada, sem atribuição/i);
  assert.match(text, /987/); // total da secao aparece; nao e atribuido ao subcabo
  assert.match(text, /Ana Exemplo/);
  assert.doesNotMatch(text, /Bia Exemplo/);
});
