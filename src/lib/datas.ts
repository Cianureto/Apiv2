// Todas as regras de "dia" e "hora" do negócio usam o fuso da operação, não o do servidor.
// Na Vercel o servidor roda em UTC; sem isso, "hoje" viraria "amanhã" às 21h em Fortaleza
// e um agendamento das 14:00 seria gravado como 11:00.
// Fortaleza = -03:00 (sem horário de verão). Pode ser trocado pela env FUSO_HORARIO.
export const FUSO = process.env.FUSO_HORARIO ?? "-03:00";

function minutosDoFuso(fuso: string) {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(fuso);
  if (!m) return -180;
  const total = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -total : total;
}

const OFFSET_MS = minutosDoFuso(FUSO) * 60_000;

/** Cria o instante correspondente a uma data/hora no relógio local do negócio. */
function instanteLocal(ano: number, mes: number, dia: number, hora = 0, minuto = 0, segundo = 0, ms = 0) {
  return new Date(Date.UTC(ano, mes, dia, hora, minuto, segundo, ms) - OFFSET_MS);
}

/** Partes da data como são vistas no relógio local do negócio. */
export function partesLocais(data: Date) {
  const l = new Date(data.getTime() + OFFSET_MS);
  return {
    ano: l.getUTCFullYear(),
    mes: l.getUTCMonth(),
    dia: l.getUTCDate(),
    diaSemana: l.getUTCDay(),
    hora: l.getUTCHours(),
    minuto: l.getUTCMinutes(),
  };
}

export function diaDaSemana(data: Date) {
  return partesLocais(data).diaSemana;
}

/** "YYYY-MM-DD" no relógio local. */
export function chaveDia(data: Date) {
  const p = partesLocais(data);
  return `${p.ano}-${String(p.mes + 1).padStart(2, "0")}-${String(p.dia).padStart(2, "0")}`;
}

/** Converte campos de formulário ("2026-09-22" + "14:30") para o instante correto. */
export function dataHoraDeCampos(data: string, hora: string) {
  const d = new Date(`${data}T${hora.length === 5 ? `${hora}:00` : hora}${FUSO}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Início do dia local de uma data "YYYY-MM-DD". */
export function inicioDoDiaStr(data: string) {
  return dataHoraDeCampos(data, "00:00");
}

export function somarDias(data: Date, dias: number) {
  return new Date(data.getTime() + dias * 86_400_000);
}

export function limitesDoDia(data: Date) {
  const p = partesLocais(data);
  return { inicio: instanteLocal(p.ano, p.mes, p.dia), fim: instanteLocal(p.ano, p.mes, p.dia, 23, 59, 59, 999) };
}

export function limitesDaSemana(data: Date) {
  const p = partesLocais(data);
  const diffParaSegunda = p.diaSemana === 0 ? -6 : 1 - p.diaSemana;
  return {
    inicio: instanteLocal(p.ano, p.mes, p.dia + diffParaSegunda),
    fim: instanteLocal(p.ano, p.mes, p.dia + diffParaSegunda + 6, 23, 59, 59, 999),
  };
}

export function limitesDoMes(data: Date) {
  const p = partesLocais(data);
  return { inicio: instanteLocal(p.ano, p.mes, 1), fim: instanteLocal(p.ano, p.mes + 1, 0, 23, 59, 59, 999) };
}

/** Primeiro dia (local) do mês deslocado em `deslocamento` meses a partir de `data`. */
export function inicioDoMesDeslocado(data: Date, deslocamento: number) {
  const p = partesLocais(data);
  return instanteLocal(p.ano, p.mes + deslocamento, 1);
}

export function mesmodia(a: Date, b: Date) {
  return chaveDia(a) === chaveDia(b);
}
