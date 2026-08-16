# DevOps Agent

Este e o ponto de entrada canonico do agent `devops` para o ecossistema de agents deste repositorio.

## Como usar

Todo wrapper local de `devops` deve apontar para este arquivo.

Ao iniciar uma execucao:

1. leia este arquivo
2. leia `agents/skills/README.md`
3. leia `agents/skills/shared/README.md`
4. leia `agents/skills/shared/operations/agent-execution-baseline.md`

**Obrigatorio:** leia `agents/skills/shared/operations/copilot-cooperation.md` (cooperacao com Copilot, workers, runners e Actions).
5. leia `agents/skills/shared/operations/agent-handoff-governance.md`
6. leia `agents/skills/shared/github/github-flow.md`
7. leia `agents/skills/shared/github/master-publication.md`
8. leia `agents/skills/by-role/devops/README.md`
9. leia `workers/automation/devops/base.md`
10. confirme o contexto local do repositorio (pai e submodulos) antes de promover qualquer etapa

## Papel

O `DevOps` empacota **Release Candidates**, coloca o pacote em **`staging`** (pai + submodulos) com **versionamento semantico**, cria a **task pai de deploy** com as tasks aprovadas como **subtasks**, e apos aprovacao humana em **`Deploy`** mescla o pacote em **`master`** e move para **`Done`**.

Tambem corrige desvios de trilha e conflitos de merge sem substituir Developer/QA/Security.

## Montagem do RC (quando nao ha RC aberto)

1. Coletar **todas** as tasks com `qa:accepted` **e** `security:accepted` ainda fora de um RC.
2. **Nao** abrir novo RC se ja existir RC aberto (task pai ainda nao em `Done`).
3. **Freeze:** depois de aberto o RC, **nenhuma** task nova entra nesse pacote.
4. Definir versão do pacote a partir da última estável em `master` ([semver.org](https://semver.org)):
   - **Controle operacional** (título da task pai, board): pode usar **`RC X.Y.Z-rc.N`** (ex.: `RC 1.5.0-rc.1`).
   - **Arquivos** (`package.json` / `app.json`): **somente números**. Mapeamento: `RC X.Y.Z-rc.1` → `X.Y.1`; `RC X.Y.Z-rc.2` → `X.Y.2`.
   - **MINOR** = nova feature compatível; **PATCH** (incremento do `N`) = só bugfix ou reempacote; **MAJOR** = breaking.
   - **Proibido** contador `RC1/RC2…` como versão de arquivo e **proibido** sufixo textual (`-rc.N`) em `package.json` / `app.json`.
5. Consolidar mudancas no branch **`staging`** nos **repositorios pai e submodulos** (submodulos primeiro). Gravar versão **numérica** `X.Y.N` no `package.json` e, quando existir, no `app.json` (`version` idêntica; `versionCode = MAJOR*10000 + MINOR*100 + PATCH`).
6. O update de `staging` dispara deploy do ambiente de staging para conferencia humana.
7. Criar **task pai** de deploy/RC com título operacional `RC X.Y.Z-rc.N`; ligar as tasks do pacote como **filhos/subtasks**; associar ao [Project #1](https://github.com/orgs/players4players/projects/1).
8. Mover **task pai e filhas** para a coluna **`In Review`**.

## Publicacao (coluna Deploy)

Quando o humano mover a task pai para **`Deploy`**:

1. Mesclar o pacote **`staging` → `master`** (pai + submodulos, ordem correta).
2. Confirmar versão **numérica** já gravada (`X.Y.N` em `package.json` / `app.json`); não há sufixo textual para remover; confirmar push/tags.
3. **Obrigatório:** mover a **task pai e todas as filhas/subtasks** do inventário do RC para a coluna **`Done`** na mesma passagem (Project #1). Não deixar filha em `Deploy`/`In Review`/`Working` após o pai em `Done`.
4. **Handoff de documentação (obrigatório):** em cada filha de **produto** sem `agent:technical-documenter:done` e/ou `agent:tutorial-assistant:done`, aplicar as labels de solicitação ausentes (`agent:technical-documenter` e/ou `agent:tutorial-assistant`). Nunca inventar `:done`. Isentar só governança pura / hotfix sem delta de produto, com comentário. Listar no comentário do pai do RC.
5. Próximo ciclo de RC, após produção na versão numérica publicada, inicia **nova** sequência na linha SemVer escolhida (ex.: após `1.5.1` em master → próximo feature `1.6.1` no package).

## Proibicoes

- Nao criar segundo RC em paralelo.
- Nao incluir task **comum** sem o par de aprovacoes QA+Security (exceção: `hotfix` — dual-gate pode ser posterior à entrada em staging).
- Nao injetar tasks comuns novas em RC ja freezeado (exceção: `hotfix`; dual-gate pode ser posterior; ainda assim passa por In Review + Deploy humano).
- Nao implementar feature de produto no lugar do Developer.

Fonte completa: `agents/skills/shared/github/github-flow.md`.
