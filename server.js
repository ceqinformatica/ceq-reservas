require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const net = require('net');
const zlib = require('zlib');

const app = express();

// Render (y en el medio, potencialmente Cloudflare) hacen de proxy delante del
// servidor. Sin esto, Express ve la IP del proxy en vez de la del visitante real,
// lo que rompe silenciosamente los rate limiters (AUTH-001/ABUSE-001): todos los
// usuarios comparten el mismo contador, o -si no se confía en el header para nada-
// alguien puede intentar forzar el reseteo del límite. `1` = confiar en el primer
// salto (el proxy inmediato de Render), no en cualquier IP que venga en el header.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ========== UTILIDADES DE SEGURIDAD ==========

// Escapa entidades HTML para evitar inyección en emails (SEC-006)
function escapeHtml(texto) {
  if (texto === null || texto === undefined) return '';
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Responde con un mensaje genérico al cliente y loguea el detalle real solo en el servidor (API-001).
// No exponer error.message crudo: puede filtrar nombres de tablas/columnas/constraints de Supabase.
function manejarError(res, error, mensajePublico = 'Error interno del servidor', status = 500) {
  console.error('❌ Error interno:', error);
  if (status >= 500) {
    const ruta = res.req ? `${res.req.method} ${res.req.originalUrl.split('?')[0]}` : '';
    anotarAlerta('error', `${ruta}: ${(error && (error.message || error.code)) || error}`);
  }
  res.status(status).json({ error: mensajePublico });
}

// Errores 500 y bloqueos 429 que todavía no se avisaron por correo (ver enviarAlertas, que
// manda como máximo un correo por hora y solo si pasó algo). Viven en memoria: si el servidor
// se reinicia se pierden, pero eso no pasa seguido y los registros de Render los tienen igual.
const alertasPendientes = { errores: [], bloqueos429: [] };
function anotarAlerta(tipo, detalle) {
  const lista = tipo === '429' ? alertasPendientes.bloqueos429 : alertasPendientes.errores;
  if (lista.length < 200) lista.push({ momento: new Date(), detalle: String(detalle).slice(0, 300) });
}

// Valida que un valor sea un entero positivo (para IDs de path params) (API-003)
function esIdValido(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0;
}

// SEC-005: hashea el código de cancelación con SHA-256. Nunca se guarda ni se
// vuelve a leer el código en claro desde la base — solo se compara el hash.
function hashCodigo(codigo) {
  return crypto.createHash('sha256').update(codigo).digest('hex');
}

// BUG-006: el servidor de Render corre en UTC, pero las reglas de negocio
// (ventana de 5 días, período de cancelación de 2 días) tienen que evaluarse
// según el día calendario en Paraguay (America/Asuncion, UTC-3), no según la
// hora del servidor. Sin esto, cerca de la medianoche UTC (21hs en Paraguay)
// los cálculos de "cuántos días faltan" podían saltar un día de más o de menos.
function hoyEnAsuncion() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Asuncion',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const partes = formatter.formatToParts(new Date());
  const anio = partes.find(p => p.type === 'year').value;
  const mes = partes.find(p => p.type === 'month').value;
  const dia = partes.find(p => p.type === 'day').value;
  // Se representa como medianoche UTC del día calendario en Paraguay, para
  // poder restar de forma limpia contra otras fechas 'YYYY-MM-DD' parseadas igual.
  return new Date(`${anio}-${mes}-${dia}T00:00:00Z`);
}

// Diferencia en días de calendario completos entre hoy (en Paraguay) y una fecha 'YYYY-MM-DD'
function diferenciaEnDiasCalendario(fechaISO) {
  const fechaObjetivo = new Date(fechaISO + 'T00:00:00Z');
  const hoy = hoyEnAsuncion();
  return Math.round((fechaObjetivo - hoy) / (1000 * 60 * 60 * 24));
}

// VAL-001: hora actual en Paraguay, en minutos desde medianoche. Se usa para
// rechazar reservas de "hoy" cuyo horario de inicio ya pasó (antes solo se
// comparaba el día calendario, así que se podía reservar "hoy 08:00" a las 3 de la tarde).
function horaActualEnAsuncionEnMinutos() {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Asuncion', hour: '2-digit', minute: '2-digit', hour12: false
  });
  const partes = formatter.formatToParts(new Date());
  const horas = Number(partes.find(p => p.type === 'hour').value);
  const minutos = Number(partes.find(p => p.type === 'minute').value);
  return horas * 60 + minutos;
}

// ========== CONFIGURACIÓN DE SEGURIDAD ==========

// Verificar que todas las variables de entorno necesarias están presentes
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_KEY', 'BREVO_API_KEY', 'JWT_SECRET', 'ADMIN_PASSWORD_HASH'];
requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    console.error(`❌ ERROR: Variable de entorno ${varName} no configurada`);
    process.exit(1);
  }
});

// Configuración Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Configuración Brevo (envío de emails)
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const EMAIL_MODERADOR = process.env.EMAIL_MODERADOR || 'ceq.informatica@gmail.com';
// Correo de contacto que ve la gente (en los correos y en los "Responder a"). Desde el 16/10/2026
// reservas@ceq-una.com recibe correos (Cloudflare los reenvía a ceq.informatica@gmail.com) y la
// Secretaría responde desde esa misma dirección. EMAIL_MODERADOR sigue siendo a quién le llegan
// los avisos internos.
const CORREO_CONTACTO = 'reservas@ceq-una.com';
// Email específico para avisos del espacio Frente (si no se configura, usa el general)
const EMAIL_MODERADOR_FRENTE = process.env.EMAIL_MODERADOR_FRENTE || EMAIL_MODERADOR;

// Correos que reciben los avisos internos de un espacio. Se eligen en el admin supremo (Correos >
// Quién recibe los avisos); por defecto, Altillo: el general; Frente: el general y el del Frente.
function getEmailModerador(espacio_id) {
  return (config.avisos_destinatarios && config.avisos_destinatarios[Number(espacio_id)]) || [EMAIL_MODERADOR];
}

// ========== PERSONALIZACIÓN (admin supremo) ==========
// Reglas de cada espacio, textos de la página, cinta de anuncios y plantillas de los correos.
// Todo se guarda en la tabla configuracion; si no hay nada guardado, se usan estos valores, que
// son los de siempre.

// Reglas de cada espacio. dias: días de la semana en que se puede reservar (0 domingo … 6 sábado).
// plazo_cancelacion_dias: hasta cuántos días antes se cancela desde la página (0 = hasta que
// empiece). anticipacion: cuántos días antes como mínimo y como máximo se puede reservar (máximo
// 0 = sin límite; igual manda qué meses están habilitados). limite_por_persona_mes: solo el
// Altillo (el del Frente es max_reservas_por_persona_mes, 0 = sin límite). normas: se muestran al
// reservar (hay que tildar que se leyeron) y van en la confirmación.
const REGLAS_POR_DEFECTO = {
  3: { dias: [1, 2, 3, 4, 5], plazo_cancelacion_dias: 2, recordatorio: true, recordatorio_dias: 2, anticipacion_min_dias: 0, anticipacion_max_dias: 0, limite_por_persona_mes: 0, acompanantes_max: 0, normas: '' },
  1: { dias: [1, 2, 3, 4, 5], plazo_cancelacion_dias: 0, recordatorio: true, recordatorio_dias: 2, anticipacion_min_dias: 0, anticipacion_max_dias: 0, limite_por_persona_mes: 0, acompanantes_max: 4, normas: '' }
};

function validarReglasEspacios(valor) {
  const v = valor || {};
  const entero = (x, min, max, nombre) => {
    const n = Number(x);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${nombre} tiene que ser un número entre ${min} y ${max}`);
    return n;
  };
  const resultado = {};
  for (const id of [3, 1]) {
    const r = { ...REGLAS_POR_DEFECTO[id], ...(v[id] || v[String(id)] || {}) };
    const espacio = id === 3 ? 'Frente' : 'Altillo';
    const dias = [...new Set((Array.isArray(r.dias) ? r.dias : []).map(Number))].filter(d => Number.isInteger(d) && d >= 0 && d <= 6).sort();
    if (!dias.length) throw new Error(`${espacio}: elegí al menos un día de la semana`);
    const normas = String(r.normas == null ? '' : r.normas).replace(/\r\n/g, '\n').trim();
    if (normas.length > 1500) throw new Error(`${espacio}: las normas pueden tener hasta 1500 caracteres`);
    const min = entero(r.anticipacion_min_dias, 0, 30, `${espacio}: la anticipación mínima`);
    const max = entero(r.anticipacion_max_dias, 0, 365, `${espacio}: la anticipación máxima`);
    if (max > 0 && max < min) throw new Error(`${espacio}: la anticipación máxima no puede ser menor que la mínima`);
    resultado[id] = {
      dias,
      plazo_cancelacion_dias: entero(r.plazo_cancelacion_dias, 0, 14, `${espacio}: el plazo para cancelar`),
      recordatorio: r.recordatorio !== false,
      recordatorio_dias: entero(r.recordatorio_dias, 1, 7, `${espacio}: los días del recordatorio`),
      anticipacion_min_dias: min,
      anticipacion_max_dias: max,
      limite_por_persona_mes: id === 3 ? 0 : entero(r.limite_por_persona_mes, 0, 20, `${espacio}: el límite por persona`),
      acompanantes_max: entero(r.acompanantes_max, 0, MAX_ACOMPANANTES_TOTAL, `${espacio}: el máximo de acompañantes`),
      normas
    };
  }
  return resultado;
}

function reglaEspacio(espacioId) {
  return config.reglas_espacios[Number(espacioId)] || REGLAS_POR_DEFECTO[Number(espacioId)] || REGLAS_POR_DEFECTO[1];
}

// Máximo de reservas por persona por mes en el espacio (null = sin límite)
function limitePorPersona(espacioId) {
  if (Number(espacioId) === 3) return config.max_reservas_por_persona_mes;
  const n = reglaEspacio(espacioId).limite_por_persona_mes;
  return n > 0 ? n : null;
}

// Textos de la página que se pueden cambiar (admin supremo > Textos de la página), agrupados por el
// lugar donde aparecen. Vacío o ausente = el texto de siempre (los "obligatorio" no pueden quedar
// vacíos: si se borran, vuelve el de siempre). En los que lo dicen, **así** va en negrita.
const TEXTOS_PAGINA = {
  // --- Página de reservas ---
  titulo_inicio: { grupo: 'Página de reservas', nombre: 'Título de la página', max: 60, defecto: 'Reserva de espacios', obligatorio: true },
  intro_inicio: { grupo: 'Página de reservas', nombre: 'Texto debajo del título (opcional)', max: 400, defecto: '' },
  mes_no_habilitado: { grupo: 'Página de reservas', nombre: 'Aviso de "mes no habilitado"', max: 300, defecto: 'Este mes todavía no está habilitado para reservas. Probá con "Hoy" o consultá con un moderador.' },
  lista_espera: { grupo: 'Página de reservas', nombre: 'Texto del cuadro de la lista de espera', max: 400, defecto: 'Todos los lugares del {espacio} de ese mes están ocupados. Anotate y, si alguien cancela una reserva de ese mes, te avisamos por correo para que puedas reservar. El lugar es de quien reserve primero.', comodines: ['espacio', 'mes'] },
  // Texto debajo de "Crear reserva", uno por espacio. Vacío: la página lo arma sola con las Reglas
  // "{ninguno}" (la casilla "No mostrar ningún texto" del panel): queda solo "Al reservar aceptás…"
  ayuda_reserva_frente: {
    grupo: 'Página de reservas', nombre: 'Texto debajo del botón "Crear reserva" en el Frente (opcional)', max: 400, defecto: '', comodines: ['plazo', 'limite', 'ninguno'],
    ayuda: 'Vacío = se arma solo con las Reglas (recomendado). Si lo escribís, usá {plazo} y {limite} en vez de escribir los números: se completan con las Reglas del Frente (por ejemplo "2 días antes" y "2 reservas"), así siguen siendo correctos si las cambiás. Los enlaces a los Términos y a la Política de privacidad se agregan siempre al final.'
  },
  ayuda_reserva_altillo: {
    grupo: 'Página de reservas', nombre: 'Texto debajo del botón "Crear reserva" en el Altillo (opcional)', max: 400, defecto: '', comodines: ['plazo', 'limite', 'ninguno'],
    ayuda: 'Igual que el del Frente, con las Reglas del Altillo. Sin plazo, {plazo} dice "el inicio de la reserva"; sin límite, {limite} dice "sin límite".'
  },
  // --- Ventana "¡Tu reserva quedó confirmada!" ---
  confirmacion_titulo: { grupo: 'Ventana de reserva confirmada', nombre: 'Título de la ventana', max: 80, defecto: '¡Tu reserva quedó confirmada!', obligatorio: true },
  confirmacion_mensaje: {
    grupo: 'Ventana de reserva confirmada', nombre: 'Mensaje de la ventana', max: 500, obligatorio: true, comodines: ['correo'], negritas: true,
    defecto: 'Te enviamos la confirmación por email a {correo}, con tu **código de cancelación** y un enlace para cancelar. Puede tardar unos minutos; revisá la carpeta de spam. **No hace falta volver a reservar.**',
    ayuda: '{correo} es el correo que escribió la persona (sale en negrita). **así** va en negrita. Debajo se agregan solos la regla para cancelar y el botón de Google Calendar.'
  },
  confirmacion_extra: { grupo: 'Ventana de reserva confirmada', nombre: 'Texto extra al final de la ventana (opcional)', max: 400, defecto: '' },
  // --- Página "Cancelar reserva" ---
  cancelar_ayuda: { grupo: 'Página Cancelar', nombre: 'Ayuda arriba del código', max: 300, defecto: 'Ingresá el código de cancelación que te llegó en el email de confirmación. Antes de cancelar te mostramos la reserva para que la revises.' },
  codigo_perdido: {
    grupo: 'Página Cancelar', nombre: 'Ayuda "¿Perdiste el código?"', max: 300, comodines: ['whatsapp'],
    defecto: '¿Perdiste el código y no encontrás el email? Revisá la carpeta de spam o escribinos por {whatsapp} y te ayudamos a cancelar.',
    ayuda: '{whatsapp} se convierte en el enlace "WhatsApp" al número del Frente (Configuración). Vacío = no se muestra.'
  },
  // --- Ventana "Reportar un problema" ---
  reporte_titulo: { grupo: 'Reportar un problema', nombre: 'Título de la ventana', max: 60, defecto: 'Reportar un problema', obligatorio: true },
  reporte_intro: { grupo: 'Reportar un problema', nombre: 'Texto arriba del cuadro', max: 200, defecto: 'Contanos qué hiciste y qué pasó.' },
  // --- Mensajes de error al reservar (los muestra la página cuando el servidor rechaza una reserva) ---
  error_ocupado: { grupo: 'Mensajes de error al reservar', nombre: 'Turno u horario ya ocupado', max: 200, obligatorio: true, defecto: 'Horario no disponible - se solapa con otra reserva existente', ayuda: 'La página agrega: "Se actualizaron los horarios: elegí otro turno."' },
  error_bloqueado: { grupo: 'Mensajes de error al reservar', nombre: 'Horario bloqueado por administración', max: 200, obligatorio: true, defecto: 'El horario seleccionado está bloqueado por administración' },
  error_horario_pasado: { grupo: 'Mensajes de error al reservar', nombre: 'Horario que ya pasó', max: 200, obligatorio: true, defecto: 'No se puede reservar un horario que ya pasó' },
  error_mes_no_habilitado: { grupo: 'Mensajes de error al reservar', nombre: 'Mes no habilitado', max: 200, obligatorio: true, defecto: 'Ese mes todavía no está habilitado para reservas' },
  error_limite: {
    grupo: 'Mensajes de error al reservar', nombre: 'Llegó al límite de reservas del mes', max: 300, obligatorio: true, comodines: ['cantidad', 'espacio', 'maximo'],
    defecto: 'Ya tenés {cantidad} en {espacio} para ese mes. El máximo es {maximo} por persona. Si necesitás otro turno, cancelá una de tus reservas anteriores.',
    ayuda: '{cantidad} dice "2 reservas activas" (o "1 reserva activa"), {espacio} el espacio y {maximo} el límite de las Reglas.'
  }
};

// Un texto de la página ya completado (lo usan los mensajes de error del servidor)
function textoPagina(clave, valores = {}) {
  const guardado = config.textos_pagina[clave];
  return completarComodines(guardado != null && guardado !== '' ? guardado : TEXTOS_PAGINA[clave].defecto, valores);
}

// Comodines {así} que se permiten en un texto: si aparece uno desconocido, es un error de tipeo
function revisarComodines(texto, permitidos, nombre) {
  const usados = [...String(texto).matchAll(/\{([^{}\s]+)\}/g)].map(m => m[1]);
  const malos = usados.filter(u => !permitidos.includes(u));
  if (malos.length) {
    throw new Error(`${nombre}: no existe ${malos.map(m => `{${m}}`).join(', ')}. ${permitidos.length ? `Podés usar: ${permitidos.map(p => `{${p}}`).join(', ')}` : 'Este texto no lleva comodines.'}`);
  }
}

function validarTextosPagina(valor) {
  const v = valor || {};
  const resultado = {};
  for (const [clave, def] of Object.entries(TEXTOS_PAGINA)) {
    if (v[clave] == null) continue;
    const texto = String(v[clave]).replace(/\r\n/g, '\n').trim();
    if (texto.length > def.max) throw new Error(`${def.nombre}: hasta ${def.max} caracteres`);
    if (def.obligatorio && !texto) continue; // vacío = el de siempre
    revisarComodines(texto, def.comodines || [], def.nombre);
    if (texto !== def.defecto) resultado[clave] = texto;
  }
  return resultado;
}

function validarAnuncio(valor) {
  const v = valor || {};
  const texto = String(v.texto == null ? '' : v.texto).replace(/\s+/g, ' ').trim();
  if (texto.length > 200) throw new Error('El anuncio puede tener hasta 200 caracteres');
  const activo = v.activo === true;
  if (activo && texto.length < 3) throw new Error('Escribí el texto del anuncio');
  const hasta = v.hasta == null || v.hasta === '' ? null : v.hasta;
  if (hasta !== null && !esFechaValida(hasta)) throw new Error('La fecha "mostrar hasta" del anuncio no es válida');
  const tipo = v.tipo === 'importante' ? 'importante' : 'info';
  return { activo, texto, hasta, tipo };
}

function anuncioVigente() {
  const a = config.anuncio;
  if (!a || !a.activo || !a.texto) return null;
  if (a.hasta && a.hasta < hoyEnAsuncion().toISOString().slice(0, 10)) return null;
  return { texto: a.texto, tipo: a.tipo };
}

// Plantillas de los correos que le llegan a la gente. En los correos con formato se editan el
// asunto, el título y el mensaje; los detalles de la reserva, el código, los enlaces para
// cancelar, la regla de cancelación y el contacto los agrega el sistema siempre, para que no se
// puedan borrar sin querer. Al asunto de los correos de una reserva se le agrega siempre
// " - CEQ #número" (Gmail no los agrupa y el sistema los reconoce). Los de la lista de espera van
// solo con texto (así no caen en Promociones) y se edita el texto entero; el enlace es obligatorio.
const COMODINES_RESERVA = ['nombre', 'espacio', 'fecha', 'horario', 'numero'];
const PLANTILLAS_CORREO = {
  confirmacion: {
    nombre: 'Confirmación de reserva', tipo: 'html', comodines: COMODINES_RESERVA,
    asunto: '✓ Confirmación de Reserva', titulo: '¡Reserva Confirmada!',
    mensaje: 'Hola {nombre},\n\nTu reserva ha sido confirmada exitosamente.'
  },
  recordatorio: {
    nombre: 'Recordatorio (días antes)', tipo: 'html', comodines: COMODINES_RESERVA,
    asunto: '⏰ Recordatorio: {espacio}, {fecha}', titulo: 'Te recordamos tu reserva',
    mensaje: 'Hola {nombre},\n\nTenés reservado el {espacio} el {fecha}, {horario}.\n\nSi la vas a usar, no tenés que hacer nada. ¡Te esperamos!\n\n¿Ya no la vas a usar? Cancelala, así otra persona puede aprovechar el lugar:'
  },
  cancelacion: {
    nombre: 'Cancelación hecha por la persona', tipo: 'html', comodines: COMODINES_RESERVA,
    asunto: 'Cancelación Confirmada', titulo: '¡Has cancelado correctamente tu reserva!', mensaje: ''
  },
  cancelacion_moderador: {
    nombre: 'Cancelación hecha por un moderador', tipo: 'html', comodines: [...COMODINES_RESERVA, 'motivo'],
    asunto: 'Tu Reserva Fue Cancelada por el Moderador', titulo: 'Tu reserva fue cancelada por el moderador',
    mensaje: 'Motivo: {motivo}'
  },
  plazo_vencido: {
    nombre: 'Quiso cancelar fuera de plazo', tipo: 'html', comodines: COMODINES_RESERVA,
    asunto: 'Período de Cancelación Gratuita Finalizado', titulo: 'El período de cancelación gratuita ha finalizado',
    mensaje: 'Intentaste cancelar tu reserva del {espacio}, pero el período de cancelación gratuita ya venció.'
  },
  reenvio: {
    nombre: 'Confirmación reenviada', tipo: 'html', comodines: COMODINES_RESERVA,
    asunto: '✓ Confirmación de Reserva (reenvío)', titulo: 'Tu reserva sigue confirmada',
    mensaje: 'Hola {nombre},\n\nTe reenviamos la confirmación de tu reserva, con un código de cancelación nuevo (el anterior ya no sirve).'
  },
  modificada: {
    nombre: 'Reserva modificada', tipo: 'html', comodines: [...COMODINES_RESERVA, 'cambios'],
    asunto: 'Tu reserva fue modificada', titulo: 'Tu reserva fue modificada',
    mensaje: 'Hola {nombre},\n\nActualizamos tu reserva ({cambios}). Estos son los datos vigentes:'
  },
  lista_espera_inscripcion: {
    nombre: 'Lista de espera: inscripción', tipo: 'texto', comodines: ['saludo', 'espacio', 'mes', 'enlace_quitar'], obligatorios: ['enlace_quitar'],
    asunto: 'Tu inscripción en la lista de espera del {espacio} ({mes})',
    texto: '{saludo}\n\nTe confirmamos que quedaste anotado/a en la lista de espera del {espacio} para {mes}.\n\nSi alguien cancela una reserva de ese mes, te escribimos a este correo con el día y el turno que quedó libre.\n\nSi te anotaste por error o ya conseguiste otro lugar, podés quitar tu inscripción desde este enlace:\n{enlace_quitar}\n\nSaludos,\nCentro de Estudiantes de Química'
  },
  lista_espera_aviso: {
    nombre: 'Lista de espera: se liberó un lugar', tipo: 'texto', comodines: ['saludo', 'espacio', 'mes', 'dia', 'dia_corto', 'horario', 'turno', 'enlace_reservar'], obligatorios: ['enlace_reservar'],
    asunto: 'Se liberó un lugar en el {espacio}: {dia_corto}, {turno}',
    texto: '{saludo}\n\n¡Buenas noticias! Alguien canceló su reserva y se liberó un lugar en el {espacio}:\n\nDía: {dia}\nHorario: {horario}\n\nPara reservarlo, entrá acá:\n{enlace_reservar}\n\nEl lugar es de quien reserve primero, así que conviene hacerlo cuanto antes.\n\nTe escribimos porque te anotaste en la lista de espera del {espacio} para {mes}. Este es el único aviso: si después querés otro, volvé a anotarte en la página.\n\nSaludos,\nCentro de Estudiantes de Química'
  },
  // Avisos internos: les llegan a los moderadores de cada espacio (avisos_destinatarios). Los datos
  // de la reserva (persona, contacto, espacio, fecha, horario, motivo, acompañantes, código) los
  // agrega el sistema. "Responder" le escribe directo a la persona que reservó.
  aviso_nueva: {
    nombre: 'Aviso interno: nueva reserva', tipo: 'html', interno: true, comodines: [...COMODINES_RESERVA, 'contacto'],
    asunto: '📌 Nueva Reserva ({espacio})', titulo: 'Nueva Reserva', mensaje: ''
  },
  aviso_cancelacion: {
    nombre: 'Aviso interno: la persona canceló', tipo: 'html', interno: true, comodines: [...COMODINES_RESERVA, 'contacto'],
    asunto: 'Cancelación de Reserva', titulo: 'Reserva Cancelada por Usuario', mensaje: ''
  },
  aviso_plazo_vencido: {
    nombre: 'Aviso interno: quiso cancelar fuera de plazo', tipo: 'html', interno: true, comodines: [...COMODINES_RESERVA, 'contacto'],
    asunto: 'Intento de Cancelación Fuera de Plazo', titulo: 'Intento de Cancelación (Período Vencido)',
    mensaje: 'El usuario intentó cancelar esta reserva, pero el período de cancelación gratuita ya había vencido. La reserva sigue activa.'
  },
  aviso_cancelacion_moderador: {
    nombre: 'Aviso interno: un moderador canceló', tipo: 'html', interno: true, comodines: [...COMODINES_RESERVA, 'contacto', 'motivo'],
    asunto: '🔔 Un moderador canceló una reserva ({espacio})', titulo: 'Cancelación realizada por un moderador',
    mensaje: 'Un moderador canceló la siguiente reserva desde el panel de administración:'
  }
};

// Quién recibe los avisos internos de cada espacio (admin supremo > Correos). Por defecto, los de
// siempre: Altillo -> EMAIL_MODERADOR; Frente -> EMAIL_MODERADOR y EMAIL_MODERADOR_FRENTE (Render).
function validarAvisosDestinatarios(valor) {
  const v = valor || {};
  const resultado = {};
  for (const id of [3, 1]) {
    const lista = v[id] || v[String(id)];
    const espacio = id === 3 ? 'Frente' : 'Altillo';
    if (!Array.isArray(lista)) throw new Error(`${espacio}: falta la lista de correos que reciben los avisos`);
    const correos = [...new Set(lista.map(c => String(c || '').trim().toLowerCase()).filter(Boolean))];
    if (correos.length < 1 || correos.length > 5) throw new Error(`${espacio}: entre 1 y 5 correos para los avisos`);
    const malo = correos.find(c => !EMAIL_REGEX.test(c) || c.length > 100);
    if (malo) throw new Error(`${espacio}: "${malo}" no es un correo válido`);
    resultado[id] = correos;
  }
  return resultado;
}

// Respuestas listas para copiar (admin supremo > Datos de una persona). {nombre} se completa con el
// primer nombre que se escribe en el panel y {plazo_frente} con el plazo para cancelar del Frente.
const COMODINES_RESPUESTAS = ['nombre', 'plazo_frente'];
const RESPUESTAS_POR_DEFECTO = [
  { titulo: 'Pedido de acceso a sus datos', texto: 'Hola, {nombre}:\n\nRecibimos tu solicitud de acceso a tus datos personales en el sistema de reservas del CEQ. Te enviamos adjunto un PDF con toda la información que tenemos guardada sobre vos: tus reservas, las reservas en las que figurás como acompañante y tus inscripciones en la lista de espera.\n\nSegún nuestra Política de Privacidad, los datos de las reservas se anonimizan automáticamente a los 6 meses.\n\nSi querés corregir algún dato o que borremos tu información, respondé a este correo indicándolo.\n\nSaludos,\nSecretaría de Informática — Centro de Estudiantes de Química' },
  { titulo: 'Datos borrados', texto: 'Hola, {nombre}:\n\nTe confirmamos que borramos tus datos personales del sistema de reservas del CEQ: tus reservas quedaron sin nombre ni contacto, y saliste de las listas de acompañantes y de la lista de espera.\n\nSi en el futuro volvés a reservar, se van a guardar los datos de esa nueva reserva.\n\nSaludos,\nSecretaría de Informática — Centro de Estudiantes de Química' },
  { titulo: 'Datos corregidos', texto: 'Hola, {nombre}:\n\nYa corregimos los datos de tu reserva como pediste. Te llegó (o te va a llegar en unos minutos) un correo con los datos actualizados.\n\nSi ves algo más que no esté bien, respondé a este correo.\n\nSaludos,\nCentro de Estudiantes de Química' },
  { titulo: 'No le llegó el correo', texto: 'Hola, {nombre}:\n\nTe reenviamos la confirmación de tu reserva, con un código de cancelación nuevo (el anterior ya no sirve). Revisá también la carpeta de spam o "Promociones".\n\nSi querés cancelar, podés usar el enlace "Cancelar mi reserva" de ese correo.\n\nSaludos,\nCentro de Estudiantes de Química' },
  { titulo: 'Pide cancelar fuera de plazo (Frente)', texto: 'Hola, {nombre}:\n\nRecibimos tu pedido para cancelar la reserva. Como faltan menos de {plazo_frente}, ya no se puede cancelar desde la página, pero la cancelamos nosotros: te llega la confirmación por correo.\n\nTe pedimos que la próxima vez avises con al menos {plazo_frente} de anticipación, así el turno lo puede usar otra persona.\n\nSaludos,\nCentro de Estudiantes de Química' },
  { titulo: 'Consulta general', texto: 'Hola, {nombre}:\n\nGracias por escribirnos. \n\n[Respuesta]\n\nCualquier otra duda, respondé a este correo.\n\nSaludos,\nCentro de Estudiantes de Química' }
];
function validarRespuestasListas(valor) {
  if (!Array.isArray(valor) || valor.length < 1 || valor.length > 30) throw new Error('Tiene que haber entre 1 y 30 respuestas');
  return valor.map((r, i) => {
    const titulo = String(r && r.titulo || '').replace(/\s+/g, ' ').trim();
    const texto = String(r && r.texto || '').replace(/\r\n/g, '\n').trim();
    if (titulo.length < 3 || titulo.length > 80) throw new Error(`La respuesta ${i + 1} necesita un nombre de 3 a 80 caracteres`);
    if (!texto || texto.length > 4000) throw new Error(`"${titulo}": el texto tiene que tener entre 1 y 4000 caracteres`);
    revisarComodines(texto, COMODINES_RESPUESTAS, `"${titulo}"`);
    return { titulo, texto };
  });
}

function validarPlantillasCorreo(valor) {
  const v = valor || {};
  const resultado = {};
  for (const [clave, def] of Object.entries(PLANTILLAS_CORREO)) {
    const p = v[clave];
    if (!p) continue;
    const limpiar = (t, max, nombre, unaLinea) => {
      const s = String(t == null ? '' : t).replace(/\r\n/g, '\n');
      const r = unaLinea ? s.replace(/\s+/g, ' ').trim() : s.trim();
      if (r.length > max) throw new Error(`${def.nombre} — ${nombre}: hasta ${max} caracteres`);
      if (/[<>]/.test(r)) throw new Error(`${def.nombre} — ${nombre}: no puede tener los signos < ni >`);
      revisarComodines(r, def.comodines, `${def.nombre} — ${nombre}`);
      return r;
    };
    const asunto = limpiar(p.asunto, 120, 'el asunto', true);
    if (asunto.length < 3) throw new Error(`${def.nombre}: el asunto no puede quedar vacío`);
    if (def.tipo === 'html') {
      const titulo = limpiar(p.titulo, 120, 'el título', true);
      if (!titulo) throw new Error(`${def.nombre}: el título no puede quedar vacío`);
      const mensaje = limpiar(p.mensaje, 2000, 'el mensaje', false);
      if (asunto !== def.asunto || titulo !== def.titulo || mensaje !== def.mensaje) resultado[clave] = { asunto, titulo, mensaje };
    } else {
      const texto = limpiar(p.texto, 3000, 'el texto', false);
      const faltan = (def.obligatorios || []).filter(o => !texto.includes(`{${o}}`));
      if (faltan.length) throw new Error(`${def.nombre}: el texto tiene que incluir ${faltan.map(f => `{${f}}`).join(', ')} (es el enlace que necesita la persona)`);
      if (asunto !== def.asunto || texto !== def.texto) resultado[clave] = { asunto, texto };
    }
  }
  return resultado;
}

// La plantilla vigente (la guardada o la de siempre)
function plantillaCorreo(clave) {
  return { ...PLANTILLAS_CORREO[clave], ...(config.plantillas_correo[clave] || {}) };
}

// Reemplaza los {comodines} por sus valores (los desconocidos quedan como estaban)
function completarComodines(texto, valores) {
  return String(texto || '').replace(/\{([^{}\s]+)\}/g, (todo, nombre) => (valores[nombre] !== undefined && valores[nombre] !== null ? String(valores[nombre]) : todo));
}

// Texto simple -> párrafos HTML (los valores ya se escaparon antes de reemplazarlos)
function parrafosHtml(texto) {
  return String(texto || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
    .map(p => `<p>${p.split('\n').join('<br>')}</p>`).join('\n');
}

// Asunto, título y mensaje de un correo con formato, ya completados. `valores` sin escapar.
function partesCorreo(clave, valores, numeroReserva) {
  const p = plantillaCorreo(clave);
  const escapados = Object.fromEntries(Object.entries(valores).map(([k, val]) => [k, escapeHtml(String(val == null ? '' : val))]));
  const asunto = completarComodines(p.asunto, valores) + (numeroReserva ? ` - CEQ #${numeroReserva}` : '');
  return {
    asunto,
    titulo: `<h2>${completarComodines(escapeHtml(p.titulo), escapados)}</h2>`,
    mensaje: parrafosHtml(completarComodines(escapeHtml(p.mensaje), escapados))
  };
}

// Valores comunes de una reserva para las plantillas
function valoresReserva(r, extra = {}) {
  const inicio = String(r.hora_inicio).substring(0, 5);
  const fin = String(r.hora_fin).substring(0, 5);
  return {
    nombre: r.nombre_solicitante, espacio: getEspacioNombre(r.espacio_id), fecha: fechaLarga(r.fecha),
    horario: descripcionHorario(r.espacio_id, inicio, fin), numero: r.id, contacto: r.contacto || '', ...extra
  };
}

// Normas del espacio para los correos (si hay)
function normasHtml(espacioId) {
  const normas = reglaEspacio(espacioId).normas;
  return normas ? `<p><strong>Normas de uso del ${getEspacioNombre(espacioId)}:</strong></p>${parrafosHtml(escapeHtml(normas))}` : '';
}

// ========== CORREOS A PARTIR DE LAS PLANTILLAS ==========
// Cada correo que le llega a la gente se arma acá: el asunto, el título y el mensaje salen de la
// plantilla (admin supremo > Avanzado > Correos); el resto (detalles, código, enlaces, regla de
// cancelación, normas y contacto) lo agrega siempre el sistema. Lo usan los envíos reales y el
// botón "Enviarme una prueba", así la prueba es exactamente igual al correo de verdad.

// "por WhatsApp" (Frente) o "a correo@..." (Altillo): por dónde pedir una cancelación fuera de plazo
function contactoFueraDePlazoHtml(espacioId) {
  return Number(espacioId) === 3 ? `por <a href="${enlaceWhatsappFrente()}">WhatsApp</a>` : `a ${escapeHtml(correoRespuesta(espacioId))}`;
}

// Línea de los detalles de la reserva (con o sin negrita en la etiqueta, como estaba cada correo)
function detallesReservaHtml(r, { conMotivo = false, codigo = null, etiquetasEnNegrita = true, titulo = 'Detalles:' } = {}) {
  const inicio = String(r.hora_inicio).substring(0, 5);
  const fin = String(r.hora_fin).substring(0, 5);
  const etiqueta = t => (etiquetasEnNegrita ? `<strong>${t}:</strong>` : `${t}:`);
  const acompanantes = Array.isArray(r.acompanantes) ? r.acompanantes : [];
  const filas = [
    `<li>${etiqueta('Espacio')} ${getEspacioNombre(r.espacio_id)}</li>`,
    `<li>${etiqueta('Fecha')} ${r.fecha}</li>`,
    `<li>${etiqueta('Horario')} ${descripcionHorario(r.espacio_id, inicio, fin)}</li>`
  ];
  if (conMotivo) filas.push(`<li>${etiqueta('Motivo')} ${escapeHtml(r.motivo) || 'Sin especificar'}</li>`);
  if (conMotivo && acompanantes.length) filas.push(`<li>${etiqueta('Acompañantes')} ${escapeHtml(acompanantesTexto(acompanantes))}</li>`);
  if (codigo) filas.push(`<li>${etiqueta('Código de cancelación')} ${codigo}</li>`);
  return `<p><strong>${titulo}</strong></p>\n<ul>\n  ${filas.join('\n  ')}\n</ul>`;
}

// Datos de la reserva para los avisos internos (con el contacto de la persona). Sin el código de
// cancelación (AUD-04): los moderadores cancelan desde el panel, y el código solo lo tiene la persona
// (Términos 7.4: "se almacena cifrado").
function detallesInternosHtml(r, { motivoCancelacion = null } = {}) {
  const inicio = String(r.hora_inicio).substring(0, 5);
  const fin = String(r.hora_fin).substring(0, 5);
  const acompanantes = Array.isArray(r.acompanantes) ? r.acompanantes : [];
  const filas = [
    `<li><strong>Espacio:</strong> ${getEspacioNombre(r.espacio_id)}</li>`,
    `<li><strong>Fecha:</strong> ${r.fecha}</li>`,
    `<li><strong>Horario:</strong> ${descripcionHorario(r.espacio_id, inicio, fin)}</li>`,
    `<li><strong>Motivo:</strong> ${escapeHtml(r.motivo) || 'Sin especificar'}</li>`
  ];
  if (acompanantes.length) filas.push(`<li><strong>Acompañantes:</strong> ${escapeHtml(acompanantesTexto(acompanantes))}</li>`);
  if (motivoCancelacion) filas.push(`<li><strong>Motivo de la cancelación:</strong> ${escapeHtml(motivoCancelacion)}</li>`);
  return `<p><strong>Usuario:</strong> ${escapeHtml(r.nombre_solicitante)}</p>\n<p><strong>Contacto:</strong> ${escapeHtml(r.contacto)}</p>\n<hr>\n<ul>\n  ${filas.join('\n  ')}\n</ul>`;
}

// Recordatorio: hasta cuándo se cancela gratis (o "hoy es el último día")
function plazoRecordatorioHtml(r) {
  const plazo = reglaEspacio(r.espacio_id).plazo_cancelacion_dias;
  if (!plazo) return '';
  const faltan = diferenciaEnDiasCalendario(r.fecha);
  if (faltan === plazo) {
    return `<p><strong>Hoy es el último día para cancelar gratis.</strong> Desde mañana, la cancelación solo se gestiona ${contactoFueraDePlazoHtml(r.espacio_id)}.</p>`;
  }
  return reglaCancelacionHtml(r.espacio_id, r.fecha);
}

// Arma un correo de una reserva. extra: { codigo, motivo, cambios, valores }. Devuelve { asunto, html }.
// `valores` reemplaza comodines (lo usa la prueba con datos de ejemplo).
function correoDeReserva(clave, r, extra = {}) {
  const inicio = String(r.hora_inicio).substring(0, 5);
  const fin = String(r.hora_fin).substring(0, 5);
  const p = partesCorreo(clave, valoresReserva(r, { motivo: extra.motivo || 'No especificado', cambios: extra.cambios || '', ...(extra.valores || {}) }), r.id);
  const calendario = `<p><a href="${escapeHtml(enlaceGoogleCalendar(r.espacio_id, r.fecha, inicio, fin))}">📅 Agregar a Google Calendar</a></p>`;
  const contacto = `<p>Ante cualquier consulta, contactate con: ${getContactoLineaHtml(r.espacio_id)}</p>`;
  const firma = '<p>Centro de Estudiantes de Química</p>';
  // El enlace se firma con el código vigente: el nuevo si se acaba de generar, si no el guardado
  const enlace = () => enlaceCancelacion(r.id, extra.codigo ? hashCodigo(extra.codigo) : r.codigo_cancelacion_hash);
  // (se arma solo en los correos que lo llevan: los avisos y cancelaciones no tienen enlace)
  const cancelar = () => extra.codigo
    ? `<p>Si necesitas cancelar, usa tu código en: <a href="https://reservas.ceq-una.com/cancelar.html">Cancelar Reserva</a>, o directamente este enlace: <a href="${enlace()}">Cancelar mi reserva</a></p>`
    : `<p>Si necesitás cancelar, usá directamente este enlace: <a href="${enlace()}">Cancelar mi reserva</a></p>`;
  let cuerpo;
  switch (clave) {
    case 'confirmacion':
    case 'reenvio':
    case 'modificada':
      cuerpo = [p.titulo, p.mensaje, '<hr>', detallesReservaHtml(r, { conMotivo: true, codigo: extra.codigo }), cancelar(),
        reglaCancelacionHtml(r.espacio_id, r.fecha), calendario, normasHtml(r.espacio_id), contacto, firma];
      break;
    case 'recordatorio':
      cuerpo = [p.titulo, p.mensaje,
        `<p><a href="${enlace()}" style="display:inline-block;background:#1F3A68;color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">Cancelar mi reserva</a></p>`,
        plazoRecordatorioHtml(r), calendario, normasHtml(r.espacio_id), contacto, firma];
      break;
    case 'cancelacion':
      cuerpo = [p.titulo, p.mensaje, detallesReservaHtml(r, { etiquetasEnNegrita: false }),
        `<p>Si tienes dudas, contacta con: ${getContactoLineaHtml(r.espacio_id)}</p>`];
      break;
    case 'cancelacion_moderador':
      cuerpo = [p.titulo, p.mensaje, detallesReservaHtml(r, { etiquetasEnNegrita: false, titulo: 'Detalles de la Reserva:' }),
        `<p>Si tienes preguntas, contacta con: ${getContactoLineaHtml(r.espacio_id)}</p>`];
      break;
    case 'aviso_nueva':
      cuerpo = [p.titulo, p.mensaje, detallesInternosHtml(r)];
      break;
    case 'aviso_cancelacion':
    case 'aviso_plazo_vencido':
      cuerpo = [p.titulo, p.mensaje, detallesInternosHtml(r)];
      break;
    case 'aviso_cancelacion_moderador':
      cuerpo = [p.titulo, p.mensaje, detallesInternosHtml(r, { motivoCancelacion: extra.motivo || 'No especificado' }),
        '<p style="color:#888; font-size:12px;">Este aviso les llega a los moderadores del espacio para que estén al tanto de las cancelaciones que se hacen desde el panel.</p>'];
      break;
    case 'plazo_vencido':
      cuerpo = [p.titulo, p.mensaje, detallesReservaHtml(r, { etiquetasEnNegrita: false, titulo: 'Detalles de la Reserva:' }),
        `<p>Si de todas formas deseás realizar la cancelación, escribí a ${escapeHtml(correoRespuesta(r.espacio_id))}${Number(r.espacio_id) === 3 ? ` o contactate por WhatsApp: <a href="${enlaceWhatsappFrente()}">Contactar por WhatsApp</a>` : ''}</p>`];
      break;
    default:
      throw new Error(`Plantilla de correo desconocida: ${clave}`);
  }
  return { asunto: p.asunto, html: cuerpo.filter(Boolean).join('\n') };
}

// Correos de la lista de espera (solo texto). Devuelve { asunto, texto }.
function correoListaEspera(clave, valores) {
  const p = plantillaCorreo(clave);
  return { asunto: completarComodines(p.asunto, valores), texto: completarComodines(p.texto, valores) };
}

// Términos y condiciones y Política de privacidad de siempre (ver "TÉRMINOS Y CONDICIONES Y
// POLÍTICA DE PRIVACIDAD EDITABLES" más abajo)
const LEGAL_POR_DEFECTO = require('./legal-por-defecto.json');

// ========== CONFIGURACIÓN EDITABLE (admin supremo > Avanzado > Configuración) ==========
// Turnos del Frente, límite por persona, contacto del Frente y correo de alertas. Antes estaban
// fijos en el código. Estos son los valores por defecto (los de siempre): si en la tabla
// configuracion hay otro valor guardado desde el panel, se usa ese. Se guarda en memoria (el
// servidor corre en una sola instancia) y se recarga al guardar desde el panel y cada 5 minutos.
const CONFIG_POR_DEFECTO = {
  turnos_frente: [
    { nombre: 'Desayuno', inicio: '07:00', fin: '10:00' },
    { nombre: 'Almuerzo', inicio: '10:00', fin: '13:00' },
    { nombre: 'Merienda', inicio: '14:00', fin: '18:00' }
  ],
  max_reservas_por_persona_mes: 2,
  contacto_email_frente: 'Monsegonza511@gmail.com',
  contacto_whatsapp_frente: '595972753471', // formato wa.me: código de país + número, sin +, espacios ni guiones
  email_alertas: EMAIL_MODERADOR,
  // Motivos del Frente (la persona elige uno de la lista; en el Altillo el motivo es libre)
  motivos_frente: [
    'Actividad Personal',
    'Recaudación - Asociación Estudiantil',
    'Recaudación - Secretaría CEQ',
    'Recaudación - Padrinaje',
    'Recaudación - Congreso o Evento Académico'
  ],
  // Altillo: bloques de 1 hora; el primero empieza a las 07:00 y el último a las 18:00 (se usa
  // hasta las 19:00), de 1 a 2 horas por reserva
  altillo_hora_desde: 7,
  altillo_hora_hasta: 19,
  altillo_max_horas: 2,
  // Espacios deshabilitados cuyo aviso NO se muestra al entrar a la página (se guarda el texto igual)
  avisos_ocultos: [],
  // Pausa general (admin supremo > Avanzado > Herramientas): no se puede reservar ni anotarse en la
  // lista de espera, y la página muestra el mensaje
  pausa_reservas: { activa: false, mensaje: '' },
  // Personalización (admin supremo > Avanzado > Reglas, Textos de la página y Correos)
  reglas_espacios: REGLAS_POR_DEFECTO,
  textos_pagina: {},
  anuncio: { activo: false, texto: '', hasta: null, tipo: 'info' },
  plantillas_correo: {},
  // Quién recibe los avisos internos de cada espacio (admin supremo > Correos)
  avisos_destinatarios: { 3: [...new Set([EMAIL_MODERADOR, EMAIL_MODERADOR_FRENTE].map(c => c.toLowerCase()))], 1: [EMAIL_MODERADOR.toLowerCase()] },
  // Respuestas listas para copiar (admin supremo > Datos de una persona)
  respuestas_listas: RESPUESTAS_POR_DEFECTO,
  // Términos y Política de privacidad (admin supremo > Avanzado > Términos y privacidad)
  legal_terminos: LEGAL_POR_DEFECTO.terminos,
  legal_privacidad: LEGAL_POR_DEFECTO.privacidad,
  // Ventana de novedades que ve la gente al entrar (una vez por navegador y por versión). Se
  // escribe desde el admin supremo; este es el contenido inicial.
  ventana_novedades: {
    activa: true,
    version: '2026-10',
    frecuencia: 'una_vez', // 'una_vez' (una vez por navegador) o 'cada_visita'
    hasta: null,           // "AAAA-MM-DD": después de ese día deja de mostrarse sola
    titulo: '¡Actualizamos la página de reservas!',
    intro: 'Renovamos el sistema de reservas del CEQ para que sea más fácil de usar. Esto es lo nuevo:',
    bloques: [
      { titulo: 'Nuevo diseño, más claro', texto: 'El calendario muestra mejor qué turnos quedan libres, y el contador indica las reservas del mes y del espacio que estás viendo.' },
      { titulo: 'Lista de espera', texto: 'Si ya no quedan turnos, dejá tu correo y te avisamos apenas alguien cancele una reserva.' },
      { titulo: 'Recordatorio por correo', texto: 'Dos días antes de tu reserva te llega un recordatorio, con un enlace para cancelarla si no vas a poder asistir.' }
    ],
    cierre: 'Antes de reservar, leé los Términos y condiciones y la Política de privacidad: al confirmar una reserva los aceptás. Tu nombre y el motivo se muestran en el calendario para que puedas verificar que tu reserva quedó registrada.'
  }
};
let config = { ...CONFIG_POR_DEFECTO };
// Las que se guardan en la tabla como JSON (el resto, como texto simple)
const CLAVES_CONFIG_JSON = ['turnos_frente', 'avisos_ocultos', 'ventana_novedades', 'motivos_frente', 'pausa_reservas', 'reglas_espacios', 'textos_pagina', 'anuncio', 'plantillas_correo', 'legal_terminos', 'legal_privacidad', 'avisos_destinatarios', 'respuestas_listas'];
const LIMITES_NOVEDADES = { titulo: 80, intro: 600, bloques: 6, bloqueTitulo: 60, bloqueTexto: 400, cierre: 600 };

// Valida cada valor de configuración. Devuelve el valor normalizado o lanza un Error con un
// mensaje para mostrar en el panel. Se usa al guardar desde el panel y al leer de la base.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALIDADORES_CONFIG = {
  turnos_frente(valor) {
    if (!Array.isArray(valor) || valor.length < 1 || valor.length > 5) throw new Error('Tiene que haber entre 1 y 5 turnos');
    const turnos = valor.map(t => ({
      nombre: String(t && t.nombre || '').trim(),
      inicio: String(t && t.inicio || ''),
      fin: String(t && t.fin || '')
    }));
    const minutos = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
    turnos.forEach(t => {
      if (!t.nombre || t.nombre.length > 20) throw new Error('Cada turno necesita un nombre de hasta 20 caracteres');
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t.inicio) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t.fin)) throw new Error(`Horario inválido en "${t.nombre}" (usá HH:MM)`);
      if (minutos(t.inicio) < 6 * 60 || minutos(t.fin) > 22 * 60) throw new Error(`"${t.nombre}" tiene que estar entre las 06:00 y las 22:00`);
      if (minutos(t.inicio) >= minutos(t.fin)) throw new Error(`En "${t.nombre}" la hora de inicio tiene que ser anterior a la de fin`);
    });
    turnos.sort((a, b) => minutos(a.inicio) - minutos(b.inicio));
    turnos.forEach((t, i) => {
      if (i > 0 && minutos(t.inicio) < minutos(turnos[i - 1].fin)) throw new Error(`"${turnos[i - 1].nombre}" y "${t.nombre}" se superponen`);
    });
    if (new Set(turnos.map(t => t.nombre.toLowerCase())).size !== turnos.length) throw new Error('Dos turnos no pueden tener el mismo nombre');
    return turnos;
  },
  max_reservas_por_persona_mes(valor) {
    const n = Number(valor);
    if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error('El límite por persona tiene que ser un número entre 1 y 20');
    return n;
  },
  contacto_email_frente(valor) {
    const email = String(valor || '').trim();
    if (!EMAIL_REGEX.test(email) || email.length > 100) throw new Error('El correo de contacto del Frente no es válido');
    return email;
  },
  contacto_whatsapp_frente(valor) {
    const numero = String(valor || '').replace(/\D/g, '');
    if (numero.length < 8 || numero.length > 15) throw new Error('El WhatsApp tiene que ser el número con código de país, por ejemplo 595981123456');
    return numero;
  },
  email_alertas(valor) {
    const email = String(valor || '').trim();
    if (!EMAIL_REGEX.test(email) || email.length > 100) throw new Error('El correo para las alertas no es válido');
    return email;
  },
  motivos_frente(valor) {
    if (!Array.isArray(valor) || valor.length < 1 || valor.length > 10) throw new Error('Tiene que haber entre 1 y 10 motivos');
    const motivos = valor.map(m => String(m == null ? '' : m).trim().replace(/\s+/g, ' '));
    motivos.forEach(m => {
      if (m.length < 2 || m.length > 60) throw new Error('Cada motivo tiene que tener entre 2 y 60 caracteres');
      if (/["\\]/.test(m)) throw new Error('Los motivos no pueden tener comillas dobles ni barras invertidas');
    });
    if (new Set(motivos.map(m => m.toLowerCase())).size !== motivos.length) throw new Error('Hay motivos repetidos');
    return motivos;
  },
  altillo_hora_desde(valor) {
    const n = Number(valor);
    if (!Number.isInteger(n) || n < 5 || n > 22) throw new Error('El Altillo tiene que abrir entre las 05:00 y las 22:00');
    return n;
  },
  altillo_hora_hasta(valor) {
    const n = Number(valor);
    if (!Number.isInteger(n) || n < 6 || n > 23) throw new Error('El Altillo tiene que cerrar entre las 06:00 y las 23:00');
    return n;
  },
  altillo_max_horas(valor) {
    const n = Number(valor);
    if (!Number.isInteger(n) || n < 1 || n > 12) throw new Error('El máximo de horas del Altillo tiene que ser entre 1 y 12');
    return n;
  },
  pausa_reservas(valor) {
    const v = valor || {};
    const activa = v.activa === true;
    const mensaje = String(v.mensaje == null ? '' : v.mensaje).replace(/\r\n/g, '\n').trim();
    if (mensaje.length > 300) throw new Error('El mensaje de la pausa puede tener hasta 300 caracteres');
    if (activa && mensaje.length < 5) throw new Error('Escribí el mensaje que va a ver la gente (por ejemplo: "Volvemos el lunes")');
    return { activa, mensaje };
  },
  reglas_espacios: validarReglasEspacios,
  textos_pagina: validarTextosPagina,
  anuncio: validarAnuncio,
  plantillas_correo: validarPlantillasCorreo,
  avisos_destinatarios: validarAvisosDestinatarios,
  respuestas_listas: validarRespuestasListas,
  legal_terminos: valor => validarDocumentoLegal(valor),
  legal_privacidad: valor => validarDocumentoLegal(valor),
  avisos_ocultos(valor) {
    if (!Array.isArray(valor)) throw new Error('avisos_ocultos tiene que ser una lista');
    const ids = [...new Set(valor.map(Number))];
    if (ids.some(id => ![1, 3].includes(id))) throw new Error('avisos_ocultos solo admite el Frente y el Altillo');
    return ids.sort();
  },
  ventana_novedades(valor) {
    const v = valor || {};
    const L = LIMITES_NOVEDADES;
    const texto = (t, max, nombre) => {
      const s = String(t == null ? '' : t).replace(/\r\n/g, '\n').trim();
      if (s.length > max) throw new Error(`${nombre} puede tener hasta ${max} caracteres`);
      return s;
    };
    const titulo = texto(v.titulo, L.titulo, 'El título');
    if (!titulo) throw new Error('La ventana necesita un título');
    const bloques = Array.isArray(v.bloques) ? v.bloques : [];
    if (bloques.length > L.bloques) throw new Error(`Puede haber hasta ${L.bloques} bloques`);
    const version = String(v.version || '');
    if (!/^[\w.:-]{1,40}$/.test(version)) throw new Error('Versión de la ventana inválida');
    const frecuencia = v.frecuencia == null ? 'una_vez' : v.frecuencia;
    if (!['una_vez', 'cada_visita'].includes(frecuencia)) throw new Error('Frecuencia inválida');
    const hasta = v.hasta == null || v.hasta === '' ? null : v.hasta;
    if (hasta !== null && !esFechaValida(hasta)) throw new Error('La fecha "mostrar hasta" no es válida');
    return {
      activa: v.activa === true,
      version,
      frecuencia,
      hasta,
      titulo,
      intro: texto(v.intro, L.intro, 'El texto de introducción'),
      bloques: bloques.map((b, i) => {
        const bt = texto(b && b.titulo, L.bloqueTitulo, `El título del bloque ${i + 1}`);
        const bx = texto(b && b.texto, L.bloqueTexto, `El texto del bloque ${i + 1}`);
        if (!bt && !bx) throw new Error(`El bloque ${i + 1} está vacío`);
        return { titulo: bt, texto: bx };
      }),
      cierre: texto(v.cierre, L.cierre, 'El texto final')
    };
  }
};

async function cargarConfiguracion() {
  const { data, error } = await supabase
    .from('configuracion')
    .select('clave, valor')
    .in('clave', Object.keys(VALIDADORES_CONFIG));
  if (error) throw error;
  const nueva = { ...CONFIG_POR_DEFECTO };
  (data || []).forEach(({ clave, valor }) => {
    try {
      nueva[clave] = VALIDADORES_CONFIG[clave](CLAVES_CONFIG_JSON.includes(clave) ? JSON.parse(valor) : valor);
    } catch (err) {
      console.error(`⚠️ Configuración "${clave}" inválida en la base, se usa el valor por defecto:`, err.message);
    }
  });
  config = nueva;
}

// Los motivos del Frente y el horario del Altillo están en la configuración (config.motivos_frente,
// config.altillo_hora_desde/hasta, config.altillo_max_horas): los cambia el admin supremo.

// Acompañantes (opcional): [{ nombre, celular }]. Cuántos se permiten en cada espacio lo dicen las
// Reglas (acompanantes_max; por defecto Altillo 4 y Frente 0); la base acepta hasta 10
// (MAX_ACOMPANANTES_TOTAL). Devuelve la lista limpia o lanza un Error con el mensaje para la persona.
const MAX_ACOMPANANTES_TOTAL = 10;
function validarAcompanantes(valor, maximo) {
  if (valor === undefined || valor === null) return [];
  if (!Array.isArray(valor) || valor.length > maximo) throw new Error(`Se pueden anotar hasta ${maximo} acompañantes`);
  return valor.map((a, i) => {
    const nombre = String(a && a.nombre || '').trim();
    const celular = String(a && a.celular || '').trim();
    if (nombre.length < 2 || nombre.length > 100) throw new Error(`Escribí el nombre del acompañante ${i + 1}`);
    if (celular.length > 30 || celular.replace(/\D/g, '').length < 6) throw new Error(`Escribí un celular válido para el acompañante ${i + 1}`);
    return { nombre, celular };
  });
}

function acompanantesTexto(lista) {
  return (Array.isArray(lista) ? lista : []).map(a => `${a.nombre} (${a.celular})`).join(', ');
}

// Nombre del turno del Frente para un horario ("Desayuno"), o '' si no coincide con ninguno
function nombreTurnoFrente(horaInicioHHMM, horaFinHHMM) {
  const turno = config.turnos_frente.find(t => t.inicio === horaInicioHHMM && t.fin === horaFinHHMM);
  return turno ? turno.nombre : '';
}

function listaTurnosFrenteTexto() {
  return config.turnos_frente.map(t => `${t.nombre} (${t.inicio}-${t.fin})`).join(', ');
}

function enlaceWhatsappFrente() {
  return `https://wa.me/${config.contacto_whatsapp_frente}`;
}

// Devuelve el HTML de la línea de contacto a mostrarle al usuario según el espacio.
// Frente: email de contacto + WhatsApp. Altillo: solo el email general del moderador.
// A quién responde la persona que reservó: Frente -> su contacto (configurable); el resto -> correo general
function correoRespuesta(espacio_id) {
  return Number(espacio_id) === 3 ? config.contacto_email_frente : CORREO_CONTACTO;
}

// Correo de la persona que reservó ("celular | email"), para que el moderador le responda directo
function correoDeContacto(contacto) {
  const email = String(contacto || '').split('|')[1]?.trim() || '';
  return EMAIL_REGEX.test(email) ? email : undefined;
}

function getContactoLineaHtml(espacio_id) {
  if (Number(espacio_id) === 3) {
    return `${escapeHtml(config.contacto_email_frente)} o por <a href="${enlaceWhatsappFrente()}">WhatsApp</a>`;
  }
  return CORREO_CONTACTO;
}

// Función helper para enviar emails vía la API de Brevo.
// Nunca lanza error (lo captura y lo loguea), así que se llama SIN await: los
// endpoints responden al usuario de inmediato y el email sale en segundo plano,
// en vez de hacer esperar al usuario varios segundos a que conteste Brevo.
// `text` (opcional): versión en texto simple que va junto al HTML.
// `responderA` (opcional): a quién le llega si se toca "Responder". Por defecto, a reservas@ceq-una.com
// (CORREO_CONTACTO), que desde el 16/10/2026 sí recibe (antes no tenía buzón y las respuestas rebotaban).
// `adjuntos` (opcional): [{ name, content }] con content en base64.
async function enviarEmail({ to, subject, html, text, responderA, adjuntos }) {
  try {
    const destinatarios = Array.isArray(to) ? to : [to];
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: 'CEQ Reservas', email: 'reservas@ceq-una.com' },
        to: destinatarios.map(email => ({ email })),
        subject,
        // Sin HTML se manda solo el texto (algunos correos van así a propósito, ver la lista de espera)
        ...(html ? { htmlContent: html } : {}),
        replyTo: { email: EMAIL_REGEX.test(String(responderA || '')) ? responderA : CORREO_CONTACTO },
        ...(text ? { textContent: text } : {}),
        ...(adjuntos && adjuntos.length ? { attachment: adjuntos } : {})
      }),
      // Si Brevo no contesta, se corta a los 15 s (cuenta como fallo y la cola lo reintenta)
      signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      console.error('⚠️ Error al enviar email vía Brevo:', res.status, errorData);
      ultimoErrorEmail = `Brevo ${res.status}: ${String(errorData.message || errorData.code || '').slice(0, 200)}`;
      return false;
    }
    return true;
  } catch (err) {
    console.error('⚠️ Error de red al enviar email:', err);
    ultimoErrorEmail = `Error de red: ${String(err && err.message || err).slice(0, 200)}`;
    return false;
  }
}
let ultimoErrorEmail = '';

