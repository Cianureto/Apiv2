import { Router } from "express";
import { z } from "zod";
import type { Ausencia } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { inicioDoDiaStr, limitesDoDia } from "../lib/datas";
import { ErroHttp } from "../lib/erros";
import { exigirAutenticacao, RequisicaoAutenticada } from "../middleware/auth";

const router = Router();
router.use(exigirAutenticacao);

const TIPOS = ["ferias", "treinamento", "outra"] as const;

export function serializarAusencia(a: Ausencia & { consultor?: { id: string; nome: string } }) {
  return {
    id: a.id,
    consultorId: a.consultorId,
    ...(a.consultor ? { consultor: { id: a.consultor.id, nome: a.consultor.nome } } : {}),
    tipo: a.tipo,
    inicio: a.inicio.toISOString(),
    fim: a.fim.toISOString(),
    diaInteiro: a.diaInteiro,
    descricao: a.descricao,
  };
}

/**
 * Datas aceitas: "YYYY-MM-DD" (dia inteiro, no fuso da operação) ou ISO completo.
 * Para dia inteiro, `fim` é estendido até 23:59:59 do último dia.
 */
function resolverPeriodo(inicioStr: string, fimStr: string, diaInteiro: boolean) {
  const soData = /^\d{4}-\d{2}-\d{2}$/;
  const inicio = soData.test(inicioStr) ? inicioDoDiaStr(inicioStr) : new Date(inicioStr);
  const fimBase = soData.test(fimStr) ? inicioDoDiaStr(fimStr) : new Date(fimStr);
  if (!inicio || !fimBase || Number.isNaN(inicio.getTime()) || Number.isNaN(fimBase.getTime())) {
    throw new ErroHttp(400, "Datas inválidas.");
  }
  const inicioFinal = diaInteiro ? limitesDoDia(inicio).inicio : inicio;
  const fimFinal = diaInteiro ? limitesDoDia(fimBase).fim : fimBase;
  if (fimFinal <= inicioFinal) throw new ErroHttp(400, "A data final precisa ser depois da inicial.");
  return { inicio: inicioFinal, fim: fimFinal };
}

async function carregarAusencia(req: RequisicaoAutenticada, id: string) {
  const ausencia = await prisma.ausencia.findUnique({ where: { id } });
  if (!ausencia || (req.usuario!.papel === "consultor" && ausencia.consultorId !== req.usuario!.id)) {
    throw new ErroHttp(404, "Ausência não encontrada.");
  }
  return ausencia;
}

/** Visitas planejadas que ficariam em cima da ausência — a tela avisa o consultor. */
async function contarVisitasAfetadas(consultorId: string, inicio: Date, fim: Date) {
  return prisma.visita.count({
    where: { consultorId, dataHora: { gte: inicio, lt: fim }, status: { in: ["pendente", "confirmado"] } },
  });
}

// GET /ausencias?inicio=ISO&fim=ISO&consultorId=
router.get("/", async (req: RequisicaoAutenticada, res) => {
  const inicio = typeof req.query.inicio === "string" ? new Date(req.query.inicio) : null;
  const fim = typeof req.query.fim === "string" ? new Date(req.query.fim) : null;
  const consultorId =
    req.usuario!.papel === "consultor" ? req.usuario!.id : typeof req.query.consultorId === "string" ? req.query.consultorId : undefined;

  const ausencias = await prisma.ausencia.findMany({
    where: {
      ...(consultorId ? { consultorId } : {}),
      ...(inicio && fim && !Number.isNaN(inicio.getTime()) && !Number.isNaN(fim.getTime()) ? { inicio: { lt: fim }, fim: { gt: inicio } } : {}),
    },
    include: { consultor: { select: { id: true, nome: true } } },
    orderBy: { inicio: "asc" },
  });
  res.json({ ausencias: ausencias.map(serializarAusencia) });
});

const salvarSchema = z.object({
  consultorId: z.string().optional(),
  tipo: z.enum(TIPOS),
  inicio: z.string().min(1),
  fim: z.string().min(1),
  diaInteiro: z.boolean().default(true),
  descricao: z.string().optional(),
});

router.post("/", async (req: RequisicaoAutenticada, res) => {
  const parsed = salvarSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: "Informe o tipo e o período da ausência." });
  const { tipo, diaInteiro, descricao } = parsed.data;

  const consultorId = req.usuario!.papel === "gestor" ? parsed.data.consultorId : req.usuario!.id;
  if (!consultorId) return res.status(400).json({ erro: "Selecione o consultor." });

  const { inicio, fim } = resolverPeriodo(parsed.data.inicio, parsed.data.fim, diaInteiro);
  const ausencia = await prisma.ausencia.create({
    data: { consultorId, tipo, inicio, fim, diaInteiro, descricao: descricao?.trim() || null },
  });

  res.status(201).json({ ausencia: serializarAusencia(ausencia), visitasAfetadas: await contarVisitasAfetadas(consultorId, inicio, fim) });
});

router.patch("/:id", async (req: RequisicaoAutenticada, res) => {
  const parsed = salvarSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: "Informe o tipo e o período da ausência." });
  const atual = await carregarAusencia(req, String(req.params.id));

  const { inicio, fim } = resolverPeriodo(parsed.data.inicio, parsed.data.fim, parsed.data.diaInteiro);
  const ausencia = await prisma.ausencia.update({
    where: { id: atual.id },
    data: { tipo: parsed.data.tipo, inicio, fim, diaInteiro: parsed.data.diaInteiro, descricao: parsed.data.descricao?.trim() || null },
  });
  res.json({ ausencia: serializarAusencia(ausencia), visitasAfetadas: await contarVisitasAfetadas(atual.consultorId, inicio, fim) });
});

router.delete("/:id", async (req: RequisicaoAutenticada, res) => {
  const atual = await carregarAusencia(req, String(req.params.id));
  await prisma.ausencia.delete({ where: { id: atual.id } });
  res.json({ ok: true });
});

export default router;
