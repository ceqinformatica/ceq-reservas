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
Planilla de Google Sheets ──> pide las reservas al servidor cada hora
```

| Parte | Dónde está | Qué hace |
|---|---|---|
| Páginas (`index.html`, `cancelar.html`, `admin.html`) | Repo [`ceq-reservas-frontend`](https://github.com/ceqinformatica/ceq-reservas-frontend), publicado en **Vercel** como `reservas.ceq-una.com` | Lo que ve la gente. No guardan nada: todo lo piden al servidor. |
| Servidor (`server.js`) | Este repo, publicado en **Render** (servicio `ceq-reservas`, plan gratuito, Node.js 24) como `api.ceq-una.com` | Valida y guarda las reservas, manda los correos y atiende el panel. |
| Base de datos | **Supabase** (proyecto `reservas-ceq`, PostgreSQL 17, plan gratuito) | Guarda reservas, bloqueos, meses habilitados, reportes, qué espacios están abiertos y el registro de actividad del panel. Su estructura está en [`esquema-base-de-datos.sql`](esquema-base-de-datos.sql). |
| Correos | **Brevo**, remitente `reservas@ceq-una.com` | Confirmaciones, cancelaciones y avisos a los moderadores. |
| Monitoreo | **UptimeRobot**, cuenta `ceq.informatica@gmail.com` | Consulta `https://api.ceq-una.com/api/health` cada 5 minutos y avisa por correo si el sistema se cae. Además mantiene despiertos al servidor y a la base. |
| Planilla | **Google Sheets**, cuenta `ceq.informatica@gmail.com`, con el script [`sincronizar-reservas.gs`](sincronizar-reservas.gs) | Copia de todas las reservas que se actualiza sola cada hora, con resumen y una copia fija por mes (sección 5). |
| Dominio | `ceq-una.com` registrado en **Hosting PY**, DNS administrado en **Cloudflare** | Los registros `reservas` (Vercel) y `api` (Render) **no se tocan**. |

## 2. Accesos

Las contraseñas de estas cuentas se guardan en un documento privado de la Secretaría de Informática, **nunca en este repo**.

| Servicio | Cuenta |
|---|---|
| GitHub | organización `ceqinformatica` |
| Render | `ceq.informatica@gmail.com` (workspace "reservas ceq") |
| UptimeRobot | `ceq.informatica@gmail.com` |
| Vercel, Supabase, Brevo, Cloudflare, Hosting PY | completar con la cuenta de cada uno |
| Panel de administración | dos contraseñas: la del **admin** (moderadores) y la del **admin supremo** (solo quien administra el sistema). Ver sección 11 para cambiarlas. |

## 3. Variables de entorno (Render → servicio `ceq-reservas` → Environment)

| Variable | Obligatoria | Qué es |
|---|---|---|
| `SUPABASE_URL` | Sí | Dirección del proyecto de Supabase. |
| `SUPABASE_KEY` | Sí | Clave **service_role** de Supabase. Es secreta: da acceso total a la base. Nunca ponerla en las páginas. |
| `BREVO_API_KEY` | Sí | Clave de Brevo para mandar correos. |
| `JWT_SECRET` | Sí | Texto secreto con el que se firman las sesiones del panel. Si se cambia, se cierran todas las sesiones abiertas. |
| `ADMIN_PASSWORD_HASH` | Sí | La contraseña del panel (admin), cifrada (sección 11). |
| `SUPERADMIN_PASSWORD_HASH` | No | La contraseña del **admin supremo**, cifrada (sección 11). Tiene que ser distinta de la del admin. Si no está, nadie puede entrar como admin supremo y el panel funciona igual que antes. |
| `CLAVE_SINCRONIZACION` | No | Clave con la que la planilla de Google Sheets pide las reservas (sección 5). Al menos 32 caracteres al azar. Si no está, esa función queda apagada. Si se cambia, hay que guardarla de nuevo en la planilla. |
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
| Exportar a Excel | Exportar | Botones **Este mes**, **Mes pasado** y **Todo**, filtro por espacio y por estado. Trae una hoja **Resumen** (totales por espacio, turno, día de la semana y mes) y una hoja por espacio con todos los datos de cada reserva, con fechas reales y filtros. |
| **Copia de seguridad** | Planilla de Google Sheets | El plan gratuito de Supabase no guarda copias que se puedan recuperar. La planilla guarda sola una copia fija por mes (pestañas "Copia AAAA-MM"). Revisá de vez en cuando que la hora de "Última actualización" sea reciente. Si la planilla no está funcionando, **exportá a Excel una vez por mes**. |

### Admin supremo

Se entra al mismo panel, pero con la contraseña del admin supremo (`SUPERADMIN_PASSWORD_HASH`). Arriba dice **Admin supremo**, y además de todo lo anterior aparece:

