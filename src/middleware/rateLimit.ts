import rateLimit from "express-rate-limit";

// Login e cadastro só: limite por IP contra força bruta e varredura de e-mails (VULN-02/05 do pentest).
// Guarda o contador em memória do processo — em serverless (Vercel) isso reinicia a cada instância nova,
// então não é uma garantia dura, mas já corta scripts de varredura simples.
export const limitadorAuth = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: "Muitas tentativas. Aguarde alguns minutos e tente de novo." },
});
