# agents-mcp

Repositório de orquestração dos agents, skills e workers do ecossistema deste repositorio.

## Estrutura

```
agents/
├── roles/          # definição canônica de cada papel
└── skills/         # biblioteca de skills
    ├── shared/     # regras transversais (github, documentation, security, quality, operations)
    ├── by-role/    # skills por papel
    └── runners/    # mapas de runtime

workers/            # execução (scripts, runners, automações)
├── automate/
├── automation/
├── src/
└── scripts/
```

## Entradas principais

- `agents/skills/README.md` — mapa da biblioteca
- `agents/skills/shared/README.md` — políticas compartilhadas
- `agents/skills/by-role/*/README.md` — orientação por agent
- `agents/roles/*/agent.md` — entradas canônicas
- `AGENTS.md` — regras operacionais centrais
- `workers/scripts/sync-copilot-agents.mjs` — sync dos wrappers

## Nota

Este repositório é a fonte canônica. Wrappers em `.github/agents/` devem permanecer finos e apontar para `agents/roles/*/agent.md`.

## Configuracao do fork (obrigatoria)

**Leia sempre** `config/ecosystem.config.json` antes de executar agents ou workers.

Valores de organizacao, Project board, repositorios de produto, central de ajuda e e-mails ficam **somente** nesse arquivo (versionado neste fork).

- `config/ecosystem.config.json` — valores reais deste fork
- `config/ecosystem.config.example.json` — modelo
- `config/README.md` — placeholders (`<OWNER>`, `<PROJECT_URL>`, `<HELP_CENTER_URL>`, …) e env
