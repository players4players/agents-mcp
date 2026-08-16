# Manager Worker + Copilot Workers (fonte canônica)

Este documento é a **fonte canônica** de como o GitHub Actions orquestra o Copilot Coding Agent nos repositórios da org ControleOnline.

Ele descreve o fluxo que existe em **todos** os repositórios após a padronização:

- `.github/workflows/manager-worker.yml`
- `.github/actions/workers/manager/action.yml`
- `.github/actions/workers/qa/action.yml`
- `.github/actions/workers/security/action.yml`
- `.github/actions/workers/technical-documenter/action.yml`

Não confundir com os runners legados em `workers/src/*` / `workers/automate/` (fila de project, dispatch de PR, etc.). Este documento trata **somente** do canal de push → Manager → assignment do Copilot via composite actions.

---

## Visão geral (1 parágrafo)

Em todo push para `master`, `dev` ou `staging`, o workflow `manager-worker.yml` roda o **Manager Subworker**. O Manager resolve a issue fonte (ou cria uma se o commit não referenciar issue), normaliza branch (`main` → `master`), aplica labels de estágio e decide quais workers invocar. Em seguida jobs condicionais chamam os composite workers de **QA**, **Security** e/ou **Technical Documenter**. Cada um desses workers:

1. garante a label `agent:<papel>` na issue;
2. faz `POST /issues/{n}/assignees` com `assignees: ["copilot-swe-agent[bot]"]` e um bloco `agent_assignment` contendo `custom_instructions` que apontam obrigatoriamente para `agents/roles/<papel>/agent.md` + skills de cooperação;
3. comenta na issue que o Manager disparou o papel.

O Copilot (quando disponível) age a partir desse assignment. Se o Copilot falhar ou não atuar, outros bots (ex.: Grok) e o Manager humano/automático continuam podendo atuar pelas labels — o fluxo de labels é a fonte de verdade.

---

## Trigger e branch padrão

```yaml
on:
  push:
    branches: [master, dev, staging]
```

- **Padrão da org = `master`**. Nunca usar `main` como branch de trabalho.
- O Manager Subworker, se receber `main`, trata internamente como `master` e grava `base_branch=master` no output.
- Todos os repositórios devem ter default branch = `master`.

---

## Fluxo detalhado por branch

### Push em `dev` ou `staging`

| Passo | Quem | O que faz |
|-------|------|-----------|
| 1 | Manager | Resolve issue do commit (`#N`) ou cria issue automática com labels `agent:manager` + `agent:qa` + `agent:security` (+ `agent:developer:done` em `dev`) |
| 2 | Manager | Outputs: `run_qa=true`, `run_security=true`, `run_docs=false`, `run_gates=false` |
| 3 | Job `qa` | Composite `workers/qa` → label `agent:qa` + assign Copilot com instruções de QA |
| 4 | Job `security` | Composite `workers/security` → label `agent:security` + assign Copilot com instruções de Security |
| 5 | (paralelo) | QA e Security rodam em paralelo |

### Push em `master`

| Passo | Quem | O que faz |
|-------|------|-----------|
| 1 | Manager | Resolve/cria issue; aplica `agent:technical-documenter` |
| 2 | Manager | Outputs: `run_docs=true`, `run_gates=true` |
| 3 | Job `technical-documenter` | Composite → label + assign Copilot como technical-documenter |
| 4 | Job `master-gates` | Lê labels da issue. Se faltar `qa:accepted` / `security:accepted` / `agent:technical-documenter:done`, aplica a label `agent:*` correspondente e seta `need_*=true` |
| 5 | Jobs `master-qa` / `master-security` (condicionais) | Se gap, invocam novamente os composites de QA/Security |

**Quarteto de conclusão** (Manager fecha a issue só quando existir, com evidência):

1. `qa:accepted`
2. `security:accepted`
3. `agent:technical-documenter:done`
4. `agent:tutorial-assistant:done` (quando aplicável ao fluxo)

---

## Como cada composite worker aciona o Copilot

**Princípio:** um único link. Nenhuma skill, checklist ou regra extra no `action.yml`.

```text
CUSTOM_INSTRUCTIONS =
  Atue 100% como <papel> do ControleOnline.
  Leia e siga OBRIGATORIAMENTE a fonte canônica única:
  https://raw.githubusercontent.com/players4players/agents-mcp/master/agents/roles/<papel>/agent.md
```

