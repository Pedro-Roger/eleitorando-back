# Exportação de dados + zona/seção nos cabos — Design

Data: 2026-08-10 · Status: aprovado pelo usuário

## Escopo

1. **Página "Exportar" (só ADMIN)** para compartilhar dados de eleitores em XLSX, CSV, PDF e formato WhatsApp.
2. **Zona e seção no cadastro de cabos/subcabos** (estado, cidade e bairro já existem no modelo User).

## Página Exportar (front, rota /exportar)

- **Filtro de equipe**: lista de cabos com checkbox. Nada marcado = todos os eleitores.
  Ao marcar um cabo que tem subcabos, os subcabos aparecem com checkbox:
  nenhum marcado = cabo + todos os seus subcabos; alguns marcados = só os marcados (+ o próprio cabo).
- **Filtros**: cidade, bairro, gênero (dropdowns com valores existentes no banco; vazio = todos).
- **Colunas**: Nome (sempre), Telefone, Cidade, Bairro, Estado, Gênero, Idade, Zona, Seção, Cadastrado por.
- **Prévia**: "X eleitores serão exportados", atualizada conforme filtros.
- **Formatos**:
  - XLSX (exceljs, cabeçalho formatado)
  - CSV (UTF-8 com BOM, vírgula, campos com aspas)
  - PDF (pdfkit, tabela simples com título e data)
  - WhatsApp: CSV sem cabeçalho `Nome,5585992265252` — telefone só dígitos, prefixo 55
    adicionado se faltar; eleitores sem telefone ficam de fora.

## API

- `GET /export/options` (ADMIN): árvore cabo→subcabos (ativos, não excluídos) +
  listas distintas de cidade/bairro/gênero dos eleitores.
- `GET /export/voters` (ADMIN): params `format`, `columns`, `createdByIds`, `city`,
  `neighborhood`, `gender`, `count=1` (só contagem p/ prévia).
  O front expande a seleção cabo→subcabos e envia a lista final de `createdByIds`;
  vazio = todos (inclui cadastros de usuários já excluídos — dado histórico).
- Registra atividade `DADOS_EXPORTADOS`.
- Novas dependências: `exceljs`, `pdfkit`.

## Zona/seção nos cabos e subcabos

- Prisma: `zone String?` e `section String?` no model User + migração.
- Rotas users: aceitar os campos no POST e PATCH.
- Front: campos opcionais no formulário de criação/edição da Equipe e exibição no detalhe.

## Decisões

- Geração dos arquivos no servidor (não pesa o bundle do celular; filtros no banco).
- Sem exportação de equipe por enquanto (pode entrar depois como aba na mesma página).
