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
| Cloudflare (DNS y correo de `reservas@ceq-una.com`) | `Oficialceq@gmail.com` |
| Vercel, Supabase, Brevo, Hosting PY | completar con la cuenta de cada uno (ver sección 13, "Traspaso") |
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

Si falta una obligatoria, el servidor no arranca y lo dice en los Logs de Render.

## 4. Cómo subir cambios

1. En GitHub, editá el archivo con el lápiz, o usá **Add file → Upload files** para reemplazar varios a la vez, y hacé **Commit**.
2. Render (servidor) y Vercel (páginas) publican solos en 1 a 3 minutos.
3. **Pruebas automáticas:** con cada cambio, GitHub corre solo unas 690 pruebas (ver [`pruebas/`](pruebas/README.md)). En la página del repo, al lado del último cambio, aparece una ✅ (todo bien) o una ❌ (algo se rompió: entrá a **Actions** para ver qué). Render está configurado con **Auto-Deploy: After CI Checks Pass** (desde el 23/10/2026): un cambio con ❌ no se publica y queda en línea la versión anterior. Por eso, si se cambian el servidor y las pruebas juntos, el servidor se publica recién cuando sube el cambio de las pruebas y todo da ✅. Además, Render solo pasa el tráfico a una versión nueva si `/api/health` responde bien (Health Check Path), e instala las librerías con `npm ci` (exactamente las de `package-lock.json`).
4. Verificá:
   - Render → **Events**: el último deploy tiene que decir **Live**. En los registros de la compilación tiene que aparecer `Using Node.js version 24…`.
   - `https://api.ceq-una.com/api/health` tiene que responder `{"status":"ok","db":"ok"}`.
   - Abrí la página y probá lo que cambiaste.
5. **Si algo salió mal:** en Render → Events, elegí el deploy anterior y usá **Rollback** para volver a la versión que andaba. En GitHub, el historial de cada archivo permite recuperar cualquier versión anterior.

**Dependabot** (`.github/dependabot.yml`): una vez por mes, GitHub revisa si hay versiones nuevas de las librerías y abre una propuesta de cambio (pestaña **Pull requests**). Las actualizaciones chicas (menores y parches) vienen juntas en una sola propuesta ("librerias"); cada versión **mayor** (por ejemplo, Express 5) viene aparte y hay que revisarla con calma aunque las pruebas den ✅, porque puede cambiar cómo funciona algo. Las pruebas corren solas sobre la propuesta: si dan ✅, se acepta con **Merge pull request** (y Render la publica); si dan ❌, se cierra sin aceptar. Mientras nadie la acepte, no cambia nada.

**Librerías:** `package-lock.json` fija las versiones exactas de las librerías del servidor, así cada deploy instala lo mismo que se probó. **No lo borres.** Para actualizarlas hace falta una computadora con Node.js 24: `npm update`, probar, y subir `package.json` y `package-lock.json` juntos. Si alguna vez Render avisa de vulnerabilidades por librerías viejas, usá **Manual Deploy → Clear build cache & deploy**.

## 5. Tareas frecuentes (panel de administración)

| Tarea | Dónde | Notas |
|---|---|---|
| Habilitar un mes | Meses | Los meses habilitados tienen que quedar **seguidos** (no se puede habilitar septiembre y noviembre sin octubre). Conviene habilitar el mes siguiente unos días antes de que termine el actual. |
| **Programar la apertura de un mes** | Meses → Programar la apertura de un mes | Se elige el mes (el que sigue al último habilitado) y la fecha y hora (de Paraguay). A esa hora exacta se abre solo, aunque nadie esté conectado, y la página muestra mientras tanto una cuenta regresiva. Se puede cancelar desde la misma pantalla. Habilitar o deshabilitar el mes a mano borra la programación. |
| Buscar a una persona | Reservas → "Buscar persona" | Por nombre (sin importar tildes), email o celular (con o sin espacios). Muestra un resumen: próximas, pasadas, canceladas y asistencia. |
| Ver el día | **Hoy** (la primera pestaña) | Las reservas de hoy en orden, con su estado (próxima, en curso, terminó), celular y acompañantes, y los botones de asistencia. Además: bloqueos de hoy, las reservas del próximo día hábil, cuántos reportes nuevos hay y los correos que no salieron (con el botón **Reintentar** para los que fallaron 6 veces). |
| Marcar asistencia | Hoy, o Reservas → botones **✓ Vino / ✗ No vino** | Aparecen en las reservas activas cuyo día ya llegó (también en el detalle del calendario). Tocar la opción marcada la borra. Sale en el Excel y en la planilla. |
| Bloquear un día u horario | Bloqueos | No se puede bloquear una fecha pasada ni un horario con reservas activas: primero hay que cancelarlas. El horario tiene que estar dentro del espacio: el Frente, entre el primer y el último turno; el Altillo, de 07:00 a 19:00. **Varios días:** elegí el intervalo, los días de la semana y el horario, tocá "Ver qué días se bloquean" y confirmá. Los días con reservas en ese horario no se bloquean (se avisa cuáles). La serie se puede borrar entera con "Eliminar la serie". |
| Reserva de prioridad (Comisión Directiva) | Prioridad | Solo Frente. Se puede hacer aunque el mes no esté habilitado y no cuenta para el límite por persona. Le llega la confirmación al correo que se cargue. |
| Cancelar una reserva | Reservas → Cancelar | Pide un motivo; se avisa por correo a quien reservó y a los moderadores. Así se ayuda a quien perdió su código. |
| Revisar reportes | Reportes | Cada reporte nuevo también llega por correo a `EMAIL_MODERADOR` (hasta 20 avisos por día). Cada uno pasa por **Nuevo → En revisión → Resuelto**, con una nota de lo que se hizo. Por defecto se ven los pendientes. |
| Lista de espera | (la gestiona cada persona) | Al anotarse le llega un correo con un enlace para salir de la lista (página `lista-espera.html`, con un botón para confirmar). El aviso de turno liberado y esa confirmación van **solo en texto**, para que Gmail no los mande a Promociones. |
| Exportar a Excel | Exportar | Botones **Este mes**, **Mes pasado** y **Todo**, filtro por espacio y por estado. Trae una hoja **Resumen** (totales por espacio, turno, día de la semana y mes) y una hoja por espacio con todos los datos de cada reserva, con fechas reales y filtros. |
| **Copia de seguridad** | Llega sola por correo el día 1 (ver "Copia de seguridad mensual"), o Avanzado → Mantenimiento → Copia de seguridad | El plan gratuito de Supabase no guarda copias que se puedan recuperar. La copia **completa** (.json) sirve para restaurar la base entera (sección 10, "Restaurar la base"). La planilla de Google Sheets guarda además una copia por mes, sin celulares ni correos. |

