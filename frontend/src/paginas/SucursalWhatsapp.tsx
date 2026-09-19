import { useEffect, useState, type FormEvent } from "react";
import Interruptor from "../componentes/Interruptor";
import Alerta from "../componentes/Alerta";
import { apiFetch } from "../lib/api";
import { useSucursal } from "./SucursalEditLayout";

type ConfigWhatsapp = {
  configurado: boolean;
  waba_id?: string | null;
  phone_number_id?: string | null;
  numero_telefono?: string | null;
  webhook_verify_token?: string | null;
  activo?: boolean;
  tiene_access_token?: boolean;
  tiene_app_secret?: boolean;
};

const DOMINIO = "ge.autoinsights.mx";

export default function SucursalWhatsapp() {
  const { sucursal } = useSucursal();

  const [cargando, setCargando] = useState(true);

  const [wabaId, setWabaId] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [numeroTelefono, setNumeroTelefono] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [activo, setActivo] = useState(true);

  const [accessToken, setAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [tieneAccessToken, setTieneAccessToken] = useState(false);
  const [tieneAppSecret, setTieneAppSecret] = useState(false);

  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);

  useEffect(() => {
    apiFetch<ConfigWhatsapp>(`/api/admin/sucursales/${sucursal.id}/whatsapp`)
      .then((c) => {
        if (c.configurado) {
          setWabaId(c.waba_id ?? "");
          setPhoneNumberId(c.phone_number_id ?? "");
          setNumeroTelefono(c.numero_telefono ?? "");
          setVerifyToken(c.webhook_verify_token ?? "");
          setActivo(c.activo ?? true);
          setTieneAccessToken(Boolean(c.tiene_access_token));
          setTieneAppSecret(Boolean(c.tiene_app_secret));
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar la configuración."))
      .finally(() => setCargando(false));
  }, [sucursal.id]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (phoneNumberId.trim().length === 0) {
      setError("El Phone Number ID es obligatorio.");
      return;
    }

    setEnviando(true);
    setGuardado(false);

    try {
      const cuerpo: Record<string, unknown> = {
        waba_id: wabaId.trim() || null,
        phone_number_id: phoneNumberId.trim(),
        numero_telefono: numeroTelefono.trim() || null,
        webhook_verify_token: verifyToken.trim() || null,
        activo,
      };
      // Los secretos solo se mandan si el usuario escribió uno nuevo
      if (accessToken.trim()) cuerpo.access_token = accessToken.trim();
      if (appSecret.trim()) cuerpo.app_secret = appSecret.trim();

      await apiFetch(`/api/admin/sucursales/${sucursal.id}/whatsapp`, {
        method: "PUT",
        body: JSON.stringify(cuerpo),
      });

      if (accessToken.trim()) {
        setTieneAccessToken(true);
        setAccessToken("");
      }
      if (appSecret.trim()) {
        setTieneAppSecret(true);
        setAppSecret("");
      }
      setGuardado(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la configuración.");
    } finally {
      setEnviando(false);
    }
  }

  if (cargando) {
    return <p className="campo-ayuda" style={{ marginTop: 16 }}>Cargando…</p>;
  }

  const urlWebhook = `https://${sucursal.subdominio}.${DOMINIO}/api/webhooks/whatsapp`;

  return (
    <form onSubmit={onSubmit}>
      <p className="pestana-descripcion">Datos de la API de Meta para recibir y enviar mensajes de esta sucursal.</p>

      {error && (
        <div className="aviso-formulario">
          <Alerta tipo="error">{error}</Alerta>
        </div>
      )}
      {guardado && (
        <div className="aviso-formulario">
          <Alerta tipo="ok">Configuración guardada.</Alerta>
        </div>
      )}

      {/* ---------- Webhook ---------- */}
      <section className="seccion">
        <div className="seccion-info">
          <h2>Webhook</h2>
          <p>Regístralo en Meta &gt; WhatsApp &gt; Configuración, junto con el verify token.</p>
        </div>

        <div className="seccion-campos">
          <div className="campo-formulario">
            <label htmlFor="url-webhook">URL de callback</label>
            <input id="url-webhook" type="text" value={urlWebhook} readOnly />
          </div>

          <div className="campo-formulario">
            <label htmlFor="verify-token">Webhook Verify Token</label>
            <input
              id="verify-token"
              type="text"
              value={verifyToken}
              onChange={(e) => setVerifyToken(e.target.value)}
              placeholder="Un texto que tú inventas y repites en Meta"
              spellCheck={false}
            />
            <p className="campo-ayuda">Debe ser exactamente el mismo valor que captures en el panel de Meta.</p>
          </div>
        </div>
      </section>

      {/* ---------- Identificadores ---------- */}
      <section className="seccion">
        <div className="seccion-info">
          <h2>Identificadores de Meta</h2>
          <p>Se obtienen desde WhatsApp Manager, dentro de la app de Meta for Developers.</p>
        </div>

        <div className="seccion-campos">
          <div className="pareja-campos">
            <div className="campo-formulario">
              <label htmlFor="waba-id">WABA ID</label>
              <input
                id="waba-id"
                type="text"
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
                placeholder="ID de la cuenta de WhatsApp Business"
                spellCheck={false}
              />
            </div>

            <div className="campo-formulario">
              <label htmlFor="phone-number-id">
                Phone Number ID <span className="obligatorio">*</span>
              </label>
              <input
                id="phone-number-id"
                type="text"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                placeholder="ID del número dentro de la WABA"
                spellCheck={false}
              />
            </div>
          </div>

          <div className="campo-formulario">
            <label htmlFor="numero">Número de teléfono</label>
            <input
              id="numero"
              type="text"
              value={numeroTelefono}
              onChange={(e) => setNumeroTelefono(e.target.value)}
              placeholder="+52 662 000 0000"
            />
            <p className="campo-ayuda">Solo para identificarlo en el panel; no afecta el envío.</p>
          </div>
        </div>
      </section>

      {/* ---------- Credenciales ---------- */}
      <section className="seccion">
        <div className="seccion-info">
          <h2>Credenciales</h2>
          <p>Se guardan cifradas y nunca se muestran de nuevo. Déjalas vacías para conservar la actual.</p>
        </div>

        <div className="seccion-campos">
          <div className="pareja-campos">
            <div className="campo-formulario">
              <label htmlFor="access-token">Access Token</label>
              <input
                id="access-token"
                type="password"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder={tieneAccessToken ? "•••••••• (ya configurado)" : "Token permanente de la app"}
                autoComplete="off"
                spellCheck={false}
              />
              {tieneAccessToken && <p className="campo-ayuda">Ya hay uno guardado.</p>}
            </div>

            <div className="campo-formulario">
              <label htmlFor="app-secret">App Secret</label>
              <input
                id="app-secret"
                type="password"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                placeholder={tieneAppSecret ? "•••••••• (ya configurado)" : "Para validar la firma del webhook"}
                autoComplete="off"
                spellCheck={false}
              />
              {tieneAppSecret && <p className="campo-ayuda">Ya hay uno guardado.</p>}
            </div>
          </div>

          <div className="opcion">
            <Interruptor etiqueta="Integración activa" activo={activo} onChange={setActivo} />
            <p className="campo-ayuda">Apagado, los mensajes entrantes se ignoran para esta sucursal.</p>
          </div>
        </div>
      </section>

      <footer className="barra-acciones">
        <p>
          Los campos marcados con <span className="obligatorio">*</span> son obligatorios.
        </p>
        <div className="pagina-acciones">
          <button type="submit" className="boton-guardar" disabled={enviando}>
            {enviando ? "Guardando…" : "Guardar configuración"}
          </button>
        </div>
      </footer>
    </form>
  );
}
