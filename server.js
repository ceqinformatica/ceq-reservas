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
// Email específico para avisos del espacio Frente (si no se configura, usa el general)
const EMAIL_MODERADOR_FRENTE = process.env.EMAIL_MODERADOR_FRENTE || EMAIL_MODERADOR;

// Devuelve el/los email(s) de moderador correspondientes según el espacio (para notificaciones internas).
// Altillo: solo el general. Frente: el general + el específico de Frente (sin duplicar si son iguales).
function getEmailModerador(espacio_id) {
  if (espacio_id === 3) {
    return [...new Set([EMAIL_MODERADOR, EMAIL_MODERADOR_FRENTE])];
  }
  return [EMAIL_MODERADOR];
}

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
  // Espacios deshabilitados cuyo aviso NO se muestra al entrar a la página (se guarda el texto igual)
  avisos_ocultos: [],
  // Ventana de novedades que ve la gente al entrar (una vez por navegador y por versión). Se
  // escribe desde el admin supremo; este es el contenido inicial.
  ventana_novedades: {
    activa: true,
    version: '2026-10',
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
const CLAVES_CONFIG_JSON = ['turnos_frente', 'avisos_ocultos', 'ventana_novedades'];
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
    return {
      activa: v.activa === true,
      version,
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

// Motivos del Frente: la persona elige uno de la lista (en el Altillo el motivo sigue siendo libre)
const MOTIVOS_FRENTE = [
  'Actividad Personal',
  'Recaudación - Asociación Estudiantil',
  'Recaudación - Secretaría CEQ',
  'Recaudación - Padrinaje',
  'Recaudación - Congreso o Evento Académico'
];

// Altillo: bloques de 1 hora entre las 08:00 y las 20:00, de 1 a 2 horas por reserva
const ALTILLO_HORA_DESDE = 8;
const ALTILLO_HORA_HASTA = 20;
const ALTILLO_MAX_HORAS = 2;

// Acompañantes (opcional, hasta 4, solo en el Altillo): [{ nombre, celular }]. Devuelve la lista limpia o lanza un
// Error con el mensaje para la persona.
const MAX_ACOMPANANTES = 4;
function validarAcompanantes(valor) {
  if (valor === undefined || valor === null) return [];
  if (!Array.isArray(valor) || valor.length > MAX_ACOMPANANTES) throw new Error(`Se pueden anotar hasta ${MAX_ACOMPANANTES} acompañantes`);
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
  return Number(espacio_id) === 3 ? config.contacto_email_frente : EMAIL_MODERADOR;
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
  return `${EMAIL_MODERADOR}`;
}

// Función helper para enviar emails vía la API de Brevo.
// Nunca lanza error (lo captura y lo loguea), así que se llama SIN await: los
// endpoints responden al usuario de inmediato y el email sale en segundo plano,
// en vez de hacer esperar al usuario varios segundos a que conteste Brevo.
// `text` (opcional): versión en texto simple que va junto al HTML.
// `responderA` (opcional): a quién le llega si se toca "Responder". reservas@ceq-una.com no tiene
// buzón (las respuestas rebotaban), así que por defecto las respuestas van al correo general.
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
        htmlContent: html,
        replyTo: { email: EMAIL_REGEX.test(String(responderA || '')) ? responderA : EMAIL_MODERADOR },
        ...(text ? { textContent: text } : {}),
        ...(adjuntos && adjuntos.length ? { attachment: adjuntos } : {})
      })
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      console.error('⚠️ Error al enviar email vía Brevo:', res.status, errorData);
      return false;
    }
    return true;
  } catch (err) {
    console.error('⚠️ Error de red al enviar email:', err);
    return false;
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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token']
}));