### Admin supremo

Se entra al mismo panel, pero con la contraseña del admin supremo (`SUPERADMIN_PASSWORD_HASH`). Arriba dice **Admin supremo**, y además de todo lo anterior aparece:

| Qué | Dónde | Notas |
|---|---|---|
| Cuándo se hizo cada reserva, y cuándo, quién y por qué se canceló | Reservas → columna **Registro** (y el detalle de cada día en el calendario) | Las canceladas antes del 11/10/2026 dicen "sin datos". Quién: `usuario` (con su código), `moderador` o `admin supremo`. |
| Habilitar o deshabilitar el Frente o el Altillo | Avanzado → Espacios disponibles | Se marca o desmarca "Se puede reservar desde la página" y se escribe el aviso que ve la gente al entrar. Si se desmarca "Mostrar este aviso al entrar a la página", el espacio se deshabilita sin ninguna ventana (el texto queda guardado). Las reservas que ya existen no se tocan. |
| Anunciar novedades al entrar a la página | Avanzado → Ventana de novedades | Título, introducción, hasta 6 bloques (título + texto) y texto final, con vista previa. **Publicar** con "Mostrarla de nuevo" la ve todo el mundo otra vez; sin esa casilla solo se corrige el texto. **Quitar de la página** la oculta sin borrarla. Se puede elegir si sale **una vez por navegador** o **en cada visita**, y una fecha **"mostrar hasta"** para que se quite sola. Las frases "Términos y condiciones" y "Política de privacidad" se convierten solas en enlaces. Se guarda en la tabla `configuracion` (claves `ventana_novedades` y `avisos_ocultos`). |
| Eliminar reservas de la base | Avanzado → Limpieza → Eliminar reservas canceladas | Definitivo, para limpiar las de prueba. **Solo canceladas**: una activa primero se cancela (así la persona recibe el aviso). Pide escribir ELIMINAR. Si hace falta, exportá a Excel antes. |
| Eliminar reportes | Avanzado → Limpieza → Eliminar reportes de errores | Definitivo. |
| Ver qué se hizo en el panel | Avanzado → Registro de actividad | Últimos 300 movimientos: inicios de sesión (también los fallidos), cancelaciones, bloqueos, meses, reservas de prioridad, reportes leídos, espacios y eliminaciones, con fecha, hora y si fue el admin o el admin supremo. No guarda datos personales. |
| Cerrar todas las sesiones | Avanzado → Contraseña y sesiones | Saca del panel a todos, incluido quien lo usa. Si se sospecha que alguien conoce una contraseña, cambiala también (sección 11). |
| Cambiar turnos, motivos del Frente, horario del Altillo, contacto del Frente y correo de alertas | Avanzado → Turnos, horarios y contacto | Se aplica al instante en la página, el servidor y los correos. Hasta 5 turnos, entre las 06:00 y las 22:00, sin superponerse; de 1 a 10 motivos; el Altillo abre y cierra a horas enteras y el máximo por reserva no puede ser mayor que su horario. Cambiar un turno o quitar un motivo no toca las reservas que ya existen. Si cambia el horario del Altillo, actualizar el artículo 5.2 de los Términos. |
| Ver estadísticas | Avanzado → Estadísticas | Por espacio y período: reservas y cancelaciones por mes, turnos y horarios más pedidos, día de la semana, asistencia y quiénes faltan seguido (2 o más "No vino"). |
| Ver la lista de espera | Avanzado → Lista de espera | Quién espera en cada espacio, para qué mes, su nombre y desde cuándo; se puede sacar a alguien (no se le avisa). |
| Ver si todo anda bien | Avanzado → Estado del sistema | Base de datos, correos de hoy (contra el límite de 300 de Brevo), correos trabados, última copia mensual, última actualización de la planilla, plazos de conservación, lista de espera, reportes nuevos, si las reservas están pausadas y el vencimiento de la clave SMTP de Gmail. |
| Editar una reserva | Reservas → columna "Registro" → Editar | Nombre, celular, correo, día y horario de una reserva activa que no pasó. Respeta turnos/horarios, bloqueos y superposiciones, pero no el límite por persona ni los meses habilitados. Por defecto le avisa a la persona por correo ("Tu reserva fue modificada"). |
| Reenviar la confirmación | Reservas → columna "Registro" → Reenviar confirmación | Para "no me llegó el correo": se genera un código nuevo (el anterior deja de servir) y se manda la confirmación otra vez. |
| Ver el historial de una reserva | Reservas → columna "Registro" → Historial | Cuándo se hizo, recordatorio, cambios y reenvíos (registro de actividad), cancelación y los correos de los últimos 7 días. |
| Pausar las reservas | Avanzado → Mantenimiento → Pausar las reservas | La página muestra el mensaje y nadie puede reservar ni anotarse en la lista de espera; se puede cancelar y hacer reservas de prioridad. Se guarda en `configuracion` (clave `pausa_reservas`). |
| Bajar una copia de seguridad en el momento | Avanzado → Mantenimiento → Copia de seguridad | El mismo CSV de la copia mensual. Tiene datos personales. |
| Bloquear los feriados | Avanzado → Feriados | Feriados nacionales del año (fijos y Semana Santa) para revisar y bloquear todo el día en el Frente y/o el Altillo. Los que se trasladan por decreto hay que corregirlos a mano. |
| Responder pedidos por correo | Avanzado → Respuestas listas | Textos para copiar (acceso a datos, borrado, corrección, reenvío, cancelación fuera de plazo, consulta). |
| Cambiar la contraseña de los admins | Avanzado → Contraseña y sesiones | Se guarda cifrada (bcrypt) en `configuracion` (clave `admin_password_hash`) y reemplaza a `ADMIN_PASSWORD_HASH` de Render, que queda solo como la inicial. Cierra todas las sesiones. La del admin supremo sigue en Render. |
| Cambiar las reglas de cada espacio | Avanzado → Reglas de cada espacio | Por espacio: **días de la semana** en que se reserva (si se agrega el sábado o el domingo, el calendario de ese espacio muestra esas columnas), **plazo para cancelar gratis** (N días antes; 0 = hasta que empiece), **recordatorio** (prendido o apagado y cuántos días antes), **anticipación** mínima y máxima, **límite por persona por mes** (el del Frente va de 1 a 20; el del Altillo, 0 = sin límite) y **normas de uso** (si hay, se muestran al reservar, hay que tildar que se leyeron y van en la confirmación y el recordatorio). Se aplica al instante en la página, el servidor y los correos; las reservas que ya existen no cambian. Las reservas de prioridad solo respetan los días. Si una regla queda distinta de lo que dicen los Términos (art. 5.3 días, 7.2 plazo, 7.3 recordatorio), el panel lo avisa: hay que actualizar esos artículos. Se guarda en `configuracion` (claves `reglas_espacios` y `max_reservas_por_persona_mes`). |
| Cambiar textos de la página y poner un anuncio | Avanzado → Textos de la página | Título, texto de bienvenida, aviso de "mes no habilitado", texto extra de la ventana "reserva confirmada", texto de la lista de espera (con `{espacio}` y `{mes}`) y la ayuda de la página Cancelar. "Original" vuelve al texto de siempre. **Cinta de anuncios:** una franja arriba de todo (azul o roja), con fecha "mostrar hasta" para que se quite sola. El texto debajo de "Crear reserva" (plazo, anticipación y límite) se arma solo con las Reglas. Se guarda en `configuracion` (claves `textos_pagina` y `anuncio`). |
| Cambiar los correos | Avanzado → Correos automáticos | Asunto, título y mensaje de cada correo a la gente: confirmación, recordatorio, cancelación (por la persona y por un moderador), plazo vencido, confirmación reenviada, reserva modificada y los dos de la lista de espera (esos son solo texto y se edita el texto entero; tienen que incluir su enlace). Comodines como `{nombre}`, `{fecha}`, `{horario}` se insertan con un toque. Los detalles, el código, los enlaces, la regla de cancelación, las normas y el contacto los agrega el sistema siempre; al asunto se le agrega " - CEQ #número". **Enviarme una prueba** manda lo escrito (sin guardarlo) al correo de alertas con datos de ejemplo y "[PRUEBA]" en el asunto (hasta 30 por día). **Volver al original** deshace los cambios. No se aceptan los signos < y >, ni comodines que no existen. Se guarda en `configuracion` (clave `plantillas_correo`, solo los correos cambiados). |
| Cambiar los Términos y la Política de privacidad | Avanzado → Términos y privacidad | Editor por artículo con vista previa. Formato simple (sin HTML): línea en blanco = párrafo nuevo, "- " = lista, "a) " = lista con letras, `**negrita**`, `[texto](destino)` = enlace (a terminos.html, privacidad.html, https://…, mailto: o `plantilla:nombre`, un correo con asunto y mensaje ya armados que se edita abajo). Comodines como `{plazo_cancelacion_frente}`, `{dias_reserva}`, `{horario_altillo}`, `{recordatorio}`, `{max_acompanantes}` (los del Altillo), `{acompanantes_por_espacio}` (en qué espacios y cuántos) y `{meses_conservacion}` se completan solos con las Reglas y la Configuración, así el texto no las contradice. **Guardar corrección** deja la misma versión (errores de tipeo); **Publicar versión nueva** sube la versión (1.3 → 1.4, o 2.0 si es una reescritura), pide la fecha de vigencia y un resumen, y la anterior queda en el historial (se guardan las últimas 10 con su texto, para verlas o descargarlas). "Descargar los dos en PDF" arma un documento para imprimir o guardar como PDF; las páginas públicas también tienen su botón. Se guarda en `configuracion` (claves `legal_terminos` y `legal_privacidad`); si no hay nada guardado se usa `legal-por-defecto.json` (Términos 1.3 y Privacidad 1.2). Las páginas terminos.html y privacidad.html piden el texto a `/api/legal/terminos` y `/api/legal/privacidad`; si el servidor no responde, muestran el texto que traen escrito. Los cambios se ven al instante. |
| Acompañantes por espacio | Avanzado → Reglas de cada espacio | "Hasta N acompañantes por reserva" en cada espacio (0 = no se piden; máximo 10). Por defecto, Altillo 4 y Frente 0. La base acepta hasta 10 en cualquier espacio (migración `migracion-acompanantes-configurables.sql`, 19/10/2026); lo que se permite de verdad lo controla el servidor con esta regla. Si el Frente admite acompañantes, el panel avisa que el art. 6.2 de los Términos habla solo del Altillo. |
| Avisos internos a los moderadores | Avanzado → Correos automáticos | Los 4 avisos (nueva reserva, la persona canceló, quiso cancelar fuera de plazo, un moderador canceló) se editan como los demás correos (grupo "Avisos internos"); los datos de la reserva, el contacto y el código los agrega el sistema. **Quién los recibe:** "Quién recibe los avisos internos", de 1 a 5 correos por espacio (clave `avisos_destinatarios`; por defecto, `EMAIL_MODERADOR` y `EMAIL_MODERADOR_FRENTE` de Render). Los avisos de reportes siguen yendo a `EMAIL_MODERADOR`. |
| Respuestas listas | Avanzado → Respuestas listas → "Editar las respuestas" | Agregar, quitar, ordenar y cambiar los textos para responder pedidos. `{nombre}` = el primer nombre que se escribe arriba; `{plazo_frente}` = el plazo para cancelar del Frente. "Volver a las originales" deja las 6 de siempre. Clave `respuestas_listas`. |
| Textos fijos de la página y mensajes de error | Avanzado → Textos de la página | Ordenados por lugar: página de reservas, ventana "¡Tu reserva quedó confirmada!" (título y mensaje, con `{correo}` y `**negrita**`), página Cancelar ("¿Perdiste el código?" con `{whatsapp}`), ventana "Reportar un problema" y los mensajes de error al reservar (turno ocupado, bloqueado, horario que ya pasó, mes no habilitado y límite del mes con `{cantidad}`, `{espacio}` y `{maximo}`). Los obligatorios, si se borran, vuelven al texto de siempre. |
| Responder un pedido de datos (Privacidad, art. 11) | Avanzado → Datos de una persona | Buscar por correo o celular: muestra sus reservas, dónde figura como acompañante y la lista de espera. También la encuentra por los otros datos que ella dejó en sus reservas (si se busca por correo, aparece también donde figura como acompañante por su celular). "Descargar sus datos (PDF)" abre un documento con SOLO sus datos para guardarlo como PDF (en la ventana de imprimir, "Guardar como PDF") y mandárselo; también está el "Archivo técnico (.json)". En los dos va solo lo suyo: de sus reservas va cuántos acompañantes tenía, pero no sus nombres ni celulares, y donde fue acompañante no va el nombre de quien reservó. "Borrar sus datos" deja sus reservas sin nombre ni contacto, la saca de las listas de acompañantes y de la lista de espera, y borra los correos para ella que sigan guardados en la cola. Si algo no se pudo borrar, lo dice; se puede tocar "Borrar" otra vez. Si tiene reservas activas a futuro, primero hay que cancelarlas. No se puede deshacer. |
| Alertas por correo | Automático | Si hay errores del servidor o bloqueos 429, llega un correo al "correo de alertas" de la Configuración: como máximo uno por hora, y solo si pasó algo. |

El admin normal no ve la pestaña Avanzado, y el servidor le rechaza esas acciones aunque intente hacerlas por otro lado.

### Correos automáticos y lista de espera

- **Recordatorio (por defecto, 2 días antes):** a partir de las 08:00 de ese día llega un correo con un botón **Cancelar mi reserva** (no hace falta el código). Si ese día es el último para cancelar gratis (en el Frente, con las reglas de siempre), lo dice. Cuántos días antes, o si se manda, se cambia por espacio en Avanzado → Reglas de cada espacio. No se manda a las reservas de prioridad ni a las hechas en las últimas 12 horas.
- **Enlace para cancelar:** el correo de confirmación y el recordatorio traen un enlace firmado que cancela esa reserva (con las mismas reglas que el código). Si se cambia `JWT_SECRET`, los enlaces viejos dejan de andar; el código sigue sirviendo.
- **"Quedan X turnos libres":** arriba del calendario se ve cuántos turnos (Frente) u horas (Altillo) quedan en el mes que se está mirando, desde hoy y en días hábiles. Con pocos lugares se resalta; con ninguno se muestra la lista de espera.
- **Lista de espera (por mes):** cuando en un mes habilitado ya no queda ningún lugar libre en un espacio, la página muestra "Ya no hay lugares en (mes)" y la persona puede anotarse con su nombre y su correo para ese mes (se habilita un solo mes a la vez, así que no hace falta elegirlo). Si después alguien cancela una reserva de ese espacio **y de ese mes** (con código, con enlace o desde el panel), se avisa a todos los anotados para ese mes a la vez, saludándolos por el nombre, con el día y turno que se liberó y un enlace directo; el lugar es de quien reserve primero. Cada inscripción se avisa una sola vez (para otro aviso hay que volver a anotarse); hay un máximo de 60 avisos por día, y las inscripciones sin avisar se borran a los 60 días.

- **"Responder a" y contacto:** los correos salen de `reservas@ceq-una.com`. Desde el 16/10/2026 esa dirección **recibe**: Cloudflare (Email Routing) la reenvía a `ceq.informatica@gmail.com`, y desde ese Gmail se responde como reservas@ceq-una.com ("Enviar como", por el SMTP de Brevo con una clave SMTP propia que vence a los 90 días sin uso). Es el contacto público en los correos, los Términos y la Política de Privacidad. Si la persona responde un correo del Frente, le llega al contacto del Frente (Configuración); si es del Altillo, a `reservas@ceq-una.com`. Si un moderador responde un aviso de reserva o cancelación, le escribe directo a la persona que reservó.

### Copia de seguridad mensual (llega sola por correo)

Supabase gratis no guarda copias que se puedan descargar. Por eso, el **día 1° de cada mes a las 08:00** el servidor manda al **correo de alertas** (Avanzado → Turnos, horarios y contacto) dos archivos:
- `reservas-ceq-AAAA-MM.csv`: **todas** las reservas con todos sus datos (también celulares, correos, acompañantes y cancelaciones). Se abre con Excel o Google Sheets.
- `reservas-ceq-AAAA-MM-completa.zip`: la **base entera** (reservas con su código cifrado, bloqueos, meses, lista de espera, configuración con las reglas, los textos, los correos y los Términos con su historial, reportes y registro). No lleva la contraseña de los admins ni la cola de correos. No hace falta abrirlo: es lo que usa `restaurar.js` (sección 10, "Restaurar la base"). Va en `.zip` porque Brevo no acepta adjuntos `.gz` ni `.json` (si uno no le gusta, rechaza el correo entero). Si Brevo rechazara el `.zip`, el servidor manda igual el correo solo con el CSV.

**Si la copia no sale:** el servidor lo reintenta cada hora, la tarjeta "Copia de seguridad mensual" de Avanzado → Estado del sistema se pone en rojo con el motivo y llega una alerta al correo de alertas. **Avanzado → Mantenimiento → Copia de seguridad → "Mandarme la copia ahora"** manda la copia del mes en el momento al correo de alertas (hasta 5 veces por día; sirve para probar que llega, por ejemplo después de un cambio en Brevo).

Los mismos datos se bajan en el momento desde Avanzado → Mantenimiento → Copia de seguridad (el CSV y la copia completa en `.json`).

**Qué hacer cuando llega:** nada; la copia queda en el correo. **No guardarla en otro lado.** El script `limpiar-copias-de-seguridad.gs` (está en este repositorio; es un proyecto de Apps Script aparte en la cuenta ceq.informatica, con un activador diario) hace dos cosas: **guarda solo las 2 copias más nuevas** (manda las demás a la papelera) y manda a la papelera **los demás correos del sistema de más de 6 meses** (avisos de reservas y cancelaciones, reportes, alertas). Solo toca correos *recibidos* de reservas@ceq-una.com: las respuestas que la Secretaría manda desde esa cuenta no se tocan, aunque estén en la misma conversación. Gmail vacía la papelera a los 30 días. Los avisos que les llegan a otras casillas (por ejemplo, el correo personal de quien modera el Frente) no se pueden limpiar desde acá: cada moderador tiene que borrarlos. Para instalarlo o actualizarlo: script.google.com → el proyecto "Limpiar copias de seguridad" (o uno nuevo) → reemplazar todo el código → Guardar → ejecutar `activarLimpiezaDiaria` y autorizar (en Chrome). Si un mes la copia no llega, revisar Render → Logs (buscar `copia mensual`). El mes ya enviado queda anotado en la tabla `configuracion` (clave `copia_mensual_enviada`): para que se vuelva a mandar, borrá esa fila.

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
| Espacios que se pueden reservar desde la página | Solo Frente (3). Altillo (1) se gestiona con planilla. | Panel → Avanzado → Espacios disponibles (admin supremo). Se guarda en la columna `publico` de la tabla `espacios` (ver sección 7). |
| Turnos del Frente | Desayuno 07–10, Almuerzo 10–13, Merienda 14–18 | Panel → Avanzado → Turnos, horarios y contacto (admin supremo). Se guarda en la tabla `configuracion`. |
| Motivo en el Frente | Se elige de una lista: Actividad Personal; Recaudación - Asociación Estudiantil; Recaudación - Secretaría CEQ; Recaudación - Padrinaje; Recaudación - Congreso o Evento Académico. En el Altillo el motivo es libre. | `MOTIVOS_FRENTE` en `server.js` (la página la toma de ahí) |
| Horario del Altillo | Bloques de 1 hora de 07:00 a 19:00 (el último empieza a las 18:00), de 1 a 2 horas por reserva. Hoy se puede tomar el bloque en curso mientras no haya terminado (a las 11:30, el de las 11:00 sí; a las 12:00, ya no). | Panel → Avanzado → Turnos, horarios y contacto (admin supremo). Se guarda en la tabla `configuracion` (claves `altillo_hora_desde`, `altillo_hora_hasta`, `altillo_max_horas`). |
| Acompañantes | Por defecto solo en el Altillo, hasta 4 por reserva (se cambia por espacio en Avanzado → Reglas de cada espacio, hasta 10). Opcional, con nombre y celular. Se ven en el panel, el Excel y los correos (en la planilla, solo los nombres); nunca en la página pública. | `MAX_ACOMPANANTES` en `server.js` y el límite `reservas_acompanantes_validos` de la base |
| Días | Lunes a viernes, desde hoy, solo en meses habilitados, sin anticipación mínima ni máxima | Panel → Avanzado → Reglas de cada espacio (admin supremo), por espacio |
| Límite por persona | Solo en el Frente: 2 reservas activas por mes (se reconoce a la persona por correo o por celular). El Altillo no tiene límite. No cuentan las canceladas ni las de prioridad del panel. **Además, por día:** una misma persona (mismo correo o mismo celular) puede crear como máximo 5 reservas por día desde la página, contando las que después canceló (`MAX_RESERVAS_POR_PERSONA_DIA`); así no se puede ocupar y soltar turnos sin parar. La base cuenta y guarda en un solo paso (función `crear_reserva_con_cupo`), así varios pedidos al mismo tiempo no pasan el límite. **Limitación conocida:** el sistema no comprueba que el correo y el celular sean de verdad de quien reserva (no hay cuentas ni código de verificación). El límite se aplica a los datos que se escriben en el formulario: alguien que use otro correo **y** otro celular puede reservar más. Es una decisión tomada (auditoría del 16/10/2026, CEQ-01); si pasa seguido, el moderador puede cancelar las de más. Todos tienen el mismo límite: no hay correos exentos. El Altillo también puede tener límite (lo cuenta la misma función de la base, por espacio). | Panel → Avanzado → Reglas de cada espacio (admin supremo) |
| Cancelación con código o enlace | Frente: hasta 2 días antes, después por WhatsApp o al correo del Frente. Altillo: hasta que empiece (después, al correo reservas@ceq-una.com) | Panel → Avanzado → Reglas de cada espacio (admin supremo) |
| Normas de uso | Ninguna | Panel → Avanzado → Reglas de cada espacio (admin supremo) |
| Textos de la página, anuncio y correos | Los de siempre | Panel → Avanzado → Textos de la página / Correos automáticos (admin supremo) |
| Límites por IP | Crear 150/hora, cancelar 20/hora, reportes 10/hora, lista de espera 15/hora, consultas 1200 cada 5 min, login 5 intentos fallidos cada 15 min. Las direcciones IPv6 se cuentan por red (/64), porque una sola conexión puede tener miles de direcciones de esa red. | Los `rateLimit` y `claveDeRed()` en `server.js` |
| Inicio de sesión (todas las IP juntas) | 30 intentos fallidos por hora: pasado eso, se cierra para las **redes nuevas** hasta que esos intentos tengan más de una hora. Las redes desde las que alguien entró bien en los últimos 30 días siguen pudiendo entrar (se guarda solo una huella cifrada de la red, nunca la IP; clave `login_redes_conocidas`). Avanzado → Estado del sistema muestra los intentos de la última hora y tiene el botón **"Reabrir el inicio de sesión"** (deja de contar los intentos anteriores; clave `login_reabierto_en`). Al 10.º fallido de la hora y al cerrarse, llega una alerta al correo de alertas. Se cuentan en el registro de actividad ("Intento de inicio de sesión fallido"), así no se pierden con un reinicio. Si llega la alerta y no fueron ustedes, cambiar las contraseñas. | `MAX_LOGIN_FALLIDOS_POR_HORA` y `AVISO_LOGIN_FALLIDOS_POR_HORA` en `server.js` |
| Contacto del Frente | Correo y WhatsApp de la persona encargada (si nunca se cargó, el correo es `reservas@ceq-una.com`) | Panel → Avanzado → Turnos, horarios y contacto (admin supremo): se actualiza en los correos y en las páginas. Si cambia la persona, cambiar también `EMAIL_MODERADOR_FRENTE` en Render (avisos internos). |
| Límites de la lista de espera | Solo se puede anotar si el mes ya no tiene ningún lugar libre (el servidor hace la misma cuenta que la página). Una inscripción por correo, espacio y mes: si ya estaba anotado y sin avisar, no se manda otra confirmación. 15 inscripciones por hora por IP, 60 por día en total, 60 avisos por día y vigencia de 60 días. | `listaEsperaLimiter`, `MAX_INSCRIPCIONES_LISTA_ESPERA_POR_DIA`, `MAX_AVISOS_LISTA_ESPERA_POR_DIA` y `DIAS_VIGENCIA_LISTA_ESPERA` en `server.js` |
| Versión que se muestra | `v2.5a-34` | Pie de las tres páginas |

## 7. Reactivar el Altillo

Ya no hace falta tocar código:

1. Entrar al panel con la contraseña del **admin supremo** → pestaña **Avanzado** → **Espacios disponibles**.
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
| Brevo | 300 correos por día en total | Cada reserva manda 2 o 3, más 1 recordatorio. Para que siempre salgan las confirmaciones, los correos que no son de una reserva (lista de espera, avisos de reportes y pruebas del panel) se frenan cuando en el día ya hay 250 en la cola (`LIMITE_CORREOS_OPCIONALES`). Además, los avisos de reportes tienen un tope de 20 por día, los de lista de espera de 60 y las pruebas del panel de 30. Todos se cuentan en la base, así no vuelven a cero con un reinicio. |
| UptimeRobot | Revisa cada 5 minutos | Una caída se detecta con hasta 5 minutos de demora. |
| Google Apps Script | 20.000 consultas externas y 90 minutos de disparadores por día | La planilla usa 24 consultas por día y unos segundos cada vez. |
| Supabase (API) | Máximo 1000 filas por pedido | El servidor pide de a 1000 hasta traer todas (panel y planilla). |

## 10. Base de datos

La estructura completa está en [`esquema-base-de-datos.sql`](esquema-base-de-datos.sql): 9 tablas (`espacios`, `reservas`, `bloqueos`, `meses_habilitados`, `reportes_errores`, `registro_actividad`, `configuracion`, `lista_espera` y `correos_pendientes`; la tabla `cancelaciones`, que estaba en desuso, se borró con `migracion-permisos.sql`). Los cambios que se le hicieron a una base ya existente quedan como archivos `migracion-*.sql` ([`migracion-admin-supremo.sql`](migracion-admin-supremo.sql), [`migracion-funciones-octubre.sql`](migracion-funciones-octubre.sql) y [`migracion-acompanantes-y-lista-espera.sql`](migracion-acompanantes-y-lista-espera.sql), del 11/10/2026); `esquema-base-de-datos.sql` ya los incluye.

**Tareas automáticas:** cada 5 minutos el servidor abre los meses programados, manda los recordatorios del día, limpia la lista de espera vieja, manda la copia de seguridad del mes (una vez por mes), aplica los plazos de conservación de la Política de Privacidad (una vez por día: borra nombre, contacto, acompañantes y textos libres de las reservas de hace más de 6 meses, y borra los reportes de hace más de 6 meses; si se cambia ese plazo, cambiar también `privacidad.html`), relee la configuración y manda las alertas pendientes (ver `tareasPeriodicas()` en `server.js`). Funciona porque UptimeRobot mantiene el servidor despierto.

Protecciones que viven en la base (además de las del servidor):
- **`no_solapamiento_activo`:** dos reservas activas del mismo espacio no pueden superponerse, aunque lleguen al mismo instante.
- **Triggers:** no se puede reservar sobre un bloqueo (error `CEQ01`) ni bloquear sobre una reserva activa (error `CEQ02`).
- **Columnas `bloqueos.lote` y `reportes_errores.estado` / `nota`** (migración `migracion-panel-hoy.sql`): series de bloqueos de varios días y estados de los reportes.
- **Tabla `correos_pendientes`** (migración `migracion-cola-correos.sql`): cola de correos. Las confirmaciones, avisos a moderadores, cancelaciones, recordatorios y avisos de reportes se guardan acá y después se mandan; si Brevo falla, el servidor reintenta a los 1, 5, 15, 60 y 180 minutos (y retoma los pendientes si se reinicia). Al enviarse se borra el contenido; las filas se borran a los 7 días. Si un correo falla 6 veces queda en estado `fallido` (con destinatario y asunto) y aparece en el correo de alertas. Para ver si hubo alguno: Supabase → Table Editor → `correos_pendientes`, filtrar `estado = fallido`. Si la tabla no existe, el servidor manda directo, como antes.
- **Función `crear_reserva_con_cupo`** (migración `migracion-cupo-atomico.sql`): el servidor guarda las reservas públicas con ella. Con un candado por espacio y mes, cuenta las reservas activas del mes de la persona (sin las de prioridad) y guarda en la misma transacción; si llegó al límite, responde el error `CEQ03`. Solo la puede usar el servidor (`service_role`).
- **Seguridad (RLS) activada sin políticas:** solo el servidor, con la clave service_role, puede leer y escribir.
- **Sin permisos para los roles públicos** (migración `migracion-permisos.sql`, AUD-14): `anon` y `authenticated` no tienen ningún permiso sobre las tablas, secuencias ni funciones, tampoco sobre las que se creen después. Es una segunda barrera por si algún día se publicara la clave pública. La misma migración agregó el control `reservas_estado_valido` (el estado solo puede ser `activa` o `cancelada`) y borró la columna vacía `reservas.codigo_cancelacion`.
- Los códigos de cancelación se guardan cifrados: **no se pueden recuperar**, ni siquiera desde la base.

### Restaurar la base

Si se perdiera la base (o hubiera que pasar a otro proyecto de Supabase), se recupera **todo** con la última copia completa. Se probó en las pruebas automáticas (`pruebas/probar_restaurar.js`) con un PostgreSQL de verdad.

1. Tener la copia: el adjunto `reservas-ceq-AAAA-MM-completa.zip` del último correo "Copia de seguridad de las reservas" (o el `.json` que se baja del panel, si el panel todavía anda).
2. En una computadora con Node.js, en una copia de este repositorio (no hace falta `npm install`):
   ```
   node restaurar.js reservas-ceq-AAAA-MM-completa.zip > restaurar.sql
   ```
   No hace falta descomprimirlo (también lee las copias viejas `.json.gz` y el `.json` del panel). Dice cuántas filas hay por tabla. Si el archivo no es una copia del sistema, avisa y no arma nada.
3. Crear el proyecto nuevo de Supabase. En **SQL Editor**: pegar y ejecutar `esquema-base-de-datos.sql` (crea las tablas vacías) y después `restaurar.sql`. Todo va en una sola transacción: si algo falla, no queda nada a medias. Los números de reserva se conservan, así los códigos y los enlaces para cancelar siguen sirviendo. Si `restaurar.sql` es muy grande para el SQL Editor, se puede ejecutar con `psql` y la cadena de conexión del proyecto.
4. En Render, actualizar `SUPABASE_URL` y `SUPABASE_KEY` (clave service_role del proyecto nuevo) y esperar que el servidor quede en línea.
5. La contraseña de los admins no viaja en la copia: vuelve a ser la de Render (`ADMIN_PASSWORD_HASH`). Si se había cambiado desde el panel, cambiarla de nuevo (Avanzado → Mantenimiento → Contraseña y sesiones).
6. Lo que pasó entre la copia y la pérdida (hasta un mes) no está en la copia: revisar los avisos de "Nueva reserva" de ese período y cargar esas reservas a mano como reservas de prioridad.

Para crear una base **vacía** (sin datos), alcanza con el paso 3 sin `restaurar.sql` y después habilitar los meses desde el panel.

Si se cambia la estructura en Supabase, actualizar también ese archivo.

## 11. Seguridad

- **Cambiar la contraseña del panel:** en una computadora con Node.js 24, en una copia de este repo, ejecutar `npm install` y después:
  ```
  node -e "console.log(require('bcryptjs').hashSync('LA-NUEVA-CONTRASEÑA', 10))"
  ```
  Copiar el resultado (empieza con `$2`) en `ADMIN_PASSWORD_HASH` en Render y guardar. La contraseña en sí no se guarda en ningún lado.
- **Cambiar la contraseña del admin supremo:** igual, pero el resultado va en `SUPERADMIN_PASSWORD_HASH`. Tiene que ser distinta de la del admin (si fueran iguales, todos entrarían como admin supremo).
- **Cerrar todas las sesiones del panel** (por ejemplo, si alguien dejó una sesión abierta en una computadora ajena): como admin supremo, Avanzado → Contraseña y sesiones → **Cerrar todas las sesiones**. Si no se puede entrar como admin supremo, cambiar `JWT_SECRET` en Render por otro texto largo al azar hace lo mismo.
- **Nunca** subir un archivo `.env` ni pegar claves en el código o en las páginas.

## 12. Pendientes conocidos

De la auditoría del 23/10/2026 (AUD-01 a AUD-18) están resueltas las tres tandas. Queda, de AUD-18, lo que la propia auditoría recomienda no hacer de golpe: juntar en una sola función la validación de horarios y de superposición (hoy está repetida en varios lugares de `server.js`) y dejar de escribir a mano los números de los espacios (3 y 1). Conviene hacerlo de a poco, cuando se toque cada parte, y es lo que haría falta para poder crear espacios nuevos desde el panel.

De la auditoría técnica del 24/07/2026 (la respuesta completa está en el Apéndice 1 del 6° informe de la Secretaría de Informática). Ninguno es un riesgo inmediato:

- Separar el JavaScript de las páginas y activar la política de seguridad CSP (SEC-004, ARCH-001).
- Que los códigos de cancelación venzan (SEC-005) y poder cerrar una sesión puntual del panel (AUTH-002; hoy se cierran todas juntas desde Avanzado → Contraseña y sesiones).
- Evitar reservas duplicadas por reintentos con una clave de idempotencia (BUG-004).
- Guardar celular y correo en columnas separadas (VAL-002).
- Definir si se siguen mostrando los nombres en el calendario público (PRIV-001, decisión de la Comisión).
- Paginación del panel cuando haya muchas reservas (PERF-001). Hoy el panel ya trae todas de a 1000; con varios miles convendría mostrarlas por páginas.

## 13. Traspaso (cuando cambia quien administra el sistema)

La Comisión cambia cada año: el sistema no puede depender de una sola persona ni de una sola cuenta. Las contraseñas **nunca** van en este repositorio; se guardan en el gestor de contraseñas o documento privado de la Secretaría de Informática.

**Antes de que alguien deje el cargo** (y al menos una vez por año), revisar con quien lo reemplaza:

| Servicio | Qué tiene que pasar | Qué se pierde si no |
|---|---|---|
| Cuenta de Google `ceq.informatica@gmail.com` | Pasar la contraseña y el segundo factor (celular o llaves de respaldo) a la persona nueva. Cambiar el celular de recuperación. | Es la cuenta de casi todo: Render, UptimeRobot, la planilla, las copias de seguridad y las alertas. |
| Cuenta de Google `reservas@ceq-una.com` (solo para el avatar) | Pasar la contraseña; agregar un celular de recuperación. | Solo la foto que se ve en Gmail. |
| GitHub, organización `ceqinformatica` | Que haya **al menos dos dueños** (Owner) con segundo factor activado. Activar **Push protection** (Settings → Code security) para que no se pueda subir una clave por error. | Sin dueño, nadie puede cambiar el código ni los permisos. |
| Render | Agregar a la persona nueva al workspace "reservas ceq" (Settings → Members) con segundo factor. | No se puede publicar, ver los registros ni cambiar las claves. |
| Supabase | Agregar a la persona nueva a la organización del proyecto `reservas-ceq` como Owner. | No se puede ver ni restaurar la base. |
| Vercel | Agregar a la persona nueva al equipo del proyecto. | No se pueden ver los despliegues de las páginas (se publican solos desde GitHub). |
| Brevo | Agregar a la persona nueva como usuario (o pasar la cuenta). La clave SMTP de Gmail **vence el 16/10/2027** (o a los 90 días sin usarse): renovarla antes. | No se ven los envíos ni el límite diario; si vence la clave SMTP, la Secretaría no puede responder como reservas@. |
| Cloudflare `Oficialceq@gmail.com` | Pasar la contraseña o agregar a la persona nueva como miembro. | No se puede tocar el DNS ni el reenvío de `reservas@ceq-una.com`. |
| Dominio `ceq-una.com` (Hosting PY) | Saber quién es el dueño y **renovarlo antes del 09/03/2027** (lo paga la Comisión). | Si vence, dejan de andar la página, la API y los correos. |
| UptimeRobot | La cuenta es `ceq.informatica@gmail.com`: con la cuenta de Google alcanza. | No llegan los avisos de caída. |
| Panel de administración | **Cambiar la contraseña de los admins** cada vez que cambian los moderadores (Avanzado → Mantenimiento → Contraseña y sesiones). Cambiar la del admin supremo si se va quien la conocía (sección 11). | Quien se fue sigue pudiendo entrar y ver los datos de todas las reservas. |
| Moderadores | Los avisos internos llegan a los correos de "Quién recibe los avisos internos" (Avanzado → Correos automáticos). Sacar el correo de quien se va y pedirle que borre los avisos de su casilla. | Siguen llegando datos personales a alguien que ya no es moderador. |

**Para la persona nueva:** leer este manual completo, entrar al panel como admin supremo y revisar **Estado del sistema** (Avanzado → Inicio). Si algo aparece en rojo o en naranja, la sección 8 dice qué hacer.
