import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const senhaPadrao = await bcrypt.hash("123456", 10);

  const gestor = await prisma.usuario.upsert({
    where: { email: "gestor@connectland.com" },
    update: {},
    create: {
      nome: "Gestor(a) de Campo",
      email: "gestor@connectland.com",
      senhaHash: senhaPadrao,
      papel: "gestor",
      regiao: "ConnectLand Central",
      status: "ativo",
    },
  });

  const consultoresSeed = [
    { nome: "Bruna Ferreira", email: "bruna@connectland.com", regiao: "Fortaleza — Zona Sul", status: "ativo" as const },
    { nome: "Carlos Mendes", email: "carlos@connectland.com", regiao: "Fortaleza — Centro", status: "ativo" as const },
    { nome: "Débora Lima", email: "debora@connectland.com", regiao: "Caucaia", status: "ativo" as const },
    { nome: "Rafael Souza", email: "rafael@connectland.com", regiao: "Fortaleza — Aldeota", status: "ativo" as const },
    { nome: "Juliana Alves", email: "juliana@connectland.com", regiao: "Maracanaú", status: "ativo" as const },
    { nome: "Thiago Rocha", email: "thiago@connectland.com", regiao: "Fortaleza — Messejana", status: "ativo" as const },
    { nome: "Marina Tavares", email: "marina@connectland.com", regiao: "Fortaleza — Papicu", status: "pendente" as const },
  ];

  const consultores: Record<string, string> = {};
  for (const c of consultoresSeed) {
    const u = await prisma.usuario.upsert({
      where: { email: c.email },
      update: {},
      create: { nome: c.nome, email: c.email, senhaHash: senhaPadrao, papel: "consultor", regiao: c.regiao, status: c.status },
    });
    consultores[c.nome] = u.id;
  }

  const produtos = ["Linha Dermocosmética", "Suplementos Vitamínicos", "Linha de Genéricos", "Produtos Dermatológicos", "Linha Infantil"];
  for (const nome of produtos) {
    await prisma.produto.upsert({ where: { nome }, update: {}, create: { nome, categoria: "Geral" } });
  }

  const medicosSeed = [
    { nomeMedico: "Glay Maranhão", especialidade: "Ortopedista", clinica: "Centiser", bairro: "Joaquim Távora", padraoHorario: "2ª e 6ªT · 3ª e 4ª MT" },
    { nomeMedico: "Bruno Guedes", especialidade: "Gineco/Obstetra", clinica: "Medical Center", bairro: "Aldeota", padraoHorario: "3ª e 4ª M (entrada)" },
    { nomeMedico: "Carlos Windson", especialidade: "Ortopedista", clinica: "Medical Center", bairro: "Aldeota", padraoHorario: "3ª M" },
    { nomeMedico: "Charles Samuel", especialidade: "Ortopedista", clinica: "Osteo", bairro: "Dionísio Torres", padraoHorario: "3ª M (consul) · 5ª (emerg)" },
    { nomeMedico: "Júlio César", especialidade: "Ortopedista", clinica: "Osteo", bairro: "Dionísio Torres", padraoHorario: "3ª DT · 4ª 13:30h" },
    { nomeMedico: "Mabele Lima", especialidade: "Gineco/Rep Humana", clinica: "Evangelista Torquato", bairro: "Dionísio Torres", padraoHorario: "2ª T · 6ª M" },
    { nomeMedico: "Tatiana Nobre Souza", especialidade: "Nutróloga", clinica: "Medical Gênesis", bairro: "Aldeota", padraoHorario: "4ª e 5ª T" },
    { nomeMedico: "Karita Melo", especialidade: "Gineco", clinica: "Scopa", bairro: "Meireles", padraoHorario: "2ª e 5ª T" },
    { nomeMedico: "Gervásio Colares", especialidade: "Gineco", clinica: "Fernando Pessoa", bairro: "Dionísio Torres", padraoHorario: "5ª — 11:30h" },
    { nomeMedico: "Everton de Castro", especialidade: "Urologista", clinica: "Vagner Paiva", bairro: "Aldeota", padraoHorario: "2ª M" },
    { nomeMedico: "Autran Nunes", especialidade: "Gineco", clinica: "Pátio Dom Luiz 2", bairro: "Meireles", padraoHorario: "por agendamento" },
    { nomeMedico: "Dr. Eduardo Castro", especialidade: "Dermatologista", clinica: "Clínica Vitalis", bairro: "Aldeota", padraoHorario: "2ª e 4ª M" },
    { nomeMedico: "Dra. Marina Prado", especialidade: "Clínico Geral", clinica: "Hospital São Lucas", bairro: "Centro", padraoHorario: "2ª e 6ª M" },
    { nomeMedico: "Dr. Henrique Bastos", especialidade: "Clínico Geral", clinica: "Consultório Particular", bairro: "Centro", padraoHorario: "3ª e 6ª M" },
    { nomeMedico: "Dra. Camila Rezende", especialidade: "Dermatologista", clinica: "Clínica Bem Estar", bairro: "Aldeota", padraoHorario: "3ª T" },
    { nomeMedico: "Dr. Otávio Nunes", especialidade: "Pediatra", clinica: "Hospital Regional", bairro: "Messejana", padraoHorario: "2ª T" },
    { nomeMedico: "Dra. Patrícia Gomes", especialidade: "Ginecologista", clinica: "Clínica Vitalis", bairro: "Aldeota", padraoHorario: "4ª T · 6ª M" },
    { nomeMedico: "Dr. Felipe Andrade", especialidade: "Clínico Geral", clinica: "Consultório Particular", bairro: "Centro", padraoHorario: "5ª M" },
    { nomeMedico: "Dra. Beatriz Nogueira", especialidade: "Dermatologista", clinica: "Hospital São Lucas", bairro: "Centro", padraoHorario: "5ª M" },
    { nomeMedico: "Dra. Ana Beatriz Lins", especialidade: "Nutróloga", clinica: "Consultório Particular", bairro: "Centro", padraoHorario: "4ª T" },
    { nomeMedico: "Dr. Marcos Vinícius", especialidade: "Clínico Geral", clinica: "Hospital São Lucas", bairro: "Centro", padraoHorario: "4ª T" },
  ];

  // Endereços fictícios por clínica, para a tela "Contas".
  const enderecosClinica: Record<string, string> = {
    Centiser: "Av. Visconde do Rio Branco, 2800",
    "Medical Center": "Rua Silva Paulet, 1800",
    Osteo: "Rua Tibúrcio Cavalcante, 2600",
    "Evangelista Torquato": "Av. Rui Barbosa, 2400",
    "Medical Gênesis": "Rua Carolina Sucupira, 700",
    Scopa: "Av. Dom Luís, 1200",
    "Fernando Pessoa": "Rua Pereira Valente, 1100",
    "Vagner Paiva": "Rua Barbosa de Freitas, 1500",
    "Pátio Dom Luiz 2": "Av. Dom Luís, 1200 — Torre 2",
    "Clínica Vitalis": "Av. Santos Dumont, 3000",
    "Hospital São Lucas": "Rua Senador Pompeu, 900",
    "Consultório Particular": "Rua Guilherme Rocha, 400",
    "Clínica Bem Estar": "Av. Desembargador Moreira, 1300",
    "Hospital Regional": "Av. Frei Cirilo, 3480",
  };
  function slug(texto: string) {
    return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/^(dr|dra)\.?\s+/, "").replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "");
  }

  const medicos: Record<string, string> = {};
  for (const [i, m] of medicosSeed.entries()) {
    const contato = {
      crm: `CRM-CE ${10000 + i * 137}`,
      endereco: enderecosClinica[m.clinica] ?? null,
      cidade: "Fortaleza",
      uf: "CE",
      telefone: `(85) 9${String(8100 + i * 41).padStart(4, "0")}-${String(1000 + i * 73).slice(-4)}`,
      email: `${slug(m.nomeMedico)}@exemplo.com.br`,
    };
    const existente = await prisma.medicoClinica.findFirst({ where: { nomeMedico: m.nomeMedico, clinica: m.clinica } });
    const registro = existente
      ? existente.endereco
        ? existente
        : await prisma.medicoClinica.update({ where: { id: existente.id }, data: contato })
      : await prisma.medicoClinica.create({ data: { ...m, ...contato } });
    medicos[m.nomeMedico] = registro.id;
  }

  const hoje = new Date();
  function dataHoraRelativa(diffDias: number, hora: number, minuto: number) {
    const d = new Date(hoje);
    d.setDate(d.getDate() + diffDias);
    d.setHours(hora, minuto, 0, 0);
    return d;
  }

  const visitasSeed = [
    { consultor: "Bruna Ferreira", medico: "Dr. Eduardo Castro", dia: 0, h: 8, m: 30, produto: "Linha Dermocosmética", status: "realizado" as const, tipo: "presencial" as const, feedback: "Aprovou reposição mensal automática." },
    { consultor: "Bruna Ferreira", medico: "Dra. Ana Beatriz Lins", dia: 0, h: 10, m: 15, produto: "Suplementos Vitamínicos", status: "realizado" as const, tipo: "online" as const, feedback: "Pediu material técnico extra por e-mail." },
    { consultor: "Bruna Ferreira", medico: "Dr. Marcos Vinícius", dia: 0, h: 13, m: 0, produto: "Linha de Genéricos", status: "confirmado" as const, tipo: null, feedback: null },
    { consultor: "Bruna Ferreira", medico: "Dra. Patrícia Gomes", dia: 0, h: 15, m: 15, produto: "Suplementos Vitamínicos", status: "pendente" as const, tipo: null, feedback: null },
    { consultor: "Carlos Mendes", medico: "Dra. Marina Prado", dia: 0, h: 10, m: 15, produto: "Suplementos Vitamínicos", status: "realizado" as const, tipo: "presencial" as const, feedback: null },
    { consultor: "Débora Lima", medico: "Dr. Henrique Bastos", dia: 0, h: 11, m: 0, produto: "Linha de Genéricos", status: "pendente" as const, tipo: null, feedback: null },
    { consultor: "Rafael Souza", medico: "Dra. Camila Rezende", dia: 0, h: 13, m: 45, produto: "Produtos Dermatológicos", status: "confirmado" as const, tipo: null, feedback: null },
    { consultor: "Juliana Alves", medico: "Dr. Otávio Nunes", dia: 0, h: 14, m: 30, produto: "Linha Infantil", status: "cancelado" as const, tipo: null, feedback: null },
    { consultor: "Carlos Mendes", medico: "Dr. Felipe Andrade", dia: 1, h: 9, m: 0, produto: "Linha de Genéricos", status: "pendente" as const, tipo: null, feedback: null },
    { consultor: "Rafael Souza", medico: "Dra. Beatriz Nogueira", dia: 1, h: 10, m: 30, produto: "Produtos Dermatológicos", status: "confirmado" as const, tipo: null, feedback: null },
    { consultor: "Thiago Rocha", medico: "Dra. Patrícia Gomes", dia: 1, h: 9, m: 30, produto: "Suplementos Vitamínicos", status: "confirmado" as const, tipo: null, feedback: null },
    { consultor: "Débora Lima", medico: "Dr. Henrique Bastos", dia: 1, h: 11, m: 0, produto: "Linha de Genéricos", status: "pendente" as const, tipo: null, feedback: null },
    { consultor: "Carlos Mendes", medico: "Dra. Marina Prado", dia: 1, h: 14, m: 30, produto: "Suplementos Vitamínicos", status: "confirmado" as const, tipo: null, feedback: null },
    { consultor: "Bruna Ferreira", medico: "Dr. Eduardo Castro", dia: -2, h: 9, m: 0, produto: "Linha Dermocosmética", status: "realizado" as const, tipo: "presencial" as const, feedback: "Recebeu bem a linha nova, pediu mais amostras." },
    { consultor: "Carlos Mendes", medico: "Dra. Marina Prado", dia: -2, h: 11, m: 30, produto: "Suplementos Vitamínicos", status: "realizado" as const, tipo: "presencial" as const, feedback: null },
    { consultor: "Juliana Alves", medico: "Dr. Otávio Nunes", dia: -2, h: 14, m: 0, produto: "Linha Infantil", status: "cancelado" as const, tipo: null, feedback: null },
    { consultor: "Rafael Souza", medico: "Dra. Camila Rezende", dia: -1, h: 9, m: 30, produto: "Produtos Dermatológicos", status: "realizado" as const, tipo: "presencial" as const, feedback: null },
    { consultor: "Débora Lima", medico: "Dr. Henrique Bastos", dia: -1, h: 13, m: 15, produto: "Linha de Genéricos", status: "realizado" as const, tipo: "presencial" as const, feedback: null },
    { consultor: "Bruna Ferreira", medico: "Dr. Marcos Vinícius", dia: -1, h: 13, m: 0, produto: "Linha de Genéricos", status: "realizado" as const, tipo: "presencial" as const, feedback: "Pediu para retornar em 30 dias com nova tabela de preços." },
    { consultor: "Bruna Ferreira", medico: "Dra. Patrícia Gomes", dia: -1, h: 15, m: 15, produto: "Suplementos Vitamínicos", status: "cancelado" as const, tipo: null, feedback: null },
    // Relatórios pendentes (aparecem nos alertas da tela Início)
    { consultor: "Bruna Ferreira", medico: "Dra. Camila Rezende", dia: -3, h: 10, m: 0, produto: "Produtos Dermatológicos", status: "confirmado" as const, tipo: null, feedback: null },
    { consultor: "Bruna Ferreira", medico: "Dr. Henrique Bastos", dia: -8, h: 9, m: 30, produto: "Linha de Genéricos", status: "pendente" as const, tipo: null, feedback: null },
    // Próximos dias da semana (preenchem a grade da agenda)
    { consultor: "Bruna Ferreira", medico: "Karita Melo", dia: 1, h: 8, m: 0, produto: "Linha Dermocosmética", status: "confirmado" as const, tipo: null, feedback: null },
    { consultor: "Bruna Ferreira", medico: "Glay Maranhão", dia: 1, h: 14, m: 30, produto: null, status: "pendente" as const, tipo: null, feedback: null },
    { consultor: "Bruna Ferreira", medico: "Tatiana Nobre Souza", dia: 2, h: 9, m: 0, produto: "Suplementos Vitamínicos", status: "confirmado" as const, tipo: null, feedback: null },
    { consultor: "Bruna Ferreira", medico: "Mabele Lima", dia: 2, h: 11, m: 0, produto: "Linha Infantil", status: "pendente" as const, tipo: null, feedback: null },
    { consultor: "Bruna Ferreira", medico: "Dr. Otávio Nunes", dia: 3, h: 15, m: 0, produto: "Linha Infantil", status: "confirmado" as const, tipo: null, feedback: null },
  ];

  for (const v of visitasSeed as { consultor: string; medico: string; dia: number; h: number; m: number; produto: string | null; status: "confirmado" | "realizado" | "pendente" | "cancelado"; tipo: "online" | "presencial" | null; feedback: string | null }[]) {
    const consultorId = consultores[v.consultor];
    const medicoClinicaId = medicos[v.medico];
    if (!consultorId || !medicoClinicaId) continue;
    const dataHora = dataHoraRelativa(v.dia, v.h, v.m);
    const existente = await prisma.visita.findFirst({ where: { consultorId, medicoClinicaId, dataHora } });
    if (existente) continue;
    await prisma.visita.create({
      data: {
        consultorId,
        medicoClinicaId,
        dataHora,
        produto: v.produto,
        status: v.status,
        tipo: v.tipo,
        feedback: v.feedback,
        canal: v.status === "realizado" ? (v.tipo === "online" ? "virtual_teams" : "presencial") : null,
        enviadaEm: v.status === "realizado" ? dataHora : null,
      },
    });
  }

  // Ausências da Bruna: treinamento, férias e uma tarde de outra ausência.
  const bruna = consultores["Bruna Ferreira"];
  if (bruna && (await prisma.ausencia.count({ where: { consultorId: bruna } })) === 0) {
    const inicioDia = (diff: number) => dataHoraRelativa(diff, 0, 0);
    const fimDia = (diff: number) => {
      const d = dataHoraRelativa(diff, 23, 59);
      d.setSeconds(59, 999);
      return d;
    };
    await prisma.ausencia.createMany({
      data: [
        { consultorId: bruna, tipo: "treinamento", inicio: inicioDia(6), fim: fimDia(6), diaInteiro: true, descricao: "Convenção regional de vendas" },
        { consultorId: bruna, tipo: "ferias", inicio: inicioDia(21), fim: fimDia(25), diaInteiro: true, descricao: "Férias" },
        { consultorId: bruna, tipo: "outra", inicio: dataHoraRelativa(4, 13, 0), fim: dataHoraRelativa(4, 18, 0), diaInteiro: false, descricao: "Consulta médica" },
      ],
    });
  }

  // Biblioteca de apresentações com slides de demonstração (SVG gerado aqui mesmo).
  const materiaisSeed = [
    {
      titulo: "Linha Dermocosmética — Apresentação institucional",
      codigo: "CL-DERM-001",
      produto: "Linha Dermocosmética",
      descricao: "Visão geral da linha, benefícios e mensagens-chave para dermatologistas.",
      cor: "#0f6b5c",
      slides: [["Capa", "Linha Dermocosmética"], ["Sumário", "O que vamos ver"], ["Benefícios", "Hidratação e barreira cutânea"], ["Evidências", "Resultados em 4 semanas"], ["Posologia", "Como indicar"], ["Mensagens-chave", "Resumo para o médico"]],
    },
    {
      titulo: "Suplementos Vitamínicos — Guia rápido",
      codigo: "CL-SUP-002",
      produto: "Suplementos Vitamínicos",
      descricao: "Indicações, público-alvo e diferenciais da linha de suplementos.",
      cor: "#a5690a",
      slides: [["Capa", "Suplementos Vitamínicos"], ["Indicações", "Para quem indicar"], ["Composição", "Vitaminas e minerais"], ["Mensagens-chave", "Resumo para o médico"]],
    },
    {
      titulo: "Linha Infantil — Segurança e dosagem",
      codigo: "CL-INF-003",
      produto: "Linha Infantil",
      descricao: "Material para pediatras: faixas etárias, dosagem e segurança.",
      cor: "#6d4bb3",
      slides: [["Capa", "Linha Infantil"], ["Faixas etárias", "Do lactente ao escolar"], ["Dosagem", "Tabela por peso"], ["Segurança", "Perfil de tolerabilidade"], ["Mensagens-chave", "Resumo para o médico"]],
    },
    {
      titulo: "Linha de Genéricos — Tabela e intercambialidade",
      codigo: "CL-GEN-004",
      produto: "Linha de Genéricos",
      descricao: "Tabela de preços e equivalências com os medicamentos de referência.",
      cor: "#1d5fa8",
      slides: [["Capa", "Linha de Genéricos"], ["Intercambialidade", "Equivalência garantida"], ["Tabela", "Apresentações disponíveis"]],
    },
  ];

  function slideSvg(titulo: string, subtitulo: string, secao: string, cor: string, n: number, total: number) {
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">
<rect width="1600" height="1000" fill="#fbfbf9"/>
<rect width="1600" height="14" fill="${cor}"/>
<circle cx="1420" cy="220" r="360" fill="${cor}" opacity="0.08"/>
<circle cx="1500" cy="880" r="220" fill="${cor}" opacity="0.12"/>
<text x="120" y="190" font-family="Inter,Arial,sans-serif" font-size="34" font-weight="600" fill="${cor}" letter-spacing="4">${esc(secao.toUpperCase())}</text>
<text x="120" y="420" font-family="Inter,Arial,sans-serif" font-size="96" font-weight="800" fill="#0b0b0b">${esc(subtitulo)}</text>
<text x="120" y="500" font-family="Inter,Arial,sans-serif" font-size="40" fill="#52514e">${esc(titulo)}</text>
<rect x="120" y="580" width="160" height="10" rx="5" fill="${cor}"/>
<text x="120" y="920" font-family="Inter,Arial,sans-serif" font-size="28" fill="#898781">ConnectLand · material de demonstração</text>
<text x="1480" y="920" text-anchor="end" font-family="Inter,Arial,sans-serif" font-size="28" fill="#898781">${n} / ${total}</text>
</svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  }

  for (const m of materiaisSeed) {
    if (await prisma.material.findFirst({ where: { titulo: m.titulo } })) continue;
    const imagens = m.slides.map(([secao, subtitulo], i) => ({ secao, subtitulo, url: slideSvg(m.titulo, subtitulo, secao, m.cor, i + 1, m.slides.length) }));
    await prisma.material.create({
      data: {
        titulo: m.titulo,
        codigo: m.codigo,
        produto: m.produto,
        descricao: m.descricao,
        thumbnailUrl: imagens[0].url,
        slides: { create: imagens.map((img, i) => ({ ordem: i + 1, secao: img.secao, titulo: img.subtitulo, imagemUrl: img.url })) },
      },
    });
  }

  console.log("Seed concluído. Gestor:", gestor.email, "| senha padrão para todos: 123456");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
