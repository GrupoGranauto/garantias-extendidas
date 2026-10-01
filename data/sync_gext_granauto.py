"""Sincroniza la hoja GEXT_OPERACION del Google Sheet hacia la tabla real de la
sucursal Granauto en Postgres (Supabase), la misma que muestra el portal web.

Origen : Google Sheet "RCI - Detallado de ventas y Garantia extendida", hoja
         GEXT_OPERACION. Solo lectura: el Sheet NUNCA se modifica.
Destino: esquema "datos_granauto", tabla "garantias_extendidas".

Es idempotente: hace UPSERT por "id_oportunidad" (índice único parcial
ux_gext_id_oportunidad). Correrlo de nuevo actualiza las filas existentes e
inserta las nuevas; no duplica.

Requisitos:
    pip install gspread google-auth psycopg2-binary

Config por variables de entorno (con valores por omisión):
    GEXT_CRED_JSON  ruta al service account de Google
    GEXT_SHEET_ID   id del spreadsheet
    SUPABASE_DB_URL cadena de conexión Postgres (si no, se lee de backend/.env)

Uso:
    python sync_gext_granauto.py            # sincroniza
    python sync_gext_granauto.py --dry-run  # solo reporta, no escribe
"""
import os
import re
import sys
import uuid

import gspread
from google.oauth2.service_account import Credentials
import psycopg2
from psycopg2.extras import execute_values

# --------------------------------------------------------------------------- #
# Configuración
# --------------------------------------------------------------------------- #
RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CRED_JSON = os.environ.get(
    "GEXT_CRED_JSON",
    r"G:\Unidades compartidas\BDC Grupo Granauto\BDC Business Intelligence\credenciales\credencialesAI.json",
)
SHEET_ID = os.environ.get("GEXT_SHEET_ID", "19prg5YjbhXApoNt4UFMiv-01xELlUCv3SNqB5SOqTRQ")
TAB = "GEXT_OPERACION"

ESQUEMA = "datos_granauto"
TABLA = "garantias_extendidas"

# (nombre_tecnico en la tabla, tipo lógico, índice de la columna en el Sheet)
# El orden define también el orden del INSERT.
CAMPOS = [
    ("id_oportunidad", "texto", 0),
    ("cliente", "texto", 1),
    ("apv", "texto", 2),
    ("fecha_factura", "fecha", 3),
    ("vin", "texto", 4),
    ("telefono_principal", "texto", 5),
    ("origen_telefono", "texto", 6),
    ("tiene_celular", "bool", 7),
    ("correo", "texto", 8),
    ("es_contactable", "bool", 9),
    ("motivo_no_contactable", "texto", 10),
    ("agencia", "texto", 11),
    ("linea", "texto", 12),
    ("version_vehiculo", "texto", 13),
    ("anio_vin", "entero", 14),
    ("campana", "texto", 15),
    ("etapa", "texto", 16),
    ("inicio_campana", "fecha", 17),
    ("estado_fuente", "texto", 18),
    ("tiene_ge", "bool", 19),
    ("resultado_bdc", "texto", 20),
    ("comentarios", "texto", 21),
    ("fecha_ultimo_contacto", "fecha_contacto", 22),  # se limpia a una sola fecha
    ("fecha_compra", "fecha", 23),
    ("ejecutivo", "texto", 24),
    ("ultima_sincronizacion", "fecha_hora", 25),
]

# Campos que captura el ejecutivo BDC EN LA WEB: la web es la fuente de verdad.
# El sync los siembra al INSERTAR un lead nuevo, pero NUNCA los sobreescribe en
# filas que ya existen (asi no pisa el trabajo del BDC).
PROTEGIDOS = {"resultado_bdc", "comentarios", "fecha_ultimo_contacto", "fecha_compra"}

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
]


