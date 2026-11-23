# Oracle Fusion Assistant — MVP

Implementação do PRD 1.0 no Atimo existente. O leitor de documentação usa dom_query, já presente no lockfile como dependência do build Tauri e agora declarado também no runtime.

## Configuração e uso

1. Abra Settings / Connect a provider. Escolha Z.AI, selecione Coding Plan ou General API e conecte a chave correspondente. Cada endpoint tem uma entrada independente no Keychain (`zai-coding` / `zai`). Se a instalação anterior usava Coding Plan, sua chave antiga é migrada na primeira inicialização.
2. No seletor do chat, escolha GLM-5.3 ou outro modelo do provedor conectado. OpenRouter e os provedores CLI existentes continuam disponíveis.
3. Na aba **Pesquisa Oracle** da tela Conexões, ou em Configurações (`⌘,`) → Pesquisa Oracle, selecione Google Gemini ou OpenRouter Web Search e configure sua chave e modelo. O padrão Gemini é `gemini-3.5-flash-lite`, com Google Search e URL Context para permitir leitura das páginas encontradas; o OpenRouter usa o plugin Web Search com Exa, até cinco resultados por chamada. A chave OpenRouter é a mesma da integração existente. Chaves desktop ficam no Keychain; a versão web é somente para desenvolvimento e usa localStorage, conforme a integração existente.
4. Leia e ative a autorização para pesquisa de perguntas públicas. Remova dados confidenciais antes de enviar. O pesquisador recebe a pergunta e até três perguntas recentes da mesma conversa, com referências `@document(...)` etc. omitidas. Não recebe arquivos, anexos, memória ou documentos do projeto. A decisão automática passa pelo modelo principal; seu texto gerado nunca é usado como consulta externa.
5. Configure, se desejar, o orçamento mensal em USD. Selecione um modo no chat:
   - **Sem pesquisa:** somente o modelo principal, com o contexto normal do Atimo. Padrão inicial.
   - **Automático:** o modelo principal decide entre `DIRECT` e `SEARCH`. Pesquisa apenas no segundo caso e depois formula a resposta.
   - **Pesquisa profunda:** pesquisa primeiro; se faltam fontes oficiais, ou o modelo principal considera as evidências insuficientes, faz no máximo uma pesquisa complementar antes da resposta.

Uma falha na primeira pesquisa é mostrada no chat, sem substituir silenciosamente a pesquisa por conhecimento interno. Uma falha apenas na pesquisa complementar mantém as primeiras evidências e exibe a limitação.

## Padrão das respostas

O prompt compartilhado aplica um roteiro de consultoria Oracle a todos os modelos principais e modos de pesquisa. Ele usa a pergunta real, o histórico e o contexto de projeto para identificar propósito, entrega, idioma e informações do ambiente. Release, pilares licenciados, estilo de UI e permissões não fornecidos permanecem desconhecidos; perguntar sobre HCM, por exemplo, não estabelece que o cliente o licencia.

O núcleo contém princípios gerais, com orientações condicionais para SQL, REST/OIC, configuração funcional e Fast Formula/HDL/Extracts. Não inclui nomes e valores de casos anteriores como fatos pré-estabelecidos. A resposta começa pela solução ou conclusão e acompanha a complexidade do pedido. Uma pergunta pontual recebe a chamada/query ou correção, a explicação da condição decisiva e uma verificação se necessária. Não há roteiro obrigatório de seções, inventário repetido de evidências ou explicações sobre verificações omitidas. Português brasileiro é o padrão quando o idioma não está claro; uma preferência explícita do usuário prevalece.

O modelo deve distinguir comportamento documentado, resultado observado em um teste fornecido e hipótese ainda não testada, sem impor rótulos a cada frase. Afirmações materiais apoiadas em documentação devem ter a URL junto ao ponto sustentado. Um teste vale para o ambiente e condições observados; não prova uma regra universal nem uma versão mínima. Uma busca sem resultado ou um trecho parcial não demonstra que um recurso seja incompatível. Metadados de fonte oficial ou acessível não confirmam seu conteúdo. Evidências fornecidas pelo usuário (listas de colunas, linhas fictícias/anonimizadas, erros, payloads, logs e anexos legíveis) prevalecem sobre lembranças genéricas sobre aquele ambiente, sem se tornarem documentação oficial. Pode-se fornecer um bloco `<schema_and_evidence>` diretamente na pergunta; não é obrigatório preencher um formulário.

