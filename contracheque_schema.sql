-- ==================== SCHEMA: MÓDULO CONTRACHEQUE ====================
-- Este arquivo documenta o schema já aplicado no Supabase (projeto "hubapp"),
-- conferido diretamente no banco em produção. Seguro rodar mais de uma vez
-- (idempotente): tabelas/policies só são recriadas se ainda não existirem
-- (ou substituídas de forma equivalente, no caso das policies).
--
-- Todas as tabelas seguem o padrão dos demais módulos: RLS com
-- auth.uid() = user_id AND modulo_habilitado('contracheque').

create table if not exists public.contracheque_salario_base (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id),
  valor numeric not null,
  vigencia_inicio date not null,
  observacao text,
  created_at timestamptz not null default now()
);

create table if not exists public.contracheque_parametros_calculo (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id),
  chave text not null,
  descricao text,
  tipo_valor text not null default 'percentual' check (tipo_valor in ('percentual','fixo')),
  valor numeric not null default 0,
  vigencia_inicio date not null default current_date,
  created_at timestamptz not null default now(),
  unique (user_id, chave, vigencia_inicio)
);

create table if not exists public.contracheque_tabelas_oficiais (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id),
  tipo text not null check (tipo in ('INSS','IRRF')),
  vigencia_inicio date not null,
  faixa_ordem integer not null,
  valor_de numeric not null,
  valor_ate numeric,
  aliquota numeric not null,
  parcela_deduzir numeric not null default 0,
  fonte text,
  created_at timestamptz not null default now()
);

create table if not exists public.contracheque_rubricas_catalogo (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id),
  codigo text not null,
  descricao text not null,
  tipo text not null check (tipo in ('provento','desconto')),
  regra_calculo text,
  ativo boolean not null default true,
  origem text not null default 'manual' check (origem in ('manual','ia')),
  created_at timestamptz not null default now(),
  unique (user_id, codigo)
);

create table if not exists public.contracheque_lancamentos_mes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id),
  mes_referencia date not null,
  rubrica_codigo text,
  descricao text not null,
  quantidade numeric,
  valor_calculado numeric,
  observacoes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.contracheque_documentos_oficiais (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id),
  mes_referencia date not null,
  nome_arquivo text not null,
  storage_path text not null,
  status_extracao text not null default 'pendente' check (status_extracao in ('pendente','extraido','confirmado','erro')),
  total_proventos numeric,
  total_descontos numeric,
  pagamento_liquido numeric,
  criado_em timestamptz not null default now()
);

create table if not exists public.contracheque_itens_oficiais (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id),
  documento_id uuid not null references public.contracheque_documentos_oficiais(id) on delete cascade,
  rubrica_codigo text,
  descricao text not null,
  tipo text check (tipo in ('provento','desconto')),
  quantidade numeric,
  valor numeric not null,
  rubrica_desconhecida boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.contracheque_divergencias (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id),
  documento_id uuid not null references public.contracheque_documentos_oficiais(id) on delete cascade,
  rubrica_codigo text,
  descricao text,
  valor_calculado numeric,
  valor_oficial numeric,
  diferenca numeric,
  status text not null default 'divergente' check (status in ('ok','divergente','sem_referencia')),
  created_at timestamptz not null default now()
);

-- ---- contracheque_meses_confirmados ----
-- Trava a aba "Lançamentos do mês" após o usuário confirmar o mês contra o
-- contracheque oficial: existência de uma linha aqui para (user_id,
-- mes_referencia) = mês travado (somente leitura no app, com botão de
-- reabrir que apaga a linha). Tabela existia em produção mas não estava
-- documentada neste arquivo até esta atualização.
create table if not exists public.contracheque_meses_confirmados (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id),
  mes_referencia date not null,
  confirmado_em timestamptz not null default now(),
  unique (user_id, mes_referencia)
);

-- ---- RLS: contracheque_* ----
-- Padrão real aplicado em produção: UMA policy "for all" por tabela
-- (em vez de 4 policies separadas select/insert/update/delete, como em
-- outros módulos), sempre com o mesmo using/with check.
alter table public.contracheque_salario_base enable row level security;
alter table public.contracheque_parametros_calculo enable row level security;
alter table public.contracheque_tabelas_oficiais enable row level security;
alter table public.contracheque_rubricas_catalogo enable row level security;
alter table public.contracheque_lancamentos_mes enable row level security;
alter table public.contracheque_documentos_oficiais enable row level security;
alter table public.contracheque_itens_oficiais enable row level security;
alter table public.contracheque_divergencias enable row level security;
alter table public.contracheque_meses_confirmados enable row level security;

drop policy if exists "contracheque_salario_base: somente o proprio usuario" on public.contracheque_salario_base;
create policy "contracheque_salario_base: somente o proprio usuario"
  on public.contracheque_salario_base for all
  using (auth.uid() = user_id and public.modulo_habilitado('contracheque'))
  with check (auth.uid() = user_id and public.modulo_habilitado('contracheque'));

drop policy if exists "contracheque_parametros_calculo: somente o proprio usuario" on public.contracheque_parametros_calculo;
create policy "contracheque_parametros_calculo: somente o proprio usuario"
  on public.contracheque_parametros_calculo for all
  using (auth.uid() = user_id and public.modulo_habilitado('contracheque'))
  with check (auth.uid() = user_id and public.modulo_habilitado('contracheque'));

