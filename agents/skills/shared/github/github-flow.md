# GitHub Flow

## Overview

Fonte canonica do fluxo de branches e entrega tecnica do ecossistema deste repositorio.

## Branches

| Branch | Papel |
| --- | --- |
| `master` | Linha principal / producao |
| `dev` | Integracao continua das tasks do Developer (apos implementacao) |
| `staging` | **Somente** o pacote RC do DevOps (versionamento semântico); dispara deploy para conferencia humana |
| `task-{id_issue}` | Branch de trabalho do Developer |

## Fluxo ponta a ponta

```text
master
  └─ task-{id}                         (Developer cria a partir de master)
       └─ merge em dev                 (Developer; SEM PR)
            └─ dev                     (integracao continua das tasks)
                 └─ QA + Security      (labels na task; sem PR)
                      └─ DevOps empacota RC (semver)
                           └─ staging  (pai + submodulos; dispara deploy staging)
                                └─ task pai Deploy + subtasks  → coluna In Review
                                     └─ humano aprova → coluna Deploy
                                          └─ DevOps merge staging → master → coluna Done
```

## Etapas ja concluidas (pular com justificativa)

Se o estado real do GitHub mostrar que o passo da etapa **ja foi feito** (por qualquer motivo — merge manual, reexecucao, trabalho previo, hotfix operacional), o agent **nao precisa refazer** o passo. Deve:

1. **Confirmar** a evidencia no Git (commits, merge-base, branch atualizada, labels, coluna).
2. **Pular** apenas o que ja estiver concluido.
3. **Avancar** a task para o **proximo estagio** do fluxo (labels `agent:*`, handoff, coluna quando couber ao papel).
4. **Comentar na issue** com justificativa objetiva: o que ja estava feito, como foi verificado, e qual estagio passa a valer.

Exemplos:

- `task-{id}` ja mergeada em `dev` → Developer nao re-mergeia; aplica `agent:qa` + `agent:security` e comenta a justificativa.
- Conteudo do RC ja esta em `staging` nos repos do pacote → DevOps nao reconstrói o mesmo delta; segue task pai / coluna `In Review` (ou o proximo passo faltante) com comentario.
- `staging` ja esta em `master` para o RC da task pai em `Deploy` → DevOps nao re-mergeia; move para `Done` com comentario da evidencia.

**Nao** pule etapas por intuicao ou titulo da issue. So com evidencia verificavel. **Nao** use o atalho para omitir QA/Security quando a entrega ainda nao foi revisada por labels.

## Developer

1. Captura issue elegivel.
2. Cria ou reutiliza `task-{id_issue}` **a partir de `master`** atualizado.
3. Implementa e valida na branch da tarefa.
4. Sincroniza com `origin/master` antes de continuar/encerrar.
5. **Faz merge de `task-{id_issue}` em `dev`** (sem abrir PR) — ou **pula** se ja estiver mergeada (com comentario de justificativa).
6. Registra evidencia na issue e handoff por labels (`agent:qa` e `agent:security`).

### Proibicoes do Developer

- **Nao** abre PR no fluxo normal.
- **Nao** mergeia em `staging` nem em `master`.
- **Nao** commit/push direto em `master`, `main`, `dev`, `staging`.
- Trabalho so na `task-{id_issue}`; chegada em `dev` e por **merge** da task branch.

### Entrega = merge em `dev`

- **Nunca** faça merge de `dev` inteiro em `staging`. Merge sempre **apenas** `task-{id}`.
- O único merge de ambiente completo é `staging` (RC) → `master`.


- Origem: apenas `task-{id_issue}`.
- Destino: `dev`.
- Operacao: merge (nao PR, nao commits soltos em `dev`).
- Rastreabilidade: issue ↔ branch ↔ commits ↔ `dev`.

## Revisao (QA e Security)

- Atuam sobre a task/issue e a evidencia da entrega (commits na task branch e o que foi mergeado em **`dev`**).
- Registram `qa:accepted` / `qa:rejected` e `security:accepted` / `security:rejected`.
- **Nao** abrem PR; **nao** finalizam task; **nao** mexem em branches de integracao.
- Recusa devolve prioridade ao Developer na mesma `task-{id_issue}` (corrigir e re-mergear em `dev`).

