import { Router } from "express";
import { prisma } from "../lib/prisma";
import { diaDaSemana, inicioDoMesDeslocado, limitesDoDia, limitesDaSemana, limitesDoMes, partesLocais, somarDias } from "../lib/datas";
import { diasDaSemana } from "../lib/horario";
import { serializarVisitaGestor as serializarVisita } from "../lib/serializar";
import { exigirAutenticacao, exigirPapel, RequisicaoAutenticada } from "../middleware/auth";

const MESES_CURTOS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const NOMES_DIA = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

const router = Router();
router.use(exigirAutenticacao, exigirPapel("gestor"));

router.get("/kpis", async (_req, res) => {
  const hoje = new Date();
  const { inicio, fim } = limitesDoDia(hoje);
  const ontem = somarDias(hoje, -1);
  const { inicio: inicioOntem, fim: fimOntem } = limitesDoDia(ontem);

  const [visitasHoje, visitasOntem, consultoresAtivos] = await Promise.all([
    prisma.visita.findMany({ where: { dataHora: { gte: inicio, lte: fim } } }),
    prisma.visita.count({ where: { dataHora: { gte: inicioOntem, lte: fimOntem } } }),
    prisma.usuario.findMany({ where: { papel: "consultor", status: "ativo" } }),
  ]);

  const realizadas = visitasHoje.filter((v) => v.status === "realizado").length;
  const canceladas = visitasHoje.filter((v) => v.status === "cancelado").length;
  const elegiveis = visitasHoje.length - canceladas;
  const taxaComparecimento = elegiveis > 0 ? Math.round((realizadas / elegiveis) * 100) : 0;
  const consultoresComVisitaHoje = new Set(visitasHoje.filter((v) => v.status !== "cancelado").map((v) => v.consultorId));

  res.json({
    agendamentosHoje: visitasHoje.length,
    diffOntem: visitasHoje.length - visitasOntem,
    visitasOntem,
    visitasRealizadas: realizadas,
    percRealizadasDoTotal: visitasHoje.length > 0 ? Math.round((realizadas / visitasHoje.length) * 100) : 0,
    taxaComparecimento,
    consultoresEmCampo: consultoresComVisitaHoje.size,
    totalConsultoresAtivos: consultoresAtivos.length,
  });
});

router.get("/agenda", async (req: RequisicaoAutenticada, res) => {
  const visao = req.query.visao === "semana" || req.query.visao === "mes" ? req.query.visao : "hoje";
  const hoje = new Date();
  const { inicio, fim } = visao === "hoje" ? limitesDoDia(hoje) : visao === "semana" ? limitesDaSemana(hoje) : limitesDoMes(hoje);

  const visitas = await prisma.visita.findMany({
    where: { dataHora: { gte: inicio, lte: fim } },
    include: { consultor: true, medicoClinica: true },
    orderBy: { dataHora: "asc" },
  });

  res.json({ visitas: visitas.map(serializarVisita) });
});

router.get("/proximas-visitas", async (_req, res) => {
  const visitas = await prisma.visita.findMany({
    where: { dataHora: { gte: new Date() }, status: { in: ["confirmado", "pendente"] } },
    include: { consultor: true, medicoClinica: true },
    orderBy: { dataHora: "asc" },
    take: 4,
  });
  res.json({ visitas: visitas.map(serializarVisita) });
});

router.get("/consultores-em-campo", async (_req, res) => {
  const { inicio, fim } = limitesDoDia(new Date());
  const consultores = await prisma.usuario.findMany({
    where: { papel: "consultor", status: "ativo" },
    include: { visitas: { where: { dataHora: { gte: inicio, lte: fim } } } },
  });

  const resultado = consultores
    .map((c) => {
      const visitasHoje = c.visitas;
      const canceladas = visitasHoje.filter((v) => v.status === "cancelado").length;
      const ativasHoje = visitasHoje.filter((v) => v.status !== "cancelado");
      let statusCampo: "Em campo" | "Disponível" | "Offline" = "Offline";
      if (ativasHoje.length > 0) statusCampo = "Em campo";
      else if (visitasHoje.length > 0) statusCampo = "Disponível";

      return {
        id: c.id,
        nome: c.nome,
        regiao: c.regiao,
        visitasHoje: visitasHoje.length,
        canceladasHoje: canceladas,
        statusCampo,
      };
    })
    .sort((a, b) => b.visitasHoje - a.visitasHoje);

  const totalConsultores = await prisma.usuario.count({ where: { papel: "consultor" } });

  res.json({ consultores: resultado, totalConsultores });
});

