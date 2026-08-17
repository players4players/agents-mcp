# GitHub Manager Runner

## Objetivo

Fornecer um unico runner oficial, executado dentro do proprio GitHub Actions, para manutencao gerencial e mutacoes autorizadas no GitHub.

## Papel

Esse runner tem papel de gerente operacional no GitHub.

Ele:

- corrige coluna errada no ProjectV2
- remove labels `agent:*` incorretas ou residuais
- limpa assignees tecnicos quando eles nao fazem parte do fluxo oficial
- executa manutencoes gerais de issue e PR
- recebe comandos remotos de outros agents com mais permissao de escrita

## Auditoria automatica

Quando executado por `schedule` ou por `workflow_dispatch` sem `operations_json`, o runner entra em modo de auditoria.

Nesse modo ele:

- procura tasks em `Ready` ou `Working`
- verifica evidencias de aprovacao de `Security` e `Q.A.`
- move para `In Review` a task que ficou presa na coluna errada
- remove labels operacionais residuais
- pode remover assignees tecnicos residuais

## Disparos suportados

- `schedule`
- `workflow_dispatch`
- `issue_comment` no proprio repositorio `agents-mcp`, usando `/github-manager` ou `/github-ops`
- `push` em `workers/automate/requests/github-manager.json`, para requisicoes versionadas quando a integracao de origem nao dispara eventos de comentario

## Formato do comando por comentario

Exemplo:

```text
/github-manager
```json
{
  "dry_run": false,
  "operations": [
    {
      "type": "project_status",
      "org": "OWNER",
      "project_number": 1,
      "repo_full_name": "OWNER/app-community",
      "issue_number": 74,
      "target_status": "In Review"
    }
  ]
}
```
```

Sem JSON, o comentario-comando apenas dispara a auditoria gerencial.

O arquivo `workers/automate/requests/github-manager.json` aceita o mesmo payload. Ele pode incluir `report_to` com `repo_full_name` e `issue_number` para publicar o resumo verificavel da execucao.

## Operacoes suportadas

### `manager_audit`

Executa a mesma auditoria gerencial do agendamento.

### `project_status`

Campos aceitos:

- `org`
- `project_number`
- `target_status`
- `item_id` opcional quando o item ja for conhecido
- `repo_full_name` e `issue_number` quando for preciso localizar o item pela issue

Quando `repo_full_name` e `issue_number` forem informados, o runner garante que a issue esteja vinculada ao ProjectV2 antes de alterar o status. Se o item ainda nao existir no projeto, ele e incluido automaticamente e depois movido para o status solicitado.

### `issue_comment`

Campos aceitos:

- `repo_full_name`
- `issue_number`
- `body`

### `create_issue`

Cria uma issue e, quando `org`, `project_number` e `target_status` forem informados, adiciona a nova task ao ProjectV2 e define sua coluna na mesma operacao. Varias operacoes `create_issue` podem ser enviadas no mesmo `operations_json`.

Campos aceitos:

- `repo_full_name`
- `title`
- `body` opcional
- `labels` opcionais
- `assignees` opcionais
- `milestone` opcional
- `project_org` ou `org`
- `project_number`
- `target_status`

Esse tipo de operacao pode aparecer varias vezes no mesmo `operations_json`, o que permite ao CTO criar varias tasks em um unico disparo.

Quando `project_number` for informado e `target_status` nao vier no payload, a issue e adicionada ao ProjectV2 em `Ready`.

### `replace_labels`

Campos aceitos:

- `repo_full_name`
- `issue_number`
- `labels`

### `add_assignees`

Campos aceitos:

- `repo_full_name`
- `issue_number`
- `assignees`

### `remove_assignees`

Campos aceitos:

- `repo_full_name`
- `issue_number`
- `assignees`

### `pr_review`

Campos aceitos:

- `repo_full_name`
- `pull_number`
- `event`
- `body`

### `rest`

Campos aceitos:

- `method`
- `path`
- `body` opcional
- `headers` opcionais

### `graphql`

Campos aceitos:

- `query`
- `variables` opcionais

## Regras de seguranca

- o runner so executa comentario-comando de logins permitidos
- o token preferencial e `GH_TOKEN`; `GITHUB_TOKEN` fica como fallback
- o token usado pelo job precisa ter permissao `projects: write` para ler e alterar ProjectV2
- `dry_run` deve ser usado quando a operacao ainda estiver sendo validada
- o output precisa deixar rastreavel o que foi pedido, o que foi executado e o que falhou

## Relacao com os agents

Quando um agent do ChatGPT nao conseguir concluir uma mutacao do GitHub diretamente deste runtime, ele deve preferir este runner oficial em vez de fingir mudanca de coluna, label, ownership ou review.
