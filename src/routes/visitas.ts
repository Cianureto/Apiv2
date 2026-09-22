import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { dataHoraDeCampos, limitesDaSemana, limitesDoMes, somarDias } from "../lib/datas";
import { ErroHttp } from "../lib/erros";
import { validarJanelaRegistro, validarNaoFutura, validarSemAusencia } from "../lib/regras";
import { serializarAmostra, serializarVisitaGestor } from "../lib/serializar";
import { exigirAutenticacao, exigirPapel, RequisicaoAutenticada } from "../middleware/auth";

const router = Router();
router.use(exigirAutenticacao);

const CANAIS = ["presencial", "virtual_teams", "virtual_zoom", "chamada_video", "telefone", "outro"] as const;

const incluirBasico = { consultor: true, medicoClinica: true } as const;

/** Aceita `dataHora` (ISO, vindo do arrastar na agenda) ou `data` + `hora` (formulários). */
const campoDataHora = {
  dataHora: z.string().optional(),
  data: z.string().optional(),
  hora: z.string().optional(),
};

function resolverDataHora(body: { dataHora?: string; data?: string; hora?: string }): Date | null {
  if (body.dataHora) {
    const d = new Date(body.dataHora);
    if (Number.isNaN(d.getTime())) throw new ErroHttp(400, "Data e hora inválidas.");
    return d;
  }
  if (body.data && body.hora) {
    const d = dataHoraDeCampos(body.data, body.hora);
    if (!d) throw new ErroHttp(400, "Data e hora inválidas.");
    return d;
  }
  return null;
}

/** Carrega a visita garantindo que o consultor só mexe nas próprias; o gestor mexe em todas. */
async function carregarVisita(req: RequisicaoAutenticada, id: string) {
  const visita = await prisma.visita.findUnique({ where: { id }, include: incluirBasico });
  if (!visita) throw new ErroHttp(404, "Visita não encontrada.");
  if (req.usuario!.papel === "consultor" && visita.consultorId !== req.usuario!.id) throw new ErroHttp(404, "Visita não encontrada.");
  return visita;
}

function exigirEditavel(visita: { status: string }) {
  if (visita.status === "realizado") throw new ErroHttp(422, "Essa visita já foi enviada e não pode mais ser alterada.");
  if (visita.status === "cancelado") throw new ErroHttp(422, "Essa visita está cancelada.");
}

// GET /visitas?periodo=semana|mes&offsetSemana=0&mes=YYYY-MM&consultorId=
router.get("/", exigirPapel("gestor"), async (req, res) => {
  const periodo = req.query.periodo === "mes" ? "mes" : "semana";
  const consultorId = typeof req.query.consultorId === "string" ? req.query.consultorId : undefined;

  let inicio: Date, fim: Date;
  if (periodo === "semana") {
    const offset = Number(req.query.offsetSemana ?? 0) || 0;
    ({ inicio, fim } = limitesDaSemana(somarDias(new Date(), offset * 7)));
  } else {
    const mesParam = typeof req.query.mes === "string" && /^\d{4}-\d{2}$/.test(req.query.mes) ? req.query.mes : "";
    const referencia = mesParam ? dataHoraDeCampos(`${mesParam}-15`, "12:00")! : new Date();
    ({ inicio, fim } = limitesDoMes(referencia));
  }

  const visitas = await prisma.visita.findMany({
    where: { dataHora: { gte: inicio, lte: fim }, ...(consultorId ? { consultorId } : {}) },
    include: incluirBasico,
    orderBy: { dataHora: "asc" },
  });

  res.json({ visitas: visitas.map(serializarVisitaGestor), inicio: inicio.toISOString(), fim: fim.toISOString() });
});

// GET /visitas/:id — relatório completo (amostras e materiais apresentados).
router.get("/:id", async (req: RequisicaoAutenticada, res) => {
  await carregarVisita(req, String(req.params.id));
  const visita = await prisma.visita.findUniqueOrThrow({
    where: { id: String(req.params.id) },
    include: {
      ...incluirBasico,
      amostras: true,
      apresentacoes: { include: { material: { select: { id: true, titulo: true, codigo: true } } }, orderBy: { inicio: "asc" } },
    },
  });

  const m = visita.medicoClinica;
  res.json({
    visita: {
      ...serializarVisitaGestor(visita),
      medicoClinica: {
        id: m.id,
        nomeMedico: m.nomeMedico,
        especialidade: m.especialidade,
        clinica: m.clinica,
        bairro: m.bairro,
        endereco: m.endereco,
        cidade: m.cidade,
        uf: m.uf,
        telefone: m.telefone,
        email: m.email,
      },
      amostras: visita.amostras.map(serializarAmostra),
      apresentacoes: visita.apresentacoes.map((a) => ({
        id: a.id,
        material: a.material,
        inicio: a.inicio.toISOString(),
        duracaoSeg: a.duracaoSeg,
        totalSlidesVistos: Array.isArray(a.slidesVistos) ? a.slidesVistos.length : 0,
      })),
    },
  });
});

