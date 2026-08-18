// ==================== WORKER CLOUDFLARE: LER CONTRACHEQUE ====================
// Aceita um PDF de contracheque (demonstrativo de pagamento) em base64 e
// devolve os dados extraídos em JSON: cabeçalho (mês, salário, totais) e
// cada linha de rubrica (código, descrição, tipo provento/desconto,
// quantidade, valor).
//
// ESTRATÉGIA DE PROVEDOR: tenta Gemini primeiro (grátis), e só usa a
// Anthropic (paga) se o Gemini falhar (erro, indisponibilidade, resposta
// inválida) — mesmo padrão já usado no worker do Banca Pro.
//
// As chaves de API NUNCA ficam no navegador — vivem só aqui, no servidor,
// lidas das variáveis de ambiente configuradas no painel do Cloudflare
// (Workers & Pages → contracheque → Settings → Variables and Secrets):
//   GEMINI_API_KEY      (Secret)
//   ANTHROPIC_API_KEY   (Secret)
//   SUPABASE_URL        (ex: https://zlclakzjktpsbpfkltxa.supabase.co)
//   SUPABASE_ANON_KEY   (a chave publishable, a mesma usada no index.html)
//
// A extração é intencionalmente GENÉRICA — não conhece nada específico da
// GKN ou de qualquer empresa. Ela só lê o layout comum a qualquer
// demonstrativo de pagamento brasileiro (colunas Proventos/Descontos,
// código de rubrica, quantidade). Quem decide o que cada código SIGNIFICA
// (a categoria genérica) é o catálogo de rubricas do usuário, no app —
// não a IA.
//
// Este arquivo é o "main" do Worker (ver wrangler.jsonc). Ele intercepta
// apenas a rota /api/ler-contracheque; qualquer outra URL é entregue
// normalmente pelos arquivos estáticos do site (binding "ASSETS").

const SCHEMA_JSON = `
{
  "mesReferencia": "string no formato AAAA-MM (mês de referência do contracheque, campo 'Ref.') ou null",
  "dataPagamento": "string no formato AAAA-MM-DD (campo 'Dt.Pagto.') ou null",
  "salario": "number ou null — o valor do campo 'Salário' do cabeçalho (salário-base contratual impresso no documento)",
  "totalProventos": "number — o total de proventos impresso na linha 'Total' do rodapé",
  "totalDescontos": "number — o total de descontos impresso na linha 'Total' do rodapé",
  "pagamentoLiquido": "number — o valor de 'Pagamento Líquido' impresso no rodapé",
  "itens": [
    {
      "codigo": "string ou null — o código da rubrica exatamente como impresso (ex: '10Z3', '/325', 'M389'), null se a linha não tiver código",
      "descricao": "string — a descrição da rubrica como impressa",
      "tipo": "'provento' ou 'desconto' — conforme a coluna em que o valor aparece",
      "quantidade": "number ou null — o número da coluna 'Quant.' quando existir (pode ser negativo)",
      "valor": "number — o valor da linha (positivo ou negativo conforme impresso; a coluna já indica provento/desconto, o sinal aqui é só para valores negativos explícitos)"
    }
  ]
}`;

