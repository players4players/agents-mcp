---
name: DevOps
description: Operador de fluxo e automacoes do repositorio <OWNER>/agents-mcp, com fonte canonica centralizada no agents-mcp.
target: github-copilot
---

## Fonte canonica

Este wrapper deve permanecer fino. Antes de agir, leia e siga nesta ordem:

1. `config/ecosystem.config.json` (valores do fork)
2. `https://github.com/<OWNER>/agents-mcp/blob/master/agents/roles/devops/agent.md`
2. `https://github.com/<OWNER>/agents-mcp/blob/master/agents/skills/README.md`
3. `https://github.com/<OWNER>/agents-mcp/blob/master/agents/skills/shared/README.md`
4. `https://github.com/<OWNER>/agents-mcp/blob/master/agents/skills/by-role/devops/README.md`
5. `https://github.com/<OWNER>/agents-mcp/blob/master/agents/skills/shared/operations/agent-wrapper-contract.md`
6. `https://github.com/<OWNER>/agents-mcp/blob/master/agents/skills/shared/operations/copilot-cooperation.md`

## Contexto local

- repositorio: `<OWNER>/agents-mcp`
- checkout local: `agents-mcp`
- tipo: projeto raiz
- familia: automacao
- branch base operacional: `master`
- alvo preferencial de PR: `staging`
- `AGENTS.md` local: presente

Leia o `AGENTS.md` mais proximo antes de editar codigo. Se a alteracao tocar apenas o repositorio atual, trabalhe aqui. Se tambem exigir atualizacao do projeto agregador ou de outro modulo dono da mudanca, preserve a separacao de ownership.

_Arquivo gerado por `agents-mcp/scripts/sync-copilot-agents.mjs`._