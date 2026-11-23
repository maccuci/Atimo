# Eval de revisão de IAR

Manda um archive OIC para modelos reais do mesmo jeito que o app monta um turno com `@document("….iar")`: o mesmo leitor, a mesma seleção de arquivos, o mesmo inventário de cobertura e a mesma ordem de prompt. Depois pontua cada resposta contra um gabarito de achados verificados à mão no archive (`casos.ts`).

```sh
# 1M de janela: sem --janela o eval não conhece o catálogo ao vivo e manda o IAR parcial
bun evals/iar/run.ts deepseek:deepseek-flash openrouter:baidu/ernie-5.5-flash-preview:free --janela=1000000 --repeticoes=3
bun evals/iar/run.ts deepseek:deepseek-flash --janela=1000000 --effort=high,max --repeticoes=3
bun evals/iar/run.ts deepseek:deepseek-flash --janela=1000000 --seco      # monta o pedido e mostra cobertura, sem chamar
bun evals/iar/run.ts --respostas=a.md,b.md                                 # só pontua respostas salvas
```

- **Fatos estáticos:** desde 2026-11-17 o pedido inclui `staticFacts`, os fatos que `src/lib/oic-analysis.ts` extrai do archive inteiro (variável lida antes de ser atribuída, router sem rota padrão, resposta de invoke não lida, endpoint literal, `csfkey` divergente, chaves de DVM sem uso). Notas anteriores a essa data não são comparáveis com as novas.
- O IAR é dado de cliente. Coloque-o em `evals/iar/archives/` (ignorada pelo Git) ou passe `--iar=caminho`. `resultados/` também é ignorada, porque contém as respostas.
- **Nota:** 0 a 10, a soma dos pesos dos achados encontrados sobre o total, menos 0,5 por erro conhecido. Achados críticos pesam 3, altos e médios 2, baixos 1.
- **Erros conhecidos:** afirmações falsas que os modelos já fizeram sobre este archive. Por exemplo, dizer que `p_integration_date` é uma watermark que persiste, ou que o `csfkey` é igual nos dois arquivos.
- **Casos:** `cadcargo` (padrão) e `afastamento` (`--caso=afastamento`). O AFASTAMENTO é o caso de reserva: uma mudança no harness só conta como melhoria se as duas notas subirem. Ele também pune o falso positivo mais comum, que é tratar como defeito a watermark correta do parâmetro de schedule.
- A pontuação lê palavras, não entendimento. Ela foi calibrada nas respostas de 2026-11-17: no CADCARGO, nas três da rodada às cegas (ERNIE 6.3, DeepSeek 6.8, GLM 1.6); no AFASTAMENTO, nas da 1ª rodada (ERNIE 5.7, DeepSeek 6.0). Nos dois casos a ordem bate com a avaliação manual. Uma nota surpreendente é motivo para ler a resposta, e um padrão que errou deve ser corrigido em `casos.ts`.
- **Repetições:** uma execução é anedota. O resumo mostra a nota média e quantas vezes cada achado foi encontrado por modelo e esforço; use `--repeticoes=3` ou mais para comparar.
- **O que fica de fora:** as skills instaladas e a memória do projeto. O pedido leva só o archive, como uma revisão no app com o isolamento de chats. Para medir uma mudança do harness, rode o mesmo alvo antes e depois.
- **Cache:** a linha de cada execução mostra os tokens em cache informados pelo provedor. Repetições seguidas aquecem o cache, então a taxa daqui não representa uma conversa real.
