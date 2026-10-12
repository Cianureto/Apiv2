import { randomUUID } from "crypto";
import { Router, type NextFunction, type Response } from "express";
import { z } from "zod";
import type { MedicoClinica, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { atendeAmanha, atendeHoje } from "../lib/horario";
import { ErroHttp } from "../lib/erros";
import { serializarVisitaGestor } from "../lib/serializar";
import { LISTA_PROFISSOES, UFS, conselhoDaProfissao, formatarRegistro, normalizarNumeroRegistro } from "../lib/profissional";
import { exigirAutenticacao, RequisicaoAutenticada } from "../middleware/auth";

const router = Router();
router.use(exigirAutenticacao);

// Dados pessoais que o consultor nunca recebe, nem dos médicos da carteira dele (VULN-01 do pentest de 24/09/2026).
const CAMPOS_PRIVADOS = ["cpf", "dtNascimento", "observacao", "telClinica"] as const;
// Dos médicos ainda sem responsável, também não recebe contato pessoal nem CEP.
const CAMPOS_SO_GESTOR = [...CAMPOS_PRIVADOS, "cep", "celMedico"] as const;

function paraConsultor<T extends { consultorId: string | null }>(m: T, consultorId: string) {
  const copia: Record<string, unknown> = { ...m };
  for (const campo of m.consultorId === consultorId ? CAMPOS_PRIVADOS : CAMPOS_SO_GESTOR) delete copia[campo];
  return copia as Omit<T, (typeof CAMPOS_SO_GESTOR)[number]> & Partial<Pick<MedicoClinica, "cep" | "celMedico">>;
}

const visivelParaConsultor = (consultorId: string): Prisma.MedicoClinicaWhereInput => ({ OR: [{ consultorId }, { consultorId: null }] });

// Leitura liberada para gestor e consultor (precisa escolher médico/clínica ao agendar).
// Para o consultor, cada médico vem com a última visita enviada e a próxima planejada dele.
// Um médico só pode ter um consultor responsável: o consultor só vê os seus + os ainda sem dono
// (que ele pode "assumir" ao editar). O gestor continua vendo todos.
router.get("/", async (req: RequisicaoAutenticada, res) => {
  const ehConsultor = req.usuario!.papel === "consultor";
  const medicos = await prisma.medicoClinica.findMany({
    where: ehConsultor ? visivelParaConsultor(req.usuario!.id) : undefined,
    include: { consultor: { select: { nome: true } } },
    orderBy: { nomeMedico: "asc" },
  });

  const ultima = new Map<string, Date>();
  const proxima = new Map<string, Date>();
  if (ehConsultor) {
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

  const comStatus = medicos.map(({ consultor, ...m }) => ({
    ...(ehConsultor ? paraConsultor(m, req.usuario!.id) : m),
    consultorNome: ehConsultor ? null : (consultor?.nome ?? null),
    hoje: atendeHoje(m.padraoHorario),
    amanha: atendeAmanha(m.padraoHorario),
    ultimaVisitaEm: ultima.get(m.id)?.toISOString() ?? null,
    proximaVisitaEm: proxima.get(m.id)?.toISOString() ?? null,
  }));

  const especialidadesExistentes = Array.from(new Set(medicos.map((m) => m.especialidade).filter(Boolean)));
  const clinicasExistentes = Array.from(new Set(medicos.map((m) => m.clinica).filter(Boolean))).sort();

  res.json({ medicos: comStatus, especialidadesExistentes, clinicasExistentes });
});

/** Endereços do mesmo profissional: mesmo grupoId (cadastros antigos sem grupo ficam sozinhos). */
function filtroGrupo(m: Pick<MedicoClinica, "id" | "grupoId">): Prisma.MedicoClinicaWhereInput {
  return m.grupoId ? { grupoId: m.grupoId } : { id: m.id };
}

async function carregarVisivel(req: RequisicaoAutenticada, id: string) {
  const medico = await prisma.medicoClinica.findUnique({ where: { id }, include: { consultor: { select: { nome: true } } } });
  if (!medico) throw new ErroHttp(404, "Médico não encontrado.");
  if (req.usuario!.papel === "consultor" && medico.consultorId && medico.consultorId !== req.usuario!.id) {
    throw new ErroHttp(404, "Médico não encontrado.");
  }
  return medico;
}

// GET /medicos/:id — ficha da conta com histórico de visitas e materiais apresentados.
// O consultor vê só o próprio histórico com o médico; o gestor vê o de todos.
router.get("/:id", async (req: RequisicaoAutenticada, res) => {
  const { consultor, ...medico } = await carregarVisivel(req, String(req.params.id));

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
  const ehConsultor = req.usuario!.papel === "consultor";
  res.json({
    medico: {
      ...(ehConsultor ? paraConsultor(medico, req.usuario!.id) : medico),
      consultorNome: ehConsultor ? null : (consultor?.nome ?? null),
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

// GET /medicos/:id/grupo — todos os endereços/locais de atendimento do mesmo profissional.
router.get("/:id/grupo", async (req: RequisicaoAutenticada, res) => {
  const medico = await carregarVisivel(req, String(req.params.id));
  const ehConsultor = req.usuario!.papel === "consultor";
  const grupo = await prisma.medicoClinica.findMany({
    where: { AND: [filtroGrupo(medico), ehConsultor ? visivelParaConsultor(req.usuario!.id) : {}] },
    orderBy: { createdAt: "asc" },
  });
  res.json({ enderecos: grupo.map((m) => (ehConsultor ? paraConsultor(m, req.usuario!.id) : m)) });
});

const texto = z.string().trim().max(300).optional();

// Dados do profissional (iguais em todos os endereços dele).
const identidadeSchema = z.object({
  profissao: z.enum(LISTA_PROFISSOES, { message: "Escolha a profissão." }),
  conselhoUf: z.enum(UFS, { message: "Escolha o estado." }),
  registroNumero: texto,
  nomeMedico: z.string().trim().min(1, "Informe o nome.").max(200),
  especialidade: texto,
  email: z.string().trim().email("E-mail inválido.").or(z.literal("")).optional(),
  celMedico: texto,
});

// Dados de cada endereço / local de atendimento.
const enderecoSchema = z.object({
  cep: texto,
  endereco: texto,
  complemento: texto,
  bairro: texto,
  cidade: texto,
  uf: z.string().trim().max(2).optional(),
  clinica: texto,
  telefone: texto,
  padraoHorario: z.string().trim().min(1, "Informe o horário de atendimento de cada endereço."),
});

const criarSchema = identidadeSchema.extend({ enderecos: z.array(enderecoSchema).min(1).max(10) });
const editarSchema = identidadeSchema.merge(enderecoSchema);

const vazioParaNull = (v?: string | null) => (v === undefined ? undefined : v?.trim() || null);

function dadosIdentidade(d: z.infer<typeof identidadeSchema>) {
  const conselho = conselhoDaProfissao(d.profissao);
  const registroNumero = conselho ? normalizarNumeroRegistro(d.registroNumero) : null;
  return {
    profissao: d.profissao,
    conselho,
    conselhoUf: d.conselhoUf,
    registroNumero,
    crm: formatarRegistro(conselho, d.conselhoUf, registroNumero),
    nomeMedico: d.nomeMedico.trim(),
    especialidade: d.especialidade?.trim() ?? "",
    email: vazioParaNull(d.email)?.toLowerCase() ?? null,
    celMedico: vazioParaNull(d.celMedico) ?? null,
  };
}

function dadosEndereco(e: z.infer<typeof enderecoSchema>) {
  const bairro = e.bairro?.trim() ?? "";
  return {
    cep: vazioParaNull(e.cep) ?? null,
    endereco: vazioParaNull(e.endereco) ?? null,
    complemento: vazioParaNull(e.complemento) ?? null,
    bairro,
    cidade: vazioParaNull(e.cidade) ?? null,
    uf: vazioParaNull(e.uf)?.toUpperCase() ?? null,
    // Telas e relatórios mostram "especialidade · clínica"; sem nome de local, cai no bairro.
    clinica: e.clinica?.trim() || bairro || "Consultório",
    telefone: vazioParaNull(e.telefone) ?? null,
    padraoHorario: e.padraoHorario.trim(),
  };
}

type Identidade = ReturnType<typeof dadosIdentidade>;

/**
 * Um profissional não pode ter mais de um consultor. Procura outro cadastro do mesmo profissional:
 * pelo registro (conselho + UF + número) ou, sem registro, pelo mesmo nome no mesmo endereço.
 */
async function buscarDuplicado(id: Identidade, endereco: string | null, ignorar?: Pick<MedicoClinica, "id" | "grupoId">) {
  const ignorarGrupo: Prisma.MedicoClinicaWhereInput = ignorar ? { NOT: filtroGrupo(ignorar) } : {};
  if (id.conselho && id.registroNumero) {
    return prisma.medicoClinica.findFirst({
      where: { conselho: id.conselho, conselhoUf: id.conselhoUf, registroNumero: id.registroNumero, ...ignorarGrupo },
      include: { consultor: { select: { nome: true } } },
    });
  }
  if (!endereco) return null;
  return prisma.medicoClinica.findFirst({
    where: {
      nomeMedico: { equals: id.nomeMedico, mode: "insensitive" },
      endereco: { equals: endereco, mode: "insensitive" },
      ...ignorarGrupo,
    },
    include: { consultor: { select: { nome: true } } },
  });
}

function erroDuplicado(req: RequisicaoAutenticada, existente: NonNullable<Awaited<ReturnType<typeof buscarDuplicado>>>) {
  const quem = existente.nomeMedico;
  let erro: string;
  if (req.usuario!.papel === "gestor") {
    erro = `${quem} já está cadastrado${existente.consultor ? ` (responsável: ${existente.consultor.nome})` : ""}. Para outro endereço, use "Adicionar endereço" na ficha.`;
  } else if (existente.consultorId === req.usuario!.id) {
    erro = `${quem} já está na sua carteira. Para incluir outro endereço, use "Adicionar endereço" na ficha.`;
  } else if (existente.consultorId) {
    erro = `${quem} já está cadastrado com outro consultor.`;
  } else {
    erro = `${quem} já está cadastrado, ainda sem consultor. Abra a ficha e edite para assumir.`;
  }
  const podeAbrir = req.usuario!.papel === "gestor" || !existente.consultorId || existente.consultorId === req.usuario!.id;
  return { erro, medicoExistenteId: podeAbrir ? existente.id : null };
}

// Gestor edita/exclui qualquer médico. Consultor só o seu ou um ainda sem dono (e, ao editar um
// sem dono, assume a responsabilidade por ele e pelos outros endereços dele).
async function exigirDonoOuGestorMedico(req: RequisicaoAutenticada, res: Response, next: NextFunction) {
  const medico = await prisma.medicoClinica.findUnique({ where: { id: String(req.params.id) }, select: { consultorId: true } });
  if (!medico) throw new ErroHttp(404, "Médico não encontrado.");
  const ehDono = req.usuario!.papel === "gestor" || medico.consultorId === null || medico.consultorId === req.usuario!.id;
  if (!ehDono) return res.status(403).json({ erro: "Esse médico já está cadastrado com outro consultor." });
  next();
}

const primeiraMensagem = (e: z.ZodError) => e.issues[0]?.message ?? "Dados inválidos.";

// POST /medicos — cadastra o profissional com um ou mais endereços (cada um com seu horário).
router.post("/", async (req: RequisicaoAutenticada, res) => {
  const parsed = criarSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: primeiraMensagem(parsed.error) });
  const identidade = dadosIdentidade(parsed.data);
  const enderecos = parsed.data.enderecos.map(dadosEndereco);

  const duplicado = await buscarDuplicado(identidade, enderecos[0].endereco);
  if (duplicado) return res.status(409).json(erroDuplicado(req, duplicado));

  const grupoId = randomUUID();
  const consultorId = req.usuario!.papel === "consultor" ? req.usuario!.id : null;
  const criados = await prisma.$transaction(
    enderecos.map((e) => prisma.medicoClinica.create({ data: { ...identidade, ...e, grupoId, consultorId } })),
  );
  res.status(201).json({ medico: criados[0], enderecos: criados.length });
});

// POST /medicos/:id/enderecos — novo endereço para um profissional já cadastrado.
router.post("/:id/enderecos", exigirDonoOuGestorMedico, async (req: RequisicaoAutenticada, res) => {
  const parsed = enderecoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: primeiraMensagem(parsed.error) });
  const base = await prisma.medicoClinica.findUniqueOrThrow({ where: { id: String(req.params.id) } });

  const grupoId = base.grupoId ?? randomUUID();
  const consultorId = req.usuario!.papel === "consultor" ? req.usuario!.id : base.consultorId;
  const criado = await prisma.$transaction(async (tx) => {
    await tx.medicoClinica.updateMany({ where: filtroGrupo(base), data: { grupoId, consultorId } });
    return tx.medicoClinica.create({
      data: {
        profissao: base.profissao,
        conselho: base.conselho,
        conselhoUf: base.conselhoUf,
        registroNumero: base.registroNumero,
        crm: base.crm,
        nomeMedico: base.nomeMedico,
        especialidade: base.especialidade,
        email: base.email,
        celMedico: base.celMedico,
        ...dadosEndereco(parsed.data),
        grupoId,
        consultorId,
      },
    });
  });
  res.status(201).json({ medico: criado });
});

// PATCH /medicos/:id — dados do profissional valem para todos os endereços dele; os do endereço, só para este.
router.patch("/:id", exigirDonoOuGestorMedico, async (req: RequisicaoAutenticada, res) => {
  const parsed = editarSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: primeiraMensagem(parsed.error) });
  const atual = await prisma.medicoClinica.findUniqueOrThrow({ where: { id: String(req.params.id) } });
  const identidade = dadosIdentidade(parsed.data);
  const endereco = dadosEndereco(parsed.data);

  const duplicado = await buscarDuplicado(identidade, endereco.endereco, atual);
  if (duplicado) return res.status(409).json(erroDuplicado(req, duplicado));

  // Consultor que edita um registro ainda sem dono assume a responsabilidade por ele.
  const dono = req.usuario!.papel === "consultor" ? { consultorId: req.usuario!.id } : {};
  const medico = await prisma.$transaction(async (tx) => {
    await tx.medicoClinica.updateMany({ where: filtroGrupo(atual), data: { ...identidade, ...dono } });
    return tx.medicoClinica.update({ where: { id: atual.id }, data: endereco });
  });
  res.json({ medico });
});

router.delete("/:id", exigirDonoOuGestorMedico, async (req, res) => {
  const visitas = await prisma.visita.count({ where: { medicoClinicaId: String(req.params.id) } });
  if (visitas > 0) {
    return res.status(409).json({ erro: "Esse endereço já tem visitas registradas e não pode ser removido." });
  }
  await prisma.medicoClinica.delete({ where: { id: String(req.params.id) } });
  res.json({ ok: true });
});

export default router;