As verificações técnicas permanecem: validação de identificadores, binds, vigência/cardinalidade e distinção Fusion/EBS. Para SQL, a confirmação exige a página específica de Tables and Views (`oedmh`/`oedmf`); um guia funcional não basta. O código final deve preservar os nomes físicos documentados. Revisões preservam os filtros da população ou explicam a justificativa e o impacto de cada alteração; filtros de vigência, primariedade, última alteração, tipo e idioma são verificados conforme o objeto e o objetivo, sem deduzi-los pelo sufixo da tabela. Configurações funcionais incluem as dependências e a validade dos registros que determinam seu efeito, com mapeamentos validados antes de joins ou decodes.

A pesquisa identifica primeiro a dúvida que decide a solução e procura os pré-requisitos, padrões e exceções relevantes. Para APIs, consulta tanto a operação quanto o framework/sintaxe de consulta, distinguindo versão do recurso, versão do framework e headers. As opções são comparadas por aderência ao pedido, suporte/evidência, custo de execução, implementação e manutenção. Varreduras, exportações e processamento local precisam de uma limitação concreta que justifique abandonar a busca seletiva no servidor.

Uma restrição REST fica limitada à operação verificada. Antes de concluir que o objetivo é impossível ou sugerir outra ferramenta, a pesquisa investiga recursos relacionados; o seletor do acervo também recebe essa orientação. Dúvidas de comportamento que mudam a recomendação exigem FAQs, guias funcionais e notas oficiais pertinentes, além da referência da API. O acervo determinístico continua limitado aos índices HCM/Financials e às notas estáticas existentes: FAQs e outros livros, como Sales, dependem da pesquisa externa habilitada. A seleção de alternativas continua sendo uma decisão do modelo, sem garantia de cobertura completa.

Instruções e preferências explícitas do usuário continuam sendo seguidas. Afirmações recuperadas de documentos, resumos e respostas antigas precisam ser avaliadas antes de justificar uma restrição ou recomendação; o pilar licenciado, sozinho, não prova ausência de um endpoint. Testes fornecidos valem para suas condições e prevalecem sobre inferências anteriores. A skill Solução mínima compara o esforço real para o pedido, sem prioridade universal de carga sobre API. A resposta omite os rótulos internos da metodologia e sugere testes somente para dúvidas que mudam a decisão.

A avaliação de suficiência da pesquisa profunda verifica a dúvida decisiva conforme o assunto. Uma restrição sem apoio ou uma alternativa cara escolhida antes de investigar uma solução direta indica evidência insuficiente; informações desconhecidas sem efeito na solução não exigem complemento. A decisão automática e a avaliação mantêm seus protocolos de uma palavra. Antes da resposta, a revisão interna pergunta se a recomendação resolve o pedido, se alguma conclusão supera sua evidência e se existe opção mais simples ainda por investigar. Não há chamada adicional ao modelo. Essas são instruções ao modelo, não uma garantia determinística de precisão.

## Arquitetura

- `src/lib/research-orchestrator.ts`: `ResearchOrchestrator`, decisão, pesquisa, avaliação de suficiência, cache e preparação da chamada final.
- `src/lib/research-provider.ts`: contrato, normalização de citações e construção das chamadas web.
- `src-tauri/src/research.rs`: chamadas desktop a endpoints fixos, leitura interna das chaves, cancelamento e verificação limitada de links.
- `src/lib/research-settings.ts`: configurações e registro global de consumo, persistidos separadamente dos projetos. Não contém chaves ou perguntas.
- `src/lib/oracle-acervo.ts`: acervo Tables and Views for HCM, descrito abaixo.
- `src/lib/store.ts`: integração no fluxo compartilhado de envio/regeneração e registro de todas as chamadas do modelo principal, inclusive Compare.

As pesquisas ficam no campo `research` das mensagens, preservado pelo armazenamento JSON das linhas SQLite existente e pelo backup JSON. Fontes também aparecem na exportação Markdown e na cópia da resposta. O cache só usa mensagens da mesma conversa; exige a mesma pergunta/contexto público, evidências com fontes e idade inferior a 24h. Resultados anteriores à política de alternativas e FAQs (`evidenceVersion: 3`) são pesquisados novamente, sem apagar o histórico. Pesquisa profunda reutiliza somente outro resultado profundo.