drop policy if exists "contracheque_tabelas_oficiais: somente o proprio usuario" on public.contracheque_tabelas_oficiais;
create policy "contracheque_tabelas_oficiais: somente o proprio usuario"
  on public.contracheque_tabelas_oficiais for all
  using (auth.uid() = user_id and public.modulo_habilitado('contracheque'))
  with check (auth.uid() = user_id and public.modulo_habilitado('contracheque'));

drop policy if exists "contracheque_rubricas_catalogo: somente o proprio usuario" on public.contracheque_rubricas_catalogo;
create policy "contracheque_rubricas_catalogo: somente o proprio usuario"
  on public.contracheque_rubricas_catalogo for all
  using (auth.uid() = user_id and public.modulo_habilitado('contracheque'))
  with check (auth.uid() = user_id and public.modulo_habilitado('contracheque'));

drop policy if exists "contracheque_lancamentos_mes: somente o proprio usuario" on public.contracheque_lancamentos_mes;
create policy "contracheque_lancamentos_mes: somente o proprio usuario"
  on public.contracheque_lancamentos_mes for all
  using (auth.uid() = user_id and public.modulo_habilitado('contracheque'))
  with check (auth.uid() = user_id and public.modulo_habilitado('contracheque'));

drop policy if exists "contracheque_documentos_oficiais: somente o proprio usuario" on public.contracheque_documentos_oficiais;
create policy "contracheque_documentos_oficiais: somente o proprio usuario"
  on public.contracheque_documentos_oficiais for all
  using (auth.uid() = user_id and public.modulo_habilitado('contracheque'))
  with check (auth.uid() = user_id and public.modulo_habilitado('contracheque'));

drop policy if exists "contracheque_itens_oficiais: somente o proprio usuario" on public.contracheque_itens_oficiais;
create policy "contracheque_itens_oficiais: somente o proprio usuario"
  on public.contracheque_itens_oficiais for all
  using (auth.uid() = user_id and public.modulo_habilitado('contracheque'))
  with check (auth.uid() = user_id and public.modulo_habilitado('contracheque'));

drop policy if exists "contracheque_divergencias: somente o proprio usuario" on public.contracheque_divergencias;
create policy "contracheque_divergencias: somente o proprio usuario"
  on public.contracheque_divergencias for all
  using (auth.uid() = user_id and public.modulo_habilitado('contracheque'))
  with check (auth.uid() = user_id and public.modulo_habilitado('contracheque'));

drop policy if exists "contracheque_meses_confirmados: somente o proprio usuario" on public.contracheque_meses_confirmados;
create policy "contracheque_meses_confirmados: somente o proprio usuario"
  on public.contracheque_meses_confirmados for all
  using (auth.uid() = user_id and public.modulo_habilitado('contracheque'))
  with check (auth.uid() = user_id and public.modulo_habilitado('contracheque'));

-- ------------------------------------------------------------
-- STORAGE — bucket "contracheque-documentos"
-- O bucket em si precisa ser criado manualmente no painel do Supabase
-- (Storage → New bucket → "contracheque-documentos", privado). As 4
-- políticas abaixo já estão aplicadas em produção e replicam o padrão
-- usado no bucket "documentos" do Controle Financeiro, adaptadas para
-- profiles_modulos (módulo 'contracheque').
-- ------------------------------------------------------------
drop policy if exists "contracheque_documentos_storage_select_proprio" on storage.objects;
create policy "contracheque_documentos_storage_select_proprio"
  on storage.objects for select
  using (bucket_id = 'contracheque-documentos' and (storage.foldername(name))[1] = auth.uid()::text and public.modulo_habilitado('contracheque'));

drop policy if exists "contracheque_documentos_storage_insert_proprio" on storage.objects;
create policy "contracheque_documentos_storage_insert_proprio"
  on storage.objects for insert
  with check (bucket_id = 'contracheque-documentos' and (storage.foldername(name))[1] = auth.uid()::text and public.modulo_habilitado('contracheque'));

drop policy if exists "contracheque_documentos_storage_update_proprio" on storage.objects;
create policy "contracheque_documentos_storage_update_proprio"
  on storage.objects for update
  using (bucket_id = 'contracheque-documentos' and (storage.foldername(name))[1] = auth.uid()::text and public.modulo_habilitado('contracheque'));

drop policy if exists "contracheque_documentos_storage_delete_proprio" on storage.objects;
create policy "contracheque_documentos_storage_delete_proprio"
  on storage.objects for delete
  using (bucket_id = 'contracheque-documentos' and (storage.foldername(name))[1] = auth.uid()::text and public.modulo_habilitado('contracheque'));

-- ---- FUNÇÃO: incremento de uso de IA (Contracheque) ----
-- Mesmo padrão do financeiro_increment_ai_calls / banca_increment_ai_calls:
-- sem parâmetros, resolve o usuário via auth.uid() (token do próprio
-- usuário), security definer para poder escrever em profiles_modulos.
-- Corrige bug encontrado em produção: o worker.js chamava uma função
-- "increment_ai_calls_count" que nunca existiu no banco, então o contador
-- de uso de IA do módulo Contracheque nunca era incrementado.
create or replace function public.contracheque_increment_ai_calls()
returns void
language sql
security definer
as $$
  update public.profiles_modulos
  set ai_calls_count = ai_calls_count + 1
  where user_id = auth.uid() and modulo = 'contracheque';
$$;
