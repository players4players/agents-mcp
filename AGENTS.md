# GitHub Project MCP Agents

Este repositorio e a fonte oficial para automacoes, agents, runners, workflows e instrucoes operacionais do ecossistema deste repositorio.

## Fonte canonica

Tudo o que nao for memoria persistente deve estar disponivel aqui.

Entradas principais:

- `agents/skills/README.md`
- `agents/skills/shared/README.md`
- `agents/skills/shared/github/github-flow.md`
- `agents/skills/by-role/*/README.md`
- `agents/skills/runners/README.md`
- `agents/roles/*/agent.md`
- `.github/agents/*.agent.md`
- `workers/automation/`
- `workers/automate/`
- **`config/ecosystem.config.json`** — **obrigatorio**: valores reais do fork (`owner`, project, repositorios, ajuda, runners)
- `config/ecosystem.config.example.json` — modelo/schema de referencia
- `config/README.md` — tabela de placeholders e env



## Configuracao do fork (obrigatoria)

Antes de qualquer acao operacional, leia **`config/ecosystem.config.json`**.

- Use os campos `value` (e `runners.defaults`) para resolver `<OWNER>`, `<env.OWNER>`, `<PROJECT_URL>`, `<PROJECT_NUMBER>`, `<HELP_CENTER_URL>`, `<TEAM_EMAIL>` e repositorios de produto.
- A documentacao generica em `agents/` continua com placeholders; **nao** reinsira marca no texto canonico — altere apenas o JSON de config.
- Tokens (`GITHUB_TOKEN`) nao ficam no arquivo; use secrets do ambiente.

## Copilot Cooperation

Todo agent do ecossistema **deve estender** `agents/skills/shared/operations/copilot-cooperation.md`.

- GitHub Copilot Coding Agent, workers, runners e Actions sao parceiros de execucao
- Wrappers em `.github/agents/*.agent.md` (`target: github-copilot`)
- Regenerar wrappers: `node workers/scripts/sync-copilot-agents.mjs`

## Estrutura do repositorio

```
agents/
├── roles/          # definição canônica de cada papel
└── skills/         # biblioteca de skills
    ├── shared/     # regras transversais (por categoria)
    ├── by-role/    # skills por papel
    └── runners/    # mapas de runtime

workers/            # tudo que executa
├── automate/
├── automation/
├── src/
└── scripts/
```

## Regra central de skills

Toda regra nova deve entrar primeiro na camada certa, em vez de ser repetida entre agents, wrappers e instrucoes locais.

Distribuicao obrigatoria:

- comportamento compartilhado, politicas, guardrails e criterios comuns vivem em `agents/skills/shared/`
- qualidade de codigo, modularizacao, smoke tests e limite de tamanho de componentes vivem em `agents/skills/shared/quality/code-quality.md`
- documentacao de cliente e wiki tecnica vivem em `agents/skills/shared/documentation/documentation-governance.md`
- seguranca editorial e sanitizacao de evidencias vivem em `agents/skills/shared/security/security-guardrails.md`
- fluxo de branches e entrega (GitHub Flow adaptado) vive em `agents/skills/shared/github/github-flow.md`
- papel, ownership, limites e handoff por agent vivem em `agents/skills/by-role/<agent>/README.md`
- mapas de runtime, workflows, entry points e scripts reais vivem em `agents/skills/runners/README.md`
- `agents/roles/*/agent.md` devem ficar enxutos e conter apenas ponto de entrada, papel, fronteiras e referencias obrigatorias
- wrappers locais em `.github/agents/*.agent.md` devem ser finos e apontar para a fonte canonica e para o contexto local minimo

## Canal de execucao

Os runners do GitHub deste repositorio estao desativados como canal operacional principal.

A execucao por papel deve acontecer pelos agentes pares no ChatGPT.

Com isso:

- workflows em `.github/workflows/` ficam apenas como trilha desativada e referencia tecnica
- nenhuma rotina por `push` ou `schedule` deve ser reativada sem decisao estrutural explicita
- ownership, handoff e criterios de execucao continuam definidos pelas skills centrais e pelos agents canonicos

## GitHub

Ao consultar ou operar no GitHub, os agents podem usar qualquer busca, API, listagem, ferramenta, mutacao ou superficie que estiver disponivel na sessao. Nao existe restricao artificial de consulta no GitHub dentro do `agents-mcp`; a escolha do caminho deve seguir apenas o que melhor produz a evidencia correta para a tarefa atual.

## GitHub Flow (resumo)

Fonte completa: `agents/skills/shared/github/github-flow.md`.

- branch de trabalho: `task-{id_issue}` derivada de `master`
- `Developer` entrega em **`dev`** por **merge** da task branch (sem PR)
- `QA` e `Security` decidem por labels na task; evidencia em `dev`; nao abrem PR
- `DevOps` empacota **todas** as tasks com `qa:accepted` + `security:accepted` em um **RC semver**, coloca o pacote em **`staging`** (pai + submodulos), cria **task pai de deploy** com as demais como **subtasks**, move pai e filhas para **`In Review`**
- **um RC por vez**; freeze — nenhuma task nova entra no RC aberto; nao ha novo RC ate publicar o atual
- humano confere staging e move a task pai para **`Deploy`**
- `DevOps` mescla **`staging` → `master`** e move para **`Done`**

