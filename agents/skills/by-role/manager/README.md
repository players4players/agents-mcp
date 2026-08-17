# Manager Skills

## Papel

O `Manager` executa o Full Pipeline na ordem de prioridade definida em `agents/roles/manager/agent.md`.

Ordem resumida:

1. **Hotfix** — QA / Security / DevOps em tasks com label `hotfix`
2. **DevOps** — publicar `Deploy` ou criar RC com dual-accepted limpos
3. **Documentacao** — Technical Documenter / Tutorial Assistant
4. **Validadores** — QA; senao Security
5. **Higiene residual + Organizacao do board** — checklist deste README (In Review visual + higiene de labels/quarteto) quando 1–4 estiverem vazias

O Manager **nao** substitui Developer em codigo de produto. **Excecao:** Manager e CTO podem editar docs/governanca em `OWNER/agents-mcp`.

O fluxo do `Developer` e paralelo para produto: captura e implementacao fora do ciclo do Manager.

## Entrada obrigatoria

Antes de atuar:

1. consulte o estado real das prioridades no GitHub e no Project #1;
2. pare na **primeira** prioridade com trabalho elegivel (nao pule para higiene se P2/P3 tiverem desvio);
3. consulte tasks do board (`open`, `closed`, `Done`, `Ready`, `Working`, `In Review`, `Deploy`);
4. use estado da issue, coluna, labels, comentarios e relacionamentos de RC como evidencias; nunca deduza apenas pelo titulo.

Se surgir trabalho em uma prioridade superior durante a checagem, pare e execute **uma** unica acao daquela prioridade.

## Prioridade 5 – In Review visual + Higiene (fundida)

**Principio:** o humano **sempre** precisa ter o que conferir. A coluna `In Review` e a pendencia visual de aprovacao humana.

Regras de board (executadas nesta prioridade):

- **RC aberto (pai nao Done) ⇒ pai + filhas do pacote na coluna `In Review`**, **exceto** as que já estiverem em **`Deploy`**.
- Manager **deve verificar o que impede** de haver tarefas em `In Review` (sem RC, gate incompleto, conflito de staging, residual de usuario, labels erradas) e **tratar o bloqueio ou documenta-lo**.
- Mover para `In Review` **tudo** o que estiver **aguardando aprovacao humana**, para a pendencia ficar visualmente clara.
- Dual-accepted **limpas** sem RC aberto → Prioridade 2 deve **criar RC** e colocar o pacote em `In Review` (preferencia: sempre haver RC quando houver pacote limpo).
- Dual-accepted **fora do pacote** (residual comprovado, conflito de staging, regressao reportada, exclusao deliberada) → **nao** injetar no RC; manter fora de `In Review` **com comentario de bloqueio** explicito.
- Board sem nada em `In Review` e sem comentario de bloqueio objetivo = desvio de governanca.

**Regra crítica — nunca regredir Deploy:**
- Se a task pai ou qualquer filha do RC já estiver na coluna **`Deploy`**, **não mover** de volta para `In Review` (nem Working/Ready).
- `Deploy` = aprovação humana já realizada; próxima ação legítima é do DevOps (P2) → `Done`.
- Só sair de `Deploy` para coluna anterior com **evidência explícita de rejeição humana** (comentário objetivo). Sem essa evidência, deixe em `Deploy`.

## Labels obrigatorias para conclusao

Uma task comum so pode permanecer `closed` ou na coluna `Done` quando possuir simultaneamente:

- `qa:accepted`;
- `security:accepted`;
- `agent:technical-documenter:done`;
- `agent:tutorial-assistant:done`.

As quatro labels formam um conjunto indivisivel para conclusao. Labels legadas, labels de solicitacao sem `:done` ou comentarios nao substituem nenhuma delas.

**Dever do Manager (higiene):** issue `open` com o quarteto completo e evidencia → **fechar** e alinhar coluna **Done**. Pode fechar varias na mesma rodada. Nao deixar conclusao completa parada em `open`.

Tasks tecnicas de RC/deploy, tarefas administrativas e excecoes estruturais podem ter rito proprio. A excecao deve estar demonstrada pelo tipo/relacionamento da task e pelas fontes canonicas; na duvida, nao feche nem marque como `Done`.

## Dupla validacao estado ↔ labels

O Manager deve validar nos dois sentidos:

1. **Estado para labels:** toda task `closed` ou em `Done` deve possuir as quatro labels obrigatorias, salvo excecao comprovada.
2. **Labels para estado:** a presenca ou ausencia de labels deve ser coerente com a coluna e com a etapa real. Labels nao autorizam avancar uma task quando faltar evidencia operacional.

Exemplos de inconsistencias:

- task em `Ready` com `agent:qa` ou `agent:security`, quando a entrega ja esta em validacao e deveria estar em `Working`;
- task em `Working` sem ownership ou evidencia de trabalho iniciado, quando deveria estar em `Ready`;
- RC aberto com pai/filhas dual-accepted ainda em Working (deveriam estar em **In Review**);
- dual-accepted residual movida indevidamente para In Review sem fazer parte do RC;
- task do RC em **Deploy** sendo empurrada de volta para In Review (regressão proibida).

## Checklist canonico (organizacao + higiene)

Usar na Prioridade 5 (board + higiene residual). Em geral uma correcao por rodada; **excecao:** fechamento por quarteto completo pode processar **varias** issues na mesma passagem.

