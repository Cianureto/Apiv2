import { Router } from "express";
import { prisma } from "../lib/prisma";
import { inicioDoMesDeslocado, limitesDaSemana, limitesDoDia, limitesDoMes, somarDias } from "../lib/datas";
import { atendeAmanha, atendeHoje } from "../lib/horario";
import { DIAS_LIMITE_REGISTRO, diasRestantesParaRegistro, limiteRegistro } from "../lib/regras";
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
    diasLimiteRegistro: DIAS_LIMITE_REGISTRO,
  });
});

router.get("/historico", async (req: RequisicaoAutenticada, res) => {
  const visitas = await prisma.visita.findMany({
    where: {
      consultorId: req.usuario!.id,
      dataHora: { gte: somarDias(new Date(), -365) },
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

  const [visitasHoje, pendentesDeRelatorio, visitasSemana, medicos, visitasRecentes, ausencias, apresentacoesMes, indicadores] =
    await Promise.all([
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
      prisma.medicoClinica.findMany({ orderBy: { nomeMedico: "asc" } }),
      prisma.visita.findMany({
        where: { consultorId, status: { not: "cancelado" }, OR: [{ dataHora: { gte: trintaDiasAtras } }] },
        select: { medicoClinicaId: true, dataHora: true },
      }),
      prisma.ausencia.findMany({
        where: { consultorId, fim: { gte: agora }, inicio: { lte: somarDias(agora, 30) } },
        orderBy: { inicio: "asc" },
      }),
      prisma.registroApresentacao.count({ where: { consultorId, inicio: { gte: mes.inicio, lte: mes.fim } } }),
      indicadoresDoMes(consultorId, req.usuario!.metaComparecimento),
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
    alertas,
    sugestoes,
    ausencias: ausencias.map(serializarAusencia),
    apresentacoesMes,
    indicadores: { ...indicadores, metaComparecimento: req.usuario!.metaComparecimento },
    diasLimiteRegistro: DIAS_LIMITE_REGISTRO,
  });
});

export default router;
