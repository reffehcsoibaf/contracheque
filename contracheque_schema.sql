-- ==================== SCHEMA: MÓDULO CONTRACHEQUE ====================
-- Este arquivo documenta o schema já aplicado no Supabase (projeto "hubapp").
-- Todas as tabelas seguem o padrão dos demais módulos: RLS com
-- auth.uid() = user_id AND modulo_habilitado('contracheque').

create table public.contracheque_salario_base (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id),
  valor numeric not null,
  vigencia_inicio date not null,
  observacao text,
  created_at timestamptz not null default now()
);

create table public.contracheque_parametros_calculo (
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

create table public.contracheque_tabelas_oficiais (
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

create table public.contracheque_rubricas_catalogo (
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

create table public.contracheque_lancamentos_mes (
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

create table public.contracheque_documentos_oficiais (
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

create table public.contracheque_itens_oficiais (
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

create table public.contracheque_divergencias (
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

-- RLS habilitada em todas as tabelas acima, com policy padrão:
--   using (auth.uid() = user_id and modulo_habilitado('contracheque'))
--   with check (auth.uid() = user_id and modulo_habilitado('contracheque'))

-- Storage: é necessário criar manualmente o bucket "contracheque-documentos"
-- no painel do Supabase (Storage), com política de acesso restrita ao
-- próprio usuário, no mesmo padrão usado pelo bucket de documentos do
-- módulo Controle Financeiro.