const PROMPT_CONTRACHEQUE = `Você é um assistente que extrai dados estruturados de um contracheque (demonstrativo de pagamento / holerite) brasileiro, a partir do PDF anexado.

O documento tem duas colunas principais na tabela central: "Proventos" (valores que somam ao pagamento) e "Descontos" (valores que subtraem). Cada linha do corpo da tabela tem um código de rubrica, uma descrição, opcionalmente uma competência retroativa ("Retro"), opcionalmente uma quantidade (coluna "Quant."), e um valor em uma das duas colunas.

Extraia:
- mesReferencia: o mês/ano de referência do contracheque (campo "Ref."), no formato "AAAA-MM". Se esse campo não existir claramente, infira pela "Dt.Pagto.".
- dataPagamento: a data de pagamento ("Dt.Pagto."), no formato "AAAA-MM-DD".
- salario: o valor do campo "Salário" no cabeçalho (o salário-base contratual, geralmente perto de "Banco/Agência/Conta"). Null se esse campo não aparecer no documento.
- totalProventos, totalDescontos, pagamentoLiquido: os valores impressos no rodapé do documento (linha "Total" e campo "Pagamento Líquido").
- itens: uma lista com TODAS as linhas do corpo da tabela (entre o cabeçalho de colunas e a linha "Total"), sem pular nenhuma, cada uma com codigo, descricao, tipo, quantidade e valor.

Regras importantes:
- Se a mesma rubrica aparecer mais de uma vez com anotações diferentes de competência retroativa (ex: "05/2024", "06/2024" na coluna "Retro"), trate cada ocorrência como um item SEPARADO da lista, incluindo a competência retroativa na descrição entre parênteses (ex: "Salário (retroativo 05/2024)").
- Números no padrão brasileiro usam vírgula como separador decimal e ponto como separador de milhar (ex: "1.784,43" = 1784.43) — sempre converta para o padrão internacional (ponto decimal) no JSON, sem separador de milhar.
- Um sinal de menos à DIREITA de um número no documento brasileiro (ex: "155,53-") indica que o valor é negativo — registre "valor" (e "quantidade", se também tiver o sinal) como número negativo nesse caso.
- Não invente itens que não estão no documento, e não pule nenhuma linha, mesmo que pareça redundante ou de valor pequeno.
- Esse formato de contracheque pode variar bastante entre empresas diferentes — leia o layout do documento em si, não assuma nomes de rubrica específicos de nenhuma empresa em particular.
- Responda APENAS com o JSON puro, sem texto antes ou depois, sem markdown, sem crases.

Formato de saída:
${SCHEMA_JSON}`;

// ---- Checagem de acesso à IA: valida o token do usuário e confere ai_enabled ----
async function checarAcessoIA(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '');

  if (!accessToken) {
    return { ok: false, status: 401, message: 'Sessão não encontrada. Faça login novamente.' };
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return { ok: false, status: 500, message: 'Configuração do Supabase ausente no servidor (SUPABASE_URL / SUPABASE_ANON_KEY).' };
  }

  const userResp = await fetch(env.SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + accessToken }
  });
  if (!userResp.ok) {
    return { ok: false, status: 401, message: 'Sessão inválida ou expirada. Faça login novamente.' };
  }
  const userData = await userResp.json();

  const profileResp = await fetch(
    env.SUPABASE_URL + '/rest/v1/profiles_modulos?user_id=eq.' + userData.id + '&modulo=eq.contracheque&select=ai_enabled',
    { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + accessToken } }
  );
  if (!profileResp.ok) {
    return { ok: false, status: 500, message: 'Não foi possível checar sua permissão de uso da IA.' };
  }
  const rows = await profileResp.json();
  if (!rows.length || rows[0].ai_enabled !== true) {
    return { ok: false, status: 403, message: 'O acesso às funcionalidades de IA está desativado para este usuário no módulo Contracheque.' };
  }

  return { ok: true };
}

// ---- Checagem de acesso a documentos: valida o token do usuário e confere documents_enabled ----
async function checarAcessoDocumentos(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '');

  if (!accessToken) {
    return { ok: false, status: 401, message: 'Sessão não encontrada. Faça login novamente.' };
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return { ok: false, status: 500, message: 'Configuração do Supabase ausente no servidor (SUPABASE_URL / SUPABASE_ANON_KEY).' };
  }

  const userResp = await fetch(env.SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + accessToken }
  });
  if (!userResp.ok) {
    return { ok: false, status: 401, message: 'Sessão inválida ou expirada. Faça login novamente.' };
  }
  const userData = await userResp.json();

  const profileResp = await fetch(
    env.SUPABASE_URL + '/rest/v1/profiles_modulos?user_id=eq.' + userData.id + '&modulo=eq.contracheque&select=documents_enabled',
    { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + accessToken } }
  );
  if (!profileResp.ok) {
    return { ok: false, status: 500, message: 'Não foi possível checar sua permissão de armazenamento de documentos.' };
  }
  const rows = await profileResp.json();
  if (!rows.length || rows[0].documents_enabled !== true) {
    return { ok: false, status: 403, message: 'O acesso ao armazenamento de documentos está desativado para este usuário no módulo Contracheque.' };
  }

  return { ok: true };
}

