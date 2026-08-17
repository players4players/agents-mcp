# Issue Queue Discovery

Skill compartilhada pelos agents documentais (`technical-documenter`, `tutorial-assistant`), de revisao (`qa`, `security`), `sysadmin` (modo `resolve`) e reutilizavel por outros papeis que precisem da mesma fila.

## Objetivo

A fonte primaria da fila sao **issues + labels** (e estado open/closed).

- **QA e Security:** podem selecionar e processar **varias** issues elegiveis na mesma execucao/rodada (cada uma com decisao e comentario completos).
- **Demais papeis** (Developer, DevOps, Manager board, Documentacao, etc.): selecionar **exatamente uma** issue elegivel por execucao, salvo prompt ou fonte canonica do papel que ordene o contrario.

## ProjectV2

- **Nao e proibido** usar GitHub Projects (ProjectV2).
- **Prefira nao usar** ProjectV2 quando labels e busca de issues bastarem (fila, elegibilidade, handoff).
- Use ProjectV2 quando for preciso: associar issue recem-criada ao board, ler status/coluna complementar, ou quando o prompt pedir explicitamente.
- Projeto operacional padrao da org: [<OWNER> Project #1](PROJECT_URL (org Project operacional)) (`organization` `<OWNER>`, `number` `1`).

## Associacao obrigatoria ao criar task

Sempre que um agent **criar** uma issue/task nova:

1. Crie a issue no repositorio adequado.
2. **Associe-a ao projeto** `PROJECT_URL (org Project operacional)` (ProjectV2 da org, number `1`).
3. Aplique as labels `agent:*` necessarias.

Falha ao associar ao projeto deve ser registrada no comentario da issue e tentada de novo quando houver permissao/API; a issue em si nao deve ficar “solta” sem tentativa de vinculo.

## Outras regras

- Nao processe mais de uma issue na mesma execucao **exceto QA e Security** (e salvo prompt ou fonte canonica do papel que ordene o contrario).
- O agent pode **criar labels** oficiais ausentes no repositorio.

## Fonte de verdade da fila

- Issues do GitHub na org `<OWNER>` (ou escopo restrito pelo prompt).
- Labels oficiais do papel + estado da issue + comentarios.
- ProjectV2 como complemento (board), nao como unico criterio quando labels bastam.

## Descoberta

1. Se o prompt definir `owner/repo` + numero da issue → trabalhe **somente** nela (ainda assim valide elegibilidade do papel).
2. Se o prompt **nao** definir issue/repositorio:
   - busque issues em **todos** os repositorios da org `<OWNER>` (preferencialmente por label/estado);
   - se util, complemente com itens do Project #1;
   - filtre pelas regras de elegibilidade do papel;
   - **QA/Security:** pode escolher **varias** elegiveis (ordenar por prioridade e `updated`); demais papeis: escolha **exatamente uma**;
   - aplique primeiro as prioridades funcionais definidas pelo pipeline e pelo papel;
   - dentro da mesma prioridade, selecione a issue elegivel mais antiga por `createdAt` crescente;
   - em empate de `createdAt`, selecione o menor numero da issue;
   - nunca use `updatedAt` para reposicionar trabalho: comentarios, labels ou atividade recente nao fazem uma task ultrapassar outra mais antiga da mesma prioridade.

## Template de elegibilidade — `Developer`

O `Developer` deve descobrir trabalho sozinho quando a issue nao vier no prompt. Nao peca ao usuario para escolher uma issue se o GitHub/Project #1 puder ser consultado.

Este template e exclusivo do fluxo paralelo do `Developer`. O Full Pipeline / Manager nao usa esta fila para capturar implementacao; ele apenas corrige desvios de governanca quando chegar na etapa de higiene.

Fonte primaria:

- issues `open` na org `<OWNER>`;
- labels de ownership/estado;
- Project #1 como complemento para coluna/status (`Ready` e `Working`).

Candidata se **qualquer** for verdadeira:

1. possui `agent:developer`;
2. esta em `Ready` sem nenhum `agent:*` (entrada padrao do fluxo);
3. esta em `Working` sem nenhum `agent:*`, quando nao houver evidencia de ownership humano exclusivo;
4. possui `qa:rejected` ou `security:rejected` e ainda precisa de correcao pelo Developer.

Nao candidata se houver decisao/revisao ativa que ainda pertenca a `QA`, `Security` ou `DevOps` (por exemplo, aguardando aceite/recusa com `agent:qa`, `agent:security` ou pacote de RC).

Ordem de prioridade do `Developer`:

1. `hotfix`
2. `qa:rejected` ou `security:rejected`
3. `bug`
4. `enhancement`
5. `feature`

Dentro da mesma prioridade, selecione a issue elegivel mais antiga por `createdAt` crescente; em empate de `createdAt`, selecione o menor numero da issue. `updatedAt` nao altera a posicao. Se nenhuma issue elegivel existir, registre o criterio de busca e pare com bloqueio objetivo.

## Template de elegibilidade — papeis documentais

| Label | Significado |
| --- | --- |
| `agent:<papel>` | Solicitacao/marcacao para o papel (**qualquer status**) |
| `agent:<papel>:done` | Trabalho deste papel ja concluido nesta issue |

Candidata se **qualquer** for verdadeira:

- possui `agent:<papel>`;
- esta `closed` e **nao** possui `agent:<papel>:done`.

Papeis: `technical-documenter`, `tutorial-assistant`.

Conclusao documental: comentar + `agent:<papel>:done` + remover `agent:<papel>`. Sem `accepted`/`rejected`.

## Template de elegibilidade — papeis de revisao (`qa`, `security`)

Estes papeis **nao alteram codigo**, branches, PRs nem arquivos de produto. So analisam e **notificam por labels + comentarios**.

| Label | Significado |
| --- | --- |
| `agent:qa` / `agent:security` | Solicitacao explicita de revisao (**qualquer status**) |
| `qa:accepted` / `security:accepted` | Revisao aprovada; trabalho daquele papel **encerrado** nesta passagem |
| `qa:rejected` / `security:rejected` | Revisao recusada; trabalho daquele papel **encerrado** nesta passagem |

Candidata para o papel se **qualquer** for verdadeira:

1. possui `agent:<papel>` e **ainda nao** tem decisao final daquele papel (`:accepted` ou `:rejected`);
2. esta `closed` e **ainda nao** possui a aprovacao daquele papel (`qa:accepted` ou `security:accepted` respectivamente).

Notas:

- `rejected` **encerra** o trabalho do revisor naquela passagem (nao fica em loop infinito na mesma evidencia).
- Issue `closed` **sem** `qa:accepted` **e** `security:accepted` e ilegal no fluxo: o revisor que a capturar deve **reabrir** a issue antes ou durante a analise.
- Uma tarefa so pode permanecer `closed` com as **duas** aprovacoes: `qa:accepted` **e** `security:accepted`.

### Gate dual (fechamento)

| Estado da issue | Labels de aprovacao | Acao do revisor |
| --- | --- | --- |
| `closed` | falta `qa:accepted` e/ou `security:accepted` | **Reabrir** a issue, analisar, decidir por labels |
| `closed` | tem `qa:accepted` **e** `security:accepted` | Nao e candidata por fechamento indevido |
| `open` | tem `agent:qa` / `agent:security` sem decisao | Analisar e decidir |

### Conclusao da revisao

Ao **aprovar**:

1. Comente resumo objetivo + checklist atendido (quando couber).
2. Adicione `qa:accepted` ou `security:accepted`.
3. Remova `agent:qa` ou `agent:security` se presente.
4. Remova eventual `:rejected` anterior do **mesmo** papel se estiver reavaliando apos correcao.

Ao **recusar**:

1. Comente motivos objetivos + checklist nao atendido.
2. Adicione `qa:rejected` ou `security:rejected`.
3. Remova `agent:qa` ou `agent:security` se presente.
4. Garanta que a issue fique **open** (reabra se estiver closed) para o Developer atuar.

Em ambos os casos o trabalho **daquele agent** naquela passagem termina. Nao mexa em codigo.

## Output minimo da descoberta

- criterio usado (prompt explicito vs busca org; se usou ProjectV2)
- issue escolhida (`owner/repo#n`)
- labels e estado (`open`/`closed`) no momento da captura
- se reabriu a issue (sim/nao)
- se a issue foi associada ao Project #1 (ao criar)
