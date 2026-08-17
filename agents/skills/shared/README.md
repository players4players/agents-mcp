# Shared Skills

Esta biblioteca cobre as skills compartilhadas do ecossistema.

## Ecosystem Centrality

Trate `<<OWNER>>/agents-mcp` como a fonte primaria para agents, runners, ownership, handoffs e regras estruturais do fluxo.

## Task-First Policy

Toda solicitacao precisa estar vinculada a pelo menos uma task ou issue valida no GitHub. Use a skill de backlog do CTO quando faltar task.

## Skill Layering Policy

- comum → `agents/skills/shared/`
- por agent → `agents/skills/by-role/`
- runtime → `agents/skills/runners/`
- `agents/roles/*/agent.md` enxuto; wrappers finos em `.github/agents/`

## Priority Projects Policy

- `<OWNER>/app-community`
- `<OWNER>/api-community`
- `<OWNER>/api-whatsapp`

## Agent Delegation Policy

Delegue quando a trilha for de `Developer`, `Security`, `QA`, `DevOps` ou `Sysadmin`. Intervenha no `agents-mcp` quando a falha for estrutural.


## Copilot Cooperation (obrigatoria)

Todo agent **deve estender** `operations/copilot-cooperation.md`.

- Copilot Coding Agent, workers, runners e GitHub Actions sao superficies de cooperacao
- Wrappers `.github/agents/*.agent.md` usam `target: github-copilot`
- Sync: `workers/scripts/sync-copilot-agents.mjs`

## Shared Operational Skills (por categoria)

### github/
- `github/github-flow.md`
- `github/github-issue-handling.md`
- `github/operational-github-workflow.md`
- `github/master-publication.md`

### documentation/
- `documentation/documentation-governance.md`

### security/
- `security/security-guardrails.md`
- `security/operational-security-guardrails.md`

### quality/
- `quality/code-quality.md`
- `quality/task-completion-criteria.md`

### operations/
- `operations/agent-execution-baseline.md`
- `operations/agent-wrapper-contract.md`
- `operations/agent-handoff-governance.md`
- `operations/autonomous-operations.md`
- `operations/operational-source-of-truth.md`
- `operations/log-investigation-evidence.md`
- `operations/email-reading-fallback.md`
- `operations/copilot-cooperation.md — cooperacao obrigatoria com Copilot/workers/runners/Actions
- `operations/issue-queue-discovery.md`

## GitHub Flow (branches e entrega)

A skill `github-flow.md` e a fonte canonica de:

- branch `task-{id_issue}` derivada de `master`
- entrega do Developer em **`dev`** por **merge** (sem PR)
- proibicao de PR para `Developer`, `QA` e `Security` no fluxo normal
- `staging` = somente pacote RC do `DevOps` (semver, pai + submodulos)
- apos `Deploy`: `DevOps` mescla `staging` → `master` → `Done`

Todo agent que toque em branch, integracao ou promocao deve seguir essa skill.

## Issue Flow Governance (resumo)

- `Developer` entrega em **`dev`**, sem PR
- `QA` / `Security` decidem por labels; evidencia = merge em **`dev`**
- recusa: Developer corrige e re-mergeia em **`dev`**
- `DevOps` monta RC em **`staging`**, task pai + subtasks, `In Review` → `Deploy` → `master` → `Done`
- nenhum agent fecha task no lugar do rito humano/board quando aplicavel
