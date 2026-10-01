import re
import sys
import uuid
import gspread
import psycopg2
from datetime import datetime
from psycopg2.extras import execute_values
from google.oauth2.service_account import Credentials

# =========================================================================== #
#  CONFIGURACION  ---  LLENAR ESTO EN EL SERVIDOR
# =========================================================================== #
SHEET_ID = "19prg5YjbhXApoNt4UFMiv-01xELlUCv3SNqB5SOqTRQ"
TAB = "GEXT_OPERACION"
DB_URL = "postgresql://postgres.qpdxtfdwvyntkjvkipki:PEGAR_PASSWORD@aws-0-us-west-2.pooler.supabase.com:5432/postgres"
CRED_JSON = r"G:\Unidades compartidas\BDC Grupo Granauto\BDC Business Intelligence\credenciales\credencialesAI.json"
ESQUEMA = "datos_granauto"
TABLA = "garantias_extendidas"

# (nombre_tecnico en la tabla, tipo logico, indice de la columna en el Sheet)
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


# =========================================================================== #
#  LOGICA
# =========================================================================== #
def log(msg):
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def validar_config():
    faltan = []
    if "PEGAR_PASSWORD" in DB_URL:
        faltan.append("DB_URL (pega el password real)")
    if "ruta\\en\\la\\vm" in CRED_JSON or not CRED_JSON:
        faltan.append("CRED_JSON (pon la ruta local del credencialesAI.json)")
    if faltan:
        raise SystemExit("Falta configurar: " + "; ".join(faltan))


def convertir(tipo, crudo):
    """Convierte el texto del Sheet al valor que Postgres espera, o None."""
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
    return ws.get_all_values()[1:]  # sin encabezado


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


def sincronizar(dry_run=False):
    validar_config()
    log(f"Leyendo Sheet {SHEET_ID} / hoja {TAB} ...")
    renglones = leer_sheet()
    filas = construir_filas(renglones)
    log(f"Sheet: {len(renglones)} renglones -> {len(filas)} con id_oportunidad")

    if dry_run:
        log("--dry-run: no se escribe nada.")
        return

    columnas = ["id"] + [c[0] for c in CAMPOS]
    col_sql = ", ".join(f'"{c}"' for c in columnas)
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

    cx = psycopg2.connect(DB_URL)
    try:
        cx.autocommit = False
        with cx.cursor() as cur:
            execute_values(cur, sql, filas, page_size=500)
        cx.commit()
        with cx.cursor() as cur:
            cur.execute(f'SELECT count(*) FROM "{ESQUEMA}"."{TABLA}"')
            total = cur.fetchone()[0]
        log(f"OK. Upsert de {len(filas)} filas. Total en tabla: {total}.")
    except Exception as e:
        cx.rollback()
        log(f"ERROR, se revirtio todo: {e}")
        raise
    finally:
        cx.close()


if __name__ == "__main__":
    sincronizar(dry_run="--dry-run" in sys.argv)
