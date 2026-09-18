# Despliegue: un portal por sucursal

Cada sucursal vive en `<subdominio>.ge.autoinsights.mx`. Un solo servicio de
Railway sirve el frontend y la API; el subdominio del `Host` decide qué marca
se pinta y qué usuarios pueden entrar.

```
navegador                    Railway (un servicio)          Supabase
granauto.ge.autoinsights.mx ──► Express                 ──► Postgres + Auth
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
| `DOMINIO_BASE` | `ge.autoinsights.mx` |
| `SUPABASE_URL` | `https://qpdxtfdwvyntkjvkipki.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | la del dashboard (secreta) |
| `SUPABASE_DB_URL` | opcional, para consultas directas |
| `BIGQUERY_PROJECT_ID` | `base-maestra-gn` |
| `GOOGLE_CREDENTIALS_JSON` | el JSON de la cuenta de servicio, completo, en una línea |
| `CORS_ORIGIN` | `https://autoinsights.mx` |
| `NPM_CONFIG_INCLUDE` | `dev` |
| `NPM_CONFIG_PRODUCTION` | `false` |

Las dos últimas no son decorativas. Con `NODE_ENV=production`, npm omite las
devDependencies, y ahí viven `tsc` y `vite`: sin ellas el build muere con
`sh: 1: tsc: not found` (código 127). Es el error clásico de compilar
TypeScript en un servidor con esa variable puesta.

`PORT` lo inyecta Railway; el código ya lo respeta.

**BigQuery**: en local se lee el archivo apuntado por
`GOOGLE_APPLICATION_CREDENTIALS`; en Railway no hay disco donde dejarlo, así que
se pasa el JSON completo en `GOOGLE_CREDENTIALS_JSON`. Si están las dos, gana la
variable.

`railway.json` ya define build (`npm run build`), arranque (`npm start`) y
health check en `/api/health`.

## 2. Dominio comodín en Railway

`autoinsights.mx` es una zona **compartida** con otro equipo: ya tiene 500+
registros propios (correo de la empresa, 20+ portales de otro sistema). Un
comodín amplio `*.autoinsights.mx` capturaría cualquier nombre no declarado
en esa zona — territorio ajeno. Por eso el comodín va en un nivel anidado:

Settings → Networking → **+ Custom Domain** → escribir `*.ge.autoinsights.mx`.

Railway devuelve tres registros. **Los tres son obligatorios**:

| Tipo | Nombre | Valor |
|---|---|---|
| CNAME | `*.ge` | el `xxxx.up.railway.app` que muestre Railway |
| CNAME | `_acme-challenge.ge` | el `xxxx.authorize.railwaydns.net` que muestre Railway |
| TXT | `_railway-verify.ge` | el valor que muestre Railway |

Al ser un nivel anidado, la validación ocurre en `_acme-challenge.ge.autoinsights.mx`
- un nombre que no choca con el `_acme-challenge.autoinsights.mx` que ya usa
el otro equipo para su propio certificado comodín. No hay que tocar nada suyo.

El certificado lo emite y renueva Railway. No hace falta Cloudflare ni acme.sh.

**Pendiente de decidir**: como el dominio raíz `autoinsights.mx` ya lo sirve el
otro sistema (apunta a cPanel, no a Railway), los administradores de
plataforma (`usuarios.sucursal_id = NULL`) no pueden entrar por ahí como se
pensó originalmente. Falta definir su vía de acceso - un subdominio propio
bajo `.ge.` (p. ej. `admin.ge.autoinsights.mx`) es la opción más simple.

## 3. DNS en cPanel

En **Zone Editor** del dominio `autoinsights.mx`, agrega los tres registros de
la sección anterior. TTL bajo (300) mientras se confirma que todo funciona;
subirlo después no es obligatorio pero es lo consistente con el resto de la
zona (14400).

No toques ningún registro que no empiece con `.ge` o `_acme-challenge.ge` /
`_railway-verify.ge` - todo lo demás es de otro equipo.

**Aviso real de esta migración**: cPanel guardó los registros correctamente
(confirmable en su propio listado del Zone Editor) pero el servidor DNS real
(`ns144/245/143.neubox.net`) tardó en aplicar el cambio - el SOA serial se
quedó congelado por horas mientras la interfaz ya mostraba todo bien. Si
después de guardar el serial no avanza
(`nslookup -type=SOA autoinsights.mx ns144.neubox.net`), es un problema de
sincronización del lado del hosting (Neubox), no algo corregible desde el
Zone Editor. Hay que pedirles que fuercen la recarga de la zona.

**No uses "Reset DNS Zone"** (menú Acciones del Zone Editor) para intentar
forzar esto - en una zona compartida con 500+ registros de otro equipo, ese
botón probablemente reconstruye la zona desde una plantilla en blanco,
borrando todo lo existente (MX de correo, SPF/DKIM/DMARC, los demás
portales). No se probó a propósito por el riesgo.

Si algún día pones Cloudflare enfrente: el CNAME de `authorize.railwaydns.net`
**no debe ir proxiado** (nube gris), o la verificación falla.

## 4. Supabase

Authentication → URL Configuration:

- **Site URL**: `https://ge.autoinsights.mx` (o el subdominio que uses de referencia)
- **Redirect URLs**: agregar `https://*.ge.autoinsights.mx/**`

Sin esto, el login con Google y los enlaces de recuperación rebotan al volver
al subdominio. Supabase acepta comodines en esa lista.

Google Cloud **no** necesita nada por sucursal: el callback de OAuth siempre va
a `https://qpdxtfdwvyntkjvkipki.supabase.co/auth/v1/callback` y de ahí regresa
al subdominio que inició el flujo.

## 5. Comprobar

```bash
curl -s https://granauto.ge.autoinsights.mx/api/health
curl -s https://granauto.ge.autoinsights.mx/api/publico/sucursal
```

El segundo debe devolver la marca de esa sucursal. Un subdominio inexistente
devuelve 404 y el navegador muestra la pantalla "Portal no encontrado".

---

## Desarrollo

En `localhost` no hay subdominios, así que el portal se simula con
`?sucursal=granauto-ge`. La elección se recuerda en `localStorage` hasta que se
pida otra o se borre la clave `portal.sucursal.dev`.
