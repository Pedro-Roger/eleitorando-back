-- Fila de processamento OCR (jobs assíncronos com logs/auditoria)
CREATE TABLE IF NOT EXISTS "ocr_jobs" (
  id SERIAL PRIMARY KEY,
  status VARCHAR(20) NOT NULL DEFAULT 'queued',
  "createdBy" INT,
  "createdByName" TEXT,
  filename TEXT,
  "imagePath" TEXT,
  result JSONB,
  error TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "finishedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_ocr_jobs_status" ON "ocr_jobs" (status, id);
