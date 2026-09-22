import { Router } from "express";
import { prisma } from "../lib/prisma";
import { exigirAutenticacao, exigirPapel } from "../middleware/auth";

const router = Router();
router.use(exigirAutenticacao, exigirPapel("gestor"));

router.get("/", async (_req, res) => {
  const usuarios = await prisma.usuario.findMany({
    orderBy: [{ papel: "asc" }, { nome: "asc" }],
    select: { id: true, nome: true, email: true, papel: true, status: true, regiao: true },
  });
  res.json({ usuarios });
});

export default router;