async function handleChecarAcessoDocumentos(request, env) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Método não permitido.' }), { status: 405, headers });
  }

  let acesso;
  try {
    acesso = await checarAcessoDocumentos(request, env);
  } catch (erro) {
    return new Response(JSON.stringify({ error: 'Erro ao checar permissão: ' + erro.message }), { status: 500, headers });
  }
  if (!acesso.ok) {
    return new Response(JSON.stringify({ error: acesso.message }), { status: acesso.status, headers });
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

async function handleIncrementarAICalls(request, env) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Método não permitido.' }), { status: 405, headers });
  }

  const authHeader = request.headers.get('Authorization') || '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '');

  if (!accessToken) {
    return new Response(JSON.stringify({ error: 'Sessão não encontrada.' }), { status: 401, headers });
  }

  // Incrementa o contador de IA via SQL function security definer, que usa
  // auth.uid() internamente (resolvido a partir do token do próprio usuário
  // — não precisamos buscar o user_id à parte). Mesmo padrão do
  // financeiro_increment_ai_calls / banca_increment_ai_calls.
  const incrResp = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/contracheque_increment_ai_calls', {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    },
    body: '{}'
  });

  if (!incrResp.ok) {
    const detalhe = await incrResp.text();
    return new Response(JSON.stringify({ error: 'Erro ao contar uso de IA: ' + detalhe }), { status: 500, headers });
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

async function handleIncrementarStorage(request, env) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Método não permitido.' }), { status: 405, headers });
  }

  const authHeader = request.headers.get('Authorization') || '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '');

  if (!accessToken) {
    return new Response(JSON.stringify({ error: 'Sessão não encontrada.' }), { status: 401, headers });
  }

  const userResp = await fetch(env.SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + accessToken }
  });
  if (!userResp.ok) {
    return new Response(JSON.stringify({ error: 'Sessão inválida.' }), { status: 401, headers });
  }

  // O contador de armazenamento é calculado automaticamente pelos contadores de storage do Supabase
  // Esta rota é mais para futuro se precisarmos de lógica customizada
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

// ==================== BUSCA AUTOMÁTICA DE TABELA OFICIAL (INSS/IRRF) ====================
// Usa a Anthropic com a ferramenta de busca na web para localizar a tabela
// progressiva vigente numa competência informada, direto de fontes oficiais
// (INSS/Receita Federal/legislação). SEMPRE retorna para revisão manual do
// usuário antes de ser salva — nunca grava direto no banco.
const PROMPT_BUSCA_TABELA = `Você é um assistente que localiza tabelas oficiais brasileiras de contribuição progressiva (INSS ou IRRF) usando busca na web.

Você receberá o tipo de tabela ("INSS" ou "IRRF") e uma competência de referência (mês/ano) para a qual a tabela precisa estar vigente. Use a ferramenta de busca na web para encontrar, em fontes oficiais (gov.br, INSS, Receita Federal, Planalto, ou notícias confiáveis que citem a norma oficial), a tabela progressiva vigente nessa competência.

Depois de pesquisar, responda com APENAS um objeto JSON (sem markdown, sem crases, sem texto antes ou depois), no formato:

{
  "tipo": "INSS" ou "IRRF",
  "vigencia_inicio": "AAAA-MM-DD (primeiro dia de vigência da tabela encontrada)",
  "fonte": "nome curto da norma oficial (ex.: 'Portaria Interministerial MPS/MF nº 13/2026', 'Lei 15.191/2025')",
  "faixas": [
    { "faixa_ordem": 1, "valor_de": 0, "valor_ate": número ou null, "aliquota": número (percentual, ex.: 7.5), "parcela_deduzir": número }
  ]
}

Regras importantes:
- "faixas" deve conter TODAS as faixas da tabela progressiva, em ordem crescente, com "faixa_ordem" começando em 1.
- A última faixa (alíquota máxima) deve ter "valor_ate": null (sem teto).
- "valor_de" de cada faixa deve ser exatamente 0.01 acima do "valor_ate" da faixa anterior (sem sobreposição nem lacuna), exceto a primeira faixa que começa em 0.
- Para IRRF, use a tabela de desconto progressivo mensal (não a anual), e "parcela_deduzir" é o valor a deduzir do imposto calculado, não da base.
- Se a busca não encontrar dados confiáveis o suficiente para a competência exata pedida, use a tabela oficial vigente mais recente que você encontrar e explique isso no campo "fonte" (ex.: "Tabela vigente desde jan/2026 — não localizada tabela mais recente para a competência pedida").
- Nunca invente valores — se não conseguir confirmar um número em nenhuma fonte, é melhor retornar uma lista de faixas menor com os dados que você tem certeza, para o usuário completar manualmente.
- Responda SOMENTE com o JSON, nada mais, nada de comentário sobre o processo de busca.`;