router.get("/relatorios", async (_req, res) => {
  const hoje = new Date();
  const { inicio, fim } = limitesDoMes(hoje);
  const mesAnterior = inicioDoMesDeslocado(hoje, -1);
  const { inicio: inicioAnterior, fim: fimAnterior } = limitesDoMes(mesAnterior);

  const tresMesesAtras = inicioDoMesDeslocado(hoje, -2);
  const seisMesesAtras = inicioDoMesDeslocado(hoje, -5);

  const [visitasMes, visitasMesAnterior, consultores, todosMedicos, visitasRecentes, visitasSeisMeses] = await Promise.all([
    prisma.visita.findMany({ where: { dataHora: { gte: inicio, lte: fim } }, include: { medicoClinica: true } }),
    prisma.visita.count({ where: { dataHora: { gte: inicioAnterior, lte: fimAnterior } } }),
    prisma.usuario.findMany({
      where: { papel: "consultor", status: "ativo" },
      include: { visitas: { where: { dataHora: { gte: inicio, lte: fim } } } },
    }),
    prisma.medicoClinica.findMany(),
    prisma.visita.findMany({
      where: { dataHora: { gte: tresMesesAtras, lte: fim } },
      include: { medicoClinica: true },
    }),
    prisma.visita.findMany({ where: { dataHora: { gte: seisMesesAtras, lte: fim } } }),
  ]);

  const totalVisitas = visitasMes.length;
  const variacaoMes = visitasMesAnterior > 0 ? Math.round(((totalVisitas - visitasMesAnterior) / visitasMesAnterior) * 100) : 0;
  const validas = visitasMes.filter((v) => v.status !== "cancelado");
  const realizadas = visitasMes.filter((v) => v.status === "realizado");
  const taxaMedia = validas.length > 0 ? Math.round((realizadas.length / validas.length) * 100) : 0;
  const canceladas = visitasMes.filter((v) => v.status === "cancelado").length;
  const taxaCancelamento = totalVisitas > 0 ? Math.round((canceladas / totalVisitas) * 100) : 0;

  const contagemProdutos = new Map<string, number>();
  for (const v of visitasMes) {
    if (!v.produto) continue;
    contagemProdutos.set(v.produto, (contagemProdutos.get(v.produto) ?? 0) + 1);
  }
  const produtoTopEntrada = [...contagemProdutos.entries()].sort((a, b) => b[1] - a[1])[0];
  const produtoTop = produtoTopEntrada?.[0] ?? null;
  const percProdutoTop = produtoTopEntrada && totalVisitas > 0 ? Math.round((produtoTopEntrada[1] / totalVisitas) * 100) : 0;

  const ranking = consultores
    .map((c) => {
      const total = c.visitas.filter((v) => v.status !== "cancelado").length;
      const realizadasConsultor = c.visitas.filter((v) => v.status === "realizado").length;
      const comparecimento = total > 0 ? Math.round((realizadasConsultor / total) * 100) : 0;
      return { id: c.id, nome: c.nome, visitas: c.visitas.length, realizadas: realizadasConsultor, comparecimento };
    })
    .sort((a, b) => b.visitas - a.visitas);

  // Funil de status do mês
  const funil = {
    confirmado: visitasMes.filter((v) => v.status === "confirmado").length,
    realizado: realizadas.length,
    pendente: visitasMes.filter((v) => v.status === "pendente").length,
    cancelado: canceladas,
  };

  // Visitas por dia da semana (agenda real, mês atual)
  const visitasPorDiaSemana = Array.from({ length: 7 }, (_, dia) => {
    const doDia = visitasMes.filter((v) => diaDaSemana(v.dataHora) === dia);
    return {
      dia,
      label: NOMES_DIA[dia],
      total: doDia.length,
      realizado: doDia.filter((v) => v.status === "realizado").length,
    };
  });

  // Dias em que os médicos cadastrados mais atendem (padrão de horário da base inteira)
  const medicosDisponibilidadePorDia = Array.from({ length: 7 }, (_, dia) => ({
    dia,
    label: NOMES_DIA[dia],
    totalMedicos: todosMedicos.filter((m) => diasDaSemana(m.padraoHorario).includes(dia)).length,
  }));

  // Médicos que mais recebem visitas (retornos) — últimos 3 meses
  const porMedico = new Map<string, { nomeMedico: string; clinica: string; especialidade: string; total: number; realizadas: number }>();
  for (const v of visitasRecentes) {
    const atual = porMedico.get(v.medicoClinicaId) ?? {
      nomeMedico: v.medicoClinica.nomeMedico,
      clinica: v.medicoClinica.clinica,
      especialidade: v.medicoClinica.especialidade,
      total: 0,
      realizadas: 0,
    };
    if (v.status !== "cancelado") atual.total += 1;
    if (v.status === "realizado") atual.realizadas += 1;
    porMedico.set(v.medicoClinicaId, atual);
  }
  const rankingMedicos = Array.from(porMedico.entries())
    .map(([id, m]) => ({
      id,
      nomeMedico: m.nomeMedico,
      clinica: m.clinica,
      especialidade: m.especialidade,
      totalVisitas: m.total,
      comparecimento: m.total > 0 ? Math.round((m.realizadas / m.total) * 100) : 0,
    }))
    .sort((a, b) => b.totalVisitas - a.totalVisitas)
    .slice(0, 8);

  // Distribuição por especialidade e por bairro (mês atual)
  const porEspecialidadeMap = new Map<string, number>();
  const porBairroMap = new Map<string, number>();
  for (const v of visitasMes) {
    if (v.status === "cancelado") continue;
    porEspecialidadeMap.set(v.medicoClinica.especialidade, (porEspecialidadeMap.get(v.medicoClinica.especialidade) ?? 0) + 1);
    const bairro = v.medicoClinica.bairro || "Não informado";
    porBairroMap.set(bairro, (porBairroMap.get(bairro) ?? 0) + 1);
  }
  const porEspecialidade = Array.from(porEspecialidadeMap.entries())
    .map(([especialidade, total]) => ({ especialidade, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);
  const porBairro = Array.from(porBairroMap.entries())
    .map(([bairro, total]) => ({ bairro, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  // Evolução mensal — últimos 6 meses
  const evolucaoMensal = Array.from({ length: 6 }, (_, i) => {
    const ref = partesLocais(inicioDoMesDeslocado(hoje, -(5 - i)));
    const doMes = visitasSeisMeses.filter((v) => {
      const p = partesLocais(v.dataHora);
      return p.ano === ref.ano && p.mes === ref.mes;
    });
    const validasDoMes = doMes.filter((v) => v.status !== "cancelado");
    const realizadasDoMes = doMes.filter((v) => v.status === "realizado");
    return {
      mes: `${ref.ano}-${String(ref.mes + 1).padStart(2, "0")}`,
      label: MESES_CURTOS[ref.mes],
      total: doMes.length,
      realizado: realizadasDoMes.length,
      taxaComparecimento: validasDoMes.length > 0 ? Math.round((realizadasDoMes.length / validasDoMes.length) * 100) : 0,
    };
  });

  res.json({
    totalVisitas,
    variacaoMes,
    taxaMedia,
    taxaCancelamento,
    produtoTop,
    percProdutoTop,
    ranking,
    funil,
    visitasPorDiaSemana,
    medicosDisponibilidadePorDia,
    rankingMedicos,
    porEspecialidade,
    porBairro,
    evolucaoMensal,
  });
});

export default router;
