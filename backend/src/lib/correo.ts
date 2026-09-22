import nodemailer, { type Transporter } from "nodemailer";
import { env, flags } from "../config/env.js";

let transportador: Transporter | null = null;

function getTransportador(): Transporter {
  if (!flags.smtp) {
    throw new Error("SMTP no configurado (SMTP_HOST, SMTP_USER, SMTP_PASS).");
  }
  if (!transportador) {
    transportador = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT ?? 587,
      secure: env.SMTP_PORT === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      // Sin esto, una conexión que no responde (puerto bloqueado, firewall)
      // cuelga minutos en vez de fallar rápido con un error identificable.
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 15000,
    });
  }
  return transportador;
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

  await getTransportador().sendMail({
    from: `"${env.SMTP_FROM_NAME}" <${env.SMTP_USER}>`,
    to: destino,
    subject: "Te invitaron a Auto Insights",
    html: plantillaBase({
      saludo: nombre ? `Hola, ${nombre}` : "Hola",
      parrafo: `${contexto} Da clic en el botón para definir tu contraseña y entrar por primera vez.`,
      textoBoton: "Aceptar invitación",
      actionLink,
    }),
  });
}

type DatosRecuperacion = {
  destino: string;
  nombre?: string | null;
  actionLink: string;
};

export async function enviarCorreoRecuperacion({ destino, nombre, actionLink }: DatosRecuperacion): Promise<void> {
  await getTransportador().sendMail({
    from: `"${env.SMTP_FROM_NAME}" <${env.SMTP_USER}>`,
    to: destino,
    subject: "Recupera tu contraseña — Auto Insights",
    html: plantillaBase({
      saludo: nombre ? `Hola, ${nombre}` : "Hola",
      parrafo: "Pediste restablecer tu contraseña. Da clic en el botón para elegir una nueva.",
      textoBoton: "Restablecer contraseña",
      actionLink,
    }),
  });
}
