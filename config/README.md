# Configuracao do ecossistema (`agents-mcp`)

Este diretorio concentra **todas as variaveis de ambiente e placeholders** usados pela documentacao canonica e pelos workers.

A documentacao em `agents/` e `AGENTS.md` **nao deve citar marca, org real ou dominio de produto**. Use apenas placeholders. Os valores reais ficam aqui (ou no ambiente CI).

## Arquivos

| Arquivo | Uso |
|---------|-----|
| `ecosystem.config.example.json` | Modelo versionado — copiar e preencher |
| `ecosystem.config.json` | Valores do fork ( **nao** commitar segredos; pode ser local ou gerado no CI) |
| `ecosystem.config.schema.json` | Schema JSON opcional para validacao |

```bash
cp config/ecosystem.config.example.json config/ecosystem.config.json
# edite owner.value, project.*, documentation.*, etc.
```

## Placeholders na documentacao

| Placeholder | Significado | Campo no config | Env sugerida |
|-------------|-------------|-----------------|--------------|
| `<OWNER>` | Org/usuario GitHub dono dos repos | `owner.value` | `OWNER` |
| `<env.OWNER>` | Mesmo valor, lido em runtime nos workers | `owner.value` | `OWNER` / `PROJECT_ORG` / `QA_PROJECT_ORG` |
| `<OWNER>/agents-mcp` | Repo canonico deste projeto | `github.core_repository` | `AGENTS_MCP_REPOSITORY` |
| `<PROJECT_URL>` | URL do board ProjectV2 | `project.url.value` | `PROJECT_URL` |
| `<PROJECT_NUMBER>` | Numero do ProjectV2 | `project.number.value` | `PROJECT_NUMBER` |
| `<HELP_CENTER_URL>` | Base da central de ajuda | `documentation.help_center_url.value` | `HELP_CENTER_URL` |
| `<HELP_CENTER_HOST>` | Host da ajuda (sem https) | `documentation.help_center_host.value` | `HELP_CENTER_HOST` |
| `<TEAM_EMAIL>` | E-mail de avisos de doc | `documentation.team_email.value` | `TEAM_EMAIL` |

Placeholders de **template de texto** (nao sao config de fork): `<papel>`, `<agent>`, `<role>`, `<repo>`, `<executor>`, etc.

## Runtime (workers / Actions)

Prioridade de leitura recomendada:

1. Variaveis de ambiente do job (`OWNER`, `PROJECT_ORG`, `GITHUB_TOKEN`, …)
2. `config/ecosystem.config.json` (se o runner carregar o arquivo)
3. Default seguro vazio / placeholder — **nunca** uma marca hardcoded

Tokens (`GITHUB_TOKEN` / `GH_TOKEN`) **nao** entram neste JSON. Use secrets do GitHub Actions ou do ambiente.

## Checklist ao fazer fork

1. Copiar `ecosystem.config.example.json` → `ecosystem.config.json`
2. Preencher `owner.value` com a org do fork
3. Preencher `project.url` / `project.number`
4. Preencher `documentation.*` se houver central de ajuda
5. Exportar as env correspondentes no CI (ou carregar o JSON no entrypoint dos workers)
6. Garantir que buscas por marca antiga no repo retornem vazio
