import { useCallback, useEffect, useState } from "react";
import Alerta from "../componentes/Alerta";
import Cargador from "../componentes/Cargador";
import { apiFetch } from "../lib/api";
import { usePortal } from "./PortalProvider";

type Programa = {
  nombre: string;
  area_venta: string;
  meses_garantia_original: number;
  bandas_km: number[];
  plazos_meses: number[];
  msi_meses: number[];
  liga_pago_horas: number;
  estados_circulacion: string[];
  vendedores: string[];
};
type Respuesta = { programa: Programa; por_omision: Programa; estados_mexico: string[] };

/** Lo que se edita: los números van como texto mientras se escriben («15000, 59000») y se convierten al guardar. */
type Borrador = {
  nombre: string;
  area_venta: string;
  meses_garantia_original: string;
  bandas_km: string;
  plazos_meses: string;
  msi_meses: string;
  liga_pago_horas: string;
  estados_circulacion: string;
  vendedores: string;
};

const aBorrador = (p: Programa): Borrador => ({
  nombre: p.nombre,
  area_venta: p.area_venta,
  meses_garantia_original: String(p.meses_garantia_original),
  bandas_km: p.bandas_km.join(", "),
  plazos_meses: p.plazos_meses.join(", "),
  msi_meses: p.msi_meses.join(", "),
  liga_pago_horas: String(p.liga_pago_horas),
  estados_circulacion: p.estados_circulacion.join("\n"),
  vendedores: p.vendedores.join("\n"),
});

/** «15000, 59000» → [15000, 59000]: los números se separan con coma, punto y coma o espacio (sin separador de miles). */
const lista = (t: string) =>
  t
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map(Number);
const lineas = (t: string) => t.split("\n").map((x) => x.trim()).filter(Boolean);

/**
 * Programa de garantía extendida de la sucursal: las reglas del material de Nissan / Assurant (meses de garantía original,
 * bandas de km, plazos, meses sin intereses, liga de pago) y las listas del portal (estados, vendedores). Nace con los
 * valores del programa vigente de GranAuto; otro grupo u otro año puede cambiarlos aquí sin tocar el sistema.
 */
