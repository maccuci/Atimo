// Oracle eval cases. Fictitious data only. `gabarito` is for manual grading against the rubric in
// docs/oracle-fusion-mvp.md; it never goes to the model.
export interface Caso {
  id: string;
  pergunta: string;
  gabarito: string;
}

export const casos: Caso[] = [
  {
    id: "1-hcm",
    pergunta: "Como investigar uma Fast Formula de ausência no Oracle HCM 26C usando um exemplo fictício?",
    gabarito: "Anexo da fórmula no tipo/plano, compilação, teste isolado e bisseção. Não inventar DBIs nem tipos de fórmula.",
  },
  {
    id: "2-erp",
    pergunta: "Como analisar uma rejeição de importação de invoices no Oracle ERP 26C, sem compartilhar dados de clientes?",
    gabarito: "Log/relatório do job, AP_INVOICES_INTERFACE / AP_INTERFACE_REJECTIONS (PARENT_TABLE + PARENT_ID), agregação por REJECT_CODE.",
  },
  {
    id: "3-oic",
    pergunta: "Como tratar paginação e autenticação ao consultar uma API REST do Fusion a partir do OIC?",
    gabarito: "limit/offset/hasMore com orderBy estável; credencial na conexão. Opções de autenticação só como documentadas.",
  },
  {
    id: "4-bip",
    pergunta: "Como criar um data model SQL parametrizado no BI Publisher sem expor dados de produção?",
    gabarito: "SQL direto em tabela base NÃO aplica data security: usar secured list views (ex.: PER_PERSON_SECURED_LIST_V). Afirmar o contrário reprova.",
  },
  {
    id: "5-partial",
    pergunta: `Quero só o SQL: nome de exibição vigente hoje e e-mail de trabalho de uma pessoa pelo :p_person_number.
<schema_and_evidence>
PER_ALL_PEOPLE_F: PERSON_ID, PERSON_NUMBER, EFFECTIVE_START_DATE, EFFECTIVE_END_DATE
PER_PERSON_NAMES_F: PERSON_ID, NAME_TYPE, DISPLAY_NAME, EFFECTIVE_START_DATE, EFFECTIVE_END_DATE
(não tenho a lista de colunas da tabela de e-mails)
</schema_and_evidence>`,
    gabarito: "PER_EMAIL_ADDRESSES usa DATE_FROM/DATE_TO (não EFFECTIVE_*). EMAIL_TYPE de trabalho não confirmado: validar com SELECT DISTINCT. LEFT JOIN se a pessoa pode não ter e-mail.",
  },
  {
    id: "6-contradiction",
    pergunta: `Meu SQL em PER_ALL_ASSIGNMENTS_M com ASSIGNMENT_TYPE = 'E' e PRIMARY_FLAG = 'Y' retorna 0 linhas para um trabalhador contingente fictício (PERSON_NUMBER 900001), mas ele aparece ativo na tela. Isso prova que trabalhadores contingentes não têm assignment primário no 26A? Como corrijo?`,
    gabarito: "Não prova: contingente é ASSIGNMENT_TYPE = 'C'. Incluir EFFECTIVE_LATEST_CHANGE = 'Y' e a vigência (tabela _M).",
  },
  {
    // Five traps at once and no table named: tests the suggest step (5+ tables) as much as the answer.
    id: "7-report-hard",
    pergunta: "Preciso de um data model BIP: lista de empregados ativos na data :p_data com nome, gestor de linha, salário vigente e data da última contratação (temos recontratados, então não quero a primeira admissão). O usuário que roda só pode ver quem o perfil de segurança dele permite. Quero o SQL.",
    gabarito: [
      "(2) :p_data, não SYSDATE, em toda vigência: EFFECTIVE_* nas _F/_M, DATE_FROM/DATE_TO em CMP_SALARY, DATE_START/ACTUAL_TERMINATION_DATE em PER_PERIODS_OF_SERVICE.",
      "(1) Assignment: ASSIGNMENT_TYPE = 'E', PRIMARY_FLAG = 'Y', EFFECTIVE_LATEST_CHANGE = 'Y' e ASSIGNMENT_STATUS_TYPE = 'ACTIVE'.",
      "(2) Gestor: PER_ASSIGNMENT_SUPERVISORS_F com MANAGER_TYPE = 'LINE_MANAGER' (PRIMARY_FLAG não é 'de linha'), MANAGER_ID -> PERSON_ID do gestor, outer join.",
      "(2) Última contratação: PER_PERIODS_OF_SERVICE.DATE_START pelo PERIOD_OF_SERVICE_ID do assignment; não ORIGINAL_DATE_OF_HIRE nem PER_ALL_PEOPLE_F.START_DATE.",
      "(1) Salário: CMP_SALARY por ASSIGNMENT_ID, SALARY_AMOUNT (ou ANNUAL_SALARY), outer join, aviso de base/frequência.",
      "(1) Secured list views de pessoa, assignment e salário (CMP_SALARY_SECURED_LIST_V); tabela-base não aplica data security.",
      "(1) Nada inventado (colunasInexistentes vazio) e outerJoinIncompleto vazio.",
      "Reprova (máx. 3): dizer que a tabela-base respeita o perfil; SYSDATE no lugar de :p_data; ORIGINAL_DATE_OF_HIRE ou MIN(EFFECTIVE_START_DATE) como última contratação.",
      "Histórico GLM-5.3 (2026-11-10, à mão no app): 5,5/10 com as secured views contando no teto de tabelas; 8/10 depois da correção (erro restante: PRIMARY_FLAG no lugar de MANAGER_TYPE).",
    ].join(" "),
  },
  // OIC cases (2026-11-10). Facts checked on docs.oracle.com: farws (REST API for HCM, op-* pages),
  // the OIC HCM adapter capabilities page and the OIC SOAP adapter page for BIP report services.
  {
    id: "8-oic-workers",
    pergunta: "No OIC, preciso buscar via REST os trabalhadores com o e-mail de trabalho e os assignments vigentes numa data específica, sem vir links e campos que não uso. Como monto a chamada?",
    gabarito: [
      "(2) GET /hcmRestApi/resources/11.13.18.05/workers.",
      "(2) effectiveDate=yyyy-MM-dd para a data de vigência (não filtrar datas no q).",
      "(2) expand dos filhos: emails e workRelationships.assignments (caminhos /child/emails e /child/workRelationships/{PeriodOfServiceId}/child/assignments).",
      "(2) onlyData=true (sem links) e fields para restringir campos; EmailType distingue o e-mail de trabalho (valor exato a confirmar no ambiente).",
      "(1) Paginação limit/offset/hasMore com orderBy estável.",
      "(1) Conexão no OIC (adapter HCM ou REST) com credencial na conexão, nunca no payload.",
      "Reprova: inventar recurso ou parâmetro (checkRest, quando existir), ou mandar ler as tabelas por SQL no lugar da REST.",
    ].join(" "),
  },
  {
    id: "9-oic-pagination",
    pergunta: "Minha integração no OIC chama um GET de uma API REST do Fusion HCM e só volta uma parte dos registros. Como trago todos sem perder nem repetir nenhum?",
    gabarito: [
      "(3) Ler hasMore da resposta e repetir a chamada aumentando offset em limit até hasMore = false (loop While no OIC).",
      "(3) orderBy estável (chave única) em todas as páginas; sem ele, páginas podem repetir ou pular registros.",
      "(2) limit explícito; totalResults=true só dá uma contagem estimada (doc: 'estimated row count'), não serve de condição de parada.",
      "(1) Reduzir volume: q, fields, onlyData=true.",
      "(1) Volume grande ou carga recorrente: considerar HCM Extract ou Atom feeds no adapter HCM em vez de paginar tudo.",
      "Não penaliza citar default/máximo de limit se marcado como a confirmar. Reprova: parar pelo totalResults ou pela contagem de itens sem hasMore.",
    ].join(" "),
  },
  {
    id: "10-oic-hdl",
    pergunta: "Como carrego um arquivo do HCM Data Loader (Worker.dat zipado) a partir de uma integração no OIC e fico sabendo se deu erro em alguma linha?",
    gabarito: [
      "(3) Dois caminhos documentados: operação de HCM Data Loader do adapter HCM do OIC, ou a REST dataLoadDataSets.",
      "(3) Pela REST: action uploadFile (envia ao HDL import account) e depois createFileDataSet com contentId e fileAction IMPORT_AND_LOAD (ou IMPORT_ONLY).",
      "(2) Acompanhar o status do data set (GET dataLoadDataSets/{RequestId}) até terminar, sem assumir sucesso no envio.",
      "(1) Erros por linha: generateFailedLinesFile (data set ou business object) e o relatório do HDL.",
      "(1) Testar em ambiente de teste e manter source keys estáveis.",
      "Reprova: INSERT/UPDATE direto em tabela, ou endpoint inventado.",
    ].join(" "),
  },
  {
    id: "11-oic-bip",
    pergunta: "Preciso que uma integração no OIC rode um relatório BI Publisher do Fusion e use o resultado. Qual o caminho?",
    gabarito: [
      "(4) Adapter SOAP chamando ExternalReportWSSService (xmlpserver/services/ExternalReportWSSService?wsdl), operação runReport, que é síncrona.",
      "(2) Request com o caminho absoluto do relatório (.xdo), parâmetros e formato de saída; o retorno vem em reportBytes (base64) a decodificar.",
      "(2) Usuário de integração com acesso ao relatório; o resultado respeita a data security do usuário que roda (SQL em tabela-base não aplica).",
      "(2) Volume grande ou execução longa: não forçar síncrono; considerar agendamento ou HCM Extract no adapter HCM.",
      "Não penaliza omitir limites de tamanho/tempo se não forem afirmados sem fonte. Reprova: inventar endpoint REST de BIP do Fusion como caminho principal.",
    ].join(" "),
  },
  // Integration gaps (2026-11-10). Facts checked on docs.oracle.com: Oracle's sample Worker.dat
  // (tutorial-hdl-oic-encrypted), faibo (identifiers, View Business Objects), farfa 26d erpintegrations,
  // the OIC ERP adapter FBDI page, farws Employee_Atom_Feeds and the OIC HCM adapter capabilities page.
  {
    id: "12-hdl-dat",
    pergunta: "Preciso corrigir o e-mail de trabalho de 500 pessoas que foram criadas na migração por HDL com source keys. Monta o Worker.dat e me diz o que conferir antes de carregar.",
    gabarito: [
      "(3) Linhas METADATA|PersonEmail|SourceSystemOwner|SourceSystemId|PersonId(SourceSystemId)|DateFrom|EmailType|EmailAddress e MERGE|PersonEmail|... (formato do Worker.dat de exemplo da Oracle).",
      "(2) Atualizar o registro existente: reusar o SourceSystemOwner/SourceSystemId do e-mail criado na migração; um source key novo cria outro registro. Ordem das chaves: GUID, source key, surrogate ID, user key; Oracle recomenda source keys em integrações.",
      "(2) EmailType W1 = trabalho no exemplo oficial; confirmar o código no ambiente.",
      "(2) Atributos e componentes confirmados na tarefa View Business Objects ou no template baixado, a fonte oficial; não inventar atributo.",
      "(1) Testar no ambiente de teste com poucas linhas e conferir o resultado da carga.",
      "Não penaliza: incluir só o componente PersonEmail. Reprova: UPDATE no banco, componente inventado, ou source key novo como forma de atualizar.",
    ].join(" "),
  },
  {
    id: "13-erp-fbdi",
    pergunta: "Preciso importar invoices de fornecedor no Payables a partir de um arquivo que chega no OIC. Como faço a carga e como sei quais linhas foram rejeitadas?",
    gabarito: [
      "(2) FBDI: template Import Payables Invoices, CSVs zipados, que vão para as tabelas de interface do Payables.",
      "(3) No OIC: adapter ERP Cloud, operação Import Bulk Data into Oracle ERP Cloud, com callback por business event numa integração separada; ou REST POST /fscmRestApi/resources/11.13.18.05/erpintegrations com OperationName importBulkData (DocumentContent em base64, FileName, ContentType, JobName 'job,pacote', ParameterList, DocumentAccount, CallbackURL).",
      "(2) Acompanhar o job (callback ou GET erpintegrations?finder=ESSJobExecutionDetailsRF;requestId=...,fileType=ALL); não assumir sucesso no envio.",
      "(2) Rejeições: relatório do Import Payables Invoices e AP_INTERFACE_REJECTIONS ligado a AP_INVOICES_INTERFACE/AP_INVOICE_LINES_INTERFACE por PARENT_TABLE + PARENT_ID.",
      "(1) Testar com arquivo pequeno no ambiente de teste.",
      "Não penaliza: JobName/DocumentAccount exatos se marcados para confirmar. Reprova: INSERT direto na interface pelo banco, ou endpoint inventado.",
    ].join(" "),
  },
  {
    id: "14-atom-newhire",
    pergunta: "Quero que o OIC avise o sistema de crachás toda vez que alguém for contratado no Fusion, incluindo recontratados. Como faço sem ficar varrendo todos os empregados?",
    gabarito: [
      "(3) Atom feed de novas contratações: /hcmRestApi/atomservlet/employee/newhire, pela assinatura de Atom feed do adapter HCM do OIC.",
      "(2) A assinatura de Atom feed no adapter exige integração agendada: não é tempo real.",
      "(2) Cobertura: dispara quando um period of service é criado, numa recontratação e numa contratação futura; as futuras aparecem, por padrão, quando ficam efetivas. Só employee, contingent worker e pending worker.",
      "(2) Evitar duplicar: controlar o que já foi processado e tornar o envio ao destino idempotente.",
      "(1) Se o feed não traz um dado do crachá, buscar na REST workers pelo identificador da entrada.",
      "Reprova: varrer GET /workers inteiro e comparar como solução principal, ou afirmar evento em tempo real sem fonte.",
    ].join(" "),
  },
  // Decision regressions: operation contract (faaps/farws), behavior FAQ (faqpr), and scoped tests.
  // The gabarito never goes to the model. FAQ retrieval must also be evaluated in the app with research on.
  {
    id: "15-resourceusers-person-number",
    pergunta: "Minha integração REST cria pessoas pelo POST resourceUsers. Preciso informar um PersonNumber definido pelo sistema de origem. Posso enviar esse campo? Se esse endpoint não permitir, qual caminho devo investigar para manter a integração por REST?",
    gabarito: [
      "PersonNumber é read-only no POST resourceUsers (docs.oracle.com/en/cloud/saas/sales/faaps/op-resourceusers-post.html); um exemplo com o campo não muda o contrato.",
      "Investigar POST workers, cujo request inclui PersonNumber (docs.oracle.com/en/cloud/saas/human-resources/farws/op-workers-post.html), antes de recomendar HDL. Verificar requisitos, acesso e adequação à criação da pessoa/recurso; não prometer equivalência completa dos endpoints.",
      "Sem teste ou fonte específica, não universalizar o comportamento de workers com geração automática nem inventar como resourceUsers trata o campo recebido.",
      "Reprova: negar a possibilidade em toda a REST a partir de resourceUsers, impor HDL sem investigar workers, ou afirmar indisponibilidade do endpoint apenas pelo pilar licenciado.",
      "Resposta focada; sem degraus, SCIM ou índices de banco que não mudem a decisão. Um teste necessário deve mirar a alternativa e a dúvida decisiva.",
    ].join(" "),
  },
  {
    id: "16-hdl-automatic-person-number",
    pergunta: "Na migração por HDL, preciso preservar os números de pessoa do legado. A geração de Person Number está em Automatic. Preciso mudar para Manual antes da carga?",
    gabarito: [
      "Não precisa mudar para Manual para carregar números legados de novos empregados via HDL. A FAQ oficial confirma isso: https://docs.oracle.com/en/cloud/saas/human-resources/faqpr/can-i-load-legacy-person-numbers-when-the-person-number-generation-method-is-set-to-automatic.html.",
      "Initial Person Number deve ficar pelo menos uma unidade acima do maior número legado para evitar sobreposição futura. Sem número no arquivo, usa a sequência automática.",
      "Não extrapolar a regra de criação para correção de números de pessoas existentes ou para outra API.",
      "Com pesquisa habilitada, buscar/ler a FAQ em vez de deixar a questão em 'depende da configuração'. Sem fonte acessível, explicitar a lacuna sem inventar leitura ou citação.",
    ].join(" "),
  },
  {
    id: "17-rest-observed-access",
    pergunta: "Uma resposta antiga do projeto concluiu que, por termos só ERP, resourceUsers não estaria provisionada. No DEV, fizemos GET resourceUsers com HTTP 200 e POST workers com HTTP 201; o PersonNumber enviado foi preservado, mesmo com geração automática. O que esses testes permitem concluir para essa integração?",
    gabarito: [
      "Corrigir a inferência antiga sobre ausência de acesso. Tratar os resultados como observações no DEV, com as credenciais, payload e configuração testados; só ERP não estabelece indisponibilidade do endpoint.",
      "O teste workers sustenta o uso do número informado nessas condições, sem provar regra universal, acesso em produção, licença HCM ou versão mínima.",
      "Se restar validação para adoção, focar as condições ainda não cobertas, sem pedir para repetir o teste já informado ou trocar para HDL sem motivo.",
      "Reprova: insistir na ausência de resourceUsers, descartar os testes pelo resumo antigo, ou generalizar sucesso para todos os ambientes.",
    ].join(" "),
  },
  {
    id: "18-existing-hdl-load",
    pergunta: "Temos uma carga HDL de Worker.dat já validada no DEV e source keys estáveis. É uma migração única de 50 mil pessoas, sem necessidade de resposta síncrona. Vale reescrever tudo para chamadas REST só para usar API?",
    gabarito: [
      "Manter a carga HDL existente se ela atende ao requisito, com validação, acompanhamento de erros e reconciliação. A migração única e a solução já testada não justificam reescrever para REST apenas por preferência técnica.",
      "Comparar esforço real, volume e operação; não usar uma ordem universal HDL antes de API ou API antes de HDL.",
      "Reprova: impor workers sem necessidade, descrever degraus internos ou inventar limitações da REST para justificar a decisão.",
    ].join(" "),
  },
];
