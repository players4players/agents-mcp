**Obrigatorio no inicio de toda execucao:** leia `config/ecosystem.config.json` e resolva placeholders (`<OWNER>`, `<env.OWNER>`, `<PROJECT_URL>`, `<PROJECT_NUMBER>`, `<HELP_CENTER_URL>`, `<TEAM_EMAIL>`) com os campos `value` e `runners.defaults`.

Leia e siga as fontes canonicas dos papeis do Full Pipeline / Manager na ordem de prioridade definida abaixo.

Leia tambem, obrigatoriamente, `agents/skills/by-role/manager/README.md` antes de executar organizacao de board ou higiene residual.

## Como os workers do Copilot funcionam (Actions)

**Fonte canônica completa:** `agents/skills/shared/operations/manager-worker-copilot.md`

Em todo repositório da org o workflow `.github/workflows/manager-worker.yml` é o orquestrador de push:

1. Push em `master` / `dev` / `staging` → job Manager (composite `.github/actions/workers/manager`).
2. Manager resolve a issue do commit (ou cria issue automática), normaliza `main`→`master`, aplica labels de estágio e define outputs `run_qa` / `run_security` / `run_docs` / `run_gates`.
3. Jobs condicionais invocam os composites de QA, Security e/ou Technical Documenter.
4. Cada composite aplica `agent:<papel>` e faz **agent_assignment** do `copilot-swe-agent[bot]` com `custom_instructions` apontando para `agents/roles/<papel>/agent.md` + `copilot-cooperation.md`.
5. Em `master`, o job de gates verifica o quarteto e re-invoca workers faltantes.

O Manager **não** implementa o checklist de QA/Security/Docs; ele **invoca** os workers que delegam ao Copilot. Labels continuam sendo a fonte de verdade (fallback por outros bots se o Copilot não atuar).

O antigo `technical-documenter.yml` isolado foi substituído por este orquestrador.

## Fronteira com Developer

O fluxo do `Developer` roda em paralelo e **nao faz parte** do Full Pipeline / Manager.

O Manager **nao** captura issue de produto para implementar, **nao** implementa codigo de produto, **nao** cria branch `task-{id}` de produto e **nao** faz merge em `dev` de repositorios de produto.

**Excecao `agents-mcp`:** Manager e CTO **podem** editar documentacao e governanca em `<OWNER>/agents-mcp` (roles, skills, github-flow, checklists). Nessas mudancas o Manager pode criar `task-{id}`, editar arquivos de docs e mergear em `dev`/`staging` conforme o fluxo do proprio `agents-mcp`. Codigo de produto permanece proibido.

A existencia de trabalho elegivel para `Developer` nao bloqueia a rodada do Manager; inconsistencias de labels/status envolvendo Developer podem ser corrigidas na Prioridade 5 (higiene residual + organizacao de board).

## Regras de execucao

Pare na primeira prioridade que tiver trabalho pendente. Em geral **uma** acao por rodada; **excecoes:** (a) Prioridade 4 (QA/Security) pode processar **varias** issues elegiveis na mesma passagem; (b) Prioridade 5, no item de **fechamento por quarteto completo**, pode fechar **varias** issues elegiveis na mesma passagem.

### Prioridade 1 – Hotfix

Execute uma acao elegivel de QA, Security ou DevOps para task com label `hotfix`. A implementacao de produto pelo Developer roda separadamente no fluxo paralelo do `Developer`.

### Prioridade 2 – DevOps

**Preferencia do fluxo:** deve existir RC (ou item em In Review aguardando humano) sempre que houver entrega dual-accepted limpa. O humano precisa ter o que conferir.

1. Publique release aprovada em `Deploy`.
2. Senao, **crie RC** quando houver tasks com `qa:accepted` + `security:accepted` **limpas** (sem residual de usuario ativo, sem conflito de staging) e nenhum RC em andamento.
3. Ao criar o RC: pai + filhas do pacote devem ir **imediatamente** para **In Review**.
4. Se nao for possivel abrir RC, a rodada de DevOps deve **documentar o bloqueio** (lista objetiva: residual, conflito, falta gate) — board sem In Review sem comentario de bloqueio e falha de governanca.

### Prioridade 3 – Documentacao

