# Garantías Extendidas

Monorepo con `frontend/` (React + Vite + TypeScript) y `backend/` (Express + TypeScript),
con soporte para Supabase y BigQuery.

## Estructura

```
.
├── backend/          API Express + TS
│   ├── src/
│   │   ├── config/env.ts      carga y valida backend/.env
│   │   ├── lib/supabase.ts    cliente Supabase (service role)
│   │   ├── lib/bigquery.ts    cliente BigQuery
│   │   └── routes/            health, garantias
│   ├── .env                   secretos reales (ignorado por git)
│   └── .env.example
├── frontend/         React + Vite + TS
│   ├── src/
│   ├── .env                   solo variables VITE_ (públicas)
│   └── .env.example
├── data/             CSV consolidados + consolidar.py
├── secrets/          credenciales locales (ignorado por git)
└── package.json      workspaces + script dev
```

## Arranque

```bash
npm install          # una sola vez, desde la raíz
npm run dev          # levanta backend (4000) y frontend (5173)
```

- Frontend: http://localhost:5173
- Backend: http://localhost:4000/api/health
- Prueba de conexiones: http://localhost:4000/api/health/conexiones

El frontend llama a `/api/...` y Vite lo reenvía al backend (proxy en `vite.config.ts`),
así que no hay problemas de CORS en desarrollo.

## Dónde va cada credencial

| Dato | Archivo | Motivo |
|---|---|---|
| Password de la BDD de Supabase | `backend/.env` → `SUPABASE_DB_URL` | Nunca sale del servidor |
| `service_role` key de Supabase | `backend/.env` → `SUPABASE_SERVICE_ROLE_KEY` | Ignora RLS, acceso total |
| `anon` key de Supabase | `frontend/.env` → `VITE_SUPABASE_ANON_KEY` | Pública por diseño, protegida por RLS |
| JSON de cuenta de servicio BigQuery | `secrets/bigquery-service-account.json`; la **ruta** en `backend/.env` → `GOOGLE_APPLICATION_CREDENTIALS` | La carpeta `secrets/` esta en `.gitignore` |

**Regla:** todo lo que empieza con `VITE_` termina en el bundle del navegador y es visible
para cualquiera. Nada secreto ahí.

## Scripts

| Comando | Qué hace |
|---|---|
| `npm run dev` | backend + frontend en paralelo |
| `npm run dev:backend` | solo backend |
| `npm run dev:frontend` | solo frontend |
| `npm run build` | compila ambos |
| `npm run typecheck` | revisa tipos en ambos |
