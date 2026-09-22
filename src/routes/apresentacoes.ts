import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { limitesDoDia } from "../lib/datas";
import { ErroHttp } from "../lib/erros";
import { exigirAutenticacao, exigirPapel, RequisicaoAutenticada } from "../middleware/auth";

const router = Router();
router.use(exigirAutenticacao, exigirPapel("consultor"));

const registroSchema = z.object({
  materialId: z.string().min(1),
  medicoClinicaId: z.string().min(1),
  visitaId: z.string().optional(),
  inicio: z.string().min(1),
  fim: z.string().min(1),
  slides: z.array(z.object({ slideId: z.string(), segundos: z.number().min(0) })).default([]),
});

// POST /apresentacoes/registros
// Ao terminar uma apresentação, o consultor escolhe para qual médico ela foi feita.
// O registro é ligado à visita informada; se não houver, à visita de hoje com esse médico;
// se também não houver, uma visita nova é criada agora para o relatório ser preenchido.
router.post("/registros", async (req: RequisicaoAutenticada, res) => {
  const parsed = registroSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: "Selecione o médico para registrar a apresentação." });
  const consultorId = req.usuario!.id;
  const { materialId, medicoClinicaId, slides } = parsed.data;

  const inicio = new Date(parsed.data.inicio);
  const fim = new Date(parsed.data.fim);
  if (Number.isNaN(inicio.getTime()) || Number.isNaN(fim.getTime()) || fim < inicio) throw new ErroHttp(400, "Período da apresentação inválido.");

  const [material, medico] = await Promise.all([
    prisma.material.findUnique({ where: { id: materialId }, select: { id: true, produto: true } }),
    prisma.medicoClinica.findUnique({ where: { id: medicoClinicaId }, select: { id: true } }),
  ]);
  if (!material) throw new ErroHttp(404, "Material não encontrado.");
  if (!medico) throw new ErroHttp(404, "Médico não encontrado.");

  let visita = parsed.data.visitaId
    ? await prisma.visita.findFirst({ where: { id: parsed.data.visitaId, consultorId } })
    : await prisma.visita.findFirst({
        where: {
          consultorId,
          medicoClinicaId,
          status: { in: ["pendente", "confirmado"] },
          dataHora: { gte: limitesDoDia(inicio).inicio, lte: limitesDoDia(inicio).fim },
        },
        orderBy: { dataHora: "asc" },
      });

  if (parsed.data.visitaId && !visita) throw new ErroHttp(404, "Visita não encontrada.");
  if (visita && visita.status === "realizado") throw new ErroHttp(422, "Essa visita já foi enviada. Escolha outra ou registre sem visita.");
  if (visita && visita.status === "cancelado") throw new ErroHttp(422, "Essa visita está cancelada.");
  if (visita && visita.medicoClinicaId !== medicoClinicaId) throw new ErroHttp(422, "A visita escolhida é de outro médico.");

  let visitaCriada = false;
  const duracaoSeg = Math.round((fim.getTime() - inicio.getTime()) / 1000);

  if (!visita) {
    const inicioArredondado = new Date(inicio);
    inicioArredondado.setUTCMinutes(Math.floor(inicioArredondado.getUTCMinutes() / 15) * 15, 0, 0);
    visita = await prisma.visita.create({
      data: {
        consultorId,
        medicoClinicaId,
        dataHora: inicioArredondado,
        duracaoMin: Math.max(15, Math.ceil(duracaoSeg / 60 / 15) * 15),
        produto: material.produto,
        canal: "presencial",
        status: "pendente",
      },
    });
    visitaCriada = true;
  } else if (!visita.produto && material.produto) {
    await prisma.visita.update({ where: { id: visita.id }, data: { produto: material.produto } });
  }

  const registro = await prisma.registroApresentacao.create({
    data: { materialId, consultorId, medicoClinicaId, visitaId: visita.id, inicio, fim, duracaoSeg, slidesVistos: slides },
  });

  res.status(201).json({ registro: { id: registro.id }, visitaId: visita.id, visitaCriada });
});

export default router;