// Limitar tamaño de payloads
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
  console.warn(`⚠️ 429 rate limit: IP ${obtenerIpCliente(req)} en ${req.method} ${req.originalUrl}`);
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
  // Antes 15: en una red compartida (WiFi de facultad) varias personas salen con
  // la misma IP pública, y el día que se habilita un mes nuevo reservan muchas a la vez.
  max: 30,
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
async function leerTodasLasFilas(armarConsulta, maximo = 50000) {
  const TAM_PAGINA = 1000;
  const filas = [];
  for (let desde = 0; desde < maximo; desde += TAM_PAGINA) {
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

// Emails exentos del límite anterior (ej. el de quien hace pruebas del sistema).
// Se configuran en Render como variable de entorno, separados por coma:
//   EMAILS_SIN_LIMITE=uno@gmail.com,otro@gmail.com
// No se escriben acá en el código porque el repositorio es público.
const EMAILS_SIN_LIMITE = new Set(
  (process.env.EMAILS_SIN_LIMITE || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean)
);

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

// Regla de cancelación del Frente para los correos de confirmación (la misma que aplica
// /api/cancelar-por-codigo): gratis con el código hasta 2 días antes; después, por WhatsApp.
// Antes la gente se enteraba recién cuando intentaba cancelar y el sistema no la dejaba.
function reglaCancelacionHtml(espacioId, fecha) {
  if (Number(espacioId) !== 3) return '';
  const whatsapp = `<a href="${enlaceWhatsappFrente()}">WhatsApp</a>`;
  if (diferenciaEnDiasCalendario(fecha) < 2) {
    return `<p>Como faltan menos de 2 días, esta reserva ya no se puede cancelar con el código. Si necesitás cancelarla, escribinos por ${whatsapp}.</p>`;
  }
  const limite = new Date(fecha + 'T00:00:00Z');
  limite.setUTCDate(limite.getUTCDate() - 2);
  const fechaLimite = `${String(limite.getUTCDate()).padStart(2, '0')}/${String(limite.getUTCMonth() + 1).padStart(2, '0')}/${limite.getUTCFullYear()}`;
  return `<p>Podés cancelarla gratis con tu código hasta el <strong>${fechaLimite}</strong> (2 días antes). Después de esa fecha, la cancelación solo se gestiona por ${whatsapp}.</p>`;
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
const CLAVE_ENLACES = crypto.createHmac('sha256', JWT_SECRET).update('enlaces-de-cancelacion-v1').digest();

function tokenCancelacion(reservaId) {
  return crypto.createHmac('sha256', CLAVE_ENLACES).update(`cancelar:${Number(reservaId)}`).digest('base64url').slice(0, 32);
}

function tokenCancelacionValido(reservaId, token) {
  if (!esIdValido(reservaId) || typeof token !== 'string' || token.length !== 32) return false;
  const esperado = Buffer.from(tokenCancelacion(reservaId));
  const recibido = Buffer.from(token);
  return esperado.length === recibido.length && crypto.timingSafeEqual(esperado, recibido);
}

function enlaceCancelacion(reservaId) {
  return `https://reservas.ceq-una.com/cancelar.html?r=${Number(reservaId)}&t=${tokenCancelacion(reservaId)}`;
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

    // Validar contraseña: primero la del admin supremo (si está configurada), después la normal
    const esSuperadmin = SUPERADMIN_PASSWORD_HASH !== '' && await bcrypt.compare(password, SUPERADMIN_PASSWORD_HASH);
    const passwordValida = esSuperadmin || await bcrypt.compare(password, ADMIN_PASSWORD_HASH);

    if (!passwordValida) {
      console.warn(`⚠️ Intento de login fallido a las ${new Date().toISOString()}`);
      registrarActividad('-', 'Intento de inicio de sesión fallido');
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    const rol = esSuperadmin ? 'superadmin' : 'admin';

    // Generar JWT (válido por 8 horas). Lleva el rol y la versión de sesiones vigente.
    const token = jwt.sign(
      { adminId: 'admin', rol, v: await obtenerVersionSesiones(), timestamp: Date.now() },
      JWT_SECRET,
      { expiresIn: '8h', algorithm: 'HS256' }
    );

    // AUTH-002: cookie de primera parte (mismo dominio raíz que el frontend),
    // así los navegadores no la tratan como cookie de terceros y no la bloquean
    // (Safari y el modo incógnito de Chrome bloquean cookies de terceros por defecto).
    // Requiere que el backend esté servido desde un subdominio de ceq-una.com
    // (ej. api.ceq-una.com) — si todavía corre solo en onrender.com, esta cookie
    // con domain=.ceq-una.com no se va a setear correctamente.
    res.cookie('admin_token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      domain: '.ceq-una.com',
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

// Cerrar sesión: limpia las cookies del token y del CSRF (AUTH-002)
app.post('/api/logout', (req, res) => {
  res.clearCookie('admin_token', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    domain: '.ceq-una.com',
    path: '/'
  });
  res.clearCookie('csrf_token', {
    httpOnly: false,
    secure: true,
    sameSite: 'lax',
    domain: '.ceq-una.com',
    path: '/'
  });
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

    let query = supabase
      .from('reservas')
      .select('espacio_id, fecha, hora_inicio, hora_fin, nombre_solicitante, motivo')
      .eq('estado', 'activa');
    
    if (espacio_id) query = query.eq('espacio_id', parseInt(espacio_id));
    if (fecha) {
      query = query.eq('fecha', fecha);
    } else {
      // Solo desde el primer día del mes actual (en Paraguay) en adelante. Antes se
      // devolvían TODAS las reservas activas de la historia con un tope de 2000: cuando
      // la base pasara ese número, el calendario iba a empezar a mostrar como libres
      // turnos que en realidad estaban ocupados, sin ningún aviso. Se arranca desde el
      // día 1 (y no desde hoy) para que el mes en curso se siga viendo completo.
      const hoy = hoyEnAsuncion();
      const primerDiaMes = `${hoy.getUTCFullYear()}-${String(hoy.getUTCMonth() + 1).padStart(2, '0')}-01`;
      query = query.gte('fecha', primerDiaMes);
    }

    const { data, error } = await query.limit(2000);
    
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    manejarError(res, error);
  }
});

// GET bloqueos (público)
app.get('/api/bloqueos', lecturaPublicaLimiter, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bloqueos')
      .select('espacio_id, fecha, hora_inicio, hora_fin')
      .limit(1000);
    
    if (error) throw error;
    res.json(data || []);
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
app.get('/api/configuracion', lecturaPublicaLimiter, (req, res) => {
  res.json({
    turnos_frente: config.turnos_frente,
    max_reservas_por_persona_mes: config.max_reservas_por_persona_mes,
    contacto_frente: { email: config.contacto_email_frente, whatsapp: config.contacto_whatsapp_frente },
    motivos_frente: MOTIVOS_FRENTE,
    altillo: { hora_desde: ALTILLO_HORA_DESDE, hora_hasta: ALTILLO_HORA_HASTA, max_horas: ALTILLO_MAX_HORAS },
    max_acompanantes: MAX_ACOMPANANTES,
    ventana_novedades: config.ventana_novedades && config.ventana_novedades.activa ? config.ventana_novedades : null
  });
});

app.post('/api/reservas', crearReservaLimiter, async (req, res) => {
  try {
    const { espacio_id, nombre_solicitante, contacto, fecha, hora_inicio, hora_fin, motivo } = req.body;
    
    // Faltan parámetros requeridos. `motivo` también es obligatorio acá (el HTML ya
    // lo exige, pero golpeando la API directamente se podía saltear esa validación).
    if (!espacio_id || !nombre_solicitante || !contacto || !fecha || !hora_inicio || !hora_fin || !motivo) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }

    // Longitudes máximas razonables (VAL-002)
    if (String(nombre_solicitante).length > 150 || String(contacto).length > 200 || String(motivo).length > 500) {
      return res.status(400).json({ error: 'Uno o más campos exceden la longitud permitida' });
    }

    // VAL-002: el resto del sistema asume el formato "celular | email" y usa
    // contacto.split('|')[1] para mandar la confirmación por mail. Si el formato no
    // coincide (por ejemplo, golpeando la API directo sin pasar por el formulario),
    // esa parte queda undefined y el email de confirmación se pierde en silencio,
    // sin avisar a nadie que falló.
    const partesContacto = String(contacto).split('|').map(p => p.trim());
    const emailValidoRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (partesContacto.length !== 2 || !partesContacto[0] || !emailValidoRegex.test(partesContacto[1])) {
      return res.status(400).json({ error: 'El contacto debe tener el formato "celular | email" con un email válido' });
    }

    // Qué espacios se pueden reservar desde la página lo decide el admin supremo
    // (columna espacios.publico, panel > Avanzado > Espacios). Se revisa acá y no solo en
    // la página, porque alguien podría mandar la reserva directo a la API.
    const espacioIdNum = parseInt(espacio_id);
    if (!Number.isInteger(espacioIdNum)) {
      return res.status(400).json({ error: 'Espacio inválido' });
    }
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
      if (!MOTIVOS_FRENTE.includes(String(motivo).trim())) {
        return res.status(400).json({ error: 'Elegí el motivo de la lista' });
      }
    } else {
      // Altillo: bloques de 1 hora entre las 08:00 y las 20:00, de 1 a 2 horas
      const duracionHoras = (finMin - inicioMin) / 60;
      if (duracionHoras < 1 || duracionHoras > ALTILLO_MAX_HORAS) {
        return res.status(400).json({ error: `La duración debe ser entre 1 y ${ALTILLO_MAX_HORAS} horas` });
      }

      if (inicioMin < ALTILLO_HORA_DESDE * 60 || finMin > ALTILLO_HORA_HASTA * 60) {
        return res.status(400).json({ error: `Horario fuera de rango (${String(ALTILLO_HORA_DESDE).padStart(2, '0')}:00-${ALTILLO_HORA_HASTA}:00)` });
      }
    }

    // Acompañantes: solo en el Altillo
    let acompanantes;
    try {
      acompanantes = validarAcompanantes(req.body.acompanantes);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (espacioIdNum !== 1 && acompanantes.length > 0) {
      return res.status(400).json({ error: 'Los acompañantes se anotan solo en las reservas del Altillo' });
    }

    // La fecha no puede ser pasada ni caer en fin de semana. El límite superior ya
    // no es una ventana fija de 31 días: ahora depende de qué meses haya habilitado
    // manualmente un moderador (ver tabla meses_habilitados y endpoints /api/meses-habilitados).
    const hoy = hoyEnAsuncion();
    const fechaReserva = new Date(fecha + 'T00:00:00Z');
    const esFinDeSemana = fechaReserva.getUTCDay() === 0 || fechaReserva.getUTCDay() === 6;

    if (isNaN(fechaReserva.getTime()) || fechaReserva < hoy || esFinDeSemana) {
      return res.status(400).json({ error: 'Fecha fuera del rango permitido para reservar' });
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
      return res.status(400).json({ error: 'Ese mes todavía no está habilitado para reservas' });
    }

    // Límite de reservas activas por persona por mes (en el mes de la FECHA reservada,
    // no del día en que se reserva). Se identifica a la persona por email Y por celular,
    // para que no alcance con cambiar solo uno de los dos. Las canceladas no cuentan.
    // Las reservas de prioridad del panel admin no pasan por acá (no tienen límite).
    if (!EMAILS_SIN_LIMITE.has(partesContacto[1].toLowerCase())) {
      const ultimoDia = new Date(Date.UTC(anioReserva, mesReserva, 0)).getUTCDate();
      const mesStr = String(mesReserva).padStart(2, '0');
      const { data: reservasDelMes, error: errorReservasMes } = await supabase
        .from('reservas')
        .select('contacto')
        .eq('estado', 'activa')
        .eq('espacio_id', espacioIdNum)
        .gte('fecha', `${anioReserva}-${mesStr}-01`)
        .lte('fecha', `${anioReserva}-${mesStr}-${ultimoDia}`);

      if (errorReservasMes) throw errorReservasMes;

      const persona = identidadContacto(contacto);
      const cantidad = (reservasDelMes || []).filter(r => {
        const otra = identidadContacto(r.contacto);
        return (persona.email && otra.email === persona.email) ||
               (persona.celular && otra.celular === persona.celular);
      }).length;

      if (cantidad >= config.max_reservas_por_persona_mes) {
        return res.status(400).json({
          error: `Ya tenés ${cantidad} reservas activas en ${getEspacioNombre(espacioIdNum)} para ese mes. El máximo es ${config.max_reservas_por_persona_mes} por persona. Si necesitás otro turno, cancelá una de tus reservas anteriores.`
        });
      }
    }

    // VAL-001: si la reserva es para hoy, el horario no puede haber pasado. En el Frente, el
    // turno no puede haber empezado; en el Altillo, el primer bloque de 1 hora no puede haber
    // terminado (a las 11:30 todavía se puede tomar el bloque de las 11:00, a las 12:00 ya no).
    if (fechaReserva.getTime() === hoy.getTime()) {
      const minutosActuales = horaActualEnAsuncionEnMinutos();
      const limite = espacioIdNum === 3 ? inicioMin : inicioMin + 60;
      if (limite <= minutosActuales) {
        return res.status(400).json({ error: 'No se puede reservar un horario que ya pasó' });
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
      return res.status(409).json({ error: 'El horario seleccionado está bloqueado por administración' });
    }
    
    // Generar código de cancelación seguro (16 caracteres). Solo se guarda su hash
    // en la base (SEC-005); el código en claro se le muestra al usuario una única
    // vez acá y por email, y nunca se vuelve a poder recuperar desde la base.
    const codigo = crypto.randomBytes(8).toString('hex').toUpperCase();
    const codigoHash = hashCodigo(codigo);
    
    // Insertar reserva
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
        motivo: String(motivo || '').trim(),
        codigo_cancelacion_hash: codigoHash,
        acompanantes
      }])
      .select();
    
    if (error) {
      if (error.code === '23505' || error.code === '23P01') {
        return res.status(409).json({ error: 'Horario no disponible - se solapa con otra reserva existente' });
      }
      // CONC-001: el trigger de la base detectó, de forma atómica, que el horario
      // está bloqueado por administración (esto puede pasar incluso si el chequeo
      // previo en JS no lo detectó, por ejemplo si el bloqueo se creó en el mismo instante)
      if (error.code === 'CEQ01') {
        return res.status(409).json({ error: 'El horario seleccionado está bloqueado por administración' });
      }
      throw error;
    }
    
    // Extraer email del contacto (formato: "celular | email")
    const email = contacto.split('|')[1]?.trim() || '';
    const espaciosNombre = { 1: 'Altillo', 2: 'Sala de Reuniones', 3: 'Frente' };
    const nombreEspacio = espaciosNombre[espacioIdNum];
    // Se agrega al asunto de cada email para que Gmail (y clientes similares) no agrupen
    // como si fueran la misma conversación a dos reservas distintas que comparten el
    // mismo asunto genérico (ej. dos "Nueva Reserva (Altillo) - CEQ" de personas distintas).
    const reservaId = nuevaReserva[0].id;

    // Línea de contacto según el espacio reservado
    const contactoLinea = `<p>Ante cualquier consulta, contactate con: ${getContactoLineaHtml(espacioIdNum)}</p>`;

    // Valores escapados para uso en HTML de emails (SEC-006): nombre/motivo/contacto son
    // ingresados libremente por cualquier visitante y no deben interpretarse como HTML.
    const nombreSeguro = escapeHtml(nombre_solicitante);
    const motivoSeguro = escapeHtml(motivo);
    const contactoSeguro = escapeHtml(contacto);
    
    // Se responde al usuario APENAS se guardó la reserva, y los emails se mandan
    // después, en segundo plano. Antes se esperaba a Brevo (2 emails en serie) antes
    // de contestar: la confirmación tardaba varios segundos, la gente creía que había
    // fallado y volvía a reservar. enviarEmail() nunca lanza error (lo captura y loguea).
    res.status(201).json({
      mensaje: 'Reserva creada exitosamente',
      reserva: nuevaReserva[0],
      codigo
    });

    // Enviar email al usuario (si existe email)
    if (email) {
      enviarEmail({
        to: email,
        subject: `✓ Confirmación de Reserva - CEQ #${reservaId}`,
        responderA: correoRespuesta(espacioIdNum),
        html: `
          <h2>¡Reserva Confirmada!</h2>
          <p>Hola ${nombreSeguro},</p>
          <p>Tu reserva ha sido confirmada exitosamente.</p>
          <hr>
          <p><strong>Detalles:</strong></p>
          <ul>
            <li><strong>Espacio:</strong> ${nombreEspacio}</li>
            <li><strong>Fecha:</strong> ${fecha}</li>
            <li><strong>Horario:</strong> ${descripcionHorario(espacioIdNum, hora_inicio, hora_fin)}</li>
            <li><strong>Motivo:</strong> ${motivoSeguro || 'Sin especificar'}</li>${acompanantes.length ? `
            <li><strong>Acompañantes:</strong> ${escapeHtml(acompanantesTexto(acompanantes))}</li>` : ''}
            <li><strong>Código de cancelación:</strong> ${codigo}</li>
          </ul>
          <p>Si necesitas cancelar, usa tu código en: <a href="https://reservas.ceq-una.com/cancelar.html">Cancelar Reserva</a>, o directamente este enlace: <a href="${enlaceCancelacion(reservaId)}">Cancelar mi reserva</a></p>
          ${reglaCancelacionHtml(espacioIdNum, fecha)}
          <p><a href="${escapeHtml(enlaceGoogleCalendar(espacioIdNum, fecha, hora_inicio, hora_fin))}">📅 Agregar a Google Calendar</a></p>
          ${contactoLinea}
          <p>Centro de Estudiantes de Química</p>
        `
      });
    }
    
    // Enviar email al moderador correspondiente (Altillo o Frente)
    enviarEmail({
      to: getEmailModerador(espacioIdNum),
      subject: `📌 Nueva Reserva (${nombreEspacio}) - CEQ #${reservaId}`,
      responderA: correoDeContacto(contacto),
      html: `
        <h2>Nueva Reserva</h2>
        <p><strong>Usuario:</strong> ${nombreSeguro}</p>
        <p><strong>Contacto:</strong> ${contactoSeguro}</p>
        <hr>
        <ul>
          <li><strong>Espacio:</strong> ${nombreEspacio}</li>
          <li><strong>Fecha:</strong> ${fecha}</li>
          <li><strong>Horario:</strong> ${descripcionHorario(espacioIdNum, hora_inicio, hora_fin)}</li>
          <li><strong>Motivo:</strong> ${motivoSeguro || 'Sin especificar'}</li>${acompanantes.length ? `
            <li><strong>Acompañantes:</strong> ${escapeHtml(acompanantesTexto(acompanantes))}</li>` : ''}
          <li><strong>Código:</strong> ${codigo}</li>
        </ul>
      `
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

  if (diferenciaDias < 0) {
    return res.status(400).json({ error: 'Esa reserva ya pasó: no se puede cancelar' });
  }

  // Validar período de cancelación para Frente (2 días)
  if (Number(reserva.espacio_id) === 3 && diferenciaDias < 2) {
    const emailUsuario = reserva.contacto.split('|')[1]?.trim();
    if (emailUsuario) {
      enviarEmail({
        to: emailUsuario,
        subject: `Período de Cancelación Gratuita Finalizado - CEQ #${reserva.id}`,
        responderA: correoRespuesta(reserva.espacio_id),
        html: `
          <h2>El período de cancelación gratuita ha finalizado</h2>
          <p>Intentaste cancelar tu reserva de <strong>${getEspacioNombre(reserva.espacio_id)}</strong>, pero el período de cancelación gratuita ya venció.</p>
          <p><strong>Detalles de la Reserva:</strong></p>
          <ul>
            <li>Fecha: ${reserva.fecha}</li>
            <li>Horario: ${descripcionHorario(reserva.espacio_id, reserva.hora_inicio.substring(0,5), reserva.hora_fin.substring(0,5))}</li>
          </ul>
          <p>Si de todas formas deseás realizar la cancelación, contactate por WhatsApp: <a href="${enlaceWhatsappFrente()}">Contactar por WhatsApp</a></p>
        `
      });
    }

    // Aviso al moderador: hubo un intento de cancelación fuera del período gratuito
    enviarEmail({
      to: getEmailModerador(reserva.espacio_id),
      subject: `Intento de Cancelación Fuera de Plazo - CEQ #${reserva.id}`,
      responderA: correoDeContacto(reserva.contacto),
      html: `
        <h2>Intento de Cancelación (Período Vencido)</h2>
        <p><strong>Usuario:</strong> ${escapeHtml(reserva.nombre_solicitante)}</p>
        <p><strong>Contacto:</strong> ${escapeHtml(reserva.contacto)}</p>
        <p><strong>Espacio:</strong> ${getEspacioNombre(reserva.espacio_id)}</p>
        <p><strong>Fecha de la reserva:</strong> ${reserva.fecha}</p>
        <p><strong>Horario:</strong> ${descripcionHorario(reserva.espacio_id, reserva.hora_inicio.substring(0,5), reserva.hora_fin.substring(0,5))}</p>
        <p>El usuario intentó cancelar esta reserva, pero el período de cancelación gratuita ya había vencido. La reserva sigue activa.</p>
      `
    });

    return res.status(403).json({
      error: 'EL PERIODO DE CANCELACION GRATUITA HA FINALIZADO. SI DESEA REALIZAR LA CANCELACION CONTACTESE CON ceq.informatica@gmail.com'
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
    enviarEmail({
      to: email,
      subject: `Cancelación Confirmada - CEQ Reservas #${reserva.id}`,
      responderA: correoRespuesta(reserva.espacio_id),
      html: `
        <h2>¡Has cancelado correctamente tu reserva!</h2>
        <p><strong>Detalles:</strong></p>
        <ul>
          <li>Fecha: ${reserva.fecha}</li>
          <li>Espacio: ${getEspacioNombre(reserva.espacio_id)}</li>
          <li>Horario: ${descripcionHorario(reserva.espacio_id, reserva.hora_inicio.substring(0,5), reserva.hora_fin.substring(0,5))}</li>
        </ul>
        <p>Si tienes dudas, contacta con: ${getContactoLineaHtml(reserva.espacio_id)}</p>
      `
    });
  }

  // Email al moderador. Antes solo se mandaba para Frente; ahora se manda siempre —
  // getEmailModerador() ya se encarga de que a Altillo le llegue solo a ceq.informatica,
  // y a Frente le siga llegando también a Monse, sin tocar nada más.
  enviarEmail({
    to: getEmailModerador(reserva.espacio_id),
    subject: `Cancelación de Reserva - CEQ #${reserva.id}`,
    responderA: correoDeContacto(reserva.contacto),
    html: `
      <h2>Reserva Cancelada por Usuario</h2>
      <p><strong>Usuario:</strong> ${escapeHtml(reserva.nombre_solicitante)}</p>
      <p><strong>Contacto:</strong> ${escapeHtml(reserva.contacto)}</p>
      <p><strong>Espacio:</strong> ${getEspacioNombre(reserva.espacio_id)}</p>
      <p><strong>Fecha:</strong> ${reserva.fecha}</p>
      <p><strong>Horario:</strong> ${descripcionHorario(reserva.espacio_id, reserva.hora_inicio.substring(0,5), reserva.hora_fin.substring(0,5))}</p>
    `
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
  if (!tokenCancelacionValido(r, t)) {
    res.status(404).json({ error: 'El enlace no es válido. Podés cancelar con el código que te llegó en el correo de confirmación.' });
    return null;
  }
  const { data, error } = await supabase
    .from('reservas')
    .select('*')
    .eq('id', Number(r))
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    res.status(404).json({ error: 'Esa reserva ya no existe' });
    return null;
  }
  return data;
}

app.get('/api/cancelar-por-enlace', cancelarLimiter, async (req, res) => {
  try {
    const reserva = await reservaDelEnlace(res, req.query.r, req.query.t);
    if (!reserva) return;
    const dias = diferenciaEnDiasCalendario(reserva.fecha);
    const plazoVencido = Number(reserva.espacio_id) === 3 && dias < 2;
    res.set('Cache-Control', 'no-store');
    res.json({
      id: reserva.id,
      espacio: getEspacioNombre(reserva.espacio_id),
      fecha_larga: fechaLarga(reserva.fecha),
      horario: descripcionHorario(reserva.espacio_id, reserva.hora_inicio.substring(0, 5), reserva.hora_fin.substring(0, 5)),
      estado: reserva.estado,
      ya_paso: dias < 0,
      se_puede_cancelar: reserva.estado === 'activa' && dias >= 0 && !plazoVencido,
      plazo_vencido: reserva.estado === 'activa' && dias >= 0 && plazoVencido,
      whatsapp: Number(reserva.espacio_id) === 3 ? config.contacto_whatsapp_frente : null
    });
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

// ========== LISTA DE ESPERA (general, por espacio) ==========
// Cuando en un espacio ya no queda ningún lugar libre en los meses habilitados, la página muestra
// "Ya no hay reservas disponibles" y la persona puede dejar su correo. Si después alguien cancela
// cualquier reserva de ese espacio (de un horario que todavía no empezó), se avisa a todos los
// anotados a la vez, diciendo qué día y turno se liberó (el lugar es de quien reserve primero).
// Cada inscripción se avisa una sola vez; para otro aviso hay que volver a anotarse.
const MAX_AVISOS_LISTA_ESPERA_POR_DIA = 60; // dentro de los 300 correos diarios de Brevo
const DIAS_VIGENCIA_LISTA_ESPERA = 60; // las inscripciones sin avisar más viejas se borran solas
let avisosListaEsperaHoy = { dia: '', cantidad: 0 };

function puedeAvisarListaEspera() {
  const dia = hoyEnAsuncion().toISOString().slice(0, 10);
  if (avisosListaEsperaHoy.dia !== dia) avisosListaEsperaHoy = { dia, cantidad: 0 };
  if (avisosListaEsperaHoy.cantidad >= MAX_AVISOS_LISTA_ESPERA_POR_DIA) return false;
  avisosListaEsperaHoy.cantidad++;
  return true;
}

// true si ese horario ya empezó (o el día ya pasó), en hora de Paraguay
function horarioYaEmpezo(fechaISO, horaInicioHHMM) {
  const dias = diferenciaEnDiasCalendario(fechaISO);
  if (dias !== 0) return dias < 0;
  const [h, m] = horaInicioHHMM.split(':').map(Number);
  return h * 60 + m <= horaActualEnAsuncionEnMinutos();
}

app.post('/api/lista-espera', listaEsperaLimiter, async (req, res) => {
  try {
    const { espacio_id, email } = req.body || {};
    const correo = String(email || '').trim().toLowerCase();
    if (!EMAIL_REGEX.test(correo) || correo.length > 100) {
      return res.status(400).json({ error: 'Escribí un correo válido' });
    }
    const espacioIdNum = Number(espacio_id);
    if (![1, 3].includes(espacioIdNum)) {
      return res.status(400).json({ error: 'Espacio inválido' });
    }

    const { data: espacioData, error: errorEspacio } = await supabase
      .from('espacios').select('publico').eq('id', espacioIdNum).maybeSingle();
    if (errorEspacio) throw errorEspacio;
    if (!espacioData || !espacioData.publico) {
      return res.status(400).json({ error: 'Ese espacio no se puede reservar por el momento' });
    }

    // Si ya estaba anotado (por ejemplo, lo avisaron antes y se volvió a llenar), se reactiva
    const { error: errorGuardar } = await supabase
      .from('lista_espera')
      .upsert({ espacio_id: espacioIdNum, email: correo, creado_en: new Date().toISOString(), avisado_en: null },
        { onConflict: 'espacio_id,email' });
    if (errorGuardar) throw errorGuardar;

    res.status(201).json({ mensaje: 'Listo: si se libera un lugar, te avisamos por correo.' });
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

    // Se marcan como avisadas ANTES de mandar: si llegan dos cancelaciones juntas, nadie
    // recibe dos avisos por la misma inscripción
    const { data: tomadas, error } = await supabase
      .from('lista_espera').update({ avisado_en: new Date().toISOString() })
      .eq('espacio_id', reserva.espacio_id).is('avisado_en', null).select('email');
    if (error) throw error;
    if (!tomadas || tomadas.length === 0) return;

    const espacio = getEspacioNombre(reserva.espacio_id);
    const horario = descripcionHorario(reserva.espacio_id, inicio, fin);
    const enlace = `https://reservas.ceq-una.com/?fecha=${reserva.fecha}&espacio=${Number(reserva.espacio_id)}`;
    for (const correo of [...new Set(tomadas.map(x => x.email))]) {
      if (!puedeAvisarListaEspera()) {
        console.warn('⚠️ Se alcanzó el tope diario de avisos de lista de espera');
        break;
      }
      // Correo simple, como de una persona (sin botón ni emoji), para que Gmail lo deje en
      // "Principal" y no en "Promociones". El asunto lleva el día, el turno y el número de la
      // reserva cancelada: cada aviso tiene un asunto distinto y Gmail no los agrupa.
      const dia = fechaLarga(reserva.fecha);
      enviarEmail({
        to: correo,
        subject: `Se liberó un turno en el ${espacio}: ${dia}, ${horario} (aviso #${reserva.id})`,
        responderA: correoRespuesta(reserva.espacio_id),
        html: `
          <p>Hola,</p>
          <p>Se canceló una reserva del ${espacio} y quedó libre el <strong>${dia}, ${horario}</strong>.</p>
          <p>Si te sirve, podés reservarlo acá: <a href="${enlace}">${enlace}</a></p>
          <p>El turno es de quien reserve primero.</p>
          <p>Te escribimos porque te anotaste en la lista de espera del ${espacio}. Este es el único aviso; si querés otro, volvé a anotarte en la página.</p>
          <p>Centro de Estudiantes de Química</p>
        `,
        text: `Hola,\n\nSe canceló una reserva del ${espacio} y quedó libre el ${dia}, ${horario}.\n\nSi te sirve, podés reservarlo acá: ${enlace}\n\nEl turno es de quien reserve primero.\n\nTe escribimos porque te anotaste en la lista de espera del ${espacio}. Este es el único aviso; si querés otro, volvé a anotarte en la página.\n\nCentro de Estudiantes de Química`
      });
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
let avisosReporteHoy = { dia: '', cantidad: 0 };

function puedeAvisarReporte() {
  const dia = hoyEnAsuncion().toISOString().slice(0, 10);
  if (avisosReporteHoy.dia !== dia) avisosReporteHoy = { dia, cantidad: 0 };
  if (avisosReporteHoy.cantidad >= MAX_AVISOS_REPORTE_POR_DIA) return false;
  avisosReporteHoy.cantidad++;
  return true;
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
    if (puedeAvisarReporte()) {
      const reporteId = reporteCreado?.[0]?.id;
      enviarEmail({
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

    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || isNaN(new Date(fecha + 'T00:00:00').getTime())) {
      return res.status(400).json({ error: 'Fecha inválida' });
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
      const horaMinima = Number(espacio_id) === 3 ? 7 : 8;
      const horaMaxima = 18;
      
      if (horaI < horaMinima || horaF > horaMaxima || horaI >= horaF) {
        return res.status(400).json({ error: `Horario inválido (${horaMinima}:00-${horaMaxima}:00)` });
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
    const { espacio_id, nombre_solicitante, contacto, fecha, hora_inicio, hora_fin, motivo } = req.body;

    if (!espacio_id || !nombre_solicitante || !contacto || !fecha || !hora_inicio || !hora_fin || !motivo) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }

    if (String(nombre_solicitante).length > 150 || String(contacto).length > 200 || String(motivo).length > 500) {
      return res.status(400).json({ error: 'Uno o más campos exceden la longitud permitida' });
    }

    const partesContacto = String(contacto).split('|').map(p => p.trim());
    const emailValidoRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (partesContacto.length !== 2 || !partesContacto[0] || !emailValidoRegex.test(partesContacto[1])) {
      return res.status(400).json({ error: 'El contacto debe tener el formato "celular | email" con un email válido' });
    }

    // Este endpoint es solo para Frente — la prioridad de la Comisión Directiva
    // aplica únicamente ahí, no tiene sentido para Altillo.
    const espacioIdNum = parseInt(espacio_id);
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
    // sea pasada ni caiga en fin de semana, y el chequeo de horario ya pasado si es hoy.
    const hoy = hoyEnAsuncion();
    const fechaReserva = new Date(fecha + 'T00:00:00Z');
    const esFinDeSemana = fechaReserva.getUTCDay() === 0 || fechaReserva.getUTCDay() === 6;

    if (isNaN(fechaReserva.getTime()) || fechaReserva < hoy || esFinDeSemana) {
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
        nombre_solicitante: String(nombre_solicitante).trim(),
        contacto: String(contacto).trim(),
        fecha,
        hora_inicio: hora_inicio + ':00',
        hora_fin: hora_fin + ':00',
        estado: 'activa',
        motivo: motivo || '',
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
    const email = partesContacto[1];
    enviarEmail({
      to: email,
      subject: `✓ Confirmación de Reserva - CEQ #${nuevaReserva[0].id}`,
      responderA: correoRespuesta(espacioIdNum),
      html: `
        <h2>¡Reserva Confirmada!</h2>
        <p>Hola ${escapeHtml(nombre_solicitante)},</p>
        <p>Tu reserva ha sido confirmada exitosamente.</p>
        <hr>
        <p><strong>Detalles:</strong></p>
        <ul>
          <li><strong>Espacio:</strong> Frente</li>
          <li><strong>Fecha:</strong> ${fecha}</li>
          <li><strong>Horario:</strong> ${descripcionHorario(espacioIdNum, hora_inicio, hora_fin)}</li>
          <li><strong>Motivo:</strong> ${escapeHtml(motivo) || 'Sin especificar'}</li>
          <li><strong>Código de cancelación:</strong> ${codigo}</li>
        </ul>
        <p>Si necesitas cancelar, usa tu código en: <a href="https://reservas.ceq-una.com/cancelar.html">Cancelar Reserva</a>, o directamente este enlace: <a href="${enlaceCancelacion(nuevaReserva[0].id)}">Cancelar mi reserva</a></p>
        ${reglaCancelacionHtml(espacioIdNum, fecha)}
        <p><a href="${escapeHtml(enlaceGoogleCalendar(espacioIdNum, fecha, hora_inicio, hora_fin))}">📅 Agregar a Google Calendar</a></p>
        <p>Ante cualquier consulta, contactate con: ${getContactoLineaHtml(espacioIdNum)}</p>
        <p>Centro de Estudiantes de Química</p>
      `
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
      enviarEmail({
        to: email,
        subject: `Tu Reserva Fue Cancelada por el Moderador - CEQ #${reserva.id}`,
        responderA: correoRespuesta(reserva.espacio_id),
        html: `
          <h2>Tu reserva fue cancelada por el moderador</h2>
          <p><strong>Motivo:</strong> ${escapeHtml(motivo) || 'No especificado'}</p>
          <p><strong>Detalles de la Reserva:</strong></p>
          <ul>
            <li>Fecha: ${reserva.fecha}</li>
            <li>Espacio: ${getEspacioNombre(reserva.espacio_id)}</li>
            <li>Horario: ${descripcionHorario(reserva.espacio_id, reserva.hora_inicio.substring(0,5), reserva.hora_fin.substring(0,5))}</li>
          </ul>
          <p>Si tienes preguntas, contacta con: ${getContactoLineaHtml(reserva.espacio_id)}</p>
        `
      });
    }

    // Avisar a los moderadores correspondientes cuando se cancela una reserva desde
    // el panel admin: Altillo solo a ceq.informatica; Frente a ambos (ceq.informatica + Monse),
    // así se enteran cruzadamente de las cancelaciones que hace el otro moderador.
    const destinatariosAviso = Number(reserva.espacio_id) === 3
      ? [...new Set([EMAIL_MODERADOR, config.contacto_email_frente])]
      : [EMAIL_MODERADOR];

    enviarEmail({
      to: destinatariosAviso,
      subject: `🔔 Un moderador canceló una reserva (${getEspacioNombre(reserva.espacio_id)}) - CEQ #${reserva.id}`,
      responderA: correoDeContacto(reserva.contacto),
      html: `
        <h2>Cancelación realizada por un moderador</h2>
        <p>Un moderador canceló la siguiente reserva desde el panel de administración:</p>
        <ul>
          <li><strong>Usuario:</strong> ${escapeHtml(reserva.nombre_solicitante)}</li>
          <li><strong>Contacto:</strong> ${escapeHtml(reserva.contacto)}</li>
          <li><strong>Espacio:</strong> ${getEspacioNombre(reserva.espacio_id)}</li>
          <li><strong>Fecha:</strong> ${reserva.fecha}</li>
          <li><strong>Horario:</strong> ${descripcionHorario(reserva.espacio_id, reserva.hora_inicio.substring(0,5), reserva.hora_fin.substring(0,5))}</li>
          <li><strong>Motivo de la cancelación:</strong> ${escapeHtml(motivo) || 'No especificado'}</li>
        </ul>
        <p style="color:#888; font-size:12px;">Este aviso se envía a ambos moderadores para que estén al tanto de las cancelaciones que se hagan desde el panel.</p>
      `
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
  email_alertas: 'correo de alertas'
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

    const opcionesCookie = { secure: true, sameSite: 'lax', domain: '.ceq-una.com', path: '/' };
    res.clearCookie('admin_token', { ...opcionesCookie, httpOnly: true });
    res.clearCookie('csrf_token', { ...opcionesCookie, httpOnly: false });
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

// Recordatorio 2 días antes de la reserva, entre las 08:00 y las 21:00 de ese día. Para el
// Frente es el último día en que se puede cancelar gratis, así que el correo trae el botón
// para cancelar. No se manda a las reservas de prioridad ni a las hechas en las últimas
// 12 horas (esas personas acaban de recibir la confirmación).
const MAX_RECORDATORIOS_POR_TANDA = 40;

function htmlRecordatorio(r) {
  const inicio = r.hora_inicio.substring(0, 5);
  const fin = r.hora_fin.substring(0, 5);
  const esFrente = Number(r.espacio_id) === 3;
  return `
    <h2>Te recordamos tu reserva</h2>
    <p>Hola ${escapeHtml(r.nombre_solicitante)},</p>
    <p>Tenés reservado el <strong>${getEspacioNombre(r.espacio_id)}</strong> el <strong>${fechaLarga(r.fecha)}</strong>, <strong>${descripcionHorario(r.espacio_id, inicio, fin)}</strong>.</p>
    <p>Si la vas a usar, no tenés que hacer nada. ¡Te esperamos!</p>
    <p>¿Ya no la vas a usar? Cancelala, así otra persona puede aprovechar el lugar:</p>
    <p><a href="${enlaceCancelacion(r.id)}" style="display:inline-block;background:#1F3A68;color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">Cancelar mi reserva</a></p>
    ${esFrente ? `<p><strong>Hoy es el último día para cancelar gratis.</strong> Desde mañana, la cancelación solo se gestiona por <a href="${enlaceWhatsappFrente()}">WhatsApp</a>.</p>` : ''}
    <p><a href="${escapeHtml(enlaceGoogleCalendar(r.espacio_id, r.fecha, inicio, fin))}">📅 Agregar a Google Calendar</a></p>
    <p>Ante cualquier consulta, contactate con: ${getContactoLineaHtml(r.espacio_id)}</p>
    <p>Centro de Estudiantes de Química</p>
  `;
}

async function enviarRecordatorios() {
  const minutos = horaActualEnAsuncionEnMinutos();
  if (minutos < 8 * 60 || minutos >= 21 * 60) return;
  const objetivo = hoyEnAsuncion();
  objetivo.setUTCDate(objetivo.getUTCDate() + 2);
  const hace12Horas = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('reservas')
    .select('id, espacio_id, fecha, hora_inicio, hora_fin, nombre_solicitante, contacto')
    .eq('estado', 'activa')
    .eq('fecha', objetivo.toISOString().slice(0, 10))
    .eq('reservado_por_admin', false)
    .is('recordatorio_enviado_en', null)
    .lt('created_at', hace12Horas)
    .limit(MAX_RECORDATORIOS_POR_TANDA);
  if (error) throw error;

  for (const r of data || []) {
    const email = String(r.contacto || '').split('|')[1]?.trim();
    // Se marca ANTES de mandar, así un reinicio a mitad de camino no manda dos veces
    const { data: tomada, error: errorTomar } = await supabase
      .from('reservas')
      .update({ recordatorio_enviado_en: new Date().toISOString() })
      .eq('id', r.id).eq('estado', 'activa').is('recordatorio_enviado_en', null)
      .select('id');
    if (errorTomar) throw errorTomar;
    if (!tomada || tomada.length === 0 || !email) continue;

    const enviado = await enviarEmail({
      to: email,
      subject: `⏰ Recordatorio: ${getEspacioNombre(r.espacio_id)}, ${fechaLarga(r.fecha)} - CEQ #${r.id}`,
      responderA: correoRespuesta(r.espacio_id),
      html: htmlRecordatorio(r)
    });
    if (!enviado) {
      // Si Brevo falló, se desmarca para reintentar en la próxima vuelta
      await supabase.from('reservas').update({ recordatorio_enviado_en: null }).eq('id', r.id);
    }
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

async function enviarCopiaMensual() {
  if (horaActualEnAsuncionEnMinutos() < 8 * 60) return;
  const mes = hoyEnAsuncion().toISOString().slice(0, 7); // "2026-11"
  const { data, error } = await supabase
    .from('configuracion').select('valor').eq('clave', CLAVE_COPIA_MENSUAL).maybeSingle();
  if (error) throw error;
  const anterior = data ? data.valor : null;
  if (anterior === mes) return;

  // Se anota ANTES de mandar (no se manda dos veces); si el envío falla, se vuelve atrás y se
  // reintenta en la próxima vuelta
  const marcar = valor => supabase.from('configuracion').upsert({ clave: CLAVE_COPIA_MENSUAL, valor }, { onConflict: 'clave' });
  const { error: errorMarcar } = await marcar(mes);
  if (errorMarcar) throw errorMarcar;

  let enviado = false;
  try {
    const { csv, total } = await armarCsvReservas();
    const [anio, numeroMes] = mes.split('-');
    const nombreMes = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'][Number(numeroMes) - 1];
    enviado = await enviarEmail({
      to: config.email_alertas,
      subject: `Copia de seguridad de las reservas: ${nombreMes} ${anio} (${total} reservas)`,
      html: `
        <p>Hola,</p>
        <p>Te mandamos la copia de seguridad mensual del sistema de reservas: el archivo adjunto tiene las <strong>${total} reservas</strong> guardadas hasta hoy, con todos sus datos (también celulares, correos y cancelaciones).</p>
        <p><strong>Qué hacer:</strong> guardá el archivo en la carpeta de copias de Google Drive. Se abre con Excel o con Google Sheets.</p>
        <p>La base de datos gratuita no guarda copias que se puedan descargar: si algún día se perdiera, estas copias son la forma de recuperar las reservas.</p>
        <p>El archivo tiene datos personales: no lo reenvíes ni lo compartas fuera de quienes administran el sistema.</p>
        <p>Sistema de Reservas del CEQ</p>
      `,
      adjuntos: [{ name: `reservas-ceq-${mes}.csv`, content: Buffer.from(csv, 'utf8').toString('base64') }]
    });
  } finally {
    if (!enviado) await marcar(anterior || '');
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

// ========== INICIAR SERVIDOR ==========

cargarConfiguracion().catch(error => console.error('⚠️ No se pudo leer la configuración, se usan los valores por defecto:', error));
setInterval(tareasPeriodicas, INTERVALO_TAREAS_MS);
setTimeout(tareasPeriodicas, Math.min(20 * 1000, INTERVALO_TAREAS_MS));

app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en puerto ${PORT}`);
  console.log(`🔒 Modo seguro: JWT, bcrypt y validaciones activadas`);
  console.log(`📊 Sincronización con Google Sheets: ${SINCRONIZACION_ACTIVA ? 'activada' : 'desactivada (falta CLAVE_SINCRONIZACION)'}`);
});