O modelo principal recebe o contexto do projeto como já ocorria antes. Dossiês externos são enviados como dados JSON não confiáveis, acompanhados de instruções explícitas para não obedecer seu conteúdo. Não há execução de SQL, ferramentas Oracle, ferramentas de programação ou chamadas ao Web Search MCP da Z.ai.

## Acervo Tables and Views (HCM)

Antes da resposta final, em todos os modos (inclusive Sem pesquisa), o desktop anexa a lista oficial de colunas, a PK e os índices das tabelas de que a pergunta precisa. A ideia vem do acervo de leis do Watipi: o identificador é consultado, não gerado. Entram as tabelas citadas na pergunta ou no SQL colado, por nome exato, e até três sugeridas pelo modelo principal numa chamada `planning` de esforço baixo. Uma sugestão só vale se o nome existir no índice da Oracle (`oedmh/toc.htm`, ~5.700 tabelas e views), então o modelo pode deixar de indicar uma tabela, mas não inventar uma. A consulta só acontece quando a pergunta tem um identificador com `_` ou termos de SQL/BIP. Com ela, perguntas desse tipo fazem uma chamada a mais ao modelo principal.

Páginas são baixadas pelo Rust (`oracle_doc`), somente `toc.htm` ou `nome-123.html` sob `oedmh`, GET sem chaves, sem seguir redirecionamentos e com limite de 4 MiB. Um redirecionamento significa que o id da página mudou com a release, e a tabela fica de fora. O índice e as páginas ficam em cache durante a sessão; o total anexado é limitado a 60.000 caracteres e quatro tabelas. Um cartão de até 6.000 caracteres vai completo. Nos maiores, só PK, colunas citadas na pergunta e colunas-chave (`_ID`, `_FLAG`, `_TYPE`, `_STATUS`, `_CODE`, datas, números, `EFFECTIVE_*`) mantêm tipo e comentário. O comentário fica inteiro nas colunas que listam valores, como `ASSIGNMENT_TYPE`. As demais colunas, incluindo as de auditoria ("Who column") e as obsoletas, entram só pelo nome, e dos índices ficam apenas os únicos. `PER_ALL_ASSIGNMENTS_M` cai de ~31 mil para ~13 mil caracteres; no caso 6 do eval, a entrada caiu de ~14 mil para ~7,5 mil tokens, e a resposta continuou certa (`'C'`, `EFFECTIVE_LATEST_CHANGE`). O texto vai como dado não confiável, com a URL de cada página. Na versão web não há acervo (CORS).

A docs.oracle.com publica apenas "FA Latest" (`/26c/` e semelhantes redirecionam para a página inicial), então o acervo pode estar numa release mais nova que a do cliente. Em teste com o GLM-5.3, os dois erros de identificador da avaliação manual (`EFFECTIVE_*_DATE` em `PER_EMAIL_ADDRESSES` e a falta de `EFFECTIVE_LATEST_CHANGE` em `PER_ALL_ASSIGNMENTS_M`) desapareceram com os cartões. Ainda não cobre ERP (`oedmf`) nem guias funcionais.

Em perguntas sobre relatórios e segurança (BIP, data model, OTBI, relatório, segurança, data role), também entra a regra de "Business Intelligence Publisher Secured List Views" (Securing HCM): SQL direto na tabela não aplica a segurança de dados; o join com a secured list view aplica os perfis de segurança de quem roda o relatório. Vai junto o mapeamento tabela → view segura, com o privilégio e os papéis. Se a pergunta cita tabelas, só as linhas delas entram, e o cartão da view segura vem logo depois do cartão da tabela. O mapeamento é uma cópia estática da página, feita em 10/11/2026 (`SECURED_VIEWS`), e por isso chega à resposta mesmo sem acesso a docs.oracle.com, inclusive na versão web.

