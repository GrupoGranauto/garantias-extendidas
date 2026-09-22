import { NavLink } from "react-router-dom";

type Props = { id: string };

const PESTANAS = [
  { etiqueta: "General", sufijo: "editar" },
  { etiqueta: "WhatsApp", sufijo: "whatsapp" },
  { etiqueta: "Plantillas", sufijo: "plantillas" },
  { etiqueta: "Base de datos", sufijo: "base-datos" },
];

export default function PestanasSucursal({ id }: Props) {
  return (
    <nav className="pestanas" aria-label="Secciones de la sucursal">
      {PESTANAS.map((p) => (
        <NavLink
          key={p.sufijo}
          to={`/sucursales/${id}/${p.sufijo}`}
          className={({ isActive }) => `pestana${isActive ? " pestana-activa" : ""}`}
        >
          {p.etiqueta}
        </NavLink>
      ))}
    </nav>
  );
}
