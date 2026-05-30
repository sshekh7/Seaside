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
