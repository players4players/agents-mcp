# Copilot Cooperation (obrigatoria)

Skill **transversal**: todo agent do ecossistema `players4players` **deve estender** esta skill. Nenhum papel opera isolado do Copilot Coding Agent, workers, runners ou GitHub Actions quando essas superficies ajudam a concluir o trabalho.

## Objetivo

Tratar o **GitHub Copilot Coding Agent**, os **workers/runners** deste repositorio e as **GitHub Actions** como **parceiros de execucao**, nao como canais opcionais. O agent na sessao **coopera** com eles: delega, monitora, valida e integra o resultado na fila operacional.

## Quem deve estender

Todos os papeis:

`cto` · `developer` · `devops` · `qa` · `security` · `sysadmin` · `manager` · `technical-documenter` · `tutorial-assistant`

Wrappers em `.github/agents/*.agent.md` (`target: github-copilot`) herdam esta skill via o `agents/roles/<papel>/agent.md` correspondente.

## Superficies de cooperacao

| Superficie | Uso tipico |
| --- | --- |
| **GitHub Copilot Coding Agent** | Implementacao em branch/PR, refactors, testes, patches multi-arquivo |
| **Workers** (`workers/src`, `workers/automate`) | Dispatch de fila, claim, handoff, scripts de review/dispatch |
| **Runners** (`workers/src/*-runner.js`, `npm run …`) | Entrypoints por papel |
| **GitHub Actions** (`.github/workflows`, `workers/automate/workflows`) | CI, operacoes batch quando habilitadas |
| **Scripts de sync** (`workers/scripts/sync-copilot-agents.mjs`) | Regenerar wrappers Copilot a partir da fonte canonica |
| **API GitHub** | PR, checks, merge — com referencia `owner/repo#n` |

## Fila (ControleOnline)

Siga `issue-queue-discovery.md` deste repositorio (issues/labels e Project quando aplicavel). Ao cooperar com Copilot, cite sempre `owner/repo#n` no PR.

## Regras de cooperacao

1. **Estenda, nao substitua.** O agent na sessao permanece responsavel pelo criterio, elegibilidade, handoff e qualidade; Copilot/workers executam trechos mecanicos ou de volume.
2. **Prefira Copilot** quando a tarefa exigir mudancas de codigo em repositorio GitHub.
3. **Prefira workers/runners** quando a tarefa for fila, claim, handoff, batch de status ou prompt seed.
4. **Prefira Actions** quando o trabalho for recorrente, gated por CI ou precisar de ambiente de pipeline.
5. **Sempre referencie a tarefa** da fila (`owner/repo#n`) em PRs, commits e handoff.
6. **Nao invente canal paralelo** de fila. Copilot nao vira dono da fila — so do codigo/PR.
7. **Ao delegar ao Copilot**, deixe escopo claro: repo, branch base, criterios de aceite, fora de escopo, ID da tarefa.
8. **Ao receber resultado do Copilot**, valide CI, diff e criterios do papel antes do handoff.
9. **Wrappers Copilot** permanecem finos e apontam para `agents/roles/*/agent.md` + esta skill; regenere com `sync-copilot-agents.mjs` apos mudancas estruturais.
10. **Falha de superficie**: registre o bloqueio, use alternativa e continue — nao abandone sem handoff.

## Contrato de delegacao ao Copilot

Prompt/contexto minimo:

- papel que coopera (`developer`, `qa`, …)
- referencia da tarefa (`owner/repo#n`)
- repositorio(s) alvo
- branch base (`master` / `dev` conforme `github-flow.md`)
- criterios de aceite objetivos
- escopo negativo (o que nao fazer)
- obrigacao de citar a tarefa no PR

## Contrato de uso de workers / runners

```bash
AGENT_DISPATCH_ROLE=developer npm run dispatch
npm run developer
npm run qa
npm run security
npm run devops
```

- Fila: workers de project/issue dispatch documentados neste repo
- Env: `GITHUB_TOKEN` / GitHub App

## Contrato de Actions

- Workflows podem estar desativados como canal principal; o agent pode aciona-los quando reduzirem risco ou repeticao.
- Secrets: `GITHUB_TOKEN` / GitHub App (codigo/PR/fila).

## Ordem de leitura (todo agent)

1. `copilot-cooperation.md` (esta skill)
2. `agent-execution-baseline.md`
3. `issue-queue-discovery.md`
4. `agent-handoff-governance.md`
5. skills do papel em `by-role/<papel>/`
6. `github-flow.md` quando houver codigo/PR

## Output minimo ao cooperar

- superficie usada (Copilot / worker / runner / Action)
- tarefa da fila
- PR/run/job IDs
- resultado e proxima label/status

## Quality bar

- nao ignore Copilot/workers quando encurtam o caminho seguro
- nao despeje trabalho no Copilot sem criterios de aceite
- nao trate output do Copilot como verdade sem validacao do papel
- nao quebre a fonte canonica `agents-mcp` com regras so no wrapper
- nao desvie da skill de fila deste repositorio
