/* 0007: una regla por tiempo solo aplica a oportunidades que entraron a la etapa después de activarla
   (salvo que se marque "aplicar a las que ya están"), para no inundar de tareas el backlog existente. */
alter table public.crm_automatizaciones add column if not exists activa_desde timestamptz;
update public.crm_automatizaciones set activa_desde = coalesce(actualizado_en, now()) where activa and activa_desde is null;
