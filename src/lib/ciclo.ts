import type { CanalVisita, MedicoClinica, TipoVisita } from "@prisma/client";
import { prisma } from "./prisma";
import { FUSO, limitesDoMes, partesLocais } from "./datas";
import { diasUteisDoMes } from "./diasUteis";

// Profissões que são estabelecimentos (clínicas, hospitais, academias), não pessoas.
const ESTABELECIMENTOS = new Set(["clinica", "academia"]);

/** Endereços do mesmo profissional compartilham o grupo; cadastros antigos sem grupo ficam sozinhos. */
export const chaveProfissional = (m: Pick<MedicoClinica, "id" | "grupoId">) => m.grupoId ?? m.id;

/** Visitas realizadas no ciclo (mês) atual, somadas por profissional (todos os endereços dele). */
export async function contatosFeitosNoCiclo(consultorId?: string, agora = new Date()) {
  const { inicio, fim } = limitesDoMes(agora);
  const visitas = await prisma.visita.findMany({
    where: { status: "realizado", dataHora: { gte: inicio, lte: fim }, ...(consultorId ? { consultorId } : {}) },
    select: { medicoClinica: { select: { id: true, grupoId: true } } },
  });
  const porProfissional = new Map<string, number>();
  for (const v of visitas) {
    const k = chaveProfissional(v.medicoClinica);
    porProfissional.set(k, (porProfissional.get(k) ?? 0) + 1);
  }
  return porProfissional;
}

/** Presencial ou à distância (Teams, Zoom, chamada de vídeo, telefone). Sem canal, vale o tipo agendado. */
export function ehPresencial(v: { canal: CanalVisita | null; tipo: TipoVisita | null }) {
  return v.canal ? v.canal === "presencial" : v.tipo !== "online";
}

export type FaixaContatos = "0" | "1" | "2" | "3" | "4+" | "2+" | "1+";

export type FiltrosVisao = {
  /** Ciclos "YYYY-MM" somados no recorte; vazio = ciclo atual. */
  meses?: string[];
  // Cada filtro aceita várias opções (vale qualquer uma delas); vazio = sem filtro.
  consultores?: string[];
  especialidades?: string[];
  tipos?: ("profissional" | "estabelecimento")[];
  modalidades?: ("presencial" | "video")[];
  cidades?: string[];
  contatos?: FaixaContatos[];
  busca?: string;
};

function naFaixa(n: number, faixa?: FaixaContatos) {
  switch (faixa) {
    case "0": return n === 0;
    case "1": return n === 1;
    case "2": return n === 2;
    case "3": return n === 3;
    case "4+": return n >= 4;
    case "2+": return n >= 2;
    case "1+": return n >= 1;
    default: return true;
  }
}