## Ownership operacional

Labels oficiais de review na task:

- `qa:accepted`
- `qa:rejected`
- `security:accepted`
- `security:rejected`

Regras obrigatorias:

- nenhuma task deve ser atribuida a pessoas, bots ou fallbacks tecnicos como mecanismo de captura de trabalho
- assignees do GitHub nao participam do roteamento operacional e devem ser removidos quando aparecerem em tasks da fila
- `Developer` seleciona trabalho apenas quando a issue ainda esta aberta, foi criada por membro da equipe e nao existe pendencia ativa de decisao por `QA` e `Security`
- `Developer` so trabalha na `task-{id_issue}` e entrega em **`dev`** por merge, sem abrir PR
- `Developer` nao mexe diretamente em `master`, `main`, `dev`, `staging`
- `Security` e `QA` registram apenas labels de aceite/recusa na task
- quando `Security` ou `QA` recusarem, comentam de forma objetiva para o `Developer`
- somente o `DevOps` monta RC em `staging`, cria a task pai de deploy e promove `staging` → `master` apos coluna `Deploy`
- agents nao fecham tasks por conta propria fora do rito de colunas do board; `closed` formal segue governanca humana quando aplicavel

## Fronteira do CTO

O CTO supervisiona o ecossistema e corrige diretamente o `agents-mcp` quando houver falha estrutural de instrucao, runner, workflow, ownership ou automacao.

O CTO nao deve substituir a execucao normal de `Developer`, `Security`, `Quality Assurance`, `DevOps` ou `Sysadmin` quando a trilha ja pertence claramente a um desses agents.

Quando `qa:accepted` e `security:accepted` coexistirem, a trilha de RC/`staging`/`master` pertence ao `DevOps`, conforme `agents/skills/shared/github/github-flow.md` e `agents/skills/shared/github/master-publication.md`.

## Fluxos operacionais paralelos

Existem dois fluxos independentes que rodam em paralelo:

1. **Full Pipeline / Manager**: governa Hotfix ja implementado, DevOps, Documentacao, Validadores e higiene de board. Este fluxo **nao captura nem implementa trabalho de Developer**.
2. **Developer**: captura autonomamente a propria fila, implementa em `task-{id_issue}` a partir de `master`, faz merge da task em `dev` e entrega para QA/Security.

O Manager pode corrigir labels/status que devolvam uma task ao `Developer`, mas nao deve executar a implementacao, escolher uma task para implementar dentro do seu ciclo, nem bloquear a propria rodada porque existe trabalho novo de Developer.

## Mode de Acao do Agent (Full Pipeline / Manager)

Quando a automação unificada (`Full Pipeline`) for executada, ela deve seguir **estritamente** a ordem de prioridade abaixo.  
O princípio é: **sempre atuar no que está mais avançado no pipeline do Manager**, sem incluir a fila paralela do `Developer`.

### Ordem de prioridade (uma ação por execução)

1. **Hotfix**
   - Qualquer issue com label `hotfix` (validar QA/Security, promover/deploy) tem prioridade absoluta
   - **Implementação (Developer) de hotfix roda à parte** no fluxo paralelo do `Developer` e não faz parte desta automação do Manager
   - Hotfix **pode entrar** em RC já freezeado; ainda assim **sempre** passa por **In Review** + ação humana em **Deploy** (nunca direto a master)
   - Ao criar task hotfix: **sempre** aplicar a label `hotfix`
   - Ver seção Hotfix em `agents/skills/shared/github/github-flow.md`
   - Merge sempre **somente** da `task-{id}` (nunca `dev` inteiro → `staging`)

2. **DevOps**
   - Publicar release aprovada na coluna Deploy (se existir)
   - Criar Release Candidate (se houver tasks com `qa:accepted` + `security:accepted` e não houver RC em andamento)
   - No RC: merge **somente** das `task-{id}` aprovadas em `staging` (nunca `dev` inteiro)

3. **Documentação** (Documentadores)
   - Technical Documenter
   - Tutorial Assistant

4. **Validadores**
   - QA
   - Security

5. **Developer**

### Regras deste mode

- Execute **exatamente uma** ação por rodada.
- Pare na primeira prioridade que tiver trabalho pendente.
- Dentro da mesma prioridade funcional, selecione a task elegivel mais antiga por `createdAt` crescente; em empate, use o menor numero da issue.
- `updatedAt` serve apenas como evidencia de atividade e nunca reposiciona uma task na fila.
- SysAdmin **não** participa deste mode (deve continuar rodando em paralelo em automação separada).
- **Developer** **não** participa deste mode: sua captura, implementação e merge em `dev` rodam no fluxo paralelo próprio.
- Sempre confirme o estado real no GitHub / Project #1 antes de agir.
- Siga integralmente as fontes canônicas de cada papel (`agents/roles/*/agent.md` e skills referenciadas).
