import { Response, NextFunction } from "express";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { atendeAmanha, atendeHoje } from "../lib/horario";
import { ErroHttp } from "../lib/erros";
import { serializarVisitaGestor } from "../lib/serializar";
import { exigirAutenticacao, RequisicaoAutenticada } from "../middleware/auth";

const router = Router();
router.use(exigirAutenticacao);

// Campos de identificação pessoal do médico que o consultor não precisa para o trabalho de campo
// (agenda, contas, mapa) — ficam de fora da resposta para esse papel. Ver VULN-01 do pentest de 24/09/2026.
const CAMPOS_SO_GESTOR = ["cpf", "dtNascimento", "cep", "celMedico", "telClinica", "observacao"] as const;

function paraConsultor<T extends Record<string, unknown>>(m: T): Omit<T, (typeof CAMPOS_SO_GESTOR)[number]> {
  const copia = { ...m };
  for (const campo of CAMPOS_SO_GESTOR) delete copia[campo];
  return copia;
}

// Leitura liberada para gestor e consultor (precisa escolher médico/clínica ao agendar).
// Para o consultor, cada médico vem com a última visita enviada e a próxima planejada dele.
// Um médico só pode ter um consultor responsável: o consultor só vê os seus + os ainda sem dono
// (que ele pode "assumir" ao editar). O gestor continua vendo todos.
router.get("/", async (req: RequisicaoAutenticada, res) => {
  const ehConsultorPapel = req.usuario!.papel === "consultor";
  const medicos = await prisma.medicoClinica.findMany({
    where: ehConsultorPapel ? { OR: [{ consultorId: req.usuario!.id }, { consultorId: null }] } : undefined,
    include: ehConsultorPapel ? undefined : { consultor: { select: { nome: true } } },
    orderBy: { nomeMedico: "asc" },
  });

  const ultima = new Map<string, Date>();
  const proxima = new Map<string, Date>();
  if (req.usuario!.papel === "consultor") {
    const agora = new Date();
    const [enviadas, futuras] = await Promise.all([
      prisma.visita.groupBy({ by: ["medicoClinicaId"], where: { consultorId: req.usuario!.id, status: "realizado" }, _max: { dataHora: true } }),
      prisma.visita.groupBy({
        by: ["medicoClinicaId"],
        where: { consultorId: req.usuario!.id, status: { in: ["pendente", "confirmado"] }, dataHora: { gte: agora } },
        _min: { dataHora: true },
      }),
    ]);
    for (const e of enviadas) if (e._max.dataHora) ultima.set(e.medicoClinicaId, e._max.dataHora);
    for (const f of futuras) if (f._min.dataHora) proxima.set(f.medicoClinicaId, f._min.dataHora);
  }

  const ehConsultor = req.usuario!.papel === "consultor";
  const comStatus = medicos.map((m) => {
    const { consultor, ...base } = m as typeof m & { consultor?: { nome: string } | null };
    return {
      ...(ehConsultor ? paraConsultor(base) : base),
      consultorNome: consultor?.nome ?? null,
      hoje: atendeHoje(m.padraoHorario),
      amanha: atendeAmanha(m.padraoHorario),
      ultimaVisitaEm: ultima.get(m.id)?.toISOString() ?? null,
      proximaVisitaEm: proxima.get(m.id)?.toISOString() ?? null,
    };
  });

  const especialidadesExistentes = Array.from(new Set(medicos.map((m) => m.especialidade)));
  const clinicasExistentes = Array.from(new Set(medicos.map((m) => m.clinica))).sort();

  res.json({ medicos: comStatus, especialidadesExistentes, clinicasExistentes });
});