async function handleBuscarTabelaOficial(request, env) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Método não permitido.' }), { status: 405, headers });
  }

  let acesso;
  try {
    acesso = await checarAcessoIA(request, env);
  } catch (erroChecagem) {
    return new Response(
      JSON.stringify({ error: 'Erro ao checar permissão de IA: ' + erroChecagem.message }),
      { status: 500, headers }
    );
  }
  if (!acesso.ok) {
    return new Response(JSON.stringify({ error: acesso.message }), { status: acesso.status, headers });
  }

  let payload;
  try { payload = await request.json(); }
  catch (e) { return new Response(JSON.stringify({ error: 'Corpo da requisição inválido.' }), { status: 400, headers }); }

  const { tipo, competenciaReferencia } = payload || {};
  if (!tipo || !['INSS', 'IRRF'].includes(tipo)) {
    return new Response(JSON.stringify({ error: 'Informe "tipo" como "INSS" ou "IRRF".' }), { status: 400, headers });
  }
  if (!competenciaReferencia) {
    return new Response(JSON.stringify({ error: 'Informe "competenciaReferencia" (AAAA-MM).' }), { status: 400, headers });
  }

  if (!env.ANTHROPIC_API_KEY) {
    return new Response(
      JSON.stringify({ error: 'ANTHROPIC_API_KEY não configurada neste Worker — necessária para a busca automática com IA.' }),
      { status: 500, headers }
    );
  }

  try {
    const resultado = await buscarTabelaComAnthropic({ apiKey: env.ANTHROPIC_API_KEY, tipo, competenciaReferencia });
    return new Response(JSON.stringify({ ...resultado, _provedor: 'anthropic-web-search' }), { status: 200, headers });
  } catch (erro) {
    return new Response(
      JSON.stringify({ error: 'Não foi possível buscar a tabela automaticamente: ' + erro.message }),
      { status: 502, headers }
    );
  }
}

async function buscarTabelaComAnthropic({ apiKey, tipo, competenciaReferencia }) {
  const mensagemUsuario = `Tipo de tabela: ${tipo}\nCompetência de referência: ${competenciaReferencia}\n\nBusque a tabela oficial vigente nessa competência e responda no formato JSON indicado.`;

  const corpoRequisicao = {
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    system: [{ type: 'text', text: PROMPT_BUSCA_TABELA }],
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: mensagemUsuario }],
  };

  const resposta = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(corpoRequisicao),
  });

  if (!resposta.ok) {
    const textoErro = await resposta.text();
    throw new Error(`Anthropic retornou ${resposta.status}: ${textoErro}`);
  }

  const dados = await resposta.json();
  const blocosTexto = (dados.content || []).filter((b) => b.type === 'text');
  const blocoTexto = blocosTexto[blocosTexto.length - 1];
  if (!blocoTexto) {
    throw new Error('A IA não retornou uma resposta em texto (possivelmente ficou presa em chamadas de busca).');
  }

  const extraido = parsearJSON(blocoTexto.text);
  if (!extraido || !Array.isArray(extraido.faixas) || extraido.faixas.length === 0) {
    throw new Error('A resposta da IA não trouxe faixas utilizáveis. Tente novamente ou cadastre manualmente.');
  }
  return extraido;
}

