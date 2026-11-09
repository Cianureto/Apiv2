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
import { chaveProfissional, contatosFeitosNoCiclo } from "../lib/ciclo";
import { filtroGrupo, pedirParaCarteira } from "../lib/carteira";

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
// (que ele pode pedir para a carteira; o gestor aprova). O gestor continua vendo todos.
// `escopo=carteira` traz só os do consultor (vínculo fixo); `escopo=livres`, só os ainda sem responsável
// (o "limbo", que ele consulta quando quer puxar alguém). Sem escopo, o consultor recebe os dois juntos.
router.get("/", async (req: RequisicaoAutenticada, res) => {
  const ehConsultor = req.usuario!.papel === "consultor";
  const escopo = req.query.escopo;
  const where: Prisma.MedicoClinicaWhereInput | undefined =
    escopo === "livres"
      ? { consultorId: null }
      : ehConsultor
        ? escopo === "carteira"
          ? { consultorId: req.usuario!.id }
          : visivelParaConsultor(req.usuario!.id)
        : undefined;
  const medicos = await prisma.medicoClinica.findMany({
    where,
    include: { consultor: { select: { nome: true } } },
    orderBy: { nomeMedico: "asc" },
  });

  const ultima = new Map<string, Date>();
  const proxima = new Map<string, Date>();
  let feitosNoCiclo = new Map<string, number>();
  // No limbo, o consultor vê em cada profissional o pedido dele: pendente ou recusado (últimos 30 dias).
  const meusPedidos = new Map<string, { id: string; status: "pendente" | "recusada"; motivo: string | null }>();
  if (ehConsultor && escopo === "livres") {
    const pedidos = await prisma.solicitacaoCarteira.findMany({
      where: {
        consultorId: req.usuario!.id,
        OR: [{ status: "pendente" }, { status: "recusada", decididoEm: { gte: new Date(Date.now() - 30 * 86400000) } }],
      },
      include: { medicoClinica: { select: { id: true, grupoId: true } } },
      orderBy: { createdAt: "asc" },
    });
    for (const p of pedidos) {
      const k = chaveProfissional(p.medicoClinica);
      if (meusPedidos.get(k)?.status === "pendente") continue;
      meusPedidos.set(k, { id: p.id, status: p.status as "pendente" | "recusada", motivo: p.motivo });
    }
  }
  if (ehConsultor) {
    feitosNoCiclo = await contatosFeitosNoCiclo(req.usuario!.id);
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
    // Visitas realizadas pelo consultor neste ciclo, somando todos os endereços do profissional.
    contatosFeitosNoCiclo: ehConsultor ? (feitosNoCiclo.get(chaveProfissional(m)) ?? 0) : null,
    minhaSolicitacao: m.consultorId === null ? (meusPedidos.get(chaveProfissional(m)) ?? null) : null,
  }));

  const especialidadesExistentes = Array.from(new Set(medicos.map((m) => m.especialidade).filter(Boolean)));
  const clinicasExistentes = Array.from(new Set(medicos.map((m) => m.clinica).filter(Boolean))).sort();

  res.json({ medicos: comStatus, especialidadesExistentes, clinicasExistentes });
});

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
    erro = `${quem} já está cadastrado, ainda sem consultor. Peça para a sua carteira para usar o cadastro existente (o gestor aprova).`;
  }
  const podeAbrir = req.usuario!.papel === "gestor" || !existente.consultorId || existente.consultorId === req.usuario!.id;
  // Consultor tentando cadastrar alguém que já está sem responsável: a tela oferece pedir para a carteira dele.
  const podeAssumir = req.usuario!.papel === "consultor" && !existente.consultorId;
  return { erro, medicoExistenteId: podeAbrir ? existente.id : null, podeAssumir };
}

// Gestor edita/exclui qualquer médico. Consultor só os da carteira dele: um sem consultor ele pede
// para a carteira e o gestor aprova (editar, adicionar endereço ou remover não tomam mais o profissional).
async function exigirDonoOuGestorMedico(req: RequisicaoAutenticada, res: Response, next: NextFunction) {
  const medico = await prisma.medicoClinica.findUnique({ where: { id: String(req.params.id) }, select: { consultorId: true } });
  if (!medico) throw new ErroHttp(404, "Médico não encontrado.");
  if (req.usuario!.papel === "gestor" || medico.consultorId === req.usuario!.id) return next();
  const erro = medico.consultorId === null
    ? "Esse profissional ainda não tem consultor. Peça para a sua carteira; depois que o gestor aprovar, você pode alterar o cadastro."
    : "Esse médico já está cadastrado com outro consultor.";
  return res.status(403).json({ erro });
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
        contatosCiclo: base.contatosCiclo,
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

  const medico = await prisma.$transaction(async (tx) => {
    await tx.medicoClinica.updateMany({ where: filtroGrupo(atual), data: identidade });
    return tx.medicoClinica.update({ where: { id: atual.id }, data: endereco });
  });
  res.json({ medico });
});

// POST /medicos/:id/assumir — o consultor pede para levar à carteira dele um profissional ainda sem
// consultor (todos os endereços dele). Fica pendente até o gestor aprovar em /solicitacoes.
router.post("/:id/assumir", async (req: RequisicaoAutenticada, res) => {
  if (req.usuario!.papel !== "consultor") return res.status(403).json({ erro: "Só o consultor pede profissionais para a carteira." });
  const { solicitacao, jaEraSeu } = await pedirParaCarteira(req.usuario!.id, String(req.params.id));
  if (jaEraSeu) return res.json({ ok: true, jaEraSeu: true });
  res.status(202).json({ ok: true, pendente: true, solicitacao: { id: solicitacao!.id, status: solicitacao!.status, motivo: solicitacao!.motivo } });
});

const contatosSchema = z.object({
  contatosCiclo: z.number({ message: "Informe a quantidade de contatos." }).int().min(1, "O mínimo é 1 contato por ciclo.").max(4, "O máximo é 4 contatos por ciclo (primeira visita + 3 revisitas)."),
});

// PATCH /medicos/:id/contatos — quantos contatos o consultor planeja ter com o profissional por ciclo
// (1 = só a primeira visita). Quem decide é o consultor responsável; vale para todos os endereços.
router.patch("/:id/contatos", async (req: RequisicaoAutenticada, res) => {
  const parsed = contatosSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: primeiraMensagem(parsed.error) });
  const medico = await prisma.medicoClinica.findUnique({ where: { id: String(req.params.id) }, select: { id: true, grupoId: true, consultorId: true } });
  if (!medico) throw new ErroHttp(404, "Médico não encontrado.");
  if (req.usuario!.papel !== "consultor" || medico.consultorId !== req.usuario!.id) {
    const erro = medico.consultorId === null
      ? "Peça o profissional para a sua carteira antes de definir os contatos do ciclo."
      : "Só o consultor responsável define os contatos do ciclo.";
    return res.status(403).json({ erro });
  }
  await prisma.medicoClinica.updateMany({ where: filtroGrupo(medico), data: { contatosCiclo: parsed.data.contatosCiclo } });
  res.json({ contatosCiclo: parsed.data.contatosCiclo });
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
