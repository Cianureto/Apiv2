import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { assinarSessao, hashSenha, verificarSenha } from "../lib/auth";
import { exigirAutenticacao, RequisicaoAutenticada } from "../middleware/auth";

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  senha: z.string().min(1),
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: "Informe e-mail e senha válidos." });
  const { email, senha } = parsed.data;

  const usuario = await prisma.usuario.findUnique({ where: { email: email.toLowerCase() } });
  if (!usuario) return res.status(401).json({ erro: "E-mail ou senha inválidos." });

  const senhaOk = await verificarSenha(senha, usuario.senhaHash);
  if (!senhaOk) return res.status(401).json({ erro: "E-mail ou senha inválidos." });

  if (usuario.status === "pendente") return res.status(403).json({ erro: "Seu cadastro ainda está aguardando aprovação do gestor." });
  if (usuario.status === "inativo") return res.status(403).json({ erro: "Seu acesso foi desativado. Fale com o gestor de campo." });

  const token = assinarSessao({ userId: usuario.id, papel: usuario.papel, nome: usuario.nome });

  res.json({
    token,
    usuario: {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      papel: usuario.papel,
      regiao: usuario.regiao,
      telefone: usuario.telefone,
      metaComparecimento: usuario.metaComparecimento,
    },
  });
});

const cadastroSchema = z.object({
  nome: z.string().min(1),
  email: z.string().email(),
  senha: z.string().min(6),
  regiao: z.string().optional(),
});

router.post("/cadastro", async (req, res) => {
  const parsed = cadastroSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: "Preencha nome, e-mail e senha (mínimo 6 caracteres)." });
  const { nome, email, senha, regiao } = parsed.data;

  const existente = await prisma.usuario.findUnique({ where: { email: email.toLowerCase() } });
  if (existente) return res.status(409).json({ erro: "Já existe uma conta com esse e-mail." });

  await prisma.usuario.create({
    data: {
      nome,
      email: email.toLowerCase(),
      senhaHash: await hashSenha(senha),
      papel: "consultor",
      regiao: regiao || null,
      status: "pendente",
    },
  });

  res.status(201).json({ ok: true });
});

router.get("/me", exigirAutenticacao, async (req: RequisicaoAutenticada, res) => {
  res.json({ usuario: req.usuario });
});

export default router;
