import { prisma } from "./prisma";
import { ErroHttp } from "./erros";
import { chaveDia, inicioDoMesDeslocado, limitesDoDia, partesLocais } from "./datas";

/** Fechamento do ciclo: visitas de um mês podem ser registradas até este dia do mês seguinte. */
export const DIA_FECHAMENTO_CICLO = Number(process.env.DIA_FECHAMENTO_CICLO ?? 5);

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/** Tolerância para enviar uma visita marcada para daqui a pouco (ex.: chegou antes do horário). */
const TOLERANCIA_FUTURO_MIN = 60;

/** Início do dia mais antigo em que ainda é permitido registrar uma visita (1º do mês atual, ou do anterior até o fechamento). */
export function limiteRegistro(agora = new Date()) {
  return inicioDoMesDeslocado(agora, partesLocais(agora).dia <= DIA_FECHAMENTO_CICLO ? -1 : 0);
}

/** Dias que faltam para a visita sair da janela de registro (0 = último dia). */
export function diasRestantesParaRegistro(dataHora: Date, agora = new Date()) {
  const prazo = inicioDoMesDeslocado(dataHora, 1).getTime() + (DIA_FECHAMENTO_CICLO - 1) * 86_400_000;
  const hoje = limitesDoDia(agora).inicio.getTime();
  return Math.round((prazo - hoje) / 86_400_000);
}

export function validarJanelaRegistro(dataHora: Date) {
  if (dataHora < limiteRegistro()) {
    const mes = partesLocais(dataHora).mes;
    throw new ErroHttp(
      422,
      `O prazo para registrar visitas de ${MESES[mes]} terminou no dia ${DIA_FECHAMENTO_CICLO} de ${MESES[(mes + 1) % 12]}.`,
    );
  }
}

export function validarNaoFutura(dataHora: Date) {
  if (dataHora.getTime() > Date.now() + TOLERANCIA_FUTURO_MIN * 60_000) {
    throw new ErroHttp(422, "Não é possível enviar uma visita com data futura. Ajuste a data e hora para quando ela aconteceu.");
  }
}

const NOME_AUSENCIA = { ferias: "nas suas férias", treinamento: "no seu treinamento/convenção", outra: "na sua ausência" } as const;

/** Bloqueia visitas que caem em cima de férias, treinamentos ou outras ausências do consultor. */
export async function validarSemAusencia(consultorId: string, inicio: Date, duracaoMin: number) {
  const fim = new Date(inicio.getTime() + duracaoMin * 60_000);
  const conflito = await prisma.ausencia.findFirst({
    where: { consultorId, inicio: { lt: fim }, fim: { gt: inicio } },
    orderBy: { inicio: "asc" },
  });
  if (conflito) {
    const periodo =
      chaveDia(conflito.inicio) === chaveDia(conflito.fim)
        ? `em ${formatarDia(conflito.inicio)}`
        : `de ${formatarDia(conflito.inicio)} a ${formatarDia(conflito.fim)}`;
    throw new ErroHttp(409, `Esse horário cai ${NOME_AUSENCIA[conflito.tipo]} (${periodo}).`, { ausenciaId: conflito.id });
  }
}

function formatarDia(d: Date) {
  const [ano, mes, dia] = chaveDia(d).split("-");
  return `${dia}/${mes}/${ano}`;
}
