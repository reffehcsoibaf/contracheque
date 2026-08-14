// ==================== WORKER CLOUDFLARE: CONTRACHEQUE ====================
// Assim como no Hub e nos demais módulos, este Worker por enquanto só
// serve os arquivos estáticos (binding "ASSETS"). Toda leitura/escrita
// acontece direto no navegador via Supabase (RLS cuida do isolamento
// por usuário). Uma rota de API própria (ex: /api/extrair-pdf) poderá
// ser adicionada aqui futuramente para a extração via IA dos
// contracheques oficiais, no mesmo padrão do BancaPro Worker.

export default {
  async fetch(request, env, ctx) {
    return env.ASSETS.fetch(request);
  },
};
