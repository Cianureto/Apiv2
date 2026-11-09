import type { MedicoClinica, Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { ErroHttp } from "./erros";

/** Endereços do mesmo profissional: mesmo grupoId (cadastros antigos sem grupo ficam sozinhos). */
export function filtroGrupo(m: Pick<MedicoClinica, "id" | "grupoId">): Prisma.MedicoClinicaWhereInput {
  return m.grupoId ? { grupoId: m.grupoId } : { id: m.id };
}

/** Pedidos pendentes de qualquer endereço do profissional. */
function pedidosDoProfissional(m: Pick<MedicoClinica, "id" | "grupoId">): Prisma.SolicitacaoCarteiraWhereInput {
  return { status: "pendente", medicoClinica: filtroGrupo(m) };
}

/**
 * O consultor pede para levar à carteira um profissional sem consultor. Não muda o responsável:
 * fica pendente até o gestor aprovar. Repetir o pedido devolve o que já está pendente.
 */
export async function pedirParaCarteira(consultorId: string, medicoId: string) {
  const medico = await prisma.medicoClinica.findUnique({ where: { id: medicoId }, select: { id: true, grupoId: true, consultorId: true, nomeMedico: true } });
  if (!medico) throw new ErroHttp(404, "Médico não encontrado.");
  if (medico.consultorId === consultorId) return { solicitacao: null, jaEraSeu: true };
  if (medico.consultorId) throw new ErroHttp(409, `${medico.nomeMedico} já está com outro consultor.`);

  const existente = await prisma.solicitacaoCarteira.findFirst({ where: { consultorId, ...pedidosDoProfissional(medico) } });
  if (existente) return { solicitacao: existente, jaEraSeu: false };
  try {
    const solicitacao = await prisma.solicitacaoCarteira.create({ data: { medicoClinicaId: medico.id, consultorId } });
    return { solicitacao, jaEraSeu: false };
  } catch (e) {
    // Clique duplo: o índice único de pendentes barrou o segundo; devolve o primeiro.
    const primeiro = await prisma.solicitacaoCarteira.findFirst({ where: { consultorId, ...pedidosDoProfissional(medico) } });
    if (primeiro) return { solicitacao: primeiro, jaEraSeu: false };
    throw e;
  }
}

/**
 * Gestor aprova: o profissional (todos os endereços) passa para o consultor, desde que continue sem
 * consultor, e os pedidos dos outros consultores pelo mesmo profissional são recusados.
 */
export async function aprovarPedido(id: string, gestorId: string) {
  return prisma.$transaction(async (tx) => {
    const pedido = await tx.solicitacaoCarteira.findUnique({ where: { id }, include: { medicoClinica: true, consultor: { select: { nome: true, status: true } } } });
    if (!pedido) throw new ErroHttp(404, "Pedido não encontrado.");
    if (pedido.status !== "pendente") throw new ErroHttp(409, "Esse pedido já foi respondido.");
    if (pedido.consultor.status !== "ativo") throw new ErroHttp(409, `${pedido.consultor.nome} não está ativo. Recuse o pedido.`);

    const m = pedido.medicoClinica;
    const { count } = await tx.medicoClinica.updateMany({ where: { AND: [filtroGrupo(m), { consultorId: null }] }, data: { consultorId: pedido.consultorId } });
    if (count === 0) throw new ErroHttp(409, `${m.nomeMedico} já tem consultor. Recuse o pedido.`);

    const agora = new Date();
    await tx.solicitacaoCarteira.update({ where: { id }, data: { status: "aprovada", decididoPorId: gestorId, decididoEm: agora } });
    const outros = await tx.solicitacaoCarteira.updateMany({
      where: { id: { not: id }, ...pedidosDoProfissional(m) },
      data: { status: "recusada", motivo: `Ficou com ${pedido.consultor.nome}.`, decididoPorId: gestorId, decididoEm: agora },
    });
    return { enderecos: count, outrosRecusados: outros.count };
  });
}

export async function recusarPedido(id: string, gestorId: string, motivo: string | null) {
  const { count } = await prisma.solicitacaoCarteira.updateMany({
    where: { id, status: "pendente" },
    data: { status: "recusada", motivo, decididoPorId: gestorId, decididoEm: new Date() },
  });
  if (count === 0) {
    const existe = await prisma.solicitacaoCarteira.count({ where: { id } });
    throw new ErroHttp(existe ? 409 : 404, existe ? "Esse pedido já foi respondido." : "Pedido não encontrado.");
  }
}
