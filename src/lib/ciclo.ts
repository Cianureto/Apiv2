import type { MedicoClinica } from "@prisma/client";
import { prisma } from "./prisma";
import { limitesDoMes, partesLocais } from "./datas";
import { diasUteisDoMes } from "./diasUteis";

// Profissões que são estabelecimentos (clínicas, hospitais, academias), não pessoas.
const ESTABELECIMENTOS = new Set(["clinica", "academia"]);

/** Endereços do mesmo profissional compartilham o grupo; cadastros antigos sem grupo ficam sozinhos. */
export const chaveProfissional = (m: Pick<MedicoClinica, "id" | "grupoId">) => m.grupoId ?? m.id;

/** Visitas realizadas no ciclo (mês) atual, somadas por profissional (todos os endereços dele). */
export async function contatosFeitosNoCiclo(consultorId?: string, agora = new Date()) {
  const { inicio, fim } = limitesDoMes(agora);
  const visitas = await prisma.visita.findMany({
    where: { status: "realizado", dataHora: { gte: inicio, lte: fim }, ...(consultorId ? { consultorId } : {}) },
    select: { medicoClinica: { select: { id: true, grupoId: true } } },
  });
  const porProfissional = new Map<string, number>();
  for (const v of visitas) {
    const k = chaveProfissional(v.medicoClinica);
    porProfissional.set(k, (porProfissional.get(k) ?? 0) + 1);
  }
  return porProfissional;
}

/**
 * Execução do ciclo (mês) atual. Cada profissional da carteira tem uma meta de contatos (1 = só a
 * primeira visita; 4 = primeira + 3 revisitas). A meta do ciclo é a soma dessas metas e a cobertura
 * conta, de cada profissional, no máximo o que foi alocado para ele: visitar demais um médico não
 * compensa outro que ficou sem visita. O que passa do alocado aparece como "excedentes".
 * Sem `consultorId`, considera todos os cadastros e todas as visitas.
 */
export async function execucaoDoCiclo(consultorId?: string, agora = new Date()) {
  const [cadastros, feitos] = await Promise.all([
    prisma.medicoClinica.findMany({
      where: consultorId ? { consultorId } : undefined,
      select: { id: true, grupoId: true, profissao: true, contatosCiclo: true, consultorId: true },
    }),
    contatosFeitosNoCiclo(consultorId, agora),
  ]);

  const profissionais = new Map<string, { estabelecimento: boolean; contatos: number; semConsultor: boolean }>();
  for (const m of cadastros) {
    const k = chaveProfissional(m);
    const atual = profissionais.get(k);
    profissionais.set(k, {
      estabelecimento: ESTABELECIMENTOS.has(m.profissao ?? ""),
      contatos: Math.max(atual?.contatos ?? 1, m.contatosCiclo),
      semConsultor: m.consultorId === null,
    });
  }

  let metaContatos = 0, contatosNaMeta = 0, primeiras = 0, revisitas = 0, excedentes = 0;
  let visitados = 0, completos = 0, estabelecimentos = 0, semConsultor = 0;
  for (const [k, p] of profissionais) {
    const feitas = feitos.get(k) ?? 0;
    metaContatos += p.contatos;
    contatosNaMeta += Math.min(feitas, p.contatos);
    excedentes += Math.max(0, feitas - p.contatos);
    if (feitas > 0) {
      visitados++;
      primeiras++;
      revisitas += feitas - 1;
    }
    if (feitas >= p.contatos) completos++;
    if (p.estabelecimento) estabelecimentos++;
    if (p.semConsultor) semConsultor++;
  }

  // Visitas do consultor a profissionais que não estão na carteira dele (contam na produtividade, não na cobertura).
  let foraDaCarteira = 0;
  for (const [k, n] of feitos) if (!profissionais.has(k)) foraDaCarteira += n;

  const realizadas = primeiras + revisitas + foraDaCarteira;
  const dias = diasUteisDoMes(agora, agora);
  const faltam = Math.max(0, metaContatos - contatosNaMeta);
  const { ano, mes } = partesLocais(agora);

  return {
    cadastro: {
      profissionais: profissionais.size - estabelecimentos,
      estabelecimentos,
      total: profissionais.size,
      semConsultor,
    },
    ciclo: {
      mes: `${ano}-${String(mes + 1).padStart(2, "0")}`,
      metaContatos,
      contatosNaMeta,
      cobertura: metaContatos > 0 ? Math.round((contatosNaMeta / metaContatos) * 1000) / 10 : 0,
      realizadas,
      primeiras,
      revisitas,
      excedentes,
      foraDaCarteira,
      profissionaisVisitados: visitados,
      profissionaisCompletos: completos,
      diasUteis: dias,
      mediaPorDiaUtil: dias.transcorridos > 0 ? Math.round((realizadas / dias.transcorridos) * 10) / 10 : 0,
      necessarioPorDiaUtil: dias.restantes > 0 ? Math.round((faltam / dias.restantes) * 10) / 10 : null,
    },
  };
}