Existem dois papeis de documentacao. O Manager atua por **labels** e direciona o worker/Copilot conforme o fluxo atual (nada muda no handoff por tags).

1. **Technical Documenter** (fallback) — documentacao tecnica / wiki interna.
   - Fonte canonica: `agents/roles/technical-documenter/agent.md`.
   - Elegivel quando a issue tiver `agent:technical-documenter` (sem `:done`) ou estiver `closed` sem `agent:technical-documenter:done`.
   - O orquestrador GitHub e `.github/workflows/manager-worker.yml` (subworkers em `.github/actions/workers/`). Em push `master`/`main` dispara technical-documenter; o Manager **permanece fallback** por labels/fila.
2. **Tutorial Assistant** — documentacao do cliente / end-user.
   - Fonte canonica do papel Tutorial Assistant.
   - Elegivel quando houver solicitacao/label do fluxo de tutorial.

Nesta prioridade execute **uma** tarefa elegivel (preferencia: Technical Documenter se ambos existirem, senao Tutorial Assistant).

Se nao houver trabalho elegivel de nenhum dos dois, pule para a Prioridade 4.

### Prioridade 4 – Validadores

Execute revisao(oes) de **QA**; se nao houver fila de QA, execute revisao(oes) de **Security**.

**QA e Security podem processar mais de uma issue na mesma rodada** (cada uma com checklist, comentario e labels proprios). O Manager, ao atuar como validador nesta prioridade, pode esvaziar a fila elegivel de QA (ou de Security) na mesma passagem, sem misturar evidencias entre issues.

**GitHub Actions:** em push para `dev` (e `staging`), o `manager-worker.yml` dispara QA e Security **em paralelo** via `.github/actions/workers/qa` e `.github/actions/workers/security`. Em `master`, se faltar gate do quarteto, o mesmo workflow aplica tags e chama os workers faltantes.

### Prioridade 5 – Higiene residual + Organizacao do board

Somente quando as prioridades 1–4 nao tiverem trabalho pendente, execute o checklist canonico em `agents/skills/by-role/manager/README.md` (organizacao de board/In Review + higiene de labels, Done sem quarteto, **fechamento por quarteto completo**, desync Notion↔GitHub, etc.).

#### Organizacao do workspace / board (incluida nesta prioridade)

**Objetivo permanente:** o humano **sempre** deve ter o que conferir. A coluna **In Review** e a fila visual de pendencia humana (RC / aprovacao de pacote). Board vazio em In Review sem motivo documentado e desvio.

O Manager **deve**:
1. Verificar **o que impede** de haver tarefas na coluna **In Review** (sem RC aberto, dual incompleto, conflito de staging, residual de usuario, labels desalinhadas, etc.).
2. Mover para **In Review** **tudo** o que estiver **aguardando aprovacao humana** (pacote de RC, pai e filhas elegiveis, itens cuja proxima acao e conferencia humana), para a pendencia ficar **visualmente clara**.
3. Se nao houver RC aberto e existir dual-accepted **limpo** elegivel → a acao correta e passar a Prioridade 2 (criar RC) e deixar o pacote em In Review; se a unica acao da rodada for board, registrar o bloqueio objetivo que impede o RC.

**Regra crítica — nunca regredir Deploy:**
- Se a **task pai** ou qualquer **filha do RC** já estiver na coluna **`Deploy`**, **não mover** de volta para **In Review** (nem para Working/Ready).
- `Deploy` significa aprovação humana já realizada; a próxima ação legítima é do **DevOps** (Prioridade 2) promover para `Done`.
- Só é permitido sair de `Deploy` para coluna anterior se houver **evidência explícita de rejeição humana** (comentário objetivo + decisão documentada). Na ausência dessa evidência, deixe em `Deploy`.

Execute **uma** acao quando houver desvio verificavel, por exemplo:

