# Eval Oracle

Roda o pipeline do app (`ResearchOrchestrator` em Sem pesquisa, acervo Tables and Views, prompt Oracle) contra modelos reais. Grava cada resposta em `resultados/`. Os casos e o gabarito estão em `casos.ts`, com dados fictícios. A nota é manual e segue a rubrica de 0 a 2 de [`docs/oracle-fusion-mvp.md`](../../docs/oracle-fusion-mvp.md#validação). O único item automático é `colunasInexistentes`: colunas usadas no SQL da resposta que a página Tables and Views da tabela não lista (`checkSql`), verificado com ou sem acervo. `regrasOracle` lista as regras de `checkSqlRules` que a resposta final quebra (ex.: `PER_ASSIGNMENT_SUPERVISORS_F` sem `MANAGER_TYPE`). Quando algum checador aponta problema, o pipeline pede uma revisão ao modelo, uma única vez; `revisado: true` marca essas respostas, e os campos automáticos se referem à versão revisada. No modo de pesquisa profunda, respostas com afirmação restritiva ("não permite", "read-only", "não cria"…) passam antes por uma chamada de verificação (`planning`): ela confere essas afirmações e os fatos que o usuário informou contra as evidências, e o que ela apontar entra na mesma revisão. Com `--sem-revisao`, o pipeline pula a verificação e a revisão (linha de base para A/B). O JSON guarda `verificacao` (a resposta da verificação) e, nas respostas revisadas, o `rascunho` anterior.

```sh
# alvos: zai:<modelo> (General API), zai-coding:<modelo> (Coding Plan), openrouter:<vendor/modelo>, deepseek:<modelo> (API oficial)
bun evals/oracle/run.ts zai:glm-5.3 openrouter:anthropic/claude-opus-5 --acervo=both
bun evals/oracle/run.ts zai:glm-5.3 --casos=5-partial,6-contradiction
```

- `--acervo=on` (padrão, como no app), `off` ou `both`.
- `--effort=auto,low` (padrão `auto` no pipeline; o esforço original no replay) muda o esforço só da resposta; vários valores rodam lado a lado.
- `--repeticoes=N` roda cada caso N vezes. O mesmo modelo dá respostas diferentes ao mesmo caso, e uma execução só é anedota; para comparar modelos ou mudanças, use pelo menos 3. No final, um resumo conta, por grupo, as respostas sem coluna inexistente. A correção continua sendo avaliada à mão.
- `tabelas` registra o que foi anexado; `SECURED_LIST_VIEWS` indica a regra das views seguras.
- Chaves: `ZAI_API_KEY`, `ZAI_CODING_API_KEY`, `OPENROUTER_API_KEY` ou a entrada do app no Keychain (o macOS pode pedir permissão).
- O Coding Plan da Z.AI só pode ser usado nas ferramentas listadas pela Z.AI, e o Atimo não está entre elas. Use `zai-coding:` só na sua própria conta, sabendo do risco.
- As chamadas são sequenciais, porque chamadas simultâneas levam 429. Um 429 tem até 3 novas tentativas.
- Não há pesquisa web nem execução de SQL. Para comparar respostas, use o mesmo alvo e os mesmos casos antes e depois da mudança.

Os casos `15-resourceusers-person-number`, `16-hdl-automatic-person-number`, `17-rest-observed-access` e `18-existing-hdl-load` cobrem alternativas REST, FAQs, evidência de acesso e a preservação de uma carga existente. O gabarito fica fora da entrada do modelo. O runner inclui a busca local nos livros do HCM (os Questions and Answers faqpr, fahcc, fajqa, falqa e faeqa; Implementing Global Human Resources, faigh; HDL Business Objects, faibo; e o guia HCM Data Loader, fahdl), como o app, mas sem o e5: aqui a escolha das páginas é só por palavras, então perguntas em português sem termos em inglês podem não achar a página. Ele não injeta as skills instaladas nem faz pesquisa web; para avaliar esses comportamentos, repita os casos no app com Solução mínima ativa e Pesquisa profunda, em conversas novas, registrando a resposta e as fontes efetivamente lidas. O transporte das instruções e a renovação do cache são verificados nos testes locais; isso não comprova a qualidade das respostas reais.

## Juiz automático

`--juiz=<alvo>` dá nota a cada resposta contra o gabarito do caso depois da rodada; `bun evals/oracle/judge.ts <alvo> resultados/arquivo.json` faz o mesmo num arquivo já gravado. O veredito vai em `juiz` (nota 0 a 10, `reprova` e a justificativa) e o relatório mostra a média por grupo. `respostaCompleta` e `solucaoCorreta` continuam sendo da revisão humana. Use um juiz de outro fornecedor que o avaliado (o runner avisa quando não é) e confira uma amostra à mão: conflitos de conhecimento também enviesam o modelo que julga.

## Repetir as mensagens reais do app

No console do app em desenvolvimento (`bun run dev` ou Tauri dev):

```js
const capture = await import('/src/lib/eval-capture.ts');
capture.startCapture();
// Envie as perguntas pelo app, com as skills, pesquisa e documentos desejados.
await capture.saveCapture();
```

A captura é opt-in, fica somente em memória até salvar e registra apenas chamadas finais por API, depois do limite de orçamento. Contém mensagens completas, inclusive anexos, histórico, skills e evidências recuperadas; não contém as chaves de conexão. Aguarde as respostas terminarem antes de salvar: `observedCalls` inclui os tokens, cache, custo estimado ou informado e motivo de término dessas chamadas. Salvar encerra a gravação. CLIs não são capturadas, pois elas montam suas próprias requisições. Use dados fictícios: a captura e os resultados de replay contêm o contexto do projeto. Guarde capturas em `evals/oracle/captures/`, ignorada pelo Git; resultados com `-capture-` no nome também são ignorados.

```sh
bun evals/oracle/run.ts deepseek:deepseek-flash --capture=evals/oracle/captures/casos.json --effort=low,high,max --repeticoes=3
```

O replay mantém as mensagens e as demais configurações capturadas, variando apenas modelo e esforço. Sem `--effort`, mantém o esforço capturado. Não executa novamente pesquisa, skills ou busca vetorial. `--casos` seleciona IDs das requisições capturadas; `--acervo` não se aplica. A validação estática de SQL/REST/HDL continua sendo feita depois da resposta, como no modo original. A latência do replay mede a chamada final, incluindo novas tentativas, e exclui essa validação posterior; a do pipeline original inclui a preparação. O JSON de resultados inclui a requisição reenviada para conferência.

`finishReason` e `terminouNormalmente` registram o término do protocolo. Respostas vazias ou cortadas não passam na métrica automática. Um término normal não comprova que a solução está completa ou correta: revise `respostaCompleta` e `solucaoCorreta` no JSON, preenchendo `true` ou `false` contra a pergunta, as evidências e o gabarito. `null` significa revisão pendente, nunca aprovação. Depois de revisar, recalcule o relatório sem chamar modelos:

```sh
bun evals/oracle/report.ts evals/oracle/resultados/arquivo.json
```

## Medir cache antes de reorganizar o contexto

Navegador e Rust leem `usage.prompt_tokens_details.cached_tokens`, com fallback para `prompt_cache_hit_tokens` do DeepSeek. O contador chega ao log persistido em `cachedInputTokens`: `0` é um miss medido; ausente ou `null` é desconhecido. O relatório de replay mostra a taxa ponderada pelos tokens de entrada apenas das chamadas medidas e a cobertura dessa medição. Repetições idênticas aquecem o cache; a taxa de replay não representa automaticamente a de conversas reais. Para observar o app:

```js
const { monthlyUsage, useResearchSettings } = await import('/src/lib/research-settings.ts');
monthlyUsage(useResearchSettings.getState().calls.filter(c => c.provider === 'deepseek' && c.purpose === 'answer')).cache;
```

Verificação do prefixo atual: as instruções do projeto são lidas do mesmo texto, e o catálogo mantém a ordem do registro de skills. Ambos permanecem estáveis enquanto as configurações não mudam; os testes de composição cobrem isso. Skills em `always` também mantêm a ordem. Skills em `auto` podem entrar/sair ou trocar de ordem por pontuação da pergunta (`armSkills` e o otimizador do composer). Desde 2026-11-17, os trechos recuperados, as skills ativadas no turno e os chats vão na última mensagem do usuário, sob "Context retrieved for this message". A mensagem de sistema leva só o que se repete entre turnos (preâmbulo, instruções, catálogo de skills e o IAR mencionado), então o histórico também entra no prefixo em cache. O rodapé de cada resposta mostra a porcentagem em cache.

Referência histórica disponível em `resultados/` em 2026-11-15: 63 chamadas finais ao `deepseek-flash`, todas com contadores de cache, somam 428.821 tokens de entrada e 294.774 em cache (68,7%). As 63 chamadas de planejamento somam 10.911 tokens, sem hits. São avaliações antigas com repetições e outra cobertura de contexto, não uma medição de conversas reais nem um teste causal da posição dos trechos.
