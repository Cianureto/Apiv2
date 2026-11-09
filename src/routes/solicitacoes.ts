import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { somarDias } from "../lib/datas";
import { ErroHttp } from "../lib/erros";
import { aprovarPedido, recusarPedido } from "../lib/carteira";
import { exigirAutenticacao, exigirPapel, RequisicaoAutenticada } from "../middleware/auth";

// Pedidos de consultores para puxar profissionais sem consultor para a carteira (o gestor aprova ou recusa).
const router = Router();
router.use(exigirAutenticacao);

const chave = (m: { id: string; grupoId: string | null }) => m.grupoId ?? m.id;

// GET /solicitacoes?situacao=pendentes|respondidas — gestor vê os de todos; consultor, só os dele.
// "respondidas" traz as dos últimos 30 dias.
router.get("/", async (req: RequisicaoAutenticada, res) => {
  const ehGestor = req.usuario!.papel === "gestor";
  const respondidas = req.query.situacao === "respondidas";
  const where: Prisma.SolicitacaoCarteiraWhereInput = {
    ...(ehGestor ? {} : { consultorId: req.usuario!.id }),
    ...(respondidas ? { status: { in: ["aprovada", "recusada"] }, decididoEm: { gte: somarDias(new Date(), -30) } } : { status: "pendente" }),
  };
  const pedidos = await prisma.solicitacaoCarteira.findMany({
    where,
    include: {
      medicoClinica: { select: { id: true, grupoId: true, nomeMedico: true, profissao: true, especialidade: true, crm: true, clinica: true, bairro: true, cidade: true, uf: true } },
      consultor: { select: { id: true, nome: true } },
      decididoPor: { select: { nome: true } },
    },
    orderBy: respondidas ? { decididoEm: "desc" } : { createdAt: "asc" },
    take: 200,
  });

  // Quantos endereços cada profissional tem e, para o gestor, se outros consultores pediram o mesmo.
  const grupos = [...new Set(pedidos.map((p) => p.medicoClinica.grupoId).filter((g): g is string => !!g))];
  const [porGrupo, pendentesPorProfissional, carteiras] = await Promise.all([
    grupos.length ? prisma.medicoClinica.groupBy({ by: ["grupoId"], where: { grupoId: { in: grupos } }, _count: true }) : [],
    ehGestor && !respondidas ? Promise.resolve(pedidos) : Promise.resolve([]),
    ehGestor
      ? prisma.medicoClinica.groupBy({ by: ["consultorId"], where: { consultorId: { in: [...new Set(pedidos.map((p) => p.consultorId))] } }, _count: true })
      : [],
  ]);
  const enderecos = new Map(porGrupo.map((g) => [g.grupoId, g._count]));
  const pedidosPor = new Map<string, number>();
  for (const p of pendentesPorProfissional) pedidosPor.set(chave(p.medicoClinica), (pedidosPor.get(chave(p.medicoClinica)) ?? 0) + 1);
  const tamanhoCarteira = new Map(carteiras.map((c) => [c.consultorId, c._count]));

  res.json({
    solicitacoes: pedidos.map((p) => {
      const { grupoId, ...medico } = p.medicoClinica;
      return {
        id: p.id,
        status: p.status,
        motivo: p.motivo,
        criadaEm: p.createdAt.toISOString(),
        decididaEm: p.decididoEm?.toISOString() ?? null,
        decididaPor: ehGestor ? (p.decididoPor?.nome ?? null) : null,
        consultor: p.consultor,
        medico,
        enderecos: grupoId ? (enderecos.get(grupoId) ?? 1) : 1,
        // Gestor: outros consultores pedindo o mesmo profissional ao mesmo tempo, e o tamanho da carteira de quem pede.
        outrosPedidos: ehGestor ? Math.max(0, (pedidosPor.get(chave(p.medicoClinica)) ?? 1) - 1) : 0,
        carteiraDoConsultor: ehGestor ? (tamanhoCarteira.get(p.consultorId) ?? 0) : null,
      };
    }),
  });
});

// GET /solicitacoes/resumo — contador do alerta no menu do gestor (e dos pedidos do consultor).
router.get("/resumo", async (req: RequisicaoAutenticada, res) => {
  const pendentes = await prisma.solicitacaoCarteira.count({
    where: { status: "pendente", ...(req.usuario!.papel === "gestor" ? {} : { consultorId: req.usuario!.id }) },
  });
  res.json({ pendentes });
});

router.post("/:id/aprovar", exigirPapel("gestor"), async (req: RequisicaoAutenticada, res) => {
  const r = await aprovarPedido(String(req.params.id), req.usuario!.id);
  res.json({ ok: true, ...r });
});

const recusarSchema = z.object({ motivo: z.string().trim().max(300).optional() });

router.post("/:id/recusar", exigirPapel("gestor"), async (req: RequisicaoAutenticada, res) => {
  const parsed = recusarSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ erro: "O motivo pode ter até 300 caracteres." });
  await recusarPedido(String(req.params.id), req.usuario!.id, parsed.data.motivo || null);
  res.json({ ok: true });
});

// DELETE /solicitacoes/:id — o consultor desiste de um pedido que ainda não foi respondido.
router.delete("/:id", exigirPapel("consultor"), async (req: RequisicaoAutenticada, res) => {
  const { count } = await prisma.solicitacaoCarteira.updateMany({
    where: { id: String(req.params.id), consultorId: req.usuario!.id, status: "pendente" },
    data: { status: "cancelada" },
  });
  if (count === 0) throw new ErroHttp(409, "Esse pedido já foi respondido pelo gestor.");
  res.json({ ok: true });
});

export default router;