// ==================== BUSCA AUTOMÁTICA DO SALÁRIO MÍNIMO NACIONAL ====================
// Mesmo padrão da busca de tabela de INSS/IRRF: usa IA com busca na web,
// SEMPRE retorna para revisão manual do usuário antes de ser salvo — nunca
// grava direto no banco. O salário mínimo impacta diretamente o cálculo de
// insalubridade (20% do salário mínimo vigente, não do salário-base).
const PROMPT_BUSCA_SALARIO_MINIMO = `Você é um assistente que localiza o valor oficial do salário mínimo nacional (federal) do Brasil usando busca na web.

Você receberá uma competência de referência (mês/ano) para a qual o valor precisa estar vigente. Use a ferramenta de busca na web para encontrar, em fontes oficiais (gov.br, Planalto, Ministério do Trabalho, ou notícias confiáveis que citem o decreto/lei oficial), o valor do salário mínimo nacional vigente nessa competência.

Depois de pesquisar, responda com APENAS um objeto JSON (sem markdown, sem crases, sem texto antes ou depois), no formato:

{
  "valor": número (valor do salário mínimo em reais, ex.: 1621.00),
  "vigencia_inicio": "AAAA-MM-DD (data em que este valor passou a vigorar, geralmente 1º de janeiro do ano correspondente)",
  "fonte": "nome curto da norma oficial (ex.: 'Decreto nº 12.342/2025')"
}

Regras importantes:
- Retorne o salário mínimo NACIONAL (federal), não pisos estaduais/regionais.
- Se a busca não encontrar dados confiáveis para a competência exata pedida, use o valor oficial vigente mais recente que você encontrar e explique isso no campo "fonte".
- Nunca invente o valor — se não conseguir confirmar em nenhuma fonte, responda com "valor": null para o usuário preencher manualmente.
- Responda SOMENTE com o JSON, nada mais.`;

async function handleBuscarSalarioMinimo(request, env) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Método não permitido.' }), { status: 405, headers });
  }

  let acesso;
  try {
    acesso = await checarAcessoIA(request, env);
  } catch (erroChecagem) {
    return new Response(
      JSON.stringify({ error: 'Erro ao checar permissão de IA: ' + erroChecagem.message }),
      { status: 500, headers }
    );
  }
  if (!acesso.ok) {
    return new Response(JSON.stringify({ error: acesso.message }), { status: acesso.status, headers });
  }

  let payload;
  try { payload = await request.json(); }
  catch (e) { return new Response(JSON.stringify({ error: 'Corpo da requisição inválido.' }), { status: 400, headers }); }

  const { competenciaReferencia } = payload || {};
  if (!competenciaReferencia) {
    return new Response(JSON.stringify({ error: 'Informe "competenciaReferencia" (AAAA-MM).' }), { status: 400, headers });
  }

  if (!env.ANTHROPIC_API_KEY) {
    return new Response(
      JSON.stringify({ error: 'ANTHROPIC_API_KEY não configurada neste Worker — necessária para a busca automática com IA.' }),
      { status: 500, headers }
    );
  }

  try {
    const resultado = await buscarSalarioMinimoComAnthropic({ apiKey: env.ANTHROPIC_API_KEY, competenciaReferencia });
    return new Response(JSON.stringify({ ...resultado, _provedor: 'anthropic-web-search' }), { status: 200, headers });
  } catch (erro) {
    return new Response(
      JSON.stringify({ error: 'Não foi possível buscar o salário mínimo automaticamente: ' + erro.message }),
      { status: 502, headers }
    );
  }
}

