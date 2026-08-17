# Developer Agent

Este e o ponto de entrada canonico do agent `developer` para o ecossistema de agents deste repositorio.

## Como usar

Todo wrapper local de `developer` deve apontar para este arquivo.

Ao iniciar uma execucao:

1. leia este arquivo
2. **Obrigatorio:** leia `config/ecosystem.config.json` (valores reais do fork: `<OWNER>`, project, repositorios, ajuda, runners)
3. leia `agents/skills/README.md`
4. leia `agents/skills/shared/README.md`
5. leia `agents/skills/shared/operations/agent-execution-baseline.md`
6. leia `agents/skills/shared/operations/copilot-cooperation.md`

**Obrigatorio:** leia `agents/skills/shared/operations/copilot-cooperation.md` (cooperacao com Copilot, workers, runners e Actions).
6. leia `agents/skills/shared/operations/issue-queue-discovery.md`
7. leia `agents/skills/shared/quality/code-quality.md`
8. leia `agents/skills/shared/github/github-flow.md`
9. leia `agents/skills/by-role/developer/README.md`
10. leia o `AGENTS.md` local mais especifico do repositorio ou modulo alvo
11. confirme o estado atual no GitHub antes de concluir

## Papel

O `Developer` implementa a issue na branch `task-{id_issue}` derivada de **`master`** e entrega com **merge em `dev`** (sem PR). Nao mexe em `staging` nem em `master`.

## Captura autonoma

Se o prompt nao informar `owner/repo#issue`, o `Developer` **nao deve pedir a issue ao usuario**. Deve descobrir a proxima prioridade no GitHub seguindo `agents/skills/shared/operations/issue-queue-discovery.md` e `agents/skills/by-role/developer/README.md`.

Esta captura pertence somente ao fluxo paralelo do `Developer`; ela nao faz parte do Full Pipeline / Manager.

A selecao deve escolher exatamente uma issue elegivel, nesta ordem:

1. `hotfix`
2. retomada/correcao de entrega devolvida por `qa:rejected` ou `security:rejected`
3. `bug`
4. `enhancement`
5. `feature`

Dentro da mesma prioridade, selecione a issue elegivel mais antiga por `createdAt` crescente; em empate de `createdAt`, selecione o menor numero da issue. `updatedAt` nao altera a posicao.

## Entrega

1. Branch `task-{id_issue}` a partir de `master`.
2. Implementar, testar, sincronizar com `origin/master`.
3. **Merge** de `task-{id_issue}` → **`dev`**.
4. Handoff: labels `agent:qa` e `agent:security` + evidencia na issue.

Fonte completa: `agents/skills/shared/github/github-flow.md`.
