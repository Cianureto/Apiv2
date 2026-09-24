import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth";
import painelRoutes from "./routes/painel";
import consultoresRoutes from "./routes/consultores";
import visitasRoutes from "./routes/visitas";
import consultorRoutes from "./routes/consultor";
import medicosRoutes from "./routes/medicos";
import produtosRoutes from "./routes/produtos";
import usuariosRoutes from "./routes/usuarios";
import ausenciasRoutes from "./routes/ausencias";
import materiaisRoutes from "./routes/materiais";
import apresentacoesRoutes from "./routes/apresentacoes";
import { ErroHttp } from "./lib/erros";

const app = express();
// Necessário na Vercel (atrás de proxy) para o rate limiter e req.ip lerem o IP real do cliente.
app.set("trust proxy", 1);

const ORIGENS_PERMITIDAS = [
  "http://localhost:5173",
  "https://connectland-app.vercel.app",
  ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",").map((o) => o.trim()) : []),
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || ORIGENS_PERMITIDAS.includes(origin)) return callback(null, true);
      callback(new Error("Origem não permitida pelo CORS."));
    },
  })
);
// Limite maior por causa das imagens dos slides (o front já comprime antes de enviar).
app.use(express.json({ limit: "5mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/auth", authRoutes);
app.use("/painel", painelRoutes);
app.use("/consultores", consultoresRoutes);
app.use("/visitas", visitasRoutes);
app.use("/consultor", consultorRoutes);
app.use("/medicos", medicosRoutes);
app.use("/produtos", produtosRoutes);
app.use("/usuarios", usuariosRoutes);
app.use("/ausencias", ausenciasRoutes);
app.use("/materiais", materiaisRoutes);
app.use("/apresentacoes", apresentacoesRoutes);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ErroHttp) return res.status(err.status).json({ erro: err.message, ...(err.detalhes ? { detalhes: err.detalhes } : {}) });
  if (err && typeof err === "object" && "type" in err && err.type === "entity.too.large") {
    return res.status(413).json({ erro: "Arquivo grande demais para enviar." });
  }
  // Registro inexistente no Prisma (ex.: update/delete com id errado).
  if (err && typeof err === "object" && "code" in err && err.code === "P2025") return res.status(404).json({ erro: "Registro não encontrado." });
  console.error(err);
  const mensagem = err instanceof Error ? err.message : "Erro interno do servidor.";
  res.status(500).json({ erro: mensagem });
});

export default app;
