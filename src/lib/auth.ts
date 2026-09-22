import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

const JWT_SECRET = process.env.JWT_SECRET as string;

export type SessionPayload = {
  userId: string;
  papel: "gestor" | "consultor";
  nome: string;
};

export function hashSenha(senha: string) {
  return bcrypt.hash(senha, 10);
}

export function verificarSenha(senha: string, hash: string) {
  return bcrypt.compare(senha, hash);
}

export function assinarSessao(payload: SessionPayload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

export function verificarToken(token: string): SessionPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as SessionPayload;
  } catch {
    return null;
  }
}
