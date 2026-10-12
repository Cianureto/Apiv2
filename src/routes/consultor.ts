import { Router } from "express";
import { prisma } from "../lib/prisma";
import { inicioDoDiaStr, inicioDoMesDeslocado, limitesDaSemana, limitesDoDia, limitesDoMes, partesLocais, somarDias } from "../lib/datas";
import { atendeAmanha, atendeHoje } from "../lib/horario";
import { DIA_FECHAMENTO_CICLO, diasRestantesParaRegistro, limiteRegistro } from "../lib/regras";
import { serializarVisitaConsultor } from "../lib/serializar";
import { serializarAusencia } from "./ausencias";
import { exigirAutenticacao, exigirPapel, RequisicaoAutenticada } from "../middleware/auth";

const router = Router();
router.use(exigirAutenticacao, exigirPapel("consultor"));

function lerIntervalo(query: Record<string, unknown>) {
  if (typeof query.inicio !== "string" || typeof query.fim !== "string") return null;
  const inicio = new Date(query.inicio);
  const fim = new Date(query.fim);
  if (Number.isNaN(inicio.getTime()) || Number.isNaN(fim.getTime()) || fim <= inicio) return null;
  return { inicio, fim };
}

// GET /consultor/agenda?inicio=ISO&fim=ISO
// Sem parâmetros, devolve a janela antiga (mês passado até o fim do próximo mês).
router.get("/agenda", async (req: RequisicaoAutenticada, res) => {
  const intervalo = lerIntervalo(req.query) ?? {
    inicio: inicioDoMesDeslocado(new Date(), -1),
    fim: limitesDoMes(inicioDoMesDeslocado(new Date(), 1)).fim,
  };

  const [visitas, ausencias] = await Promise.all([
    prisma.visita.findMany({
      where: { consultorId: req.usuario!.id, dataHora: { gte: intervalo.inicio, lte: intervalo.fim } },
      include: { medicoClinica: true },
      orderBy: { dataHora: "asc" },
    }),
    prisma.ausencia.findMany({
      where: { consultorId: req.usuario!.id, inicio: { lt: intervalo.fim }, fim: { gt: intervalo.inicio } },
      orderBy: { inicio: "asc" },
    }),
  ]);

  res.json({
    visitas: visitas.map(serializarVisitaConsultor),
    ausencias: ausencias.map(serializarAusencia),
    diaFechamentoCiclo: DIA_FECHAMENTO_CICLO,
  });
});

// GET /consultor/historico?inicio=AAAA-MM-DD&fim=AAAA-MM-DD (dias locais, inclusivos).
// Sem parâmetros: últimos 365 dias.
router.get("/historico", async (req: RequisicaoAutenticada, res) => {
  const dia = /^\d{4}-\d{2}-\d{2}$/;
  const inicioStr = typeof req.query.inicio === "string" && dia.test(req.query.inicio) ? req.query.inicio : null;
  const fimStr = typeof req.query.fim === "string" && dia.test(req.query.fim) ? req.query.fim : null;
  const inicio = (inicioStr && inicioDoDiaStr(inicioStr)) || somarDias(new Date(), -365);
  const fim = fimStr ? somarDias(inicioDoDiaStr(fimStr)!, 1) : null;

  const visitas = await prisma.visita.findMany({
    where: {
      consultorId: req.usuario!.id,
      dataHora: { gte: inicio, ...(fim ? { lt: fim } : {}) },
      status: { in: ["realizado", "cancelado"] },
    },
    include: { medicoClinica: true },
    orderBy: { dataHora: "desc" },
  });

  res.json({ visitas: visitas.map(serializarVisitaConsultor) });
});

async function indicadoresDoMes(consultorId: string, metaComparecimento: number) {
  const { inicio, fim } = limitesDoMes(new Date());
  const visitasMes = await prisma.visita.findMany({ where: { consultorId, dataHora: { gte: inicio, lte: fim } } });

  const validas = visitasMes.filter((v) => v.status !== "cancelado");
  const realizadas = visitasMes.filter((v) => v.status === "realizado");
  const comparecimento = validas.length > 0 ? Math.round((realizadas.length / validas.length) * 100) : 0;
  const produtosOfertados = new Set(realizadas.map((v) => v.produto).filter(Boolean)).size;

  return {
    visitasMes: visitasMes.length,
    realizadasMes: realizadas.length,
    comparecimento,
    produtosOfertados,
    metaBatida: comparecimento >= metaComparecimento,
  };
}

