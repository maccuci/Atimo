import type { IarCase } from "./score";

/*
 * Gabarito verified by hand against the archive (2026-11-17). Each finding was
 * checked in the extracted files, not taken from a model's answer. Patterns are
 * Portuguese and English because answers come in both.
 */
export const casos: IarCase[] = [
  {
    id: "cadcargo",
    arquivo: "INTEGRACAOCADCARGOFUNCAOADP_01.00.0000 (2).iar",
    pergunta: 'analise essa integração pra mim, e monte um diagrama explicando seu funcionamento @document("INTEGRACAOCADCARGOFUNCAOADP_01.00.0000 (2).iar")',
    achados: [
      {
        id: "gate-variaveis",
        descricao: "O router s0 e o AssignEndVars usam p_integration_date/p_job_code, variáveis globais atribuídas só no fim e que não persistem; os parâmetros do schedule são integrationDate/jobCode. O gate nunca abre e a watermark nunca é salva.",
        peso: 3,
        evidencia: [
          /antes de (qualquer )?atribui|atribu[ií]d[ao]s? (s[oó] )?depois (dele|do (router|roteador))|before (they are|being) assigned/i,
          /outros? message contexts?|other message contexts?/i,
          { near: [/p_integration_date/, /n[aã]o persist|s[oó] vive (nesta|na mesma) inst|does not persist|vari[aá]ve(l|is) globa(l|is)|global variable/i], within: 160 },
          { near: [/(condi[cç][aã]o|router|roteador)/i, /\$?integrationDate/, /\$?jobCode/, /apont|troc|usar|ler de|point/i], within: 160 },
        ],
      },
      {
        id: "resposta-processar",
        descricao: "A resposta do POST /processar (status, message, tarefas) nunca é lida.",
        peso: 2,
        evidencia: [
          { near: [/status|tarefas|returnStatus/i, /n[aã]o (é|são) (lid|consumid|inspecionad)|descartad|ignorad|nada l[eê]|never read|discarded/i], within: 160 },
        ],
      },
      {
        id: "status-final-fixo",
        descricao: "O monitor fecha sempre com 'S' / Processado com Sucesso, mesmo com falha por cargo.",
        peso: 2,
        evidencia: [
          { near: [/Processado com Sucesso|process_status\s*=\s*["'`]?S/i, /mascarad|engolid|mesmo que|independente|incondicional|sem contar|100% de erros|todos os cargos (tenham )?falhad|regardless/i], within: 250 },
        ],
      },
      {
        id: "log-orfao-p",
        descricao: "Sem rota default no s1, relatório vazio deixa o log em 'P' sem fechar.",
        peso: 2,
        evidencia: [
          /(fica|permanece|preso|travad[oa]|[oó]rf[aã]o)[^.\n]{0,40}["“'`]P["”'`]|["“'`]P["”'`][^.\n]{0,50}(indefinidamente|sem nunca|nunca (é )?fechad|nunca virar)|stuck (in|at) ["'`]?P/i,
        ],
      },
      {
        id: "endpoint-teste",
        descricao: "endpointURL do runReport fixo no pod de teste, sem parâmetro da conexão.",
        peso: 2,
        evidencia: [
          { near: [/endpointURL|endpoint/i, /pod de teste|ambiente de teste|test pod|-test-/i, /fixo|literal|hardcod|parametriz/i], within: 250 },
        ],
      },
      {
        id: "csfkey-divergente",
        descricao: "O csfkey do app instance difere do csfkey do JCA.",
        peso: 1,
        evidencia: [{ near: [/csfkey/i, /diverg|diferent|distint|differ/i], within: 200 }],
      },
      {
        id: "policy-divergente",
        descricao: "A conexão declara GENERIC_OAUTH_AUTHORIZATION_CODE e o invoke usa wss_http_token_over_ssl_client_policy.",
        peso: 1,
        evidencia: [{ near: [/GENERIC_OAUTH_AUTHORIZATION_CODE/, /wss_http_token/], within: 400 }],
      },
      {
        id: "monitoramento-ativo",
        descricao: "MonitoramentoAtivo do DVM nunca é lido.",
        peso: 1,
        evidencia: [{ near: [/MonitoramentoAtivo/, /n[aã]o [eé] (usad|lid|consultad)|nunca [eé] lid|morta|n[aã]o referencia|nenhum XSL|never read|unused/i], within: 200 }],
      },
      {
        id: "dvm-dev",
        descricao: "O DVM viaja no IAR com Ambiente = DEV.",
        peso: 1,
        evidencia: [/Ambiente\W{0,6}DEV/],
      },
      {
        id: "logger-sem-cargo",
        descricao: "Os loggers de erro usam $p_job_code, sempre vazio, então a mensagem sai sem o cargo.",
        peso: 1,
        evidencia: [/(processor_312|processor_391|logger|mensage[mn]s? de erro)[^\n]{0,160}p_job_code[^\n]{0,40}vazi/i],
      },
      {
        id: "variaveis-mortas",
        descricao: "etapa, directory e file são atribuídas e nunca usadas.",
        peso: 1,
        evidencia: [{ near: [/\b(etapa|directory)\b/, /nunca (s[aã]o )?(usad|consumid)|n[aã]o (s[aã]o )?(usad|consumid)|resqu[ií]cio|mortas|never used|unused/i], within: 200 }],
      },
      {
        id: "invoke-duplicado",
        descricao: "Dois invokes se chamam Integration5.",
        peso: 1,
        evidencia: [/Integration5/],
      },
      {
        id: "attribute-format",
        descricao: "attributeFormat vai vazio no runReport.",
        peso: 1,
        evidencia: [/attributeFormat/],
      },
    ],
    erros: [
      {
        id: "watermark-persiste",
        descricao: "Afirma que p_integration_date alimenta a próxima execução.",
        evidencia: [{ near: [/p_integration_date|watermark/i, /alimentar[aá] a pr[oó]xima|feeds the next run/i], within: 160 }],
      },
      {
        id: "csfkey-igual",
        descricao: "Afirma que o csfkey é o mesmo no JCA e na conexão.",
        evidencia: [{ near: [/csfkey/i, /mesma chave|mesmo valor|same key/i], within: 160 }],
      },
      {
        id: "csfkey-segredo",
        descricao: "Trata o csfkey (referência ao keystore) como segredo a rotacionar.",
        evidencia: [{ near: [/csfkey/i, /rotacion|rotate/i], within: 200 }],
      },
      {
        id: "layout-agendamento",
        descricao: "Chama layout3.json (posições do canvas) de definição do agendamento.",
        evidencia: [/layout3\.json[^\n]{0,40}defini[cç][aã]o do agendamento/i],
      },
      {
        id: "vazio-sem-log",
        descricao: "Diz que relatório vazio não grava log nenhum (o 'P' já foi gravado).",
        evidencia: [/relat[oó]rio vazio[^.\n]{0,60}(n[aã]o loga nada|termina em sil[eê]ncio)/i],
      },
    ],
  },
  {
    id: "afastamento",
    arquivo: "INTEGRACAOAFASTAMENTOADP_01.00.0000.iar",
    pergunta: 'analise essa integração pra mim, e monte um diagrama explicando seu funcionamento @document("INTEGRACAOAFASTAMENTOADP_01.00.0000.iar")',
    achados: [
      {
        id: "resposta-processar",
        descricao: "A resposta do POST /afastamento (returnStatus, returnMessage) nunca é lida; rejeição com HTTP 200 passa como sucesso.",
        peso: 2,
        evidencia: [
          { near: [/returnStatus|returnMessage|resposta (da ADP|do \/afastamento|do ProcessarAfastamento)/i, /n[aã]o (é|são) (lid|consumid|inspecionad)|descartad|ignorad|nada l[eê]|never read|discarded|nenhum roteador/i], within: 250 },
        ],
      },
      {
        id: "status-final-fixo",
        descricao: "O monitor fecha sempre com 'S' / Processado com Sucesso (literal no processor_207), mesmo com falha por linha.",
        peso: 2,
        evidencia: [
          { near: [/Processado com Sucesso|process_status\s*=\s*["'`]?S/i, /literal|constante|fixo|sempre|independente|incondicional|mascarad|regardless/i], within: 250 },
        ],
      },
      {
        id: "log-orfao-p",
        descricao: "O router s1 não tem rota padrão: relatório vazio deixa o log em 'P' sem fechar.",
        peso: 2,
        evidencia: [
          /(fica|permanece|preso|travad[oa]|[oó]rf[aã]o)[^.\n]{0,40}["“'`]P["”'`]|["“'`]P["”'`][^.\n]{0,50}(indefinidamente|sem nunca|nunca (é )?fechad|nunca virar|sem registro de erro)|stuck (in|at) ["'`]?P|permanentemente em ["“]?Em execu/i,
        ],
      },
      {
        id: "endpoint-teste",
        descricao: "endpointURL do runReport fixo no pod de teste, sem parâmetro da conexão.",
        peso: 2,
        evidencia: [
          { near: [/endpointURL|endpoint/i, /pod de teste|ambiente de teste|test pod|-test-|TESTE/i, /fixo|literal|hardcod|parametriz/i], within: 250 },
        ],
      },
      {
        id: "parametros-bip",
        descricao: "O runReport envia os parâmetros como personNumber/integrationDate, mas o DATA_DS devolve P_PERSON_NUMBER/P_INTEGRATION_DATE: o data model espera nomes p_*, e o relatório pode ignorar os filtros.",
        peso: 2,
        evidencia: [
          { near: [/P_PERSON_NUMBER|P_INTEGRATION_DATE|p_person_number|p_integration_date/, /\bpersonNumber\b|\bintegrationDate\b/, /nome|name|diverg|diferent|n[aã]o (casa|bate|correspond)|ignor|mismatch/i], within: 300 },
        ],
      },
      {
        id: "campos-descartados",
        descricao: "Só personNumber e perAbsenceEntryId vão para a ADP; EH_ALTERACAO, ABSENCE_STATUS_CD e OBJECT_VERSION_NUMBER são descartados.",
        peso: 1,
        evidencia: [/EH_ALTERACAO|ABSENCE_STATUS_CD|OBJECT_VERSION_NUMBER/],
      },
      {
        id: "monitor-log-id",
        descricao: "O MONITOR_LOG_ID devolvido pelo insert do monitor é descartado; o fechamento depende de a API achar o registro por instance_id.",
        peso: 1,
        evidencia: [/MONITOR_LOG_ID/],
      },
      {
        id: "monitoramento-ativo",
        descricao: "MonitoramentoAtivo do DVM nunca é lido.",
        peso: 1,
        evidencia: [{ near: [/MonitoramentoAtivo/, /n[aã]o [eé] (usad|lid|consultad)|nunca [eé] lid|morta|n[aã]o referencia|nenhum XSL|never read|unused/i], within: 200 }],
      },
      {
        id: "dvm-dev",
        descricao: "O DVM viaja no IAR com Ambiente = DEV.",
        peso: 1,
        evidencia: [/Ambiente\W{0,6}DEV/],
      },
      {
        id: "invoke-duplicado",
        descricao: "Dois invokes se chamam Integration5.",
        peso: 1,
        evidencia: [/Integration5/],
      },
    ],
    erros: [
      {
        id: "watermark-negada",
        descricao: "Trata como defeito a watermark correta: integrationDate é parâmetro do schedule e o valor atualizado no fim persiste para a próxima execução.",
        evidencia: [
          /n[aã]o (é|há) (um )?watermark|n[aã]o h[aá] watermark persistid|nada popula essas vari[aá]veis|vari[aá]veis de gatilho n[aã]o t[eê]m mapeamento|no watermark/i,
        ],
      },
      {
        id: "xsl-g1-vazio",
        descricao: "Diz que $currentRow/G_1/... volta vazio; é o caminho que o mapper do OIC gera dentro do for-each.",
        evidencia: [{ near: [/currentRow/, /G_1/, /vazi|n[aã]o casa|empty/i], within: 300 }],
      },
      {
        id: "csfkey-divergente",
        descricao: "Diz que o csfkey diverge; neste archive é o mesmo na conexão e no JCA.",
        evidencia: [{ near: [/csfkey/i, /diverg|diferent|distint|differ/i], within: 200 }],
      },
      {
        id: "csfkey-segredo",
        descricao: "Trata o csfkey (referência ao keystore) como segredo a rotacionar.",
        evidencia: [{ near: [/csfkey/i, /rotacion|rotate|segredo em claro/i], within: 200 }],
      },
      {
        id: "layout-agendamento",
        descricao: "Chama layout3.json (posições do canvas) de definição do agendamento.",
        evidencia: [/layout3\.json[^\n]{0,40}defini[cç][aã]o do agendamento/i],
      },
    ],
  },
];
