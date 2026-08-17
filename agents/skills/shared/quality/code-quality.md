# Code Quality Skill

## Objetivo

Definir a barra comum de qualidade de codigo para `Developer` e `Quality Assurance` no ecossistema deste repositorio.

Esta skill e a fonte oficial para criterios compartilhados de:

- modularizacao
- tamanho de arquivos e componentes
- cobertura de testes
- smoke tests
- reuso de contratos e componentes
- manutencao de mudancas pequenas e rastreaveis

## Regra central

Nenhuma mudanca de codigo deve ser considerada pronta sem cumprir a barra de qualidade desta skill.

Se houver conflito entre um AGENTS local e esta skill para criterios de qualidade compartilhados, esta skill prevalece.

## Critérios obrigatorios

- mudanças devem ser pequenas, isoladas e focadas
- cada componente, classe ou helper deve permanecer pequeno e com responsabilidade unica
- tamanho recomendado de componente/arquivo e abaixo de 200 linhas
- limite absoluto de componente/arquivo e 500 linhas; acima disso, a mudanca deve ser quebrada antes de aprovar
- se a regra de modularizacao puder ser respeitada com divisao simples, a divisao deve acontecer na mesma entrega
- reutilize componentes, stores, helpers e contratos existentes antes de criar duplicatas
- nao replique contrato de tela, store ou API quando a base compartilhada ja existir
- qualquer mudanca visivel em browser exige smoke test
- qualquer mudanca funcional deve ter testes automatizados adequados ao risco
- a ausencia de smoke test bloqueia a aprovacao de UI, fluxo visual ou contrato de navegador
- a ausencia de teste automatizado adequado bloqueia a aprovacao de mudanca funcional
- lint, testes e smoke devem ser executados ou explicitamente bloqueados com justificativa objetiva
- o resultado da validacao deve ser descrito com o escopo real do que foi coberto
- as capturas, prints, screenshots ou artefatos do smoke test devem ser guardados quando forem uteis para o `Documentor` transformar a validacao em documentacao para o cliente
- o `Documentor` deve conseguir reutilizar o material gerado pelo smoke sem depender de interpretacao verbal da entrega

## Uso por papel

- `Developer` usa esta skill antes de encerrar a propria entrega
- `Quality Assurance` usa esta skill antes de aprovar ou devolver a entrega

## Sinais de aprovacao

Uma entrega so avanca quando:

- a base ficou modularizada
- os arquivos e componentes ficaram pequenos o suficiente
- os testes relevantes existem e passam, ou existe bloqueio externo documentado
- os smoke tests existem para fluxos visiveis no browser
- a evidência cobre o comportamento que mudou

## Sinais de rejeicao

Devolva a entrega quando:

- faltar teste apropriado
- faltar smoke test em mudanca de UI
- houver componente ou arquivo grande demais sem quebra aceitavel
- a mudanca duplicar contrato que ja existe em shared/store/component
- a mudanca tornar o codigo mais centralizado, dificil de reaproveitar ou dificil de testar