const criarSchema = z.object({
  consultorId: z.string().min(1).optional(),
  medicoClinicaId: z.string().min(1),
  ...campoDataHora,
  produto: z.string().optional(),
  duracaoMin: z.number().int().min(5).max(600).optional(),
  canal: z.enum(CANAIS).optional(),
});

// Gestor pode criar para qualquer consultor; consultor só cria para si mesmo
// (o campo consultorId enviado pelo consultor é ignorado, por segurança).
router.post("/", async (req: RequisicaoAutenticada, res) => {
  const parsed = criarSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: "Preencha todos os campos do agendamento." });
  const { medicoClinicaId, produto, duracaoMin = 30, canal } = parsed.data;

  const dataHora = resolverDataHora(parsed.data);
  if (!dataHora) return res.status(400).json({ erro: "Informe a data e a hora da visita." });

  let consultorId: string;
  if (req.usuario!.papel === "gestor") {
    if (!parsed.data.consultorId) return res.status(400).json({ erro: "Selecione o consultor." });
    consultorId = parsed.data.consultorId;
  } else {
    consultorId = req.usuario!.id;
  }

  validarJanelaRegistro(dataHora);
  await validarSemAusencia(consultorId, dataHora, duracaoMin);

  const visita = await prisma.visita.create({
    data: {
      consultorId,
      medicoClinicaId,
      dataHora,
      duracaoMin,
      produto: produto?.trim() || null,
      canal: canal ?? null,
      status: "pendente",
    },
    include: incluirBasico,
  });

  res.status(201).json({ visita: serializarVisitaGestor(visita) });
});

const reagendarSchema = z.object({ ...campoDataHora, duracaoMin: z.number().int().min(5).max(600).optional() });

// Arrastar a visita na agenda (ou mudar data/hora no relatório).
router.patch("/:id/reagendar", async (req: RequisicaoAutenticada, res) => {
  const parsed = reagendarSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: "Dados inválidos." });

  const visita = await carregarVisita(req, String(req.params.id));
  exigirEditavel(visita);

  const dataHora = resolverDataHora(parsed.data) ?? visita.dataHora;
  const duracaoMin = parsed.data.duracaoMin ?? visita.duracaoMin;
  validarJanelaRegistro(dataHora);
  await validarSemAusencia(visita.consultorId, dataHora, duracaoMin);

  const atualizada = await prisma.visita.update({ where: { id: visita.id }, data: { dataHora, duracaoMin }, include: incluirBasico });
  res.json({ visita: serializarVisitaGestor(atualizada) });
});

const relatorioSchema = z.object({
  dataHora: z.string().optional(),
  duracaoMin: z.number().int().min(5).max(600).optional(),
  produto: z.string().nullable().optional(),
  canal: z.enum(CANAIS).nullable().optional(),
  local: z.string().nullable().optional(),
  motivo: z.string().nullable().optional(),
  foco: z.string().nullable().optional(),
  acompanhada: z.boolean().optional(),
  acompanhante: z.string().nullable().optional(),
  feedback: z.string().nullable().optional(),
  amostras: z
    .array(z.object({ produto: z.string().min(1), quantidade: z.number().int().min(1).max(999), lote: z.string().nullable().optional() }))
    .optional(),
});

type DadosRelatorio = z.infer<typeof relatorioSchema>;

function texto(v: string | null | undefined) {
  if (v === undefined) return undefined;
  return v?.trim() || null;
}

/** Aplica os campos do relatório (Salvar). Retorna a data/hora efetiva da visita. */
async function salvarRelatorio(visita: Awaited<ReturnType<typeof carregarVisita>>, dados: DadosRelatorio) {
  let dataHora = visita.dataHora;
  if (dados.dataHora) {
    dataHora = new Date(dados.dataHora);
    if (Number.isNaN(dataHora.getTime())) throw new ErroHttp(400, "Data e hora inválidas.");
  }
  const duracaoMin = dados.duracaoMin ?? visita.duracaoMin;

  validarJanelaRegistro(dataHora);
  if (dataHora.getTime() !== visita.dataHora.getTime() || duracaoMin !== visita.duracaoMin) {
    await validarSemAusencia(visita.consultorId, dataHora, duracaoMin);
  }

  await prisma.$transaction(async (tx) => {
    await tx.visita.update({
      where: { id: visita.id },
      data: {
        dataHora,
        duracaoMin,
        produto: texto(dados.produto),
        canal: dados.canal,
        local: texto(dados.local),
        motivo: texto(dados.motivo),
        foco: texto(dados.foco),
        acompanhada: dados.acompanhada,
        acompanhante: dados.acompanhada === false ? null : texto(dados.acompanhante),
        feedback: texto(dados.feedback),
        relatorioSalvoEm: new Date(),
      },
    });
    if (dados.amostras) {
      await tx.amostraEntregue.deleteMany({ where: { visitaId: visita.id } });
      if (dados.amostras.length > 0) {
        await tx.amostraEntregue.createMany({
          data: dados.amostras.map((a) => ({ visitaId: visita.id, produto: a.produto.trim(), quantidade: a.quantidade, lote: a.lote?.trim() || null })),
        });
      }
    }
  });

  return dataHora;
}