// ========== COLA DE CORREOS (CEQ-06) ==========
// Los correos de las reservas (confirmaciones, avisos a los moderadores, cancelaciones,
// recordatorios, reportes) primero se guardan en la tabla correos_pendientes y después se
// mandan. Si Brevo falla, se reintenta a los 1, 5, 15, 60 y 180 minutos; si el servidor se
// reinicia en el medio, se retoma al volver. Antes, si Brevo fallaba justo en ese momento, el
// correo se perdía (la reserva quedaba guardada igual, pero la persona no recibía su código).
// Privacidad: cuando un correo sale, se borra su contenido de la tabla (tiene el código de
// cancelación en claro). Los que se dan por perdidos lo conservan para poder reintentarlos desde
// el panel. Todas las filas se borran a los 7 días.
// Si la tabla no está (o la base no responde), se manda directo, como antes.
const REINTENTOS_CORREO_MIN = [1, 5, 15, 60, 180];
const INTERVALO_COLA_CORREOS_MS = Number(process.env.INTERVALO_COLA_CORREOS_MS) || 60 * 1000;
let colaCorreosEnCurso = false;

// Nunca lanza error. Devuelve true si el correo quedó en la cola (o salió directo).
async function encolarCorreo({ to, subject, html, text, responderA }) {
  const destinatarios = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (destinatarios.length === 0) return false;
  try {
    const ahora = new Date().toISOString();
    const { data, error } = await supabase.from('correos_pendientes').insert([{
      destinatarios, asunto: subject, html: html || '', texto: text || null,
      responder_a: responderA || null, estado: 'pendiente', proximo_intento: ahora, creado_en: ahora
    }]).select('id');
    if (error || !data || data.length === 0) throw error || new Error('la cola no devolvió la fila');
    procesarColaCorreos().catch(err => console.error('⚠️ Cola de correos:', err));
    return true;
  } catch (err) {
    console.error('⚠️ No se pudo guardar el correo en la cola, se manda directo:', err && (err.message || err.code));
    return enviarEmail({ to: destinatarios, subject, html, text, responderA });
  }
}

async function procesarColaCorreos() {
  if (colaCorreosEnCurso) return;
  colaCorreosEnCurso = true;
  try {
    const ahora = new Date().toISOString();
    // Pendientes cuya hora llegó, y los que quedaron "enviando" porque el servidor se reinició
    const [pendientes, colgados] = await Promise.all([
      supabase.from('correos_pendientes').select('*').eq('estado', 'pendiente').lte('proximo_intento', ahora).order('id', { ascending: true }).limit(20),
      supabase.from('correos_pendientes').select('*').eq('estado', 'enviando').lt('reclamado_hasta', ahora).order('id', { ascending: true }).limit(20)
    ]);
    if (pendientes.error) throw pendientes.error;
    if (colgados.error) throw colgados.error;
    for (const correo of [...(colgados.data || []), ...(pendientes.data || [])]) {
      // Se "reclama" con la condición del estado anterior: si otra vuelta ya lo tomó, no se repite
      const reclamo = supabase.from('correos_pendientes')
        .update({ estado: 'enviando', reclamado_hasta: new Date(Date.now() + 5 * 60 * 1000).toISOString() })
        .eq('id', correo.id).eq('estado', correo.estado);
      const { data: tomado, error: errorReclamo } = await (correo.estado === 'enviando'
        ? reclamo.lt('reclamado_hasta', ahora) : reclamo).select('id');
      if (errorReclamo) throw errorReclamo;
      if (!tomado || tomado.length === 0) continue;

      const ok = await enviarEmail({ to: correo.destinatarios, subject: correo.asunto, html: correo.html || undefined, text: correo.texto || undefined, responderA: correo.responder_a });
      const intentos = (correo.intentos || 0) + 1;
      let cambios;
      if (ok) {
        cambios = { estado: 'enviado', enviado_en: new Date().toISOString(), intentos, html: '', texto: null, destinatarios: [], ultimo_error: null };
      } else if (intentos > REINTENTOS_CORREO_MIN.length) {
        // Se da por perdido. Conserva el contenido para poder reintentarlo desde el panel ("Hoy");
        // igual se borra con la fila a los 7 días
        cambios = { estado: 'fallido', intentos, ultimo_error: ultimoErrorEmail };
        anotarAlerta('error', `Correo no enviado después de ${intentos} intentos: "${correo.asunto}" (${ultimoErrorEmail})`);
      } else {
        const espera = REINTENTOS_CORREO_MIN[intentos - 1] * 60 * 1000;
        cambios = { estado: 'pendiente', intentos, ultimo_error: ultimoErrorEmail, proximo_intento: new Date(Date.now() + espera).toISOString() };
      }
      const { error: errorFinal } = await supabase.from('correos_pendientes').update(cambios).eq('id', correo.id);
      if (errorFinal) console.error('⚠️ No se pudo actualizar la cola de correos:', errorFinal);
    }
  } finally {
    colaCorreosEnCurso = false;
  }
}

// Se borran las filas ya resueltas (enviadas o perdidas) de hace más de 7 días
async function limpiarColaCorreos() {
  const { error } = await supabase.from('correos_pendientes').delete()
    .in('estado', ['enviado', 'fallido']).lt('creado_en', new Date(Date.now() - 7 * 86400000).toISOString());
  if (error && error.code !== '42P01' && error.code !== 'PGRST205') throw error;
}

// ========== TOPES DIARIOS DE CORREOS (AUD-01, AUD-17) ==========
// Brevo gratis manda 300 correos por día EN TOTAL, y lo importante son las confirmaciones con el
// código. Los correos que no son de una reserva (inscripción y avisos de la lista de espera, avisos
// de reportes y pruebas del panel) se frenan cuando en el día ya hay LIMITE_CORREOS_OPCIONALES en
// la cola, así siempre queda lugar para las reservas. Todo se cuenta en la base y no en memoria:
// antes los topes volvían a cero con cada reinicio o deploy del servidor.
const LIMITE_CORREOS_OPCIONALES = 250;

// Instante (ISO, en UTC) en que empezó el día de hoy en Paraguay
function inicioDelDiaEnAsuncion() {
  const medianocheUtc = hoyEnAsuncion(); // 00:00 UTC de la fecha de hoy en Paraguay
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Asuncion', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(medianocheUtc).map(x => [x.type, x.value]));
  // Qué hora marca el reloj de Paraguay en ese instante: la diferencia es el huso (hoy, 3 horas)
  const relojParaguay = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return new Date(2 * medianocheUtc.getTime() - relojParaguay).toISOString();
}

// Cuántas filas de `tabla` tienen la fecha `columna` desde que empezó el día (hasta `tope`)
async function contarDeHoy(tabla, columna, filtrar = q => q, tope = 1000) {
  const { data, error } = await filtrar(supabase.from(tabla).select('id').gte(columna, inicioDelDiaEnAsuncion())).limit(tope);
  if (error) throw error;
  return (data || []).length;
}

// Cuántos correos más que no son de una reserva se pueden mandar hoy. Si no se puede contar (la
// base no responde), no se frena nada: el correo igual pasa por la cola.
async function correosOpcionalesRestantesHoy() {
  try {
    return Math.max(LIMITE_CORREOS_OPCIONALES - await contarDeHoy('correos_pendientes', 'creado_en'), 0);
  } catch (err) {
    console.error('⚠️ No se pudieron contar los correos de hoy:', err && (err.message || err.code));
    return LIMITE_CORREOS_OPCIONALES;
  }
}

// Configuración de seguridad
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
// Contraseña del admin supremo (opcional, también cifrada con bcrypt). Con ella se entra al
// mismo panel, pero con la pestaña "Avanzado". Si no está configurada, solo existe el admin normal.
const SUPERADMIN_PASSWORD_HASH = process.env.SUPERADMIN_PASSWORD_HASH || '';
// Clave con la que la planilla de Google Sheets pide las reservas (GET /api/sincronizacion/reservas).
// Opcional: si no está (o tiene menos de 32 caracteres), esa ruta queda desactivada.
const CLAVE_SINCRONIZACION = process.env.CLAVE_SINCRONIZACION || '';
const SINCRONIZACION_ACTIVA = CLAVE_SINCRONIZACION.length >= 32;

// ========== MIDDLEWARE ==========

// Cabeceras de seguridad (SEC-004). CSP queda deshabilitada por ahora: el frontend
// actual usa scripts y handlers inline (onclick=...) en varios lugares, y activar una
// CSP estricta sin antes extraer ese código a archivos separados rompería la UI.
// Pendiente: extraer JS inline de index.html/admin.html y activar contentSecurityPolicy.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// CORS configurado correctamente
app.use(cors({
  origin: [
    'https://reservas.ceq-una.com',
    'http://localhost:3000',
    'http://localhost:5173'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'DELETE', 'PUT'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  // Para que la página sepa cuánto esperar después de un 429 (CEQ-11)
  exposedHeaders: ['Retry-After', 'RateLimit-Reset']
}));

// Limitar tamaño de payloads. Los Términos y la Privacidad enteros (editor del admin supremo)
// ocupan unos 15 KB y pueden crecer: esas rutas aceptan hasta 400 KB; todo lo demás, 10 KB.
app.use('/api/superadmin/legal', express.json({ limit: '400kb' }));
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());

// ========== RATE LIMITING (AUTH-001, ABUSE-001) ==========

// IP real del visitante para usar como clave de los rate limiters.
// La API corre en Render, que tiene delante su propio Cloudflare + un balanceador
// interno. Verificado en logs: X-Forwarded-For llega como
// "<cliente>, <IP de Cloudflare>, <10.x interna de Render>", así que con
// `trust proxy 1` req.ip era la 10.x interna — la MISMA para todos los visitantes,
// y todo el sitio compartía un único contador. Cloudflare siempre pisa el header
// cf-connecting-ip con la IP real que se conectó a él, así que el cliente no lo
// puede falsificar. Si no viene (o no es una IP válida), se usa req.ip como antes.
function obtenerIpCliente(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && net.isIP(cf.trim())) {
    return cf.trim();
  }
  return req.ip;
}

// Cuando un limiter rechaza un pedido (429), lo deja registrado en los logs de Render
// (buscar "429" en Logs) antes de responder. Sin esto, los 429 no dejaban ningún rastro
// y uno solo se enteraba por los reportes de usuarios. Si aparecen IPs 10.x acá, es
// señal de que Render dejó de mandar cf-connecting-ip y hay que revisar obtenerIpCliente().
function registrar429(req, res, next, options) {
  // Sin la parte después del "?": ahí viajan los enlaces de cancelación (CEQ-13)
  console.warn(`⚠️ 429 rate limit: IP ${obtenerIpCliente(req)} en ${req.method} ${req.path}`);
  anotarAlerta('429', `${obtenerIpCliente(req)}|${req.method} ${req.originalUrl.split('?')[0]}`);
  res.status(options.statusCode).json(options.message);
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5,
  // Solo cuentan los intentos fallidos: un login correcto no consume el cupo
  skipSuccessfulRequests: true,
  keyGenerator: obtenerIpCliente,
  handler: registrar429,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Probá de nuevo en unos minutos.' }
});

const crearReservaLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  // Antes 15 y después 30: en una red compartida (WiFi de facultad) varias personas salen
  // con la misma IP pública, y el día que se habilita un mes nuevo reservan muchas a la vez.
  // El límite real por persona lo pone el cupo mensual; este solo frena abusos automáticos.
  max: 150,
  keyGenerator: obtenerIpCliente,
  handler: registrar429,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Probá de nuevo más tarde.' }
});

const cancelarLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: obtenerIpCliente,
  handler: registrar429,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de cancelación. Probá de nuevo más tarde.' }
});

const reportesLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: obtenerIpCliente,
  handler: registrar429,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados reportes enviados. Probá de nuevo más tarde.' }
});

const listaEsperaLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  keyGenerator: obtenerIpCliente,
  handler: registrar429,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas inscripciones seguidas. Probá de nuevo más tarde.' }
});

// Límite genérico para endpoints públicos de solo lectura (más permisivo, pero
// evita que queden completamente sin ningún tope de scraping/DoS barato)
const lecturaPublicaLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutos
  // Antes era 60. Con el auto-refresco del calendario cada 20s haciendo hasta 4
  // pedidos por ciclo, UNA sola pestaña abierta ya gastaba las 60 solicitudes en
  // 5 minutos. En redes compartidas (WiFi de facultad, misma operadora móvil)
  // varias personas distintas salen con la misma IP pública, así que el cupo se
  // agotaba entre todas con uso normal, no por abuso. 300 deja margen holgado
  // para varias decenas de personas conectadas simultáneamente desde la misma IP.
  // Subido a 1200 (antes 600) al pasar el auto-refresco del calendario a cada 20s:
  // una pestaña abierta hace ~40-50 pedidos cada 5 min, así que esto alcanza para
  // ~25 personas usando el sitio a la vez detrás de la misma IP pública (ej. WiFi de facultad).
  max: 1200,
  keyGenerator: obtenerIpCliente,
  handler: registrar429,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Probá de nuevo en unos minutos.' }
});

// La planilla de Google Sheets se actualiza una vez por hora: 30 pedidos por hora deja margen
// para "Actualizar ahora" a mano y corta cualquier intento de adivinar la clave
const sincronizacionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyGenerator: obtenerIpCliente,
  handler: registrar429,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes de sincronización. Probá de nuevo más tarde.' }
});

// ========== UTILIDADES ==========

// Supabase entrega como máximo 1000 filas por pedido: esto pide de a 1000 hasta traer todas.
// `armarConsulta` tiene que devolver una consulta nueva cada vez, con un orden que no cambie
// entre páginas (por eso siempre se ordena también por id).
// Si hay más de `maximo` filas, lanza un error en vez de devolver la lista cortada (CEQ-08):
// antes se cortaba sin avisar, y un listado, una exportación o el calendario podían parecer
// completos sin estarlo.
async function leerTodasLasFilas(armarConsulta, maximo = 50000) {
  const TAM_PAGINA = 1000;
  const filas = [];
  for (let desde = 0; ; desde += TAM_PAGINA) {
    if (desde >= maximo) {
      throw new Error(`Hay más de ${maximo} filas para leer: no se muestra una lista incompleta`);
    }
    const { data, error } = await armarConsulta().range(desde, desde + TAM_PAGINA - 1);
    if (error) throw error;
    filas.push(...(data || []));
    if (!data || data.length < TAM_PAGINA) break;
  }
  return filas;
}

