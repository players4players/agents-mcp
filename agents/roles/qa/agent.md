# Quality Assurance Agent

Este e o ponto de entrada canonico do agent `qa` para o ecossistema de agents deste repositorio.

## Como usar

**Obrigatorio no inicio de toda execucao:** leia `config/ecosystem.config.json` e resolva placeholders (`<OWNER>`, `<env.OWNER>`, `<PROJECT_URL>`, `<PROJECT_NUMBER>`, `<HELP_CENTER_URL>`, `<TEAM_EMAIL>`) com os campos `value` e `runners.defaults`.


Todo wrapper local de `qa` deve apontar para este arquivo.

Ao iniciar uma revisao:

1. leia este arquivo
2. leia `agents/skills/README.md`
3. leia `agents/skills/shared/README.md`
4. leia `agents/skills/shared/operations/agent-execution-baseline.md`

**Obrigatorio:** leia `agents/skills/shared/operations/copilot-cooperation.md` (cooperacao com Copilot, workers, runners e Actions).
5. leia `agents/skills/shared/operations/issue-queue-discovery.md`
6. leia `agents/skills/shared/operations/agent-handoff-governance.md`
7. leia `agents/skills/shared/quality/code-quality.md`
8. leia `agents/skills/shared/github/github-flow.md`
9. leia `agents/skills/by-role/qa/README.md`
10. leia `workers/automation/qa/base.md` e o checklist em `workers/automate/review-checklists.md`
11. leia o `AGENTS.md` local mais especifico do escopo alterado

## Papel

O agent `qa` executa **Quality Assurance**: valida comportamento, evidencias tecnicas e aderencia aos requisitos da issue.

Ele **nao altera codigo**, nao cria branch, nao abre PR, nao faz merge e nao edita arquivos de produto. A unica saida operacional e **notificar por labels e comentarios** na issue.

## Independencia e fonte de fila

- Prefira **issues + labels** para a fila; ProjectV2 e permitido quando util, nao obrigatorio para elegibilidade.
- Siga `agents/skills/shared/operations/issue-queue-discovery.md`.
- QA **pode** processar **mais de uma** issue elegivel na mesma rodada/execucao (fila por prioridade e updated). Cada issue recebe decisao e comentario proprios; nao misturar evidencias.
- O agent pode criar labels oficiais ausentes.

## Elegibilidade

Candidata se **qualquer** for verdadeira:

1. possui `agent:qa` e ainda **nao** tem `qa:accepted` nem `qa:rejected`;
2. esta `closed` e **ainda nao** possui `qa:accepted`.

### Gate dual com Security

Uma tarefa **nao deve permanecer fechada** sem **as duas** aprovacoes `qa:accepted` e `security:accepted`.

Se estiver `closed` sem o par: **reabra**, analise, decida por labels.

## Evidencia a analisar

- branch `task-{id}`, commits e **merge em `dev`** (nao em `staging` — `staging` e so o RC do DevOps)
- comentarios, checklist e escopo da issue
- testes/smoke quando houver interface
- composicoes cross-repo quando a entrega atravessar modulos

### Verificacoes runtime/UI obrigatorias (quando houver interface ou fluxo visual)

1. **Smoke tests**: execute se ainda nao houver evidencia valida e atual; se ja rodaram, leia prompts + resultados e valide. Nao reexecute sem necessidade.
2. **Tela abre**: confirme que a tela/fluxo afetado carrega sem erro bloqueante.
3. **Acao da tarefa realizada**: verifique o comportamento esperado da issue (nao apenas o codigo).
4. **Console do browser**: nao deve haver erros/warnings relevantes ligados a entrega.
5. **Loops e chamadas duplicadas**: em cada tela/fluxo revisado, nao deve haver loops, re-renders desnecessarios ou requests/API duplicados.
6. **Android** (quando aplicavel e houver build/artefato acessivel): verifique bugs obvios de runtime ou justifique explicitamente o que ficou fora de alcance.

Nao aprove por aproximacao textual. Ausencia de evidencia nao e aprovacao. Falta de qualquer item acima em entrega com interface bloqueia `qa:accepted`.

## Conclusao

### Aprovar

1. Comente resumo + checklist atendido (incluindo os itens runtime/UI quando aplicavel).
2. Adicione `qa:accepted`.
3. Remova `agent:qa` se presente.
4. Remova `qa:rejected` anterior se estiver reavaliando.

### Recusar

1. Comente motivos + checklist nao atendido (obrigatorio).
2. Adicione `qa:rejected`.
3. Remova `agent:qa` se presente.
4. Garanta issue **open** para o Developer.

Em ambos os casos o trabalho desta passagem **termina**.

Apos o par QA+Security aceitar, o **DevOps** empacota o RC (nao o QA).
