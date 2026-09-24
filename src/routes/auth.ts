import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { assinarSessao, hashSenha, verificarSenha } from "../lib/auth";
import { exigirAutenticacao, RequisicaoAutenticada } from "../middleware/auth";
import { limitadorAuth } from "../middleware/rateLimit";

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  senha: z.string().min(1),
});

router.post("/login", limitadorAuth, async (req, res) => {
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

const MENSAGEM_SENHA_FRACA = "A senha precisa ter pelo menos 8 caracteres, incluindo letra e número.";

const senhaForte = z
  .string()
  .min(8, MENSAGEM_SENHA_FRACA)
  .refine((v) => /[a-zA-Z]/.test(v) && /[0-9]/.test(v), MENSAGEM_SENHA_FRACA);

const cadastroSchema = z.object({
  nome: z.string().min(1),
  email: z.string().email(),
  senha: senhaForte,
  regiao: z.string().optional(),
});

const MENSAGEM_CADASTRO_NEUTRA = "Se este e-mail ainda não tiver conta, ela foi enviada para a fila de aprovação do gestor.";

router.post("/cadastro", limitadorAuth, async (req, res) => {
  const parsed = cadastroSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: parsed.error.issues[0]?.message ?? "Preencha nome, e-mail e senha corretamente." });
  const { nome, email, senha, regiao } = parsed.data;

  // Resposta sempre igual, exista ou não a conta — evita que o cadastro sirva de oráculo de e-mails.
  const existente = await prisma.usuario.findUnique({ where: { email: email.toLowerCase() } });
  if (!existente) {
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
  }

  res.status(202).json({ ok: true, mensagem: MENSAGEM_CADASTRO_NEUTRA });
});

router.get("/me", exigirAutenticacao, async (req: RequisicaoAutenticada, res) => {
  res.json({ usuario: req.usuario });
});

router.post("/logout", exigirAutenticacao, async (req: RequisicaoAutenticada, res) => {
  if (req.sessao) {
    await prisma.sessaoRevogada.upsert({
      where: { jti: req.sessao.jti },
      update: {},
      create: { jti: req.sessao.jti, expiraEm: req.sessao.expiraEm },
    });
  }
  res.status(204).end();
});

export default router;
