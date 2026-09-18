import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { cargarPortal, type Portal } from "../lib/portal";

type Estado = {
  portal: Portal | null;
  cargando: boolean;
  /** El subdominio no corresponde a ninguna sucursal. */
  noEncontrado: boolean;
};

const PortalContext = createContext<Estado>({
  portal: null,
  cargando: true,
  noEncontrado: false,
});

export function PortalProvider({ children }: { children: ReactNode }) {
  const [estado, setEstado] = useState<Estado>({
    portal: null,
    cargando: true,
    noEncontrado: false,
  });

  useEffect(() => {
    let vivo = true;

    cargarPortal()
      .then((portal) => {
        if (vivo) setEstado({ portal, cargando: false, noEncontrado: false });
      })
      .catch((err: Error) => {
        if (!vivo) return;
        setEstado({
          portal: null,
          cargando: false,
          noEncontrado: err.message === "PORTAL_NO_ENCONTRADO",
        });
      });

    return () => {
      vivo = false;
    };
  }, []);

  // El color de la sucursal reemplaza al de Auto Insights en toda la app
  useEffect(() => {
    const raiz = document.documentElement;
    const color = estado.portal?.color;

    if (!color) {
      raiz.style.removeProperty("--marca");
      raiz.style.removeProperty("--marca-anillo");
      return;
    }

    raiz.style.setProperty("--marca", color);
    raiz.style.setProperty("--marca-anillo", `${color}33`);
  }, [estado.portal?.color]);

  // Y el nombre de la sucursal en la pestaña
  useEffect(() => {
    document.title = estado.portal
      ? `${estado.portal.nombre} — Auto Insights`
      : "Auto Insights — Panel de administración";
  }, [estado.portal?.nombre]);

  return <PortalContext.Provider value={estado}>{children}</PortalContext.Provider>;
}

export function usePortal(): Estado {
  return useContext(PortalContext);
}
