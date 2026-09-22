# ConnectLand v2 — Agenda semanal, relatório de visita e apresentações

Este documento descreve o que foi implementado nos dois repositórios (`connectland-api` e `connectland-app`)
para deixar o app do consultor parecido com o app de tablet de propagandista mostrado nos vídeos de referência
(agenda semanal com arrastar, ausências, relatório de visita, contas e biblioteca de apresentações).

Use este arquivo como contexto no VS Code: *"leia o ESPECIFICACAO.md e ..."*.

---

## 1. O que o vídeo mostra → o que foi feito

| No vídeo (app de referência) | No ConnectLand |
|---|---|
| Tela inicial com alertas, visitas do dia, sugestões | **Início** (`/inicio`): planejadas/enviadas hoje, relatórios pendentes com prazo, sugestões de visita, semana, ausências |
| Lista de contas (nome, endereço, telefone, e-mail, ações) | **Contas** (`/contas`): busca, filtro por especialidade, "atendem hoje", ficha lateral com histórico; ações agendar / registrar agora / apresentar / mapa |
| Agenda semanal em grade de horários; médicos à esquerda; **arrastar o médico para o calendário** | **Agenda** (`/agenda`): visões Dia / Semana / Mês; grade 07h–21h; painel de contas arrastável; mover visita arrastando; toque-e-toque no celular |
| Faixa de dia inteiro: "Outras ausências", "Férias", "Treinamentos e convenções" | **Ausências**: faixa "dia todo" + ausências de parte do dia; criar/editar/excluir |
| Cores: verde (planejada), teal (enviada), vermelho (ausência) | Mesma lógica: planejada, confirmada, relatório pendente (âmbar), enviada (teal sólido), cancelada (riscada), ausência (vermelho) |
| Alerta: *"Você não pode salvar uma visita ocorrida mais de 5 dias antes"* | Mesma regra no backend **e** no front (dias fora do prazo aparecem hachurados) |
| Relatório de visitas: conta, local, endereço, canal (Presencial, MS Teams, Zoom...), motivo, foco, acompanhada, amostras; Salvar / Enviar / Excluir | **Relatório de visita** (`/visitas/:id`): todos esses campos + amostras (produto, qtd, lote) + materiais apresentados + observações; Salvar rascunho / Enviar (trava) / Cancelar / Excluir |
| Biblioteca de apresentações (miniaturas, favoritos) | **Apresentações** (`/apresentacoes`): Todas / Favoritas / Recentes, busca, filtro por produto |
| Apresentação em tela cheia, sumário por seção, ao concluir **"Selecionar conta"** | **Player** (`/apresentacoes/:id`): tela cheia, swipe/setas/teclado, sumário por seção, mede tempo por slide; ao concluir registra para o médico (liga à visita do dia ou cria uma) e abre o relatório |
| (gestor) conteúdo da biblioteca | **Gestor → Apresentações** (`/materiais`): cria material, envia **imagens ou PDF** (cada página vira slide), ordena, define seção e capa, ativa/desativa, pré-visualiza |

Não foram copiados nome, logo ou materiais do app de referência — só o fluxo e o layout. As cores seguem a identidade do ConnectLand (`--petroleo`). Para trocar o destaque (ex.: laranja), altere `--petroleo`/`--petroleo-escuro`/`--petroleo-claro` em `src/index.css`.

---

## 2. Regras de negócio

- **Janela de registro (5 dias):** não é possível criar, mover ou salvar uma visita cuja data seja anterior ao início do dia de *hoje − 5*. Configurável por env `DIAS_LIMITE_REGISTRO` (API). O front usa o valor devolvido em `/consultor/agenda` e `/consultor/painel`.
- **Sem data futura ao enviar:** o relatório só pode ser enviado se a visita não estiver mais de 60 min no futuro.
- **Canal obrigatório para enviar** (presencial, Teams, Zoom, chamada de vídeo, telefone, outro). O campo antigo `tipo` (online/presencial) é preenchido automaticamente a partir do canal.
- **Enviada = travada:** após enviar (`status = realizado`, `enviadaEm`), a visita não pode ser editada, movida nem excluída pelo consultor.
- **Ausências bloqueiam a agenda:** criar/mover visita em cima de férias, treinamento ou outra ausência retorna 409 com a mensagem explicando o conflito. Ao criar uma ausência, a API avisa quantas visitas planejadas ficaram em cima dela.
- **Consultor** cancela as próprias visitas (vira "cancelado", continua no histórico) e pode excluir as que não foram enviadas. O **gestor** continua podendo tudo.
- **Apresentação → visita:** ao registrar uma apresentação, ela é ligada à visita informada; senão à visita planejada de hoje com aquele médico; senão uma visita nova é criada (status pendente, canal presencial) para o consultor preencher o relatório.
- **Fuso horário:** toda regra de "dia" usa `America/Fortaleza` (`FUSO_HORARIO=-03:00` por padrão), não o fuso do servidor (a Vercel roda em UTC). Ver seção 6.

---

## 3. Banco de dados (Prisma)

Só **adições** — nada existente é removido. SQL equivalente em `prisma/sql/2026-09-v2-agenda-relatorio-apresentacoes.sql`.

