const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const router = require('../../routes/elections');

const report = {
  candidateName: 'Candidato Exemplo', office: 'GOVERNADOR', year: 2026, turn: 1, filters: {},
  cabos: [{ id: 7, cabo: 'Cabo Amostra', prometidos: 3, entregue: 2, faltante: 1, cobertura: .667, subcabos: [
    { subcabo: 'Subcabo Amostra', prometidos: 3, secoes: 1, secoesCompartilhadas: 0 },
  ] }],
  hierarchy: [{ cabo: 'Cabo Amostra', subcabos: [{ subcabo: 'Subcabo Amostra', cidades: [{ city: 'Fortaleza', bairros: [{ bairro: 'Centro', secoes: [
    { zona: '01', secao: '0159', prometidos: 3, apurado: 2, entregue: 2, faltante: 1, status: 'com-falta', compartilhada: false, eleitores: ['Ana Exemplo', 'Bia Exemplo', 'Caio Exemplo'] },
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

test('PDF por cabo lista subcabos sem total entregue por subcabo', async () => {
  const res = response();
  router.pdfBuilders.sendCaboReportPdf(res, report, 7);
  await new Promise((resolve, reject) => { res.on('finish', resolve); res.on('error', reject); });
  const text = textFromPdf(res.buffer());
  assert.match(text, /Cabo Amostra/);
  assert.match(text, /Subcabo Amostra/);
  assert.match(text, /ENTREGUES/i);
  assert.doesNotMatch(text, /Subcabo\s+Promessas\s+Seções\s+Entregues/i);
  assert.match(text, /Ana Exemplo/);
});
