import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";

const JWT_SECRET = process.env.JWT_SECRET as string;

export type SessionPayload = {
  userId: string;
  papel: "gestor" | "consultor";
  nome: string;
  jti: string;
};

export function hashSenha(senha: string) {
  return bcrypt.hash(senha, 10);
}

export function verificarSenha(senha: string, hash: string) {
  return bcrypt.compare(senha, hash);
}

export function assinarSessao(payload: Omit<SessionPayload, "jti">) {
  return jwt.sign({ ...payload, jti: randomUUID() }, JWT_SECRET, { expiresIn: "7d" });
}

export function verificarToken(token: string): SessionPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as SessionPayload;
  } catch {
    return null;
  }
}