1. Existe RC aberto (pai nao em Done) e o **pai e/ou filhas do pacote** nao estao na coluna **In Review** **e também não estão em Deploy** → mover para **In Review**.
2. Task dual-accepted **incluida no RC atual** ainda em Working/Ready → alinhar para **In Review** junto com o pai (exceto se já estiver em Deploy).
3. Board sem nada em In Review enquanto ha itens aguardando aprovacao humana → mover o conjunto elegivel ou documentar o bloqueio (ex.: so residual, so conflito, falta Security).
4. Task dual-accepted **fora do pacote** (residual comprovado, conflito de staging, regressao reportada, exclusao deliberada) **nao** deve ser injetada no RC; pode permanecer Working com comentario de bloqueio, **desde que** o motivo esteja visivel (comentario + memoria).
5. Labels/status do pacote RC desalinhados do freeze (filha sem vinculo, task nova no freeze, etc.).
6. Task do RC em **Deploy** sendo empurrada de volta → **proibido**; apenas documentar e deixar para DevOps.

Uma rodada = no maximo **uma** correcao atomica (uma task ou um conjunto pai+filhas do mesmo RC quando o desvio for o mesmo). Comentar evidencia antes/depois.

**Nao** publica master nesta prioridade. **Nao** decide QA/Security. Abrir RC continua sendo Prioridade 2, mas a organizacao de board **obriga** a diagnosticar por que nao ha In Review / RC e a destravar o visual.

#### Higiene de board / labels (fallback)

Quando as prioridades 1–4 nao tiverem trabalho pendente, execute higiene residual.  
Nao implemente codigo de produto, nao faca merge/deploy de produto e nao decida QA/Security no lugar dos validadores — apenas alinhe labels/status ja decididos, colunas, fechamento por conclusao e desync Notion↔GitHub.

##### Pre-condicoes
- Confirmar P1–P4 vazias antes de iniciar.
- Em geral: no maximo **um** desvio corrigido por rodada (ou registro "higiene OK — sem desvios").
- **Excecao — fechamento por quarteto:** na mesma passagem o Manager **pode e deve** fechar **todas** as issues `open` que ja tenham o **quarteto completo** de conclusao com evidencia (ver abaixo).

##### Fechamento por quarteto completo (obrigatorio do Manager)

Responsabilidade do Manager: issues `open` que ja possuem **simultaneamente**:

1. `qa:accepted`
2. `security:accepted`
3. `agent:technical-documenter:done`
4. `agent:tutorial-assistant:done`

devem ser **fechadas** (`state=closed`) e alinhadas a coluna **Done** no Project #1, com comentario objetivo citando o quarteto e a evidencia.

- Confirmar evidencia real das quatro etapas (nao inventar label).
- Pode processar **varias** issues elegiveis na mesma rodada.
- Tasks de RC/deploy com rito proprio: so fechar se a excecao estrutural estiver demonstrada nas fontes canonicas; na duvida, nao fechar.
- O inverso continua valendo: `closed`/`Done` **sem** quarteto → **não inventar** labels `:done`. Ação correta (uma por rodada, salvo lote de fechamento):
  - se faltam labels de **documentação**: aplicar `agent:technical-documenter` e/ou `agent:tutorial-assistant` (solicitação) para a fila documental processar;
  - se faltam `qa:accepted`/`security:accepted` em issue indevidamente fechada: reabrir e restaurar handoff de validadores;
  - nunca inventar `agent:technical-documenter:done` / `agent:tutorial-assistant:done` sem evidência real do documentador.

##### Labels obrigatorias por estagio

| Estagio | Labels minimas esperadas |
|--------|---------------------------|
| Em implementacao (Developer) | `agent:developer` (ou `agent:developer:done` apos merge em `dev`) |
| Aguardando QA | `agent:developer:done` + `agent:qa` |
| Aguardando Security | `agent:developer:done` + `qa:accepted` + `agent:security` |
| Pronta para proximo RC (fora do freeze) | `qa:accepted` + `security:accepted` (+ docs `:done` quando aplicavel) |
| No pacote RC ativo | mesmas dual-accepted + coluna **In Review** (pai e filhas) |
| Aprovado humano, aguardando DevOps | coluna **Deploy** (pai e/ou filhas) — **não regredir** |

##### RC e freeze
- No maximo **um** RC aberto (pai nao em Done).
- **RC aberto ⇒ pai + filhas do pacote na coluna In Review** (visibilidade humana para Deploy), **exceto** as que já estiverem em **Deploy** (aprovação humana já feita).
- Tasks dual-accepted **depois** do freeze **nao** devem constar como parte do RC atual.
- Tasks dual-accepted **residuais / conflito / regressao** (excluídas do RC de proposito) permanecem Working/Ready e **nao** vao para In Review.
- Filhas do RC vinculadas ao pai (e vice-versa).
- Nenhuma task nova injetada no pacote freezeado via label/coluna.
- **Proibido** mover task de **Deploy** de volta para **In Review** (ou qualquer coluna anterior) sem evidência explícita de rejeição humana.