**Enums novos:** `CanalVisita`, `TipoAusencia`.

**`MedicoClinica` (+):** `crm`, `endereco`, `cidade`, `uf`, `cep`, `telefone`, `email`.

**`Visita` (+):** `duracaoMin` (padrão 30), `canal`, `local`, `motivo`, `foco`, `acompanhada`, `acompanhante`, `relatorioSalvoEm`, `enviadaEm`; `produto` passou a ser **opcional** (a visita pode nascer arrastando o médico, sem produto).

**Tabelas novas:**
- `AmostraEntregue` (visita, produto, quantidade, lote)
- `Ausencia` (consultor, tipo, início, fim, diaInteiro, descrição)
- `Material` (título, código, produto, descrição, capa, ativo)
- `Slide` (material, ordem, seção, título, imagem)
- `MaterialFavorito` (usuário × material)
- `RegistroApresentacao` (material, consultor, médico, visita, início, fim, duração, slides vistos com segundos)

**Aplicar:** `npm run db:push` (como o projeto já faz) **ou** rodar o SQL no Supabase. Depois `npm run db:seed` para dados de demonstração (contatos dos médicos, ausências e 4 materiais com slides). O seed pode ser rodado de novo sem duplicar.

---

## 4. API — rotas novas e alteradas

Todas exigem `Authorization: Bearer <token>`. Rotas antigas continuam funcionando (o front antigo segue compatível).

### Visitas (`src/routes/visitas.ts`)
| Método | Rota | Quem | O que faz |
|---|---|---|---|
| GET | `/visitas/:id` | dono ou gestor | Relatório completo (médico com contato, amostras, apresentações) |
| POST | `/visitas` | todos | Agora aceita `dataHora` (ISO) **ou** `data`+`hora`; `produto`, `duracaoMin`, `canal` opcionais; aplica regra dos 5 dias e ausências |
| PATCH | `/visitas/:id/reagendar` | dono ou gestor | `{ dataHora, duracaoMin? }` — usado ao arrastar |
| PATCH | `/visitas/:id/relatorio` | consultor dono | Salvar rascunho (campos do relatório + `amostras[]` + `dataHora`) |
| POST | `/visitas/:id/enviar` | consultor dono | Salva e envia (trava) |
| PATCH | `/visitas/:id/cancelar` | dono ou gestor | Cancela |
| DELETE | `/visitas/:id` | gestor; consultor se não enviada | Exclui |
| PATCH | `/visitas/:id/realizar` | consultor | Fluxo antigo, mantido (agora também respeita os 5 dias) |

### Consultor (`src/routes/consultor.ts`)
- `GET /consultor/agenda?inicio=ISO&fim=ISO` → `{ visitas, ausencias, diasLimiteRegistro }` (sem parâmetros mantém a janela antiga).
- `GET /consultor/painel` → dados da tela Início (hoje, semana, alertas, sugestões, ausências, indicadores).

### Ausências (`src/routes/ausencias.ts`)
- `GET /ausencias?inicio&fim&consultorId` · `POST /ausencias` · `PATCH /ausencias/:id` · `DELETE /ausencias/:id`
- Corpo: `{ tipo: "ferias"|"treinamento"|"outra", inicio, fim, diaInteiro, descricao? }` — com `diaInteiro`, `inicio`/`fim` podem ser `YYYY-MM-DD`.

### Médicos (`src/routes/medicos.ts`)
- `GET /medicos` agora traz os campos de contato e, para o consultor, `ultimaVisitaEm` / `proximaVisitaEm`.
- `GET /medicos/:id` → ficha com visitas e apresentações. `PATCH /medicos/:id` (gestor). `POST` aceita contato.

### Materiais e apresentações (`src/routes/materiais.ts`, `src/routes/apresentacoes.ts`)
- `GET /materiais` (gestor: `?todos=1` inclui inativos) · `GET /materiais/:id` (com slides)
- Gestor: `POST /materiais`, `PATCH /materiais/:id`, `DELETE /materiais/:id`, `POST /materiais/:id/slides`, `PATCH /materiais/:id/slides/:slideId`, `PUT /materiais/:id/slides/ordem`, `DELETE /materiais/:id/slides/:slideId`
- Todos: `POST /materiais/:id/favorito` (liga/desliga)
- Consultor: `POST /apresentacoes/registros` `{ materialId, medicoClinicaId, visitaId?, inicio, fim, slides:[{slideId, segundos}] }` → `{ visitaId, visitaCriada }`

**Imagens dos slides:** o front comprime (JPEG, até 1600px, ~200–400 KB) e envia como data URL; a API aceita URL http(s) ou data URL até ~3,5 MB por slide (`express.json` com limite 5 MB; a Vercel aceita até 4,5 MB por requisição). Para muito volume, trocar por Supabase Storage / Vercel Blob e gravar só a URL (a coluna já aceita URL).

**Erros:** `src/lib/erros.ts` (`ErroHttp`) + tratamento em `app.ts` (status correto, 404 para registro inexistente, 413 para corpo grande).

---

## 5. Front — arquivos