// GET /medicos/:id — ficha da conta com histórico de visitas e materiais apresentados.
// O consultor vê só o próprio histórico com o médico; o gestor vê o de todos.
router.get("/:id", async (req: RequisicaoAutenticada, res) => {
  const medico = await prisma.medicoClinica.findUnique({
    where: { id: String(req.params.id) },
    include: { consultor: { select: { nome: true } } },
  });
  if (!medico) throw new ErroHttp(404, "Médico não encontrado.");
  if (req.usuario!.papel === "consultor" && medico.consultorId && medico.consultorId !== req.usuario!.id) {
    throw new ErroHttp(404, "Médico não encontrado.");
  }

  const filtroConsultor = req.usuario!.papel === "consultor" ? { consultorId: req.usuario!.id } : {};
  const [visitas, apresentacoes] = await Promise.all([
    prisma.visita.findMany({
      where: { medicoClinicaId: medico.id, ...filtroConsultor },
      include: { consultor: true, medicoClinica: true },
      orderBy: { dataHora: "desc" },
      take: 30,
    }),
    prisma.registroApresentacao.findMany({
      where: { medicoClinicaId: medico.id, ...filtroConsultor },
      include: { material: { select: { id: true, titulo: true, codigo: true } } },
      orderBy: { inicio: "desc" },
      take: 10,
    }),
  ]);

  const agora = new Date();
  const { consultor, ...medicoSemRelacao } = medico;
  const medicoBase = req.usuario!.papel === "consultor" ? paraConsultor(medicoSemRelacao) : medicoSemRelacao;
  res.json({
    medico: {
      ...medicoBase,
      consultorNome: consultor?.nome ?? null,
      hoje: atendeHoje(medico.padraoHorario),
      amanha: atendeAmanha(medico.padraoHorario),
    },
    proximaVisita: visitas
      .filter((v) => v.dataHora >= agora && v.status !== "cancelado")
      .map(serializarVisitaGestor)
      .at(-1) ?? null,
    visitas: visitas.map(serializarVisitaGestor),
    apresentacoes: apresentacoes.map((a) => ({ id: a.id, material: a.material, inicio: a.inicio.toISOString(), duracaoSeg: a.duracaoSeg, visitaId: a.visitaId })),
  });
});

const camposContato = {
  crm: z.string().optional(),
  endereco: z.string().optional(),
  cidade: z.string().optional(),
  uf: z.string().max(2).optional(),
  cep: z.string().optional(),
  telefone: z.string().optional(),
  email: z.string().email().or(z.literal("")).optional(),
};

const criarSchema = z.object({
  nomeMedico: z.string().min(1),
  especialidade: z.string().min(1),
  clinica: z.string().min(1),
  bairro: z.string().optional(),
  padraoHorario: z.string().min(1),
  ...camposContato,
});

function limparContato(d: Partial<Record<keyof typeof camposContato, string | undefined>>) {
  const limpo = (v?: string) => (v === undefined ? undefined : v.trim() || null);
  return {
    crm: limpo(d.crm),
    endereco: limpo(d.endereco),
    cidade: limpo(d.cidade),
    uf: limpo(d.uf)?.toUpperCase() ?? (d.uf === undefined ? undefined : null),
    cep: limpo(d.cep),
    telefone: limpo(d.telefone),
    email: limpo(d.email)?.toLowerCase() ?? (d.email === undefined ? undefined : null),
  };
}

// Um médico não pode ter mais de um consultor responsável. Detecta duplicidade pelo CRM (se
// informado) ou por endereço+cidade, e bloqueia se o registro encontrado já for de outro
// consultor. Se for do próprio consultor (ou sem dono), não é duplicidade — devolve null.
async function medicoDuplicadoDeOutroConsultor(
  dados: { crm?: string | null; endereco?: string | null; cidade?: string | null },
  consultorId: string,
  ignorarId?: string,
) {
  const condicoes: Record<string, unknown>[] = [];
  if (dados.crm) condicoes.push({ crm: dados.crm });
  if (dados.endereco && dados.cidade) condicoes.push({ endereco: dados.endereco, cidade: dados.cidade });
  if (condicoes.length === 0) return null;

  const existente = await prisma.medicoClinica.findFirst({
    where: { OR: condicoes, ...(ignorarId ? { id: { not: ignorarId } } : {}) },
    select: { id: true, nomeMedico: true, consultorId: true },
  });
  if (!existente || existente.consultorId === consultorId) return null;
  return existente;
}