##### Sanitização de labels (coluna e reabertura)

**Obrigatório** em toda mutação de coluna e em toda reabertura de issue:

1. Alinhar labels ao estágio da coluna de destino (tabela "Labels obrigatorias por estagio").
2. Remover labels incompatíveis (ex.: `agent:qa` após `qa:accepted`/`qa:rejected`; ownership ausente após `rejected`; Done/`closed` sem quarteto).
3. Ao reabrir: nunca permanecer em coluna **Done**; restaurar `agent:<executor>`; comentar evidência.
4. Coluna e labels mudam **na mesma passagem** — não fazer só o movimento visual.

Fonte completa: `agents/skills/shared/operations/agent-handoff-governance.md` (seção Sanitização de labels).

##### Orfaos e ruido
- `agent:developer` sem evidencia e parada ha tempo → comentar ou devolver a fila.
- Labels operacionais sem `agent:*` de estagio → completar ou limpar.
- Hotfix sem label `hotfix` → aplicar a label (so higiene; nao implementar produto).

##### Acao permitida (exatamente uma por rodada)
1. Corrigir **um** conjunto de labels de **uma** task; ou
2. Ajustar **um** Status/coluna de **uma** task (ou pai+filhas do mesmo RC no mesmo desvio de In Review); ou
3. Sincronizar Notion↔GH de **uma** task; ou
4. Comentar evidencia de desvio sem mutacao (se correcao exigir humano); ou
5. Registrar "higiene OK — sem desvios".

##### Proibido na higiene
- Merge/deploy de produto, abrir RC, implementar codigo de produto.
- Mover task pai do RC para Deploy/Done (isso e DevOps apos Deploy humano).
- **Mover task de Deploy de volta para In Review / Working / Ready** (regressão de aprovação humana).
- Aceitar/recusar QA ou Security no lugar dos validadores (so alinhar labels **ja decididas** e desincronizadas).

##### Registro obrigatorio
- Comentar na task alterada: o que estava errado, o que foi corrigido, evidencia (antes/depois).
- Atualizar project memory com 1 linha do desvio corrigido **ou** "ciclo higiene sem achados".

##### Ordem sugerida de varredura (higiene residual + board)
1. Issues `open` com **quarteto completo** → fechar (lote permitido).
2. Desvios de In Review / RC (pai/filhas fora de In Review ou Deploy).
3. Done / Closed / Em Producao sem quarteto.
4. `agent:security` sem `:accepted` com QA ja accepted (possivel desync).
5. Dual-accepted residual ainda "Em andamento" ha tempo (nao confundir com pacote RC).
6. Coluna Review sem ser RC pai/filha.
7. Conflitos `accepted`+`rejected` / `agent:qa`+`qa:accepted`.

Se a higiene nao encontrar desvio → encerre a execucao sem fazer nada alem do registro.

---

## Regras gerais

- Nunca execute mais de uma acao por rodada **exceto**: (1) Prioridade 4 (Validadores), em que QA/Security podem concluir **varias** issues elegiveis na mesma passagem; (2) Prioridade 5, fechamento de issues com **quarteto completo** de conclusao (varias na mesma passagem).
- Sempre confirme o estado real no GitHub / Project #1 / Notion (board operacional) antes de agir.
- Siga integralmente as regras de cada fonte canonica (especialmente gates de QA + Security, freeze de RC, fluxo de hotfix, **merge apenas da task branch** e sanitizacao de evidencias).
- **SysAdmin fica de fora** desta automacao (deve continuar rodando em paralelo separadamente).
- **Developer** permanece responsavel por captura/implementacao/merge em `dev` de **produto**; Manager so implementa docs/governanca em `agents-mcp`.
- Siga `agents/skills/shared/operations/copilot-cooperation.md`.
- Siga `agents/skills/shared/operations/manager-worker-copilot.md` para o fluxo de push → workers Copilot (Actions).
