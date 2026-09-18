# Credenciales

Todo lo que esta en esta carpeta queda fuera de git (`.gitignore`: `secrets/*`,
salvo este archivo y `.gitkeep`).

## bigquery-service-account.json

JSON de la cuenta de servicio de Google Cloud. `backend/.env` lo apunta con
ruta relativa a la raiz del proyecto:

    GOOGLE_APPLICATION_CREDENTIALS=secrets/bigquery-service-account.json

Permisos del archivo restringidos al usuario actual (sin herencia).

## Advertencia

Esta carpeta vive dentro de OneDrive, asi que el JSON se sincroniza a la nube.
Si quieres que la llave no salga de esta maquina, muevela a una ruta fuera de
OneDrive (ej. C:\Users\famil\.secrets\) y pon la ruta absoluta en
GOOGLE_APPLICATION_CREDENTIALS. El codigo acepta ambas formas.