async function buscarSalarioMinimoComAnthropic({ apiKey, competenciaReferencia }) {
  const mensagemUsuario = `Competência de referência: ${competenciaReferencia}\n\nBusque o salário mínimo nacional vigente nessa competência e responda no formato JSON indicado.`;

  const corpoRequisicao = {
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: [{ type: 'text', text: PROMPT_BUSCA_SALARIO_MINIMO }],
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: mensagemUsuario }],
  };

  const resposta = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(corpoRequisicao),
  });

  if (!resposta.ok) {
    const textoErro = await resposta.text();
    throw new Error(`Anthropic retornou ${resposta.status}: ${textoErro}`);
  }

  const dados = await resposta.json();
  const blocosTexto = (dados.content || []).filter((b) => b.type === 'text');
  const blocoTexto = blocosTexto[blocosTexto.length - 1];
  if (!blocoTexto) {
    throw new Error('A IA não retornou uma resposta em texto (possivelmente ficou presa em chamadas de busca).');
  }

  const extraido = parsearJSON(blocoTexto.text);
  if (!extraido || extraido.valor == null || !extraido.vigencia_inicio) {
    throw new Error('A resposta da IA não trouxe um valor utilizável. Tente novamente ou cadastre manualmente.');
  }
  return extraido;
}

// ---- HANDLER PRINCIPAL (formato Cloudflare Workers) ----
export default {
  async fetch(request, env, ctx) {
    try {
      return await handleFetch(request, env, ctx);
    } catch (erroFatal) {
      return new Response(
        JSON.stringify({ error: 'Erro inesperado no servidor: ' + (erroFatal && erroFatal.message) }),
        {
          status: 500,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Content-Type': 'application/json',
          }
        }
      );
    }
  },
};

async function handleFetch(request, env, ctx) {
  const url = new URL(request.url);

  // Só tratamos aqui a rota da API. Qualquer outra URL (o próprio site) é
  // devolvida pelos arquivos estáticos normalmente.
  if (url.pathname === '/api/checar-acesso-documentos') {
    return handleChecarAcessoDocumentos(request, env);
  }
  if (url.pathname === '/api/incrementar-ai-calls') {
    return handleIncrementarAICalls(request, env);
  }
  if (url.pathname === '/api/incrementar-storage') {
    return handleIncrementarStorage(request, env);
  }
  if (url.pathname === '/api/buscar-tabela-oficial') {
    return handleBuscarTabelaOficial(request, env);
  }
  if (url.pathname === '/api/buscar-salario-minimo') {
    return handleBuscarSalarioMinimo(request, env);
  }
  if (url.pathname !== '/api/ler-contracheque') {
    return env.ASSETS.fetch(request);
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Método não permitido.' }), { status: 405, headers });
  }

  let acesso;
  try {
    acesso = await checarAcessoIA(request, env);
  } catch (erroChecagem) {
    return new Response(
      JSON.stringify({ error: 'Erro ao checar permissão de IA: ' + erroChecagem.message }),
      { status: 500, headers }
    );
  }
  if (!acesso.ok) {
    return new Response(JSON.stringify({ error: acesso.message }), { status: acesso.status, headers });
  }

  let payload;
  try { payload = await request.json(); }
  catch (e) { return new Response(JSON.stringify({ error: 'Corpo da requisição inválido.' }), { status: 400, headers }); }

  const { arquivoBase64 } = payload || {};
  if (!arquivoBase64) {
    return new Response(JSON.stringify({ error: 'Envie o PDF em "arquivoBase64" (base64, sem o prefixo data:).' }), { status: 400, headers });
  }

  // ---- 1ª TENTATIVA: GEMINI (grátis) ----
  let erroGeminiDetalhe = null;
  if (env.GEMINI_API_KEY) {
    try {
      const extraido = await lerComGemini({ apiKey: env.GEMINI_API_KEY, arquivoBase64 });
      return new Response(JSON.stringify({ ...extraido, _provedor: 'gemini' }), { status: 200, headers });
    } catch (erroGemini) {
      erroGeminiDetalhe = String(erroGemini.message || erroGemini).slice(0, 500);
      console.log('[fallback] Gemini falhou, tentando Anthropic:', erroGeminiDetalhe);
    }
  } else {
    erroGeminiDetalhe = 'GEMINI_API_KEY não configurada neste Worker.';
    console.log('[fallback] GEMINI_API_KEY não configurada, indo direto para Anthropic.');
  }

  // ---- 2ª TENTATIVA: ANTHROPIC ----
  if (!env.ANTHROPIC_API_KEY) {
    return new Response(
      JSON.stringify({ error: 'Nem GEMINI_API_KEY nem ANTHROPIC_API_KEY estão configuradas no Cloudflare. Detalhe do Gemini: ' + erroGeminiDetalhe }),
      { status: 500, headers }
    );
  }

  try {
    const extraido = await lerComAnthropic({ apiKey: env.ANTHROPIC_API_KEY, arquivoBase64 });
    return new Response(JSON.stringify({ ...extraido, _provedor: 'anthropic' }), { status: 200, headers });
  } catch (erroAnthropic) {
    return new Response(
      JSON.stringify({
        error: 'Erro ao processar (Gemini e Anthropic falharam): ' + erroAnthropic.message +
          (erroGeminiDetalhe ? ' | Detalhe do Gemini: ' + erroGeminiDetalhe : ''),
      }),
      { status: 502, headers }
    );
  }
}

