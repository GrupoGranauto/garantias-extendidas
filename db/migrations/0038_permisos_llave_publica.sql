/*
  Endurecimiento de permisos de la llave pública (Etapa 0 de la auditoría externa, H28). Complementa la 0037, que ya cerró
  usuarios y las plantillas.

  Qué usa hoy la llave pública desde el navegador: el login y AuthCallback leen la propia fila de usuarios (authenticated),
  Storage (sus políticas usan privado.es_admin(), fuera de public) y canales Realtime de tipo broadcast (sin tablas).
  Ninguna otra tabla, vista ni función de public. El backend entra como postgres (dueño, ignora RLS) o service_role.

  Verificado en el catálogo antes de escribirla:
  - Los triggers de auth.users (public.manejar_usuario_nuevo y privado.exigir_invitacion) son SECURITY DEFINER de postgres.
  - Ninguna política usa funciones de public.
*/
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Nada de public queda abierto a anon.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

-- authenticated conserva solo lo que usa el navegador. Las políticas actuales siguen limitando las filas.
revoke all on all tables in schema public from authenticated;
revoke all on all sequences in schema public from authenticated;
grant select on public.usuarios to authenticated;     -- login y AuthCallback (política «cada quien lee su perfil»)
grant select on public.sucursales to authenticated;   -- tiene políticas de lectura; se conserva por compatibilidad

-- La política de edición propia ya no aplica (la 0037 quitó el UPDATE) y era la puerta del escalamiento de rol.
drop policy if exists "cada quien edita su nombre" on public.usuarios;

-- Funciones: EXECUTE solo para el backend. El trigger de alta de usuarios lo dispara supabase_auth_admin.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
grant execute on function public.manejar_usuario_nuevo() to supabase_auth_admin;

-- Lo que cree postgres en adelante (quien aplica las migraciones) no nace abierto.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;

commit;

/*
  Reversa: se genera ANTES de aplicar con las consultas de abajo (su salida es el script) y se guarda junto a la ficha.

  select format('grant %s on table public.%I to %I;', string_agg(privilege_type, ', '), table_name, grantee)
    from information_schema.role_table_grants
   where table_schema = 'public' and grantee in ('anon', 'authenticated')
   group by table_name, grantee;

  select format('grant execute on function %s to %s;', p.oid::regprocedure,
                case when a.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(a.grantee)) end)
    from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   where p.pronamespace = 'public'::regnamespace and a.privilege_type = 'EXECUTE'
     and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated'));

  Además, a mano:
    create policy "cada quien edita su nombre" on public.usuarios for update to authenticated
      using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
    alter default privileges for role postgres in schema public grant all on tables to anon, authenticated;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated;
    alter default privileges for role postgres in schema public grant execute on functions to public, anon, authenticated;
*/
