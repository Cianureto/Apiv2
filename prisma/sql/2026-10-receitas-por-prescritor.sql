-- ConnectLand — receitas por prescritor (importação dos PDFs da farmácia).
-- Só ADICIONA tabelas; nada é apagado. Pode rodar 'npm run db:push' OU executar este SQL no Supabase.

-- CreateTable
CREATE TABLE "ImportacaoReceitas" (
    "id" TEXT NOT NULL,
    "origem" TEXT NOT NULL DEFAULT 'Farmaland',
    "visitador" TEXT NOT NULL,
    "periodoInicio" DATE NOT NULL,
    "periodoFim" DATE NOT NULL,
    "arquivoNome" TEXT,
    "totalPacientes" INTEGER,
    "consultorId" TEXT,
    "criadoPorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportacaoReceitas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinhaReceita" (
    "id" TEXT NOT NULL,
    "importacaoId" TEXT NOT NULL,
    "registro" TEXT NOT NULL,
    "chave" TEXT NOT NULL,
    "nomeMedico" TEXT NOT NULL,
    "receitas" INTEGER NOT NULL,
    "formulas" INTEGER NOT NULL,
    "valorCentavos" INTEGER NOT NULL,

    CONSTRAINT "LinhaReceita_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ImportacaoReceitas_visitador_periodoInicio_periodoFim_key" ON "ImportacaoReceitas"("visitador", "periodoInicio", "periodoFim");

-- CreateIndex
CREATE INDEX "LinhaReceita_chave_idx" ON "LinhaReceita"("chave");

-- CreateIndex
CREATE INDEX "LinhaReceita_importacaoId_idx" ON "LinhaReceita"("importacaoId");

-- AddForeignKey
ALTER TABLE "ImportacaoReceitas" ADD CONSTRAINT "ImportacaoReceitas_consultorId_fkey" FOREIGN KEY ("consultorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinhaReceita" ADD CONSTRAINT "LinhaReceita_importacaoId_fkey" FOREIGN KEY ("importacaoId") REFERENCES "ImportacaoReceitas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
