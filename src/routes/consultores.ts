import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { limitesDoMes, mesmodia } from "../lib/datas";
import { exigirAutenticacao, exigirPapel } from "../middleware/auth";

const router = Router();
router.use(exigirAutenticacao, exigirPapel("gestor"));

router.get("/", async (_req, res) => {
  const { inicio: inicioMes, fim: fimMes } = limitesDoMes(new Date());

  const consultores = await prisma.usuario.findMany({
    where: { papel: "consultor" },
    include: { visitas: { where: { dataHora: { gte: inicioMes, lte: fimMes } } } },
    orderBy: { nome: "asc" },
  });

  const resultado = consultores.map((c) => {
    const visitasHoje = c.visitas.filter((v) => mesmodia(v.dataHora, new Date()));
    const visitasMesValidas = c.visitas.filter((v) => v.status !== "cancelado");
    const realizadasMes = c.visitas.filter((v) => v.status === "realizado").length;
    const comparecimento = visitasMesValidas.length > 0 ? Math.round((realizadasMes / visitasMesValidas.length) * 100) : 0;
    const ativasHoje = visitasHoje.filter((v) => v.status !== "cancelado");

    let statusCampo: "Em campo" | "Disponível" | "Offline" = "Offline";
    if (c.status === "ativo") statusCampo = ativasHoje.length > 0 ? "Em campo" : "Disponível";

    return {
      id: c.id,
      nome: c.nome,
      email: c.email,
      regiao: c.regiao,
      telefone: c.telefone,
      status: c.status,
      metaComparecimento: c.metaComparecimento,
      visitasHoje: visitasHoje.length,
      comparecimento,
      statusCampo,
    };
  });

  res.json({ consultores: resultado });
});

router.patch("/:id/aprovar", async (req, res) => {
  await prisma.usuario.update({ where: { id: String(req.params.id) }, data: { status: "ativo" } });
  res.json({ ok: true });
});

router.delete("/:id/recusar", async (req, res) => {
  await prisma.usuario.delete({ where: { id: String(req.params.id) } });
  res.json({ ok: true });
});

const editarSchema = z.object({
  nome: z.string().min(1),
  regiao: z.string().optional(),
  telefone: z.string().optional(),
  metaComparecimento: z.number().min(0).max(100).optional(),
  status: z.enum(["ativo", "inativo"]),
});

router.patch("/:id", async (req, res) => {
  const parsed = editarSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: "Dados inválidos." });
  const { nome, regiao, telefone, metaComparecimento, status } = parsed.data;

  await prisma.usuario.update({
    where: { id: String(req.params.id) },
    data: {
      nome,
      regiao: regiao || null,
      telefone: telefone || null,
      metaComparecimento: metaComparecimento ?? 80,
      status,
    },
  });
  res.json({ ok: true });
});

router.delete("/:id", async (req, res) => {
  await prisma.usuario.delete({ where: { id: String(req.params.id) } });
  res.json({ ok: true });
});

export default router;