router.get("/perfil", async (req: RequisicaoAutenticada, res) => {
  const ind = await indicadoresDoMes(req.usuario!.id, req.usuario!.metaComparecimento);
  res.json({
    usuario: req.usuario,
    visitasMes: ind.visitasMes,
    comparecimento: ind.comparecimento,
    produtosOfertados: ind.produtosOfertados,
    metaBatida: ind.metaBatida,
  });
});

// GET /consultor/painel — tela "Início": visitas de hoje, alertas, sugestões e indicadores.
router.get("/painel", async (req: RequisicaoAutenticada, res) => {
  const consultorId = req.usuario!.id;
  const agora = new Date();
  const hoje = limitesDoDia(agora);
  const semana = limitesDaSemana(agora);
  const mes = limitesDoMes(agora);
  const trintaDiasAtras = somarDias(agora, -30);

  const [
    visitasHoje,
    pendentesDeRelatorio,
    visitasSemana,
    medicos,
    visitasRecentes,
    ultimasVisitasRealizadas,
    proximasVisitas,
    visitasRealizadasNoMes,
    agendaPendente,
    ausencias,
    apresentacoesMes,
    indicadores,
    tarefasAbertas,
  ] = await Promise.all([
    prisma.visita.findMany({
      where: { consultorId, dataHora: { gte: hoje.inicio, lte: hoje.fim } },
      include: { medicoClinica: true },
      orderBy: { dataHora: "asc" },
    }),
    // Visitas que já passaram e ainda não tiveram o relatório enviado.
    prisma.visita.findMany({
      where: { consultorId, dataHora: { lt: agora, gte: somarDias(agora, -60) }, status: { in: ["pendente", "confirmado"] } },
      include: { medicoClinica: true },
      orderBy: { dataHora: "asc" },
    }),
    prisma.visita.findMany({ where: { consultorId, dataHora: { gte: semana.inicio, lte: semana.fim } }, select: { status: true } }),
    // Carteira do consultor: médicos dele + os ainda sem consultor responsável.
    prisma.medicoClinica.findMany({
      where: { OR: [{ consultorId }, { consultorId: null }] },
      orderBy: { nomeMedico: "asc" },
    }),
    prisma.visita.findMany({
      where: { consultorId, status: { not: "cancelado" }, OR: [{ dataHora: { gte: trintaDiasAtras } }] },
      select: { medicoClinicaId: true, dataHora: true },
    }),
    // Última visita realizada (qualquer época) por médico, para medir há quanto tempo está sem visita.
    prisma.visita.groupBy({ by: ["medicoClinicaId"], where: { consultorId, status: "realizado" }, _max: { dataHora: true } }),
    prisma.visita.groupBy({
      by: ["medicoClinicaId"],
      where: { consultorId, status: { in: ["pendente", "confirmado"] }, dataHora: { gte: agora } },
      _min: { dataHora: true },
    }),
    prisma.visita.findMany({
      where: { consultorId, status: "realizado", dataHora: { gte: mes.inicio, lte: mes.fim } },
      select: { medicoClinicaId: true },
    }),
    // Agenda pendente: total de visitas futuras ainda não realizadas (não só as da semana).
    prisma.visita.count({ where: { consultorId, status: { in: ["pendente", "confirmado"] }, dataHora: { gte: agora } } }),
    // Ausências do ciclo (mês) atual, inclusive as que já passaram, e as dos próximos 30 dias.
    prisma.ausencia.findMany({
      where: { consultorId, fim: { gte: mes.inicio }, inicio: { lte: somarDias(agora, 30) } },
      orderBy: { inicio: "asc" },
    }),
    prisma.registroApresentacao.count({ where: { consultorId, inicio: { gte: mes.inicio, lte: mes.fim } } }),
    indicadoresDoMes(consultorId, req.usuario!.metaComparecimento),
    prisma.visita.findMany({
      where: { consultorId, tarefa: { not: null }, tarefaConcluidaEm: null, status: { not: "cancelado" } },
      include: { medicoClinica: true },
      orderBy: { dataHora: "desc" },
    }),
  ]);

  const limite = limiteRegistro(agora);
  const alertas = pendentesDeRelatorio.map((v) => {
    const expirada = v.dataHora < limite;
    return {
      tipo: expirada ? ("prazo_expirado" as const) : ("relatorio_pendente" as const),
      diasRestantes: expirada ? 0 : diasRestantesParaRegistro(v.dataHora, agora),
      visita: serializarVisitaConsultor(v),
    };
  });

  // Sugestões: médicos que atendem hoje/amanhã e que o consultor não visita há 30 dias nem tem visita marcada.
  const comVisitaRecenteOuFutura = new Set(visitasRecentes.map((v) => v.medicoClinicaId));
  const sugestoes = medicos
    .filter((m) => !comVisitaRecenteOuFutura.has(m.id))
    .map((m) => ({ m, hoje: atendeHoje(m.padraoHorario), amanha: atendeAmanha(m.padraoHorario) }))
    .filter((s) => s.hoje || s.amanha)
    .sort((a, b) => Number(b.hoje) - Number(a.hoje))
    .slice(0, 6)
    .map(({ m, hoje: atendeHojeFlag }) => ({
      medico: { id: m.id, nomeMedico: m.nomeMedico, especialidade: m.especialidade, clinica: m.clinica, bairro: m.bairro, padraoHorario: m.padraoHorario },
      motivo: atendeHojeFlag ? "Atende hoje e está sem visita há mais de 30 dias" : "Atende amanhã e está sem visita há mais de 30 dias",
    }));

  // Meta de cobertura: % da carteira (médicos dela já atribuídos a ele; se ainda não tiver
  // nenhum, usa a carteira disponível — dele + sem dono) visitada (realizado) no mês.
  const meusMedicos = medicos.filter((m) => m.consultorId === consultorId);
  const carteira = meusMedicos.length > 0 ? meusMedicos : medicos;
  const idsCarteira = new Set(carteira.map((m) => m.id));
  const visitadosNoMes = new Set(visitasRealizadasNoMes.map((v) => v.medicoClinicaId).filter((id) => idsCarteira.has(id)));
  const totalCarteira = carteira.length;
  const cobertura = {
    visitados: visitadosNoMes.size,
    total: totalCarteira,
    percentual: totalCarteira > 0 ? Math.round((visitadosNoMes.size / totalCarteira) * 100) : 0,
    meta: req.usuario!.metaCoberturaMedicos,
  };

  // Médicos da carteira sem visita realizada no ciclo (mês) atual. "ciclosSemVisita" conta os meses
  // seguidos sem visita, incluindo o atual (2 = sem visita neste mês e no anterior); nulo = nunca visitado.
  const ultimaVisitaPorMedico = new Map<string, Date>();
  for (const u of ultimasVisitasRealizadas) if (u._max.dataHora) ultimaVisitaPorMedico.set(u.medicoClinicaId, u._max.dataHora);
  const proximaVisitaPorMedico = new Map<string, Date>();
  for (const p of proximasVisitas) if (p._min.dataHora) proximaVisitaPorMedico.set(p.medicoClinicaId, p._min.dataHora);
  const cicloAtual = partesLocais(agora);
  const indiceMes = (p: { ano: number; mes: number }) => p.ano * 12 + p.mes;
  const semVisita = carteira
    .filter((m) => !visitadosNoMes.has(m.id))
    .map((m) => {
      const ultima = ultimaVisitaPorMedico.get(m.id) ?? null;
      return {
        id: m.id,
        nomeMedico: m.nomeMedico,
        especialidade: m.especialidade,
        clinica: m.clinica,
        bairro: m.bairro,
        ultimaVisitaEm: ultima?.toISOString() ?? null,
        proximaVisitaEm: proximaVisitaPorMedico.get(m.id)?.toISOString() ?? null,
        ciclosSemVisita: ultima ? indiceMes(cicloAtual) - indiceMes(partesLocais(ultima)) : null,
        nuncaVisitado: !ultima,
      };
    })
    .sort((a, b) => (b.ciclosSemVisita ?? Infinity) - (a.ciclosSemVisita ?? Infinity) || a.nomeMedico.localeCompare(b.nomeMedico));

  const tarefas = tarefasAbertas.map((v) => ({
    visitaId: v.id,
    tarefa: v.tarefa!,
    dataHora: v.dataHora.toISOString(),
    medico: v.medicoClinica.nomeMedico,
    clinica: v.medicoClinica.clinica,
  }));

  res.json({
    hoje: {
      total: visitasHoje.length,
      planejadas: visitasHoje.filter((v) => v.status === "pendente" || v.status === "confirmado").length,
      enviadas: visitasHoje.filter((v) => v.status === "realizado").length,
      canceladas: visitasHoje.filter((v) => v.status === "cancelado").length,
      visitas: visitasHoje.map(serializarVisitaConsultor),
    },
    semana: {
      planejadas: visitasSemana.filter((v) => v.status === "pendente" || v.status === "confirmado").length,
      enviadas: visitasSemana.filter((v) => v.status === "realizado").length,
    },
    agendaPendente,
    alertas,
    tarefas,
    sugestoes,
    semVisita,
    cobertura,
    ausencias: ausencias.map(serializarAusencia),
    apresentacoesMes,
    indicadores: { ...indicadores, metaComparecimento: req.usuario!.metaComparecimento },
    diaFechamentoCiclo: DIA_FECHAMENTO_CICLO,
  });
});

export default router;
