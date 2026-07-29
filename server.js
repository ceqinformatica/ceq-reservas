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
  res.status(status).json({ error: mensajePublico });
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

// Contacto público que se muestra al reservante para consultas sobre Frente
const CONTACTO_EMAIL_FRENTE = 'Monsegonza511@gmail.com';
const CONTACTO_WHATSAPP_FRENTE = '595972753471'; // formato wa.me: código de país + número, sin +, espacios ni guiones

// Devuelve el HTML de la línea de contacto a mostrarle al usuario según el espacio.
// Frente: email de contacto + WhatsApp. Altillo: solo el email general del moderador.
function getContactoLineaHtml(espacio_id) {
  if (espacio_id === 3) {
    return `${CONTACTO_EMAIL_FRENTE} o por <a href="https://wa.me/${CONTACTO_WHATSAPP_FRENTE}">WhatsApp</a>`;
  }
  return `${EMAIL_MODERADOR}`;
}

// Función helper para enviar emails vía la API de Brevo
async function enviarEmail({ to, subject, html }) {
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
        htmlContent: html
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

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Probá de nuevo en unos minutos.' }
});

const crearReservaLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Probá de nuevo más tarde.' }
});

const cancelarLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de cancelación. Probá de nuevo más tarde.' }
});

const reportesLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados reportes enviados. Probá de nuevo más tarde.' }
});

// Límite genérico para endpoints públicos de solo lectura (más permisivo, pero
// evita que queden completamente sin ningún tope de scraping/DoS barato)
const lecturaPublicaLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutos
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Probá de nuevo en unos minutos.' }
});

// ========== UTILIDADES ==========

function getEspacioNombre(id) {
  const espacios = { 1: 'Altillo', 2: 'Sala de Reuniones', 3: 'Frente' };
  return espacios[id] || 'Espacio ' + id;
}

// Frente reserva por turnos fijos con nombre propio (Desayuno/Almuerzo/Merienda), no por
// horario libre como Altillo. En vez de mostrar solo el rango crudo "07:00 - 10:00" en
// emails y en el detalle del día, se muestra el nombre del turno junto con el rango, para
// que quede claro qué momento del día y qué horario exacto puede usar la persona.
// Recibe horaInicio/horaFin ya recortadas a "HH:MM" (sin segundos).
const NOMBRES_TURNOS_FRENTE = {
  '07:00-10:00': 'Desayuno',
  '10:00-13:00': 'Almuerzo',
  '14:00-18:00': 'Merienda'
};

function descripcionHorario(espacioId, horaInicioHHMM, horaFinHHMM) {
  const rango = `${horaInicioHHMM} - ${horaFinHHMM}`;
  if (Number(espacioId) === 3) {
    const nombreTurno = NOMBRES_TURNOS_FRENTE[`${horaInicioHHMM}-${horaFinHHMM}`];
    if (nombreTurno) return `${nombreTurno} (${rango})`;
  }
  return rango;
}