// Fecha y hora de la base -> texto ISO en UTC ("2026-10-11T08:41:05.123Z"). created_at no trae
// zona (la base guarda en UTC); cancelada_en sí ("+00:00").
function aIsoUtc(valor) {
  if (!valor) return null;
  let texto = String(valor).replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(texto)) texto += 'Z';
  const fecha = new Date(texto);
  return isNaN(fecha) ? null : fecha.toISOString();
}

// El máximo de reservas activas por persona por mes (formulario público) ahora está en
// config.max_reservas_por_persona_mes (se cambia desde el panel del admin supremo).
// Se aplica a todos por igual: ya no hay correos exentos.

// A partir de un contacto "celular | email" devuelve { email, celular } normalizados,
// para reconocer a la misma persona aunque escriba distinto el número
// (0981 123 456, +595 981123456, 981-123-456 → "981123456": últimos 9 dígitos).
function identidadContacto(contacto) {
  const [cel = '', mail = ''] = String(contacto || '').split('|').map(p => p.trim());
  const digitos = cel.replace(/\D/g, '');
  return {
    email: mail.toLowerCase() || null,
    celular: digitos.length >= 6 ? digitos.slice(-9) : null
  };
}

// true si la reserva ya terminó: el día ya pasó, o es hoy y su hora de fin ya pasó (en Paraguay)
function reservaYaTermino(reserva) {
  const dias = diferenciaEnDiasCalendario(reserva.fecha);
  if (dias !== 0) return dias < 0;
  const [h, m] = String(reserva.hora_fin).split(':').map(Number);
  return horaActualEnAsuncionEnMinutos() >= h * 60 + m;
}

// Fecha "AAAA-MM-DD" que exista de verdad (new Date convierte en silencio el 31/02 en 03/03)
function esFechaValida(fecha) {
  if (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false;
  const d = new Date(fecha + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === fecha;
}

// Número entero positivo, como número o como texto de solo dígitos (parseInt aceptaba "3abc")
function enteroPositivo(valor) {
  if (typeof valor === 'number') return Number.isSafeInteger(valor) && valor > 0 ? valor : null;
  if (typeof valor === 'string' && /^\d{1,9}$/.test(valor.trim())) return Number(valor.trim()) || null;
  return null;
}

// Valida y normaliza los datos de una reserva antes de guardar nada (CEQ-03). Lanza un Error con
// el mensaje para la persona. Devuelve los valores limpios que se usan para guardar y escribir.
function validarDatosDeReserva(body) {
  const b = body || {};
  const campos = ['nombre_solicitante', 'contacto', 'fecha', 'hora_inicio', 'hora_fin', 'motivo'];
  if (campos.some(k => b[k] == null || b[k] === '') || b.espacio_id == null || b.espacio_id === '') {
    throw new Error('Faltan parámetros requeridos');
  }
  if (campos.some(k => typeof b[k] !== 'string')) throw new Error('Tipos de datos inválidos');
  const espacioIdNum = enteroPositivo(b.espacio_id);
  if (!espacioIdNum) throw new Error('Espacio inválido');

  const nombre = b.nombre_solicitante.trim().replace(/\s+/g, ' ');
  const motivo = b.motivo.trim();
  if (nombre.length > 150 || b.contacto.length > 200 || motivo.length > 500) {
    throw new Error('Uno o más campos exceden la longitud permitida');
  }
  if (nombre.length < 2 || !/\p{L}/u.test(nombre)) throw new Error('Escribí tu nombre y apellido');
  if (!motivo) throw new Error('Faltan parámetros requeridos');

  // El resto del sistema usa el formato "celular | email" (confirmaciones, límite por persona)
  const partes = b.contacto.split('|').map(p => p.trim());
  if (partes.length !== 2) throw new Error('El contacto debe tener el formato "celular | email" con un email válido');
  const [celular, emailCrudo] = partes;
  const email = emailCrudo.toLowerCase();
  const digitos = celular.replace(/\D/g, '');
  if (!/^\+?[\d\s()-]+$/.test(celular) || digitos.length < 7 || digitos.length > 15) {
    throw new Error('El celular no es válido: usá solo números (por ejemplo, 0981 123 456)');
  }
  if (!EMAIL_REGEX.test(email) || email.length > 100) {
    throw new Error('El contacto debe tener el formato "celular | email" con un email válido');
  }
  if (!esFechaValida(b.fecha)) throw new Error('Fecha inválida');

  return {
    espacioIdNum,
    nombre_solicitante: nombre,
    contacto: `${celular} | ${email}`,
    fecha: b.fecha,
    hora_inicio: b.hora_inicio,
    hora_fin: b.hora_fin,
    motivo
  };
}

function getEspacioNombre(id) {
  const espacios = { 1: 'Altillo', 2: 'Sala de Reuniones', 3: 'Frente' };
  return espacios[id] || 'Espacio ' + id;
}

// Frente reserva por turnos fijos con nombre propio (Desayuno/Almuerzo/Merienda), no por
// horario libre como Altillo. En vez de mostrar solo el rango crudo "07:00 - 10:00" en
// emails y en el detalle del día, se muestra el nombre del turno junto con el rango, para
// que quede claro qué momento del día y qué horario exacto puede usar la persona.
// Recibe horaInicio/horaFin ya recortadas a "HH:MM" (sin segundos). Los turnos salen de la
// configuración (config.turnos_frente); una reserva hecha con un turno que después se cambió
// se muestra solo con su rango horario.
function descripcionHorario(espacioId, horaInicioHHMM, horaFinHHMM) {
  const rango = `${horaInicioHHMM} - ${horaFinHHMM}`;
  if (Number(espacioId) === 3) {
    const nombreTurno = nombreTurnoFrente(horaInicioHHMM, horaFinHHMM);
    if (nombreTurno) return `${nombreTurno} (${rango})`;
  }
  return rango;
}

// Regla de cancelación para los correos (la misma que aplica /api/cancelar-por-codigo): gratis
// con el código hasta N días antes (admin supremo > Reglas; Frente: 2); después, por WhatsApp en
// el Frente o por correo en el Altillo. Sin plazo (0) no se agrega nada.
// Antes la gente se enteraba recién cuando intentaba cancelar y el sistema no la dejaba.
function reglaCancelacionHtml(espacioId, fecha) {
  const plazo = reglaEspacio(espacioId).plazo_cancelacion_dias;
  if (!plazo) return '';
  const contacto = contactoFueraDePlazoHtml(espacioId);
  const dias = plazo === 1 ? '1 día' : `${plazo} días`;
  if (diferenciaEnDiasCalendario(fecha) < plazo) {
    return `<p>${plazo === 1 ? 'Como la reserva es hoy' : `Como faltan menos de ${dias}`}, esta reserva ya no se puede cancelar con el código. Si necesitás cancelarla, escribinos ${contacto}.</p>`;
  }
  const limite = new Date(fecha + 'T00:00:00Z');
  limite.setUTCDate(limite.getUTCDate() - plazo);
  const fechaLimite = `${String(limite.getUTCDate()).padStart(2, '0')}/${String(limite.getUTCMonth() + 1).padStart(2, '0')}/${limite.getUTCFullYear()}`;
  return `<p>Podés cancelarla gratis con tu código hasta el <strong>${fechaLimite}</strong> (${dias} antes). Después de esa fecha, la cancelación solo se gestiona ${contacto}.</p>`;
}

// Enlace que abre Google Calendar con el evento de la reserva ya cargado (en hora de Paraguay).
// Recibe horaInicio/horaFin como "HH:MM".
function enlaceGoogleCalendar(espacioId, fecha, horaInicioHHMM, horaFinHHMM) {
  const dia = fecha.replace(/-/g, '');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Reserva del ${getEspacioNombre(espacioId)} - CEQ`,
    dates: `${dia}T${horaInicioHHMM.replace(':', '')}00/${dia}T${horaFinHHMM.replace(':', '')}00`,
    ctz: 'America/Asuncion',
    details: `Horario: ${descripcionHorario(espacioId, horaInicioHHMM, horaFinHHMM)}\nPara cancelar, usá el código de tu email de confirmación en https://reservas.ceq-una.com/cancelar.html`,
    location: 'Centro de Estudiantes de Química - Facultad de Ciencias Químicas (UNA)'
  });
  return 'https://calendar.google.com/calendar/render?' + params.toString();
}

// ========== ENLACES PARA CANCELAR SIN EL CÓDIGO ==========
// Los correos (confirmación y recordatorio) traen un enlace que cancela la reserva sin tener
// que escribir el código: el código no se puede volver a mostrar porque solo se guarda cifrado
// (SEC-005). El enlace lleva una firma HMAC del número de reserva con una clave derivada de
// JWT_SECRET: no se puede fabricar para otra reserva. Si se cambia JWT_SECRET, los enlaces
// viejos dejan de andar (el código sigue sirviendo). Cancelar por enlace sigue las mismas
// reglas que con el código (Frente: hasta 2 días antes).
// AUD-09: la firma lleva también el código de cancelación cifrado de la reserva. Si el código cambia
// (se corrige el correo de la reserva o se reenvía la confirmación), el enlace anterior deja de
// servir. Antes la firma dependía solo del número, y quien tenía un correo viejo seguía pudiendo
// cancelar.
const CLAVE_ENLACES_V1 = crypto.createHmac('sha256', JWT_SECRET).update('enlaces-de-cancelacion-v1').digest();
const CLAVE_ENLACES = crypto.createHmac('sha256', JWT_SECRET).update('enlaces-de-cancelacion-v2').digest();
// Los enlaces que ya se mandaron antes de este cambio solo dependían del número: siguen sirviendo
// para las reservas hechas hasta entonces (las más nuevas ya tienen la firma con el código)
const FIN_ENLACES_V1 = Date.parse('2026-10-24T12:00:00Z');

function tokenCancelacion(reservaId, codigoHash) {
  return crypto.createHmac('sha256', CLAVE_ENLACES).update(`cancelar:${Number(reservaId)}:${codigoHash || ''}`).digest('base64url').slice(0, 32);
}

function tokenCancelacionV1(reservaId) {
  return crypto.createHmac('sha256', CLAVE_ENLACES_V1).update(`cancelar:${Number(reservaId)}`).digest('base64url').slice(0, 32);
}

function mismaFirma(esperado, token) {
  const a = Buffer.from(esperado);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// `reserva` es la fila de la base (con codigo_cancelacion_hash y created_at)
function tokenCancelacionValido(reserva, token) {
  if (!reserva || !esIdValido(reserva.id) || typeof token !== 'string' || token.length !== 32) return false;
  if (mismaFirma(tokenCancelacion(reserva.id, reserva.codigo_cancelacion_hash), token)) return true;
  const creada = Date.parse(aIsoUtc(reserva.created_at) || '');
  return Number.isFinite(creada) && creada < FIN_ENLACES_V1 && mismaFirma(tokenCancelacionV1(reserva.id), token);
}

function enlaceCancelacion(reservaId, codigoHash) {
  if (!codigoHash) console.warn(`⚠️ Enlace para cancelar la reserva #${reservaId} sin el código cifrado: no va a servir`);
  return `https://reservas.ceq-una.com/cancelar.html?r=${Number(reservaId)}&t=${tokenCancelacion(reservaId, codigoHash)}`;
}

// "jueves 16/10/2026" para los correos
function fechaLarga(fechaISO) {
  const [a, m, d] = fechaISO.split('-').map(Number);
  const dia = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][new Date(Date.UTC(a, m - 1, d)).getUTCDay()];
  return `${dia} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${a}`;
}

// Middleware de autenticación JWT (AUTH-002: el token viaja en una cookie httpOnly,
// no en localStorage ni en el header Authorization. Esto hace que sea imposible que
// JavaScript del lado del cliente lea o robe el token, incluso si hubiera un XSS
// que hoy no conocemos; antes, cualquier script inyectado podía leer localStorage
// directamente y robar la sesión de admin completa).
// "Cerrar todas las sesiones" (admin supremo): cada token guarda el número de versión de
// sesiones vigente al iniciar sesión (campo v). Al subir ese número, todos los tokens
// anteriores dejan de valer. Se guarda en la tabla configuracion y se cachea en memoria
// (el servidor corre en una sola instancia, así que el cambio se ve al instante).
let versionSesiones = null;
async function obtenerVersionSesiones() {
  if (versionSesiones !== null) return versionSesiones;
  const { data, error } = await supabase
    .from('configuracion')
    .select('valor')
    .eq('clave', 'version_sesiones')
    .maybeSingle();
  if (error) throw error;
  versionSesiones = Number(data?.valor) || 1;
  return versionSesiones;
}

const verifyAdminToken = async (req, res, next) => {
  const token = req.cookies?.admin_token;

  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado' });
    }
    return res.status(403).json({ error: 'Token inválido' });
  }

  try {
    // Los tokens anteriores a este cambio no traen v: cuentan como versión 1
    if ((decoded.v || 1) !== await obtenerVersionSesiones()) {
      return res.status(401).json({ error: 'La sesión fue cerrada por un administrador' });
    }
  } catch (error) {
    return manejarError(res, error);
  }

  // Los tokens anteriores a este cambio no traen rol: son del admin normal
  req.admin = { ...decoded, rol: decoded.rol === 'superadmin' ? 'superadmin' : 'admin' };
  next();
};

// Solo para las rutas /api/superadmin/*: se usa siempre DESPUÉS de verifyAdminToken.
// La pestaña "Avanzado" del panel se oculta al admin normal, pero la protección real es esta.
const verifySuperAdmin = (req, res, next) => {
  if (req.admin?.rol !== 'superadmin') {
    return res.status(403).json({ error: 'Solo el admin supremo puede hacer esto' });
  }
  next();
};

// Registro de actividad del panel (admin supremo > Avanzado > Actividad): qué se hizo y
// cuándo, sin datos personales. Se llama SIN await y nunca lanza error: si falla, solo se
// loguea en Render, y la acción principal (cancelar, bloquear, etc.) sigue igual.
async function registrarActividad(rol, accion, detalle = '') {
  try {
    const { error } = await supabase
      .from('registro_actividad')
      .insert([{ rol, accion, detalle: String(detalle).slice(0, 500) }]);
    if (error) console.error('⚠️ No se pudo guardar el registro de actividad:', error);
  } catch (err) {
    console.error('⚠️ No se pudo guardar el registro de actividad:', err);
  }
}

const NOMBRES_ROL = { admin: 'Admin', superadmin: 'Admin supremo', sistema: 'Sistema' };

// Fecha 'YYYY-MM-DD' -> 'DD/MM/YYYY' para los textos del registro de actividad
function fechaDMY(fechaISO) {
  return String(fechaISO).split('-').reverse().join('/');
}

// CSRF (doble-submit): exige que el valor de la cookie csrf_token coincida con
// el header X-CSRF-Token que manda el frontend. Se aplica solo a rutas que
// modifican datos (POST/DELETE de admin); las de solo lectura (GET) no lo necesitan.
const verificarCSRF = (req, res, next) => {
  const cookieToken = req.cookies?.csrf_token;
  const headerToken = req.headers['x-csrf-token'];

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'Token CSRF inválido o ausente' });
  }
  next();
};

// ========== ENDPOINTS PÚBLICOS ==========

// Health check
// Además de confirmar que el servidor responde, hace una consulta mínima a la base
// de datos. Sirve para dos cosas:
//  1. Un monitor externo (UptimeRobot) que llama acá cada 5 minutos mantiene despiertos
//     tanto al servidor de Render como a la base de Supabase (el plan gratuito de
//     Supabase pausa el proyecto tras una semana sin actividad, por ejemplo en vacaciones).
//  2. Si la base falla, responde 503 y el monitor avisa por email.
// El resultado se reutiliza durante 30 segundos, para que llamadas repetidas a esta
// ruta (que no tiene rate limit) no generen una consulta a la base cada vez.
let ultimoChequeoBase = { momento: 0, ok: false };
app.get('/api/health', async (req, res) => {
  if (Date.now() - ultimoChequeoBase.momento > 30 * 1000) {
    try {
      // Se pide 1 fila normal (GET) y no solo el conteo (HEAD): con HEAD la librería de
      // Supabase toma un 404 sin cuerpo como éxito, y el chequeo podía decir "ok" sin serlo.
      const { error } = await supabase
        .from('meses_habilitados')
        .select('mes')
        .limit(1);
      if (error) throw error;
      ultimoChequeoBase = { momento: Date.now(), ok: true };
    } catch (error) {
      console.error('❌ Health check: la base de datos no respondió:', error);
      ultimoChequeoBase = { momento: Date.now(), ok: false };
    }
  }
  if (ultimoChequeoBase.ok) {
    return res.json({ status: 'ok', db: 'ok' });
  }
  return res.status(503).json({ status: 'error', db: 'error' });
});

// Contraseña del panel de los admins: si el admin supremo la cambió desde el panel, está cifrada
// en la tabla configuracion (admin_password_hash); si no, se usa la de Render (ADMIN_PASSWORD_HASH).
async function hashClaveAdmin() {
  const { data, error } = await supabase.from('configuracion').select('valor').eq('clave', 'admin_password_hash').maybeSingle();
  if (error) throw error;
  return data && /^\$2[aby]\$/.test(String(data.valor)) ? data.valor : ADMIN_PASSWORD_HASH;
}

// AUD-02: además del límite por IP (loginLimiter), un tope para TODOS los intentos fallidos juntos,
// por si alguien prueba contraseñas desde muchas IP. Se cuentan en el registro de actividad, así no
// se pierden con un reinicio. Pasado el tope, nadie puede entrar hasta que esos intentos tengan más
// de una hora; al llegar al aviso, y al cerrarse el inicio de sesión, sale una alerta por correo.
const MAX_LOGIN_FALLIDOS_POR_HORA = 30;
const AVISO_LOGIN_FALLIDOS_POR_HORA = 10;
const ACCION_LOGIN_FALLIDO = 'Intento de inicio de sesión fallido';

async function loginFallidosUltimaHora() {
  const { data, error } = await supabase.from('registro_actividad').select('id').eq('accion', ACCION_LOGIN_FALLIDO)
    .gte('creado_en', new Date(Date.now() - 60 * 60 * 1000).toISOString()).limit(MAX_LOGIN_FALLIDOS_POR_HORA);
  if (error) throw error;
  return (data || []).length;
}

