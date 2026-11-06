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
  /** "YYYY-MM"; vazio = ciclo atual. */
  mes?: string;
  consultorId?: string;
  especialidade?: string;
  tipo?: "profissional" | "estabelecimento";
  modalidade?: "presencial" | "video";
  cidade?: string;
  contatos?: FaixaContatos;
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
 * Visão geral do ciclo (mês) para o gestor. Cada profissional da carteira tem uma meta de contatos
 * (1 = só a primeira visita; 4 = primeira + 3 revisitas). A meta do ciclo é a soma dessas metas e a
 * cobertura de contatos conta, de cada profissional, no máximo o alocado: visitar demais um médico
 * não compensa outro que ficou sem visita. Só visitas realizadas contam; médias usam dias úteis.
 */
async function calcularCiclo(f: FiltrosVisao, agora: Date) {
  const mes = f.mes ?? chaveMes(agora);
  const referencia = new Date(`${mes}-15T12:00:00${FUSO}`);
  const { inicio, fim } = limitesDoMes(referencia);
  const dias = diasUteisDoMes(referencia, agora);

  const [cadastros, visitas] = await Promise.all([
    prisma.medicoClinica.findMany({
      select: { id: true, grupoId: true, nomeMedico: true, especialidade: true, profissao: true, cidade: true, contatosCiclo: true, consultorId: true },
    }),
    prisma.visita.findMany({
      where: { status: "realizado", dataHora: { gte: inicio, lte: fim }, ...(f.consultorId ? { consultorId: f.consultorId } : {}) },
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
    (!f.especialidade || p.especialidade === f.especialidade) &&
    (!f.tipo || p.estabelecimento === (f.tipo === "estabelecimento")) &&
    (!f.cidade || p.cidade === f.cidade) &&
    (!busca || normalizar(p.nome).includes(busca));

  let painel = [...profissionais.values()].filter((p) => confere(p) && (!f.consultorId || p.consultorId === f.consultorId));

  // Visitas do recorte, por profissional.
  type Contagem = { n: number; presencial: number; video: number };
  const porProfissional = new Map<string, Contagem>();
  let doRecorte: { chave: string; dia: string; presencial: boolean; consultorId: string }[] = [];
  for (const v of visitas) {
    const k = chaveProfissional(v.medicoClinica);
    const p = profissionais.get(k);
    if (!p || !confere(p)) continue;
    const presencial = ehPresencial(v);
    if (f.modalidade && presencial !== (f.modalidade === "presencial")) continue;
    const pl = partesLocais(v.dataHora);
    doRecorte.push({ chave: k, dia: `${pl.ano}-${String(pl.mes + 1).padStart(2, "0")}-${String(pl.dia).padStart(2, "0")}`, presencial, consultorId: v.consultorId });
  }
  for (const v of doRecorte) {
    const c = porProfissional.get(v.chave) ?? { n: 0, presencial: 0, video: 0 };
    c.n++;
    if (v.presencial) c.presencial++;
    else c.video++;
    porProfissional.set(v.chave, c);
  }

  // Filtro "contatos no ciclo": mantém só quem está na faixa (inclusive os não visitados, na faixa 0).
  if (f.contatos) {
    const n = (k: string) => porProfissional.get(k)?.n ?? 0;
    painel = painel.filter((p) => naFaixa(n(p.chave), f.contatos));
    doRecorte = doRecorte.filter((v) => naFaixa(n(v.chave), f.contatos));
    for (const k of [...porProfissional.keys()]) if (!naFaixa(n(k), f.contatos)) porProfissional.delete(k);
  }

  const noPainel = new Set(painel.map((p) => p.chave));
  const feitas = (k: string) => porProfissional.get(k)?.n ?? 0;

  // Cadastro e meta de contatos
  const estabelecimentos = painel.filter((p) => p.estabelecimento).length;
  const metaContatos = painel.reduce((s, p) => s + p.contatos, 0);
  const contatosNaMeta = painel.reduce((s, p) => s + Math.min(feitas(p.chave), p.contatos), 0);
  const excedentes = painel.reduce((s, p) => s + Math.max(0, feitas(p.chave) - p.contatos), 0);
  const completos = painel.filter((p) => feitas(p.chave) >= p.contatos).length;

  // Execução
  const realizadas = doRecorte.length;
  const presenciais = doRecorte.filter((v) => v.presencial).length;
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

  const cicloAtual = mes === chaveMes(agora);

  return {
    mes,
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
      primeiras: unicos,
      revisitas: realizadas - unicos,
      presenciais,
      videos: realizadas - presenciais,
      percPresencial: pct(presenciais, realizadas),
      percVideo: realizadas > 0 ? umaCasa(100 - pct(presenciais, realizadas)) : 0,
      mediaPorDiaUtil: dias.transcorridos > 0 ? umaCasa(realizadas / dias.transcorridos) : 0,
      necessarioPorDiaUtil: cicloAtual && dias.restantes > 0 ? umaCasa(Math.max(0, metaContatos - contatosNaMeta) / dias.restantes) : null,
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
  const atual = await calcularCiclo(f, agora);
  const anterior = await calcularCiclo({ ...f, mes: deslocarMes(atual.mes, -1) }, agora);
  return {
    ...atual,
    // Ciclo anterior com os mesmos filtros, para a comparação nas respostas rápidas (nulo se não teve visitas).
    anterior:
      anterior.execucao.realizadas > 0
        ? {
            mes: anterior.mes,
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
