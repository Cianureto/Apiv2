-- ConnectLand — contatos planejados por profissional em cada ciclo (meta de contatos do painel).
-- Só ADICIONA uma coluna; nada é apagado. Pode rodar 'npm run db:push' OU executar este SQL no Supabase.

ALTER TABLE "MedicoClinica" ADD COLUMN IF NOT EXISTS "contatosCiclo" INTEGER NOT NULL DEFAULT 1;