// Middleware de autenticación JWT (AUTH-002: el token viaja en una cookie httpOnly,
// no en localStorage ni en el header Authorization. Esto hace que sea imposible que
// JavaScript del lado del cliente lea o robe el token, incluso si hubiera un XSS
// que hoy no conocemos; antes, cualquier script inyectado podía leer localStorage
// directamente y robar la sesión de admin completa).
const verifyAdminToken = (req, res, next) => {
  const token = req.cookies?.admin_token;
  
  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    req.admin = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado' });
    }
    return res.status(403).json({ error: 'Token inválido' });
  }
};

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
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// LOGIN - Endpoint seguro
app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { password } = req.body;
    
    if (!password) {
      return res.status(400).json({ error: 'Contraseña requerida' });
    }
    
    // Validar contraseña
    const passwordValida = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
    
    if (!passwordValida) {
      console.warn(`⚠️ Intento de login fallido a las ${new Date().toISOString()}`);
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }
    
    // Generar JWT (válido por 8 horas)
    const token = jwt.sign(
      { adminId: 'admin', timestamp: Date.now() },
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
    
    console.log(`✅ Login exitoso a las ${new Date().toISOString()}`);
    res.json({ 
      mensaje: 'Sesión iniciada correctamente',
      expiresIn: '8h'
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
  res.json({ ok: true });
});

// GET espacios
app.get('/api/espacios', async (req, res) => {
  try {
    const { data } = await supabase.from('espacios').select('*');
    res.json(data || []);
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
    if (fecha) query = query.eq('fecha', fecha);
    
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
app.get('/api/meses-habilitados', lecturaPublicaLimiter, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('meses_habilitados')
      .select('anio, mes')
      .eq('habilitado', true)
      .order('anio', { ascending: true })
      .order('mes', { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    manejarError(res, error);
  }
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

    // Solo se ofrecen públicamente los espacios Altillo (1) y Frente (3)
    const espacioIdNum = parseInt(espacio_id);
    if (![1, 3].includes(espacioIdNum)) {
      return res.status(400).json({ error: 'Espacio inválido' });
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
      // Frente: solo se permiten los 3 turnos fijos (Desayuno, Almuerzo, Merienda).
      // No es una duración libre: Merienda dura 4hs, por eso no se valida como rango 1-3h.
      const turnosValidosFrente = [
        { inicio: '07:00', fin: '10:00' },
        { inicio: '10:00', fin: '13:00' },
        { inicio: '14:00', fin: '18:00' }
      ];
      const esTurnoValido = turnosValidosFrente.some(t => t.inicio === hora_inicio && t.fin === hora_fin);
      if (!esTurnoValido) {
        return res.status(400).json({ error: 'Turno inválido para Frente. Debe ser Desayuno (07-10), Almuerzo (10-13) o Merienda (14-18)' });
      }
    } else {
      // Altillo: selección libre de horas dentro del rango, entre 1 y 3 horas
      const duracionHoras = (finMin - inicioMin) / 60;
      if (duracionHoras < 1 || duracionHoras > 3) {
        return res.status(400).json({ error: 'La duración debe ser entre 1 y 3 horas' });
      }

      const horaMinimaPermitida = 8;
      if (horaIniH < horaMinimaPermitida || horaFinH > 18 || (horaFinH === 18 && horaFinM > 0)) {
        return res.status(400).json({ error: `Horario fuera de rango (${horaMinimaPermitida}:00-18:00)` });
      }
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
      .select('habilitado')
      .eq('anio', anioReserva)
      .eq('mes', mesReserva)
      .eq('habilitado', true)
      .maybeSingle();

    if (errorMesHabilitado) throw errorMesHabilitado;
    if (!mesHabilitadoData) {
      return res.status(400).json({ error: 'Ese mes todavía no está habilitado para reservas' });
    }

    // VAL-001: si la reserva es para hoy, el horario de inicio no puede ya haber pasado
    if (fechaReserva.getTime() === hoy.getTime()) {
      const minutosActuales = horaActualEnAsuncionEnMinutos();
      if (inicioMin <= minutosActuales) {
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
        motivo: motivo || '',
        codigo_cancelacion_hash: codigoHash
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
    
    // Enviar email al usuario (si existe email)
    if (email) {
      await enviarEmail({
        to: email,
        subject: `✓ Confirmación de Reserva - CEQ #${reservaId}`,
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
            <li><strong>Motivo:</strong> ${motivoSeguro || 'Sin especificar'}</li>
            <li><strong>Código de cancelación:</strong> ${codigo}</li>
          </ul>
          <p>Si necesitas cancelar, usa tu código en: <a href="https://reservas.ceq-una.com/cancelar.html">Cancelar Reserva</a></p>
          ${contactoLinea}
          <p>Centro de Estudiantes de Química</p>
        `
      });
    }
    
    // Enviar email al moderador correspondiente (Altillo o Frente)
    await enviarEmail({
      to: getEmailModerador(espacioIdNum),
      subject: `📌 Nueva Reserva (${nombreEspacio}) - CEQ #${reservaId}`,
      html: `
        <h2>Nueva Reserva</h2>
        <p><strong>Usuario:</strong> ${nombreSeguro}</p>
        <p><strong>Contacto:</strong> ${contactoSeguro}</p>
        <hr>
        <ul>
          <li><strong>Espacio:</strong> ${nombreEspacio}</li>
          <li><strong>Fecha:</strong> ${fecha}</li>
          <li><strong>Horario:</strong> ${descripcionHorario(espacioIdNum, hora_inicio, hora_fin)}</li>
          <li><strong>Motivo:</strong> ${motivoSeguro || 'Sin especificar'}</li>
          <li><strong>Código:</strong> ${codigo}</li>
        </ul>
      `
    });
    
    res.status(201).json({
      mensaje: 'Reserva creada exitosamente',
      reserva: nuevaReserva[0],
      codigo
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
    // BUG-006: antes se comparaban milisegundos crudos entre `new Date(reserva.fecha)`
    // (medianoche UTC de esa fecha) y `new Date()` (hora exacta actual del servidor,
    // en UTC), y se hacía Math.floor. Eso significaba que el resultado dependía de la
    // hora del día en que se hacía la petición, no solo de la fecha calendario: una
    // reserva "a 2 días" podía calcularse como "a 1 día" simplemente por hacer el
    // pedido de tarde en vez de la mañana (hora Paraguay). Ahora se compara día
    // calendario contra día calendario, fijo en huso horario de Paraguay.
    const diferenciaDias = diferenciaEnDiasCalendario(reserva.fecha);

    // Validar período de cancelación para Frente (2 días)
    if (reserva.espacio_id === 3 && diferenciaDias < 2) {
      const emailUsuario = reserva.contacto.split('|')[1]?.trim();
      if (emailUsuario) {
        await enviarEmail({
          to: emailUsuario,
          subject: `Período de Cancelación Gratuita Finalizado - CEQ #${reserva.id}`,
          html: `
            <h2>El período de cancelación gratuita ha finalizado</h2>
            <p>Intentaste cancelar tu reserva de <strong>${getEspacioNombre(reserva.espacio_id)}</strong>, pero el período de cancelación gratuita ya venció.</p>
            <p><strong>Detalles de la Reserva:</strong></p>
            <ul>
              <li>Fecha: ${reserva.fecha}</li>
              <li>Horario: ${descripcionHorario(reserva.espacio_id, reserva.hora_inicio.substring(0,5), reserva.hora_fin.substring(0,5))}</li>
            </ul>
            <p>Si de todas formas deseás realizar la cancelación, contactate por WhatsApp: <a href="https://wa.me/595972753471">Contactar por WhatsApp</a></p>
          `
        });
      }

      // Aviso al moderador: hubo un intento de cancelación fuera del período gratuito
      await enviarEmail({
        to: getEmailModerador(reserva.espacio_id),
        subject: `Intento de Cancelación Fuera de Plazo - CEQ #${reserva.id}`,
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
      .update({ estado: 'cancelada' })
      .eq('codigo_cancelacion_hash', codigoHashBuscado)
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
      await enviarEmail({
        to: email,
        subject: `Cancelación Confirmada - CEQ Reservas #${reserva.id}`,
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
    {
      await enviarEmail({
        to: getEmailModerador(reserva.espacio_id),
        subject: `Cancelación de Reserva - CEQ #${reserva.id}`,
        html: `
          <h2>Reserva Cancelada por Usuario</h2>
          <p><strong>Usuario:</strong> ${escapeHtml(reserva.nombre_solicitante)}</p>
          <p><strong>Contacto:</strong> ${escapeHtml(reserva.contacto)}</p>
          <p><strong>Espacio:</strong> ${getEspacioNombre(reserva.espacio_id)}</p>
          <p><strong>Fecha:</strong> ${reserva.fecha}</p>
          <p><strong>Horario:</strong> ${descripcionHorario(reserva.espacio_id, reserva.hora_inicio.substring(0,5), reserva.hora_fin.substring(0,5))}</p>
        `
      });
    }

    res.json({ 
      mensaje: 'Reserva cancelada correctamente',
      reserva_id: reserva.id,
      espacio_id: reserva.espacio_id,
      fecha: reserva.fecha
    });
  } catch (error) {
    manejarError(res, error);
  }
});

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
    
    const { error } = await supabase
      .from('reportes_errores')
      .insert([{ mensaje, url, navegador, leido: false }]);
    
    if (error) throw error;
    return res.status(201).json({ mensaje: 'Reporte enviado correctamente' });
  } catch (error) {
    return manejarError(res, error);
  }
});

// ========== ENDPOINTS PROTEGIDOS (REQUIEREN JWT) ==========

// GET admin/reservas
app.get('/api/admin/reservas', verifyAdminToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reservas')
      .select('*')
      .order('fecha', { ascending: false })
      .limit(2000); // tope de seguridad; si el volumen crece mucho, pasar a paginación real
    
    if (error) throw error;
    res.json(data || []);
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
      .select('anio, mes, habilitado')
      .order('anio', { ascending: true })
      .order('mes', { ascending: true });

    if (error) throw error;
    res.json(data || []);
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
      .select('anio, mes')
      .eq('habilitado', true);

    if (errorActuales) throw errorActuales;

    const valorNuevo = anioNum * 12 + mesNum;
    const valoresResultantes = (actuales || [])
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

    const { error } = await supabase
      .from('meses_habilitados')
      .upsert(
        { anio: anioNum, mes: mesNum, habilitado, updated_at: new Date().toISOString() },
        { onConflict: 'anio,mes' }
      );

    if (error) throw error;
    res.json({ mensaje: 'Actualizado correctamente' });
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
      const horaMinima = espacio_id === 3 ? 7 : 8;
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

    const turnosValidosFrente = [
      { inicio: '07:00', fin: '10:00' },
      { inicio: '10:00', fin: '13:00' },
      { inicio: '14:00', fin: '18:00' }
    ];
    const esTurnoValido = turnosValidosFrente.some(t => t.inicio === hora_inicio && t.fin === hora_fin);
    if (!esTurnoValido) {
      return res.status(400).json({ error: 'Turno inválido. Debe ser Desayuno (07-10), Almuerzo (10-13) o Merienda (14-18)' });
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
    await enviarEmail({
      to: email,
      subject: `✓ Confirmación de Reserva - CEQ #${nuevaReserva[0].id}`,
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
        <p>Si necesitas cancelar, usa tu código en: <a href="https://reservas.ceq-una.com/cancelar.html">Cancelar Reserva</a></p>
        <p>Ante cualquier consulta, contactate con: ${getContactoLineaHtml(espacioIdNum)}</p>
        <p>Centro de Estudiantes de Química</p>
      `
    });

    // A propósito no se manda aviso al moderador acá (a diferencia del formulario
    // público): quien crea esto ya es el moderador, y está viendo el resultado en
    // pantalla al toque, no hace falta que se notifique a sí mismo.
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
    
    // Transición condicional (BUG-005): solo cancela si seguía activa
    const { data: updateData, error } = await supabase
      .from('reservas')
      .update({ estado: 'cancelada' })
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
      await enviarEmail({
        to: email,
        subject: `Tu Reserva Fue Cancelada por el Moderador - CEQ #${reserva.id}`,
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
    const destinatariosAviso = reserva.espacio_id === 3
      ? [...new Set([EMAIL_MODERADOR, CONTACTO_EMAIL_FRENTE])]
      : [EMAIL_MODERADOR];

    await enviarEmail({
      to: destinatariosAviso,
      subject: `🔔 Un moderador canceló una reserva (${getEspacioNombre(reserva.espacio_id)}) - CEQ #${reserva.id}`,
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

    res.json({ mensaje: 'Reserva cancelada por admin' });
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
    res.json({ mensaje: 'Reporte marcado como leído' });
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

// ========== INICIAR SERVIDOR ==========

app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en puerto ${PORT}`);
  console.log(`🔒 Modo seguro: JWT, bcrypt y validaciones activadas`);
});
