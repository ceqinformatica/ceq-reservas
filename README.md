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
3. **Pruebas automáticas:** con cada cambio, GitHub corre solo unas 300 pruebas (ver [`pruebas/`](pruebas/README.md)). En la página del repo, al lado del último cambio, aparece una ✅ (todo bien) o una ❌ (algo se rompió: entrá a **Actions** para ver qué). Si Render está configurado con **Auto-Deploy: After CI Checks Pass**, un cambio con ❌ ni siquiera se publica.
4. Verificá:
   - Render → **Events**: el último deploy tiene que decir **Live**. En los registros de la compilación tiene que aparecer `Using Node.js version 24…`.
   - `https://api.ceq-una.com/api/health` tiene que responder `{"status":"ok","db":"ok"}`.
   - Abrí la página y probá lo que cambiaste.
5. **Si algo salió mal:** en Render → Events, elegí el deploy anterior y usá **Rollback** para volver a la versión que andaba. En GitHub, el historial de cada archivo permite recuperar cualquier versión anterior.

**Librerías:** `package-lock.json` fija las versiones exactas de las librerías del servidor, así cada deploy instala lo mismo que se probó. **No lo borres.** Para actualizarlas hace falta una computadora con Node.js 24: `npm update`, probar, y subir `package.json` y `package-lock.json` juntos. Si alguna vez Render avisa de vulnerabilidades por librerías viejas, usá **Manual Deploy → Clear build cache & deploy**.

## 5. Tareas frecuentes (panel de administración)

| Tarea | Dónde | Notas |
|---|---|---|
| Habilitar un mes | Meses | Los meses habilitados tienen que quedar **seguidos** (no se puede habilitar septiembre y noviembre sin octubre). Conviene habilitar el mes siguiente unos días antes de que termine el actual. |
| **Programar la apertura de un mes** | Meses → Programar la apertura de un mes | Se elige el mes (el que sigue al último habilitado) y la fecha y hora (de Paraguay). A esa hora exacta se abre solo, aunque nadie esté conectado, y la página muestra mientras tanto una cuenta regresiva. Se puede cancelar desde la misma pantalla. Habilitar o deshabilitar el mes a mano borra la programación. |
| Buscar a una persona | Reservas → "Buscar persona" | Por nombre (sin importar tildes), email o celular (con o sin espacios). Muestra un resumen: próximas, pasadas, canceladas y asistencia. |
| Marcar asistencia | Reservas → botones **✓ Vino / ✗ No vino** | Aparecen en las reservas activas cuyo día ya llegó (también en el detalle del calendario). Tocar la opción marcada la borra. Sale en el Excel y en la planilla. |
| Bloquear un día u horario | Bloqueos | No se puede bloquear una fecha pasada ni un horario con reservas activas: primero hay que cancelarlas. El horario tiene que estar dentro del espacio: el Frente, entre el primer y el último turno; el Altillo, de 07:00 a 19:00. |
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
| Habilitar o deshabilitar el Frente o el Altillo | Avanzado → Espacios | Se marca o desmarca "Se puede reservar desde la página" y se escribe el aviso que ve la gente al entrar. Si se desmarca "Mostrar este aviso al entrar a la página", el espacio se deshabilita sin ninguna ventana (el texto queda guardado). Las reservas que ya existen no se tocan. |
| Anunciar novedades al entrar a la página | Avanzado → Ventana de novedades | Título, introducción, hasta 6 bloques (título + texto) y texto final, con vista previa. **Publicar** con "Mostrarla de nuevo" la ve todo el mundo otra vez; sin esa casilla solo se corrige el texto. **Quitar de la página** la oculta sin borrarla. Las frases "Términos y condiciones" y "Política de privacidad" se convierten solas en enlaces. Se guarda en la tabla `configuracion` (claves `ventana_novedades` y `avisos_ocultos`). |
| Eliminar reservas de la base | Avanzado → Eliminar reservas canceladas | Definitivo, para limpiar las de prueba. **Solo canceladas**: una activa primero se cancela (así la persona recibe el aviso). Pide escribir ELIMINAR. Si hace falta, exportá a Excel antes. |
| Eliminar reportes | Avanzado → Eliminar reportes de errores | Definitivo. |
| Ver qué se hizo en el panel | Avanzado → Registro de actividad | Últimos 300 movimientos: inicios de sesión (también los fallidos), cancelaciones, bloqueos, meses, reservas de prioridad, reportes leídos, espacios y eliminaciones, con fecha, hora y si fue el admin o el admin supremo. No guarda datos personales. |
| Cerrar todas las sesiones | Avanzado → Seguridad | Saca del panel a todos, incluido quien lo usa. Si se sospecha que alguien conoce una contraseña, cambiala también (sección 11). |
| Cambiar turnos, límite por persona, contacto del Frente y correo de alertas | Avanzado → Configuración | Se aplica al instante en la página, el servidor y los correos. Hasta 5 turnos, entre las 06:00 y las 22:00, sin superponerse. Cambiar un turno no toca las reservas que ya existen (se siguen mostrando con su horario). |
| Alertas por correo | Automático | Si hay errores del servidor o bloqueos 429, llega un correo al "correo de alertas" de la Configuración: como máximo uno por hora, y solo si pasó algo. |