// LOGIN - Endpoint seguro
app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ error: 'Contraseña requerida' });
    }

    if (typeof password !== 'string' || password.length > 200) {
      return res.status(400).json({ error: 'Contraseña inválida' });
    }

    // Si no se pueden contar los intentos (la base no responde), se sigue con el límite por IP
    let fallidos = 0;
    try {
      fallidos = await loginFallidosUltimaHora();
    } catch (err) {
      console.error('⚠️ No se pudieron contar los intentos de inicio de sesión:', err && (err.message || err.code));
    }
    if (fallidos >= MAX_LOGIN_FALLIDOS_POR_HORA) {
      console.warn(`⚠️ Inicio de sesión cerrado: ${fallidos} intentos fallidos en la última hora`);
      return res.status(429).json({ error: 'Por seguridad, el inicio de sesión está cerrado por un rato: hubo muchos intentos con una contraseña equivocada. Probá de nuevo en una hora.' });
    }

    // Validar contraseña: primero la del admin supremo (si está configurada), después la normal
    const esSuperadmin = SUPERADMIN_PASSWORD_HASH !== '' && await bcrypt.compare(password, SUPERADMIN_PASSWORD_HASH);
    const passwordValida = esSuperadmin || await bcrypt.compare(password, await hashClaveAdmin());

    if (!passwordValida) {
      console.warn(`⚠️ Intento de login fallido a las ${new Date().toISOString()}`);
      // Se espera a que quede guardado: es lo que cuenta para el tope
      await registrarActividad('-', ACCION_LOGIN_FALLIDO);
      const total = fallidos + 1;
      if (total === AVISO_LOGIN_FALLIDOS_POR_HORA) {
        anotarAlerta('error', `Hubo ${total} intentos de inicio de sesión fallidos en la última hora en el panel. Si no fueron ustedes, conviene cambiar las contraseñas.`);
      } else if (total === MAX_LOGIN_FALLIDOS_POR_HORA) {
        anotarAlerta('error', `Se cerró el inicio de sesión del panel por una hora: ${total} intentos fallidos en la última hora.`);
      }
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    const rol = esSuperadmin ? 'superadmin' : 'admin';

    // Generar JWT (válido por 8 horas). Lleva el rol y la versión de sesiones vigente.
    const token = jwt.sign(
      { adminId: 'admin', rol, v: await obtenerVersionSesiones(), timestamp: Date.now() },
      JWT_SECRET,
      { expiresIn: '8h', algorithm: 'HS256' }
    );

    // AUTH-002: cookie de primera parte (api.ceq-una.com es del mismo sitio que la página),
    // así los navegadores no la tratan como cookie de terceros y no la bloquean.
    // CEQ-10: sin "domain", la cookie es SOLO de api.ceq-una.com. Antes llevaba
    // domain=.ceq-una.com y el navegador también se la mandaba a ceq-una.com (la web del CEQ,
    // en otro servidor) y a cualquier otro subdominio. Se borra la vieja, si quedó.
    borrarCookieSesionVieja(res);
    res.cookie('admin_token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000, // 8 horas, en milisegundos
      path: '/'
    });
    
    // CSRF (doble-submit token): además de la cookie httpOnly del JWT, se manda
    // otra cookie NO httpOnly con un valor aleatorio. El JS del admin la lee y la
    // reenvía en un header en cada petición que modifica datos; el servidor exige
    // que cookie y header coincidan. Un sitio malicioso podría lograr que el
    // navegador mande la cookie sola (eso es justamente lo que previene SameSite),
    // pero no puede leer su valor para copiarlo en el header, por la política de
    // mismo origen del navegador.
    const csrfToken = crypto.randomBytes(24).toString('hex');
    res.cookie('csrf_token', csrfToken, {
      httpOnly: false,
      secure: true,
      sameSite: 'lax',
      domain: '.ceq-una.com',
      maxAge: 8 * 60 * 60 * 1000,
      path: '/'
    });
    
    console.log(`✅ Login exitoso (${rol}) a las ${new Date().toISOString()}`);
    registrarActividad(rol, 'Inicio de sesión');
    res.json({
      mensaje: 'Sesión iniciada correctamente',
      expiresIn: '8h',
      rol
    });
  } catch (error) {
    console.error('❌ Error en login:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// La cookie del token con domain=.ceq-una.com (antes de CEQ-10). Dura 8 horas, así que después
// del primer día ya no queda ninguna; se sigue borrando por las dudas.
function borrarCookieSesionVieja(res) {
  res.clearCookie('admin_token', { httpOnly: true, secure: true, sameSite: 'lax', domain: '.ceq-una.com', path: '/' });
}

// Borra las cookies de sesión: el token (solo de la API), la vieja y la del CSRF. La del CSRF
// sigue en .ceq-una.com porque el panel (reservas.ceq-una.com) tiene que poder leerla.
function borrarCookiesSesion(res) {
  res.clearCookie('admin_token', { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
  borrarCookieSesionVieja(res);
  res.clearCookie('csrf_token', { httpOnly: false, secure: true, sameSite: 'lax', domain: '.ceq-una.com', path: '/' });
}

// Cerrar sesión: limpia las cookies del token y del CSRF (AUTH-002)
app.post('/api/logout', (req, res) => {
  borrarCookiesSesion(res);
  res.json({ mensaje: 'Sesión cerrada' });
});

// Verificar si hay una sesión de admin activa (para saber si mostrar el panel
// o el login al cargar la página, ya que el token ya no se puede leer desde el
// JavaScript del cliente)
app.get('/api/admin/verificar-sesion', verifyAdminToken, (req, res) => {
  res.json({ ok: true, rol: req.admin.rol });
});

// GET espacios (público): la página usa `publico` y `aviso` para saber qué espacios se
// pueden reservar y qué aviso mostrar de los que no (se manejan desde el admin supremo).
// `mostrar_aviso` en false: el espacio se deshabilita sin ventana al entrar.
app.get('/api/espacios', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('espacios')
      .select('id, nombre, publico, aviso')
      .order('id', { ascending: true });
    if (error) throw error;
    res.json((data || []).map(e => ({ ...e, mostrar_aviso: !config.avisos_ocultos.includes(Number(e.id)) })));
  } catch (error) {
    manejarError(res, error);
  }
});

// GET reservas (público, filtrado por espacio y fecha) — expone solo lo necesario
// para que los usuarios puedan corroborar sus propias reservas en el calendario público
// (nombre y motivo), pero NUNCA contacto ni código de cancelación (SEC-001/PRIV-001):
// antes se exponía select('*') completo, lo que permitía cancelar reservas ajenas
// usando el codigo_cancelacion filtrado por este mismo endpoint.
app.get('/api/reservas', lecturaPublicaLimiter, async (req, res) => {
  try {
    const { espacio_id, fecha } = req.query;

    // Solo desde el primer día del mes actual (en Paraguay) en adelante. Antes se
    // devolvían TODAS las reservas activas de la historia con un tope de 2000: cuando
    // la base pasara ese número, el calendario iba a empezar a mostrar como libres
    // turnos que en realidad estaban ocupados, sin ningún aviso. Se arranca desde el
    // día 1 (y no desde hoy) para que el mes en curso se siga viendo completo.
    // Se lee de a páginas (CEQ-08): ya no hay un tope que deje turnos ocupados afuera.
    const primerDiaMes = primerDiaMesActual();
    // AUD-13: con un valor inválido la base rechazaba el filtro y se respondía 500 (con alerta)
    const espacioIdNum = espacio_id === undefined || espacio_id === '' ? null : enteroPositivo(espacio_id);
    if (espacioIdNum === null && espacio_id !== undefined && espacio_id !== '') {
      return res.status(400).json({ error: 'Espacio inválido' });
    }
    if (fecha !== undefined && fecha !== '' && !esFechaValida(fecha)) {
      return res.status(400).json({ error: 'Fecha inválida' });
    }
    // AUD-03: los días de meses anteriores no se muestran (nombre y motivo de quién usó cada
    // espacio): la página nunca los pide, y Privacidad 7.1 justifica mostrarlos solo para
    // corroborar la propia reserva
    if (fecha && fecha < primerDiaMes) return res.json([]);
    const armar = () => {
      let query = supabase
        .from('reservas')
        .select('espacio_id, fecha, hora_inicio, hora_fin, nombre_solicitante, motivo')
        .eq('estado', 'activa');
      if (espacioIdNum) query = query.eq('espacio_id', espacioIdNum);
      query = fecha ? query.eq('fecha', fecha) : query.gte('fecha', primerDiaMes);
      return query.order('fecha', { ascending: true }).order('id', { ascending: true });
    };

    res.json(await leerTodasLasFilas(armar, 20000));
  } catch (error) {
    manejarError(res, error);
  }
});

// Primer día del mes actual en Paraguay ("2026-10-01")
function primerDiaMesActual() {
  const hoy = hoyEnAsuncion();
  return `${hoy.getUTCFullYear()}-${String(hoy.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

// GET bloqueos (público). Solo desde el mes actual y leído de a páginas (CEQ-08): antes
// traía todos los de la historia con un tope de 1000, y pasado ese número los más nuevos
// podían quedar afuera (el calendario mostraba libre un día bloqueado).
app.get('/api/bloqueos', lecturaPublicaLimiter, async (req, res) => {
  try {
    const desde = primerDiaMesActual();
    const filas = await leerTodasLasFilas(() => supabase
      .from('bloqueos')
      .select('espacio_id, fecha, hora_inicio, hora_fin')
      .gte('fecha', desde)
      .order('fecha', { ascending: true })
      .order('id', { ascending: true }), 20000);
    res.json(filas);
  } catch (error) {
    manejarError(res, error);
  }
});

// Validar disponibilidad: se eliminó este endpoint (no lo usa el frontend, no tenía
// rate limiter, y su lógica estaba desactualizada -ignoraba minutos y bloqueos-,
// así que era superficie pública expuesta sin ningún beneficio real).

// POST crear reserva
// GET meses habilitados (público) — devuelve solo los que están habilitados, para
// que el calendario público sepa qué meses puede mostrar/permitir navegar. No expone
// nada sensible: es la misma información que ya se ve reflejada en qué días quedan
// clickeables en el calendario.
// Un mes cuenta como habilitado si un moderador lo habilitó, o si tenía una apertura programada
// y esa hora ya llegó. Así se abre a la hora exacta, sin esperar a que la tarea periódica lo
// marque como habilitado en la base (ver abrirMesesProgramados).
function mesEstaAbierto(fila, ahora = new Date()) {
  return !!fila && (fila.habilitado === true || (!!fila.abrir_en && new Date(fila.abrir_en) <= ahora));
}

app.get('/api/meses-habilitados', lecturaPublicaLimiter, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('meses_habilitados')
      .select('anio, mes, habilitado, abrir_en')
      .order('anio', { ascending: true })
      .order('mes', { ascending: true });

    if (error) throw error;

    // Al calendario público no se le mandan los meses que ya terminaron (aunque sigan
    // marcados como habilitados en el panel): ahí no se puede reservar nada, y solo
    // hacían aparecer el botón "Anterior" hacia meses muertos.
    const hoy = hoyEnAsuncion();
    const valorMesActual = hoy.getUTCFullYear() * 12 + (hoy.getUTCMonth() + 1);
    const ahora = new Date();
    res.json((data || [])
      .filter(m => mesEstaAbierto(m, ahora) && m.anio * 12 + m.mes >= valorMesActual)
      .map(m => ({ anio: m.anio, mes: m.mes })));
  } catch (error) {
    manejarError(res, error);
  }
});

// Próximas aperturas programadas, para la cuenta regresiva de la página. Manda también la hora
// del servidor, para que la cuenta no dependa de si el reloj de cada celular está bien.
app.get('/api/aperturas-programadas', lecturaPublicaLimiter, async (req, res) => {
  try {
    const ahora = new Date();
    const { data, error } = await supabase
      .from('meses_habilitados')
      .select('anio, mes, abrir_en')
      .eq('habilitado', false)
      .gt('abrir_en', ahora.toISOString())
      .order('abrir_en', { ascending: true });

    if (error) throw error;
    res.set('Cache-Control', 'no-store');
    res.json({
      ahora: ahora.toISOString(),
      aperturas: (data || []).map(m => ({ anio: m.anio, mes: m.mes, abrir_en: new Date(m.abrir_en).toISOString() }))
    });
  } catch (error) {
    manejarError(res, error);
  }
});

// Configuración que necesitan las páginas (turnos del Frente, límite por persona y contacto
// del Frente). Es información pública: ya se ve en la página y en los correos.
// La ventana de novedades, si está activa y no pasó su fecha "mostrar hasta" (en Paraguay)
function ventanaNovedadesVigente() {
  const v = config.ventana_novedades;
  if (!v || !v.activa) return null;
  if (v.hasta && v.hasta < hoyEnAsuncion().toISOString().slice(0, 10)) return null;
  return v;
}

app.get('/api/configuracion', lecturaPublicaLimiter, (req, res) => {
  res.json({
    turnos_frente: config.turnos_frente,
    max_reservas_por_persona_mes: config.max_reservas_por_persona_mes,
    contacto_frente: { email: config.contacto_email_frente, whatsapp: config.contacto_whatsapp_frente },
    motivos_frente: config.motivos_frente,
    altillo: { hora_desde: config.altillo_hora_desde, hora_hasta: config.altillo_hora_hasta, max_horas: config.altillo_max_horas },
    // Máximo de acompañantes del Altillo (páginas anteriores); cada espacio tiene el suyo en reglas
    max_acompanantes: reglaEspacio(1).acompanantes_max,
    ventana_novedades: ventanaNovedadesVigente(),
    pausa_reservas: config.pausa_reservas.activa ? config.pausa_reservas : null,
    // Personalización: reglas de cada espacio, textos de la página (con los de siempre si no se
    // cambiaron) y la cinta de anuncios si está vigente
    reglas: Object.fromEntries([3, 1].map(id => {
      const r = reglaEspacio(id);
      return [id, {
        dias: r.dias, plazo_cancelacion_dias: r.plazo_cancelacion_dias, recordatorio: r.recordatorio, recordatorio_dias: r.recordatorio_dias,
        anticipacion_min_dias: r.anticipacion_min_dias, anticipacion_max_dias: r.anticipacion_max_dias,
        limite_por_persona_mes: limitePorPersona(id), acompanantes_max: r.acompanantes_max, normas: r.normas
      }];
    })),
    textos: Object.fromEntries(Object.entries(TEXTOS_PAGINA).map(([k, d]) => [k, config.textos_pagina[k] != null ? config.textos_pagina[k] : d.defecto])),
    anuncio: anuncioVigente()
  });
});

app.post('/api/reservas', crearReservaLimiter, async (req, res) => {
  try {
    if (config.pausa_reservas.activa) {
      return res.status(503).json({ error: config.pausa_reservas.mensaje, pausa: true });
    }
    // Todo se valida ANTES de guardar (CEQ-03): tipos, nombre, celular, correo y fecha. Antes,
    // un contacto mandado como lista pasaba el chequeo, se guardaba y después el servidor
    // fallaba al leerlo, y un nombre de puros espacios o un celular "abc" se aceptaban.
    let datos;
    try {
      datos = validarDatosDeReserva(req.body);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const { espacioIdNum, nombre_solicitante, contacto, fecha, hora_inicio, hora_fin, motivo } = datos;
    const partesContacto = contacto.split('|').map(p => p.trim());

    // Qué espacios se pueden reservar desde la página lo decide el admin supremo
    // (columna espacios.publico, panel > Avanzado > Espacios). Se revisa acá y no solo en
    // la página, porque alguien podría mandar la reserva directo a la API.
    const { data: espacioData, error: errorEspacio } = await supabase
      .from('espacios')
      .select('publico')
      .eq('id', espacioIdNum)
      .maybeSingle();
    if (errorEspacio) throw errorEspacio;
    if (!espacioData) {
      return res.status(400).json({ error: 'Espacio inválido' });
    }
    if (!espacioData.publico) {
      return res.status(400).json({ error: 'Ese espacio no se puede reservar por el momento' });
    }
    
    // Validar formato de hora
    if (!/^\d{2}:\d{2}$/.test(hora_inicio) || !/^\d{2}:\d{2}$/.test(hora_fin)) {
      return res.status(400).json({ error: 'Formato de hora inválido' });
    }

    const [horaIniH, horaIniM] = hora_inicio.split(':').map(Number);
    const [horaFinH, horaFinM] = hora_fin.split(':').map(Number);

    if (![horaIniH, horaIniM, horaFinH, horaFinM].every(Number.isFinite) ||
        horaIniH > 23 || horaFinH > 23 || horaIniM > 59 || horaFinM > 59) {
      return res.status(400).json({ error: 'Hora inválida' });
    }

    const inicioMin = horaIniH * 60 + horaIniM;
    const finMin = horaFinH * 60 + horaFinM;

    if (inicioMin >= finMin) {
      return res.status(400).json({ error: 'La hora de inicio debe ser anterior a la hora de fin' });
    }

    if (espacioIdNum === 3) {
      // Frente: solo se permiten los turnos fijos de la configuración (por defecto Desayuno,
      // Almuerzo y Merienda). No es una duración libre, por eso no se valida como rango 1-3h.
      if (!nombreTurnoFrente(hora_inicio, hora_fin)) {
        return res.status(400).json({ error: `Turno inválido para Frente. Los turnos son: ${listaTurnosFrenteTexto()}` });
      }
      if (!config.motivos_frente.includes(String(motivo).trim())) {
        return res.status(400).json({ error: 'Elegí el motivo de la lista' });
      }
    } else {
      // Altillo: bloques de 1 hora entre las 07:00 y las 19:00, de 1 a 2 horas. Solo horas
      // completas (CEQ-04): el calendario de la página trabaja por horas enteras.
      if (horaIniM !== 0 || horaFinM !== 0) {
        return res.status(400).json({ error: 'El Altillo se reserva en bloques de horas completas (por ejemplo, 09:00 a 11:00)' });
      }
      const duracionHoras = (finMin - inicioMin) / 60;
      if (duracionHoras < 1 || duracionHoras > config.altillo_max_horas) {
        return res.status(400).json({ error: `La duración debe ser entre 1 y ${config.altillo_max_horas} horas` });
      }

      if (inicioMin < config.altillo_hora_desde * 60 || finMin > config.altillo_hora_hasta * 60) {
        return res.status(400).json({ error: `Horario fuera de rango (${String(config.altillo_hora_desde).padStart(2, '0')}:00-${config.altillo_hora_hasta}:00)` });
      }
    }

    // Acompañantes: cuántos permite el espacio (Reglas; por defecto solo el Altillo, hasta 4)
    const maxAcompanantes = reglaEspacio(espacioIdNum).acompanantes_max;
    const pedidos = req.body.acompanantes;
    if (maxAcompanantes === 0 && pedidos != null && !(Array.isArray(pedidos) && pedidos.length === 0)) {
      const conAcompanantes = [3, 1].filter(id => reglaEspacio(id).acompanantes_max > 0).map(getEspacioNombre);
      return res.status(400).json({ error: conAcompanantes.length
        ? `Los acompañantes se anotan solo en las reservas del ${conAcompanantes.join(' y del ')}`
        : 'Por el momento no se anotan acompañantes en las reservas' });
    }
    let acompanantes;
    try {
      acompanantes = validarAcompanantes(pedidos, maxAcompanantes);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    // La fecha no puede ser pasada ni caer en un día de la semana que el espacio no usa (admin
    // supremo > Reglas; por defecto, de lunes a viernes). El límite superior ya no es una ventana
    // fija de 31 días: depende de qué meses haya habilitado un moderador (tabla meses_habilitados)
    // y, si se configuró, de la anticipación máxima.
    const hoy = hoyEnAsuncion();
    const fechaReserva = new Date(fecha + 'T00:00:00Z');
    const regla = reglaEspacio(espacioIdNum);

    if (isNaN(fechaReserva.getTime()) || fechaReserva < hoy || !regla.dias.includes(fechaReserva.getUTCDay())) {
      return res.status(400).json({ error: 'Fecha fuera del rango permitido para reservar' });
    }
    const diasDeAnticipacion = diferenciaEnDiasCalendario(fecha);
    if (diasDeAnticipacion < regla.anticipacion_min_dias) {
      return res.status(400).json({ error: `El ${getEspacioNombre(espacioIdNum)} se reserva con al menos ${regla.anticipacion_min_dias === 1 ? '1 día' : `${regla.anticipacion_min_dias} días`} de anticipación` });
    }
    if (regla.anticipacion_max_dias > 0 && diasDeAnticipacion > regla.anticipacion_max_dias) {
      return res.status(400).json({ error: `El ${getEspacioNombre(espacioIdNum)} se puede reservar con hasta ${regla.anticipacion_max_dias === 1 ? '1 día' : `${regla.anticipacion_max_dias} días`} de anticipación` });
    }
    // Normas de uso: si el espacio tiene, la página pide tildar que se leyeron
    if (regla.normas && req.body.acepta_normas !== true) {
      return res.status(400).json({ error: `Para reservar, leé y aceptá las normas de uso del ${getEspacioNombre(espacioIdNum)}` });
    }

    // El mes de la fecha pedida tiene que estar explícitamente habilitado. Reemplaza
    // la vieja ventana fija de "hoy + 31 días": ahora un moderador habilita/deshabilita
    // meses a mano desde el panel admin (por ejemplo, a fin de mes habilita el actual +
    // el siguiente, para que se puedan reservar los primeros días del mes entrante).
    const anioReserva = fechaReserva.getUTCFullYear();
    const mesReserva = fechaReserva.getUTCMonth() + 1;
    const { data: mesHabilitadoData, error: errorMesHabilitado } = await supabase
      .from('meses_habilitados')
      .select('habilitado, abrir_en')
      .eq('anio', anioReserva)
      .eq('mes', mesReserva)
      .maybeSingle();

    if (errorMesHabilitado) throw errorMesHabilitado;
    if (!mesEstaAbierto(mesHabilitadoData)) {
      return res.status(400).json({ error: textoPagina('error_mes_no_habilitado') });
    }

    // Límite de reservas activas por persona por mes en ese espacio: el Frente siempre tiene
    // (max_reservas_por_persona_mes); el Altillo solo si se configuró en Reglas. Cuenta el mes de
    // la FECHA reservada; se reconoce a la persona por correo O por celular, y no cuentan las
    // canceladas ni las de prioridad del panel. El conteo y el guardado los hace la base en un
    // solo paso (función crear_reserva_con_cupo, CEQ-02): antes se contaba acá y se guardaba
    // aparte, y varios pedidos simultáneos podían pasar todos el límite.
    const limiteCupo = limitePorPersona(espacioIdNum);

    // VAL-001: si la reserva es para hoy, el horario no puede haber pasado. En el Frente, el
    // turno no puede haber empezado; en el Altillo, el primer bloque de 1 hora no puede haber
    // terminado (a las 11:30 todavía se puede tomar el bloque de las 11:00, a las 12:00 ya no).
    if (fechaReserva.getTime() === hoy.getTime()) {
      const minutosActuales = horaActualEnAsuncionEnMinutos();
      const limite = espacioIdNum === 3 ? inicioMin : inicioMin + 60;
      if (limite <= minutosActuales) {
        return res.status(400).json({ error: textoPagina('error_horario_pasado') });
      }
    }

    // Verificar que no exista un bloqueo administrativo para ese espacio/fecha/horario (BUG-001).
    // Nota: esto reduce el riesgo pero no es 100% atómico frente a un bloqueo creado en el mismo instante;
    // la garantía definitiva requiere una función/transacción en la base (ver informe de auditoría, CONC-001).
    const { data: bloqueosConflicto, error: errorBloqueos } = await supabase
      .from('bloqueos')
      .select('hora_inicio, hora_fin')
      .eq('espacio_id', espacioIdNum)
      .eq('fecha', fecha);

    if (errorBloqueos) throw errorBloqueos;

    const hayBloqueo = (bloqueosConflicto || []).some(b => {
      const [bIniH, bIniM] = b.hora_inicio.split(':').map(Number);
      const [bFinH, bFinM] = b.hora_fin.split(':').map(Number);
      const bIniMin = bIniH * 60 + bIniM;
      const bFinMin = bFinH * 60 + bFinM;
      return inicioMin < bFinMin && finMin > bIniMin;
    });

    if (hayBloqueo) {
      return res.status(409).json({ error: textoPagina('error_bloqueado') });
    }
    
    // Generar código de cancelación seguro (16 caracteres). Solo se guarda su hash
    // en la base (SEC-005); el código en claro se le muestra al usuario una única
    // vez acá y por email, y nunca se vuelve a poder recuperar desde la base.
    const codigo = crypto.randomBytes(8).toString('hex').toUpperCase();
    const codigoHash = hashCodigo(codigo);
    
    // Insertar reserva (con el control de cupo en la misma transacción)
    const persona = identidadContacto(contacto);
    const { data: nuevaReserva, error } = await supabase.rpc('crear_reserva_con_cupo', {
      p_espacio_id: espacioIdNum,
      p_nombre: nombre_solicitante,
      p_contacto: contacto,
      p_fecha: fecha,
      p_hora_inicio: hora_inicio + ':00',
      p_hora_fin: hora_fin + ':00',
      p_motivo: motivo,
      p_codigo_hash: codigoHash,
      p_acompanantes: acompanantes,
      p_limite: limiteCupo,
      p_email: persona.email,
      p_celular: persona.celular
    });

    if (error) {
      if (error.code === '23505' || error.code === '23P01') {
        return res.status(409).json({ error: textoPagina('error_ocupado') });
      }
      // CEQ03: la base contó que la persona ya llegó al límite del mes
      if (error.code === 'CEQ03') {
        const cantidad = Number(error.message) || limiteCupo;
        return res.status(400).json({
          error: textoPagina('error_limite', { cantidad: `${cantidad} ${cantidad === 1 ? 'reserva activa' : 'reservas activas'}`, espacio: getEspacioNombre(espacioIdNum), maximo: limiteCupo })
        });
      }
      // CONC-001: el trigger de la base detectó, de forma atómica, que el horario
      // está bloqueado por administración (esto puede pasar incluso si el chequeo
      // previo en JS no lo detectó, por ejemplo si el bloqueo se creó en el mismo instante)
      if (error.code === 'CEQ01') {
        return res.status(409).json({ error: textoPagina('error_bloqueado') });
      }
      throw error;
    }
    
    // Extraer email del contacto (formato: "celular | email")
    const email = contacto.split('|')[1]?.trim() || '';
    // El número va al final del asunto de cada correo ("- CEQ #id", lo agrega correoDeReserva) para
    // que Gmail no junte en una conversación dos reservas distintas con el mismo asunto. Nombre,
    // motivo y contacto los escribe cualquier persona: correoDeReserva los escapa (SEC-006).
    const reservaId = nuevaReserva[0].id;

    // Enviar email al usuario (si existe email)
    const correos = [];
    if (email) {
      // Asunto, título y mensaje: plantilla "Confirmación de reserva" (admin supremo > Correos)
      const confirmacion = correoDeReserva('confirmacion',
        { id: reservaId, espacio_id: espacioIdNum, nombre_solicitante, fecha, hora_inicio, hora_fin, motivo, acompanantes }, { codigo });
      correos.push(encolarCorreo({
        to: email,
        subject: confirmacion.asunto,
        responderA: correoRespuesta(espacioIdNum),
        html: confirmacion.html
      }));
    }

    // Aviso a los moderadores del espacio (plantilla "Aviso interno: nueva reserva")
    const avisoNueva = correoDeReserva('aviso_nueva',
      { id: reservaId, espacio_id: espacioIdNum, nombre_solicitante, contacto, fecha, hora_inicio, hora_fin, motivo, acompanantes });
    correos.push(encolarCorreo({
      to: getEmailModerador(espacioIdNum),
      subject: avisoNueva.asunto,
      responderA: correoDeContacto(contacto),
      html: avisoNueva.html
    }));

    // CEQ-06: se espera a que los correos queden guardados en la cola (es un insert en la base,
    // rápido) y recién ahí se responde. Antes se respondía primero: si el servidor se reiniciaba
    // justo en ese instante, la reserva quedaba guardada pero la persona nunca recibía su código.
    // El envío a Brevo sigue en segundo plano. encolarCorreo() nunca lanza error.
    await Promise.all(correos);
    // Sin el código ni el contacto (AUD-04): el código solo va en el correo de la persona, y la
    // página no necesita más que el número y el horario
    const { id, espacio_id: espacioGuardado, fecha: fechaGuardada, hora_inicio: inicioGuardado, hora_fin: finGuardado } = nuevaReserva[0];
    res.status(201).json({
      mensaje: 'Reserva creada exitosamente',
      reserva: { id, espacio_id: espacioGuardado, fecha: fechaGuardada, hora_inicio: inicioGuardado, hora_fin: finGuardado }
    });
  } catch (error) {
    manejarError(res, error);
  }
});

// Cancelar por código (público)
app.post('/api/cancelar-por-codigo', cancelarLimiter, async (req, res) => {
  try {
    const { codigo } = req.body;
    
    if (!codigo || typeof codigo !== 'string' || codigo.length > 64) {
      return res.status(400).json({ error: 'Código requerido' });
    }
    
    const codigoHashBuscado = hashCodigo(codigo.trim().toUpperCase());

    const { data, error } = await supabase
      .from('reservas')
      .select('*')
      .eq('codigo_cancelacion_hash', codigoHashBuscado)
      .eq('estado', 'activa');
    
    if (error) throw error;
    if (data.length === 0) {
      return res.status(404).json({ error: 'Código no válido' });
    }

    const reserva = data[0];
    await cancelarComoUsuario(reserva, res);
  } catch (error) {
    manejarError(res, error);
  }
});

// Cancelación hecha por la propia persona, con el código o con el enlace de los correos.
// Las dos formas siguen exactamente las mismas reglas. `reserva` es la fila completa.
async function cancelarComoUsuario(reserva, res) {
  // BUG-006: antes se comparaban milisegundos crudos entre `new Date(reserva.fecha)`
  // (medianoche UTC de esa fecha) y `new Date()` (hora exacta actual del servidor,
  // en UTC), y se hacía Math.floor. Eso significaba que el resultado dependía de la
  // hora del día en que se hacía la petición, no solo de la fecha calendario: una
  // reserva "a 2 días" podía calcularse como "a 1 día" simplemente por hacer el
  // pedido de tarde en vez de la mañana (hora Paraguay). Ahora se compara día
  // calendario contra día calendario, fijo en huso horario de Paraguay.
  const diferenciaDias = diferenciaEnDiasCalendario(reserva.fecha);

  // También si es de hoy y su horario ya terminó (CEQ-05): si no, se podía usar el Altillo a la
  // mañana, cancelar a la tarde y recuperar el cupo
  if (reservaYaTermino(reserva)) {
    return res.status(400).json({ error: 'Esa reserva ya pasó: no se puede cancelar' });
  }

  // Plazo para cancelar gratis (admin supremo > Reglas; por defecto, Frente hasta 2 días antes
  // y Altillo hasta que empiece)
  const plazoCancelacion = reglaEspacio(reserva.espacio_id).plazo_cancelacion_dias;
  if (plazoCancelacion > 0 && diferenciaDias < plazoCancelacion) {
    const emailUsuario = reserva.contacto.split('|')[1]?.trim();
    if (emailUsuario) {
      const correo = correoDeReserva('plazo_vencido', reserva);
      encolarCorreo({
        to: emailUsuario,
        subject: correo.asunto,
        responderA: correoRespuesta(reserva.espacio_id),
        html: correo.html
      });
    }

    // Aviso a los moderadores: hubo un intento de cancelación fuera del período gratuito
    const avisoPlazo = correoDeReserva('aviso_plazo_vencido', reserva);
    encolarCorreo({
      to: getEmailModerador(reserva.espacio_id),
      subject: avisoPlazo.asunto,
      responderA: correoDeContacto(reserva.contacto),
      html: avisoPlazo.html
    });

    return res.status(403).json({
      // El contacto es el del espacio (Frente: el de Configuración). La página busca
      // "PERIODO DE CANCELACION" en este texto, no cambiar ese comienzo.
      error: `EL PERIODO DE CANCELACION GRATUITA HA FINALIZADO. SI DESEA REALIZAR LA CANCELACION CONTACTESE CON ${correoRespuesta(reserva.espacio_id)}`
    });
  }

  // Actualizar estado de forma condicional y atómica (BUG-005): solo transiciona si
  // seguía activa en ese instante. Si otra petición concurrente ya la canceló,
  // updateData viene vacío y respondemos de forma idempotente sin reenviar emails.
  const { data: updateData, error: updateError } = await supabase
    .from('reservas')
    .update({ estado: 'cancelada', cancelada_en: new Date().toISOString(), cancelada_por: 'usuario' })
    .eq('id', reserva.id)
    .eq('estado', 'activa')
    .select();

  if (updateError) throw updateError;

  if (!updateData || updateData.length === 0) {
    return res.json({ mensaje: 'La reserva ya se encontraba cancelada' });
  }

  // Enviar emails (PRIV-002 corregido: el contacto de Frente ya no se copia en
  // el email del propio usuario; solo se le muestra como texto de contacto)
  const email = reserva.contacto.split('|')[1]?.trim();
  if (email) {
    const correo = correoDeReserva('cancelacion', reserva);
    encolarCorreo({
      to: email,
      subject: correo.asunto,
      responderA: correoRespuesta(reserva.espacio_id),
      html: correo.html
    });
  }

  // Aviso a los moderadores del espacio (plantilla "Aviso interno: la persona canceló")
  const avisoCancelacion = correoDeReserva('aviso_cancelacion', reserva);
  encolarCorreo({
    to: getEmailModerador(reserva.espacio_id),
    subject: avisoCancelacion.asunto,
    responderA: correoDeContacto(reserva.contacto),
    html: avisoCancelacion.html
  });

  res.json({
    mensaje: 'Reserva cancelada correctamente',
    reserva_id: reserva.id,
    espacio_id: reserva.espacio_id,
    fecha: reserva.fecha
  });

  // Se liberó un lugar: avisar a quienes estaban en la lista de espera (en segundo plano)
  avisarListaEspera(reserva);
}

// ========== CANCELAR CON EL ENLACE DE LOS CORREOS ==========
// GET: datos mínimos para mostrar en cancelar.html antes de confirmar (sin datos personales).
// POST: cancela. Las dos exigen la firma del enlace (ver tokenCancelacion).
async function reservaDelEnlace(res, r, t) {
  const invalido = () => {
    res.status(404).json({ error: 'El enlace no es válido. Podés cancelar con el código que te llegó en el correo de confirmación.' });
    return null;
  };
  if (!esIdValido(r) || typeof t !== 'string' || t.length !== 32) return invalido();
  // La firma se comprueba con la reserva (lleva su código cifrado, AUD-09)
  const { data, error } = await supabase
    .from('reservas')
    .select('*')
    .eq('id', Number(r))
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    // Una reserva borrada desde el panel: solo se dice si el enlace era de verdad (formato viejo)
    if (mismaFirma(tokenCancelacionV1(r), t)) {
      res.status(404).json({ error: 'Esa reserva ya no existe' });
      return null;
    }
    return invalido();
  }
  if (!tokenCancelacionValido(data, t)) return invalido();
  return data;
}

app.get('/api/cancelar-por-enlace', cancelarLimiter, async (req, res) => {
  try {
    const reserva = await reservaDelEnlace(res, req.query.r, req.query.t);
    if (!reserva) return;
    res.set('Cache-Control', 'no-store');
    res.json(datosParaCancelar(reserva));
  } catch (error) {
    manejarError(res, error);
  }
});

// Lo que ve la persona antes de confirmar la cancelación (con el enlace o con el código)
function datosParaCancelar(reserva) {
  const dias = diferenciaEnDiasCalendario(reserva.fecha);
  const plazo = reglaEspacio(reserva.espacio_id).plazo_cancelacion_dias;
  const plazoVencido = plazo > 0 && dias < plazo;
  const yaPaso = reservaYaTermino(reserva);
  // Para saludar a la persona ("Hola, Ana"): solo el primer nombre, y nada si ya se anonimizó.
  // El enlace y el código son personales (le llegan a su propio correo), así que no exponen
  // datos de otras personas.
  const nombre = String(reserva.nombre_solicitante || '').trim();
  return {
    id: reserva.id,
    nombre: nombre && nombre !== NOMBRE_ANONIMIZADO ? nombre.split(/\s+/)[0].slice(0, 40) : '',
    espacio: getEspacioNombre(reserva.espacio_id),
    fecha_larga: fechaLarga(reserva.fecha),
    horario: descripcionHorario(reserva.espacio_id, reserva.hora_inicio.substring(0, 5), reserva.hora_fin.substring(0, 5)),
    estado: reserva.estado,
    ya_paso: yaPaso,
    se_puede_cancelar: reserva.estado === 'activa' && !yaPaso && !plazoVencido,
    plazo_vencido: reserva.estado === 'activa' && !yaPaso && plazoVencido,
    plazo_dias: plazo,
    whatsapp: Number(reserva.espacio_id) === 3 ? config.contacto_whatsapp_frente : null,
    // A quién escribir si venció el plazo para cancelar (Frente: el contacto del Frente). Solo en
    // ese caso: si no, no hace falta mandar ningún correo
    correo_contacto: plazoVencido ? correoRespuesta(reserva.espacio_id) : null
  };
}

// Con el código: primero se muestran los datos de la reserva y la persona confirma; recién ahí
// se llama a POST /api/cancelar-por-codigo. Esto solo consulta, no cancela nada. Va por POST
// (no en la dirección) para que el código no quede en el historial ni en los registros, y con
// el mismo límite de intentos que cancelar (no sirve para probar códigos al azar).
app.post('/api/cancelar-por-codigo/consultar', cancelarLimiter, async (req, res) => {
  try {
    const { codigo } = req.body || {};
    if (!codigo || typeof codigo !== 'string' || codigo.length > 64) {
      return res.status(400).json({ error: 'Código requerido' });
    }
    const { data, error } = await supabase
      .from('reservas')
      .select('*')
      .eq('codigo_cancelacion_hash', hashCodigo(codigo.trim().toUpperCase()))
      .limit(1);
    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Código no válido' });
    }
    res.set('Cache-Control', 'no-store');
    res.json(datosParaCancelar(data[0]));
  } catch (error) {
    manejarError(res, error);
  }
});

app.post('/api/cancelar-por-enlace', cancelarLimiter, async (req, res) => {
  try {
    const { r, t } = req.body || {};
    const reserva = await reservaDelEnlace(res, r, t);
    if (!reserva) return;
    if (reserva.estado !== 'activa') {
      return res.json({ mensaje: 'La reserva ya se encontraba cancelada' });
    }
    await cancelarComoUsuario(reserva, res);
  } catch (error) {
    manejarError(res, error);
  }
});

// ========== LISTA DE ESPERA (por espacio y mes) ==========
// Cuando en un mes habilitado ya no queda ningún lugar libre en un espacio, la página muestra
// "Ya no hay lugares" y la persona puede anotarse con su nombre y correo para ESE mes. Si después
// alguien cancela una reserva de ese espacio y ese mes (de un horario que todavía no empezó), se
// avisa a todos los anotados para ese mes a la vez, diciendo qué día y turno se liberó (el lugar
// es de quien reserve primero). Cada inscripción se avisa una sola vez; para otro aviso hay que
// volver a anotarse.
const MAX_AVISOS_LISTA_ESPERA_POR_DIA = 60; // dentro de los 300 correos diarios de Brevo
const MAX_INSCRIPCIONES_LISTA_ESPERA_POR_DIA = 60; // cada una manda una confirmación
const DIAS_VIGENCIA_LISTA_ESPERA = 60; // las inscripciones sin avisar más viejas se borran solas

// Cuántos avisos de "se liberó un lugar" se pueden mandar todavía hoy. Se cuentan las
// inscripciones marcadas como avisadas hoy (si un aviso no sale, se desmarca y no cuenta).
async function avisosListaEsperaRestantesHoy() {
  const [avisadosHoy, opcionales] = await Promise.all([contarDeHoy('lista_espera', 'avisado_en'), correosOpcionalesRestantesHoy()]);
  return Math.min(MAX_AVISOS_LISTA_ESPERA_POR_DIA - avisadosHoy, opcionales);
}

// Meses habilitados ('2026-11') en los que ya no queda ningún lugar en el espacio: la misma cuenta
// que hace la página para mostrar la lista de espera (mesesSinLugar en index.html). Si en algún
// mes habilitado todavía queda lugar, devuelve [] (no corresponde anotarse: hay que reservar).
async function mesesSinLugar(espacioId) {
  const { data: meses, error } = await supabase.from('meses_habilitados').select('anio, mes, habilitado, abrir_en');
  if (error) throw error;
  const hoy = hoyEnAsuncion().toISOString().slice(0, 10);
  const ahora = new Date();
  const abiertos = (meses || []).filter(m => mesEstaAbierto(m, ahora))
    .map(m => `${m.anio}-${String(m.mes).padStart(2, '0')}`).filter(clave => clave >= hoy.slice(0, 7)).sort();
  if (abiertos.length === 0) return [];
  const desde = `${abiertos[0]}-01`;
  const [reservas, bloqueos] = await Promise.all([
    leerTodasLasFilas(() => supabase.from('reservas').select('fecha, hora_inicio, hora_fin')
      .eq('estado', 'activa').eq('espacio_id', espacioId).gte('fecha', desde).order('id', { ascending: true }), 20000),
    leerTodasLasFilas(() => supabase.from('bloqueos').select('fecha, hora_inicio, hora_fin')
      .eq('espacio_id', espacioId).gte('fecha', desde).order('id', { ascending: true }), 20000)
  ]);
  const minutos = hhmm => { const [h, m] = String(hhmm).substring(0, 5).split(':').map(Number); return h * 60 + m; };
  const ocupadoPorDia = new Map();
  for (const o of [...reservas, ...bloqueos]) {
    if (!ocupadoPorDia.has(o.fecha)) ocupadoPorDia.set(o.fecha, []);
    ocupadoPorDia.get(o.fecha).push([minutos(o.hora_inicio), minutos(o.hora_fin)]);
  }
  // Los turnos del Frente, o los bloques de 1 hora del Altillo
  const franjas = Number(espacioId) === 3
    ? config.turnos_frente.map(t => [minutos(t.inicio), minutos(t.fin)])
    : Array.from({ length: config.altillo_hora_hasta - config.altillo_hora_desde }, (_, i) => [(config.altillo_hora_desde + i) * 60, (config.altillo_hora_desde + i + 1) * 60]);
  const regla = reglaEspacio(espacioId);
  const ahoraMinutos = horaActualEnAsuncionEnMinutos();
  const llenos = [];
  for (const clave of abiertos) {
    const [anio, mes] = clave.split('-').map(Number);
    const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
    let diasHabiles = 0;
    let hayLugar = false;
    for (let d = 1; d <= ultimo && !hayLugar; d++) {
      const fecha = `${clave}-${String(d).padStart(2, '0')}`;
      if (fecha < hoy) continue;
      const faltan = diferenciaEnDiasCalendario(fecha);
      if (!regla.dias.includes(new Date(fecha + 'T12:00:00Z').getUTCDay()) || faltan < regla.anticipacion_min_dias ||
          (regla.anticipacion_max_dias > 0 && faltan > regla.anticipacion_max_dias)) continue;
      diasHabiles++;
      const ocupado = ocupadoPorDia.get(fecha) || [];
      hayLugar = franjas.some(([inicio, fin]) => {
        // Hoy: el turno del Frente que ya empezó, o el bloque del Altillo que ya terminó, no cuentan
        if (faltan === 0 && (Number(espacioId) === 3 ? inicio <= ahoraMinutos : inicio + 60 <= ahoraMinutos)) return false;
        return !ocupado.some(([oInicio, oFin]) => oInicio < fin && inicio < oFin);
      });
    }
    if (hayLugar) return [];
    if (diasHabiles > 0) llenos.push(clave);
  }
  return llenos;
}

// true si ese horario ya empezó (o el día ya pasó), en hora de Paraguay
function horarioYaEmpezo(fechaISO, horaInicioHHMM) {
  const dias = diferenciaEnDiasCalendario(fechaISO);
  if (dias !== 0) return dias < 0;
  const [h, m] = horaInicioHHMM.split(':').map(Number);
  return h * 60 + m <= horaActualEnAsuncionEnMinutos();
}

const NOMBRES_MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
// '2026-11' -> 'noviembre de 2026'
function nombreDelMes(mes) {
  const [anio, numero] = String(mes).split('-').map(Number);
  return `${NOMBRES_MESES[numero - 1] || ''} de ${anio}`;
}
// Saludo de los correos: "Hola, Ana:" con el primer nombre, o "Hola:" si no hay nombre
function saludoCorreo(nombre) {
  const primero = String(nombre || '').trim().split(/\s+/)[0];
  return primero ? `Hola, ${primero}:` : 'Hola:';
}

app.post('/api/lista-espera', listaEsperaLimiter, async (req, res) => {
  try {
    if (config.pausa_reservas.activa) {
      return res.status(503).json({ error: config.pausa_reservas.mensaje, pausa: true });
    }
    const { espacio_id, email, nombre, mes } = req.body || {};
    const correo = String(email || '').trim().toLowerCase();
    if (!EMAIL_REGEX.test(correo) || correo.length > 100) {
      return res.status(400).json({ error: 'Escribí un correo válido' });
    }
    // Nombre y apellido, como en las reservas (sin saltos de línea ni caracteres de control)
    const nombreLimpio = typeof nombre === 'string' ? nombre.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
    if (nombreLimpio.length < 2 || nombreLimpio.length > 100) {
      return res.status(400).json({ error: 'Escribí tu nombre' });
    }
    const espacioIdNum = Number(espacio_id);
    if (![1, 3].includes(espacioIdNum)) {
      return res.status(400).json({ error: 'Espacio inválido' });
    }
    // El mes tiene que estar habilitado y no haber terminado
    const mesTexto = typeof mes === 'string' ? mes : '';
    const partesMes = mesTexto.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
    if (!partesMes || mesTexto < hoyEnAsuncion().toISOString().slice(0, 7)) {
      return res.status(400).json({ error: 'Elegí un mes válido' });
    }
    const { data: mesData, error: errorMes } = await supabase.from('meses_habilitados')
      .select('habilitado, abrir_en').eq('anio', Number(partesMes[1])).eq('mes', Number(partesMes[2])).maybeSingle();
    if (errorMes) throw errorMes;
    if (!mesEstaAbierto(mesData)) {
      return res.status(400).json({ error: 'Ese mes todavía no está habilitado para reservar' });
    }

    const { data: espacioData, error: errorEspacio } = await supabase
      .from('espacios').select('publico').eq('id', espacioIdNum).maybeSingle();
    if (errorEspacio) throw errorEspacio;
    if (!espacioData || !espacioData.publico) {
      return res.status(400).json({ error: 'Ese espacio no se puede reservar por el momento' });
    }

    // AUD-01: solo se anota si en ese mes ya no queda ningún lugar (lo mismo que mira la página para
    // mostrar la lista de espera). Antes se aceptaba siempre, y cada pedido mandaba un correo.
    if (!(await mesesSinLugar(espacioIdNum)).includes(mesTexto)) {
      return res.status(409).json({ error: `Todavía quedan lugares en ${nombreDelMes(mesTexto)}: podés reservar directamente desde el calendario.` });
    }

    // Ya anotado y todavía sin avisar: no se guarda de nuevo ni se manda otra confirmación (si no,
    // alguien podía llenarle la casilla de correos a cualquier dirección)
    const { data: previa, error: errorPrevia } = await supabase.from('lista_espera').select('id, avisado_en')
      .eq('espacio_id', espacioIdNum).eq('email', correo).eq('mes', mesTexto).maybeSingle();
    if (errorPrevia) throw errorPrevia;
    if (previa && !previa.avisado_en) {
      return res.json({ mensaje: `Ya estabas anotado: si se libera un lugar en ${nombreDelMes(mesTexto)}, te avisamos por correo.` });
    }

    // Tope del día para las inscripciones (cada una manda una confirmación) y lugar para correos
    // que no son de una reserva
    const [inscripcionesHoy, opcionales] = await Promise.all([contarDeHoy('lista_espera', 'creado_en'), correosOpcionalesRestantesHoy()]);
    if (inscripcionesHoy >= MAX_INSCRIPCIONES_LISTA_ESPERA_POR_DIA || opcionales <= 0) {
      console.warn('⚠️ Se alcanzó el tope diario de inscripciones en la lista de espera');
      return res.status(503).json({ error: 'Por hoy no podemos anotar a más personas en la lista de espera. Probá de nuevo mañana.' });
    }

    // Si ya estaba anotado para ese mes y ya lo avisaron (por ejemplo, se volvió a llenar), se reactiva
    const { error: errorGuardar } = await supabase
      .from('lista_espera')
      .upsert({ espacio_id: espacioIdNum, email: correo, nombre: nombreLimpio, mes: mesTexto, creado_en: new Date().toISOString(), avisado_en: null },
        { onConflict: 'espacio_id,email,mes' });
    if (errorGuardar) throw errorGuardar;

    // Confirmación con el enlace para quitar la inscripción. Solo texto (sin HTML ni botones), como
    // un correo personal, para que Gmail lo deje en "Principal" y no en "Promociones". El asunto es
    // una confirmación simple y el enlace no se presenta como "salir de la lista" ni "darse de baja":
    // esas frases son típicas de los correos masivos y Gmail los manda a Promociones.
    const espacio = getEspacioNombre(espacioIdNum);
    const elMes = nombreDelMes(mesTexto);
    // Texto: plantilla "Lista de espera: inscripción" (admin supremo > Correos)
    const inscripcion = correoListaEspera('lista_espera_inscripcion', {
      saludo: saludoCorreo(nombreLimpio), espacio, mes: elMes, enlace_quitar: enlaceBajaListaEspera(espacioIdNum, correo)
    });
    encolarCorreo({
      to: correo,
      subject: inscripcion.asunto,
      responderA: correoRespuesta(espacioIdNum),
      text: inscripcion.texto
    });

    res.status(201).json({ mensaje: `Listo: si se libera un lugar en ${elMes}, te avisamos por correo.` });
  } catch (error) {
    manejarError(res, error);
  }
});

// Salir de la lista de espera con el enlace del correo (firmado: nadie puede sacar a otra persona
// sabiendo solo su correo). La página pide confirmar con un botón, así los programas que abren
// los enlaces de los correos para revisarlos no dan de baja a nadie sin querer.
const CLAVE_LISTA_ESPERA = crypto.createHmac('sha256', JWT_SECRET).update('lista-de-espera-baja-v1').digest();
function tokenBajaListaEspera(espacioId, email) {
  return crypto.createHmac('sha256', CLAVE_LISTA_ESPERA).update(`baja:${Number(espacioId)}:${String(email).toLowerCase()}`).digest('base64url').slice(0, 32);
}
function enlaceBajaListaEspera(espacioId, email) {
  const q = new URLSearchParams({ s: String(Number(espacioId)), e: String(email).toLowerCase(), t: tokenBajaListaEspera(espacioId, email) });
  return `https://reservas.ceq-una.com/lista-espera.html?${q}`;
}

app.post('/api/lista-espera/baja', cancelarLimiter, async (req, res) => {
  try {
    const { s, e, t } = req.body || {};
    const espacioIdNum = Number(s);
    const correo = String(e || '').trim().toLowerCase();
    const esperado = Buffer.from(tokenBajaListaEspera(espacioIdNum, correo));
    const recibido = Buffer.from(typeof t === 'string' ? t : '');
    if (![1, 3].includes(espacioIdNum) || !EMAIL_REGEX.test(correo) ||
        esperado.length !== recibido.length || !crypto.timingSafeEqual(esperado, recibido)) {
      return res.status(400).json({ error: 'El enlace no es válido. Copialo completo desde el correo.' });
    }
    const { error } = await supabase.from('lista_espera').delete().eq('espacio_id', espacioIdNum).eq('email', correo);
    if (error) throw error;
    // La misma respuesta aunque ya no estuviera anotado: el resultado es el mismo
    res.json({ mensaje: `Listo: saliste de la lista de espera del ${getEspacioNombre(espacioIdNum)}. No vas a recibir más avisos.` });
  } catch (error) {
    manejarError(res, error);
  }
});

// Se llama (sin await) cada vez que se cancela una reserva. Nunca lanza error.
async function avisarListaEspera(reserva) {
  try {
    const inicio = reserva.hora_inicio.substring(0, 5);
    const fin = reserva.hora_fin.substring(0, 5);
    if (horarioYaEmpezo(reserva.fecha, inicio)) return;

    // Solo se toman tantas inscripciones como avisos queden hoy (CEQ-06): antes se marcaban
    // todas como avisadas y, pasado el tope diario, el resto quedaba marcado sin recibir nada.
    // Las que no entran siguen esperando el próximo turno que se libere.
    const disponibles = await avisosListaEsperaRestantesHoy();
    if (disponibles <= 0) {
      console.warn('⚠️ Se alcanzó el tope diario de avisos de lista de espera');
      return;
    }
    // Solo los anotados para el mes del turno que se liberó
    const mesLiberado = String(reserva.fecha).slice(0, 7);
    const { data: pendientes, error: errorPendientes } = await supabase
      .from('lista_espera').select('id')
      .eq('espacio_id', reserva.espacio_id).eq('mes', mesLiberado).is('avisado_en', null)
      .order('creado_en', { ascending: true }).limit(disponibles);
    if (errorPendientes) throw errorPendientes;
    if (!pendientes || pendientes.length === 0) return;

    // Se marcan ANTES de mandar (con la condición "todavía sin avisar"): si llegan dos
    // cancelaciones juntas, nadie recibe dos avisos por la misma inscripción
    const { data: tomadas, error } = await supabase
      .from('lista_espera').update({ avisado_en: new Date().toISOString() })
      .in('id', pendientes.map(p => p.id)).is('avisado_en', null).select('id, email, nombre');
    if (error) throw error;
    if (!tomadas || tomadas.length === 0) return;
    // Si un aviso no se pudo mandar, la inscripción vuelve a quedar pendiente
    const devolver = async ids => {
      if (ids.length === 0) return;
      const { error: errorDevolver } = await supabase.from('lista_espera').update({ avisado_en: null }).in('id', ids);
      if (errorDevolver) console.error('⚠️ No se pudo dejar pendiente en la lista de espera:', errorDevolver);
    };

    const espacio = getEspacioNombre(reserva.espacio_id);
    const horario = descripcionHorario(reserva.espacio_id, inicio, fin);
    const enlace = `https://reservas.ceq-una.com/?fecha=${reserva.fecha}&espacio=${Number(reserva.espacio_id)}`;
    // Ya no hace falta contar acá: se tomaron como máximo las que quedaban para hoy, y las marcadas
    // como avisadas son las que cuentan para el tope
    for (let i = 0; i < tomadas.length; i++) {
      const correo = tomadas[i].email;
      // SOLO TEXTO, como un correo escrito por una persona: sin HTML, botones, negritas ni emoji.
      // Con HTML, Brevo agrega la imagen de seguimiento de aperturas y Gmail lo mandaba a
      // "Promociones". El asunto es corto y natural, con el día y el turno (cada aviso es distinto
      // y Gmail no los agrupa); antes llevaba también el número de la reserva y quedaba largo.
      // Pasa por la cola como los demás correos (CEQ-06): si Brevo falla, se reintenta. Sin HTML
      // en la cola, sale igual solo con texto. Si ni siquiera se pudo guardar, vuelve a pendiente.
      const dia = fechaLarga(reserva.fecha); // "lunes 02/11/2026"
      const diaCorto = dia.replace(/\/\d{4}$/, ''); // "lunes 02/11"
      // {turno}: el nombre del turno en el Frente, "09:00 a 11:00" en el Altillo
      const turno = (Number(reserva.espacio_id) === 3 && nombreTurnoFrente(inicio, fin)) || `${inicio} a ${fin}`;
      // Texto: plantilla "Lista de espera: se liberó un lugar" (admin supremo > Correos)
      const aviso = correoListaEspera('lista_espera_aviso', {
        saludo: saludoCorreo(tomadas[i].nombre), espacio, mes: nombreDelMes(mesLiberado),
        dia, dia_corto: diaCorto, horario, turno, enlace_reservar: enlace
      });
      const enviado = await encolarCorreo({
        to: correo,
        subject: aviso.asunto,
        responderA: correoRespuesta(reserva.espacio_id),
        text: aviso.texto
      });
      if (!enviado) await devolver([tomadas[i].id]);
    }
  } catch (err) {
    console.error('⚠️ No se pudo avisar a la lista de espera:', err);
  }
}

// Cada reporte nuevo se avisa por email al moderador general, para enterarse en el
// momento (antes solo quedaban guardados y uno se enteraba recién al abrir el panel).
// Tiene un tope diario: el plan gratuito de Brevo permite 300 emails por día EN TOTAL,
// y alguien que mande reportes falsos desde muchas IPs no debe poder agotarlos y dejar
// sin email de confirmación a las reservas. Pasado el tope, los reportes se siguen
// guardando igual y se ven en el panel; solo deja de llegar el aviso hasta el día siguiente.
const MAX_AVISOS_REPORTE_POR_DIA = 20;

// Se cuentan los reportes guardados hoy (el recién guardado incluido), así el tope no vuelve a
// cero si el servidor se reinicia (AUD-17). Si no se pueden contar, se avisa igual.
async function puedeAvisarReporte() {
  try {
    const [reportesHoy, opcionales] = await Promise.all([contarDeHoy('reportes_errores', 'created_at'), correosOpcionalesRestantesHoy()]);
    return reportesHoy <= MAX_AVISOS_REPORTE_POR_DIA && opcionales > 0;
  } catch (err) {
    console.error('⚠️ No se pudieron contar los reportes de hoy:', err && (err.message || err.code));
    return true;
  }
}

// Reportar error (público)
app.post('/api/reportes', reportesLimiter, async (req, res) => {
  try {
    const { mensaje, url, navegador } = req.body;
    
    if (!mensaje || typeof mensaje !== 'string') {
      return res.status(400).json({ error: 'Mensaje requerido' });
    }

    if (mensaje.length > 1000 || (url && String(url).length > 500) || (navegador && String(navegador).length > 300)) {
      return res.status(400).json({ error: 'Uno o más campos exceden la longitud permitida' });
    }

    if (url && !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'URL inválida' });
    }
    
    const { data: reporteCreado, error } = await supabase
      .from('reportes_errores')
      .insert([{ mensaje, url, navegador, leido: false }])
      .select('id');

    if (error) throw error;
    res.status(201).json({ mensaje: 'Reporte enviado correctamente' });

    // El email sale después de responder, igual que en las reservas (enviarEmail nunca lanza error)
    if (await puedeAvisarReporte()) {
      const reporteId = reporteCreado?.[0]?.id;
      encolarCorreo({
        to: EMAIL_MODERADOR,
        subject: `⚠️ Nuevo reporte de error${reporteId ? ` #${reporteId}` : ''} - CEQ Reservas`,
        html: `
          <h2>Nuevo reporte de error</h2>
          <p>Alguien envió un reporte desde la opción "Reportar un problema" de la página de reservas.</p>
          <p><strong>Mensaje:</strong><br>${escapeHtml(mensaje).replace(/\n/g, '<br>')}</p>
          <ul>
            <li><strong>Página:</strong> ${escapeHtml(url) || 'No informada'}</li>
            <li><strong>Navegador:</strong> ${escapeHtml(navegador) || 'No informado'}</li>
          </ul>
          <p>Podés verlo y marcarlo como leído en el <a href="https://reservas.ceq-una.com/admin.html">panel de administración</a>, pestaña Reportes.</p>
        `
      });
    }
  } catch (error) {
    return manejarError(res, error);
  }
});

