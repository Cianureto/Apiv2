// Interpreta o padrão de dias de atendimento cadastrado no médico/clínica,
// ex: "2ª e 6ªT · 3ª e 4ª MT", "5ª — 11:30h", "por agendamento".
// Mapeia para os dias da semana do JS: 0=domingo ... 6=sábado.
import { diaDaSemana, somarDias } from "./datas";

const MAPA_DIAS: { regex: RegExp; dia: number }[] = [
  { regex: /2ª/, dia: 1 },
  { regex: /3ª/, dia: 2 },
  { regex: /4ª/, dia: 3 },
  { regex: /5ª/, dia: 4 },
  { regex: /6ª/, dia: 5 },
  { regex: /7ª|sáb/i, dia: 6 },
  { regex: /dom/i, dia: 0 },
];

export function diasDaSemana(padraoHorario: string): number[] {
  const dias = new Set<number>();
  for (const { regex, dia } of MAPA_DIAS) {
    if (regex.test(padraoHorario)) dias.add(dia);
  }
  return Array.from(dias);
}

export function atendeNoDia(padraoHorario: string, data: Date): boolean {
  return diasDaSemana(padraoHorario).includes(diaDaSemana(data));
}

export function atendeHoje(padraoHorario: string): boolean {
  return atendeNoDia(padraoHorario, new Date());
}

export function atendeAmanha(padraoHorario: string): boolean {
  return atendeNoDia(padraoHorario, somarDias(new Date(), 1));
}