// Gestor edita/exclui qualquer médico. Consultor só o seu ou um ainda sem dono (e, ao editar um
// sem dono, assume a responsabilidade por ele).
async function exigirDonoOuGestorMedico(req: RequisicaoAutenticada, res: Response, next: NextFunction) {
  const medico = await prisma.medicoClinica.findUnique({ where: { id: String(req.params.id) }, select: { consultorId: true } });
  if (!medico) throw new ErroHttp(404, "Médico não encontrado.");
  const ehDono = req.usuario!.papel === "gestor" || medico.consultorId === null || medico.consultorId === req.usuario!.id;
  if (!ehDono) return res.status(403).json({ erro: "Esse médico já está cadastrado com outro consultor." });
  next();
}

router.post("/", async (req: RequisicaoAutenticada, res) => {
  const parsed = criarSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: "Preencha nome, especialidade, clínica e horário de atendimento." });
  const { nomeMedico, especialidade, clinica, bairro, padraoHorario } = parsed.data;
  const contato = limparContato(parsed.data);

  if (req.usuario!.papel === "consultor") {
    const duplicado = await medicoDuplicadoDeOutroConsultor(contato, req.usuario!.id);
    if (duplicado) {
      return res.status(409).json({
        erro: `Esse médico já está cadastrado com outro consultor (${duplicado.nomeMedico}).`,
        medicoExistenteId: duplicado.id,
      });
    }
  }

  const medico = await prisma.medicoClinica.create({
    data: {
      nomeMedico,
      especialidade,
      clinica,
      bairro: bairro ?? "",
      padraoHorario,
      ...contato,
      consultorId: req.usuario!.papel === "consultor" ? req.usuario!.id : null,
    },
  });
  res.status(201).json({ medico });
});

router.patch("/:id", exigirDonoOuGestorMedico, async (req: RequisicaoAutenticada, res) => {
  const parsed = criarSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: "Dados inválidos." });
  const { nomeMedico, especialidade, clinica, bairro, padraoHorario } = parsed.data;
  const contato = limparContato(parsed.data);

  if (req.usuario!.papel === "consultor") {
    const duplicado = await medicoDuplicadoDeOutroConsultor(contato, req.usuario!.id, String(req.params.id));
    if (duplicado) {
      return res.status(409).json({
        erro: `Esse médico já está cadastrado com outro consultor (${duplicado.nomeMedico}).`,
        medicoExistenteId: duplicado.id,
      });
    }
  }

  const medico = await prisma.medicoClinica.update({
    where: { id: String(req.params.id) },
    data: {
      nomeMedico,
      especialidade,
      clinica,
      bairro,
      padraoHorario,
      ...contato,
      // Consultor que edita um registro ainda sem dono assume a responsabilidade por ele.
      ...(req.usuario!.papel === "consultor" ? { consultorId: req.usuario!.id } : {}),
    },
  });
  res.json({ medico });
});

router.delete("/:id", exigirDonoOuGestorMedico, async (req, res) => {
  const visitas = await prisma.visita.count({ where: { medicoClinicaId: String(req.params.id) } });
  if (visitas > 0) {
    return res.status(409).json({ erro: "Esse médico já tem visitas registradas e não pode ser removido." });
  }
  await prisma.medicoClinica.delete({ where: { id: String(req.params.id) } });
  res.json({ ok: true });
});

// GET /medicos/:id/grupo — outros endereços/clínicas do mesmo médico (mesmo CRM, ou mesmo nome
// quando não há CRM), para a ficha de Contas listar junto e permitir adicionar/editar/remover.
router.get("/:id/grupo", async (req: RequisicaoAutenticada, res) => {
  const medico = await prisma.medicoClinica.findUnique({ where: { id: String(req.params.id) } });
  if (!medico) throw new ErroHttp(404, "Médico não encontrado.");

  const ehConsultor = req.usuario!.papel === "consultor";
  if (ehConsultor && medico.consultorId && medico.consultorId !== req.usuario!.id) {
    throw new ErroHttp(404, "Médico não encontrado.");
  }

  const condicaoGrupo = medico.crm ? { crm: medico.crm } : { nomeMedico: medico.nomeMedico };
  const grupo = await prisma.medicoClinica.findMany({
    where: {
      ...condicaoGrupo,
      ...(ehConsultor ? { OR: [{ consultorId: req.usuario!.id }, { consultorId: null }] } : {}),
    },
    orderBy: { createdAt: "asc" },
  });

  res.json({ enderecos: grupo.map((m) => (ehConsultor ? paraConsultor(m) : m)) });
});

export default router;
