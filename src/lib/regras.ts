import { prisma } from "./prisma";
import { ErroHttp } from "./erros";
import { chaveDia, limitesDoDia, somarDias } from "./datas";

/** Quantos dias para trás uma visita ainda pode ser registrada/salva. */
export const DIAS_LIMITE_REGISTRO = Number(process.env.DIAS_LIMITE_REGISTRO ?? 5);

/** Tolerância para enviar uma visita marcada para daqui a pouco (ex.: chegou antes do horário). */
const TOLERANCIA_FUTURO_MIN = 60;

/** Início do dia mais antigo em que ainda é permitido registrar uma visita. */
export function limiteRegistro(agora = new Date()) {
  return limitesDoDia(somarDias(agora, -DIAS_LIMITE_REGISTRO)).inicio;
}

/** Dias que faltam para a visita sair da janela de registro (0 = último dia). */
export function diasRestantesParaRegistro(dataHora: Date, agora = new Date()) {
  const limiteDaVisita = somarDias(limitesDoDia(dataHora).inicio, DIAS_LIMITE_REGISTRO);
  const hoje = limitesDoDia(agora).inicio;
  return Math.round((limiteDaVisita.getTime() - hoje.getTime()) / 86_400_000);
}

export function validarJanelaRegistro(dataHora: Date) {
  if (dataHora < limiteRegistro()) {
    throw new ErroHttp(422, `Você não pode salvar uma visita ocorrida mais de ${DIAS_LIMITE_REGISTRO} dias antes.`);
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
