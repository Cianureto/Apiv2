-- Pedidos do consultor para puxar um profissional sem consultor para a carteira (o gestor aprova ou recusa).
DO $$ BEGIN
  CREATE TYPE "StatusSolicitacao" AS ENUM ('pendente', 'aprovada', 'recusada', 'cancelada');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "SolicitacaoCarteira" (
  "id"              TEXT NOT NULL,
  "medicoClinicaId" TEXT NOT NULL,
  "consultorId"     TEXT NOT NULL,
  "status"          "StatusSolicitacao" NOT NULL DEFAULT 'pendente',
  "motivo"          TEXT,
  "decididoPorId"   TEXT,
  "decididoEm"      TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SolicitacaoCarteira_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SolicitacaoCarteira_medicoClinicaId_fkey" FOREIGN KEY ("medicoClinicaId") REFERENCES "MedicoClinica"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SolicitacaoCarteira_consultorId_fkey" FOREIGN KEY ("consultorId") REFERENCES "Usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SolicitacaoCarteira_decididoPorId_fkey" FOREIGN KEY ("decididoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "SolicitacaoCarteira_status_createdAt_idx" ON "SolicitacaoCarteira"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "SolicitacaoCarteira_consultorId_status_idx" ON "SolicitacaoCarteira"("consultorId", "status");
CREATE INDEX IF NOT EXISTS "SolicitacaoCarteira_medicoClinicaId_idx" ON "SolicitacaoCarteira"("medicoClinicaId");
-- Não deixa o mesmo consultor ter dois pedidos pendentes do mesmo cadastro (clique duplo, duas abas).
CREATE UNIQUE INDEX IF NOT EXISTS "SolicitacaoCarteira_pendente_unico" ON "SolicitacaoCarteira"("medicoClinicaId", "consultorId") WHERE "status" = 'pendente';

-- A API acessa o banco pelo Prisma (papel postgres); a tabela fica fechada para o acesso público do Supabase.
ALTER TABLE "SolicitacaoCarteira" ENABLE ROW LEVEL SECURITY;