// ========== ENDPOINTS PROTEGIDOS (REQUIEREN JWT) ==========

// GET admin/reservas
app.get('/api/admin/reservas', verifyAdminToken, async (req, res) => {
  try {
    // Todas las reservas, de a 1000 (antes se pedían en un solo pedido y Supabase corta en 1000:
    // al pasar ese número, el panel y el Excel iban a dejar de ver las más viejas sin avisar)
    const data = await leerTodasLasFilas(() => supabase
      .from('reservas')
      .select('*')
      .order('fecha', { ascending: false })
      .order('id', { ascending: false }));

    res.json(data);
  } catch (error) {
    manejarError(res, error);
  }
});

// GET bloqueos completos para el panel de admin (incluye id y motivo, a diferencia
// del endpoint público /api/bloqueos que solo expone lo necesario para pintar el calendario)
app.get('/api/admin/bloqueos', verifyAdminToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bloqueos')
      .select('*')
      .order('fecha', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    manejarError(res, error);
  }
});

// POST crear bloqueo
// GET meses habilitados (admin) — a diferencia del endpoint público, devuelve todas
// las filas existentes (habilitadas y deshabilitadas), para poder pintar el estado
// real de cada toggle en el panel. Los meses que nunca se tocaron simplemente no
// tienen fila (el frontend los trata como deshabilitados por default).
app.get('/api/admin/meses-habilitados', verifyAdminToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('meses_habilitados')
      .select('anio, mes, habilitado, abrir_en')
      .order('anio', { ascending: true })
      .order('mes', { ascending: true });

    if (error) throw error;
    // Una apertura programada cuya hora ya llegó se muestra como habilitada, aunque la tarea
    // periódica todavía no la haya marcado en la base
    const ahora = new Date();
    res.json((data || []).map(m => ({
      anio: m.anio,
      mes: m.mes,
      habilitado: mesEstaAbierto(m, ahora),
      abrir_en: m.abrir_en && !mesEstaAbierto(m, ahora) ? new Date(m.abrir_en).toISOString() : null
    })));
  } catch (error) {
    manejarError(res, error);
  }
});

// POST habilitar/deshabilitar un mes puntual (admin)
app.post('/api/admin/meses-habilitados', verifyAdminToken, verificarCSRF, async (req, res) => {
  try {
    const { anio, mes, habilitado } = req.body;
    const anioNum = parseInt(anio);
    const mesNum = parseInt(mes);

    if (!Number.isInteger(anioNum) || anioNum < 2020 || anioNum > 2100) {
      return res.status(400).json({ error: 'Año inválido' });
    }
    if (!Number.isInteger(mesNum) || mesNum < 1 || mesNum > 12) {
      return res.status(400).json({ error: 'Mes inválido' });
    }
    if (typeof habilitado !== 'boolean') {
      return res.status(400).json({ error: 'El campo habilitado debe ser true o false' });
    }

    // Los meses habilitados siempre tienen que quedar como un bloque consecutivo,
    // sin huecos: el calendario público (index.html) decide cuándo mostrar los botones
    // de navegación de mes asumiendo que no hay saltos. Se simula el estado resultante
    // ANTES de guardar, y se rechaza si dejaría un hueco (ej: julio + septiembre sin agosto).
    const { data: actuales, error: errorActuales } = await supabase
      .from('meses_habilitados')
      .select('anio, mes, habilitado, abrir_en');

    if (errorActuales) throw errorActuales;

    const valorNuevo = anioNum * 12 + mesNum;
    const ahora = new Date();
    const valoresResultantes = (actuales || [])
      .filter(m => mesEstaAbierto(m, ahora))
      .map(m => m.anio * 12 + m.mes)
      .filter(v => v !== valorNuevo);

    if (habilitado) valoresResultantes.push(valorNuevo);
    valoresResultantes.sort((a, b) => a - b);

    const esConsecutivo = valoresResultantes.every(
      (v, i) => i === 0 || v - valoresResultantes[i - 1] === 1
    );

    if (!esConsecutivo) {
      return res.status(400).json({
        error: 'Los meses habilitados tienen que quedar consecutivos, sin huecos. Habilitá o deshabilitá de a uno, siempre desde una punta del rango.'
      });
    }

    // Habilitar o deshabilitar a mano cancela cualquier apertura programada de ese mes
    const { error } = await supabase
      .from('meses_habilitados')
      .upsert(
        { anio: anioNum, mes: mesNum, habilitado, abrir_en: null, updated_at: new Date().toISOString() },
        { onConflict: 'anio,mes' }
      );

    if (error) throw error;
    registrarActividad(req.admin.rol, habilitado ? 'Habilitó un mes' : 'Deshabilitó un mes', `${String(mesNum).padStart(2, '0')}/${anioNum}`);
    res.json({ mensaje: 'Actualizado correctamente' });
  } catch (error) {
    manejarError(res, error);
  }
});

// "dd/mm/aaaa HH:MM" en hora de Paraguay (para el registro de actividad y los correos)
function fechaHoraAsuncionTexto(fecha) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Asuncion', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(fecha).map(x => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

// POST programar (o cancelar, con abrir_en: null) la apertura automática de un mes.
// A esa hora exacta el mes empieza a contar como habilitado (ver mesEstaAbierto).
app.post('/api/admin/meses-habilitados/programar', verifyAdminToken, verificarCSRF, async (req, res) => {
  try {
    const { anio, mes, abrir_en } = req.body || {};
    const anioNum = parseInt(anio);
    const mesNum = parseInt(mes);
    if (!Number.isInteger(anioNum) || anioNum < 2020 || anioNum > 2100) {
      return res.status(400).json({ error: 'Año inválido' });
    }
    if (!Number.isInteger(mesNum) || mesNum < 1 || mesNum > 12) {
      return res.status(400).json({ error: 'Mes inválido' });
    }
    const etiquetaMes = `${String(mesNum).padStart(2, '0')}/${anioNum}`;

    if (abrir_en === null) {
      const { error } = await supabase
        .from('meses_habilitados')
        .update({ abrir_en: null, updated_at: new Date().toISOString() })
        .eq('anio', anioNum).eq('mes', mesNum).eq('habilitado', false);
      if (error) throw error;
      registrarActividad(req.admin.rol, 'Canceló la apertura programada de un mes', etiquetaMes);
      return res.json({ mensaje: 'Apertura programada cancelada' });
    }

    const momento = new Date(abrir_en);
    if (typeof abrir_en !== 'string' || isNaN(momento.getTime())) {
      return res.status(400).json({ error: 'Fecha y hora inválidas' });
    }
    const ahora = new Date();
    if (momento.getTime() <= ahora.getTime() + 60 * 1000) {
      return res.status(400).json({ error: 'Elegí una fecha y hora que todavía no haya pasado' });
    }
    if (momento.getTime() > ahora.getTime() + 183 * 24 * 60 * 60 * 1000) {
      return res.status(400).json({ error: 'La apertura tiene que ser dentro de los próximos 6 meses' });
    }
    const hoy = hoyEnAsuncion();
    const valorNuevo = anioNum * 12 + mesNum;
    if (valorNuevo < hoy.getUTCFullYear() * 12 + hoy.getUTCMonth() + 1) {
      return res.status(400).json({ error: 'Ese mes ya pasó' });
    }

    const { data: actuales, error: errorActuales } = await supabase
      .from('meses_habilitados')
      .select('anio, mes, habilitado, abrir_en');
    if (errorActuales) throw errorActuales;
    if ((actuales || []).some(m => m.anio === anioNum && m.mes === mesNum && mesEstaAbierto(m, ahora))) {
      return res.status(400).json({ error: 'Ese mes ya está habilitado' });
    }

    // Mismo control que al habilitar a mano: cuando se abra, los meses habilitados tienen que
    // quedar seguidos (se mira cómo están ahora)
    const valores = (actuales || [])
      .filter(m => mesEstaAbierto(m, ahora))
      .map(m => m.anio * 12 + m.mes)
      .concat(valorNuevo)
      .sort((a, b) => a - b);
    if (!valores.every((v, i) => i === 0 || v - valores[i - 1] === 1)) {
      return res.status(400).json({
        error: 'Cuando se abra, los meses habilitados tienen que quedar seguidos. Programá el mes que sigue al último habilitado.'
      });
    }

    const { error } = await supabase
      .from('meses_habilitados')
      .upsert(
        { anio: anioNum, mes: mesNum, habilitado: false, abrir_en: momento.toISOString(), updated_at: ahora.toISOString() },
        { onConflict: 'anio,mes' }
      );
    if (error) throw error;
    registrarActividad(req.admin.rol, 'Programó la apertura de un mes', `${etiquetaMes} · se abre el ${fechaHoraAsuncionTexto(momento)}`);
    res.json({ mensaje: 'Apertura programada', abrir_en: momento.toISOString() });
  } catch (error) {
    manejarError(res, error);
  }
});

app.post('/api/bloqueos', verifyAdminToken, verificarCSRF, async (req, res) => {
  try {
    const { espacio_id, fecha, hora_inicio, hora_fin, motivo } = req.body;
    
    if (!espacio_id || !fecha || !hora_inicio || !hora_fin) {
      return res.status(400).json({ error: 'Faltan parámetros' });
    }

    if (!esFechaValida(fecha) || typeof hora_inicio !== 'string' || typeof hora_fin !== 'string') {
      return res.status(400).json({ error: 'Fecha inválida' });
    }
    if (![1, 3].includes(Number(espacio_id))) {
      return res.status(400).json({ error: 'Espacio inválido' });
    }

    // VAL-003: un bloqueo en una fecha que ya pasó (en Paraguay) no tiene efecto y solo
    // ensucia la lista de bloqueos del panel. Hoy sí se permite.
    if (new Date(fecha + 'T00:00:00Z') < hoyEnAsuncion()) {
      return res.status(400).json({ error: 'No se puede bloquear una fecha que ya pasó' });
    }

    // Acepta HH:MM o HH:MM:SS (el bloqueo de día completo manda "00:00:00"/"23:59:00" con segundos)
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(hora_inicio) || !/^\d{2}:\d{2}(:\d{2})?$/.test(hora_fin)) {
      return res.status(400).json({ error: 'Formato de hora inválido' });
    }
    
    const [horaI, minI] = hora_inicio.split(':').map(Number);
    const [horaF, minF] = hora_fin.split(':').map(Number);

    if (![horaI, minI, horaF, minF].every(Number.isFinite) || horaI > 23 || horaF > 23 || minI > 59 || minF > 59) {
      return res.status(400).json({ error: 'Hora inválida' });
    }
    
    const isBloqueCompleto = horaI === 0 && minI === 0 && horaF === 23 && minF === 59;
    
    if (!isBloqueCompleto) {
      // El rango sale de la configuración de cada espacio (CEQ-04): el Frente, de sus turnos;
      // el Altillo, de 07:00 a 19:00. Antes había un tope fijo de 18:00 para los dos.
      const aMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
      const [desdeMin, hastaMin] = Number(espacio_id) === 3
        ? [Math.min(...config.turnos_frente.map(t => aMin(t.inicio))), Math.max(...config.turnos_frente.map(t => aMin(t.fin)))]
        : [config.altillo_hora_desde * 60, config.altillo_hora_hasta * 60];
      const texto = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      const iniMin = horaI * 60 + minI;
      const finMin = horaF * 60 + minF;

      if (iniMin < desdeMin || finMin > hastaMin || iniMin >= finMin) {
        return res.status(400).json({ error: `Horario inválido (${texto(desdeMin)}-${texto(hastaMin)})` });
      }
    }

    // VAL-003: antes se podía crear un bloqueo "por encima" de una reserva activa
    // existente sin ningún aviso, dejando un estado contradictorio (una reserva
    // confirmada en un horario que ahora figura como bloqueado). Se verifica y
    // se rechaza explícitamente, mostrando qué reserva(s) están en conflicto,
    // para que el admin decida (por ejemplo, cancelarlas primero si corresponde).
    const { data: reservasConflicto, error: errorReservasConflicto } = await supabase
      .from('reservas')
      .select('id, nombre_solicitante, hora_inicio, hora_fin')
      .eq('espacio_id', espacio_id)
      .eq('fecha', fecha)
      .eq('estado', 'activa');

    if (errorReservasConflicto) throw errorReservasConflicto;

    const inicioBloqueoMin = horaI * 60 + minI;
    const finBloqueoMin = horaF * 60 + minF;

    const conflictos = (reservasConflicto || []).filter(r => {
      const [rIniH, rIniM] = r.hora_inicio.split(':').map(Number);
      const [rFinH, rFinM] = r.hora_fin.split(':').map(Number);
      const rIniMin = rIniH * 60 + rIniM;
      const rFinMin = rFinH * 60 + rFinM;
      return inicioBloqueoMin < rFinMin && finBloqueoMin > rIniMin;
    });

    if (conflictos.length > 0) {
      return res.status(409).json({
        error: 'Ya hay reservas activas en ese horario. Cancelalas primero si querés bloquear el espacio.',
        reservas_en_conflicto: conflictos.map(r => ({
          id: r.id,
          nombre: r.nombre_solicitante,
          horario: `${r.hora_inicio.substring(0,5)} - ${r.hora_fin.substring(0,5)}`
        }))
      });
    }
    
    const { error } = await supabase
      .from('bloqueos')
      .insert([{
        espacio_id,
        fecha,
        hora_inicio,
        hora_fin,
        motivo: motivo ? String(motivo).slice(0, 300) : 'Sin especificar'
      }]);
    
    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Ya existe un bloqueo para ese horario' });
      }
      // CONC-001: el trigger detectó, de forma atómica, una reserva activa que se
      // solapa (red de seguridad final por si el chequeo previo en JS -VAL-003- no
      // llegó a detectarla, por ejemplo si la reserva se creó en el mismo instante)
      if (error.code === 'CEQ02') {
        return res.status(409).json({ error: 'Ya hay una reserva activa en ese horario. Cancelala primero si querés bloquear el espacio.' });
      }
      throw error;
    }
    
    registrarActividad(req.admin.rol, 'Creó un bloqueo',
      `${getEspacioNombre(Number(espacio_id))}, ${fechaDMY(fecha)}, ${isBloqueCompleto ? 'todo el día' : `${hora_inicio.substring(0, 5)} - ${hora_fin.substring(0, 5)}`}`);
    res.status(201).json({ mensaje: 'Bloqueo creado' });
  } catch (error) {
    manejarError(res, error);
  }
});

// DELETE bloqueo
app.delete('/api/bloqueos/:id', verifyAdminToken, verificarCSRF, async (req, res) => {
  try {
    const { id } = req.params;

    if (!esIdValido(id)) {
      return res.status(400).json({ error: 'ID inválido' });
    }
    
    const { data, error } = await supabase
      .from('bloqueos')
      .delete()
      .eq('id', id)
      .select();
    
    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Bloqueo no encontrado' });
    }
    const b = data[0];
    registrarActividad(req.admin.rol, 'Eliminó un bloqueo', `${getEspacioNombre(b.espacio_id)}, ${fechaDMY(b.fecha)}`);
    res.json({ mensaje: 'Bloqueo eliminado' });
  } catch (error) {
    manejarError(res, error);
  }
});

// ===== BLOQUEOS DE VARIOS DÍAS =====
// Bloquea un intervalo de fechas (por ejemplo, del 3 al 28 de noviembre), todos los días hábiles
// o solo algunos (por ejemplo, martes y jueves), todo el día o en un horario. Primero se pide una
// vista previa (qué días se bloquean y qué reservas lo impiden) y después se confirma. Los días
// con reservas activas en ese horario NO se bloquean (no se cancela nada sin avisar): se informan
// para que el moderador decida. Todos los bloqueos creados juntos comparten un "lote" y se pueden
// borrar juntos.
const MAX_DIAS_LOTE_BLOQUEOS = 184; // medio año

// Valida el horario de un bloqueo para el espacio. Devuelve { completo } o lanza un Error.
function validarHorarioBloqueo(espacioId, horaInicio, horaFin) {
  // Estricto (CEQ-18): horas 00-23, minutos 00-59 y, si vienen segundos, tienen que ser 00.
  // Antes "08:99" pasaba la forma y se convertía en 09:39 sin avisar.
  const HORA_ESTRICTA = /^([01]\d|2[0-3]):([0-5]\d)(:00)?$/;
  if (typeof horaInicio !== 'string' || typeof horaFin !== 'string' ||
      !HORA_ESTRICTA.test(horaInicio) || !HORA_ESTRICTA.test(horaFin)) {
    throw new Error('Formato de hora inválido');
  }
  const aMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const ini = aMin(horaInicio), fin = aMin(horaFin);
  if (ini === 0 && fin === 23 * 60 + 59) return { completo: true, ini, fin };
  const [desde, hasta] = Number(espacioId) === 3
    ? [Math.min(...config.turnos_frente.map(t => aMin(t.inicio))), Math.max(...config.turnos_frente.map(t => aMin(t.fin)))]
    : [config.altillo_hora_desde * 60, config.altillo_hora_hasta * 60];
  const texto = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  if (ini < desde || fin > hasta || ini >= fin) throw new Error(`Horario inválido (${texto(desde)}-${texto(hasta)})`);
  return { completo: false, ini, fin };
}

app.post('/api/bloqueos/lote', verifyAdminToken, verificarCSRF, async (req, res) => {
  try {
    const { espacio_id, desde, hasta, dias, hora_inicio, hora_fin, motivo, confirmar } = req.body || {};
    const espacioIdNum = Number(espacio_id);
    if (![1, 3].includes(espacioIdNum)) return res.status(400).json({ error: 'Espacio inválido' });
    if (!esFechaValida(desde) || !esFechaValida(hasta)) return res.status(400).json({ error: 'Fechas inválidas' });
    if (desde > hasta) return res.status(400).json({ error: 'La fecha "desde" tiene que ser anterior a "hasta"' });
    if (new Date(desde + 'T00:00:00Z') < hoyEnAsuncion()) return res.status(400).json({ error: 'No se puede bloquear una fecha que ya pasó' });
    const totalDias = (new Date(hasta + 'T00:00:00Z') - new Date(desde + 'T00:00:00Z')) / 86400000 + 1;
    if (totalDias > MAX_DIAS_LOTE_BLOQUEOS) return res.status(400).json({ error: 'El intervalo puede ser de hasta 6 meses' });
    // Días de la semana: 0 = domingo, 1 = lunes … 6 = sábado (AUD-10: los sábados y domingos se
    // pueden habilitar en las Reglas, así que también se tienen que poder bloquear)
    const diasSemana = Array.isArray(dias) ? [...new Set(dias.map(Number))] : [];
    if (diasSemana.length === 0 || diasSemana.some(d => !Number.isInteger(d) || d < 0 || d > 6)) {
      return res.status(400).json({ error: 'Elegí al menos un día de la semana' });
    }
    let horario;
    try {
      horario = validarHorarioBloqueo(espacioIdNum, hora_inicio, hora_fin);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const fechas = [];
    for (let d = new Date(desde + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= hasta; d.setUTCDate(d.getUTCDate() + 1)) {
      if (diasSemana.includes(d.getUTCDay())) fechas.push(d.toISOString().slice(0, 10));
    }
    if (fechas.length === 0) return res.status(400).json({ error: 'En ese intervalo no hay ningún día de los elegidos' });

    const [{ data: reservas, error: e1 }, { data: existentes, error: e2 }] = await Promise.all([
      supabase.from('reservas').select('id, fecha, nombre_solicitante, hora_inicio, hora_fin')
        .eq('espacio_id', espacioIdNum).eq('estado', 'activa').gte('fecha', desde).lte('fecha', hasta),
      supabase.from('bloqueos').select('fecha, hora_inicio, hora_fin')
        .eq('espacio_id', espacioIdNum).gte('fecha', desde).lte('fecha', hasta)
    ]);
    if (e1) throw e1;
    if (e2) throw e2;
    const aMin = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
    const choca = x => horario.ini < aMin(x.hora_fin) && horario.fin > aMin(x.hora_inicio);
    const conflictos = [];
    const yaBloqueadas = [];
    const aCrear = [];
    for (const fecha of fechas) {
      const enConflicto = (reservas || []).filter(r => r.fecha === fecha && choca(r));
      if (enConflicto.length) {
        conflictos.push({ fecha, reservas: enConflicto.map(r => ({ id: r.id, nombre: r.nombre_solicitante, horario: `${r.hora_inicio.substring(0, 5)} - ${r.hora_fin.substring(0, 5)}` })) });
      } else if ((existentes || []).some(b => b.fecha === fecha && choca(b))) {
        yaBloqueadas.push(fecha);
      } else {
        aCrear.push(fecha);
      }
    }

    if (confirmar !== true) {
      return res.json({ fechas: aCrear, conflictos, ya_bloqueadas: yaBloqueadas });
    }
    if (aCrear.length === 0) return res.status(400).json({ error: 'No queda ningún día para bloquear', conflictos, ya_bloqueadas: yaBloqueadas });

    const lote = crypto.randomUUID();
    const textoMotivo = motivo ? String(motivo).slice(0, 300) : 'Sin especificar';
    const { error } = await supabase.from('bloqueos').insert(aCrear.map(fecha => ({
      espacio_id: espacioIdNum, fecha, hora_inicio, hora_fin, motivo: textoMotivo, lote
    })));
    if (error) {
      // Se insertan todos juntos (o ninguno): si justo alguien reservó o bloqueó, se pide repetir
      if (['23505', 'CEQ02'].includes(error.code)) {
        return res.status(409).json({ error: 'Mientras tanto cambió algo en esas fechas. Volvé a ver la vista previa.' });
      }
      throw error;
    }
    registrarActividad(req.admin.rol, 'Creó bloqueos de varios días',
      `${getEspacioNombre(espacioIdNum)}, ${aCrear.length} día(s) del ${fechaDMY(aCrear[0])} al ${fechaDMY(aCrear[aCrear.length - 1])}, ${horario.completo ? 'todo el día' : `${hora_inicio.substring(0, 5)} - ${hora_fin.substring(0, 5)}`}`);
    res.status(201).json({ mensaje: `Se bloquearon ${aCrear.length} día(s)`, lote, creados: aCrear.length, conflictos, ya_bloqueadas: yaBloqueadas });
  } catch (error) {
    manejarError(res, error);
  }
});

// Borrar todos los bloqueos de un lote (los creados juntos con "varios días")
app.delete('/api/bloqueos/lote/:lote', verifyAdminToken, verificarCSRF, async (req, res) => {
  try {
    const { lote } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(lote)) return res.status(400).json({ error: 'Lote inválido' });
    const { data, error } = await supabase.from('bloqueos').delete().eq('lote', lote).select('espacio_id, fecha');
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: 'No se encontraron esos bloqueos' });
    registrarActividad(req.admin.rol, 'Eliminó bloqueos de varios días', `${getEspacioNombre(data[0].espacio_id)}, ${data.length} día(s)`);
    res.json({ mensaje: `Se eliminaron ${data.length} bloqueo(s)`, eliminados: data.length });
  } catch (error) {
    manejarError(res, error);
  }
});

// POST cancelar reserva (admin)
// POST crear reserva de PRIORIDAD (admin) — para que la Comisión Directiva pueda
// reservar un turno de Frente (o Altillo) ANTES de que ese mes se habilite
// públicamente. A diferencia de un bloqueo, esto SÍ ocupa un turno con nombre real:
// queda protegido por el mismo EXCLUDE constraint que cualquier otra reserva, así
// que cuando el mes se habilite después, el público va a ver ese turno como ya
// ocupado, no como libre. Reutiliza exactamente la misma validación de formato que
// el endpoint público — la única diferencia real es que salta el chequeo de
// meses_habilitados, que es justamente el punto de este endpoint.
app.post('/api/admin/reservas', verifyAdminToken, verificarCSRF, async (req, res) => {
  try {
    // Misma validación que el formulario público (CEQ-03)
    let datos;
    try {
      datos = validarDatosDeReserva(req.body);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const { espacioIdNum, nombre_solicitante, contacto, fecha, hora_inicio, hora_fin, motivo } = datos;

    // Este endpoint es solo para Frente — la prioridad de la Comisión Directiva
    // aplica únicamente ahí, no tiene sentido para Altillo.
    if (espacioIdNum !== 3) {
      return res.status(400).json({ error: 'Este endpoint es solo para Frente' });
    }

    if (!/^\d{2}:\d{2}$/.test(hora_inicio) || !/^\d{2}:\d{2}$/.test(hora_fin)) {
      return res.status(400).json({ error: 'Formato de hora inválido' });
    }

    const [horaIniH, horaIniM] = hora_inicio.split(':').map(Number);
    const [horaFinH, horaFinM] = hora_fin.split(':').map(Number);

    if (![horaIniH, horaIniM, horaFinH, horaFinM].every(Number.isFinite) ||
        horaIniH > 23 || horaFinH > 23 || horaIniM > 59 || horaFinM > 59) {
      return res.status(400).json({ error: 'Hora inválida' });
    }

    const inicioMin = horaIniH * 60 + horaIniM;
    const finMin = horaFinH * 60 + horaFinM;

    if (inicioMin >= finMin) {
      return res.status(400).json({ error: 'La hora de inicio debe ser anterior a la hora de fin' });
    }

    if (!nombreTurnoFrente(hora_inicio, hora_fin)) {
      return res.status(400).json({ error: `Turno inválido. Los turnos son: ${listaTurnosFrenteTexto()}` });
    }

    // A diferencia del endpoint público, acá NO se chequea meses_habilitados — es
    // justamente el punto de este endpoint. Sí se sigue exigiendo que la fecha no
    // sea pasada ni caiga en un día que el Frente no usa (Reglas), y el chequeo de horario ya
    // pasado si es hoy. La anticipación y las normas no se aplican: lo decide la Comisión.
    const hoy = hoyEnAsuncion();
    const fechaReserva = new Date(fecha + 'T00:00:00Z');

    if (isNaN(fechaReserva.getTime()) || fechaReserva < hoy || !reglaEspacio(3).dias.includes(fechaReserva.getUTCDay())) {
      return res.status(400).json({ error: 'Fecha fuera del rango permitido para reservar' });
    }

    if (fechaReserva.getTime() === hoy.getTime()) {
      const minutosActuales = horaActualEnAsuncionEnMinutos();
      if (inicioMin <= minutosActuales) {
        return res.status(400).json({ error: 'No se puede reservar un horario que ya pasó' });
      }
    }

    // Chequeo previo (no atómico) de bloqueos, igual que el endpoint público. La
    // garantía real la sigue dando el trigger de la base (CEQ01).
    const { data: bloqueosConflicto, error: errorBloqueos } = await supabase
      .from('bloqueos')
      .select('hora_inicio, hora_fin')
      .eq('espacio_id', espacioIdNum)
      .eq('fecha', fecha);

    if (errorBloqueos) throw errorBloqueos;

    const hayBloqueo = (bloqueosConflicto || []).some(b => {
      const [bIniH, bIniM] = b.hora_inicio.split(':').map(Number);
      const [bFinH, bFinM] = b.hora_fin.split(':').map(Number);
      const bIniMin = bIniH * 60 + bIniM;
      const bFinMin = bFinH * 60 + bFinM;
      return inicioMin < bFinMin && finMin > bIniMin;
    });

    if (hayBloqueo) {
      return res.status(409).json({ error: 'El horario seleccionado está bloqueado por administración' });
    }

    const codigo = crypto.randomBytes(8).toString('hex').toUpperCase();
    const codigoHash = hashCodigo(codigo);

    const { data: nuevaReserva, error } = await supabase
      .from('reservas')
      .insert([{
        espacio_id: espacioIdNum,
        nombre_solicitante,
        contacto,
        fecha,
        hora_inicio: hora_inicio + ':00',
        hora_fin: hora_fin + ':00',
        estado: 'activa',
        motivo,
        codigo_cancelacion_hash: codigoHash,
        reservado_por_admin: true
      }])
      .select();

    if (error) {
      if (error.code === '23505' || error.code === '23P01') {
        return res.status(409).json({ error: 'Horario no disponible - se solapa con otra reserva existente' });
      }
      if (error.code === 'CEQ01') {
        return res.status(409).json({ error: 'El horario seleccionado está bloqueado por administración' });
      }
      throw error;
    }

    // Se manda la misma confirmación que recibe cualquier persona que reserva por el
    // formulario público, al email que se haya cargado en el contacto de la reserva
    // de prioridad — para que la Comisión Directiva también tenga registro/código.
    const email = contacto.split('|')[1].trim();
    const confirmacion = correoDeReserva('confirmacion',
      { id: nuevaReserva[0].id, espacio_id: espacioIdNum, nombre_solicitante, fecha, hora_inicio, hora_fin, motivo, acompanantes: [] }, { codigo });
    encolarCorreo({
      to: email,
      subject: confirmacion.asunto,
      responderA: correoRespuesta(espacioIdNum),
      html: confirmacion.html
    });

    // A propósito no se manda aviso al moderador acá (a diferencia del formulario
    // público): quien crea esto ya es el moderador, y está viendo el resultado en
    // pantalla al toque, no hace falta que se notifique a sí mismo.
    registrarActividad(req.admin.rol, 'Creó una reserva de prioridad',
      `#${nuevaReserva[0].id} · Frente, ${fechaDMY(fecha)}, ${descripcionHorario(espacioIdNum, hora_inicio, hora_fin)}`);
    res.json({ mensaje: 'Reserva de prioridad creada correctamente', reserva: nuevaReserva[0] });
  } catch (error) {
    manejarError(res, error);
  }
});

app.post('/api/admin/cancelar/:reserva_id', verifyAdminToken, verificarCSRF, async (req, res) => {
  try {
    const { reserva_id } = req.params;
    const { motivo } = req.body;

    if (!esIdValido(reserva_id)) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    // Obtener datos de la reserva
    const { data, error: selectError } = await supabase
      .from('reservas')
      .select('*')
      .eq('id', reserva_id);

    if (selectError) throw selectError;
    if (data.length === 0) {
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }

    const reserva = data[0];

    if (reserva.estado !== 'activa') {
      return res.json({ mensaje: 'La reserva ya se encontraba cancelada' });
    }
    
    // Transición condicional (BUG-005): solo cancela si seguía activa. Se guarda cuándo,
    // quién y el motivo, para verlo después en el panel del admin supremo.
    const { data: updateData, error } = await supabase
      .from('reservas')
      .update({
        estado: 'cancelada',
        cancelada_en: new Date().toISOString(),
        cancelada_por: req.admin.rol === 'superadmin' ? 'admin supremo' : 'moderador',
        motivo_cancelacion: motivo ? String(motivo).slice(0, 300) : null
      })
      .eq('id', reserva_id)
      .eq('estado', 'activa')
      .select();
    
    if (error) throw error;

    if (!updateData || updateData.length === 0) {
      return res.json({ mensaje: 'La reserva ya se encontraba cancelada' });
    }

    // Enviar email al reservante con motivo (PRIV-002 corregido: ya no se copia
    // al contacto de Frente en el email del propio usuario)
    const email = reserva.contacto.split('|')[1]?.trim();
    if (email) {
      const correo = correoDeReserva('cancelacion_moderador', reserva, { motivo: motivo ? String(motivo).slice(0, 300) : '' });
      encolarCorreo({
        to: email,
        subject: correo.asunto,
        responderA: correoRespuesta(reserva.espacio_id),
        html: correo.html
      });
    }

    // Aviso a los moderadores del espacio (así se enteran de las cancelaciones que hace otro
    // moderador). Plantilla "Aviso interno: un moderador canceló"; destinatarios en Correos.
    const avisoModerador = correoDeReserva('aviso_cancelacion_moderador', reserva, { motivo: motivo ? String(motivo).slice(0, 300) : '' });
    encolarCorreo({
      to: getEmailModerador(reserva.espacio_id),
      subject: avisoModerador.asunto,
      responderA: correoDeContacto(reserva.contacto),
      html: avisoModerador.html
    });

    registrarActividad(req.admin.rol, 'Canceló una reserva',
      `#${reserva.id} · ${getEspacioNombre(reserva.espacio_id)}, ${fechaDMY(reserva.fecha)}, ${descripcionHorario(reserva.espacio_id, reserva.hora_inicio.substring(0, 5), reserva.hora_fin.substring(0, 5))}`);
    res.json({ mensaje: 'Reserva cancelada por admin' });
    avisarListaEspera(reserva); // se liberó un lugar (en segundo plano)
  } catch (error) {
    manejarError(res, error);
  }
});

// POST marcar si la persona vino o no vino (null = borrar la marca). Solo reservas activas
// cuyo día ya llegó (hoy o antes).
app.post('/api/admin/reservas/:id/asistencia', verifyAdminToken, verificarCSRF, async (req, res) => {
  try {
    const { id } = req.params;
    if (!esIdValido(id)) {
      return res.status(400).json({ error: 'ID inválido' });
    }
    const { asistencia } = req.body || {};
    if (asistencia !== null && asistencia !== 'vino' && asistencia !== 'no_vino') {
      return res.status(400).json({ error: 'La asistencia tiene que ser "vino", "no_vino" o vacía' });
    }

    const { data: reserva, error: errorReserva } = await supabase
      .from('reservas')
      .select('id, estado, fecha, espacio_id, hora_inicio, hora_fin')
      .eq('id', Number(id))
      .maybeSingle();
    if (errorReserva) throw errorReserva;
    if (!reserva) {
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }
    if (reserva.estado !== 'activa') {
      return res.status(400).json({ error: 'Solo se marca la asistencia de reservas activas' });
    }
    if (diferenciaEnDiasCalendario(reserva.fecha) > 0) {
      return res.status(400).json({ error: 'Todavía no llegó el día de esa reserva' });
    }

    const { error } = await supabase
      .from('reservas')
      .update({ asistencia })
      .eq('id', reserva.id);
    if (error) throw error;

    const textos = { vino: 'Vino', no_vino: 'No vino' };
    registrarActividad(req.admin.rol, asistencia ? 'Marcó la asistencia de una reserva' : 'Borró la asistencia de una reserva',
      `#${reserva.id}${asistencia ? ' · ' + textos[asistencia] : ''} · ${getEspacioNombre(reserva.espacio_id)}, ${fechaDMY(reserva.fecha)}`);
    res.json({ mensaje: 'Asistencia guardada', asistencia });
  } catch (error) {
    manejarError(res, error);
  }
});

// GET reportes
app.get('/api/admin/reportes', verifyAdminToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reportes_errores')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(2000);
    
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    manejarError(res, error);
  }
});

// Estado de un reporte: nuevo → en revisión → resuelto, con una nota (por ejemplo, qué se hizo)
const ESTADOS_REPORTE = ['nuevo', 'en_revision', 'resuelto'];
const NOMBRES_ESTADO_REPORTE = { nuevo: 'nuevo', en_revision: 'en revisión', resuelto: 'resuelto' };
app.post('/api/admin/reportes/:id/estado', verifyAdminToken, verificarCSRF, async (req, res) => {
  try {
    const { id } = req.params;
    if (!esIdValido(id)) return res.status(400).json({ error: 'ID inválido' });
    const { estado, nota } = req.body || {};
    if (!ESTADOS_REPORTE.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    if (nota != null && (typeof nota !== 'string' || nota.length > 500)) {
      return res.status(400).json({ error: 'La nota puede tener hasta 500 caracteres' });
    }
    const { data, error } = await supabase.from('reportes_errores')
      .update({ estado, nota: nota ? nota.trim() : null, leido: estado !== 'nuevo' })
      .eq('id', id).select('id, estado, nota');
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: 'Reporte no encontrado' });
    registrarActividad(req.admin.rol, 'Cambió el estado de un reporte', `#${id} · ${NOMBRES_ESTADO_REPORTE[estado]}`);
    res.json({ mensaje: 'Reporte actualizado', reporte: data[0] });
  } catch (error) {
    manejarError(res, error);
  }
});