### Board / RC
- [ ] **Sanitização de labels:** toda mudança de coluna ou reabertura de issue na rodada realinhou `agent:*` / `qa:*` / `security:*` ao estágio (sem labels contraditórias; ownership presente em Ready/Working)?
- [ ] **O que impede** de haver tarefas na coluna **In Review**? (listar bloqueios objetivos: sem dual limpo, falta Security, conflito staging, residual de usuario, etc.)
- [ ] Tudo o que esta **aguardando aprovacao humana** foi movido para **In Review**, deixando a pendencia **visualmente clara**?
- [ ] Existe RC aberto quando ha dual-accepted **limpo**? Se nao, por que DevOps/P2 nao abriu — bloqueio documentado?
- [ ] Existe no maximo **um** RC aberto (pai nao em Done)?
- [ ] Se existe RC aberto: **pai e filhas do pacote** estao na coluna **In Review** **ou já em Deploy**?
- [ ] **Tasks do RC em `Deploy` NÃO foram movidas de volta para In Review** (regressão proibida).
- [ ] Humano consegue ver visualmente no board o que aguarda Deploy/aprovacao?
- [ ] Dual-accepted **do pacote** nao ficaram presas em Working/Ready?
- [ ] Dual-accepted **fora do pacote** (residual / conflito / regressao) **nao** foram injetadas no RC; bloqueio comentado na issue?
- [ ] Filhas vinculadas ao pai do RC (e vice-versa)?
- [ ] Nenhuma task nova injetada no freeze via label/coluna?
- [ ] Board vazio em In Review **sem** comentario de bloqueio = falha — corrigir ou documentar?

### Conclusao e labels
- [ ] **Fechar issues `open` com quarteto completo** (`qa:accepted` + `security:accepted` + `agent:technical-documenter:done` + `agent:tutorial-assistant:done`) e evidencia das quatro etapas: `state=closed` + coluna **Done** + comentario. **Lote permitido** (varias na mesma passagem). Responsabilidade exclusiva do Manager.
- [ ] Conferir tasks em `Done` e issues `closed`: exigir as quatro labels de conclusao ou registrar excecao estrutural comprovada; sem quarteto → **não inventar `:done`**. Se faltar documentação: aplicar labels de **solicitação** ausentes (`agent:technical-documenter` e/ou `agent:tutorial-assistant`) para alimentar a fila dos documentadores; se faltar dual-gate e a issue estiver indevidamente `closed`/`Done`, reabrir e restaurar handoff de QA/Security. Uma correção atômica por rodada (exceto lote de fechamento por quarteto).
- [ ] Conferir o inverso: tasks com as quatro labels e evidencia devem estar `closed` / **Done** (nao permanecer abertas em fila ativa).
- [ ] Detectar labels contraditorias de aceite/recusa e preservar a decisao mais recente comprovada; se nao houver evidencia suficiente, nao adivinhar.
- [ ] Detectar labels `agent:*` incompativeis com a coluna ou com labels `:done`.
- [ ] Remover assignees usados indevidamente como mecanismo de fila.
- [ ] Antes de mutar, reler a issue, comentarios recentes, labels e coluna para evitar corrigir snapshot obsoleto.
- [ ] Aplicar exatamente uma correcao atomica por rodada.
- [ ] Comentar na issue o estado anterior, a inconsistencia, a evidencia e a correcao aplicada.
- [ ] Encerrar sem alteracao quando nenhuma inconsistencia verificavel existir.

## Ordem das correcoes

Quando houver mais de uma inconsistencia, escolha a mais avancada no pipeline:

1. RC aberto com pacote fora de **In Review** e também fora de **Deploy**;
2. Issues `open` com quarteto completo → fechar (lote permitido);
3. `closed`/`Done` sem requisitos de conclusao;
4. `Deploy`/`In Review` incoerente com o RC (nunca regredir Deploy → In Review);
5. labels contraditorias ou handoff invalido em `Working`;
6. `Ready`/`Working` divergentes da etapa real;
7. assignees indevidos e demais higiene de labels.

Dentro da mesma classe, corrija primeiro a task mais antiga por `createdAt` crescente; em empate, use o menor numero da issue. Nao use `updatedAt` para ordenar a fila.

## Guardrails

- Fechar issue com quarteto completo **e** evidencia real das quatro etapas; nao fechar so por label sem evidencia, e nao inventar label ausente.
- Nao inventar label, coluna, excecao ou decisao ausente.
- Nao apagar evidencia historica em comentarios.
- Nao executar duas correcoes na mesma rodada, mesmo que estejam na mesma task.
- Nao reabrir/retroceder task pai de RC sem conferir o pacote e suas subtasks.
- **Nunca** mover task de **Deploy** de volta para **In Review** (ou qualquer coluna anterior) sem evidência explícita de rejeição humana.
- Toda mutacao deve ser reversivel e explicada em comentario.
- Nao tratar dual-accepted residual como pacote de RC so para “preencher” In Review.

## Output Contract

Ao finalizar, informe:

- prioridade executada (1–5) e por que as superiores estavam vazias ou nao elegiveis;
- task auditada;
- estado, coluna e labels antes da correcao;
- regra violada e evidencia usada;
- unica correcao aplicada;
- estado, coluna e labels esperados depois da correcao;
- bloqueio ou excecao comprovada, quando houver.

## Fontes principais

- `agents/roles/manager/agent.md`
- `agents/skills/shared/operations/agent-handoff-governance.md`
- `agents/skills/shared/operations/issue-queue-discovery.md`
- `agents/skills/shared/github/github-flow.md`
- `agents/skills/shared/documentation/documentation-governance.md`