const normalizar = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
const umaCasa = (n: number) => Math.round(n * 10) / 10;
const chaveMes = (d: Date) => {
  const p = partesLocais(d);
  return `${p.ano}-${String(p.mes + 1).padStart(2, "0")}`;
};
const deslocarMes = (mes: string, n: number) => {
  const [a, m] = mes.split("-").map(Number);
  const d = new Date(Date.UTC(a, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

type Profissional = {
  chave: string;
  nome: string;
  especialidade: string;
  estabelecimento: boolean;
  cidade: string;
  consultorId: string | null;
  contatos: number;
};

/**
 * Visão geral de um ou mais ciclos (meses) para o gestor. Cada profissional da carteira tem uma meta
 * de contatos por ciclo (1 = só a primeira visita; 4 = primeira + 3 revisitas). A meta do recorte é a
 * soma dessas metas em cada ciclo, e a cobertura de contatos conta, de cada profissional e em cada
 * ciclo, no máximo o alocado: visitar demais um médico (ou um mês) não compensa outro que ficou sem
 * visita. A 1ª visita de cada ciclo é a primeira; as demais, revisitas. Só visitas realizadas contam;
 * médias usam dias úteis.
 */
async function calcularCiclo(f: FiltrosVisao, agora: Date) {
  const atual = chaveMes(agora);
  const meses = f.meses?.length ? [...new Set(f.meses)].sort() : [atual];
  const doMes = meses.map((m) => {
    const referencia = new Date(`${m}-15T12:00:00${FUSO}`);
    return { mes: m, ...limitesDoMes(referencia), dias: diasUteisDoMes(referencia, agora) };
  });
  const inicio = doMes[0].inicio;
  const fim = doMes[doMes.length - 1].fim;
  const dias = {
    total: doMes.reduce((t, m) => t + m.dias.total, 0),
    transcorridos: doMes.reduce((t, m) => t + m.dias.transcorridos, 0),
    // Dias que ainda dá para trabalhar: só os do ciclo atual, se ele estiver no recorte.
    restantes: doMes.find((m) => m.mes === atual)?.dias.restantes ?? 0,
    lista: doMes.flatMap((m) => m.dias.lista),
  };
  const noRecorte = new Set(meses);

  const [cadastros, visitas] = await Promise.all([
    prisma.medicoClinica.findMany({
      select: { id: true, grupoId: true, nomeMedico: true, especialidade: true, profissao: true, cidade: true, contatosCiclo: true, consultorId: true },
    }),
    prisma.visita.findMany({
      where: { status: "realizado", dataHora: { gte: inicio, lte: fim }, ...(f.consultores?.length ? { consultorId: { in: f.consultores } } : {}) },
      select: { dataHora: true, canal: true, tipo: true, consultorId: true, medicoClinica: { select: { id: true, grupoId: true } } },
    }),
  ]);

  const profissionais = new Map<string, Profissional>();
  for (const m of cadastros) {
    const k = chaveProfissional(m);
    const atual = profissionais.get(k);
    profissionais.set(k, {
      chave: k,
      nome: m.nomeMedico,
      especialidade: m.especialidade || "Não informada",
      estabelecimento: ESTABELECIMENTOS.has(m.profissao ?? ""),
      cidade: atual?.cidade || m.cidade?.trim() || "",
      consultorId: m.consultorId,
      contatos: Math.max(atual?.contatos ?? 1, m.contatosCiclo),
    });
  }

  const busca = f.busca ? normalizar(f.busca) : "";
  const confere = (p: Profissional) =>
    (!f.especialidades?.length || f.especialidades.includes(p.especialidade)) &&
    (!f.tipos?.length || f.tipos.includes(p.estabelecimento ? "estabelecimento" : "profissional")) &&
    (!f.cidades?.length || f.cidades.includes(p.cidade)) &&
    (!busca || normalizar(p.nome).includes(busca));

  let painel = [...profissionais.values()].filter((p) => confere(p) && (!f.consultores?.length || (p.consultorId !== null && f.consultores.includes(p.consultorId))));

  // Visitas do recorte, por profissional.
  type Contagem = { n: number; presencial: number; video: number };
  const porProfissional = new Map<string, Contagem>();
  let doRecorte: { chave: string; mes: string; dia: string; presencial: boolean; consultorId: string }[] = [];
  for (const v of visitas) {
    const k = chaveProfissional(v.medicoClinica);
    const p = profissionais.get(k);
    if (!p || !confere(p)) continue;
    const presencial = ehPresencial(v);
    if (f.modalidades?.length && !f.modalidades.includes(presencial ? "presencial" : "video")) continue;
    const mes = chaveMes(v.dataHora);
    if (!noRecorte.has(mes)) continue;
    const pl = partesLocais(v.dataHora);
    doRecorte.push({ chave: k, mes, dia: `${mes}-${String(pl.dia).padStart(2, "0")}`, presencial, consultorId: v.consultorId });
  }
  for (const v of doRecorte) {
    const c = porProfissional.get(v.chave) ?? { n: 0, presencial: 0, video: 0 };
    c.n++;
    if (v.presencial) c.presencial++;
    else c.video++;
    porProfissional.set(v.chave, c);
  }

  // Filtro "contatos no ciclo": mantém só quem está na faixa (inclusive os não visitados, na faixa 0).
  if (f.contatos?.length) {
    const faixas = f.contatos;
    const n = (k: string) => porProfissional.get(k)?.n ?? 0;
    const confereFaixa = (k: string) => faixas.some((faixa) => naFaixa(n(k), faixa));
    painel = painel.filter((p) => confereFaixa(p.chave));
    doRecorte = doRecorte.filter((v) => confereFaixa(v.chave));
    for (const k of [...porProfissional.keys()]) if (!confereFaixa(k)) porProfissional.delete(k);
  }

  const feitas = (k: string) => porProfissional.get(k)?.n ?? 0;
  // Visitas de cada profissional em cada ciclo do recorte ("chave|YYYY-MM").
  const porCiclo = new Map<string, number>();
  for (const v of doRecorte) porCiclo.set(`${v.chave}|${v.mes}`, (porCiclo.get(`${v.chave}|${v.mes}`) ?? 0) + 1);
  const feitasNoCiclo = (k: string, m: string) => porCiclo.get(`${k}|${m}`) ?? 0;

  // Cadastro e meta de contatos (a meta vale para cada ciclo do recorte)
  const estabelecimentos = painel.filter((p) => p.estabelecimento).length;
  const somaCiclos = (fn: (p: Profissional, m: string) => number) => painel.reduce((s, p) => s + meses.reduce((t, m) => t + fn(p, m), 0), 0);
  const metaContatos = somaCiclos((p) => p.contatos);
  const contatosNaMeta = somaCiclos((p, m) => Math.min(feitasNoCiclo(p.chave, m), p.contatos));
  const excedentes = somaCiclos((p, m) => Math.max(0, feitasNoCiclo(p.chave, m) - p.contatos));
  const completos = painel.filter((p) => meses.every((m) => feitasNoCiclo(p.chave, m) >= p.contatos)).length;
  // O que ainda falta da meta só pode ser feito no ciclo atual.
  const faltamNoAtual = noRecorte.has(atual) ? painel.reduce((s, p) => s + Math.max(0, p.contatos - feitasNoCiclo(p.chave, atual)), 0) : 0;

  // Execução: a 1ª visita de cada profissional em cada ciclo é a primeira; as demais, revisitas.
  const realizadas = doRecorte.length;
  const presenciais = doRecorte.filter((v) => v.presencial).length;
  const primeiras = porCiclo.size;
  const unicos = porProfissional.size;
  const unicosPainel = painel.filter((p) => feitas(p.chave) > 0).length;
  const multi = [...porProfissional.values()].filter((c) => c.n >= 2).length;
  const alta = [...porProfissional.values()].filter((c) => c.n >= 4);

  // Especialidades dos profissionais (estabelecimentos ficam de fora)
  const pessoas = painel.filter((p) => !p.estabelecimento);
  const coberturaProfissionais = pct(pessoas.filter((p) => feitas(p.chave) > 0).length, pessoas.length);
  const esp = new Map<string, { especialidade: string; cadastrados: number; visitados: number; contatos: number }>();
  for (const p of pessoas) {
    const e = esp.get(p.especialidade) ?? { especialidade: p.especialidade, cadastrados: 0, visitados: 0, contatos: 0 };
    e.cadastrados++;
    if (feitas(p.chave) > 0) e.visitados++;
    e.contatos += feitas(p.chave);
    esp.set(p.especialidade, e);
  }
  const especialidades = [...esp.values()]
    .map((e) => {
      const cobertura = pct(e.visitados, e.cadastrados);
      return { ...e, cobertura, atencao: cobertura < 40 || cobertura < coberturaProfissionais * 0.8 };
    })
    .sort((a, b) => b.cadastrados - a.cadastrados);

  const diario = dias.lista.map((dia) => ({
    dia,
    presencial: doRecorte.filter((v) => v.dia === dia && v.presencial).length,
    video: doRecorte.filter((v) => v.dia === dia && !v.presencial).length,
  }));

  const cicloAtual = noRecorte.has(atual);

  return {
    meses,
    cicloAtual,
    cadastro: {
      profissionais: painel.length - estabelecimentos,
      estabelecimentos,
      total: painel.length,
      semConsultor: painel.filter((p) => p.consultorId === null).length,
    },
    execucao: {
      metaContatos,
      contatosNaMeta,
      coberturaContatos: pct(contatosNaMeta, metaContatos),
      excedentes,
      realizadas,
      primeiras,
      revisitas: realizadas - primeiras,
      presenciais,
      videos: realizadas - presenciais,
      percPresencial: pct(presenciais, realizadas),
      percVideo: realizadas > 0 ? umaCasa(100 - pct(presenciais, realizadas)) : 0,
      mediaPorDiaUtil: dias.transcorridos > 0 ? umaCasa(realizadas / dias.transcorridos) : 0,
      necessarioPorDiaUtil: cicloAtual && dias.restantes > 0 ? umaCasa(faltamNoAtual / dias.restantes) : null,
      consultores: new Set(doRecorte.map((v) => v.consultorId)).size,
    },
    alcance: {
      unicos,
      unicosPainel,
      foraDoPainel: unicos - unicosPainel,
      naoVisitados: painel.length - unicosPainel,
      coberturaPainel: pct(unicosPainel, painel.length),
      coberturaProfissionais,
      frequencia: unicos > 0 ? Math.round((realizadas / unicos) * 100) / 100 : 0,
      multi,
      indiceRevisita: pct(multi, unicos),
      completos,
    },
    concentracao: { clientes: alta.length, visitas: alta.reduce((s, c) => s + c.n, 0) },
    maisVisitados: [...porProfissional.entries()]
      .filter(([, c]) => c.n >= 2)
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 3)
      .map(([k, c]) => ({ nome: profissionais.get(k)?.nome ?? "", contatos: c.n })),
    especialidades,
    dias: { total: dias.total, transcorridos: dias.transcorridos, restantes: dias.restantes },
    diario,
  };
}

export async function visaoGeral(f: FiltrosVisao, agora = new Date()) {
  const recorte = await calcularCiclo(f, agora);
  // Período anterior do mesmo tamanho (ex.: 3 ciclos → os 3 meses antes de cada um), com os mesmos filtros.
  const anterior = await calcularCiclo({ ...f, meses: recorte.meses.map((m) => deslocarMes(m, -recorte.meses.length)) }, agora);
  return {
    ...recorte,
    // Para a comparação nas respostas rápidas (nulo se o período anterior não teve visitas).
    anterior:
      anterior.execucao.realizadas > 0
        ? {
            meses: anterior.meses,
            mediaPorDiaUtil: anterior.execucao.mediaPorDiaUtil,
            coberturaPainel: anterior.alcance.coberturaPainel,
            coberturaContatos: anterior.execucao.coberturaContatos,
          }
        : null,
  };
}

/** Opções dos filtros da visão geral: ciclos com visitas, consultores, especialidades e cidades. */
export async function opcoesVisaoGeral(agora = new Date()) {
  const [primeira, consultores, cadastros] = await Promise.all([
    prisma.visita.aggregate({ _min: { dataHora: true } }),
    prisma.usuario.findMany({ where: { papel: "consultor", status: "ativo" }, select: { id: true, nome: true }, orderBy: { nome: "asc" } }),
    prisma.medicoClinica.findMany({ select: { especialidade: true, cidade: true } }),
  ]);
  const atual = chaveMes(agora);
  const meses: string[] = [];
  for (let m = primeira._min.dataHora ? chaveMes(primeira._min.dataHora) : atual; m <= atual; m = deslocarMes(m, 1)) meses.push(m);
  const unicos = (l: (string | null)[]) => [...new Set(l.map((x) => x?.trim()).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b, "pt"));
  return {
    meses: meses.reverse(),
    consultores,
    especialidades: unicos(cadastros.map((c) => c.especialidade)),
    cidades: unicos(cadastros.map((c) => c.cidade)),
  };
}
