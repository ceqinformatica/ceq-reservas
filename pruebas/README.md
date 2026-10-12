# Pruebas automáticas del servidor

Unas 300 pruebas que comprueban que el sistema funciona: reservas, cancelaciones, lista de espera, correos, panel, admin supremo, planilla de Google Sheets, copia mensual y las reglas de la base de datos.

**GitHub las corre solas** cada vez que se sube un cambio a este repo (archivo [`.github/workflows/pruebas.yml`](../.github/workflows/pruebas.yml)). El resultado se ve en la pestaña **Actions** del repo, o al lado del último cambio en la página principal:

- ✅ tilde verde: todo bien.
- ❌ cruz roja: algo se rompió. Entrá a **Actions → la ejecución con la cruz → Correr todas las pruebas** y vas a ver qué prueba falló y por qué.

Ninguna prueba toca la base real, ni manda correos, ni usa claves de verdad: cada una levanta el `server.js` real contra una base de datos simulada en memoria, con los correos interceptados y, cuando hace falta, un reloj falso (por ejemplo, para probar el recordatorio de 2 días antes o la copia del día 1°).

## Correrlas en una computadora

Con Node.js 24, en una copia de este repo:

```
npm ci
npm install --no-save @electric-sql/pglite@0.5.8
node pruebas/correr-todas.js
```

Tarda unos 3 minutos. Al final dice `✅ Todo bien: N pruebas` o qué grupo falló.

## Qué hay en esta carpeta

| Archivo | Qué prueba |
|---|---|
| `correr-todas.js` | Corre todos los grupos de abajo, uno detrás de otro. |
| `probar_servidor.js` | Arranque, salud, reservas, bloqueos y reportes. |
| `probar_superadmin.js` | Panel: contraseñas, sesiones, CSRF, admin y admin supremo. |
| `probar_funciones_octubre.js` | Configuración, aperturas programadas, recordatorios, cancelar con enlace, lista de espera, asistencia y alertas. |
| `probar_sincronizacion.js` | La ruta de la planilla y el script de Google Sheets (con un Google simulado). |
| `probar_frente_correos.js` | Correos de confirmación (regla de cancelación del Frente y Google Calendar). |
| `probar_altillo_servidor.js` | Horario del Altillo, motivos del Frente y acompañantes. |
| `probar_copia_y_responder.js` | Copia de seguridad mensual por correo y "Responder a" de los correos. |
| `probar_retencion.js` | Plazos de conservación de la Política de Privacidad: anonimizar reservas de más de 2 años y borrar reportes de más de 1 año. |
| `probar_esquema.js` | Que `esquema-base-de-datos.sql` se pueda crear desde cero y que sus reglas funcionen (sin superposiciones, bloqueos, acompañantes, etc.). |
| `mini_postgrest.js`, `reloj_falso.js`, `interceptar_brevo.js` | Ayudantes: base simulada, reloj falso y correos interceptados. |

## Si cambiás el servidor

Si cambiás una regla a propósito (por ejemplo, el máximo de horas del Altillo), la prueba de esa regla va a fallar: hay que actualizarla también, en el mismo cambio. Si falla una prueba de algo que **no** quisiste cambiar, es que el cambio rompió algo: no lo subas hasta entender por qué.