// Salvar relatório (rascunho). Só o consultor dono da visita.
router.patch("/:id/relatorio", exigirPapel("consultor"), async (req: RequisicaoAutenticada, res) => {
  const parsed = relatorioSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: "Dados do relatório inválidos." });

  const visita = await carregarVisita(req, String(req.params.id));
  exigirEditavel(visita);
  await salvarRelatorio(visita, parsed.data);

  const atualizada = await prisma.visita.findUniqueOrThrow({ where: { id: visita.id }, include: incluirBasico });
  res.json({ visita: serializarVisitaGestor(atualizada) });
});

// Enviar relatório: salva o que veio no corpo e trava a visita como realizada.
router.post("/:id/enviar", exigirPapel("consultor"), async (req: RequisicaoAutenticada, res) => {
  const parsed = relatorioSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ erro: "Dados do relatório inválidos." });

  const visita = await carregarVisita(req, String(req.params.id));
  exigirEditavel(visita);

  const canal = parsed.data.canal !== undefined ? parsed.data.canal : visita.canal;
  if (!canal) return res.status(422).json({ erro: "Informe o canal da visita (presencial, Teams, Zoom...) antes de enviar." });

  const dataHora = parsed.data.dataHora ? new Date(parsed.data.dataHora) : visita.dataHora;
  validarNaoFutura(dataHora);
  await salvarRelatorio(visita, parsed.data);

  const atualizada = await prisma.visita.update({
    where: { id: visita.id },
    data: { status: "realizado", tipo: canal === "presencial" ? "presencial" : "online", enviadaEm: new Date() },
    include: incluirBasico,
  });
  res.json({ visita: serializarVisitaGestor(atualizada) });
});

const statusSchema = z.object({ status: z.enum(["confirmado", "realizado", "pendente", "cancelado"]) });

router.patch("/:id/status", exigirPapel("gestor"), async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: "Status inválido." });
  await prisma.visita.update({ where: { id: String(req.params.id) }, data: { status: parsed.data.status } });
  res.json({ ok: true });
});

// Consultor cancela a própria visita (sem apagar, para não distorcer os indicadores).
router.patch("/:id/cancelar", async (req: RequisicaoAutenticada, res) => {
  const visita = await carregarVisita(req, String(req.params.id));
  exigirEditavel(visita);
  await prisma.visita.update({ where: { id: visita.id }, data: { status: "cancelado" } });
  res.json({ ok: true });
});

const reatribuirSchema = z.object({ consultorId: z.string().min(1) });

router.patch("/:id/reatribuir", exigirPapel("gestor"), async (req, res) => {
  const parsed = reatribuirSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: "Consultor inválido." });
  await prisma.visita.update({ where: { id: String(req.params.id) }, data: { consultorId: parsed.data.consultorId } });
  res.json({ ok: true });
});

// Gestor exclui qualquer visita; consultor só as próprias que ainda não foram enviadas.
router.delete("/:id", async (req: RequisicaoAutenticada, res) => {
  const visita = await carregarVisita(req, String(req.params.id));
  if (req.usuario!.papel === "consultor" && visita.status === "realizado") {
    throw new ErroHttp(422, "Visitas enviadas não podem ser excluídas.");
  }
  await prisma.visita.delete({ where: { id: visita.id } });
  res.json({ ok: true });
});

const realizarSchema = z.object({
  tipo: z.enum(["online", "presencial"]),
  feedback: z.string().optional(),
});

// Fluxo antigo ("Marcar como realizada"), mantido por compatibilidade.
router.patch("/:id/realizar", exigirPapel("consultor"), async (req: RequisicaoAutenticada, res) => {
  const parsed = realizarSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: "Selecione o tipo da visita (online ou presencial)." });

  const visita = await carregarVisita(req, String(req.params.id));
  exigirEditavel(visita);
  validarJanelaRegistro(visita.dataHora);

  await prisma.visita.update({
    where: { id: visita.id },
    data: {
      status: "realizado",
      tipo: parsed.data.tipo,
      canal: visita.canal ?? (parsed.data.tipo === "presencial" ? "presencial" : "outro"),
      feedback: parsed.data.feedback?.trim() || null,
      enviadaEm: new Date(),
    },
  });
  res.json({ ok: true });
});

export default router;