O balão mostra as páginas lidas ("Documentação Oracle lida pelo Atimo"). Depois da resposta, `checkSql` confere os blocos `sql`, sem chamar o modelo: toda referência `alias.coluna` ou `tabela.coluna` cuja tabela esteja no índice precisa existir na página dela. Colunas que a página não lista aparecem como aviso no balão e na exportação Markdown, sem alterar a resposta. Ficam de fora colunas sem qualificador, CTEs, aliases de subquery, tabelas fora do índice HCM (ERP, por exemplo) e views sem lista de colunas, então o aviso pode deixar erros passarem, mas não acusa nomes que não conseguiu verificar. Funciona com qualquer modo, mesmo quando a pergunta não acionou o acervo.

O eval reproduzível fica em [`evals/oracle`](../evals/oracle/README.md).

## Referências e links

### Revisão de IAR e XML

Anexe um `.iar`/`.zip`, ou arquivos `.xml`, `.xsl`, `.xslt`, `.xsd` e `.wsdl`, no chat.
Eles entram no conhecimento do projeto e são referenciados automaticamente no rascunho.
Peça, por exemplo: "Revise os mappings e contratos desta integração; mostre os achados com arquivo e linha".

O leitor abre o arquivo em memória, sem executar conteúdo, gravar seus caminhos no disco,
alterar o IAR ou consultar URLs declaradas dentro do XML. O inventário inclui arquivos
indexados e ignorados, com o motivo. Arquivos textuais de configuração/código comuns do
pacote, como JCA, JS, JSON e properties, também podem ser indexados. Arquivos binários e
pacotes aninhados ficam apenas no inventário.