**Novos**
- `src/pages/consultor/InicioPage.tsx`, `ContasPage.tsx`, `ApresentacoesPage.tsx`, `RelatorioVisitaPage.tsx`
- `src/pages/ApresentacaoPlayerPage.tsx` (consultor e pré-visualização do gestor)
- `src/pages/gestor/MateriaisPage.tsx`
- `src/components/consultor/`: `Cabecalho`, `GradeSemana` (grade semanal), `PainelContas` (lista arrastável), `useArraste` (arrastar com Pointer Events — mouse, caneta e dedo), `AusenciaModal`, `SelecionarContaModal`, `VisitaItem`, `estiloVisita`
- `src/components/Aviso.tsx` (alerta/confirmação estilo iPad)
- `src/lib/imagens.ts` (compressão de imagem e PDF → slides com `pdfjs-dist`, build *legacy* para funcionar no Safari do iPad; carregado só quando usado)

**Alterados**
- `App.tsx` (rotas novas; consultor entra em `/inicio`), `ProtectedRoute.tsx`
- `ConsultorLayout.tsx` (tela larga + barra de abas inferior: Início, Contas, Agenda, Apresentações, Histórico, Perfil)
- `AgendaPage.tsx` (reescrita), `HistoricoPage.tsx` (abre o relatório), `PerfilPage.tsx` (largura)
- `NovoAgendamentoConsultorModal.tsx` (produto opcional, duração, valores iniciais), `NovoContatoModal.tsx` (endereço, telefone, e-mail, CRM)
- `GestorLayout.tsx` (menu "Apresentações"), `MedicosPage.tsx` e `PainelPage.tsx` (contato / produto opcional)
- `api/types.ts`, `api/client.ts` (`put`), `lib/format.ts` (canais, ausências, estado da visita, datas), `icons.tsx`
- `package.json`: + `pdfjs-dist`

**Removido:** `MarcarRealizadaModal.tsx` (substituído pelo relatório de visita).

### Como a agenda funciona (para dar manutenção)
- A grade usa `HORA_INICIO=7`, `HORA_FIM=21`, `PX_POR_HORA=56`, passo de 15 min (`useArraste.ts`).
- Cada coluna de dia tem `data-coluna-dia="YYYY-MM-DD"`; ao soltar, `alvoNoPonto()` usa `document.elementFromPoint` para achar o dia e calcula o horário pela posição Y.
- No mouse, arrasta pelo item inteiro; no toque, pela alça (⋮⋮) ou toca no médico e depois no horário.
- Depois de soltar aparece um aviso com **Desfazer**.
- Estados das visitas: `estadoVisita()` em `lib/format.ts`.

---

## 6. Atenção: fuso horário (bug antigo corrigido)

Antes, a API montava a data com `new Date("2026-09-22T14:00:00")`, que na Vercel (UTC) vira 14:00 UTC = **11:00 em Fortaleza**. Agora as datas vindas de `data`+`hora` são interpretadas em `-03:00`, e o front novo manda `dataHora` já em ISO.

Se em produção as visitas antigas aparecem **3 horas antes** do horário que foi digitado, é esse bug. As novas ficam certas; para corrigir as antigas (**confira antes**, o seed rodado no seu Mac já estava certo):

```sql
-- Exemplo: corrige visitas criadas pelo app em produção antes do deploy da v2.
-- UPDATE "Visita" SET "dataHora" = "dataHora" + interval '3 hours'
-- WHERE "createdAt" < '2026-09-23' AND <condição que exclua as do seed>;
```

---

## 7. Deploy

1. **API primeiro:** `npm run db:push` apontando para o banco de produção (ou o SQL), depois deploy na Vercel. Variáveis opcionais: `DIAS_LIMITE_REGISTRO` (padrão 5), `FUSO_HORARIO` (padrão `-03:00`).
2. **Front depois:** `npm install` e deploy normal.

A API nova é compatível com o front antigo; o front novo precisa da API nova.

## 8. Roteiro de teste rápido

1. `npm run db:seed` → entrar como `bruna@connectland.com` / `123456`.
2. Início: relatórios pendentes com os dias que faltam e 1 visita fora do prazo.
3. Agenda → Semana: arrastar um médico da esquerda para um horário; arrastar um bloco para outro horário; clicar em "Desfazer".
4. Ir para a semana passada e arrastar para um dia hachurado → alerta dos 5 dias.
5. Semana que vem: segunda tem "Treinamentos e convenções" → tentar marcar ali → bloqueado.
6. Abrir uma visita pendente → preencher canal, amostra → Salvar → Apresentar → concluir → volta ao relatório com o material listado → Enviar.
7. Gestor (`gestor@connectland.com`) → Apresentações → Novo material → enviar um PDF.

## 9. Próximos passos sugeridos
- Testar o arrastar com o dedo num iPad de verdade (testado com mouse e toque simulado).
- Guardar imagens de slides em storage (Supabase Storage) se a biblioteca crescer.
- Painel do gestor: ausências da equipe e ranking de materiais apresentados.
- Modo offline (o app de referência funciona sem internet e sincroniza depois).
- Assinatura do médico no recebimento de amostras.
