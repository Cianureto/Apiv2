import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { ErroHttp } from "../lib/erros";
import { exigirAutenticacao, exigirPapel, RequisicaoAutenticada } from "../middleware/auth";

// Receitas por prescritor, alimentadas pelos PDFs "Lista de Pacientes - Sintética" da farmácia.
// O front lê o PDF e manda as linhas já estruturadas; aqui só validamos, gravamos e agregamos.

const router = Router();
router.use(exigirAutenticacao);

const MESES_CURTOS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
// Sem receitas nesse intervalo antes do recorte = "retomada" (equivalente aos 84 dias do relatório de exames).
const DIAS_PARA_RETOMADA = 84;
const MESES_TENDENCIA = 6;

/** "CRN-CE-000017791", "CRM 7834/CE", "crm-ce 7834" -> { chave: "CRM-7834", registro: "CRM-CE 7834" }. */
export function normalizarRegistro(bruto: string) {
  const texto = bruto.toUpperCase();
  const conselho = /CRN/.test(texto) ? "CRN" : "CRM";
  const uf = /\b(?:CR[MN])[\s/-]*([A-Z]{2})\b/.exec(texto)?.[1] ?? /\/([A-Z]{2})\b/.exec(texto)?.[1] ?? null;
  const digitos = texto.replace(/\D/g, "").replace(/^0+/, "");
  if (!digitos) return null;
  return { chave: `${conselho}-${digitos}`, registro: `${conselho}${uf ? `-${uf}` : ""} ${digitos}` };
}

const dataStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const diaUtc = (s: string) => new Date(`${s}T00:00:00Z`);
const strDia = (d: Date) => d.toISOString().slice(0, 10);
const chaveMes = (d: Date) => d.toISOString().slice(0, 7);
const rotuloMes = (chave: string) => `${MESES_CURTOS[Number(chave.slice(5, 7)) - 1]}/${chave.slice(2, 4)}`;