| Qué | Dónde | Notas |
|---|---|---|
| Cuándo se hizo cada reserva, y cuándo, quién y por qué se canceló | Reservas → columna **Registro** (y el detalle de cada día en el calendario) | Las canceladas antes del 11/10/2026 dicen "sin datos". Quién: `usuario` (con su código), `moderador` o `admin supremo`. |
| Habilitar o deshabilitar el Frente o el Altillo | Avanzado → Espacios | Se marca o desmarca "Se puede reservar desde la página" y se escribe el aviso que ve la gente al entrar. Las reservas que ya existen no se tocan. |
| Eliminar reservas de la base | Avanzado → Eliminar reservas canceladas | Definitivo, para limpiar las de prueba. **Solo canceladas**: una activa primero se cancela (así la persona recibe el aviso). Pide escribir ELIMINAR. Si hace falta, exportá a Excel antes. |
| Eliminar reportes | Avanzado → Eliminar reportes de errores | Definitivo. |
| Ver qué se hizo en el panel | Avanzado → Registro de actividad | Últimos 300 movimientos: inicios de sesión (también los fallidos), cancelaciones, bloqueos, meses, reservas de prioridad, reportes leídos, espacios y eliminaciones, con fecha, hora y si fue el admin o el admin supremo. No guarda datos personales. |
| Cerrar todas las sesiones | Avanzado → Seguridad | Saca del panel a todos, incluido quien lo usa. Si se sospecha que alguien conoce una contraseña, cambiala también (sección 11). |

El admin normal no ve la pestaña Avanzado, y el servidor le rechaza esas acciones aunque intente hacerlas por otro lado.

### Planilla de Google Sheets (se actualiza sola)

Una planilla en la cuenta `ceq.informatica@gmail.com` tiene todas las reservas y se actualiza **cada hora** con el script [`sincronizar-reservas.gs`](sincronizar-reservas.gs). Pestañas:
- **Resumen:** hora de la última actualización, estado (OK o el error) y totales por espacio, turno, día de la semana y mes.
- **Reservas:** todas las reservas, una por fila, con filtros. Se reescribe en cada actualización: **no edites ahí**, porque se pierde. Para trabajar con los datos, copiá la pestaña.
- **Una pestaña por mes** ("Noviembre 2026", "Octubre 2026", …), del más nuevo al más viejo: las reservas de ese mes, con el mismo formato. También se reescriben (no editar ahí). Cada mes nuevo aparece solo; si un mes se queda sin reservas, su pestaña se borra.
- **Copia AAAA-MM:** foto fija tomada en la primera actualización de cada mes. Es la copia de seguridad: no se vuelve a tocar. Se guardan las últimas 24.

Tiene datos personales (nombre, celular, email): compartila **solo** con quienes administran el sistema, nunca con "cualquier persona con el enlace".

**Cómo funciona:** el script pide los datos a `https://api.ceq-una.com/api/sincronizacion/reservas`, que solo responde si recibe la clave `CLAVE_SINCRONIZACION` (sección 3). Esa dirección es de solo lectura: la planilla no puede cambiar nada del sistema.

**Armarla desde cero** (o si se pierde):
1. Generar una clave al azar en una computadora con Node.js: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Ponerla en Render como `CLAVE_SINCRONIZACION` y guardar.
2. Con la cuenta `ceq.informatica@gmail.com`, crear una planilla nueva en Google Sheets (por ejemplo, "Reservas CEQ").
3. **Extensiones → Apps Script.** Borrar lo que haya, pegar todo `sincronizar-reservas.gs` y **Guardar**.
4. Volver a la planilla y recargarla: aparece el menú **Reservas CEQ**.
5. **Reservas CEQ → 1. Guardar clave de sincronización** y pegar la clave. La primera vez Google pide autorización: elegir la cuenta, después **Configuración avanzada → Ir a (nombre del proyecto)** y **Permitir**. El aviso de "app no verificada" es normal en scripts propios. Si después de autorizar no aparece el cuadro para pegar la clave, tocá de nuevo la opción del menú.
6. **Reservas CEQ → Actualizar ahora**, para probar.
7. **Reservas CEQ → 2. Activar actualización automática (cada hora).**

Si falla la actualización automática, Google manda un correo a la cuenta. La causa más común es que la clave de Render y la de la planilla no coinciden: guardarla de nuevo con el paso 5.

## 6. Reglas del sistema y dónde se cambian