export default function ProgramaGe() {
  const { portal } = usePortal();
  const base = `/api/admin/sucursales/${portal!.id}/crm/programa`;

  const [datos, setDatos] = useState<Respuesta | null>(null);
  const [b, setB] = useState<Borrador | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sucio, setSucio] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);

  const cargar = useCallback(() => {
    apiFetch<Respuesta>(base)
      .then((r) => {
        setDatos(r);
        setB(aBorrador(r.programa));
        setSucio(false);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar."));
  }, [base]);
  useEffect(cargar, [cargar]);

  const editar = (cambios: Partial<Borrador>) => {
    setB((x) => (x ? { ...x, ...cambios } : x));
    setSucio(true);
    setAviso(null);
  };

  async function guardar() {
    if (!b) return;
    setGuardando(true);
    setAviso(null);
    try {
      await apiFetch(base, {
        method: "PUT",
        body: JSON.stringify({
          nombre: b.nombre,
          area_venta: b.area_venta,
          meses_garantia_original: Number(b.meses_garantia_original),
          bandas_km: lista(b.bandas_km),
          plazos_meses: lista(b.plazos_meses),
          msi_meses: lista(b.msi_meses),
          liga_pago_horas: Number(b.liga_pago_horas),
          estados_circulacion: lineas(b.estados_circulacion),
          vendedores: lineas(b.vendedores),
        }),
      });
      setAviso({ tipo: "ok", texto: "Guardado." });
      cargar();
    } catch (err) {
      setAviso({ tipo: "error", texto: err instanceof Error ? err.message : "No se pudo guardar." });
    } finally {
      setGuardando(false);
    }
  }

  if (error) return <Alerta tipo="error">{error}</Alerta>;
  if (!datos || !b) return <Cargador />;

  const bandas = lista(b.bandas_km);
  const maximo = bandas.length > 0 ? bandas[bandas.length - 1] : null;

  return (
    <>
      <p className="pestana-descripcion">
        Las reglas del programa de garantía extendida con el que vende esta sucursal. Vienen del material de Nissan y Assurant (portal de emisión); si cambia el programa, el año o
        el grupo, se ajustan aquí. La ficha las usa para revisar si un vehículo se puede emitir, armar el producto y llenar las listas.
      </p>
      {aviso && <Alerta tipo={aviso.tipo}>{aviso.texto}</Alerta>}

      <section className="rep-tarjeta">
        <div className="inicio-cab">
          <h3>Programa y requisitos</h3>
          <button type="button" className="boton-guardar" disabled={!sucio || guardando} onClick={guardar}>
            {guardando ? "Guardando…" : "Guardar"}
          </button>
        </div>
        <div className="camp-def-campos">
          <label className="auto-campo seg-ancho">
            <span>Nombre del programa (como en el portal)</span>
            <input type="text" className="auto-input" maxLength={120} value={b.nombre} onChange={(e) => editar({ nombre: e.target.value })} />
          </label>
          <label className="auto-campo">
            <span>Área de venta</span>
            <input type="text" className="auto-input" maxLength={60} value={b.area_venta} onChange={(e) => editar({ area_venta: e.target.value })} />
          </label>
          <label className="auto-campo">
            <span>Garantía original (meses)</span>
            <input type="number" min={1} max={120} className="auto-input" value={b.meses_garantia_original} onChange={(e) => editar({ meses_garantia_original: e.target.value })} />
          </label>
          <label className="auto-campo seg-ancho">
            <span>Bandas de kilometraje (límite de cada una, sin comas de miles)</span>
            <input type="text" className="auto-input" value={b.bandas_km} onChange={(e) => editar({ bandas_km: e.target.value })} placeholder="15000, 59000" />
          </label>
          <label className="auto-campo">
            <span>Plazos de la extensión (meses)</span>
            <input type="text" className="auto-input" value={b.plazos_meses} onChange={(e) => editar({ plazos_meses: e.target.value })} placeholder="12, 24, 36" />
          </label>
          <label className="auto-campo">
            <span>Meses sin intereses (pago financiado)</span>
            <input type="text" className="auto-input" value={b.msi_meses} onChange={(e) => editar({ msi_meses: e.target.value })} placeholder="3, 6, 9" />
          </label>
          <label className="auto-campo">
            <span>Vigencia de la liga de pago (horas)</span>
            <input type="number" min={1} max={720} className="auto-input" value={b.liga_pago_horas} onChange={(e) => editar({ liga_pago_horas: e.target.value })} />
          </label>
        </div>
        <p className="rep-ayuda">
          Un vehículo se puede emitir si no ha terminado su garantía original ({b.meses_garantia_original || "?"} meses desde la factura)
          {maximo !== null && Number.isFinite(maximo) ? ` y tiene como máximo ${maximo.toLocaleString("es-MX")} km` : ""}. La cobertura extendida empieza al terminar la original y dura
          el plazo elegido. Con pago «Contado» no hay meses sin intereses.
        </p>
      </section>

      <section className="rep-tarjeta">
        <h3>Listas del portal</h3>
        <div className="camp-def-campos">
          <label className="auto-campo seg-ancho">
            <span>Estados (estado de circulación y estado de la dirección), uno por línea</span>
            <textarea className="auto-input" rows={6} value={b.estados_circulacion} onChange={(e) => editar({ estados_circulacion: e.target.value })} />
          </label>
          <label className="auto-campo seg-ancho">
            <span>Vendedores a asignar, uno por línea</span>
            <textarea className="auto-input" rows={4} value={b.vendedores} onChange={(e) => editar({ vendedores: e.target.value })} placeholder="Como aparecen en el portal de Assurant" />
          </label>
        </div>
        <p className="rep-ayuda">Si una lista se deja vacía, en la ficha ese dato se escribe libre.</p>
        <button type="button" className="boton-secundario-claro" onClick={() => editar({ estados_circulacion: datos.estados_mexico.join("\n") })}>
          Poner los 32 estados de la república
        </button>
      </section>
    </>
  );
}