# --------------------------------------------------------------------------- #
# Utilidades
# --------------------------------------------------------------------------- #
def db_url():
    url = os.environ.get("SUPABASE_DB_URL")
    if url:
        return url
    env_path = os.path.join(RAIZ, "backend", ".env")
    with open(env_path, encoding="utf-8") as f:
        for linea in f:
            if linea.startswith("SUPABASE_DB_URL="):
                return linea.split("=", 1)[1].strip()
    raise SystemExit("No hay SUPABASE_DB_URL (ni en entorno ni en backend/.env).")


def convertir(tipo, crudo):
    """Convierte el texto del Sheet al valor Python que Postgres espera, o None."""
    s = (crudo or "").strip()
    if s == "":
        return None
    if tipo == "texto":
        return s
    if tipo == "entero":
        return int(s) if s.isdigit() else None
    if tipo == "bool":
        u = s.upper()
        return True if u == "TRUE" else (False if u == "FALSE" else None)
    if tipo == "fecha":
        return s if re.match(r"^\d{4}-\d{2}-\d{2}$", s) else None
    if tipo == "fecha_contacto":
        # El Sheet trae dos formatos: 'YYYY-MM-DD' (se queda) o un rango
        # 'dd/mm/yyyy - dd/mm/yyyy'; en ese caso toma la primera fecha.
        if re.match(r"^\d{4}-\d{2}-\d{2}$", s):
            return s
        m = re.match(r"^(\d{2})/(\d{2})/(\d{4})", s)
        return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else None
    if tipo == "fecha_hora":
        return s  # 'YYYY-MM-DD HH:MM' lo parsea Postgres como timestamptz
    return None


def leer_sheet():
    creds = Credentials.from_service_account_file(CRED_JSON, scopes=SCOPES)
    gc = gspread.authorize(creds)
    ws = gc.open_by_key(SHEET_ID).worksheet(TAB)
    valores = ws.get_all_values()
    return valores[1:]  # sin encabezado


def construir_filas(renglones):
    filas = []
    for r in renglones:
        id_op = (r[0] if len(r) > 0 else "").strip()
        if not id_op:
            continue  # sin clave natural no se puede upsert
        fila = [str(uuid.uuid4())]  # id (uuid) para el caso INSERT
        for _, tipo, idx in CAMPOS:
            crudo = r[idx] if idx < len(r) else ""
            fila.append(convertir(tipo, crudo))
        filas.append(fila)
    return filas


# --------------------------------------------------------------------------- #
# Sincronización
# --------------------------------------------------------------------------- #
def sincronizar(dry_run=False):
    renglones = leer_sheet()
    filas = construir_filas(renglones)
    print(f"Sheet: {len(renglones)} renglones -> {len(filas)} con id_oportunidad")

    if dry_run:
        print("--dry-run: no se escribe nada.")
        return

    columnas = ["id"] + [c[0] for c in CAMPOS]
    col_sql = ", ".join(f'"{c}"' for c in columnas)
    # En conflicto (id_oportunidad ya existe y no está borrado) actualiza todo
    # menos id/id_oportunidad, y marca actualizado_en.
    set_sql = ", ".join(
        f'"{c[0]}" = EXCLUDED."{c[0]}"'
        for c in CAMPOS
        if c[0] != "id_oportunidad" and c[0] not in PROTEGIDOS
    )

    sql = (
        f'INSERT INTO "{ESQUEMA}"."{TABLA}" ({col_sql}) VALUES %s '
        f'ON CONFLICT ("id_oportunidad") WHERE borrado_en IS NULL '
        f'DO UPDATE SET {set_sql}, actualizado_en = now()'
    )

    cx = psycopg2.connect(db_url())
    try:
        cx.autocommit = False
        with cx.cursor() as cur:
            execute_values(cur, sql, filas, page_size=500)
        cx.commit()
        with cx.cursor() as cur:
            cur.execute(f'SELECT count(*) FROM "{ESQUEMA}"."{TABLA}"')
            total = cur.fetchone()[0]
        print(f"OK. Upsert de {len(filas)} filas. Total en tabla: {total}.")
    except Exception:
        cx.rollback()
        raise
    finally:
        cx.close()


if __name__ == "__main__":
    sincronizar(dry_run="--dry-run" in sys.argv)
