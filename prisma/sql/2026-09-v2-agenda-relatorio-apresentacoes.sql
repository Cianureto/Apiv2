-- ConnectLand v2 — agenda semanal, ausências, relatório de visita e apresentações.
-- Gerado com: prisma migrate diff (schema antigo -> novo). Só ADICIONA colunas/tabelas; nada é apagado.
-- Você pode rodar 'npm run db:push' (recomendado) OU executar este SQL no Supabase.

-- CreateEnum
CREATE TYPE "CanalVisita" AS ENUM ('presencial', 'virtual_teams', 'virtual_zoom', 'chamada_video', 'telefone', 'outro');

-- CreateEnum
CREATE TYPE "TipoAusencia" AS ENUM ('ferias', 'treinamento', 'outra');

-- AlterTable
ALTER TABLE "MedicoClinica" ADD COLUMN     "cep" TEXT,
ADD COLUMN     "cidade" TEXT,
ADD COLUMN     "crm" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "endereco" TEXT,
ADD COLUMN     "telefone" TEXT,
ADD COLUMN     "uf" TEXT;

-- AlterTable
ALTER TABLE "Visita" ADD COLUMN     "acompanhada" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "acompanhante" TEXT,
ADD COLUMN     "canal" "CanalVisita",
ADD COLUMN     "duracaoMin" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "enviadaEm" TIMESTAMP(3),
ADD COLUMN     "foco" TEXT,
ADD COLUMN     "local" TEXT,
ADD COLUMN     "motivo" TEXT,
ADD COLUMN     "relatorioSalvoEm" TIMESTAMP(3),
ALTER COLUMN "produto" DROP NOT NULL;

-- CreateTable
CREATE TABLE "AmostraEntregue" (
    "id" TEXT NOT NULL,
    "visitaId" TEXT NOT NULL,
    "produto" TEXT NOT NULL,
    "quantidade" INTEGER NOT NULL DEFAULT 1,
    "lote" TEXT,

    CONSTRAINT "AmostraEntregue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ausencia" (
    "id" TEXT NOT NULL,
    "consultorId" TEXT NOT NULL,
    "tipo" "TipoAusencia" NOT NULL,
    "inicio" TIMESTAMP(3) NOT NULL,
    "fim" TIMESTAMP(3) NOT NULL,
    "diaInteiro" BOOLEAN NOT NULL DEFAULT true,
    "descricao" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ausencia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Material" (
    "id" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "descricao" TEXT,
    "codigo" TEXT,
    "produto" TEXT,
    "thumbnailUrl" TEXT,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Slide" (
    "id" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "ordem" INTEGER NOT NULL,
    "titulo" TEXT,
    "secao" TEXT,
    "imagemUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Slide_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialFavorito" (
    "usuarioId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaterialFavorito_pkey" PRIMARY KEY ("usuarioId","materialId")
);

-- CreateTable
CREATE TABLE "RegistroApresentacao" (
    "id" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "consultorId" TEXT NOT NULL,
    "medicoClinicaId" TEXT NOT NULL,
    "visitaId" TEXT,
    "inicio" TIMESTAMP(3) NOT NULL,
    "fim" TIMESTAMP(3) NOT NULL,
    "duracaoSeg" INTEGER NOT NULL,
    "slidesVistos" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistroApresentacao_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Ausencia_consultorId_inicio_idx" ON "Ausencia"("consultorId", "inicio");

-- CreateIndex
CREATE INDEX "Slide_materialId_ordem_idx" ON "Slide"("materialId", "ordem");

-- CreateIndex
CREATE INDEX "Visita_consultorId_dataHora_idx" ON "Visita"("consultorId", "dataHora");

-- AddForeignKey
ALTER TABLE "AmostraEntregue" ADD CONSTRAINT "AmostraEntregue_visitaId_fkey" FOREIGN KEY ("visitaId") REFERENCES "Visita"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ausencia" ADD CONSTRAINT "Ausencia_consultorId_fkey" FOREIGN KEY ("consultorId") REFERENCES "Usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Slide" ADD CONSTRAINT "Slide_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialFavorito" ADD CONSTRAINT "MaterialFavorito_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialFavorito" ADD CONSTRAINT "MaterialFavorito_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistroApresentacao" ADD CONSTRAINT "RegistroApresentacao_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistroApresentacao" ADD CONSTRAINT "RegistroApresentacao_consultorId_fkey" FOREIGN KEY ("consultorId") REFERENCES "Usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistroApresentacao" ADD CONSTRAINT "RegistroApresentacao_medicoClinicaId_fkey" FOREIGN KEY ("medicoClinicaId") REFERENCES "MedicoClinica"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistroApresentacao" ADD CONSTRAINT "RegistroApresentacao_visitaId_fkey" FOREIGN KEY ("visitaId") REFERENCES "Visita"("id") ON DELETE SET NULL ON UPDATE CASCADE;

