const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const router = require('../../routes/elections');

const report = {
  candidateName: 'Candidato Exemplo', office: 'GOVERNADOR', year: 2026, turn: 1, filters: {},
  totals: { prometidos: 3, entregue: 2, faltante: 1, cobertura: .667, compartilhadas: 1 },
  cabos: [{ cabo: 'Cabo Amostra', prometidos: 3, entregue: 2, faltante: 1, cobertura: .667 }],
  compartilhadasEntreBairros: [{ city: 'Fortaleza', secao: '0159', bairros: ['Centro', 'Aldeota'] }],
  sectionAudits: [{ city: 'Fortaleza', zona: '01', secao: '0159', bairros: ['Centro'], prometidos: 3, apurado: 2, entregue: 2, faltante: 1, compartilhada: false, status: 'faltante' }],
  hierarchy: [{ cabo: 'Cabo Amostra', subcabos: [{ subcabo: 'Subcabo Amostra', cidades: [{ city: 'Fortaleza', bairros: [{ bairro: 'Centro', prometidos: 3, entregue: 2, faltante: 1, cobertura: 66.7, secoes: [{ secao: '0159', zona: '01', prometidos: 3, apurado: 2, entregue: 2, faltante: 1, status: 'faltante', eleitores: ['Ana Exemplo', 'Bia Exemplo', 'Caio Exemplo'] }] }] }] }] }],
};

function makeResponse() {
  const chunks = [];
  const res = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  res.setHeader = () => {};
  res.buffer = () => Buffer.concat(chunks);
  return res;
}

function pdfText(buffer) {
  const script = 'import sys; from pypdf import PdfReader; import io; print("\\n".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(sys.stdin.buffer.read())).pages))';
  const result = spawnSync('python3', ['-c', script], { input: buffer, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('PDF geral apresenta os totais, o ranking e seções compartilhadas entre bairros', async () => {
  const res = makeResponse();
  router.pdfBuilders.sendGeneralReportPdf(res, report);
  await new Promise((resolve, reject) => { res.on('finish', resolve); res.on('error', reject); });
  const text = pdfText(res.buffer());
  for (const expected of ['Total prometido', 'Total entregue', 'Total faltante', '66,7%', 'Cabo Amostra', 'Seções compartilhadas entre bairros']) {
    assert.match(text, new RegExp(expected, 'i'));
  }
});
