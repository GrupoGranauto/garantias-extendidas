/*
  Corrección urgente de seguridad (2026-10-15), aplicada en producción con autorización del usuario.
  Hallazgos H26 y H27 de la auditoría externa del flujo de datos GE (v3):
  - H27: el rol authenticated podía hacer UPDATE en todas las columnas de su propia fila de usuarios (rol, sucursal_id,
    ejecutivo_asignado, activo). La política «cada quien edita su nombre» solo compara auth.uid() = id y el backend toma el
    rol de esta tabla: un usuario con sesión podía hacerse administrador con la llave pública.
  - H26: whatsapp_plantillas y whatsapp_plantilla_variables tenían el RLS apagado y todos los permisos para anon y
    authenticated: cualquiera con la llave pública podía leer, cambiar o borrar plantillas y su mapeo de variables.
  El navegador solo lee su propio perfil en usuarios (Login y AuthCallback); el backend entra como postgres o service_role,
  que no dependen de estos permisos. El endurecimiento amplio (resto de tablas, funciones y privilegios por defecto) queda
  para una migración posterior, probada antes en un proyecto aparte.
*/
begin;
set local lock_timeout = '5s';

revoke insert, update, delete, truncate, references, trigger on public.usuarios from anon, authenticated;
revoke select on public.usuarios from anon;

alter table public.whatsapp_plantillas enable row level security;
alter table public.whatsapp_plantilla_variables enable row level security;
revoke all on public.whatsapp_plantillas, public.whatsapp_plantilla_variables from anon, authenticated;

commit;

/*
  Reversa (estado previo, capturado antes de aplicar):
  begin;
  grant delete, insert, references, select, trigger, truncate, update on table public.usuarios to anon, authenticated;
  grant delete, insert, references, select, trigger, truncate, update on table public.whatsapp_plantilla_variables to anon, authenticated;
  grant delete, insert, references, select, trigger, truncate, update on table public.whatsapp_plantillas to anon, authenticated;
  alter table public.whatsapp_plantilla_variables disable row level security;
  alter table public.whatsapp_plantillas disable row level security;
  commit;
*/