// Correos de los últimos 7 días que no salieron (pendientes de reintento o perdidos), para el
// panel "Hoy". No se manda el contenido (tiene códigos de cancelación): solo a quién y el asunto.
app.get('/api/admin/correos', verifyAdminToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('correos_pendientes')
      .select('id, destinatarios, asunto, estado, intentos, ultimo_error, creado_en, proximo_intento')
      .in('estado', ['pendiente', 'enviando', 'fallido'])
      .order('id', { ascending: false }).limit(100);
    if (error) {
      if (['42P01', 'PGRST205'].includes(error.code)) return res.json([]);
      throw error;
    }
    res.json(data || []);
  } catch (error) {
    manejarError(res, error);
  }
});

// Reintentar un correo perdido: vuelve a la cola como nuevo, con todos sus intentos
app.post('/api/admin/correos/:id/reintentar', verifyAdminToken, verificarCSRF, async (req, res) => {
  try {
    const { id } = req.params;
    if (!esIdValido(id)) return res.status(400).json({ error: 'ID inválido' });
    const { data, error } = await supabase.from('correos_pendientes')
      .update({ estado: 'pendiente', intentos: 0, proximo_intento: new Date().toISOString(), ultimo_error: null })
      .eq('id', id).eq('estado', 'fallido').select('id, asunto');
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: 'Ese correo no está entre los fallidos' });
    registrarActividad(req.admin.rol, 'Reintentó un correo', data[0].asunto);
    procesarColaCorreos().catch(err => console.error('⚠️ Cola de correos:', err));
    res.json({ mensaje: 'El correo volvió a la cola' });
  } catch (error) {
    manejarError(res, error);
  }
});

// POST marcar reporte como leído
app.post('/api/admin/reportes/:id/leer', verifyAdminToken, verificarCSRF, async (req, res) => {
  try {
    const { id } = req.params;

    if (!esIdValido(id)) {
      return res.status(400).json({ error: 'ID inválido' });
    }
    
    const { data, error } = await supabase
      .from('reportes_errores')
      .update({ leido: true })
      .eq('id', id)
      .select();
    // Un reporte "nuevo" que se lee pasa a "en revisión" (con la columna estado; si no existe, se ignora)
    if (!error && data && data.length) {
      await supabase.from('reportes_errores').update({ estado: 'en_revision' }).eq('id', id).eq('estado', 'nuevo');
    }
    
    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Reporte no encontrado' });
    }
    registrarActividad(req.admin.rol, 'Marcó un reporte como leído', `#${id}`);
    res.json({ mensaje: 'Reporte marcado como leído' });
  } catch (error) {
    manejarError(res, error);
  }
});

// ========== ENDPOINTS DEL ADMIN SUPREMO (JWT con rol superadmin) ==========

// Valida una lista de IDs enviada en el cuerpo: enteros positivos, sin repetir, hasta 500
function idsValidos(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) return null;
  if (!ids.every(esIdValido)) return null;
  return [...new Set(ids.map(Number))];
}

// Para el registro de actividad: "#1, #2, #3" (recortado si son muchos)
function listaIds(ids) {
  const texto = ids.map(id => `#${id}`).join(', ');
  return texto.length > 400 ? texto.slice(0, 400) + '…' : texto;
}

// Habilitar o deshabilitar el Frente o el Altillo para el público, y el aviso que ve la
// gente cuando no está disponible. Reemplaza tener que cambiar código para reactivar el Altillo.
app.post('/api/superadmin/espacios/:id', verifyAdminToken, verifySuperAdmin, verificarCSRF, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (![1, 3].includes(id)) {
      return res.status(400).json({ error: 'Solo se pueden configurar el Frente y el Altillo' });
    }
    const { publico, aviso, mostrar_aviso } = req.body;
    if (typeof publico !== 'boolean') {
      return res.status(400).json({ error: 'El campo publico debe ser true o false' });
    }
    if (mostrar_aviso !== undefined && typeof mostrar_aviso !== 'boolean') {
      return res.status(400).json({ error: 'El campo mostrar_aviso debe ser true o false' });
    }
    if (aviso !== undefined && aviso !== null && (typeof aviso !== 'string' || aviso.length > 1000)) {
      return res.status(400).json({ error: 'El aviso debe ser un texto de hasta 1000 caracteres' });
    }

    // Estado anterior, solo para que el registro de actividad diga qué cambió
    const { data: antes, error: errorAntes } = await supabase
      .from('espacios')
      .select('publico')
      .eq('id', id)
      .maybeSingle();
    if (errorAntes) throw errorAntes;

    const { data, error } = await supabase
      .from('espacios')
      .update({ publico, aviso: aviso ? aviso.trim() : null })
      .eq('id', id)
      .select('id, nombre, publico, aviso');

    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Espacio no encontrado' });
    }
    // Mostrar u ocultar el aviso al entrar (sin borrar el texto)
    if (mostrar_aviso !== undefined && mostrar_aviso === config.avisos_ocultos.includes(id)) {
      const ocultos = mostrar_aviso
        ? config.avisos_ocultos.filter(x => x !== id)
        : [...config.avisos_ocultos, id];
      const { error: errorOcultos } = await supabase.from('configuracion')
        .upsert({ clave: 'avisos_ocultos', valor: comoTexto('avisos_ocultos', VALIDADORES_CONFIG.avisos_ocultos(ocultos)) }, { onConflict: 'clave' });
      if (errorOcultos) throw errorOcultos;
      await cargarConfiguracion();
    }
    const accion = antes && antes.publico === publico
      ? 'Guardó el aviso de un espacio'
      : (publico ? 'Habilitó un espacio para el público' : 'Deshabilitó un espacio para el público');
    const conAviso = !config.avisos_ocultos.includes(id);
    registrarActividad(req.admin.rol, accion, publico || conAviso ? getEspacioNombre(id) : `${getEspacioNombre(id)} (sin aviso al entrar)`);
    res.json({ mensaje: 'Espacio actualizado', espacio: { ...data[0], mostrar_aviso: conAviso } });
  } catch (error) {
    manejarError(res, error);
  }
});

// Eliminar definitivamente reservas de la base (por ejemplo, las de prueba). Solo las
// CANCELADAS: una activa primero se cancela desde el panel, para que la persona reciba el aviso.
app.post('/api/superadmin/reservas/eliminar', verifyAdminToken, verifySuperAdmin, verificarCSRF, async (req, res) => {
  try {
    const ids = idsValidos(req.body.ids);
    if (!ids) {
      return res.status(400).json({ error: 'Lista de reservas inválida (entre 1 y 500)' });
    }

    const { data, error } = await supabase
      .from('reservas')
      .delete()
      .in('id', ids)
      .eq('estado', 'cancelada')
      .select('id');

    if (error) {
      if (error.code === '23503') {
        return res.status(409).json({ error: 'Alguna de esas reservas tiene registros asociados y no se puede eliminar' });
      }
      throw error;
    }

    const eliminadas = (data || []).map(r => r.id);
    if (eliminadas.length > 0) {
      registrarActividad(req.admin.rol, `Eliminó ${eliminadas.length} reserva${eliminadas.length === 1 ? '' : 's'} cancelada${eliminadas.length === 1 ? '' : 's'}`, listaIds(eliminadas));
    }
    res.json({ eliminadas: eliminadas.length, ignoradas: ids.length - eliminadas.length });
  } catch (error) {
    manejarError(res, error);
  }
});

// Eliminar definitivamente reportes de errores (por ejemplo, los de prueba)
app.post('/api/superadmin/reportes/eliminar', verifyAdminToken, verifySuperAdmin, verificarCSRF, async (req, res) => {
  try {
    const ids = idsValidos(req.body.ids);
    if (!ids) {
      return res.status(400).json({ error: 'Lista de reportes inválida (entre 1 y 500)' });
    }

    const { data, error } = await supabase
      .from('reportes_errores')
      .delete()
      .in('id', ids)
      .select('id');

    if (error) throw error;
    const eliminados = (data || []).map(r => r.id);
    if (eliminados.length > 0) {
      registrarActividad(req.admin.rol, `Eliminó ${eliminados.length} reporte${eliminados.length === 1 ? '' : 's'}`, listaIds(eliminados));
    }
    res.json({ eliminados: eliminados.length });
  } catch (error) {
    manejarError(res, error);
  }
});

// Registro de actividad del panel (los últimos 300 movimientos)
app.get('/api/superadmin/actividad', verifyAdminToken, verifySuperAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('registro_actividad')
      .select('id, creado_en, rol, accion, detalle')
      .order('id', { ascending: false })
      .limit(300);

    if (error) throw error;
    res.json((data || []).map(a => ({ ...a, rol: NOMBRES_ROL[a.rol] || a.rol })));
  } catch (error) {
    manejarError(res, error);
  }
});

// Configuración editable (turnos del Frente, límite por persona, contacto del Frente y correo
// de alertas). Al guardar se valida todo (ver VALIDADORES_CONFIG) y se aplica al instante.
const NOMBRES_CONFIG = {
  turnos_frente: 'turnos del Frente',
  max_reservas_por_persona_mes: 'límite por persona',
  contacto_email_frente: 'correo de contacto del Frente',
  contacto_whatsapp_frente: 'WhatsApp del Frente',
  email_alertas: 'correo de alertas',
  motivos_frente: 'motivos del Frente',
  altillo_hora_desde: 'apertura del Altillo',
  altillo_hora_hasta: 'cierre del Altillo',
  altillo_max_horas: 'máximo de horas del Altillo'
};

const comoTexto = (clave, valor) => CLAVES_CONFIG_JSON.includes(clave) ? JSON.stringify(valor) : String(valor);

app.get('/api/superadmin/configuracion', verifyAdminToken, verifySuperAdmin, (req, res) => {
  res.json(config);
});