## DevOps — Release Candidate (RC)

### Entrada

- Todas as issues **open** (ou elegiveis) que tenham **ao mesmo tempo** `qa:accepted` **e** `security:accepted`.
- Essas tasks ainda **nao** estao vinculadas a um RC aberto.

### Regras de exclusividade do RC

- **Nao** se cria um novo RC enquanto existir um RC aberto (task pai de deploy ainda nao publicada / nao em `Done`).
- **Freeze:** depois de aberto o RC, **nenhuma** task nova entra nesse pacote — **exceto** issues com label `hotfix`.
- **Exceção de freeze (hotfix):** um item com label `hotfix` **pode e deve** ser injetado no RC atual (ou ir a `staging` em trilha própria) mesmo com freeze ativo, **sem** exigir dual-gate prévio. Hotfix tem prioridade absoluta e quebra **apenas** a regra de “não entrar no RC atual” / espera de QA+Security para staging.
- Tasks comuns (sem `hotfix`) aprovadas depois do freeze aguardam o **próximo** RC.
- **Inalterado:** mesmo com a injeção de hotfix, o pacote (ou o caminho de promoção do hotfix) **sempre** passa por coluna **In Review** e ação humana em **Deploy** antes de ir a `master`. Nunca direto a `master`.

### Montagem do pacote

