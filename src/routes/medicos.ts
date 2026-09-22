import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { atendeAmanha, atendeHoje } from "../lib/horario";
import { ErroHttp } from "../lib/erros";
import { serializarVisitaGestor } from "../lib/serializar";
import { exigirAutenticacao, exigirPapel, RequisicaoAutenticada } from "../middleware/auth";

const router = Router();
router.use(exigirAutenticacao);

// Leitura liberada para gestor e consultor (precisa escolher médico/clínica ao agendar).
// Para o consultor, cada médico vem com a última visita enviada e a próxima planejada dele.
router.get("/", async (req: RequisicaoAutenticada, res) => {
  const medicos = await prisma.medicoClinica.findMany({ orderBy: { nomeMedico: "asc" } });

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

  const comStatus = medicos.map((m) => ({
    ...m,
    hoje: atendeHoje(m.padraoHorario),
    amanha: atendeAmanha(m.padraoHorario),
    ultimaVisitaEm: ultima.get(m.id)?.toISOString() ?? null,
    proximaVisitaEm: proxima.get(m.id)?.toISOString() ?? null,
  }));

  const especialidadesExistentes = Array.from(new Set(medicos.map((m) => m.especialidade)));
  const clinicasExistentes = Array.from(new Set(medicos.map((m) => m.clinica))).sort();

  res.json({ medicos: comStatus, especialidadesExistentes, clinicasExistentes });
});

// GET /medicos/:id — ficha da conta com histórico de visitas e materiais apresentados.
// O consultor vê só o próprio histórico com o médico; o gestor vê o de todos.
router.get("/:id", async (req: RequisicaoAutenticada, res) => {
  const medico = await prisma.medicoClinica.findUnique({ where: { id: String(req.params.id) } });
  if (!medico) throw new ErroHttp(404, "Médico não encontrado.");

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
  res.json({
    medico: { ...medico, hoje: atendeHoje(medico.padraoHorario), amanha: atendeAmanha(medico.padraoHorario) },
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

router.post("/", exigirPapel("gestor"), async (req, res) => {
  const parsed = criarSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: "Preencha nome, especialidade, clínica e horário de atendimento." });
  const { nomeMedico, especialidade, clinica, bairro, padraoHorario } = parsed.data;

  const medico = await prisma.medicoClinica.create({
    data: { nomeMedico, especialidade, clinica, bairro: bairro ?? "", padraoHorario, ...limparContato(parsed.data) },
  });
  res.status(201).json({ medico });
});

router.patch("/:id", exigirPapel("gestor"), async (req, res) => {
  const parsed = criarSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: "Dados inválidos." });
  const { nomeMedico, especialidade, clinica, bairro, padraoHorario } = parsed.data;

  const medico = await prisma.medicoClinica.update({
    where: { id: String(req.params.id) },
    data: { nomeMedico, especialidade, clinica, bairro, padraoHorario, ...limparContato(parsed.data) },
  });
  res.json({ medico });
});

router.delete("/:id", exigirPapel("gestor"), async (req, res) => {
  await prisma.medicoClinica.delete({ where: { id: String(req.params.id) } });
  res.json({ ok: true });
});

export default router;
