"""Consolida los CSV de garantias extendidas de Downloads en una base por tipo.

Genera una base separada por cada tipo de poliza:
    GN -> garantias de unidades nacionales
    GI -> garantias de unidades importadas

Agrega columnas de control: archivo de origen, fechas parseadas, importe numerico,
tipo de movimiento (CARGO / CANCELACION) y marca de VIN con mas de un cargo
activo sin cancelar.

Uso:
    python consolidar.py            # procesa GN y GI
    python consolidar.py GI         # solo un tipo
"""
import glob
import os
import sys

import pandas as pd

ORIGEN = r"C:\Users\famil\Downloads"
DESTINO = os.path.dirname(os.path.abspath(__file__))
TIPOS = ["GN", "GI"]


def consolidar(tipo):
    rutas = sorted(glob.glob(os.path.join(ORIGEN, f"*{tipo}.csv")))
    if not rutas:
        print(f"{tipo}: sin archivos en {ORIGEN}")
        return None

    partes = []
    for ruta in rutas:
        df = pd.read_csv(ruta, dtype=str, encoding="latin-1", index_col=False)
        df = df.loc[:, ~df.columns.str.startswith("Unnamed")]
        df["archivo_origen"] = os.path.basename(ruta)
        partes.append(df)

    base = pd.concat(partes, ignore_index=True)

    base["fecha_cargo"] = pd.to_datetime(base["feccar"], format="%d/%m/%Y", errors="coerce")
    base["fecha_factura"] = pd.to_datetime(base["fecfac"], format="%d/%m/%Y", errors="coerce")
    base["fecha_fin_garantia"] = pd.to_datetime(base["fecfingtia"], format="%d/%m/%Y", errors="coerce")
    base["importe"] = pd.to_numeric(base["impciva"], errors="coerce")
    base["anio"] = base["fecha_cargo"].dt.year
    base["mes"] = base["fecha_cargo"].dt.month
    base["periodo"] = base["fecha_cargo"].dt.to_period("M").astype(str)
    base["tipo_mov"] = base["importe"].apply(lambda x: "CANCELACION" if x < 0 else "CARGO")

    # VIN con mas cargos que cancelaciones en toda la base -> posible venta doble
    mov = base.groupby("numser")["importe"].agg(
        cargos=lambda s: (s > 0).sum(), cancelaciones=lambda s: (s < 0).sum()
    )
    vin_doble = mov.index[(mov["cargos"] - mov["cancelaciones"]) > 1]
    base["vin_doble_activo"] = base["numser"].isin(vin_doble)

    base = base.sort_values(["fecha_cargo", "nomsucemp", "refcar"]).reset_index(drop=True)

    salida_csv = os.path.join(DESTINO, f"{tipo}_consolidado.csv")
    salida_xlsx = os.path.join(DESTINO, f"{tipo}_consolidado.xlsx")
    base.to_csv(salida_csv, index=False, encoding="utf-8-sig")
    with pd.ExcelWriter(salida_xlsx, engine="openpyxl") as xls:
        base.to_excel(xls, sheet_name="base", index=False)
        base.pivot_table(
            index="periodo", columns="tipo_mov", values="importe", aggfunc=["count", "sum"]
        ).to_excel(xls, sheet_name="resumen_mensual")
        base[base["vin_doble_activo"]].to_excel(xls, sheet_name="vin_doble_activo", index=False)

    print(f"\n=== {tipo} ===")
    print(f"archivos: {len(partes)} | filas: {len(base)}")
    print(f"periodo: {base['fecha_cargo'].min():%d/%m/%Y} -> {base['fecha_cargo'].max():%d/%m/%Y}")
    print(f"cargos: {(base['tipo_mov'] == 'CARGO').sum()} | cancelaciones: {(base['tipo_mov'] == 'CANCELACION').sum()}")
    print(f"importe neto: {base['importe'].sum():,.2f}")
    print(f"uuid duplicados: {base['uuid'].duplicated().sum()} | filas duplicadas: {base.duplicated().sum()}")
    print(f"VIN con doble cargo activo: {len(vin_doble)}")
    print(f"{salida_csv}\n{salida_xlsx}")
    return base


if __name__ == "__main__":
    tipos = [t.upper() for t in sys.argv[1:]] or TIPOS
    for t in tipos:
        consolidar(t)
