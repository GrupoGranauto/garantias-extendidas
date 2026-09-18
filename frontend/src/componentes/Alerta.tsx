type Props = { tipo: "error" | "ok" | "info"; children: React.ReactNode };

export default function Alerta({ tipo, children }: Props) {
  return (
    <p className={`alerta alerta-${tipo}`} role={tipo === "error" ? "alert" : "status"}>
      {children}
    </p>
  );
}