Tudo o mais (skills, checklists, labels de aceite, proibições, cooperação com Copilot) está **dentro** do `agent.md` do papel. O Copilot lê esse arquivo e segue a ordem de leitura definida nele.

O worker só:
1. aplica a label de estágio `agent:<papel>`;
2. faz `agent_assignment` com o texto mínimo acima;
3. comenta apontando a fonte.

- **Token**: `GH_TOKEN` (PAT; `GITHUB_TOKEN` padrão não permite agent_assignment).
- **Base branch**: passado pelo Manager (já normalizado).


## Labels de controle (resumo operacional)

| Label | Significado |
|-------|-------------|
| `agent:manager` | Manager orquestrou / está no ciclo |
| `agent:qa` | Aguardando atuação de QA (Copilot ou fallback) |
| `qa:accepted` / `qa:rejected` | Resultado do validador QA |
| `agent:security` | Aguardando Security |
| `security:accepted` / `security:rejected` | Resultado do validador Security |
| `agent:technical-documenter` | Aguardando documentação técnica |
| `agent:technical-documenter:done` | Documentação técnica concluída |
| `agent:developer:done` | Código de produto mergeado em `dev` (contexto de push em `dev`) |

O Manager **não** decide aceite de QA/Security no lugar dos validadores. Ele só aplica labels de estágio e invoca os workers.

---



## Wrappers `.github/agents` (não usar em repos de produto)

Regras **não** devem morar espalhadas em cada repositório.

- Em repositórios de produto (`app-community`, `api-*`, `ui-*`, etc.): **remover** o diretório `.github/agents/`.
- Os wrappers finos (se ainda necessários para o Copilot UI) devem ser gerados **somente** a partir do `agents-mcp` e apontar exclusivamente para `agents/roles/*/agent.md`.
- O canal oficial de assignment em push é o Manager Worker + composite actions (este documento), não arquivos locais de wrapper.

## Separação de canais (não misturar)

| Canal | Quando usar | Onde vive |
|-------|-------------|-----------|
| **Manager Worker + composite actions** (este doc) | Push em master/dev/staging → orquestração de issue + assignment Copilot para QA/Security/Docs | `.github/workflows/manager-worker.yml` + `.github/actions/workers/*` |
| Runners legados / dispatch | Fila de Project, claim de issue, PR review runners, DevOps dispatch | `workers/src/*`, `workers/automate/`, `github-operations.yml` |
| ChatGPT / agents pares | Investigação, handoff, execução interativa por papel | Fora do GitHub Actions |

O `manager-worker` **substitui** o antigo `technical-documenter.yml` isolado. Documentação técnica agora é invocada pelo Manager (e, em master, também pelos gates de quarteto).

---

## Responsabilidades e limites

- **Manager (Actions)**: resolve/cria issue, labels de estágio, decide e invoca workers, gates de quarteto em master. Não implementa código de produto.
- **Composite workers (QA / Security / TD)**: apenas assign + label + comentário. A execução real do checklist fica a cargo do Copilot (ou fallback por labels).
- **Copilot**: segue o `agent.md` + `copilot-cooperation.md` recebidos no `custom_instructions`. Não vira dono da fila de Project.
- **Outros bots (Grok etc.)**: podem atuar pelas labels se o Copilot não completar; o fluxo de labels permanece a fonte de verdade.
- **Exceção agents-mcp**: Manager/CTO podem editar docs e governança neste repositório (roles, skills, workflows).

---

## Secrets necessários

Em cada repositório:

- `GH_TOKEN` — PAT (ou GitHub App token) com permissão de issues write + agent assignment.  
  O `GITHUB_TOKEN` gerado automaticamente pelo Actions **não** é suficiente para o endpoint de `agent_assignment`.

---

## Referências obrigatórias

- Roles: `agents/roles/{manager,qa,security,technical-documenter}/agent.md`
- Cooperação Copilot: `agents/skills/shared/operations/copilot-cooperation.md`
- GitHub Flow: `agents/skills/shared/github/github-flow.md`
- Runners (canal paralelo): `agents/skills/runners/README.md`
- Este documento: `agents/skills/shared/operations/manager-worker-copilot.md`

Qualquer mudança no comportamento dos workers deve ser refletida **primeiro** neste arquivo e nos `action.yml` correspondentes, depois propagada.