| Regla | Valor actual | Dónde |
|---|---|---|
| Espacios que se pueden reservar desde la página | Solo Frente (3). Altillo (1) se gestiona con planilla. | Panel → Avanzado → Espacios (admin supremo). Se guarda en la columna `publico` de la tabla `espacios` (ver sección 7). |
| Turnos del Frente | Desayuno 07–10, Almuerzo 10–13, Merienda 14–18 | `turnosValidosFrente` y `NOMBRES_TURNOS_FRENTE` en `server.js`, y los turnos en `index.html` |
| Días | Lunes a viernes, desde hoy, solo en meses habilitados | `server.js` (`POST /api/reservas`) |
| Límite por persona | 2 reservas activas por mes y por espacio (se reconoce a la persona por correo o por celular) | `MAX_RESERVAS_POR_PERSONA_MES` en `server.js` |
| Cancelación con código (Frente) | Hasta 2 días antes; después, por WhatsApp | `server.js` (`POST /api/cancelar-por-codigo`) |
| Límites por IP | Crear 30/hora, cancelar 20/hora, reportes 10/hora, consultas 1200 cada 5 min, login 5 intentos fallidos cada 15 min | Los `rateLimit` en `server.js` |
| Contacto del Frente | Correo y WhatsApp de la persona encargada | `CONTACTO_EMAIL_FRENTE` y `CONTACTO_WHATSAPP_FRENTE` en `server.js`, más el enlace `wa.me` del correo de cancelación fuera de plazo (`server.js`) y los dos enlaces de `cancelar.html`. Si cambia la persona, actualizar todos y `EMAIL_MODERADOR_FRENTE`. |
| Versión que se muestra | `v2.5a-34` | Pie de las tres páginas |

## 7. Reactivar el Altillo

Ya no hace falta tocar código:

1. Entrar al panel con la contraseña del **admin supremo** → pestaña **Avanzado** → **Espacios**.
2. En la tarjeta del Altillo, marcar **Se puede reservar desde la página** y tocar **Guardar**.
3. Abrir la página (o recargarla) y hacer una reserva de prueba en el Altillo (horario libre de 1 a 3 horas, entre 08:00 y 18:00). Después cancelarla y, si se quiere, eliminarla desde Avanzado.

Para volver a cerrarlo: desmarcar la casilla, escribir el aviso que tiene que ver la gente y **Guardar**. Lo mismo sirve para cerrar el Frente por un tiempo (por ejemplo, en vacaciones). La página muestra el aviso una vez por visita y el botón del espacio dice "No disponible"; el servidor rechaza cualquier reserva en un espacio cerrado.

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
| Google Apps Script | 20.000 consultas externas y 90 minutos de disparadores por día | La planilla usa 24 consultas por día y unos segundos cada vez. |
| Supabase (API) | Máximo 1000 filas por pedido | El servidor pide de a 1000 hasta traer todas (panel y planilla). |

## 10. Base de datos

La estructura completa está en [`esquema-base-de-datos.sql`](esquema-base-de-datos.sql): 8 tablas (`espacios`, `reservas`, `bloqueos`, `meses_habilitados`, `reportes_errores`, `registro_actividad`, `configuracion` y `cancelaciones`, que está en desuso). Los cambios que se le hicieron a una base ya existente quedan como archivos `migracion-*.sql` (por ejemplo, [`migracion-admin-supremo.sql`](migracion-admin-supremo.sql), aplicada el 11/10/2026); `esquema-base-de-datos.sql` ya los incluye.

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
- **Cambiar la contraseña del admin supremo:** igual, pero el resultado va en `SUPERADMIN_PASSWORD_HASH`. Tiene que ser distinta de la del admin (si fueran iguales, todos entrarían como admin supremo).
- **Cerrar todas las sesiones del panel** (por ejemplo, si alguien dejó una sesión abierta en una computadora ajena): como admin supremo, Avanzado → Seguridad → **Cerrar todas las sesiones**. Si no se puede entrar como admin supremo, cambiar `JWT_SECRET` en Render por otro texto largo al azar hace lo mismo.
- **Nunca** subir un archivo `.env` ni pegar claves en el código o en las páginas.

## 12. Pendientes conocidos

De la auditoría técnica del 24/07/2026 (la respuesta completa está en el Apéndice 1 del 6° informe de la Secretaría de Informática). Ninguno es un riesgo inmediato:

- Pruebas automáticas que corran solas en GitHub (TEST-001).
- Separar el JavaScript de las páginas y activar la política de seguridad CSP (SEC-004, ARCH-001).
- Que los códigos de cancelación venzan (SEC-005) y poder cerrar una sesión puntual del panel (AUTH-002; hoy se cierran todas juntas desde Avanzado → Seguridad).
- Evitar reservas duplicadas por reintentos con una clave de idempotencia (BUG-004).
- Guardar celular y correo en columnas separadas (VAL-002).
- Definir si se siguen mostrando los nombres en el calendario público (PRIV-001, decisión de la Comisión).
- Paginación del panel cuando haya muchas reservas (PERF-001). Hoy el panel ya trae todas de a 1000; con varios miles convendría mostrarlas por páginas.