// ==================== PROVEDOR: GEMINI ====================
// Lista de modelos candidatos, em ordem de preferência. Se o Google
// descontinuar um, o próximo da lista assume automaticamente.
const MODELOS_GEMINI_CANDIDATOS = [
  'gemini-3.1-flash-lite',
  'gemini-flash-latest',
  'gemini-2.5-flash-lite',
  'gemini-3.5-flash',
];

async function lerComGemini({ apiKey, arquivoBase64 }) {
  let ultimoErro = null;

  for (const modelo of MODELOS_GEMINI_CANDIDATOS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;
    try {
      const corpoRequisicao = {
        systemInstruction: { parts: [{ text: PROMPT_CONTRACHEQUE }] },
        contents: [{
          role: 'user',
          parts: [{ inline_data: { mime_type: 'application/pdf', data: arquivoBase64 } }],
        }],
        generationConfig: { temperature: 0 },
      };

      const resposta = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpoRequisicao),
      });

      if (!resposta.ok) {
        const corpoErro = await resposta.text();
        const tentarProximoModelo = resposta.status === 404 || resposta.status === 503;
        if (tentarProximoModelo) {
          console.log(`[gemini] Modelo "${modelo}" falhou (${resposta.status}), tentando o próximo candidato.`);
          ultimoErro = new Error(`Gemini (${modelo}) retornou ${resposta.status}: ${corpoErro}`);
          continue;
        }
        throw new Error(`Gemini (${modelo}) retornou ${resposta.status}: ${corpoErro}`);
      }

      const dados = await resposta.json();
      const partes = dados?.candidates?.[0]?.content?.parts || [];
      const texto = partes.map((p) => p.text || '').join('').trim();
      if (!texto) {
        throw new Error(`Gemini (${modelo}) não retornou texto utilizável (possível bloqueio de segurança ou resposta vazia).`);
      }

      return parsearJSON(texto);
    } catch (e) {
      ultimoErro = e;
      continue;
    }
  }

  throw ultimoErro || new Error('Nenhum modelo Gemini candidato respondeu.');
}

// ==================== PROVEDOR: ANTHROPIC ====================
async function lerComAnthropic({ apiKey, arquivoBase64 }) {
  const corpoRequisicao = {
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    system: [{ type: 'text', text: PROMPT_CONTRACHEQUE }],
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: arquivoBase64 } },
      ],
    }],
  };

  const resposta = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(corpoRequisicao),
  });

  if (!resposta.ok) {
    const textoErro = await resposta.text();
    throw new Error(`Anthropic retornou ${resposta.status}: ${textoErro}`);
  }

  const dados = await resposta.json();
  const blocosTexto = (dados.content || []).filter((b) => b.type === 'text');
  const blocoTexto = blocosTexto[blocosTexto.length - 1];
  if (!blocoTexto) {
    throw new Error('Anthropic não retornou texto utilizável.');
  }

  return parsearJSON(blocoTexto.text);
}

// ==================== AUXILIAR ====================
function parsearJSON(texto) {
  const limpo = texto.replace(/```json\s*|```\s*/g, '').trim();
  try {
    return JSON.parse(limpo);
  } catch (e) {
    throw new Error('Não foi possível interpretar a resposta como JSON: ' + limpo.slice(0, 200));
  }
}