El admin normal no ve la pestaña Avanzado, y el servidor le rechaza esas acciones aunque intente hacerlas por otro lado.

### Correos automáticos y lista de espera

- **Recordatorio 2 días antes:** a las 08:00 del día en que todavía se puede cancelar gratis, llega un correo con un botón **Cancelar mi reserva** (no hace falta el código). Para el Frente dice que es el último día para cancelar gratis. No se manda a las reservas de prioridad ni a las hechas en las últimas 12 horas.
- **Enlace para cancelar:** el correo de confirmación y el recordatorio traen un enlace firmado que cancela esa reserva (con las mismas reglas que el código). Si se cambia `JWT_SECRET`, los enlaces viejos dejan de andar; el código sigue sirviendo.
- **Lista de espera (general):** cuando en un espacio ya no queda ningún lugar libre en los meses habilitados, la página muestra "Ya no hay reservas disponibles" y la persona puede dejar su correo. Si después alguien cancela cualquier reserva de ese espacio (con código, con enlace o desde el panel), se avisa a todos los anotados a la vez, con el día y turno que se liberó y un enlace directo; el lugar es de quien reserve primero. Cada inscripción se avisa una sola vez (para otro aviso hay que volver a anotarse); hay un máximo de 60 avisos por día, y las inscripciones sin avisar se borran a los 60 días.

- **"Responder a":** los correos salen de `reservas@ceq-una.com`, que no tiene buzón. Por eso todos llevan un "Responder a": si la persona responde un correo del Frente, le llega al contacto del Frente (Configuración); si es del Altillo, a `ceq.informatica@gmail.com`. Si un moderador responde un aviso de reserva o cancelación, le escribe directo a la persona que reservó.

### Copia de seguridad mensual (llega sola por correo)

Supabase gratis no guarda copias que se puedan descargar. Por eso, el **día 1° de cada mes a las 08:00** el servidor manda al **correo de alertas** (Avanzado → Configuración) un archivo `reservas-ceq-AAAA-MM.csv` con **todas** las reservas y todos sus datos (también celulares, correos, acompañantes y cancelaciones). Se abre con Excel o Google Sheets.

**Qué hacer cuando llega:** nada; la copia queda en el correo. **No guardarla en otro lado**: la Política de Privacidad dice que las copias se conservan como máximo 6 meses, y el script `google-sheets/limpiar-copias-de-seguridad.gs` (un proyecto de Apps Script aparte en la cuenta ceq.informatica, con un activador diario) manda a la papelera las de más de 6 meses. Para instalarlo: script.google.com → Nuevo proyecto → pegar el código → ejecutar `activarLimpiezaDiaria` y autorizar (en Chrome). Tiene datos personales: no reenviarlo. Si un mes no llega, revisar Render → Logs (buscar `copia mensual`). El mes ya enviado queda anotado en la tabla `configuracion` (clave `copia_mensual_enviada`): para que se vuelva a mandar, borrá esa fila.

### Planilla de Google Sheets (se actualiza sola)

Una planilla en la cuenta `ceq.informatica@gmail.com` tiene todas las reservas y se actualiza **cada hora** con el script [`sincronizar-reservas.gs`](sincronizar-reservas.gs). Pestañas:
- **Resumen:** hora de la última actualización, estado (OK o el error) y totales por espacio, turno, día de la semana y mes.
- **Reservas:** todas las reservas, una por fila, con filtros. Se reescribe en cada actualización: **no edites ahí**, porque se pierde. Para trabajar con los datos, copiá la pestaña.
- **Una pestaña por mes** ("Noviembre 2026", "Octubre 2026", …), del más nuevo al más viejo: las reservas de ese mes, con el mismo formato. También se reescriben (no editar ahí). Cada mes nuevo aparece solo; si un mes se queda sin reservas, su pestaña se borra.
- **Copia AAAA-MM:** foto fija tomada en la primera actualización de cada mes. Es la copia de seguridad. Se borra cuando tiene más de 6 meses y, mientras tanto, las reservas que pasan ese plazo quedan sin nombre, acompañantes ni motivo libre (Política de Privacidad).

