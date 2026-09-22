import { Request, Response, NextFunction } from "express";
import { verificarToken, SessionPayload } from "../lib/auth";
import { prisma } from "../lib/prisma";

export interface RequisicaoAutenticada extends Request {
  usuario?: {
    id: string;
    nome: string;
    email: string;
    papel: "gestor" | "consultor";
    regiao: string | null;
    telefone: string | null;
    status: "ativo" | "pendente" | "inativo";
    metaComparecimento: number;
  };
}

export async function exigirAutenticacao(req: RequisicaoAutenticada, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ erro: "Não autenticado." });

  const payload: SessionPayload | null = verificarToken(token);
  if (!payload) return res.status(401).json({ erro: "Sessão inválida ou expirada." });

  const usuario = await prisma.usuario.findUnique({ where: { id: payload.userId } });
  if (!usuario || usuario.status !== "ativo") return res.status(401).json({ erro: "Conta não encontrada ou inativa." });

  req.usuario = {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    papel: usuario.papel,
    regiao: usuario.regiao,
    telefone: usuario.telefone,
    status: usuario.status,
    metaComparecimento: usuario.metaComparecimento,
  };
  next();
}

export function exigirPapel(papel: "gestor" | "consultor") {
  return (req: RequisicaoAutenticada, res: Response, next: NextFunction) => {
    if (req.usuario?.papel !== papel) return res.status(403).json({ erro: "Acesso não autorizado para este papel." });
    next();
  };
}
