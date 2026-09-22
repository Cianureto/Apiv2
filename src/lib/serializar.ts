import type { AmostraEntregue, MedicoClinica, Usuario, Visita } from "@prisma/client";

type VisitaBase = Visita & { medicoClinica: MedicoClinica };
type VisitaComConsultor = VisitaBase & { consultor: Pick<Usuario, "id" | "nome"> };

/** Campos do relatório de visita, comuns às visões do gestor e do consultor. */
function camposRelatorio(v: Visita) {
  return {
    duracaoMin: v.duracaoMin,
    canal: v.canal,
    local: v.local,
    motivo: v.motivo,
    foco: v.foco,
    acompanhada: v.acompanhada,
    acompanhante: v.acompanhante,
    relatorioSalvoEm: v.relatorioSalvoEm?.toISOString() ?? null,
    enviadaEm: v.enviadaEm?.toISOString() ?? null,
  };
}

/** Formato "plano" usado nas telas do consultor (mantém os campos antigos). */
export function serializarVisitaConsultor(v: VisitaBase) {
  return {
    id: v.id,
    dataHora: v.dataHora.toISOString(),
    produto: v.produto,
    status: v.status,
    tipo: v.tipo,
    feedback: v.feedback,
    medicoClinicaId: v.medicoClinicaId,
    medico: v.medicoClinica.nomeMedico,
    especialidade: v.medicoClinica.especialidade,
    clinica: v.medicoClinica.clinica,
    bairro: v.medicoClinica.bairro,
    endereco: v.medicoClinica.endereco,
    ...camposRelatorio(v),
  };
}

/** Formato aninhado usado nas telas do gestor (mantém os campos antigos). */
export function serializarVisitaGestor(v: VisitaComConsultor) {
  return {
    id: v.id,
    dataHora: v.dataHora.toISOString(),
    produto: v.produto,
    status: v.status,
    tipo: v.tipo,
    feedback: v.feedback,
    consultorId: v.consultorId,
    consultor: { id: v.consultor.id, nome: v.consultor.nome },
    medicoClinica: {
      id: v.medicoClinica.id,
      nomeMedico: v.medicoClinica.nomeMedico,
      clinica: v.medicoClinica.clinica,
      bairro: v.medicoClinica.bairro,
    },
    ...camposRelatorio(v),
  };
}

export function serializarAmostra(a: AmostraEntregue) {
  return { id: a.id, produto: a.produto, quantidade: a.quantidade, lote: a.lote };
}
