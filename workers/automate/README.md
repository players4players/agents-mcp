# Automate

Esta pasta concentra a politica e a base executavel dos runners operacionais do ecossistema `players4players`.

## Agentes cobertos

- `Developer`: seleciona issue aberta de membro da equipe com prioridade em `Ready`, executa a mudanca na propria branch e mantém a task em `Working` ate o handoff para a fase compartilhada de `Quality Assurance` e `Security`
- `Quality Assurance`: valida a entrega recebida do `Developer`, registra `qa:accepted` ou `qa:rejected` na issue e remove `agent:qa`
- `Security`: valida a entrega recebida de `Quality Assurance`, registra `security:accepted` ou `security:rejected` na issue e remove `agent:security`
- `DevOps`: seleciona tarefas com `qa:accepted` e `security:accepted`, cria a release, aguarda a aprovacao humana que move a task para `Deploy` e, a partir de `Deploy`, publica a build em producao ate a finalizacao
- `GitHub Operations Runner`: executa mutacoes de GitHub a partir do proprio GitHub Actions quando o runtime local dos agents nao consegue concluir a operacao

## Arquivos principais

- `workers/scripts/developer-pr-dispatch.mjs`: selecao do backlog do `Developer`
- `workers/scripts/pr-label-review-runner.mjs`: review runner compartilhado entre `Quality Assurance` e `Security` para fluxo por labels e issue
- `workers/scripts/github-operations.mjs`: executor genérico de mutações REST, GraphQL e atualizacoes de projeto no GitHub
- `review-checklists.md`: checklists canonicos que devem ser copiados para a task durante a revisao
- `pull-request-review.md`: politica atual de review de `QA`
- `security-pull-request-review.md`: politica atual de review de `Security`
- `master-publication.md`: regra de aprovacao e promocao exclusiva do `DevOps` na publicacao de `master`

## Objetivo

Permitir que o GitHub execute o fluxo padronizado:

1. `Developer` le apenas issue aberta criada por membro da equipe com prioridade em `Ready`
2. `Developer` trabalha somente na propria branch da tarefa, contendo o numero da issue
3. `Developer` nao encerra o fluxo tecnico normal com PR
4. `Developer` mantém a task em `Working` e repassa a responsabilidade para a fase compartilhada de `Quality Assurance` e `Security` via `agent:qa` e `agent:security`
5. `Quality Assurance` registra `qa:accepted` ou `qa:rejected` na issue, copia o checklist de aprovacao para a task e remove `agent:qa`
6. `Security` registra `security:accepted` ou `security:rejected` na issue, copia o checklist de seguranca para a task e remove `agent:security`
7. quando houver recusa, o runner comenta a issue de forma direta e explicativa, informando o motivo objetivo e o checklist que nao foi atendido
8. quando `qa:accepted` e `security:accepted` coexistirem sem novas solicitacoes nos comentarios, `DevOps` seleciona a task e cria a release
9. o humano aprova a entrega movendo a task para `Deploy`
10. em `Deploy`, `DevOps` pega as tasks contidas na build e publica a build em producao ate a finalizacao
11. depois de publicar, `DevOps` move a task para `Documentation` e aplica `agent:tutorial-assistant` e/ou `agent:technical-documenter` para iniciar a trilha documental correspondente

## Observacoes

- `Quality Assurance` e `Security` nao publicam `APPROVE` ou `REQUEST_CHANGES` no GitHub Review.
- `Quality Assurance` e `Security` operam por labels e comentario na issue.
- a fila oficial de entrada e `Ready`; `Working` e o estado de ownership ativo ate `Developer`, `Quality Assurance` e `Security` concluirem a trilha tecnica
- a fase compartilhada de QA/Security deve carregar as duas labels de entrada enquanto ainda nao houver decisao estruturada
- tasks recusadas por `QA` ou `Security` devem voltar a prioridade do `Developer` antes de capturas novas
- quando `qa:accepted` e `security:accepted` coexistirem sem novas solicitacoes nos comentarios, `DevOps` assume a task para preparar a release tecnica
- quando houver conflito entre script e politica, siga os arquivos `.md` desta pasta.
