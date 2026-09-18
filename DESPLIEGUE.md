# Despliegue: un portal por sucursal

Cada sucursal vive en `<subdominio>.autoinsights.mx`. Un solo servicio de
Railway sirve el frontend y la API; el subdominio del `Host` decide qué marca
se pinta y qué usuarios pueden entrar.

```
navegador                    Railway (un servicio)          Supabase
granauto-ge.autoinsights.mx ──► Express                 ──► Postgres + Auth
                                 ├── /api/*                  + Storage (marca)
                                 └── frontend/dist
```

Servir ambas cosas desde el mismo origen evita CORS entre portal y API, y hace
que **un solo dominio comodín** cubra todas las sucursales, presentes y futuras.

---

## 1. Railway

Variables de entorno del servicio:

| Variable | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `DOMINIO_BASE` | `autoinsights.mx` |
| `SUPABASE_URL` | `https://qpdxtfdwvyntkjvkipki.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | la del dashboard (secreta) |
| `SUPABASE_DB_URL` | opcional, para consultas directas |
| `BIGQUERY_PROJECT_ID` | `base-maestra-gn` |
| `GOOGLE_CREDENTIALS_JSON` | el JSON de la cuenta de servicio, completo, en una línea |
| `CORS_ORIGIN` | `https://autoinsights.mx` |

`PORT` lo inyecta Railway; el código ya lo respeta.

**BigQuery**: en local se lee el archivo apuntado por
`GOOGLE_APPLICATION_CREDENTIALS`; en Railway no hay disco donde dejarlo, así que
se pasa el JSON completo en `GOOGLE_CREDENTIALS_JSON`. Si están las dos, gana la
variable.

`railway.json` ya define build (`npm run build`), arranque (`npm start`) y
health check en `/api/health`.

## 2. Dominio comodín en Railway

Settings → Networking → **+ Custom Domain** → escribir `*.autoinsights.mx`.

Railway devuelve dos registros. **Los dos son obligatorios**: sin el TXT el
dominio responde 404 aunque el CNAME resuelva.

| Tipo | Nombre | Valor |
|---|---|---|
| CNAME | `*` | el `xxxx.up.railway.app` que muestre Railway |
| TXT | el que indique Railway | el valor que indique Railway |

Conviene agregar también `autoinsights.mx` a secas, para el dominio raíz donde
entran los administradores de plataforma. Son dos dominios distintos para
efectos del plan: Hobby permite 2 por servicio, Pro permite 20.

El certificado lo emite y renueva Railway. No hace falta Cloudflare ni acme.sh.

## 3. DNS en cPanel

En **Zone Editor** del dominio `autoinsights.mx`:

1. CNAME con nombre `*` apuntando al destino que dio Railway.
2. El TXT de verificación, tal cual.

Si algún día pones Cloudflare enfrente: el CNAME de `authorize.railwaydns.net`
**no debe ir proxiado** (nube gris), o la verificación falla. Los cambios de DNS
pueden tardar hasta 72 horas en propagar, aunque normalmente son minutos.

## 4. Supabase

Authentication → URL Configuration:

- **Site URL**: `https://autoinsights.mx`
- **Redirect URLs**: agregar `https://*.autoinsights.mx/**`

Sin esto, el login con Google y los enlaces de recuperación rebotan al volver
al subdominio. Supabase acepta comodines en esa lista.

Google Cloud **no** necesita nada por sucursal: el callback de OAuth siempre va
a `https://qpdxtfdwvyntkjvkipki.supabase.co/auth/v1/callback` y de ahí regresa
al subdominio que inició el flujo.

## 5. Comprobar

```bash
curl -s https://granauto-ge.autoinsights.mx/api/health
curl -s https://granauto-ge.autoinsights.mx/api/publico/sucursal
```

El segundo debe devolver la marca de esa sucursal. Un subdominio inexistente
devuelve 404 y el navegador muestra la pantalla "Portal no encontrado".

---

## Desarrollo

En `localhost` no hay subdominios, así que el portal se simula con
`?sucursal=granauto-ge`. La elección se recuerda en `localStorage` hasta que se
pida otra o se borre la clave `portal.sucursal.dev`.