1. Coletar **todas** as tasks elegiveis no momento da abertura do RC.
2. Definir a **versão alvo** com **Semantic Versioning** (https://semver.org). **Controle operacional** (título da task pai, board, comentários) pode usar a forma legível **`RC X.Y.Z-rc.N`** (ex.: `RC 1.5.0-rc.1`). **Arquivos de versão** (`package.json`, `app.json`) **não podem** conter texto — somente números.
   - **Forma gravada em `package.json` / `app.json`:** somente números. Mapeamento do RC operacional:
     - `RC X.Y.Z-rc.1` → versão numérica **`X.Y.1`** (ex.: `1.5.0-rc.1` → `1.5.1`)
     - `RC X.Y.Z-rc.2` → versão numérica **`X.Y.2`** (ex.: `1.5.0-rc.2` → `1.5.2`)
     - e assim por diante (incrementa o PATCH numérico a cada reempacote do mesmo RC).
   - **Proibido** gravar sufixo textual (`-rc.N`, `-beta`, etc.) no campo `version` de `package.json` ou `app.json`.
   - **Proibido** usar contador sequencial de RC como versão de arquivo (ex.: `RC6`, `RC v1.4.20` como se “RC6” fosse a versão).
   - Escolha de `MAJOR.MINOR` (e base do PATCH) a partir da **última versão estável em `master`**, conforme [SemVer 2.0.0](https://semver.org):
     - **MAJOR** (`X+1.y.n`): mudança **incompatível** / breaking na API ou no comportamento público.
     - **MINOR** (`x.Y+1.n`): **nova funcionalidade** compatível com o que já existe (feature).
     - **PATCH** (só sobe o `n` na mesma linha): **somente correção de bug** compatível, sem feature nova; ou reempacote do mesmo RC.
     - Pacote misto (bugs + features compatíveis) → sobe **MINOR**. Breaking no pacote → sobe **MAJOR**.
   - Após uma versão numérica publicada em produção, o **próximo** RC inicia nova sequência numérica na linha SemVer escolhida (ex.: após `1.5.1` em master, próximo ciclo feature → `1.6.1` no package; reempacote do mesmo ciclo → `1.6.2`).
   - **`app.json` (Expo / mobile) — obrigatório espelhar o `package.json`:**
     - `"version"` do `app.json` **igual** à `"version"` do `package.json` (somente números).
     - `"versionCode"` = `MAJOR * 10000 + MINOR * 100 + PATCH` (formato compacto tipo `x.x0.xx`).
       - Ex.: versão `1.4.18` → `versionCode: 14018`; versão `1.5.1` → `versionCode: 15001`.
3. Consolidar as mudancas aprovadas no branch **`staging`** fazendo merge **somente de cada `task-{id}`** aprovada (nunca merge de `dev` inteiro). Pule consolidacao ja presente com evidencia + comentario.
4. Fazer isso nos **repositorios pai e nos submodulos** afetados (ordem: submodulos primeiro, depois pai; pins/gitlinks coerentes). Gravar a versão **numérica** (`X.Y.N`) no `package.json` e, quando existir, no `app.json` (`version` + `versionCode`) do pacote em `staging`.
5. O push/atualizacao de `staging` **dispara o deploy** do ambiente de staging para **conferencia humana**.

### Task pai de deploy + subtasks

1. Criar **uma nova task pai** de deploy/RC (titulo operacional com a forma legível, ex.: `RC 1.5.0-rc.1` — **não** `RC6 v1.4.20`). A versão nos arquivos continua numérica (`1.5.1`).
2. Associar ao [Project #1](<PROJECT_URL>).
3. Colocar as tasks do pacote como **filhos/subtasks** da task pai (e/ou links bidirecionais claros issue pai ↔ filhas).
4. Mover a **task pai e as filhas** para a coluna **`In Review`**.

   Se o pacote ficar fora de `In Review` (pai/filhas ainda em Working/Ready), a **Prioridade 2 do Manager** (organizacao do board) corrige na proxima rodada — o humano precisa ver o pacote visualmente antes do Deploy. Dual-accepted **fora** do pacote (residual/conflito/regressao) **nao** vao para `In Review`.
5. Label operacional tipica na pai: `agent:devops` (ou manter ownership de deploy no board).

### Aprovacao humana e publicacao

1. Humano confere o ambiente de staging.
2. Quando aprovar o pacote, move a task pai para a coluna **`Deploy`**.
3. Em `Deploy`, o DevOps:
   - **mescla o pacote (`staging`) em `master`** (pai + submodulos na ordem correta) — ou confirma que ja esta em `master` e avanca;
   - **mantém a versão numérica** já gravada no `package.json` / `app.json` (ex.: `1.5.1`); não há strip de sufixo textual porque o arquivo **nunca** contém `-rc.N`; confirma tags/versão quando aplicavel;
   - confirma push remoto e tags/versao quando aplicavel;
   - **obrigatório:** move a **task pai e todas as filhas/subtasks** do inventário do RC para a coluna **`Done`** na mesma passagem (Project #1);
   - não deixar nenhuma filha do inventário em `Deploy` / `In Review` / `Working` após o pai estar em `Done`;
   - **handoff de documentação:** em cada filha de produto sem `agent:technical-documenter:done` / `agent:tutorial-assistant:done`, aplicar labels de solicitação ausentes (`agent:technical-documenter` / `agent:tutorial-assistant`); nunca inventar `:done` (ver `master-publication.md`);
   - se pulou merge por ja estar feito, **comente a justificativa** na task pai.

**Proteção de coluna Deploy (Manager e higiene):**
- A coluna **`Deploy`** é o sinal de aprovação humana já realizada.
- **Nenhum** agent (Manager P2/P6, higiene residual ou outro) pode mover task de **`Deploy`** de volta para **`In Review`**, Working ou Ready.
- Única exceção: evidência explícita de rejeição humana (comentário objetivo + decisão documentada).
- Enquanto a task pai estiver em `Deploy`, a próxima ação legítima é do **DevOps** (promover e ir para `Done`).

Detalhes de publicacao: `agents/skills/shared/github/master-publication.md`.

### O que o DevOps nao faz

- Nao implementa feature de produto no lugar do Developer.
- Nao abre RC novo com RC ainda aberto.
- Nao inclui task **comum** sem o par `qa:accepted` + `security:accepted` (exceção: `hotfix`, cujo dual-gate pode ser posterior).
- Nao injeta tasks comuns novas no RC ja freezeado (exceção: `hotfix`; dual-gate pode ser posterior).

## Quem pode o que

| Acao | Developer | QA | Security | DevOps |
|------|-----------|----|----------|--------|
| Branch `task-{id}` a partir de `master` | sim | nao | nao | so excecao |
| Merge `task-{id}` → `dev` | sim | nao | nao | so se conflito/desvio |
| Merge em `staging` (pacote RC) | **nao** | **nao** | **nao** | **sim** |
| Abrir PR de produto / task | **nao** | **nao** | **nao** | **nao** (salvo excecao documentada) |
| Labels `qa:*` / `security:*` | nao | sim | sim | nao |
| Criar task pai RC + subtasks | nao | nao | nao | **sim** |
| Merge `staging` → `master` | **nao** | **nao** | **nao** | **sim** (apos coluna Deploy) |
| Deploy / publicacao | nao | nao | nao | sim |
| Pular passo ja evidenciado + comentar | sim | sim* | sim* | sim |

\*QA/Security podem reconhecer merge ja feito em `dev` como evidencia, mas **nao** pulam a propria decisao de aceite/recusa sem analisar.

## Relacao com outras skills

- publicacao em master: `agents/skills/shared/github/master-publication.md`
- ownership e handoff: `agents/skills/shared/operations/agent-handoff-governance.md`
- criterios de conclusao: `agents/skills/shared/quality/task-completion-criteria.md`
- board / Project #1: `agents/skills/shared/operations/issue-queue-discovery.md`


## Hotfix (prioridade absoluta)

Hotfixes são correções urgentes em produção (ou risco crítico iminente) que **não esperam** o ciclo normal de RC.

### Identificação

- Label obrigatória: `hotfix` (criar no repositório se ausente).
- **Sempre** aplicar a label `hotfix` ao criar uma task pedida como hotfix.
- Pode coexistir com `bug` / `enhancement`.
- Developer, QA, Security e DevOps devem tratar issues com `hotfix` como **prioridade 1**. O Manager trata como prioridade 1 somente as ações elegíveis de QA, Security ou DevOps; implementação continua exclusiva do Developer.

### Fluxo acelerado

```text
master
  └─ task-{id}                         (Developer cria a partir de master)
       └─ merge task-{id} → dev        (Developer; SEM PR) — prioridade máxima
            └─ na mesma passada / em seguida:
                 └─ DevOps (ou Developer no handoff de hotfix) merge **somente** task-{id} → staging
                      (NUNCA merge de `dev` inteiro em staging)
                      └─ task hotfix → coluna **In Review** (staging já atualizado)
                           └─ QA + Security podem atuar **depois** (labels; não bloqueiam staging)
                           └─ humano move a task hotfix para **Deploy**
                                └─ DevOps promove **somente o delta do hotfix** → master → Done
                                   (NÃO é obrigatório levar o RC inteiro junto)
```

**Aceleração de hotfix (gate diferido):** no hotfix, o Developer entrega em `dev` e o delta **já pode ir para `staging` na mesma passada**, **sem** esperar `qa:accepted` + `security:accepted`. QA e Security **atuam depois** (revisam o que já está em staging / In Review) e aplicam labels quando concluírem. O dual-gate **não** bloqueia a entrada em `staging` no caminho de hotfix.

**Obrigatório (inalterado):** o delta **não** vai direto para `master`. Após estar em `staging`, a task hotfix **deve** passar pela coluna **In Review** para conferência humana. Só após o **humano** mover a task hotfix para **Deploy** o DevOps promove a `master`.

**Publicação independente:** quando o humano coloca a **task hotfix** em **Deploy**, o DevOps promove **somente o delta da `task-{id}` do hotfix** para `master`. **Não** é necessário publicar o RC completo junto. O RC aberto continua no fluxo normal com o restante do pacote.

### Regra crítica de merge (hotfix e fluxo normal)

- **Sempre** faça merge **apenas da branch `task-{id}`** para o destino (`dev` ou, no caminho de promoção prioritária, `staging`).
- **Nunca** faça merge de um ambiente inteiro (`dev` → `staging`).
- O **único** merge de ambiente completo permitido é o **RC em `staging` → `master`** (após coluna Deploy).
- `dev` pode conter tarefas ainda quebradas / incompletas e **não pode** ir para `staging`.
- `staging` deve permanecer **estável** (deltas de tasks dual-accepted no pacote RC **ou** hotfix prioritário — no hotfix o dual-gate pode ser posterior).

### Regras

1. **Developer**: captura e implementa hotfix antes de qualquer outra issue; branch `task-{id}` a partir de `master`; merge **somente** `task-{id}` → `dev`; aplica labels de handoff `agent:qa` + `agent:security` (QA/Security **podem** concluir depois). Em hotfix, o delta já está elegível para `staging` na mesma passada.
2. **QA / Security**: no hotfix, **não bloqueiam** a entrada em `staging`. Revisam com prioridade (código já pode estar em staging / In Review) e registram `qa:accepted`/`security:accepted` (ou rejected) **depois**. Recusa após staging exige correção na mesma `task-{id}` e novo merge (dev + staging).
3. **DevOps** (ou promoção prioritária de hotfix):
   - Com label `hotfix` e entrega do Developer em `dev`, promove com prioridade **sem esperar dual-gate**:
     - merge **somente** `task-{id}` → `staging` (nunca `dev` inteiro);
     - ou inclui o delta no RC aberto / monta RC de item único;
     - move a **task hotfix** para a coluna **In Review** (nunca pula In Review);
   - **Proibido** promover hotfix direto de `staging`/`dev` para `master` sem a coluna **Deploy** (aprovação humana).
   - Após o **humano** mover a task hotfix para **Deploy**: promove **somente o delta da `task-{id}` do hotfix** para `master` e move essa task para `Done`.
   - **Não** é obrigatório levar o RC completo junto na publicação do hotfix. O RC aberto permanece no seu fluxo normal com as demais tasks.
4. **Manager**: prioridade 1 = executar somente uma ação elegível de **QA, Security ou DevOps** para issue com label `hotfix`. O Manager **nunca** captura ou implementa a task, **nunca** cria `task-{id}` e **nunca** faz merge em `dev`; essas ações permanecem exclusivas do fluxo paralelo do Developer.
5. **Não se abre segundo RC paralelo** só por causa de hotfix. Se já existir RC aberto (mesmo freezeado), o DevOps **pode** incluir o delta da `task-{id}` no pacote atual (única quebra de freeze) **ou** promover o hotfix em trilha própria (task-{id} → staging → In Review → Deploy → master). Em ambos os casos:
   - a task hotfix **sempre** passa por **In Review**;
   - só após o **humano** mover a task hotfix para **Deploy** o DevOps publica em master;
   - a publicação do hotfix promove **somente o delta do hotfix** — **não** exige levar o RC inteiro para master;
   - QA/Security podem concluir **depois** da entrada em staging.
   - Nunca pular In Review nem ir direto a master.
6. Após publicação, o hotfix deve permanecer refletido em `dev` e `master` para não regredir.

### Quality bar de hotfix

- Mudança mínima e focada no problema crítico.
- Testes/smoke do escopo afetado (mesmo sob urgência).
- Evidência clara na issue (commits da `task-{id}`, merge em `dev`, labels).
- Não usar `hotfix` para feature ou melhoria não urgente.

## Quality Bar

- nao derive task branch de `dev`/`staging` (sempre de `master`)
- nao entregue Developer em `staging` (destino e `dev`)
- nao promova para `master` sem task (pai do RC **ou** task de hotfix) em coluna `Deploy` e passagem prévia por **In Review** (hotfix também não pula In Review)
- nao promova hotfix direto para `master` sem conferência humana em staging
- ao publicar hotfix em Deploy: promova **somente o delta do hotfix**; não é obrigatório publicar o RC completo junto
- nao abra segundo RC em paralelo
- nao refaca merge/passo ja concluido sem necessidade; documente o pulo com comentario
- nao pule etapa sem evidencia verificavel no GitHub
- nao feche issue; `closed`/Done operacional segue o board e humanos conforme governanca
- **nao** mova task de **Deploy** de volta para **In Review** (Manager / higiene); Deploy é terminal até DevOps promover para Done
