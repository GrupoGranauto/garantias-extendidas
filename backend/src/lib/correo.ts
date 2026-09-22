import { env, flags } from "../config/env.js";

// Railway bloquea SMTP saliente (puertos 587/465 nunca conectan), así que el
// correo se manda por la API REST de Gmail (HTTPS puro, nunca bloqueado) con
// una cuenta de servicio OAuth2 (notificaciones@autoinsights.mx). El access
// token dura ~1h; se cachea y se renueva con el refresh token cuando toca.
let accessTokenCache: { token: string; expiraEn: number } | null = null;

async function obtenerAccessToken(): Promise<string> {
  if (accessTokenCache && Date.now() < accessTokenCache.expiraEn) {
    return accessTokenCache.token;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID!,
      client_secret: env.GMAIL_CLIENT_SECRET!,
      refresh_token: env.GMAIL_REFRESH_TOKEN!,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    throw new Error(`No se pudo renovar el token de Gmail: HTTP ${res.status} ${await res.text()}`);
  }

  const datos = (await res.json()) as { access_token: string; expires_in: number };
  // Un margen de 60s para no usar un token a punto de vencer a mitad de la llamada
  accessTokenCache = { token: datos.access_token, expiraEn: Date.now() + (datos.expires_in - 60) * 1000 };
  return datos.access_token;
}

/** Codifica en base64url (Gmail exige esta variante, no el base64 normal). */
function base64Url(texto: string): string {
  return Buffer.from(texto, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function construirMime(destino: string, asunto: string, html: string): string {
  const asuntoCodificado = `=?UTF-8?B?${Buffer.from(asunto, "utf8").toString("base64")}?=`;
  const mensaje = [
    `From: "${env.SMTP_FROM_NAME}" <${env.GMAIL_SENDER}>`,
    `To: ${destino}`,
    `Subject: ${asuntoCodificado}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "",
    html,
  ].join("\r\n");
  return base64Url(mensaje);
}

async function enviarPorGmail(destino: string, asunto: string, html: string): Promise<void> {
  if (!flags.correo) {
    throw new Error("Gmail no configurado (GMAIL_SENDER, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN).");
  }

  const accessToken = await obtenerAccessToken();

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: construirMime(destino, asunto, html) }),
  });

  if (!res.ok) {
    throw new Error(`Gmail respondió HTTP ${res.status}: ${await res.text()}`);
  }
}

const LOGO_URL = `https://panel.${env.DOMINIO_BASE}/marca/logo-morado.png`;

type PlantillaBase = {
  saludo: string;
  parrafo: string;
  textoBoton: string;
  actionLink: string;
};

/** Tarjeta blanca con logo, un párrafo y un botón: el esqueleto de todos los correos propios. */
function plantillaBase({ saludo, parrafo, textoBoton, actionLink }: PlantillaBase): string {
  return `<!DOCTYPE html>
<html lang="es">
  <body style="margin:0; padding:0; background:#f3f4f6; font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.08); max-width:480px;">
            <tr>
              <td style="padding:32px 40px 0;" align="center">
                <img src="${LOGO_URL}" alt="Auto Insights" height="68" style="display:block; border:0;" />
              </td>
            </tr>
            <tr>
              <td style="padding:28px 40px 8px;">
                <h1 style="margin:0; font-size:20px; font-weight:700; color:#111827;">${saludo}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 24px; font-size:14px; line-height:1.6; color:#4b5563;">
                ${parrafo}
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 32px;" align="center">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="border-radius:8px; background:#493f91;">
                      <a href="${actionLink}"
                         style="display:inline-block; padding:13px 28px; font-size:14px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:8px; font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
                        ${textoBoton}
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 32px; font-size:12px; line-height:1.6; color:#9ca3af;">
                Si el botón no funciona, copia y pega este enlace en tu navegador:<br />
                <a href="${actionLink}" style="color:#493f91; word-break:break-all;">${actionLink}</a>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 40px; background:#f9fafb; font-size:11.5px; color:#9ca3af; text-align:center;">
                Si no esperabas este correo, puedes ignorarlo con confianza.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

type DatosInvitacion = {
  destino: string;
  nombre?: string | null;
  sucursalNombre?: string | null;
  actionLink: string;
};

export async function enviarCorreoInvitacion({ destino, nombre, sucursalNombre, actionLink }: DatosInvitacion): Promise<void> {
  const contexto = sucursalNombre
    ? `Te dieron de alta en el panel de <strong>${sucursalNombre}</strong>.`
    : "Te dieron de alta como administrador de la plataforma.";

  await enviarPorGmail(
    destino,
    "Te invitaron a Auto Insights",
    plantillaBase({
      saludo: nombre ? `Hola, ${nombre}` : "Hola",
      parrafo: `${contexto} Da clic en el botón para definir tu contraseña y entrar por primera vez.`,
      textoBoton: "Aceptar invitación",
      actionLink,
    }),
  );
}

type DatosRecuperacion = {
  destino: string;
  nombre?: string | null;
  actionLink: string;
};

export async function enviarCorreoRecuperacion({ destino, nombre, actionLink }: DatosRecuperacion): Promise<void> {
  await enviarPorGmail(
    destino,
    "Recupera tu contraseña — Auto Insights",
    plantillaBase({
      saludo: nombre ? `Hola, ${nombre}` : "Hola",
      parrafo: "Pediste restablecer tu contraseña. Da clic en el botón para elegir una nueva.",
      textoBoton: "Restablecer contraseña",
      actionLink,
    }),
  );
}
