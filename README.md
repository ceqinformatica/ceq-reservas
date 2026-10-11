# Sistema de Reservas del CEQ: manual de mantenimiento

Sistema con el que los estudiantes reservan los espacios del Centro de Estudiantes de Química (CEQ-UNA).

- **Página pública:** https://reservas.ceq-una.com
- **Cancelar una reserva:** https://reservas.ceq-una.com/cancelar.html
- **Panel de administración:** https://reservas.ceq-una.com/admin.html

Este manual es para quien tenga que mantener el sistema. No hace falta saber programar para las tareas del día a día (secciones 5 a 8); las demás explican cómo está armado por si hay que cambiar algo.

> **Este repositorio es público.** Nunca escribas acá contraseñas, claves ni datos personales. Las claves van solo en Render (sección 3).

---

## 1. Cómo está armado

```
Estudiante ──> Páginas (Vercel) ──> Servidor (Render) ──> Base de datos (Supabase)
                                         └──> Correos (Brevo)
UptimeRobot ──> consulta el servidor cada 5 minutos
```

| Parte | Dónde está | Qué hace |
|---|---|---|
| Páginas (`index.html`, `cancelar.html`, `admin.html`) | Repo [`ceq-reservas-frontend`](https://github.com/ceqinformatica/ceq-reservas-frontend), publicado en **Vercel** como `reservas.ceq-una.com` | Lo que ve la gente. No guardan nada: todo lo piden al servidor. |
| Servidor (`server.js`) | Este repo, publicado en **Render** (servicio `ceq-reservas`, plan gratuito, Node.js 24) como `api.ceq-una.com` | Valida y guarda las reservas, manda los correos y atiende el panel. |
| Base de datos | **Supabase** (proyecto `reservas-ceq`, PostgreSQL 17, plan gratuito) | Guarda reservas, bloqueos, meses habilitados y reportes. Su estructura está en [`esquema-base-de-datos.sql`](esquema-base-de-datos.sql). |
| Correos | **Brevo**, remitente `reservas@ceq-una.com` | Confirmaciones, cancelaciones y avisos a los moderadores. |
| Monitoreo | **UptimeRobot**, cuenta `ceq.informatica@gmail.com` | Consulta `https://api.ceq-una.com/api/health` cada 5 minutos y avisa por correo si el sistema se cae. Además mantiene despiertos al servidor y a la base. |
| Dominio | `ceq-una.com` registrado en **Hosting PY**, DNS administrado en **Cloudflare** | Los registros `reservas` (Vercel) y `api` (Render) **no se tocan**. |

## 2. Accesos

Las contraseñas de estas cuentas se guardan en un documento privado de la Secretaría de Informática, **nunca en este repo**.

| Servicio | Cuenta |
|---|---|
| GitHub | organización `ceqinformatica` |
| Render | `ceq.informatica@gmail.com` (workspace "reservas ceq") |
| UptimeRobot | `ceq.informatica@gmail.com` |
| Vercel, Supabase, Brevo, Cloudflare, Hosting PY | completar con la cuenta de cada uno |
| Panel de administración | contraseña única del admin (ver sección 11 para cambiarla) |

## 3. Variables de entorno (Render → servicio `ceq-reservas` → Environment)

| Variable | Obligatoria | Qué es |
|---|---|---|
| `SUPABASE_URL` | Sí | Dirección del proyecto de Supabase. |
| `SUPABASE_KEY` | Sí | Clave **service_role** de Supabase. Es secreta: da acceso total a la base. Nunca ponerla en las páginas. |
| `BREVO_API_KEY` | Sí | Clave de Brevo para mandar correos. |
| `JWT_SECRET` | Sí | Texto secreto con el que se firman las sesiones del panel. Si se cambia, se cierran todas las sesiones abiertas. |
| `ADMIN_PASSWORD_HASH` | Sí | La contraseña del panel, cifrada (sección 11). |
| `EMAIL_MODERADOR` | No | Correo que recibe los avisos generales y los reportes. Por defecto, `ceq.informatica@gmail.com`. |
| `EMAIL_MODERADOR_FRENTE` | No | Correo que además recibe los avisos del Frente. |
| `EMAILS_SIN_LIMITE` | No | Correos que no tienen el límite de 2 reservas por mes (para hacer pruebas), separados por coma. |

Si falta una obligatoria, el servidor no arranca y lo dice en los Logs de Render.

## 4. Cómo subir cambios

1. En GitHub, editá el archivo con el lápiz, o usá **Add file → Upload files** para reemplazar varios a la vez, y hacé **Commit**.
2. Render (servidor) y Vercel (páginas) publican solos en 1 a 3 minutos.
3. Verificá:
   - Render → **Events**: el último deploy tiene que decir **Live**. En los registros de la compilación tiene que aparecer `Using Node.js version 24…`.
   - `https://api.ceq-una.com/api/health` tiene que responder `{"status":"ok","db":"ok"}`.
   - Abrí la página y probá lo que cambiaste.
4. **Si algo salió mal:** en Render → Events, elegí el deploy anterior y usá **Rollback** para volver a la versión que andaba. En GitHub, el historial de cada archivo permite recuperar cualquier versión anterior.

**Librerías:** `package-lock.json` fija las versiones exactas de las librerías del servidor, así cada deploy instala lo mismo que se probó. **No lo borres.** Para actualizarlas hace falta una computadora con Node.js 24: `npm update`, probar, y subir `package.json` y `package-lock.json` juntos. Si alguna vez Render avisa de vulnerabilidades por librerías viejas, usá **Manual Deploy → Clear build cache & deploy**.

## 5. Tareas frecuentes (panel de administración)

| Tarea | Dónde | Notas |
|---|---|---|
| Habilitar un mes | Meses | Los meses habilitados tienen que quedar **seguidos** (no se puede habilitar septiembre y noviembre sin octubre). Conviene habilitar el mes siguiente unos días antes de que termine el actual. |
| Bloquear un día u horario | Bloqueos | No se puede bloquear una fecha pasada ni un horario con reservas activas: primero hay que cancelarlas. |
| Reserva de prioridad (Comisión Directiva) | Prioridad | Solo Frente. Se puede hacer aunque el mes no esté habilitado y no cuenta para el límite por persona. Le llega la confirmación al correo que se cargue. |
| Cancelar una reserva | Reservas → Cancelar | Pide un motivo; se avisa por correo a quien reservó y a los moderadores. Así se ayuda a quien perdió su código. |
| Revisar reportes | Reportes | Cada reporte nuevo también llega por correo a `EMAIL_MODERADOR` (hasta 20 avisos por día). Marcalos como leídos. |
| **Copia de seguridad** | Exportar | **Exportar a Excel una vez por mes.** El plan gratuito de Supabase no guarda copias que se puedan recuperar. |

## 6. Reglas del sistema y dónde se cambian

| Regla | Valor actual | Dónde |
|---|---|---|
| Espacios que se pueden reservar desde la página | Solo Frente (3). Altillo (1) se gestiona con planilla. | `ESPACIOS_PUBLICOS` en `server.js` (ver sección 7) |
| Turnos del Frente | Desayuno 07–10, Almuerzo 10–13, Merienda 14–18 | `turnosValidosFrente` y `NOMBRES_TURNOS_FRENTE` en `server.js`, y los turnos en `index.html` |
| Días | Lunes a viernes, desde hoy, solo en meses habilitados | `server.js` (`POST /api/reservas`) |
| Límite por persona | 2 reservas activas por mes y por espacio (se reconoce a la persona por correo o por celular) | `MAX_RESERVAS_POR_PERSONA_MES` en `server.js` |
| Cancelación con código (Frente) | Hasta 2 días antes; después, por WhatsApp | `server.js` (`POST /api/cancelar-por-codigo`) |
| Límites por IP | Crear 30/hora, cancelar 20/hora, reportes 10/hora, consultas 1200 cada 5 min, login 5 intentos fallidos cada 15 min | Los `rateLimit` en `server.js` |
| Contacto del Frente | Correo y WhatsApp de la persona encargada | `CONTACTO_EMAIL_FRENTE` y `CONTACTO_WHATSAPP_FRENTE` en `server.js`, más el enlace `wa.me` del correo de cancelación fuera de plazo (`server.js`) y los dos enlaces de `cancelar.html`. Si cambia la persona, actualizar todos y `EMAIL_MODERADOR_FRENTE`. |
| Versión que se muestra | `v2.5a-34` | Pie de las tres páginas |

## 7. Reactivar el Altillo

1. `server.js`: cambiar `const ESPACIOS_PUBLICOS = [3];` por `[1, 3]`.
2. `index.html` (repo de las páginas): en el botón del Altillo (`data-espacio="1"`), quitar `disabled`, `aria-disabled="true"`, el `title`, la clase `no-disponible` y el texto `<span>No disponible</span>`.
3. `index.html`: borrar el bloque "Mostrar el aviso de Altillo una vez por sesión" (al final del archivo), para que deje de aparecer el aviso de que se reserva con planilla.
4. Subir los dos repos y hacer una reserva de prueba en el Altillo (horario libre de 1 a 3 horas, entre 08:00 y 18:00).

## 8. Si algo falla

**Llega un correo "Monitor is DOWN" de UptimeRobot** (si el asunto empieza con "TEST:", es una prueba). Si enseguida llega "Monitor is UP", fue un corte de segundos. Si sigue caído:

1. Abrí `https://api.ceq-una.com/api/health`.
   - `{"status":"error","db":"error"}` → problema en **Supabase**. Entrá al panel de Supabase: si el proyecto está pausado, tocá **Restore**.
   - No responde → problema en **Render**. Mirá **Events** (¿falló un deploy?) y **Logs**. Si el problema empezó con un deploy, hacé **Rollback**.
   - Responde bien pero la página no carga → problema en **Vercel**.
2. **"No se pudo conectar con el servidor" o error 429 en la página:** en Render → Logs, buscá `429 rate limit`. Si las IP que aparecen empiezan con `10.`, Render dejó de mandar la IP real del visitante: revisar `obtenerIpCliente()` en `server.js`.
3. **No llegan los correos:** en Render → Logs, buscá `enviar email`, y en el panel de Brevo revisá el registro de envíos y el límite diario.

## 9. Límites de los planes gratuitos

| Servicio | Límite | Qué implica |
|---|---|---|
| Render | 750 horas por mes por cuenta; se duerme tras 15 min sin uso | El monitor lo mantiene despierto (unas 744 horas al mes). **No crear otro servicio gratuito en la misma cuenta**, porque no alcanzarían las horas. |
| Supabase | Se pausa tras 7 días sin actividad; 500 MB; sin copias recuperables | El monitor evita la pausa. Exportar a Excel una vez por mes. |
| Brevo | 300 correos por día en total | Cada reserva manda 2 o 3. Los avisos de reportes tienen un tope propio de 20 por día. |
| UptimeRobot | Revisa cada 5 minutos | Una caída se detecta con hasta 5 minutos de demora. |

## 10. Base de datos

La estructura completa está en [`esquema-base-de-datos.sql`](esquema-base-de-datos.sql): 6 tablas (`espacios`, `reservas`, `bloqueos`, `meses_habilitados`, `reportes_errores` y `cancelaciones`, que está en desuso).

Protecciones que viven en la base (además de las del servidor):
- **`no_solapamiento_activo`:** dos reservas activas del mismo espacio no pueden superponerse, aunque lleguen al mismo instante.
- **Triggers:** no se puede reservar sobre un bloqueo (error `CEQ01`) ni bloquear sobre una reserva activa (error `CEQ02`).
- **Seguridad (RLS) activada sin políticas:** solo el servidor, con la clave service_role, puede leer y escribir.
- Los códigos de cancelación se guardan cifrados: **no se pueden recuperar**, ni siquiera desde la base.

**Para recrear la base** (por ejemplo, si hubiera que pasar a otro proyecto de Supabase): crear el proyecto, abrir el **SQL Editor**, pegar y ejecutar `esquema-base-de-datos.sql`, actualizar `SUPABASE_URL` y `SUPABASE_KEY` en Render, y habilitar los meses desde el panel. Las reservas viejas no se recuperan con este archivo (para eso están las exportaciones a Excel).

Si se cambia la estructura en Supabase, actualizar también ese archivo.

## 11. Seguridad

- **Cambiar la contraseña del panel:** en una computadora con Node.js 24, en una copia de este repo, ejecutar `npm install` y después:
  ```
  node -e "console.log(require('bcryptjs').hashSync('LA-NUEVA-CONTRASEÑA', 10))"
  ```
  Copiar el resultado (empieza con `$2`) en `ADMIN_PASSWORD_HASH` en Render y guardar. La contraseña en sí no se guarda en ningún lado.
- **Cerrar todas las sesiones del panel** (por ejemplo, si alguien dejó una sesión abierta en una computadora ajena): cambiar `JWT_SECRET` en Render por otro texto largo al azar.
- **Nunca** subir un archivo `.env` ni pegar claves en el código o en las páginas.

## 12. Pendientes conocidos

De la auditoría técnica del 24/07/2026 (la respuesta completa está en el Apéndice 1 del 6° informe de la Secretaría de Informática). Ninguno es un riesgo inmediato:

- Pruebas automáticas que corran solas en GitHub (TEST-001).
- Separar el JavaScript de las páginas y activar la política de seguridad CSP (SEC-004, ARCH-001).
- Que los códigos de cancelación venzan (SEC-005) y poder cerrar una sesión puntual del panel (AUTH-002; hoy se cierran todas cambiando `JWT_SECRET`).
- Evitar reservas duplicadas por reintentos con una clave de idempotencia (BUG-004).
- Guardar celular y correo en columnas separadas (VAL-002).
- Definir si se siguen mostrando los nombres en el calendario público (PRIV-001, decisión de la Comisión).
- Paginación del panel cuando haya muchas reservas (PERF-001).
