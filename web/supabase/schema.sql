-- Agents table
create table agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  profile_pic jsonb,
  job_description text,
  location_work text,
  location_home text,
  age integer,
  personality text,
  created_at timestamptz default now()
);

-- Memory table (per agent)
create table memory (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references agents(id) on delete cascade not null,
  time_start timestamptz not null,
  time_end timestamptz,
  activity text not null,
  created_at timestamptz default now()
);

-- Index for fast lookups by agent
create index idx_memory_agent_id on memory(agent_id);
create index idx_memory_time on memory(agent_id, time_start desc);

-- Plans table
-- Stores the full generated day plan as JSONB so Supabase Edge Functions
-- (which have no filesystem access) can read what generate-plan produced.
create table if not exists plans (
  id           uuid primary key default gen_random_uuid(),
  agent_id     uuid references agents(id) on delete cascade not null,
  sim_date     date not null,
  plan_data    jsonb not null,
  generated_at timestamptz default now(),
  unique(agent_id, sim_date)
);

create index if not exists idx_plans_agent_date on plans(agent_id, sim_date);
