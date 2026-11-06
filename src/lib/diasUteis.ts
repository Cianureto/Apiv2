import { chaveDia, partesLocais } from "./datas";

// Calendário de Fortaleza: sem sábados, domingos e feriados nacionais, do Ceará e do município
// (Carnaval entra como ponto facultativo). As médias de produtividade dividem só por estes dias.

const doisDigitos = (n: number) => String(n).padStart(2, "0");
const chave = (ano: number, mes: number, dia: number) => `${ano}-${doisDigitos(mes + 1)}-${doisDigitos(dia)}`;

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher), mês 0-11. */
function pascoa(ano: number) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(ano, mes - 1, dia);
}

function aPartirDaPascoa(ano: number, dias: number) {
  const d = new Date(pascoa(ano) + dias * 86_400_000);
  return chave(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const cacheFeriados = new Map<number, Set<string>>();

export function feriadosDoAno(ano: number) {
  let feriados = cacheFeriados.get(ano);
  if (!feriados) {
    feriados = new Set([
      chave(ano, 0, 1), // Confraternização Universal
      aPartirDaPascoa(ano, -48), // Carnaval (segunda)
      aPartirDaPascoa(ano, -47), // Carnaval (terça)
      chave(ano, 2, 19), // São José (CE)
      chave(ano, 2, 25), // Data Magna do Ceará
      aPartirDaPascoa(ano, -2), // Sexta-feira da Paixão
      chave(ano, 3, 21), // Tiradentes
      chave(ano, 4, 1), // Dia do Trabalho
      aPartirDaPascoa(ano, 60), // Corpus Christi (Fortaleza)
      chave(ano, 7, 15), // Nossa Senhora da Assunção (Fortaleza)
      chave(ano, 8, 7), // Independência
      chave(ano, 9, 12), // Nossa Senhora Aparecida
      chave(ano, 10, 2), // Finados
      chave(ano, 10, 15), // Proclamação da República
      chave(ano, 10, 20), // Consciência Negra
      chave(ano, 11, 25), // Natal
    ]);
    cacheFeriados.set(ano, feriados);
  }
  return feriados;
}

/**
 * Dias úteis do mês de `referencia` ("YYYY-MM-DD" em `lista`): total, quantos já passaram (incluindo
 * hoje, se for útil) e quantos faltam. Num mês já encerrado, todos contam como transcorridos.
 */
export function diasUteisDoMes(referencia: Date, agora = new Date()) {
  const { ano, mes } = partesLocais(referencia);
  const hoje = chaveDia(agora);
  const feriados = feriadosDoAno(ano);
  const ultimoDia = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
  const lista: string[] = [];
  let transcorridos = 0;
  for (let dia = 1; dia <= ultimoDia; dia++) {
    const diaSemana = new Date(Date.UTC(ano, mes, dia)).getUTCDay();
    const k = chave(ano, mes, dia);
    if (diaSemana === 0 || diaSemana === 6 || feriados.has(k)) continue;
    lista.push(k);
    if (k <= hoje) transcorridos++;
  }
  return { total: lista.length, transcorridos, restantes: lista.length - transcorridos, lista };
}