Columnas: N°, Fecha, Día, Espacio, Turno, Inicio, Fin, Nombre, Motivo, Acompañantes (solo nombres), Estado, Asistencia y Creada. **No trae celulares, correos, prioridad ni datos de cancelación**: el servidor ni siquiera se los manda (para eso están el panel y su Excel). Las "personas distintas" del Resumen se cuentan con un código anónimo que manda el servidor. Las copias guardadas antes de este cambio se limpiaron solas (se borraron esas columnas).

Igual tiene nombres: compartila **solo** con quienes administran el sistema, nunca con "cualquier persona con el enlace".

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
| Turnos del Frente | Desayuno 07–10, Almuerzo 10–13, Merienda 14–18 | Panel → Avanzado → Configuración (admin supremo). Se guarda en la tabla `configuracion`. |
| Motivo en el Frente | Se elige de una lista: Actividad Personal; Recaudación - Asociación Estudiantil; Recaudación - Secretaría CEQ; Recaudación - Padrinaje; Recaudación - Congreso o Evento Académico. En el Altillo el motivo es libre. | `MOTIVOS_FRENTE` en `server.js` (la página la toma de ahí) |
| Horario del Altillo | Bloques de 1 hora de 07:00 a 19:00 (el último empieza a las 18:00), de 1 a 2 horas por reserva. Hoy se puede tomar el bloque en curso mientras no haya terminado (a las 11:30, el de las 11:00 sí; a las 12:00, ya no). | `ALTILLO_HORA_DESDE`, `ALTILLO_HORA_HASTA` y `ALTILLO_MAX_HORAS` en `server.js` (la página los toma de ahí) |
| Acompañantes | Solo en el Altillo (en el Frente no se piden). Opcional, hasta 4 por reserva, con nombre y celular. Se ven en el panel, el Excel y los correos (en la planilla, solo los nombres); nunca en la página pública. | `MAX_ACOMPANANTES` en `server.js` y el límite `reservas_acompanantes_validos` de la base |
| Días | Lunes a viernes, desde hoy, solo en meses habilitados | `server.js` (`POST /api/reservas`) |
| Límite por persona | Solo en el Frente: 2 reservas activas por mes (se reconoce a la persona por correo o por celular). El Altillo no tiene límite. No cuentan las canceladas ni las de prioridad del panel. La base cuenta y guarda en un solo paso (función `crear_reserva_con_cupo`), así varios pedidos al mismo tiempo no pasan el límite. | Panel → Avanzado → Configuración (admin supremo) |
| Cancelación con código o enlace (Frente) | Hasta 2 días antes; después, por WhatsApp | `cancelarComoUsuario()` en `server.js` |
| Límites por IP | Crear 30/hora, cancelar 20/hora, reportes 10/hora, consultas 1200 cada 5 min, login 5 intentos fallidos cada 15 min | Los `rateLimit` en `server.js` |
| Contacto del Frente | Correo y WhatsApp de la persona encargada | Panel → Avanzado → Configuración (admin supremo): se actualiza en los correos y en las páginas. Si cambia la persona, cambiar también `EMAIL_MODERADOR_FRENTE` en Render (avisos internos). |
| Límites de la lista de espera | 15 inscripciones por hora por IP, una por correo y espacio, 60 avisos por día, vigencia de 60 días | `listaEsperaLimiter`, `MAX_AVISOS_LISTA_ESPERA_POR_DIA` y `DIAS_VIGENCIA_LISTA_ESPERA` en `server.js` |
| Versión que se muestra | `v2.5a-34` | Pie de las tres páginas |

## 7. Reactivar el Altillo

Ya no hace falta tocar código:

1. Entrar al panel con la contraseña del **admin supremo** → pestaña **Avanzado** → **Espacios**.
2. En la tarjeta del Altillo, marcar **Se puede reservar desde la página** y tocar **Guardar**.
3. Abrir la página (o recargarla) y hacer una reserva de prueba en el Altillo (de 1 a 2 horas, entre 07:00 y 19:00). Después cancelarla y, si se quiere, eliminarla desde Avanzado.

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
| Supabase | Se pausa tras 7 días sin actividad; 500 MB; sin copias recuperables | El monitor evita la pausa. La copia de seguridad llega sola por correo el 1° de cada mes. |
| Brevo | 300 correos por día en total | Cada reserva manda 2 o 3, más 1 recordatorio. Los avisos de reportes tienen un tope propio de 20 por día y los de lista de espera, de 60. |
| UptimeRobot | Revisa cada 5 minutos | Una caída se detecta con hasta 5 minutos de demora. |
| Google Apps Script | 20.000 consultas externas y 90 minutos de disparadores por día | La planilla usa 24 consultas por día y unos segundos cada vez. |
| Supabase (API) | Máximo 1000 filas por pedido | El servidor pide de a 1000 hasta traer todas (panel y planilla). |

## 10. Base de datos

La estructura completa está en [`esquema-base-de-datos.sql`](esquema-base-de-datos.sql): 9 tablas (`espacios`, `reservas`, `bloqueos`, `meses_habilitados`, `reportes_errores`, `registro_actividad`, `configuracion`, `lista_espera` y `cancelaciones`, que está en desuso). Los cambios que se le hicieron a una base ya existente quedan como archivos `migracion-*.sql` ([`migracion-admin-supremo.sql`](migracion-admin-supremo.sql), [`migracion-funciones-octubre.sql`](migracion-funciones-octubre.sql) y [`migracion-acompanantes-y-lista-espera.sql`](migracion-acompanantes-y-lista-espera.sql), del 11/10/2026); `esquema-base-de-datos.sql` ya los incluye.

**Tareas automáticas:** cada 5 minutos el servidor abre los meses programados, manda los recordatorios del día, limpia la lista de espera vieja, manda la copia de seguridad del mes (una vez por mes), aplica los plazos de conservación de la Política de Privacidad (una vez por día: borra nombre, contacto, acompañantes y textos libres de las reservas de hace más de 6 meses, y borra los reportes de hace más de 6 meses; si se cambia ese plazo, cambiar también `privacidad.html`), relee la configuración y manda las alertas pendientes (ver `tareasPeriodicas()` en `server.js`). Funciona porque UptimeRobot mantiene el servidor despierto.

Protecciones que viven en la base (además de las del servidor):
- **`no_solapamiento_activo`:** dos reservas activas del mismo espacio no pueden superponerse, aunque lleguen al mismo instante.
- **Triggers:** no se puede reservar sobre un bloqueo (error `CEQ01`) ni bloquear sobre una reserva activa (error `CEQ02`).
- **Tabla `correos_pendientes`** (migración `migracion-cola-correos.sql`): cola de correos. Las confirmaciones, avisos a moderadores, cancelaciones, recordatorios y avisos de reportes se guardan acá y después se mandan; si Brevo falla, el servidor reintenta a los 1, 5, 15, 60 y 180 minutos (y retoma los pendientes si se reinicia). Al enviarse se borra el contenido; las filas se borran a los 7 días. Si un correo falla 6 veces queda en estado `fallido` (con destinatario y asunto) y aparece en el correo de alertas. Para ver si hubo alguno: Supabase → Table Editor → `correos_pendientes`, filtrar `estado = fallido`. Si la tabla no existe, el servidor manda directo, como antes.
- **Función `crear_reserva_con_cupo`** (migración `migracion-cupo-atomico.sql`): el servidor guarda las reservas públicas con ella. Con un candado por espacio y mes, cuenta las reservas activas del mes de la persona (sin las de prioridad) y guarda en la misma transacción; si llegó al límite, responde el error `CEQ03`. Solo la puede usar el servidor (`service_role`).
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

- Separar el JavaScript de las páginas y activar la política de seguridad CSP (SEC-004, ARCH-001).
- Que los códigos de cancelación venzan (SEC-005) y poder cerrar una sesión puntual del panel (AUTH-002; hoy se cierran todas juntas desde Avanzado → Seguridad).
- Evitar reservas duplicadas por reintentos con una clave de idempotencia (BUG-004).
- Guardar celular y correo en columnas separadas (VAL-002).
- Definir si se siguen mostrando los nombres en el calendario público (PRIV-001, decisión de la Comisión).
- Paginación del panel cuando haya muchas reservas (PERF-001). Hoy el panel ya trae todas de a 1000; con varios miles convendría mostrarlas por páginas.