A decodificação respeita BOM e declarações de encoding XML suportadas pelo `TextDecoder`
da plataforma, incluindo Windows-1252 encontrado nos schemas de um exemplo público da
Oracle ([Parking Lot Pattern, release v1.0](https://github.com/oracle/cloud-asset-integration-oic-parkinglotpattern-sample/releases/tag/v1.0)).
O leitor abriu os 36 arquivos do `SR_ASYNC_PROCESSOR_01.00.0000.iar` desse exemplo; duas
inspeções XML pararam nas declarações DTD dos arquivos de propriedades, com os avisos
registrados. Nenhuma integração foi executada. Bytes inválidos não são substituídos
silenciosamente por caracteres de reposição.

Cada trecho preserva caminho, linhas e colunas do texto decodificado, com fim exclusivo.
O XML é verificado quanto à formação e às referências declaradas em XSD import/include/
redefine/override, XSL import/include e WSDL 1.1 import. Isso não valida instâncias contra
XSD, executa XSLT ou reconstrói todas as dependências e atividades de um fluxo OIC.
Referências com `xml:base` e externas permanecem não verificadas. Dependência não encontrada
significa ausente deste documento/pacote, podendo existir em outro documento ou no tenant.
DTD e entidades declaradas interrompem a inspeção XML; nenhum recurso externo é buscado.

O contexto enviado contém o inventário completo e os achados estáticos, mesmo que só parte
do código caiba. A seleção prioriza o descritor `PROJECT-INF/project.xml`, BPEL, mappings
XSL e contratos; distribui trechos entre os arquivos e reserva espaço para o
relatório dentro de aproximadamente 12 mil tokens por documento referenciado. A resposta
recebe instruções para localizar achados, separar hipóteses de verificações e declarar
limitações. O painel **Arquivos e cobertura**, abaixo da resposta, mostra os arquivos,
intervalos efetivamente incluídos naquele contexto, exclusões e alertas estáticos. Texto
enviado não garante que o modelo inspecionou tudo nem que a integração funciona em execução.
O relatório fica preservado no contexto da mensagem; inventário e localizações também
sobrevivem ao armazenamento e ao backup JSON.

Limites: 20 MiB por arquivo comprimido e por soma dos tamanhos expandidos, até 512 entradas,
2 MiB por arquivo textual, e inventário de até 32 mil caracteres. Arquivos maiores que
2 MiB ficam inventariados sem texto. Caminhos inseguros/duplicados e arquivos truncados são
recusados. A inspeção de dependências tem limite de 256 referências e 2048 caracteres por
destino; ao atingir um limite, registra que a inspeção parou. Há um exemplo fictício com
defeitos conhecidos em `src/tests/fixtures/oic-review`, incluindo um `review.iar` para
anexar manualmente. Não é um export Oracle importável.

Fontes são extraídas somente dos metadados de grounding do Gemini ou das annotations do OpenRouter. URLs mencionadas apenas na prosa gerada pelo pesquisador não viram fontes. As respostas pesquisadas só tornam clicáveis links Markdown presentes nesses metadados. Textos e trechos são renderizados como texto; SQL tem realce e botão de cópia.

`docs.oracle.com` é distinguido das demais fontes pelo hostname exato. No desktop, o aplicativo lê até seis páginas HTML públicas por chamada usando GET sem chaves ou cookies, somente em `docs.oracle.com` e redirecionamentos de citação `vertexaisearch.cloud.google.com`, com cada destino restrito aos mesmos hosts. Cada download tem limite de 1 MiB e timeout de 8s; a etapa de leitura tem limite total de 20s. O parser remove scripts, estilos, navegação e outros elementos sem executá-los, preserva texto/tabelas e seleciona até 18.000 caracteres por fonte conforme a pergunta. Trechos parciais são identificados. O texto extraído acompanha a URL e a citação original até o modelo principal e o histórico, além de poder ser expandido no chat. Uma falha de leitura não descarta a resposta paga do pesquisador nem seus contadores.

A interface distingue página lida pelo Atimo, leitura por URL informada pelo Gemini e link apenas acessível. Uma página lida não confirma automaticamente toda afirmação: o trecho precisa sustentar o ponto específico. Na versão web, sem o leitor nativo devido às restrições CORS, o Gemini pode consultar as páginas usando URL Context; somente status de recuperação bem-sucedido é registrado como leitura pelo provedor. Seu resumo permanece separado do texto original extraído pelo Atimo. Consultas OpenRouter mantêm os trechos/citações do provedor e ganham leitura direta no desktop.

O balão mostra as fontes e os trechos consultados. O widget HTML de sugestões do Google e a lista de consultas não são renderizados; seus metadados continuam disponíveis para histórico e contagem de uso. A CSP Tauri bloqueia frames.

## Consumo e limites

- Cada chamada registra provedor, modelo, finalidade, horário UTC, tokens/consultas quando informados, custo, estimativa e estado, inclusive falhas e cancelamentos.
- Custos reportados pelo provedor prevalecem. Gemini 3.5 Flash-Lite usa a estimativa de US$0,30/M tokens de entrada, US$2,50/M de saída (incluindo raciocínio), contabiliza também os tokens de entrada das ferramentas/URL Context, e usa US$0,014 por consulta informada. Não são descontadas franquias compartilhadas com outros aplicativos. Consultas nos metadados não equivalem necessariamente à quantidade faturada; conferir o painel Google.
- Preços Z.ai e OpenRouter para respostas vêm do catálogo existente; GLM-5.3 usa US$1,40/M entrada e US$4,40/M saída. Coding Plan e CLIs registram USD incremental zero por serem cobertos por assinatura, sem presumir cota ilimitada.
- O mês é UTC. Aos 80%, aparece um alerta. No limite, novas chamadas pagas são bloqueadas. Chamadas cobertas por assinatura ou modelos conhecidos como gratuitos continuam disponíveis.
- Quando o teto de uma chamada de texto é calculável, ele é reservado antes da API, inclusive em painéis concorrentes. Com orçamento ativo, respostas pagas sem teto explícito ficam limitadas a até 8192 tokens de saída. O custo real/estimado reconcilia a reserva depois.
- Buscas internas, modelos sem preço e chamadas multimodais podem não ter teto conhecido. O gasto registrado ainda é verificado antes delas; não há garantia de limite financeiro rígido nesses casos. Valores desconhecidos são mostrados como desconhecidos, nunca como gratuitos. Reservas de chamadas interrompidas sem uso reportado são mantidas conservadoramente.
- Pesquisa: timeout de API de 90s, até 20s adicionais para leitura nativa das páginas, uma repetição somente para 429/502/503/504. Respostas: timeout de 180s, sem repetição automática de streaming, evitando duplicar uma resposta paga. Stop cancela também planejamento e pesquisa complementar.

## Validação

Automatizada: modos, passagem de citações ao modelo principal, avaliação/complemento, cache/expiração/contexto, consentimento, bloqueio de credenciais reconhecíveis, falha de API, cancelamento, orçamento concorrente, virada do mês, chaves independentes, GLM-5.3 com raciocínio obrigatório, contratos Gemini/OpenRouter, links seguros e preservação integral do texto SQL. A suíte existente e o build também devem passar.

O leitor nativo foi testado também contra as páginas públicas de Default Expense Account, PER_ALL_ASSIGNMENTS_M e Mailing Address for Expenses Reimbursement (24B), sem usar API keys. Há regressão automatizada para encaminhar ao modelo as evidências de coluna física, visibilidade da tela, valores e divergência de lookup. A orientação exige confirmar os pontos documentados, manter o mapeamento conflitante separado, não declarar um dicionário obsoleto sem prova e consultar códigos armazenados antes de um decode. Consistência entre o tipo selecionado e um endereço vigente continua sendo uma checagem relevante, mesmo sem erro relatado. Isso valida leitura e transporte de evidências, não a geração da resposta correta por um modelo real.

A aceitação operacional ainda exige chaves e chamadas reais; os testes locais usam respostas simuladas e não demonstram precisão técnica das respostas de um modelo. Eles verificam também a igualdade dos prompts de pesquisa web/desktop, o transporte das instruções, a renovação do cache antigo e a quantidade de chamadas preservada. Para comparar respostas, execute as mesmas perguntas novas com o mesmo modelo, contexto e modo antes/depois, em conversas separadas. Não inclua a solução esperada nem a análise posterior no contexto de entrada. Registre a resposta completa e as fontes efetivamente lidas. Roteiro manual:

| Caso | Pergunta de teste (sem dados reais) | Verificar em profundo / sem pesquisa |
| --- | --- | --- |
| HCM | Como investigar uma Fast Formula de ausência no Oracle HCM 26C usando um exemplo fictício? | Release considerado, fontes oficiais, hipóteses identificadas; nenhuma operação executada. |
| ERP | Como analisar uma rejeição de importação de invoices no Oracle ERP 26C, sem compartilhar dados de clientes? | Procedimento documentado, limitações e links que sustentem os passos. |
| OIC | Como tratar paginação e autenticação ao consultar uma API REST do Fusion a partir do OIC? | Versões relevantes solicitadas, endpoints e parâmetros confirmados em fontes. |
| BI Publisher | Como criar um data model SQL parametrizado no BI Publisher sem expor dados de produção? | SQL copiável, sintaxe destacada, binds/objetos verificados nas fontes. |

Use também casos com evidência parcial e com um teste fornecido que contradiga uma suposição anterior. Avalie cada resposta de 0 a 2 em cada critério (0: falhou; 1: parcial; 2: atendeu):

| Critério | O que deve ser demonstrado |
| --- | --- |
| Correção | A recomendação principal resolve o pedido e os identificadores/condições têm suporte. |
| Pesquisa decisiva | As fontes esclarecem o ponto que muda a solução, incluindo pré-requisitos e exceções relevantes. |
| Calibração | Lacuna não vira proibição; observação local não vira regra universal; hipóteses ficam delimitadas. |
| Escolha da solução | A opção recomendada atende ao objetivo com custo e esforço justificados; alternativas caras têm motivo concreto. |
| Utilidade | A entrega vem primeiro e os detalhes incluídos mudam a ação do usuário. |

Uma recomendação principal incorreta, um identificador inventado ou uma restrição sem evidência reprova o caso, independentemente da soma. Confira a correção com documentação ou teste controlado; o modelo avaliar a própria resposta não substitui essa conferência. Preserve casos antigos de SQL/configuração na comparação para detectar regressões.

Executar também uma pergunta de reescrita em Automático (sem busca), repetir uma pergunta no mesmo contexto (cache), simular quota/credenciais inválidas, cancelar durante cada etapa e reiniciar o app para conferir histórico e consumo. Não há chaves de usuários nem exemplos de clientes neste documento.

## Documentação oficial consultada

- [Gemini 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)
- [Gemini generateContent / grounding metadata](https://ai.google.dev/api/generate-content)
- [Gemini Google Search Grounding](https://ai.google.dev/gemini-api/docs/google-search)
- [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [GLM-5.3 e parâmetros de raciocínio](https://docs.z.ai/guides/llm/glm-5.3)
- [Z.ai pricing](https://docs.z.ai/guides/overview/pricing)
- [OpenRouter Web Search](https://openrouter.ai/docs/guides/features/plugins/web-search)