function mesesEntre(inicio: string, fim: string) {
  const meses: string[] = [];
  let [a, m] = [Number(inicio.slice(0, 4)), Number(inicio.slice(5, 7))];
  const [af, mf] = [Number(fim.slice(0, 4)), Number(fim.slice(5, 7))];
  while (a < af || (a === af && m <= mf)) {
    meses.push(`${a}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) [a, m] = [a + 1, 1];
  }
  return meses;
}

const importacaoSchema = z.object({
  visitador: z.string().trim().min(1).max(200),
  periodoInicio: dataStr,
  periodoFim: dataStr,
  arquivoNome: z.string().max(300).optional(),
  totalPacientes: z.number().int().min(0).nullable().optional(),
  consultorId: z.string().nullable().optional(),
  substituir: z.boolean().optional(),
  linhas: z
    .array(
      z.object({
        registro: z.string().min(1).max(60),
        nomeMedico: z.string().trim().min(1).max(200),
        receitas: z.number().int().min(0),
        formulas: z.number().int().min(0),
        valorCentavos: z.number().int().min(0),
      })
    )
    .min(1)
    .max(5000),
});

router.post("/importacoes", exigirPapel("gestor"), async (req: RequisicaoAutenticada, res) => {
  const parsed = importacaoSchema.safeParse(req.body);
  if (!parsed.success) throw new ErroHttp(400, "Dados da importação inválidos.", parsed.error.issues);
  const d = parsed.data;
  if (d.periodoFim < d.periodoInicio) throw new ErroHttp(400, "O fim do período é anterior ao início.");

  if (d.consultorId) {
    const consultor = await prisma.usuario.findFirst({ where: { id: d.consultorId, papel: "consultor" } });
    if (!consultor) throw new ErroHttp(400, "Consultor não encontrado.");
  }

  const linhas = d.linhas.map((l) => {
    const reg = normalizarRegistro(l.registro);
    if (!reg) throw new ErroHttp(400, `Registro profissional inválido: ${l.registro}`);
    return { ...reg, nomeMedico: l.nomeMedico, receitas: l.receitas, formulas: l.formulas, valorCentavos: l.valorCentavos };
  });

  const chaveUnica = { visitador: d.visitador, periodoInicio: diaUtc(d.periodoInicio), periodoFim: diaUtc(d.periodoFim) };
  const existente = await prisma.importacaoReceitas.findUnique({ where: { visitador_periodoInicio_periodoFim: chaveUnica } });
  if (existente && !d.substituir) {
    throw new ErroHttp(409, "Já existe uma importação deste visitador para esse período.", { importacaoId: existente.id });
  }

  const criada = await prisma.$transaction(async (tx) => {
    if (existente) await tx.importacaoReceitas.delete({ where: { id: existente.id } });
    return tx.importacaoReceitas.create({
      data: {
        ...chaveUnica,
        arquivoNome: d.arquivoNome,
        totalPacientes: d.totalPacientes ?? null,
        consultorId: d.consultorId ?? null,
        criadoPorId: req.usuario!.id,
        linhas: { create: linhas },
      },
    });
  });

  res.status(201).json({ importacao: { id: criada.id }, substituiu: !!existente });
});

router.get("/importacoes", exigirPapel("gestor"), async (_req, res) => {
  const importacoes = await prisma.importacaoReceitas.findMany({
    include: { consultor: { select: { id: true, nome: true } }, linhas: { select: { receitas: true, formulas: true, valorCentavos: true } } },
    orderBy: [{ periodoInicio: "desc" }, { visitador: "asc" }],
  });
  res.json({
    importacoes: importacoes.map((i) => ({
      id: i.id,
      origem: i.origem,
      visitador: i.visitador,
      periodoInicio: strDia(i.periodoInicio),
      periodoFim: strDia(i.periodoFim),
      arquivoNome: i.arquivoNome,
      totalPacientes: i.totalPacientes,
      consultor: i.consultor,
      createdAt: i.createdAt,
      prescritores: i.linhas.length,
      receitas: i.linhas.reduce((s, l) => s + l.receitas, 0),
      formulas: i.linhas.reduce((s, l) => s + l.formulas, 0),
      valorCentavos: i.linhas.reduce((s, l) => s + l.valorCentavos, 0),
    })),
  });
});

router.patch("/importacoes/:id", exigirPapel("gestor"), async (req, res) => {
  const parsed = z.object({ consultorId: z.string().nullable() }).safeParse(req.body);
  if (!parsed.success) throw new ErroHttp(400, "Consultor inválido.");
  if (parsed.data.consultorId) {
    const consultor = await prisma.usuario.findFirst({ where: { id: parsed.data.consultorId, papel: "consultor" } });
    if (!consultor) throw new ErroHttp(400, "Consultor não encontrado.");
  }
  await prisma.importacaoReceitas.update({ where: { id: String(req.params.id) }, data: { consultorId: parsed.data.consultorId } });
  res.json({ ok: true });
});

router.delete("/importacoes/:id", exigirPapel("gestor"), async (req, res) => {
  await prisma.importacaoReceitas.delete({ where: { id: String(req.params.id) } });
  res.status(204).end();
});

type Agregado = { receitas: number; formulas: number; valorCentavos: number };
const vazio = (): Agregado => ({ receitas: 0, formulas: 0, valorCentavos: 0 });
function somar(a: Agregado, l: Agregado) {
  a.receitas += l.receitas;
  a.formulas += l.formulas;
  a.valorCentavos += l.valorCentavos;
}

// GET /receitas/resumo?inicio=YYYY-MM-DD&fim=YYYY-MM-DD&consultorId=&conselho=CRM|CRN
// Entram no recorte as importações cujo período está inteiro dentro de [inicio, fim].
// Só gestor: tem valores em R$. O consultor usa /carteira, que não expõe valores.
router.get("/resumo", exigirPapel("gestor"), async (req: RequisicaoAutenticada, res) => {
  const q = z
    .object({ inicio: dataStr, fim: dataStr, consultorId: z.string().optional(), conselho: z.enum(["CRM", "CRN"]).optional() })
    .safeParse(req.query);
  if (!q.success) throw new ErroHttp(400, "Informe o período (inicio e fim no formato AAAA-MM-DD).");
  const { inicio, fim } = q.data;
  const consultorFiltro = q.data.consultorId || null;

  const [importacoes, medicos] = await Promise.all([
    prisma.importacaoReceitas.findMany({ include: { linhas: true }, orderBy: { periodoInicio: "asc" } }),
    prisma.medicoClinica.findMany({
      where: { crm: { not: null } },
      select: { id: true, nomeMedico: true, crm: true, especialidade: true, consultorId: true, consultor: { select: { nome: true } } },
    }),
  ]);

  // Vínculo prescritor -> médico cadastrado, pela chave do registro.
  const medicoPorChave = new Map<string, (typeof medicos)[number]>();
  for (const m of medicos) {
    const reg = normalizarRegistro(m.crm!);
    if (reg && !medicoPorChave.has(reg.chave)) medicoPorChave.set(reg.chave, m);
  }

  const noEscopo = (imp: (typeof importacoes)[number], chave: string) => {
    if (q.data.conselho && !chave.startsWith(q.data.conselho)) return false;
    if (!consultorFiltro) return true;
    return imp.consultorId === consultorFiltro || medicoPorChave.get(chave)?.consultorId === consultorFiltro;
  };

  // Todas as linhas visíveis para quem pergunta, com o período da importação.
  const todas = importacoes.flatMap((imp) =>
    imp.linhas
      .filter((l) => noEscopo(imp, l.chave))
      .map((l) => ({ ...l, inicio: strDia(imp.periodoInicio), fim: strDia(imp.periodoFim), mes: chaveMes(imp.periodoInicio) }))
  );
  const noRecorte = todas.filter((l) => l.inicio >= inicio && l.fim <= fim);
  const importacoesNoRecorte = importacoes.filter((i) => strDia(i.periodoInicio) >= inicio && strDia(i.periodoFim) <= fim);

  const total = vazio();
  noRecorte.forEach((l) => somar(total, l));

  // Volume por mês dentro do recorte.
  const meses = mesesEntre(inicio, fim);
  const porMes = new Map(meses.map((m) => [m, vazio()]));
  noRecorte.forEach((l) => porMes.get(l.mes) && somar(porMes.get(l.mes)!, l));

  // Tendência: últimos N meses até o fim do recorte, por prescritor.
  const mesesTendencia = mesesEntre(strDia(new Date(Date.UTC(Number(fim.slice(0, 4)), Number(fim.slice(5, 7)) - MESES_TENDENCIA, 1))), fim);
  const tendencia = new Map<string, number[]>();
  for (const l of todas) {
    const i = mesesTendencia.indexOf(l.mes);
    if (i < 0) continue;
    if (!tendencia.has(l.chave)) tendencia.set(l.chave, mesesTendencia.map(() => 0));
    tendencia.get(l.chave)![i] += l.valorCentavos;
  }

  // Visitas realizadas no recorte (para cruzar "visitado x não visitado").
  const idsMedicos = [...new Set(noRecorte.map((l) => medicoPorChave.get(l.chave)?.id).filter((id): id is string => !!id))];
  const visitas = idsMedicos.length
    ? await prisma.visita.groupBy({
        by: ["medicoClinicaId"],
        where: {
          medicoClinicaId: { in: idsMedicos },
          status: "realizado",
          dataHora: { gte: new Date(`${inicio}T00:00:00-03:00`), lte: new Date(`${fim}T23:59:59.999-03:00`) },
          ...(consultorFiltro ? { consultorId: consultorFiltro } : {}),
        },
        _count: { _all: true },
        _max: { dataHora: true },
      })
    : [];
  const visitasPorMedico = new Map(visitas.map((v) => [v.medicoClinicaId, { quantidade: v._count._all, ultima: v._max.dataHora }]));

  // Ranking por prescritor.
  const porPrescritor = new Map<string, Agregado & { chave: string; registro: string; nome: string }>();
  for (const l of noRecorte) {
    if (!porPrescritor.has(l.chave)) porPrescritor.set(l.chave, { chave: l.chave, registro: l.registro, nome: l.nomeMedico, ...vazio() });
    somar(porPrescritor.get(l.chave)!, l);
  }
  const prescritores = [...porPrescritor.values()]
    .map((p) => {
      const medico = medicoPorChave.get(p.chave);
      const visita = medico ? visitasPorMedico.get(medico.id) : undefined;
      return {
        ...p,
        ticketCentavos: p.receitas ? Math.round(p.valorCentavos / p.receitas) : 0,
        percValor: total.valorCentavos ? p.valorCentavos / total.valorCentavos : 0,
        tendencia: tendencia.get(p.chave) ?? mesesTendencia.map(() => 0),
        medico: medico
          ? { id: medico.id, nome: medico.nomeMedico, especialidade: medico.especialidade, consultor: medico.consultor?.nome ?? null }
          : null,
        visitasNoRecorte: visita?.quantidade ?? 0,
        ultimaVisita: visita?.ultima ?? null,
      };
    })
    .sort((a, b) => b.valorCentavos - a.valorCentavos);

  // Quebras (equivalentes a categoria / convênio / procedência do relatório de exames).
  function quebra(rotulo: (p: (typeof prescritores)[number]) => string) {
    const m = new Map<string, Agregado & { prescritores: number }>();
    for (const p of prescritores) {
      const k = rotulo(p);
      if (!m.has(k)) m.set(k, { ...vazio(), prescritores: 0 });
      somar(m.get(k)!, p);
      m.get(k)!.prescritores += 1;
    }
    return [...m.entries()]
      .map(([item, a]) => ({ item, ...a, percReceitas: total.receitas ? a.receitas / total.receitas : 0 }))
      .sort((a, b) => b.valorCentavos - a.valorCentavos);
  }
  const quebras = {
    conselho: quebra((p) => (p.chave.startsWith("CRN") ? "Nutricionistas (CRN)" : "Médicos (CRM)")),
    consultor: quebra((p) => (p.medico ? (p.medico.consultor ?? "Sem consultor") : "Não cadastrado")),
    visitacao: quebra((p) => (!p.medico ? "Não cadastrado" : p.visitasNoRecorte > 0 ? "Visitado no período" : "Não visitado no período")),
  };

  // Novos no recorte: 1ª vez (nunca apareceu antes) ou retomada (sumiu por DIAS_PARA_RETOMADA+ dias e voltou).
  const limiteRetomada = strDia(new Date(diaUtc(inicio).getTime() - DIAS_PARA_RETOMADA * 86_400_000));
  const ultimaAntes = new Map<string, string>();
  for (const l of todas) {
    if (l.fim >= inicio) continue;
    if ((ultimaAntes.get(l.chave) ?? "") < l.fim) ultimaAntes.set(l.chave, l.fim);
  }
  const primeiroNoRecorte = new Map<string, string>();
  for (const l of noRecorte) if ((primeiroNoRecorte.get(l.chave) ?? "9999") > l.inicio) primeiroNoRecorte.set(l.chave, l.inicio);
  const novos = prescritores
    .map((p) => {
      const anterior = ultimaAntes.get(p.chave);
      const status = !anterior ? "primeira_vez" : anterior < limiteRetomada ? "retomada" : null;
      return status ? { ...p, status, primeiroNoRecorte: primeiroNoRecorte.get(p.chave)! } : null;
    })
    .filter((p): p is NonNullable<typeof p> => !!p);
  const valorNovos = novos.reduce((s, p) => s + p.valorCentavos, 0);

  const datas = todas.map((l) => l.inicio).concat(todas.map((l) => l.fim)).sort();
  const atualizadoEm = importacoes.reduce<Date | null>((max, i) => (!max || i.createdAt > max ? i.createdAt : max), null);
  const pacientes = consultorFiltro || q.data.conselho
    ? null // o total de pacientes vem do PDF inteiro; não dá para recortar por carteira
    : importacoesNoRecorte.reduce((s, i) => s + (i.totalPacientes ?? 0), 0);

  res.json({
    base: {
      receitas: todas.reduce((s, l) => s + l.receitas, 0),
      importacoes: new Set(todas.map((l) => l.importacaoId)).size,
      periodoMin: datas[0] ?? null,
      periodoMax: datas[datas.length - 1] ?? null,
      atualizadoEm,
    },
    kpis: {
      receitas: total.receitas,
      formulas: total.formulas,
      valorCentavos: total.valorCentavos,
      ticketCentavos: total.receitas ? Math.round(total.valorCentavos / total.receitas) : 0,
      prescritores: prescritores.length,
      pacientes,
      importacoes: new Set(noRecorte.map((l) => l.importacaoId)).size,
    },
    meses: meses.map((m) => ({ chave: m, rotulo: rotuloMes(m), ...porMes.get(m)! })),
    mesesTendencia: mesesTendencia.map(rotuloMes),
    prescritores,
    quebras,
    novos: {
      primeiraVez: novos.filter((n) => n.status === "primeira_vez").length,
      retomada: novos.filter((n) => n.status === "retomada").length,
      valorCentavos: valorNovos,
      percValor: total.valorCentavos ? valorNovos / total.valorCentavos : 0,
      diasRetomada: DIAS_PARA_RETOMADA,
      itens: novos,
    },
  });
});

// GET /receitas/carteira?mes=YYYY-MM[&consultorId=] — visão do consultor, sem valores em R$.
// Separa a carteira em grupos de ação a partir das receitas (quantidade) mês a mês.
// Consultor: sempre a própria carteira. Gestor: precisa informar consultorId.
const MESES_SERIE = 6;
const QUEDA_FRACAO = 0.5; // receitas do mês <= metade da média dos (até) 3 meses anteriores com relatório
const QUEDA_MEDIA_MINIMA = 2; // ignora quedas em quem quase não prescreve

router.get("/carteira", async (req: RequisicaoAutenticada, res) => {
  const q = z.object({ mes: z.string().regex(/^\d{4}-\d{2}$/).optional(), consultorId: z.string().optional() }).safeParse(req.query);
  if (!q.success) throw new ErroHttp(400, "Mês inválido (use AAAA-MM).");
  const consultorId = req.usuario!.papel === "consultor" ? req.usuario!.id : q.data.consultorId;
  if (!consultorId) throw new ErroHttp(400, "Informe o consultor.");

  const [importacoes, carteira] = await Promise.all([
    prisma.importacaoReceitas.findMany({ include: { linhas: { select: { chave: true, registro: true, nomeMedico: true, receitas: true } } } }),
    prisma.medicoClinica.findMany({
      where: { consultorId },
      select: { id: true, nomeMedico: true, especialidade: true, clinica: true, crm: true },
      orderBy: { nomeMedico: "asc" },
    }),
  ]);

  const medicoPorChave = new Map<string, (typeof carteira)[number]>();
  const semCrm: { id: string; nome: string; clinica: string }[] = [];
  for (const m of carteira) {
    const reg = m.crm ? normalizarRegistro(m.crm) : null;
    if (reg) medicoPorChave.set(reg.chave, m);
    else semCrm.push({ id: m.id, nome: m.nomeMedico, clinica: m.clinica });
  }

  // Receitas por prescritor e mês, só das linhas que são do consultor (relatório ligado a ele ou médico da carteira).
  const porChave = new Map<string, { registro: string; nome: string; meses: Map<string, number> }>();
  for (const imp of importacoes) {
    const mes = chaveMes(imp.periodoInicio);
    for (const l of imp.linhas) {
      if (imp.consultorId !== consultorId && !medicoPorChave.has(l.chave)) continue;
      if (!porChave.has(l.chave)) porChave.set(l.chave, { registro: l.registro, nome: l.nomeMedico, meses: new Map() });
      const p = porChave.get(l.chave)!;
      p.meses.set(mes, (p.meses.get(mes) ?? 0) + l.receitas);
    }
  }

  const mesesDisponiveis = [...new Set([...porChave.values()].flatMap((p) => [...p.meses.keys()]))].sort();
  const mesRef = q.data.mes && mesesDisponiveis.includes(q.data.mes) ? q.data.mes : mesesDisponiveis[mesesDisponiveis.length - 1];
  const base = { mesesDisponiveis: mesesDisponiveis.map((m) => ({ chave: m, rotulo: rotuloMes(m) })), carteira: carteira.length, semCrm };
  if (!mesRef) return res.json({ ...base, mesReferencia: null });

  const [ano, mes] = mesRef.split("-").map(Number);
  const serieMeses = mesesEntre(strDia(new Date(Date.UTC(ano, mes - MESES_SERIE, 1))), `${mesRef}-01`);

  // Visitas do consultor a esses médicos: última realizada e próxima planejada.
  const idsCarteira = carteira.map((m) => m.id);
  const agora = new Date();
  const [realizadas, planejadas] = idsCarteira.length
    ? await Promise.all([
        prisma.visita.groupBy({ by: ["medicoClinicaId"], where: { consultorId, medicoClinicaId: { in: idsCarteira }, status: "realizado" }, _max: { dataHora: true } }),
        prisma.visita.groupBy({
          by: ["medicoClinicaId"],
          where: { consultorId, medicoClinicaId: { in: idsCarteira }, status: { in: ["pendente", "confirmado"] }, dataHora: { gte: agora } },
          _min: { dataHora: true },
        }),
      ])
    : [[], []];
  const ultimaVisita = new Map(realizadas.map((v) => [v.medicoClinicaId, v._max.dataHora]));
  const proximaVisita = new Map(planejadas.map((v) => [v.medicoClinicaId, v._min.dataHora]));

  function item(chave: string) {
    const p = porChave.get(chave);
    const medico = medicoPorChave.get(chave) ?? null;
    const serie = serieMeses.map((m) => p?.meses.get(m) ?? 0);
    const historico = [...(p?.meses.entries() ?? [])].filter(([m, n]) => m <= mesRef && n > 0).map(([m]) => m).sort();
    return {
      chave,
      registro: p?.registro ?? medico?.crm ?? "",
      nome: medico?.nomeMedico ?? p?.nome ?? "",
      especialidade: medico?.especialidade ?? null,
      medicoId: medico?.id ?? null,
      naCarteira: !!medico,
      receitasMes: serie[serie.length - 1],
      serie,
      mesesAtivos: serie.filter((n) => n > 0).length,
      primeiroMes: historico[0] ?? null,
      ultimoMes: historico[historico.length - 1] ?? null,
      ultimaVisita: medico ? (ultimaVisita.get(medico.id) ?? null) : null,
      proximaVisita: medico ? (proximaVisita.get(medico.id) ?? null) : null,
    };
  }

  const chaves = new Set([...porChave.keys(), ...medicoPorChave.keys()]);
  const itens = [...chaves].map(item);
  // Comparações usam os meses que têm relatório (se faltar o PDF de um mês, ninguém "para" nem "volta" por isso).
  const idxRef = mesesDisponiveis.indexOf(mesRef);
  const mesesAnteriores = mesesDisponiveis.slice(Math.max(0, idxRef - 3), idxRef);
  const mesAnterior = mesesAnteriores[mesesAnteriores.length - 1];
  const receitasEm = (chave: string, m: string | undefined) => (m ? (porChave.get(chave)?.meses.get(m) ?? 0) : 0);

  // Quem não é da carteira já aparece em "foraDaCarteira".
  // Sem mês anterior com relatório não há com o que comparar: ninguém é "novo", "voltou" ou "parou".
  const comparacao = mesesAnteriores.length > 0;
  const novos = comparacao ? itens.filter((i) => i.naCarteira && i.receitasMes > 0 && i.primeiroMes === mesRef) : [];
  const voltaram = itens.filter((i) => i.receitasMes > 0 && i.primeiroMes !== mesRef && !!mesAnterior && receitasEm(i.chave, mesAnterior) === 0);

  type ItemAtencao = ReturnType<typeof item> & { motivo: "parou" | "queda" | "sumiu"; mediaAnterior: number | null };
  const PRIORIDADE = { parou: 0, queda: 1, sumiu: 2 } as const;
  const atencao: ItemAtencao[] = [];
  for (const i of itens) {
    if (!i.ultimoMes) continue;
    if (i.receitasMes === 0) {
      atencao.push({ ...i, motivo: i.ultimoMes === mesAnterior ? "parou" : "sumiu", mediaAnterior: null });
      continue;
    }
    if (!mesesAnteriores.length) continue;
    const media = mesesAnteriores.reduce((s, m) => s + receitasEm(i.chave, m), 0) / mesesAnteriores.length;
    if (media >= QUEDA_MEDIA_MINIMA && i.receitasMes <= media * QUEDA_FRACAO) atencao.push({ ...i, motivo: "queda", mediaAnterior: Math.round(media * 10) / 10 });
  }
  atencao.sort((a, b) => PRIORIDADE[a.motivo] - PRIORIDADE[b.motivo] || (b.ultimoMes ?? "").localeCompare(a.ultimoMes ?? "") || a.nome.localeCompare(b.nome));

  // Quem está em queda já aparece em "atenção"; não repete entre os constantes.
  const emAtencao = new Set(atencao.map((i) => i.chave));
  // Com comparação: os mais constantes mês após mês. No primeiro mês da base: quem mais prescreveu no mês.
  const constantes = itens
    .filter((i) => i.receitasMes > 0 && (!comparacao || i.primeiroMes !== mesRef) && !emAtencao.has(i.chave))
    .sort((a, b) => (comparacao ? b.mesesAtivos - a.mesesAtivos : 0) || b.receitasMes - a.receitasMes)
    .slice(0, 10);

  const semReceita = itens.filter((i) => i.naCarteira && !i.ultimoMes).sort((a, b) => a.nome.localeCompare(b.nome));
  const ativos = itens.filter((i) => i.receitasMes > 0);

  res.json({
    ...base,
    mesReferencia: { chave: mesRef, rotulo: rotuloMes(mesRef) },
    comparacao,
    serieMeses: serieMeses.map(rotuloMes),
    resumo: {
      ativos: ativos.length,
      ativosNaCarteira: ativos.filter((i) => i.naCarteira).length,
      atencao: atencao.length,
      voltaram: voltaram.length,
      novos: novos.length,
      semReceita: semReceita.length,
      foraDaCarteira: ativos.filter((i) => !i.naCarteira).length,
    },
    atencao,
    voltaram,
    constantes,
    novos,
    semReceita,
    foraDaCarteira: ativos.filter((i) => !i.naCarteira).sort((a, b) => b.receitasMes - a.receitasMes),
  });
});

export default router;
