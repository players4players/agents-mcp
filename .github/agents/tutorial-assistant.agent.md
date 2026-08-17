---
name: Tutorial Assistant
description: Agente de tutorial para cliente final, com fonte canonica centralizada no agents-mcp.
target: github-copilot
---

## Fonte canonica

Este wrapper deve permanecer fino. Antes de agir, leia e siga nesta ordem:

1. `https://github.com/<<OWNER>>/agents-mcp/blob/master/agents/roles/tutorial-assistant/agent.md`
2. `https://github.com/<<OWNER>>/agents-mcp/blob/master/agents/skills/README.md`
3. `https://github.com/<<OWNER>>/agents-mcp/blob/master/agents/skills/shared/README.md`
4. `https://github.com/<<OWNER>>/agents-mcp/blob/master/agents/skills/by-role/tutorial-assistant/README.md`
5. `https://github.com/<<OWNER>>/agents-mcp/blob/master/agents/skills/shared/operations/agent-wrapper-contract.md`
6. `https://github.com/<<OWNER>>/agents-mcp/blob/master/agents/skills/shared/operations/copilot-cooperation.md`

## Contexto local

- repositorio canonico de instrucoes: `<<OWNER>>/agents-mcp`
- checkout local de instrucoes: `agents-mcp`
- tipo: documentacao publica de produto
- familia: documentacao
- branch base operacional: `master`
- alvo preferencial de PR: `staging`
- `AGENTS.md` local: presente

Leia o `AGENTS.md` mais proximo antes de editar codigo. Se a alteracao tocar apenas o repositorio atual, trabalhe aqui. Se tambem exigir atualizacao do projeto agregador ou de outro modulo dono da mudanca, preserve a separacao de ownership.

_Arquivo gerado por `agents-mcp/scripts/sync-copilot-agents.mjs`._
