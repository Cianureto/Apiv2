import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { exigirAutenticacao, exigirPapel } from "../middleware/auth";

const router = Router();
router.use(exigirAutenticacao);

// Leitura liberada para gestor e consultor (precisa escolher o produto ao agendar).
router.get("/", async (_req, res) => {
  const produtos = await prisma.produto.findMany({ orderBy: { nome: "asc" } });
  res.json({ produtos });
});

const criarSchema = z.object({ nome: z.string().min(1) });

router.post("/", exigirPapel("gestor"), async (req, res) => {
  const parsed = criarSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: "Informe o nome do produto." });
  const produto = await prisma.produto.upsert({
    where: { nome: parsed.data.nome },
    update: {},
    create: { nome: parsed.data.nome },
  });
  res.status(201).json({ produto });
});

router.delete("/:id", exigirPapel("gestor"), async (req, res) => {
  await prisma.produto.delete({ where: { id: String(req.params.id) } });
  res.json({ ok: true });
});

export default router;