// Ventana de novedades: la escribe el admin supremo (título, introducción, bloques y texto final).
// "Publicar" con volver_a_mostrar le da una versión nueva: la ve de nuevo quien ya la había cerrado.
// Sin volver_a_mostrar (por ejemplo, para corregir un error de tipeo) se conserva la versión.
app.post('/api/superadmin/novedades', verifyAdminToken, verifySuperAdmin, verificarCSRF, async (req, res) => {
  try {
    const b = req.body || {};
    if (typeof b.activa !== 'boolean') {
      return res.status(400).json({ error: 'El campo activa debe ser true o false' });
    }
    const anterior = config.ventana_novedades || {};
    const nuevaVersion = b.volver_a_mostrar === true || !anterior.version;
    let ventana;
    try {
      ventana = VALIDADORES_CONFIG.ventana_novedades({
        ...b,
        version: nuevaVersion ? `v${Date.now()}` : anterior.version
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const { error } = await supabase.from('configuracion')
      .upsert({ clave: 'ventana_novedades', valor: comoTexto('ventana_novedades', ventana) }, { onConflict: 'clave' });
    if (error) throw error;
    await cargarConfiguracion();
    registrarActividad(req.admin.rol,
      !ventana.activa ? 'Quitó la ventana de novedades' : (nuevaVersion ? 'Publicó la ventana de novedades' : 'Corrigió la ventana de novedades'),
      ventana.titulo);
    res.json({ mensaje: 'Ventana guardada', ventana_novedades: config.ventana_novedades });
  } catch (error) {
    manejarError(res, error);
  }
});

app.post('/api/superadmin/configuracion', verifyAdminToken, verifySuperAdmin, verificarCSRF, async (req, res) => {
  try {
    const cambios = req.body || {};
    // Los avisos ocultos y la ventana de novedades tienen su propia ruta (más abajo)
    const claves = Object.keys(cambios).filter(k => Object.prototype.hasOwnProperty.call(NOMBRES_CONFIG, k));
    if (claves.length === 0) {
      return res.status(400).json({ error: 'No hay nada para guardar' });
    }
    const filas = [];
    for (const clave of claves) {
      let valor;
      try {
        valor = VALIDADORES_CONFIG[clave](cambios[clave]);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      filas.push({ clave, valor: comoTexto(clave, valor) });
    }
    // El horario del Altillo se revisa junto: abre antes de cerrar y el máximo entra en el horario
    const nuevo = clave => { const f = filas.find(x => x.clave === clave); return f ? Number(f.valor) : config[clave]; };
    const abre = nuevo('altillo_hora_desde'), cierra = nuevo('altillo_hora_hasta'), maximo = nuevo('altillo_max_horas');
    if (cierra - abre < 1) return res.status(400).json({ error: 'El Altillo tiene que cerrar al menos 1 hora después de abrir' });
    if (maximo > cierra - abre) return res.status(400).json({ error: `El máximo de horas del Altillo no puede ser mayor que su horario (${cierra - abre} h)` });
    const cambiadas = filas.filter(f => f.valor !== comoTexto(f.clave, config[f.clave]));
    if (cambiadas.length > 0) {
      const { error } = await supabase.from('configuracion').upsert(cambiadas, { onConflict: 'clave' });
      if (error) throw error;
      await cargarConfiguracion();
      registrarActividad(req.admin.rol, 'Cambió la configuración', cambiadas.map(f => NOMBRES_CONFIG[f.clave]).join(', '));
    }
    res.json({ mensaje: cambiadas.length > 0 ? 'Configuración guardada' : 'No había cambios', config });
  } catch (error) {
    manejarError(res, error);
  }
});

// ===== DATOS DE UNA PERSONA (Política de Privacidad, art. 11) =====
// Para responder pedidos de acceso o de borrado: busca por correo o por celular todo lo que hay
// de una persona (sus reservas, las reservas donde figura como acompañante y la lista de espera)
// y, si lo pide, borra sus datos. Solo el admin supremo.
function criterioPersona(q) {
  const texto = String(q || '').trim().toLowerCase();
  if (texto.includes('@')) return EMAIL_REGEX.test(texto) ? { email: texto, celular: null } : null;
  const digitos = texto.replace(/\D/g, '');
  return digitos.length >= 7 ? { email: null, celular: digitos.slice(-9) } : null;
}

// Busca a la persona por el correo o el celular que se escribió y, además, por los otros datos
// de contacto que ella misma dejó en sus reservas (CEQ-17): si se busca por correo, también se
// encuentra dónde figura como acompañante (que se guarda por celular); si se busca por celular,
// también su lista de espera (que se guarda por correo). Se amplía una sola vez, con lo que figura
// en sus propias reservas, para no terminar sumando datos de otras personas.
const celularDe = x => String(x || '').replace(/\D/g, '').slice(-9);

async function buscarDatosPersona(criterio) {
  const reservas = await leerTodasLasFilas(() => supabase.from('reservas')
    .select('id, espacio_id, fecha, hora_inicio, hora_fin, nombre_solicitante, contacto, motivo, acompanantes, estado, reservado_por_admin, asistencia, created_at, cancelada_en, cancelada_por, motivo_cancelacion')
    .order('fecha', { ascending: true }).order('id', { ascending: true }));
  const emails = new Set(criterio.email ? [criterio.email] : []);
  const celulares = new Set(criterio.celular ? [criterio.celular] : []);
  const coincide = ident => (ident.email && emails.has(ident.email)) || (ident.celular && celulares.has(ident.celular));
  const directas = reservas.filter(r => coincide(identidadContacto(r.contacto)));
  for (const r of directas) {
    const ident = identidadContacto(r.contacto);
    if (ident.email) emails.add(ident.email);
    if (ident.celular) celulares.add(ident.celular);
  }
  const propias = reservas.filter(r => coincide(identidadContacto(r.contacto)));
  const esElla = a => celulares.has(celularDe(a && a.celular));
  const comoAcompanante = celulares.size ? reservas.filter(r => !propias.includes(r) &&
    (Array.isArray(r.acompanantes) ? r.acompanantes : []).some(esElla)) : [];
  let listaEspera = [];
  if (emails.size) {
    const { data, error } = await supabase.from('lista_espera').select('id, espacio_id, email, nombre, mes, creado_en, avisado_en').in('email', [...emails]);
    if (error) throw error;
    listaEspera = data || [];
  }
  return { propias, comoAcompanante, listaEspera, emails: [...emails], celulares: [...celulares], esElla };
}

// Correos de la cola que todavía tienen contenido (sin mandar, mandándose o fallidos) y que son
// para la persona o la mencionan (por ejemplo, el aviso al moderador de una reserva suya). Los ya
// enviados no guardan contenido. Si la cola no se puede leer, devuelve null (no se sabe).
async function correosDePersona(emails, contactos) {
  try {
    const filas = await leerTodasLasFilas(() => supabase.from('correos_pendientes')
      .select('id, destinatarios, asunto, html, texto, estado')
      .in('estado', ['pendiente', 'enviando', 'fallido'])
      .order('id', { ascending: true }));
    const buscar = [...emails, ...contactos.filter(c => c && c.length >= 7)].map(x => x.toLowerCase());
    return filas.filter(f => {
      const para = (Array.isArray(f.destinatarios) ? f.destinatarios : []).map(d => String(d).toLowerCase());
      if (para.some(d => emails.includes(d))) return true;
      const contenido = `${f.asunto || ''}\n${f.html || ''}\n${f.texto || ''}`.toLowerCase();
      return buscar.some(x => contenido.includes(x));
    });
  } catch (err) {
    console.error('⚠️ No se pudo revisar la cola de correos:', err && (err.message || err.code));
    return null;
  }
}

// Lo que se le entrega a la persona (botón "Descargar sus datos"): SOLO sus datos (CEQ-16). De sus
// reservas no van los nombres ni los celulares de sus acompañantes (son datos de otras personas),
// solo cuántos eran; de las reservas donde figura como acompañante va lo que ella misma es en esa
// lista, sin el nombre de quien reservó.
function entregaPersona({ propias, comoAcompanante, listaEspera, esElla }) {
  return {
    reservas: propias.map(r => ({
      numero: r.id, espacio: getEspacioNombre(r.espacio_id), fecha: r.fecha,
      hora_inicio: String(r.hora_inicio || '').slice(0, 5), hora_fin: String(r.hora_fin || '').slice(0, 5),
      nombre: r.nombre_solicitante, contacto: r.contacto, motivo: r.motivo || '',
      cantidad_acompanantes: Array.isArray(r.acompanantes) ? r.acompanantes.length : 0,
      estado: r.estado, asistencia: r.asistencia || null, hecha_desde_el_panel: r.reservado_por_admin === true,
      creada: aIsoUtc(r.created_at), cancelada_en: aIsoUtc(r.cancelada_en), motivo_cancelacion: r.motivo_cancelacion || null
    })),
    como_acompanante: comoAcompanante.map(r => ({
      numero: r.id, espacio: getEspacioNombre(r.espacio_id), fecha: r.fecha,
      hora_inicio: String(r.hora_inicio || '').slice(0, 5), hora_fin: String(r.hora_fin || '').slice(0, 5), estado: r.estado,
      como_figura: (r.acompanantes || []).filter(esElla).map(a => ({ nombre: a.nombre || '', celular: a.celular || '' }))
    })),
    lista_espera: listaEspera.map(l => ({ espacio: getEspacioNombre(l.espacio_id), mes: l.mes || null, nombre: l.nombre || null, email: l.email, anotada: aIsoUtc(l.creado_en), avisada: aIsoUtc(l.avisado_en) }))
  };
}

app.get('/api/superadmin/persona', verifyAdminToken, verifySuperAdmin, async (req, res) => {
  try {
    const criterio = criterioPersona(req.query.q);
    if (!criterio) return res.status(400).json({ error: 'Escribí un correo o un celular (al menos 7 números)' });
    const datos = await buscarDatosPersona(criterio);
    const { propias, comoAcompanante, listaEspera, esElla } = datos;
    const correos = await correosDePersona(datos.emails, propias.map(r => r.contacto));
    res.set('Cache-Control', 'no-store');
    res.json({
      reservas: propias,
      como_acompanante: comoAcompanante.map(r => ({
        id: r.id, espacio_id: r.espacio_id, fecha: r.fecha, hora_inicio: r.hora_inicio, hora_fin: r.hora_fin, estado: r.estado,
        titular: r.nombre_solicitante,
        acompanante: (r.acompanantes || []).filter(esElla)
      })),
      lista_espera: listaEspera,
      correos_en_cola: correos ? correos.length : null,
      // Lo que se descarga para mandarle a la persona
      entrega: entregaPersona(datos)
    });
  } catch (error) {
    manejarError(res, error);
  }
});

// Borra los datos de la persona: sus reservas quedan anónimas (como a los 6 meses), se la quita
// de las listas de acompañantes, de la lista de espera y de los correos de la cola que todavía
// guardan contenido (CEQ-17). Si tiene reservas activas a futuro, primero hay que cancelarlas
// (así le llega el aviso y no queda un turno ocupado sin dueño). Se puede repetir: si algo falló
// a la mitad, otra vez "Borrar" termina lo que faltó.
app.post('/api/superadmin/persona/borrar', verifyAdminToken, verifySuperAdmin, verificarCSRF, async (req, res) => {
  try {
    const { q, confirmar } = req.body || {};
    const criterio = criterioPersona(q);
    if (!criterio) return res.status(400).json({ error: 'Escribí un correo o un celular (al menos 7 números)' });
    if (confirmar !== 'BORRAR') return res.status(400).json({ error: 'Para borrar hay que escribir BORRAR' });
    const datos = await buscarDatosPersona(criterio);
    const { propias, comoAcompanante, listaEspera, esElla } = datos;
    const hoy = hoyEnAsuncion().toISOString().slice(0, 10);
    const futuras = propias.filter(r => r.estado === 'activa' && r.fecha >= hoy);
    if (futuras.length) {
      return res.status(409).json({
        error: 'Tiene reservas activas que todavía no pasaron. Cancelalas primero (así le llega el aviso) y después borrá sus datos.',
        reservas: futuras.map(r => ({ id: r.id, fecha: r.fecha, espacio: getEspacioNombre(r.espacio_id) }))
      });
    }
    // Antes de anonimizar: los contactos tal como figuran sirven para encontrarla en la cola
    const contactos = propias.map(r => r.contacto);
    const hecho = { reservas: 0, como_acompanante: 0, lista_espera: 0, correos: 0 };
    const pendiente = [];
    try {
      for (const r of propias) {
        const motivoQueda = Number(r.espacio_id) === 3 && config.motivos_frente.includes(r.motivo) ? r.motivo : '';
        const { error } = await supabase.from('reservas')
          .update({ nombre_solicitante: NOMBRE_ANONIMIZADO, contacto: '-', acompanantes: [], motivo_cancelacion: null, motivo: motivoQueda })
          .eq('id', r.id);
        if (error) throw error;
        hecho.reservas++;
      }
      for (const r of comoAcompanante) {
        const restantes = (r.acompanantes || []).filter(a => !esElla(a));
        const { error } = await supabase.from('reservas').update({ acompanantes: restantes }).eq('id', r.id);
        if (error) throw error;
        hecho.como_acompanante++;
      }
      if (listaEspera.length) {
        const { error } = await supabase.from('lista_espera').delete().in('id', listaEspera.map(l => l.id));
        if (error) throw error;
        hecho.lista_espera = listaEspera.length;
      }
    } catch (err) {
      console.error('⚠️ Borrado de datos incompleto:', err && (err.message || err.code));
      pendiente.push('reservas o lista de espera');
    }
    const correos = await correosDePersona(datos.emails, contactos);
    if (correos === null) {
      pendiente.push('correos en la cola');
    } else if (correos.length) {
      const { error } = await supabase.from('correos_pendientes').delete().in('id', correos.map(c => c.id));
      if (error) { console.error('⚠️ No se pudieron borrar correos de la cola:', error.message || error.code); pendiente.push('correos en la cola'); }
      else hecho.correos = correos.length;
    }
    // Sin datos personales en el registro: solo cuántas cosas se borraron
    registrarActividad(req.admin.rol, pendiente.length ? 'Borró en parte los datos de una persona' : 'Borró los datos de una persona',
      `${hecho.reservas} reserva(s), ${hecho.como_acompanante} como acompañante, ${hecho.lista_espera} en lista de espera, ${hecho.correos} correo(s) en cola` +
      (pendiente.length ? ` — faltó: ${pendiente.join(', ')}` : ''));
    if (pendiente.length) {
      return res.status(500).json({
        error: `No se pudo borrar todo (faltó: ${pendiente.join(', ')}). Probá "Borrar sus datos" otra vez en un rato; lo que ya se borró no se repite.`,
        ...hecho
      });
    }
    res.json({ mensaje: 'Datos borrados', ...hecho });
  } catch (error) {
    manejarError(res, error);
  }
});

// ===== PERSONALIZACIÓN (admin supremo > Avanzado > Reglas, Textos de la página y Correos) =====
// Lo que antes había que pedir que se cambie en el código. Cada guardado queda en el registro de
// actividad y se aplica al instante (la página lo lee de /api/configuracion).

async function guardarFilasConfig(filas) {
  const { error } = await supabase.from('configuracion').upsert(filas, { onConflict: 'clave' });
  if (error) throw error;
  await cargarConfiguracion();
}

// La plantilla de un correo como la necesita el editor (la de siempre y la vigente)
function plantillaParaEditor(clave) {
  const def = PLANTILLAS_CORREO[clave];
  const actual = plantillaCorreo(clave);
  const campos = def.tipo === 'html' ? ['asunto', 'titulo', 'mensaje'] : ['asunto', 'texto'];
  const tomar = p => Object.fromEntries(campos.map(c => [c, p[c]]));
  return {
    nombre: def.nombre, tipo: def.tipo, interno: !!def.interno, comodines: def.comodines, obligatorios: def.obligatorios || [],
    defecto: tomar(def), actual: tomar(actual), modificada: !!config.plantillas_correo[clave]
  };
}

app.get('/api/superadmin/personalizacion', verifyAdminToken, verifySuperAdmin, (req, res) => {
  res.json({
    reglas: config.reglas_espacios,
    reglas_defecto: REGLAS_POR_DEFECTO,
    max_reservas_por_persona_mes: config.max_reservas_por_persona_mes,
    textos: Object.fromEntries(Object.entries(TEXTOS_PAGINA).map(([k, d]) => [k, {
      grupo: d.grupo, nombre: d.nombre, max: d.max, defecto: d.defecto, comodines: d.comodines || [], ayuda: d.ayuda || '', obligatorio: !!d.obligatorio,
      valor: config.textos_pagina[k] != null ? config.textos_pagina[k] : d.defecto
    }])),
    anuncio: config.anuncio,
    anuncio_visible: !!anuncioVigente(),
    // Qué reglas se actualizan solas en los Términos (porque el texto usa su comodín)
    legal_comodines_usados: comodinesUsados(config.legal_terminos),
    avisos_destinatarios: config.avisos_destinatarios,
    respuestas_listas: config.respuestas_listas,
    respuestas_defecto: RESPUESTAS_POR_DEFECTO,
    // Valor de {plazo_frente} en las respuestas listas (el plazo para cancelar del Frente)
    respuestas_valores: { plazo_frente: (() => { const n = reglaEspacio(3).plazo_cancelacion_dias; return `${n} ${n === 1 ? 'día' : 'días'}`; })() },
    plantillas: Object.fromEntries(Object.keys(PLANTILLAS_CORREO).map(k => [k, plantillaParaEditor(k)]))
  });
});

const NOMBRES_REGLAS = {
  dias: 'días', plazo_cancelacion_dias: 'plazo para cancelar', recordatorio: 'recordatorio', recordatorio_dias: 'días del recordatorio',
  anticipacion_min_dias: 'anticipación mínima', anticipacion_max_dias: 'anticipación máxima', limite_por_persona_mes: 'límite por persona', acompanantes_max: 'acompañantes', normas: 'normas'
};

app.post('/api/superadmin/reglas', verifyAdminToken, verifySuperAdmin, verificarCSRF, async (req, res) => {
  try {
    const b = req.body || {};
    let reglas, maximo;
    try {
      reglas = validarReglasEspacios(b.reglas);
      maximo = VALIDADORES_CONFIG.max_reservas_por_persona_mes(b.max_reservas_por_persona_mes == null ? config.max_reservas_por_persona_mes : b.max_reservas_por_persona_mes);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const cambios = [];
    for (const id of [3, 1]) {
      const antes = reglaEspacio(id);
      const campos = Object.keys(NOMBRES_REGLAS).filter(k => JSON.stringify(antes[k]) !== JSON.stringify(reglas[id][k])).map(k => NOMBRES_REGLAS[k]);
      if (id === 3 && maximo !== config.max_reservas_por_persona_mes) campos.push(`límite por persona (${maximo})`);
      if (campos.length) cambios.push(`${getEspacioNombre(id)}: ${campos.join(', ')}`);
    }
    if (!cambios.length) return res.json({ mensaje: 'No había cambios' });
    await guardarFilasConfig([
      { clave: 'reglas_espacios', valor: comoTexto('reglas_espacios', reglas) },
      { clave: 'max_reservas_por_persona_mes', valor: comoTexto('max_reservas_por_persona_mes', maximo) }
    ]);
    registrarActividad(req.admin.rol, 'Cambió las reglas de los espacios', cambios.join(' · '));
    res.json({ mensaje: 'Reglas guardadas', reglas: config.reglas_espacios, max_reservas_por_persona_mes: config.max_reservas_por_persona_mes });
  } catch (error) {
    manejarError(res, error);
  }
});

app.post('/api/superadmin/textos', verifyAdminToken, verifySuperAdmin, verificarCSRF, async (req, res) => {
  try {
    const b = req.body || {};
    let textos, anuncio;
    try {
      // Sin `textos` (o sin `anuncio`) se deja lo que estaba
      textos = b.textos === undefined ? config.textos_pagina : validarTextosPagina(b.textos);
      anuncio = validarAnuncio(b.anuncio === undefined ? config.anuncio : b.anuncio);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const cambios = [];
    Object.keys(TEXTOS_PAGINA).forEach(k => {
      if ((textos[k] || null) !== (config.textos_pagina[k] || null)) cambios.push(TEXTOS_PAGINA[k].nombre.replace(/ \(opcional\)$/, ''));
    });
    if (JSON.stringify(anuncio) !== JSON.stringify(config.anuncio)) {
      cambios.push(anuncio.activo ? `anuncio: "${anuncio.texto}"${anuncio.hasta ? ` (hasta el ${fechaDMY(anuncio.hasta)})` : ''}` : 'quitó el anuncio');
    }
    if (!cambios.length) return res.json({ mensaje: 'No había cambios' });
    await guardarFilasConfig([
      { clave: 'textos_pagina', valor: comoTexto('textos_pagina', textos) },
      { clave: 'anuncio', valor: comoTexto('anuncio', anuncio) }
    ]);
    registrarActividad(req.admin.rol, 'Cambió los textos de la página', cambios.join(' · '));
    res.json({ mensaje: 'Textos guardados', textos_pagina: config.textos_pagina, anuncio: config.anuncio });
  } catch (error) {
    manejarError(res, error);
  }
});

// Quién recibe los avisos internos de cada espacio ({ 3: [correos], 1: [correos] })
app.post('/api/superadmin/avisos-destinatarios', verifyAdminToken, verifySuperAdmin, verificarCSRF, async (req, res) => {
  try {
    let destinatarios;
    try {
      destinatarios = validarAvisosDestinatarios(req.body || {});
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (JSON.stringify(destinatarios) === JSON.stringify(config.avisos_destinatarios)) return res.json({ mensaje: 'No había cambios' });
    await guardarFilasConfig([{ clave: 'avisos_destinatarios', valor: comoTexto('avisos_destinatarios', destinatarios) }]);
    // Sin los correos en el registro (son datos de personas): solo cuántos quedaron
    registrarActividad(req.admin.rol, 'Cambió quién recibe los avisos internos', `Frente: ${destinatarios[3].length} correo(s) · Altillo: ${destinatarios[1].length} correo(s)`);
    res.json({ mensaje: 'Guardado', avisos_destinatarios: config.avisos_destinatarios });
  } catch (error) {
    manejarError(res, error);
  }
});

// Respuestas listas para copiar ([{ titulo, texto }])
app.post('/api/superadmin/respuestas', verifyAdminToken, verifySuperAdmin, verificarCSRF, async (req, res) => {
  try {
    const b = req.body || {};
    let respuestas;
    try {
      respuestas = validarRespuestasListas(b.restaurar === true ? RESPUESTAS_POR_DEFECTO : b.respuestas);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (JSON.stringify(respuestas) === JSON.stringify(config.respuestas_listas)) return res.json({ mensaje: 'No había cambios', respuestas_listas: config.respuestas_listas });
    await guardarFilasConfig([{ clave: 'respuestas_listas', valor: comoTexto('respuestas_listas', respuestas) }]);
    registrarActividad(req.admin.rol, b.restaurar === true ? 'Volvió a las respuestas listas originales' : 'Cambió las respuestas listas', `${respuestas.length} respuesta(s)`);
    res.json({ mensaje: 'Guardado', respuestas_listas: config.respuestas_listas });
  } catch (error) {
    manejarError(res, error);
  }
});

// Cinta de anuncios sola (admin supremo > Avanzado > Anuncio): publicar ({ activo: true, texto,
// hasta, tipo }) o quitar ({ activo: false }). Devuelve si se está viendo en la página ahora.
app.post('/api/superadmin/anuncio', verifyAdminToken, verifySuperAdmin, verificarCSRF, async (req, res) => {
  try {
    const b = req.body || {};
    let anuncio;
    try {
      anuncio = validarAnuncio({ ...config.anuncio, ...b });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const hoy = hoyEnAsuncion().toISOString().slice(0, 10);
    if (anuncio.activo && anuncio.hasta && anuncio.hasta < hoy) {
      return res.status(400).json({ error: 'La fecha "mostrar hasta" ya pasó: elegí hoy o un día que venga (o dejala vacía)' });
    }
    if (JSON.stringify(anuncio) !== JSON.stringify(config.anuncio)) {
      await guardarFilasConfig([{ clave: 'anuncio', valor: comoTexto('anuncio', anuncio) }]);
      registrarActividad(req.admin.rol, anuncio.activo ? 'Publicó un anuncio' : 'Quitó el anuncio',
        anuncio.activo ? `"${anuncio.texto}"${anuncio.hasta ? ` (hasta el ${fechaDMY(anuncio.hasta)})` : ''}` : '');
    }
    res.json({ mensaje: anuncio.activo ? 'Anuncio publicado' : 'Anuncio quitado', anuncio: config.anuncio, visible: !!anuncioVigente() });
  } catch (error) {
    manejarError(res, error);
  }
});

// Guardar una plantilla ({ clave, asunto, titulo, mensaje } o { clave, asunto, texto }) o volver a
// la de siempre ({ clave, restaurar: true })
app.post('/api/superadmin/plantillas', verifyAdminToken, verifySuperAdmin, verificarCSRF, async (req, res) => {
  try {
    const b = req.body || {};
    const clave = String(b.clave || '');
    if (!Object.prototype.hasOwnProperty.call(PLANTILLAS_CORREO, clave)) return res.status(400).json({ error: 'Correo desconocido' });
    const todas = { ...config.plantillas_correo };
    if (b.restaurar === true) delete todas[clave];
    else todas[clave] = { asunto: b.asunto, titulo: b.titulo, mensaje: b.mensaje, texto: b.texto };
    let plantillas;
    try {
      plantillas = validarPlantillasCorreo(todas);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    await guardarFilasConfig([{ clave: 'plantillas_correo', valor: comoTexto('plantillas_correo', plantillas) }]);
    registrarActividad(req.admin.rol, b.restaurar === true ? 'Volvió al correo original' : 'Cambió un correo', PLANTILLAS_CORREO[clave].nombre);
    res.json({ mensaje: b.restaurar === true ? 'Listo: el correo volvió al texto original' : 'Correo guardado', plantilla: plantillaParaEditor(clave) });
  } catch (error) {
    manejarError(res, error);
  }
});

// Datos de ejemplo para las pruebas: número de reserva 0 (el enlace para cancelar no sirve para
// ninguna reserva de verdad) y un día de dentro de unas semanas en que se pueda reservar.
function reservaDeEjemplo(espacioId) {
  const fecha = hoyEnAsuncion();
  fecha.setUTCDate(fecha.getUTCDate() + 10);
  const dias = reglaEspacio(espacioId).dias;
  for (let i = 0; i < 7 && !dias.includes(fecha.getUTCDay()); i++) fecha.setUTCDate(fecha.getUTCDate() + 1);
  const turno = config.turnos_frente[0];
  const esFrente = Number(espacioId) === 3;
  return {
    id: 0, espacio_id: Number(espacioId), nombre_solicitante: 'Ana Pérez', contacto: '0981 123 456 | ana.perez@example.com', fecha: fecha.toISOString().slice(0, 10),
    hora_inicio: esFrente ? turno.inicio : '09:00', hora_fin: esFrente ? turno.fin : '11:00',
    motivo: esFrente ? config.motivos_frente[0] : 'Estudio para el parcial', acompanantes: []
  };
}

const MAX_PRUEBAS_DE_CORREO_POR_DIA = 30;
const PREFIJO_PRUEBA_CORREO = '[PRUEBA] ';

// Las pruebas de hoy se cuentan en la cola de correos (el asunto queda aunque el correo ya salió)
async function pruebasDeCorreoHoy() {
  const { data, error } = await supabase.from('correos_pendientes').select('asunto')
    .gte('creado_en', inicioDelDiaEnAsuncion()).limit(1000);
  if (error) throw error;
  return (data || []).filter(c => String(c.asunto || '').startsWith(PREFIJO_PRUEBA_CORREO)).length;
}

// Un correo con datos de ejemplo, armado exactamente igual que los de verdad (correoDeReserva /
// correoListaEspera), con lo escrito en el editor aunque no se haya guardado. Lo usan la vista
// previa del panel y "Enviarme una prueba". Devuelve { error } o { subject, html | text }.
function correoDeEjemplo(b) {
  const clave = String(b.clave || '');
  if (!Object.prototype.hasOwnProperty.call(PLANTILLAS_CORREO, clave)) return { error: 'Correo desconocido' };
  const def = PLANTILLAS_CORREO[clave];
  const espacioId = Number(b.espacio_id) === 1 ? 1 : 3;
  // Sin asunto en el pedido: la plantilla guardada
  let borrador = null;
  if (b.asunto !== undefined) {
    try {
      borrador = validarPlantillasCorreo({ [clave]: { asunto: b.asunto, titulo: b.titulo, mensaje: b.mensaje, texto: b.texto } })[clave] || {};
    } catch (err) {
      return { error: err.message };
    }
  }
  // Se arma con el borrador en lugar de la plantilla guardada (todo sincrónico: no se cruza con
  // ningún otro correo) y se vuelve a dejar como estaba
  const r = reservaDeEjemplo(espacioId);
  const guardadas = config.plantillas_correo;
  try {
    // borrador {} = lo escrito es igual al original; null = la guardada
    config.plantillas_correo = { ...guardadas, [clave]: borrador || guardadas[clave] || {} };
    if (def.tipo === 'html') {
      const c = correoDeReserva(clave, r, {
        codigo: ['confirmacion', 'reenvio'].includes(clave) ? 'A1B2C3D4E5F60789' : null,
        motivo: 'Mantenimiento del espacio', cambios: 'día u horario', valores: { numero: '1234' }
      });
      // La reserva de ejemplo es la #0 (su enlace para cancelar no sirve para ninguna real); el
      // asunto se muestra con un número como los de verdad
      return { subject: `${c.asunto} - CEQ #1234`, html: c.html };
    }
    const mes = r.fecha.slice(0, 7);
    const diaLargo = fechaLarga(r.fecha);
    const turno = espacioId === 3 ? nombreTurnoFrente(r.hora_inicio, r.hora_fin) : `${r.hora_inicio} a ${r.hora_fin}`;
    const c = correoListaEspera(clave, {
      saludo: saludoCorreo(r.nombre_solicitante), espacio: getEspacioNombre(espacioId), mes: nombreDelMes(mes),
      dia: diaLargo, dia_corto: diaLargo.replace(/\/\d{4}$/, ''), horario: descripcionHorario(espacioId, r.hora_inicio, r.hora_fin), turno,
      enlace_quitar: 'https://reservas.ceq-una.com/lista-espera.html?… (enlace de ejemplo)',
      enlace_reservar: `https://reservas.ceq-una.com/?fecha=${r.fecha}&espacio=${espacioId}`
    });
    return { subject: c.asunto, text: c.texto };
  } finally {
    config.plantillas_correo = guardadas;
  }
}

// Vista previa del panel: el correo tal cual sale (no manda nada)
app.post('/api/superadmin/plantillas/vista-previa', verifyAdminToken, verifySuperAdmin, verificarCSRF, (req, res) => {
  try {
    const correo = correoDeEjemplo(req.body || {});
    if (correo.error) return res.status(400).json({ error: correo.error });
    res.set('Cache-Control', 'no-store');
    res.json({ asunto: correo.subject, html: correo.html || null, texto: correo.text || null });
  } catch (error) {
    manejarError(res, error);
  }
});

// "Enviarme una prueba": manda el correo (con lo que está escrito en el editor, aunque no se haya
// guardado) al correo de las alertas, con datos de ejemplo
app.post('/api/superadmin/plantillas/prueba', verifyAdminToken, verifySuperAdmin, verificarCSRF, async (req, res) => {
  try {
    const correo = correoDeEjemplo(req.body || {});
    if (correo.error) return res.status(400).json({ error: correo.error });
    if (await pruebasDeCorreoHoy() >= MAX_PRUEBAS_DE_CORREO_POR_DIA) return res.status(429).json({ error: `Hoy ya se mandaron ${MAX_PRUEBAS_DE_CORREO_POR_DIA} pruebas. Probá mañana.` });
    if (await correosOpcionalesRestantesHoy() <= 0) return res.status(429).json({ error: 'Hoy ya salieron muchos correos: las pruebas se frenan para dejar lugar a las confirmaciones de las reservas. Probá mañana.' });
    const enviado = await encolarCorreo({ to: config.email_alertas, subject: `${PREFIJO_PRUEBA_CORREO}${correo.subject}`, html: correo.html, text: correo.text });
    res.json({ mensaje: enviado ? `Listo: te mandamos la prueba a ${config.email_alertas}` : 'No se pudo mandar la prueba ahora; quedó para reintentar' });
  } catch (error) {
    manejarError(res, error);
  }
});

// ========== TÉRMINOS Y CONDICIONES Y POLÍTICA DE PRIVACIDAD EDITABLES ==========
// Se editan desde el admin supremo (Avanzado > Términos y privacidad). Cada documento se guarda en
// la tabla configuracion (claves legal_terminos y legal_privacidad); si no hay nada guardado, se
// usa el texto de legal-por-defecto.json (el de siempre). Las páginas terminos.html y
// privacidad.html lo piden a /api/legal/:doc y, si el servidor no responde, muestran el texto que
// traen escrito (el de la última versión publicada en ellas).
//
// El texto se escribe en un formato simple, nunca en HTML (así no se puede romper la página ni meter
// código): una línea en blanco separa párrafos; las líneas que empiezan con "- " forman una lista;
// las que empiezan con "a) ", "b) "… forman una lista con letras; **así** va en negrita; y
// [texto](destino) es un enlace, donde destino es una página (terminos.html, privacidad.html), una
// dirección https://…, un correo (mailto:alguien@…) o un correo con mensaje armado (plantilla:clave).
// Los {comodines} se completan con las reglas del sistema, así el texto no contradice lo que hace.
const LEGAL_DOCS = { terminos: 'Términos y condiciones', privacidad: 'Política de privacidad' };
const LEGAL_LIMITES = { intro: 4000, articulos: 40, titulo: 150, texto: 8000, plantillas: 20, asunto: 150, cuerpo: 2000, historial: 10, resumen: 300 };

const NUMEROS_EN_LETRAS = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce',
  'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés',
  'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve', 'treinta'];
// "dos (2) días", "una (1) hora" (femenino), "uno (1) día" -> "un (1) día"
function cantidadLegal(n, singular, plural, femenino = false) {
  let letras = NUMEROS_EN_LETRAS[n] || String(n);
  if (n === 1) letras = femenino ? 'una' : 'un';
  if (n === 21) letras = femenino ? 'veintiuna' : 'veintiún';
  return `${letras} (${n}) ${n === 1 ? singular : plural}`;
}
const NOMBRES_DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
// [1,2,3,4,5] -> "de lunes a viernes"; [1,3,5] -> "los lunes, miércoles y viernes"
function diasEnTexto(dias) {
  const orden = [1, 2, 3, 4, 5, 6, 0].filter(d => dias.includes(d));
  if (orden.length === 7) return 'todos los días';
  const posicion = d => [1, 2, 3, 4, 5, 6, 0].indexOf(d);
  const seguidos = orden.every((d, i) => i === 0 || posicion(d) === posicion(orden[i - 1]) + 1);
  if (seguidos && orden.length >= 3) return `de ${NOMBRES_DIAS_SEMANA[orden[0]]} a ${NOMBRES_DIAS_SEMANA[orden[orden.length - 1]]}`;
  const plurales = orden.map(d => (d === 6 ? 'sábados' : d === 0 ? 'domingos' : NOMBRES_DIAS_SEMANA[d]));
  return 'los ' + (plurales.length === 1 ? plurales[0] : `${plurales.slice(0, -1).join(', ')} y ${plurales[plurales.length - 1]}`);
}

// Comodines de los textos legales: su descripción para el editor y su valor con las reglas vigentes
const COMODINES_LEGALES = {
  dias_reserva: 'Días en que se reserva (Reglas). Ej.: "de lunes a viernes"',
  horario_altillo: 'Horario y duración del Altillo (Configuración). Ej.: "entre las 07:00 y las 19:00 (…), con una duración mínima de una (1) hora y máxima de dos (2) horas por Reserva"',
  plazo_cancelacion_frente: 'Hasta cuándo se cancela gratis el Frente (Reglas). Ej.: "hasta dos (2) días calendario antes de la fecha de la Reserva"',
  plazo_cancelacion_altillo: 'Lo mismo para el Altillo. Ej.: "hasta el inicio de la Reserva"',
  recordatorio: 'La frase del recordatorio (Reglas). Ej.: "Dos (2) días antes de la fecha, el Sistema enviará un recordatorio al correo registrado."',
  max_acompanantes: 'Máximo de acompañantes en el Altillo. Ej.: "cuatro (4)"',
  acompanantes_por_espacio: 'En qué espacios y cuántos acompañantes se anotan (Reglas). Ej.: "solo en el Altillo, hasta cuatro (4) por Reserva"',
  meses_conservacion: 'Plazo de conservación de los datos. Ej.: "seis (6) meses"'
};
function valoresComodinesLegales() {
  const frente = reglaEspacio(3), altillo = reglaEspacio(1);
  const hora = h => `${String(h).padStart(2, '0')}:00`;
  const plazo = r => (r.plazo_cancelacion_dias > 0
    ? `hasta ${cantidadLegal(r.plazo_cancelacion_dias, 'día calendario', 'días calendario')} antes de la fecha de la Reserva`
    : 'hasta el inicio de la Reserva');
  const recordatorioDe = r => `${cantidadLegal(r.recordatorio_dias, 'día', 'días')} antes de la fecha`;
  let recordatorio;
  if (frente.recordatorio && altillo.recordatorio && frente.recordatorio_dias === altillo.recordatorio_dias) {
    const t = recordatorioDe(frente);
    recordatorio = `${t[0].toUpperCase()}${t.slice(1)}, el Sistema enviará un recordatorio al correo registrado.`;
  } else if (frente.recordatorio || altillo.recordatorio) {
    const partes = [];
    if (frente.recordatorio) partes.push(`en el Frente, ${recordatorioDe(frente)}`);
    if (altillo.recordatorio) partes.push(`en el Altillo, ${recordatorioDe(altillo)}`);
    recordatorio = `El Sistema enviará un recordatorio al correo registrado ${partes.join(', y ')}.`;
  } else {
    recordatorio = 'El Sistema no envía recordatorios: el Usuario es responsable de recordar su Reserva.';
  }
  const mismosDias = frente.dias.join() === altillo.dias.join();
  const desde = config.altillo_hora_desde, hasta = config.altillo_hora_hasta;
  // AUD-12: los acompañantes se configuran por espacio (antes el texto decía siempre "solo Altillo")
  const enLetras = n => `${NUMEROS_EN_LETRAS[n] || n} (${n})`;
  const conAcompanantes = [['Frente', frente.acompanantes_max], ['Altillo', altillo.acompanantes_max]].filter(([, n]) => n > 0);
  const acompanantesPorEspacio = conAcompanantes.length === 0
    ? 'en ningún espacio'
    : conAcompanantes.length === 1
      ? `solo en el ${conAcompanantes[0][0]}, hasta ${enLetras(conAcompanantes[0][1])} por Reserva`
      : frente.acompanantes_max === altillo.acompanantes_max
        ? `en el Frente y en el Altillo, hasta ${enLetras(frente.acompanantes_max)} por Reserva`
        : `en el Frente, hasta ${enLetras(frente.acompanantes_max)}, y en el Altillo, hasta ${enLetras(altillo.acompanantes_max)} por Reserva`;
  return {
    dias_reserva: mismosDias ? diasEnTexto(frente.dias) : `en el Frente, ${diasEnTexto(frente.dias)}, y en el Altillo, ${diasEnTexto(altillo.dias)}`,
    horario_altillo: `entre las ${hora(desde)} y las ${hora(hasta)} (el primer bloque comienza a las ${hora(desde)} y el último, a las ${hora(hasta - 1)}), con una duración mínima de una (1) hora y máxima de ${cantidadLegal(config.altillo_max_horas, 'hora', 'horas', true)} por Reserva`,
    plazo_cancelacion_frente: plazo(frente),
    plazo_cancelacion_altillo: plazo(altillo),
    recordatorio,
    max_acompanantes: enLetras(altillo.acompanantes_max),
    acompanantes_por_espacio: acompanantesPorEspacio,
    meses_conservacion: cantidadLegal(MESES_CONSERVACION, 'mes', 'meses')
  };
}

// href para un enlace del texto, o null si el destino no está permitido
function hrefLegal(destino, plantillas) {
  if (/^plantilla:[a-z][a-z0-9_]*$/.test(destino)) {
    const p = plantillas[destino.slice(10)];
    return p ? `mailto:${p.para}?subject=${encodeURIComponent(p.asunto)}&body=${encodeURIComponent(p.cuerpo)}` : null;
  }
  if (/^(terminos|privacidad)\.html$/.test(destino)) return destino;
  if (/^https:\/\/[^\s<>"']+$/.test(destino)) return destino;
  if (/^mailto:[^\s<>"'?]+@[^\s<>"'?]+$/.test(destino)) return destino;
  return null;
}

// Una línea (o párrafo) del formato simple -> HTML seguro. Los comodines se completan antes de
// escapar; después se aplican las negritas y los enlaces sobre el texto ya escapado.
function lineaLegalHtml(texto, valores, plantillas) {
  let t = String(texto).replace(/\{([a-z_]+)\}/g, (todo, n) => (valores[n] !== undefined ? valores[n] : todo));
  t = escapeHtml(t);
  t = t.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\[([^\]]+?)\]\(([^)\s]+)\)/g, (todo, etiqueta, destino) => {
    const href = hrefLegal(destino.replace(/&amp;/g, '&'), plantillas);
    return href ? `<a href="${escapeHtml(href)}">${etiqueta}</a>` : etiqueta;
  });
  return t;
}

// Texto de un artículo (o la introducción) -> HTML: párrafos, listas con viñetas y listas con letras
function textoLegalHtml(texto, valores, plantillas) {
  const bloques = String(texto || '').replace(/\r\n/g, '\n').split(/\n\s*\n/).map(b => b.split('\n').map(l => l.trim()).filter(Boolean)).filter(b => b.length);
  const salida = [];
  for (const lineas of bloques) {
    // Un bloque puede mezclar un texto y una lista seguida: se separa en tramos del mismo tipo
    let tramo = null;
    const cerrar = () => {
      if (!tramo) return;
      if (tramo.tipo === 'p') salida.push(`<p>${tramo.lineas.map(l => lineaLegalHtml(l, valores, plantillas)).join('<br>')}</p>`);
      else salida.push(`<ul${tramo.tipo === 'letras' ? ' class="letras"' : ''}>\n${tramo.lineas.map(l => `  <li>${lineaLegalHtml(l, valores, plantillas)}</li>`).join('\n')}\n</ul>`);
      tramo = null;
    };
    for (const linea of lineas) {
      const tipo = /^- /.test(linea) ? 'lista' : (/^[a-z]\) /.test(linea) ? 'letras' : 'p');
      const contenido = tipo === 'lista' ? linea.slice(2) : linea;
      if (!tramo || tramo.tipo !== tipo) { cerrar(); tramo = { tipo, lineas: [] }; }
      tramo.lineas.push(contenido);
    }
    cerrar();
  }
  return salida.join('\n');
}

const MESES_LARGOS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function fechaLegal(iso) {
  const [a, m, d] = String(iso).split('-').map(Number);
  return `${d} de ${MESES_LARGOS[m - 1]} de ${a}`;
}

// Un documento entero -> HTML (la línea de versión, la introducción y los artículos)
function documentoLegalHtml(doc, valores = valoresComodinesLegales()) {
  const plantillas = doc.plantillas || {};
  const partes = [`<p class="fecha">Versión ${escapeHtml(doc.version)} · Vigente desde el ${fechaLegal(doc.vigente_desde)}</p>`];
  if (doc.intro) partes.push(textoLegalHtml(doc.intro, valores, plantillas));
  for (const a of doc.articulos) {
    partes.push(`<h2>${lineaLegalHtml(a.titulo, valores, plantillas)}</h2>`);
    partes.push(textoLegalHtml(a.texto, valores, plantillas));
  }
  return partes.join('\n');
}

// Revisa comodines y enlaces de un texto: lanza un Error con el lugar y el motivo
function revisarTextoLegal(texto, plantillas, donde) {
  const desconocidos = [...String(texto).matchAll(/\{([^{}\s]+)\}/g)].map(m => m[1]).filter(c => !COMODINES_LEGALES[c]);
  if (desconocidos.length) throw new Error(`${donde}: no existe ${desconocidos.map(c => `{${c}}`).join(', ')}. Podés usar: ${Object.keys(COMODINES_LEGALES).map(c => `{${c}}`).join(', ')}`);
  for (const m of String(texto).matchAll(/\[([^\]]+?)\]\(([^)\s]*)\)/g)) {
    if (!hrefLegal(m[2], plantillas)) {
      throw new Error(`${donde}: el enlace "[${m[1]}](${m[2]})" no es válido. Usá terminos.html, privacidad.html, https://…, mailto:correo@… o plantilla:clave (una de las de "Correos con mensaje armado")`);
    }
  }
}

// Valida y normaliza el contenido editable (introducción, artículos y plantillas de correo)
function validarContenidoLegal(v) {
  const L = LEGAL_LIMITES;
  const texto = (t, max, nombre, unaLinea) => {
    const s = String(t == null ? '' : t).replace(/\r\n/g, '\n');
    const r = unaLinea ? s.replace(/\s+/g, ' ').trim() : s.replace(/[ \t]+\n/g, '\n').trim();
    if (r.length > max) throw new Error(`${nombre}: hasta ${max} caracteres`);
    return r;
  };
  const plantillasCrudas = v.plantillas && typeof v.plantillas === 'object' ? v.plantillas : {};
  const claves = Object.keys(plantillasCrudas);
  if (claves.length > L.plantillas) throw new Error(`Puede haber hasta ${L.plantillas} correos con mensaje armado`);
  const plantillas = {};
  for (const clave of claves) {
    if (!/^[a-z][a-z0-9_]{0,29}$/.test(clave)) throw new Error(`El nombre "${clave}" de un correo con mensaje armado solo puede tener minúsculas, números y _`);
    const p = plantillasCrudas[clave] || {};
    const para = String(p.para || '').trim().toLowerCase();
    if (!EMAIL_REGEX.test(para) || para.length > 100) throw new Error(`Correo con mensaje armado "${clave}": la dirección no es válida`);
    plantillas[clave] = { para, asunto: texto(p.asunto, L.asunto, `Correo "${clave}" — el asunto`, true), cuerpo: texto(p.cuerpo, L.cuerpo, `Correo "${clave}" — el mensaje`, false) };
    if (!plantillas[clave].asunto) throw new Error(`Correo con mensaje armado "${clave}": escribí el asunto`);
  }
  const intro = texto(v.intro, L.intro, 'La introducción', false);
  revisarTextoLegal(intro, plantillas, 'La introducción');
  const articulos = Array.isArray(v.articulos) ? v.articulos : [];
  if (!articulos.length) throw new Error('Tiene que haber al menos un artículo');
  if (articulos.length > L.articulos) throw new Error(`Puede haber hasta ${L.articulos} artículos`);
  const limpios = articulos.map((a, i) => {
    const titulo = texto(a && a.titulo, L.titulo, `El título del artículo ${i + 1}`, true);
    const cuerpo = texto(a && a.texto, L.texto, `El texto de "${titulo || `artículo ${i + 1}`}"`, false);
    if (titulo.length < 3) throw new Error(`El artículo ${i + 1} necesita un título`);
    if (!cuerpo) throw new Error(`"${titulo}" está vacío`);
    revisarTextoLegal(titulo, plantillas, `El título "${titulo}"`);
    revisarTextoLegal(cuerpo, plantillas, `"${titulo}"`);
    return { titulo, texto: cuerpo };
  });
  return { intro, articulos: limpios, plantillas };
}

function validarDocumentoLegal(valor) {
  const v = valor || {};
  if (!/^\d{1,3}\.\d{1,3}$/.test(String(v.version || ''))) throw new Error('Versión inválida');
  if (!esFechaValida(v.vigente_desde)) throw new Error('Fecha de vigencia inválida');
  const historial = (Array.isArray(v.historial) ? v.historial : []).slice(0, LEGAL_LIMITES.historial).map(h => ({
    version: String(h.version || ''), vigente_desde: String(h.vigente_desde || ''), reemplazada_en: String(h.reemplazada_en || ''),
    resumen: String(h.resumen || '').slice(0, LEGAL_LIMITES.resumen),
    contenido: h.contenido && Array.isArray(h.contenido.articulos) ? h.contenido : null
  }));
  return { version: String(v.version), vigente_desde: v.vigente_desde, ...validarContenidoLegal(v), historial };
}

// Comodines que usa un documento (para saber qué reglas se actualizan solas en el texto)
function comodinesUsados(doc) {
  const todo = [doc.intro, ...doc.articulos.map(a => `${a.titulo}\n${a.texto}`)].join('\n');
  return Object.keys(COMODINES_LEGALES).filter(c => todo.includes(`{${c}}`));
}

// Público: el documento vigente ya armado
app.get('/api/legal/:doc', lecturaPublicaLimiter, (req, res) => {
  const clave = req.params.doc;
  if (!Object.prototype.hasOwnProperty.call(LEGAL_DOCS, clave)) return res.status(404).json({ error: 'Documento inexistente' });
  const doc = config[`legal_${clave}`];
  // Sin guardar en caché: una versión recién publicada se ve al instante (el texto es chico)
  res.set('Cache-Control', 'no-cache');
  res.json({ titulo: LEGAL_DOCS[clave], version: doc.version, vigente_desde: doc.vigente_desde, html: documentoLegalHtml(doc) });
});

// Admin supremo: los dos documentos para editar, los comodines con su valor de hoy y el historial
app.get('/api/superadmin/legal', verifyAdminToken, verifySuperAdmin, (req, res) => {
  const valores = valoresComodinesLegales();
  res.json({
    documentos: Object.fromEntries(Object.keys(LEGAL_DOCS).map(clave => {
      const d = config[`legal_${clave}`];
      return [clave, {
        titulo: LEGAL_DOCS[clave], version: d.version, vigente_desde: d.vigente_desde, intro: d.intro, articulos: d.articulos, plantillas: d.plantillas,
        comodines_usados: comodinesUsados(d),
        historial: d.historial.map((h, i) => ({ indice: i, version: h.version, vigente_desde: h.vigente_desde, reemplazada_en: h.reemplazada_en, resumen: h.resumen, tiene_texto: !!h.contenido }))
      }];
    })),
    comodines: Object.entries(COMODINES_LEGALES).map(([clave, descripcion]) => ({ clave, descripcion, valor: valores[clave] }))
  });
});

// Vista previa con lo que está escrito en el editor (aunque no se haya guardado)
app.post('/api/superadmin/legal/vista-previa', verifyAdminToken, verifySuperAdmin, verificarCSRF, (req, res) => {
  const b = req.body || {};
  const clave = String(b.doc || '');
  if (!Object.prototype.hasOwnProperty.call(LEGAL_DOCS, clave)) return res.status(400).json({ error: 'Documento inexistente' });
  try {
    const contenido = validarContenidoLegal(b);
    const actual = config[`legal_${clave}`];
    res.set('Cache-Control', 'no-store');
    res.json({ html: documentoLegalHtml({ version: actual.version, vigente_desde: actual.vigente_desde, ...contenido }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Una versión anterior (para verla o descargarla)
app.get('/api/superadmin/legal/:doc/historial/:i', verifyAdminToken, verifySuperAdmin, (req, res) => {
  const clave = req.params.doc;
  if (!Object.prototype.hasOwnProperty.call(LEGAL_DOCS, clave)) return res.status(404).json({ error: 'Documento inexistente' });
  const h = config[`legal_${clave}`].historial[Number(req.params.i)];
  if (!h || !h.contenido) return res.status(404).json({ error: 'Esa versión no tiene el texto guardado' });
  res.json({ titulo: LEGAL_DOCS[clave], version: h.version, vigente_desde: h.vigente_desde, html: documentoLegalHtml({ version: h.version, vigente_desde: h.vigente_desde, ...h.contenido }) });
});

// Guardar. publicar: 'correccion' (misma versión y fecha: para errores de tipeo) o 'menor' / 'mayor'
// (versión nueva: 1.3 -> 1.4 o 2.0, con su fecha de vigencia y un resumen de lo que cambió; la
// versión anterior queda en el historial con su texto)
app.post('/api/superadmin/legal/:doc', verifyAdminToken, verifySuperAdmin, verificarCSRF, async (req, res) => {
  try {
    const clave = req.params.doc;
    if (!Object.prototype.hasOwnProperty.call(LEGAL_DOCS, clave)) return res.status(404).json({ error: 'Documento inexistente' });
    const b = req.body || {};
    const publicar = String(b.publicar || '');
    if (!['correccion', 'menor', 'mayor'].includes(publicar)) return res.status(400).json({ error: 'Elegí cómo guardar: corrección o versión nueva' });
    let contenido;
    try {
      contenido = validarContenidoLegal(b);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const actual = config[`legal_${clave}`];
    const sinCambios = JSON.stringify({ intro: actual.intro, articulos: actual.articulos, plantillas: actual.plantillas }) === JSON.stringify(contenido);
    let nuevo;
    if (publicar === 'correccion') {
      if (sinCambios) return res.json({ mensaje: 'No había cambios' });
      nuevo = { ...actual, ...contenido };
    } else {
      const resumen = String(b.resumen || '').replace(/\s+/g, ' ').trim();
      if (resumen.length < 5 || resumen.length > LEGAL_LIMITES.resumen) return res.status(400).json({ error: `Escribí en pocas palabras qué cambió (entre 5 y ${LEGAL_LIMITES.resumen} caracteres): queda en el historial` });
      const hoy = hoyEnAsuncion().toISOString().slice(0, 10);
      const vigente = b.vigente_desde ? String(b.vigente_desde) : hoy;
      if (!esFechaValida(vigente) || vigente < hoy) return res.status(400).json({ error: 'La fecha de vigencia tiene que ser hoy o un día que venga' });
      const [mayor, menor] = actual.version.split('.').map(Number);
      const version = publicar === 'mayor' ? `${mayor + 1}.0` : `${mayor}.${menor + 1}`;
      nuevo = {
        ...contenido, version, vigente_desde: vigente,
        historial: [{ version: actual.version, vigente_desde: actual.vigente_desde, reemplazada_en: hoy, resumen,
          contenido: { intro: actual.intro, articulos: actual.articulos, plantillas: actual.plantillas } }, ...actual.historial].slice(0, LEGAL_LIMITES.historial)
      };
    }
    let validado;
    try {
      validado = validarDocumentoLegal(nuevo);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    await guardarFilasConfig([{ clave: `legal_${clave}`, valor: comoTexto(`legal_${clave}`, validado) }]);
    registrarActividad(req.admin.rol, publicar === 'correccion' ? `Corrigió ${LEGAL_DOCS[clave]}` : `Publicó ${LEGAL_DOCS[clave]} v${validado.version}`,
      publicar === 'correccion' ? `v${validado.version}` : `vigente desde el ${fechaDMY(validado.vigente_desde)} · ${validado.historial[0].resumen}`);
    res.json({ mensaje: publicar === 'correccion' ? 'Corrección guardada' : `Publicada la versión ${validado.version}`, version: validado.version, vigente_desde: validado.vigente_desde });
  } catch (error) {
    manejarError(res, error);
  }
});

// ===== HERRAMIENTAS DEL ADMIN SUPREMO (octubre 2026) =====
// Editar una reserva, reenviar su confirmación, ver su historial, pausar las reservas, cambiar
// la contraseña del panel de los admins, ver el estado del sistema y bajar una copia en el momento.

// Los correos de "confirmación reenviada" y "reserva modificada" salen de sus plantillas
// (correoDeReserva), con el mismo formato que la confirmación original.

async function reservaPorId(id) {
  const { data, error } = await supabase.from('reservas').select('*').eq('id', Number(id)).maybeSingle();
  if (error) throw error;
  return data;
}

// Reenviar la confirmación: para "no me llegó el correo". El código anterior no se puede
// recuperar (solo se guarda cifrado), así que se genera uno nuevo y el viejo deja de servir.
app.post('/api/superadmin/reservas/:id/reenviar', verifyAdminToken, verifySuperAdmin, verificarCSRF, async (req, res) => {
  try {
    if (!esIdValido(req.params.id)) return res.status(400).json({ error: 'ID inválido' });
    const reserva = await reservaPorId(req.params.id);
    if (!reserva) return res.status(404).json({ error: 'La reserva no existe' });
    if (reserva.estado !== 'activa') return res.status(400).json({ error: 'La reserva está cancelada' });
    if (reservaYaTermino(reserva)) return res.status(400).json({ error: 'La reserva ya pasó' });
    const email = correoDeContacto(reserva.contacto);
    if (!email) return res.status(400).json({ error: 'La reserva no tiene un correo válido. Corregilo con "Editar" y después reenviá.' });

    const codigo = crypto.randomBytes(8).toString('hex').toUpperCase();
    const { error } = await supabase.from('reservas').update({ codigo_cancelacion_hash: hashCodigo(codigo) }).eq('id', reserva.id).eq('estado', 'activa');
    if (error) throw error;
    const correo = correoDeReserva('reenvio', reserva, { codigo });
    const enviado = await encolarCorreo({
      to: email,
      subject: correo.asunto,
      responderA: correoRespuesta(reserva.espacio_id),
      html: correo.html
    });
    registrarActividad(req.admin.rol, 'Reenvió la confirmación de una reserva', `#${reserva.id}`);
    res.json({ mensaje: enviado ? `Listo: se reenvió la confirmación a ${email}` : 'No se pudo enviar el correo ahora; quedó para reintentar' });
  } catch (error) {
    manejarError(res, error);
  }
});

// Editar una reserva activa que todavía no pasó: nombre, celular, correo, día y horario. No pasa
// por el límite por persona ni por los meses habilitados (lo decide el admin supremo), pero sí
// respeta los turnos/horarios del espacio, los bloqueos y que no se superponga con otra reserva.
app.put('/api/superadmin/reservas/:id', verifyAdminToken, verifySuperAdmin, verificarCSRF, async (req, res) => {
  try {
    if (!esIdValido(req.params.id)) return res.status(400).json({ error: 'ID inválido' });
    const reserva = await reservaPorId(req.params.id);
    if (!reserva) return res.status(404).json({ error: 'La reserva no existe' });
    if (reserva.estado !== 'activa') return res.status(400).json({ error: 'Solo se pueden editar reservas activas' });
    if (reservaYaTermino(reserva)) return res.status(400).json({ error: 'La reserva ya pasó' });

    const b = req.body || {};
    const [celularActual = '', emailActual = ''] = String(reserva.contacto || '').split('|').map(p => p.trim());
    const texto = (v, actual) => v === undefined || v === null ? actual : (typeof v === 'string' ? v : null);
    const campos = {
      nombre_solicitante: texto(b.nombre_solicitante, reserva.nombre_solicitante),
      celular: texto(b.celular, celularActual),
      email: texto(b.email, emailActual),
      fecha: texto(b.fecha, reserva.fecha),
      hora_inicio: texto(b.hora_inicio, String(reserva.hora_inicio).substring(0, 5)),
      hora_fin: texto(b.hora_fin, String(reserva.hora_fin).substring(0, 5))
    };
    if (Object.values(campos).some(v => v === null)) return res.status(400).json({ error: 'Tipos de datos inválidos' });
    let datos;
    try {
      // Las mismas reglas que una reserva nueva para nombre, celular, correo y fecha
      datos = validarDatosDeReserva({
        espacio_id: reserva.espacio_id, nombre_solicitante: campos.nombre_solicitante, contacto: `${campos.celular} | ${campos.email}`,
        fecha: campos.fecha, hora_inicio: campos.hora_inicio, hora_fin: campos.hora_fin, motivo: reserva.motivo || 'Sin especificar'
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const ini = datos.hora_inicio.substring(0, 5), fin = datos.hora_fin.substring(0, 5);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(ini) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(fin)) return res.status(400).json({ error: 'Horario inválido' });
    const espacioId = Number(reserva.espacio_id);
    if (espacioId === 3) {
      if (!config.turnos_frente.some(t => t.inicio === ini && t.fin === fin)) return res.status(400).json({ error: 'En el Frente el horario tiene que ser uno de los turnos' });
    } else {
      const hI = Number(ini.slice(0, 2)), hF = Number(fin.slice(0, 2));
      if (ini.slice(3) !== '00' || fin.slice(3) !== '00' || hI < config.altillo_hora_desde || hF > config.altillo_hora_hasta || hF <= hI || hF - hI > config.altillo_max_horas) {
        return res.status(400).json({ error: `Horario inválido para el Altillo (horas enteras entre ${config.altillo_hora_desde}:00 y ${config.altillo_hora_hasta}:00, hasta ${config.altillo_max_horas} h)` });
      }
    }
    const nueva = { ...reserva, nombre_solicitante: datos.nombre_solicitante, contacto: datos.contacto, fecha: datos.fecha, hora_inicio: ini + ':00', hora_fin: fin + ':00' };
    if (reservaYaTermino(nueva) || diferenciaEnDiasCalendario(datos.fecha) < 0) return res.status(400).json({ error: 'El nuevo horario ya pasó' });

    const cambiaHorario = datos.fecha !== reserva.fecha || ini !== String(reserva.hora_inicio).substring(0, 5) || fin !== String(reserva.hora_fin).substring(0, 5);
    if (cambiaHorario) {
      const aMin = h => { const [x, y] = String(h).split(':').map(Number); return x * 60 + y; };
      const seSuperpone = o => aMin(ini) < aMin(o.hora_fin) && aMin(fin) > aMin(o.hora_inicio);
      const [{ data: bloqueos, error: errorBloqueos }, { data: otras, error: errorOtras }] = await Promise.all([
        supabase.from('bloqueos').select('hora_inicio, hora_fin').eq('espacio_id', espacioId).eq('fecha', datos.fecha),
        supabase.from('reservas').select('id, hora_inicio, hora_fin').eq('espacio_id', espacioId).eq('fecha', datos.fecha).eq('estado', 'activa').neq('id', reserva.id)
      ]);
      if (errorBloqueos) throw errorBloqueos;
      if (errorOtras) throw errorOtras;
      if ((bloqueos || []).some(seSuperpone)) return res.status(409).json({ error: 'Ese horario está bloqueado' });
      // La base también lo impide (restricción no_solapamiento_activo); esto da un mensaje claro antes
      if ((otras || []).some(seSuperpone)) return res.status(409).json({ error: 'Ese horario ya está ocupado por otra reserva' });
    }
    const cambios = [];
    if (datos.nombre_solicitante !== reserva.nombre_solicitante) cambios.push('nombre');
    if (datos.contacto !== reserva.contacto) cambios.push('contacto');
    if (cambiaHorario) cambios.push('día u horario');
    if (!cambios.length) return res.json({ mensaje: 'No había cambios' });

    // AUD-09: si cambia el correo o el celular, el código anterior (y el enlace firmado con él) deja
    // de servir: se genera uno nuevo y va en el aviso al contacto nuevo. Si no, quien tenía el
    // correo equivocado seguía pudiendo cancelar la reserva.
    const cambiaContacto = datos.contacto !== reserva.contacto;
    const codigoNuevo = cambiaContacto ? crypto.randomBytes(8).toString('hex').toUpperCase() : null;
    const { data: actualizada, error } = await supabase.from('reservas')
      .update({ nombre_solicitante: datos.nombre_solicitante, contacto: datos.contacto, fecha: datos.fecha, hora_inicio: ini + ':00', hora_fin: fin + ':00',
        ...(codigoNuevo ? { codigo_cancelacion_hash: hashCodigo(codigoNuevo) } : {}) })
      .eq('id', reserva.id).eq('estado', 'activa').select();
    if (error) {
      if (error.code === '23P01' || error.code === '23505') return res.status(409).json({ error: 'Ese horario ya está ocupado por otra reserva' });
      if (error.code === 'CEQ01') return res.status(409).json({ error: 'Ese horario está bloqueado' });
      throw error;
    }
    if (!actualizada || !actualizada.length) return res.status(409).json({ error: 'La reserva cambió mientras la editabas (por ejemplo, se canceló). Volvé a cargarla.' });

    // Aviso a la persona (al correo nuevo, si se cambió), salvo que se pida no avisar. Con un código
    // nuevo se avisa siempre: es la única forma de que la persona lo tenga.
    let avisado = false;
    const email = correoDeContacto(datos.contacto);
    if ((b.avisar !== false || codigoNuevo) && email) {
      const correo = correoDeReserva('modificada', actualizada[0], { cambios: cambios.join(', '), codigo: codigoNuevo });
      avisado = await encolarCorreo({
        to: email,
        subject: correo.asunto,
        responderA: correoRespuesta(espacioId),
        html: correo.html
      });
    }
    // Sin datos personales en el registro: qué se cambió y nada más
    registrarActividad(req.admin.rol, 'Modificó una reserva', `#${reserva.id} · ${cambios.join(', ')}${cambiaHorario ? ` · ${fechaDMY(datos.fecha)} ${ini}-${fin}` : ''}`);
    res.json({ mensaje: `Reserva actualizada${avisado ? ' y se le avisó por correo' : ''}`, reserva: actualizada[0] });
  } catch (error) {
    manejarError(res, error);
  }
});

// Historial de una reserva: lo guardado en la reserva, el registro de actividad que la menciona
// (#número) y los correos sobre ella que siguen en la cola (se borran a los 7 días).
app.get('/api/superadmin/reservas/:id/historial', verifyAdminToken, verifySuperAdmin, async (req, res) => {
  try {
    if (!esIdValido(req.params.id)) return res.status(400).json({ error: 'ID inválido' });
    const reserva = await reservaPorId(req.params.id);
    if (!reserva) return res.status(404).json({ error: 'La reserva no existe' });
    const id = Number(reserva.id);
    const menciona = t => new RegExp(`#${id}(?!\\d)`).test(String(t || ''));
    const eventos = [];
    eventos.push({ cuando: aIsoUtc(reserva.created_at), que: reserva.reservado_por_admin ? 'Reserva de prioridad hecha desde el panel' : 'Reserva hecha desde la página' });
    if (reserva.recordatorio_enviado_en) eventos.push({ cuando: aIsoUtc(reserva.recordatorio_enviado_en), que: 'Se mandó el recordatorio' });
    // AUD-08: el panel guarda 'moderador' o 'admin supremo' (antes se comparaba con 'admin', y toda
    // cancelación del panel figuraba como hecha por la persona); 'admin' queda por las más viejas
    const quienCancelo = { moderador: 'un moderador', admin: 'un moderador', 'admin supremo': 'el admin supremo' }[reserva.cancelada_por] || 'la persona';
    if (reserva.cancelada_en) eventos.push({ cuando: aIsoUtc(reserva.cancelada_en), que: `Cancelada por ${quienCancelo}${reserva.motivo_cancelacion ? ` (motivo: ${reserva.motivo_cancelacion})` : ''}` });

    const { data: actividad, error: errorActividad } = await supabase.from('registro_actividad')
      .select('creado_en, rol, accion, detalle').order('id', { ascending: false }).limit(2000);
    if (errorActividad) throw errorActividad;
    (actividad || []).filter(a => menciona(a.detalle)).forEach(a => {
      eventos.push({ cuando: aIsoUtc(a.creado_en), que: `${a.accion}${a.detalle ? ` (${a.detalle})` : ''}`, quien: NOMBRES_ROL[a.rol] || a.rol });
    });
    try {
      const correos = await leerTodasLasFilas(() => supabase.from('correos_pendientes')
        .select('id, asunto, estado, creado_en, enviado_en').order('id', { ascending: true }), 5000);
      correos.filter(c => menciona(c.asunto)).forEach(c => {
        const estado = c.estado === 'enviado' ? 'enviado' : c.estado === 'fallido' ? 'NO SALIÓ' : 'en la cola';
        eventos.push({ cuando: aIsoUtc(c.enviado_en || c.creado_en), que: `Correo "${c.asunto}" (${estado})` });
      });
    } catch (err) {
      eventos.push({ cuando: null, que: 'No se pudo revisar la cola de correos' });
    }
    eventos.sort((a, b) => String(a.cuando || '').localeCompare(String(b.cuando || '')));
    res.set('Cache-Control', 'no-store');
    res.json({
      reserva: {
        id, espacio: getEspacioNombre(reserva.espacio_id), fecha: reserva.fecha,
        horario: descripcionHorario(reserva.espacio_id, String(reserva.hora_inicio).substring(0, 5), String(reserva.hora_fin).substring(0, 5)),
        nombre: reserva.nombre_solicitante, contacto: reserva.contacto, estado: reserva.estado, asistencia: reserva.asistencia || null
      },
      eventos
    });
  } catch (error) {
    manejarError(res, error);
  }
});

// Pausar las reservas: la página muestra el mensaje y no deja reservar ni anotarse en la lista de
// espera. Se puede cancelar igual, y el panel sigue pudiendo hacer reservas de prioridad.
app.post('/api/superadmin/pausa', verifyAdminToken, verifySuperAdmin, verificarCSRF, async (req, res) => {
  try {
    let pausa;
    try {
      pausa = VALIDADORES_CONFIG.pausa_reservas(req.body || {});
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const { error } = await supabase.from('configuracion')
      .upsert({ clave: 'pausa_reservas', valor: comoTexto('pausa_reservas', pausa) }, { onConflict: 'clave' });
    if (error) throw error;
    await cargarConfiguracion();
    registrarActividad(req.admin.rol, pausa.activa ? 'Pausó las reservas' : 'Reanudó las reservas', pausa.activa ? pausa.mensaje : '');
    res.json({ mensaje: pausa.activa ? 'Reservas pausadas' : 'Reservas reanudadas', pausa_reservas: config.pausa_reservas });
  } catch (error) {
    manejarError(res, error);
  }
});

// Contraseña del panel de los admins (no la del admin supremo). Se guarda cifrada (bcrypt) en la
// tabla configuracion y reemplaza a la de Render (ADMIN_PASSWORD_HASH), que queda solo como la
// inicial. Al cambiarla se cierran todas las sesiones, incluida la propia.
app.post('/api/superadmin/clave-admin', verifyAdminToken, verifySuperAdmin, verificarCSRF, async (req, res) => {
  try {
    const { nueva, confirmar } = req.body || {};
    if (typeof nueva !== 'string' || nueva.length < 10 || nueva.length > 200) {
      return res.status(400).json({ error: 'La contraseña tiene que tener entre 10 y 200 caracteres' });
    }
    if (nueva !== confirmar) return res.status(400).json({ error: 'Las dos contraseñas no coinciden' });
    if (SUPERADMIN_PASSWORD_HASH && await bcrypt.compare(nueva, SUPERADMIN_PASSWORD_HASH)) {
      return res.status(400).json({ error: 'No puede ser igual a la del admin supremo' });
    }
    const hash = await bcrypt.hash(nueva, 12);
    const nuevaVersion = (await obtenerVersionSesiones()) + 1;
    const { error } = await supabase.from('configuracion').upsert([
      { clave: 'admin_password_hash', valor: hash },
      { clave: 'version_sesiones', valor: String(nuevaVersion) }
    ], { onConflict: 'clave' });
    if (error) throw error;
    versionSesiones = nuevaVersion;
    registrarActividad(req.admin.rol, 'Cambió la contraseña del panel de los admins', 'se cerraron todas las sesiones');
    borrarCookiesSesion(res);
    res.json({ mensaje: 'Contraseña cambiada. Se cerraron todas las sesiones: volvé a entrar con la tuya.' });
  } catch (error) {
    manejarError(res, error);
  }
});

// Estado del sistema: lo que hay que mirar para saber si todo anda bien
app.get('/api/superadmin/estado', verifyAdminToken, verifySuperAdmin, async (req, res) => {
  try {
    const hoy = hoyEnAsuncion().toISOString().slice(0, 10);
    // Medianoche de Paraguay en UTC (UTC-3)
    const desde = new Date(hoy + 'T03:00:00Z').toISOString();
    let correos = null;
    try {
      const filas = await leerTodasLasFilas(() => supabase.from('correos_pendientes')
        .select('id, estado, creado_en').order('id', { ascending: true }), 5000);
      correos = {
        hoy: filas.filter(f => f.creado_en >= desde).length,
        enviados_hoy: filas.filter(f => f.creado_en >= desde && f.estado === 'enviado').length,
        pendientes: filas.filter(f => f.estado === 'pendiente' || f.estado === 'enviando').length,
        fallidos: filas.filter(f => f.estado === 'fallido').length
      };
    } catch (err) { /* sin cola: se informa null */ }
    const { data: claves, error } = await supabase.from('configuracion').select('clave, valor')
      .in('clave', ['copia_mensual_enviada', 'ultima_sincronizacion']);
    if (error) throw error;
    const valor = c => ((claves || []).find(x => x.clave === c) || {}).valor || null;
    const [enEspera, reportesNuevos] = await Promise.all([
      leerTodasLasFilas(() => supabase.from('lista_espera').select('id').is('avisado_en', null).order('id', { ascending: true }), 20000),
      leerTodasLasFilas(() => supabase.from('reportes_errores').select('id').eq('estado', 'nuevo').order('id', { ascending: true }), 20000)
    ]).then(r => r.map(filas => filas.length));
    res.set('Cache-Control', 'no-store');
    res.json({
      // Si llegó hasta acá, las consultas de arriba respondieron: la base anda (si no, da error 500)
      base: 'ok',
      servidor_desde: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      version: String(process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null,
      correos, limite_correos_dia: 300,
      copia_mensual: valor('copia_mensual_enviada'),
      ultima_sincronizacion: valor('ultima_sincronizacion'),
      ultima_revision_plazos: ultimaRevisionConservacion || null,
      lista_espera_pendientes: enEspera,
      reportes_nuevos: reportesNuevos,
      pausa_reservas: config.pausa_reservas
    });
  } catch (error) {
    manejarError(res, error);
  }
});

// Copia de seguridad en el momento: los mismos archivos que la copia mensual, para bajarlos ya.
// ?formato=json: la copia completa (para restaurar.js); si no, el CSV de las reservas.
app.get('/api/superadmin/copia', verifyAdminToken, verifySuperAdmin, async (req, res) => {
  try {
    if (req.query.formato === 'json') {
      const copia = await armarCopiaCompleta();
      registrarActividad(req.admin.rol, 'Descargó una copia de seguridad completa', `${copia.tablas.reservas.length} reservas`);
      res.set('Cache-Control', 'no-store');
      res.set('Content-Type', 'application/json; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="reservas-ceq-${hoyEnAsuncion().toISOString().slice(0, 10)}-completa.json"`);
      return res.send(JSON.stringify(copia));
    }
    const { csv, total } = await armarCsvReservas();
    registrarActividad(req.admin.rol, 'Descargó una copia de seguridad', `${total} reservas`);
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="reservas-ceq-${hoyEnAsuncion().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (error) {
    manejarError(res, error);
  }
});

// ===== LISTA DE ESPERA (ver y sacar a alguien) =====
app.get('/api/superadmin/lista-espera', verifyAdminToken, verifySuperAdmin, async (req, res) => {
  try {
    // De a páginas (CEQ-08): Supabase entrega como máximo 1000 filas por pedido
    res.json(await leerTodasLasFilas(() => supabase.from('lista_espera')
      .select('id, espacio_id, email, nombre, mes, creado_en, avisado_en')
      .order('creado_en', { ascending: true }).order('id', { ascending: true })));
  } catch (error) {
    manejarError(res, error);
  }
});

app.delete('/api/superadmin/lista-espera/:id', verifyAdminToken, verifySuperAdmin, verificarCSRF, async (req, res) => {
  try {
    const { id } = req.params;
    if (!esIdValido(id)) return res.status(400).json({ error: 'ID inválido' });
    const { data, error } = await supabase.from('lista_espera').delete().eq('id', id).select('espacio_id');
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: 'No está en la lista' });
    registrarActividad(req.admin.rol, 'Sacó a alguien de la lista de espera', getEspacioNombre(data[0].espacio_id));
    res.json({ mensaje: 'Listo: ya no está en la lista de espera' });
  } catch (error) {
    manejarError(res, error);
  }
});

// Cerrar todas las sesiones del panel (incluida la propia): sirve si la contraseña se
// filtró o alguien dejó la sesión abierta en una computadora ajena. Conviene cambiar
// también la contraseña en Render si se sospecha que alguien la conoce.
app.post('/api/superadmin/cerrar-sesiones', verifyAdminToken, verifySuperAdmin, verificarCSRF, async (req, res) => {
  try {
    const nueva = (await obtenerVersionSesiones()) + 1;
    const { error } = await supabase
      .from('configuracion')
      .upsert({ clave: 'version_sesiones', valor: String(nueva) }, { onConflict: 'clave' });

    if (error) throw error;
    versionSesiones = nueva;
    registrarActividad(req.admin.rol, 'Cerró todas las sesiones del panel');

    borrarCookiesSesion(res);
    res.json({ mensaje: 'Se cerraron todas las sesiones' });
  } catch (error) {
    manejarError(res, error);
  }
});

// ========== SINCRONIZACIÓN CON GOOGLE SHEETS ==========
// La planilla de la Secretaría (cuenta ceq.informatica) pide acá todas las reservas una vez
// por hora, con un script de Google (Apps Script). Es de solo lectura y trae datos personales,
// por eso exige la clave CLAVE_SINCRONIZACION en el header X-Clave-Sincronizacion (nunca en
// la dirección, para que no quede en ningún registro). Se compara en tiempo constante.
function claveSincronizacionValida(recibida) {
  if (!SINCRONIZACION_ACTIVA || typeof recibida !== 'string' || recibida.length === 0) return false;
  const a = crypto.createHash('sha256').update(recibida).digest();
  const b = crypto.createHash('sha256').update(CLAVE_SINCRONIZACION).digest();
  return crypto.timingSafeEqual(a, b);
}

// Código anónimo de la persona que reservó (mismo correo, o mismo celular si no hay correo = mismo
// código). Es un HMAC con una clave derivada de JWT_SECRET: sin esa clave no se puede saber de quién es.
const CLAVE_CODIGO_PERSONA = crypto.createHmac('sha256', JWT_SECRET).update('codigo-persona-planilla-v1').digest();
function codigoPersona(contacto) {
  const [celular = '', email = ''] = String(contacto || '').split('|').map(p => p.trim());
  const identidad = email.toLowerCase() || celular.replace(/\D/g, '');
  if (!identidad) return '';
  return crypto.createHmac('sha256', CLAVE_CODIGO_PERSONA).update(identidad).digest('base64url').slice(0, 12);
}

app.get('/api/sincronizacion/reservas', sincronizacionLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!SINCRONIZACION_ACTIVA) {
    return res.status(503).json({ error: 'La sincronización no está configurada en el servidor' });
  }
  if (!claveSincronizacionValida(req.headers['x-clave-sincronizacion'])) {
    console.warn(`⚠️ Sincronización rechazada (clave inválida) desde ${obtenerIpCliente(req)}`);
    return res.status(401).json({ error: 'Clave de sincronización inválida' });
  }

  try {
    supabase.from('configuracion').upsert({ clave: 'ultima_sincronizacion', valor: new Date().toISOString() }, { onConflict: 'clave' })
      .then(({ error }) => { if (error) console.error('⚠️ No se pudo anotar la sincronización:', error.message); });
    const filas = await leerTodasLasFilas(() => supabase
      .from('reservas')
      .select('id, espacio_id, fecha, hora_inicio, hora_fin, nombre_solicitante, contacto, motivo, estado, created_at, asistencia, acompanantes')
      .order('fecha', { ascending: true })
      .order('hora_inicio', { ascending: true })
      .order('id', { ascending: true }));

    // A la planilla NO van celulares, correos, prioridad ni datos de cancelación. Para contar
    // personas distintas se manda un código anónimo por persona (no se puede volver al correo
    // ni al celular). Los acompañantes van solo con el nombre.
    const reservas = filas.map(r => {
      const inicio = String(r.hora_inicio || '').substring(0, 5);
      const fin = String(r.hora_fin || '').substring(0, 5);
      return {
        id: r.id,
        espacio: getEspacioNombre(r.espacio_id),
        fecha: r.fecha,
        hora_inicio: inicio,
        hora_fin: fin,
        turno: Number(r.espacio_id) === 3 ? nombreTurnoFrente(inicio, fin) : '',
        nombre: r.nombre_solicitante || '',
        motivo: (r.motivo || '').trim(),
        acompanantes: (Array.isArray(r.acompanantes) ? r.acompanantes : []).map(a => a && a.nombre).filter(Boolean).join(', '),
        estado: r.estado,
        asistencia: r.asistencia || '',
        creada_en: aIsoUtc(r.created_at),
        persona: codigoPersona(r.contacto)
      };
    });

    res.json({ generado_en: new Date().toISOString(), total: reservas.length, reservas });
  } catch (error) {
    manejarError(res, error);
  }
});

// GET estadísticas
app.get('/api/estadisticas', lecturaPublicaLimiter, async (req, res) => {
  try {
    const { count: activas, error: errorActivas } = await supabase
      .from('reservas')
      .select('id', { count: 'exact', head: true })
      .eq('estado', 'activa');

    if (errorActivas) throw errorActivas;

    const { count: canceladas, error: errorCanceladas } = await supabase
      .from('reservas')
      .select('id', { count: 'exact', head: true })
      .eq('estado', 'cancelada');

    if (errorCanceladas) throw errorCanceladas;
    
    res.json({
      reservas_activas: activas || 0,
      reservas_canceladas: canceladas || 0
    });
  } catch (error) {
    manejarError(res, error);
  }
});

// ========== TAREAS PERIÓDICAS (cada 5 minutos) ==========
// Render no tiene tareas programadas en el plan gratuito, pero el servidor nunca se duerme
// (UptimeRobot lo consulta cada 5 minutos), así que alcanza con un temporizador. Todo lo que
// hacen estas tareas queda guardado en la base, así que si el servidor se reinicia no se
// repite ni se pierde nada (salvo las alertas pendientes, que viven en memoria).
const INTERVALO_TAREAS_MS = Number(process.env.INTERVALO_TAREAS_MS) || 5 * 60 * 1000;

// Marca como habilitados los meses cuya apertura programada ya llegó. Para la página ya
// estaban abiertos desde el segundo exacto (mesEstaAbierto); esto deja la base prolija.
async function abrirMesesProgramados() {
  const ahora = new Date().toISOString();
  const { data, error } = await supabase
    .from('meses_habilitados')
    .update({ habilitado: true, abrir_en: null, updated_at: ahora })
    .eq('habilitado', false)
    .lte('abrir_en', ahora)
    .select('anio, mes');
  if (error) throw error;
  (data || []).forEach(m => registrarActividad('sistema', 'Se abrió un mes programado', `${String(m.mes).padStart(2, '0')}/${m.anio}`));
}

// Recordatorio N días antes de la reserva (admin supremo > Reglas; por defecto 2, se puede
// apagar por espacio), entre las 08:00 y las 21:00 de ese día. En el Frente, con los valores de
// siempre, es el último día en que se puede cancelar gratis, así que el correo trae el botón para
// cancelar. No se manda a las reservas de prioridad ni a las hechas en las últimas 12 horas
// (esas personas acaban de recibir la confirmación).
// Asunto, título y mensaje: plantilla "Recordatorio" (admin supremo > Correos).
const MAX_RECORDATORIOS_POR_TANDA = 40;

async function enviarRecordatorios() {
  const minutos = horaActualEnAsuncionEnMinutos();
  if (minutos < 8 * 60 || minutos >= 21 * 60) return;
  const hace12Horas = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  // Cada espacio con su propio día (si tiene el recordatorio prendido)
  const data = [];
  for (const id of [3, 1]) {
    const regla = reglaEspacio(id);
    if (!regla.recordatorio) continue;
    const objetivo = hoyEnAsuncion();
    objetivo.setUTCDate(objetivo.getUTCDate() + regla.recordatorio_dias);
    const { data: filas, error } = await supabase
      .from('reservas')
      // codigo_cancelacion_hash: firma el enlace "Cancelar mi reserva" (AUD-09)
      .select('id, espacio_id, fecha, hora_inicio, hora_fin, nombre_solicitante, contacto, codigo_cancelacion_hash, created_at')
      .eq('estado', 'activa')
      .eq('espacio_id', id)
      .eq('fecha', objetivo.toISOString().slice(0, 10))
      .eq('reservado_por_admin', false)
      .is('recordatorio_enviado_en', null)
      .lt('created_at', hace12Horas)
      .limit(MAX_RECORDATORIOS_POR_TANDA);
    if (error) throw error;
    data.push(...(filas || []));
  }

  // Primero se guarda el correo en la cola y DESPUÉS se marca la reserva (CEQ-06). Antes era al
  // revés: si el servidor se reiniciaba entre los dos pasos, la reserva quedaba marcada y el
  // recordatorio no salía nunca. Ahora, en ese caso, la próxima vuelta lo encuentra sin marcar y,
  // como el asunto lleva el número de la reserva, ve que ya está en la cola y solo la marca (no
  // se manda dos veces).
  for (const r of data || []) {
    const email = String(r.contacto || '').split('|')[1]?.trim();
    const marcar = () => supabase.from('reservas')
      .update({ recordatorio_enviado_en: new Date().toISOString() })
      .eq('id', r.id).is('recordatorio_enviado_en', null);
    if (!email) {
      const { error: errorMarcar } = await marcar();
      if (errorMarcar) throw errorMarcar;
      continue;
    }
    const correo = correoDeReserva('recordatorio', r);
    const asunto = correo.asunto;
    const { data: yaEnCola, error: errorCola } = await supabase.from('correos_pendientes')
      .select('id').eq('asunto', asunto).limit(1);
    const encolado = !errorCola && yaEnCola && yaEnCola.length > 0;

    const enviado = encolado || await encolarCorreo({
      to: email,
      subject: asunto,
      responderA: correoRespuesta(r.espacio_id),
      html: correo.html
    });
    // Si no se pudo guardar en la cola ni mandar directo, queda sin marcar para la próxima vuelta
    if (!enviado) continue;
    const { error: errorMarcar } = await marcar();
    if (errorMarcar) throw errorMarcar;
  }
}

// Lista de espera: se borran las inscripciones ya avisadas hace más de 7 días y las que siguen
// sin avisar después de DIAS_VIGENCIA_LISTA_ESPERA días
async function limpiarListaEspera() {
  const haceDias = d => new Date(Date.now() - d * 86400000).toISOString();
  const { error } = await supabase.from('lista_espera').delete().lt('avisado_en', haceDias(7));
  if (error) throw error;
  const { error: error2 } = await supabase.from('lista_espera').delete()
    .is('avisado_en', null).lt('creado_en', haceDias(DIAS_VIGENCIA_LISTA_ESPERA));
  if (error2) throw error2;
}

// ========== PLAZOS DE CONSERVACIÓN (Política de Privacidad, artículo 10) ==========
// Plazo: 6 meses (un semestre).
// - Reservas de hace más de 6 meses (por su fecha): se borran el nombre, el contacto, los
//   acompañantes y el motivo de cancelación, y el motivo del Altillo (texto libre). Queda solo lo
//   estadístico (espacio, fecha, horario, estado, motivo del Frente, que es de una lista fija).
// - Reportes de problemas de hace más de 6 meses: se borran.
// Se revisa una vez por día. Si se cambia este plazo, cambiar también privacidad.html.
const MESES_CONSERVACION = 6;
const NOMBRE_ANONIMIZADO = '(datos eliminados)';
let ultimaRevisionConservacion = '';

async function aplicarPlazosDeConservacion() {
  const hoy = hoyEnAsuncion().toISOString().slice(0, 10);
  if (ultimaRevisionConservacion === hoy) return;
  const limite = hoyEnAsuncion();
  limite.setUTCMonth(limite.getUTCMonth() - MESES_CONSERVACION);
  const fechaLimite = limite.toISOString().slice(0, 10);
  const datosBorrados = { nombre_solicitante: NOMBRE_ANONIMIZADO, contacto: '-', acompanantes: [], motivo_cancelacion: null };

  const { data: frente, error: e1 } = await supabase.from('reservas').update(datosBorrados)
    .lt('fecha', fechaLimite).neq('nombre_solicitante', NOMBRE_ANONIMIZADO).neq('espacio_id', 1).select('id');
  if (e1) throw e1;
  const { data: altillo, error: e2 } = await supabase.from('reservas').update({ ...datosBorrados, motivo: '' })
    .lt('fecha', fechaLimite).neq('nombre_solicitante', NOMBRE_ANONIMIZADO).eq('espacio_id', 1).select('id');
  if (e2) throw e2;
  // En el Frente el motivo se conserva solo si es uno de la lista (es una categoría, no un dato
  // personal). Las reservas de prioridad del panel pueden tener motivo libre: ese se borra.
  const { error: e4 } = await supabase.from('reservas').update({ motivo: '' })
    .lt('fecha', fechaLimite).eq('espacio_id', 3).neq('motivo', '')
    .not('motivo', 'in', `(${config.motivos_frente.map(m => `"${m}"`).join(',')})`);
  if (e4) throw e4;
  const { data: reportes, error: e3 } = await supabase.from('reportes_errores').delete().lt('created_at', fechaLimite + 'T00:00:00').select('id');
  if (e3) throw e3;

  const anonimizadas = (frente || []).length + (altillo || []).length;
  if (anonimizadas || (reportes || []).length) {
    console.log(`🧹 Plazos de conservación: ${anonimizadas} reserva(s) anonimizada(s), ${(reportes || []).length} reporte(s) borrado(s)`);
    registrarActividad('sistema', 'Aplicó los plazos de conservación', `${anonimizadas} reserva(s) anonimizada(s) · ${(reportes || []).length} reporte(s) borrado(s)`);
  }
  ultimaRevisionConservacion = hoy;
}

// ========== COPIA DE SEGURIDAD MENSUAL POR CORREO ==========
// Supabase gratis no guarda copias que se puedan descargar, y la planilla de Google ya no tiene
// los contactos. Por eso, una vez por mes (la primera vuelta después de las 08:00 de cada mes
// nuevo), se manda al "correo de alertas" un archivo con TODAS las reservas y todos sus datos,
// para guardarlo en Drive. El mes ya enviado se anota en la tabla configuracion
// (clave copia_mensual_enviada), así no se repite aunque el servidor se reinicie.
const CLAVE_COPIA_MENSUAL = 'copia_mensual_enviada';

// Celda para CSV abierto con Excel: entre comillas, y si empieza con = + - @ se le antepone una
// comilla simple para que Excel no lo tome como fórmula
function celdaCsv(valor) {
  let texto = String(valor == null ? '' : valor).replace(/\r?\n/g, ' ');
  if (/^[=+\-@\t]/.test(texto)) texto = "'" + texto;
  return `"${texto.replace(/"/g, '""')}"`;
}

async function armarCsvReservas() {
  const filas = await leerTodasLasFilas(() => supabase
    .from('reservas')
    .select('id, espacio_id, fecha, hora_inicio, hora_fin, nombre_solicitante, contacto, motivo, acompanantes, estado, reservado_por_admin, asistencia, created_at, cancelada_en, cancelada_por, motivo_cancelacion')
    .order('fecha', { ascending: true })
    .order('hora_inicio', { ascending: true })
    .order('id', { ascending: true }));
  const fechaHora = valor => valor ? fechaHoraAsuncionTexto(new Date(aIsoUtc(valor))) : '';
  const encabezado = ['N°', 'Fecha', 'Espacio', 'Turno', 'Inicio', 'Fin', 'Nombre', 'Celular', 'Email', 'Motivo',
    'Acompañantes', 'Estado', 'Prioridad', 'Asistencia', 'Creada', 'Cancelada', 'Cancelada por', 'Motivo de cancelación'];
  const lineas = [encabezado.map(celdaCsv).join(';')];
  for (const r of filas) {
    const [celular = '', email = ''] = String(r.contacto || '').split('|').map(p => p.trim());
    const inicio = String(r.hora_inicio || '').substring(0, 5);
    const fin = String(r.hora_fin || '').substring(0, 5);
    lineas.push([
      r.id, r.fecha, getEspacioNombre(r.espacio_id),
      Number(r.espacio_id) === 3 ? nombreTurnoFrente(inicio, fin) : '',
      inicio, fin, r.nombre_solicitante, celular, email, (r.motivo || '').trim(),
      acompanantesTexto(r.acompanantes),
      r.estado === 'cancelada' ? 'Cancelada' : 'Activa',
      r.reservado_por_admin ? 'Sí' : 'No',
      r.asistencia === 'vino' ? 'Vino' : r.asistencia === 'no_vino' ? 'No vino' : '',
      fechaHora(r.created_at), fechaHora(r.cancelada_en), r.cancelada_por || '', r.motivo_cancelacion || ''
    ].map(celdaCsv).join(';'));
  }
  // BOM: para que Excel muestre bien las tildes; ";" es el separador que usa Excel en español
  return { csv: '﻿' + lineas.join('\r\n') + '\r\n', total: filas.length };
}

// AUD-06: copia COMPLETA de la base, para volver a cargarla en una base nueva con restaurar.js
// (ver README, "Restaurar la base"). Además de las reservas (con su código cifrado, así los
// códigos y los enlaces siguen sirviendo) lleva los bloqueos, los meses, la lista de espera, la
// configuración (reglas, textos, correos, Términos y su historial), los reportes y el registro.
// No lleva la contraseña de los admins ni la cola de correos.
const TABLAS_COPIA = [
  ['espacios', 'id'], ['meses_habilitados', 'id'], ['configuracion', 'clave'], ['reservas', 'id'],
  ['bloqueos', 'id'], ['lista_espera', 'id'], ['reportes_errores', 'id'], ['registro_actividad', 'id']
];
const CLAVES_FUERA_DE_LA_COPIA = ['admin_password_hash'];

async function armarCopiaCompleta() {
  const tablas = {};
  for (const [tabla, orden] of TABLAS_COPIA) {
    const filas = await leerTodasLasFilas(() => supabase.from(tabla).select('*').order(orden, { ascending: true }), 200000);
    tablas[tabla] = tabla === 'configuracion' ? filas.filter(f => !CLAVES_FUERA_DE_LA_COPIA.includes(f.clave)) : filas;
  }
  return { formato: 'copia-ceq-reservas', version: 1, creada_en: new Date().toISOString(), tablas };
}

async function enviarCopiaMensual() {
  if (horaActualEnAsuncionEnMinutos() < 8 * 60) return;
  const mes = hoyEnAsuncion().toISOString().slice(0, 7); // "2026-11"
  const { data, error } = await supabase
    .from('configuracion').select('valor').eq('clave', CLAVE_COPIA_MENSUAL).maybeSingle();
  if (error) throw error;
  const anterior = data ? data.valor : null;
  if (anterior === mes) return;

  // Antes de mandar se anota "mes|enviando|hora" (CEQ-06): mientras tanto no se manda otra vez.
  // Cuando sale, queda "mes". Si el envío falla, se vuelve atrás y se reintenta en la próxima
  // vuelta. Si el servidor se reinicia en el medio, la marca "enviando" queda colgada: pasados
  // 30 minutos se toma como no enviada y se reintenta (antes el mes se daba por enviado y la
  // copia no llegaba nunca).
  const enviando = String(anterior || '').match(/^(\d{4}-\d{2})\|enviando\|(.+)$/);
  if (enviando && enviando[1] === mes && Date.now() - Date.parse(enviando[2]) < 30 * 60 * 1000) return;
  const hecho = enviando ? '' : (anterior || '');
  const marcar = valor => supabase.from('configuracion').upsert({ clave: CLAVE_COPIA_MENSUAL, valor }, { onConflict: 'clave' });
  const { error: errorMarcar } = await marcar(`${mes}|enviando|${new Date().toISOString()}`);
  if (errorMarcar) throw errorMarcar;

  let enviado = false;
  try {
    const { csv, total } = await armarCsvReservas();
    // La copia completa va comprimida (el texto de la base ocupa mucho y se achica unas diez veces)
    const completa = zlib.gzipSync(Buffer.from(JSON.stringify(await armarCopiaCompleta()), 'utf8'));
    const [anio, numeroMes] = mes.split('-');
    const nombreMes = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'][Number(numeroMes) - 1];
    enviado = await enviarEmail({
      to: config.email_alertas,
      subject: `Copia de seguridad de las reservas: ${nombreMes} ${anio} (${total} reservas)`,
      html: `
        <p>Hola,</p>
        <p>Te mandamos la copia de seguridad mensual del sistema de reservas. Trae dos archivos:</p>
        <ul>
          <li><strong>reservas-ceq-${mes}.csv</strong>: las <strong>${total} reservas</strong> guardadas hasta hoy, con todos sus datos (también celulares, correos y cancelaciones). Se abre con Excel o con Google Sheets.</li>
          <li><strong>reservas-ceq-${mes}-completa.json.gz</strong>: la base entera (reservas, bloqueos, meses, lista de espera, reglas, textos, correos y Términos). No hace falta abrirlo: sirve para volver a cargar todo en una base nueva con restaurar.js (ver el README del servidor, "Restaurar la base").</li>
        </ul>
        <p><strong>Qué hacer:</strong> nada. La copia queda guardada en este correo.</p>
        <p>La base de datos gratuita no guarda copias que se puedan descargar: si algún día se perdiera, estas copias son la forma de recuperarla.</p>
        <p>Los archivos tienen datos personales: no los reenvíes, no los guardes en otro lado y no los compartas fuera de quienes administran el sistema. El script "Limpiar copias de seguridad" de esta cuenta guarda solo las 2 copias más nuevas y manda las demás a la papelera.</p>
        <p>Sistema de Reservas del CEQ</p>
      `,
      adjuntos: [
        { name: `reservas-ceq-${mes}.csv`, content: Buffer.from(csv, 'utf8').toString('base64') },
        { name: `reservas-ceq-${mes}-completa.json.gz`, content: completa.toString('base64') }
      ]
    });
  } finally {
    const { error: errorFinal } = await marcar(enviado ? mes : hecho);
    if (errorFinal) console.error('⚠️ No se pudo anotar la copia mensual:', errorFinal.message || errorFinal.code);
  }
}

// Correo de alerta (admin supremo > Configuración > correo de alertas) si hubo errores del
// servidor o bloqueos 429. Como máximo uno por hora, y solo si pasó algo.
const INTERVALO_ALERTAS_MS = 60 * 60 * 1000;
let ultimaAlertaEnviada = 0;

async function enviarAlertas() {
  const { errores, bloqueos429 } = alertasPendientes;
  if (errores.length === 0 && bloqueos429.length === 0) return;
  if (Date.now() - ultimaAlertaEnviada < INTERVALO_ALERTAS_MS) return;

  const listaErrores = errores.splice(0);
  const lista429 = bloqueos429.splice(0);
  const porIp = {};
  lista429.forEach(b => { const ip = b.detalle.split('|')[0]; porIp[ip] = (porIp[ip] || 0) + 1; });
  const ips = Object.entries(porIp).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const item = texto => `<li>${escapeHtml(texto)}</li>`;

  const enviado = await enviarEmail({
    to: config.email_alertas,
    subject: `⚠️ Alerta del sistema de reservas: ${listaErrores.length} error(es), ${lista429.length} bloqueo(s) 429`,
    html: `
      <h2>Alerta del sistema de reservas</h2>
      <p>Desde el último aviso hubo:</p>
      <ul>
        <li><strong>${listaErrores.length}</strong> error(es) del servidor</li>
        <li><strong>${lista429.length}</strong> bloqueo(s) por exceso de pedidos (429)</li>
      </ul>
      ${listaErrores.length ? `<h3>Errores (los últimos 10)</h3><ul>${listaErrores.slice(-10).map(e => item(`${fechaHoraAsuncionTexto(e.momento)} · ${e.detalle}`)).join('')}</ul>` : ''}
      ${lista429.length ? `<h3>Bloqueos 429 por IP</h3><ul>${ips.map(([ip, n]) => item(`${ip}: ${n} vez/veces`)).join('')}</ul>
        <p>Si son muchas IP distintas a la misma hora (por ejemplo, al abrir un mes), es mucha gente a la vez. Si las IP empiezan con 10., hay que revisar obtenerIpCliente() en server.js.</p>` : ''}
      <p>Más detalle en Render → servicio ceq-reservas → Logs. Este correo sale como máximo una vez por hora.</p>
    `
  });
  if (enviado) {
    ultimaAlertaEnviada = Date.now();
  } else {
    // Si el correo falló, se devuelven a la lista para el próximo intento
    alertasPendientes.errores.unshift(...listaErrores.slice(-100));
    alertasPendientes.bloqueos429.unshift(...lista429.slice(-100));
  }
}

// Si una vuelta todavía no terminó (por ejemplo, Brevo o la base tardan), la siguiente no arranca:
// así dos vueltas nunca mandan el mismo correo a la vez
let tareasEnCurso = false;
async function tareasPeriodicas() {
  if (tareasEnCurso) return;
  tareasEnCurso = true;
  try {
    await correrTareasPeriodicas();
  } finally {
    tareasEnCurso = false;
  }
}

async function correrTareasPeriodicas() {
  const tareas = [
    ['configuración', cargarConfiguracion],
    ['aperturas programadas', abrirMesesProgramados],
    ['recordatorios', enviarRecordatorios],
    ['lista de espera', limpiarListaEspera],
    ['cola de correos', limpiarColaCorreos],
    ['copia mensual', enviarCopiaMensual],
    ['plazos de conservación', aplicarPlazosDeConservacion],
    ['alertas', enviarAlertas]
  ];
  for (const [nombre, tarea] of tareas) {
    try {
      await tarea();
    } catch (error) {
      console.error(`⚠️ La tarea periódica "${nombre}" falló:`, error);
    }
  }
}

// ========== ERRORES NO ATRAPADOS (CEQ-12) ==========
// Lo que falla antes de llegar a una ruta (por ejemplo, un JSON mal escrito o demasiado grande)
// no pasa por manejarError(). Sin esto, Express respondía con una página HTML que, fuera del modo
// producción, mostraba rutas internas del servidor. Va después de todas las rutas.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Solicitud demasiado grande' });
  console.error(`⚠️ Error no atrapado en ${req.method} ${req.path}:`, err && err.name, err && err.message);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ========== INICIAR SERVIDOR ==========

cargarConfiguracion().catch(error => console.error('⚠️ No se pudo leer la configuración, se usan los valores por defecto:', error));
setInterval(tareasPeriodicas, INTERVALO_TAREAS_MS);
// La cola de correos se revisa aparte, cada minuto (los reintentos no esperan a las otras tareas)
setInterval(() => procesarColaCorreos().catch(err => {
  if (!['42P01', 'PGRST205'].includes(err && err.code)) console.error('⚠️ Cola de correos:', err);
}), INTERVALO_COLA_CORREOS_MS);
setTimeout(tareasPeriodicas, Math.min(20 * 1000, INTERVALO_TAREAS_MS));

app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en puerto ${PORT}`);
  console.log(`🔒 Modo seguro: JWT, bcrypt y validaciones activadas`);
  console.log(`⚙️ NODE_ENV: ${process.env.NODE_ENV || '(sin definir)'}`);
  console.log(`📊 Sincronización con Google Sheets: ${SINCRONIZACION_ACTIVA ? 'activada' : 'desactivada (falta CLAVE_SINCRONIZACION)'}`);
});
