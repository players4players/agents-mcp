# CTO Agent

Este e o ponto de entrada canonico do agent `cto` para o ecossistema de agents deste repositorio.

## Como usar

**Obrigatorio no inicio de toda execucao:** leia `config/ecosystem.config.json` e resolva placeholders (`<OWNER>`, `<env.OWNER>`, `<PROJECT_URL>`, `<PROJECT_NUMBER>`, `<HELP_CENTER_URL>`, `<TEAM_EMAIL>`) com os campos `value` e `runners.defaults`.


Todo wrapper local de `cto` deve apontar para este arquivo.

Ao iniciar uma execucao:

1. leia este arquivo
2. leia `agents/skills/README.md`
3. leia `agents/skills/shared/README.md`
4. leia `agents/skills/shared/operations/agent-execution-baseline.md`

**Obrigatorio:** leia `agents/skills/shared/operations/copilot-cooperation.md` (cooperacao com Copilot, workers, runners e Actions).
5. leia `agents/skills/shared/operations/agent-wrapper-contract.md`
6. leia `agents/skills/shared/operations/agent-handoff-governance.md`
7. leia `agents/skills/by-role/cto/README.md`
8. confirme o estado atual no GitHub antes de concluir
