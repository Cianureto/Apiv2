// Profissões atendidas e o conselho de cada uma. O registro (conselho + UF + número) identifica o
// profissional: um CRM e um CRN podem ter o mesmo número, então o conselho entra sempre na chave.
export const PROFISSOES = {
  medico: { rotulo: "Médico(a)", conselho: "CRM" },
  nutricionista: { rotulo: "Nutricionista", conselho: "CRN" },
  farmaceutico: { rotulo: "Farmacêutico(a)", conselho: "CRF" },
  educador_fisico: { rotulo: "Educador(a) físico(a)", conselho: "CREF" },
  fisioterapeuta: { rotulo: "Fisioterapeuta", conselho: "CREFITO" },
  esteticista: { rotulo: "Esteticista", conselho: null },
  clinica: { rotulo: "Clínica", conselho: null },
  academia: { rotulo: "Academia", conselho: null },
} as const;

export type Profissao = keyof typeof PROFISSOES;
export const LISTA_PROFISSOES = Object.keys(PROFISSOES) as [Profissao, ...Profissao[]];

export const UFS = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA",
  "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
] as const;

export function conselhoDaProfissao(profissao: Profissao) {
  return PROFISSOES[profissao].conselho;
}

/** "0007834" -> "7834"; vazio -> null. */
export function normalizarNumeroRegistro(numero?: string | null) {
  const digitos = (numero ?? "").replace(/\D/g, "").replace(/^0+/, "");
  return digitos || null;
}

/** Registro formatado para exibir e para ligar às receitas: "CRN-CE 16459". */
export function formatarRegistro(conselho: string | null, uf: string | null, numero: string | null) {
  if (!conselho || !numero) return null;
  return `${conselho}${uf ? `-${uf}` : ""} ${numero}`;
}
